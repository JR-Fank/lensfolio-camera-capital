begin;

create extension if not exists pgtap with schema extensions;
set local search_path = extensions, public, pg_catalog;

select plan(17);

insert into auth.users (id, email, aud, role)
values
  ('11111111-1111-1111-1111-111111111111', 'owner-a@example.test', 'authenticated', 'authenticated'),
  ('22222222-2222-2222-2222-222222222222', 'editor-a@example.test', 'authenticated', 'authenticated'),
  ('33333333-3333-3333-3333-333333333333', 'viewer-a@example.test', 'authenticated', 'authenticated'),
  ('44444444-4444-4444-4444-444444444444', 'owner-b@example.test', 'authenticated', 'authenticated');

insert into public.portfolios (id, name, created_by)
values
  ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaa0', 'Fictional Portfolio A', '11111111-1111-1111-1111-111111111111'),
  ('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbb0', 'Fictional Portfolio B', '44444444-4444-4444-4444-444444444444');

insert into public.portfolio_members (portfolio_id, user_id, role, created_by)
values
  ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaa0', '11111111-1111-1111-1111-111111111111', 'owner', '11111111-1111-1111-1111-111111111111'),
  ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaa0', '22222222-2222-2222-2222-222222222222', 'editor', '11111111-1111-1111-1111-111111111111'),
  ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaa0', '33333333-3333-3333-3333-333333333333', 'viewer', '11111111-1111-1111-1111-111111111111'),
  ('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbb0', '44444444-4444-4444-4444-444444444444', 'owner', '44444444-4444-4444-4444-444444444444');

insert into public.assets (
  id, portfolio_id, brand, model, operational_status, repair_status,
  measured_weight_g, created_by
)
values
  (
    'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaa1',
    'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaa0',
    'FixtureLab',
    'Bundle Component A',
    'acquired',
    'unknown',
    null,
    '11111111-1111-1111-1111-111111111111'
  ),
  (
    'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaa2',
    'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaa0',
    'FixtureLab',
    'Bundle Component B',
    'acquired',
    'unknown',
    null,
    '11111111-1111-1111-1111-111111111111'
  ),
  (
    'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbb1',
    'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbb0',
    'FixtureLab',
    'Other Portfolio Asset',
    'acquired',
    'unknown',
    null,
    '44444444-4444-4444-4444-444444444444'
  );

set local role anon;
select throws_ok(
  $$select count(*) from public.assets$$,
  '42501',
  null,
  'anonymous users cannot read investment data'
);
reset role;

select set_config('request.jwt.claim.sub', '33333333-3333-3333-3333-333333333333', true);
set local role authenticated;
select is(
  (select count(*) from public.assets),
  2::bigint,
  'viewer can read assets in their portfolio'
);
select throws_ok(
  $$
    insert into public.assets (
      id, portfolio_id, brand, model, created_by
    ) values (
      'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaa9',
      'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaa0',
      'FixtureLab',
      'Viewer Write Must Fail',
      '33333333-3333-3333-3333-333333333333'
    )
  $$,
  '42501',
  null,
  'viewer cannot write business data'
);
reset role;

select set_config('request.jwt.claim.sub', '22222222-2222-2222-2222-222222222222', true);
set local role authenticated;
select lives_ok(
  $$
    insert into public.assets (
      id, portfolio_id, brand, model, created_by
    ) values (
      'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaa3',
      'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaa0',
      'FixtureLab',
      'Editor Created Asset',
      '22222222-2222-2222-2222-222222222222'
    )
  $$,
  'editor can write business data'
);
reset role;

select set_config('request.jwt.claim.sub', '11111111-1111-1111-1111-111111111111', true);
set local role authenticated;
select lives_ok(
  $$
    update public.portfolios
    set name = 'Fictional Portfolio A Updated'
    where id = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaa0'
  $$,
  'owner can manage the portfolio'
);
select is(
  (
    select count(*)
    from public.assets
    where portfolio_id = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbb0'
  ),
  0::bigint,
  'portfolio A user cannot read portfolio B data'
);
reset role;

select is(
  (
    select data_type
    from information_schema.columns
    where table_schema = 'public'
      and table_name = 'cost_entries'
      and column_name = 'amount_cny'
  ),
  'numeric',
  'money uses PostgreSQL numeric'
);

insert into public.shipments (
  id, portfolio_id, status, actual_paid_cny, budget_cny, created_by
)
values (
  'cccccccc-cccc-cccc-cccc-ccccccccccc0',
  'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaa0',
  'booked',
  100,
  100,
  '11111111-1111-1111-1111-111111111111'
);

