-- Definition only. This migration never calls either reconciliation function.
-- Historical source IDs below were read from the confirmed production evidence.

create function public.reconcile_partner_b_historical_funding(
  p_portfolio_id uuid
)
returns jsonb
language plpgsql
security invoker
set search_path = ''
set timezone = 'UTC'
as $$
declare
  v_actor uuid := auth.uid();
  v_partner_b_account uuid;
  v_event record;
  v_order_id uuid;
  v_shipment_id uuid;
  v_occurred_at timestamptz;
  v_count integer;
  v_result jsonb := '[]'::jsonb;
  v_receipt_id uuid;
  v_receipt public.audit_logs%rowtype;
  v_partner_b_total numeric;
  v_historical_total numeric;
  v_historical_count integer;
  v_historical_keys jsonb;
  v_tvs_total numeric;
  v_events jsonb := jsonb_build_array(
    jsonb_build_object('key','sii-standalone-purchase','kind','purchase_funding','asset_id','a847b8d7-a50d-4bdd-bdf7-2258dda5f679','item_id','a533bcc8-e9ca-5463-a221-b9e8045c1cb4','cost_id','327e8837-c440-4fd9-ad75-4a596db268a8','amount',986.00),
    jsonb_build_object('key','sii-standalone-shipping','kind','cost_funding','asset_id','a847b8d7-a50d-4bdd-bdf7-2258dda5f679','item_id','4539af29-2fa8-5c66-856e-a2f28b4dc794','cost_id','963d219b-3cb2-4e7c-9f3c-7f4e7ab75113','amount',106.00),
    jsonb_build_object('key','t2-date-back-purchase','kind','purchase_funding','asset_id','5c4e8a70-2828-47d4-aad7-928b6e5cc56d','item_id','bfa9157f-a7fd-59d9-b324-6e2fdcfb63f1','cost_id','868237bb-2cd8-4e1e-bd7b-44e5c8865f17','amount',4913.00),
    jsonb_build_object('key','t2-date-back-shipping','kind','cost_funding','asset_id','5c4e8a70-2828-47d4-aad7-928b6e5cc56d','item_id','738b2ae9-6cc6-560d-a3c4-8d7a7d580db5','cost_id','8a4a1cf8-683f-4623-904a-a4629d8f8d38','amount',115.00),
    jsonb_build_object('key','nikon-28ti-purchase','kind','purchase_funding','asset_id','c8506c0d-89bd-43c5-8467-b748dbc2eab8','item_id','89f97dfd-2141-520f-8d26-c0be27c8ab3f','cost_id','19b02f8e-6e27-450f-bd26-598926de284f','amount',6505.00),
    jsonb_build_object('key','nikon-28ti-shipping','kind','cost_funding','asset_id','c8506c0d-89bd-43c5-8467-b748dbc2eab8','item_id','72dfb7c9-62a1-51ff-9426-9a2b02fe0e7e','cost_id','97f2b550-e975-40d0-b2f5-51789aebb174','amount',95.68),
    jsonb_build_object('key','canon-sii-bundle-purchase','kind','purchase_funding','asset_id','c916a37b-9ac6-43ff-b97b-577ef9120414','item_id','67df5aaa-8d45-508d-9934-45e59ac94769','cost_id','47557ddb-e9d5-408e-ae45-d35c8a66bfeb','amount',603.00),
    jsonb_build_object('key','canon-sii-bundle-shipping','kind','cost_funding','asset_id','c916a37b-9ac6-43ff-b97b-577ef9120414','item_id','bb608a88-3a8b-5796-9078-23f8ed3b1b52','cost_id','0e04c36b-40db-43bd-ac65-5ec1531f7303','amount',64.66),
    jsonb_build_object('key','canon-s-bundle-purchase','kind','purchase_funding','asset_id','a0c926a0-7c45-4951-bd68-d127ae0a8fc1','item_id','1517f0d6-40f5-52ac-9b05-eb59c1a92d8f','cost_id','fa4874f1-1a83-4588-91ef-3e0ed61e28a0','amount',603.00),
    jsonb_build_object('key','canon-s-bundle-shipping','kind','cost_funding','asset_id','a0c926a0-7c45-4951-bd68-d127ae0a8fc1','item_id','074fb4b9-8903-5d6b-b364-6b097a7863fe','cost_id','aacf4e35-4314-4dba-824f-42832a70d56c','amount',64.66),
    jsonb_build_object('key','rollei-35-classic-titanium-purchase','kind','purchase_funding','asset_id','b70d89c7-a314-4ad0-9024-890485f172ba','item_id','608082a2-96e3-49b9-a40c-f30d19342c53','cost_id','5b0209ad-6b8e-4249-a2c9-275782e5e765','amount',6520.00),
    jsonb_build_object('key','rollei-35-classic-titanium-shipping','kind','cost_funding','asset_id','b70d89c7-a314-4ad0-9024-890485f172ba','item_id','69e3aa75-ef00-403e-ad54-e9f449fa9422','cost_id','f167f41e-f65b-4a7c-a86e-b1f996c4e9c8','amount',146.00)
  );
