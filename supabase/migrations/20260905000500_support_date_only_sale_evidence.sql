-- Follow-up only: 00100 through 00400 are applied history.
-- No source repair or bootstrap RPC is executed by this migration.
alter table public.sales add column sold_on date;

alter table public.sales
  drop constraint sales_sold_shape,
  add constraint sales_sold_shape check (
    status <> 'sold' or (sold_price_cny is not null
      and (sold_at is not null or sold_on is not null))
  );

create function private.validate_sale_date_evidence()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_timezone text;
  v_date date;
begin
  -- Serialize evidence writes with display timezone changes.
  select display_timezone into strict v_timezone from public.portfolios
  where id = new.portfolio_id for share;
  if new.sold_at is not null then
    v_date := (new.sold_at at time zone v_timezone)::date;
    if new.sold_on is null then
      new.sold_on := v_date;
    elsif new.sold_on is distinct from v_date then
      raise exception using errcode = '23514',
        message = 'sold_on must match sold_at in the portfolio display timezone.';
    end if;
  end if;
  return new;
end;
$$;
create trigger sales_validate_date_evidence
before insert or update on public.sales
for each row execute function private.validate_sale_date_evidence();

alter table public.funding_transactions
  add column occurred_on date,
  alter column occurred_at drop not null,
  add constraint funding_transactions_occurrence_shape check (
    (occurred_at is not null and occurred_on is null)
    or (transaction_kind = 'sale_proceeds' and occurred_at is null and occurred_on is not null)
  );

-- A timezone edit must not invalidate existing sale dates or reversal ordering.
create function private.protect_portfolio_sale_dates()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.display_timezone is distinct from old.display_timezone then
    if exists (select 1 from public.sales sale
      where sale.portfolio_id = new.id and sale.sold_at is not null
        and sale.sold_on is distinct from (sale.sold_at at time zone new.display_timezone)::date)
      or exists (select 1 from public.funding_transactions reversal
        join public.funding_transactions original
          on original.portfolio_id = reversal.portfolio_id and original.id = reversal.reversal_of
        where original.portfolio_id = new.id and original.occurred_at is null
          and reversal.transaction_status = 'posted'
          and (reversal.occurred_at at time zone new.display_timezone)::date <= original.occurred_on) then
      raise exception using errcode = '23514',
        message = 'Display timezone change conflicts with existing sale date evidence.';
    end if;
  end if;
  return new;
end;
$$;
create trigger portfolios_protect_sale_dates
before update of display_timezone on public.portfolios
for each row execute function private.protect_portfolio_sale_dates();

revoke all on function private.validate_sale_date_evidence() from public, anon, authenticated, service_role;
revoke all on function private.protect_portfolio_sale_dates() from public, anon, authenticated, service_role;

