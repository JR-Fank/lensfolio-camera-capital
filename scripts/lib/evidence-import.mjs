import { createHash } from "node:crypto";
import { basename } from "node:path";

const ASSET_STATUSES = new Set([
  "acquired",
  "in_transit",
  "in_storage",
  "inspection",
  "repair",
  "ready_for_sale",
  "listed",
  "sold",
  "retired",
]);
const ALLOCATION_METHODS = new Set(["equal", "weight", "manual", "legacy_equal_allocation"]);
const SHIPMENT_STATUSES = new Set([
  "draft",
  "booked",
  "in_transit",
  "customs",
  "delivered",
  "cancelled",
]);
const PAYMENT_STATUSES = new Set(["paid", "pending", "budget"]);

function stableValue(value) {
  if (Array.isArray(value)) return value.map(stableValue);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, stableValue(value[key])]),
    );
  }
  return value;
}

export function canonicalJson(value) {
  return JSON.stringify(stableValue(value));
}

export function sha256(value) {
  return createHash("sha256").update(typeof value === "string" ? value : canonicalJson(value)).digest("hex");
}

export function shippingEntryStatus(paymentStatus) {
  if (paymentStatus === "paid") return "posted";
  if (paymentStatus === "pending" || paymentStatus === "budget") return "pending";
  return null;
}

function issue(message, path) {
  return path ? `${path}: ${message}` : message;
}

function readEnvelope(container, key, context, options = {}) {
  const { required = false, type, allowEmpty = false } = options;
  const path = `${context.path}.${key}`;
  const envelope = container?.[key];

  if (!envelope || typeof envelope !== "object" || !("value" in envelope) || !("status" in envelope)) {
    context.blockers.push(issue("expected an evidence field with value and status", path));
    return null;
  }

  if (!new Set(["confirmed", "uncertain"]).has(envelope.status)) {
    context.blockers.push(issue("status must be confirmed or uncertain", path));
    return null;
  }

  if (envelope.status === "uncertain") {
    context.uncertain.push({
      path,
      value: envelope.value ?? null,
      candidates: envelope.candidates ?? [],
      evidence: envelope.evidence ?? null,
    });
    if (required) context.blockers.push(issue("must be confirmed before import", path));
    return null;
  }

  const value = envelope.value;
  if (required && (value === null || value === undefined || (!allowEmpty && value === ""))) {
    context.blockers.push(issue("confirmed value is required", path));
    return null;
  }

  if (value === null || value === undefined) return null;
  if (type === "string" && typeof value !== "string") {
    context.blockers.push(issue("must be a string or null", path));
    return null;
  }
  if (type === "number" && (typeof value !== "number" || !Number.isFinite(value))) {
    context.blockers.push(issue("must be a finite number or null", path));
    return null;
  }
  if (type === "integer" && (!Number.isInteger(value))) {
    context.blockers.push(issue("must be an integer or null", path));
    return null;
  }
  return typeof value === "string" && !allowEmpty ? value.trim() : value;
}

function validateMoney(value, path, blockers, { positive = false } = {}) {
  if (value === null) return;
  if ((positive ? value <= 0 : value < 0) || Math.round(value * 100) !== value * 100) {
    blockers.push(issue(`${positive ? "must be positive" : "must be nonnegative"} with at most two decimals`, path));
  }
}

function validatePositiveInteger(value, path, blockers) {
  if (value !== null && value <= 0) blockers.push(issue("must be a positive integer", path));
}

function validateDate(value, path, blockers) {
  if (value !== null && !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    blockers.push(issue("must use YYYY-MM-DD", path));
  }
}

function ensureDocument(document, type) {
  const blockers = [];
  if (!document || typeof document !== "object") blockers.push("Input must be a JSON object.");
  if (document?.schema_version !== "1.0") blockers.push("schema_version must be 1.0.");
  if (document?.evidence_type !== type) blockers.push(`evidence_type must be ${type}.`);
  if (!Array.isArray(document?.source_files)) blockers.push("source_files must be an array.");
  return blockers;
}

function sanitizedSourceFiles(document) {
  return [
    ...new Set(
      (document.source_files ?? [])
        .filter((value) => typeof value === "string")
        .map((value) => basename(value)),
    ),
  ];
}

export function assertConfirmation(document) {
  if (document?.confirmation?.status !== "confirmed" || document?.confirmation?.text !== "确认录入") {
    throw new Error("Write blocked: normalized evidence has not received the exact confirmation text \"确认录入\".");
  }
}

