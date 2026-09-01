import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";
import {
  calculateConfidence,
  calculateValuationStatistics,
  exclusionReasons,
  type ExclusionReason,
  type ListingReviewStatus,
  type PreparedListing,
} from "../valuation/xianyu";

export type ValuationResearchStatus = "researching" | "ready_for_review" | "failed" | "confirmed" | "cancelled";

export type ValuationResearchRun = {
  id: string;
  portfolio_id: string;
  asset_id: string;
  market_source_id: string;
  status: ValuationResearchStatus;
  search_terms: string[];
  raw_count: number;
  deduplicated_count: number;
  included_count: number;
  p25_cny: number | null;
  median_cny: number | null;
  p75_cny: number | null;
  sample_count: number;
  confidence: number | null;
  methodology: string | null;
  price_semantics: "asking_price";
  error_message: string | null;
  created_at: string;
  created_by: string;
  confirmed_at: string | null;
  confirmed_by: string | null;
  confirmed_snapshot_id: string | null;
};

export type ValuationResearchListing = {
  id: string;
  portfolio_id: string;
  market_source_id: string;
  asset_id: string | null;
  research_run_id: string;
  external_listing_id: string | null;
  title: string;
  listing_url: string | null;
  asking_price: number;
  currency: string;
  seller_name: string | null;
  listed_at: string | null;
  captured_at: string | null;
  condition_text: string | null;
  review_status: ListingReviewStatus;
  exclusion_reason: ExclusionReason | null;
  listing_fingerprint: string;
  metadata: Record<string, unknown>;
  observed_at: string;
};

export type ConfirmedValuationResearch = {
  run_id: string;
  snapshot_id: string;
  sample_count: number;
  low: number;
  p25: number;
  median: number;
  p75: number;
  high: number;
  confidence: number | null;
};

export class ValuationWorkflowError extends Error {
  readonly status: number;

  constructor(message: string, status = 400) {
    super(message);
    this.name = "ValuationWorkflowError";
    this.status = status;
  }
}

function databaseError(error: { message?: string; code?: string } | null, fallback: string) {
  if (error?.code === "42501") return new ValuationWorkflowError("当前账户没有估值研究写入权限。", 403);
  return new ValuationWorkflowError(error?.message || fallback, 500);
}

const runSelect = "id,portfolio_id,asset_id,market_source_id,status,search_terms,raw_count,deduplicated_count,included_count,p25_cny,median_cny,p75_cny,sample_count,confidence,methodology,price_semantics,error_message,created_at,created_by,confirmed_at,confirmed_by,confirmed_snapshot_id";
const listingSelect = "id,portfolio_id,market_source_id,asset_id,research_run_id,external_listing_id,title,listing_url,asking_price,currency,seller_name,listed_at,captured_at,condition_text,review_status,exclusion_reason,listing_fingerprint,metadata,observed_at";

export async function getValuationResearchRun(supabase: SupabaseClient, runId: string) {
  const { data, error } = await supabase
    .from("valuation_research_runs")
    .select(runSelect)
    .eq("id", runId)
    .maybeSingle();
  if (error) throw databaseError(error, "读取估值研究失败。");
  return data as ValuationResearchRun | null;
}

export async function getValuationResearchListings(supabase: SupabaseClient, runId: string) {
  const { data, error } = await supabase
    .from("market_listings")
    .select(listingSelect)
    .eq("research_run_id", runId)
    .order("asking_price", { ascending: true });
  if (error) throw databaseError(error, "读取闲鱼挂牌样本失败。");
  return (data ?? []) as ValuationResearchListing[];
}

export async function createValuationResearchRun(supabase: SupabaseClient, input: {
  portfolioId: string;
  assetId: string;
  marketSourceId: string;
  userId: string;
  searchTerms: string[];
  rawCount: number;
  deduplicatedCount: number;
  methodology: string;
}) {
  const { data, error } = await supabase
    .from("valuation_research_runs")
    .insert({
      portfolio_id: input.portfolioId,
      asset_id: input.assetId,
      market_source_id: input.marketSourceId,
      status: "researching",
      search_terms: input.searchTerms,
      raw_count: input.rawCount,
      deduplicated_count: input.deduplicatedCount,
      included_count: 0,
      sample_count: 0,
      methodology: input.methodology,
      price_semantics: "asking_price",
      created_by: input.userId,
    })
    .select(runSelect)
    .single();
  if (error) throw databaseError(error, "创建估值研究失败。");
  return data as ValuationResearchRun;
}

export async function saveValuationResearchListings(supabase: SupabaseClient, input: {
  run: ValuationResearchRun;
  userId: string;
  listings: PreparedListing[];
}) {
  const observedAt = new Date().toISOString();
  if (input.listings.length) {
    const { error } = await supabase.from("market_listings").insert(input.listings.map((listing) => ({
      portfolio_id: input.run.portfolio_id,
      market_source_id: input.run.market_source_id,
      asset_id: input.run.asset_id,
      research_run_id: input.run.id,
      external_listing_id: listing.externalListingId || null,
      title: listing.title.trim(),
      listing_url: listing.listingUrl || null,
      asking_price: listing.askingPrice,
      currency: listing.currency,
      seller_name: listing.sellerName || null,
      listed_at: listing.listedAt || null,
      captured_at: listing.capturedAt || observedAt,
      condition_text: listing.conditionText || null,
      review_status: listing.reviewStatus,
      exclusion_reason: listing.exclusionReason,
      listing_fingerprint: listing.listingFingerprint,
      metadata: listing.metadata || {},
      observed_at: listing.capturedAt || observedAt,
      created_by: input.userId,
    })));
    if (error) throw databaseError(error, "保存闲鱼挂牌样本失败。");
  }
  return refreshResearchRunStatistics(supabase, input.run.id, "ready_for_review");
}

