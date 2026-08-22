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
import { basename, dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";

const EXPECTED_BACKUP_NAME = "lensfolio-d1-backup-20260821T141816Z";
const EXPECTED_MANIFEST_SHA256 = "a7bb4f87a43efb58e26292f4507b6ac401102cce34c5d4529290d467bf0142f8";
const EXPECTED_OWNER_ID = "b438f993-fbfd-49c9-963b-ff0d02ff4003";
const UUID_NAMESPACE = "4dfd41dc-fec8-4c37-814f-adf2f0916be8";
const PORTFOLIO_ID = uuidV5(`${EXPECTED_BACKUP_NAME}:portfolio`, UUID_NAMESPACE);
const PORTFOLIO_NAME = "Lensfolio Camera Capital";
const SUPABASE_CLI_VERSION = "2.115.0";

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
const ownerId = args.ownerId ?? EXPECTED_OWNER_ID;
if (ownerId !== EXPECTED_OWNER_ID) {
  throw new Error(`Owner UUID must match the confirmed Auth owner: ${EXPECTED_OWNER_ID}`);
}

const source = loadAndValidateBackup(backupDirectory);
const plan = buildAssetPlan(source.cameras);

if (args.verify) {
  const result = runRemoteSql(buildVerificationSql(plan, ownerId));
  assertVerification(result);
  printLog("verification", {
    mode: "verify",
    backup: backupDirectory,
    manifestSha256: source.manifestSha256,
    portfolioId: PORTFOLIO_ID,
    result,
  });
  process.exit(0);
}

if (args.rollback) {
  if (!args.confirmRollback) {
    throw new Error("Rollback requires --confirm-rollback. No data was changed.");
  }
  const migrationRunId = randomUUID();
  const result = runRemoteSql(buildRollbackSql(migrationRunId, ownerId));
  printLog("rollback", {
    mode: "rollback",
    migrationRunId,
    backup: backupDirectory,
    manifestSha256: source.manifestSha256,
    portfolioId: PORTFOLIO_ID,
    result,
  });
  process.exit(0);
}

if (!args.apply) {
  printLog("dry-run", {
    mode: "dry-run",
    databaseConnected: false,
    backup: backupDirectory,
    manifestSha256: source.manifestSha256,
    ownerId,
    portfolioId: PORTFOLIO_ID,
    portfolioName: PORTFOLIO_NAME,
    sourceRows: source.cameras.length,
    plannedAssets: plan.map(({ legacyId, brand, model, measuredWeightG }) => ({
      legacyId,
      brand,
      model,
      measuredWeightG,
    })),
    assetStatusEvents: 0,
  });
  process.exit(0);
}

const migrationRunId = randomUUID();
const importedAt = new Date().toISOString();
const result = runRemoteSql(buildImportSql({
  plan,
  ownerId,
  migrationRunId,
  importedAt,
  manifestSha256: source.manifestSha256,
}));

printLog("import", {
  mode: "apply",
  migrationRunId,
  importedAt,
  backup: backupDirectory,
  manifestSha256: source.manifestSha256,
  portfolioId: PORTFOLIO_ID,
  result,
});

function loadAndValidateBackup(directory) {
  if (!existsSync(directory)) throw new Error(`Backup directory not found: ${directory}`);
  if (basename(directory) !== EXPECTED_BACKUP_NAME) {
    throw new Error(`Backup directory must be exactly ${EXPECTED_BACKUP_NAME}`);
  }

  const manifestPath = join(directory, "manifest.json");
  const checksumsPath = join(directory, "checksums.sha256");
  const camerasPath = join(directory, "data", "cameras.jsonl");
  for (const filePath of [manifestPath, checksumsPath, camerasPath]) {
    if (!existsSync(filePath)) throw new Error(`Required backup file not found: ${filePath}`);
  }

  const manifestSha256 = sha256(manifestPath);
  if (manifestSha256 !== EXPECTED_MANIFEST_SHA256) {
    throw new Error(`Manifest checksum mismatch: expected ${EXPECTED_MANIFEST_SHA256}, got ${manifestSha256}`);
  }

  const checksumLines = readFileSync(checksumsPath, "utf8").trim().split("\n").filter(Boolean);
  for (const line of checksumLines) {
    const match = line.match(/^([a-f0-9]{64}) {2}(.+)$/);
    if (!match) throw new Error(`Invalid checksum line: ${line}`);
    const [, expectedHash, relativePath] = match;
    const filePath = resolve(directory, relativePath);
    if (dirname(filePath).length < directory.length || !filePath.startsWith(`${directory}/`)) {
      throw new Error(`Checksum path escapes backup directory: ${relativePath}`);
    }
    if (!existsSync(filePath)) throw new Error(`Checksummed file not found: ${relativePath}`);
    const actualHash = sha256(filePath);
    if (actualHash !== expectedHash) {
      throw new Error(`Checksum mismatch for ${relativePath}: expected ${expectedHash}, got ${actualHash}`);
    }
  }

  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  if (manifest?.tables?.cameras?.rowCount !== 5) {
    throw new Error(`Expected 5 source cameras, found ${manifest?.tables?.cameras?.rowCount ?? "unknown"}`);
  }
  if (manifest?.site?.migrationReadOnly !== true || manifest?.site?.siteVersion !== "v4") {
    throw new Error("Backup manifest is not the frozen read-only Site v4 baseline");
  }

  const cameras = parseJsonLines(camerasPath);
  if (cameras.length !== 5) throw new Error(`Expected 5 camera rows, found ${cameras.length}`);
  const legacyIds = cameras.map(({ id }) => id);
  if (new Set(legacyIds).size !== legacyIds.length || legacyIds.some((id) => !id)) {
    throw new Error("Source camera legacy IDs are missing or duplicated");
  }

  return { manifest, manifestSha256, cameras };
}

function buildAssetPlan(cameras) {
  return cameras
    .map((camera) => {
      const isBundleComponent = camera.variant === "套装内";
      return {
        legacyId: text(camera.id, "camera.id"),
        brand: text(camera.brand, `${camera.id}.brand`),
        model: [text(camera.model, `${camera.id}.model`), nullableText(camera.variant)]
          .filter(Boolean)
          .join(" "),
        serialNumber: nullableText(camera.serial_number),
        condition: nullableText(camera.condition_grade),
        operationalStatus: mapOperationalStatus(camera.lifecycle_status),
        repairStatus: mapRepairStatus(camera.repair_status),
        acquiredAt: legacyTimestamp(camera.acquired_at),
        measuredWeightG: isBundleComponent ? null : positiveIntegerOrNull(camera.weight_g),
        createdAt: legacyTimestamp(camera.created_at),
        updatedAt: legacyTimestamp(camera.updated_at),
      };
    })
    .sort((left, right) => left.legacyId.localeCompare(right.legacyId));
}

function buildImportSql({ plan, ownerId, migrationRunId, importedAt, manifestSha256 }) {
  const expectedLegacyIds = sqlTextArray(plan.map(({ legacyId }) => legacyId));
  const assetValues = plan.map((asset) => `(
    ${sqlText(PORTFOLIO_ID)}::uuid,
    ${sqlText(asset.legacyId)},
    ${sqlText(asset.brand)},
    ${sqlText(asset.model)},
    ${sqlNullableText(asset.serialNumber)},
    ${sqlNullableText(asset.condition)},
    ${sqlText(asset.operationalStatus)}::public.asset_operational_status,
    ${sqlText(asset.repairStatus)}::public.asset_repair_status,
    ${sqlText(asset.acquiredAt)}::timestamptz,
    ${asset.measuredWeightG ?? "null"},
    ${sqlText(asset.createdAt)}::timestamptz,
    ${sqlText(asset.updatedAt)}::timestamptz,
    ${sqlText(ownerId)}::uuid
  )`).join(",\n");

  const afterData = {
    phase: "3B-1",
    migrationRunId,
    importedAt,
    sourceBackup: EXPECTED_BACKUP_NAME,
    sourceManifestSha256: manifestSha256,
    expectedAssetCount: 5,
    assetStatusEventCount: 0,
  };

  return `begin;
set local lock_timeout = '10s';

do $preflight$
begin
  if (select count(*) from auth.users) <> 1
    or not exists (select 1 from auth.users where id = ${sqlText(ownerId)}::uuid)
  then
    raise exception 'Expected exactly one confirmed Auth owner';
  end if;

  if not exists (select 1 from public.profiles where id = ${sqlText(ownerId)}::uuid) then
    raise exception 'Confirmed Auth owner profile is missing';
  end if;

  if (select count(*) from public.portfolios where id <> ${sqlText(PORTFOLIO_ID)}::uuid) <> 0
    or (select count(*) from public.portfolios) > 1
  then
    raise exception 'Unexpected portfolio rows exist';
  end if;

  if exists (
    select 1 from public.assets
    where portfolio_id <> ${sqlText(PORTFOLIO_ID)}::uuid
      or legacy_id is null
      or legacy_id <> all (${expectedLegacyIds})
  ) then
    raise exception 'Unexpected asset rows exist';
  end if;

  if (select count(*) from public.asset_status_events) <> 0
    or (select count(*) from public.purchase_orders) <> 0
    or (select count(*) from public.purchase_items) <> 0
    or (select count(*) from public.shipments) <> 0
    or (select count(*) from public.shipment_items) <> 0
    or (select count(*) from public.tracking_events) <> 0
    or (select count(*) from public.tracking_sync_runs) <> 0
    or (select count(*) from public.repairs) <> 0
    or (select count(*) from public.market_sources) <> 0
    or (select count(*) from public.market_listings) <> 0
    or (select count(*) from public.valuation_snapshots) <> 0
    or (select count(*) from public.sales) <> 0
    or (select count(*) from public.cost_entries) <> 0
    or (select count(*) from public.attachments) <> 0
  then
    raise exception 'A later-phase business table is not empty';
  end if;
end;
$preflight$;

select set_config(
  'lensfolio.phase3b1_assets_before',
  (select count(*)::text from public.assets where portfolio_id = ${sqlText(PORTFOLIO_ID)}::uuid),
  true
);

insert into public.portfolios (
  id, name, base_currency, display_timezone, created_by
) values (
  ${sqlText(PORTFOLIO_ID)}::uuid,
  ${sqlText(PORTFOLIO_NAME)},
  'CNY',
  'Asia/Hong_Kong',
  ${sqlText(ownerId)}::uuid
)
on conflict (id) do update set
  name = excluded.name,
  base_currency = excluded.base_currency,
  display_timezone = excluded.display_timezone,
  created_by = excluded.created_by
where (portfolios.name, portfolios.base_currency, portfolios.display_timezone, portfolios.created_by)
  is distinct from (excluded.name, excluded.base_currency, excluded.display_timezone, excluded.created_by);

insert into public.portfolio_members (
  portfolio_id, user_id, role, created_by
) values (
  ${sqlText(PORTFOLIO_ID)}::uuid,
  ${sqlText(ownerId)}::uuid,
  'owner',
  ${sqlText(ownerId)}::uuid
)
on conflict (portfolio_id, user_id) do update set
  role = excluded.role,
  created_by = excluded.created_by
where (portfolio_members.role, portfolio_members.created_by)
  is distinct from (excluded.role, excluded.created_by);

insert into public.assets (
  portfolio_id, legacy_id, brand, model, serial_number, condition,
  operational_status, repair_status, acquired_at, measured_weight_g,
  created_at, updated_at, created_by
) values
${assetValues}
on conflict (portfolio_id, legacy_id) do update set
  brand = excluded.brand,
  model = excluded.model,
  serial_number = excluded.serial_number,
  condition = excluded.condition,
  operational_status = excluded.operational_status,
  repair_status = excluded.repair_status,
  acquired_at = excluded.acquired_at,
  measured_weight_g = excluded.measured_weight_g,
  created_by = excluded.created_by
where (
  assets.brand, assets.model, assets.serial_number, assets.condition,
  assets.operational_status, assets.repair_status, assets.acquired_at,
  assets.measured_weight_g, assets.created_by
) is distinct from (
  excluded.brand, excluded.model, excluded.serial_number, excluded.condition,
  excluded.operational_status, excluded.repair_status, excluded.acquired_at,
  excluded.measured_weight_g, excluded.created_by
);

insert into public.audit_logs (
  id, portfolio_id, actor_id, action, entity_type, entity_id,
  before_data, after_data, occurred_at
) values (
  ${sqlText(migrationRunId)}::uuid,
  ${sqlText(PORTFOLIO_ID)}::uuid,
  ${sqlText(ownerId)}::uuid,
  'phase3b1_assets_import',
  'migration_run',
  ${sqlText(migrationRunId)}::uuid,
  jsonb_build_object(
    'assets_before',
    current_setting('lensfolio.phase3b1_assets_before')::integer
  ),
  ${sqlText(JSON.stringify(afterData))}::jsonb,
  ${sqlText(importedAt)}::timestamptz
);

do $postflight$
begin
  if (select count(*) from public.portfolios where id = ${sqlText(PORTFOLIO_ID)}::uuid) <> 1
    or (select count(*) from public.portfolio_members where portfolio_id = ${sqlText(PORTFOLIO_ID)}::uuid and user_id = ${sqlText(ownerId)}::uuid and role = 'owner') <> 1
    or (select count(*) from public.assets where portfolio_id = ${sqlText(PORTFOLIO_ID)}::uuid) <> 5
    or (select count(distinct legacy_id) from public.assets where portfolio_id = ${sqlText(PORTFOLIO_ID)}::uuid) <> 5
    or (select count(*) from public.asset_status_events) <> 0
  then
    raise exception 'Phase 3B-1 postflight verification failed';
  end if;
end;
$postflight$;

commit;

${buildResultSelect(migrationRunId)};`;
}

function buildVerificationSql(plan, ownerId) {
  const expectedLegacyIds = sqlTextArray(plan.map(({ legacyId }) => legacyId));
  return `select json_build_object(
  'portfolio_id', ${sqlText(PORTFOLIO_ID)}::uuid,
  'portfolio_count', (select count(*) from public.portfolios where id = ${sqlText(PORTFOLIO_ID)}::uuid),
  'owner_member_count', (select count(*) from public.portfolio_members where portfolio_id = ${sqlText(PORTFOLIO_ID)}::uuid and user_id = ${sqlText(ownerId)}::uuid and role = 'owner'),
  'asset_count', (select count(*) from public.assets where portfolio_id = ${sqlText(PORTFOLIO_ID)}::uuid),
  'distinct_legacy_id_count', (select count(distinct legacy_id) from public.assets where portfolio_id = ${sqlText(PORTFOLIO_ID)}::uuid),
  'unexpected_legacy_id_count', (select count(*) from public.assets where portfolio_id = ${sqlText(PORTFOLIO_ID)}::uuid and legacy_id <> all (${expectedLegacyIds})),
  'orphan_asset_count', (select count(*) from public.assets asset left join public.portfolios portfolio on portfolio.id = asset.portfolio_id where portfolio.id is null),
  'asset_status_event_count', (select count(*) from public.asset_status_events),
  'purchase_order_count', (select count(*) from public.purchase_orders),
  'shipment_count', (select count(*) from public.shipments),
  'valuation_count', (select count(*) from public.valuation_snapshots),
  'sales_count', (select count(*) from public.sales),
  'cost_entry_count', (select count(*) from public.cost_entries),
  'assets', (
    select json_agg(json_build_object(
      'id', id,
      'legacy_id', legacy_id,
      'brand', brand,
      'model', model,
      'serial_number', serial_number,
      'condition', condition,
      'operational_status', operational_status,
      'repair_status', repair_status,
      'acquired_at', acquired_at,
      'measured_weight_g', measured_weight_g,
      'portfolio_id', portfolio_id
    ) order by legacy_id)
    from public.assets
    where portfolio_id = ${sqlText(PORTFOLIO_ID)}::uuid
  )
) as phase3b1_verification;`;
}

function buildRollbackSql(migrationRunId, ownerId) {
  return `begin;
set local lock_timeout = '10s';

do $rollback_preflight$
begin
  if (select count(*) from public.purchase_orders) <> 0
    or (select count(*) from public.purchase_items) <> 0
    or (select count(*) from public.shipments) <> 0
    or (select count(*) from public.shipment_items) <> 0
    or (select count(*) from public.tracking_events) <> 0
    or (select count(*) from public.repairs) <> 0
    or (select count(*) from public.valuation_snapshots) <> 0
    or (select count(*) from public.sales) <> 0
    or (select count(*) from public.cost_entries) <> 0
  then
    raise exception 'Rollback refused because later-phase data exists';
  end if;
  if not exists (select 1 from auth.users where id = ${sqlText(ownerId)}::uuid) then
    raise exception 'Confirmed Auth owner no longer exists';
  end if;
end;
$rollback_preflight$;

delete from public.portfolios where id = ${sqlText(PORTFOLIO_ID)}::uuid;

commit;

select json_build_object(
  'migration_run_id', ${sqlText(migrationRunId)}::uuid,
  'portfolio_id', ${sqlText(PORTFOLIO_ID)}::uuid,
  'portfolio_count', (select count(*) from public.portfolios where id = ${sqlText(PORTFOLIO_ID)}::uuid),
  'asset_count', (select count(*) from public.assets where portfolio_id = ${sqlText(PORTFOLIO_ID)}::uuid)
) as phase3b1_rollback;`;
}

function buildResultSelect(migrationRunId) {
  return `select json_build_object(
  'migration_run_id', ${sqlText(migrationRunId)}::uuid,
  'portfolio_id', ${sqlText(PORTFOLIO_ID)}::uuid,
  'portfolio_count', (select count(*) from public.portfolios where id = ${sqlText(PORTFOLIO_ID)}::uuid),
  'owner_member_count', (select count(*) from public.portfolio_members where portfolio_id = ${sqlText(PORTFOLIO_ID)}::uuid and role = 'owner'),
  'asset_count', (select count(*) from public.assets where portfolio_id = ${sqlText(PORTFOLIO_ID)}::uuid),
  'assets', (select json_agg(json_build_object('id', id, 'legacy_id', legacy_id) order by legacy_id) from public.assets where portfolio_id = ${sqlText(PORTFOLIO_ID)}::uuid),
  'asset_status_event_count', (select count(*) from public.asset_status_events)
) as phase3b1_import;`;
}

function runRemoteSql(sql) {
  const temporaryDirectory = mkdtempSync(join(tmpdir(), "lensfolio-phase3b1-"));
  const sqlPath = join(temporaryDirectory, "query.sql");
  try {
    writeFileSync(sqlPath, sql, { encoding: "utf8", mode: 0o600 });
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
      { cwd: process.cwd(), encoding: "utf8", stdio: "pipe" },
    );
    if (result.error) throw result.error;
    if (result.status !== 0) {
      throw new Error(`Supabase CLI failed with status ${result.status}: ${result.stderr || result.stdout}`);
    }
    return parseCliJson(result.stdout);
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

function assertVerification(result) {
  const verification = result?.rows?.[0]?.phase3b1_verification;
  if (!verification || typeof verification !== "object") {
    throw new Error("Supabase verification response is missing phase3b1_verification");
  }
  const expected = {
    portfolio_count: 1,
    owner_member_count: 1,
    asset_count: 5,
    distinct_legacy_id_count: 5,
    unexpected_legacy_id_count: 0,
    orphan_asset_count: 0,
    asset_status_event_count: 0,
    purchase_order_count: 0,
    shipment_count: 0,
    valuation_count: 0,
    sales_count: 0,
    cost_entry_count: 0,
  };
  const differences = Object.entries(expected)
    .filter(([key, value]) => Number(verification[key]) !== value)
    .map(([key, value]) => ({ key, expected: value, actual: verification[key] }));
  if (differences.length > 0) {
    throw new Error(`Phase 3B-1 verification failed: ${JSON.stringify(differences)}`);
  }
  if (!Array.isArray(verification.assets) || verification.assets.length !== 5) {
    throw new Error("Phase 3B-1 verification did not return exactly 5 assets");
  }
}

function parseJsonLines(filePath) {
  return readFileSync(filePath, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line, index) => {
      try {
        return JSON.parse(line);
      } catch {
        throw new Error(`Invalid JSONL at ${filePath}:${index + 1}`);
      }
    });
}

function mapOperationalStatus(value) {
  const mapping = new Map([
    ["运输中", "in_transit"],
    ["待入库", "in_storage"],
    ["持有中", "in_storage"],
    ["维修中", "repair"],
    ["待出售", "ready_for_sale"],
    ["已上架", "listed"],
    ["已出售", "sold"],
  ]);
  const mapped = mapping.get(value);
  if (!mapped) throw new Error(`Unsupported lifecycle_status: ${value}`);
  return mapped;
}

function mapRepairStatus(value) {
  const mapping = new Map([
    ["未检测", "not_inspected"],
    ["正常", "normal"],
    ["需维修", "needs_repair"],
    ["维修中", "in_repair"],
    ["已维修", "repaired"],
  ]);
  const mapped = mapping.get(value);
  if (!mapped) throw new Error(`Unsupported repair_status: ${value}`);
  return mapped;
}

function legacyTimestamp(value) {
  const stringValue = text(value, "timestamp");
  if (/([zZ]|[+-]\d\d:\d\d)$/.test(stringValue)) return stringValue;
  return `${stringValue.replace(" ", "T")}+08:00`;
}

function positiveIntegerOrNull(value) {
  if (value === null || value === undefined || value === "") return null;
  if (!Number.isInteger(value) || value <= 0) throw new Error(`Invalid measured weight: ${value}`);
  return value;
}

function text(value, name) {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${name} must be a non-empty string`);
  return value.trim();
}

function nullableText(value) {
  if (value === null || value === undefined) return null;
  const result = String(value).trim();
  return result || null;
}

function sqlText(value) {
  return `'${String(value).replaceAll("'", "''")}'`;
}

function sqlNullableText(value) {
  return value === null ? "null" : sqlText(value);
}

function sqlTextArray(values) {
  return `array[${values.map(sqlText).join(", ")}]::text[]`;
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
    else if (value === "--backup" || value === "--owner-id") {
      const next = values[index + 1];
      if (!next || next.startsWith("--")) throw new Error(`Missing value for ${value}`);
      if (value === "--backup") parsed.backup = next;
      else parsed.ownerId = next;
      index += 1;
    } else {
      throw new Error(`Unknown argument: ${value}`);
    }
  }
  const modes = [parsed.apply, parsed.verify, parsed.rollback].filter(Boolean).length;
  if (modes > 1) throw new Error("Choose only one of --apply, --verify, or --rollback");
  return parsed;
}

function required(value, name) {
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function printLog(event, details) {
  console.log(JSON.stringify({ event, loggedAt: new Date().toISOString(), ...details }, null, 2));
}

function printHelp() {
  console.log(`Usage:
  node scripts/import-assets-phase3b1.mjs --backup <backup-directory>
  node scripts/import-assets-phase3b1.mjs --backup <backup-directory> --apply
  node scripts/import-assets-phase3b1.mjs --backup <backup-directory> --verify
  node scripts/import-assets-phase3b1.mjs --backup <backup-directory> --rollback --confirm-rollback

The default mode validates the frozen backup and prints a dry-run plan without
connecting to Supabase. Apply runs one atomic transaction, records an audit log
with migration_run_id, and upserts assets by (portfolio_id, legacy_id).
Rollback refuses to run if later-phase data exists and never deletes auth.users
or profiles.`);
}