export function buildPurchasePlan(document) {
  const blockers = ensureDocument(document, "purchase");
  const uncertain = [];
  const context = { blockers, uncertain, path: "purchase" };
  const purchase = document?.purchase ?? {};
  const assets = Array.isArray(document?.assets) ? document.assets : [];

  if (assets.length === 0) blockers.push("assets must contain at least one physical camera.");

  const purchaseDate = readEnvelope(purchase, "purchase_date", context, { required: true, type: "string" });
  const platform = readEnvelope(purchase, "platform", context, { type: "string" });
  const seller = readEnvelope(purchase, "seller", context, { type: "string" });
  const orderReference = readEnvelope(purchase, "order_reference", context, { type: "string" });
  const purchasePriceJpy = readEnvelope(purchase, "purchase_price_jpy", context, { type: "number" });
  const actualPaidCny = readEnvelope(purchase, "actual_paid_cny", context, { required: true, type: "number" });
  const exchangeRate = readEnvelope(purchase, "exchange_rate_jpy_to_cny", context, { type: "number" });
  const feeJpy = readEnvelope(purchase, "fee_jpy", context, { type: "number" });
  const domesticShippingJpy = readEnvelope(purchase, "domestic_shipping_jpy", context, { type: "number" });
  const couponJpy = readEnvelope(purchase, "coupon_jpy", context, { type: "number" });
  const photoFeeJpy = readEnvelope(purchase, "photo_fee_jpy", context, { type: "number" });

  validateDate(purchaseDate, "purchase.purchase_date", blockers);
  validateMoney(actualPaidCny, "purchase.actual_paid_cny", blockers, { positive: true });
  for (const [name, value] of [
    ["purchase_price_jpy", purchasePriceJpy],
    ["fee_jpy", feeJpy],
    ["domestic_shipping_jpy", domesticShippingJpy],
    ["coupon_jpy", couponJpy],
    ["photo_fee_jpy", photoFeeJpy],
  ]) validateMoney(value, `purchase.${name}`, blockers);

  if ((purchasePriceJpy === null) !== (exchangeRate === null)) {
    blockers.push("purchase.purchase_price_jpy and exchange_rate_jpy_to_cny must both be confirmed or both be NULL.");
  }
  if (exchangeRate !== null && exchangeRate <= 0) blockers.push("purchase.exchange_rate_jpy_to_cny must be positive.");

  const normalizedAssets = assets.map((asset, index) => {
    const assetContext = { blockers, uncertain, path: `assets[${index}]` };
    const brand = readEnvelope(asset, "brand", assetContext, { required: true, type: "string" });
    const model = readEnvelope(asset, "model", assetContext, { required: true, type: "string" });
    const serialNumber = readEnvelope(asset, "serial_number", assetContext, { type: "string" });
    const measuredWeight = readEnvelope(asset, "measured_weight_g", assetContext, { type: "integer" });
    const condition = readEnvelope(asset, "condition", assetContext, { type: "string" });
    const status = readEnvelope(asset, "status", assetContext, { type: "string" });
    const notes = readEnvelope(asset, "notes", assetContext, { type: "string" });
    let itemJpy = readEnvelope(asset, "purchase_price_jpy", assetContext, { type: "number" });
    let allocation = readEnvelope(asset, "allocated_cost_cny", assetContext, {
      required: assets.length > 1,
      type: "number",
    });
    let allocationMethod = readEnvelope(asset, "allocation_method", assetContext, {
      required: assets.length > 1,
      type: "string",
    });

    if (assets.length === 1) {
      if (allocation === null) allocation = actualPaidCny;
      if (allocationMethod === null) allocationMethod = "equal";
      if (itemJpy === null) itemJpy = purchasePriceJpy;
    }

    validatePositiveInteger(measuredWeight, `assets[${index}].measured_weight_g`, blockers);
    validateMoney(itemJpy, `assets[${index}].purchase_price_jpy`, blockers);
    validateMoney(allocation, `assets[${index}].allocated_cost_cny`, blockers);
    if (status !== null && !ASSET_STATUSES.has(status)) blockers.push(`assets[${index}].status is not a supported asset status.`);
    if (allocationMethod !== null && !ALLOCATION_METHODS.has(allocationMethod)) {
      blockers.push(`assets[${index}].allocation_method is not supported.`);
    }

    return {
      brand,
      model,
      serial_number: serialNumber,
      measured_weight_g: measuredWeight,
      condition,
      status,
      notes,
      purchase_price_jpy: itemJpy,
      allocated_cost_cny: allocation,
      allocation_method: allocationMethod,
    };
  });

  if (actualPaidCny !== null && normalizedAssets.every((asset) => asset.allocated_cost_cny !== null)) {
    const total = normalizedAssets.reduce((sum, asset) => sum + asset.allocated_cost_cny, 0);
    if (Math.abs(total - actualPaidCny) > 0.01) blockers.push("Asset allocations must equal actual_paid_cny within CNY 0.01.");
  }

  const allocationMethods = new Set(normalizedAssets.map((asset) => asset.allocation_method).filter(Boolean));
  const payload = {
    purchase_date: purchaseDate,
    platform,
    seller,
    order_reference: orderReference,
    purchase_price_jpy: purchasePriceJpy,
    actual_paid_cny: actualPaidCny,
    exchange_rate_jpy_to_cny: exchangeRate,
    fee_jpy: feeJpy,
    domestic_shipping_jpy: domesticShippingJpy,
    coupon_jpy: couponJpy,
    photo_fee_jpy: photoFeeJpy,
    allocation_method: allocationMethods.size === 1 ? [...allocationMethods][0] : "manual",
    assets: normalizedAssets,
  };
  const payloadHash = sha256(payload);
  const identity = orderReference
    ? canonicalJson({ type: "purchase", order_reference: orderReference.toLocaleLowerCase("en-US") })
    : payloadHash;

  return {
    type: "purchase",
    payload,
    payload_hash: payloadHash,
    evidence_fingerprint: sha256(identity),
    source_files: sanitizedSourceFiles(document),
    uncertain,
    blockers,
    will_create: {
      assets: normalizedAssets.length,
      purchase_orders: 1,
      purchase_items: normalizedAssets.length,
      purchase_cost_entries: normalizedAssets.length,
      audit_logs: 1,
    },
  };
}

