#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { basename, join } from "node:path";
import { tmpdir } from "node:os";
import { resolve } from "node:path";

const EXPECTED_BACKUP_NAME = "lensfolio-d1-backup-20260821T141816Z";
const EXPECTED_MANIFEST_SHA256 = "a7bb4f87a43efb58e26292f4507b6ac401102cce34c5d4529290d467bf0142f8";
const EXPECTED_VALUATION_SHA256 = "a6ef0ea2ec6da876e0d24f3ea4f67a6164c375bb1ca74033f6f7d03b82af95a8";
const OWNER_ID = "b438f993-fbfd-49c9-963b-ff0d02ff4003";
const PORTFOLIO_ID = "c9392708-c769-5f74-9587-b3071bc354bd";
const UUID_NAMESPACE = "4dfd41dc-fec8-4c37-814f-adf2f0916be8";
const MARKET_SOURCE_ID = uuidV5(`${EXPECTED_BACKUP_NAME}:market-source:xianyu`, UUID_NAMESPACE);
const SUPABASE_CLI_VERSION = "2.115.0";
const METHODOLOGY_VERSION = "legacy_manual_v1";
const AMOUNT_TOLERANCE = 0.01;

const EXPECTED_ASSETS = new Map([
  ["canon-autoboy-sii-01", { valuation: 1100, postedCost: 1092, allCost: 1092, profit: 8 }],
  ["contax-t2-date-back", { valuation: 7000, postedCost: 5028, allCost: 5028, profit: 1972 }],
  ["nikon-28ti", { valuation: 7400, postedCost: 6505, allCost: 6603, profit: 895 }],
  ["canon-autoboy-s-set", { valuation: 700, postedCost: 603, allCost: 669, profit: 97 }],
  ["canon-autoboy-sii-set", { valuation: 1050, postedCost: 603, allCost: 669, profit: 447 }],
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

const backupDirectory = resolve(required(args.backup, "--backup"));
const source = loadAndValidateBackup(backupDirectory);
const plan = buildPlan(source);

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
    targetMigrationRunId: result?.rows?.[0]?.phase4a2_rollback?.target_migration_run_id,
    rolledBackAt,
    result: result?.rows?.[0]?.phase4a2_rollback,
  });
  process.exit(0);
}

if (args.verify) {
  const result = runRemoteSql(buildVerificationSql(plan));
  const verification = assertVerification(result, plan, true);
  printLog("verification", {
    mode: "verify",
    backup: backupDirectory,
    manifestSha256: source.manifestSha256,
    valuationJsonlSha256: source.valuationJsonlSha256,
    result: verification,
  });
  process.exit(0);
}

if (!args.apply) {
  printLog("dry-run", {
    mode: "dry-run",
    databaseConnected: false,
    databaseWritten: false,
    backup: backupDirectory,
    manifestSha256: source.manifestSha256,
    valuationJsonlSha256: source.valuationJsonlSha256,
    marketSource: { id: MARKET_SOURCE_ID, name: "闲鱼", sourceType: "xianyu" },
    snapshots: plan.snapshots,
    totalsCny: plan.totals,
    downstreamTablesWritten: [],
  });
  process.exit(0);
}

const migrationRunId = randomUUID();
const importedAt = new Date().toISOString();
const importResult = runRemoteSql(buildImportSql({
  plan,
  migrationRunId,
  importedAt,
  manifestSha256: source.manifestSha256,
  valuationJsonlSha256: source.valuationJsonlSha256,
}));
const verificationResult = runRemoteSql(buildVerificationSql(plan));
const verification = assertVerification(verificationResult, plan, true);

printLog("import", {
  mode: "apply",
  migrationRunId,
  importedAt,
  backup: backupDirectory,
  manifestSha256: source.manifestSha256,
  valuationJsonlSha256: source.valuationJsonlSha256,
  importResult: importResult?.rows?.[0]?.phase4a2_import,
  verification,
});

function loadAndValidateBackup(directory) {
  if (!existsSync(directory)) throw new Error(`Backup directory not found: ${directory}`);
  if (basename(directory) !== EXPECTED_BACKUP_NAME) {
    throw new Error(`Backup directory must be exactly ${EXPECTED_BACKUP_NAME}`);
  }

  const manifestPath = join(directory, "manifest.json");
  const checksumsPath = join(directory, "checksums.sha256");
  const valuationsPath = join(directory, "data", "market_valuations.jsonl");
  const camerasPath = join(directory, "data", "cameras.jsonl");
  for (const filePath of [manifestPath, checksumsPath, valuationsPath, camerasPath]) {
    if (!existsSync(filePath)) throw new Error(`Required backup file not found: ${filePath}`);
  }

  const manifestSha256 = sha256(manifestPath);
  const valuationJsonlSha256 = sha256(valuationsPath);
  if (manifestSha256 !== EXPECTED_MANIFEST_SHA256) {
    throw new Error(`Manifest checksum mismatch: expected ${EXPECTED_MANIFEST_SHA256}, got ${manifestSha256}`);
  }
  if (valuationJsonlSha256 !== EXPECTED_VALUATION_SHA256) {
    throw new Error(`Valuation JSONL checksum mismatch: expected ${EXPECTED_VALUATION_SHA256}, got ${valuationJsonlSha256}`);
  }
  validateChecksumFile(directory, checksumsPath);

  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  if (manifest?.site?.migrationReadOnly !== true
    || manifest?.site?.siteVersion !== "v4"
    || manifest?.site?.accessMode !== "owner-only") {
    throw new Error("Backup manifest is not the frozen owner-only Site v4 baseline");
  }
  if (manifest?.tables?.market_valuations?.rowCount !== 5
    || Number(manifest?.financialBaseline?.currentValuationCny) !== 17250) {
    throw new Error("Backup valuation baseline does not match Phase 1C");
  }

  return {
    manifestSha256,
    valuationJsonlSha256,
    valuations: parseJsonLines(valuationsPath),
    cameras: parseJsonLines(camerasPath),
  };
}

