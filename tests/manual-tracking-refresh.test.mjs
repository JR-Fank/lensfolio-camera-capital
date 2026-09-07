import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { stripTypeScriptTypes } from "node:module";
import test from "node:test";
import { runInNewContext } from "node:vm";
import {
  deriveJapanPostShipmentState,
  japanPostEventFingerprint,
  parseJapanPostJstTimestamp,
  parseJapanPostTracking,
} from "../lib/tracking/japan-post.ts";
import {
  assertTrackingWriteRole,
  runManualTrackingSync,
} from "../lib/supabase/tracking.ts";

const SHIPMENT_ID = "e0a99216-763a-58ef-a7d9-d490bbf40fb7";
const PORTFOLIO_ID = "10000000-0000-4000-8000-000000000001";
const USER_ID = "10000000-0000-4000-8000-000000000002";
const RUN_ID = "10000000-0000-4000-8000-000000000003";

// Exercise the actual private helpers without loading Next.js or a Supabase session.
async function loadSourceFunction(path, name) {
  const source = await readFile(new URL(path, import.meta.url), "utf8");
  const declaration = source.match(new RegExp(`^function ${name}\\([\\s\\S]*?^\\}`, "m"));
  assert.ok(declaration, `Missing function ${name} in ${path}`);
  return runInNewContext(`${stripTypeScriptTypes(declaration[0])}\n${name}`);
}

const shipmentDisplayName = await loadSourceFunction(
  "../lib/supabase/dashboard.ts", "shipmentDisplayName",
);
const shipmentCarrierDisplayName = await loadSourceFunction(
  "../lib/supabase/dashboard.ts", "shipmentCarrierDisplayName",
);
const isUuid = await loadSourceFunction(
  "../app/api/logistics/refresh/route.ts", "isUuid",
);

test("internal shipment provenance is replaced with a user-facing logistics name", () => {
  for (const suffix of ["t2", "tvs", "future-shipment"]) {
    const shipment = { id: SHIPMENT_ID, legacy_id: `confirmed-capital-source-v1:${suffix}` };
    assert.equal(shipmentDisplayName(shipment, "Contax T2"), "Contax T2 · 国际物流");
    assert.equal(shipmentDisplayName(shipment, ""), "国际物流");
    assert.equal(shipment.legacy_id, `confirmed-capital-source-v1:${suffix}`);
  }
});

test("other historical shipment names and existing fallbacks are preserved", () => {
  const display = (legacy_id, cameraNames = "") =>
    shipmentDisplayName({ id: SHIPMENT_ID, legacy_id }, cameraNames);
  assert.equal(display("evidence:logistics:t2", "Contax T2"), "Contax T2 · 国际物流");
  assert.equal(display("evidence:logistics:t2"), "国际物流");
  assert.equal(display("historical-batch-001", "Contax T2"), "historical-batch-001");
  assert.equal(display("confirmed-capital-source-v2:t2"), "confirmed-capital-source-v2:t2");
  assert.equal(display(null), `物流 ${SHIPMENT_ID.slice(0, 8)}`);
});

test("Japan Post EMS is localized while other carriers and the fallback are preserved", () => {
  assert.equal(shipmentCarrierDisplayName("Japan Post EMS"), "日本邮政 EMS");
  assert.equal(shipmentCarrierDisplayName("日本邮政 EMS"), "日本邮政 EMS");
  assert.equal(shipmentCarrierDisplayName("DHL"), "DHL");
  assert.equal(shipmentCarrierDisplayName(""), "");
  assert.equal(shipmentCarrierDisplayName(null), "未记录承运商");
});

test("refresh UUID validator accepts PostgreSQL md5 UUIDs regardless of version or variant", () => {
  // md5('test')::uuid: version d and variant c do not satisfy the old RFC restrictions.
  const md5Uuid = "098f6bcd-4621-d373-cade-4e832627b4f6";
  assert.equal(isUuid(md5Uuid), true);
  assert.equal(isUuid(md5Uuid.toUpperCase()), true);
  assert.equal(isUuid(SHIPMENT_ID), true);
});

test("refresh UUID validator rejects malformed UUID strings", () => {
  for (const value of [
    "",
    "not-a-uuid",
    "confirmed-capital-source-v1:t2",
    "098f6bcd4621d373cade4e832627b4f6",
    "098f6bcd-4621-d373-cade-4e832627b4fg",
    "098f6bcd-4621-d373-cade-4e832627b4f",
    "098f6bcd-4621-d373-cade-4e832627b4f60",
    "{098f6bcd-4621-d373-cade-4e832627b4f6}",
  ]) {
    assert.equal(isUuid(value), false, value);
  }
});

