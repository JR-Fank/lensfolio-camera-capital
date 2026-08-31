import type { DashboardData } from "../db/queries";

export function createNativeDashboardBaseline(): DashboardData {
  return {
    dataSource: "baseline",
    migrationReadOnly: true,
    summary: {
      totalInvested: 0,
      projectedCostBasis: 0,
      assetCount: 0,
      totalAssetCount: 0,
      heldAssetCount: 0,
      soldAssetCount: 0,
      heldCarryingCost: 0,
      currentMarketValue: null,
      unrealizedProfit: null,
      roi: null,
      valuedAssetCount: 0,
      valuedAssetCarryingCost: null,
      valuationCoverageComplete: false,
      portfolioRoi: null,
      averageHoldingDays: 0,
      logisticsCost: 0,
      estimatedLogisticsCost: 0,
      repairCost: 0,
      otherCost: 0,
      realizedProfit: 0,
      realizedRoi: null,
      totalProfit: null,
    },
    assets: [],
    logistics: [],
    repairs: [],
    sales: [],
    expenses: [],
    valuationHistory: [],
    refreshedAt: new Date().toISOString(),
  };
}
