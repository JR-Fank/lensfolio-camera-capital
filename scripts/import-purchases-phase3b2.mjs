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
const EXPECTED_PURCHASE_TOTAL_CNY = 13_610;
const AMOUNT_TOLERANCE_CNY = 0.01;

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
const plan = buildPurchasePlan(source);

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
      purchaseOrders: source.purchaseOrders.length,
      purchaseItems: source.purchaseItems.length,
    },
    totalsCny: plan.totals,
    orders: plan.orders.map(dryRunOrder),
    items: plan.items.map(dryRunItem),
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
  const purchaseOrdersPath = join(directory, "data", "purchase_orders.jsonl");
  const purchaseItemsPath = join(directory, "data", "purchase_order_items.jsonl");
  for (const filePath of [
    manifestPath,
    checksumsPath,
    camerasPath,
    purchaseOrdersPath,
    purchaseItemsPath,
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
  if (manifest?.tables?.purchase_orders?.rowCount !== 4
    || manifest?.tables?.purchase_order_items?.rowCount !== 5
    || Number(manifest?.financialBaseline?.purchasePaidCny) !== EXPECTED_PURCHASE_TOTAL_CNY) {
    throw new Error("Backup manifest purchase baseline does not match Phase 1C");
  }

  const cameras = parseJsonLines(camerasPath);
  const purchaseOrders = parseJsonLines(purchaseOrdersPath);
  const purchaseItems = parseJsonLines(purchaseItemsPath);
  if (cameras.length !== 5 || purchaseOrders.length !== 4 || purchaseItems.length !== 5) {
    throw new Error("Backup JSONL row counts do not match the frozen manifest");
  }

  assertUniqueNonempty(cameras.map(({ id }) => id), "camera legacy IDs");
  assertUniqueNonempty(purchaseOrders.map(({ id }) => id), "purchase order legacy IDs");
  assertUniqueNonempty(purchaseItems.map(({ id }) => id), "purchase item legacy IDs");

  const cameraIds = new Set(cameras.map(({ id }) => id));
  const orderIds = new Set(purchaseOrders.map(({ id }) => id));
  for (const item of purchaseItems) {
    if (!cameraIds.has(item.camera_id)) {
      throw new Error(`Purchase item ${item.id} references unknown camera ${item.camera_id}`);
    }
    if (!orderIds.has(item.order_id)) {
      throw new Error(`Purchase item ${item.id} references unknown order ${item.order_id}`);
    }
  }

  return { manifest, manifestSha256, cameras, purchaseOrders, purchaseItems };
}

function validateChecksumFile(directory, checksumsPath) {
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
}

function buildPurchasePlan(source) {
  const sourceItemsByOrder = new Map();
  for (const item of source.purchaseItems) {
    const items = sourceItemsByOrder.get(item.order_id) ?? [];
    items.push(item);
    sourceItemsByOrder.set(item.order_id, items);
  }

  const orders = source.purchaseOrders.map((order) => {
    const legacyId = text(order.id, "purchase_order.id");
    const orderItems = sourceItemsByOrder.get(legacyId) ?? [];
    if (orderItems.length === 0) throw new Error(`Purchase order ${legacyId} has no items`);

    const originalSubtotalJpy = nonnegativeNumber(order.item_price_jpy, `${legacyId}.item_price_jpy`);
    const couponJpy = nonnegativeNumber(order.discount_jpy, `${legacyId}.discount_jpy`);
    const serviceFeeJpy = nonnegativeNumber(order.service_fee_jpy, `${legacyId}.service_fee_jpy`);
    const photoFeeJpy = nonnegativeNumber(order.photo_fee_jpy, `${legacyId}.photo_fee_jpy`);
    const adjustmentJpy = finiteNumber(order.adjustment_jpy, `${legacyId}.adjustment_jpy`);
    const feeJpy = serviceFeeJpy + photoFeeJpy + adjustmentJpy;
    if (feeJpy < 0) throw new Error(`${legacyId}.aggregated_fee_jpy cannot be negative`);
    const domesticShippingJpy = nonnegativeNumber(
      order.domestic_shipping_jpy,
      `${legacyId}.domestic_shipping_jpy`,
    );
    const sourceTotalJpy = nonnegativeNumber(order.total_jpy, `${legacyId}.total_jpy`);
    const reconstructedTotalJpy = originalSubtotalJpy - couponJpy + feeJpy + domesticShippingJpy;
    if (!withinTolerance(reconstructedTotalJpy, sourceTotalJpy, 0.01)) {
      throw new Error(`Purchase order ${legacyId} JPY components do not reconcile to source total`);
    }

    const actualPaidCny = nonnegativeNumber(order.paid_cny, `${legacyId}.paid_cny`);
    const allocatedCny = sum(orderItems.map((item) => nonnegativeNumber(
      item.allocated_paid_cny,
      `${item.id}.allocated_paid_cny`,
    )));
    if (!withinTolerance(actualPaidCny, allocatedCny, AMOUNT_TOLERANCE_CNY)) {
      throw new Error(`Purchase order ${legacyId} allocated CNY does not equal actual paid CNY`);
    }

    const allocationMethod = orderItems.length > 1 ? "legacy_equal_allocation" : "manual";
    if (allocationMethod === "legacy_equal_allocation") {
      const expectedAllocation = actualPaidCny / orderItems.length;
      if (!orderItems.every((item) => withinTolerance(
        Number(item.allocated_paid_cny),
        expectedAllocation,
        AMOUNT_TOLERANCE_CNY,
      ))) {
        throw new Error(`Bundle order ${legacyId} is not equally allocated in the source backup`);
      }
    }

    return {
      id: uuidV5(`${EXPECTED_BACKUP_NAME}:purchase_order:${legacyId}`, UUID_NAMESPACE),
      legacyId,
      vendor: nullableText(order.seller),
      platform: nullableText(order.platform),
      orderReference: nullableText(order.order_ref),
      originalCurrency: "JPY",
      orderedAt: legacyTimestamp(order.purchased_at),
      status: mapPurchaseStatus(order.status),
      originalSubtotalJpy,
      couponJpy,
      feeJpy,
      feeComponentsJpy: { serviceFeeJpy, photoFeeJpy, adjustmentJpy },
      domesticShippingJpy,
      sourceTotalJpy,
      exchangeRateJpyToCny: positiveNumber(order.exchange_rate, `${legacyId}.exchange_rate`),
      actualPaidCny,
      allocationMethod,
      createdAt: legacyTimestamp(order.created_at),
      updatedAt: legacyTimestamp(order.updated_at),
    };
  }).sort((left, right) => left.legacyId.localeCompare(right.legacyId));

  const orderByLegacyId = new Map(orders.map((order) => [order.legacyId, order]));
  const items = source.purchaseItems.map((item) => {
    const legacyId = text(item.id, "purchase_item.id");
    const order = orderByLegacyId.get(text(item.order_id, `${legacyId}.order_id`));
    if (!order) throw new Error(`Purchase item ${legacyId} references an unmapped order`);
    const allocatedCostCny = nonnegativeNumber(item.allocated_paid_cny, `${legacyId}.allocated_paid_cny`);
    return {
      id: uuidV5(`${EXPECTED_BACKUP_NAME}:purchase_item:${legacyId}`, UUID_NAMESPACE),
      legacyId,
      orderLegacyId: order.legacyId,
      assetLegacyId: text(item.camera_id, `${legacyId}.camera_id`),
      originalPriceJpy: nonnegativeNumber(item.item_price_jpy, `${legacyId}.item_price_jpy`),
      allocationMethod: order.allocationMethod,
      allocationRatio: allocatedCostCny / order.actualPaidCny,
      allocatedCostCny,
      allocationNote: nullableText(item.allocation_note),
      createdAt: legacyTimestamp(item.created_at),
      updatedAt: legacyTimestamp(item.created_at),
    };
  }).sort((left, right) => left.legacyId.localeCompare(right.legacyId));

  const purchaseActualPaidCny = sum(orders.map(({ actualPaidCny }) => actualPaidCny));
  const purchaseItemAllocatedCny = sum(items.map(({ allocatedCostCny }) => allocatedCostCny));
  if (!withinTolerance(purchaseActualPaidCny, EXPECTED_PURCHASE_TOTAL_CNY, AMOUNT_TOLERANCE_CNY)
    || !withinTolerance(purchaseItemAllocatedCny, EXPECTED_PURCHASE_TOTAL_CNY, AMOUNT_TOLERANCE_CNY)) {
    throw new Error("Frozen purchase totals do not match CNY 13,610");
  }

  return {
    orders,
    items,
    assetLegacyIds: source.cameras.map(({ id }) => text(id, "camera.id")).sort(),
    totals: {
      purchaseActualPaidCny,
      purchaseItemAllocatedCny,
      differenceCny: Math.abs(purchaseActualPaidCny - purchaseItemAllocatedCny),
    },
  };
}

function buildImportSql({ plan, ownerId, migrationRunId, importedAt, manifestSha256 }) {
  const orderLegacyIds = sqlTextArray(plan.orders.map(({ legacyId }) => legacyId));
  const itemLegacyIds = sqlTextArray(plan.items.map(({ legacyId }) => legacyId));
  const assetLegacyIds = sqlTextArray(plan.assetLegacyIds);
  const orderValues = plan.orders.map((order) => `(
    ${sqlText(order.id)}::uuid,
    ${sqlText(PORTFOLIO_ID)}::uuid,
    ${sqlText(order.legacyId)},
    ${sqlNullableText(order.vendor)},
    ${sqlNullableText(order.platform)},
    ${sqlNullableText(order.orderReference)},
    ${sqlText(order.originalCurrency)},
    ${sqlText(order.orderedAt)}::timestamptz,
    ${sqlText(order.status)}::public.purchase_status,
    ${sqlNumber(order.originalSubtotalJpy)}::numeric,
    ${sqlNumber(order.couponJpy)}::numeric,
    ${sqlNumber(order.feeJpy)}::numeric,
    ${sqlNumber(order.domesticShippingJpy)}::numeric,
    ${sqlNumber(order.exchangeRateJpyToCny)}::numeric,
    ${sqlNumber(order.actualPaidCny)}::numeric,
    ${sqlText(order.allocationMethod)}::public.allocation_method,
    ${sqlText(order.createdAt)}::timestamptz,
    ${sqlText(order.updatedAt)}::timestamptz,
    ${sqlText(ownerId)}::uuid
  )`).join(",\n");
  const itemValues = plan.items.map((item) => `(
    ${sqlText(item.id)}::uuid,
    ${sqlText(item.legacyId)},
    ${sqlText(item.orderLegacyId)},
    ${sqlText(item.assetLegacyId)},
    ${sqlNumber(item.originalPriceJpy)}::numeric,
    ${sqlText(item.allocationMethod)}::public.allocation_method,
    ${sqlNumber(item.allocationRatio)}::numeric,
    ${sqlNumber(item.allocatedCostCny)}::numeric,
    ${sqlText(item.createdAt)}::timestamptz,
    ${sqlText(item.updatedAt)}::timestamptz
  )`).join(",\n");
  const afterData = {
    phase: "3B-2",
    migrationRunId,
    importedAt,
    sourceBackup: EXPECTED_BACKUP_NAME,
    sourceManifestSha256: manifestSha256,
    expectedPurchaseOrderCount: 4,
    expectedPurchaseItemCount: 5,
    purchaseActualPaidCny: plan.totals.purchaseActualPaidCny,
    purchaseItemAllocatedCny: plan.totals.purchaseItemAllocatedCny,
    orders: plan.orders.map(({ legacyId, sourceTotalJpy, feeComponentsJpy }) => ({
      legacyId,
      sourceTotalJpy,
      feeComponentsJpy,
    })),
    items: plan.items.map(({ legacyId, allocationNote }) => ({
      legacyId,
      allocationNote,
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
  then
    raise exception 'Confirmed portfolio or owner membership is missing';
  end if;

  if (select count(*) from public.assets where portfolio_id = ${sqlText(PORTFOLIO_ID)}::uuid) <> 5
    or (select count(distinct legacy_id) from public.assets where portfolio_id = ${sqlText(PORTFOLIO_ID)}::uuid) <> 5
    or exists (
      select 1 from public.assets
      where portfolio_id <> ${sqlText(PORTFOLIO_ID)}::uuid
        or legacy_id is null
        or legacy_id <> all (${assetLegacyIds})
    )
  then
    raise exception 'Asset baseline does not match Phase 3B-1';
  end if;

  if (select count(*) from public.purchase_orders) > 4
    or exists (
      select 1 from public.purchase_orders
      where portfolio_id <> ${sqlText(PORTFOLIO_ID)}::uuid
        or legacy_id is null
        or legacy_id <> all (${orderLegacyIds})
    )
    or (select count(*) from public.purchase_items) > 5
    or exists (
      select 1 from public.purchase_items
      where portfolio_id <> ${sqlText(PORTFOLIO_ID)}::uuid
        or legacy_id is null
        or legacy_id <> all (${itemLegacyIds})
    )
  then
    raise exception 'Unexpected purchase rows exist';
  end if;

  if (select count(*) from public.shipments) <> 0
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

select set_config('lensfolio.phase3b2_orders_before', (select count(*)::text from public.purchase_orders), true);
select set_config('lensfolio.phase3b2_items_before', (select count(*)::text from public.purchase_items), true);

insert into public.purchase_orders (
  id, portfolio_id, legacy_id, vendor, platform, order_reference, original_currency,
  ordered_at, status, original_subtotal_jpy, coupon_jpy, fee_jpy,
  domestic_shipping_jpy, exchange_rate_jpy_to_cny, actual_paid_cny,
  allocation_method, created_at, updated_at, created_by
) values
${orderValues}
on conflict (portfolio_id, legacy_id) do update set
  vendor = excluded.vendor,
  platform = excluded.platform,
  order_reference = excluded.order_reference,
  original_currency = excluded.original_currency,
  ordered_at = excluded.ordered_at,
  status = excluded.status,
  original_subtotal_jpy = excluded.original_subtotal_jpy,
  coupon_jpy = excluded.coupon_jpy,
  fee_jpy = excluded.fee_jpy,
  domestic_shipping_jpy = excluded.domestic_shipping_jpy,
  exchange_rate_jpy_to_cny = excluded.exchange_rate_jpy_to_cny,
  actual_paid_cny = excluded.actual_paid_cny,
  allocation_method = excluded.allocation_method,
  created_by = excluded.created_by
where (
  purchase_orders.vendor, purchase_orders.platform, purchase_orders.order_reference,
  purchase_orders.original_currency, purchase_orders.ordered_at, purchase_orders.status,
  purchase_orders.original_subtotal_jpy, purchase_orders.coupon_jpy,
  purchase_orders.fee_jpy, purchase_orders.domestic_shipping_jpy,
  purchase_orders.exchange_rate_jpy_to_cny, purchase_orders.actual_paid_cny,
  purchase_orders.allocation_method, purchase_orders.created_by
) is distinct from (
  excluded.vendor, excluded.platform, excluded.order_reference,
  excluded.original_currency, excluded.ordered_at, excluded.status,
  excluded.original_subtotal_jpy, excluded.coupon_jpy,
  excluded.fee_jpy, excluded.domestic_shipping_jpy,
  excluded.exchange_rate_jpy_to_cny, excluded.actual_paid_cny,
  excluded.allocation_method, excluded.created_by
);

with source_items (
  id, legacy_id, order_legacy_id, asset_legacy_id, original_price_jpy,
  allocation_method, allocation_ratio, allocated_cost_cny, created_at, updated_at
) as (values
${itemValues}
)
insert into public.purchase_items (
  id, portfolio_id, purchase_order_id, asset_id, original_price_jpy,
  allocation_method, allocation_ratio, allocated_cost_cny,
  created_at, updated_at, created_by, legacy_id
)
select
  source_items.id,
  ${sqlText(PORTFOLIO_ID)}::uuid,
  purchase_order.id,
  asset.id,
  source_items.original_price_jpy,
  source_items.allocation_method,
  source_items.allocation_ratio,
  source_items.allocated_cost_cny,
  source_items.created_at,
  source_items.updated_at,
  ${sqlText(ownerId)}::uuid,
  source_items.legacy_id
from source_items
join public.purchase_orders purchase_order
  on purchase_order.portfolio_id = ${sqlText(PORTFOLIO_ID)}::uuid
  and purchase_order.legacy_id = source_items.order_legacy_id
join public.assets asset
  on asset.portfolio_id = ${sqlText(PORTFOLIO_ID)}::uuid
  and asset.legacy_id = source_items.asset_legacy_id
on conflict (portfolio_id, legacy_id) do update set
  purchase_order_id = excluded.purchase_order_id,
  asset_id = excluded.asset_id,
  original_price_jpy = excluded.original_price_jpy,
  allocation_method = excluded.allocation_method,
  allocation_ratio = excluded.allocation_ratio,
  allocated_cost_cny = excluded.allocated_cost_cny,
  created_by = excluded.created_by
where (
  purchase_items.purchase_order_id, purchase_items.asset_id,
  purchase_items.original_price_jpy, purchase_items.allocation_method,
  purchase_items.allocation_ratio, purchase_items.allocated_cost_cny,
  purchase_items.created_by
) is distinct from (
  excluded.purchase_order_id, excluded.asset_id,
  excluded.original_price_jpy, excluded.allocation_method,
  excluded.allocation_ratio, excluded.allocated_cost_cny,
  excluded.created_by
);

insert into public.audit_logs (
  id, portfolio_id, actor_id, action, entity_type, entity_id,
  before_data, after_data, occurred_at
) values (
  ${sqlText(migrationRunId)}::uuid,
  ${sqlText(PORTFOLIO_ID)}::uuid,
  ${sqlText(ownerId)}::uuid,
  'phase3b2_purchases_import',
  'migration_run',
  ${sqlText(migrationRunId)}::uuid,
  jsonb_build_object(
    'purchase_orders_before', current_setting('lensfolio.phase3b2_orders_before')::integer,
    'purchase_items_before', current_setting('lensfolio.phase3b2_items_before')::integer
  ),
  ${sqlText(JSON.stringify(afterData))}::jsonb,
  ${sqlText(importedAt)}::timestamptz
);

do $postflight$
begin
  if (select count(*) from public.purchase_orders where portfolio_id = ${sqlText(PORTFOLIO_ID)}::uuid) <> 4
    or (select count(*) from public.purchase_items where portfolio_id = ${sqlText(PORTFOLIO_ID)}::uuid) <> 5
    or (select count(distinct legacy_id) from public.purchase_orders where portfolio_id = ${sqlText(PORTFOLIO_ID)}::uuid) <> 4
    or (select count(distinct legacy_id) from public.purchase_items where portfolio_id = ${sqlText(PORTFOLIO_ID)}::uuid) <> 5
    or abs((select sum(actual_paid_cny) from public.purchase_orders where portfolio_id = ${sqlText(PORTFOLIO_ID)}::uuid) - ${sqlNumber(EXPECTED_PURCHASE_TOTAL_CNY)}::numeric) > ${sqlNumber(AMOUNT_TOLERANCE_CNY)}::numeric
    or abs((select sum(allocated_cost_cny) from public.purchase_items where portfolio_id = ${sqlText(PORTFOLIO_ID)}::uuid) - ${sqlNumber(EXPECTED_PURCHASE_TOTAL_CNY)}::numeric) > ${sqlNumber(AMOUNT_TOLERANCE_CNY)}::numeric
    or exists (
      select 1
      from public.purchase_orders purchase_order
      left join public.purchase_items purchase_item on purchase_item.purchase_order_id = purchase_order.id
      where purchase_order.portfolio_id = ${sqlText(PORTFOLIO_ID)}::uuid
      group by purchase_order.id, purchase_order.actual_paid_cny
      having abs(purchase_order.actual_paid_cny - coalesce(sum(purchase_item.allocated_cost_cny), 0)) > ${sqlNumber(AMOUNT_TOLERANCE_CNY)}::numeric
    )
    or exists (
      select 1
      from public.purchase_items purchase_item
      left join public.purchase_orders purchase_order on purchase_order.id = purchase_item.purchase_order_id
      left join public.assets asset on asset.id = purchase_item.asset_id
      where purchase_order.id is null
        or asset.id is null
        or purchase_item.portfolio_id <> purchase_order.portfolio_id
        or purchase_item.portfolio_id <> asset.portfolio_id
    )
  then
    raise exception 'Phase 3B-2 postflight verification failed';
  end if;
end;
$postflight$;

commit;

${buildResultSelect(migrationRunId)};`;
}

function buildVerificationSql(plan, ownerId) {
  const orderLegacyIds = sqlTextArray(plan.orders.map(({ legacyId }) => legacyId));
  const itemLegacyIds = sqlTextArray(plan.items.map(({ legacyId }) => legacyId));
  return `select json_build_object(
  'portfolio_id', ${sqlText(PORTFOLIO_ID)}::uuid,
  'owner_id', ${sqlText(ownerId)}::uuid,
  'purchase_order_count', (select count(*) from public.purchase_orders where portfolio_id = ${sqlText(PORTFOLIO_ID)}::uuid),
  'purchase_item_count', (select count(*) from public.purchase_items where portfolio_id = ${sqlText(PORTFOLIO_ID)}::uuid),
  'purchase_order_duplicate_legacy_count', (select count(*) from (select legacy_id from public.purchase_orders where portfolio_id = ${sqlText(PORTFOLIO_ID)}::uuid group by legacy_id having count(*) > 1) duplicates),
  'purchase_item_duplicate_legacy_count', (select count(*) from (select legacy_id from public.purchase_items where portfolio_id = ${sqlText(PORTFOLIO_ID)}::uuid group by legacy_id having count(*) > 1) duplicates),
  'unexpected_purchase_order_count', (select count(*) from public.purchase_orders where portfolio_id <> ${sqlText(PORTFOLIO_ID)}::uuid or legacy_id is null or legacy_id <> all (${orderLegacyIds})),
  'unexpected_purchase_item_count', (select count(*) from public.purchase_items where portfolio_id <> ${sqlText(PORTFOLIO_ID)}::uuid or legacy_id is null or legacy_id <> all (${itemLegacyIds})),
  'orphan_purchase_order_count', (select count(*) from public.purchase_orders purchase_order left join public.portfolios portfolio on portfolio.id = purchase_order.portfolio_id where portfolio.id is null),
  'orphan_purchase_item_order_count', (select count(*) from public.purchase_items purchase_item left join public.purchase_orders purchase_order on purchase_order.id = purchase_item.purchase_order_id where purchase_order.id is null),
  'orphan_purchase_item_asset_count', (select count(*) from public.purchase_items purchase_item left join public.assets asset on asset.id = purchase_item.asset_id where asset.id is null),
  'cross_portfolio_purchase_item_count', (select count(*) from public.purchase_items purchase_item join public.purchase_orders purchase_order on purchase_order.id = purchase_item.purchase_order_id join public.assets asset on asset.id = purchase_item.asset_id where purchase_item.portfolio_id <> purchase_order.portfolio_id or purchase_item.portfolio_id <> asset.portfolio_id),
  'purchase_actual_paid_cny', (select coalesce(sum(actual_paid_cny), 0) from public.purchase_orders where portfolio_id = ${sqlText(PORTFOLIO_ID)}::uuid),
  'purchase_item_allocated_cny', (select coalesce(sum(allocated_cost_cny), 0) from public.purchase_items where portfolio_id = ${sqlText(PORTFOLIO_ID)}::uuid),
  'shipments', (select count(*) from public.shipments),
  'shipment_items', (select count(*) from public.shipment_items),
  'tracking_events', (select count(*) from public.tracking_events),
  'tracking_sync_runs', (select count(*) from public.tracking_sync_runs),
  'repairs', (select count(*) from public.repairs),
  'market_sources', (select count(*) from public.market_sources),
  'market_listings', (select count(*) from public.market_listings),
  'valuation_snapshots', (select count(*) from public.valuation_snapshots),
  'sales', (select count(*) from public.sales),
  'cost_entries', (select count(*) from public.cost_entries),
  'attachments', (select count(*) from public.attachments),
  'rollback_safe', not exists (select 1 from public.shipments union all select 1 from public.repairs union all select 1 from public.valuation_snapshots union all select 1 from public.sales union all select 1 from public.cost_entries),
  'orders', (
    select json_agg(json_build_object(
      'id', purchase_order.id,
      'legacy_id', purchase_order.legacy_id,
      'vendor', purchase_order.vendor,
      'platform', purchase_order.platform,
      'order_reference', purchase_order.order_reference,
      'original_currency', purchase_order.original_currency,
      'ordered_at', purchase_order.ordered_at,
      'status', purchase_order.status,
      'original_subtotal_jpy', purchase_order.original_subtotal_jpy,
      'coupon_jpy', purchase_order.coupon_jpy,
      'fee_jpy', purchase_order.fee_jpy,
      'domestic_shipping_jpy', purchase_order.domestic_shipping_jpy,
      'exchange_rate_jpy_to_cny', purchase_order.exchange_rate_jpy_to_cny,
      'actual_paid_cny', purchase_order.actual_paid_cny,
      'allocation_method', purchase_order.allocation_method,
      'allocated_items_cny', coalesce((select sum(purchase_item.allocated_cost_cny) from public.purchase_items purchase_item where purchase_item.purchase_order_id = purchase_order.id), 0)
    ) order by purchase_order.legacy_id)
    from public.purchase_orders purchase_order
    where purchase_order.portfolio_id = ${sqlText(PORTFOLIO_ID)}::uuid
  ),
  'items', (
    select json_agg(json_build_object(
      'id', purchase_item.id,
      'legacy_id', purchase_item.legacy_id,
      'purchase_order_id', purchase_item.purchase_order_id,
      'order_legacy_id', purchase_order.legacy_id,
      'asset_id', purchase_item.asset_id,
      'asset_legacy_id', asset.legacy_id,
      'original_price_jpy', purchase_item.original_price_jpy,
      'allocation_method', purchase_item.allocation_method,
      'allocation_ratio', purchase_item.allocation_ratio,
      'allocated_cost_cny', purchase_item.allocated_cost_cny
    ) order by purchase_item.legacy_id)
    from public.purchase_items purchase_item
    join public.purchase_orders purchase_order on purchase_order.id = purchase_item.purchase_order_id
    join public.assets asset on asset.id = purchase_item.asset_id
    where purchase_item.portfolio_id = ${sqlText(PORTFOLIO_ID)}::uuid
  )
) as phase3b2_verification;`;
}

function buildRollbackSql({ plan, ownerId, migrationRunId, rolledBackAt, manifestSha256 }) {
  const orderLegacyIds = sqlTextArray(plan.orders.map(({ legacyId }) => legacyId));
  const itemLegacyIds = sqlTextArray(plan.items.map(({ legacyId }) => legacyId));
  return `begin;
set local lock_timeout = '10s';

do $rollback_preflight$
begin
  if not exists (select 1 from auth.users where id = ${sqlText(ownerId)}::uuid)
    or not exists (select 1 from public.portfolios where id = ${sqlText(PORTFOLIO_ID)}::uuid)
  then
    raise exception 'Confirmed owner or portfolio is missing';
  end if;

  if (select count(*) from public.shipments) <> 0
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
    raise exception 'Rollback refused because later-phase data exists';
  end if;

  if exists (
    select 1 from public.purchase_orders
    where portfolio_id <> ${sqlText(PORTFOLIO_ID)}::uuid
      or legacy_id is null
      or legacy_id <> all (${orderLegacyIds})
  ) or exists (
    select 1 from public.purchase_items
    where portfolio_id <> ${sqlText(PORTFOLIO_ID)}::uuid
      or legacy_id is null
      or legacy_id <> all (${itemLegacyIds})
  ) then
    raise exception 'Rollback refused because unrelated purchase data exists';
  end if;
end;
$rollback_preflight$;

delete from public.purchase_items
where portfolio_id = ${sqlText(PORTFOLIO_ID)}::uuid
  and legacy_id = any (${itemLegacyIds});

delete from public.purchase_orders
where portfolio_id = ${sqlText(PORTFOLIO_ID)}::uuid
  and legacy_id = any (${orderLegacyIds});

insert into public.audit_logs (
  id, portfolio_id, actor_id, action, entity_type, entity_id,
  before_data, after_data, occurred_at
) values (
  ${sqlText(migrationRunId)}::uuid,
  ${sqlText(PORTFOLIO_ID)}::uuid,
  ${sqlText(ownerId)}::uuid,
  'phase3b2_purchases_rollback',
  'migration_run',
  ${sqlText(migrationRunId)}::uuid,
  ${sqlText(JSON.stringify({
    purchaseOrderLegacyIds: plan.orders.map(({ legacyId }) => legacyId),
    purchaseItemLegacyIds: plan.items.map(({ legacyId }) => legacyId),
  }))}::jsonb,
  ${sqlText(JSON.stringify({
    phase: "3B-2 rollback",
    migrationRunId,
    rolledBackAt,
    sourceBackup: EXPECTED_BACKUP_NAME,
    sourceManifestSha256: manifestSha256,
    purchaseOrdersAfter: 0,
    purchaseItemsAfter: 0,
  }))}::jsonb,
  ${sqlText(rolledBackAt)}::timestamptz
);

do $rollback_postflight$
begin
  if (select count(*) from public.purchase_orders) <> 0
    or (select count(*) from public.purchase_items) <> 0
  then
    raise exception 'Phase 3B-2 rollback postflight verification failed';
  end if;
end;
$rollback_postflight$;

commit;

select json_build_object(
  'migration_run_id', ${sqlText(migrationRunId)}::uuid,
  'portfolio_id', ${sqlText(PORTFOLIO_ID)}::uuid,
  'purchase_order_count', (select count(*) from public.purchase_orders),
  'purchase_item_count', (select count(*) from public.purchase_items),
  'asset_count', (select count(*) from public.assets)
) as phase3b2_rollback;`;
}

function buildResultSelect(migrationRunId) {
  return `select json_build_object(
  'migration_run_id', ${sqlText(migrationRunId)}::uuid,
  'portfolio_id', ${sqlText(PORTFOLIO_ID)}::uuid,
  'purchase_order_count', (select count(*) from public.purchase_orders where portfolio_id = ${sqlText(PORTFOLIO_ID)}::uuid),
  'purchase_item_count', (select count(*) from public.purchase_items where portfolio_id = ${sqlText(PORTFOLIO_ID)}::uuid),
  'purchase_actual_paid_cny', (select sum(actual_paid_cny) from public.purchase_orders where portfolio_id = ${sqlText(PORTFOLIO_ID)}::uuid),
  'purchase_item_allocated_cny', (select sum(allocated_cost_cny) from public.purchase_items where portfolio_id = ${sqlText(PORTFOLIO_ID)}::uuid),
  'audit_log', (select json_build_object('id', id, 'action', action, 'before_data', before_data, 'after_data', after_data, 'occurred_at', occurred_at) from public.audit_logs where id = ${sqlText(migrationRunId)}::uuid)
) as phase3b2_import;`;
}

function assertVerification(result, plan) {
  const verification = result?.rows?.[0]?.phase3b2_verification;
  if (!verification || typeof verification !== "object") {
    throw new Error("Supabase verification response is missing phase3b2_verification");
  }
  const expectedCounts = {
    purchase_order_count: 4,
    purchase_item_count: 5,
    purchase_order_duplicate_legacy_count: 0,
    purchase_item_duplicate_legacy_count: 0,
    unexpected_purchase_order_count: 0,
    unexpected_purchase_item_count: 0,
    orphan_purchase_order_count: 0,
    orphan_purchase_item_order_count: 0,
    orphan_purchase_item_asset_count: 0,
    cross_portfolio_purchase_item_count: 0,
    shipments: 0,
    shipment_items: 0,
    tracking_events: 0,
    tracking_sync_runs: 0,
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
    throw new Error(`Phase 3B-2 count verification failed: ${JSON.stringify(differences)}`);
  }
  if (verification.rollback_safe !== true) {
    throw new Error("Rollback preconditions are not currently safe");
  }
  assertAmount(verification.purchase_actual_paid_cny, EXPECTED_PURCHASE_TOTAL_CNY, "purchase actual paid total");
  assertAmount(verification.purchase_item_allocated_cny, EXPECTED_PURCHASE_TOTAL_CNY, "purchase item allocated total");

  const actualOrders = verification.orders ?? [];
  const actualItems = verification.items ?? [];
  if (actualOrders.length !== plan.orders.length || actualItems.length !== plan.items.length) {
    throw new Error("Detailed purchase mappings have an unexpected row count");
  }

  const actualOrdersByLegacyId = new Map(actualOrders.map((order) => [order.legacy_id, order]));
  for (const expected of plan.orders) {
    const actual = actualOrdersByLegacyId.get(expected.legacyId);
    if (!actual) throw new Error(`Missing target purchase order ${expected.legacyId}`);
    assertEqual(actual.id, expected.id, `${expected.legacyId}.id`);
    assertEqual(actual.vendor, expected.vendor, `${expected.legacyId}.vendor`);
    assertEqual(actual.platform, expected.platform, `${expected.legacyId}.platform`);
    assertEqual(actual.order_reference, expected.orderReference, `${expected.legacyId}.order_reference`);
    assertEqual(actual.original_currency, expected.originalCurrency, `${expected.legacyId}.original_currency`);
    assertSameInstant(actual.ordered_at, expected.orderedAt, `${expected.legacyId}.ordered_at`);
    assertEqual(actual.status, expected.status, `${expected.legacyId}.status`);
    assertAmount(actual.original_subtotal_jpy, expected.originalSubtotalJpy, `${expected.legacyId}.original_subtotal_jpy`);
    assertAmount(actual.coupon_jpy, expected.couponJpy, `${expected.legacyId}.coupon_jpy`);
    assertAmount(actual.fee_jpy, expected.feeJpy, `${expected.legacyId}.fee_jpy`);
    assertAmount(actual.domestic_shipping_jpy, expected.domesticShippingJpy, `${expected.legacyId}.domestic_shipping_jpy`);
    assertAmount(actual.exchange_rate_jpy_to_cny, expected.exchangeRateJpyToCny, `${expected.legacyId}.exchange_rate`);
    assertAmount(actual.actual_paid_cny, expected.actualPaidCny, `${expected.legacyId}.actual_paid_cny`);
    assertAmount(actual.allocated_items_cny, expected.actualPaidCny, `${expected.legacyId}.allocated_items_cny`);
    assertEqual(actual.allocation_method, expected.allocationMethod, `${expected.legacyId}.allocation_method`);
  }

  const actualItemsByLegacyId = new Map(actualItems.map((item) => [item.legacy_id, item]));
  for (const expected of plan.items) {
    const actual = actualItemsByLegacyId.get(expected.legacyId);
    if (!actual) throw new Error(`Missing target purchase item ${expected.legacyId}`);
    assertEqual(actual.id, expected.id, `${expected.legacyId}.id`);
    assertEqual(actual.order_legacy_id, expected.orderLegacyId, `${expected.legacyId}.order_legacy_id`);
    assertEqual(actual.asset_legacy_id, expected.assetLegacyId, `${expected.legacyId}.asset_legacy_id`);
    assertAmount(actual.original_price_jpy, expected.originalPriceJpy, `${expected.legacyId}.original_price_jpy`);
    assertEqual(actual.allocation_method, expected.allocationMethod, `${expected.legacyId}.allocation_method`);
    assertAmount(actual.allocation_ratio, expected.allocationRatio, `${expected.legacyId}.allocation_ratio`);
    assertAmount(actual.allocated_cost_cny, expected.allocatedCostCny, `${expected.legacyId}.allocated_cost_cny`);
  }

  return verification;
}

function runRemoteSql(sql) {
  const temporaryDirectory = mkdtempSync(join(tmpdir(), "lensfolio-phase3b2-"));
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

function dryRunOrder(order) {
  return {
    id: order.id,
    legacyId: order.legacyId,
    vendor: order.vendor,
    platform: order.platform,
    orderReference: order.orderReference,
    originalCurrency: order.originalCurrency,
    orderedAt: order.orderedAt,
    originalSubtotalJpy: order.originalSubtotalJpy,
    couponJpy: order.couponJpy,
    feeJpy: order.feeJpy,
    feeComponentsJpy: order.feeComponentsJpy,
    domesticShippingJpy: order.domesticShippingJpy,
    sourceTotalJpy: order.sourceTotalJpy,
    exchangeRateJpyToCny: order.exchangeRateJpyToCny,
    actualPaidCny: order.actualPaidCny,
    allocationMethod: order.allocationMethod,
  };
}

function dryRunItem(item) {
  return {
    id: item.id,
    legacyId: item.legacyId,
    orderLegacyId: item.orderLegacyId,
    assetLegacyId: item.assetLegacyId,
    originalPriceJpy: item.originalPriceJpy,
    allocationMethod: item.allocationMethod,
    allocationRatio: item.allocationRatio,
    allocatedCostCny: item.allocatedCostCny,
    allocationNote: item.allocationNote,
  };
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

function mapPurchaseStatus(value) {
  const mapping = new Map([["已付款", "paid"]]);
  const mapped = mapping.get(value);
  if (!mapped) throw new Error(`Unsupported purchase status: ${value}`);
  return mapped;
}

function legacyTimestamp(value) {
  const stringValue = text(value, "timestamp");
  if (/([zZ]|[+-]\d\d:\d\d)$/.test(stringValue)) return stringValue;
  return `${stringValue.replace(" ", "T")}+08:00`;
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

function finiteNumber(value, name) {
  const result = Number(value);
  if (!Number.isFinite(result)) throw new Error(`${name} must be a finite number`);
  return result;
}

function nonnegativeNumber(value, name) {
  const result = finiteNumber(value, name);
  if (result < 0) throw new Error(`${name} must be nonnegative`);
  return result;
}

function positiveNumber(value, name) {
  const result = finiteNumber(value, name);
  if (result <= 0) throw new Error(`${name} must be positive`);
  return result;
}

function sum(values) {
  return values.reduce((total, value) => total + value, 0);
}

function withinTolerance(left, right, tolerance) {
  return Math.abs(Number(left) - Number(right)) <= tolerance;
}

function assertAmount(actual, expected, name) {
  if (!withinTolerance(actual, expected, AMOUNT_TOLERANCE_CNY)) {
    throw new Error(`${name} mismatch: expected ${expected}, got ${actual}`);
  }
}

function assertEqual(actual, expected, name) {
  if (actual !== expected) throw new Error(`${name} mismatch: expected ${expected}, got ${actual}`);
}

function assertSameInstant(actual, expected, name) {
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
  node scripts/import-purchases-phase3b2.mjs --backup <backup-directory>
  node scripts/import-purchases-phase3b2.mjs --backup <backup-directory> --apply
  node scripts/import-purchases-phase3b2.mjs --backup <backup-directory> --verify
  node scripts/import-purchases-phase3b2.mjs --backup <backup-directory> --rollback --confirm-rollback

The default mode validates the complete frozen backup and prints a dry-run plan
without connecting to Supabase. Apply performs one atomic, idempotent transaction
and records migration_run_id in audit_logs. Verify is read-only. Rollback removes
only the Phase 3B-2 purchase rows, refuses to run after later-phase imports, and
requires the explicit --confirm-rollback guard.`);
}
