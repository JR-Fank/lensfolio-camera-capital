import { env } from "cloudflare:workers";
import { isMigrationReadOnly } from "../lib/migration-protection";
import { getD1 } from ".";

export type AssetView = {
  id: string;
  brand: string;
  model: string;
  variant: string | null;
  serialNumber: string | null;
  purchasePlatform: string | null;
  purchaseSeller: string | null;
  purchaseOrderRef: string | null;
  paymentMethod: string | null;
  paidAt: string | null;
  weightG: number;
  acquiredAt: string;
  lifecycleStatus: string;
  repairStatus: string;
  conditionGrade: string | null;
  notes: string | null;
  purchaseJpy: number;
  purchaseCny: number;
  exchangeRate: number;
  domesticShippingJpy: number;
  domesticShippingCny: number;
  internationalShippingCny: number;
  pendingShippingCny?: number;
  shippingEstimated: boolean;
  repairCny: number;
  otherCostCny: number;
  trueCost: number;
  valuationSource: string;
  valuationDate: string | null;
  valuationKeyword: string | null;
  valuationSampleSize: number | null;
  valuationCondition: string | null;
  valuationConfidence: number;
  valuationCollectionMethod: string;
  marketLowCny: number | null;
  marketMedianCny: number | null;
  marketHighCny: number | null;
  expectedSaleCny: number | null;
  conservativeProfit: number | null;
  normalProfit: number | null;
  optimisticProfit: number | null;
  roi: number | null;
  holdingDays: number;
};

export type LogisticsEventView = {
  id: string;
  logisticsOrderId: string;
  occurredAt: string;
  rawStatus: string;
  statusLabel: string;
  details: string | null;
  office: string | null;
  country: string | null;
  postalCode: string | null;
};

export type LogisticsAllocationView = {
  logisticsOrderId: string;
  cameraId: string;
  cameraName: string;
  weightG: number | null;
  allocatedShippingCny: number;
  actualAllocatedShippingCny?: number | null;
  budgetAllocatedShippingCny?: number | null;
};

export type LogisticsView = {
  id: string;
  batchCode: string;
  carrier: string;
  trackingNumber: string | null;
  origin: string;
  destination: string;
  status: string;
  latestEvent: string | null;
  estimatedArrivalAt: string | null;
  sellerShippedAt: string | null;
  warehouseInAt: string | null;
  internationalShippedAt: string | null;
  hongKongArrivedAt: string | null;
  deliveredAt: string | null;
  bareWeightG: number | null;
  chargeableWeightG: number | null;
  shippingJpy: number;
  shippingCny: number;
  allocationMethod: string;
  isEstimated: boolean;
  lastCheckedAt: string | null;
  trackingSource: string | null;
  trackingError: string | null;
  anomaly: string | null;
  notes: string | null;
  itemCount: number;
  cameraNames: string;
  totalTransitDays: number | null;
  costPerKg: number | null;
  costPerCamera: number;
  allocations: LogisticsAllocationView[];
  events: LogisticsEventView[];
};

export type RepairView = {
  id: string;
  cameraId: string;
  cameraName: string;
  repairDate: string;
  problem: string;
  workPerformed: string;
  costCny: number;
  vendor: string | null;
  resultingStatus: string;
  valueBeforeCny: number;
  valueAfterCny: number;
  valueChangeCny: number;
  notes: string | null;
};

export type SaleView = {
  id: string;
  cameraId: string;
  cameraName: string;
  platform: string;
  status: string;
  listedAt: string | null;
  soldAt: string | null;
  askingPriceCny: number | null;
  marketPriceCny: number | null;
  actualPriceCny: number | null;
  grossProceedsCny: number | null;
  netProceedsCny: number | null;
  platformFeeCny: number;
  shippingCny: number;
  carryingCostCny: number;
  finalProfit: number;
  realizedRoi: number | null;
  holdingDays: number;
};

export type ExpenseView = {
  id: string;
  cameraId: string;
  cameraName: string;
  expenseDate: string;
  category: string;
  amountCny: number;
  notes: string | null;
};

export type ValuationHistoryView = {
  id: string;
  cameraId: string;
  cameraName: string;
  source: string;
  keyword: string | null;
  valuedAt: string;
  lowCny: number;
  medianCny: number;
  highCny: number;
  expectedCny: number;
  sampleSize: number | null;
  confidence: number;
  collectionMethod: string;
};

