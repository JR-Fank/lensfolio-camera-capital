-- Prepared migration; application requires separate explicit approval.
-- Capital Ledger records funding source and destination. It does not participate
-- in asset carrying cost or ROI; public.cost_entries remains the sole cost truth.

create type public.funding_account_kind as enum (
  'participant_capital',
  'sales_proceeds_pool'
);

create type public.funding_transaction_kind as enum (
  'sale_proceeds',
  'purchase_funding',
  'cost_funding',
  'refund',
  'distribution',
  'adjustment',
  'reversal'
);

create type public.funding_transaction_status as enum (
  'draft',
  'posted',
  'void'
);

-- Composite source keys are required so every ledger reference carries its
-- portfolio boundary through the foreign key itself.
alter table public.purchase_items
  add constraint purchase_items_portfolio_id_id_key unique (portfolio_id, id);

alter table public.shipment_items
  add constraint shipment_items_portfolio_id_id_key unique (portfolio_id, id);

alter table public.sales
  add constraint sales_portfolio_id_id_key unique (portfolio_id, id);

-- The foundation schema permits only one cost reversal per original entry.
-- Replace that uniqueness rule with a deferred cumulative cap so separate
-- partial refunds remain separate immutable evidence rows.
do $cost_reversal_preflight$
begin
  if exists (
    select 1
    from public.cost_entries reversal
    left join public.cost_entries original
      on original.portfolio_id = reversal.portfolio_id
     and original.asset_id = reversal.asset_id
     and original.id = reversal.reversal_of
    where reversal.reversal_of is not null
      and (
        original.id is null
        or original.cost_type = 'reversal'
        or original.reversal_of is not null
        or reversal.cost_type <> 'reversal'
        or reversal.source_type <> 'reversal'
        or reversal.source_id is distinct from reversal.reversal_of
        or reversal.amount_cny >= 0
        or (
          reversal.entry_status = 'posted'
          and (
            original.entry_status <> 'posted'
            or original.amount_cny <= 0
            or reversal.original_amount >= 0
            or reversal.currency <> original.currency
            or reversal.fx_rate_to_cny <> original.fx_rate_to_cny
            or reversal.occurred_at < original.occurred_at
          )
        )
      )
  ) then
    raise exception using
      errcode = '23514',
      message = 'Existing cost reversals must be normalized before Capital Ledger migration.';
  end if;

  if exists (
    select 1
    from public.cost_entries original
    join public.cost_entries reversal
      on reversal.portfolio_id = original.portfolio_id
     and reversal.asset_id = original.asset_id
     and reversal.reversal_of = original.id
     and reversal.entry_status = 'posted'
    group by original.portfolio_id, original.asset_id, original.id, original.amount_cny
    having sum(-reversal.amount_cny) > original.amount_cny
  ) then
    raise exception using
      errcode = '23514',
      message = 'Existing cumulative cost reversals exceed an original cost amount.';
  end if;
end;
$cost_reversal_preflight$;

drop index if exists public.cost_entries_one_reversal_per_entry_idx;

alter table public.cost_entries
  drop constraint cost_entries_asset_source_cost_key;

create unique index cost_entries_nonreversal_source_key
  on public.cost_entries (asset_id, source_type, source_id, cost_type)
  where reversal_of is null and source_id is not null;

create index cost_entries_reversal_of_idx
  on public.cost_entries (portfolio_id, asset_id, reversal_of)
  where reversal_of is not null;

create table public.funding_participants (
  id uuid primary key default gen_random_uuid(),
  portfolio_id uuid not null references public.portfolios(id) on delete cascade,
  user_id uuid,
  display_name text not null,
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  created_by uuid not null references auth.users(id),
  unique (portfolio_id, id),
  unique (portfolio_id, user_id),
  foreign key (portfolio_id, user_id)
    references public.portfolio_members(portfolio_id, user_id) on delete restrict,
  constraint funding_participants_display_name_not_blank
    check (btrim(display_name) <> '')
);

create unique index funding_participants_active_display_name_idx
  on public.funding_participants (portfolio_id, display_name)
  where active;

