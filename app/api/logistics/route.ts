import { getD1 } from "../../../db";
import { booleanValue, jsonError, numberValue, readObject, text } from "../_shared";

export async function POST(request: Request) {
  try {
    const body = await readObject(request);
    const cameraIds = Array.isArray(body.cameraIds)
      ? body.cameraIds.map((value) => String(value).trim()).filter(Boolean)
      : [];
    if (!cameraIds.length) throw new Error("请至少选择一台相机");
    const logisticsOrderId = crypto.randomUUID();
    const shippingCny = numberValue(body.shippingCny, "物流费用");
    const allocation = shippingCny / cameraIds.length;
    const db = getD1();
    await db.batch([
      db.prepare(`
        INSERT INTO logistics_orders
          (id, batch_code, carrier, tracking_number, origin, destination, status, latest_event,
           estimated_arrival_at, seller_shipped_at, warehouse_in_at, international_shipped_at,
           bare_weight_g, chargeable_weight_g, shipping_jpy, shipping_cny, handling_cny,
           is_estimated, notes)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).bind(
        logisticsOrderId, text(body.batchCode, "批次"), text(body.carrier, "快递公司", false) || "日本邮政 EMS",
        text(body.trackingNumber, "国际单号", false).toUpperCase() || null,
        text(body.origin, "起点", false) || "日本",
        text(body.destination, "终点", false) || "香港",
        text(body.status, "当前状态", false) || "待发货",
        text(body.latestEvent, "最新轨迹", false) || null,
        text(body.estimatedArrivalAt, "预计到达时间", false) || null,
        text(body.sellerShippedAt, "日本发货时间", false) || null,
        text(body.warehouseInAt, "入库时间", false) || null,
        text(body.internationalShippedAt, "国际发货时间", false) || null,
        numberValue(body.bareWeightG, "裸重"), numberValue(body.chargeableWeightG, "计费重量"),
        numberValue(body.shippingJpy, "日元运费"), shippingCny,
        numberValue(body.handlingCny, "手续费"), booleanValue(body.isEstimated) ? 1 : 0,
        text(body.notes, "备注", false) || null,
      ),
      ...cameraIds.map((cameraId) => db.prepare(`
        INSERT INTO logistics_items
          (id, logistics_order_id, camera_id, allocated_shipping_cny, weight_g)
        VALUES (?, ?, ?, ?, ?)
      `).bind(crypto.randomUUID(), logisticsOrderId, cameraId, allocation, 0)),
    ]);
    return Response.json({ ok: true, id: logisticsOrderId }, { status: 201 });
  } catch (error) {
    return jsonError(error);
  }
}
