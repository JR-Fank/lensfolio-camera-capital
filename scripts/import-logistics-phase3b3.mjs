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
const SUPABASE_CLI_VERSION = "2.115.0";
const EXPECTED_ACTUAL_CNY = 221;
const EXPECTED_BUDGET_CNY = 230;
const EXPECTED_LOGISTICS_CNY = 451;
const AMOUNT_TOLERANCE = 0.01;
const RATIO_TOLERANCE = 0.000000001;

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
const plan = buildLogisticsPlan(source);

if (args.verify) {
  const result = runRemoteSql(buildVerificationSql(plan, ownerId));
  const verification = assertVerification(result, plan);
  printLog("verification", {
    mode: "verify",
    backup: backupDirectory,
    manifestSha256: source.manifestSha256,
    portfolioId: PORTFOLIO_ID,
    result: verification,
  });
  process.exit(0);
}

if (args.rollback) {
  if (!args.confirmRollback) {
    throw new Error("Rollback requires --confirm-rollback. No data was changed.");
  }
  const migrationRunId = randomUUID();
  const rolledBackAt = new Date().toISOString();
  const result = runRemoteSql(buildRollbackSql({
    plan,
    ownerId,
    migrationRunId,
    rolledBackAt,
    manifestSha256: source.manifestSha256,
  }));
  printLog("rollback", {
    mode: "rollback",
    migrationRunId,
    rolledBackAt,
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
    sourceRows: {
      shipments: source.logisticsOrders.length,
      shipmentItems: source.logisticsItems.length,
      trackingEvents: source.logisticsEvents.length,
      trackingSyncRuns: 0,
    },
    totalsCny: plan.totals,
    shipments: plan.shipments.map(dryRunShipment),
    shipmentItems: plan.items.map(dryRunItem),
    trackingEvents: plan.events.map(dryRunEvent),
    downstreamTablesWritten: [],
  });
  process.exit(0);
}

const migrationRunId = randomUUID();
const importedAt = new Date().toISOString();
const importResult = runRemoteSql(buildImportSql({
  plan,
  ownerId,
  migrationRunId,
  importedAt,
  manifestSha256: source.manifestSha256,
}));
const verificationResult = runRemoteSql(buildVerificationSql(plan, ownerId));
const verification = assertVerification(verificationResult, plan);

printLog("import", {
  mode: "apply",
  migrationRunId,
  importedAt,
  backup: backupDirectory,
  manifestSha256: source.manifestSha256,
  portfolioId: PORTFOLIO_ID,
  importResult,
  verification,
});

function loadAndValidateBackup(directory) {
  if (!existsSync(directory)) throw new Error(`Backup directory not found: ${directory}`);
  if (basename(directory) !== EXPECTED_BACKUP_NAME) {
    throw new Error(`Backup directory must be exactly ${EXPECTED_BACKUP_NAME}`);
  }

  const manifestPath = join(directory, "manifest.json");
  const checksumsPath = join(directory, "checksums.sha256");
  const camerasPath = join(directory, "data", "cameras.jsonl");
  const logisticsOrdersPath = join(directory, "data", "logistics_orders.jsonl");
  const logisticsItemsPath = join(directory, "data", "logistics_items.jsonl");
  const logisticsEventsPath = join(directory, "data", "logistics_events.jsonl");
  for (const filePath of [
    manifestPath,
    checksumsPath,
    camerasPath,
    logisticsOrdersPath,
    logisticsItemsPath,
    logisticsEventsPath,
  ]) {
    if (!existsSync(filePath)) throw new Error(`Required backup file not found: ${filePath}`);
  }

  const manifestSha256 = sha256(manifestPath);
  if (manifestSha256 !== EXPECTED_MANIFEST_SHA256) {
    throw new Error(`Manifest checksum mismatch: expected ${EXPECTED_MANIFEST_SHA256}, got ${manifestSha256}`);
  }
  validateChecksumFile(directory, checksumsPath);

  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  if (manifest?.site?.migrationReadOnly !== true
    || manifest?.site?.siteVersion !== "v4"
    || manifest?.site?.accessMode !== "owner-only") {
    throw new Error("Backup manifest is not the frozen owner-only Site v4 baseline");
  }
  if (manifest?.tables?.logistics_orders?.rowCount !== 2
    || manifest?.tables?.logistics_items?.rowCount !== 5
    || manifest?.tables?.logistics_events?.rowCount !== 7
    || Number(manifest?.financialBaseline?.logisticsActualCny) !== EXPECTED_ACTUAL_CNY
    || Number(manifest?.financialBaseline?.logisticsBudgetCny) !== EXPECTED_BUDGET_CNY
    || Number(manifest?.financialBaseline?.logisticsTotalCny) !== EXPECTED_LOGISTICS_CNY) {
    throw new Error("Backup manifest logistics baseline does not match Phase 1C");
  }

  const cameras = parseJsonLines(camerasPath);
  const logisticsOrders = parseJsonLines(logisticsOrdersPath);
  const logisticsItems = parseJsonLines(logisticsItemsPath);
  const logisticsEvents = parseJsonLines(logisticsEventsPath);
  if (cameras.length !== 5
    || logisticsOrders.length !== 2
    || logisticsItems.length !== 5
    || logisticsEvents.length !== 7) {
    throw new Error("Backup JSONL row counts do not match the frozen manifest");
  }

  assertUniqueNonempty(cameras.map(({ id }) => id), "camera legacy IDs");
  assertUniqueNonempty(logisticsOrders.map(({ id }) => id), "shipment legacy IDs");
  assertUniqueNonempty(logisticsItems.map(({ id }) => id), "shipment item legacy IDs");
  assertUniqueNonempty(logisticsEvents.map(({ id }) => id), "tracking event legacy IDs");

  const cameraIds = new Set(cameras.map(({ id }) => id));
  const shipmentIds = new Set(logisticsOrders.map(({ id }) => id));
  for (const item of logisticsItems) {
    if (!cameraIds.has(item.camera_id)) {
      throw new Error(`Logistics item ${item.id} references unknown camera ${item.camera_id}`);
    }
    if (!shipmentIds.has(item.logistics_order_id)) {
      throw new Error(`Logistics item ${item.id} references unknown shipment ${item.logistics_order_id}`);
    }
  }
  for (const event of logisticsEvents) {
    if (!shipmentIds.has(event.logistics_order_id)) {
      throw new Error(`Logistics event ${event.id} references unknown shipment ${event.logistics_order_id}`);
    }
  }

  return {
    manifest,
    manifestSha256,
    cameras,
    logisticsOrders,
    logisticsItems,
    logisticsEvents,
  };
}