export type DashboardData = {
  dataSource?: "baseline" | "cloudflare-d1" | "supabase";
  migrationReadOnly: boolean;
  summary: {
    totalInvested: number;
    projectedCostBasis: number;
    assetCount: number;
    totalAssetCount: number;
    heldAssetCount: number;
    soldAssetCount: number;
    heldCarryingCost: number;
    currentMarketValue: number | null;
    unrealizedProfit: number | null;
    roi: number | null;
    valuedAssetCount: number;
    valuedAssetCarryingCost: number | null;
    valuationCoverageComplete: boolean;
    portfolioRoi: number | null;
    averageHoldingDays: number;
    logisticsCost: number;
    estimatedLogisticsCost: number;
    repairCost: number;
    otherCost: number;
    realizedProfit: number;
    realizedRoi: number | null;
    totalProfit: number | null;
  };
  assets: AssetView[];
  logistics: LogisticsView[];
  repairs: RepairView[];
  sales: SaleView[];
  expenses: ExpenseView[];
  valuationHistory: ValuationHistoryView[];
  refreshedAt: string;
};

type AssetRow = Omit<AssetView,
  "shippingEstimated" | "trueCost" | "conservativeProfit" | "normalProfit" | "optimisticProfit" | "roi"
> & { shippingEstimated: number };

