import { writeAccessError } from "../../../../lib/supabase/write-access";
import { createClient } from "../../../../lib/supabase/server";
import {
  cancelValuationResearchRun,
  createValuationResearchRun,
  markValuationResearchFailed,
  saveValuationResearchListings,
  updateListingReview,
  ValuationWorkflowError,
} from "../../../../lib/supabase/valuations";
import {
  assertResearchableAsset,
  deduplicateListings,
  exclusionReasons,
  isValidIsoDateTime,
  mergeSearchTerms,
  type ExclusionReason,
  type ListingReviewStatus,
  type NormalizedListingInput,
} from "../../../../lib/valuation/xianyu";

export const runtime = "nodejs";

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function workflowResponse(error: unknown) {
  const status = error instanceof ValuationWorkflowError ? error.status : 500;
  const message = error instanceof Error ? error.message : "估值研究处理失败。";
  return Response.json({ error: message }, { status });
}

function optionalText(value: unknown) {
  const text = typeof value === "string" ? value.trim() : "";
  return text || null;
}

function optionalIsoDateTime(value: unknown, index: number, field: string) {
  const text = optionalText(value);
  if (text && !isValidIsoDateTime(text)) {
    throw new ValuationWorkflowError(`第 ${index + 1} 条样本的 ${field} 不是有效 ISO datetime。`);
  }
  return text;
}

function parseListing(value: unknown, index: number): NormalizedListingInput {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new ValuationWorkflowError(`第 ${index + 1} 条样本格式不正确。`);
  }
  const row = value as Record<string, unknown>;
  const title = optionalText(row.title);
  const askingPrice = typeof row.askingPrice === "number"
    || (typeof row.askingPrice === "string" && row.askingPrice.trim())
    ? Number(row.askingPrice)
    : Number.NaN;
  const currency = (optionalText(row.currency) || "CNY").toUpperCase();
  if (!title) throw new ValuationWorkflowError(`第 ${index + 1} 条样本缺少标题。`);
  if (!Number.isFinite(askingPrice) || askingPrice < 0) {
    throw new ValuationWorkflowError(`第 ${index + 1} 条样本挂牌价无效。`);
  }
  if (!/^[A-Z]{3}$/.test(currency)) throw new ValuationWorkflowError(`第 ${index + 1} 条样本币种无效。`);
  const metadata = row.metadata && typeof row.metadata === "object" && !Array.isArray(row.metadata)
    ? row.metadata as Record<string, unknown>
    : {};
  return {
    externalListingId: optionalText(row.externalListingId),
    title,
    listingUrl: optionalText(row.listingUrl),
    askingPrice,
    currency,
    sellerName: optionalText(row.sellerName),
    listedAt: optionalIsoDateTime(row.listedAt, index, "listedAt"),
    capturedAt: optionalIsoDateTime(row.capturedAt, index, "capturedAt"),
    conditionText: optionalText(row.conditionText),
    metadata,
  };
}

async function authenticatedRequest() {
  const supabase = await createClient();
  const { data, error } = await supabase.auth.getUser();
  if (error || !data.user) throw new ValuationWorkflowError("请先登录 Lensfolio。", 401);
  const accessError = await writeAccessError(supabase);
  if (accessError) throw new ValuationWorkflowError("当前账户没有写入权限。", accessError.status);
  return { supabase, user: data.user };
}

