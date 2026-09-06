import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import ts from "typescript";
import { aggregateValuationTrend, trendLabelIndices } from "../lib/valuation-trend.ts";
import { capitalOccurrence, capitalTransactionKind, capitalVisibleText, projectCapitalLedger } from "../lib/capital-ledger.ts";

const valuation = (id, cameraId, valuedAt, medianCny) => ({ id, cameraId, valuedAt, medianCny });

test("Hong Kong business day crosses UTC midnight and x-axis contains short dates only", () => {
  const result = aggregateValuationTrend([
    valuation("1", "a", "2026-08-18T16:00:00Z", 100),
    valuation("2", "a", "2026-08-19T15:59:59Z", 200),
    valuation("3", "a", "2026-08-19T16:00:00Z", 300),
  ]);
  assert.deepEqual(result, [
    { day: "2026-08-19", label: "08-19", value: 200, assetCount: 1 },
    { day: "2026-08-20", label: "08-20", value: 300, assetCount: 1 },
  ]);
  for (const point of result) assert.match(point.label, /^\d{2}-\d{2}$/);
});

test("same asset/day keeps the chronologically latest record regardless of input order or offset", () => {
  const records = [
    valuation("z", "a", "2026-09-04T02:00:00Z", 100),
    valuation("a", "a", "2026-09-04T13:00:00+08:00", 150),
    valuation("b", "a", "2026-09-04T04:00:00Z", 120),
  ];
  assert.equal(aggregateValuationTrend(records)[0].value, 150);
  assert.deepEqual(aggregateValuationTrend(records), aggregateValuationTrend(records.toReversed()));
});

test("timestamp precision below a millisecond still chooses the latest valuation", () => {
  const result = aggregateValuationTrend([
    valuation("z", "a", "2026-09-04T01:00:00.123001Z", 100),
    valuation("a", "a", "2026-09-04T01:00:00.123002Z", 110),
  ]);
  assert.equal(result[0].value, 110);
});

test("different assets sum once each; missing days/assets are never filled forward", () => {
  const result = aggregateValuationTrend([
    valuation("1", "a", "2026-09-01T01:00:00Z", 100.10),
    valuation("2", "b", "2026-09-01T01:00:00Z", 200.20),
    valuation("3", "a", "2026-09-03T01:00:00Z", 120),
  ]);
  assert.deepEqual(result.map(({ value, assetCount }) => [value, assetCount]), [[300.30, 2], [120, 1]]);
  assert.equal(result.length, 2);
  assert.deepEqual(aggregateValuationTrend([]), []);
  assert.deepEqual(aggregateValuationTrend([valuation("1", "a", "invalid", 100)]), []);
});

test("adaptive labels reserve space at narrow widths and retain endpoints without dropping bars", () => {
  for (const count of [0, 1, 2, 10, 100, 500]) {
    for (const width of [0, 200, 320, 800]) {
      const indices = trendLabelIndices(count, width);
      assert.equal(new Set(indices).size, indices.length);
      assert.ok(indices.length <= Math.max(1, Math.floor(width / 64)));
      if (count) assert.equal(indices.at(-1), count - 1);
      if (indices.length > 1) assert.equal(indices[0], 0);
    }
  }
});

test("all funding transaction kinds map to Chinese; unknown values are not echoed", () => {
  const expected = { sale_proceeds: "销售回款", purchase_funding: "采购出资", cost_funding: "费用出资", refund: "退款", distribution: "分配", adjustment: "调整", reversal: "冲销" };
  for (const [kind, label] of Object.entries(expected)) assert.equal(capitalTransactionKind(kind), label);
  assert.equal(capitalTransactionKind("confirmed-capital-internal"), "其他资金事件");
  assert.equal(capitalTransactionKind("toString"), "其他资金事件");
});

test("date-only transactions never fabricate a time; exact timestamps use Hong Kong time", () => {
  assert.equal(capitalOccurrence(null, "2026-09-02"), "2026-09-02");
  assert.equal(capitalOccurrence(null, null), "日期未记录");
});

