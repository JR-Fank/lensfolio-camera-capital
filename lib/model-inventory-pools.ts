import type { AssetView } from "../db/queries";

export type ModelInventoryPool = {
  key: string;
  brand: string;
  model: string;
  assets: AssetView[];
  confirmedAssets: AssetView[];
  riskAssets: AssetView[];
  heldUnits: number;
  confirmedUnits: number;
  riskUnits: number;
  totalCarryingCost: number;
  averageCarryingCost: number;
  confirmedCarryingCost: number;
  confirmedAverageCarryingCost: number | null;
  minimumCarryingCost: number;
  maximumCarryingCost: number;
  latestModelMarketMedian: number | null;
  valuedUnits: number;
  valuationCoverage: number;
  blendedCostAdvantage: number | null;
};

export type ModelPoolScenario = {
  units: number;
  grossAverageSalePrice: number;
  sellingFeePerUnit: number;
  netAverageProceeds: number;
  totalExpectedProceeds: number;
  totalPoolProfit: number;
  poolRoi: number | null;
  averageProfitPerUnit: number;
  averageBreakEvenPrice: number;
  requiredAverageSalePrice: number;
};

const bundleSuffix = /\s*(?:套装内|bundle(?:\s+item)?|set)\s*$/iu;

export function normalizedModelKey(brand: string, model: string) {
  return `${normalize(brand)}::${normalize(canonicalModel(model))}`;
}

export function canonicalModel(model: string) {
  return model.replace(bundleSuffix, "").trim();
}

export function isConfirmedInventoryAsset(asset: AssetView) {
  return asset.repairStatus === "正常"
    || asset.repairStatus === "已维修"
    || asset.lifecycleStatus === "可出售"
    || asset.lifecycleStatus === "已挂牌";
}

export function buildModelInventoryPools(assets: AssetView[]) {
  const heldAssets = assets.filter((asset) => asset.lifecycleStatus !== "已出售");
  const grouped = new Map<string, AssetView[]>();
  for (const asset of heldAssets) {
    const key = normalizedModelKey(asset.brand, asset.model);
    grouped.set(key, [...(grouped.get(key) ?? []), asset]);
  }

  return [...grouped.entries()]
    .filter(([, items]) => items.length > 1)
    .map(([key, items]): ModelInventoryPool => {
      const confirmedAssets = items.filter(isConfirmedInventoryAsset);
      const riskAssets = items.filter((asset) => !isConfirmedInventoryAsset(asset));
      const costs = items.map((asset) => asset.trueCost);
      const totalCarryingCost = sum(costs);
      const confirmedCarryingCost = sum(confirmedAssets.map((asset) => asset.trueCost));
      const valuedAssets = items.filter((asset) => asset.marketMedianCny !== null);
      const latestValuationTime = Math.max(...valuedAssets.map((asset) => timestamp(asset.valuationDate)));
      const latestMedians = valuedAssets
        .filter((asset) => timestamp(asset.valuationDate) === latestValuationTime)
        .flatMap((asset) => asset.marketMedianCny === null ? [] : [asset.marketMedianCny]);
      const averageCarryingCost = totalCarryingCost / items.length;
      const confirmedAverageCarryingCost = confirmedAssets.length
        ? confirmedCarryingCost / confirmedAssets.length
        : null;

      return {
        key,
        brand: items[0].brand,
        model: canonicalModel(items[0].model),
        assets: items,
        confirmedAssets,
        riskAssets,
        heldUnits: items.length,
        confirmedUnits: confirmedAssets.length,
        riskUnits: riskAssets.length,
        totalCarryingCost,
        averageCarryingCost,
        confirmedCarryingCost,
        confirmedAverageCarryingCost,
        minimumCarryingCost: Math.min(...costs),
        maximumCarryingCost: Math.max(...costs),
        latestModelMarketMedian: latestMedians.length ? median(latestMedians) : null,
        valuedUnits: valuedAssets.length,
        valuationCoverage: valuedAssets.length / items.length,
        blendedCostAdvantage: confirmedAverageCarryingCost === null
          ? null
          : confirmedAverageCarryingCost - averageCarryingCost,
      };
    })
    .sort((a, b) => b.heldUnits - a.heldUnits || b.totalCarryingCost - a.totalCarryingCost);
}

export function calculateModelPoolScenario(
  totalCarryingCost: number,
  units: number,
  grossAverageSalePrice: number,
  sellingFeePerUnit: number,
  targetRoiPercent: number,
): ModelPoolScenario {
  const safeUnits = Math.max(0, units);
  const safeGrossPrice = Math.max(0, grossAverageSalePrice);
  const safeFee = Math.max(0, sellingFeePerUnit);
  const netAverageProceeds = Math.max(0, safeGrossPrice - safeFee);
  const totalExpectedProceeds = netAverageProceeds * safeUnits;
  const totalPoolProfit = totalExpectedProceeds - totalCarryingCost;
  const averageCarryingCost = safeUnits ? totalCarryingCost / safeUnits : 0;
  return {
    units: safeUnits,
    grossAverageSalePrice: safeGrossPrice,
    sellingFeePerUnit: safeFee,
    netAverageProceeds,
    totalExpectedProceeds,
    totalPoolProfit,
    poolRoi: totalCarryingCost > 0 ? totalPoolProfit / totalCarryingCost * 100 : null,
    averageProfitPerUnit: safeUnits ? totalPoolProfit / safeUnits : 0,
    averageBreakEvenPrice: averageCarryingCost + safeFee,
    requiredAverageSalePrice: averageCarryingCost * (1 + Math.max(0, targetRoiPercent) / 100) + safeFee,
  };
}

function normalize(value: string) {
  return value.trim().replace(/\s+/g, " ").toLocaleLowerCase("en-US");
}

function timestamp(value: string | null) {
  if (!value) return Number.NEGATIVE_INFINITY;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : Number.NEGATIVE_INFINITY;
}

function median(values: number[]) {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

function sum(values: number[]) {
  return values.reduce((total, value) => total + value, 0);
}
