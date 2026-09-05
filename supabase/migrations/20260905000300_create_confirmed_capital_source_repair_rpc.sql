-- Definition only: this migration does not call the repair RPC.
-- Fixed, confirmed assets only. Funding is handled separately by 00200.
create function public.reconcile_confirmed_capital_source_facts(
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
  v_sii constant uuid := 'a847b8d7-a50d-4bdd-bdf7-2258dda5f679';
  v_t2 constant uuid := '99d47bd7-4990-4a55-bbeb-eebea4ef2ca4';
  v_tvs constant uuid := '5dc2aac1-cea2-445c-ab4d-646bf2a27489';
  v_refund_at constant timestamptz := '2026-09-04 17:40:41+08:00';
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
  v_result jsonb := '{}'::jsonb;
  v_pass integer;
begin
  if v_actor is null then
    raise exception using errcode = '28000', message = 'Authentication required.';
  end if;
  if p_portfolio_id is null or not private.can_write_portfolio(p_portfolio_id) then
    raise exception using errcode = '42501', message = 'Portfolio write access required.';
  end if;
  if p_autoboy_sii_sold_at is null or not isfinite(p_autoboy_sii_sold_at)
    or (p_autoboy_sii_sold_at at time zone 'Asia/Shanghai')::date <> date '2026-09-02'
    or p_t2_shipping_paid_at is null or not isfinite(p_t2_shipping_paid_at)
    or p_t2_shipping_paid_at > v_refund_at
    or p_tvs_shipping_paid_at is null or not isfinite(p_tvs_shipping_paid_at) then
    raise exception using errcode = '22023',
      message = 'Explicit evidenced sale and shipping payment timestamps required; S II sale date must be 2026-09-02 in Asia/Shanghai.';
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
      if v_receipt.action <> 'confirmed_capital_source_repaired_v1'
        or v_receipt.after_data->'arguments' is distinct from v_args
        or v_receipt.after_data->'snapshot' is distinct from v_snapshot then
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
      sold_price_cny, platform_fees_cny, outbound_shipping_cny, sold_at, created_by)
    values (v_sale, p_portfolio_id, v_sii, 'confirmed-capital-source-v1:sii-sale', 'sold',
      '口令红包直接到账', 1288, 0, 0, p_autoboy_sii_sold_at, v_actor);
    update public.assets set operational_status = 'sold'
    where portfolio_id = p_portfolio_id and id = v_sii;
    insert into public.asset_status_events(portfolio_id, asset_id, operational_status, note, occurred_at, created_by)
    values (p_portfolio_id, v_sii, 'sold', 'Confirmed standalone S II sale: direct receipt.', p_autoboy_sii_sold_at, v_actor);
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