function buildPlan(source) {
  if (source.valuations.length !== 5 || source.cameras.length !== 5) {
    throw new Error("Frozen backup must contain five valuations and five cameras");
  }
  assertUniqueNonempty(source.valuations.map(({ id }) => id), "valuation IDs");
  assertUniqueNonempty(source.valuations.map(({ camera_id: cameraId }) => cameraId), "valuation camera IDs");
  assertUniqueNonempty(source.cameras.map(({ id }) => id), "camera IDs");

  const cameraIds = new Set(source.cameras.map(({ id }) => id));
  const snapshots = source.valuations.map((row) => {
    if (!cameraIds.has(row.camera_id) || !EXPECTED_ASSETS.has(row.camera_id)) {
      throw new Error(`Valuation ${row.id} references an unexpected camera: ${row.camera_id}`);
    }
    if (row.source !== "闲鱼" || row.collection_method !== "人工录入") {
      throw new Error(`Valuation ${row.id} has unexpected source or collection method`);
    }
    if (row.sample_size !== null) {
      throw new Error(`Valuation ${row.id} sample_size must remain NULL`);
    }
    const low = requiredNumber(row.low_cny, `${row.id}.low_cny`);
    const median = requiredNumber(row.median_cny, `${row.id}.median_cny`);
    const high = requiredNumber(row.high_cny, `${row.id}.high_cny`);
    const confidence = requiredNumber(row.confidence, `${row.id}.confidence`);
    if (low > median || median > high) throw new Error(`${row.id} violates low <= median <= high`);
    if (confidence < 0 || confidence > 1) throw new Error(`${row.id} confidence is outside 0..1`);
    assertAmount(row.expected_cny, median, `${row.id} expected versus median`);
    assertAmount(row.average_cny, median, `${row.id} average versus median`);
    assertAmount(row.premium_cny, high, `${row.id} premium versus high`);

    return {
      id: uuidV5(`${EXPECTED_BACKUP_NAME}:valuation:${row.id}`, UUID_NAMESPACE),
      legacyId: row.id,
      assetLegacyId: row.camera_id,
      low,
      median,
      high,
      sampleCount: null,
      confidence,
      methodologyVersion: METHODOLOGY_VERSION,
      valuedAt: hongKongDateToUtc(row.valued_at),
      createdAt: hongKongTimestampToUtc(row.created_at),
      currency: "CNY",
    };
  });

  const valuationTotalCny = snapshots.reduce((sum, row) => sum + row.median, 0);
  assertAmount(valuationTotalCny, 17250, "valuation total");
  return { snapshots, totals: { valuationCny: valuationTotalCny } };
}

