import { getD1 } from "../../../../db";
import { refreshLogisticsTracking } from "../../../../db/tracking";
import { jsonError, readObject, text, writeAccessError } from "../../_shared";

export async function POST(request: Request) {
  const accessError = writeAccessError(request);
  if (accessError) return accessError;

  try {
    const body = await readObject(request);
    const result = await refreshLogisticsTracking(getD1(), text(body.logisticsOrderId, "物流订单"));
    return Response.json({ ok: true, latest: result.latest });
  } catch (error) {
    return jsonError(error, 502);
  }
}