export async function POST(request: Request) {
  let runId: string | null = null;
  let supabase: Awaited<ReturnType<typeof createClient>> | null = null;
  try {
    const authenticated = await authenticatedRequest();
    supabase = authenticated.supabase;
    const body = await request.json() as Record<string, unknown>;
    const assetId = optionalText(body.assetId);
    if (!assetId || !uuidPattern.test(assetId)) throw new ValuationWorkflowError("资产 UUID 格式不正确。");
    if (!Array.isArray(body.listings) || body.listings.length === 0) {
      throw new ValuationWorkflowError("至少需要一条已采集的闲鱼挂牌样本。");
    }
    if (body.listings.length > 250) throw new ValuationWorkflowError("单次研究最多接收 250 条样本。");

    const { data: asset, error: assetError } = await supabase
      .from("assets")
      .select("id,portfolio_id,brand,model,operational_status")
      .eq("id", assetId)
      .maybeSingle();
    if (assetError) throw new ValuationWorkflowError(assetError.message, 500);
    if (!asset) throw new ValuationWorkflowError("没有找到可访问的资产。", 404);
    assertResearchableAsset(asset);

    const { data: completedSale, error: saleError } = await supabase
      .from("sales")
      .select("id")
      .eq("portfolio_id", asset.portfolio_id)
      .eq("asset_id", asset.id)
      .eq("status", "sold")
      .limit(1)
      .maybeSingle();
    if (saleError) throw new ValuationWorkflowError(saleError.message, 500);
    if (completedSale) throw new ValuationWorkflowError("已出售资产不能启动新的市场估值研究。", 409);

    const { data: source, error: sourceError } = await supabase
      .from("market_sources")
      .select("id")
      .eq("portfolio_id", asset.portfolio_id)
      .eq("source_type", "xianyu")
      .eq("active", true)
      .limit(1)
      .maybeSingle();
    if (sourceError) throw new ValuationWorkflowError(sourceError.message, 500);
    if (!source) throw new ValuationWorkflowError("当前 portfolio 没有可用的闲鱼 market source。", 409);

    const listings = body.listings.map(parseListing);
    const prepared = await deduplicateListings(listings, { brand: asset.brand, model: asset.model });
    const suppliedTerms = Array.isArray(body.searchTerms)
      ? body.searchTerms.map(optionalText).filter((term): term is string => Boolean(term))
      : [];
    const searchTerms = mergeSearchTerms(asset, suppliedTerms);
    const run = await createValuationResearchRun(supabase, {
      portfolioId: asset.portfolio_id,
      assetId: asset.id,
      marketSourceId: source.id,
      userId: authenticated.user.id,
      searchTerms,
      rawCount: listings.length,
      deduplicatedCount: prepared.listings.length,
      methodology: "闲鱼 asking prices；保守型号匹配、规则排除、候选去重、人工复核后使用 percentile_cont。",
    });
    runId = run.id;
    const readyRun = await saveValuationResearchListings(supabase, {
      run,
      userId: authenticated.user.id,
      listings: prepared.listings,
    });
    return Response.json({
      ok: true,
      run: readyRun,
      duplicateCount: prepared.duplicateCount,
      reviewUrl: `/cameras/${asset.id}/valuation/research/${run.id}`,
    }, { status: 201, headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    if (supabase && runId) {
      const message = error instanceof Error ? error.message : "估值研究导入失败。";
      await markValuationResearchFailed(supabase, runId, message).catch(() => undefined);
    }
    return workflowResponse(error);
  }
}

export async function PATCH(request: Request) {
  try {
    const { supabase } = await authenticatedRequest();
    const body = await request.json() as Record<string, unknown>;
    const runId = optionalText(body.runId);
    const listingId = optionalText(body.listingId);
    const reviewStatus = optionalText(body.reviewStatus) as ListingReviewStatus | null;
    const exclusionReason = optionalText(body.exclusionReason) as ExclusionReason | null;
    if (!runId || !uuidPattern.test(runId) || !listingId || !uuidPattern.test(listingId)) {
      throw new ValuationWorkflowError("研究或样本 UUID 格式不正确。");
    }
    if (!reviewStatus || !["pending", "included", "excluded"].includes(reviewStatus)) {
      throw new ValuationWorkflowError("样本复核状态无效。");
    }
    if (exclusionReason && !exclusionReasons.includes(exclusionReason)) {
      throw new ValuationWorkflowError("样本排除原因无效。");
    }
    const run = await updateListingReview(supabase, { runId, listingId, reviewStatus, exclusionReason });
    return Response.json({ ok: true, run }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return workflowResponse(error);
  }
}

export async function DELETE(request: Request) {
  try {
    const { supabase } = await authenticatedRequest();
    const body = await request.json() as Record<string, unknown>;
    const runId = optionalText(body.runId);
    if (!runId || !uuidPattern.test(runId)) throw new ValuationWorkflowError("研究 UUID 格式不正确。");
    const run = await cancelValuationResearchRun(supabase, runId);
    return Response.json({ ok: true, run }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return workflowResponse(error);
  }
}