test("capital occurrence omits zero seconds: 10:32:00 becomes 10:32", () => {
  assert.equal(capitalOccurrence("2026-09-03T02:32:00Z", null), "2026-09-03 10:32");
  assert.equal(capitalOccurrence("2026-09-03T10:32:00+08:00", null), "2026-09-03 10:32");
});

test("capital occurrence preserves nonzero seconds: 17:40:41 stays 17:40:41", () => {
  assert.equal(capitalOccurrence("2026-09-04T09:40:41Z", null), "2026-09-04 17:40:41");
  assert.equal(capitalOccurrence("2026-09-02T15:00:01Z", null), "2026-09-02 23:00:01");
});

const uuid = "12345678-1234-1234-1234-123456789abc";
function ledgerInput() {
  return {
    participants: ["A", "B", "C"].map((name, index) => ({ participant_id: `p${index}`, display_name: `Partner ${name}`, gross_contribution_cny: "200.50", reversed_or_distributed_cny: "10.25", net_contribution_cny: "190.25" })),
    pools: [{ account_id: "pool", gross_inflow_cny: "1000", gross_outflow_cny: "400", balance_cny: "600" }],
    accounts: [{ account_id: "pool", account_kind: "sales_proceeds_pool", participant_id: null }, { account_id: "a", account_kind: "participant_capital", participant_id: "p0" }],
    transactions: [{ id: uuid, transaction_kind: "sale_proceeds", amount_cny: "1000", occurred_at: null, occurred_on: "2026-09-02", sale_id: "sale", purchase_item_id: null, cost_entry_id: null, shipment_id: null, reversal_of: null, note: `到账 confirmed-capital-funding-v1:receipt ${uuid}`, idempotency_key: "secret-import-key", provenance_key: "private-source-key" }],
    allocations: [{ transaction_id: uuid, account_id: "pool", amount_cny: "1000" }, { transaction_id: "draft", account_id: "pool", amount_cny: "20" }],
    sales: [{ id: "sale", asset_id: "asset" }], costs: [], purchases: [],
    assets: [{ id: "asset", brand: "Canon", model: "Autoboy" }], realizedProfit: "210.25",
  };
}

test("presentation uses database projections, supports Partner C and strips internal metadata", () => {
  const result = projectCapitalLedger(ledgerInput());
  assert.equal(result.participants.length, 3);
  assert.equal(result.participants[2].name, "Partner C");
  assert.equal(result.pool.balance, 600);
  assert.equal(result.realizedProfit, 210.25);
  assert.equal(result.transactions[0].source, "销售 · Canon Autoboy");
  assert.equal(result.transactions[0].occurrence, "2026-09-02");
  assert.equal(result.transactions[0].note, "到账");
  assert.equal(result.transactions[0].allocations.length, 1);
  assert.doesNotMatch(JSON.stringify(result), /confirmed-capital|12345678|idempotency|provenance|secret-import|private-source/);
  assert.equal(capitalVisibleText("EMS refund; provenance_key=hidden:value; idempotency_key=private-key"), "EMS refund");
  assert.equal(capitalVisibleText("Confirmed capital funding v1"), null);
});

test("refund preserves signed participant allocation and original logistics source", () => {
  const input = ledgerInput();
  input.transactions[0] = { ...input.transactions[0], transaction_kind: "cost_funding", sale_id: null, cost_entry_id: "cost", shipment_id: "shipment", occurred_at: "2026-09-01T00:00:00Z", occurred_on: null };
  input.costs = [{ id: "cost", asset_id: "asset" }];
  input.allocations[0] = { transaction_id: uuid, account_id: "a", amount_cny: "1000" };
  input.transactions.push({ ...input.transactions[0], id: "refund", transaction_kind: "refund", amount_cny: "10", occurred_at: "2026-09-04T01:00:00Z", reversal_of: uuid, cost_entry_id: "reversal-cost", shipment_id: null });
  input.allocations.push({ transaction_id: "refund", account_id: "a", amount_cny: "-10" });
  const result = projectCapitalLedger(input);
  assert.equal(result.transactions[0].source, "退款 · 物流费用 · Canon Autoboy");
  assert.deepEqual(result.transactions[0].allocations, [{ account: "Partner A · 出资账户", amount: -10 }]);
  assert.equal(result.realizedProfit, 210.25);
});

