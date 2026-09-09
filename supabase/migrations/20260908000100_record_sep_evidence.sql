-- Confirmed Lensfolio evidence reported 2026-09-08.
-- Personal pickup travel expense (CNY 46.32 round-trip reference) is explicitly
-- excluded from cost_entries, carrying cost, profit, and the sales proceeds pool.

begin;

do $evidence$
declare
  v_portfolio constant uuid := 'c9392708-c769-5f74-9587-b3071bc354bd';
  v_nikon constant uuid := 'c8506c0d-89bd-43c5-8467-b748dbc2eab8';
  v_canon_s constant uuid := 'a0c926a0-7c45-4951-bd68-d127ae0a8fc1';
  v_canon_sii constant uuid := 'c916a37b-9ac6-43ff-b97b-577ef9120414';

  v_actor uuid;
  v_pool uuid;

  v_sale uuid :=
    md5(v_portfolio::text || ':canon-sii-bundle-sale:2026-09-07T20:30+08')::uuid;

  v_sale_funding uuid :=
    md5(v_portfolio::text || ':canon-sii-bundle-sale-funding:2026-09-07T20:30+08')::uuid;

  v_sale_allocation uuid :=
    md5(v_portfolio::text || ':canon-sii-bundle-sale-allocation:2026-09-07T20:30+08')::uuid;

  v_nikon_repair uuid :=
    md5(v_portfolio::text || ':nikon-28ti-pointer-repair-quote:2026-09-08')::uuid;

  v_travel_evidence uuid :=
    md5(v_portfolio::text || ':personal-pickup-travel-evidence:2026-09-08')::uuid;

  v_count integer;