const japanPostHtml = `
  <table summary="履歴情報">
    <tr><td>08/26/2026 09:15</td><td>Posting/Collection</td><td></td><td>TOKYO</td><td>JAPAN</td></tr>
    <tr><td>100-0001</td></tr>
    <tr><td>08/27/2026 18:40</td><td>Arrival at inward office of exchange</td><td></td><td>HONG KONG</td><td>HONG KONG</td></tr>
    <tr><td></td></tr>
    <tr><td>09/05/2026</td><td>Retention</td><td></td><td>HONG KONG</td><td>HONG KONG</td></tr>
  </table>
`;

function event(overrides = {}) {
  return {
    occurredAt: "2026-08-26T00:15:00.000Z",
    rawStatus: "Posting/Collection",
    statusLabel: "已收寄",
    details: "",
    office: "TOKYO",
    country: "JAPAN",
    postalCode: "100-0001",
    ...overrides,
  };
}

function memoryStore({ role = "owner" } = {}) {
  const calls = { started: [], completed: [], failed: [] };
  return {
    calls,
    store: {
      async getShipment() {
        return {
          id: SHIPMENT_ID,
          portfolio_id: PORTFOLIO_ID,
          carrier: "日本邮政 EMS",
          tracking_number: "EN536199851JP",
          status: "in_transit",
        };
      },
      async getRole() {
        return role;
      },
      async startRun(input) {
        calls.started.push(input);
      },
      async completeRun(input) {
        calls.completed.push(input);
        return {
          run_id: input.runId,
          shipment_id: input.shipmentId,
          events_seen: input.events.length,
          events_inserted: input.events.length,
          shipment_status: "in_transit",
          shipped_at: input.events[0]?.occurred_at ?? null,
          delivered_at: null,
          latest_status: input.events.at(-1)?.status_label ?? "",
        };
      },
      async failRun(input) {
        calls.failed.push(input);
      },
    },
  };
}

test("Japan Post parser converts JST to an unambiguous timestamptz instant", () => {
  assert.equal(parseJapanPostJstTimestamp("08/26/2026 09:15"), "2026-08-26T00:15:00.000Z");
  assert.throws(() => parseJapanPostJstTimestamp("09/05/2026"), /无法解析日本邮政时间/);
  const events = parseJapanPostTracking(japanPostHtml);
  assert.equal(events.length, 2);
  assert.equal(events[0].occurredAt, "2026-08-26T00:15:00.000Z");
  assert.equal(events[1].occurredAt, "2026-08-27T09:40:00.000Z");
  assert.equal(events[1].statusLabel, "到达香港");
  assert.equal(events.some((trackingEvent) => trackingEvent.rawStatus === "Retention"), false);
});

test("duplicate carrier events produce the same non-null event fingerprint", async () => {
  const first = await japanPostEventFingerprint("EN536199851JP", event());
  const duplicate = await japanPostEventFingerprint(" en536199851jp ", event());
  assert.equal(first, duplicate);
  assert.match(first, /^[a-f0-9]{64}$/);
});

test("shipment status and timestamps come only from carrier evidence", () => {
  const inTransit = deriveJapanPostShipmentState([event()]);
  assert.equal(inTransit.status, "in_transit");
  assert.equal(inTransit.shippedAt, "2026-08-26T00:15:00.000Z");
  assert.equal(inTransit.deliveredAt, null);

  const customs = deriveJapanPostShipmentState([
    event(),
    event({
      occurredAt: "2026-08-27T09:40:00.000Z",
      rawStatus: "Arrival at inward office of exchange",
      statusLabel: "到达香港",
    }),
  ]);
  assert.equal(customs.status, "customs");

  const delivered = deriveJapanPostShipmentState([
    event(),
    event({
      occurredAt: "2026-08-28T03:00:00.000Z",
      rawStatus: "Final delivery",
      statusLabel: "已签收",
    }),
  ]);
  assert.equal(delivered.status, "delivered");
  assert.equal(delivered.deliveredAt, "2026-08-28T03:00:00.000Z");
});

test("owner and editor may sync while viewer is rejected", () => {
  assert.doesNotThrow(() => assertTrackingWriteRole("owner"));
  assert.doesNotThrow(() => assertTrackingWriteRole("editor"));
  assert.throws(() => assertTrackingWriteRole("viewer"), /owner.*editor/);
  assert.throws(() => assertTrackingWriteRole(null), /owner.*editor/);
});

