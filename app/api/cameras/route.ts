import { getD1 } from "../../../db";
import { jsonError, numberValue, readObject, slug, text, valuationConfidence } from "../_shared";

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
    const platform = text(body.platform, "采购平台", false) || "任意门";
    const db = getD1();
    const statements = [
      db.prepare(`
        INSERT INTO cameras
          (id, brand, model, variant, serial_number, purchase_platform, weight_g,
           acquired_at, lifecycle_status, repair_status, condition_grade, notes)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).bind(
        cameraId, brand, model, text(body.variant, "版本", false) || null,
        text(body.serialNumber, "序列号", false) || null, platform,
        numberValue(body.weightG, "机器重量"), acquiredAt,
        text(body.lifecycleStatus, "资产状态", false) || "待入库",
        text(body.repairStatus, "维修状态", false) || "未检测",
        text(body.conditionGrade, "成色", false) || null,
        text(body.notes, "备注", false) || null,
      ),
      db.prepare(`
        INSERT INTO purchase_orders
          (id, order_ref, platform, seller, product_name, payment_method, paid_at,
           purchased_at, item_price_jpy, service_fee_jpy,
           domestic_shipping_jpy, photo_fee_jpy, adjustment_jpy, discount_jpy, total_jpy,
           paid_cny, exchange_rate, status, notes)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, '已付款', ?)
      `).bind(
        orderId, text(body.orderRef, "采购订单号", false) || `PO-${Date.now()}`,
        platform, text(body.seller, "卖家", false) || null,
        text(body.productName, "商品名称", false) || `${brand} ${model}`,
        text(body.paymentMethod, "支付方式", false) || "人民币支付",
        text(body.paidAt, "支付日期", false) || acquiredAt,
        acquiredAt, purchaseJpy,
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

    const marketMedian = numberValue(body.marketMedianCny, "市场中位价");
    if (marketMedian > 0) {
      const marketLow = numberValue(body.marketLowCny, "价格区间下限");
      const marketHigh = numberValue(body.marketHighCny, "价格区间上限");
      const sampleSize = body.sampleSize ? numberValue(body.sampleSize, "样本数") : 0;
      statements.push(db.prepare(`
        INSERT INTO market_valuations
          (id, camera_id, source, keyword, valued_at, low_cny, average_cny, premium_cny,
           median_cny, high_cny, expected_cny, sample_size, condition_grade, confidence,
           collection_method, exclusion_rules, notes)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, '人工录入', ?, ?)
      `).bind(
        crypto.randomUUID(), cameraId, text(body.valuationSource, "估价来源", false) || "闲鱼",
        text(body.valuationKeyword, "搜索关键词", false) || `${brand} ${model}`,
        text(body.valuationDate, "估价日期", false) || new Date().toISOString().slice(0, 10),
        marketLow, marketMedian, marketHigh, marketMedian, marketHigh,
        numberValue(body.expectedSaleCny ?? marketMedian, "预计售价"),
        sampleSize || null,
        text(body.conditionGrade, "成色", false) || null,
        valuationConfidence(sampleSize, marketLow, marketMedian, marketHigh),
        "维修机,故障机,配件,皮套,说明书,空壳",
        text(body.valuationNotes, "估价备注", false) || null,
      ));
    }

    const initialOtherCost = numberValue(body.otherCostCny, "其他费用");
    if (initialOtherCost > 0) {
      statements.push(db.prepare(`
        INSERT INTO asset_expenses (id, camera_id, expense_date, category, amount_cny, notes)
        VALUES (?, ?, ?, '其他', ?, ?)
      `).bind(crypto.randomUUID(), cameraId, acquiredAt, initialOtherCost, "建档时录入"));
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
      text(body.lifecycleStatus, "持有状态", false) || "已入库",
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