create or replace function private.validate_funding_transaction(
  p_portfolio_id uuid,
  p_transaction_id uuid
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_tx public.funding_transactions%rowtype;
  v_original_tx public.funding_transactions%rowtype;
  v_sale public.sales%rowtype;
  v_cost public.cost_entries%rowtype;
  v_original_cost public.cost_entries%rowtype;
  v_purchase_item public.purchase_items%rowtype;
  v_purchase_order public.purchase_orders%rowtype;
  v_shipment_item public.shipment_items%rowtype;
  v_shipment public.shipments%rowtype;
  v_allocation_count integer;
  v_allocation_abs_total numeric(20, 2);
  v_reversal_total numeric(20, 2);
  v_shipping_gross_total numeric(20, 2);
  v_shipment_item_count integer;
  v_shipping_cost_count integer;
begin
  select funding_tx.*
  into v_tx
  from public.funding_transactions funding_tx
  where funding_tx.portfolio_id = p_portfolio_id
    and funding_tx.id = p_transaction_id
  for update;

  if not found or v_tx.transaction_status <> 'posted' then
    return;
  end if;

  select count(*), coalesce(sum(abs(allocation.amount_cny)), 0)
  into v_allocation_count, v_allocation_abs_total
  from public.funding_allocations allocation
  where allocation.portfolio_id = v_tx.portfolio_id
    and allocation.transaction_id = v_tx.id;

  if v_allocation_count = 0 or v_allocation_abs_total <> v_tx.amount_cny then
    raise exception using
      errcode = '23514',
      message = 'Funding allocation absolute total must equal transaction amount.';
  end if;

  if exists (
    select 1
    from public.funding_allocations allocation
    join public.funding_accounts account
      on account.portfolio_id = allocation.portfolio_id
     and account.id = allocation.account_id
    where allocation.portfolio_id = v_tx.portfolio_id
      and allocation.transaction_id = v_tx.id
      and account.closed_at is not null
      and v_tx.posted_at >= account.closed_at
  ) then
    raise exception using
      errcode = '23514',
      message = 'A posted funding transaction cannot allocate to a closed account.';
  end if;

  if v_tx.transaction_kind = 'sale_proceeds' then
    select sale.*
    into v_sale
    from public.sales sale
    where sale.portfolio_id = v_tx.portfolio_id
      and sale.id = v_tx.sale_id;

    if not found
      or v_sale.status <> 'sold'
      or v_sale.net_proceeds_cny is null
      or v_tx.amount_cny <> v_sale.net_proceeds_cny
      or (v_sale.sold_at is not null and (
        v_tx.occurred_at is distinct from v_sale.sold_at or v_tx.occurred_on is not null))
      or (v_sale.sold_at is null and (
        v_sale.sold_on is null or v_tx.occurred_at is not null
        or v_tx.occurred_on is distinct from v_sale.sold_on)) then
      raise exception using
        errcode = '23514',
        message = 'Sale proceeds funding must exactly match completed sale amount and timestamp or date evidence.';
    end if;

    if exists (
      select 1
      from public.funding_allocations allocation
      join public.funding_accounts account
        on account.portfolio_id = allocation.portfolio_id
       and account.id = allocation.account_id
      where allocation.portfolio_id = v_tx.portfolio_id
        and allocation.transaction_id = v_tx.id
        and (
          account.account_kind <> 'sales_proceeds_pool'
          or allocation.amount_cny <= 0
        )
    ) then
      raise exception using
        errcode = '23514',
        message = 'Sale proceeds must be a positive allocation to the sales proceeds pool.';
    end if;

  elsif v_tx.transaction_kind = 'purchase_funding' then
    select item.*
    into v_purchase_item
    from public.purchase_items item
    where item.portfolio_id = v_tx.portfolio_id
      and item.id = v_tx.purchase_item_id;

    select purchase.*
    into v_purchase_order
    from public.purchase_orders purchase
    where purchase.portfolio_id = v_tx.portfolio_id
      and purchase.id = v_tx.purchase_order_id;

    select entry.*
    into v_cost
    from public.cost_entries entry
    where entry.portfolio_id = v_tx.portfolio_id
      and entry.id = v_tx.cost_entry_id;

    if v_purchase_item.id is null
      or v_purchase_order.id is null
      or v_cost.id is null
      or v_purchase_item.purchase_order_id <> v_purchase_order.id
      or v_purchase_order.status = 'cancelled'
      or v_cost.asset_id <> v_purchase_item.asset_id
      or v_cost.cost_type <> 'purchase'
      or v_cost.source_type <> 'purchase_item'
      or v_cost.source_id is distinct from v_purchase_item.id
      or v_cost.reversal_of is not null
      or v_cost.entry_status <> 'posted'
      or v_cost.amount_cny <> v_purchase_item.allocated_cost_cny
      or v_tx.amount_cny <> v_cost.amount_cny then
      raise exception using
        errcode = '23514',
        message = 'Purchase funding must match its order, item, asset, and posted purchase cost.';
    end if;

    if exists (
      select 1
      from public.funding_allocations allocation
      join public.funding_accounts account
        on account.portfolio_id = allocation.portfolio_id
       and account.id = allocation.account_id
      where allocation.portfolio_id = v_tx.portfolio_id
        and allocation.transaction_id = v_tx.id
        and (
          (account.account_kind = 'participant_capital' and allocation.amount_cny < 0)
          or (account.account_kind = 'sales_proceeds_pool' and allocation.amount_cny > 0)
        )
    ) then
      raise exception using
        errcode = '23514',
        message = 'Purchase funding account direction is invalid.';
    end if;

  elsif v_tx.transaction_kind = 'cost_funding' then
    select entry.*
    into v_cost
    from public.cost_entries entry
    where entry.portfolio_id = v_tx.portfolio_id
      and entry.id = v_tx.cost_entry_id;

    if not found
      or v_cost.cost_type = 'reversal'
      or v_cost.reversal_of is not null
      or v_cost.entry_status <> 'posted'
      or v_cost.amount_cny <= 0
      or v_tx.amount_cny <> v_cost.amount_cny then
      raise exception using
        errcode = '23514',
        message = 'Cost funding must exactly match a positive posted cost entry.';
    end if;

    if v_cost.cost_type = 'international_shipping' then
      if v_tx.shipment_id is null or v_tx.shipment_item_id is null then
        raise exception using
          errcode = '23514',
          message = 'International shipping funding requires shipment and shipment-item evidence.';
      end if;

      select item.*
      into v_shipment_item
      from public.shipment_items item
      where item.portfolio_id = v_tx.portfolio_id
        and item.id = v_tx.shipment_item_id;

      select shipment.*
      into v_shipment
      from public.shipments shipment
      where shipment.portfolio_id = v_tx.portfolio_id
        and shipment.id = v_tx.shipment_id;

      if v_shipment_item.id is null
        or v_shipment.id is null
        or v_shipment_item.shipment_id <> v_shipment.id
        or v_shipment_item.allocation_locked_at is null
        or v_shipment.status = 'cancelled'
        or v_cost.asset_id <> v_shipment_item.asset_id
        or v_cost.source_type <> 'shipment_item'
        or v_cost.source_id is distinct from v_shipment_item.id then
        raise exception using
          errcode = '23514',
          message = 'Shipping funding must match its shipment, item, asset, and cost evidence.';
      end if;

      select
        count(distinct item.id),
        count(entry.id),
        coalesce(sum(entry.amount_cny), 0)
      into
        v_shipment_item_count,
        v_shipping_cost_count,
        v_shipping_gross_total
      from public.shipment_items item
      left join public.cost_entries entry
        on entry.portfolio_id = item.portfolio_id
       and entry.asset_id = item.asset_id
       and entry.source_type = 'shipment_item'
       and entry.source_id = item.id
       and entry.cost_type = 'international_shipping'
       and entry.reversal_of is null
       and entry.entry_status = 'posted'
      where item.portfolio_id = v_tx.portfolio_id
        and item.shipment_id = v_shipment.id;

      if v_shipment_item_count = 0
        or v_shipping_cost_count <> v_shipment_item_count
        or v_shipping_gross_total <> v_shipment.actual_paid_cny then
        raise exception using
          errcode = '23514',
          message = 'Posted gross shipping costs must be one-to-one with shipment items and reconcile to shipment actual_paid_cny.';
      end if;

      if exists (
        select 1
        from public.shipment_items item
        where item.portfolio_id = v_tx.portfolio_id
          and item.shipment_id = v_shipment.id
          and item.allocation_locked_at is null
      ) then
        raise exception using
          errcode = '23514',
          message = 'Shipping funding requires locked shipment-item allocation evidence.';
      end if;
    elsif v_tx.shipment_id is not null or v_tx.shipment_item_id is not null then
      raise exception using
        errcode = '23514',
        message = 'Non-shipping cost funding cannot carry shipment evidence.';
    end if;

    if exists (
      select 1
      from public.funding_allocations allocation
      join public.funding_accounts account
        on account.portfolio_id = allocation.portfolio_id
       and account.id = allocation.account_id
      where allocation.portfolio_id = v_tx.portfolio_id
        and allocation.transaction_id = v_tx.id
        and (
          (account.account_kind = 'participant_capital' and allocation.amount_cny < 0)
          or (account.account_kind = 'sales_proceeds_pool' and allocation.amount_cny > 0)
        )
    ) then
      raise exception using
        errcode = '23514',
        message = 'Cost funding account direction is invalid.';
    end if;

  elsif v_tx.transaction_kind = 'refund' then
    select reversal.*
    into v_cost
    from public.cost_entries reversal
    where reversal.portfolio_id = v_tx.portfolio_id
      and reversal.id = v_tx.cost_entry_id;

    if not found
      or v_cost.cost_type <> 'reversal'
      or v_cost.source_type <> 'reversal'
      or v_cost.reversal_of is null
      or v_cost.source_id is distinct from v_cost.reversal_of
      or v_cost.entry_status <> 'posted'
      or v_cost.amount_cny >= 0
      or v_tx.amount_cny <> abs(v_cost.amount_cny)
      or v_tx.occurred_at <> v_cost.occurred_at then
      raise exception using
        errcode = '23514',
        message = 'A funding refund must match a posted negative cost reversal and its explicit time.';
    end if;

    select original.*
    into v_original_cost
    from public.cost_entries original
    where original.portfolio_id = v_cost.portfolio_id
      and original.asset_id = v_cost.asset_id
      and original.id = v_cost.reversal_of;

    select original_transaction.*
    into v_original_tx
    from public.funding_transactions original_transaction
    where original_transaction.portfolio_id = v_tx.portfolio_id
      and original_transaction.id = v_tx.reversal_of;

    if v_original_cost.id is null
      or v_original_tx.id is null
      or v_original_tx.cost_entry_id is distinct from v_original_cost.id then
      raise exception using
        errcode = '23514',
        message = 'Funding refund and cost reversal must target the same original cost.';
    end if;

  elsif v_tx.transaction_kind = 'distribution' then
    if exists (
      select 1
      from public.funding_allocations allocation
      where allocation.portfolio_id = v_tx.portfolio_id
        and allocation.transaction_id = v_tx.id
        and allocation.amount_cny >= 0
    ) then
      raise exception using
        errcode = '23514',
        message = 'Distribution allocations must reduce their funding accounts.';
    end if;
  end if;

  if v_tx.reversal_of is not null then
    perform id from public.portfolios where id = v_tx.portfolio_id for share;
    select original.*
    into v_original_tx
    from public.funding_transactions original
    where original.portfolio_id = v_tx.portfolio_id
      and original.id = v_tx.reversal_of
    for update;

    if not found
      or v_original_tx.transaction_status <> 'posted'
      or v_original_tx.reversal_of is not null
      or v_original_tx.transaction_kind in ('refund', 'reversal')
      or (v_original_tx.occurred_at is not null and v_tx.occurred_at < v_original_tx.occurred_at)
      -- Same-day ordering is unknowable for date-only evidence. Require a
      -- strictly later local date; never synthesize an original timestamp.
      or (v_original_tx.occurred_at is null and (
        v_original_tx.occurred_on is null
        or (v_tx.occurred_at at time zone (select display_timezone from public.portfolios
          where id = v_tx.portfolio_id))::date <= v_original_tx.occurred_on)) then
      raise exception using
        errcode = '23514',
        message = 'Funding reversal must target an earlier posted original transaction.';
    end if;

    if exists (
      select 1
      from public.funding_allocations reversal_allocation
      left join public.funding_allocations original_allocation
        on original_allocation.portfolio_id = reversal_allocation.portfolio_id
       and original_allocation.transaction_id = v_original_tx.id
       and original_allocation.account_id = reversal_allocation.account_id
      where reversal_allocation.portfolio_id = v_tx.portfolio_id
        and reversal_allocation.transaction_id = v_tx.id
        and (
          original_allocation.id is null
          or sign(reversal_allocation.amount_cny) = sign(original_allocation.amount_cny)
          or abs(reversal_allocation.amount_cny) > abs(original_allocation.amount_cny)
        )
    ) then
      raise exception using
        errcode = '23514',
        message = 'Funding reversal allocations must reverse original account allocations.';
    end if;
  end if;

  if v_tx.reversal_of is null then
    select coalesce(sum(reversal.amount_cny), 0)
    into v_reversal_total
    from public.funding_transactions reversal
    where reversal.portfolio_id = v_tx.portfolio_id
      and reversal.reversal_of = v_tx.id
      and reversal.transaction_status = 'posted';

    if v_reversal_total > v_tx.amount_cny then
      raise exception using
        errcode = '23514',
        message = 'Cumulative funding reversals exceed the original transaction amount.';
    end if;

    if exists (
      select 1
      from public.funding_allocations original_allocation
      where original_allocation.portfolio_id = v_tx.portfolio_id
        and original_allocation.transaction_id = v_tx.id
        and (
          select coalesce(sum(abs(reversal_allocation.amount_cny)), 0)
          from public.funding_transactions reversal
          join public.funding_allocations reversal_allocation
            on reversal_allocation.portfolio_id = reversal.portfolio_id
           and reversal_allocation.transaction_id = reversal.id
          where reversal.portfolio_id = v_tx.portfolio_id
            and reversal.reversal_of = v_tx.id
            and reversal.transaction_status = 'posted'
            and reversal_allocation.account_id = original_allocation.account_id
        ) > abs(original_allocation.amount_cny)
    ) then
      raise exception using
        errcode = '23514',
        message = 'Cumulative funding reversals exceed an original account allocation.';
    end if;
  else
    perform private.validate_funding_transaction(v_tx.portfolio_id, v_tx.reversal_of);
  end if;
end;
$$;

revoke all on function private.validate_funding_transaction(uuid, uuid) from public, anon, authenticated, service_role;

-- Narrow date-only entry point; the existing exact-time RPC is unchanged.
create function public.reconcile_capital_sale_proceeds_date_only(
  p_portfolio_id uuid,
  p_sale_id uuid,
  p_sold_on date,
  p_idempotency_key text,
  p_sales_proceeds_pool_account_id uuid,
  p_note text
)
returns jsonb
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_actor uuid := auth.uid();
  v_sale public.sales%rowtype;
  v_existing public.funding_transactions%rowtype;
  v_transaction_id uuid;
  v_audit_id uuid := gen_random_uuid();
begin
  if v_actor is null then
    raise exception using errcode = '28000', message = 'Authentication required.';
  end if;
  if p_portfolio_id is null or not private.can_write_portfolio(p_portfolio_id) then
    raise exception using errcode = '42501', message = 'Portfolio write access required.';
  end if;
  if p_sold_on is null or not isfinite(p_sold_on)
    or nullif(btrim(p_idempotency_key), '') is null then
    raise exception using errcode = '22023', message = 'A finite sold date and stable idempotency key are required.';
  end if;
  -- Same key namespace and lock as the exact-time RPC.
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(p_portfolio_id::text || ':' || p_idempotency_key, 0));
  select * into v_existing from public.funding_transactions
  where portfolio_id = p_portfolio_id and idempotency_key = p_idempotency_key for update;
  select * into v_sale from public.sales
  where portfolio_id = p_portfolio_id and id = p_sale_id for update;
  if not found then
    raise exception using errcode = 'P0002', message = 'Sale evidence was not found through RLS.';
  end if;
  if v_sale.status <> 'sold' or v_sale.sold_at is not null
    or v_sale.sold_on is distinct from p_sold_on
    or v_sale.net_proceeds_cny is null or v_sale.net_proceeds_cny <= 0 then
    raise exception using errcode = '23514', message = 'Date-only funding must match completed sale date and positive net proceeds.';
  end if;
  perform id from public.funding_accounts
  where portfolio_id = p_portfolio_id and id = p_sales_proceeds_pool_account_id
    and account_kind = 'sales_proceeds_pool' for update;
  if not found then
    raise exception using errcode = 'P0002', message = 'Sales proceeds pool was not found in this portfolio through RLS.';
  end if;
  if v_existing.id is not null then
    if v_existing.transaction_status <> 'posted' or v_existing.transaction_kind <> 'sale_proceeds'
      or v_existing.sale_id is distinct from p_sale_id
      or v_existing.amount_cny is distinct from v_sale.net_proceeds_cny
      or v_existing.occurred_at is not null or v_existing.occurred_on is distinct from p_sold_on
      or v_existing.note is distinct from p_note
      or (select count(*) from public.funding_allocations
        where portfolio_id = p_portfolio_id and transaction_id = v_existing.id) <> 1
      or not exists (select 1 from public.funding_allocations
        where portfolio_id = p_portfolio_id and transaction_id = v_existing.id
          and account_id = p_sales_proceeds_pool_account_id and amount_cny = v_sale.net_proceeds_cny) then
      raise exception using errcode = '23505', message = 'Idempotency key already exists with different date-only funding evidence.';
    end if;
    return jsonb_build_object('transaction_id', v_existing.id, 'portfolio_id', p_portfolio_id,
      'transaction_kind', 'sale_proceeds', 'amount_cny', v_existing.amount_cny, 'idempotent_replay', true);
  end if;

  v_transaction_id := gen_random_uuid();
  insert into public.funding_transactions(id, portfolio_id, transaction_kind, transaction_status,
    amount_cny, occurred_at, occurred_on, idempotency_key, sale_id, note, created_by)
  values (v_transaction_id, p_portfolio_id, 'sale_proceeds', 'draft',
    v_sale.net_proceeds_cny, null, v_sale.sold_on, p_idempotency_key, v_sale.id, p_note, v_actor);
  insert into public.funding_allocations(portfolio_id, transaction_id, account_id, amount_cny, created_by)
  values (p_portfolio_id, v_transaction_id, p_sales_proceeds_pool_account_id, v_sale.net_proceeds_cny, v_actor);
  update public.funding_transactions set transaction_status = 'posted', posted_at = now()
  where portfolio_id = p_portfolio_id and id = v_transaction_id and transaction_status = 'draft';
  if not found then
    raise exception using errcode = 'P0001', message = 'Funding transaction could not be posted.';
  end if;
  set constraints public.funding_transactions_validate_deferred,
    public.funding_allocations_validate_deferred immediate;
  set constraints public.funding_transactions_validate_deferred,
    public.funding_allocations_validate_deferred deferred;
  insert into public.audit_logs(id, portfolio_id, actor_id, action, entity_type, entity_id, after_data)
  values (v_audit_id, p_portfolio_id, v_actor, 'capital_funding_reconciled', 'funding_transaction',
    v_transaction_id, jsonb_build_object('transaction_kind', 'sale_proceeds',
      'amount_cny', v_sale.net_proceeds_cny, 'occurred_at', null, 'occurred_on', v_sale.sold_on,
      'sale_id', v_sale.id, 'idempotency_key', p_idempotency_key));
  return jsonb_build_object('transaction_id', v_transaction_id, 'portfolio_id', p_portfolio_id,
    'transaction_kind', 'sale_proceeds', 'amount_cny', v_sale.net_proceeds_cny,
    'audit_id', v_audit_id, 'idempotent_replay', false);