create table public.funding_accounts (
  id uuid primary key default gen_random_uuid(),
  portfolio_id uuid not null references public.portfolios(id) on delete cascade,
  participant_id uuid,
  account_code text not null,
  display_name text not null,
  account_kind public.funding_account_kind not null,
  currency text not null default 'CNY',
  closed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  created_by uuid not null references auth.users(id),
  unique (portfolio_id, id),
  unique (portfolio_id, account_code),
  foreign key (portfolio_id, participant_id)
    references public.funding_participants(portfolio_id, id) on delete restrict,
  constraint funding_accounts_code_not_blank check (btrim(account_code) <> ''),
  constraint funding_accounts_name_not_blank check (btrim(display_name) <> ''),
  constraint funding_accounts_currency_cny check (currency = 'CNY'),
  constraint funding_accounts_participant_shape check (
    (account_kind = 'participant_capital' and participant_id is not null)
    or (account_kind = 'sales_proceeds_pool' and participant_id is null)
  ),
  constraint funding_accounts_closed_after_creation
    check (closed_at is null or closed_at >= created_at)
);

create unique index funding_accounts_one_capital_account_per_participant_idx
  on public.funding_accounts (portfolio_id, participant_id)
  where account_kind = 'participant_capital';

create unique index funding_accounts_one_sales_pool_per_portfolio_idx
  on public.funding_accounts (portfolio_id)
  where account_kind = 'sales_proceeds_pool';

create table public.funding_transactions (
  id uuid primary key default gen_random_uuid(),
  portfolio_id uuid not null references public.portfolios(id) on delete cascade,
  transaction_kind public.funding_transaction_kind not null,
  transaction_status public.funding_transaction_status not null default 'draft',
  amount_cny numeric(20, 2) not null,
  occurred_at timestamptz not null,
  posted_at timestamptz,
  idempotency_key text not null,
  sale_id uuid,
  purchase_order_id uuid,
  purchase_item_id uuid,
  shipment_id uuid,
  shipment_item_id uuid,
  cost_entry_id uuid,
  reversal_of uuid,
  note text,
  created_at timestamptz not null default now(),
  created_by uuid not null references auth.users(id),
  unique (portfolio_id, id),
  unique (portfolio_id, idempotency_key),
  foreign key (portfolio_id, sale_id)
    references public.sales(portfolio_id, id) on delete restrict,
  foreign key (portfolio_id, purchase_order_id)
    references public.purchase_orders(portfolio_id, id) on delete restrict,
  foreign key (portfolio_id, purchase_item_id)
    references public.purchase_items(portfolio_id, id) on delete restrict,
  foreign key (portfolio_id, shipment_id)
    references public.shipments(portfolio_id, id) on delete restrict,
  foreign key (portfolio_id, shipment_item_id)
    references public.shipment_items(portfolio_id, id) on delete restrict,
  foreign key (portfolio_id, cost_entry_id)
    references public.cost_entries(portfolio_id, id) on delete restrict,
  foreign key (portfolio_id, reversal_of)
    references public.funding_transactions(portfolio_id, id) on delete restrict,
  constraint funding_transactions_amount_positive check (
    amount_cny > 0 and amount_cny = round(amount_cny, 2)
  ),
  constraint funding_transactions_idempotency_key_not_blank
    check (btrim(idempotency_key) <> ''),
  constraint funding_transactions_posted_shape check (
    (transaction_status = 'posted' and posted_at is not null)
    or (transaction_status <> 'posted' and posted_at is null)
  ),
  constraint funding_transactions_source_shape check (
    (
      transaction_kind = 'sale_proceeds'
      and sale_id is not null
      and purchase_order_id is null
      and purchase_item_id is null
      and shipment_id is null
      and shipment_item_id is null
      and cost_entry_id is null
      and reversal_of is null
    )
    or (
      transaction_kind = 'purchase_funding'
      and sale_id is null
      and purchase_order_id is not null
      and purchase_item_id is not null
      and shipment_id is null
      and shipment_item_id is null
      and cost_entry_id is not null
      and reversal_of is null
    )
    or (
      transaction_kind = 'cost_funding'
      and sale_id is null
      and purchase_order_id is null
      and purchase_item_id is null
      and ((shipment_id is null and shipment_item_id is null)
        or (shipment_id is not null and shipment_item_id is not null))
      and cost_entry_id is not null
      and reversal_of is null
    )
    or (
      transaction_kind = 'refund'
      and sale_id is null
      and purchase_order_id is null
      and purchase_item_id is null
      and shipment_id is null
      and shipment_item_id is null
      and cost_entry_id is not null
      and reversal_of is not null
    )
    or (
      transaction_kind in ('distribution', 'adjustment')
      and sale_id is null
      and purchase_order_id is null
      and purchase_item_id is null
      and shipment_id is null
      and shipment_item_id is null
      and cost_entry_id is null
      and reversal_of is null
    )
    or (
      transaction_kind = 'reversal'
      and sale_id is null
      and purchase_order_id is null
      and purchase_item_id is null
      and shipment_id is null
      and shipment_item_id is null
      and cost_entry_id is null
      and reversal_of is not null
    )
  )
);

