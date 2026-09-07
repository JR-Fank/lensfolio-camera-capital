import "server-only";

import { cache } from "react";
import { redirect } from "next/navigation";
import type { AssetView, DashboardData, LogisticsEventView, LogisticsView, SaleView, ValuationHistoryView } from "../../db/queries";
import { calculateHoldingDays } from "../holding-days";
import { buildLogisticsBenchmarks, type LogisticsCostSample } from "../logistics-benchmark";
import { canonicalizeTrackingEvents, deriveTransitDuration } from "../tracking/transit-duration";
import { projectAssetValuation, projectPortfolioValuation } from "../valuation-semantics";
import { createClient } from "./server";

type QueryResult<T = unknown> = { data: T | null; error: { message: string } | null };
type AssetRow = {
  id: string; portfolio_id: string; legacy_id: string | null; brand: string; model: string;
  serial_number: string | null; condition: string | null; operational_status: string;
  repair_status: string; acquired_at: string | null; measured_weight_g: number | null;
};
type FinancialRow = {
  portfolio_id: string; asset_id: string; acquisition_cost_cny: number | string;
  logistics_cost_cny: number | string; repair_cost_cny: number | string;
  other_cost_cny: number | string; total_carrying_cost_cny: number | string;
  current_valuation_cny: number | string | null; valued_at: string | null;
  unrealized_profit_cny: number | string | null; realized_profit_cny: number | string | null;
  investment_roi: number | string | null;
};
type PortfolioMetricsRow = {
  asset_count: number | string; total_carrying_cost_cny: number | string;
  active_asset_count: number | string; sold_asset_count: number | string;
  current_valuation_cny: number | string | null; unrealized_profit_cny: number | string | null;
  realized_profit_cny: number | string | null; investment_roi: number | string | null;
  unrealized_roi: number | string | null; realized_roi: number | string | null;
  logistics_cost_cny: number | string; repair_cost_cny: number | string; other_cost_cny: number | string;
  total_asset_count: number | string; total_posted_carrying_cost_cny: number | string;
  valued_asset_count: number | string; valued_asset_carrying_cost_cny: number | string | null;
  valued_unrealized_profit_cny: number | string | null; valued_assets_roi: number | string | null;
  valuation_coverage_complete: boolean; portfolio_roi: number | string | null;
};
type CostEntryRow = { asset_id: string; amount_cny: number | string };
type StatusEventRow = { asset_id: string; note: string | null; occurred_at: string };
type ValuationRow = {
  id: string; asset_id: string; market_source_id: string | null; low: number | string | null;
  median: number | string; high: number | string | null; sample_count: number | null;
  confidence: number | string | null; methodology_version: string; valued_at: string;
};
type MarketSourceRow = { id: string; name: string };
type SaleRow = {
  id: string; asset_id: string; status: string; platform: string | null;
  listing_price_cny: number | string | null; sold_price_cny: number | string | null;
  net_proceeds_cny: number | string | null;
  platform_fees_cny: number | string; outbound_shipping_cny: number | string;
  listed_at: string | null; sold_at: string | null;
};
type PurchaseItemRow = {
  asset_id: string; purchase_order_id: string; original_price_jpy: number | string; allocation_method: string;
};
type PurchaseOrderRow = {
  id: string; vendor: string | null; platform: string | null; order_reference: string | null;
  original_currency: string | null; ordered_at: string; domestic_shipping_jpy: number | string;
  exchange_rate_jpy_to_cny: number | string;
};
type AssetBuildContext = {
  financialByAsset: Map<string, FinancialRow>;
  pendingByAsset: Map<string, number>;
  valuationByAsset: Map<string, ValuationRow>;
  sourceById: Map<string, string>;
  purchaseItemByAsset: Map<string, PurchaseItemRow>;
  purchaseOrderById: Map<string, PurchaseOrderRow>;
  noteByAsset: Map<string, string>;
  soldAtByAsset: Map<string, string>;
};

const assetSelect = "id,portfolio_id,legacy_id,brand,model,serial_number,condition,operational_status,repair_status,acquired_at,measured_weight_g";
const financialSelect = "portfolio_id,asset_id,acquisition_cost_cny,logistics_cost_cny,repair_cost_cny,other_cost_cny,total_carrying_cost_cny,current_valuation_cny,valued_at,unrealized_profit_cny,realized_profit_cny,investment_roi";
const valuationSelect = "id,asset_id,market_source_id,low,median,high,sample_count,confidence,methodology_version,valued_at";
const purchaseItemSelect = "asset_id,purchase_order_id,original_price_jpy,allocation_method";
const purchaseOrderSelect = "id,vendor,platform,order_reference,original_currency,ordered_at,domestic_shipping_jpy,exchange_rate_jpy_to_cny";
const saleSelect = "id,asset_id,status,platform,listing_price_cny,sold_price_cny,net_proceeds_cny,platform_fees_cny,outbound_shipping_cny,listed_at,sold_at";

