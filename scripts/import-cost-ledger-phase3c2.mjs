#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const SUPABASE_CLI_VERSION = "2.115.0";
const OWNER_ID = "b438f993-fbfd-49c9-963b-ff0d02ff4003";
const PORTFOLIO_ID = "c9392708-c769-5f74-9587-b3071bc354bd";
const AMOUNT_TOLERANCE = 0.01;

const EXPECTED_ASSETS = new Map([
  ["canon-autoboy-sii-01", { purchase: 986, shipping: 106, total: 1092, posted: 1092 }],
  ["contax-t2-date-back", { purchase: 4913, shipping: 115, total: 5028, posted: 5028 }],
  ["nikon-28ti", { purchase: 6505, shipping: 98, total: 6603, posted: 6505 }],
  ["canon-autoboy-s-set", { purchase: 603, shipping: 66, total: 669, posted: 603 }],
  ["canon-autoboy-sii-set", { purchase: 603, shipping: 66, total: 669, posted: 603 }],
]);

process.on("uncaughtException", (error) => {
  console.error(JSON.stringify({
    event: "error",
    loggedAt: new Date().toISOString(),
    message: error.message,
  }, null, 2));
  process.exit(1);
});

const args = parseArgs(process.argv.slice(2));

if (args.help) {
  printHelp();
  process.exit(0);
}

if (args.rollback) {
  if (!args.confirmRollback) {
    throw new Error("Rollback requires --confirm-rollback. No data was changed.");
  }
  const rollbackRunId = randomUUID();
  const rolledBackAt = new Date().toISOString();
  const result = runRemoteSql(buildRollbackSql({
    targetMigrationRunId: args.migrationRunId ?? null,
    rollbackRunId,
    rolledBackAt,
  }));
  printLog("rollback", {
    mode: "rollback",
    rollbackRunId,
    targetMigrationRunId: result?.rows?.[0]?.phase3c2_rollback?.target_migration_run_id,
    rolledBackAt,
    result: result?.rows?.[0]?.phase3c2_rollback,
  });
  process.exit(0);
}

if (args.verify) {
  const result = runRemoteSql(buildVerificationSql());
  const verification = assertVerification(result, true);
  printLog("verification", { mode: "verify", result: verification });
  process.exit(0);
}

if (!args.apply) {
  const result = runRemoteSql(buildVerificationSql());
  const verification = assertVerification(result, false);
  printLog("dry-run", {
    mode: "dry-run",
    databaseConnected: true,
    databaseWritten: false,
    plannedEntries: verification.source_rows,
    sourceTotalsCny: verification.source_totals_cny,
    currentCostEntryCount: verification.cost_entries,
  });
  process.exit(0);
}

const migrationRunId = randomUUID();
const importedAt = new Date().toISOString();
const importResult = runRemoteSql(buildImportSql({ migrationRunId, importedAt }));
const verificationResult = runRemoteSql(buildVerificationSql());
const verification = assertVerification(verificationResult, true);

printLog("import", {
  mode: "apply",
  migrationRunId,
  importedAt,
  importResult: importResult?.rows?.[0]?.phase3c2_import,
  verification,
});