end;
$$;
revoke all on function public.reconcile_capital_sale_proceeds_date_only(uuid, uuid, date, text, uuid, text)
  from public, anon, service_role;
grant execute on function public.reconcile_capital_sale_proceeds_date_only(uuid, uuid, date, text, uuid, text)
  to authenticated;

-- Definition only: this migration does not call the repair RPC.
-- Fixed, confirmed assets only. Funding is handled separately by 00200.
create or replace function public.reconcile_confirmed_capital_source_facts(
  p_portfolio_id uuid,
  p_autoboy_sii_sold_at timestamptz,
  p_t2_shipping_paid_at timestamptz,
  p_tvs_shipping_paid_at timestamptz
)
returns jsonb
language plpgsql
security invoker
set search_path = ''
set timezone = 'UTC'
as $$
declare
  v_actor uuid := auth.uid();
  v_sii constant uuid := 'a847b8d7-a50d-4bdd-bdf7-2258dda5f679'::uuid;
  v_t2 constant uuid := '99d47bd7-4990-4a55-bbeb-eebea4ef2ca4'::uuid;
  v_tvs constant uuid := '5dc2aac1-cea2-445c-ab4d-646bf2a27489'::uuid;
  v_refund_at constant timestamptz := '2026-09-04 17:40:41+08:00'::timestamptz;
  v_assets uuid[];
  v_count integer;
  v_asset uuid;
  v_expected numeric;
  v_gross numeric;
  v_paid_at timestamptz;
  v_key text;
  v_shipment uuid;
  v_item uuid;
  v_cost uuid;
  v_sale uuid;
  v_refund uuid;
  v_receipt_id uuid;
  v_receipt public.audit_logs%rowtype;
  v_args jsonb;
  v_snapshot jsonb;
  v_comparison_snapshot jsonb;
  v_result jsonb := '{}'::jsonb;