test("viewer rejection happens before a carrier request or sync run", async () => {
  const fixture = memoryStore({ role: "viewer" });
  let fetched = false;
  await assert.rejects(runManualTrackingSync({
    store: fixture.store,
    userId: USER_ID,
    shipmentId: SHIPMENT_ID,
    fetchTracking: async () => {
      fetched = true;
      return { trackingNumber: "EN536199851JP", events: [event()] };
    },
  }), /owner.*editor/);
  assert.equal(fetched, false);
  assert.equal(fixture.calls.started.length, 0);
});

test("carrier failure finishes the same sync run as failed", async () => {
  const fixture = memoryStore();
  const moments = [
    new Date("2026-08-27T00:00:00.000Z"),
    new Date("2026-08-27T00:00:02.000Z"),
  ];
  await assert.rejects(runManualTrackingSync({
    store: fixture.store,
    userId: USER_ID,
    shipmentId: SHIPMENT_ID,
    fetchTracking: async () => { throw new Error("provider unavailable"); },
    now: () => moments.shift() ?? new Date("2026-08-27T00:00:02.000Z"),
    createId: () => RUN_ID,
  }), /provider unavailable/);
  assert.equal(fixture.calls.started.length, 1);
  assert.equal(fixture.calls.completed.length, 0);
  assert.deepEqual(fixture.calls.failed[0], {
    runId: RUN_ID,
    finishedAt: "2026-08-27T00:00:02.000Z",
    message: "provider unavailable",
  });
});

test("successful sync sends all events to one atomic completion call", async () => {
  const fixture = memoryStore({ role: "editor" });
  const events = parseJapanPostTracking(japanPostHtml);
  const result = await runManualTrackingSync({
    store: fixture.store,
    userId: USER_ID,
    shipmentId: SHIPMENT_ID,
    fetchTracking: async () => ({ trackingNumber: "EN536199851JP", events }),
    now: () => new Date("2026-08-27T10:00:00.000Z"),
    createId: () => RUN_ID,
  });
  assert.equal(fixture.calls.started.length, 1);
  assert.equal(fixture.calls.completed.length, 1);
  assert.equal(fixture.calls.completed[0].events.length, 2);
  assert.equal(fixture.calls.failed.length, 0);
  assert.equal(result.state.status, "customs");
});

test("database migration enforces invoker/RLS semantics and event idempotency", async () => {
  const migration = await readFile(new URL(
    "../supabase/migrations/20260821001600_fix_manual_tracking_refresh_json_precedence.sql",
    import.meta.url,
  ), "utf8");
  const baseSchema = await readFile(new URL(
    "../supabase/migrations/20260821000200_business_schema.sql",
    import.meta.url,
  ), "utf8");
  assert.match(migration, /security invoker/i);
  assert.match(migration, /private\.can_write_portfolio/);
  assert.match(migration, /on conflict \(shipment_id, external_event_id\) do nothing/i);
  assert.match(baseSchema, /unique \(shipment_id, external_event_id\)/i);
  assert.match(migration, /event->>'raw_status' = 'Final delivery'/);
});

test("follow-up migration parenthesizes JSON extraction before both identifier concatenations", async () => {
  const [original, fixed] = await Promise.all([
    readFile(new URL(
      "../supabase/migrations/20260821001500_create_manual_tracking_refresh_rpc.sql",
      import.meta.url,
    ), "utf8"),
    readFile(new URL(
      "../supabase/migrations/20260821001600_fix_manual_tracking_refresh_json_precedence.sql",
      import.meta.url,
    ), "utf8"),
  ]);
  const safeConcatenations = fixed.match(/\|\| \(event->>'event_fingerprint'\)/g) ?? [];
  assert.equal(safeConcatenations.length, 2);
  assert.doesNotMatch(fixed, /\|\| event->>'event_fingerprint'/);

  const originalFunction = original.slice(original.indexOf("create or replace function"));
  const fixedFunction = fixed.slice(fixed.indexOf("create or replace function"));
  assert.equal(
    fixedFunction.replaceAll(
      "|| (event->>'event_fingerprint')",
      "|| event->>'event_fingerprint'",
    ),
    originalFunction,
  );
});

test("manual tracking persistence cannot mutate financial or allocation data", async () => {
  const sources = await Promise.all([
    readFile(new URL("../lib/supabase/tracking.ts", import.meta.url), "utf8"),
    readFile(new URL(
      "../supabase/migrations/20260821001600_fix_manual_tracking_refresh_json_precedence.sql",
      import.meta.url,
    ), "utf8"),
  ]);
  const implementation = sources.join("\n");
  for (const forbidden of [
    "cost_entries",
    "shipment_items",
    "asset_financials",
    "valuation_snapshots",
    "purchase_orders",
    "budget_cny",
    "actual_paid_cny",
    "allocated_shipping_cny",
  ]) {
    assert.doesNotMatch(implementation, new RegExp(forbidden));
  }
});