async function sessionPortfolio() {
  const supabase = await createClient();
  const { data: authData, error: authError } = await supabase.auth.getUser();
  if (authError || !authData.user) redirect("/login");

  const portfoliosResult = await supabase
    .from("portfolios")
    .select("id,name")
    .order("created_at", { ascending: true })
    .limit(2);
  const portfolios = rows<{ id: string; name: string }>("portfolio", portfoliosResult);
  if (portfolios.length !== 1) {
    throw new Error(`Expected one RLS-visible portfolio, found ${portfolios.length}.`);
  }
  return { supabase, portfolioId: portfolios[0].id };
}

export const getSupabaseDashboardData = cache(async (): Promise<DashboardData> => {
  const { supabase, portfolioId } = await sessionPortfolio();
  const [metricsResult, assetsResult, financialsResult, pendingResult, valuationsResult, sourcesResult, purchaseItemsResult, purchaseOrdersResult, statusEventsResult, salesResult] = await Promise.all([
    supabase.from("portfolio_metrics").select("asset_count,active_asset_count,sold_asset_count,total_carrying_cost_cny,current_valuation_cny,unrealized_profit_cny,realized_profit_cny,unrealized_roi,realized_roi,investment_roi,logistics_cost_cny,repair_cost_cny,other_cost_cny,total_asset_count,total_posted_carrying_cost_cny,valued_asset_count,valued_asset_carrying_cost_cny,valued_unrealized_profit_cny,valued_assets_roi,valuation_coverage_complete,portfolio_roi").eq("portfolio_id", portfolioId).single(),
    supabase.from("assets").select(assetSelect).eq("portfolio_id", portfolioId).order("acquired_at", { ascending: true }),
    supabase.from("asset_financials").select(financialSelect).eq("portfolio_id", portfolioId),
    supabase.from("cost_entries").select("asset_id,amount_cny").eq("portfolio_id", portfolioId).eq("entry_status", "pending").eq("cost_type", "international_shipping"),
    supabase.from("valuation_snapshots").select(valuationSelect).eq("portfolio_id", portfolioId).order("valued_at", { ascending: false }),
    supabase.from("market_sources").select("id,name").eq("portfolio_id", portfolioId),
    supabase.from("purchase_items").select(purchaseItemSelect).eq("portfolio_id", portfolioId),
    supabase.from("purchase_orders").select(purchaseOrderSelect).eq("portfolio_id", portfolioId),
    supabase.from("asset_status_events").select("asset_id,note,occurred_at").eq("portfolio_id", portfolioId).not("note", "is", null).order("occurred_at", { ascending: false }),
    supabase.from("sales").select(saleSelect).eq("portfolio_id", portfolioId).order("sold_at", { ascending: false, nullsFirst: false }),
  ]);
  const metrics = row<PortfolioMetricsRow>("portfolio metrics", metricsResult);
  const assetRows = rows<AssetRow>("assets", assetsResult);
  const valuationRows = rows<ValuationRow>("valuation snapshots", valuationsResult);
  const saleRows = rows<SaleRow>("sales", salesResult);
  const context = buildContext({
    financials: rows<FinancialRow>("asset financials", financialsResult),
    pendingEntries: rows<CostEntryRow>("pending shipping", pendingResult),
    valuations: valuationRows,
    sources: rows<MarketSourceRow>("market sources", sourcesResult),
    purchaseItems: rows<PurchaseItemRow>("purchase items", purchaseItemsResult),
    purchaseOrders: rows<PurchaseOrderRow>("purchase orders", purchaseOrdersResult),
    statusEvents: rows<StatusEventRow>("asset status notes", statusEventsResult),
    sales: saleRows,
  });
  const assets = assetRows.map((asset) => buildAsset(asset, context));
  const sales = buildSales(saleRows, assetRows, context.financialByAsset);
  const pendingShipping = sum(context.pendingByAsset.values());
  const postedCarryingCost = money(metrics.total_carrying_cost_cny);
  const valuationMetrics = projectPortfolioValuation(metrics);
  const heldCarryingCost = sum(assets.filter((asset) => asset.lifecycleStatus !== "已出售").map((asset) => asset.trueCost));
  const realizedProfit = money(metrics.realized_profit_cny);
  const totalProfit = valuationMetrics.valuedUnrealizedProfit === null
    ? null
    : realizedProfit + valuationMetrics.valuedUnrealizedProfit;

  return {
    dataSource: "supabase",
    migrationReadOnly: true,
    summary: {
      totalInvested: postedCarryingCost,
      projectedCostBasis: postedCarryingCost + pendingShipping,
      assetCount: whole(metrics.asset_count),
      totalAssetCount: whole(metrics.asset_count),
      heldAssetCount: whole(metrics.active_asset_count),
      soldAssetCount: whole(metrics.sold_asset_count),
      heldCarryingCost,
      currentMarketValue: valuationMetrics.currentMarketValue,
      unrealizedProfit: valuationMetrics.valuedUnrealizedProfit,
      roi: valuationMetrics.valuedAssetsRoi,
      valuedAssetCount: valuationMetrics.valuedAssetCount,
      valuedAssetCarryingCost: valuationMetrics.valuedAssetCarryingCost,
      valuationCoverageComplete: valuationMetrics.valuationCoverageComplete,
      portfolioRoi: valuationMetrics.portfolioRoi,
      averageHoldingDays: averageHoldingDays(assets),
      logisticsCost: money(metrics.logistics_cost_cny) + pendingShipping,
      estimatedLogisticsCost: pendingShipping,
      repairCost: money(metrics.repair_cost_cny),
      otherCost: money(metrics.other_cost_cny),
      realizedProfit,
      realizedRoi: nullablePercentage(metrics.realized_roi),
      totalProfit,
    },
    assets,
    logistics: [],
    repairs: [],
    sales,
    expenses: [],
    valuationHistory: buildValuationHistory(valuationRows, assetRows, context.sourceById),
    refreshedAt: new Date().toISOString(),
  };
});