function buildImportSql({ migrationRunId, importedAt }) {
  return `begin;
set local lock_timeout = '10s';

do $preflight$
begin
  if not exists (select 1 from auth.users where id = ${sqlUuid(OWNER_ID)})
    or not exists (select 1 from public.profiles where id = ${sqlUuid(OWNER_ID)})
    or (select count(*) from public.portfolios where id = ${sqlUuid(PORTFOLIO_ID)} and created_by = ${sqlUuid(OWNER_ID)}) <> 1
    or (select count(*) from public.portfolio_members where portfolio_id = ${sqlUuid(PORTFOLIO_ID)} and user_id = ${sqlUuid(OWNER_ID)} and role = 'owner') <> 1
  then
    raise exception 'Confirmed portfolio owner baseline is not intact';
  end if;

  if (select count(*) from public.assets) <> 5
    or (select count(*) from public.purchase_orders) <> 4
    or (select count(*) from public.purchase_items) <> 5
    or (select count(*) from public.shipments) <> 2
    or (select count(*) from public.shipment_items) <> 5
    or (select count(*) from public.tracking_events) <> 7
    or (select count(*) from public.repairs) <> 0
    or (select count(*) from public.valuation_snapshots) <> 0
    or (select count(*) from public.sales) <> 0
  then
    raise exception 'Phase 3C-1 business baseline is not intact';
  end if;

  if abs((select sum(allocated_cost_cny) from public.purchase_items) - 13610::numeric) > ${AMOUNT_TOLERANCE}::numeric
    or abs((select sum(allocated_shipping_cny) from public.shipment_items) - 451::numeric) > ${AMOUNT_TOLERANCE}::numeric
    or abs((select sum(actual_paid_cny) from public.shipments) - 221::numeric) > ${AMOUNT_TOLERANCE}::numeric
    or abs((select sum(budget_cny) from public.shipments) - 230::numeric) > ${AMOUNT_TOLERANCE}::numeric
  then
    raise exception 'Source financial baseline does not reconcile';
  end if;

  if (select count(*) from public.purchase_items where portfolio_id <> ${sqlUuid(PORTFOLIO_ID)}) <> 0
    or (select count(*) from public.shipment_items where portfolio_id <> ${sqlUuid(PORTFOLIO_ID)}) <> 0
    or exists (
      select 1
      from public.purchase_items item
      join public.assets asset on asset.id = item.asset_id
      join public.purchase_orders purchase_order on purchase_order.id = item.purchase_order_id
      where item.portfolio_id <> asset.portfolio_id
        or item.portfolio_id <> purchase_order.portfolio_id
    )
    or exists (
      select 1
      from public.shipment_items item
      join public.assets asset on asset.id = item.asset_id
      join public.shipments shipment on shipment.id = item.shipment_id
      where item.portfolio_id <> asset.portfolio_id
        or item.portfolio_id <> shipment.portfolio_id
    )
  then
    raise exception 'Source portfolio or asset relationships are invalid';
  end if;

  if (select count(*) from public.shipments where legacy_id = 'logistics-batch-001' and actual_paid_cny = 221 and budget_cny = 0) <> 1
    or (select count(*) from public.shipments where legacy_id = 'logistics-batch-002' and actual_paid_cny = 0 and budget_cny = 230) <> 1
    or abs((select sum(item.allocated_shipping_cny) from public.shipment_items item join public.shipments shipment on shipment.id = item.shipment_id where shipment.legacy_id = 'logistics-batch-001') - 221::numeric) > ${AMOUNT_TOLERANCE}::numeric
    or abs((select sum(item.allocated_shipping_cny) from public.shipment_items item join public.shipments shipment on shipment.id = item.shipment_id where shipment.legacy_id = 'logistics-batch-002') - 230::numeric) > ${AMOUNT_TOLERANCE}::numeric
  then
    raise exception 'Shipment status baseline does not reconcile';
  end if;

  if not exists (
    select 1
    from pg_constraint constraint_row
    join pg_class table_row on table_row.oid = constraint_row.conrelid
    join pg_namespace schema_row on schema_row.oid = table_row.relnamespace
    where schema_row.nspname = 'public'
      and table_row.relname = 'cost_entries'
      and constraint_row.conname = 'cost_entries_asset_source_cost_key'
      and pg_get_constraintdef(constraint_row.oid) = 'UNIQUE (asset_id, source_type, source_id, cost_type)'
  ) then
    raise exception 'Cost entry idempotency constraint is missing or changed';
  end if;

  if (select count(*) from public.cost_entries) not in (0, 10)
    or exists (
      select 1 from public.cost_entries
      where portfolio_id <> ${sqlUuid(PORTFOLIO_ID)}
        or source_type not in ('purchase_item', 'shipment_item')
        or cost_type not in ('purchase', 'international_shipping')
        or reversal_of is not null
    )
  then
    raise exception 'Unexpected cost entries exist';
  end if;
end;
$preflight$;

select set_config('lensfolio.phase3c2_entries_before', (select count(*)::text from public.cost_entries), true);

create temporary table phase3c2_inserted_entries (
  id uuid primary key,
  asset_id uuid not null,
  source_type public.cost_source_type not null,
  source_id uuid not null,
  cost_type public.cost_type not null,
  amount_cny numeric(20, 2) not null,
  entry_status public.cost_entry_status not null
) on commit drop;

with inserted as (
  insert into public.cost_entries (
    portfolio_id, asset_id, cost_type, source_type, source_id,
    original_amount, currency, fx_rate_to_cny, amount_cny,
    entry_status, occurred_at, reversal_of, created_by
  )
  select
    item.portfolio_id,
    item.asset_id,
    'purchase'::public.cost_type,
    'purchase_item'::public.cost_source_type,
    item.id,
    item.allocated_cost_cny,
    'CNY',
    1::numeric,
    item.allocated_cost_cny,
    'posted'::public.cost_entry_status,
    purchase_order.ordered_at,
    null,
    ${sqlUuid(OWNER_ID)}
  from public.purchase_items item
  join public.purchase_orders purchase_order
    on purchase_order.id = item.purchase_order_id
    and purchase_order.portfolio_id = item.portfolio_id
  where item.portfolio_id = ${sqlUuid(PORTFOLIO_ID)}
  on conflict on constraint cost_entries_asset_source_cost_key do nothing
  returning id, asset_id, source_type, source_id, cost_type, amount_cny, entry_status
)
insert into phase3c2_inserted_entries
select * from inserted;

with inserted as (
  insert into public.cost_entries (
    portfolio_id, asset_id, cost_type, source_type, source_id,
    original_amount, currency, fx_rate_to_cny, amount_cny,
    entry_status, occurred_at, reversal_of, created_by
  )
  select
    item.portfolio_id,
    item.asset_id,
    'international_shipping'::public.cost_type,
    'shipment_item'::public.cost_source_type,
    item.id,
    item.allocated_shipping_cny,
    'CNY',
    1::numeric,
    item.allocated_shipping_cny,
    case shipment.legacy_id
      when 'logistics-batch-001' then 'posted'::public.cost_entry_status
      when 'logistics-batch-002' then 'pending'::public.cost_entry_status
    end,
    coalesce(shipment.shipped_at, shipment.created_at),
    null,
    ${sqlUuid(OWNER_ID)}
  from public.shipment_items item
  join public.shipments shipment
    on shipment.id = item.shipment_id
    and shipment.portfolio_id = item.portfolio_id
  where item.portfolio_id = ${sqlUuid(PORTFOLIO_ID)}
    and shipment.legacy_id in ('logistics-batch-001', 'logistics-batch-002')
  on conflict on constraint cost_entries_asset_source_cost_key do nothing
  returning id, asset_id, source_type, source_id, cost_type, amount_cny, entry_status
)
insert into phase3c2_inserted_entries
select * from inserted;

insert into public.audit_logs (
  id, portfolio_id, actor_id, action, entity_type, entity_id,
  before_data, after_data, occurred_at
) values (
  ${sqlUuid(migrationRunId)},
  ${sqlUuid(PORTFOLIO_ID)},
  ${sqlUuid(OWNER_ID)},
  'phase3c2_cost_ledger_import',
  'migration_run',
  ${sqlUuid(migrationRunId)},
  jsonb_build_object(
    'cost_entries_before', current_setting('lensfolio.phase3c2_entries_before')::integer
  ),
  jsonb_build_object(
    'phase', '3C-2B',
    'migration_run_id', ${sqlText(migrationRunId)},
    'imported_at', ${sqlText(importedAt)},
    'source', 'migrated Supabase purchase_items and shipment_items',
    'inserted_count', (select count(*) from phase3c2_inserted_entries),
    'inserted_entries', (
      select coalesce(jsonb_agg(jsonb_build_object(
        'id', id,
        'asset_id', asset_id,
        'source_type', source_type,
        'source_id', source_id,
        'cost_type', cost_type,
        'amount_cny', amount_cny,
        'entry_status', entry_status
      ) order by source_type, source_id), '[]'::jsonb)
      from phase3c2_inserted_entries
    )
  ),
  ${sqlTimestamp(importedAt)}
);

do $postflight$
begin
  if (select count(*) from public.cost_entries) <> 10
    or (select count(*) from public.cost_entries where cost_type = 'purchase' and source_type = 'purchase_item' and entry_status = 'posted') <> 5
    or (select count(*) from public.cost_entries where cost_type = 'international_shipping' and source_type = 'shipment_item' and entry_status = 'posted') <> 2
    or (select count(*) from public.cost_entries where cost_type = 'international_shipping' and source_type = 'shipment_item' and entry_status = 'pending') <> 3
    or abs((select sum(amount_cny) from public.cost_entries where cost_type = 'purchase') - 13610::numeric) > ${AMOUNT_TOLERANCE}::numeric
    or abs((select sum(amount_cny) from public.cost_entries where cost_type = 'international_shipping') - 451::numeric) > ${AMOUNT_TOLERANCE}::numeric
    or abs((select sum(amount_cny) from public.cost_entries where entry_status = 'posted') - 13831::numeric) > ${AMOUNT_TOLERANCE}::numeric
    or abs((select sum(amount_cny) from public.cost_entries) - 14061::numeric) > ${AMOUNT_TOLERANCE}::numeric
    or exists (
      select 1
      from public.cost_entries entry
      left join public.purchase_items item
        on entry.source_type = 'purchase_item'
        and item.id = entry.source_id
        and item.asset_id = entry.asset_id
        and item.portfolio_id = entry.portfolio_id
      left join public.shipment_items shipment_item
        on entry.source_type = 'shipment_item'
        and shipment_item.id = entry.source_id
        and shipment_item.asset_id = entry.asset_id
        and shipment_item.portfolio_id = entry.portfolio_id
      where (entry.source_type = 'purchase_item' and item.id is null)
        or (entry.source_type = 'shipment_item' and shipment_item.id is null)
    )
    or exists (
      select 1
      from public.cost_entries entry
      left join public.purchase_items purchase_item on entry.source_type = 'purchase_item' and purchase_item.id = entry.source_id
      left join public.shipment_items shipment_item on entry.source_type = 'shipment_item' and shipment_item.id = entry.source_id
      where entry.original_amount <> entry.amount_cny
        or entry.currency <> 'CNY'
        or entry.fx_rate_to_cny <> 1
        or entry.amount_cny <> coalesce(purchase_item.allocated_cost_cny, shipment_item.allocated_shipping_cny)
    )
  then
    raise exception 'Phase 3C-2B postflight verification failed';
  end if;
end;
$postflight$;

commit;

select json_build_object(
  'migration_run_id', ${sqlUuid(migrationRunId)},
  'cost_entries_before', (select (before_data->>'cost_entries_before')::integer from public.audit_logs where id = ${sqlUuid(migrationRunId)}),
  'inserted_count', (select (after_data->>'inserted_count')::integer from public.audit_logs where id = ${sqlUuid(migrationRunId)}),
  'cost_entries_after', (select count(*) from public.cost_entries),
  'audit_log_id', (select id from public.audit_logs where id = ${sqlUuid(migrationRunId)})
) as phase3c2_import;`;
}