begin
  if v_actor is null then
    raise exception using errcode = '28000', message = 'Authentication required.';
  end if;
  if p_portfolio_id is null or not private.can_write_portfolio(p_portfolio_id) then
    raise exception using errcode = '42501', message = 'Portfolio write access required.';
  end if;
  if (p_autoboy_sii_sold_at is not null and (not isfinite(p_autoboy_sii_sold_at)
    or (p_autoboy_sii_sold_at at time zone 'Asia/Shanghai')::date <> date '2026-09-02'))
    or p_t2_shipping_paid_at is null or not isfinite(p_t2_shipping_paid_at)
    or p_t2_shipping_paid_at > v_refund_at
    or p_tvs_shipping_paid_at is null or not isfinite(p_tvs_shipping_paid_at) then
    raise exception using errcode = '22023',
      message = 'Explicit shipping payment timestamps required; optional S II timestamp must fall on 2026-09-02 in Asia/Shanghai.';
  end if;
  v_assets := array[v_sii, v_t2, v_tvs];
  v_args := jsonb_build_object('sold_at', p_autoboy_sii_sold_at,
    't2_paid_at', p_t2_shipping_paid_at, 'tvs_paid_at', p_tvs_shipping_paid_at);
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(p_portfolio_id::text || ':confirmed-capital-source-v1', 0));
  v_receipt_id := md5(p_portfolio_id::text || ':confirmed-capital-source-v1:receipt')::uuid;
  v_sale := md5(p_portfolio_id::text || ':confirmed-capital-source-v1:sii-sale')::uuid;
  v_refund := md5(p_portfolio_id::text || ':confirmed-capital-source-v1:t2-refund')::uuid;

  perform id from public.assets
  where portfolio_id = p_portfolio_id and id = any(v_assets) order by id for update;
  get diagnostics v_count = row_count;
  if v_count <> 3 then
    raise exception using errcode = 'P0002', message = 'All three confirmed assets must exist in this portfolio.';
  end if;
  -- Same order on retries. Lock all existing evidence before comparing it.
  perform p.id from public.purchase_orders p
  where p.portfolio_id = p_portfolio_id and exists (
    select 1 from public.purchase_items i where i.purchase_order_id = p.id
      and i.portfolio_id = p_portfolio_id and i.asset_id = any(v_assets))
  order by p.id for update;
  perform id from public.purchase_items where portfolio_id = p_portfolio_id
    and asset_id = any(v_assets) order by id for update;
  perform s.id from public.shipments s where s.portfolio_id = p_portfolio_id
    and exists (select 1 from public.shipment_items i where i.shipment_id = s.id
      and i.portfolio_id = p_portfolio_id and i.asset_id = any(v_assets))
  order by s.id for update;
  perform id from public.shipment_items where portfolio_id = p_portfolio_id
    and asset_id = any(v_assets) order by id for update;
  perform id from public.cost_entries where portfolio_id = p_portfolio_id
    and asset_id = any(v_assets) order by id for update;
  perform id from public.sales where portfolio_id = p_portfolio_id
    and asset_id = any(v_assets) order by id for update;
  select * into v_receipt from public.audit_logs where id = v_receipt_id
    and portfolio_id = p_portfolio_id for update;

  -- Capture before the write and after the write using the identical projection.
  -- A replay is accepted only if all recorded source rows still match exactly.
  for v_pass in 1..2 loop
    select jsonb_build_object(
      'assets', (select jsonb_agg(to_jsonb(a) order by a.id) from public.assets a
        where a.portfolio_id = p_portfolio_id and a.id = any(v_assets)),
      'costs', (select jsonb_agg(to_jsonb(c) order by c.id) from public.cost_entries c
        where c.portfolio_id = p_portfolio_id and c.asset_id = any(v_assets)),
      'sales', (select jsonb_agg(to_jsonb(s) order by s.id) from public.sales s
        where s.portfolio_id = p_portfolio_id and s.asset_id = any(v_assets)),
      'items', (select jsonb_agg(to_jsonb(i) order by i.id) from public.shipment_items i
        where i.portfolio_id = p_portfolio_id and i.asset_id = any(v_assets)),
      'shipments', (select jsonb_agg(to_jsonb(s) order by s.id) from public.shipments s
        where s.portfolio_id = p_portfolio_id and exists (
          select 1 from public.shipment_items i where i.shipment_id = s.id
            and i.portfolio_id = p_portfolio_id and i.asset_id = any(v_assets))),
      'purchases', (select jsonb_agg(to_jsonb(i) order by i.id) from public.purchase_items i
        where i.portfolio_id = p_portfolio_id and i.asset_id = any(v_assets))
    ) into v_snapshot;

    if v_pass = 2 then
      exit;
    end if;
    if v_receipt.id is not null then
      v_comparison_snapshot := v_snapshot;
      if exists (select 1 from jsonb_array_elements(v_receipt.after_data #> '{snapshot,sales}') sale
        where not (sale ? 'sold_on')) then
        v_comparison_snapshot := jsonb_set(v_snapshot, '{sales}',
          (select jsonb_agg(sale - 'sold_on' order by sale->>'id')
           from jsonb_array_elements(v_snapshot->'sales') sale));
      end if;
      if v_receipt.action <> 'confirmed_capital_source_repaired_v1'
        or v_receipt.after_data->'arguments' is distinct from v_args
        or v_receipt.after_data->'snapshot' is distinct from v_comparison_snapshot then
        raise exception using errcode = '23514', message = 'Repair replay conflicts with arguments or current source evidence.';
      end if;
      return (v_receipt.after_data->'result') || jsonb_build_object('idempotent_replay', true);
    end if;

    if exists (select 1 from public.assets where portfolio_id = p_portfolio_id
      and id in (v_t2, v_tvs) and measured_weight_g is not null) then
      raise exception using errcode = '23514', message = 'Confirmed camera measured weights must remain NULL.';
    end if;
    if exists (select 1 from public.sales where portfolio_id = p_portfolio_id and asset_id = v_sii)
      or exists (select 1 from public.assets where id = v_sii and operational_status in ('sold', 'retired')) then
      raise exception using errcode = '23514', message = 'S II already has sale/status evidence; refuse to overwrite.';
    end if;
    if (select coalesce(sum(amount_cny), 0) from public.cost_entries
      where portfolio_id = p_portfolio_id and asset_id = v_sii and entry_status = 'posted') <> 1092 then
      raise exception using errcode = '23514', message = 'S II carrying cost must be 1092 before repair.';
    end if;

    foreach v_asset in array array[v_t2, v_tvs] loop
      v_expected := case when v_asset = v_t2 then 4803 else 2533 end;
      v_gross := case when v_asset = v_t2 then 109 else 132 end;
      v_paid_at := case when v_asset = v_t2 then p_t2_shipping_paid_at else p_tvs_shipping_paid_at end;
      v_key := 'confirmed-capital-source-v1:' || case when v_asset = v_t2 then 't2' else 'tvs' end;
      v_shipment := md5(p_portfolio_id::text || ':' || v_key || ':shipment')::uuid;
      v_item := md5(p_portfolio_id::text || ':' || v_key || ':item')::uuid;
      v_cost := md5(p_portfolio_id::text || ':' || v_key || ':cost')::uuid;
      select count(*) into v_count from public.purchase_items i
      join public.purchase_orders p on p.portfolio_id = i.portfolio_id and p.id = i.purchase_order_id
      join public.cost_entries c on c.portfolio_id = i.portfolio_id and c.asset_id = i.asset_id
        and c.source_type = 'purchase_item' and c.source_id = i.id and c.cost_type = 'purchase'
      where i.portfolio_id = p_portfolio_id and i.asset_id = v_asset
        and i.allocated_cost_cny = v_expected and c.amount_cny = v_expected
        and c.entry_status = 'posted' and c.reversal_of is null and p.status <> 'cancelled';
      if v_count <> 1 or (select count(*) from public.purchase_items
        where portfolio_id = p_portfolio_id and asset_id = v_asset) <> 1
        or (select coalesce(sum(amount_cny), 0) from public.cost_entries
          where portfolio_id = p_portfolio_id and asset_id = v_asset and entry_status = 'posted') <> v_expected
        or exists (select 1 from public.cost_entries where portfolio_id = p_portfolio_id
          and asset_id = v_asset and cost_type in ('international_shipping', 'reversal'))
        or exists (select 1 from public.shipment_items where portfolio_id = p_portfolio_id and asset_id = v_asset)
        or exists (select 1 from public.shipments where portfolio_id = p_portfolio_id
          and (legacy_id = v_key or (v_asset = v_t2 and tracking_number = 'EN537362085JP'))) then
        raise exception using errcode = '23514', message = 'Purchase baseline or existing logistics conflicts with confirmed repair.';
      end if;

      -- No event timestamp is inferred from a payment. Tracking events are not created.
      insert into public.shipments(id, portfolio_id, legacy_id, carrier, tracking_number,
        status, actual_paid_cny, budget_cny, created_by)
      values (v_shipment, p_portfolio_id, v_key, 'Japan Post EMS',
        case when v_asset = v_t2 then 'EN537362085JP' else null end,
        'booked', v_gross, v_gross, v_actor);
      insert into public.shipment_items(id, portfolio_id, shipment_id, asset_id,
        allocation_method, allocation_ratio, allocated_shipping_cny, allocation_locked_at, created_by)
      values (v_item, p_portfolio_id, v_shipment, v_asset, 'manual', 1, v_gross, now(), v_actor);
      insert into public.cost_entries(id, portfolio_id, asset_id, cost_type, source_type,
        source_id, original_amount, currency, fx_rate_to_cny, amount_cny, entry_status, occurred_at, created_by)
      values (v_cost, p_portfolio_id, v_asset, 'international_shipping', 'shipment_item',
        v_item, v_gross, 'CNY', 1, v_gross, 'posted', v_paid_at, v_actor);
      if v_asset = v_t2 then
        insert into public.cost_entries(id, portfolio_id, asset_id, cost_type, source_type,
          source_id, original_amount, currency, fx_rate_to_cny, amount_cny, entry_status,
          occurred_at, reversal_of, created_by)
        values (v_refund, p_portfolio_id, v_t2, 'reversal', 'reversal', v_cost,
          -22, 'CNY', 1, -22, 'posted', v_refund_at, v_cost, v_actor);
      end if;
      v_result := v_result || jsonb_build_object(
        case when v_asset = v_t2 then 't2' else 'tvs' end,
        jsonb_build_object('shipment_id', v_shipment, 'shipment_item_id', v_item, 'cost_entry_id', v_cost));
    end loop;

    insert into public.sales(id, portfolio_id, asset_id, legacy_id, status, platform,
      sold_price_cny, platform_fees_cny, outbound_shipping_cny, sold_at, sold_on, created_by)
    values (v_sale, p_portfolio_id, v_sii, 'confirmed-capital-source-v1:sii-sale', 'sold',
      '口令红包直接到账', 1288, 0, 0, p_autoboy_sii_sold_at, date '2026-09-02', v_actor);
    update public.assets set operational_status = 'sold'
    where portfolio_id = p_portfolio_id and id = v_sii;
    -- The status-event table requires exact occurrence evidence. The audit
    -- receipt below preserves date-only evidence without a fabricated event.
    if p_autoboy_sii_sold_at is not null then
      insert into public.asset_status_events(portfolio_id, asset_id, operational_status, note, occurred_at, created_by)
      values (p_portfolio_id, v_sii, 'sold', 'Confirmed standalone S II sale: direct receipt.', p_autoboy_sii_sold_at, v_actor);
    end if;
    v_result := v_result || jsonb_build_object('sale_id', v_sale, 'refund_cost_entry_id', v_refund);
  end loop;

  set constraints public.cost_entries_00_validate_reversal_total_deferred immediate;
  set constraints public.cost_entries_00_validate_reversal_total_deferred deferred;
  if exists (select 1 from public.asset_financials where portfolio_id = p_portfolio_id
    and ((asset_id = v_sii and (total_carrying_cost_cny <> 1092 or realized_profit_cny is distinct from 196::numeric))
      or (asset_id = v_t2 and total_carrying_cost_cny <> 4890)
      or (asset_id = v_tvs and total_carrying_cost_cny <> 2665))) then
    raise exception using errcode = '23514', message = 'Source repair financial postcondition failed.';
  end if;
  insert into public.audit_logs(id, portfolio_id, actor_id, action, entity_type, after_data)
  values (v_receipt_id, p_portfolio_id, v_actor, 'confirmed_capital_source_repaired_v1',
    'confirmed_capital_source_facts', jsonb_build_object('arguments', v_args,
      'snapshot', v_snapshot, 'result', v_result, 'evidence', jsonb_build_object(
        'sii', jsonb_build_object('sold_on', date '2026-09-02', 'sold_at', p_autoboy_sii_sold_at,
          'net_proceeds_cny', 1288),
        't2', jsonb_build_object('final_packaged_order_weight_g', 500,
          'earlier_observed_weight_g', 507, 'earlier_chargeable_weight_g', 657,
          'volume_cm3', 3120, 'max_side_cm', 26, 'gross_shipping_cny', 109,
          'refund_cny', 22, 'refund_at', v_refund_at),
        'tvs', jsonb_build_object('shipping_jpy', 2400, 'reinforcement_jpy', 150,
          'adjustment_jpy', 440, 'total_jpy', 2990, 'settled_cny', 132))));
  return v_result || jsonb_build_object('idempotent_replay', false);
end;
$$;

revoke all on function public.reconcile_confirmed_capital_source_facts(uuid, timestamptz, timestamptz, timestamptz)
  from public, anon, service_role;
grant execute on function public.reconcile_confirmed_capital_source_facts(uuid, timestamptz, timestamptz, timestamptz)
  to authenticated;

-- Definition only. This function creates funding identities and imports seven
-- confirmed events through exact/date-only RPCs; it never repairs source evidence.
create or replace function public.bootstrap_confirmed_capital_funding(
  p_portfolio_id uuid,
  p_t2_date_back_sale_id uuid
)
returns jsonb
language plpgsql
security invoker
set search_path = ''
set timezone = 'UTC'
as $$
declare
  v_actor uuid := auth.uid();
  v_code text;
  v_participant uuid;
  v_account uuid;
  v_accounts jsonb := '{}'::jsonb;
  v_results jsonb := '[]'::jsonb;
  v_event record;
  v_source public.audit_logs%rowtype;
  v_sale public.sales%rowtype;
  v_purchase record;
  v_count integer;
  v_asset uuid;
  v_events jsonb;
  v_pool numeric;
  v_a numeric;
  v_b numeric;
  v_profit numeric;
begin
  if v_actor is null then
    raise exception using errcode = '28000', message = 'Authentication required.';
  end if;
  if p_portfolio_id is null or not private.can_write_portfolio(p_portfolio_id) then
    raise exception using errcode = '42501', message = 'Portfolio write access required.';
  end if;
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(p_portfolio_id::text || ':confirmed-capital-funding-v1', 0));
  select * into v_source from public.audit_logs
  where portfolio_id = p_portfolio_id
    and id = md5(p_portfolio_id::text || ':confirmed-capital-source-v1:receipt')::uuid
    and action = 'confirmed_capital_source_repaired_v1' for update;
  if not found then
    raise exception using errcode = 'P0002', message = 'Complete confirmed source repair first.';
  end if;
  select * into v_sale from public.sales
  where portfolio_id = p_portfolio_id and id = p_t2_date_back_sale_id for update;
  if not found or v_sale.status <> 'sold' or v_sale.net_proceeds_cny <> 6188
    or v_sale.sold_at is null or not exists (
      select 1 from public.asset_financials where portfolio_id = p_portfolio_id
        and asset_id = v_sale.asset_id and total_carrying_cost_cny = 5028
        and realized_profit_cny = 1160) then
    raise exception using errcode = '23514', message = 'Explicit Date Back sale must match confirmed financial evidence.';
  end if;


  v_events := jsonb_build_array(jsonb_build_object('key', 'date-back-sale', 'kind', 'sale_proceeds',
    'sale_id', v_sale.id, 'amount', 6188, 'at', v_sale.sold_at, 'account', 'sales_proceeds_pool', 'signed', 6188));
  foreach v_asset in array array['99d47bd7-4990-4a55-bbeb-eebea4ef2ca4'::uuid,
    '5dc2aac1-cea2-445c-ab4d-646bf2a27489'::uuid] loop
    select count(*) into v_count from public.purchase_items i
    join public.cost_entries c on c.portfolio_id = i.portfolio_id and c.asset_id = i.asset_id
      and c.source_type = 'purchase_item' and c.source_id = i.id and c.cost_type = 'purchase'
    where i.portfolio_id = p_portfolio_id and i.asset_id = v_asset and c.entry_status = 'posted';
    if v_count <> 1 then
      raise exception using errcode = '23514', message = 'Exactly one posted purchase cost is required per confirmed asset.';
    end if;
    select i.id, i.purchase_order_id, c.id as cost_id, c.amount_cny, c.occurred_at
    into strict v_purchase from public.purchase_items i
    join public.cost_entries c on c.portfolio_id = i.portfolio_id and c.asset_id = i.asset_id
      and c.source_type = 'purchase_item' and c.source_id = i.id and c.cost_type = 'purchase'
    where i.portfolio_id = p_portfolio_id and i.asset_id = v_asset and c.entry_status = 'posted'
    for update of i, c;
    v_code := case when v_asset = '99d47bd7-4990-4a55-bbeb-eebea4ef2ca4'::uuid then 't2' else 'tvs' end;
    if v_purchase.amount_cny <> (case when v_code = 't2' then 4803 else 2533 end) then
      raise exception using errcode = '23514', message = 'Purchase amount conflicts with confirmed facts.';
    end if;
    v_events := v_events || jsonb_build_array(jsonb_build_object('key', v_code || '-purchase',
      'kind', 'purchase_funding', 'order_id', v_purchase.purchase_order_id, 'item_id', v_purchase.id,
      'cost_id', v_purchase.cost_id, 'amount', v_purchase.amount_cny, 'at', v_purchase.occurred_at,
      'account', case when v_code = 't2' then 'sales_proceeds_pool' else 'partner_b_capital' end,
      'signed', case when v_code = 't2' then -v_purchase.amount_cny else v_purchase.amount_cny end));
  end loop;

  for v_event in
    select c.*, i.shipment_id, i.id as item_id from public.cost_entries c
    join public.shipment_items i on i.portfolio_id = c.portfolio_id and i.id = c.source_id
    where c.portfolio_id = p_portfolio_id and c.id in (
      (v_source.after_data #>> '{result,t2,cost_entry_id}')::uuid,
      (v_source.after_data #>> '{result,tvs,cost_entry_id}')::uuid)
    order by c.id for update of c, i
  loop
    v_code := case when v_event.asset_id = '99d47bd7-4990-4a55-bbeb-eebea4ef2ca4'::uuid then 't2' else 'tvs' end;
    v_events := v_events || jsonb_build_array(jsonb_build_object('key', v_code || '-ems',
      'kind', 'cost_funding', 'cost_id', v_event.id, 'shipment_id', v_event.shipment_id,
      'shipment_item_id', v_event.item_id, 'amount', v_event.amount_cny, 'at', v_event.occurred_at,
      'account', case when v_code = 't2' then 'partner_a_capital' else 'partner_b_capital' end,
      'signed', v_event.amount_cny));
  end loop;
  select * into strict v_event from public.cost_entries
  where portfolio_id = p_portfolio_id and id = (v_source.after_data #>> '{result,refund_cost_entry_id}')::uuid for update;
  v_events := v_events || jsonb_build_array(jsonb_build_object('key', 't2-refund', 'kind', 'refund',
    'cost_id', v_event.id, 'amount', 22, 'at', v_event.occurred_at, 'account', 'partner_a_capital', 'signed', -22));
  select * into strict v_sale from public.sales where portfolio_id = p_portfolio_id
    and id = (v_source.after_data #>> '{result,sale_id}')::uuid for update;
  if v_sale.asset_id <> 'a847b8d7-a50d-4bdd-bdf7-2258dda5f679'::uuid
    or v_sale.status <> 'sold' or v_sale.net_proceeds_cny is distinct from 1288::numeric
    or v_sale.sold_on is distinct from date '2026-09-02' then
    raise exception using errcode = '23514', message = 'Standalone S II sale identity mismatch.';
  end if;
  v_events := v_events || jsonb_build_array(jsonb_build_object('key', 'sii-sale', 'kind', 'sale_proceeds',
    'sale_id', v_sale.id, 'amount', 1288, 'at', v_sale.sold_at, 'on', v_sale.sold_on, 'account', 'sales_proceeds_pool', 'signed', 1288));
  if jsonb_array_length(v_events) <> 7 then
    raise exception using errcode = '23514', message = 'All seven source events are required.';
  end if;

  foreach v_code in array array['partner_a_capital', 'partner_b_capital', 'sales_proceeds_pool'] loop
    v_participant := case when v_code = 'sales_proceeds_pool' then null
      else md5(p_portfolio_id::text || ':capital-participant:' || v_code)::uuid end;
    v_account := md5(p_portfolio_id::text || ':capital-account:' || v_code)::uuid;
    if v_participant is not null then
      insert into public.funding_participants(id, portfolio_id, display_name, created_by)
      values (v_participant, p_portfolio_id,
        case when v_code = 'partner_a_capital' then 'Partner A' else 'Partner B' end, v_actor)
      on conflict (id) do nothing;
      perform id from public.funding_participants where id = v_participant
        and portfolio_id = p_portfolio_id and active for update;
      if not found then
        raise exception using errcode = '23514', message = 'Participant identity conflicts with bootstrap.';
      end if;
    end if;
    insert into public.funding_accounts(id, portfolio_id, participant_id, account_code,
      display_name, account_kind, created_by)
    values (v_account, p_portfolio_id, v_participant, v_code, v_code,
      case when v_participant is null then 'sales_proceeds_pool'::public.funding_account_kind
        else 'participant_capital'::public.funding_account_kind end, v_actor)
    on conflict (id) do nothing;
    perform id from public.funding_accounts where id = v_account
      and portfolio_id = p_portfolio_id and account_code = v_code
      and participant_id is not distinct from v_participant and currency = 'CNY'
      and account_kind = case when v_participant is null then 'sales_proceeds_pool'::public.funding_account_kind
        else 'participant_capital'::public.funding_account_kind end
      and closed_at is null for update;
    if not found then
      raise exception using errcode = '23514', message = 'Account identity conflicts with bootstrap.';
    end if;
    v_accounts := v_accounts || jsonb_build_object(v_code, v_account);
  end loop;


  for v_event in select value as data from jsonb_array_elements(v_events) loop
    if v_event.data->>'key' = 'sii-sale' and v_event.data->>'at' is null then
      v_results := v_results || jsonb_build_array(public.reconcile_capital_sale_proceeds_date_only(
        p_portfolio_id, (v_event.data->>'sale_id')::uuid, (v_event.data->>'on')::date,
        'confirmed-capital-funding-v1:sii-sale', (v_accounts->>'sales_proceeds_pool')::uuid,
        'Confirmed capital funding v1'));
      continue;
    end if;
    v_results := v_results || jsonb_build_array(public.reconcile_capital_funding_transaction(
      p_portfolio_id, (v_event.data->>'kind')::public.funding_transaction_kind,
      (v_event.data->>'amount')::numeric, (v_event.data->>'at')::timestamptz,
      'confirmed-capital-funding-v1:' || (v_event.data->>'key'),
      jsonb_build_array(jsonb_build_object('account_id', v_accounts->>(v_event.data->>'account'),
        'amount_cny', (v_event.data->>'signed')::numeric)),
      (v_event.data->>'sale_id')::uuid, (v_event.data->>'order_id')::uuid,
      (v_event.data->>'item_id')::uuid, (v_event.data->>'shipment_id')::uuid,
      (v_event.data->>'shipment_item_id')::uuid, (v_event.data->>'cost_id')::uuid,
      case when v_event.data->>'kind' = 'refund' then (
        select id from public.funding_transactions where portfolio_id = p_portfolio_id
          and idempotency_key = 'confirmed-capital-funding-v1:t2-ems') else null end,
      'Confirmed capital funding v1'));
  end loop;
  select balance_cny into strict v_pool from public.funding_account_balances
    where portfolio_id = p_portfolio_id and account_code = 'sales_proceeds_pool';
  select balance_cny into strict v_a from public.funding_account_balances
    where portfolio_id = p_portfolio_id and account_code = 'partner_a_capital';
  select balance_cny into strict v_b from public.funding_account_balances
    where portfolio_id = p_portfolio_id and account_code = 'partner_b_capital';
  select sum(realized_profit_cny) into v_profit from public.asset_financials
    where portfolio_id = p_portfolio_id and sale_id in (p_t2_date_back_sale_id, v_sale.id);
  if v_pool <> 2673 or v_a <> 87 or v_b <> 2665 or v_profit is distinct from 1356::numeric then
    raise exception using errcode = '23514', message = 'Derived confirmed funding/profit totals conflict; all bootstrap writes rolled back.';
  end if;
  return jsonb_build_object('accounts', v_accounts, 'transactions', v_results,
    'pool_cny', v_pool, 'partner_a_cny', v_a, 'partner_b_cny', v_b, 'realized_profit_cny', v_profit);
end;
$$;
revoke all on function public.bootstrap_confirmed_capital_funding(uuid, uuid) from public, anon, service_role;
grant execute on function public.bootstrap_confirmed_capital_funding(uuid, uuid) to authenticated;

-- Existing column names/order and SECURITY INVOKER are preserved; append only.
create or replace view public.funding_transaction_balances
with (security_invoker = true)
as
with reversal_totals as (
  select
    reversal.portfolio_id,
    reversal.reversal_of as transaction_id,
    sum(reversal.amount_cny) as reversed_amount_cny
  from public.funding_transactions reversal
  where reversal.transaction_status = 'posted'
    and reversal.reversal_of is not null
  group by reversal.portfolio_id, reversal.reversal_of
)
select
  original.portfolio_id,
  original.id as transaction_id,
  original.transaction_kind,
  original.amount_cny as original_amount_cny,
  coalesce(reversal.reversed_amount_cny, 0::numeric) as reversed_amount_cny,
  original.amount_cny - coalesce(reversal.reversed_amount_cny, 0::numeric)
    as remaining_amount_cny,
  original.occurred_at,
  original.posted_at,
  original.occurred_on
from public.funding_transactions original
left join reversal_totals reversal
  on reversal.portfolio_id = original.portfolio_id
 and reversal.transaction_id = original.id
where original.transaction_status = 'posted'
  and original.reversal_of is null;

-- asset_financials and portfolio_metrics already derive sold/profit from
-- sale_id and status, not sold_at. Their formulas remain unchanged.

-- Preserve historical source-repair snapshots: sold_on backfill is not a new
-- sale event. Only the updated_at metadata trigger is suspended; all funding
-- invariants remain active and are flushed before the final ALTER TABLE.
alter table public.sales disable trigger sales_set_updated_at;
-- Use the portfolio timezone, never the migration session timezone.
update public.sales sale
set sold_on = (sale.sold_at at time zone portfolio.display_timezone)::date
from public.portfolios portfolio
where portfolio.id = sale.portfolio_id and sale.sold_at is not null;

set constraints public.sales_revalidate_funding_deferred immediate;
set constraints public.sales_revalidate_funding_deferred deferred;
alter table public.sales enable trigger sales_set_updated_at;
