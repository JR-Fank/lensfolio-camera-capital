import { getD1 } from "../../../../db";
import { refreshDueTracking } from "../../../../db/tracking";
import { jsonError, writeAccessError } from "../../_shared";

export async function POST(request: Request) {
  const accessError = writeAccessError(request);
  if (accessError) return accessError;

  try {
    return Response.json({ ok: true, outcomes: await refreshDueTracking(getD1()) });
  } catch (error) {
    return jsonError(error, 502);
  }
}