test("missing or inconsistent funding evidence fails instead of displaying partial money", () => {
  const input = ledgerInput();
  input.allocations = [];
  assert.throws(() => projectCapitalLedger(input), /do not reconcile/);
  const missing = ledgerInput();
  missing.realizedProfit = undefined;
  assert.throws(() => projectCapitalLedger(missing), /Invalid/);
});

async function component(relativePath) {
  const url = new URL(relativePath, import.meta.url);
  const source = await readFile(url, "utf8");
  const { outputText } = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.ESNext, jsx: ts.JsxEmit.ReactJSX, target: ts.ScriptTarget.ES2022 },
  });
  const code = outputText.replace(/from "([^"]+)"/g, (_, specifier) => {
    const resolved = specifier.startsWith(".") ? new URL(`${specifier}.ts`, url).href : import.meta.resolve(specifier);
    return `from ${JSON.stringify(resolved)}`;
  });
  return (await import(`data:text/javascript;base64,${Buffer.from(code).toString("base64")}`)).default;
}

test("rendered capital page displays date evidence, third participant and no internal identifiers", async () => {
  const Component = await component("../app/capital/CapitalLedgerView.tsx");
  const html = renderToStaticMarkup(createElement(Component, { data: projectCapitalLedger(ledgerInput()) }));
  assert.match(html, /销售回款池 ≠ 利润/);
  assert.match(html, /Partner C/);
  assert.match(html, /2026-09-02<\/p>/);
  assert.match(html, /cost_entries/);
  assert.doesNotMatch(html, /00:00|confirmed-capital|12345678|idempotency|provenance|<table|<button|<form/);
  assert.match(html, /Partner A 累计净投入/);
});

