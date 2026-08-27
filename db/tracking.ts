import { fetchJapanPostTracking } from "../lib/tracking/japan-post";

export {
  fetchJapanPostTracking,
  parseJapanPostTracking,
} from "../lib/tracking/japan-post";
export type { JapanPostTrackingEvent } from "../lib/tracking/japan-post";

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
