import { writeAccessError } from "../../../../lib/supabase/write-access";
import { createClient } from "../../../../lib/supabase/server";
import {
  refreshSupabaseShipmentTracking,
  TrackingSyncError,
} from "../../../../lib/supabase/tracking";

export const runtime = "nodejs";

function isUuid(value: string) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
}

export async function POST(request: Request) {
  try {
    const supabase = await createClient();
    const { data, error } = await supabase.auth.getUser();
    if (error || !data.user) {
      return Response.json({ error: "请先登录 Lensfolio。" }, { status: 401 });
    }

    const accessError = await writeAccessError(supabase);
    if (accessError) return accessError;

    const body = await request.json() as { shipmentId?: unknown };
    const shipmentId = String(body.shipmentId ?? "").trim();
    if (!isUuid(shipmentId)) {
      return Response.json({ error: "物流批次 UUID 格式不正确。" }, { status: 400 });
    }

    const result = await refreshSupabaseShipmentTracking({
      supabase,
      userId: data.user.id,
      shipmentId,
    });

    return Response.json(
      {
        ok: true,
        runId: result.run_id,
        eventsSeen: result.events_seen,
        eventsInserted: result.events_inserted,
        latest: result.latest,
      },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (error) {
    const status = error instanceof TrackingSyncError ? error.status : 500;
    const message = error instanceof Error ? error.message : "物流同步失败";
    return Response.json({ error: message }, { status });
  }
}