function buildVerificationSql() {
  return `with source_rows as (
  select
    asset.legacy_id as asset_legacy_id,
    asset.brand,
    asset.model,
    'purchase_item'::text as source_type,
    item.id as source_id,
    purchase_order.legacy_id as parent_legacy_id,
    item.allocated_cost_cny as amount_cny,
    'posted'::text as expected_status
  from public.purchase_items item
  join public.purchase_orders purchase_order on purchase_order.id = item.purchase_order_id
  join public.assets asset on asset.id = item.asset_id
  union all
  select
    asset.legacy_id,
    asset.brand,
    asset.model,
    'shipment_item',
    item.id,
    shipment.legacy_id,
    item.allocated_shipping_cny,
    case shipment.legacy_id when 'logistics-batch-001' then 'posted' else 'pending' end
  from public.shipment_items item
  join public.shipments shipment on shipment.id = item.shipment_id
  join public.assets asset on asset.id = item.asset_id
),
ledger_by_asset as (
  select
    asset.legacy_id,
    coalesce(sum(entry.amount_cny) filter (where entry.cost_type = 'purchase'), 0) as purchase_cny,
    coalesce(sum(entry.amount_cny) filter (where entry.cost_type = 'international_shipping'), 0) as shipping_cny,
    coalesce(sum(entry.amount_cny), 0) as all_entry_total_cny,
    coalesce(sum(entry.amount_cny) filter (where entry.entry_status = 'posted'), 0) as posted_total_cny
  from public.assets asset
  left join public.cost_entries entry on entry.asset_id = asset.id
  group by asset.id, asset.legacy_id
),
source_totals as (
  select
    (select sum(allocated_cost_cny) from public.purchase_items) as purchase_cny,
    (select sum(allocated_shipping_cny) from public.shipment_items) as shipping_cny,
    (select sum(actual_paid_cny) from public.shipments) as shipping_actual_cny,
    (select sum(budget_cny) from public.shipments) as shipping_budget_cny
),
ledger_totals as (
  select
    coalesce(sum(amount_cny) filter (where cost_type = 'purchase'), 0) as purchase_cny,
    coalesce(sum(amount_cny) filter (where cost_type = 'international_shipping'), 0) as shipping_cny,
    coalesce(sum(amount_cny) filter (where cost_type = 'international_shipping' and entry_status = 'posted'), 0) as shipping_posted_cny,
    coalesce(sum(amount_cny) filter (where cost_type = 'international_shipping' and entry_status = 'pending'), 0) as shipping_pending_cny,
    coalesce(sum(amount_cny) filter (where entry_status = 'posted'), 0) as posted_total_cny,
    coalesce(sum(amount_cny), 0) as all_entry_total_cny
  from public.cost_entries
)
select json_build_object(
  'portfolio_id', ${sqlUuid(PORTFOLIO_ID)},
  'owner_id', ${sqlUuid(OWNER_ID)},
  'assets', (select count(*) from public.assets),
  'purchase_orders', (select count(*) from public.purchase_orders),
  'purchase_items', (select count(*) from public.purchase_items),
  'shipments', (select count(*) from public.shipments),
  'shipment_items', (select count(*) from public.shipment_items),
  'tracking_events', (select count(*) from public.tracking_events),
  'repairs', (select count(*) from public.repairs),
  'valuation_snapshots', (select count(*) from public.valuation_snapshots),
  'sales', (select count(*) from public.sales),
  'cost_entries', (select count(*) from public.cost_entries),
  'source_rows', (select coalesce(json_agg(row_to_json(source_rows) order by source_type, parent_legacy_id, asset_legacy_id), '[]'::json) from source_rows),
  'source_totals_cny', (select row_to_json(source_totals) from source_totals),
  'ledger_totals_cny', (select row_to_json(ledger_totals) from ledger_totals),
  'entry_status_counts', json_build_object(
    'purchase_posted', (select count(*) from public.cost_entries where cost_type = 'purchase' and entry_status = 'posted'),
    'shipping_posted', (select count(*) from public.cost_entries where cost_type = 'international_shipping' and entry_status = 'posted'),
    'shipping_pending', (select count(*) from public.cost_entries where cost_type = 'international_shipping' and entry_status = 'pending')
  ),
  'duplicate_key_count', (
    select count(*) from (
      select asset_id, source_type, source_id, cost_type
      from public.cost_entries
      group by asset_id, source_type, source_id, cost_type
      having count(*) > 1
    ) duplicates
  ),
  'source_mismatch_count', (
    select count(*)
    from public.cost_entries entry
    left join public.purchase_items purchase_item
      on entry.source_type = 'purchase_item'
      and purchase_item.id = entry.source_id
      and purchase_item.asset_id = entry.asset_id
      and purchase_item.portfolio_id = entry.portfolio_id
    left join public.shipment_items shipment_item
      on entry.source_type = 'shipment_item'
      and shipment_item.id = entry.source_id
      and shipment_item.asset_id = entry.asset_id
      and shipment_item.portfolio_id = entry.portfolio_id
    where (entry.source_type = 'purchase_item' and purchase_item.id is null)
      or (entry.source_type = 'shipment_item' and shipment_item.id is null)
  ),
  'amount_mismatch_count', (
    select count(*)
    from public.cost_entries entry
    left join public.purchase_items purchase_item on entry.source_type = 'purchase_item' and purchase_item.id = entry.source_id
    left join public.shipment_items shipment_item on entry.source_type = 'shipment_item' and shipment_item.id = entry.source_id
    where entry.original_amount <> entry.amount_cny
      or entry.currency <> 'CNY'
      or entry.fx_rate_to_cny <> 1
      or entry.amount_cny <> coalesce(purchase_item.allocated_cost_cny, shipment_item.allocated_shipping_cny)
  ),
  'asset_costs', (select coalesce(json_agg(row_to_json(ledger_by_asset) order by legacy_id), '[]'::json) from ledger_by_asset),
  'asset_financials', (
    select coalesce(json_agg(row_to_json(financial_row) order by financial_row.legacy_id), '[]'::json)
    from (
      select
        asset.legacy_id,
        financial.acquisition_cost_cny,
        financial.logistics_cost_cny,
        financial.total_carrying_cost_cny,
        financial.current_valuation_cny,
        financial.realized_profit_cny,
        financial.unrealized_profit_cny,
        financial.investment_roi,
        financial.roi_basis
      from public.asset_financials financial
      join public.assets asset on asset.id = financial.asset_id
    ) financial_row
  ),
  'roi_formula_valid', (
    select position('/ cost.total_carrying_cost_cny' in lower(pg_get_viewdef('public.asset_financials'::regclass, true))) > 0
      and position('/ sale.sold_price_cny' in lower(pg_get_viewdef('public.asset_financials'::regclass, true))) = 0
  ),
  'import_audit_count', (select count(*) from public.audit_logs where action = 'phase3c2_cost_ledger_import')
) as phase3c2_verification;`;
}

