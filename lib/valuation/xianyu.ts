import { getAssetLocalizedName } from "../asset-display-names.ts";

export const XIANYU_PRICE_SEMANTICS = "asking_price" as const;
export const XIANYU_METHODOLOGY_VERSION = "xianyu-asking-v1";

export const exclusionReasons = [
  "accessory",
  "wanted",
  "wrong_model",
  "body_or_shell_only",
  "broken_or_junk",
  "collector_premium",
  "different_variant",
  "duplicate",
  "suspicious_price",
  "insufficient_information",
] as const;

export type ExclusionReason = typeof exclusionReasons[number];
export type ListingReviewStatus = "pending" | "included" | "excluded";

export type XianyuAssetIdentity = {
  brand: string;
  model: string;
};

export type NormalizedListingInput = {
  externalListingId?: string | null;
  title: string;
  listingUrl?: string | null;
  askingPrice: number;
  currency?: string | null;
  sellerName?: string | null;
  listedAt?: string | null;
  capturedAt?: string | null;
  conditionText?: string | null;
  metadata?: Record<string, unknown> | null;
};

export type PreparedListing = NormalizedListingInput & {
  currency: string;
  normalizedTitle: string;
  listingFingerprint: string;
  reviewStatus: ListingReviewStatus;
  exclusionReason: ExclusionReason | null;
};

export type ValuationStatistics = {
  sampleCount: number;
  low: number | null;
  p25: number | null;
  median: number | null;
  p75: number | null;
  high: number | null;
};

const accessoryPattern = /(?:相机包|皮套|保护套|镜头盖|电池|充电器|说明书|背带|转接环|配件|贴膜)/i;
const completeCameraEvidencePattern = /(?:整机|胶片机|旁轴相机|功能正常|正常使用|无故障|全部正常|测试正常|实拍可用|(?:带|含|附送|附赠).{0,8}(?:相机包|皮套|保护套|镜头盖|电池|充电器|说明书|背带|转接环|贴膜))/i;
const wantedPattern = /(?:求购|收购|高价回收|蹲一台|想收)/i;
const shellPattern = /(?:空壳|机壳|外壳|拆机件|零件壳)/i;
const junkPattern = /(?:故障|坏机|尸体|报废|无法开机|不能开机|不能使用|维修机|零件机|进水|漏液)/i;
const premiumPattern = /(?:收藏级|未拆封|全新库存|纪念版|限量版|限量纪念)/i;
const positiveConditionPattern = /(?:功能正常|正常使用|无故障|全部正常|测试正常|实拍可用)/i;
const uncertainConditionPattern = /(?:未测试|未全面测试|功能未知|不懂测试|仅开机|只测试开机|未实拍|不保证功能)/i;

const modelAliasCatalog = new Map<string, string[]>([
  ["contax::t2", ["Contax T2", "T2", "康泰时 T2"]],
  ["contax::t2 date back", ["Contax T2 Date Back", "T2 Date Back", "康泰时 T2 Date Back"]],
  ["contax::tvs ii", ["Contax TVS II", "TVS II", "康泰时 TVS II"]],
  ["nikon::28ti", ["Nikon 28Ti", "28Ti", "尼康 28Ti"]],
  ["canon::autoboy s ii", ["Canon Autoboy S II", "Autoboy S II", "佳能 Autoboy S II", "小霹雳 S II", "佳能 小霹雳 S II"]],
  ["canon::autoboy s", ["Canon Autoboy S", "Autoboy S", "佳能 Autoboy S", "小霹雳 S", "佳能 小霹雳 S"]],
  ["rollei::35 classic titanium", ["Rollei 35 Classic Titanium", "Rollei 35 Classic 钛", "禄来 35 Classic Titanium", "禄来 35 Classic 钛", "禄来 35 Classic 钛金版"]],
]);

function distinct(values: Array<string | null | undefined>) {
  return [...new Set(values.map((value) => value?.trim()).filter((value): value is string => Boolean(value)))];
}

export function normalizeSearchTerms(asset: XianyuAssetIdentity) {
  const localizedName = getAssetLocalizedName(asset.brand, asset.model);
  return distinct([
    localizedName,
    `${asset.brand} ${asset.model}`,
    asset.model,
  ]);
}

