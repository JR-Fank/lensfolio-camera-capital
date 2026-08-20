export type JapanPostTrackingEvent = {
  occurredAt: string;
  rawStatus: string;
  statusLabel: string;
  details: string;
  office: string;
  country: string;
  postalCode: string;
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
  "Retention": "待领取",
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
    .replace(/\s+/g, " ")
    .trim();
}

function toSqlDate(value: string) {
  const match = value.match(/^(\d{2})\/(\d{2})\/(\d{4})\s+(\d{2}):(\d{2})$/);
  if (!match) return value;
  const [, month, day, year, hour, minute] = match;
  return `${year}-${month}-${day} ${hour}:${minute}:00`;
}

export function parseJapanPostTracking(html: string): JapanPostTrackingEvent[] {
  const historyMatch = html.match(/<table[^>]+summary=["']履歴情報["'][^>]*>([\s\S]*?)<\/table>/i);
  if (!historyMatch) return [];

  const rows = [...historyMatch[1].matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/gi)]
    .map((row) => [...row[1].matchAll(/<td[^>]*>([\s\S]*?)<\/td>/gi)].map((cell) => cleanHtml(cell[1])));

  const events: JapanPostTrackingEvent[] = [];
  for (let index = 0; index < rows.length; index += 1) {
    const cells = rows[index];
    if (cells.length < 5 || !/^\d{2}\/\d{2}\/\d{4}/.test(cells[0])) continue;
    const postalCode = rows[index + 1]?.length === 1 ? rows[index + 1][0] : "";
    events.push({
      occurredAt: toSqlDate(cells[0]),
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

export async function fetchJapanPostTracking(trackingNumber: string) {
  const normalized = trackingNumber.replace(/\s+/g, "").toUpperCase();
  if (!/^[A-Z]{2}\d{9}JP$/.test(normalized)) {
    throw new Error("日本邮政国际单号应为 2 个字母 + 9 位数字 + JP");
  }

  const url = new URL("https://trackings.post.japanpost.jp/services/srv/search/direct");
  url.searchParams.set("reqCodeNo1", normalized);
  url.searchParams.set("searchKind", "S004");
  url.searchParams.set("locale", "en");

  const response = await fetch(url, {
    headers: { "User-Agent": "Lensfolio/1.0 (+private camera portfolio tracker)" },
  });
  if (!response.ok) throw new Error(`日本邮政查询失败（${response.status}）`);

  const events = parseJapanPostTracking(await response.text());
  if (!events.length) throw new Error("日本邮政暂未返回可识别的物流轨迹");
  return { trackingNumber: normalized, events };
}

export async function refreshLogisticsTracking(db: D1Database, logisticsOrderId: string) {
  const order = await db
    .prepare("SELECT id, tracking_number, carrier FROM logistics_orders WHERE id = ? LIMIT 1")
    .bind(logisticsOrderId)
    .first<{ id: string; tracking_number: string | null; carrier: string }>();

  if (!order?.tracking_number) throw new Error("该物流订单尚未填写国际单号");
  if (!order.carrier.includes("日本邮政") && !order.carrier.includes("EMS")) {
    throw new Error("当前自动追踪仅支持日本邮政 EMS；DHL / FedEx 可先保存单号并人工更新");
  }

  try {
    const result = await fetchJapanPostTracking(order.tracking_number);
    const statements = result.events.map((event) => db.prepare(`
      INSERT OR IGNORE INTO logistics_events
        (id, logistics_order_id, occurred_at, raw_status, status_label, details, office, country, postal_code)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).bind(
      crypto.randomUUID(),
      logisticsOrderId,
      event.occurredAt,
      event.rawStatus,
      event.statusLabel,
      event.details,
      event.office,
      event.country,
      event.postalCode,
    ));
    if (statements.length) await db.batch(statements);

    const latest = result.events.at(-1)!;
    const hongKongArrival = [...result.events].reverse().find((event) => event.rawStatus === "Arrival at inward office of exchange");
    const delivered = [...result.events].reverse().find((event) => event.rawStatus === "Final delivery");
    await db.prepare(`
      UPDATE logistics_orders
      SET status = ?, latest_event = ?, hong_kong_arrived_at = COALESCE(?, hong_kong_arrived_at),
          delivered_at = COALESCE(?, delivered_at), last_checked_at = CURRENT_TIMESTAMP,
          tracking_source = 'Japan Post public tracking', tracking_error = NULL, updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `).bind(
      latest.statusLabel,
      latest.rawStatus,
      hongKongArrival?.occurredAt ?? null,
      delivered?.occurredAt ?? null,
      logisticsOrderId,
    ).run();

    return { ...result, latest };
  } catch (error) {
    const message = error instanceof Error ? error.message : "物流查询失败";
    await db.prepare(`
      UPDATE logistics_orders
      SET last_checked_at = CURRENT_TIMESTAMP, tracking_error = ?, updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `).bind(message, logisticsOrderId).run();
    throw error;
  }
}

export async function refreshDueTracking(db: D1Database) {
  const due = await db.prepare(`
    SELECT id FROM logistics_orders
    WHERE tracking_number IS NOT NULL
      AND (carrier LIKE '%日本邮政%' OR carrier LIKE '%EMS%')
      AND status NOT IN ('已签收', '退回寄件人')
      AND (last_checked_at IS NULL OR datetime(last_checked_at) <= datetime('now', '-24 hours'))
    ORDER BY COALESCE(last_checked_at, '1970-01-01') ASC
    LIMIT 20
  `).all<{ id: string }>();

  const outcomes: Array<{ id: string; ok: boolean; error?: string }> = [];
  for (const row of due.results) {
    try {
      await refreshLogisticsTracking(db, row.id);
      outcomes.push({ id: row.id, ok: true });
    } catch (error) {
      outcomes.push({ id: row.id, ok: false, error: error instanceof Error ? error.message : "查询失败" });
    }
  }
  return outcomes;
}
