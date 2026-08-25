begin;

create extension if not exists pgtap with schema extensions;
set local search_path = extensions, public, pg_catalog;

select plan(26);

insert into auth.users (id, email, aud, role)
values
  ('61111111-1111-1111-1111-111111111111', 'evidence-owner@example.test', 'authenticated', 'authenticated'),
  ('62222222-2222-2222-2222-222222222222', 'evidence-editor@example.test', 'authenticated', 'authenticated'),
  ('63333333-3333-3333-3333-333333333333', 'evidence-viewer@example.test', 'authenticated', 'authenticated');

insert into public.portfolios (id, name, created_by)
values (
  '6aaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaa0',
  'Evidence Rollback Fixture',
  '61111111-1111-1111-1111-111111111111'
);

insert into public.portfolio_members (portfolio_id, user_id, role, created_by)
values
  ('6aaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaa0', '61111111-1111-1111-1111-111111111111', 'owner', '61111111-1111-1111-1111-111111111111'),
  ('6aaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaa0', '62222222-2222-2222-2222-222222222222', 'editor', '61111111-1111-1111-1111-111111111111'),
  ('6aaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaa0', '63333333-3333-3333-3333-333333333333', 'viewer', '61111111-1111-1111-1111-111111111111');

select is(
  (
    select prosecdef from pg_proc
    where oid = 'public.import_purchase_evidence(uuid,text,text,jsonb,jsonb)'::regprocedure
  ),
  false,
  'purchase evidence RPC is SECURITY INVOKER'
);

select is(
  (
    select prosecdef from pg_proc
    where oid = 'public.import_logistics_evidence(uuid,text,text,jsonb,jsonb)'::regprocedure
  ),
  false,
  'logistics evidence RPC is SECURITY INVOKER'
);

select ok(
  not has_function_privilege(
    'anon',
    'public.import_purchase_evidence(uuid,text,text,jsonb,jsonb)',
    'EXECUTE'
  ),
  'anonymous role cannot execute purchase evidence RPC'
);

select ok(
  not has_function_privilege(
    'anon',
    'public.import_logistics_evidence(uuid,text,text,jsonb,jsonb)',
    'EXECUTE'
  ),
  'anonymous role cannot execute logistics evidence RPC'
);

select set_config('request.jwt.claim.sub', '61111111-1111-1111-1111-111111111111', true);
set local role authenticated;

select lives_ok(
  $$
    select public.import_purchase_evidence(
      '6aaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaa0',
      'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
      '["rollback-purchase.png"]'::jsonb,
      '{
        "purchase_date": "2026-08-25",
        "platform": "Fixture Market",
        "seller": "Fixture Seller",
        "order_reference": "EVIDENCE-ROLLBACK-001",
        "purchase_price_jpy": null,
        "actual_paid_cny": 120,
        "exchange_rate_jpy_to_cny": null,
        "fee_jpy": null,
        "photo_fee_jpy": null,
        "domestic_shipping_jpy": null,
        "coupon_jpy": null,
        "allocation_method": "manual",
        "assets": [
          {
            "brand": "FixtureLab",
            "model": "Bundle Evidence A",
            "serial_number": null,
            "measured_weight_g": null,
            "condition": null,
            "status": "acquired",
            "notes": null,
            "purchase_price_jpy": null,
            "allocated_cost_cny": 50,
            "allocation_method": "manual"
          },
          {
            "brand": "FixtureLab",
            "model": "Bundle Evidence B",
            "serial_number": null,
            "measured_weight_g": null,
            "condition": null,
            "status": "acquired",
            "notes": null,
            "purchase_price_jpy": null,
            "allocated_cost_cny": 70,
            "allocation_method": "manual"
          }
        ]
      }'::jsonb
    )
  $$,
  'owner can import bundle purchase evidence atomically'
);

select is(
  (select count(*) from public.assets where legacy_id like 'evidence:asset:aaaaaaaa%'),
  2::bigint,
  'bundle creates two physical assets'
);

select is(
  (select count(*) from public.purchase_orders where order_reference = 'EVIDENCE-ROLLBACK-001'),
  1::bigint,
  'purchase evidence creates one order'
);

select is(
  (
    select count(*) from public.purchase_items
    where legacy_id like 'evidence:purchase-item:aaaaaaaa%'
  ),
  2::bigint,
  'purchase evidence creates one item per asset'
);

