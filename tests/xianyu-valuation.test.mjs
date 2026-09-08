import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  XIANYU_PRICE_SEMANTICS,
  assertResearchableAsset,
  calculateConfidence,
  calculateValuationStatistics,
  canonicalizeListingUrl,
  classifyListing,
  deduplicateListings,
  getXianyuModelAliases,
  isValidIsoDateTime,
  listingFingerprint,
  mergeSearchTerms,
  normalizeSearchTerms,
} from "../lib/valuation/xianyu.ts";

const target = { brand: "Contax", model: "T2" };
const listing = (overrides = {}) => ({
  title: "Contax T2 功能正常 胶片相机",
  askingPrice: 8000,
  currency: "CNY",
  sellerName: "seller-a",
  ...overrides,
});

test("search terms put the Chinese localized name first", () => {
  const terms = normalizeSearchTerms({ brand: "Contax", model: "T2 Date Back" });
  assert.equal(terms[0], "康泰时 T2");
  assert.ok(terms.includes("Contax T2 Date Back"));
  assert.deepEqual(
    mergeSearchTerms({ brand: "Contax", model: "T2 Date Back" }, ["CONTAX T2 DATE BACK", "闲鱼 T2"]),
    ["康泰时 T2", "Contax T2 Date Back", "T2 Date Back", "闲鱼 T2"],
  );
});

test("Chinese and formal model aliases are first-class matching evidence", () => {
  const included = { reviewStatus: "included", exclusionReason: null };
  assert.deepEqual(classifyListing(listing({ title: "康泰时 T2 功能正常" }), { brand: "Contax", model: "T2" }), included);
  assert.deepEqual(classifyListing(listing({ title: "康泰时 TVS II 功能正常" }), { brand: "Contax", model: "TVS II" }), included);
  assert.deepEqual(classifyListing(listing({ title: "尼康 28Ti 全部正常" }), { brand: "Nikon", model: "28Ti" }), included);
  assert.deepEqual(classifyListing(listing({ title: "佳能 小霹雳 S 正常使用" }), { brand: "Canon", model: "Autoboy S" }), included);
  assert.deepEqual(classifyListing(listing({ title: "佳能 小霹雳 S II 测试正常" }), { brand: "Canon", model: "Autoboy S II" }), included);
  assert.ok(getXianyuModelAliases({ brand: "Rollei", model: "35 Classic Titanium" }).includes("禄来 35 Classic 钛金版"));
});

test("specific variants do not cross-match shorter model aliases", () => {
  assert.equal(
    classifyListing(listing({ title: "佳能 Autoboy S II 功能正常" }), { brand: "Canon", model: "Autoboy S" }).exclusionReason,
    "different_variant",
  );
  assert.equal(
    classifyListing(listing({ title: "佳能 Autoboy S 功能正常" }), { brand: "Canon", model: "Autoboy S II" }).exclusionReason,
    "different_variant",
  );
  assert.equal(
    classifyListing(listing({ title: "佳能 小霹雳 S II 功能正常" }), { brand: "Canon", model: "Autoboy S" }).exclusionReason,
    "different_variant",
  );
  assert.equal(
    classifyListing(listing({ title: "佳能 小霹雳 S 功能正常" }), { brand: "Canon", model: "Autoboy S II" }).exclusionReason,
    "different_variant",
  );
  assert.equal(
    classifyListing(listing({ title: "康泰时 T2 Date Back 功能正常" }), { brand: "Contax", model: "T2" }).exclusionReason,
    "different_variant",
  );
  assert.equal(
    classifyListing(listing({ title: "康泰时 T2 功能正常" }), { brand: "Contax", model: "T2 Date Back" }).exclusionReason,
    "different_variant",
  );
});

test("Rollei Titanium accepts Chinese aliases but rejects or defers other variants", () => {
  const titanium = { brand: "Rollei", model: "35 Classic Titanium" };
  for (const title of [
    "Rollei 35 Classic Titanium 功能正常",
    "Rollei 35 Classic 钛 功能正常",
    "禄来 35 Classic 钛 功能正常",
    "禄来 35 Classic 钛金版 功能正常",
  ]) {
    assert.deepEqual(classifyListing(listing({ title }), titanium), { reviewStatus: "included", exclusionReason: null });
  }
  assert.equal(classifyListing(listing({ title: "Rollei 35 Classic Gold 功能正常" }), titanium).exclusionReason, "different_variant");
  assert.equal(classifyListing(listing({ title: "禄来 35 Classic 铂金版 功能正常" }), titanium).exclusionReason, "different_variant");
  assert.deepEqual(
    classifyListing(listing({ title: "禄来 35 Classic 功能正常" }), titanium),
    { reviewStatus: "pending", exclusionReason: null },
  );
});

