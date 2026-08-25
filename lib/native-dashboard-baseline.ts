import type { DashboardData } from "../db/queries";

export function createNativeDashboardBaseline(): DashboardData {
  return {
    dataSource: "baseline",
    migrationReadOnly: true,
    summary: {
      totalInvested: 0,
      projectedCostBasis: 0,
      assetCount: 0,
      currentMarketValue: 0,
      unrealizedProfit: 0,
      roi: 0,
      averageHoldingDays: 0,
      logisticsCost: 0,
      estimatedLogisticsCost: 0,
      repairCost: 0,
      otherCost: 0,
      realizedProfit: 0,
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
