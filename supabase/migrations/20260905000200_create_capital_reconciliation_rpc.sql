-- Prepared migration; application requires separate explicit approval.
-- Depends on 20260905000100_create_capital_ledger.sql.
--
-- This SECURITY INVOKER RPC reconciles already-posted source evidence into the
-- funding ledger. It never inserts or updates sales, purchases, shipments,
-- shipment items, assets, or cost_entries. In particular, it cannot change
-- assets.measured_weight_g or collapse shipment, package, early-weight, and
-- chargeable-weight evidence into one field.

create or replace function public.reconcile_capital_funding_transaction(
  p_portfolio_id uuid,
  p_transaction_kind public.funding_transaction_kind,
  p_amount_cny numeric,
  p_occurred_at timestamptz,
  p_idempotency_key text,
  p_allocations jsonb,
  p_sale_id uuid,
  p_purchase_order_id uuid,
  p_purchase_item_id uuid,
  p_shipment_id uuid,
  p_shipment_item_id uuid,
  p_cost_entry_id uuid,
  p_reversal_of uuid,
  p_note text
)
returns jsonb
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_user_id uuid := (select auth.uid());
  v_transaction_id uuid;
  v_existing public.funding_transactions%rowtype;
  v_allocation_count integer;
  v_distinct_account_count integer;
  v_matched_account_count integer;
  v_allocation_abs_total numeric(20, 2);
  v_audit_id uuid := gen_random_uuid();