test("conservative classifier excludes accessories, wanted posts, wrong models, junk, and variants", () => {
  assert.equal(classifyListing(listing({ title: "Contax T2 原装皮套" }), target).exclusionReason, "accessory");
  assert.equal(classifyListing(listing({ title: "求购 Contax T2" }), target).exclusionReason, "wanted");
  assert.equal(classifyListing(listing({ title: "Contax TVS II 功能正常" }), target).exclusionReason, "wrong_model");
  assert.equal(classifyListing(listing({ title: "Contax T2 尸体机" }), target).exclusionReason, "broken_or_junk");
  assert.equal(classifyListing(listing({ title: "Contax T2 Date Back 功能正常" }), target).exclusionReason, "different_variant");
  assert.deepEqual(classifyListing(listing(), target), { reviewStatus: "included", exclusionReason: null });
  assert.deepEqual(classifyListing(listing({ title: "Contax T2 实物图" }), target), { reviewStatus: "pending", exclusionReason: null });
});

test("condition evidence is operational, uncertainty wins, and accessories are contextual", () => {
  assert.deepEqual(
    classifyListing(listing({ title: "Contax T2 成色良好" }), target),
    { reviewStatus: "pending", exclusionReason: null },
  );
  assert.deepEqual(
    classifyListing(listing({ title: "Contax T2 成色良好 未测试" }), target),
    { reviewStatus: "pending", exclusionReason: null },
  );
  assert.deepEqual(
    classifyListing(listing({ title: "Contax T2 功能正常" }), target),
    { reviewStatus: "included", exclusionReason: null },
  );
  assert.equal(classifyListing(listing({ title: "Contax T2 相机皮套" }), target).exclusionReason, "accessory");
  assert.deepEqual(
    classifyListing(listing({ title: "Contax T2 功能正常，带原装皮套" }), target),
    { reviewStatus: "included", exclusionReason: null },
  );
});

test("canonical URLs preserve item identity and remove only explicit tracking parameters", () => {
  assert.notEqual(
    canonicalizeListingUrl("https://example.com/item?id=123"),
    canonicalizeListingUrl("https://example.com/item?id=456"),
  );
  assert.equal(
    canonicalizeListingUrl("https://EXAMPLE.com/item?id=123&utm_source=share&track=abc#photo"),
    canonicalizeListingUrl("https://example.com/item?id=123"),
  );
  assert.match(canonicalizeListingUrl("https://example.com/item?itemId=ABC&unknown=keep"), /itemId=ABC/);
  assert.match(canonicalizeListingUrl("https://example.com/item?item_id=123&auctionId=456"), /item_id=123/);
});

test("fingerprint is deterministic and dedupe uses external ID, canonical URL, then fingerprint", async () => {
  assert.equal(await listingFingerprint(listing()), await listingFingerprint(listing()));
  const result = await deduplicateListings([
    listing({ externalListingId: "A-1", title: "Contax T2 功能正常 A" }),
    listing({ externalListingId: "a-1", title: "Contax T2 功能正常 duplicate id" }),
    listing({ externalListingId: "B-1", listingUrl: "https://example.com/item/2?track=x", title: "Contax T2 功能正常 B" }),
    listing({ externalListingId: "B-2", listingUrl: "https://example.com/item/2#top", title: "Contax T2 功能正常 duplicate url" }),
    listing({ title: "Contax T2 功能正常 fingerprint", sellerName: "same", askingPrice: 8100 }),
    listing({ title: "Contax T2 功能正常 fingerprint", sellerName: "same", askingPrice: 8100 }),
  ], target);
  assert.equal(result.listings.length, 3);
  assert.equal(result.duplicateCount, 3);
  assert.equal(new Set(result.listings.map((row) => row.listingFingerprint)).size, 3);
});