create unique index funding_transactions_one_sale_proceeds_idx
  on public.funding_transactions (portfolio_id, sale_id)
  where sale_id is not null;

create unique index funding_transactions_one_cost_evidence_idx
  on public.funding_transactions (portfolio_id, cost_entry_id)
  where cost_entry_id is not null;

-- Deliberately non-unique: one original transaction may have many partial
-- reversal/refund transactions.
create index funding_transactions_reversal_of_idx
  on public.funding_transactions (portfolio_id, reversal_of, transaction_status)
  where reversal_of is not null;

create index funding_transactions_portfolio_occurred_idx
  on public.funding_transactions (portfolio_id, occurred_at, id);

create table public.funding_allocations (
  id uuid primary key default gen_random_uuid(),
  portfolio_id uuid not null references public.portfolios(id) on delete cascade,
  transaction_id uuid not null,
  account_id uuid not null,
  amount_cny numeric(20, 2) not null,
  created_at timestamptz not null default now(),
  created_by uuid not null references auth.users(id),
  unique (portfolio_id, id),
  unique (transaction_id, account_id),
  foreign key (portfolio_id, transaction_id)
    references public.funding_transactions(portfolio_id, id) on delete cascade,
  foreign key (portfolio_id, account_id)
    references public.funding_accounts(portfolio_id, id) on delete restrict,
  constraint funding_allocations_amount_nonzero check (
    amount_cny <> 0 and amount_cny = round(amount_cny, 2)
  )
);

create index funding_allocations_account_idx
  on public.funding_allocations (portfolio_id, account_id, transaction_id);