function buildImportSql({ plan, migrationRunId, importedAt, manifestSha256, valuationJsonlSha256 }) {
  const legacyIds = sqlTextArray(plan.snapshots.map(({ legacyId }) => legacyId));
  const assetLegacyIds = sqlTextArray(plan.snapshots.map(({ assetLegacyId }) => assetLegacyId));
  const values = snapshotValues(plan.snapshots);

  return `begin;
set local lock_timeout = '10s';

do $preflight$
begin
  if not exists (select 1 from auth.users where id = ${sqlUuid(OWNER_ID)})
    or not exists (select 1 from public.profiles where id = ${sqlUuid(OWNER_ID)})
    or (select count(*) from public.portfolios where id = ${sqlUuid(PORTFOLIO_ID)} and created_by = ${sqlUuid(OWNER_ID)} and base_currency = 'CNY') <> 1
    or (select count(*) from public.portfolio_members where portfolio_id = ${sqlUuid(PORTFOLIO_ID)} and user_id = ${sqlUuid(OWNER_ID)} and role = 'owner') <> 1
  then
    raise exception 'Confirmed CNY portfolio owner baseline is not intact';
  end if;

  if (select count(*) from public.assets) <> 5
    or (select count(*) from public.purchase_orders) <> 4
    or (select count(*) from public.purchase_items) <> 5
    or (select count(*) from public.shipments) <> 2
    or (select count(*) from public.shipment_items) <> 5
    or (select count(*) from public.tracking_events) <> 7
    or (select count(*) from public.cost_entries) <> 10
    or (select count(*) from public.market_listings) <> 0
    or (select count(*) from public.sales) <> 0
  then
    raise exception 'Phase 4A-1 business baseline is not intact';
  end if;

  if abs((select sum(amount_cny) from public.cost_entries) - 14061::numeric) > ${AMOUNT_TOLERANCE}::numeric
    or abs((select sum(amount_cny) from public.cost_entries where entry_status = 'posted') - 13831::numeric) > ${AMOUNT_TOLERANCE}::numeric
  then
    raise exception 'Cost ledger baseline changed';
  end if;

  if (select count(*) from public.assets where portfolio_id = ${sqlUuid(PORTFOLIO_ID)} and legacy_id = any (${assetLegacyIds})) <> 5
  then
    raise exception 'Valuation assets do not map 5/5';
  end if;

  if (select count(*) from public.market_sources) > 1
    or exists (select 1 from public.market_sources where portfolio_id <> ${sqlUuid(PORTFOLIO_ID)} or name <> '闲鱼')
    or (select count(*) from public.valuation_snapshots) > 5
    or exists (
      select 1 from public.valuation_snapshots
      where portfolio_id <> ${sqlUuid(PORTFOLIO_ID)}
        or legacy_id is null
        or legacy_id <> all (${legacyIds})
    )
  then
    raise exception 'Unexpected market source or valuation rows exist';
  end if;

  if not exists (
    select 1
    from pg_constraint constraint_row
    join pg_class table_row on table_row.oid = constraint_row.conrelid
    join pg_namespace schema_row on schema_row.oid = table_row.relnamespace
    where schema_row.nspname = 'public'
      and table_row.relname = 'valuation_snapshots'
      and constraint_row.conname = 'valuation_snapshots_portfolio_legacy_key'
      and pg_get_constraintdef(constraint_row.oid) = 'UNIQUE (portfolio_id, legacy_id)'
  ) then
    raise exception 'Valuation idempotency constraint is missing or changed';
  end if;

  if (select count(*) from information_schema.columns
    where table_schema = 'public'
      and table_name = 'valuation_snapshots'
      and column_name = 'sample_count'
      and is_nullable = 'YES'
      and column_default is null) <> 1 then
    raise exception 'sample_count must be nullable with no default';
  end if;
end;
$preflight$;

select set_config('lensfolio.phase4a2_sources_before', (select count(*)::text from public.market_sources), true);
select set_config('lensfolio.phase4a2_snapshots_before', (select count(*)::text from public.valuation_snapshots), true);

create temporary table phase4a2_existing_snapshots as
select id, legacy_id
from public.valuation_snapshots
where portfolio_id = ${sqlUuid(PORTFOLIO_ID)};

insert into public.market_sources (
  id, portfolio_id, name, source_url, active, created_at, updated_at, created_by, source_type
) values (
  ${sqlUuid(MARKET_SOURCE_ID)},
  ${sqlUuid(PORTFOLIO_ID)},
  '闲鱼',
  null,
  true,
  ${sqlTimestamp(importedAt)},
  ${sqlTimestamp(importedAt)},
  ${sqlUuid(OWNER_ID)},
  'xianyu'
)
on conflict (portfolio_id, name) do update set
  source_type = excluded.source_type,
  active = excluded.active,
  created_by = excluded.created_by
where (market_sources.source_type, market_sources.active, market_sources.created_by)
  is distinct from (excluded.source_type, excluded.active, excluded.created_by);

create temporary table phase4a2_changed_snapshots (
  id uuid primary key,
  legacy_id text not null,
  asset_id uuid not null,
  low numeric(20, 2),
  median numeric(20, 2) not null,
  high numeric(20, 2),
  sample_count integer,
  confidence numeric(6, 5),
  inserted_by_run boolean not null
) on commit drop;

with source_snapshots (
  id, legacy_id, asset_legacy_id, low, median, high,
  sample_count, confidence, methodology_version, valued_at, created_at
) as (values
${values}
),
upserted as (
  insert into public.valuation_snapshots (
    id, portfolio_id, asset_id, market_source_id,
    low, p25, median, p75, high, sample_count, confidence,
    methodology_version, valued_at, created_at, created_by, legacy_id
  )
  select
    source_snapshot.id,
    ${sqlUuid(PORTFOLIO_ID)},
    asset.id,
    market_source.id,
    source_snapshot.low,
    null,
    source_snapshot.median,
    null,
    source_snapshot.high,
    source_snapshot.sample_count,
    source_snapshot.confidence,
    source_snapshot.methodology_version,
    source_snapshot.valued_at,
    source_snapshot.created_at,
    ${sqlUuid(OWNER_ID)},
    source_snapshot.legacy_id
  from source_snapshots source_snapshot
  join public.assets asset
    on asset.portfolio_id = ${sqlUuid(PORTFOLIO_ID)}
    and asset.legacy_id = source_snapshot.asset_legacy_id
  join public.market_sources market_source
    on market_source.portfolio_id = ${sqlUuid(PORTFOLIO_ID)}
    and market_source.name = '闲鱼'
  on conflict on constraint valuation_snapshots_portfolio_legacy_key do update set
    asset_id = excluded.asset_id,
    market_source_id = excluded.market_source_id,
    low = excluded.low,
    p25 = excluded.p25,
    median = excluded.median,
    p75 = excluded.p75,
    high = excluded.high,
    sample_count = excluded.sample_count,
    confidence = excluded.confidence,
    methodology_version = excluded.methodology_version,
    valued_at = excluded.valued_at,
    created_at = excluded.created_at,
    created_by = excluded.created_by
  where (
    valuation_snapshots.asset_id,
    valuation_snapshots.market_source_id,
    valuation_snapshots.low,
    valuation_snapshots.p25,
    valuation_snapshots.median,
    valuation_snapshots.p75,
    valuation_snapshots.high,
    valuation_snapshots.sample_count,
    valuation_snapshots.confidence,
    valuation_snapshots.methodology_version,
    valuation_snapshots.valued_at,
    valuation_snapshots.created_at,
    valuation_snapshots.created_by
  ) is distinct from (
    excluded.asset_id,
    excluded.market_source_id,
    excluded.low,
    excluded.p25,
    excluded.median,
    excluded.p75,
    excluded.high,
    excluded.sample_count,
    excluded.confidence,
    excluded.methodology_version,
    excluded.valued_at,
    excluded.created_at,
    excluded.created_by
  )
  returning id, legacy_id, asset_id, low, median, high, sample_count, confidence
)
insert into phase4a2_changed_snapshots
select
  upserted.*,
  not exists (select 1 from phase4a2_existing_snapshots existing where existing.legacy_id = upserted.legacy_id)
from upserted;

insert into public.audit_logs (
  id, portfolio_id, actor_id, action, entity_type, entity_id,
  before_data, after_data, occurred_at
) values (
  ${sqlUuid(migrationRunId)},
  ${sqlUuid(PORTFOLIO_ID)},
  ${sqlUuid(OWNER_ID)},
  'phase4a2_valuation_import',
  'migration_run',
  ${sqlUuid(migrationRunId)},
  jsonb_build_object(
    'market_sources_before', current_setting('lensfolio.phase4a2_sources_before')::integer,
    'valuation_snapshots_before', current_setting('lensfolio.phase4a2_snapshots_before')::integer
  ),
  jsonb_build_object(
    'phase', '4A-2',
    'migration_run_id', ${sqlText(migrationRunId)},
    'imported_at', ${sqlText(importedAt)},
    'source_backup', ${sqlText(EXPECTED_BACKUP_NAME)},
    'source_manifest_sha256', ${sqlText(manifestSha256)},
    'valuation_jsonl_sha256', ${sqlText(valuationJsonlSha256)},
    'currency', 'CNY',
    'market_source_id', (select id from public.market_sources where portfolio_id = ${sqlUuid(PORTFOLIO_ID)} and name = '闲鱼'),
    'market_source_created', current_setting('lensfolio.phase4a2_sources_before')::integer = 0,
    'changed_count', (select count(*) from phase4a2_changed_snapshots),
    'inserted_count', (select count(*) from phase4a2_changed_snapshots where inserted_by_run),
    'inserted_snapshots', (
      select coalesce(jsonb_agg(jsonb_build_object(
        'id', id,
        'legacy_id', legacy_id,
        'asset_id', asset_id,
        'low', low,
        'median', median,
        'high', high,
        'sample_count', sample_count,
        'confidence', confidence
      ) order by legacy_id), '[]'::jsonb)
      from phase4a2_changed_snapshots
      where inserted_by_run
    )
  ),
  ${sqlTimestamp(importedAt)}
);

do $postflight$
begin
  if (select count(*) from public.market_sources) <> 1
    or (select count(*) from public.market_sources where portfolio_id = ${sqlUuid(PORTFOLIO_ID)} and name = '闲鱼' and source_type = 'xianyu') <> 1
    or (select count(*) from public.valuation_snapshots) <> 5
    or (select count(*) from public.valuation_snapshots where sample_count is null) <> 5
    or (select count(*) from public.valuation_snapshots where p25 is null and p75 is null) <> 5
    or (select count(distinct legacy_id) from public.valuation_snapshots) <> 5
    or abs((select sum(median) from public.valuation_snapshots) - 17250::numeric) > ${AMOUNT_TOLERANCE}::numeric
    or exists (select 1 from public.valuation_snapshots where low > median or median > high)
    or exists (
      select 1
      from public.valuation_snapshots snapshot
      join public.assets asset on asset.id = snapshot.asset_id
      join public.market_sources source on source.id = snapshot.market_source_id
      where snapshot.portfolio_id <> asset.portfolio_id
        or snapshot.portfolio_id <> source.portfolio_id
        or snapshot.methodology_version <> ${sqlText(METHODOLOGY_VERSION)}
        or snapshot.confidence <> 0.5
    )
    or exists (
      with expected_snapshot (
        id, legacy_id, asset_legacy_id, low, median, high,
        sample_count, confidence, methodology_version, valued_at, created_at
      ) as (values
${values}
      )
      select 1
      from expected_snapshot expected
      left join public.valuation_snapshots snapshot
        on snapshot.portfolio_id = ${sqlUuid(PORTFOLIO_ID)}
        and snapshot.legacy_id = expected.legacy_id
      left join public.assets asset on asset.id = snapshot.asset_id
      left join public.market_sources source on source.id = snapshot.market_source_id
      where snapshot.id is null
        or asset.legacy_id is distinct from expected.asset_legacy_id
        or source.name is distinct from '闲鱼'
        or source.source_type is distinct from 'xianyu'
        or (
          snapshot.low,
          snapshot.p25,
          snapshot.median,
          snapshot.p75,
          snapshot.high,
          snapshot.sample_count,
          snapshot.confidence,
          snapshot.methodology_version,
          snapshot.valued_at,
          snapshot.created_at
        ) is distinct from (
          expected.low,
          null::numeric,
          expected.median,
          null::numeric,
          expected.high,
          expected.sample_count,
          expected.confidence,
          expected.methodology_version,
          expected.valued_at,
          expected.created_at
        )
    )
    or (select count(*) from public.market_listings) <> 0
    or (select count(*) from public.cost_entries) <> 10
    or (select count(*) from public.sales) <> 0
  then
    raise exception 'Phase 4A-2 postflight verification failed';
  end if;
end;
$postflight$;

commit;

select json_build_object(
  'migration_run_id', ${sqlUuid(migrationRunId)},
  'market_source_id', (select id from public.market_sources where portfolio_id = ${sqlUuid(PORTFOLIO_ID)} and name = '闲鱼'),
  'market_source_created', (select (after_data->>'market_source_created')::boolean from public.audit_logs where id = ${sqlUuid(migrationRunId)}),
  'valuation_snapshots_before', (select (before_data->>'valuation_snapshots_before')::integer from public.audit_logs where id = ${sqlUuid(migrationRunId)}),
  'changed_count', (select (after_data->>'changed_count')::integer from public.audit_logs where id = ${sqlUuid(migrationRunId)}),
  'inserted_count', (select (after_data->>'inserted_count')::integer from public.audit_logs where id = ${sqlUuid(migrationRunId)}),
  'valuation_snapshots_after', (select count(*) from public.valuation_snapshots),
  'audit_log_id', (select id from public.audit_logs where id = ${sqlUuid(migrationRunId)})
) as phase4a2_import;`;
}