test("dedupe carries identities through duplicate rows transitively", async () => {
  const result = await deduplicateListings([
    listing({ externalListingId: "X", title: "Contax T2 功能正常 A" }),
    listing({ externalListingId: "X", listingUrl: "https://example.com/item?id=U", title: "Contax T2 功能正常 B" }),
    listing({ externalListingId: "Y", listingUrl: "https://example.com/item?id=U", title: "Contax T2 功能正常 C" }),
  ], target);
  assert.equal(result.listings.length, 1);
  assert.equal(result.duplicateCount, 2);
});

test("zero asking prices remain review evidence but can never be included", () => {
  assert.deepEqual(
    classifyListing(listing({ askingPrice: 0 }), target),
    { reviewStatus: "excluded", exclusionReason: "suspicious_price" },
  );
});

test("listing timestamps require an ISO datetime with an explicit timezone", () => {
  assert.equal(isValidIsoDateTime("2026-08-26T12:30:00+08:00"), true);
  assert.equal(isValidIsoDateTime("2026-08-26T04:30:00Z"), true);
  assert.equal(isValidIsoDateTime("2026-08-26 12:30:00"), false);
  assert.equal(isValidIsoDateTime("not-a-date"), false);
});

test("percentiles match PostgreSQL percentile_cont interpolation semantics", () => {
  assert.deepEqual(calculateValuationStatistics([400, 100, 300, 200]), {
    sampleCount: 4,
    low: 100,
    p25: 175,
    median: 250,
    p75: 325,
    high: 400,
  });
});

test("confidence is explainable and bounded between zero and one", () => {
  const sparse = calculateConfidence({ includedPrices: [1000], rawCount: 8, excludedCount: 7 });
  const stronger = calculateConfidence({ includedPrices: [980, 1000, 1020, 1030, 1050, 1060, 1070, 1080], rawCount: 10, excludedCount: 2 });
  assert.ok(sparse >= 0 && sparse <= 1);
  assert.ok(stronger >= 0 && stronger <= 1);
  assert.ok(stronger > sparse);
});

test("asking price semantics are explicit and sold assets cannot start research", () => {
  assert.equal(XIANYU_PRICE_SEMANTICS, "asking_price");
  assert.doesNotThrow(() => assertResearchableAsset({ operational_status: "acquired" }));
  assert.throws(() => assertResearchableAsset({ operational_status: "sold" }), /已出售资产/);
});

test("migration enforces RLS, cross-portfolio keys, draft isolation, and atomic idempotent confirmation", async () => {
  const sql = await readFile(new URL(
    "../supabase/migrations/20260821001900_create_xianyu_valuation_research_workflow.sql",
    import.meta.url,
  ), "utf8");
  assert.match(sql, /drop constraint market_listings_market_source_id_external_listing_id_key/i);
  assert.match(sql, /market_listings_source_external_id_idx[\s\S]*\(market_source_id, external_listing_id\)/i);
  assert.match(sql, /unique \(portfolio_id, id, asset_id, market_source_id\)/i);
  assert.match(sql, /foreign key \(portfolio_id, research_run_id, asset_id, market_source_id\)[\s\S]*references public\.valuation_research_runs\(portfolio_id, id, asset_id, market_source_id\)/i);
  assert.match(sql, /research_run_id is null[\s\S]*asset_id is not null and listing_fingerprint is not null/i);
  assert.match(sql, /foreign key \(portfolio_id, confirmed_snapshot_id\)/i);
  assert.match(sql, /private\.is_portfolio_member/);
  assert.match(sql, /private\.can_write_portfolio/);
  assert.match(sql, /security invoker/i);
  assert.match(sql, /select \* into v_run[\s\S]*for update/i);
  assert.match(sql, /from public\.market_listings listing[\s\S]*for update/i);
  assert.match(sql, /percentile_cont\(0\.25\)[\s\S]*percentile_cont\(0\.50\)[\s\S]*percentile_cont\(0\.75\)/i);
  assert.match(sql, /listing\.currency <> 'CNY'/);
  assert.match(sql, /listing\.asking_price <= 0/);
  assert.match(sql, /listing\.asset_id = v_run\.asset_id/);
  assert.match(sql, /listing\.market_source_id = v_run\.market_source_id/);
  assert.match(sql, /sale\.status = 'sold'/);
  assert.match(sql, /source\.source_type = 'xianyu'/);
  assert.match(sql, /listing\.review_status = 'pending'/);
  assert.match(sql, /if v_run\.status = 'confirmed'[\s\S]*from public\.valuation_snapshots snapshot[\s\S]*'sample_count', v_snapshot\.sample_count/i);
  assert.match(sql, /on conflict on constraint valuation_snapshots_portfolio_legacy_key do nothing/i);
  assert.match(sql, /protect_confirmed_valuation_research_evidence/i);
  assert.match(sql, /protect_confirmed_valuation_research_run/i);
  assert.match(sql, /Confirmed valuation research evidence is immutable/i);
  assert.match(sql, /Confirmed valuation research runs are immutable/i);
  assert.equal((sql.match(/insert into public\.valuation_snapshots/gi) ?? []).length, 1);
  assert.match(sql, /status in \('researching', 'ready_for_review', 'failed', 'confirmed', 'cancelled'\)/i);
});

