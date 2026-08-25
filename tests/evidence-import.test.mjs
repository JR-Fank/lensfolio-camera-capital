import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  assertConfirmation,
  buildLogisticsPlan,
  buildPurchasePlan,
  parseCliArgs,
  resolveAssetReferences,
  shippingEntryStatus,
  publicPreview,
} from "../scripts/lib/evidence-import.mjs";

const confirmed = (value) => ({ value, status: "confirmed", evidence: "fixture" });
const uncertain = (value = null) => ({ value, status: "uncertain", evidence: null });

function purchaseFixture() {
  return {
    schema_version: "1.0",
    evidence_type: "purchase",
    source_files: ["fixture-purchase.png"],
    purchase: {
      purchase_date: confirmed("2026-08-25"),
      platform: confirmed("Fixture Market"),
      seller: confirmed("Fixture Seller"),
      order_reference: confirmed("FIXTURE-ORDER-001"),
      purchase_price_jpy: confirmed(22000),
      actual_paid_cny: confirmed(986),
      exchange_rate_jpy_to_cny: confirmed(0.0448181818),
      fee_jpy: confirmed(0),
      domestic_shipping_jpy: confirmed(0),
      coupon_jpy: confirmed(0),
      photo_fee_jpy: uncertain(),
    },
    assets: [
      {
        brand: confirmed("Fixture Brand"),
        model: confirmed("Fixture Model"),
        serial_number: uncertain(),
        measured_weight_g: confirmed(551),
        condition: confirmed("used"),
        status: confirmed("acquired"),
        notes: uncertain(),
        purchase_price_jpy: confirmed(22000),
        allocated_cost_cny: confirmed(986),
        allocation_method: confirmed("equal"),
      },
    ],
    confirmation: { status: "pending", text: null, confirmed_at: null },
  };
}

function logisticsFixture() {
  return {
    schema_version: "1.0",
    evidence_type: "logistics",
    source_files: ["fixture-logistics.png"],
    logistics: {
      carrier: confirmed("Fixture Carrier"),
      tracking_number: confirmed("FIXTURE-TRACK-001"),
      origin: confirmed("Tokyo"),
      destination: confirmed("Hong Kong"),
      shipping_date: confirmed("2026-08-25"),
      bare_weight_g: confirmed(1000),
      chargeable_weight_g: confirmed(1200),
      shipping_cost_jpy: uncertain(),
      shipping_cost_cny: confirmed(30),
      payment_status: confirmed("pending"),
      status: confirmed("in_transit"),
    },
    associated_assets: [
      {
        asset_id: uncertain(),
        legacy_id: uncertain(),
        brand: confirmed("Fixture Brand"),
        model: confirmed("Fixture A"),
        weight_snapshot_g: confirmed(400),
        allocation_method: confirmed("manual"),
        allocation_ratio: confirmed(0.4),
        allocated_shipping_cny: confirmed(12),
      },
      {
        asset_id: uncertain(),
        legacy_id: confirmed("fixture-b"),
        brand: uncertain(),
        model: uncertain(),
        weight_snapshot_g: confirmed(600),
        allocation_method: confirmed("manual"),
        allocation_ratio: confirmed(0.6),
        allocated_shipping_cny: confirmed(18),
      },
    ],
    tracking_events: [
      {
        raw_status: confirmed("Dispatch"),
        status: confirmed("in_transit"),
        status_label: confirmed("Dispatched"),
        location: confirmed("Tokyo"),
        occurred_at: confirmed("2026-08-25T01:00:00+09:00"),
      },
    ],
    confirmation: { status: "pending", text: null, confirmed_at: null },
  };
}

test("JSON Schema contract is present and versioned", async () => {
  const schema = JSON.parse(await readFile(new URL("../schemas/evidence-import.schema.json", import.meta.url)));
  assert.equal(schema.$schema, "https://json-schema.org/draft/2020-12/schema");
  assert.equal(schema.oneOf.length, 2);
});

test("purchase evidence normalizes confirmed facts and keeps absent optional data NULL", () => {
  const plan = buildPurchasePlan(purchaseFixture());
  assert.deepEqual(plan.blockers, []);
  assert.equal(plan.payload.assets.length, 1);
  assert.equal(plan.payload.photo_fee_jpy, null);
  assert.equal(plan.payload.assets[0].serial_number, null);
  assert.equal(plan.will_create.purchase_cost_entries, 1);
  assert.equal(publicPreview(plan).summary.assets[0].model, "Fixture Model");
});

