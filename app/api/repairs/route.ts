import { getD1 } from "../../../db";
import { jsonError, numberValue, readObject, text } from "../_shared";

export async function POST(request: Request) {
  try {
    const body = await readObject(request);
    const cameraId = text(body.cameraId, "相机");
    const resultingStatus = text(body.resultingStatus, "维修结果") || "已维修";
    const db = getD1();
    await db.batch([
      db.prepare(`
        INSERT INTO repair_records
          (id, camera_id, repair_date, problem, work_performed, cost_cny, vendor, resulting_status, notes)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).bind(
        crypto.randomUUID(), cameraId, text(body.repairDate, "日期"), text(body.problem, "问题"),
        text(body.workPerformed, "维修项目"), numberValue(body.costCny, "维修费用"),
        text(body.vendor, "维修商", false) || null, resultingStatus,
        text(body.notes, "备注", false) || null,
      ),
      db.prepare("UPDATE cameras SET repair_status = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?")
        .bind(resultingStatus, cameraId),
    ]);
    return Response.json({ ok: true }, { status: 201 });
  } catch (error) {
    return jsonError(error);
  }
}
