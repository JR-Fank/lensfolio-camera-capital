import { env } from "cloudflare:workers";
import {
  AUTHENTICATION_REQUIRED_MESSAGE,
  isMigrationReadOnly,
  MIGRATION_PROTECTION_MESSAGE,
} from "../../lib/migration-protection";

export function writeAccessError(request: Request) {
  if (isMigrationReadOnly(env)) {
    return Response.json({ error: MIGRATION_PROTECTION_MESSAGE }, { status: 423 });
  }

  const userId = request.headers.get("oai-authenticated-user-id")?.trim();
  const email = request.headers.get("oai-authenticated-user-email")?.trim();
  if (!userId || !email) {
    return Response.json({ error: AUTHENTICATION_REQUIRED_MESSAGE }, { status: 401 });
  }

  return null;
}

export async function readObject(request: Request) {
  const value = await request.json();
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("请求内容格式不正确");
  }
  return value as Record<string, unknown>;
}

export function text(value: unknown, field: string, required = true) {
  const normalized = String(value ?? "").trim();
  if (required && !normalized) throw new Error(`请填写${field}`);
  return normalized;
}

export function numberValue(value: unknown, field: string, minimum = 0) {
  const normalized = Number(value ?? 0);
  if (!Number.isFinite(normalized) || normalized < minimum) {
    throw new Error(`${field}格式不正确`);
  }
  return normalized;
}

export function booleanValue(value: unknown) {
  return value === true || value === "true" || value === 1 || value === "1";
}

export function jsonError(error: unknown, status = 400) {
  return Response.json(
    { error: error instanceof Error ? error.message : "操作失败，请稍后再试" },
    { status },
  );
}

export function slug(value: string) {
  const base = value
    .normalize("NFKD")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 42);
  return `${base || "camera"}-${crypto.randomUUID().slice(0, 8)}`;
}

export function valuationConfidence(sampleSize: number, low: number, median: number, high: number) {
  let score = sampleSize >= 50 ? 0.9 : sampleSize >= 20 ? 0.8 : sampleSize >= 10 ? 0.65 : sampleSize >= 5 ? 0.5 : 0.3;
  const spread = median > 0 ? (high - low) / median : 1;
  if (spread > 0.6) score -= 0.2;
  else if (spread > 0.35) score -= 0.1;
  if (low <= 0 || high <= 0) score -= 0.1;
  return Math.round(Math.max(0.2, Math.min(1, score)) * 10) / 10;
}
