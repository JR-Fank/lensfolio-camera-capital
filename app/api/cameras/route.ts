import { getD1 } from "../../../db";
import { jsonError, numberValue, readObject, slug, text } from "../_shared";

export async function POST(request: Request) {
  try {
    const body = await readObject(request);
    const brand = text(body.brand, "品牌");
    const model = text(body.model, "型号");
    const acquiredAt = text(body.acquiredAt, "购买日期");
    const purchaseJpy = numberValue(body.purchaseJpy, "日本购买价");
    const paidCny = numberValue(body.paidCny, "人民币实付");
    const domesticShippingJpy = numberValue(body.domesticShippingJpy, "日本境内运费");
    const totalJpy = numberValue(body.totalJpy ?? purchaseJpy + domesticShippingJpy, "日元订单总额");
    const exchangeRate = numberValue(body.exchangeRate ?? (totalJpy ? paidCny / totalJpy : 0), "汇率");
    const cameraId = slug(`${brand}-${model}`);
    const orderId = crypto.randomUUID();
    const db = getD1();
    const statements = [
      db.prepare(`
        INSERT INTO cameras
          (id, brand, model, variant, serial_number, acquired_at, lifecycle_status, repair_status, condition_grade, notes)
        VALUES (?, ?, ?, ?, ?, ?, '持有中', ?, ?, ?)
      `).bind(
        cameraId, brand, model, text(body.variant, "版本", false) || null,
        text(body.serialNumber, "序列号", false) || null, acquiredAt,
        text(body.repairStatus, "维修状态", false) || "未检测",
        text(body.conditionGrade, "成色", false) || null,
        text(body.notes, "备注", false) || null,
      ),
      db.prepare(`
        INSERT INTO purchase_orders
          (id, order_ref, platform, seller, purchased_at, item_price_jpy, service_fee_jpy,
           domestic_shipping_jpy, photo_fee_jpy, adjustment_jpy, discount_jpy, total_jpy,
           paid_cny, exchange_rate, status, notes)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, '已付款', ?)
      `).bind(
        orderId, text(body.orderRef, "采购订单号", false) || `PO-${Date.now()}`,
        text(body.platform, "采购平台", false) || "任意门",
        text(body.seller, "卖家", false) || null, acquiredAt, purchaseJpy,
        numberValue(body.serviceFeeJpy, "手续费"), domesticShippingJpy,
        numberValue(body.photoFeeJpy, "拍照费"), numberValue(body.adjustmentJpy, "调整金额"),
        numberValue(body.discountJpy, "优惠金额"), totalJpy, paidCny, exchangeRate,
        text(body.purchaseNotes, "采购备注", false) || null,
      ),
      db.prepare(`
        INSERT INTO purchase_order_items
          (id, order_id, camera_id, item_price_jpy, allocated_paid_cny, allocated_domestic_shipping_jpy, allocation_note)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `).bind(
        crypto.randomUUID(), orderId, cameraId, purchaseJpy, paidCny, domesticShippingJpy,
        "单机订单全额分配",
      ),
    ];

    const marketAverage = numberValue(body.marketAverageCny, "市场均价");
    if (marketAverage > 0) {
      statements.push(db.prepare(`
        INSERT INTO market_valuations
          (id, camera_id, source, valued_at, low_cny, average_cny, premium_cny, expected_cny, sample_size, notes)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).bind(
        crypto.randomUUID(), cameraId, text(body.valuationSource, "估价来源", false) || "闲鱼",
        text(body.valuationDate, "估价日期", false) || new Date().toISOString().slice(0, 10),
        numberValue(body.marketLowCny, "最低价"), marketAverage,
        numberValue(body.marketPremiumCny, "精品价"),
        numberValue(body.expectedSaleCny ?? marketAverage, "预计售价"),
        body.sampleSize ? numberValue(body.sampleSize, "样本数") : null,
        text(body.valuationNotes, "估价备注", false) || null,
      ));
    }

    await db.batch(statements);
    return Response.json({ ok: true, id: cameraId }, { status: 201 });
  } catch (error) {
    return jsonError(error);
  }
}

export async function PATCH(request: Request) {
  try {
    const body = await readObject(request);
    const id = text(body.id, "相机");
    const db = getD1();
    const found = await db.prepare("SELECT id FROM cameras WHERE id = ?").bind(id).first();
    if (!found) return jsonError(new Error("没有找到这台相机"), 404);
    await db.prepare(`
      UPDATE cameras SET lifecycle_status = ?, repair_status = ?, condition_grade = ?, notes = ?, updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `).bind(
      text(body.lifecycleStatus, "持有状态", false) || "持有中",
      text(body.repairStatus, "维修状态", false) || "未检测",
      text(body.conditionGrade, "成色", false) || null,
      text(body.notes, "备注", false) || null,
      id,
    ).run();
    return Response.json({ ok: true });
  } catch (error) {
    return jsonError(error);
  }
}