function buildVerificationSql(plan) {
  const legacyIds = sqlTextArray(plan.snapshots.map(({ legacyId }) => legacyId));
  return `with ledger_all_costs as (
  select asset_id, sum(amount_cny) as all_cost_cny
  from public.cost_entries
  group by asset_id
),
snapshot_rows as (
  select
    snapshot.id,
    snapshot.legacy_id,
    asset.legacy_id as asset_legacy_id,
    source.name as source_name,
    source.source_type,
    snapshot.low,
    snapshot.p25,
    snapshot.median,
    snapshot.p75,
    snapshot.high,
    snapshot.sample_count,
    snapshot.confidence,
    snapshot.methodology_version,
    snapshot.valued_at,
    snapshot.created_at
  from public.valuation_snapshots snapshot
  join public.assets asset on asset.id = snapshot.asset_id
  left join public.market_sources source on source.id = snapshot.market_source_id
)
select json_build_object(
  'counts', json_build_object(
    'assets', (select count(*) from public.assets),
    'cost_entries', (select count(*) from public.cost_entries),
    'market_sources', (select count(*) from public.market_sources),
    'market_listings', (select count(*) from public.market_listings),
    'valuation_snapshots', (select count(*) from public.valuation_snapshots),
    'sales', (select count(*) from public.sales)
  ),
  'market_source', (
    select json_build_object('id', id, 'name', name, 'source_type', source_type, 'source_url', source_url)
    from public.market_sources
    where portfolio_id = ${sqlUuid(PORTFOLIO_ID)} and name = '闲鱼'
  ),
  'snapshots', (select coalesce(json_agg(row_to_json(snapshot_rows) order by legacy_id), '[]'::json) from snapshot_rows),
  'duplicate_legacy_count', (
    select count(*) from (select portfolio_id, legacy_id from public.valuation_snapshots group by portfolio_id, legacy_id having count(*) > 1) duplicates
  ),
  'unexpected_legacy_count', (
    select count(*) from public.valuation_snapshots
    where portfolio_id <> ${sqlUuid(PORTFOLIO_ID)} or legacy_id is null or legacy_id <> all (${legacyIds})
  ),
  'orphan_count', (
    select count(*)
    from public.valuation_snapshots snapshot
    left join public.assets asset on asset.id = snapshot.asset_id and asset.portfolio_id = snapshot.portfolio_id
    left join public.market_sources source on source.id = snapshot.market_source_id and source.portfolio_id = snapshot.portfolio_id
    where asset.id is null or source.id is null
  ),
  'invalid_order_count', (select count(*) from public.valuation_snapshots where low > median or median > high),
  'null_sample_count', (select count(*) from public.valuation_snapshots where sample_count is null),
  'median_total_cny', (select coalesce(sum(median), 0) from public.valuation_snapshots),
  'cost_totals_cny', json_build_object(
    'all_entries', (select sum(amount_cny) from public.cost_entries),
    'posted', (select sum(amount_cny) from public.cost_entries where entry_status = 'posted')
  ),
  'asset_financials', (
    select coalesce(json_agg(row_to_json(financial_row) order by financial_row.legacy_id), '[]'::json)
    from (
      select
        asset.legacy_id,
        ledger.all_cost_cny,
        financial.total_carrying_cost_cny,
        financial.current_valuation_cny,
        financial.unrealized_profit_cny,
        financial.investment_roi,
        financial.realized_profit_cny,
        financial.realized_roi
      from public.asset_financials financial
      join public.assets asset on asset.id = financial.asset_id
      left join ledger_all_costs ledger on ledger.asset_id = asset.id
    ) financial_row
  ),
  'portfolio_metrics', (
    select json_build_object(
      'total_carrying_cost_cny', total_carrying_cost_cny,
      'current_valuation_cny', current_valuation_cny,
      'unrealized_profit_cny', unrealized_profit_cny,
      'investment_roi', investment_roi,
      'realized_profit_cny', realized_profit_cny,
      'realized_roi', realized_roi
    )
    from public.portfolio_metrics
    where portfolio_id = ${sqlUuid(PORTFOLIO_ID)}
  ),
  'import_audit_count', (select count(*) from public.audit_logs where action = 'phase4a2_valuation_import')
) as phase4a2_verification;`;
}