type ShipmentRow = {
  id: string;
  legacy_id: string | null;
  carrier: string | null;
  tracking_number: string | null;
  status: string;
  shipped_at: string | null;
  delivered_at: string | null;
  actual_paid_cny: number | string;
  budget_cny: number | string;
  origin: string | null;
  destination: string | null;
  bare_weight_g: number | null;
  chargeable_weight_g: number | null;
  legacy_status: string | null;
  created_at: string;
};

type ShipmentItemRow = {
  id: string;
  shipment_id: string;
  asset_id: string;
  weight_snapshot_g: number | null;
  allocation_method: string;
  allocated_shipping_cny: number | string;
};

type ShipmentCostRow = {
  id: string;
  source_id: string | null;
  source_type: string;
  cost_type: string;
  reversal_of: string | null;
  amount_cny: number | string;
};

function postedShippingCostsByItem(costs: ShipmentCostRow[]) {
  const originals = costs.filter((cost) => cost.cost_type === "international_shipping"
    && cost.source_type === "shipment_item" && cost.source_id && !cost.reversal_of);
  const reversalsByCostId = new Map<string, number>();
  for (const cost of costs) {
    if (cost.cost_type !== "reversal" || !cost.reversal_of) continue;
    reversalsByCostId.set(cost.reversal_of,
      (reversalsByCostId.get(cost.reversal_of) ?? 0) + Math.round(Number(cost.amount_cny) * 100));
  }
  const grossByItemId = new Map<string, number>();
  const netByItemId = new Map<string, number>();
  for (const cost of originals) {
    const itemId = cost.source_id!;
    const grossCents = Math.round(Number(cost.amount_cny) * 100);
    grossByItemId.set(itemId, ((grossByItemId.get(itemId) ?? 0) * 100 + grossCents) / 100);
    netByItemId.set(itemId, ((netByItemId.get(itemId) ?? 0) * 100
      + grossCents + (reversalsByCostId.get(cost.id) ?? 0)) / 100);
  }
  return { grossByItemId, netByItemId };
}

type TrackingEventRow = {
  id: string;
  shipment_id: string;
  external_event_id: string | null;
  legacy_id: string | null;
  status: string;
  description: string | null;
  location: string | null;
  occurred_at: string;
  recorded_at: string;
  raw_status: string | null;
};

type TrackingSyncRunRow = {
  shipment_id: string | null;
  finished_at: string | null;
  status: string;
  error_message: string | null;
};

type LogisticsPurchaseItemRow = {
  asset_id: string;
  purchase_order_id: string;
};

type LogisticsPurchaseOrderRow = {
  id: string;
  ordered_at: string;
};

type LogisticsReferenceRow = {
  carrier: string;
  service: string;
  chargeable_weight_g: number;
  net_cost_cny: number | string;
};