export function buildLogisticsPlan(document) {
  const blockers = ensureDocument(document, "logistics");
  const uncertain = [];
  const context = { blockers, uncertain, path: "logistics" };
  const logistics = document?.logistics ?? {};
  const associatedAssets = Array.isArray(document?.associated_assets) ? document.associated_assets : [];
  const trackingEvents = Array.isArray(document?.tracking_events) ? document.tracking_events : [];

  if (associatedAssets.length === 0) blockers.push("associated_assets must contain at least one asset reference.");

  const carrier = readEnvelope(logistics, "carrier", context, { type: "string" });
  const trackingNumber = readEnvelope(logistics, "tracking_number", context, { type: "string" });
  const origin = readEnvelope(logistics, "origin", context, { type: "string" });
  const destination = readEnvelope(logistics, "destination", context, { type: "string" });
  const shippingDate = readEnvelope(logistics, "shipping_date", context, { type: "string" });
  const bareWeight = readEnvelope(logistics, "bare_weight_g", context, { type: "integer" });
  const chargeableWeight = readEnvelope(logistics, "chargeable_weight_g", context, { type: "integer" });
  const shippingCostJpy = readEnvelope(logistics, "shipping_cost_jpy", context, { type: "number" });
  const shippingCostCny = readEnvelope(logistics, "shipping_cost_cny", context, { type: "number" });
  const paymentStatus = readEnvelope(logistics, "payment_status", context, {
    required: shippingCostCny !== null,
    type: "string",
  });
  const status = readEnvelope(logistics, "status", context, { type: "string" });

  validateDate(shippingDate, "logistics.shipping_date", blockers);
  validatePositiveInteger(bareWeight, "logistics.bare_weight_g", blockers);
  validatePositiveInteger(chargeableWeight, "logistics.chargeable_weight_g", blockers);
  validateMoney(shippingCostJpy, "logistics.shipping_cost_jpy", blockers);
  validateMoney(shippingCostCny, "logistics.shipping_cost_cny", blockers);
  if (paymentStatus !== null && !PAYMENT_STATUSES.has(paymentStatus)) blockers.push("logistics.payment_status is not paid, pending, or budget.");
  if (status !== null && !SHIPMENT_STATUSES.has(status)) blockers.push("logistics.status is not a supported shipment status.");

  const normalizedAssets = associatedAssets.map((asset, index) => {
    const assetContext = { blockers, uncertain, path: `associated_assets[${index}]` };
    const assetId = readEnvelope(asset, "asset_id", assetContext, { type: "string" });
    const legacyId = readEnvelope(asset, "legacy_id", assetContext, { type: "string" });
    const brand = readEnvelope(asset, "brand", assetContext, { type: "string" });
    const model = readEnvelope(asset, "model", assetContext, { type: "string" });
    const weightSnapshot = readEnvelope(asset, "weight_snapshot_g", assetContext, { type: "integer" });
    let allocationMethod = readEnvelope(asset, "allocation_method", assetContext, {
      required: associatedAssets.length > 1,
      type: "string",
    });
    let allocationRatio = readEnvelope(asset, "allocation_ratio", assetContext, {
      required: associatedAssets.length > 1,
      type: "number",
    });
    let allocatedShipping = readEnvelope(asset, "allocated_shipping_cny", assetContext, {
      required: associatedAssets.length > 1 && shippingCostCny !== null,
      type: "number",
    });

    if (!assetId && !legacyId && !(brand && model)) {
      blockers.push(`associated_assets[${index}] needs confirmed asset_id, legacy_id, or brand + model.`);
    }
    if (associatedAssets.length === 1) {
      if (allocationMethod === null) allocationMethod = "equal";
      if (allocationRatio === null) allocationRatio = 1;
      if (allocatedShipping === null) allocatedShipping = shippingCostCny ?? 0;
    }

    validatePositiveInteger(weightSnapshot, `associated_assets[${index}].weight_snapshot_g`, blockers);
    validateMoney(allocatedShipping, `associated_assets[${index}].allocated_shipping_cny`, blockers);
    if (allocationMethod !== null && !ALLOCATION_METHODS.has(allocationMethod)) {
      blockers.push(`associated_assets[${index}].allocation_method is not supported.`);
    }
    if (allocationRatio !== null && (allocationRatio < 0 || allocationRatio > 1)) {
      blockers.push(`associated_assets[${index}].allocation_ratio must be between 0 and 1.`);
    }

    return {
      match: { asset_id: assetId, legacy_id: legacyId, brand, model },
      weight_snapshot_g: weightSnapshot,
      allocation_method: allocationMethod,
      allocation_ratio: allocationRatio,
      allocated_shipping_cny: allocatedShipping,
    };
  });

  if (normalizedAssets.every((asset) => asset.allocated_shipping_cny !== null)) {
    const total = normalizedAssets.reduce((sum, asset) => sum + asset.allocated_shipping_cny, 0);
    if (shippingCostCny === null && Math.abs(total) > 0.01) blockers.push("Allocated shipping requires a confirmed shipping_cost_cny.");
    if (shippingCostCny !== null && Math.abs(total - shippingCostCny) > 0.01) {
      blockers.push("Asset shipping allocations must equal shipping_cost_cny within CNY 0.01.");
    }
  }

  const normalizedEvents = trackingEvents.map((event, index) => {
    const eventContext = { blockers, uncertain, path: `tracking_events[${index}]` };
    const rawStatus = readEnvelope(event, "raw_status", eventContext, { type: "string" });
    const eventStatus = readEnvelope(event, "status", eventContext, { required: true, type: "string" });
    const statusLabel = readEnvelope(event, "status_label", eventContext, { type: "string" });
    const location = readEnvelope(event, "location", eventContext, { type: "string" });
    const occurredAt = readEnvelope(event, "occurred_at", eventContext, { required: true, type: "string" });
    if (occurredAt !== null && Number.isNaN(Date.parse(occurredAt))) blockers.push(`tracking_events[${index}].occurred_at must be an ISO timestamp.`);
    const eventIdentity = { raw_status: rawStatus, status: eventStatus, location, occurred_at: occurredAt };
    return { ...eventIdentity, status_label: statusLabel, event_fingerprint: sha256(eventIdentity) };
  });

  const identitySeed = trackingNumber
    ? canonicalJson({
      type: "logistics",
      tracking_number: trackingNumber.replaceAll(/\s/g, "").toLocaleUpperCase("en-US"),
    })
    : null;
  const preliminaryPayload = {
    carrier,
    tracking_number: trackingNumber,
    origin,
    destination,
    shipping_date: shippingDate,
    bare_weight_g: bareWeight,
    chargeable_weight_g: chargeableWeight,
    shipping_cost_jpy: shippingCostJpy,
    shipping_cost_cny: shippingCostCny,
    payment_status: paymentStatus,
    shipping_cost_entry_status: shippingEntryStatus(paymentStatus),
    status,
    legacy_status: null,
    assets: normalizedAssets,
    tracking_events: normalizedEvents,
  };
  const payloadHash = sha256(preliminaryPayload);

  return {
    type: "logistics",
    payload: preliminaryPayload,
    payload_hash: payloadHash,
    evidence_fingerprint: sha256(identitySeed ?? payloadHash),
    source_files: sanitizedSourceFiles(document),
    uncertain,
    blockers,
    will_create_or_update: {
      shipments: 1,
      shipment_items: normalizedAssets.length,
      tracking_events: normalizedEvents.length,
      shipping_cost_entries: shippingCostCny === null ? 0 : normalizedAssets.length,
      audit_logs: 1,
    },
  };
}