async function refreshResearchRunStatistics(
  supabase: SupabaseClient,
  runId: string,
  status?: ValuationResearchStatus,
) {
  const [run, listings] = await Promise.all([
    getValuationResearchRun(supabase, runId),
    getValuationResearchListings(supabase, runId),
  ]);
  if (!run) throw new ValuationWorkflowError("没有找到可访问的估值研究。", 404);
  if (run.status === "confirmed" || run.status === "cancelled") {
    throw new ValuationWorkflowError("已结束的估值研究不能再修改。", 409);
  }

  const included = listings.filter((listing) => listing.review_status === "included");
  const prices = included.map((listing) => Number(listing.asking_price));
  const stats = calculateValuationStatistics(prices);
  const confidence = calculateConfidence({
    includedPrices: prices,
    rawCount: run.raw_count,
    excludedCount: listings.filter((listing) => listing.review_status === "excluded").length,
  });
  const { data, error } = await supabase
    .from("valuation_research_runs")
    .update({
      status: status ?? run.status,
      included_count: stats.sampleCount,
      sample_count: stats.sampleCount,
      p25_cny: stats.p25,
      median_cny: stats.median,
      p75_cny: stats.p75,
      confidence,
      error_message: null,
    })
    .eq("id", run.id)
    .eq("portfolio_id", run.portfolio_id)
    .select(runSelect)
    .single();
  if (error) throw databaseError(error, "更新估值研究统计失败。");
  return data as ValuationResearchRun;
}

export async function updateListingReview(supabase: SupabaseClient, input: {
  runId: string;
  listingId: string;
  reviewStatus: ListingReviewStatus;
  exclusionReason?: ExclusionReason | null;
}) {
  if (!["pending", "included", "excluded"].includes(input.reviewStatus)) {
    throw new ValuationWorkflowError("无效的样本复核状态。");
  }
  const run = await getValuationResearchRun(supabase, input.runId);
  if (!run) throw new ValuationWorkflowError("没有找到可访问的估值研究。", 404);
  if (run.status === "confirmed" || run.status === "cancelled") {
    throw new ValuationWorkflowError("已结束的估值研究不能再修改。", 409);
  }
  const { data: listing, error: listingError } = await supabase
    .from("market_listings")
    .select("id")
    .eq("id", input.listingId)
    .eq("research_run_id", input.runId)
    .eq("portfolio_id", run.portfolio_id)
    .eq("asset_id", run.asset_id)
    .eq("market_source_id", run.market_source_id)
    .maybeSingle();
  if (listingError) throw databaseError(listingError, "读取待复核样本失败。");
  if (!listing) throw new ValuationWorkflowError("样本不属于该估值研究。", 404);
  const reason = input.reviewStatus === "excluded" ? input.exclusionReason : null;
  if (input.reviewStatus === "excluded" && (!reason || !exclusionReasons.includes(reason))) {
    throw new ValuationWorkflowError("排除样本时必须选择有效原因。");
  }
  const { error } = await supabase
    .from("market_listings")
    .update({ review_status: input.reviewStatus, exclusion_reason: reason })
    .eq("id", input.listingId)
    .eq("research_run_id", input.runId);
  if (error) throw databaseError(error, "更新样本复核结果失败。");
  return refreshResearchRunStatistics(supabase, input.runId);
}

export async function cancelValuationResearchRun(supabase: SupabaseClient, runId: string) {
  const { data, error } = await supabase
    .from("valuation_research_runs")
    .update({ status: "cancelled" })
    .eq("id", runId)
    .in("status", ["researching", "ready_for_review", "failed"])
    .select(runSelect)
    .maybeSingle();
  if (error) throw databaseError(error, "取消估值研究失败。");
  if (!data) throw new ValuationWorkflowError("估值研究已结束或不存在。", 409);
  return data as ValuationResearchRun;
}

export async function confirmValuationResearchRun(supabase: SupabaseClient, runId: string) {
  const { data, error } = await supabase.rpc("confirm_valuation_research_run", { p_run_id: runId });
  if (error) {
    const status = error.code === "42501" ? 403 : error.code === "P0002" ? 404 : 400;
    throw new ValuationWorkflowError(error.message || "确认估值研究失败。", status);
  }
  return data as ConfirmedValuationResearch;
}

export async function markValuationResearchFailed(
  supabase: SupabaseClient,
  runId: string,
  message: string,
) {
  await supabase
    .from("valuation_research_runs")
    .update({ status: "failed", error_message: message.slice(0, 1000) })
    .eq("id", runId)
    .eq("status", "researching");
}