test("bundle purchase keeps separate assets and never derives individual weight", () => {
  const fixture = purchaseFixture();
  fixture.purchase.actual_paid_cny = confirmed(1200);
  fixture.assets = [
    { ...fixture.assets[0], model: confirmed("Bundle A"), measured_weight_g: uncertain(), allocated_cost_cny: confirmed(600), allocation_method: confirmed("legacy_equal_allocation") },
    { ...fixture.assets[0], model: confirmed("Bundle B"), measured_weight_g: uncertain(), allocated_cost_cny: confirmed(600), allocation_method: confirmed("legacy_equal_allocation") },
  ];
  const plan = buildPurchasePlan(fixture);
  assert.deepEqual(plan.blockers, []);
  assert.equal(plan.payload.assets.length, 2);
  assert.deepEqual(plan.payload.assets.map((asset) => asset.measured_weight_g), [null, null]);
  assert.deepEqual(plan.payload.assets.map((asset) => asset.allocated_cost_cny), [600, 600]);
});

test("missing or uncertain required purchase facts block import", () => {
  const fixture = purchaseFixture();
  fixture.purchase.actual_paid_cny = uncertain();
  const plan = buildPurchasePlan(fixture);
  assert.ok(plan.blockers.some((message) => message.includes("actual_paid_cny")));
});

test("duplicate purchase evidence produces the same fingerprint", () => {
  const first = buildPurchasePlan(purchaseFixture());
  const repeated = structuredClone(purchaseFixture());
  repeated.purchase.platform = uncertain();
  repeated.purchase.seller = uncertain();
  repeated.purchase.order_reference = confirmed("fixture-order-001");
  const second = buildPurchasePlan(repeated);
  assert.equal(first.evidence_fingerprint, second.evidence_fingerprint);
  assert.notEqual(first.payload_hash, second.payload_hash);
});

test("confirmation gate requires exact user confirmation", () => {
  const fixture = purchaseFixture();
  assert.throws(() => assertConfirmation(fixture), /确认录入/);
  fixture.confirmation = { status: "confirmed", text: "确认录入", confirmed_at: "2026-08-25T00:00:00Z" };
  assert.doesNotThrow(() => assertConfirmation(fixture));
});

test("import CLI accepts the evidence path without requiring a portfolio or token argument", () => {
  assert.deepEqual(parseCliArgs(["fixture.json"]), {
    apply: false,
    verify: false,
    confirmImport: false,
    input: "fixture.json",
  });
});

test("logistics evidence supports multi-asset allocation and pending versus posted cost state", () => {
  const plan = buildLogisticsPlan(logisticsFixture());
  assert.deepEqual(plan.blockers, []);
  assert.equal(plan.payload.assets.length, 2);
  assert.equal(plan.payload.shipping_cost_entry_status, "pending");
  assert.equal(shippingEntryStatus("paid"), "posted");
  assert.equal(shippingEntryStatus("budget"), "pending");
  assert.equal(plan.payload.assets.reduce((sum, asset) => sum + asset.allocated_shipping_cny, 0), 30);
});

test("duplicate tracking events have a deterministic event fingerprint", () => {
  const fixture = logisticsFixture();
  fixture.tracking_events.push(structuredClone(fixture.tracking_events[0]));
  const plan = buildLogisticsPlan(fixture);
  assert.equal(plan.payload.tracking_events[0].event_fingerprint, plan.payload.tracking_events[1].event_fingerprint);
  assert.equal(new Set(plan.payload.tracking_events.map((event) => event.event_fingerprint)).size, 1);
});

test("asset matching resolves UUID, legacy ID, and unique brand/model", () => {
  const plan = buildLogisticsPlan(logisticsFixture());
  const assets = [
    { id: "00000000-0000-4000-8000-000000000001", legacy_id: "fixture-a", brand: "Fixture Brand", model: "Fixture A" },
    { id: "00000000-0000-4000-8000-000000000002", legacy_id: "fixture-b", brand: "Fixture Brand", model: "Fixture B" },
  ];
  const resolved = resolveAssetReferences(plan.payload.assets, assets);
  assert.deepEqual(resolved.map((asset) => asset.asset_id), assets.map((asset) => asset.id));
});

test("ambiguous brand/model asset matching stops instead of guessing", () => {
  const plan = buildLogisticsPlan(logisticsFixture());
  const assets = [
    { id: "00000000-0000-4000-8000-000000000001", legacy_id: "fixture-a", brand: "Fixture Brand", model: "Fixture A" },
    { id: "00000000-0000-4000-8000-000000000003", legacy_id: "fixture-a-2", brand: "Fixture Brand", model: "Fixture A" },
    { id: "00000000-0000-4000-8000-000000000002", legacy_id: "fixture-b", brand: "Fixture Brand", model: "Fixture B" },
  ];
  assert.throws(() => resolveAssetReferences(plan.payload.assets, assets), /ambiguous/);
});