begin
  select created_by
    into strict v_actor
  from public.portfolios
  where id = v_portfolio;

  select id
    into strict v_pool
  from public.funding_accounts
  where portfolio_id = v_portfolio
    and account_code = 'sales_proceeds_pool'
    and account_kind = 'sales_proceeds_pool'
    and closed_at is null;

  -- Preflight: abort rather than overwrite evidence that changed after review.
  select count(*) into v_count
  from public.assets
  where portfolio_id = v_portfolio
    and (
      (
        id = v_nikon
        and operational_status = 'in_storage'
        and repair_status = 'not_inspected'
        and condition = '接近未使用'
      )
      or (
        id = v_canon_s
        and operational_status = 'in_storage'
        and repair_status = 'not_inspected'
        and condition is null
      )
      or (
        id = v_canon_sii
        and operational_status = 'in_storage'
        and repair_status = 'not_inspected'
        and condition is null
      )
    );

  if v_count <> 3 then
    raise exception 'Asset evidence changed since preflight; aborting.';
  end if;

  if exists (
    select 1
    from public.sales
    where portfolio_id = v_portfolio
      and asset_id = v_canon_sii
  ) then
    raise exception 'Canon Autoboy S II bundle asset already has sale evidence.';
  end if;

  if exists (
    select 1
    from public.repairs
    where portfolio_id = v_portfolio
      and asset_id = v_nikon
  ) then
    raise exception 'Nikon 28Ti already has repair evidence.';
  end if;

  -- Actual physical pickup times.
  -- The first two were already correct; setting all three makes the confirmed
  -- evidence explicit and corrects EN537370952JP by +1 minute.
  update public.shipments
  set delivered_at = case tracking_number
        when 'EN533720370JP' then '2026-08-28 15:01:00+08'::timestamptz
        when 'EN536199851JP' then '2026-09-06 13:38:00+08'::timestamptz
        when 'EN537370952JP' then '2026-09-06 13:38:00+08'::timestamptz
      end,
      status = 'delivered',
      updated_at = now()
  where portfolio_id = v_portfolio
    and tracking_number in (
      'EN533720370JP',
      'EN536199851JP',
      'EN537370952JP'
    );

  get diagnostics v_count = row_count;
  if v_count <> 3 then
    raise exception 'Expected exactly three shipment rows; found %.', v_count;
  end if;

  -- Nikon 28Ti: pointer fault, quoted CNY 650, decision still pending.
  -- This repair quote is NOT a posted carrying cost.
  update public.assets
  set repair_status = 'needs_repair',
      condition = '接近未使用；指针故障',
      updated_at = now()
  where portfolio_id = v_portfolio
    and id = v_nikon;

  insert into public.repairs (
    id,
    portfolio_id,
    asset_id,
    vendor,
    description,
    status,
    original_amount,
    currency,
    fx_rate_to_cny,
    amount_cny,
    started_at,
    completed_at,
    created_by
  ) values (
    v_nikon_repair,
    v_portfolio,
    v_nikon,
    null,
    '指针故障；已询得维修报价 ¥650，仍在考虑，尚未开始维修，未发生实际维修支出。',
    'planned',
    650,
    'CNY',
    1,
    650,
    null,
    null,
    v_actor
  );

  insert into public.asset_status_events (
    portfolio_id,
    asset_id,
    repair_status,
    note,
    occurred_at,
    created_by
  ) values (
    v_portfolio,
    v_nikon,
    'needs_repair',
    '2026-09-08 记录：指针故障；维修报价 ¥650，仍在考虑。实际故障发现时间未记录；报价未计入 carrying cost。',
    '2026-09-08 21:59:00+08'::timestamptz,
    v_actor
  );

  -- Canon Autoboy S bundle unit: flash failure.
  update public.assets
  set repair_status = 'needs_repair',
      condition = '闪光灯故障',
      updated_at = now()
  where portfolio_id = v_portfolio
    and id = v_canon_s;

  insert into public.asset_status_events (
    portfolio_id,
    asset_id,
    repair_status,
    note,
    occurred_at,
    created_by
  ) values (
    v_portfolio,
    v_canon_s,
    'needs_repair',
    '2026-09-08 记录：闪光灯故障；实际故障发现时间未记录。',
    '2026-09-08 21:59:00+08'::timestamptz,
    v_actor
  );

  -- Canon Autoboy S II bundle unit:
  -- sold 2026-09-07 20:30 +08 for CNY 1,198 via Alipay QR payment.
  update public.assets
  set operational_status = 'sold',
      repair_status = 'needs_repair',
      condition = '取景器有黑点（出售前已知）',
      updated_at = now()
  where portfolio_id = v_portfolio
    and id = v_canon_sii;

  insert into public.asset_status_events (
    portfolio_id,
    asset_id,
    operational_status,
    repair_status,
    note,
    occurred_at,
    created_by
  ) values (
    v_portfolio,
    v_canon_sii,
    'sold',
    'needs_repair',
    '出售前已知：取景器有黑点。具体发现时间未记录。2026-09-07 20:30 以 ¥1,198 售出，支付宝扫码付款。',
    '2026-09-07 20:30:00+08'::timestamptz,
    v_actor
  );

  insert into public.sales (
    id,
    portfolio_id,
    asset_id,
    status,
    platform,
    sold_price_cny,
    platform_fees_cny,
    outbound_shipping_cny,
    sold_at,
    created_by
  ) values (
    v_sale,
    v_portfolio,
    v_canon_sii,
    'sold',
    '支付宝扫码付款',
    1198,
    0,
    0,
    '2026-09-07 20:30:00+08'::timestamptz,
    v_actor
  );

  -- Full net proceeds enter the sales proceeds pool.
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
    note,
    created_by
  ) values (
    v_sale_funding,
    v_portfolio,
    'sale_proceeds',
    'draft',
    1198,
    '2026-09-07 20:30:00+08'::timestamptz,
    null,
    'confirmed-sale:canon-autoboy-sii-bundle:2026-09-07T20:30+08',
    v_sale,
    'Canon Autoboy S II 套装内销售回款；支付宝扫码付款。',
    v_actor
  );

  insert into public.funding_allocations (
    id,
    portfolio_id,
    transaction_id,
    account_id,
    amount_cny,
    created_by
  ) values (
    v_sale_allocation,
    v_portfolio,
    v_sale_funding,
    v_pool,
    1198,
    v_actor
  );

  -- Funding allocations must exist before a transaction becomes immutable/posted.
  update public.funding_transactions
  set transaction_status = 'posted',
      posted_at = now()
  where portfolio_id = v_portfolio
    and id = v_sale_funding
    and transaction_status = 'draft';

  get diagnostics v_count = row_count;
  if v_count <> 1 then
    raise exception 'Expected to post exactly one Canon S II funding transaction.';
  end if;

  -- Non-financial operational evidence only.
  -- CNY 46.32 is preserved as a personal round-trip reference, but deliberately
  -- creates NO cost_entry and NO funding transaction.
  insert into public.audit_logs (
    id,
    portfolio_id,
    actor_id,
    action,
    entity_type,
    entity_id,
    after_data,
    occurred_at
  ) values (
    v_travel_evidence,
    v_portfolio,
    v_actor,
    'personal_pickup_travel_evidence',
    'logistics',
    null,
    jsonb_build_object(
      'round_trip_reference_cny', 46.32,
      'financial_treatment', 'personal_out_of_pocket_excluded_from_lensfolio_financials',
      'pickup_events', jsonb_build_array(
        jsonb_build_object(
          'tracking_number', 'EN533720370JP',
          'picked_up_at', '2026-08-28T15:01:00+08:00',
          'participants', 'user'
        ),
        jsonb_build_object(
          'tracking_number', 'EN536199851JP',
          'picked_up_at', '2026-09-06T13:38:00+08:00',
          'participants', 'user_and_partner'
        ),
        jsonb_build_object(
          'tracking_number', 'EN537370952JP',
          'picked_up_at', '2026-09-06T13:38:00+08:00',
          'participants', 'user_and_partner'
        )
      )
    ),
    '2026-09-08 21:59:00+08'::timestamptz
  );
end;
$evidence$;

commit;
