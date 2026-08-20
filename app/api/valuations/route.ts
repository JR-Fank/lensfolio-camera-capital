import { getD1 } from "../../../db";
import { jsonError, numberValue, readObject, text, valuationConfidence } from "../_shared";

export async function POST(request: Request) {
  try {
    const body = await readObject(request);
    const median = numberValue(body.medianCny, "市场中位价");
    const high = numberValue(body.highCny, "价格区间上限");
    const low = numberValue(body.lowCny, "价格区间下限");
    const sampleSize = body.sampleSize ? numberValue(body.sampleSize, "样本数") : 0;
    await getD1().prepare(`
      INSERT INTO market_valuations
        (id, camera_id, source, keyword, valued_at, low_cny, average_cny, premium_cny,
         median_cny, high_cny, expected_cny, sample_size, condition_grade, confidence,
         collection_method, exclusion_rules, notes)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, '人工录入', ?, ?)
    `).bind(
      crypto.randomUUID(), text(body.cameraId, "相机"), text(body.source, "估价来源", false) || "闲鱼",
      text(body.keyword, "搜索关键词", false) || null,
      text(body.valuedAt, "估价日期"), low, median,
      high, median, high, numberValue(body.expectedCny ?? median, "预计售价"),
      sampleSize || null,
      text(body.conditionGrade, "样本成色", false) || null,
      valuationConfidence(sampleSize, low, median, high),
      "维修机,故障机,配件,皮套,说明书,空壳",
      text(body.notes, "备注", false) || null,
    ).run();
    return Response.json({ ok: true }, { status: 201 });
  } catch (error) {
    return jsonError(error);
  }
}
