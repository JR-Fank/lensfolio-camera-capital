#!/usr/bin/env node

import { readFile } from "node:fs/promises";
import { createClient } from "@supabase/supabase-js";
import {
  assertConfirmation,
  buildPurchasePlan,
  parseCliArgs,
  publicPreview,
} from "./lib/evidence-import.mjs";

function authenticatedClient() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY;
  const accessToken = process.env.LENSFOLIO_USER_ACCESS_TOKEN;
  if (!url || !key || !accessToken) {
    throw new Error(
      "Database access requires NEXT_PUBLIC_SUPABASE_URL, NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY, and LENSFOLIO_USER_ACCESS_TOKEN.",
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

async function verify(client, plan, portfolioId) {
  const legacyId = `evidence:purchase:${plan.evidence_fingerprint}`;
  const { data: order, error: orderError } = await client
    .from("purchase_orders")
    .select("id,legacy_id,actual_paid_cny")
    .eq("portfolio_id", portfolioId)
    .eq("legacy_id", legacyId)
    .maybeSingle();
  if (orderError) throw orderError;
  if (!order) return { verified: false, reason: "No matching purchase evidence import exists." };

  const { data: items, error: itemError } = await client
    .from("purchase_items")
    .select("id,asset_id,allocated_cost_cny")
    .eq("portfolio_id", portfolioId)
    .eq("purchase_order_id", order.id);
  if (itemError) throw itemError;

  const itemIds = items.map((item) => item.id);
  const { data: costs, error: costError } = await client
    .from("cost_entries")
    .select("id,asset_id,source_id,amount_cny,entry_status")
    .eq("portfolio_id", portfolioId)
    .eq("source_type", "purchase_item")
    .eq("cost_type", "purchase")
    .in("source_id", itemIds);
  if (costError) throw costError;

  const { data: audit, error: auditError } = await client
    .from("audit_logs")
    .select("id,actor_id,action,occurred_at,after_data")
    .eq("portfolio_id", portfolioId)
    .eq("entity_type", "purchase_evidence")
    .eq("entity_id", order.id)
    .order("occurred_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (auditError) throw auditError;

  return {
    verified: items.length === plan.payload.assets.length
      && costs.length === items.length
      && audit?.after_data?.normalized_payload_hash === plan.payload_hash,
    purchase_order: order,
    purchase_items: items,
    purchase_cost_entries: costs,
    audit,
  };
}

async function main() {
  const args = parseCliArgs(process.argv.slice(2));
  const document = JSON.parse(await readFile(args.input, "utf8"));
  const plan = buildPurchasePlan(document);
  console.log(JSON.stringify(publicPreview(plan), null, 2));

  if (plan.blockers.length > 0) throw new Error("Import blocked by normalized evidence validation.");
  if (!args.apply && !args.verify) return;

  const { client, accessToken } = authenticatedClient();
  const { data: authData, error: authError } = await client.auth.getUser(accessToken);
  if (authError || !authData.user) throw authError ?? new Error("Authenticated user not found.");

  if (args.verify) {
    console.log(JSON.stringify(await verify(client, plan, args.portfolioId), null, 2));
    return;
  }

  assertConfirmation(document);
  const { data, error } = await client.rpc("import_purchase_evidence", {
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