function buildRollbackSql({ targetMigrationRunId, rollbackRunId, rolledBackAt }) {
  const targetFilter = targetMigrationRunId
    ? `and id = ${sqlUuid(targetMigrationRunId)}`
    : "and coalesce((after_data->>'inserted_count')::integer, 0) > 0";

  return `begin;
set local lock_timeout = '10s';

create temporary table phase3c2_rollback_run (
  import_run_id uuid primary key,
  inserted_entries jsonb not null
) on commit drop;

insert into phase3c2_rollback_run (import_run_id, inserted_entries)
select id, after_data->'inserted_entries'
from public.audit_logs
where action = 'phase3c2_cost_ledger_import'
  ${targetFilter}
order by occurred_at desc
limit 1;

create temporary table phase3c2_rollback_targets (
  id uuid primary key,
  asset_id uuid not null,
  source_type public.cost_source_type not null,
  source_id uuid not null,
  cost_type public.cost_type not null,
  amount_cny numeric(20, 2) not null,
  entry_status public.cost_entry_status not null
) on commit drop;

insert into phase3c2_rollback_targets
select target.*
from phase3c2_rollback_run run
cross join lateral jsonb_to_recordset(run.inserted_entries) as target(
  id uuid,
  asset_id uuid,
  source_type public.cost_source_type,
  source_id uuid,
  cost_type public.cost_type,
  amount_cny numeric,
  entry_status public.cost_entry_status
);

do $rollback_preflight$
begin
  if (select count(*) from phase3c2_rollback_run) <> 1
    or (select count(*) from phase3c2_rollback_targets) = 0
  then
    raise exception 'No eligible Phase 3C-2B migration run was found';
  end if;

  if (select count(*) from public.repairs) <> 0
    or (select count(*) from public.valuation_snapshots) <> 0
    or (select count(*) from public.sales) <> 0
    or exists (select 1 from public.cost_entries where reversal_of in (select id from phase3c2_rollback_targets))
  then
    raise exception 'Rollback is blocked by downstream financial data or reversals';
  end if;

  if (select count(*) from public.cost_entries) <> (select count(*) from phase3c2_rollback_targets)
    or exists (
      select 1
      from phase3c2_rollback_targets target
      left join public.cost_entries entry
        on entry.id = target.id
        and entry.asset_id = target.asset_id
        and entry.source_type = target.source_type
        and entry.source_id = target.source_id
        and entry.cost_type = target.cost_type
        and entry.amount_cny = target.amount_cny
        and entry.entry_status = target.entry_status
      where entry.id is null
    )
  then
    raise exception 'Ledger rows no longer match the selected migration run';
  end if;
end;
$rollback_preflight$;

with deleted as (
  delete from public.cost_entries entry
  using phase3c2_rollback_targets target
  where entry.id = target.id
    and entry.asset_id = target.asset_id
    and entry.source_type = target.source_type
    and entry.source_id = target.source_id
    and entry.cost_type = target.cost_type
  returning entry.id
)
select set_config('lensfolio.phase3c2_deleted_count', count(*)::text, true)
from deleted;

insert into public.audit_logs (
  id, portfolio_id, actor_id, action, entity_type, entity_id,
  before_data, after_data, occurred_at
) values (
  ${sqlUuid(rollbackRunId)},
  ${sqlUuid(PORTFOLIO_ID)},
  ${sqlUuid(OWNER_ID)},
  'phase3c2_cost_ledger_rollback',
  'migration_run',
  ${sqlUuid(rollbackRunId)},
  jsonb_build_object(
    'target_migration_run_id', (select import_run_id from phase3c2_rollback_run),
    'target_entry_ids', (select jsonb_agg(id order by id) from phase3c2_rollback_targets)
  ),
  jsonb_build_object(
    'deleted_count', current_setting('lensfolio.phase3c2_deleted_count')::integer,
    'cost_entries_after', (select count(*) from public.cost_entries)
  ),
  ${sqlTimestamp(rolledBackAt)}
);

do $rollback_postflight$
begin
  if current_setting('lensfolio.phase3c2_deleted_count')::integer <> (select count(*) from phase3c2_rollback_targets)
    or (select count(*) from public.cost_entries) <> 0
  then
    raise exception 'Phase 3C-2B rollback postflight verification failed';
  end if;
end;
$rollback_postflight$;

commit;

select json_build_object(
  'rollback_run_id', ${sqlUuid(rollbackRunId)},
  'target_migration_run_id', (select (before_data->>'target_migration_run_id')::uuid from public.audit_logs where id = ${sqlUuid(rollbackRunId)}),
  'deleted_count', (select (after_data->>'deleted_count')::integer from public.audit_logs where id = ${sqlUuid(rollbackRunId)}),
  'cost_entries_after', (select count(*) from public.cost_entries)
) as phase3c2_rollback;`;
}

