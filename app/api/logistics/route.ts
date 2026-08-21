import { getD1 } from "../../../db";
import { booleanValue, jsonError, numberValue, readObject, text, writeAccessError } from "../_shared";

export async function POST(request: Request) {
  const accessError = writeAccessError(request);
  if (accessError) return accessError;

  try {
    const body = await readObject(request);
    const cameraIds = Array.isArray(body.cameraIds)
      ? body.cameraIds.map((value) => String(value).trim()).filter(Boolean)
      : [];
    if (!cameraIds.length) throw new Error("请至少选择一台相机");
    const logisticsOrderId = crypto.randomUUID();
    const shippingCny = numberValue(body.shippingCny, "物流费用");
    const handlingCny = numberValue(body.handlingCny, "手续费");
    const db = getD1();
    const placeholders = cameraIds.map(() => "?").join(", ");
    const cameraResult = await db.prepare(`
      SELECT id, weight_g AS weightG FROM cameras WHERE id IN (${placeholders})
    `).bind(...cameraIds).all<{ id: string; weightG: number }>();
    if (cameraResult.results.length !== cameraIds.length) throw new Error("关联机器中有记录不存在");

    const weightById = new Map(cameraResult.results.map((camera) => [camera.id, Number(camera.weightG)]));
    const requestedMethod = text(body.allocationMethod, "分摊方式", false) || "按重量";
    const canAllocateByWeight = requestedMethod === "按重量" && cameraIds.every((id) => (weightById.get(id) ?? 0) > 0);
    const allocationMethod = canAllocateByWeight ? "按重量" : "平均分摊";
    const totalWeight = cameraIds.reduce((sum, id) => sum + (weightById.get(id) ?? 0), 0);
    const allocatableCost = shippingCny + handlingCny;
    let allocatedSoFar = 0;
    const allocations = cameraIds.map((cameraId, index) => {
      const unrounded = canAllocateByWeight
        ? allocatableCost * (weightById.get(cameraId) ?? 0) / totalWeight
        : allocatableCost / cameraIds.length;
      const amount = index === cameraIds.length - 1
        ? Math.round((allocatableCost - allocatedSoFar) * 100) / 100
        : Math.round(unrounded * 100) / 100;
      allocatedSoFar += amount;
      return { cameraId, amount, weightG: weightById.get(cameraId) ?? 0 };
    });

    await db.batch([
      db.prepare(`
        INSERT INTO logistics_orders
          (id, batch_code, carrier, tracking_number, origin, destination, status, latest_event,
           estimated_arrival_at, seller_shipped_at, warehouse_in_at, international_shipped_at,
           bare_weight_g, chargeable_weight_g, shipping_jpy, shipping_cny, handling_cny,
           allocation_method, is_estimated, notes)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
        handlingCny, allocationMethod, booleanValue(body.isEstimated) ? 1 : 0,
        text(body.notes, "备注", false) || null,
      ),
      ...allocations.map(({ cameraId, amount, weightG }) => db.prepare(`
        INSERT INTO logistics_items
          (id, logistics_order_id, camera_id, allocated_shipping_cny, weight_g)
        VALUES (?, ?, ?, ?, ?)
      `).bind(crypto.randomUUID(), logisticsOrderId, cameraId, amount, weightG)),
      ...cameraIds.map((cameraId) => db.prepare(`
        UPDATE cameras SET lifecycle_status = '运输中', updated_at = CURRENT_TIMESTAMP
        WHERE id = ? AND lifecycle_status <> '已出售'
      `).bind(cameraId)),
    ]);
    return Response.json({ ok: true, id: logisticsOrderId, allocationMethod, allocations }, { status: 201 });
  } catch (error) {
    return jsonError(error);
  }
}