export const getSupabaseLogisticsData = cache(async (): Promise<DashboardData> => {
  const dashboard = await getSupabaseDashboardData();
  const { supabase, portfolioId } = await sessionPortfolio();

  const [shipmentsResult, itemsResult, costsResult, eventsResult, syncRunsResult, purchaseItemsResult, purchaseOrdersResult, referencesResult] = await Promise.all([
    supabase
      .from("shipments")
      .select("id,legacy_id,carrier,tracking_number,status,shipped_at,delivered_at,actual_paid_cny,budget_cny,origin,destination,bare_weight_g,chargeable_weight_g,legacy_status,created_at")
      .eq("portfolio_id", portfolioId)
      .order("created_at", { ascending: false }),
    supabase
      .from("shipment_items")
      .select("id,shipment_id,asset_id,weight_snapshot_g,allocation_method,allocated_shipping_cny")
      .eq("portfolio_id", portfolioId),
    supabase
      .from("cost_entries")
      .select("id,source_id,source_type,cost_type,reversal_of,amount_cny")
      .eq("portfolio_id", portfolioId)
      .in("cost_type", ["international_shipping", "reversal"])
      .eq("entry_status", "posted"),
    supabase
      .from("tracking_events")
      .select("id,shipment_id,external_event_id,legacy_id,status,description,location,occurred_at,recorded_at,raw_status")
      .eq("portfolio_id", portfolioId)
      .order("occurred_at", { ascending: true }),
    supabase
      .from("tracking_sync_runs")
      .select("shipment_id,finished_at,status,error_message")
      .eq("portfolio_id", portfolioId)
      .not("finished_at", "is", null)
      .order("finished_at", { ascending: false }),
    supabase
      .from("purchase_items")
      .select("asset_id,purchase_order_id")
      .eq("portfolio_id", portfolioId),
    supabase
      .from("purchase_orders")
      .select("id,ordered_at")
      .eq("portfolio_id", portfolioId),
    supabase
      .from("logistics_reference_samples")
      .select("carrier,service,chargeable_weight_g,net_cost_cny")
      .eq("portfolio_id", portfolioId)
      .eq("reference_scope", "external_private"),
  ]);

  const shipments = rows<ShipmentRow>("shipments", shipmentsResult);
  const items = rows<ShipmentItemRow>("shipment items", itemsResult);
  const costs = rows<ShipmentCostRow>("posted shipment costs", costsResult);
  const events = rows<TrackingEventRow>("tracking events", eventsResult);
  const syncRuns = rows<TrackingSyncRunRow>("tracking sync runs", syncRunsResult);
  const purchaseItems = rows<LogisticsPurchaseItemRow>("shipment purchase items", purchaseItemsResult);
  const purchaseOrders = rows<LogisticsPurchaseOrderRow>("shipment purchase orders", purchaseOrdersResult);
  const referenceSamples = rows<LogisticsReferenceRow>("external logistics references", referencesResult);

  const assetNameById = new Map(
    dashboard.assets.map((asset) => [asset.id, `${asset.brand} ${asset.model}`])
  );
  const { grossByItemId, netByItemId: postedCostByItemId } = postedShippingCostsByItem(costs);
  const purchaseOrderById = new Map(purchaseOrders.map((order) => [order.id, order]));
  const orderedAtByAssetId = new Map(
    purchaseItems.map((item) => [
      item.asset_id,
      purchaseOrderById.get(item.purchase_order_id)?.ordered_at ?? null,
    ]),
  );

  const itemsByShipment = new Map<string, ShipmentItemRow[]>();
  for (const item of items) {
    const list = itemsByShipment.get(item.shipment_id) ?? [];
    list.push(item);
    itemsByShipment.set(item.shipment_id, list);
  }

  const eventsByShipment = new Map<string, TrackingEventRow[]>();
  for (const event of events) {
    const list = eventsByShipment.get(event.shipment_id) ?? [];
    list.push(event);
    eventsByShipment.set(event.shipment_id, list);
  }

  const latestRunByShipment = new Map<string, TrackingSyncRunRow>();
  for (const run of syncRuns) {
    if (run.shipment_id && !latestRunByShipment.has(run.shipment_id)) {
      latestRunByShipment.set(run.shipment_id, run);
    }
  }

  const benchmarkSamples: LogisticsCostSample[] = shipments.flatMap((shipment) => {
    const shipmentItems = itemsByShipment.get(shipment.id) ?? [];
    const postedCost = sum(
      shipmentItems.map((item) => postedCostByItemId.get(item.id) ?? 0),
    );
    const actualPaid = money(shipment.actual_paid_cny);
    const postedGross = sum(shipmentItems.map((item) => grossByItemId.get(item.id) ?? 0));
    const weightG = nullableWhole(shipment.chargeable_weight_g);
    const carrierService = shipment.carrier?.trim() ?? "";
    if (
      !carrierService
      || weightG === null
      || weightG <= 0
      || actualPaid <= 0
      || shipmentItems.some((item) => !grossByItemId.has(item.id))
      || Math.abs(postedGross - actualPaid) > 0.01
    ) return [];

    const shipmentEvents = canonicalizeTrackingEvents(
      (eventsByShipment.get(shipment.id) ?? []).map((event) => trackingEventView(shipment.id, event)),
    );
    const duration = deriveTransitDuration(shipmentEvents);
    const completedTransitDays = duration.isComplete ? duration.transitDays : null;

    return [{
      carrierService,
      scope: "portfolio_actual" as const,
      chargeableWeightG: weightG,
      actualCostCny: postedCost,
      completedTransitDays,
    }];
  });
  benchmarkSamples.push(...referenceSamples.map((sample) => ({
    carrierService: `${sample.carrier.trim()} ${sample.service.trim()}`,
    scope: "external_private" as const,
    chargeableWeightG: sample.chargeable_weight_g,
    actualCostCny: money(sample.net_cost_cny),
    completedTransitDays: null,
  })));

  const logisticsRecords = shipments.map((shipment) => {
    const shipmentItems = itemsByShipment.get(shipment.id) ?? [];
    const shipmentEvents = canonicalizeTrackingEvents(
      (eventsByShipment.get(shipment.id) ?? []).map((event) => trackingEventView(shipment.id, event)),
    );
    const latestRun = latestRunByShipment.get(shipment.id);
    const actualPaid = money(shipment.actual_paid_cny);
    const budget = money(shipment.budget_cny);
    const hasCompletePostedShipping = shipmentItems.length > 0
      && shipmentItems.every((item) => postedCostByItemId.has(item.id));
    const postedNetShipping = sum(
      shipmentItems.map((item) => postedCostByItemId.get(item.id) ?? 0),
    );
    const shippingCny = hasCompletePostedShipping
      ? postedNetShipping
      : actualPaid > 0
        ? actualPaid
        : budget;
    const isEstimated = !hasCompletePostedShipping && actualPaid <= 0 && budget > 0;
    const bareWeightG = nullableWhole(shipment.bare_weight_g);
    const chargeableWeightG = nullableWhole(shipment.chargeable_weight_g);

    const allocations = shipmentItems.map((item) => {
      const budgetAllocation = money(item.allocated_shipping_cny);
      const actualAllocation = postedCostByItemId.get(item.id) ?? null;
      return {
        logisticsOrderId: shipment.id,
        cameraId: item.asset_id,
        cameraName: assetNameById.get(item.asset_id) ?? "Unknown asset",
        weightG: nullableWhole(item.weight_snapshot_g),
        allocatedShippingCny: actualAllocation ?? budgetAllocation,
        actualAllocatedShippingCny: actualAllocation,
        budgetAllocatedShippingCny: budgetAllocation,
      };
    });
    const cameraNames = allocations.map((item) => item.cameraName).join(" · ");
    const businessOrderAt = shipmentItems
      .map((item) => orderedAtByAssetId.get(item.asset_id))
      .filter((value): value is string => Boolean(value))
      .sort((a, b) => b.localeCompare(a))[0] ?? shipment.created_at;

    const findTrackingEvent = (...labels: string[]) =>
      shipmentEvents.find((event) => {
        const value = `${event.rawStatus} ${event.statusLabel}`.toLowerCase();
        return labels.some((label) => value.includes(label.toLowerCase()));
      });

    const postingEvent = findTrackingEvent("Posting/Collection");
    const dispatchEvent = findTrackingEvent("Dispatch from outward office of exchange");
    const inwardArrivalEvent = findTrackingEvent("Arrival at inward office of exchange");
    const latest = shipmentEvents.at(-1);
    const duration = deriveTransitDuration(shipmentEvents);

    const view: LogisticsView = {
      id: shipment.id,
      batchCode: shipmentDisplayName(shipment, cameraNames),
      carrier: shipmentCarrierDisplayName(shipment.carrier),
      trackingNumber: shipment.tracking_number,
      origin: shipment.origin ?? "未记录",
      destination: shipment.destination ?? "未记录",
      status: shipmentPresentationStatus(shipment.status, latest),
      latestEvent:
        latest?.statusLabel ??
        shipment.legacy_status ??
        null,
      estimatedArrivalAt: null,
      sellerShippedAt: postingEvent?.occurredAt ?? null,
      warehouseInAt: null,
      internationalShippedAt: dispatchEvent?.occurredAt ?? shipment.shipped_at,
      hongKongArrivedAt: inwardArrivalEvent?.occurredAt ?? null,
      deliveredAt: shipment.delivered_at,
      bareWeightG,
      chargeableWeightG,
      shippingJpy: 0,
      shippingCny,
      allocationMethod: allocationMethod(shipmentItems[0]?.allocation_method),
      isEstimated,
      lastCheckedAt: latestRun?.finished_at ?? null,
      trackingSource: latestRun || shipmentEvents.length
        ? "Japan Post public tracking"
        : null,
      trackingError: latestRun?.status === "failed"
        ? latestRun.error_message
        : null,
      anomaly: null,
      notes: shipment.legacy_status,
      itemCount: shipmentItems.length,
      cameraNames,
      totalTransitDays: duration.transitDays,
      transitDurationComplete: duration.isComplete,
      pickupWaitDays: duration.pickupWaitDays,
      costPerKg:
        chargeableWeightG !== null && chargeableWeightG > 0
          ? shippingCny / (chargeableWeightG / 1000)
          : null,
      costPerCamera:
        shipmentItems.length > 0 ? shippingCny / shipmentItems.length : 0,
      allocations,
      events: shipmentEvents,
    };
    return {
      view,
      businessOrderAt,
      sortGroup: shipment.status === "delivered" ? 1 : shipment.status === "cancelled" ? 2 : 0,
      createdAt: shipment.created_at,
    };
  });
  const logistics = logisticsRecords
    .sort((a, b) =>
      a.sortGroup - b.sortGroup
      || b.businessOrderAt.localeCompare(a.businessOrderAt)
      || b.createdAt.localeCompare(a.createdAt)
      || a.view.id.localeCompare(b.view.id)
    )
    .map((record) => record.view);

  return {
    ...dashboard,
    logistics,
    logisticsBenchmarks: buildLogisticsBenchmarks(benchmarkSamples),
  };
});