function buildRollbackSql({ targetMigrationRunId, rollbackRunId, rolledBackAt }) {
  const targetFilter = targetMigrationRunId
    ? `and id = ${sqlUuid(targetMigrationRunId)}`
    : "and coalesce((after_data->>'inserted_count')::integer, 0) > 0";

  return `begin;
set local lock_timeout = '10s';

create temporary table phase4a2_rollback_run (
  import_run_id uuid primary key,
  market_source_id uuid not null,
  market_source_created boolean not null,
  inserted_snapshots jsonb not null
) on commit drop;

insert into phase4a2_rollback_run
select
  id,
  (after_data->>'market_source_id')::uuid,
  (after_data->>'market_source_created')::boolean,
  after_data->'inserted_snapshots'
from public.audit_logs
where action = 'phase4a2_valuation_import'
  ${targetFilter}
order by occurred_at desc
limit 1;

create temporary table phase4a2_rollback_targets (
  id uuid primary key,
  legacy_id text not null,
  asset_id uuid not null,
  low numeric(20, 2),
  median numeric(20, 2) not null,
  high numeric(20, 2),
  sample_count integer,
  confidence numeric(6, 5)
) on commit drop;

insert into phase4a2_rollback_targets
select target.*
from phase4a2_rollback_run run
cross join lateral jsonb_to_recordset(run.inserted_snapshots) as target(
  id uuid,
  legacy_id text,
  asset_id uuid,
  low numeric,
  median numeric,
  high numeric,
  sample_count integer,
  confidence numeric
);

do $rollback_preflight$
begin
  if (select count(*) from phase4a2_rollback_run) <> 1
    or (select count(*) from phase4a2_rollback_targets) <> 5
  then
    raise exception 'No eligible Phase 4A-2 migration run was found';
  end if;

  if (select count(*) from public.market_listings) <> 0
    or (select count(*) from public.sales) <> 0
    or (select count(*) from public.cost_entries) <> 10
  then
    raise exception 'Rollback is blocked by downstream data or changed ledger baseline';
  end if;

  if (select count(*) from public.valuation_snapshots) <> (select count(*) from phase4a2_rollback_targets)
    or exists (
      select 1
      from phase4a2_rollback_targets target
      left join public.valuation_snapshots snapshot
        on snapshot.id = target.id
        and snapshot.legacy_id = target.legacy_id
        and snapshot.asset_id = target.asset_id
        and snapshot.low = target.low
        and snapshot.median = target.median
        and snapshot.high = target.high
        and snapshot.sample_count is not distinct from target.sample_count
        and snapshot.confidence is not distinct from target.confidence
      where snapshot.id is null
    )
  then
    raise exception 'Valuation rows no longer match the selected migration run';
  end if;
end;
$rollback_preflight$;

with deleted as (
  delete from public.valuation_snapshots snapshot
  using phase4a2_rollback_targets target
  where snapshot.id = target.id
    and snapshot.legacy_id = target.legacy_id
  returning snapshot.id
)
select set_config('lensfolio.phase4a2_deleted_count', count(*)::text, true)
from deleted;

delete from public.market_sources source
using phase4a2_rollback_run run
where run.market_source_created
  and source.id = run.market_source_id
  and not exists (select 1 from public.valuation_snapshots snapshot where snapshot.market_source_id = source.id)
  and not exists (select 1 from public.market_listings listing where listing.market_source_id = source.id);

insert into public.audit_logs (
  id, portfolio_id, actor_id, action, entity_type, entity_id,
  before_data, after_data, occurred_at
) values (
  ${sqlUuid(rollbackRunId)},
  ${sqlUuid(PORTFOLIO_ID)},
  ${sqlUuid(OWNER_ID)},
  'phase4a2_valuation_rollback',
  'migration_run',
  ${sqlUuid(rollbackRunId)},
  jsonb_build_object(
    'target_migration_run_id', (select import_run_id from phase4a2_rollback_run),
    'target_snapshot_ids', (select jsonb_agg(id order by id) from phase4a2_rollback_targets)
  ),
  jsonb_build_object(
    'deleted_count', current_setting('lensfolio.phase4a2_deleted_count')::integer,
    'valuation_snapshots_after', (select count(*) from public.valuation_snapshots),
    'market_sources_after', (select count(*) from public.market_sources)
  ),
  ${sqlTimestamp(rolledBackAt)}
);

do $rollback_postflight$
begin
  if current_setting('lensfolio.phase4a2_deleted_count')::integer <> 5
    or (select count(*) from public.valuation_snapshots) <> 0
    or (select count(*) from public.market_listings) <> 0
    or (select count(*) from public.cost_entries) <> 10
    or (select count(*) from public.sales) <> 0
  then
    raise exception 'Phase 4A-2 rollback postflight verification failed';
  end if;
end;
$rollback_postflight$;

commit;

select json_build_object(
  'rollback_run_id', ${sqlUuid(rollbackRunId)},
  'target_migration_run_id', (select (before_data->>'target_migration_run_id')::uuid from public.audit_logs where id = ${sqlUuid(rollbackRunId)}),
  'deleted_count', (select (after_data->>'deleted_count')::integer from public.audit_logs where id = ${sqlUuid(rollbackRunId)}),
  'valuation_snapshots_after', (select count(*) from public.valuation_snapshots),
  'market_sources_after', (select count(*) from public.market_sources)
) as phase4a2_rollback;`;
}