begin
  if v_user_id is null then
    raise exception using errcode = '28000', message = 'Authentication required.';
  end if;

  if p_portfolio_id is null
    or not (select private.can_write_portfolio(p_portfolio_id)) then
    raise exception using errcode = '42501', message = 'Portfolio write access required.';
  end if;

  if p_transaction_kind is null
    or p_amount_cny is null
    or p_amount_cny <= 0
    or p_amount_cny <> round(p_amount_cny, 2) then
    raise exception using
      errcode = '22023',
      message = 'A positive transaction amount with 0.01 CNY precision is required.';
  end if;

  -- No date-only or midnight fallback is allowed. A sale with an unknown exact
  -- sold_at must remain unreconciled until an explicit timestamp is supplied
  -- and matches public.sales.sold_at.
  if p_occurred_at is null then
    raise exception using
      errcode = '22023',
      message = 'An explicit evidence timestamp is required; it is never inferred.';
  end if;

  if nullif(btrim(p_idempotency_key), '') is null then
    raise exception using errcode = '22023', message = 'A stable idempotency key is required.';
  end if;

  if p_allocations is null
    or jsonb_typeof(p_allocations) <> 'array'
    or jsonb_array_length(p_allocations) = 0 then
    raise exception using
      errcode = '22023',
      message = 'At least one funding allocation is required.';
  end if;

  begin
    with parsed as (
      select allocation.account_id, allocation.amount_cny
      from jsonb_to_recordset(p_allocations)
        as allocation(account_id uuid, amount_cny numeric)
    )
    select
      count(*),
      count(distinct parsed.account_id),
      coalesce(sum(abs(parsed.amount_cny)), 0)
    into
      v_allocation_count,
      v_distinct_account_count,
      v_allocation_abs_total
    from parsed
    where parsed.account_id is not null
      and parsed.amount_cny is not null
      and parsed.amount_cny <> 0
      and parsed.amount_cny = round(parsed.amount_cny, 2);
  exception
    when invalid_text_representation or numeric_value_out_of_range then
      raise exception using
        errcode = '22023',
        message = 'Funding allocations contain an invalid account ID or CNY amount.';
  end;

  if v_allocation_count <> jsonb_array_length(p_allocations)
    or v_distinct_account_count <> v_allocation_count
    or v_allocation_abs_total <> p_amount_cny then
    raise exception using
      errcode = '22023',
      message = 'Allocations must use unique accounts and reconcile exactly to transaction amount.';
  end if;

  -- Serialize retries for one portfolio/idempotency pair before inspecting or
  -- inserting any ledger state.
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(p_portfolio_id::text || ':' || p_idempotency_key, 0)
  );

  select funding_tx.*
  into v_existing
  from public.funding_transactions funding_tx
  where funding_tx.portfolio_id = p_portfolio_id
    and funding_tx.idempotency_key = p_idempotency_key
  for update;

  if found then
    if v_existing.transaction_status <> 'posted'
      or v_existing.transaction_kind is distinct from p_transaction_kind
      or v_existing.amount_cny is distinct from p_amount_cny
      or v_existing.occurred_at is distinct from p_occurred_at
      or v_existing.sale_id is distinct from p_sale_id
      or v_existing.purchase_order_id is distinct from p_purchase_order_id
      or v_existing.purchase_item_id is distinct from p_purchase_item_id
      or v_existing.shipment_id is distinct from p_shipment_id
      or v_existing.shipment_item_id is distinct from p_shipment_item_id
      or v_existing.cost_entry_id is distinct from p_cost_entry_id
      or v_existing.reversal_of is distinct from p_reversal_of
      or v_existing.note is distinct from p_note then
      raise exception using
        errcode = '23505',
        message = 'Idempotency key already exists with different funding evidence.';
    end if;

    if exists (
      with requested as (
        select allocation.account_id, allocation.amount_cny::numeric(20, 2)
        from jsonb_to_recordset(p_allocations)
          as allocation(account_id uuid, amount_cny numeric)
      ),
      existing as (
        select allocation.id, allocation.account_id, allocation.amount_cny
        from public.funding_allocations allocation
        where allocation.portfolio_id = p_portfolio_id
          and allocation.transaction_id = v_existing.id
      )
      select 1
      from requested
      full join existing existing_allocation
        on existing_allocation.account_id = requested.account_id
      where requested.account_id is null
        or existing_allocation.id is null
        or existing_allocation.amount_cny is distinct from requested.amount_cny
    ) then
      raise exception using
        errcode = '23505',
        message = 'Idempotency key already exists with different allocations.';
    end if;

    return jsonb_build_object(
      'transaction_id', v_existing.id,
      'portfolio_id', v_existing.portfolio_id,
      'transaction_kind', v_existing.transaction_kind,
      'amount_cny', v_existing.amount_cny,
      'idempotent_replay', true
    );
  end if;

  -- Lock source evidence before accounts. Missing evidence is rejected here;
  -- the deferred constraint trigger performs the complete relationship and
  -- amount validation again at commit.
  if p_transaction_kind = 'sale_proceeds' then
    perform 1
    from public.sales sale
    where sale.portfolio_id = p_portfolio_id
      and sale.id = p_sale_id
    for update;
    if not found then
      raise exception using errcode = 'P0002', message = 'Sale evidence was not found through RLS.';
    end if;

  elsif p_transaction_kind = 'purchase_funding' then
    perform 1
    from public.purchase_orders purchase
    where purchase.portfolio_id = p_portfolio_id
      and purchase.id = p_purchase_order_id
    for update;
    if not found then
      raise exception using errcode = 'P0002', message = 'Purchase order was not found through RLS.';
    end if;

    perform 1
    from public.purchase_items item
    where item.portfolio_id = p_portfolio_id
      and item.id = p_purchase_item_id
    for update;
    if not found then
      raise exception using errcode = 'P0002', message = 'Purchase item was not found through RLS.';
    end if;

    perform 1
    from public.cost_entries entry
    where entry.portfolio_id = p_portfolio_id
      and entry.id = p_cost_entry_id
    for update;
    if not found then
      raise exception using errcode = 'P0002', message = 'Purchase cost entry was not found through RLS.';
    end if;

  elsif p_transaction_kind = 'cost_funding' then
    if p_shipment_id is not null then
      perform 1
      from public.shipments shipment
      where shipment.portfolio_id = p_portfolio_id
        and shipment.id = p_shipment_id
      for update;
      if not found then
        raise exception using errcode = 'P0002', message = 'Shipment was not found through RLS.';
      end if;

      perform 1
      from public.shipment_items item
      where item.portfolio_id = p_portfolio_id
        and item.id = p_shipment_item_id
      for update;
      if not found then
        raise exception using errcode = 'P0002', message = 'Shipment item was not found through RLS.';
      end if;
    end if;

    perform 1
    from public.cost_entries entry
    where entry.portfolio_id = p_portfolio_id
      and entry.id = p_cost_entry_id
    for update;
    if not found then
      raise exception using errcode = 'P0002', message = 'Cost entry was not found through RLS.';
    end if;

  elsif p_transaction_kind = 'refund' then
    perform 1
    from public.cost_entries reversal
    join public.cost_entries original
      on original.portfolio_id = reversal.portfolio_id
     and original.asset_id = reversal.asset_id
     and original.id = reversal.reversal_of
    where reversal.portfolio_id = p_portfolio_id
      and reversal.id = p_cost_entry_id
    for update of original, reversal;
    if not found then
      raise exception using errcode = 'P0002', message = 'Cost reversal and original cost were not found through RLS.';
    end if;

    perform 1
    from public.funding_transactions original
    where original.portfolio_id = p_portfolio_id
      and original.id = p_reversal_of
    for update;
    if not found then
      raise exception using errcode = 'P0002', message = 'Original funding transaction was not found through RLS.';
    end if;

  elsif p_transaction_kind = 'reversal' then
    perform 1
    from public.funding_transactions original
    where original.portfolio_id = p_portfolio_id
      and original.id = p_reversal_of
    for update;
    if not found then
      raise exception using errcode = 'P0002', message = 'Original funding transaction was not found through RLS.';
    end if;
  end if;

  perform account.id
  from public.funding_accounts account
  join jsonb_to_recordset(p_allocations)
    as allocation(account_id uuid, amount_cny numeric)
    on allocation.account_id = account.id
  where account.portfolio_id = p_portfolio_id
  order by account.id
  for update of account;

  select count(*)
  into v_matched_account_count
  from public.funding_accounts account
  join jsonb_to_recordset(p_allocations)
    as allocation(account_id uuid, amount_cny numeric)
    on allocation.account_id = account.id
  where account.portfolio_id = p_portfolio_id;

  if v_matched_account_count <> v_allocation_count then
    raise exception using
      errcode = 'P0002',
      message = 'One or more funding accounts were not found in the portfolio through RLS.';
  end if;

  v_transaction_id := gen_random_uuid();

  insert into public.funding_transactions (
    id,
    portfolio_id,
    transaction_kind,
    transaction_status,
    amount_cny,
    occurred_at,
    posted_at,
    idempotency_key,
    sale_id,
    purchase_order_id,
    purchase_item_id,
    shipment_id,
    shipment_item_id,
    cost_entry_id,
    reversal_of,
    note,
    created_by
  ) values (
    v_transaction_id,
    p_portfolio_id,
    p_transaction_kind,
    'draft',
    p_amount_cny,
    p_occurred_at,
    null,
    p_idempotency_key,
    p_sale_id,
    p_purchase_order_id,
    p_purchase_item_id,
    p_shipment_id,
    p_shipment_item_id,
    p_cost_entry_id,
    p_reversal_of,
    p_note,
    v_user_id
  );

  insert into public.funding_allocations (
    portfolio_id,
    transaction_id,
    account_id,
    amount_cny,
    created_by
  )
  select
    p_portfolio_id,
    v_transaction_id,
    allocation.account_id,
    allocation.amount_cny::numeric(20, 2),
    v_user_id
  from jsonb_to_recordset(p_allocations)
    as allocation(account_id uuid, amount_cny numeric);

  update public.funding_transactions
  set transaction_status = 'posted',
      posted_at = now()
  where portfolio_id = p_portfolio_id
    and id = v_transaction_id
    and transaction_status = 'draft';

  if not found then
    raise exception using errcode = 'P0001', message = 'Funding transaction could not be posted.';
  end if;

  -- Fail inside the RPC rather than waiting for transaction commit. Invoking
  -- the constraint triggers avoids granting authenticated users EXECUTE on the
  -- SECURITY DEFINER validator. Setting them back to deferred preserves their
  -- normal behavior for any later statement in the caller's transaction.
  set constraints
    public.funding_transactions_validate_deferred,
    public.funding_allocations_validate_deferred
  immediate;
  set constraints
    public.funding_transactions_validate_deferred,
    public.funding_allocations_validate_deferred
  deferred;

  insert into public.audit_logs (
    id,
    portfolio_id,
    actor_id,
    action,
    entity_type,
    entity_id,
    after_data
  ) values (
    v_audit_id,
    p_portfolio_id,
    v_user_id,
    'capital_funding_reconciled',
    'funding_transaction',
    v_transaction_id,
    jsonb_build_object(
      'transaction_kind', p_transaction_kind,
      'amount_cny', p_amount_cny,
      'occurred_at', p_occurred_at,
      'sale_id', p_sale_id,
      'purchase_order_id', p_purchase_order_id,
      'purchase_item_id', p_purchase_item_id,
      'shipment_id', p_shipment_id,
      'shipment_item_id', p_shipment_item_id,
      'cost_entry_id', p_cost_entry_id,
      'reversal_of', p_reversal_of,
      'idempotency_key', p_idempotency_key
    )
  );

  return jsonb_build_object(
    'transaction_id', v_transaction_id,
    'portfolio_id', p_portfolio_id,
    'transaction_kind', p_transaction_kind,
    'amount_cny', p_amount_cny,
    'audit_id', v_audit_id,
    'idempotent_replay', false
  );