begin
  if v_actor is null then
    raise exception using errcode = '28000', message = 'Authentication required.';
  end if;
  if p_portfolio_id is null or not private.can_write_portfolio(p_portfolio_id) then
    raise exception using errcode = '42501', message = 'Portfolio write access required.';
  end if;
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(p_portfolio_id::text || ':partner-b-historical-funding-v1', 0));

  select id into v_partner_b_account from public.funding_accounts
  where portfolio_id = p_portfolio_id and account_code = 'partner_b_capital'
    and account_kind = 'participant_capital' and closed_at is null for update;
  if not found then
    raise exception using errcode = 'P0002', message = 'Partner B capital account must exist before historical reconciliation.';
  end if;

  -- A complete preflight precedes every insert. Parent IDs and timestamps come
  -- only from the locked source rows; no date, order, or shipment is inferred.
  for v_event in select value as data from jsonb_array_elements(v_events) loop
    if v_event.data->>'kind' = 'purchase_funding' then
      select i.purchase_order_id, c.occurred_at into v_order_id, v_occurred_at
      from public.cost_entries c
      join public.purchase_items i on i.portfolio_id = c.portfolio_id and i.id = c.source_id
      join public.assets a on a.portfolio_id = c.portfolio_id and a.id = c.asset_id
      where c.portfolio_id = p_portfolio_id and c.id = (v_event.data->>'cost_id')::uuid
        and c.asset_id = (v_event.data->>'asset_id')::uuid and i.asset_id = c.asset_id
        and i.id = (v_event.data->>'item_id')::uuid and c.cost_type = 'purchase'
        and c.source_type = 'purchase_item' and c.entry_status = 'posted'
        and c.amount_cny = (v_event.data->>'amount')::numeric
      for update of c, i, a;
      if not found or v_order_id is null or v_occurred_at is null then
        raise exception using errcode = '23514', message = 'Historical purchase evidence does not exactly match the confirmed source.';
      end if;
    else
      select i.shipment_id, c.occurred_at into v_shipment_id, v_occurred_at
      from public.cost_entries c
      join public.shipment_items i on i.portfolio_id = c.portfolio_id and i.id = c.source_id
      join public.assets a on a.portfolio_id = c.portfolio_id and a.id = c.asset_id
      where c.portfolio_id = p_portfolio_id and c.id = (v_event.data->>'cost_id')::uuid
        and c.asset_id = (v_event.data->>'asset_id')::uuid and i.asset_id = c.asset_id
        and i.id = (v_event.data->>'item_id')::uuid and c.cost_type = 'international_shipping'
        and c.source_type = 'shipment_item' and c.entry_status = 'posted'
        and c.amount_cny = (v_event.data->>'amount')::numeric
      for update of c, i, a;
      if not found or v_shipment_id is null or v_occurred_at is null then
        raise exception using errcode = '23514', message = 'Historical international shipping evidence does not exactly match the confirmed source.';
      end if;
    end if;
    select count(*) into v_count from public.funding_transactions t
    where t.portfolio_id = p_portfolio_id and t.transaction_status = 'posted'
      and t.cost_entry_id = (v_event.data->>'cost_id')::uuid
      and t.idempotency_key <> 'partner-b-historical-funding-v1:' || (v_event.data->>'key');
    if v_count <> 0 then
      raise exception using errcode = '23514', message = 'A historical cost entry already has different posted funding.';
    end if;
  end loop;
  if (select count(*) from jsonb_array_elements(v_events)) <> 12
    or (select coalesce(sum((value->>'amount')::numeric), 0) from jsonb_array_elements(v_events)) <> 20722.00 then
    raise exception using errcode = '23514', message = 'Historical funding plan is incomplete.';
  end if;
  select jsonb_agg(value->>'key' order by value->>'key') into v_historical_keys
  from jsonb_array_elements(v_events);

  -- The two TVS II events are required as already-posted source funding. They
  -- contribute 2665 but are never created by this reconciliation.
  select count(*), coalesce(sum(t.amount_cny), 0) into v_count, v_tvs_total
  from public.funding_transactions t
  join public.funding_allocations al on al.portfolio_id = t.portfolio_id and al.transaction_id = t.id
  where t.portfolio_id = p_portfolio_id and t.transaction_status = 'posted'
    and ((t.idempotency_key = 'confirmed-capital-funding-v1:tvs-purchase' and t.transaction_kind = 'purchase_funding'
      and t.amount_cny = 2533 and al.account_id = v_partner_b_account and al.amount_cny = 2533
      and exists (select 1 from public.cost_entries c join public.purchase_items i
        on i.portfolio_id = c.portfolio_id and i.id = c.source_id
        where c.portfolio_id = p_portfolio_id and c.id = t.cost_entry_id and i.id = t.purchase_item_id
          and t.purchase_order_id = i.purchase_order_id
          and c.asset_id = '5dc2aac1-cea2-445c-ab4d-646bf2a27489'::uuid and c.cost_type = 'purchase'
          and c.source_type = 'purchase_item' and c.entry_status = 'posted' and c.amount_cny = 2533)
      and (select count(*) from public.funding_allocations all_allocations
        where all_allocations.portfolio_id = t.portfolio_id and all_allocations.transaction_id = t.id) = 1)
      or (t.idempotency_key = 'confirmed-capital-funding-v1:tvs-ems' and t.transaction_kind = 'cost_funding'
      and t.amount_cny = 132 and al.account_id = v_partner_b_account and al.amount_cny = 132
      and exists (select 1 from public.cost_entries c join public.shipment_items i
        on i.portfolio_id = c.portfolio_id and i.id = c.source_id
        where c.portfolio_id = p_portfolio_id and c.id = t.cost_entry_id and i.id = t.shipment_item_id
          and t.shipment_id = i.shipment_id
          and c.asset_id = '5dc2aac1-cea2-445c-ab4d-646bf2a27489'::uuid and c.cost_type = 'international_shipping'
          and c.source_type = 'shipment_item' and c.entry_status = 'posted' and c.amount_cny = 132)
      and (select count(*) from public.funding_allocations all_allocations
        where all_allocations.portfolio_id = t.portfolio_id and all_allocations.transaction_id = t.id) = 1));
  if v_count <> 2 or v_tvs_total <> 2665 then
    raise exception using errcode = '23514', message = 'Existing TVS II Partner B funding must be exactly 2533 plus 132.';
  end if;

  for v_event in select value as data from jsonb_array_elements(v_events) loop
    if v_event.data->>'kind' = 'purchase_funding' then
      select i.purchase_order_id, c.occurred_at into strict v_order_id, v_occurred_at
      from public.cost_entries c join public.purchase_items i on i.portfolio_id = c.portfolio_id and i.id = c.source_id
      where c.portfolio_id = p_portfolio_id and c.id = (v_event.data->>'cost_id')::uuid;
      v_result := v_result || jsonb_build_array(public.reconcile_capital_funding_transaction(
        p_portfolio_id, 'purchase_funding', (v_event.data->>'amount')::numeric, v_occurred_at,
        'partner-b-historical-funding-v1:' || (v_event.data->>'key'),
        jsonb_build_array(jsonb_build_object('account_id', v_partner_b_account, 'amount_cny', (v_event.data->>'amount')::numeric)),
        null, v_order_id, (v_event.data->>'item_id')::uuid, null, null, (v_event.data->>'cost_id')::uuid, null,
        '历史 Partner B 资金补录'));
    else
      select i.shipment_id, c.occurred_at into strict v_shipment_id, v_occurred_at
      from public.cost_entries c join public.shipment_items i on i.portfolio_id = c.portfolio_id and i.id = c.source_id
      where c.portfolio_id = p_portfolio_id and c.id = (v_event.data->>'cost_id')::uuid;
      v_result := v_result || jsonb_build_array(public.reconcile_capital_funding_transaction(
        p_portfolio_id, 'cost_funding', (v_event.data->>'amount')::numeric, v_occurred_at,
        'partner-b-historical-funding-v1:' || (v_event.data->>'key'),
        jsonb_build_array(jsonb_build_object('account_id', v_partner_b_account, 'amount_cny', (v_event.data->>'amount')::numeric)),
        null, null, null, v_shipment_id, (v_event.data->>'item_id')::uuid, (v_event.data->>'cost_id')::uuid, null,
        '历史 Partner B 资金补录'));
    end if;
  end loop;
  select balance_cny into strict v_partner_b_total from public.funding_account_balances
  where portfolio_id = p_portfolio_id and account_id = v_partner_b_account;
  with expected as (
    select value as data from jsonb_array_elements(v_events)
  ), exact_historical as (
    select t.amount_cny
    from expected
    join public.cost_entries c on c.portfolio_id = p_portfolio_id
      and c.id = (expected.data->>'cost_id')::uuid
      and c.occurred_at is not null
    join public.funding_transactions t on t.portfolio_id = p_portfolio_id
      and t.idempotency_key = 'partner-b-historical-funding-v1:' || (expected.data->>'key')
      and t.transaction_status = 'posted'
      and t.transaction_kind = (expected.data->>'kind')::public.funding_transaction_kind
      and t.amount_cny = (expected.data->>'amount')::numeric
      and t.cost_entry_id = c.id and t.occurred_at = c.occurred_at
    join public.funding_allocations al on al.portfolio_id = t.portfolio_id and al.transaction_id = t.id
      and al.account_id = v_partner_b_account and al.amount_cny = (expected.data->>'amount')::numeric
    left join public.purchase_items i on expected.data->>'kind' = 'purchase_funding'
      and i.portfolio_id = p_portfolio_id and i.id = (expected.data->>'item_id')::uuid
    left join public.shipment_items s on expected.data->>'kind' = 'cost_funding'
      and s.portfolio_id = p_portfolio_id and s.id = (expected.data->>'item_id')::uuid
    where ((expected.data->>'kind' = 'purchase_funding'
        and t.purchase_item_id = i.id and t.purchase_order_id = i.purchase_order_id)
      or (expected.data->>'kind' = 'cost_funding'
        and t.shipment_item_id = s.id and t.shipment_id = s.shipment_id))
      and (select count(*) from public.funding_allocations all_allocations
        where all_allocations.portfolio_id = t.portfolio_id and all_allocations.transaction_id = t.id) = 1
  )
  select count(*), coalesce(sum(amount_cny), 0) into v_count, v_historical_total from exact_historical;
  select count(*) into v_historical_count from public.funding_transactions
  where portfolio_id = p_portfolio_id and transaction_status = 'posted'
    and idempotency_key like 'partner-b-historical-funding-v1:%';
  if v_count <> 12 or v_historical_count <> 12 or v_historical_total <> 20722.00 then
    raise exception using errcode = '23514', message = 'Historical Partner B funding slice is incomplete or does not reconcile.';
  end if;
  v_receipt_id := md5(p_portfolio_id::text || ':partner-b-historical-funding-v1:receipt')::uuid;
  select * into v_receipt from public.audit_logs
  where portfolio_id = p_portfolio_id and id = v_receipt_id for update;
  if found then
    if v_receipt.action <> 'partner_b_historical_funding_reconciled_v1'
      or v_receipt.entity_type <> 'funding_reconciliation' or v_receipt.entity_id <> v_receipt_id
      or v_receipt.after_data->'historical_keys' is distinct from v_historical_keys
      or (v_receipt.after_data->>'historical_transaction_count')::integer <> 12
      or (v_receipt.after_data->>'historical_funding_cny')::numeric <> 20722.00
      or (v_receipt.after_data->>'tvs_existing_funding_cny')::numeric <> 2665.00 then
      raise exception using errcode = '23514', message = 'Historical funding receipt conflicts with the reconciled slice.';
    end if;
  else
    insert into public.audit_logs(id, portfolio_id, actor_id, action, entity_type, entity_id, after_data)
    values (v_receipt_id, p_portfolio_id, v_actor, 'partner_b_historical_funding_reconciled_v1', 'funding_reconciliation', v_receipt_id,
      jsonb_build_object('historical_transaction_count', 12, 'historical_funding_cny', 20722.00,
        'historical_keys', v_historical_keys, 'tvs_existing_funding_cny', 2665.00));
  end if;
  return jsonb_build_object('transactions', v_result, 'historical_funding_cny', 20722.00,
    'partner_b_total_cny', v_partner_b_total, 'idempotent_replay', not exists (
      select 1 from jsonb_array_elements(v_result) r where coalesce((r->>'idempotent_replay')::boolean, false) = false));