select is(
  (
    select count(*)
    from public.cost_entries ce
    join public.assets a on a.id = ce.asset_id
    where a.legacy_id like 'evidence:asset:aaaaaaaa%'
      and ce.cost_type = 'purchase'
      and ce.entry_status = 'posted'
  ),
  2::bigint,
  'purchase evidence creates posted purchase costs'
);

select is(
  (
    select count(*) from public.assets
    where legacy_id like 'evidence:asset:aaaaaaaa%'
      and measured_weight_g is null
  ),
  2::bigint,
  'bundle individual weights remain NULL'
);

select ok(
  exists (
    select 1 from public.purchase_orders
    where order_reference = 'EVIDENCE-ROLLBACK-001'
      and original_subtotal_jpy is null
      and exchange_rate_jpy_to_cny is null
      and fee_jpy is null
  ),
  'missing purchase facts remain NULL'
);

select is(
  (
    select count(*) from public.audit_logs
    where entity_type = 'purchase_evidence'
      and after_data->>'normalized_payload_hash' = repeat('b', 64)
  ),
  1::bigint,
  'purchase import records an evidence audit'
);

select lives_ok(
  $$
    select public.import_purchase_evidence(
      '6aaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaa0',
      repeat('a', 64),
      repeat('b', 64),
      '["rollback-purchase-repeat.png"]'::jsonb,
      '{
        "purchase_date":"2026-08-25",
        "actual_paid_cny":120,
        "allocation_method":"manual",
        "assets":[
          {"brand":"FixtureLab","model":"Bundle Evidence A","allocated_cost_cny":50,"allocation_method":"manual"},
          {"brand":"FixtureLab","model":"Bundle Evidence B","allocated_cost_cny":70,"allocation_method":"manual"}
        ]
      }'::jsonb
    )
  $$,
  'duplicate purchase evidence is an idempotent replay'
);

select is(
  (select count(*) from public.purchase_orders where order_reference = 'EVIDENCE-ROLLBACK-001'),
  1::bigint,
  'purchase replay does not duplicate the order'
);

select throws_ok(
  $$
    select public.import_purchase_evidence(
      '6aaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaa0',
      repeat('a', 64),
      repeat('c', 64),
      '[]'::jsonb,
      '{
        "purchase_date":"2026-08-25",
        "actual_paid_cny":121,
        "assets":[
          {"brand":"FixtureLab","model":"Bundle Evidence A","allocated_cost_cny":51},
          {"brand":"FixtureLab","model":"Bundle Evidence B","allocated_cost_cny":70}
        ]
      }'::jsonb
    )
  $$,
  '22023',
  'Conflicting purchase evidence exists for this order reference.',
  'conflicting replay is rejected instead of silently overwriting facts'
);

select lives_ok(
  $$
    select public.import_logistics_evidence(
      '6aaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaa0',
      repeat('d', 64),
      repeat('e', 64),
      '["rollback-logistics.png"]'::jsonb,
      jsonb_build_object(
        'carrier', 'Fixture Carrier',
        'tracking_number', 'FIXTURE-TRACK-ROLLBACK',
        'origin', 'Tokyo',
        'destination', 'Hong Kong',
        'shipping_date', '2026-08-25',
        'shipping_cost_cny', 30,
        'payment_status', 'pending',
        'status', 'in_transit',
        'assets', (
          select jsonb_agg(
            jsonb_build_object(
              'asset_id', a.id,
              'weight_snapshot_g', null,
              'allocation_method', 'manual',
              'allocation_ratio', case when a.model like '% A' then 0.4 else 0.6 end,
              'allocated_shipping_cny', case when a.model like '% A' then 12 else 18 end
            ) order by a.model
          )
          from public.assets a
          where a.legacy_id like 'evidence:asset:aaaaaaaa%'
        ),
        'tracking_events', jsonb_build_array(
          jsonb_build_object(
            'event_fingerprint', repeat('f', 64),
            'raw_status', 'Dispatch',
            'status', 'in_transit',
            'status_label', 'Dispatched',
            'location', 'Tokyo',
            'occurred_at', '2026-08-25T01:00:00+09:00'
          ),
          jsonb_build_object(
            'event_fingerprint', repeat('f', 64),
            'raw_status', 'Dispatch',
            'status', 'in_transit',
            'status_label', 'Dispatched',
            'location', 'Tokyo',
            'occurred_at', '2026-08-25T01:00:00+09:00'
          )
        )
      )
    )
  $$,
  'owner can import multi-asset logistics evidence atomically'
);

select is(
  (select count(*) from public.shipments where tracking_number = 'FIXTURE-TRACK-ROLLBACK'),
  1::bigint,
  'logistics evidence creates one shipment'
);