function assertVerification(result, requireEntries) {
  const verification = result?.rows?.[0]?.phase3c2_verification;
  if (!verification || typeof verification !== "object") {
    throw new Error("Supabase response is missing phase3c2_verification");
  }

  const expectedCounts = {
    assets: 5,
    purchase_orders: 4,
    purchase_items: 5,
    shipments: 2,
    shipment_items: 5,
    tracking_events: 7,
    repairs: 0,
    valuation_snapshots: 0,
    sales: 0,
  };
  for (const [key, expected] of Object.entries(expectedCounts)) {
    assertEqual(Number(verification[key]), expected, key);
  }

  assertAmount(verification.source_totals_cny.purchase_cny, 13610, "source purchase total");
  assertAmount(verification.source_totals_cny.shipping_cny, 451, "source shipping total");
  assertAmount(verification.source_totals_cny.shipping_actual_cny, 221, "source actual shipping total");
  assertAmount(verification.source_totals_cny.shipping_budget_cny, 230, "source budget shipping total");
  assertEqual(verification.source_rows.length, 10, "source row count");

  const sourceByAsset = new Map();
  for (const row of verification.source_rows) {
    const current = sourceByAsset.get(row.asset_legacy_id) ?? { purchase: 0, shipping: 0 };
    if (row.source_type === "purchase_item") {
      current.purchase += Number(row.amount_cny);
      assertEqual(row.expected_status, "posted", `${row.asset_legacy_id} purchase status`);
    } else if (row.source_type === "shipment_item") {
      current.shipping += Number(row.amount_cny);
      const expectedStatus = row.parent_legacy_id === "logistics-batch-001" ? "posted" : "pending";
      assertEqual(row.expected_status, expectedStatus, `${row.asset_legacy_id} shipping status`);
    } else {
      throw new Error(`Unexpected source type: ${row.source_type}`);
    }
    sourceByAsset.set(row.asset_legacy_id, current);
  }
  for (const [legacyId, expected] of EXPECTED_ASSETS) {
    const actual = sourceByAsset.get(legacyId);
    if (!actual) throw new Error(`Missing source allocation for ${legacyId}`);
    assertAmount(actual.purchase, expected.purchase, `${legacyId} source purchase`);
    assertAmount(actual.shipping, expected.shipping, `${legacyId} source shipping`);
  }

  if (!requireEntries) {
    if (![0, 10].includes(Number(verification.cost_entries))) {
      throw new Error(`Dry-run found an unexpected cost entry count: ${verification.cost_entries}`);
    }
    return verification;
  }

  assertEqual(Number(verification.cost_entries), 10, "cost_entries");
  assertEqual(Number(verification.entry_status_counts.purchase_posted), 5, "posted purchase count");
  assertEqual(Number(verification.entry_status_counts.shipping_posted), 2, "posted shipping count");
  assertEqual(Number(verification.entry_status_counts.shipping_pending), 3, "pending shipping count");
  assertEqual(Number(verification.duplicate_key_count), 0, "duplicate ledger key count");
  assertEqual(Number(verification.source_mismatch_count), 0, "source mismatch count");
  assertEqual(Number(verification.amount_mismatch_count), 0, "amount mismatch count");
  assertAmount(verification.ledger_totals_cny.purchase_cny, 13610, "ledger purchase total");
  assertAmount(verification.ledger_totals_cny.shipping_cny, 451, "ledger shipping total");
  assertAmount(verification.ledger_totals_cny.shipping_posted_cny, 221, "posted shipping total");
  assertAmount(verification.ledger_totals_cny.shipping_pending_cny, 230, "pending shipping total");
  assertAmount(verification.ledger_totals_cny.posted_total_cny, 13831, "posted carrying total");
  assertAmount(verification.ledger_totals_cny.all_entry_total_cny, 14061, "all entry total");

  const actualAssets = new Map(verification.asset_costs.map((row) => [row.legacy_id, row]));
  for (const [legacyId, expected] of EXPECTED_ASSETS) {
    const actual = actualAssets.get(legacyId);
    if (!actual) throw new Error(`Missing asset cost row: ${legacyId}`);
    assertAmount(actual.purchase_cny, expected.purchase, `${legacyId} purchase`);
    assertAmount(actual.shipping_cny, expected.shipping, `${legacyId} shipping`);
    assertAmount(actual.all_entry_total_cny, expected.total, `${legacyId} all-entry total`);
    assertAmount(actual.posted_total_cny, expected.posted, `${legacyId} posted total`);
  }

  const financials = new Map(verification.asset_financials.map((row) => [row.legacy_id, row]));
  for (const [legacyId, expected] of EXPECTED_ASSETS) {
    const actual = financials.get(legacyId);
    if (!actual) throw new Error(`Missing asset_financials row: ${legacyId}`);
    assertAmount(actual.acquisition_cost_cny, expected.purchase, `${legacyId} view acquisition`);
    assertAmount(actual.logistics_cost_cny, expected.posted - expected.purchase, `${legacyId} view logistics`);
    assertAmount(actual.total_carrying_cost_cny, expected.posted, `${legacyId} view carrying cost`);
    if (actual.current_valuation_cny !== null
      || actual.realized_profit_cny !== null
      || actual.unrealized_profit_cny !== null
      || actual.investment_roi !== null) {
      throw new Error(`${legacyId} has valuation, profit, or ROI before valuation/sales migration`);
    }
  }
  if (verification.roi_formula_valid !== true) {
    throw new Error("asset_financials ROI definition is not profit / total carrying cost");
  }

  return verification;
}