function shipmentStatus(value: string) {
  return ({
    draft: "待处理",
    booked: "已预约",
    in_transit: "运输中",
    customs: "清关中",
    delivered: "已签收",
    cancelled: "已取消",
  } as Record<string, string>)[value] ?? value;
}

function shipmentPresentationStatus(value: string, latest: LogisticsEventView | undefined) {
  if (
    value === "in_transit"
    && latest?.rawStatus === "Item arrival at collection point for pick-up"
  ) {
    return "香港领取点待取";
  }
  return shipmentStatus(value);
}

function trackingEventView(shipmentId: string, event: TrackingEventRow): LogisticsEventView {
  return {
    id: event.id,
    logisticsOrderId: shipmentId,
    occurredAt: event.occurred_at,
    rawStatus: event.raw_status ?? event.status,
    statusLabel: event.status,
    externalEventId: event.external_event_id,
    legacyId: event.legacy_id,
    recordedAt: event.recorded_at,
    details: event.description,
    office: event.location,
    country: null,
    postalCode: null,
  };
}

function allocationMethod(value: string | undefined) {
  return ({
    equal: "平均分摊",
    weight: "按重量分摊",
    manual: "手工分摊",
    legacy_equal_allocation: "历史平均分摊",
  } as Record<string, string>)[value ?? ""] ?? value ?? "未记录";
}

