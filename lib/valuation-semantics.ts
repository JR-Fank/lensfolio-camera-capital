export type NumericValue = number | string | null | undefined;

export function nullableNumber(value: NumericValue): number | null {
  if (value === null || value === undefined || value === "") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function nullablePercentage(value: NumericValue): number | null {
  const parsed = nullableNumber(value);
  return parsed === null ? null : parsed * 100;
}

export function projectAssetValuation(input: {
  currentValuation: NumericValue;
  low: NumericValue;
  high: NumericValue;
  unrealizedProfit: NumericValue;
  investmentRoi: NumericValue;
}) {
  const currentValuation = nullableNumber(input.currentValuation);
  if (currentValuation === null) {
    return {
      currentValuation: null,
      low: null,
      high: null,
      unrealizedProfit: null,
      roi: null,
    };
  }

  return {
    currentValuation,
    low: nullableNumber(input.low),
    high: nullableNumber(input.high),
    unrealizedProfit: nullableNumber(input.unrealizedProfit),
    roi: nullablePercentage(input.investmentRoi),
  };
}

export type PortfolioValuationMetricRow = {
  total_asset_count: NumericValue;
  total_posted_carrying_cost_cny: NumericValue;
  valued_asset_count: NumericValue;
  valued_asset_carrying_cost_cny: NumericValue;
  current_valuation_cny: NumericValue;
  valued_unrealized_profit_cny: NumericValue;
  valued_assets_roi: NumericValue;
  valuation_coverage_complete: boolean;
  portfolio_roi: NumericValue;
};

export function projectPortfolioValuation(row: PortfolioValuationMetricRow) {
  return {
    totalAssetCount: Math.trunc(Number(row.total_asset_count)),
    totalPostedCarryingCost: Number(row.total_posted_carrying_cost_cny),
    valuedAssetCount: Math.trunc(Number(row.valued_asset_count)),
    valuedAssetCarryingCost: nullableNumber(row.valued_asset_carrying_cost_cny),
    currentMarketValue: nullableNumber(row.current_valuation_cny),
    valuedUnrealizedProfit: nullableNumber(row.valued_unrealized_profit_cny),
    valuedAssetsRoi: nullablePercentage(row.valued_assets_roi),
    valuationCoverageComplete: row.valuation_coverage_complete,
    portfolioRoi: nullablePercentage(row.portfolio_roi),
  };
}
