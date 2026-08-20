import { getD1 } from "../../../../db";
import { refreshLogisticsTracking } from "../../../../db/tracking";
import { jsonError, readObject, text } from "../../_shared";

export async function POST(request: Request) {
  try {
    const body = await readObject(request);
    const result = await refreshLogisticsTracking(getD1(), text(body.logisticsOrderId, "物流订单"));
    return Response.json({ ok: true, latest: result.latest });
  } catch (error) {
    return jsonError(error, 502);
  }
}