function shipmentDisplayName(
  shipment: Pick<ShipmentRow, "id" | "legacy_id">,
  cameraNames: string,
) {
  if (
    shipment.legacy_id?.startsWith("evidence:logistics:") ||
    shipment.legacy_id?.startsWith("confirmed-capital-source-v1:")
  ) {
    return cameraNames ? `${cameraNames} · 国际物流` : "国际物流";
  }
  return shipment.legacy_id ?? `物流 ${shipment.id.slice(0, 8)}`;
}

function shipmentCarrierDisplayName(carrier: string | null) {
  return carrier === "Japan Post EMS" ? "日本邮政 EMS" : carrier ?? "未记录承运商";
}

export const getSupabaseAssetDetailData = cache(async (assetId: string): Promise<DashboardData | null> => {
  if (!isUuid(assetId)) return null;
  const { supabase, portfolioId } = await sessionPortfolio();
  const [assetResult, financialResult, pendingResult, valuationsResult, statusEventsResult, salesResult] = await Promise.all([
    supabase.from("assets").select(assetSelect).eq("portfolio_id", portfolioId).eq("id", assetId).maybeSingle(),
    supabase.from("asset_financials").select(financialSelect).eq("portfolio_id", portfolioId).eq("asset_id", assetId).maybeSingle(),
    supabase.from("cost_entries").select("asset_id,amount_cny").eq("portfolio_id", portfolioId).eq("asset_id", assetId).eq("entry_status", "pending").eq("cost_type", "international_shipping"),
    supabase.from("valuation_snapshots").select(valuationSelect).eq("portfolio_id", portfolioId).eq("asset_id", assetId).order("valued_at", { ascending: false }),
    supabase.from("asset_status_events").select("asset_id,note,occurred_at").eq("portfolio_id", portfolioId).eq("asset_id", assetId).not("note", "is", null).order("occurred_at", { ascending: false }),
    supabase.from("sales").select(saleSelect).eq("portfolio_id", portfolioId).eq("asset_id", assetId).order("sold_at", { ascending: false, nullsFirst: false }),
  ]);
  const asset = optionalRow<AssetRow>("asset", assetResult);
  if (!asset) return null;
  const financial = optionalRow<FinancialRow>("asset financials", financialResult);
  if (!financial) throw new Error("Asset financial view row is missing.");
  const valuationRows = rows<ValuationRow>("asset valuations", valuationsResult);
  const latestValuation = valuationRows[0];
  const [purchaseItemsResult, sourcesResult] = await Promise.all([
    supabase.from("purchase_items").select(purchaseItemSelect).eq("portfolio_id", portfolioId).eq("asset_id", assetId),
    latestValuation?.market_source_id
      ? supabase.from("market_sources").select("id,name").eq("portfolio_id", portfolioId).eq("id", latestValuation.market_source_id)
      : Promise.resolve({ data: [], error: null }),
  ]);
  const purchaseItems = rows<PurchaseItemRow>("asset purchase item", purchaseItemsResult);
  const purchaseOrderId = purchaseItems[0]?.purchase_order_id;
  const purchaseOrdersResult = purchaseOrderId
    ? await supabase.from("purchase_orders").select(purchaseOrderSelect).eq("portfolio_id", portfolioId).eq("id", purchaseOrderId)
    : { data: [], error: null };
  const saleRows = rows<SaleRow>("asset sales", salesResult);
  const context = buildContext({
    financials: [financial],
    pendingEntries: rows<CostEntryRow>("asset pending shipping", pendingResult),
    valuations: valuationRows,
    sources: rows<MarketSourceRow>("asset market source", sourcesResult),
    purchaseItems,
    purchaseOrders: rows<PurchaseOrderRow>("asset purchase order", purchaseOrdersResult),
    statusEvents: rows<StatusEventRow>("asset status notes", statusEventsResult),
    sales: saleRows,
  });
  const assetView = buildAsset(asset, context);
  const sales = buildSales(saleRows, [asset], context.financialByAsset);
  const pendingShipping = assetView.pendingShippingCny ?? 0;

  return {
    dataSource: "supabase",
    migrationReadOnly: true,
    summary: {
      totalInvested: assetView.trueCost,
      projectedCostBasis: assetView.trueCost + pendingShipping,
      assetCount: 1,
      totalAssetCount: 1,
      heldAssetCount: sales.some((sale) => sale.status === "已出售") ? 0 : 1,
      soldAssetCount: sales.some((sale) => sale.status === "已出售") ? 1 : 0,
      heldCarryingCost: sales.some((sale) => sale.status === "已出售") ? 0 : assetView.trueCost,
      currentMarketValue: assetView.marketMedianCny,
      unrealizedProfit: assetView.normalProfit,
      roi: assetView.roi,
      valuedAssetCount: assetView.marketMedianCny === null ? 0 : 1,
      valuedAssetCarryingCost: assetView.marketMedianCny === null ? null : assetView.trueCost,
      valuationCoverageComplete: assetView.marketMedianCny !== null,
      portfolioRoi: assetView.marketMedianCny === null ? null : assetView.roi,
      averageHoldingDays: assetView.holdingDays,
      logisticsCost: assetView.internationalShippingCny + pendingShipping,
      estimatedLogisticsCost: pendingShipping,
      repairCost: assetView.repairCny,
      otherCost: assetView.otherCostCny,
      realizedProfit: money(financial.realized_profit_cny),
      realizedRoi: nullablePercentage(financial.investment_roi),
      totalProfit: money(financial.realized_profit_cny) || assetView.normalProfit,
    },
    assets: [assetView],
    logistics: [], repairs: [], sales, expenses: [],
    valuationHistory: buildValuationHistory(valuationRows, [asset], context.sourceById),
    refreshedAt: new Date().toISOString(),
  };
});

