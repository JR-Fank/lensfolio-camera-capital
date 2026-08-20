import { getD1 } from "../../../db";
import { jsonError, numberValue, readObject, text } from "../_shared";

export async function POST(request: Request) {
  try {
    const body = await readObject(request);
    const cameraId = text(body.cameraId, "相机");
    const status = text(body.status, "出售状态", false) || "待出售";
    const db = getD1();
    await db.batch([
      db.prepare(`
        INSERT INTO sales_records
          (id, camera_id, platform, status, listed_at, sold_at, asking_price_cny,
           market_price_cny, actual_price_cny, platform_fee_cny, shipping_cny, buyer_notes)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).bind(
        crypto.randomUUID(), cameraId, text(body.platform, "平台", false) || "闲鱼", status,
        text(body.listedAt, "上架日期", false) || null,
        status === "已出售" ? text(body.soldAt, "成交日期") : null,
        numberValue(body.askingPriceCny, "挂牌价"), numberValue(body.marketPriceCny, "当时市场价"),
        numberValue(body.actualPriceCny, "成交价"),
        numberValue(body.platformFeeCny, "平台费用"), numberValue(body.shippingCny, "出售运费"),
        text(body.buyerNotes, "备注", false) || null,
      ),
      db.prepare("UPDATE cameras SET lifecycle_status = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?")
        .bind(status === "已出售" ? "已出售" : "可出售", cameraId),
    ]);
    return Response.json({ ok: true }, { status: 201 });
  } catch (error) {
    return jsonError(error);
  }
}