export function resolveAssetReferences(references, availableAssets) {
  const resolved = [];
  const used = new Set();

  for (const [index, reference] of references.entries()) {
    const match = reference.match;
    let candidates;
    if (match.asset_id) {
      candidates = availableAssets.filter((asset) => asset.id === match.asset_id);
    } else if (match.legacy_id) {
      candidates = availableAssets.filter((asset) => asset.legacy_id === match.legacy_id);
    } else {
      const brand = match.brand?.toLocaleLowerCase("en-US");
      const model = match.model?.toLocaleLowerCase("en-US");
      candidates = availableAssets.filter(
        (asset) => asset.brand.toLocaleLowerCase("en-US") === brand
          && asset.model.toLocaleLowerCase("en-US") === model,
      );
    }

    if (candidates.length === 0) throw new Error(`associated_assets[${index}] matched no asset.`);
    if (candidates.length > 1) {
      throw new Error(`associated_assets[${index}] is ambiguous (${candidates.map((asset) => asset.id).join(", ")}).`);
    }
    if (used.has(candidates[0].id)) throw new Error(`Asset ${candidates[0].id} was matched more than once.`);
    used.add(candidates[0].id);
    resolved.push({ ...reference, asset_id: candidates[0].id, match: undefined });
  }

  return resolved;
}