end;
$$;

revoke all on function public.reconcile_capital_funding_transaction(
  uuid,
  public.funding_transaction_kind,
  numeric,
  timestamptz,
  text,
  jsonb,
  uuid,
  uuid,
  uuid,
  uuid,
  uuid,
  uuid,
  uuid,
  text
) from public, anon;

grant execute on function public.reconcile_capital_funding_transaction(
  uuid,
  public.funding_transaction_kind,
  numeric,
  timestamptz,
  text,
  jsonb,
  uuid,
  uuid,
  uuid,
  uuid,
  uuid,
  uuid,
  uuid,
  text
) to authenticated, service_role;

comment on function public.reconcile_capital_funding_transaction(
  uuid,
  public.funding_transaction_kind,
  numeric,
  timestamptz,
  text,
  jsonb,
  uuid,
  uuid,
  uuid,
  uuid,
  uuid,
  uuid,
  uuid,
  text
) is
  'SECURITY INVOKER reconciliation of existing evidence into the immutable funding ledger; never mutates cost or operational source tables.';

-- Review acceptance facts (not executable seed data):
--   sales proceeds pool: 6188 - 4803 + 1288 = 2673
--   cumulative realized profit: 1160 + 196 = 1356
--   new Contax T2 shipping: gross 109, cost reversal 22, net 87
--   new Contax T2 carrying cost remains cost_entries-derived: 4803 + 87 = 4890
--   Partner A net contribution: 109 - 22 = 87
--   TVS II Partner B contribution and carrying cost: 2533 + 132 = 2665
--   Autoboy S II asset a847b8d7-a50d-4bdd-bdf7-2258dda5f679:
--     sold date 2026-09-02, exact sold_at unknown; RPC must reject until explicit
--     source timestamp exists. It must never synthesize midnight or another time.
--   New T2 tracking EN537362085JP and 500 g / 507 g / 657 g remain distinct
--   shipment evidence; this RPC never writes those facts or measured_weight_g.