insert into public.shipment_items (
  id, portfolio_id, shipment_id, asset_id, weight_snapshot_g,
  allocation_method, allocation_ratio, allocated_shipping_cny,
  allocation_version, created_by
)
values
  (
    'cccccccc-cccc-cccc-cccc-ccccccccccc1',
    'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaa0',
    'cccccccc-cccc-cccc-cccc-ccccccccccc0',
    'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaa1',
    null,
    'manual',
    0.3,
    30,
    1,
    '11111111-1111-1111-1111-111111111111'
  ),
  (
    'cccccccc-cccc-cccc-cccc-ccccccccccc2',
    'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaa0',
    'cccccccc-cccc-cccc-cccc-ccccccccccc0',
    'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaa2',
    null,
    'manual',
    0.7,
    70,
    1,
    '11111111-1111-1111-1111-111111111111'
  );

select is(
  (
    select count(*)
    from public.shipment_items
    where shipment_id = 'cccccccc-cccc-cccc-cccc-ccccccccccc0'
  ),
  2::bigint,
  'one shipment can contain multiple assets'
);

select lives_ok(
  $$
    update public.shipment_items
    set allocation_locked_at = '2026-08-21 12:00:00+08'::timestamptz
    where shipment_id = 'cccccccc-cccc-cccc-cccc-ccccccccccc0'
  $$,
  'shipment allocation can be locked'
);

select throws_ok(
  $$
    update public.shipment_items
    set allocation_ratio = 0.5
    where id = 'cccccccc-cccc-cccc-cccc-ccccccccccc1'
  $$,
  'P0001',
  'Locked shipment allocation is immutable.',
  'locked shipment allocation is immutable'
);

select is(
  (
    select count(*)
    from public.assets
    where id in (
      'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaa1',
      'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaa2'
    )
      and measured_weight_g is null
  ),
  2::bigint,
  'two bundle components may both have null individual weight without inference'
);

update public.assets
set measured_weight_g = 500
where id = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaa1';

select is(
  (
    select weight_snapshot_g
    from public.shipment_items
    where id = 'cccccccc-cccc-cccc-cccc-ccccccccccc1'
  ),
  null::integer,
  'later asset weight changes do not alter a locked shipment snapshot'
);

insert into public.cost_entries (
  id, portfolio_id, asset_id, cost_type, source_type, original_amount,
  currency, fx_rate_to_cny, amount_cny, occurred_at, created_by
)
values
  (
    'dddddddd-dddd-dddd-dddd-ddddddddddd1',
    'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaa0',
    'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaa1',
    'purchase', 'manual', 100, 'CNY', 1, 100,
    '2026-08-21 10:00:00+08',
    '11111111-1111-1111-1111-111111111111'
  ),
  (
    'dddddddd-dddd-dddd-dddd-ddddddddddd2',
    'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaa0',
    'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaa1',
    'repair', 'manual', 0.10, 'CNY', 1, 0.10,
    '2026-08-21 10:01:00+08',
    '11111111-1111-1111-1111-111111111111'
  ),
  (
    'dddddddd-dddd-dddd-dddd-ddddddddddd3',
    'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaa0',
    'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaa1',
    'other', 'manual', 0.20, 'CNY', 1, 0.20,
    '2026-08-21 10:02:00+08',
    '11111111-1111-1111-1111-111111111111'
  ),
  (
    'dddddddd-dddd-dddd-dddd-ddddddddddd4',
    'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaa0',
    'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaa3',
    'purchase', 'manual', 100, 'CNY', 1, 100,
    '2026-08-21 10:03:00+08',
    '11111111-1111-1111-1111-111111111111'
  );

select is(
  (
    select sum(amount_cny)
    from public.cost_entries
    where asset_id = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaa1'
  ),
  100.30::numeric,
  'numeric arithmetic retains exact decimal amounts'
);

select is(
  (
    select total_carrying_cost_cny
    from public.asset_financials
    where asset_id = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaa1'
  ),
  100.30::numeric,
  'cost entries aggregate to the asset total carrying cost'
);

insert into public.valuation_snapshots (
  id, portfolio_id, asset_id, median, sample_count, confidence,
  methodology_version, valued_at, created_by
)
values (
  'eeeeeeee-eeee-eeee-eeee-eeeeeeeeeee1',
  'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaa0',
  'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaa3',
  125,
  1,
  1,
  'fixture-v1',
  '2026-08-21 11:00:00+08',
  '11111111-1111-1111-1111-111111111111'
);

select is(
  (
    select investment_roi
    from public.asset_financials
    where asset_id = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaa3'
  ),
  0.25::numeric,
  'investment ROI is profit divided by total cost'
);

select is(
  (
    select sum(allocation_ratio)
    from public.shipment_items
    where shipment_id = 'cccccccc-cccc-cccc-cccc-ccccccccccc0'
  ),
  1.0000000000::numeric,
  'multi-asset shipment allocation ratios reconcile exactly'
);

select is(
  (
    select count(*)
    from public.shipment_items
    where shipment_id = 'cccccccc-cccc-cccc-cccc-ccccccccccc0'
      and allocation_locked_at is not null
  ),
  2::bigint,
  'all shipment item allocation snapshots are locked'
);

select * from finish();
rollback;