test("research API rejects negative prices and invalid timestamps before creating a run", async () => {
  const source = await readFile(new URL("../app/api/valuations/research/route.ts", import.meta.url), "utf8");
  const parseStart = source.indexOf("function parseListing");
  const authStart = source.indexOf("async function authenticatedRequest");
  const parser = source.slice(parseStart, authStart);
  assert.match(parser, /!Number\.isFinite\(askingPrice\) \|\| askingPrice < 0/);
  assert.match(parser, /optionalIsoDateTime\(row\.listedAt/);
  assert.match(parser, /optionalIsoDateTime\(row\.capturedAt/);
  assert.ok(source.indexOf("isValidIsoDateTime") < source.indexOf("createValuationResearchRun(supabase"));
});

test("research start checks completed sales before creating a run and preserves Chinese-first terms", async () => {
  const source = await readFile(new URL("../app/api/valuations/research/route.ts", import.meta.url), "utf8");
  const saleCheck = source.indexOf('.from("sales")');
  const runCreate = source.indexOf("createValuationResearchRun(supabase");
  assert.ok(saleCheck > 0 && saleCheck < runCreate);
  assert.match(source, /\.eq\("status", "sold"\)/);
  assert.match(source, /if \(completedSale\) throw new ValuationWorkflowError/);
  assert.match(source, /mergeSearchTerms\(asset, suppliedTerms\)/);
});

test("ready, failed, and cancelled workflows do not have an application snapshot write path", async () => {
  const helper = await readFile(new URL("../lib/supabase/valuations.ts", import.meta.url), "utf8");
  assert.doesNotMatch(helper, /\.from\("valuation_snapshots"\)/);
  assert.match(helper, /rpc\("confirm_valuation_research_run"/);
});

test("review helper validates terminal run state and listing ownership before UPDATE", async () => {
  const helper = await readFile(new URL("../lib/supabase/valuations.ts", import.meta.url), "utf8");
  const reviewFunction = helper.slice(
    helper.indexOf("export async function updateListingReview"),
    helper.indexOf("export async function cancelValuationResearchRun"),
  );
  assert.ok(reviewFunction.indexOf("getValuationResearchRun") < reviewFunction.indexOf('.from("market_listings")\n    .update'));
  assert.ok(reviewFunction.indexOf('run.status === "confirmed"') < reviewFunction.indexOf('.from("market_listings")\n    .update'));
  assert.ok(reviewFunction.indexOf('.select("id")') < reviewFunction.indexOf('.from("market_listings")\n    .update'));
  assert.match(reviewFunction, /\.eq\("portfolio_id", run\.portfolio_id\)/);
  assert.match(reviewFunction, /\.eq\("asset_id", run\.asset_id\)/);
  assert.match(reviewFunction, /\.eq\("market_source_id", run\.market_source_id\)/);
});

test("new valuation UI never references the legacy D1 endpoint", async () => {
  const files = await Promise.all([
    readFile(new URL("../app/ManagementApp.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/api/valuations/research/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/api/valuations/confirm/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/cameras/[id]/valuation/research/ValuationResearchIntake.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/cameras/[id]/valuation/research/[runId]/ValuationResearchReview.tsx", import.meta.url), "utf8"),
  ]);
  const implementation = files.join("\n");
  assert.doesNotMatch(implementation, /fetch\(["']\/api\/valuations["']/);
  assert.match(implementation, /\/api\/valuations\/research/);
  assert.match(implementation, /\/api\/valuations\/confirm/);
});

test("research intake closes the browser UX path without implementing scraping", async () => {
  const [page, intake] = await Promise.all([
    readFile(new URL("../app/cameras/[id]/valuation/research/page.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/cameras/[id]/valuation/research/ValuationResearchIntake.tsx", import.meta.url), "utf8"),
  ]);
  assert.match(intake, /fetch\("\/api\/valuations\/research"/);
  assert.match(intake, /method: "POST"/);
  assert.match(intake, /router\.push\(result\.reviewUrl\)/);
  assert.match(intake, /JSON\.parse/);
  assert.match(intake, /Array\.isArray\(listings\)/);
  assert.match(intake, /typeof row\.title !== "string"/);
  assert.match(intake, /askingPrice 必须是数字/);
  assert.match(intake, /此页面不会自动登录或抓取闲鱼/);
  assert.match(page, /闲鱼挂牌价 asking prices，不代表真实成交价/);
  assert.match(page, /<ValuationResearchIntake/);
  assert.doesNotMatch(page, /POST \/api\/valuations\/research/);
  assert.doesNotMatch(`${page}\n${intake}`, /xianyu\.com|puppeteer|playwright|browser automation/i);
});

test("entry and review enforce role, sold lifecycle, pending review, and terminal navigation UX", async () => {
  const [page, intake, review] = await Promise.all([
    readFile(new URL("../app/cameras/[id]/valuation/research/page.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/cameras/[id]/valuation/research/ValuationResearchIntake.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/cameras/[id]/valuation/research/[runId]/ValuationResearchReview.tsx", import.meta.url), "utf8"),
  ]);
  assert.match(page, /\.from\("sales"\)[\s\S]*\.eq\("status", "sold"\)/);
  assert.match(page, /asset\.operational_status === "sold" \|\| Boolean\(completedSale\)/);
  assert.match(page, /已出售资产不再更新估值/);
  assert.match(page, /getPortfolioAccess\(\)/);
  assert.match(page, /portfolioCanWrite && portfolioId === asset\.portfolio_id/);
  const access = await readFile(new URL("../lib/supabase/portfolio-access.ts", import.meta.url), "utf8");
  assert.match(access, /membership\.role === "owner" \|\| membership\.role === "editor"/);
  assert.match(page, /canWrite=\{canWrite\}/);
  assert.match(intake, /if \(!canWrite \|\| busy\) return/);
  assert.match(intake, /当前账户只有查看权限，不能创建估值研究/);
  assert.match(intake, /disabled=\{!canWrite \|\| busy\}/);
  assert.match(review, /const pendingCount = listings\.filter/);
  assert.match(review, /run\.included_count > 0/);
  assert.match(review, /pendingCount === 0/);
  assert.match(review, /disabled=\{!canConfirm\}/);
  assert.match(review, /还有 \{pendingCount\} 条待复核样本/);
  assert.equal((review.match(/router\.push\(`\/cameras\/\$\{asset\.id\}`\)/g) ?? []).length, 2);
  assert.match(review, /const closed = run\.status === "confirmed" \|\| run\.status === "cancelled"/);
});

test("valuation workflow cannot mutate financial, cost, sale, shipping, or purchase tables", async () => {
  const sources = await Promise.all([
    readFile(new URL("../lib/supabase/valuations.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/api/valuations/research/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/api/valuations/confirm/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../supabase/migrations/20260821001900_create_xianyu_valuation_research_workflow.sql", import.meta.url), "utf8"),
  ]);
  const implementation = sources.join("\n");
  for (const forbidden of ["cost_entries", "sales", "shipments", "shipment_items", "purchase_orders", "purchase_items"]) {
    assert.doesNotMatch(implementation, new RegExp(`(?:insert into|update|delete from)\\s+(?:public\\.)?${forbidden}`, "i"));
  }
  assert.doesNotMatch(implementation, /service_role|SUPABASE_SECRET_KEY/);
});