end;
$$;
revoke all on function public.reconcile_partner_b_historical_funding(uuid) from public, anon, service_role;
grant execute on function public.reconcile_partner_b_historical_funding(uuid) to authenticated;

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
  v_confirmed_count integer;
  v_pool_slice numeric;
  v_a_slice numeric;
  v_tvs_funding numeric;
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
      if not found then raise exception using errcode = '23514', message = 'Participant identity conflicts with bootstrap.'; end if;
    end if;
    insert into public.funding_accounts(id, portfolio_id, participant_id, account_code, display_name, account_kind, created_by)
    values (v_account, p_portfolio_id, v_participant, v_code, v_code,
      case when v_participant is null then 'sales_proceeds_pool'::public.funding_account_kind else 'participant_capital'::public.funding_account_kind end, v_actor)
    on conflict (id) do nothing;
    perform id from public.funding_accounts where id = v_account and portfolio_id = p_portfolio_id and account_code = v_code
      and participant_id is not distinct from v_participant and currency = 'CNY'
      and account_kind = case when v_participant is null then 'sales_proceeds_pool'::public.funding_account_kind else 'participant_capital'::public.funding_account_kind end
      and closed_at is null for update;
    if not found then raise exception using errcode = '23514', message = 'Account identity conflicts with bootstrap.'; end if;
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
      jsonb_build_array(jsonb_build_object('account_id', v_accounts->>(v_event.data->>'account'), 'amount_cny', (v_event.data->>'signed')::numeric)),
      (v_event.data->>'sale_id')::uuid, (v_event.data->>'order_id')::uuid, (v_event.data->>'item_id')::uuid,
      (v_event.data->>'shipment_id')::uuid, (v_event.data->>'shipment_item_id')::uuid, (v_event.data->>'cost_id')::uuid,
      case when v_event.data->>'kind' = 'refund' then (select id from public.funding_transactions where portfolio_id = p_portfolio_id
        and idempotency_key = 'confirmed-capital-funding-v1:t2-ems') else null end, 'Confirmed capital funding v1'));
  end loop;
  select balance_cny into strict v_pool from public.funding_account_balances where portfolio_id = p_portfolio_id and account_code = 'sales_proceeds_pool';
  select balance_cny into strict v_a from public.funding_account_balances where portfolio_id = p_portfolio_id and account_code = 'partner_a_capital';
  select balance_cny into strict v_b from public.funding_account_balances where portfolio_id = p_portfolio_id and account_code = 'partner_b_capital';
  select sum(realized_profit_cny) into v_profit from public.asset_financials where portfolio_id = p_portfolio_id and sale_id in (p_t2_date_back_sale_id, v_sale.id);
  with expected as (
    select value as data
    from jsonb_array_elements(v_events)
  ), exact_confirmed as (
    select
      expected.data,
      (expected.data->>'account') as account_code,
      (expected.data->>'signed')::numeric as allocation_cny
    from expected
    join public.funding_transactions t
      on t.portfolio_id = p_portfolio_id
     and t.idempotency_key = 'confirmed-capital-funding-v1:' || (expected.data->>'key')
     and t.transaction_status = 'posted'
     and t.transaction_kind = (expected.data->>'kind')::public.funding_transaction_kind
     and t.amount_cny = (expected.data->>'amount')::numeric
     and t.occurred_at is not distinct from (expected.data->>'at')::timestamptz
     and t.occurred_on is not distinct from (expected.data->>'on')::date
     and t.sale_id is not distinct from (expected.data->>'sale_id')::uuid
     and t.purchase_order_id is not distinct from (expected.data->>'order_id')::uuid
     and t.purchase_item_id is not distinct from (expected.data->>'item_id')::uuid
     and t.shipment_id is not distinct from (expected.data->>'shipment_id')::uuid
     and t.shipment_item_id is not distinct from (expected.data->>'shipment_item_id')::uuid
     and t.cost_entry_id is not distinct from (expected.data->>'cost_id')::uuid
     and (expected.data->>'kind' <> 'refund' or t.reversal_of = (
       select id from public.funding_transactions
       where portfolio_id = p_portfolio_id and idempotency_key = 'confirmed-capital-funding-v1:t2-ems'))
    join public.funding_allocations al
      on al.portfolio_id = t.portfolio_id and al.transaction_id = t.id
     and al.account_id = (v_accounts->>(expected.data->>'account'))::uuid
     and al.amount_cny = (expected.data->>'signed')::numeric
    where (select count(*) from public.funding_allocations all_allocations
      where all_allocations.portfolio_id = t.portfolio_id and all_allocations.transaction_id = t.id) = 1
  )
  select count(*),
    coalesce(sum(allocation_cny) filter (where account_code = 'sales_proceeds_pool'), 0),
    coalesce(sum(allocation_cny) filter (where account_code = 'partner_a_capital'), 0),
    coalesce(sum(allocation_cny) filter (where account_code = 'partner_b_capital'), 0)
  into v_confirmed_count, v_pool_slice, v_a_slice, v_tvs_funding
  from exact_confirmed;
  if v_confirmed_count <> 7 or v_pool_slice <> 2673 or v_a_slice <> 87
    or v_tvs_funding <> 2665 or v_profit is distinct from 1356::numeric then
    raise exception using errcode = '23514', message = 'Derived confirmed funding/profit totals conflict; all bootstrap writes rolled back.';
  end if;
  return jsonb_build_object('accounts', v_accounts, 'transactions', v_results,
    'pool_cny', v_pool, 'partner_a_cny', v_a, 'partner_b_cny', v_b,
    'confirmed_pool_slice_cny', v_pool_slice, 'confirmed_partner_a_slice_cny', v_a_slice,
    'tvs_partner_b_cny', v_tvs_funding, 'realized_profit_cny', v_profit);
end;
$$;
revoke all on function public.bootstrap_confirmed_capital_funding(uuid, uuid) from public, anon, service_role;
grant execute on function public.bootstrap_confirmed_capital_funding(uuid, uuid) to authenticated;