function runRemoteSql(sql) {
  const temporaryDirectory = mkdtempSync(join(tmpdir(), "lensfolio-phase3c2-"));
  const sqlPath = join(temporaryDirectory, "query.sql");
  try {
    writeFileSync(sqlPath, sql, { encoding: "utf8", mode: 0o600 });
    let lastResult;
    for (let attempt = 1; attempt <= 2; attempt += 1) {
      lastResult = spawnSync(
        "npx",
        [
          "--yes",
          `supabase@${SUPABASE_CLI_VERSION}`,
          "db",
          "query",
          "--linked",
          "--file",
          sqlPath,
          "--output-format",
          "json",
        ],
        { cwd: process.cwd(), encoding: "utf8", stdio: "pipe", timeout: 30000 },
      );
      if (lastResult.error) {
        if (lastResult.error.code === "ETIMEDOUT" && attempt === 1) continue;
        throw lastResult.error;
      }
      if (lastResult.status === 0) return parseCliJson(lastResult.stdout);
      const output = `${lastResult.stderr || ""}\n${lastResult.stdout || ""}`;
      const transientLoginFailure = output.includes("password authentication failed for user \"cli_login_postgres\"");
      if (!transientLoginFailure || attempt === 2) {
        throw new Error(`Supabase CLI failed with status ${lastResult.status}: ${output.trim()}`);
      }
    }
    throw new Error("Supabase CLI did not return a result");
  } finally {
    rmSync(temporaryDirectory, { recursive: true, force: true });
  }
}