function assertVerification(result, plan, requireImported) {
  const verification = result?.rows?.[0]?.phase4a2_verification;
  if (!verification || typeof verification !== "object") {
    throw new Error("Supabase response is missing phase4a2_verification");
  }
  const expectedBaseCounts = { assets: 5, cost_entries: 10, market_listings: 0, sales: 0 };
  for (const [key, expected] of Object.entries(expectedBaseCounts)) {
    assertEqual(Number(verification.counts[key]), expected, key);
  }
  assertAmount(verification.cost_totals_cny.all_entries, 14061, "all ledger entries");
  assertAmount(verification.cost_totals_cny.posted, 13831, "posted carrying cost");

  if (!requireImported) return verification;

  assertEqual(Number(verification.counts.market_sources), 1, "market_sources");
  assertEqual(Number(verification.counts.valuation_snapshots), 5, "valuation_snapshots");
  assertEqual(verification.market_source.name, "闲鱼", "market source name");
  assertEqual(verification.market_source.source_type, "xianyu", "market source type");
  assertEqual(verification.market_source.source_url, null, "market source URL");
  assertEqual(Number(verification.duplicate_legacy_count), 0, "duplicate valuation legacy IDs");
  assertEqual(Number(verification.unexpected_legacy_count), 0, "unexpected valuation legacy IDs");
  assertEqual(Number(verification.orphan_count), 0, "orphan valuations");
  assertEqual(Number(verification.invalid_order_count), 0, "invalid valuation ranges");
  assertEqual(Number(verification.null_sample_count), 5, "NULL sample counts");
  assertAmount(verification.median_total_cny, 17250, "valuation median total");

  const expectedSnapshots = new Map(plan.snapshots.map((snapshot) => [snapshot.legacyId, snapshot]));
  for (const actual of verification.snapshots) {
    const expected = expectedSnapshots.get(actual.legacy_id);
    if (!expected) throw new Error(`Unexpected snapshot ${actual.legacy_id}`);
    assertEqual(actual.id, expected.id, `${actual.legacy_id}.id`);
    assertEqual(actual.asset_legacy_id, expected.assetLegacyId, `${actual.legacy_id}.asset`);
    assertEqual(actual.source_name, "闲鱼", `${actual.legacy_id}.source_name`);
    assertEqual(actual.source_type, "xianyu", `${actual.legacy_id}.source_type`);
    assertAmount(actual.low, expected.low, `${actual.legacy_id}.low`);
    assertEqual(actual.p25, null, `${actual.legacy_id}.p25`);
    assertAmount(actual.median, expected.median, `${actual.legacy_id}.median`);
    assertEqual(actual.p75, null, `${actual.legacy_id}.p75`);
    assertAmount(actual.high, expected.high, `${actual.legacy_id}.high`);
    assertEqual(actual.sample_count, null, `${actual.legacy_id}.sample_count`);
    assertAmount(actual.confidence, expected.confidence, `${actual.legacy_id}.confidence`);
    assertEqual(actual.methodology_version, METHODOLOGY_VERSION, `${actual.legacy_id}.methodology`);
    assertSameInstant(actual.valued_at, expected.valuedAt, `${actual.legacy_id}.valued_at`);
    assertSameInstant(actual.created_at, expected.createdAt, `${actual.legacy_id}.created_at`);
  }
  assertEqual(verification.snapshots.length, 5, "snapshot mapping count");

  const financials = new Map(verification.asset_financials.map((row) => [row.legacy_id, row]));
  for (const [legacyId, expected] of EXPECTED_ASSETS) {
    const actual = financials.get(legacyId);
    if (!actual) throw new Error(`Missing asset financial row: ${legacyId}`);
    assertAmount(actual.all_cost_cny, expected.allCost, `${legacyId} all cost`);
    assertAmount(actual.total_carrying_cost_cny, expected.postedCost, `${legacyId} posted cost`);
    assertAmount(actual.current_valuation_cny, expected.valuation, `${legacyId} valuation`);
    assertAmount(actual.unrealized_profit_cny, expected.profit, `${legacyId} unrealized profit`);
    assertAmount(actual.investment_roi, expected.profit / expected.postedCost, `${legacyId} ROI`);
    assertEqual(actual.realized_profit_cny, null, `${legacyId} realized profit`);
    assertEqual(actual.realized_roi, null, `${legacyId} realized ROI`);
  }

  assertAmount(verification.portfolio_metrics.total_carrying_cost_cny, 13831, "portfolio carrying cost");
  assertAmount(verification.portfolio_metrics.current_valuation_cny, 17250, "portfolio valuation");
  assertAmount(verification.portfolio_metrics.unrealized_profit_cny, 3419, "portfolio unrealized profit");
  assertAmount(verification.portfolio_metrics.investment_roi, 3419 / 13831, "portfolio ROI");
  assertEqual(verification.portfolio_metrics.realized_profit_cny, null, "portfolio realized profit");
  assertEqual(verification.portfolio_metrics.realized_roi, null, "portfolio realized ROI");
  return verification;
}