export function mergeSearchTerms(asset: XianyuAssetIdentity, suppliedTerms: string[]) {
  const seen = new Set<string>();
  return [...normalizeSearchTerms(asset), ...suppliedTerms]
    .map((term) => term.trim())
    .filter((term) => {
      if (!term) return false;
      const key = term.normalize("NFKC").toLocaleLowerCase("zh-CN");
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
}

export function normalizeListingTitle(title: string) {
  return title
    .normalize("NFKC")
    .toLocaleLowerCase("zh-CN")
    .replace(/[·•・_/\\|,，。:：;；!！?？()（）[\]【】{}<>《》"'“”‘’-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

const trackingQueryParameters = new Set([
  "spm",
  "track",
  "tracking",
  "track_id",
  "tracking_id",
  "share_token",
]);

export function canonicalizeListingUrl(value: string | null | undefined) {
  if (!value?.trim()) return null;
  try {
    const url = new URL(value.trim());
    url.hash = "";
    for (const key of [...url.searchParams.keys()]) {
      const normalizedKey = key.toLocaleLowerCase("en-US");
      if (normalizedKey.startsWith("utm_") || trackingQueryParameters.has(normalizedKey)) {
        url.searchParams.delete(key);
      }
    }
    url.searchParams.sort();
    const pathname = url.pathname === "/" ? "" : url.pathname.replace(/\/$/, "");
    return `${url.protocol.toLowerCase()}//${url.host.toLowerCase()}${pathname}${url.search}`;
  } catch {
    return value.trim().toLowerCase();
  }
}

export function isValidIsoDateTime(value: string) {
  return /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,9})?)?(?:Z|[+-]\d{2}:\d{2})$/.test(value)
    && Number.isFinite(Date.parse(value));
}

async function sha256(value: string) {
  const bytes = new TextEncoder().encode(value);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

export async function listingFingerprint(listing: NormalizedListingInput) {
  return sha256(JSON.stringify({
    title: normalizeListingTitle(listing.title),
    askingPrice: Number(listing.askingPrice).toFixed(2),
    currency: (listing.currency || "CNY").trim().toUpperCase(),
    seller: normalizeListingTitle(listing.sellerName || ""),
  }));
}

function compactModel(value: string) {
  return normalizeListingTitle(value).replace(/\s+/g, "");
}

function assetIdentityKey(target: XianyuAssetIdentity) {
  return `${normalizeListingTitle(target.brand)}::${normalizeListingTitle(target.model)}`;
}

export function getXianyuModelAliases(target: XianyuAssetIdentity) {
  const localizedName = getAssetLocalizedName(target.brand, target.model);
  const localizedParts = localizedName?.split("/").map((part) => part.trim()) ?? [];
  return distinct([
    ...(modelAliasCatalog.get(assetIdentityKey(target)) ?? []),
    `${target.brand} ${target.model}`,
    target.model,
    localizedName,
    ...localizedParts,
  ]);
}

function containsAnyAlias(compactTitle: string, aliases: string[]) {
  return aliases.some((alias) => compactTitle.includes(compactModel(alias)));
}

type ModelMatch = "match" | "uncertain_variant" | "different_variant" | "wrong_model" | "missing";

function matchKnownModel(title: string, target: XianyuAssetIdentity): ModelMatch {
  const compactTitle = compactModel(title);
  const targetKey = assetIdentityKey(target);
  const hasDateBack = /date\s*back|dateback/i.test(normalizeListingTitle(title));
  const hasT2 = containsAnyAlias(compactTitle, ["Contax T2", "康泰时 T2"]);
  const hasTvsIi = containsAnyAlias(compactTitle, modelAliasCatalog.get("contax::tvs ii") ?? []);
  const hasAutoboySii = containsAnyAlias(compactTitle, ["Autoboy S II", "小霹雳 S II"]);
  const hasAutoboyS = !hasAutoboySii && containsAnyAlias(compactTitle, ["Autoboy S", "小霹雳 S"]);
  const hasRolleiClassic = containsAnyAlias(compactTitle, ["Rollei 35 Classic", "禄来 35 Classic", "35 Classic"]);
  const hasTitanium = /titanium|钛/i.test(normalizeListingTitle(title));
  const hasOtherRolleiVariant = /(?:gold|黄金|platinum|铂金)/i.test(normalizeListingTitle(title));

  if (targetKey === "contax::t2") {
    if (hasTvsIi) return "wrong_model";
    if (!hasT2) return "missing";
    return hasDateBack ? "different_variant" : "match";
  }
  if (targetKey === "contax::t2 date back") {
    if (hasTvsIi) return "wrong_model";
    if (!hasT2) return "missing";
    return hasDateBack ? "match" : "different_variant";
  }
  if (targetKey === "canon::autoboy s") {
    if (hasAutoboySii) return "different_variant";
    return hasAutoboyS ? "match" : "missing";
  }
  if (targetKey === "canon::autoboy s ii") {
    if (hasAutoboySii) return "match";
    return hasAutoboyS ? "different_variant" : "missing";
  }
  if (targetKey === "rollei::35 classic titanium") {
    if (!hasRolleiClassic) return "missing";
    if (hasOtherRolleiVariant) return "different_variant";
    return hasTitanium ? "match" : "uncertain_variant";
  }
  if (containsAnyAlias(compactTitle, getXianyuModelAliases(target))) return "match";

  const matchesAnotherKnownModel = [...modelAliasCatalog.entries()].some(([key, aliases]) => (
    key !== targetKey && containsAnyAlias(compactTitle, aliases)
  ));
  return matchesAnotherKnownModel ? "wrong_model" : "missing";
}

export function classifyListing(listing: NormalizedListingInput, target: XianyuAssetIdentity): {
  reviewStatus: ListingReviewStatus;
  exclusionReason: ExclusionReason | null;
} {
  const title = normalizeListingTitle(listing.title);
  const combined = `${title} ${normalizeListingTitle(listing.conditionText || "")}`;
  const modelMatch = matchKnownModel(title, target);

  if (!Number.isFinite(listing.askingPrice) || listing.askingPrice <= 0) {
    return { reviewStatus: "excluded", exclusionReason: "suspicious_price" };
  }
  if (wantedPattern.test(combined)) return { reviewStatus: "excluded", exclusionReason: "wanted" };
  if (shellPattern.test(combined)) return { reviewStatus: "excluded", exclusionReason: "body_or_shell_only" };
  if (junkPattern.test(combined.replace(/(?:无故障|没有故障)/gi, ""))) {
    return { reviewStatus: "excluded", exclusionReason: "broken_or_junk" };
  }
  if (accessoryPattern.test(title) && !completeCameraEvidencePattern.test(title)) {
    return { reviewStatus: "excluded", exclusionReason: "accessory" };
  }
  if (premiumPattern.test(combined)) return { reviewStatus: "excluded", exclusionReason: "collector_premium" };
  if (modelMatch === "different_variant") return { reviewStatus: "excluded", exclusionReason: "different_variant" };
  if (modelMatch === "wrong_model") return { reviewStatus: "excluded", exclusionReason: "wrong_model" };
  if (modelMatch === "missing") return { reviewStatus: "excluded", exclusionReason: "insufficient_information" };
  if (modelMatch === "uncertain_variant") return { reviewStatus: "pending", exclusionReason: null };
  if (uncertainConditionPattern.test(combined)) return { reviewStatus: "pending", exclusionReason: null };
  if (positiveConditionPattern.test(combined)) return { reviewStatus: "included", exclusionReason: null };

  // Matching a model is not evidence that the camera is complete and working.
  return { reviewStatus: "pending", exclusionReason: null };
}

export async function deduplicateListings(
  listings: NormalizedListingInput[],
  target: XianyuAssetIdentity,
) {
  const seen = new Set<string>();
  const prepared: PreparedListing[] = [];
  let duplicateCount = 0;

  for (const listing of listings) {
    const fingerprint = await listingFingerprint(listing);
    const identities = distinct([
      listing.externalListingId ? `external:${listing.externalListingId.trim().toLowerCase()}` : null,
      canonicalizeListingUrl(listing.listingUrl) ? `url:${canonicalizeListingUrl(listing.listingUrl)}` : null,
      `fingerprint:${fingerprint}`,
    ]);
    const isDuplicate = identities.some((identity) => seen.has(identity));
    identities.forEach((identity) => seen.add(identity));
    if (isDuplicate) {
      duplicateCount += 1;
      continue;
    }
    const classification = classifyListing(listing, target);
    prepared.push({
      ...listing,
      currency: (listing.currency || "CNY").trim().toUpperCase(),
      normalizedTitle: normalizeListingTitle(listing.title),
      listingFingerprint: fingerprint,
      ...classification,
    });
  }

  return { listings: prepared, duplicateCount };
}

export function continuousPercentile(sortedValues: number[], percentile: number) {
  if (!sortedValues.length) return null;
  if (sortedValues.length === 1) return sortedValues[0];
  const index = (sortedValues.length - 1) * percentile;
  const lower = Math.floor(index);
  const upper = Math.ceil(index);
  if (lower === upper) return sortedValues[lower];
  const weight = index - lower;
  return sortedValues[lower] + (sortedValues[upper] - sortedValues[lower]) * weight;
}

export function calculateValuationStatistics(prices: number[]): ValuationStatistics {
  const sorted = prices.filter(Number.isFinite).sort((a, b) => a - b);
  return {
    sampleCount: sorted.length,
    low: sorted.at(0) ?? null,
    p25: continuousPercentile(sorted, 0.25),
    median: continuousPercentile(sorted, 0.5),
    p75: continuousPercentile(sorted, 0.75),
    high: sorted.at(-1) ?? null,
  };
}

export function calculateConfidence(input: {
  includedPrices: number[];
  rawCount: number;
  excludedCount: number;
}) {
  const stats = calculateValuationStatistics(input.includedPrices);
  if (!stats.sampleCount || stats.median === null || stats.median <= 0) return 0;
  const sampleScore = Math.min(1, stats.sampleCount / 10);
  const dispersion = stats.p25 === null || stats.p75 === null
    ? 1
    : Math.min(1, Math.max(0, (stats.p75 - stats.p25) / stats.median));
  const dispersionScore = 1 - dispersion;
  const reviewedCount = Math.max(input.rawCount, stats.sampleCount + input.excludedCount, 1);
  const inclusionScore = stats.sampleCount / reviewedCount;
  return Math.max(0, Math.min(1, Number((sampleScore * 0.5 + dispersionScore * 0.3 + inclusionScore * 0.2).toFixed(5))));
}

export function assertResearchableAsset(asset: { operational_status: string }) {
  if (asset.operational_status === "sold") {
    throw new Error("已出售资产不能启动新的市场估值研究。");
  }
}
