import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
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

const japanPostHtml = `
  <table summary="履歴情報">
    <tr><td>08/26/2026 09:15</td><td>Posting/Collection</td><td></td><td>TOKYO</td><td>JAPAN</td></tr>
    <tr><td>100-0001</td></tr>
    <tr><td>08/27/2026 18:40</td><td>Arrival at inward office of exchange</td><td></td><td>HONG KONG</td><td>HONG KONG</td></tr>
    <tr><td></td></tr>
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
  const events = parseJapanPostTracking(japanPostHtml);
  assert.equal(events.length, 2);
  assert.equal(events[0].occurredAt, "2026-08-26T00:15:00.000Z");
  assert.equal(events[1].occurredAt, "2026-08-27T09:40:00.000Z");
  assert.equal(events[1].statusLabel, "到达香港");
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
    "../supabase/migrations/20260821001500_create_manual_tracking_refresh_rpc.sql",
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

test("manual tracking persistence cannot mutate financial or allocation data", async () => {
  const sources = await Promise.all([
    readFile(new URL("../lib/supabase/tracking.ts", import.meta.url), "utf8"),
    readFile(new URL(
      "../supabase/migrations/20260821001500_create_manual_tracking_refresh_rpc.sql",
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