function snapshotValues(snapshots) {
  return snapshots.map((snapshot) => `(
    ${sqlUuid(snapshot.id)},
    ${sqlText(snapshot.legacyId)},
    ${sqlText(snapshot.assetLegacyId)},
    ${sqlNumber(snapshot.low)}::numeric,
    ${sqlNumber(snapshot.median)}::numeric,
    ${sqlNumber(snapshot.high)}::numeric,
    null::integer,
    ${sqlNumber(snapshot.confidence)}::numeric,
    ${sqlText(snapshot.methodologyVersion)},
    ${sqlTimestamp(snapshot.valuedAt)},
    ${sqlTimestamp(snapshot.createdAt)}
  )`).join(",\n");
}

function runRemoteSql(sql) {
  const temporaryDirectory = mkdtempSync(join(tmpdir(), "lensfolio-phase4a2-"));
  const sqlPath = join(temporaryDirectory, "query.sql");
  try {
    writeFileSync(sqlPath, sql, { encoding: "utf8", mode: 0o600 });
    for (let attempt = 1; attempt <= 2; attempt += 1) {
      const result = spawnSync(
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
      if (result.error) {
        if (result.error.code === "ETIMEDOUT" && attempt === 1) continue;
        throw result.error;
      }
      if (result.status === 0) return parseCliJson(result.stdout);
      const output = `${result.stderr || ""}\n${result.stdout || ""}`;
      const transientLoginFailure = output.includes("password authentication failed for user \"cli_login_postgres\"");
      if (!transientLoginFailure || attempt === 2) {
        throw new Error(`Supabase CLI failed with status ${result.status}: ${output.trim()}`);
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

function validateChecksumFile(directory, checksumsPath) {
  const lines = readFileSync(checksumsPath, "utf8").split(/\r?\n/).filter(Boolean);
  if (lines.length === 0) throw new Error("checksums.sha256 is empty");
  for (const line of lines) {
    const match = line.match(/^([a-f0-9]{64}) {2}(.+)$/i);
    if (!match) throw new Error(`Invalid checksum line: ${line}`);
    const [, expected, relativePath] = match;
    const filePath = join(directory, relativePath);
    if (!existsSync(filePath)) throw new Error(`Checksum target not found: ${relativePath}`);
    const actual = sha256(filePath);
    if (actual !== expected.toLowerCase()) {
      throw new Error(`Checksum mismatch for ${relativePath}: expected ${expected}, got ${actual}`);
    }
  }
}

function parseJsonLines(filePath) {
  return readFileSync(filePath, "utf8")
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line, index) => {
      try {
        return JSON.parse(line);
      } catch {
        throw new Error(`Invalid JSONL at ${filePath}:${index + 1}`);
      }
    });
}

function hongKongDateToUtc(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) throw new Error(`Invalid legacy valuation date: ${value}`);
  return requiredInstant(`${value}T00:00:00+08:00`, "legacy valuation date");
}

function hongKongTimestampToUtc(value) {
  if (!/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(value)) {
    throw new Error(`Invalid legacy Hong Kong timestamp: ${value}`);
  }
  return requiredInstant(`${value.replace(" ", "T")}+08:00`, "legacy created_at");
}

function requiredInstant(value, label) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) throw new Error(`${label} is invalid: ${value}`);
  return date.toISOString();
}