test("capital ledger uses compact rows without a horizontal table or oversized transaction amounts", async () => {
  const source = await readFile(new URL("../app/globals.css", import.meta.url), "utf8");
  const componentSource = await readFile(new URL("../app/capital/CapitalLedgerView.tsx", import.meta.url), "utf8");
  assert.match(componentSource, /capital-transaction-main/);
  assert.match(source, /\.capital-transaction-main \{[^}]*grid-template-columns: 150px 100px minmax\(0, 1fr\) minmax\(120px, .7fr\) auto/);
  assert.match(source, /\.capital-transaction-main strong \{ font: 600 15px/);
  assert.doesNotMatch(source, /\.capital-transactions header strong \{ font: 600 24px/);
  assert.match(source, /@media \(max-width: 640px\)[\s\S]*\.capital-transaction-main \{ grid-template-columns: minmax\(0, 1fr\) auto/);
});

test("historical funding migration contains all confirmed sources and safe compatibility checks", async () => {
  const source = await readFile(new URL("../supabase/migrations/20260905000600_reconcile_partner_b_historical_funding.sql", import.meta.url), "utf8");
  for (const value of ["20722.00", "327e8837-c440-4fd9-ad75-4a596db268a8", "97f2b550-e975-40d0-b2f5-51789aebb174", "f167f41e-f65b-4a7c-a86e-b1f996c4e9c8"]) assert.match(source, new RegExp(value));
  assert.match(source, /security invoker/);
  assert.match(source, /private\.can_write_portfolio/);
  assert.match(source, /pg_advisory_xact_lock/);
  assert.match(source, /partner-b-historical-funding-v1:/);
  assert.match(source, /Existing TVS II Partner B funding/);
  assert.match(source, /A historical cost entry already has different posted funding/);
  assert.match(source, /v_count <> 12 or v_historical_count <> 12 or v_historical_total <> 20722\.00/);
  assert.match(source, /Historical funding receipt conflicts with the reconciled slice/);
  assert.doesNotMatch(source, /if v_pool <> 2673 or v_a <> 87/);
  assert.match(source, /exact_confirmed as/);
  assert.match(source, /v_confirmed_count <> 7 or v_pool_slice <> 2673 or v_a_slice <> 87/);
  assert.match(source, /v_tvs_funding <> 2665/);
  assert.match(source, /t\.purchase_order_id is not distinct from/);
  assert.match(source, /t\.shipment_item_id is not distinct from/);
  assert.match(source, /all_allocations\.transaction_id = t\.id\) = 1/);
  assert.match(source, /t\.purchase_order_id = i\.purchase_order_id/);
  assert.match(source, /t\.shipment_id = i\.shipment_id/);
  assert.match(source, /exact_historical as/);
  assert.match(source, /t\.occurred_at = c\.occurred_at/);
  assert.match(source, /sale_id in \(p_t2_date_back_sale_id, v_sale\.id\)/);
});

test("capital metrics remain dynamic while accepting the reconciled 19-event totals", () => {
  const input = ledgerInput();
  input.participants = [
    { participant_id: "p0", display_name: "Partner A", gross_contribution_cny: "109", reversed_or_distributed_cny: "22", net_contribution_cny: "87" },
    { participant_id: "p1", display_name: "Partner B", gross_contribution_cny: "23387", reversed_or_distributed_cny: "0", net_contribution_cny: "23387" },
  ];
  input.accounts = [
    { account_id: "pool", account_kind: "sales_proceeds_pool", participant_id: null },
    { account_id: "a", account_kind: "participant_capital", participant_id: "p0" },
    { account_id: "b", account_kind: "participant_capital", participant_id: "p1" },
  ];
  input.pools = [{ account_id: "pool", gross_inflow_cny: "7476", gross_outflow_cny: "4803", balance_cny: "2673" }];
  input.realizedProfit = "1356";
  input.transactions = Array.from({ length: 19 }, (_, index) => ({
    ...input.transactions[0], id: `transaction-${index}`, amount_cny: "1", note: null,
  }));
  input.allocations = input.transactions.map((transaction) => ({ transaction_id: transaction.id, account_id: "pool", amount_cny: "1" }));
  const result = projectCapitalLedger(input);
  assert.equal(result.transactions.length, 19);
  assert.deepEqual(result.participants.map(({ name, net }) => [name, net]), [["Partner A", 87], ["Partner B", 23387]]);
  assert.equal(result.pool.balance, 2673);
  assert.equal(result.realizedProfit, 1356);
});

test("rendered market chart retains every observed date bar and never renders an ISO x-axis", async () => {
  const Component = await component("../app/MarketValueTrend.tsx");
  const valuations = Array.from({ length: 90 }, (_, index) => valuation(String(index), "a", new Date(Date.UTC(2026, 0, index + 1, 16)).toISOString(), 100 + index));
  const html = renderToStaticMarkup(createElement(Component, { valuations }));
  assert.equal((html.match(/role="listitem"/g) ?? []).length, 90);
  assert.doesNotMatch(html, /T16:00|\.000Z/);
  assert.match(html, /market-trend-axis/);
});

test("reader is session/RLS scoped, paginated, posted only, and does not select provenance or mutate", async () => {
  const source = await readFile(new URL("../lib/supabase/capital-ledger.ts", import.meta.url), "utf8");
  assert.match(source, /import "server-only"/);
  assert.match(source, /getPortfolioAccess\(\)/);
  assert.match(source, /createClient\(\)/);
  assert.match(source, /\.eq\("portfolio_id", portfolioId\)/);
  assert.match(source, /\.range\(offset, offset \+ pageSize - 1\)/);
  assert.match(source, /\.eq\("transaction_status", "posted"\)/);
  assert.match(source, /"id", true\)/);
  assert.doesNotMatch(source, /\.insert\(|\.update\(|\.upsert\(|\.delete\(|\.rpc\(|service.role|idempotency|provenance/i);
});
