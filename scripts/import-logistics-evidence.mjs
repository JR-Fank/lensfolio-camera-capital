#!/usr/bin/env node

import { readFile } from "node:fs/promises";
import { createClient } from "@supabase/supabase-js";
import {
  assertConfirmation,
  buildLogisticsPlan,
  canonicalJson,
  parseCliArgs,
  publicPreview,
  resolveAssetReferences,
  sha256,
} from "./lib/evidence-import.mjs";

function authenticatedClient() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY;
  const accessToken = process.env.LENSFOLIO_USER_ACCESS_TOKEN;
  if (!url || !key || !accessToken) {
    throw new Error(
      "Logistics matching requires NEXT_PUBLIC_SUPABASE_URL, NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY, and LENSFOLIO_USER_ACCESS_TOKEN.",
    );
  }
  return {
    client: createClient(url, key, {
      global: { headers: { Authorization: `Bearer ${accessToken}` } },
      auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
    }),
    accessToken,
  };
}

async function resolveAssets(client, plan, portfolioId) {
  const { data: assets, error } = await client
    .from("assets")
    .select("id,legacy_id,brand,model")
    .eq("portfolio_id", portfolioId);
  if (error) throw error;
  const resolved = resolveAssetReferences(plan.payload.assets, assets);
  plan.payload = { ...plan.payload, assets: resolved };
  plan.payload_hash = sha256(canonicalJson(plan.payload));
  return plan;
}

async function verify(client, plan, portfolioId) {
  let shipmentQuery = client
    .from("shipments")
    .select("id,legacy_id,tracking_number,actual_paid_cny,budget_cny")
    .eq("portfolio_id", portfolioId);
  shipmentQuery = plan.payload.tracking_number
    ? shipmentQuery.eq("tracking_number", plan.payload.tracking_number)
    : shipmentQuery.eq("legacy_id", `evidence:logistics:${plan.evidence_fingerprint}`);
  const { data: shipment, error: shipmentError } = await shipmentQuery.maybeSingle();
  if (shipmentError) throw shipmentError;
  if (!shipment) return { verified: false, reason: "No matching logistics evidence import exists." };

  const { data: items, error: itemError } = await client
    .from("shipment_items")
    .select("id,asset_id,allocated_shipping_cny,allocation_locked_at,allocation_version")
    .eq("portfolio_id", portfolioId)
    .eq("shipment_id", shipment.id);
  if (itemError) throw itemError;

  const { data: events, error: eventError } = await client
    .from("tracking_events")
    .select("id,external_event_id,status,occurred_at")
    .eq("portfolio_id", portfolioId)
    .eq("shipment_id", shipment.id);
  if (eventError) throw eventError;

  const itemIds = items.map((item) => item.id);
  let costs = [];
  if (itemIds.length > 0) {
    const { data, error: costError } = await client
      .from("cost_entries")
      .select("id,asset_id,source_id,amount_cny,entry_status")
      .eq("portfolio_id", portfolioId)
      .eq("source_type", "shipment_item")
      .eq("cost_type", "international_shipping")
      .in("source_id", itemIds);
    if (costError) throw costError;
    costs = data;
  }

  const { data: audit, error: auditError } = await client
    .from("audit_logs")
    .select("id,actor_id,action,occurred_at,after_data")
    .eq("portfolio_id", portfolioId)
    .eq("entity_type", "logistics_evidence")
    .eq("entity_id", shipment.id)
    .order("occurred_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (auditError) throw auditError;

  return {
    verified: items.length === plan.payload.assets.length
      && events.filter((event) => event.external_event_id?.startsWith("evidence:")).length >= plan.payload.tracking_events.length
      && audit?.after_data?.normalized_payload_hash === plan.payload_hash,
    shipment,
    shipment_items: items,
    tracking_events: events,
    shipping_cost_entries: costs,
    audit,
  };
}

async function main() {
  const args = parseCliArgs(process.argv.slice(2));
  const document = JSON.parse(await readFile(args.input, "utf8"));
  const plan = buildLogisticsPlan(document);

  if (plan.blockers.length > 0) {
    console.log(JSON.stringify(publicPreview(plan), null, 2));
    throw new Error("Import blocked by normalized evidence validation.");
  }

  const { client, accessToken } = authenticatedClient();
  const { data: authData, error: authError } = await client.auth.getUser(accessToken);
  if (authError || !authData.user) throw authError ?? new Error("Authenticated user not found.");

  await resolveAssets(client, plan, args.portfolioId);
  console.log(JSON.stringify(publicPreview(plan), null, 2));

  if (!args.apply && !args.verify) return;
  if (args.verify) {
    console.log(JSON.stringify(await verify(client, plan, args.portfolioId), null, 2));
    return;
  }

  assertConfirmation(document);
  const { data, error } = await client.rpc("import_logistics_evidence", {
    p_portfolio_id: args.portfolioId,
    p_evidence_fingerprint: plan.evidence_fingerprint,
    p_payload_hash: plan.payload_hash,
    p_source_files: plan.source_files,
    p_payload: plan.payload,
  });
  if (error) throw error;
  console.log(JSON.stringify({ applied: true, importing_user: authData.user.id, result: data }, null, 2));
}

main().catch((error) => {
  console.error(error.message ?? error);
  process.exitCode = 1;
});
