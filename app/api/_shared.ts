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
