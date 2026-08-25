begin;

create extension if not exists pgtap with schema extensions;
set local search_path = extensions, public, pg_catalog;

select plan(16);

insert into auth.users (id, email, aud, role)
values
  ('51111111-1111-1111-1111-111111111111', 'flow-owner@example.test', 'authenticated', 'authenticated'),
  ('52222222-2222-2222-2222-222222222222', 'flow-editor@example.test', 'authenticated', 'authenticated'),
  ('53333333-3333-3333-3333-333333333333', 'flow-viewer@example.test', 'authenticated', 'authenticated');

insert into public.portfolios (id, name, created_by)
values (
  '5aaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaa0',
  'Atomic Flow Fixture Portfolio',
  '51111111-1111-1111-1111-111111111111'
);

insert into public.portfolio_members (portfolio_id, user_id, role, created_by)
values
  ('5aaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaa0', '51111111-1111-1111-1111-111111111111', 'owner', '51111111-1111-1111-1111-111111111111'),
  ('5aaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaa0', '52222222-2222-2222-2222-222222222222', 'editor', '51111111-1111-1111-1111-111111111111'),
  ('5aaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaa0', '53333333-3333-3333-3333-333333333333', 'viewer', '51111111-1111-1111-1111-111111111111');

select is(
  (
    select prosecdef
    from pg_proc
    where oid = 'public.create_asset_with_purchase(uuid,text,text,date,numeric,text,integer,text,public.asset_operational_status,text,numeric,numeric,text,text)'::regprocedure
  ),
  false,
  'asset purchase RPC is SECURITY INVOKER'
);

select ok(
  not has_function_privilege(
    'anon',
    'public.create_asset_with_purchase(uuid,text,text,date,numeric,text,integer,text,public.asset_operational_status,text,numeric,numeric,text,text)',
    'EXECUTE'
  ),
  'anonymous role cannot execute the asset purchase RPC'
);

select set_config('request.jwt.claim.sub', '51111111-1111-1111-1111-111111111111', true);
set local role authenticated;

select lives_ok(
  $$
    select * from public.create_asset_with_purchase(
      '5aaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaa0',
      'FixtureLab',
      'Atomic CNY Camera',
      '2026-08-25',
      1250.50,
      null,
      null,
      'Excellent',
      'acquired',
      'Rollback-only fixture note',
      null,
      null,
      'Fixture Market',
      'FLOW-CNY-001'
    )
  $$,
  'owner can atomically create an asset and purchase chain'
);

select is(
  (select count(*) from public.assets where model = 'Atomic CNY Camera'),
  1::bigint,
  'RPC creates one asset'
);

select is(
  (select count(*) from public.purchase_orders where order_reference = 'FLOW-CNY-001'),
  1::bigint,
  'RPC creates one purchase order'
);

select is(
  (
    select count(*)
    from public.purchase_items item
    join public.assets asset on asset.id = item.asset_id
    where asset.model = 'Atomic CNY Camera'
  ),
  1::bigint,
  'RPC creates one purchase item linked to the asset'
);

select is(
  (
    select count(*)
    from public.cost_entries entry
    join public.assets asset on asset.id = entry.asset_id
    where asset.model = 'Atomic CNY Camera'
      and entry.cost_type = 'purchase'
      and entry.source_type = 'purchase_item'
      and entry.entry_status = 'posted'
  ),
  1::bigint,
  'RPC creates one posted purchase cost entry'
);

select is(
  (
    select entry.amount_cny
    from public.cost_entries entry
    join public.assets asset on asset.id = entry.asset_id
    where asset.model = 'Atomic CNY Camera'
  ),
  1250.50::numeric,
  'purchase cost equals actual paid CNY exactly'
);

select ok(
  exists (
    select 1
    from public.cost_entries entry
    join public.purchase_items item on item.id = entry.source_id
    where entry.asset_id = item.asset_id
      and item.allocated_cost_cny = entry.amount_cny
      and entry.amount_cny = 1250.50
  ),
  'purchase item allocation and cost entry share the same source and amount'
);

select is(
  (
    select note
    from public.asset_status_events event
    join public.assets asset on asset.id = event.asset_id
    where asset.model = 'Atomic CNY Camera'
  ),
  'Rollback-only fixture note',
  'optional notes are retained as an asset status event'
);

select ok(
  exists (
    select 1
    from public.purchase_orders
    where order_reference = 'FLOW-CNY-001'
      and original_currency = 'CNY'
      and original_subtotal_jpy = 0
      and exchange_rate_jpy_to_cny = 1
  ),
  'JPY details may be omitted without changing the CNY cost basis'
);

select throws_ok(
  $$
    select * from public.create_asset_with_purchase(
      '5aaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaa0',
      'FixtureLab',
      'Atomic Failure Camera',
      '2026-08-25',
      -1,
      null,
      null,
      null,
      'acquired',
      null,
      null,
      null,
      null,
      null
    )
  $$,
  '22023',
  'Actual paid CNY must be a positive amount with at most two decimal places.',
  'invalid input aborts the RPC'
);

select is(
  (select count(*) from public.assets where model = 'Atomic Failure Camera'),
  0::bigint,
  'a failed RPC leaves no partial asset'
);

reset role;
select set_config('request.jwt.claim.sub', '52222222-2222-2222-2222-222222222222', true);
set local role authenticated;

select lives_ok(
  $$
    select * from public.create_asset_with_purchase(
      '5aaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaa0',
      'FixtureLab',
      'Atomic JPY Camera',
      '2026-08-25',
      800.00,
      'SERIAL-JPY',
      320,
      null,
      'in_storage',
      null,
      16000,
      0.05,
      'Fixture Japan',
      'FLOW-JPY-001'
    )
  $$,
  'editor can execute the same atomic flow'
);

select ok(
  exists (
    select 1
    from public.purchase_orders purchase
    join public.purchase_items item on item.purchase_order_id = purchase.id
    where purchase.order_reference = 'FLOW-JPY-001'
      and purchase.original_currency = 'JPY'
      and purchase.original_subtotal_jpy = 16000
      and purchase.exchange_rate_jpy_to_cny = 0.05
      and purchase.actual_paid_cny = 800
      and item.original_price_jpy = 16000
      and item.allocated_cost_cny = 800
  ),
  'JPY audit facts are retained while CNY remains the cost basis'
);

reset role;
select set_config('request.jwt.claim.sub', '53333333-3333-3333-3333-333333333333', true);
set local role authenticated;

select throws_ok(
  $$
    select * from public.create_asset_with_purchase(
      '5aaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaa0',
      'FixtureLab',
      'Viewer Write Camera',
      '2026-08-25',
      100,
      null,
      null,
      null,
      'acquired',
      null,
      null,
      null,
      null,
      null
    )
  $$,
  '42501',
  'Portfolio write access required.',
  'viewer cannot execute the write flow'
);

reset role;
select * from finish();
rollback;