export async function getDashboardData(): Promise<DashboardData> {
  const db = getD1();

  const [assetResult, logisticsResult, allocationResult, eventResult, repairResult, salesResult, expenseResult, valuationResult, investmentRow] = await Promise.all([
    db.prepare(`
      WITH latest_valuation AS (
        SELECT *, ROW_NUMBER() OVER (PARTITION BY camera_id ORDER BY valued_at DESC, created_at DESC) AS position
        FROM market_valuations
      )
      SELECT
        c.id, c.brand, c.model, c.variant, c.serial_number AS serialNumber,
        c.purchase_platform AS purchasePlatform, c.weight_g AS weightG,
        c.acquired_at AS acquiredAt, c.lifecycle_status AS lifecycleStatus,
        c.repair_status AS repairStatus, c.condition_grade AS conditionGrade, c.notes,
        (SELECT po.seller FROM purchase_order_items poi JOIN purchase_orders po ON po.id = poi.order_id WHERE poi.camera_id = c.id ORDER BY po.purchased_at DESC LIMIT 1) AS purchaseSeller,
        (SELECT po.order_ref FROM purchase_order_items poi JOIN purchase_orders po ON po.id = poi.order_id WHERE poi.camera_id = c.id ORDER BY po.purchased_at DESC LIMIT 1) AS purchaseOrderRef,
        (SELECT po.payment_method FROM purchase_order_items poi JOIN purchase_orders po ON po.id = poi.order_id WHERE poi.camera_id = c.id ORDER BY po.purchased_at DESC LIMIT 1) AS paymentMethod,
        (SELECT po.paid_at FROM purchase_order_items poi JOIN purchase_orders po ON po.id = poi.order_id WHERE poi.camera_id = c.id ORDER BY po.purchased_at DESC LIMIT 1) AS paidAt,
        COALESCE((SELECT SUM(poi.item_price_jpy) FROM purchase_order_items poi WHERE poi.camera_id = c.id), 0) AS purchaseJpy,
        COALESCE((SELECT SUM(poi.allocated_paid_cny) FROM purchase_order_items poi WHERE poi.camera_id = c.id), 0) AS purchaseCny,
        COALESCE((SELECT po.exchange_rate FROM purchase_order_items poi JOIN purchase_orders po ON po.id = poi.order_id WHERE poi.camera_id = c.id ORDER BY po.purchased_at DESC LIMIT 1), 0) AS exchangeRate,
        COALESCE((SELECT SUM(poi.allocated_domestic_shipping_jpy) FROM purchase_order_items poi WHERE poi.camera_id = c.id), 0) AS domesticShippingJpy,
        COALESCE((SELECT SUM(poi.allocated_domestic_shipping_jpy * po.exchange_rate) FROM purchase_order_items poi JOIN purchase_orders po ON po.id = poi.order_id WHERE poi.camera_id = c.id), 0) AS domesticShippingCny,
        COALESCE((SELECT SUM(li.allocated_shipping_cny) FROM logistics_items li WHERE li.camera_id = c.id), 0) AS internationalShippingCny,
        COALESCE((SELECT MAX(lo.is_estimated) FROM logistics_items li JOIN logistics_orders lo ON lo.id = li.logistics_order_id WHERE li.camera_id = c.id), 0) AS shippingEstimated,
        COALESCE((SELECT SUM(rr.cost_cny) FROM repair_records rr WHERE rr.camera_id = c.id), 0) AS repairCny,
        COALESCE((SELECT SUM(ae.amount_cny) FROM asset_expenses ae WHERE ae.camera_id = c.id), 0) AS otherCostCny,
        COALESCE(lv.source, '待估价') AS valuationSource,
        lv.valued_at AS valuationDate, lv.keyword AS valuationKeyword,
        COALESCE(lv.sample_size, 0) AS valuationSampleSize,
        lv.condition_grade AS valuationCondition,
        COALESCE(lv.confidence, 0) AS valuationConfidence,
        COALESCE(lv.collection_method, '人工录入') AS valuationCollectionMethod,
        COALESCE(lv.low_cny, 0) AS marketLowCny,
        COALESCE(NULLIF(lv.median_cny, 0), lv.average_cny, 0) AS marketMedianCny,
        COALESCE(NULLIF(lv.high_cny, 0), lv.premium_cny, 0) AS marketHighCny,
        COALESCE(NULLIF(lv.expected_cny, 0), NULLIF(lv.median_cny, 0), lv.average_cny, 0) AS expectedSaleCny,
        MAX(0, CAST(julianday('now') - julianday(c.acquired_at) AS INTEGER)) AS holdingDays
      FROM cameras c
      LEFT JOIN latest_valuation lv ON lv.camera_id = c.id AND lv.position = 1
      ORDER BY c.acquired_at ASC, c.created_at ASC
    `).all<AssetRow>(),
    db.prepare(`
      SELECT
        lo.id, lo.batch_code AS batchCode, lo.carrier, lo.tracking_number AS trackingNumber,
        lo.origin, lo.destination, lo.status, lo.latest_event AS latestEvent,
        lo.estimated_arrival_at AS estimatedArrivalAt, lo.seller_shipped_at AS sellerShippedAt,
        lo.warehouse_in_at AS warehouseInAt, lo.international_shipped_at AS internationalShippedAt,
        lo.hong_kong_arrived_at AS hongKongArrivedAt, lo.delivered_at AS deliveredAt,
        lo.bare_weight_g AS bareWeightG, lo.chargeable_weight_g AS chargeableWeightG,
        lo.shipping_jpy AS shippingJpy, lo.shipping_cny + lo.handling_cny AS shippingCny,
        lo.allocation_method AS allocationMethod, lo.is_estimated AS isEstimated,
        lo.last_checked_at AS lastCheckedAt, lo.tracking_source AS trackingSource,
        lo.tracking_error AS trackingError, lo.notes,
        COUNT(li.id) AS itemCount,
        COALESCE(GROUP_CONCAT(c.brand || ' ' || c.model, ' · '), '') AS cameraNames,
        CASE WHEN lo.international_shipped_at IS NOT NULL THEN ROUND(
          julianday(COALESCE(lo.delivered_at, (SELECT MAX(le.occurred_at) FROM logistics_events le WHERE le.logistics_order_id = lo.id), lo.hong_kong_arrived_at))
          - julianday(lo.international_shipped_at), 2
        ) ELSE NULL END AS totalTransitDays,
        CASE
          WHEN lo.tracking_error IS NOT NULL THEN lo.tracking_error
          WHEN lo.tracking_number IS NOT NULL AND lo.status NOT IN ('已签收', '已领取')
            AND lo.last_checked_at IS NOT NULL AND julianday('now') - julianday(lo.last_checked_at) > 2
          THEN '超过 48 小时未刷新'
          WHEN lo.estimated_arrival_at IS NOT NULL AND julianday('now') > julianday(lo.estimated_arrival_at)
            AND lo.status NOT IN ('已签收', '已领取')
          THEN '已超过预计到达时间'
          ELSE NULL
        END AS anomaly
      FROM logistics_orders lo
      LEFT JOIN logistics_items li ON li.logistics_order_id = lo.id
      LEFT JOIN cameras c ON c.id = li.camera_id
      GROUP BY lo.id
      ORDER BY lo.batch_code DESC
    `).all<Omit<LogisticsView, "events" | "allocations" | "costPerKg" | "costPerCamera">>(),
    db.prepare(`
      SELECT li.logistics_order_id AS logisticsOrderId, li.camera_id AS cameraId,
        c.brand || ' ' || c.model AS cameraName, li.weight_g AS weightG,
        li.allocated_shipping_cny AS allocatedShippingCny
      FROM logistics_items li
      JOIN cameras c ON c.id = li.camera_id
      ORDER BY li.logistics_order_id, li.allocated_shipping_cny DESC
    `).all<LogisticsAllocationView>(),
    db.prepare(`
      SELECT id, logistics_order_id AS logisticsOrderId, occurred_at AS occurredAt,
        raw_status AS rawStatus, status_label AS statusLabel, details, office, country,
        postal_code AS postalCode
      FROM logistics_events
      ORDER BY occurred_at ASC
    `).all<LogisticsEventView>(),
    db.prepare(`
      SELECT rr.id, rr.camera_id AS cameraId, c.brand || ' ' || c.model AS cameraName,
        rr.repair_date AS repairDate, rr.problem, rr.work_performed AS workPerformed,
        rr.cost_cny AS costCny, rr.vendor, rr.resulting_status AS resultingStatus,
        rr.value_before_cny AS valueBeforeCny, rr.value_after_cny AS valueAfterCny,
        rr.value_after_cny - rr.value_before_cny AS valueChangeCny, rr.notes
      FROM repair_records rr
      JOIN cameras c ON c.id = rr.camera_id
      ORDER BY rr.repair_date DESC, rr.created_at DESC
    `).all<RepairView>(),
    db.prepare(`
      SELECT sr.id, sr.camera_id AS cameraId, c.brand || ' ' || c.model AS cameraName,
        sr.platform, sr.status, sr.listed_at AS listedAt, sr.sold_at AS soldAt,
        sr.asking_price_cny AS askingPriceCny, sr.market_price_cny AS marketPriceCny,
        sr.actual_price_cny AS actualPriceCny, sr.platform_fee_cny AS platformFeeCny,
        sr.shipping_cny AS shippingCny,
        sr.actual_price_cny - sr.platform_fee_cny - sr.shipping_cny
          - COALESCE((SELECT SUM(poi.allocated_paid_cny) FROM purchase_order_items poi WHERE poi.camera_id = sr.camera_id), 0)
          - COALESCE((SELECT SUM(li.allocated_shipping_cny) FROM logistics_items li WHERE li.camera_id = sr.camera_id), 0)
          - COALESCE((SELECT SUM(rr.cost_cny) FROM repair_records rr WHERE rr.camera_id = sr.camera_id), 0)
          - COALESCE((SELECT SUM(ae.amount_cny) FROM asset_expenses ae WHERE ae.camera_id = sr.camera_id), 0)
          AS finalProfit
      FROM sales_records sr
      JOIN cameras c ON c.id = sr.camera_id
      ORDER BY COALESCE(sr.sold_at, sr.listed_at, sr.created_at) DESC
    `).all<SaleView>(),
    db.prepare(`
      SELECT ae.id, ae.camera_id AS cameraId, c.brand || ' ' || c.model AS cameraName,
        ae.expense_date AS expenseDate, ae.category, ae.amount_cny AS amountCny, ae.notes
      FROM asset_expenses ae JOIN cameras c ON c.id = ae.camera_id
      ORDER BY ae.expense_date DESC, ae.created_at DESC
    `).all<ExpenseView>(),
    db.prepare(`
      SELECT mv.id, mv.camera_id AS cameraId, c.brand || ' ' || c.model AS cameraName,
        mv.source, mv.keyword, mv.valued_at AS valuedAt, mv.low_cny AS lowCny,
        COALESCE(NULLIF(mv.median_cny, 0), mv.average_cny) AS medianCny,
        COALESCE(NULLIF(mv.high_cny, 0), mv.premium_cny) AS highCny,
        mv.expected_cny AS expectedCny, COALESCE(mv.sample_size, 0) AS sampleSize,
        mv.confidence, mv.collection_method AS collectionMethod
      FROM market_valuations mv JOIN cameras c ON c.id = mv.camera_id
      ORDER BY mv.valued_at ASC, mv.created_at ASC
    `).all<ValuationHistoryView>(),
    db.prepare(`
      SELECT
        COALESCE((SELECT SUM(paid_cny) FROM purchase_orders), 0)
          + COALESCE((SELECT SUM(shipping_cny + handling_cny) FROM logistics_orders WHERE is_estimated = 0), 0)
          + COALESCE((SELECT SUM(cost_cny) FROM repair_records), 0)
          + COALESCE((SELECT SUM(amount_cny) FROM asset_expenses), 0) AS totalInvested,
        COALESCE((SELECT SUM(shipping_cny + handling_cny) FROM logistics_orders), 0) AS logisticsCost,
        COALESCE((SELECT SUM(shipping_cny + handling_cny) FROM logistics_orders WHERE is_estimated = 1), 0) AS estimatedLogisticsCost,
        COALESCE((SELECT SUM(cost_cny) FROM repair_records), 0) AS repairCost,
        COALESCE((SELECT SUM(amount_cny) FROM asset_expenses), 0) AS otherCost,
        COALESCE((SELECT SUM(actual_price_cny - platform_fee_cny - shipping_cny) FROM sales_records WHERE status = '已出售'), 0) AS realizedNetProceeds
    `).first<{ totalInvested: number; logisticsCost: number; estimatedLogisticsCost: number; repairCost: number; otherCost: number; realizedNetProceeds: number }>(),
  ]);

  const assets = assetResult.results.map((row) => {
    const purchaseCny = Number(row.purchaseCny);
    const internationalShippingCny = Number(row.internationalShippingCny);
    const repairCny = Number(row.repairCny);
    const otherCostCny = Number(row.otherCostCny);
    const trueCost = purchaseCny + internationalShippingCny + repairCny + otherCostCny;
    const marketLowCny = Number(row.marketLowCny);
    const marketMedianCny = Number(row.marketMedianCny);
    const marketHighCny = Number(row.marketHighCny);
    const expectedSaleCny = Number(row.expectedSaleCny);
    return {
      ...row,
      weightG: Number(row.weightG),
      purchaseJpy: Number(row.purchaseJpy),
      purchaseCny,
      exchangeRate: Number(row.exchangeRate),
      domesticShippingJpy: Number(row.domesticShippingJpy),
      domesticShippingCny: Number(row.domesticShippingCny),
      internationalShippingCny,
      shippingEstimated: Boolean(row.shippingEstimated),
      repairCny,
      otherCostCny,
      valuationSampleSize: Number(row.valuationSampleSize),
      valuationConfidence: Number(row.valuationConfidence),
      marketLowCny,
      marketMedianCny,
      marketHighCny,
      expectedSaleCny,
      holdingDays: Number(row.holdingDays),
      trueCost,
      conservativeProfit: marketLowCny - trueCost,
      normalProfit: marketMedianCny - trueCost,
      optimisticProfit: marketHighCny - trueCost,
      roi: trueCost ? (marketMedianCny - trueCost) / trueCost * 100 : 0,
    } satisfies AssetView;
  });

  const eventsByOrder = new Map<string, LogisticsEventView[]>();
  for (const event of eventResult.results) {
    const events = eventsByOrder.get(event.logisticsOrderId) ?? [];
    events.push(event);
    eventsByOrder.set(event.logisticsOrderId, events);
  }
  const allocationsByOrder = new Map<string, LogisticsAllocationView[]>();
  for (const row of allocationResult.results) {
    const allocations = allocationsByOrder.get(row.logisticsOrderId) ?? [];
    allocations.push({ ...row, weightG: Number(row.weightG), allocatedShippingCny: Number(row.allocatedShippingCny) });
    allocationsByOrder.set(row.logisticsOrderId, allocations);
  }

  const logistics = logisticsResult.results.map((row) => ({
    ...row,
    bareWeightG: Number(row.bareWeightG),
    chargeableWeightG: Number(row.chargeableWeightG),
    shippingJpy: Number(row.shippingJpy),
    shippingCny: Number(row.shippingCny),
    isEstimated: Boolean(row.isEstimated),
    itemCount: Number(row.itemCount),
    totalTransitDays: row.totalTransitDays === null ? null : Number(row.totalTransitDays),
    costPerKg: Number(row.chargeableWeightG) ? Number(row.shippingCny) / (Number(row.chargeableWeightG) / 1000) : 0,
    costPerCamera: Number(row.itemCount) ? Number(row.shippingCny) / Number(row.itemCount) : 0,
    allocations: allocationsByOrder.get(row.id) ?? [],
    events: eventsByOrder.get(row.id) ?? [],
  })) satisfies LogisticsView[];

  const activeAssets = assets.filter((asset) => asset.lifecycleStatus !== "已出售");
  const projectedCostBasis = activeAssets.reduce((sum, asset) => sum + asset.trueCost, 0);
  const valuedAssets = activeAssets.filter((asset) => asset.marketMedianCny !== null);
  const valuedAssetCarryingCost = valuedAssets.length
    ? valuedAssets.reduce((sum, asset) => sum + asset.trueCost, 0)
    : null;
  const currentMarketValue = valuedAssets.length
    ? valuedAssets.reduce((sum, asset) => sum + (asset.marketMedianCny ?? 0), 0)
    : null;
  const unrealizedProfit = currentMarketValue === null || valuedAssetCarryingCost === null
    ? null
    : currentMarketValue - valuedAssetCarryingCost;
  const valuedAssetsRoi = unrealizedProfit === null || !valuedAssetCarryingCost
    ? null
    : unrealizedProfit / valuedAssetCarryingCost * 100;
  const valuationCoverageComplete = valuedAssets.length === activeAssets.length;
  const soldCost = assets.filter((asset) => asset.lifecycleStatus === "已出售").reduce((sum, asset) => sum + asset.trueCost, 0);
  const realizedProfit = Number(investmentRow?.realizedNetProceeds ?? 0) - soldCost;
  const totalProfit = unrealizedProfit === null ? null : unrealizedProfit + realizedProfit;

  return {
    migrationReadOnly: isMigrationReadOnly(env),
    summary: {
      totalInvested: Number(investmentRow?.totalInvested ?? 0),
      projectedCostBasis,
      assetCount: assets.length,
      totalAssetCount: assets.length,
      heldAssetCount: activeAssets.length,
      soldAssetCount: assets.length - activeAssets.length,
      heldCarryingCost: projectedCostBasis,
      currentMarketValue,
      unrealizedProfit,
      roi: valuedAssetsRoi,
      valuedAssetCount: valuedAssets.length,
      valuedAssetCarryingCost,
      valuationCoverageComplete,
      portfolioRoi: valuationCoverageComplete ? valuedAssetsRoi : null,
      averageHoldingDays: activeAssets.length ? activeAssets.reduce((sum, asset) => sum + asset.holdingDays, 0) / activeAssets.length : 0,
      logisticsCost: Number(investmentRow?.logisticsCost ?? 0),
      estimatedLogisticsCost: Number(investmentRow?.estimatedLogisticsCost ?? 0),
      repairCost: Number(investmentRow?.repairCost ?? 0),
      otherCost: Number(investmentRow?.otherCost ?? 0),
      realizedProfit,
      realizedRoi: soldCost ? realizedProfit / soldCost * 100 : null,
      totalProfit,
    },
    assets,
    logistics,
    repairs: repairResult.results.map((row) => ({
      ...row,
      costCny: Number(row.costCny),
      valueBeforeCny: Number(row.valueBeforeCny),
      valueAfterCny: Number(row.valueAfterCny),
      valueChangeCny: Number(row.valueChangeCny),
    })),
    sales: salesResult.results.map((row) => ({
      ...row,
      askingPriceCny: Number(row.askingPriceCny),
      marketPriceCny: Number(row.marketPriceCny),
      actualPriceCny: Number(row.actualPriceCny),
      grossProceedsCny: Number(row.actualPriceCny),
      netProceedsCny: Number(row.actualPriceCny) - Number(row.platformFeeCny) - Number(row.shippingCny),
      platformFeeCny: Number(row.platformFeeCny),
      shippingCny: Number(row.shippingCny),
      carryingCostCny: Number(row.actualPriceCny) - Number(row.platformFeeCny) - Number(row.shippingCny) - Number(row.finalProfit),
      finalProfit: Number(row.finalProfit),
      realizedRoi: Number(row.actualPriceCny) - Number(row.platformFeeCny) - Number(row.shippingCny) - Number(row.finalProfit)
        ? Number(row.finalProfit) / (Number(row.actualPriceCny) - Number(row.platformFeeCny) - Number(row.shippingCny) - Number(row.finalProfit)) * 100
        : null,
      holdingDays: 0,
    })),
    expenses: expenseResult.results.map((row) => ({ ...row, amountCny: Number(row.amountCny) })),
    valuationHistory: valuationResult.results.map((row) => ({
      ...row,
      lowCny: Number(row.lowCny),
      medianCny: Number(row.medianCny),
      highCny: Number(row.highCny),
      expectedCny: Number(row.expectedCny),
      sampleSize: Number(row.sampleSize),
      confidence: Number(row.confidence),
    })),
    refreshedAt: new Date().toISOString(),
  };
}

export async function getCameraById(id: string) {
  const data = await getDashboardData();
  return data.assets.find((asset) => asset.id === id) ?? null;
}
