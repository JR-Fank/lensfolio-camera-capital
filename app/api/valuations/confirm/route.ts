import { writeAccessError } from "../../../../lib/supabase/write-access";
import { createClient } from "../../../../lib/supabase/server";
import {
  confirmValuationResearchRun,
  ValuationWorkflowError,
} from "../../../../lib/supabase/valuations";

export const runtime = "nodejs";

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export async function POST(request: Request) {
  try {
    const supabase = await createClient();
    const { data, error } = await supabase.auth.getUser();
    if (error || !data.user) {
      return Response.json({ error: "请先登录 Lensfolio。" }, { status: 401 });
    }
    const accessError = await writeAccessError(supabase);
    if (accessError) return accessError;

    const body = await request.json() as { runId?: unknown };
    const runId = typeof body.runId === "string" ? body.runId.trim() : "";
    if (!uuidPattern.test(runId)) {
      return Response.json({ error: "研究 UUID 格式不正确。" }, { status: 400 });
    }
    const result = await confirmValuationResearchRun(supabase, runId);
    return Response.json({ ok: true, result }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    const status = error instanceof ValuationWorkflowError ? error.status : 500;
    const message = error instanceof Error ? error.message : "确认估值研究失败。";
    return Response.json({ error: message }, { status });
  }
}
