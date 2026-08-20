import { getD1 } from ".";

export type AssetView = {
  id: string;
  brand: string;
  model: string;
  variant: string | null;
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
  shippingEstimated: boolean;
  repairCny: number;
  trueCost: number;
  valuationSource: string;
  valuationDate: string | null;
  marketLowCny: number;
  marketAverageCny: number;
  marketPremiumCny: number;
  expectedSaleCny: number;
  conservativeProfit: number;
  normalProfit: number;
  optimisticProfit: number;
  roi: number;
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
  bareWeightG: number;
  chargeableWeightG: number;
  shippingJpy: number;
  shippingCny: number;
  isEstimated: boolean;
  lastCheckedAt: string | null;
  trackingSource: string | null;
  trackingError: string | null;
  notes: string | null;
  itemCount: number;
  cameraNames: string;
  totalTransitDays: number | null;
  costPerKg: number;
  costPerCamera: number;
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
  askingPriceCny: number;
  actualPriceCny: number;
  platformFeeCny: number;
  shippingCny: number;
  finalProfit: number;
};

export type DashboardData = {
  summary: {
    totalInvested: number;
    projectedCostBasis: number;
    assetCount: number;
    currentMarketValue: number;
    unrealizedProfit: number;
    roi: number;
    averageHoldingDays: number;
    logisticsCost: number;
    estimatedLogisticsCost: number;
    repairCost: number;
    realizedProfit: number;
  };
  assets: AssetView[];
  logistics: LogisticsView[];
  repairs: RepairView[];
  sales: SaleView[];
  refreshedAt: string;
};

type AssetRow = Omit<AssetView,
  "shippingEstimated" | "trueCost" | "conservativeProfit" | "normalProfit" | "optimisticProfit" | "roi"
> & { shippingEstimated: number };

