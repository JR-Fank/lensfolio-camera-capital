import { getD1 } from "../../../../db";
import { refreshDueTracking } from "../../../../db/tracking";
import { jsonError } from "../../_shared";

export async function POST() {
  try {
    return Response.json({ ok: true, outcomes: await refreshDueTracking(getD1()) });
  } catch (error) {
    return jsonError(error, 502);
  }
}
