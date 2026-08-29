-- Settle a shipment's pending shipping budget into posted actual costs while
-- preserving the locked shipment-item allocation snapshot.

create or replace function public.settle_shipment_shipping_actual(
  p_shipment_id uuid,
  p_expected_budget_cny numeric,
  p_actual_paid_cny numeric,
  p_evidence jsonb
)
returns jsonb
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_user_id uuid := (select auth.uid());
  v_portfolio_id uuid;
  v_current_budget_cny numeric(20, 2);
  v_current_actual_cny numeric(20, 2);
  v_item_count integer;
  v_cost_count integer;
  v_updated_count integer;
  v_ratio_total numeric;
  v_pending_total numeric(20, 2);
  v_item_snapshot jsonb;
  v_before_costs jsonb;
  v_after_costs jsonb;
  v_audit_id uuid := gen_random_uuid();
begin
  if v_user_id is null then
    raise exception using errcode = '28000', message = 'Authentication required.';
  end if;

  if p_expected_budget_cny is null
    or p_expected_budget_cny < 0
    or p_expected_budget_cny <> round(p_expected_budget_cny, 2)
    or p_actual_paid_cny is null
    or p_actual_paid_cny <= 0
    or p_actual_paid_cny <> round(p_actual_paid_cny, 2) then
    raise exception using errcode = '22023', message = 'Budget and actual CNY amounts must use 0.01 precision.';
  end if;

  if p_evidence is null
    or jsonb_typeof(p_evidence) <> 'object'
    or nullif(btrim(p_evidence->>'merchant'), '') is null
    or nullif(btrim(p_evidence->>'payment_time'), '') is null
    or nullif(btrim(p_evidence->>'provider_order'), '') is null
    or nullif(btrim(p_evidence->>'merchant_reference'), '') is null
    or (p_evidence->>'invoice_jpy')::numeric <= 0
    or (p_evidence->>'actual_debit_cny')::numeric is distinct from p_actual_paid_cny
    or (p_evidence->>'package_weight_g')::integer <= 0 then
    raise exception using errcode = '22023', message = 'Complete shipping settlement evidence is required.';
  end if;

  -- Validate the timestamp without assigning it to shipment tracking fields.
  perform (p_evidence->>'payment_time')::timestamptz;

  select shipment.portfolio_id, shipment.budget_cny, shipment.actual_paid_cny
  into v_portfolio_id, v_current_budget_cny, v_current_actual_cny
  from public.shipments shipment
  where shipment.id = p_shipment_id
  for update;

  if v_portfolio_id is null then
    raise exception using errcode = 'P0002', message = 'Shipment was not found through RLS.';
  end if;

  if not (select private.can_write_portfolio(v_portfolio_id)) then
    raise exception using errcode = '42501', message = 'Portfolio write access required.';
  end if;

  if v_current_actual_cny <> 0 then
    raise exception using errcode = '22023', message = 'Shipment already has an actual paid amount.';
  end if;

  if v_current_budget_cny is distinct from p_expected_budget_cny then
    raise exception using errcode = '22023', message = 'Shipment budget changed before settlement.';
  end if;

  -- Lock the immutable allocation snapshots and their corresponding costs.
  perform 1
  from public.shipment_items item
  where item.portfolio_id = v_portfolio_id
    and item.shipment_id = p_shipment_id
  for update;

  perform 1
  from public.cost_entries entry
  join public.shipment_items item
    on item.portfolio_id = entry.portfolio_id
   and item.id = entry.source_id
  where item.portfolio_id = v_portfolio_id
    and item.shipment_id = p_shipment_id
    and entry.source_type = 'shipment_item'
    and entry.cost_type = 'international_shipping'
  for update of entry;

  select count(*), sum(item.allocation_ratio)
  into v_item_count, v_ratio_total
  from public.shipment_items item
  where item.portfolio_id = v_portfolio_id
    and item.shipment_id = p_shipment_id;

  if v_item_count = 0 or v_ratio_total is null or v_ratio_total <= 0 then
    raise exception using errcode = '22023', message = 'Shipment has no usable allocation ratios.';
  end if;

  select count(*), coalesce(sum(entry.amount_cny), 0)
  into v_cost_count, v_pending_total
  from public.shipment_items item
  join public.cost_entries entry
    on entry.portfolio_id = item.portfolio_id
   and entry.asset_id = item.asset_id
   and entry.source_type = 'shipment_item'
   and entry.source_id = item.id
   and entry.cost_type = 'international_shipping'
  where item.portfolio_id = v_portfolio_id
    and item.shipment_id = p_shipment_id
    and entry.entry_status = 'pending';

  if v_cost_count <> v_item_count then
    raise exception using errcode = '22023', message = 'Shipment items and pending shipping costs are not one-to-one.';
  end if;

  if v_pending_total is distinct from p_expected_budget_cny then
    raise exception using errcode = '22023', message = 'Pending shipping total changed before settlement.';
  end if;

  if exists (
    select 1
    from public.shipment_items item
    join public.cost_entries entry
      on entry.portfolio_id = item.portfolio_id
     and entry.asset_id = item.asset_id
     and entry.source_type = 'shipment_item'
     and entry.source_id = item.id
     and entry.cost_type = 'international_shipping'
    where item.portfolio_id = v_portfolio_id
      and item.shipment_id = p_shipment_id
      and (
        entry.entry_status <> 'pending'
        or entry.amount_cny is distinct from item.allocated_shipping_cny
        or entry.currency <> 'CNY'
        or entry.fx_rate_to_cny <> 1
      )
  ) then
    raise exception using errcode = '22023', message = 'Pending shipping costs no longer match the locked budget snapshot.';
  end if;

  if exists (
    select 1
    from public.cost_entries entry
    where entry.portfolio_id = v_portfolio_id
      and entry.cost_type = 'international_shipping'
      and entry.entry_status = 'posted'
      and (
        (entry.source_type = 'shipment' and entry.source_id = p_shipment_id)
        or (
          entry.source_type = 'shipment_item'
          and entry.source_id in (
            select item.id
            from public.shipment_items item
            where item.portfolio_id = v_portfolio_id
              and item.shipment_id = p_shipment_id
          )
        )
      )
  ) then
    raise exception using errcode = '22023', message = 'Shipment already has posted international shipping costs.';
  end if;

  select coalesce(jsonb_agg(jsonb_build_object(
    'shipment_item_id', item.id,
    'asset_id', item.asset_id,
    'allocation_ratio', item.allocation_ratio,
    'locked_budget_cny', item.allocated_shipping_cny,
    'allocation_locked_at', item.allocation_locked_at,
    'allocation_version', item.allocation_version
  ) order by item.id), '[]'::jsonb)
  into v_item_snapshot
  from public.shipment_items item
  where item.portfolio_id = v_portfolio_id
    and item.shipment_id = p_shipment_id;

  select coalesce(jsonb_agg(jsonb_build_object(
    'cost_entry_id', entry.id,
    'asset_id', entry.asset_id,
    'source_type', entry.source_type,
    'source_id', entry.source_id,
    'amount_cny', entry.amount_cny,
    'entry_status', entry.entry_status
  ) order by entry.id), '[]'::jsonb)
  into v_before_costs
  from public.shipment_items item
  join public.cost_entries entry
    on entry.portfolio_id = item.portfolio_id
   and entry.asset_id = item.asset_id
   and entry.source_type = 'shipment_item'
   and entry.source_id = item.id
   and entry.cost_type = 'international_shipping'
  where item.portfolio_id = v_portfolio_id
    and item.shipment_id = p_shipment_id;

  with ratio_shares as (
    select
      item.id as shipment_item_id,
      item.asset_id,
      entry.id as cost_entry_id,
      item.allocation_ratio,
      round(p_actual_paid_cny * item.allocation_ratio / v_ratio_total, 2) as rounded_amount,
      row_number() over (
        order by item.allocation_ratio desc, item.id
      ) as residual_rank
    from public.shipment_items item
    join public.cost_entries entry
      on entry.portfolio_id = item.portfolio_id
     and entry.asset_id = item.asset_id
     and entry.source_type = 'shipment_item'
     and entry.source_id = item.id
     and entry.cost_type = 'international_shipping'
    where item.portfolio_id = v_portfolio_id
      and item.shipment_id = p_shipment_id
  ),
  residual as (
    select p_actual_paid_cny - sum(share.rounded_amount) as amount
    from ratio_shares share
  ),
  final_shares as (
    select
      share.shipment_item_id,
      share.asset_id,
      share.cost_entry_id,
      share.allocation_ratio,
      share.rounded_amount
        + case when share.residual_rank = 1 then residual.amount else 0 end as actual_amount
    from ratio_shares share
    cross join residual
  ),
  updated as (
    update public.cost_entries entry
    set original_amount = share.actual_amount,
        amount_cny = share.actual_amount,
        entry_status = 'posted'
    from final_shares share
    where entry.id = share.cost_entry_id
      and entry.portfolio_id = v_portfolio_id
      and entry.entry_status = 'pending'
    returning
      entry.id,
      entry.asset_id,
      entry.source_type,
      entry.source_id,
      entry.amount_cny,
      entry.entry_status
  )
  select
    coalesce(jsonb_agg(jsonb_build_object(
      'cost_entry_id', updated.id,
      'asset_id', updated.asset_id,
      'source_type', updated.source_type,
      'source_id', updated.source_id,
      'amount_cny', updated.amount_cny,
      'entry_status', updated.entry_status
    ) order by updated.id), '[]'::jsonb),
    count(*)
  into v_after_costs, v_updated_count
  from updated;

  if v_updated_count <> v_item_count then
    raise exception using errcode = 'P0001', message = 'Not all pending shipping costs were settled.';
  end if;

  if (
    select coalesce(sum((cost->>'amount_cny')::numeric), 0)
    from jsonb_array_elements(v_after_costs) cost
  ) is distinct from p_actual_paid_cny then
    raise exception using errcode = 'P0001', message = 'Rounded actual shipping allocations do not equal the paid total.';
  end if;

  update public.shipments
  set actual_paid_cny = p_actual_paid_cny
  where id = p_shipment_id
    and portfolio_id = v_portfolio_id
    and actual_paid_cny = 0
    and budget_cny = p_expected_budget_cny;

  get diagnostics v_updated_count = row_count;
  if v_updated_count <> 1 then
    raise exception using errcode = 'P0001', message = 'Shipment changed during settlement.';
  end if;

  insert into public.audit_logs (
    id,
    portfolio_id,
    actor_id,
    action,
    entity_type,
    entity_id,
    before_data,
    after_data
  ) values (
    v_audit_id,
    v_portfolio_id,
    v_user_id,
    'shipping_actual_settlement',
    'shipment',
    p_shipment_id,
    jsonb_build_object(
      'budget_cny', v_current_budget_cny,
      'actual_paid_cny', v_current_actual_cny,
      'shipment_items', v_item_snapshot,
      'cost_entries', v_before_costs
    ),
    jsonb_build_object(
      'budget_cny', v_current_budget_cny,
      'actual_paid_cny', p_actual_paid_cny,
      'variance_cny', p_actual_paid_cny - v_current_budget_cny,
      'shipment_items', v_item_snapshot,
      'cost_entries', v_after_costs,
      'evidence', p_evidence
    )
  );

  return jsonb_build_object(
    'shipment_id', p_shipment_id,
    'audit_id', v_audit_id,
    'budget_cny', v_current_budget_cny,
    'actual_paid_cny', p_actual_paid_cny,
    'variance_cny', p_actual_paid_cny - v_current_budget_cny,
    'shipment_items', v_item_snapshot,
    'cost_entries', v_after_costs
  );
end;
$$;

revoke all on function public.settle_shipment_shipping_actual(uuid, numeric, numeric, jsonb)
  from public, anon;
grant execute on function public.settle_shipment_shipping_actual(uuid, numeric, numeric, jsonb)
  to authenticated;