function buildContext(input: {
  financials: FinancialRow[]; pendingEntries: CostEntryRow[]; valuations: ValuationRow[];
  sources: MarketSourceRow[]; purchaseItems: PurchaseItemRow[]; purchaseOrders: PurchaseOrderRow[];
  statusEvents: StatusEventRow[]; sales: SaleRow[];
}): AssetBuildContext {
  const valuationByAsset = new Map<string, ValuationRow>();
  for (const valuation of input.valuations) {
    if (!valuationByAsset.has(valuation.asset_id)) valuationByAsset.set(valuation.asset_id, valuation);
  }
  const pendingByAsset = new Map<string, number>();
  for (const entry of input.pendingEntries) {
    pendingByAsset.set(entry.asset_id, (pendingByAsset.get(entry.asset_id) ?? 0) + money(entry.amount_cny));
  }
  const noteByAsset = new Map<string, string>();
  for (const event of input.statusEvents) {
    if (event.note && !noteByAsset.has(event.asset_id)) noteByAsset.set(event.asset_id, event.note);
  }
  return {
    financialByAsset: new Map(input.financials.map((value) => [value.asset_id, value])),
    pendingByAsset,
    valuationByAsset,
    sourceById: new Map(input.sources.map((value) => [value.id, value.name])),
    purchaseItemByAsset: new Map(input.purchaseItems.map((value) => [value.asset_id, value])),
    purchaseOrderById: new Map(input.purchaseOrders.map((value) => [value.id, value])),
    noteByAsset,
    soldAtByAsset: new Map(
      input.sales.flatMap((sale) => sale.status === "sold" && sale.sold_at
        ? [[sale.asset_id, sale.sold_at] as const]
        : []),
    ),
  };
}

function buildAsset(asset: AssetRow, context: AssetBuildContext): AssetView {
  const financial = context.financialByAsset.get(asset.id);
  if (!financial) throw new Error(`Missing asset financials for ${asset.id}.`);
  const valuation = context.valuationByAsset.get(asset.id);
  const purchaseItem = context.purchaseItemByAsset.get(asset.id);
  const purchaseOrder = purchaseItem ? context.purchaseOrderById.get(purchaseItem.purchase_order_id) : undefined;
  const postedCost = money(financial.total_carrying_cost_cny);
  const projectedValuation = projectAssetValuation({
    currentValuation: financial.current_valuation_cny,
    low: valuation?.low,
    high: valuation?.high,
    unrealizedProfit: financial.unrealized_profit_cny,
    investmentRoi: financial.investment_roi,
  });
  return {
    id: asset.id, brand: asset.brand, model: asset.model, variant: null,
    serialNumber: asset.serial_number, purchasePlatform: purchaseOrder?.platform ?? null,
    purchaseSeller: purchaseOrder?.vendor ?? null, purchaseOrderRef: purchaseOrder?.order_reference ?? null,
    paymentMethod: null, paidAt: purchaseOrder?.ordered_at ?? null,
    weightG: asset.measured_weight_g ?? 0, acquiredAt: asset.acquired_at?.slice(0, 10) ?? "",
    lifecycleStatus: operationalStatus(asset.operational_status), repairStatus: repairStatus(asset.repair_status),
    conditionGrade: asset.condition, notes: context.noteByAsset.get(asset.id) ?? null, purchaseJpy: money(purchaseItem?.original_price_jpy),
    purchaseCny: money(financial.acquisition_cost_cny), exchangeRate: money(purchaseOrder?.exchange_rate_jpy_to_cny),
    domesticShippingJpy: money(purchaseOrder?.domestic_shipping_jpy), domesticShippingCny: 0,
    internationalShippingCny: money(financial.logistics_cost_cny),
    pendingShippingCny: context.pendingByAsset.get(asset.id) ?? 0,
    shippingEstimated: (context.pendingByAsset.get(asset.id) ?? 0) > 0,
    repairCny: money(financial.repair_cost_cny), otherCostCny: money(financial.other_cost_cny), trueCost: postedCost,
    valuationSource: valuation?.market_source_id ? context.sourceById.get(valuation.market_source_id) ?? "市场估值" : "待估价",
    valuationDate: valuation?.valued_at ?? financial.valued_at, valuationKeyword: null,
    valuationSampleSize: valuation?.sample_count ?? null, valuationCondition: asset.condition,
    valuationConfidence: money(valuation?.confidence), valuationCollectionMethod: valuation?.methodology_version ?? "",
    marketLowCny: projectedValuation.low,
    marketMedianCny: projectedValuation.currentValuation,
    marketHighCny: projectedValuation.high,
    expectedSaleCny: projectedValuation.currentValuation,
    conservativeProfit: projectedValuation.low === null ? null : projectedValuation.low - postedCost,
    normalProfit: projectedValuation.unrealizedProfit,
    optimisticProfit: projectedValuation.high === null ? null : projectedValuation.high - postedCost,
    roi: projectedValuation.roi,
    holdingDays: calculateHoldingDays(asset.acquired_at, context.soldAtByAsset.get(asset.id) ?? null),
  };
}

