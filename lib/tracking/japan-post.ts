export type JapanPostTrackingEvent = {
  occurredAt: string;
  rawStatus: string;
  statusLabel: string;
  details: string;
  office: string;
  country: string;
  postalCode: string;
};

export type JapanPostShipmentState = {
  status: "in_transit" | "customs" | "delivered";
  shippedAt: string | null;
  deliveredAt: string | null;
  legacyStatus: string;
};

const statusLabels: Record<string, string> = {
  "Posting/Collection": "已收寄",
  "Arrival at outward office of exchange": "到达日本国际交换局",
  "Dispatch from outward office of exchange": "离开日本",
  "Arrival at inward office of exchange": "到达香港",
  "Departure from inward office of exchange": "离开香港交换局",
  "Processing at delivery Post Office": "投递局处理中",
  "Item arrival at collection point for pick-up": "香港领取点待取",
  "Final delivery": "已签收",
  Retention: "待领取",
  "Returned to Sender": "退回寄件人",
};

function cleanHtml(value: string) {
  return value
    .replace(/<br\s*\/?>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;|&#160;|\u00a0/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/\s+/g, " ")
    .trim();
}

export function parseJapanPostJstTimestamp(value: string) {
  const match = value.match(/^(\d{2})\/(\d{2})\/(\d{4})\s+(\d{2}):(\d{2})$/);
  if (!match) throw new Error(`无法解析日本邮政时间：${value}`);

  const [, monthText, dayText, yearText, hourText, minuteText] = match;
  const month = Number(monthText);
  const day = Number(dayText);
  const year = Number(yearText);
  const hour = Number(hourText);
  const minute = Number(minuteText);
  const utcMillis = Date.UTC(year, month - 1, day, hour - 9, minute);
  const jstView = new Date(utcMillis + 9 * 60 * 60 * 1000);

  if (
    month < 1 || month > 12 || day < 1 || hour > 23 || minute > 59 ||
    jstView.getUTCFullYear() !== year ||
    jstView.getUTCMonth() !== month - 1 ||
    jstView.getUTCDate() !== day ||
    jstView.getUTCHours() !== hour ||
    jstView.getUTCMinutes() !== minute
  ) {
    throw new Error(`日本邮政时间无效：${value}`);
  }

  return new Date(utcMillis).toISOString();
}

export function parseJapanPostTracking(html: string): JapanPostTrackingEvent[] {
  const historyMatch = html.match(/<table[^>]+summary=["']履歴情報["'][^>]*>([\s\S]*?)<\/table>/i);
  if (!historyMatch) return [];

  const rows = [...historyMatch[1].matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/gi)]
    .map((row) => [...row[1].matchAll(/<td[^>]*>([\s\S]*?)<\/td>/gi)]
      .map((cell) => cleanHtml(cell[1])));

  const events: JapanPostTrackingEvent[] = [];
  for (let index = 0; index < rows.length; index += 1) {
    const cells = rows[index];
    if (cells.length < 5 || !/^\d{2}\/\d{2}\/\d{4}/.test(cells[0])) continue;
    const postalCode = rows[index + 1]?.length === 1 ? rows[index + 1][0] : "";
    events.push({
      occurredAt: parseJapanPostJstTimestamp(cells[0]),
      rawStatus: cells[1],
      statusLabel: statusLabels[cells[1]] ?? cells[1],
      details: cells[2],
      office: cells[3],
      country: cells[4],
      postalCode,
    });
  }

  return events.sort((a, b) => a.occurredAt.localeCompare(b.occurredAt));
}

export function isJapanPostTrackingNumber(value: string | null | undefined) {
  return /^[A-Z]{2}\d{9}JP$/.test(String(value ?? "").replace(/\s+/g, "").toUpperCase());
}

export function normalizeJapanPostTrackingNumber(value: string) {
  const normalized = value.replace(/\s+/g, "").toUpperCase();
  if (!isJapanPostTrackingNumber(normalized)) {
    throw new Error("日本邮政国际单号应为 2 个字母 + 9 位数字 + JP");
  }
  return normalized;
}

export function deriveJapanPostShipmentState(
  events: JapanPostTrackingEvent[],
): JapanPostShipmentState {
  if (!events.length) throw new Error("日本邮政暂未返回可识别的物流轨迹");

  const ordered = [...events].sort((a, b) => a.occurredAt.localeCompare(b.occurredAt));
  const latest = ordered.at(-1)!;
  const shippedAt = ordered.find((event) =>
    event.rawStatus === "Posting/Collection" ||
    event.rawStatus === "Dispatch from outward office of exchange"
  )?.occurredAt ?? null;
  const deliveredAt = [...ordered].reverse()
    .find((event) => event.rawStatus === "Final delivery")?.occurredAt ?? null;

  return {
    status: deliveredAt
      ? "delivered"
      : latest.rawStatus === "Arrival at inward office of exchange"
        ? "customs"
        : "in_transit",
    shippedAt,
    deliveredAt,
    legacyStatus: latest.statusLabel,
  };
}

export function japanPostEventLocation(event: JapanPostTrackingEvent) {
  return [event.office, event.postalCode, event.country].filter(Boolean).join(" · ") || null;
}

export async function japanPostEventFingerprint(
  trackingNumber: string,
  event: JapanPostTrackingEvent,
) {
  const normalizedTrackingNumber = normalizeJapanPostTrackingNumber(trackingNumber);
  const evidence = JSON.stringify([
    normalizedTrackingNumber,
    event.occurredAt,
    event.rawStatus,
    event.details,
    event.office,
    event.country,
    event.postalCode,
  ]);
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(evidence));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export async function fetchJapanPostTracking(
  trackingNumber: string,
  fetchImpl: typeof fetch = fetch,
) {
  const normalized = normalizeJapanPostTrackingNumber(trackingNumber);
  const url = new URL("https://trackings.post.japanpost.jp/services/srv/search/direct");
  url.searchParams.set("reqCodeNo1", normalized);
  url.searchParams.set("searchKind", "S004");
  url.searchParams.set("locale", "en");

  const response = await fetchImpl(url, {
    headers: { "User-Agent": "Lensfolio/1.0 (+private camera portfolio tracker)" },
    cache: "no-store",
  });
  if (!response.ok) throw new Error(`日本邮政查询失败（${response.status}）`);

  const events = parseJapanPostTracking(await response.text());
  if (!events.length) throw new Error("日本邮政暂未返回可识别的物流轨迹");
  return { trackingNumber: normalized, events };
}