select is(
  (
    select count(*) from public.shipment_items si
    join public.shipments s on s.id = si.shipment_id
    where s.tracking_number = 'FIXTURE-TRACK-ROLLBACK'
      and si.allocation_locked_at is not null
      and si.allocation_version = 1
  ),
  2::bigint,
  'multi-asset shipment allocations are inserted locked'
);

select is(
  (
    select count(*) from public.cost_entries ce
    join public.shipment_items si on si.id = ce.source_id
    join public.shipments s on s.id = si.shipment_id
    where s.tracking_number = 'FIXTURE-TRACK-ROLLBACK'
      and ce.cost_type = 'international_shipping'
      and ce.entry_status = 'pending'
  ),
  2::bigint,
  'budget or unpaid logistics costs remain pending'
);

select is(
  (
    select count(*) from public.tracking_events te
    join public.shipments s on s.id = te.shipment_id
    where s.tracking_number = 'FIXTURE-TRACK-ROLLBACK'
  ),
  1::bigint,
  'duplicate tracking events are deduplicated'
);

select lives_ok(
  $$
    select public.import_logistics_evidence(
      '6aaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaa0',
      repeat('d', 64),
      repeat('9', 64),
      '["rollback-logistics-paid.png"]'::jsonb,
      jsonb_build_object(
        'carrier', 'Fixture Carrier',
        'tracking_number', 'FIXTURE-TRACK-ROLLBACK',
        'shipping_date', '2026-08-25',
        'shipping_cost_cny', 30,
        'payment_status', 'paid',
        'status', 'in_transit',
        'assets', (
          select jsonb_agg(
            jsonb_build_object(
              'asset_id', a.id,
              'weight_snapshot_g', null,
              'allocation_method', 'manual',
              'allocation_ratio', case when a.model like '% A' then 0.4 else 0.6 end,
              'allocated_shipping_cny', case when a.model like '% A' then 12 else 18 end
            ) order by a.model
          )
          from public.assets a
          where a.legacy_id like 'evidence:asset:aaaaaaaa%'
        ),
        'tracking_events', '[]'::jsonb
      )
    )
  $$,
  'confirmed logistics payment promotes pending costs to posted'
);

select is(
  (
    select count(*) from public.cost_entries ce
    join public.shipment_items si on si.id = ce.source_id
    join public.shipments s on s.id = si.shipment_id
    where s.tracking_number = 'FIXTURE-TRACK-ROLLBACK'
      and ce.entry_status = 'posted'
  ),
  2::bigint,
  'paid logistics evidence produces posted cost entries'
);

select ok(
  exists (
    select 1 from public.shipments
    where tracking_number = 'FIXTURE-TRACK-ROLLBACK'
      and actual_paid_cny = 30
      and budget_cny = 0
  ),
  'shipment actual and budget totals reflect confirmed payment'
);

select throws_ok(
  $$
    update public.shipment_items
    set allocation_ratio = 0.5
    where shipment_id = (
      select id from public.shipments where tracking_number = 'FIXTURE-TRACK-ROLLBACK'
    )
  $$,
  'P0001',
  'Locked shipment allocation is immutable.',
  'locked evidence allocation cannot be recalculated'
);

reset role;
select set_config('request.jwt.claim.sub', '62222222-2222-2222-2222-222222222222', true);
set local role authenticated;

select lives_ok(
  $$
    select public.import_purchase_evidence(
      '6aaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaa0',
      repeat('1', 64),
      repeat('2', 64),
      '[]'::jsonb,
      '{
        "purchase_date":"2026-08-25",
        "actual_paid_cny":10,
        "allocation_method":"equal",
        "assets":[
          {"brand":"FixtureLab","model":"Editor Evidence","allocated_cost_cny":10,"allocation_method":"equal"}
        ]
      }'::jsonb
    )
  $$,
  'editor can execute evidence import'
);

reset role;
select set_config('request.jwt.claim.sub', '63333333-3333-3333-3333-333333333333', true);
set local role authenticated;

select throws_ok(
  $$
    select public.import_purchase_evidence(
      '6aaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaa0',
      repeat('3', 64),
      repeat('4', 64),
      '[]'::jsonb,
      '{"purchase_date":"2026-08-25","actual_paid_cny":10,"assets":[{"brand":"FixtureLab","model":"Viewer Evidence","allocated_cost_cny":10}]}'::jsonb
    )
  $$,
  '42501',
  'Portfolio write access required.',
  'viewer cannot execute evidence import'
);

reset role;
select * from finish();
rollback;