function validateChecksumFile(directory, checksumsPath) {
  const lines = readFileSync(checksumsPath, "utf8").trim().split("\n").filter(Boolean);
  for (const line of lines) {
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
}

function buildLogisticsPlan(source) {
  const sourceItemsByShipment = groupBy(source.logisticsItems, ({ logistics_order_id }) => logistics_order_id);
  const shipments = source.logisticsOrders.map((sourceShipment) => {
    const legacyId = text(sourceShipment.id, "logistics_order.id");
    const sourceItems = sourceItemsByShipment.get(legacyId) ?? [];
    if (sourceItems.length === 0) throw new Error(`Shipment ${legacyId} has no source items`);

    const bareWeightG = positiveInteger(sourceShipment.bare_weight_g, `${legacyId}.bare_weight_g`);
    const itemWeightG = sum(sourceItems.map((item) => positiveInteger(item.weight_g, `${item.id}.weight_g`)));
    if (itemWeightG !== bareWeightG) {
      throw new Error(`Shipment ${legacyId} item weights do not equal the frozen bare weight`);
    }

    const shippingCostCny = nonnegativeNumber(sourceShipment.shipping_cny, `${legacyId}.shipping_cny`);
    const allocatedShippingCny = sum(sourceItems.map((item) => nonnegativeNumber(
      item.allocated_shipping_cny,
      `${item.id}.allocated_shipping_cny`,
    )));
    if (!withinTolerance(shippingCostCny, allocatedShippingCny, AMOUNT_TOLERANCE)) {
      throw new Error(`Shipment ${legacyId} allocated shipping does not equal source shipping cost`);
    }

    const isEstimated = integer(sourceShipment.is_estimated, `${legacyId}.is_estimated`) === 1;
    return {
      id: uuidV5(`${EXPECTED_BACKUP_NAME}:shipment:${legacyId}`, UUID_NAMESPACE),
      legacyId,
      batchCode: text(sourceShipment.batch_code, `${legacyId}.batch_code`),
      carrier: nullableText(sourceShipment.carrier),
      trackingNumber: nullableText(sourceShipment.tracking_number),
      origin: nullableText(sourceShipment.origin),
      destination: nullableText(sourceShipment.destination),
      shippedAt: nullableLegacyTimestamp(sourceShipment.international_shipped_at),
      deliveredAt: nullableLegacyTimestamp(sourceShipment.delivered_at),
      bareWeightG,
      weightTotalG: bareWeightG,
      chargeableWeightG: positiveInteger(
        sourceShipment.chargeable_weight_g,
        `${legacyId}.chargeable_weight_g`,
      ),
      shippingCostCny,
      actualPaidCny: isEstimated ? 0 : shippingCostCny,
      budgetCny: isEstimated ? shippingCostCny : 0,
      status: mapShipmentStatus(sourceShipment.status),
      legacyStatus: text(sourceShipment.status, `${legacyId}.status`),
      allocationMethod: mapAllocationMethod(sourceShipment.allocation_method),
      createdAt: legacyTimestamp(sourceShipment.created_at),
      updatedAt: legacyTimestamp(sourceShipment.updated_at),
      sourceMetadata: {
        shippingJpy: nonnegativeNumber(sourceShipment.shipping_jpy, `${legacyId}.shipping_jpy`),
        handlingCny: nonnegativeNumber(sourceShipment.handling_cny, `${legacyId}.handling_cny`),
        isEstimated,
        sellerShippedAt: nullableLegacyTimestamp(sourceShipment.seller_shipped_at),
        warehouseInAt: nullableLegacyTimestamp(sourceShipment.warehouse_in_at),
        internationalShippedAt: nullableLegacyTimestamp(sourceShipment.international_shipped_at),
        hongKongArrivedAt: nullableLegacyTimestamp(sourceShipment.hong_kong_arrived_at),
        estimatedArrivalAt: nullableLegacyTimestamp(sourceShipment.estimated_arrival_at),
        lastCheckedAt: nullableLegacyTimestamp(sourceShipment.last_checked_at),
        latestEvent: nullableText(sourceShipment.latest_event),
        trackingSource: nullableText(sourceShipment.tracking_source),
        trackingError: nullableText(sourceShipment.tracking_error),
        notes: nullableText(sourceShipment.notes),
      },
    };
  }).sort((left, right) => left.legacyId.localeCompare(right.legacyId));

  const shipmentByLegacyId = new Map(shipments.map((shipment) => [shipment.legacyId, shipment]));
  const items = source.logisticsItems.map((sourceItem) => {
    const legacyId = text(sourceItem.id, "logistics_item.id");
    const shipment = shipmentByLegacyId.get(text(
      sourceItem.logistics_order_id,
      `${legacyId}.logistics_order_id`,
    ));
    if (!shipment) throw new Error(`Shipment item ${legacyId} references an unmapped shipment`);
    const weightSnapshotG = positiveInteger(sourceItem.weight_g, `${legacyId}.weight_g`);
    return {
      id: uuidV5(`${EXPECTED_BACKUP_NAME}:shipment_item:${legacyId}`, UUID_NAMESPACE),
      legacyId,
      shipmentLegacyId: shipment.legacyId,
      assetLegacyId: text(sourceItem.camera_id, `${legacyId}.camera_id`),
      weightSnapshotG,
      allocationMethod: shipment.allocationMethod,
      allocationRatio: weightSnapshotG / shipment.bareWeightG,
      allocatedShippingCny: nonnegativeNumber(
        sourceItem.allocated_shipping_cny,
        `${legacyId}.allocated_shipping_cny`,
      ),
      allocationLockedAt: legacyTimestamp(sourceItem.created_at),
      allocationVersion: 1,
      createdAt: legacyTimestamp(sourceItem.created_at),
      updatedAt: legacyTimestamp(sourceItem.created_at),
    };
  }).sort((left, right) => left.legacyId.localeCompare(right.legacyId));

  const events = source.logisticsEvents.map((sourceEvent) => {
    const legacyId = text(sourceEvent.id, "logistics_event.id");
    const shipmentLegacyId = text(sourceEvent.logistics_order_id, `${legacyId}.logistics_order_id`);
    if (!shipmentByLegacyId.has(shipmentLegacyId)) {
      throw new Error(`Tracking event ${legacyId} references an unmapped shipment`);
    }
    return {
      id: uuidV5(`${EXPECTED_BACKUP_NAME}:tracking_event:${legacyId}`, UUID_NAMESPACE),
      legacyId,
      shipmentLegacyId,
      externalEventId: null,
      rawStatus: text(sourceEvent.raw_status, `${legacyId}.raw_status`),
      status: text(sourceEvent.status_label, `${legacyId}.status_label`),
      statusLabel: text(sourceEvent.status_label, `${legacyId}.status_label`),
      description: nullableText(sourceEvent.details),
      location: buildLocation(sourceEvent),
      occurredAt: legacyTimestamp(sourceEvent.occurred_at),
      recordedAt: legacyTimestamp(sourceEvent.created_at),
      sourceLocation: {
        office: nullableText(sourceEvent.office),
        country: nullableText(sourceEvent.country),
        postalCode: nullableText(sourceEvent.postal_code),
      },
    };
  }).sort((left, right) => (
    left.shipmentLegacyId.localeCompare(right.shipmentLegacyId)
      || new Date(left.occurredAt) - new Date(right.occurredAt)
      || left.legacyId.localeCompare(right.legacyId)
  ));

  for (const shipment of shipments) {
    const shipmentItems = items.filter(({ shipmentLegacyId }) => shipmentLegacyId === shipment.legacyId);
    const ratioTotal = sum(shipmentItems.map(({ allocationRatio }) => allocationRatio));
    const allocatedTotal = sum(shipmentItems.map(({ allocatedShippingCny }) => allocatedShippingCny));
    if (!withinTolerance(ratioTotal, 1, RATIO_TOLERANCE)
      || !withinTolerance(allocatedTotal, shipment.shippingCostCny, AMOUNT_TOLERANCE)) {
      throw new Error(`Shipment ${shipment.legacyId} allocation snapshot does not reconcile`);
    }
  }

  const actualCny = sum(shipments.map(({ actualPaidCny }) => actualPaidCny));
  const budgetCny = sum(shipments.map(({ budgetCny }) => budgetCny));
  const allocatedCny = sum(items.map(({ allocatedShippingCny }) => allocatedShippingCny));
  if (!withinTolerance(actualCny, EXPECTED_ACTUAL_CNY, AMOUNT_TOLERANCE)
    || !withinTolerance(budgetCny, EXPECTED_BUDGET_CNY, AMOUNT_TOLERANCE)
    || !withinTolerance(actualCny + budgetCny, EXPECTED_LOGISTICS_CNY, AMOUNT_TOLERANCE)
    || !withinTolerance(allocatedCny, EXPECTED_LOGISTICS_CNY, AMOUNT_TOLERANCE)) {
    throw new Error("Frozen logistics totals do not match CNY 221 actual + CNY 230 budget");
  }

  return {
    shipments,
    items,
    events,
    assetLegacyIds: source.cameras.map(({ id }) => text(id, "camera.id")).sort(),
    totals: {
      actualCny,
      budgetCny,
      logisticsCny: actualCny + budgetCny,
      allocatedCny,
      differenceCny: Math.abs(actualCny + budgetCny - allocatedCny),
    },
  };
}

function buildImportSql({ plan, ownerId, migrationRunId, importedAt, manifestSha256 }) {
  const shipmentLegacyIds = sqlTextArray(plan.shipments.map(({ legacyId }) => legacyId));
  const itemLegacyIds = sqlTextArray(plan.items.map(({ legacyId }) => legacyId));
  const eventLegacyIds = sqlTextArray(plan.events.map(({ legacyId }) => legacyId));
  const assetLegacyIds = sqlTextArray(plan.assetLegacyIds);
  const shipmentValues = plan.shipments.map((shipment) => `(
    ${sqlText(shipment.id)}::uuid,
    ${sqlText(PORTFOLIO_ID)}::uuid,
    ${sqlText(shipment.legacyId)},
    ${sqlNullableText(shipment.carrier)},
    ${sqlNullableText(shipment.trackingNumber)},
    ${sqlText(shipment.status)}::public.shipment_status,
    ${sqlNullableTimestamp(shipment.shippedAt)},
    ${sqlNullableTimestamp(shipment.deliveredAt)},
    ${sqlNumber(shipment.actualPaidCny)}::numeric,
    ${sqlNumber(shipment.budgetCny)}::numeric,
    ${sqlText(shipment.createdAt)}::timestamptz,
    ${sqlText(shipment.updatedAt)}::timestamptz,
    ${sqlText(ownerId)}::uuid,
    ${sqlNullableText(shipment.origin)},
    ${sqlNullableText(shipment.destination)},
    ${shipment.bareWeightG},
    ${shipment.chargeableWeightG},
    ${sqlText(shipment.legacyStatus)}
  )`).join(",\n");
  const itemValues = plan.items.map((item) => `(
    ${sqlText(item.id)}::uuid,
    ${sqlText(item.legacyId)},
    ${sqlText(item.shipmentLegacyId)},
    ${sqlText(item.assetLegacyId)},
    ${item.weightSnapshotG},
    ${sqlText(item.allocationMethod)}::public.allocation_method,
    ${sqlNumber(item.allocationRatio)}::numeric,
    ${sqlNumber(item.allocatedShippingCny)}::numeric,
    ${sqlText(item.allocationLockedAt)}::timestamptz,
    ${item.allocationVersion},
    ${sqlText(item.createdAt)}::timestamptz,
    ${sqlText(item.updatedAt)}::timestamptz
  )`).join(",\n");
  const eventValues = plan.events.map((event) => `(
    ${sqlText(event.id)}::uuid,
    ${sqlText(event.legacyId)},
    ${sqlText(event.shipmentLegacyId)},
    ${sqlNullableText(event.externalEventId)},
    ${sqlText(event.status)},
    ${sqlNullableText(event.rawStatus)},
    ${sqlNullableText(event.description)},
    ${sqlNullableText(event.location)},
    ${sqlText(event.occurredAt)}::timestamptz,
    ${sqlText(event.recordedAt)}::timestamptz
  )`).join(",\n");
  const auditAfterData = {
    phase: "3B-3",
    migrationRunId,
    importedAt,
    sourceBackup: EXPECTED_BACKUP_NAME,
    sourceManifestSha256: manifestSha256,
    counts: { shipments: 2, shipmentItems: 5, trackingEvents: 7, trackingSyncRuns: 0 },
    totalsCny: plan.totals,
    shipments: plan.shipments.map(({ legacyId, batchCode, sourceMetadata }) => ({
      legacyId,
      batchCode,
      sourceMetadata,
    })),
    trackingEventLocations: plan.events.map(({ legacyId, sourceLocation }) => ({
      legacyId,
      sourceLocation,
    })),
  };

  return `begin;
set local lock_timeout = '10s';

do $preflight$
begin
  if not exists (select 1 from auth.users where id = ${sqlText(ownerId)}::uuid)
    or not exists (select 1 from public.profiles where id = ${sqlText(ownerId)}::uuid)
  then
    raise exception 'Confirmed Auth owner or profile is missing';
  end if;

  if (select count(*) from public.portfolios where id = ${sqlText(PORTFOLIO_ID)}::uuid) <> 1
    or (select count(*) from public.portfolio_members where portfolio_id = ${sqlText(PORTFOLIO_ID)}::uuid and user_id = ${sqlText(ownerId)}::uuid and role = 'owner') <> 1
    or (select count(*) from public.assets where portfolio_id = ${sqlText(PORTFOLIO_ID)}::uuid) <> 5
    or (select count(*) from public.purchase_orders where portfolio_id = ${sqlText(PORTFOLIO_ID)}::uuid) <> 4
    or (select count(*) from public.purchase_items where portfolio_id = ${sqlText(PORTFOLIO_ID)}::uuid) <> 5
  then
    raise exception 'Phase 3B-2 business baseline is not intact';
  end if;

  if exists (
    select 1 from public.assets
    where portfolio_id <> ${sqlText(PORTFOLIO_ID)}::uuid
      or legacy_id is null
      or legacy_id <> all (${assetLegacyIds})
  ) then
    raise exception 'Unexpected asset rows exist';
  end if;

  if (select count(*) from public.shipments) > 2
    or exists (select 1 from public.shipments where portfolio_id <> ${sqlText(PORTFOLIO_ID)}::uuid or legacy_id is null or legacy_id <> all (${shipmentLegacyIds}))
    or (select count(*) from public.shipment_items) > 5
    or exists (select 1 from public.shipment_items where portfolio_id <> ${sqlText(PORTFOLIO_ID)}::uuid or legacy_id is null or legacy_id <> all (${itemLegacyIds}))
    or (select count(*) from public.tracking_events) > 7
    or exists (select 1 from public.tracking_events where portfolio_id <> ${sqlText(PORTFOLIO_ID)}::uuid or legacy_id is null or legacy_id <> all (${eventLegacyIds}))
  then
    raise exception 'Unexpected logistics rows exist';
  end if;

  if (select count(*) from public.tracking_sync_runs) <> 0
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

select set_config('lensfolio.phase3b3_shipments_before', (select count(*)::text from public.shipments), true);
select set_config('lensfolio.phase3b3_items_before', (select count(*)::text from public.shipment_items), true);
select set_config('lensfolio.phase3b3_events_before', (select count(*)::text from public.tracking_events), true);

insert into public.shipments (
  id, portfolio_id, legacy_id, carrier, tracking_number, status,
  shipped_at, delivered_at, actual_paid_cny, budget_cny,
  created_at, updated_at, created_by, origin, destination,
  bare_weight_g, chargeable_weight_g, legacy_status
) values
${shipmentValues}
on conflict (portfolio_id, legacy_id) do update set
  carrier = excluded.carrier,
  tracking_number = excluded.tracking_number,
  status = excluded.status,
  shipped_at = excluded.shipped_at,
  delivered_at = excluded.delivered_at,
  actual_paid_cny = excluded.actual_paid_cny,
  budget_cny = excluded.budget_cny,
  created_by = excluded.created_by,
  origin = excluded.origin,
  destination = excluded.destination,
  bare_weight_g = excluded.bare_weight_g,
  chargeable_weight_g = excluded.chargeable_weight_g,
  legacy_status = excluded.legacy_status
where (
  shipments.carrier, shipments.tracking_number, shipments.status,
  shipments.shipped_at, shipments.delivered_at, shipments.actual_paid_cny,
  shipments.budget_cny, shipments.created_by, shipments.origin,
  shipments.destination, shipments.bare_weight_g,
  shipments.chargeable_weight_g, shipments.legacy_status
) is distinct from (
  excluded.carrier, excluded.tracking_number, excluded.status,
  excluded.shipped_at, excluded.delivered_at, excluded.actual_paid_cny,
  excluded.budget_cny, excluded.created_by, excluded.origin,
  excluded.destination, excluded.bare_weight_g,
  excluded.chargeable_weight_g, excluded.legacy_status
);

with source_items (
  id, legacy_id, shipment_legacy_id, asset_legacy_id, weight_snapshot_g,
  allocation_method, allocation_ratio, allocated_shipping_cny,
  allocation_locked_at, allocation_version, created_at, updated_at
) as (values
${itemValues}
)
insert into public.shipment_items (
  id, portfolio_id, shipment_id, asset_id, weight_snapshot_g,
  allocation_method, allocation_ratio, allocated_shipping_cny,
  allocation_locked_at, allocation_version, created_at, updated_at,
  created_by, legacy_id
)
select
  source_items.id,
  ${sqlText(PORTFOLIO_ID)}::uuid,
  shipment.id,
  asset.id,
  source_items.weight_snapshot_g,
  source_items.allocation_method,
  source_items.allocation_ratio,
  source_items.allocated_shipping_cny,
  source_items.allocation_locked_at,
  source_items.allocation_version,
  source_items.created_at,
  source_items.updated_at,
  ${sqlText(ownerId)}::uuid,
  source_items.legacy_id
from source_items
join public.shipments shipment
  on shipment.portfolio_id = ${sqlText(PORTFOLIO_ID)}::uuid
  and shipment.legacy_id = source_items.shipment_legacy_id
join public.assets asset
  on asset.portfolio_id = ${sqlText(PORTFOLIO_ID)}::uuid
  and asset.legacy_id = source_items.asset_legacy_id
on conflict (portfolio_id, legacy_id) do update set
  shipment_id = excluded.shipment_id,
  asset_id = excluded.asset_id,
  weight_snapshot_g = excluded.weight_snapshot_g,
  allocation_method = excluded.allocation_method,
  allocation_ratio = excluded.allocation_ratio,
  allocated_shipping_cny = excluded.allocated_shipping_cny,
  allocation_locked_at = excluded.allocation_locked_at,
  allocation_version = excluded.allocation_version,
  created_by = excluded.created_by
where (
  shipment_items.shipment_id, shipment_items.asset_id,
  shipment_items.weight_snapshot_g, shipment_items.allocation_method,
  shipment_items.allocation_ratio, shipment_items.allocated_shipping_cny,
  shipment_items.allocation_locked_at, shipment_items.allocation_version,
  shipment_items.created_by
) is distinct from (
  excluded.shipment_id, excluded.asset_id,
  excluded.weight_snapshot_g, excluded.allocation_method,
  excluded.allocation_ratio, excluded.allocated_shipping_cny,
  excluded.allocation_locked_at, excluded.allocation_version,
  excluded.created_by
);

with source_events (
  id, legacy_id, shipment_legacy_id, external_event_id, status,
  raw_status, description, location, occurred_at, recorded_at
) as (values
${eventValues}
)
insert into public.tracking_events (
  id, portfolio_id, shipment_id, external_event_id, status, raw_status,
  description, location, occurred_at, recorded_at, created_by, legacy_id
)
select
  source_events.id,
  ${sqlText(PORTFOLIO_ID)}::uuid,
  shipment.id,
  source_events.external_event_id,
  source_events.status,
  source_events.raw_status,
  source_events.description,
  source_events.location,
  source_events.occurred_at,
  source_events.recorded_at,
  ${sqlText(ownerId)}::uuid,
  source_events.legacy_id
from source_events
join public.shipments shipment
  on shipment.portfolio_id = ${sqlText(PORTFOLIO_ID)}::uuid
  and shipment.legacy_id = source_events.shipment_legacy_id
on conflict (portfolio_id, legacy_id) do update set
  shipment_id = excluded.shipment_id,
  external_event_id = excluded.external_event_id,
  status = excluded.status,
  raw_status = excluded.raw_status,
  description = excluded.description,
  location = excluded.location,
  occurred_at = excluded.occurred_at,
  recorded_at = excluded.recorded_at,
  created_by = excluded.created_by
where (
  tracking_events.shipment_id, tracking_events.external_event_id,
  tracking_events.status, tracking_events.raw_status,
  tracking_events.description, tracking_events.location,
  tracking_events.occurred_at, tracking_events.recorded_at,
  tracking_events.created_by
) is distinct from (
  excluded.shipment_id, excluded.external_event_id,
  excluded.status, excluded.raw_status,
  excluded.description, excluded.location,
  excluded.occurred_at, excluded.recorded_at,
  excluded.created_by
);

insert into public.audit_logs (
  id, portfolio_id, actor_id, action, entity_type, entity_id,
  before_data, after_data, occurred_at
) values (
  ${sqlText(migrationRunId)}::uuid,
  ${sqlText(PORTFOLIO_ID)}::uuid,
  ${sqlText(ownerId)}::uuid,
  'phase3b3_logistics_import',
  'migration_run',
  ${sqlText(migrationRunId)}::uuid,
  jsonb_build_object(
    'shipments_before', current_setting('lensfolio.phase3b3_shipments_before')::integer,
    'shipment_items_before', current_setting('lensfolio.phase3b3_items_before')::integer,
    'tracking_events_before', current_setting('lensfolio.phase3b3_events_before')::integer
  ),
  ${sqlText(JSON.stringify(auditAfterData))}::jsonb,
  ${sqlText(importedAt)}::timestamptz
);

do $postflight$
begin
  if (select count(*) from public.shipments where portfolio_id = ${sqlText(PORTFOLIO_ID)}::uuid) <> 2
    or (select count(*) from public.shipment_items where portfolio_id = ${sqlText(PORTFOLIO_ID)}::uuid) <> 5
    or (select count(*) from public.tracking_events where portfolio_id = ${sqlText(PORTFOLIO_ID)}::uuid) <> 7
    or (select count(*) from public.tracking_sync_runs) <> 0
    or (select count(distinct legacy_id) from public.shipments where portfolio_id = ${sqlText(PORTFOLIO_ID)}::uuid) <> 2
    or (select count(distinct legacy_id) from public.shipment_items where portfolio_id = ${sqlText(PORTFOLIO_ID)}::uuid) <> 5
    or (select count(distinct legacy_id) from public.tracking_events where portfolio_id = ${sqlText(PORTFOLIO_ID)}::uuid) <> 7
    or abs((select sum(actual_paid_cny) from public.shipments where portfolio_id = ${sqlText(PORTFOLIO_ID)}::uuid) - ${EXPECTED_ACTUAL_CNY}::numeric) > ${AMOUNT_TOLERANCE}::numeric
    or abs((select sum(budget_cny) from public.shipments where portfolio_id = ${sqlText(PORTFOLIO_ID)}::uuid) - ${EXPECTED_BUDGET_CNY}::numeric) > ${AMOUNT_TOLERANCE}::numeric
    or abs((select sum(allocated_shipping_cny) from public.shipment_items where portfolio_id = ${sqlText(PORTFOLIO_ID)}::uuid) - ${EXPECTED_LOGISTICS_CNY}::numeric) > ${AMOUNT_TOLERANCE}::numeric
    or exists (
      select 1
      from public.shipments shipment
      left join public.shipment_items item on item.shipment_id = shipment.id
      where shipment.portfolio_id = ${sqlText(PORTFOLIO_ID)}::uuid
      group by shipment.id, shipment.actual_paid_cny, shipment.budget_cny
      having abs((shipment.actual_paid_cny + shipment.budget_cny) - coalesce(sum(item.allocated_shipping_cny), 0)) > ${AMOUNT_TOLERANCE}::numeric
        or abs(1 - coalesce(sum(item.allocation_ratio), 0)) > ${RATIO_TOLERANCE}::numeric
    )
    or exists (select 1 from public.shipment_items where allocation_locked_at is null or allocation_version <> 1)
    or exists (
      select 1
      from public.shipment_items item
      left join public.shipments shipment on shipment.id = item.shipment_id
      left join public.assets asset on asset.id = item.asset_id
      where shipment.id is null
        or asset.id is null
        or item.portfolio_id <> shipment.portfolio_id
        or item.portfolio_id <> asset.portfolio_id
    )
    or exists (
      select 1
      from public.tracking_events event
      left join public.shipments shipment on shipment.id = event.shipment_id
      where shipment.id is null or event.portfolio_id <> shipment.portfolio_id
    )
  then
    raise exception 'Phase 3B-3 postflight verification failed';
  end if;
end;
$postflight$;

commit;

${buildResultSelect(migrationRunId)};`;
}

function buildVerificationSql(plan, ownerId) {
  const shipmentLegacyIds = sqlTextArray(plan.shipments.map(({ legacyId }) => legacyId));
  const itemLegacyIds = sqlTextArray(plan.items.map(({ legacyId }) => legacyId));
  const eventLegacyIds = sqlTextArray(plan.events.map(({ legacyId }) => legacyId));
  return `select json_build_object(
  'portfolio_id', ${sqlText(PORTFOLIO_ID)}::uuid,
  'owner_id', ${sqlText(ownerId)}::uuid,
  'assets', (select count(*) from public.assets),
  'purchase_orders', (select count(*) from public.purchase_orders),
  'purchase_items', (select count(*) from public.purchase_items),
  'shipments', (select count(*) from public.shipments),
  'shipment_items', (select count(*) from public.shipment_items),
  'tracking_events', (select count(*) from public.tracking_events),
  'tracking_sync_runs', (select count(*) from public.tracking_sync_runs),
  'shipment_duplicate_legacy_count', (select count(*) from (select legacy_id from public.shipments group by legacy_id having count(*) > 1) duplicate),
  'shipment_item_duplicate_legacy_count', (select count(*) from (select legacy_id from public.shipment_items group by legacy_id having count(*) > 1) duplicate),
  'tracking_event_duplicate_legacy_count', (select count(*) from (select legacy_id from public.tracking_events group by legacy_id having count(*) > 1) duplicate),
  'unexpected_shipment_count', (select count(*) from public.shipments where portfolio_id <> ${sqlText(PORTFOLIO_ID)}::uuid or legacy_id is null or legacy_id <> all (${shipmentLegacyIds})),
  'unexpected_shipment_item_count', (select count(*) from public.shipment_items where portfolio_id <> ${sqlText(PORTFOLIO_ID)}::uuid or legacy_id is null or legacy_id <> all (${itemLegacyIds})),
  'unexpected_tracking_event_count', (select count(*) from public.tracking_events where portfolio_id <> ${sqlText(PORTFOLIO_ID)}::uuid or legacy_id is null or legacy_id <> all (${eventLegacyIds})),
  'orphan_shipment_count', (select count(*) from public.shipments shipment left join public.portfolios portfolio on portfolio.id = shipment.portfolio_id where portfolio.id is null),
  'orphan_shipment_item_shipment_count', (select count(*) from public.shipment_items item left join public.shipments shipment on shipment.id = item.shipment_id where shipment.id is null),
  'orphan_shipment_item_asset_count', (select count(*) from public.shipment_items item left join public.assets asset on asset.id = item.asset_id where asset.id is null),
  'orphan_tracking_event_count', (select count(*) from public.tracking_events event left join public.shipments shipment on shipment.id = event.shipment_id where shipment.id is null),
  'cross_portfolio_item_count', (select count(*) from public.shipment_items item join public.shipments shipment on shipment.id = item.shipment_id join public.assets asset on asset.id = item.asset_id where item.portfolio_id <> shipment.portfolio_id or item.portfolio_id <> asset.portfolio_id),
  'cross_portfolio_event_count', (select count(*) from public.tracking_events event join public.shipments shipment on shipment.id = event.shipment_id where event.portfolio_id <> shipment.portfolio_id),
  'actual_cny', (select coalesce(sum(actual_paid_cny), 0) from public.shipments),
  'budget_cny', (select coalesce(sum(budget_cny), 0) from public.shipments),
  'allocated_cny', (select coalesce(sum(allocated_shipping_cny), 0) from public.shipment_items),
  'locked_item_count', (select count(*) from public.shipment_items where allocation_locked_at is not null),
  'allocation_version_one_count', (select count(*) from public.shipment_items where allocation_version = 1),
  'allocation_trigger_count', (select count(*) from information_schema.triggers where event_object_schema = 'public' and event_object_table = 'shipment_items' and trigger_name = 'shipment_items_protect_locked_allocation' and action_timing = 'BEFORE' and event_manipulation = 'UPDATE'),
  'stored_allocation_column_count', (select count(*) from information_schema.columns where table_schema = 'public' and table_name = 'shipment_items' and column_name in ('weight_snapshot_g', 'allocation_ratio', 'allocated_shipping_cny') and is_generated = 'NEVER'),
  'independent_snapshot_count', (select count(*) from public.shipment_items item join public.assets asset on asset.id = item.asset_id where item.weight_snapshot_g is distinct from asset.measured_weight_g),
  'repairs', (select count(*) from public.repairs),
  'market_sources', (select count(*) from public.market_sources),
  'market_listings', (select count(*) from public.market_listings),
  'valuation_snapshots', (select count(*) from public.valuation_snapshots),
  'sales', (select count(*) from public.sales),
  'cost_entries', (select count(*) from public.cost_entries),
  'attachments', (select count(*) from public.attachments),
  'rollback_safe', not exists (select 1 from public.repairs union all select 1 from public.valuation_snapshots union all select 1 from public.sales union all select 1 from public.cost_entries),
  'shipment_rows', (
    select json_agg(json_build_object(
      'id', shipment.id,
      'legacy_id', shipment.legacy_id,
      'carrier', shipment.carrier,
      'tracking_number', shipment.tracking_number,
      'origin', shipment.origin,
      'destination', shipment.destination,
      'shipped_at', shipment.shipped_at,
      'delivered_at', shipment.delivered_at,
      'bare_weight_g', shipment.bare_weight_g,
      'chargeable_weight_g', shipment.chargeable_weight_g,
      'actual_paid_cny', shipment.actual_paid_cny,
      'budget_cny', shipment.budget_cny,
      'status', shipment.status,
      'legacy_status', shipment.legacy_status,
      'allocated_items_cny', coalesce((select sum(item.allocated_shipping_cny) from public.shipment_items item where item.shipment_id = shipment.id), 0),
      'allocation_ratio_total', coalesce((select sum(item.allocation_ratio) from public.shipment_items item where item.shipment_id = shipment.id), 0)
    ) order by shipment.legacy_id)
    from public.shipments shipment
  ),
  'item_rows', (
    select json_agg(json_build_object(
      'id', item.id,
      'legacy_id', item.legacy_id,
      'shipment_id', item.shipment_id,
      'shipment_legacy_id', shipment.legacy_id,
      'asset_id', item.asset_id,
      'asset_legacy_id', asset.legacy_id,
      'asset_measured_weight_g', asset.measured_weight_g,
      'weight_snapshot_g', item.weight_snapshot_g,
      'allocation_method', item.allocation_method,
      'allocation_ratio', item.allocation_ratio,
      'allocated_shipping_cny', item.allocated_shipping_cny,
      'allocation_locked_at', item.allocation_locked_at,
      'allocation_version', item.allocation_version
    ) order by item.legacy_id)
    from public.shipment_items item
    join public.shipments shipment on shipment.id = item.shipment_id
    join public.assets asset on asset.id = item.asset_id
  ),
  'event_rows', (
    select json_agg(json_build_object(
      'id', event.id,
      'legacy_id', event.legacy_id,
      'shipment_id', event.shipment_id,
      'shipment_legacy_id', shipment.legacy_id,
      'external_event_id', event.external_event_id,
      'raw_status', event.raw_status,
      'status', event.status,
      'description', event.description,
      'location', event.location,
      'occurred_at', event.occurred_at,
      'recorded_at', event.recorded_at
    ) order by shipment.legacy_id, event.occurred_at, event.legacy_id)
    from public.tracking_events event
    join public.shipments shipment on shipment.id = event.shipment_id
  )
) as phase3b3_verification;`;
}

function buildRollbackSql({ plan, ownerId, migrationRunId, rolledBackAt, manifestSha256 }) {
  const shipmentLegacyIds = sqlTextArray(plan.shipments.map(({ legacyId }) => legacyId));
  const itemLegacyIds = sqlTextArray(plan.items.map(({ legacyId }) => legacyId));
  const eventLegacyIds = sqlTextArray(plan.events.map(({ legacyId }) => legacyId));
  return `begin;
set local lock_timeout = '10s';

do $rollback_preflight$
begin
  if not exists (select 1 from auth.users where id = ${sqlText(ownerId)}::uuid)
    or not exists (select 1 from public.portfolios where id = ${sqlText(PORTFOLIO_ID)}::uuid)
  then
    raise exception 'Confirmed owner or portfolio is missing';
  end if;

  if (select count(*) from public.tracking_sync_runs) <> 0
    or (select count(*) from public.repairs) <> 0
    or (select count(*) from public.market_sources) <> 0
    or (select count(*) from public.market_listings) <> 0
    or (select count(*) from public.valuation_snapshots) <> 0
    or (select count(*) from public.sales) <> 0
    or (select count(*) from public.cost_entries) <> 0
    or (select count(*) from public.attachments) <> 0
  then
    raise exception 'Rollback refused because later-phase data exists';
  end if;

  if exists (select 1 from public.shipments where portfolio_id <> ${sqlText(PORTFOLIO_ID)}::uuid or legacy_id is null or legacy_id <> all (${shipmentLegacyIds}))
    or exists (select 1 from public.shipment_items where portfolio_id <> ${sqlText(PORTFOLIO_ID)}::uuid or legacy_id is null or legacy_id <> all (${itemLegacyIds}))
    or exists (select 1 from public.tracking_events where portfolio_id <> ${sqlText(PORTFOLIO_ID)}::uuid or legacy_id is null or legacy_id <> all (${eventLegacyIds}))
  then
    raise exception 'Rollback refused because unrelated logistics data exists';
  end if;
end;
$rollback_preflight$;

delete from public.tracking_events
where portfolio_id = ${sqlText(PORTFOLIO_ID)}::uuid
  and legacy_id = any (${eventLegacyIds});

delete from public.shipment_items
where portfolio_id = ${sqlText(PORTFOLIO_ID)}::uuid
  and legacy_id = any (${itemLegacyIds});

delete from public.shipments
where portfolio_id = ${sqlText(PORTFOLIO_ID)}::uuid
  and legacy_id = any (${shipmentLegacyIds});

insert into public.audit_logs (
  id, portfolio_id, actor_id, action, entity_type, entity_id,
  before_data, after_data, occurred_at
) values (
  ${sqlText(migrationRunId)}::uuid,
  ${sqlText(PORTFOLIO_ID)}::uuid,
  ${sqlText(ownerId)}::uuid,
  'phase3b3_logistics_rollback',
  'migration_run',
  ${sqlText(migrationRunId)}::uuid,
  ${sqlText(JSON.stringify({
    shipmentLegacyIds: plan.shipments.map(({ legacyId }) => legacyId),
    itemLegacyIds: plan.items.map(({ legacyId }) => legacyId),
    eventLegacyIds: plan.events.map(({ legacyId }) => legacyId),
  }))}::jsonb,
  ${sqlText(JSON.stringify({
    phase: "3B-3 rollback",
    migrationRunId,
    rolledBackAt,
    sourceBackup: EXPECTED_BACKUP_NAME,
    sourceManifestSha256: manifestSha256,
    shipmentsAfter: 0,
    shipmentItemsAfter: 0,
    trackingEventsAfter: 0,
  }))}::jsonb,
  ${sqlText(rolledBackAt)}::timestamptz
);

do $rollback_postflight$
begin
  if (select count(*) from public.shipments) <> 0
    or (select count(*) from public.shipment_items) <> 0
    or (select count(*) from public.tracking_events) <> 0
  then
    raise exception 'Phase 3B-3 rollback postflight verification failed';
  end if;
end;
$rollback_postflight$;

commit;

select json_build_object(
  'migration_run_id', ${sqlText(migrationRunId)}::uuid,
  'portfolio_id', ${sqlText(PORTFOLIO_ID)}::uuid,
  'shipments', (select count(*) from public.shipments),
  'shipment_items', (select count(*) from public.shipment_items),
  'tracking_events', (select count(*) from public.tracking_events),
  'assets', (select count(*) from public.assets),
  'purchase_orders', (select count(*) from public.purchase_orders),
  'purchase_items', (select count(*) from public.purchase_items)
) as phase3b3_rollback;`;
}

function buildResultSelect(migrationRunId) {
  return `select json_build_object(
  'migration_run_id', ${sqlText(migrationRunId)}::uuid,
  'portfolio_id', ${sqlText(PORTFOLIO_ID)}::uuid,
  'shipments', (select count(*) from public.shipments),
  'shipment_items', (select count(*) from public.shipment_items),
  'tracking_events', (select count(*) from public.tracking_events),
  'tracking_sync_runs', (select count(*) from public.tracking_sync_runs),
  'actual_cny', (select sum(actual_paid_cny) from public.shipments),
  'budget_cny', (select sum(budget_cny) from public.shipments),
  'allocated_cny', (select sum(allocated_shipping_cny) from public.shipment_items),
  'audit_log', (select json_build_object('id', id, 'action', action, 'before_data', before_data, 'after_data', after_data, 'occurred_at', occurred_at) from public.audit_logs where id = ${sqlText(migrationRunId)}::uuid)
) as phase3b3_import;`;
}

function assertVerification(result, plan) {
  const verification = result?.rows?.[0]?.phase3b3_verification;
  if (!verification || typeof verification !== "object") {
    throw new Error("Supabase verification response is missing phase3b3_verification");
  }
  const expectedCounts = {
    assets: 5,
    purchase_orders: 4,
    purchase_items: 5,
    shipments: 2,
    shipment_items: 5,
    tracking_events: 7,
    tracking_sync_runs: 0,
    shipment_duplicate_legacy_count: 0,
    shipment_item_duplicate_legacy_count: 0,
    tracking_event_duplicate_legacy_count: 0,
    unexpected_shipment_count: 0,
    unexpected_shipment_item_count: 0,
    unexpected_tracking_event_count: 0,
    orphan_shipment_count: 0,
    orphan_shipment_item_shipment_count: 0,
    orphan_shipment_item_asset_count: 0,
    orphan_tracking_event_count: 0,
    cross_portfolio_item_count: 0,
    cross_portfolio_event_count: 0,
    locked_item_count: 5,
    allocation_version_one_count: 5,
    allocation_trigger_count: 1,
    stored_allocation_column_count: 3,
    independent_snapshot_count: 2,
    repairs: 0,
    market_sources: 0,
    market_listings: 0,
    valuation_snapshots: 0,
    sales: 0,
    cost_entries: 0,
    attachments: 0,
  };
  const differences = Object.entries(expectedCounts)
    .filter(([key, value]) => Number(verification[key]) !== value)
    .map(([key, value]) => ({ key, expected: value, actual: verification[key] }));
  if (differences.length > 0) {
    throw new Error(`Phase 3B-3 count verification failed: ${JSON.stringify(differences)}`);
  }
  if (verification.rollback_safe !== true) throw new Error("Rollback preconditions are not currently safe");
  assertAmount(verification.actual_cny, EXPECTED_ACTUAL_CNY, "actual logistics total");
  assertAmount(verification.budget_cny, EXPECTED_BUDGET_CNY, "budget logistics total");
  assertAmount(verification.allocated_cny, EXPECTED_LOGISTICS_CNY, "allocated logistics total");

  const actualShipments = verification.shipment_rows ?? [];
  const actualItems = verification.item_rows ?? [];
  const actualEvents = verification.event_rows ?? [];
  if (actualShipments.length !== plan.shipments.length
    || actualItems.length !== plan.items.length
    || actualEvents.length !== plan.events.length) {
    throw new Error("Detailed logistics mappings have an unexpected row count");
  }

  const actualShipmentsByLegacyId = new Map(actualShipments.map((row) => [row.legacy_id, row]));
  for (const expected of plan.shipments) {
    const actual = actualShipmentsByLegacyId.get(expected.legacyId);
    if (!actual) throw new Error(`Missing target shipment ${expected.legacyId}`);
    assertEqual(actual.id, expected.id, `${expected.legacyId}.id`);
    assertEqual(actual.carrier, expected.carrier, `${expected.legacyId}.carrier`);
    assertEqual(actual.tracking_number, expected.trackingNumber, `${expected.legacyId}.tracking_number`);
    assertEqual(actual.origin, expected.origin, `${expected.legacyId}.origin`);
    assertEqual(actual.destination, expected.destination, `${expected.legacyId}.destination`);
    assertSameNullableInstant(actual.shipped_at, expected.shippedAt, `${expected.legacyId}.shipped_at`);
    assertSameNullableInstant(actual.delivered_at, expected.deliveredAt, `${expected.legacyId}.delivered_at`);
    assertEqual(Number(actual.bare_weight_g), expected.bareWeightG, `${expected.legacyId}.bare_weight_g`);
    assertEqual(Number(actual.chargeable_weight_g), expected.chargeableWeightG, `${expected.legacyId}.chargeable_weight_g`);
    assertAmount(actual.actual_paid_cny, expected.actualPaidCny, `${expected.legacyId}.actual_paid_cny`);
    assertAmount(actual.budget_cny, expected.budgetCny, `${expected.legacyId}.budget_cny`);
    assertAmount(actual.allocated_items_cny, expected.shippingCostCny, `${expected.legacyId}.allocated_items_cny`);
    assertWithin(actual.allocation_ratio_total, 1, RATIO_TOLERANCE, `${expected.legacyId}.allocation_ratio_total`);
    assertEqual(actual.status, expected.status, `${expected.legacyId}.status`);
    assertEqual(actual.legacy_status, expected.legacyStatus, `${expected.legacyId}.legacy_status`);
  }

  const actualItemsByLegacyId = new Map(actualItems.map((row) => [row.legacy_id, row]));
  for (const expected of plan.items) {
    const actual = actualItemsByLegacyId.get(expected.legacyId);
    if (!actual) throw new Error(`Missing target shipment item ${expected.legacyId}`);
    assertEqual(actual.id, expected.id, `${expected.legacyId}.id`);
    assertEqual(actual.shipment_legacy_id, expected.shipmentLegacyId, `${expected.legacyId}.shipment_legacy_id`);
    assertEqual(actual.asset_legacy_id, expected.assetLegacyId, `${expected.legacyId}.asset_legacy_id`);
    assertEqual(Number(actual.weight_snapshot_g), expected.weightSnapshotG, `${expected.legacyId}.weight_snapshot_g`);
    assertEqual(actual.allocation_method, expected.allocationMethod, `${expected.legacyId}.allocation_method`);
    assertWithin(actual.allocation_ratio, expected.allocationRatio, RATIO_TOLERANCE, `${expected.legacyId}.allocation_ratio`);
    assertAmount(actual.allocated_shipping_cny, expected.allocatedShippingCny, `${expected.legacyId}.allocated_shipping_cny`);
    assertSameNullableInstant(actual.allocation_locked_at, expected.allocationLockedAt, `${expected.legacyId}.allocation_locked_at`);
    assertEqual(Number(actual.allocation_version), 1, `${expected.legacyId}.allocation_version`);
  }

  const actualEventsByLegacyId = new Map(actualEvents.map((row) => [row.legacy_id, row]));
  for (const expected of plan.events) {
    const actual = actualEventsByLegacyId.get(expected.legacyId);
    if (!actual) throw new Error(`Missing target tracking event ${expected.legacyId}`);
    assertEqual(actual.id, expected.id, `${expected.legacyId}.id`);
    assertEqual(actual.shipment_legacy_id, expected.shipmentLegacyId, `${expected.legacyId}.shipment_legacy_id`);
    assertEqual(actual.external_event_id, null, `${expected.legacyId}.external_event_id`);
    assertEqual(actual.raw_status, expected.rawStatus, `${expected.legacyId}.raw_status`);
    assertEqual(actual.status, expected.statusLabel, `${expected.legacyId}.status`);
    assertEqual(actual.description, expected.description, `${expected.legacyId}.description`);
    assertEqual(actual.location, expected.location, `${expected.legacyId}.location`);
    assertSameNullableInstant(actual.occurred_at, expected.occurredAt, `${expected.legacyId}.occurred_at`);
    assertSameNullableInstant(actual.recorded_at, expected.recordedAt, `${expected.legacyId}.recorded_at`);
  }

  return verification;
}

function runRemoteSql(sql) {
  const temporaryDirectory = mkdtempSync(join(tmpdir(), "lensfolio-phase3b3-"));
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

function dryRunShipment(shipment) {
  return {
    id: shipment.id,
    legacyId: shipment.legacyId,
    batchCode: shipment.batchCode,
    carrier: shipment.carrier,
    trackingNumber: shipment.trackingNumber,
    origin: shipment.origin,
    destination: shipment.destination,
    shippedAt: shipment.shippedAt,
    bareWeightG: shipment.bareWeightG,
    weightTotalG: shipment.weightTotalG,
    chargeableWeightG: shipment.chargeableWeightG,
    shippingCostCny: shipment.shippingCostCny,
    actualPaidCny: shipment.actualPaidCny,
    budgetCny: shipment.budgetCny,
    status: shipment.status,
    legacyStatus: shipment.legacyStatus,
  };
}

function dryRunItem(item) {
  return {
    id: item.id,
    legacyId: item.legacyId,
    shipmentLegacyId: item.shipmentLegacyId,
    assetLegacyId: item.assetLegacyId,
    weightSnapshotG: item.weightSnapshotG,
    allocationMethod: item.allocationMethod,
    allocationRatio: item.allocationRatio,
    allocatedShippingCny: item.allocatedShippingCny,
    allocationLockedAt: item.allocationLockedAt,
    allocationVersion: item.allocationVersion,
  };
}

function dryRunEvent(event) {
  return {
    id: event.id,
    legacyId: event.legacyId,
    shipmentLegacyId: event.shipmentLegacyId,
    externalEventId: event.externalEventId,
    rawStatus: event.rawStatus,
    status: event.status,
    statusLabel: event.statusLabel,
    location: event.location,
    occurredAt: event.occurredAt,
  };
}

function buildLocation(event) {
  const parts = [
    nullableText(event.office),
    nullableText(event.country),
    nullableText(event.postal_code),
  ].filter(Boolean);
  return parts.length > 0 ? parts.join(" · ") : null;
}

function mapShipmentStatus(value) {
  const mapping = new Map([
    ["香港领取点待取", "in_transit"],
    ["待支付运费", "draft"],
  ]);
  const mapped = mapping.get(value);
  if (!mapped) throw new Error(`Unsupported shipment status: ${value}`);
  return mapped;
}

function mapAllocationMethod(value) {
  const mapping = new Map([["按重量", "weight"]]);
  const mapped = mapping.get(value);
  if (!mapped) throw new Error(`Unsupported logistics allocation method: ${value}`);
  return mapped;
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

function groupBy(values, keyFor) {
  const result = new Map();
  for (const value of values) {
    const key = keyFor(value);
    const group = result.get(key) ?? [];
    group.push(value);
    result.set(key, group);
  }
  return result;
}

function legacyTimestamp(value) {
  const stringValue = text(value, "timestamp");
  if (/([zZ]|[+-]\d\d:\d\d)$/.test(stringValue)) return stringValue;
  return `${stringValue.replace(" ", "T")}+08:00`;
}

function nullableLegacyTimestamp(value) {
  return value === null || value === undefined || value === "" ? null : legacyTimestamp(value);
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

function integer(value, name) {
  const result = Number(value);
  if (!Number.isInteger(result)) throw new Error(`${name} must be an integer`);
  return result;
}

function positiveInteger(value, name) {
  const result = integer(value, name);
  if (result <= 0) throw new Error(`${name} must be positive`);
  return result;
}

function nonnegativeNumber(value, name) {
  const result = Number(value);
  if (!Number.isFinite(result) || result < 0) throw new Error(`${name} must be a nonnegative number`);
  return result;
}

function sum(values) {
  return values.reduce((total, value) => total + value, 0);
}

function withinTolerance(left, right, tolerance) {
  return Math.abs(Number(left) - Number(right)) <= tolerance;
}

function assertAmount(actual, expected, name) {
  assertWithin(actual, expected, AMOUNT_TOLERANCE, name);
}

function assertWithin(actual, expected, tolerance, name) {
  if (!withinTolerance(actual, expected, tolerance)) {
    throw new Error(`${name} mismatch: expected ${expected}, got ${actual}`);
  }
}

function assertEqual(actual, expected, name) {
  if (actual !== expected) throw new Error(`${name} mismatch: expected ${expected}, got ${actual}`);
}

function assertSameNullableInstant(actual, expected, name) {
  if (actual === null || expected === null) {
    if (actual !== expected) throw new Error(`${name} mismatch: expected ${expected}, got ${actual}`);
    return;
  }
  if (new Date(actual).getTime() !== new Date(expected).getTime()) {
    throw new Error(`${name} mismatch: expected ${expected}, got ${actual}`);
  }
}

function assertUniqueNonempty(values, name) {
  if (values.some((value) => typeof value !== "string" || !value.trim())) {
    throw new Error(`${name} contain missing values`);
  }
  if (new Set(values).size !== values.length) throw new Error(`${name} contain duplicates`);
}

function sqlText(value) {
  return `'${String(value).replaceAll("'", "''")}'`;
}

function sqlNullableText(value) {
  return value === null ? "null" : sqlText(value);
}

function sqlNullableTimestamp(value) {
  return value === null ? "null" : `${sqlText(value)}::timestamptz`;
}

function sqlTextArray(values) {
  return `array[${values.map(sqlText).join(", ")}]::text[]`;
}

function sqlNumber(value) {
  const result = Number(value);
  if (!Number.isFinite(result)) throw new Error(`Cannot serialize non-finite SQL number: ${value}`);
  return String(result);
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
  if (parsed.confirmRollback && !parsed.rollback) {
    throw new Error("--confirm-rollback is only valid with --rollback");
  }
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
  node scripts/import-logistics-phase3b3.mjs --backup <backup-directory>
  node scripts/import-logistics-phase3b3.mjs --backup <backup-directory> --apply
  node scripts/import-logistics-phase3b3.mjs --backup <backup-directory> --verify
  node scripts/import-logistics-phase3b3.mjs --backup <backup-directory> --rollback --confirm-rollback

The default mode validates the complete frozen backup and prints a dry-run plan
without connecting to Supabase. Apply performs one atomic, idempotent transaction,
locks the frozen shipment allocation snapshots, and records migration_run_id in
audit_logs. Verify is read-only. Rollback removes only the Phase 3B-3 logistics
rows, refuses to run after later-phase imports, and requires explicit confirmation.`);
}