export function parseCliArgs(argv) {
  const args = { apply: false, verify: false, confirmImport: false };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--apply") args.apply = true;
    else if (arg === "--verify") args.verify = true;
    else if (arg === "--confirm-import") args.confirmImport = true;
    else if (arg === "--input") args.input = argv[++index];
    else if (arg === "--portfolio-id") args.portfolioId = argv[++index];
    else if (!arg.startsWith("--") && !args.input) args.input = arg;
    else throw new Error(`Unknown argument: ${arg}`);
  }
  if (!args.input) throw new Error("Evidence JSON path is required.");
  if (args.apply && !args.confirmImport) throw new Error("--apply also requires --confirm-import.");
  return args;
}

export function publicPreview(plan) {
  const summary = plan.type === "purchase"
    ? {
      assets: plan.payload.assets.map((asset) => ({
        brand: asset.brand,
        model: asset.model,
        serial_number: asset.serial_number,
        measured_weight_g: asset.measured_weight_g,
        allocated_cost_cny: asset.allocated_cost_cny,
      })),
      purchase_date: plan.payload.purchase_date,
      purchase_price_jpy: plan.payload.purchase_price_jpy,
      actual_paid_cny: plan.payload.actual_paid_cny,
      platform: plan.payload.platform,
      order_reference: plan.payload.order_reference,
    }
    : {
      carrier: plan.payload.carrier,
      tracking_number: plan.payload.tracking_number,
      shipping_cost_jpy: plan.payload.shipping_cost_jpy,
      shipping_cost_cny: plan.payload.shipping_cost_cny,
      payment_status: plan.payload.payment_status,
      associated_assets: plan.payload.assets.map((asset) => ({
        asset_id: asset.asset_id ?? null,
        match: asset.match ?? null,
        weight_snapshot_g: asset.weight_snapshot_g,
        allocated_shipping_cny: asset.allocated_shipping_cny,
      })),
      tracking_event_count: plan.payload.tracking_events.length,
    };

  return {
    mode: "dry-run",
    evidence_type: plan.type,
    payload_hash: plan.payload_hash,
    evidence_fingerprint: plan.evidence_fingerprint,
    source_files: plan.source_files,
    summary,
    write_plan: plan.will_create ?? plan.will_create_or_update,
    uncertain_fields: plan.uncertain,
    blockers: plan.blockers,
    ready_for_confirmation: plan.blockers.length === 0,
  };
}