function parseCliJson(stdout) {
  const trimmed = stdout.trim();
  try {
    return JSON.parse(trimmed);
  } catch {
    const firstBrace = trimmed.indexOf("{");
    if (firstBrace >= 0) return JSON.parse(trimmed.slice(firstBrace));
    throw new Error(`Supabase CLI returned invalid JSON: ${trimmed}`);
  }
}

function parseArgs(values) {
  const parsed = {};
  for (let index = 0; index < values.length; index += 1) {
    const value = values[index];
    if (value === "--help" || value === "-h") parsed.help = true;
    else if (value === "--apply") parsed.apply = true;
    else if (value === "--verify") parsed.verify = true;
    else if (value === "--rollback") parsed.rollback = true;
    else if (value === "--confirm-rollback") parsed.confirmRollback = true;
    else if (value === "--migration-run-id") {
      const next = values[index + 1];
      if (!next || next.startsWith("--")) throw new Error(`Missing value for ${value}`);
      if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(next)) {
        throw new Error("--migration-run-id must be a UUID");
      }
      parsed.migrationRunId = next;
      index += 1;
    } else {
      throw new Error(`Unknown argument: ${value}`);
    }
  }
  const modes = [parsed.apply, parsed.verify, parsed.rollback].filter(Boolean).length;
  if (modes > 1) throw new Error("Choose only one of --apply, --verify, or --rollback");
  if (parsed.confirmRollback && !parsed.rollback) {
    throw new Error("--confirm-rollback is only valid with --rollback");
  }
  if (parsed.migrationRunId && !parsed.rollback) {
    throw new Error("--migration-run-id is only valid with --rollback");
  }
  return parsed;
}

