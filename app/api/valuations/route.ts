import { getD1 } from "../../../db";
import { jsonError, numberValue, readObject, text } from "../_shared";

export async function POST(request: Request) {
  try {
    const body = await readObject(request);
    const average = numberValue(body.averageCny, "平均售价");
    await getD1().prepare(`
      INSERT INTO market_valuations
        (id, camera_id, source, valued_at, low_cny, average_cny, premium_cny, expected_cny, sample_size, notes)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).bind(
      crypto.randomUUID(), text(body.cameraId, "相机"), text(body.source, "估价来源", false) || "闲鱼",
      text(body.valuedAt, "估价日期"), numberValue(body.lowCny, "最低售价"), average,
      numberValue(body.premiumCny, "精品售价"), numberValue(body.expectedCny ?? average, "预计售价"),
      body.sampleSize ? numberValue(body.sampleSize, "样本数") : null,
      text(body.notes, "备注", false) || null,
    ).run();
    return Response.json({ ok: true }, { status: 201 });
  } catch (error) {
    return jsonError(error);
  }
}
