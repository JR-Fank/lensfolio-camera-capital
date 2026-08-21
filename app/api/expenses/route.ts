import { getD1 } from "../../../db";
import { jsonError, numberValue, readObject, text, writeAccessError } from "../_shared";

export async function POST(request: Request) {
  const accessError = writeAccessError(request);
  if (accessError) return accessError;

  try {
    const body = await readObject(request);
    await getD1().prepare(`
      INSERT INTO asset_expenses (id, camera_id, expense_date, category, amount_cny, notes)
      VALUES (?, ?, ?, ?, ?, ?)
    `).bind(
      crypto.randomUUID(), text(body.cameraId, "相机"), text(body.expenseDate, "日期"),
      text(body.category, "费用类型", false) || "其他",
      numberValue(body.amountCny, "费用金额"), text(body.notes, "备注", false) || null,
    ).run();
    return Response.json({ ok: true }, { status: 201 });
  } catch (error) {
    return jsonError(error);
  }
}