function buildValuationHistory(valuations: ValuationRow[], assets: AssetRow[], sourceById: Map<string, string>): ValuationHistoryView[] {
  const assetById = new Map(assets.map((asset) => [asset.id, asset]));
  return valuations.map((valuation) => {
    const asset = assetById.get(valuation.asset_id);
    return {
      id: valuation.id, cameraId: valuation.asset_id,
      cameraName: asset ? `${asset.brand} ${asset.model}` : "Asset",
      source: valuation.market_source_id ? sourceById.get(valuation.market_source_id) ?? "市场估值" : "市场估值",
      keyword: null, valuedAt: valuation.valued_at, lowCny: money(valuation.low),
      medianCny: money(valuation.median), highCny: money(valuation.high), expectedCny: money(valuation.median),
      sampleSize: valuation.sample_count, confidence: money(valuation.confidence),
      collectionMethod: valuation.methodology_version,
    };
  });
}

function buildSales(sales: SaleRow[], assets: AssetRow[], financialByAsset: Map<string, FinancialRow>): SaleView[] {
  const assetById = new Map(assets.map((asset) => [asset.id, asset]));
  return sales.map((sale) => {
    const asset = assetById.get(sale.asset_id);
    const financial = financialByAsset.get(sale.asset_id);
    return {
      id: sale.id,
      cameraId: sale.asset_id,
      cameraName: asset ? `${asset.brand} ${asset.model}` : "Asset",
      platform: sale.platform ?? "未记录",
      status: saleStatus(sale.status),
      listedAt: sale.listed_at,
      soldAt: sale.sold_at,
      askingPriceCny: nullableMoney(sale.listing_price_cny),
      marketPriceCny: null,
      actualPriceCny: nullableMoney(sale.sold_price_cny),
      grossProceedsCny: nullableMoney(sale.sold_price_cny),
      netProceedsCny: nullableMoney(sale.net_proceeds_cny),
      platformFeeCny: money(sale.platform_fees_cny),
      shippingCny: money(sale.outbound_shipping_cny),
      carryingCostCny: money(financial?.total_carrying_cost_cny),
      finalProfit: money(financial?.realized_profit_cny),
      realizedRoi: nullablePercentage(financial?.investment_roi),
      holdingDays: calculateHoldingDays(asset?.acquired_at ?? null, sale.sold_at),
    };
  });
}

function rows<T>(label: string, result: QueryResult): T[] {
  if (result.error) throw new Error(`${label} query failed: ${result.error.message}`);
  return (result.data ?? []) as T[];
}
function row<T>(label: string, result: QueryResult): T {
  if (result.error) throw new Error(`${label} query failed: ${result.error.message}`);
  if (!result.data) throw new Error(`${label} query returned no row.`);
  return result.data as T;
}
function optionalRow<T>(label: string, result: QueryResult): T | null {
  if (result.error) throw new Error(`${label} query failed: ${result.error.message}`);
  return result.data as T | null;
}
function money(value: number | string | null | undefined) {
  const result = Number(value ?? 0);
  return Number.isFinite(result) ? result : 0;
}
function nullableMoney(value: number | string | null | undefined) {
  if (value === null || value === undefined) return null;
  const result = Number(value);
  return Number.isFinite(result) ? result : null;
}
function nullablePercentage(value: number | string | null | undefined) {
  const result = nullableMoney(value);
  return result === null ? null : result * 100;
}
function whole(value: number | string | null | undefined) { return Math.trunc(money(value)); }
function nullableWhole(value: number | string | null | undefined) {
  if (value === null || value === undefined) return null;
  const result = Number(value);
  return Number.isFinite(result) ? Math.trunc(result) : null;
}
function sum(values: Iterable<number>) { let total = 0; for (const value of values) total += value; return total; }
function averageHoldingDays(assets: AssetView[]) {
  const active = assets.filter((asset) => asset.lifecycleStatus !== "已出售");
  return active.length ? active.reduce((total, asset) => total + asset.holdingDays, 0) / active.length : 0;
}
function operationalStatus(value: string) {
  return ({ acquired: "已采购", in_transit: "运输中", in_storage: "已入库", inspection: "检测中", repair: "维修中", ready_for_sale: "可出售", listed: "已挂牌", sold: "已出售", retired: "已退役" } as Record<string, string>)[value] ?? value;
}
function repairStatus(value: string) {
  return ({ unknown: "未知", not_inspected: "未检测", normal: "正常", needs_repair: "待维修", in_repair: "维修中", repaired: "已维修" } as Record<string, string>)[value] ?? value;
}
function saleStatus(value: string) {
  return ({ listed: "已挂牌", sold: "已出售", cancelled: "已取消" } as Record<string, string>)[value] ?? value;
}
function isUuid(value: string) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}