function sqlText(value) {
  return `'${String(value).replaceAll("'", "''")}'`;
}

function sqlUuid(value) {
  return `${sqlText(value)}::uuid`;
}

function sqlTimestamp(value) {
  return `${sqlText(value)}::timestamptz`;
}

function assertEqual(actual, expected, label) {
  if (actual !== expected) throw new Error(`${label}: expected ${expected}, got ${actual}`);
}

function assertAmount(actual, expected, label) {
  const difference = Math.abs(Number(actual) - Number(expected));
  if (!Number.isFinite(difference) || difference > AMOUNT_TOLERANCE) {
    throw new Error(`${label}: expected ${expected}, got ${actual}`);
  }
}

function printLog(event, details) {
  console.log(JSON.stringify({ event, loggedAt: new Date().toISOString(), ...details }, null, 2));
}

function printHelp() {
  console.log(`Usage:
  node scripts/import-cost-ledger-phase3c2.mjs
  node scripts/import-cost-ledger-phase3c2.mjs --apply
  node scripts/import-cost-ledger-phase3c2.mjs --verify
  node scripts/import-cost-ledger-phase3c2.mjs --rollback --confirm-rollback [--migration-run-id <uuid>]

Default mode performs a read-only dry-run against the migrated Purchase and
Logistics source tables. Apply writes ten source-linked cost entries in one
transaction and records its migration_run_id in audit_logs. Repeated apply uses
ON CONFLICT ON CONSTRAINT cost_entries_asset_source_cost_key and creates no
duplicates. Rollback deletes only the entry UUIDs recorded as inserted by the
selected migration run and refuses without explicit confirmation.`);
}
