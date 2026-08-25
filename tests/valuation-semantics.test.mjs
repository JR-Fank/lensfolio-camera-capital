import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  projectAssetValuation,
  projectPortfolioValuation,
} from "../lib/valuation-semantics.ts";

const portfolioRow = (overrides = {}) => ({
  total_asset_count: 0,
  total_posted_carrying_cost_cny: 0,
  valued_asset_count: 0,
  valued_asset_carrying_cost_cny: null,
  current_valuation_cny: null,
  valued_unrealized_profit_cny: null,
  valued_assets_roi: null,
  valuation_coverage_complete: false,
  portfolio_roi: null,
  ...overrides,
});

test("asset with NULL valuation keeps valuation, profit, and ROI NULL", () => {
  assert.deepEqual(projectAssetValuation({
    currentValuation: null,
    low: null,
    high: null,
    unrealizedProfit: null,
    investmentRoi: null,
  }), {
    currentValuation: null,
    low: null,
    high: null,
    unrealizedProfit: null,
    roi: null,
  });
});

test("valued asset preserves market values and profit over carrying cost ROI", () => {
  assert.deepEqual(projectAssetValuation({
    currentValuation: "7000",
    low: "6200",
    high: "7800",
    unrealizedProfit: "1972",
    investmentRoi: String(1972 / 5028),
  }), {
    currentValuation: 7000,
    low: 6200,
    high: 7800,
    unrealizedProfit: 1972,
    roi: 1972 / 5028 * 100,
  });
});

test("mixed portfolio uses only valued carrying cost for valued-assets ROI", () => {
  const result = projectPortfolioValuation(portfolioRow({
    total_asset_count: 6,
    total_posted_carrying_cost_cny: 20351,
    valued_asset_count: 5,
    valued_asset_carrying_cost_cny: 13831,
    current_valuation_cny: 17250,
    valued_unrealized_profit_cny: 3419,
    valued_assets_roi: 3419 / 13831,
  }));

  assert.equal(result.valuedAssetCount, 5);
  assert.equal(result.valuedAssetCarryingCost, 13831);
  assert.equal(result.valuedAssetsRoi, 3419 / 13831 * 100);
  assert.notEqual(result.valuedAssetsRoi, 3419 / 20351 * 100);
  assert.equal(result.portfolioRoi, null);
});

test("portfolio with zero valued assets reports no valuation result", () => {
  const result = projectPortfolioValuation(portfolioRow({
    total_asset_count: 2,
    total_posted_carrying_cost_cny: 1000,
  }));
  assert.equal(result.valuedAssetCount, 0);
  assert.equal(result.currentMarketValue, null);
  assert.equal(result.valuedUnrealizedProfit, null);
  assert.equal(result.valuedAssetsRoi, null);
  assert.equal(result.portfolioRoi, null);
});

test("100 percent valuation coverage exposes a full portfolio ROI", () => {
  const valuedRoi = 3419 / 13831;
  const result = projectPortfolioValuation(portfolioRow({
    total_asset_count: 5,
    total_posted_carrying_cost_cny: 13831,
    valued_asset_count: 5,
    valued_asset_carrying_cost_cny: 13831,
    current_valuation_cny: 17250,
    valued_unrealized_profit_cny: 3419,
    valued_assets_roi: valuedRoi,
    valuation_coverage_complete: true,
    portfolio_roi: valuedRoi,
  }));
  assert.equal(result.valuationCoverageComplete, true);
  assert.equal(result.valuedAssetsRoi, valuedRoi * 100);
  assert.equal(result.portfolioRoi, valuedRoi * 100);
});

test("migration scopes valued ROI and blocks partial full-portfolio ROI", async () => {
  const sql = await readFile(new URL(
    "../supabase/migrations/20260821001400_fix_valuation_coverage_semantics.sql",
    import.meta.url,
  ), "utf8");
  assert.match(sql, /valued_asset_carrying_cost_cny/);
  assert.match(sql, /valued_assets_roi/);
  assert.match(sql, /current_valuation_cny is not null/);
  assert.match(sql, /<> count\(\*\) filter \(where sale_id is null\) then null/);
});