function sha256(filePath) {
  return createHash("sha256").update(readFileSync(filePath)).digest("hex");
}

function uuidV5(name, namespace) {
  const namespaceBytes = Buffer.from(namespace.replaceAll("-", ""), "hex");
  const digest = createHash("sha1").update(namespaceBytes).update(name, "utf8").digest();
  digest[6] = (digest[6] & 0x0f) | 0x50;
  digest[8] = (digest[8] & 0x3f) | 0x80;
  const hex = digest.subarray(0, 16).toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
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
    else if (value === "--backup" || value === "--migration-run-id") {
      const next = values[index + 1];
      if (!next || next.startsWith("--")) throw new Error(`Missing value for ${value}`);
      if (value === "--backup") parsed.backup = next;
      else {
        if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(next)) {
          throw new Error("--migration-run-id must be a UUID");
        }
        parsed.migrationRunId = next;
      }
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

function required(value, name) {
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function requiredNumber(value, label) {
  const number = Number(value);
  if (!Number.isFinite(number)) throw new Error(`${label} must be numeric`);
  return number;
}

function assertUniqueNonempty(values, label) {
  if (values.some((value) => typeof value !== "string" || !value.trim())) {
    throw new Error(`${label} contain missing values`);
  }
  if (new Set(values).size !== values.length) throw new Error(`${label} contain duplicates`);
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

function sqlTextArray(values) {
  return `array[${values.map(sqlText).join(", ")}]::text[]`;
}

function sqlNumber(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) throw new Error(`Cannot serialize non-finite SQL number: ${value}`);
  return String(number);
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

function assertSameInstant(actual, expected, label) {
  if (new Date(actual).getTime() !== new Date(expected).getTime()) {
    throw new Error(`${label}: expected ${expected}, got ${actual}`);
  }
}

function printLog(event, details) {
  console.log(JSON.stringify({ event, loggedAt: new Date().toISOString(), ...details }, null, 2));
}

function printHelp() {
  console.log(`Usage:
  node scripts/import-valuation-phase4a2.mjs --backup <backup-directory>
  node scripts/import-valuation-phase4a2.mjs --backup <backup-directory> --apply
  node scripts/import-valuation-phase4a2.mjs --backup <backup-directory> --verify
  node scripts/import-valuation-phase4a2.mjs --backup <backup-directory> --rollback --confirm-rollback [--migration-run-id <uuid>]

Default mode validates the frozen backup and prints a source-only dry-run.
Apply upserts one Xianyu source and five historical snapshots in one transaction,
records migration_run_id in audit_logs, and uses ON CONFLICT ON CONSTRAINT
valuation_snapshots_portfolio_legacy_key. Verify is read-only. Rollback deletes
only snapshot UUIDs recorded as inserted by the selected migration run and
requires explicit confirmation.`);
}
