-- Definition only. This function creates funding identities and imports seven
-- confirmed events through 00200; it never creates or repairs source evidence.
create function public.bootstrap_confirmed_capital_funding(
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
  if v_sale.asset_id <> 'a847b8d7-a50d-4bdd-bdf7-2258dda5f679'::uuid then
    raise exception using errcode = '23514', message = 'Standalone S II sale identity mismatch.';
  end if;
  v_events := v_events || jsonb_build_array(jsonb_build_object('key', 'sii-sale', 'kind', 'sale_proceeds',
    'sale_id', v_sale.id, 'amount', 1288, 'at', v_sale.sold_at, 'account', 'sales_proceeds_pool', 'signed', 1288));
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