export async function getDashboardData(): Promise<DashboardData> {
  const db = getD1();

  const [assetResult, logisticsResult, eventResult, repairResult, salesResult, investmentRow] = await Promise.all([
    db.prepare(`
      SELECT
        c.id, c.brand, c.model, c.variant, c.acquired_at AS acquiredAt,
        c.lifecycle_status AS lifecycleStatus, c.repair_status AS repairStatus,
        c.condition_grade AS conditionGrade, c.notes,
        COALESCE((SELECT SUM(poi.item_price_jpy) FROM purchase_order_items poi WHERE poi.camera_id = c.id), 0) AS purchaseJpy,
        COALESCE((SELECT SUM(poi.allocated_paid_cny) FROM purchase_order_items poi WHERE poi.camera_id = c.id), 0) AS purchaseCny,
        COALESCE((SELECT po.exchange_rate FROM purchase_order_items poi JOIN purchase_orders po ON po.id = poi.order_id WHERE poi.camera_id = c.id ORDER BY po.purchased_at DESC LIMIT 1), 0) AS exchangeRate,
        COALESCE((SELECT SUM(poi.allocated_domestic_shipping_jpy) FROM purchase_order_items poi WHERE poi.camera_id = c.id), 0) AS domesticShippingJpy,
        COALESCE((SELECT SUM(poi.allocated_domestic_shipping_jpy * po.exchange_rate) FROM purchase_order_items poi JOIN purchase_orders po ON po.id = poi.order_id WHERE poi.camera_id = c.id), 0) AS domesticShippingCny,
        COALESCE((SELECT SUM(li.allocated_shipping_cny) FROM logistics_items li WHERE li.camera_id = c.id), 0) AS internationalShippingCny,
        COALESCE((SELECT MAX(lo.is_estimated) FROM logistics_items li JOIN logistics_orders lo ON lo.id = li.logistics_order_id WHERE li.camera_id = c.id), 0) AS shippingEstimated,
        COALESCE((SELECT SUM(rr.cost_cny) FROM repair_records rr WHERE rr.camera_id = c.id), 0) AS repairCny,
        COALESCE((SELECT mv.source FROM market_valuations mv WHERE mv.camera_id = c.id ORDER BY mv.valued_at DESC, mv.created_at DESC LIMIT 1), '待估价') AS valuationSource,
        (SELECT mv.valued_at FROM market_valuations mv WHERE mv.camera_id = c.id ORDER BY mv.valued_at DESC, mv.created_at DESC LIMIT 1) AS valuationDate,
        COALESCE((SELECT mv.low_cny FROM market_valuations mv WHERE mv.camera_id = c.id ORDER BY mv.valued_at DESC, mv.created_at DESC LIMIT 1), 0) AS marketLowCny,
        COALESCE((SELECT mv.average_cny FROM market_valuations mv WHERE mv.camera_id = c.id ORDER BY mv.valued_at DESC, mv.created_at DESC LIMIT 1), 0) AS marketAverageCny,
        COALESCE((SELECT mv.premium_cny FROM market_valuations mv WHERE mv.camera_id = c.id ORDER BY mv.valued_at DESC, mv.created_at DESC LIMIT 1), 0) AS marketPremiumCny,
        COALESCE((SELECT mv.expected_cny FROM market_valuations mv WHERE mv.camera_id = c.id ORDER BY mv.valued_at DESC, mv.created_at DESC LIMIT 1), 0) AS expectedSaleCny,
        MAX(0, CAST(julianday('now') - julianday(c.acquired_at) AS INTEGER)) AS holdingDays
      FROM cameras c
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
        lo.shipping_jpy AS shippingJpy, lo.shipping_cny AS shippingCny,
        lo.is_estimated AS isEstimated, lo.last_checked_at AS lastCheckedAt,
        lo.tracking_source AS trackingSource, lo.tracking_error AS trackingError, lo.notes,
        COUNT(li.id) AS itemCount,
        COALESCE(GROUP_CONCAT(c.brand || ' ' || c.model, ' · '), '') AS cameraNames,
        CASE WHEN lo.international_shipped_at IS NOT NULL THEN ROUND(
          julianday(COALESCE(lo.delivered_at, (SELECT MAX(le.occurred_at) FROM logistics_events le WHERE le.logistics_order_id = lo.id), lo.hong_kong_arrived_at))
          - julianday(lo.international_shipped_at), 2
        ) ELSE NULL END AS totalTransitDays
      FROM logistics_orders lo
      LEFT JOIN logistics_items li ON li.logistics_order_id = lo.id
      LEFT JOIN cameras c ON c.id = li.camera_id
      GROUP BY lo.id
      ORDER BY lo.batch_code DESC
    `).all<Omit<LogisticsView, "events" | "costPerKg" | "costPerCamera">>(),
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
        rr.cost_cny AS costCny, rr.vendor, rr.resulting_status AS resultingStatus, rr.notes
      FROM repair_records rr
      JOIN cameras c ON c.id = rr.camera_id
      ORDER BY rr.repair_date DESC, rr.created_at DESC
    `).all<RepairView>(),
    db.prepare(`
      SELECT sr.id, sr.camera_id AS cameraId, c.brand || ' ' || c.model AS cameraName,
        sr.platform, sr.status, sr.listed_at AS listedAt, sr.sold_at AS soldAt,
        sr.asking_price_cny AS askingPriceCny, sr.actual_price_cny AS actualPriceCny,
        sr.platform_fee_cny AS platformFeeCny, sr.shipping_cny AS shippingCny,
        sr.actual_price_cny - sr.platform_fee_cny - sr.shipping_cny
          - COALESCE((SELECT SUM(poi.allocated_paid_cny) FROM purchase_order_items poi WHERE poi.camera_id = sr.camera_id), 0)
          - COALESCE((SELECT SUM(li.allocated_shipping_cny) FROM logistics_items li WHERE li.camera_id = sr.camera_id), 0)
          - COALESCE((SELECT SUM(rr.cost_cny) FROM repair_records rr WHERE rr.camera_id = sr.camera_id), 0)
          AS finalProfit
      FROM sales_records sr
      JOIN cameras c ON c.id = sr.camera_id
      ORDER BY COALESCE(sr.sold_at, sr.listed_at, sr.created_at) DESC
    `).all<SaleView>(),
    db.prepare(`
      SELECT
        COALESCE((SELECT SUM(paid_cny) FROM purchase_orders), 0)
          + COALESCE((SELECT SUM(shipping_cny + handling_cny) FROM logistics_orders WHERE is_estimated = 0), 0)
          + COALESCE((SELECT SUM(cost_cny) FROM repair_records), 0) AS totalInvested,
        COALESCE((SELECT SUM(shipping_cny + handling_cny) FROM logistics_orders), 0) AS logisticsCost,
        COALESCE((SELECT SUM(shipping_cny + handling_cny) FROM logistics_orders WHERE is_estimated = 1), 0) AS estimatedLogisticsCost,
        COALESCE((SELECT SUM(cost_cny) FROM repair_records), 0) AS repairCost,
        COALESCE((SELECT SUM(actual_price_cny - platform_fee_cny - shipping_cny) FROM sales_records WHERE status = '已出售'), 0) AS realizedNetProceeds
    `).first<{ totalInvested: number; logisticsCost: number; estimatedLogisticsCost: number; repairCost: number; realizedNetProceeds: number }>(),
  ]);

  const assets = assetResult.results.map((row) => {
    const purchaseCny = Number(row.purchaseCny);
    const internationalShippingCny = Number(row.internationalShippingCny);
    const repairCny = Number(row.repairCny);
    const trueCost = purchaseCny + internationalShippingCny + repairCny;
    const marketLowCny = Number(row.marketLowCny);
    const marketAverageCny = Number(row.marketAverageCny);
    const marketPremiumCny = Number(row.marketPremiumCny);
    const expectedSaleCny = Number(row.expectedSaleCny);
    return {
      ...row,
      purchaseJpy: Number(row.purchaseJpy),
      purchaseCny,
      exchangeRate: Number(row.exchangeRate),
      domesticShippingJpy: Number(row.domesticShippingJpy),
      domesticShippingCny: Number(row.domesticShippingCny),
      internationalShippingCny,
      shippingEstimated: Boolean(row.shippingEstimated),
      repairCny,
      marketLowCny,
      marketAverageCny,
      marketPremiumCny,
      expectedSaleCny,
      holdingDays: Number(row.holdingDays),
      trueCost,
      conservativeProfit: marketLowCny - trueCost,
      normalProfit: marketAverageCny - trueCost,
      optimisticProfit: marketPremiumCny - trueCost,
      roi: trueCost ? (expectedSaleCny - trueCost) / trueCost * 100 : 0,
    } satisfies AssetView;
  });

  const eventsByOrder = new Map<string, LogisticsEventView[]>();
  for (const event of eventResult.results) {
    const events = eventsByOrder.get(event.logisticsOrderId) ?? [];
    events.push(event);
    eventsByOrder.set(event.logisticsOrderId, events);
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
    events: eventsByOrder.get(row.id) ?? [],
  })) satisfies LogisticsView[];

  const activeAssets = assets.filter((asset) => asset.lifecycleStatus !== "已出售");
  const projectedCostBasis = activeAssets.reduce((sum, asset) => sum + asset.trueCost, 0);
  const currentMarketValue = activeAssets.reduce((sum, asset) => sum + asset.expectedSaleCny, 0);
  const unrealizedProfit = currentMarketValue - projectedCostBasis;
  const soldCost = assets.filter((asset) => asset.lifecycleStatus === "已出售").reduce((sum, asset) => sum + asset.trueCost, 0);
  const realizedProfit = Number(investmentRow?.realizedNetProceeds ?? 0) - soldCost;

  return {
    summary: {
      totalInvested: Number(investmentRow?.totalInvested ?? 0),
      projectedCostBasis,
      assetCount: activeAssets.length,
      currentMarketValue,
      unrealizedProfit,
      roi: projectedCostBasis ? unrealizedProfit / projectedCostBasis * 100 : 0,
      averageHoldingDays: activeAssets.length ? activeAssets.reduce((sum, asset) => sum + asset.holdingDays, 0) / activeAssets.length : 0,
      logisticsCost: Number(investmentRow?.logisticsCost ?? 0),
      estimatedLogisticsCost: Number(investmentRow?.estimatedLogisticsCost ?? 0),
      repairCost: Number(investmentRow?.repairCost ?? 0),
      realizedProfit,
    },
    assets,
    logistics,
    repairs: repairResult.results.map((row) => ({ ...row, costCny: Number(row.costCny) })),
    sales: salesResult.results.map((row) => ({
      ...row,
      askingPriceCny: Number(row.askingPriceCny),
      actualPriceCny: Number(row.actualPriceCny),
      platformFeeCny: Number(row.platformFeeCny),
      shippingCny: Number(row.shippingCny),
      finalProfit: Number(row.finalProfit),
    })),
    refreshedAt: new Date().toISOString(),
  };
}

export async function getCameraById(id: string) {
  const data = await getDashboardData();
  return data.assets.find((asset) => asset.id === id) ?? null;
}
