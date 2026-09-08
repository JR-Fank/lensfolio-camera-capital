import { getD1 } from "../../../db";
import { jsonError, numberValue, readObject, text, writeAccessError } from "../_shared";

export async function POST(request: Request) {
  const accessError = await writeAccessError(request);
  if (accessError) return accessError;

  try {
    const body = await readObject(request);
    const cameraId = text(body.cameraId, "相机");
    const resultingStatus = text(body.resultingStatus, "维修结果") || "已维修";
    const lifecycleStatus = resultingStatus === "待维修"
      ? "维修中"
      : resultingStatus === "未检测" ? "检测中" : "可出售";
    const db = getD1();
    await db.batch([
      db.prepare(`
        INSERT INTO repair_records
          (id, camera_id, repair_date, problem, work_performed, cost_cny, vendor,
           resulting_status, value_before_cny, value_after_cny, notes)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).bind(
        crypto.randomUUID(), cameraId, text(body.repairDate, "日期"), text(body.problem, "问题"),
        text(body.workPerformed, "维修项目"), numberValue(body.costCny, "维修费用"),
        text(body.vendor, "维修商", false) || null, resultingStatus,
        numberValue(body.valueBeforeCny, "维修前估值"), numberValue(body.valueAfterCny, "维修后估值"),
        text(body.notes, "备注", false) || null,
      ),
      db.prepare("UPDATE cameras SET repair_status = ?, lifecycle_status = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?")
        .bind(resultingStatus, lifecycleStatus, cameraId),
    ]);
    return Response.json({ ok: true }, { status: 201 });
  } catch (error) {
    return jsonError(error);
  }
}