create or replace function private.validate_cost_reversal_group(
  p_portfolio_id uuid,
  p_asset_id uuid,
  p_original_entry_id uuid
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_original public.cost_entries%rowtype;
  v_reversed_cny numeric(20, 2);
begin
  if p_original_entry_id is null then
    return;
  end if;

  select entry.*
  into v_original
  from public.cost_entries entry
  where entry.portfolio_id = p_portfolio_id
    and entry.asset_id = p_asset_id
    and entry.id = p_original_entry_id
  for update;

  if not found then
    return;
  end if;

  if v_original.cost_type = 'reversal' or v_original.reversal_of is not null then
    raise exception using
      errcode = '23514',
      message = 'A cost reversal cannot target another reversal.';
  end if;

  if exists (
    select 1
    from public.cost_entries reversal
    where reversal.portfolio_id = p_portfolio_id
      and reversal.asset_id = p_asset_id
      and reversal.reversal_of = p_original_entry_id
      and reversal.entry_status = 'posted'
      and (
        v_original.entry_status <> 'posted'
        or v_original.amount_cny <= 0
        or reversal.cost_type <> 'reversal'
        or reversal.source_type <> 'reversal'
        or reversal.source_id is distinct from p_original_entry_id
        or reversal.amount_cny >= 0
        or reversal.original_amount >= 0
        or reversal.currency <> v_original.currency
        or reversal.fx_rate_to_cny <> v_original.fx_rate_to_cny
        or reversal.occurred_at < v_original.occurred_at
      )
  ) then
    raise exception using
      errcode = '23514',
      message = 'Posted cost reversal evidence is inconsistent with its original entry.';
  end if;

  select coalesce(sum(-reversal.amount_cny), 0)
  into v_reversed_cny
  from public.cost_entries reversal
  where reversal.portfolio_id = p_portfolio_id
    and reversal.asset_id = p_asset_id
    and reversal.reversal_of = p_original_entry_id
    and reversal.entry_status = 'posted';

  if v_reversed_cny > v_original.amount_cny then
    raise exception using
      errcode = '23514',
      message = 'Cumulative cost reversals exceed the original cost amount.';
  end if;
end;
$$;

create or replace function private.validate_cost_reversal_deferred()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if tg_op <> 'DELETE' then
    perform private.validate_cost_reversal_group(
      new.portfolio_id,
      new.asset_id,
      coalesce(new.reversal_of, new.id)
    );
  end if;

  if tg_op <> 'INSERT' then
    perform private.validate_cost_reversal_group(
      old.portfolio_id,
      old.asset_id,
      coalesce(old.reversal_of, old.id)
    );
  end if;

  return null;
end;
$$;

-- Numeric prefixes make the lock order deterministic for cost row events:
-- validate/lock the original cost before revalidating its funding transaction.
create constraint trigger cost_entries_00_validate_reversal_total_deferred
after insert or update or delete on public.cost_entries
deferrable initially deferred
for each row execute function private.validate_cost_reversal_deferred();

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
      or v_sale.sold_at is null
      or v_tx.amount_cny <> v_sale.net_proceeds_cny
      or v_tx.occurred_at <> v_sale.sold_at then
      raise exception using
        errcode = '23514',
        message = 'Sale proceeds funding must exactly match a completed sale and its explicit sold_at.';
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
      or v_tx.occurred_at < v_original_tx.occurred_at then
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

create or replace function private.validate_funding_deferred()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if tg_table_name = 'funding_transactions' then
    if tg_op <> 'DELETE' then
      perform private.validate_funding_transaction(new.portfolio_id, new.id);
    end if;
    if tg_op <> 'INSERT' then
      perform private.validate_funding_transaction(old.portfolio_id, old.id);
    end if;
  else
    if tg_op <> 'DELETE' then
      perform private.validate_funding_transaction(new.portfolio_id, new.transaction_id);
    end if;
    if tg_op <> 'INSERT' then
      perform private.validate_funding_transaction(old.portfolio_id, old.transaction_id);
    end if;
  end if;
  return null;
end;
$$;

create constraint trigger funding_transactions_validate_deferred
after insert or update or delete on public.funding_transactions
deferrable initially deferred
for each row execute function private.validate_funding_deferred();

create constraint trigger funding_allocations_validate_deferred
after insert or update or delete on public.funding_allocations
deferrable initially deferred
for each row execute function private.validate_funding_deferred();

create or replace function private.protect_posted_funding_transaction()
returns trigger
language plpgsql
set search_path = pg_catalog
as $$
begin
  if old.transaction_status = 'posted' then
    raise exception using
      errcode = '55000',
      message = 'Posted funding transactions are immutable; append a reversal.';
  end if;
  if tg_op = 'DELETE' then
    return old;
  end if;
  return new;
end;
$$;

create trigger funding_transactions_protect_posted
before update or delete on public.funding_transactions
for each row execute function private.protect_posted_funding_transaction();

create or replace function private.protect_posted_funding_allocation()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_portfolio_id uuid;
  v_transaction_id uuid;
  v_status public.funding_transaction_status;
begin
  v_portfolio_id := case when tg_op = 'DELETE' then old.portfolio_id else new.portfolio_id end;
  v_transaction_id := case when tg_op = 'DELETE' then old.transaction_id else new.transaction_id end;

  select funding_tx.transaction_status
  into v_status
  from public.funding_transactions funding_tx
  where funding_tx.portfolio_id = v_portfolio_id
    and funding_tx.id = v_transaction_id;

  if v_status = 'posted' then
    raise exception using
      errcode = '55000',
      message = 'Posted funding allocations are immutable; append a reversal.';
  end if;

  if tg_op = 'DELETE' then
    return old;
  end if;
  return new;
end;
$$;

create trigger funding_allocations_protect_posted
before insert or update or delete on public.funding_allocations
for each row execute function private.protect_posted_funding_allocation();

create or replace function private.revalidate_funding_source()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_source_id uuid;
  v_old_source_row jsonb;
  v_new_source_row jsonb;
  v_related_shipment_id uuid;
  v_related_shipment_ids uuid[] := array[]::uuid[];
  v_reference record;
begin
  v_source_id := case when tg_op = 'DELETE' then old.id else new.id end;

  if tg_op <> 'INSERT' then
    v_old_source_row := to_jsonb(old);
  end if;
  if tg_op <> 'DELETE' then
    v_new_source_row := to_jsonb(new);
  end if;

  if tg_table_name = 'shipment_items' then
    if v_old_source_row is not null then
      v_related_shipment_ids := array_append(
        v_related_shipment_ids,
        (v_old_source_row->>'shipment_id')::uuid
      );
    end if;
    if v_new_source_row is not null then
      v_related_shipment_ids := array_append(
        v_related_shipment_ids,
        (v_new_source_row->>'shipment_id')::uuid
      );
    end if;
  elsif tg_table_name = 'cost_entries' then
    if v_old_source_row->>'cost_type' = 'international_shipping'
      and v_old_source_row->>'source_type' = 'shipment_item'
      and nullif(v_old_source_row->>'reversal_of', '') is null then
      select item.shipment_id
      into v_related_shipment_id
      from public.shipment_items item
      where item.portfolio_id = (v_old_source_row->>'portfolio_id')::uuid
        and item.id = (v_old_source_row->>'source_id')::uuid;
      v_related_shipment_ids := array_append(v_related_shipment_ids, v_related_shipment_id);
    end if;

    if v_new_source_row->>'cost_type' = 'international_shipping'
      and v_new_source_row->>'source_type' = 'shipment_item'
      and nullif(v_new_source_row->>'reversal_of', '') is null then
      select item.shipment_id
      into v_related_shipment_id
      from public.shipment_items item
      where item.portfolio_id = (v_new_source_row->>'portfolio_id')::uuid
        and item.id = (v_new_source_row->>'source_id')::uuid;
      v_related_shipment_ids := array_append(v_related_shipment_ids, v_related_shipment_id);
    end if;
  end if;

  for v_reference in
    select distinct funding_tx.portfolio_id, funding_tx.id
    from public.funding_transactions funding_tx
    where
      (tg_table_name = 'sales' and funding_tx.sale_id = v_source_id)
      or (tg_table_name = 'purchase_orders' and funding_tx.purchase_order_id = v_source_id)
      or (tg_table_name = 'purchase_items' and funding_tx.purchase_item_id = v_source_id)
      or (tg_table_name = 'shipments' and funding_tx.shipment_id = v_source_id)
      or (tg_table_name = 'shipment_items' and funding_tx.shipment_item_id = v_source_id)
      or (tg_table_name = 'cost_entries' and funding_tx.cost_entry_id = v_source_id)
      or (
        tg_table_name = 'funding_accounts'
        and exists (
          select 1
          from public.funding_allocations allocation
          where allocation.portfolio_id = funding_tx.portfolio_id
            and allocation.transaction_id = funding_tx.id
            and allocation.account_id = v_source_id
        )
      )
      or (
        funding_tx.shipment_id = any(v_related_shipment_ids)
      )
  loop
    perform private.validate_funding_transaction(v_reference.portfolio_id, v_reference.id);
  end loop;

  return null;
end;
$$;

create constraint trigger sales_revalidate_funding_deferred
after update or delete on public.sales
deferrable initially deferred
for each row execute function private.revalidate_funding_source();

create constraint trigger purchase_orders_revalidate_funding_deferred
after update or delete on public.purchase_orders
deferrable initially deferred
for each row execute function private.revalidate_funding_source();

create constraint trigger purchase_items_revalidate_funding_deferred
after update or delete on public.purchase_items
deferrable initially deferred
for each row execute function private.revalidate_funding_source();

create constraint trigger shipments_revalidate_funding_deferred
after update or delete on public.shipments
deferrable initially deferred
for each row execute function private.revalidate_funding_source();

create constraint trigger shipment_items_revalidate_funding_deferred
after insert or update or delete on public.shipment_items
deferrable initially deferred
for each row execute function private.revalidate_funding_source();

create constraint trigger cost_entries_10_revalidate_funding_deferred
after insert or update or delete on public.cost_entries
deferrable initially deferred
for each row execute function private.revalidate_funding_source();

create constraint trigger funding_accounts_revalidate_funding_deferred
after update or delete on public.funding_accounts
deferrable initially deferred
for each row execute function private.revalidate_funding_source();

create trigger funding_participants_set_updated_at
before update on public.funding_participants
for each row execute function private.set_updated_at();

create trigger funding_accounts_set_updated_at
before update on public.funding_accounts
for each row execute function private.set_updated_at();

create or replace function private.protect_funded_account_identity()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if exists (
    select 1
    from public.funding_allocations allocation
    join public.funding_transactions funding_tx
      on funding_tx.portfolio_id = allocation.portfolio_id
     and funding_tx.id = allocation.transaction_id
    where allocation.portfolio_id = old.portfolio_id
      and allocation.account_id = old.id
      and funding_tx.transaction_status = 'posted'
  ) then
    if tg_op = 'DELETE' then
      raise exception using
        errcode = '55000',
        message = 'A funded account identity is immutable; close it instead.';
    end if;

    if new.portfolio_id is distinct from old.portfolio_id
      or new.id is distinct from old.id
      or new.participant_id is distinct from old.participant_id
      or new.account_code is distinct from old.account_code
      or new.account_kind is distinct from old.account_kind
      or new.currency is distinct from old.currency then
      raise exception using
        errcode = '55000',
        message = 'A funded account identity is immutable; close it instead.';
    end if;
  end if;

  if tg_op = 'DELETE' then
    return old;
  end if;
  return new;
end;
$$;

create trigger funding_accounts_protect_funded_identity
before update or delete on public.funding_accounts
for each row execute function private.protect_funded_account_identity();

alter table public.funding_participants enable row level security;
alter table public.funding_accounts enable row level security;
alter table public.funding_transactions enable row level security;
alter table public.funding_allocations enable row level security;

create policy funding_participants_select_member
on public.funding_participants for select to authenticated
using ((select private.is_portfolio_member(portfolio_id)));

create policy funding_participants_insert_writer
on public.funding_participants for insert to authenticated
with check (
  (select private.can_write_portfolio(portfolio_id))
  and created_by = (select auth.uid())
);

create policy funding_participants_update_writer
on public.funding_participants for update to authenticated
using ((select private.can_write_portfolio(portfolio_id)))
with check ((select private.can_write_portfolio(portfolio_id)));

create policy funding_participants_delete_writer
on public.funding_participants for delete to authenticated
using ((select private.can_write_portfolio(portfolio_id)));

create policy funding_accounts_select_member
on public.funding_accounts for select to authenticated
using ((select private.is_portfolio_member(portfolio_id)));

create policy funding_accounts_insert_writer
on public.funding_accounts for insert to authenticated
with check (
  (select private.can_write_portfolio(portfolio_id))
  and created_by = (select auth.uid())
);

create policy funding_accounts_update_writer
on public.funding_accounts for update to authenticated
using ((select private.can_write_portfolio(portfolio_id)))
with check ((select private.can_write_portfolio(portfolio_id)));

create policy funding_accounts_delete_writer
on public.funding_accounts for delete to authenticated
using ((select private.can_write_portfolio(portfolio_id)));

create policy funding_transactions_select_member
on public.funding_transactions for select to authenticated
using ((select private.is_portfolio_member(portfolio_id)));

create policy funding_transactions_insert_writer
on public.funding_transactions for insert to authenticated
with check (
  (select private.can_write_portfolio(portfolio_id))
  and created_by = (select auth.uid())
);

create policy funding_transactions_update_writer
on public.funding_transactions for update to authenticated
using ((select private.can_write_portfolio(portfolio_id)))
with check (
  (select private.can_write_portfolio(portfolio_id))
  and created_by = (select auth.uid())
);

create policy funding_transactions_delete_writer
on public.funding_transactions for delete to authenticated
using ((select private.can_write_portfolio(portfolio_id)));

create policy funding_allocations_select_member
on public.funding_allocations for select to authenticated
using ((select private.is_portfolio_member(portfolio_id)));

create policy funding_allocations_insert_writer
on public.funding_allocations for insert to authenticated
with check (
  (select private.can_write_portfolio(portfolio_id))
  and created_by = (select auth.uid())
);

create policy funding_allocations_update_writer
on public.funding_allocations for update to authenticated
using ((select private.can_write_portfolio(portfolio_id)))
with check (
  (select private.can_write_portfolio(portfolio_id))
  and created_by = (select auth.uid())
);

create policy funding_allocations_delete_writer
on public.funding_allocations for delete to authenticated
using ((select private.can_write_portfolio(portfolio_id)));

create view public.funding_transaction_balances
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
  original.posted_at
from public.funding_transactions original
left join reversal_totals reversal
  on reversal.portfolio_id = original.portfolio_id
 and reversal.transaction_id = original.id
where original.transaction_status = 'posted'
  and original.reversal_of is null;

create view public.funding_account_balances
with (security_invoker = true)
as
select
  account.portfolio_id,
  account.id as account_id,
  account.account_code,
  account.display_name,
  account.account_kind,
  account.participant_id,
  coalesce(sum(allocation.amount_cny) filter (
    where funding_tx.transaction_status = 'posted'
      and allocation.amount_cny > 0
  ), 0::numeric) as gross_inflow_cny,
  coalesce(sum(-allocation.amount_cny) filter (
    where funding_tx.transaction_status = 'posted'
      and allocation.amount_cny < 0
  ), 0::numeric) as gross_outflow_cny,
  coalesce(sum(allocation.amount_cny) filter (
    where funding_tx.transaction_status = 'posted'
  ), 0::numeric) as balance_cny
from public.funding_accounts account
left join public.funding_allocations allocation
  on allocation.portfolio_id = account.portfolio_id
 and allocation.account_id = account.id
left join public.funding_transactions funding_tx
  on funding_tx.portfolio_id = allocation.portfolio_id
 and funding_tx.id = allocation.transaction_id
group by
  account.portfolio_id,
  account.id,
  account.account_code,
  account.display_name,
  account.account_kind,
  account.participant_id;

create view public.funding_participant_contributions
with (security_invoker = true)
as
select
  participant.portfolio_id,
  participant.id as participant_id,
  participant.display_name,
  coalesce(sum(balance.gross_inflow_cny), 0::numeric) as gross_contribution_cny,
  coalesce(sum(balance.gross_outflow_cny), 0::numeric) as reversed_or_distributed_cny,
  coalesce(sum(balance.balance_cny), 0::numeric) as net_contribution_cny
from public.funding_participants participant
left join public.funding_account_balances balance
  on balance.portfolio_id = participant.portfolio_id
 and balance.participant_id = participant.id
 and balance.account_kind = 'participant_capital'
group by participant.portfolio_id, participant.id, participant.display_name;

create view public.sales_proceeds_pool_balances
with (security_invoker = true)
as
select
  balance.portfolio_id,
  balance.account_id,
  balance.gross_inflow_cny,
  balance.gross_outflow_cny,
  balance.balance_cny
from public.funding_account_balances balance
where balance.account_kind = 'sales_proceeds_pool';

comment on table public.funding_transactions is
  'Immutable source/destination ledger only. Never included in asset carrying cost or ROI.';
comment on view public.sales_proceeds_pool_balances is
  'Cash funding pool balance; it is not a profit pool.';

revoke all on function private.validate_cost_reversal_group(uuid, uuid, uuid) from public;
revoke all on function private.validate_cost_reversal_deferred() from public;
revoke all on function private.validate_funding_transaction(uuid, uuid) from public;
revoke all on function private.validate_funding_deferred() from public;
revoke all on function private.protect_posted_funding_transaction() from public;
revoke all on function private.protect_posted_funding_allocation() from public;
revoke all on function private.protect_funded_account_identity() from public;
revoke all on function private.revalidate_funding_source() from public;

revoke all on public.funding_participants from public, anon;
revoke all on public.funding_accounts from public, anon;
revoke all on public.funding_transactions from public, anon;
revoke all on public.funding_allocations from public, anon;

grant select, insert, update, delete on
  public.funding_participants,
  public.funding_accounts,
  public.funding_transactions,
  public.funding_allocations
to authenticated;

grant select on
  public.funding_transaction_balances,
  public.funding_account_balances,
  public.funding_participant_contributions,
  public.sales_proceeds_pool_balances
to authenticated, service_role;

grant all on
  public.funding_participants,
  public.funding_accounts,
  public.funding_transactions,
  public.funding_allocations
to service_role;
