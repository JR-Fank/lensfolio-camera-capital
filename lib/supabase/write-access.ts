import type { SupabaseClient } from "@supabase/supabase-js";

// Request headers are not proof of identity. Verify the session on the server.
export async function writeAccessError(supabase: SupabaseClient) {
  const { data, error } = await supabase.auth.getUser();
  if (error || !data.user) {
    return Response.json({ error: "请先登录 Lensfolio。" }, { status: 401 });
  }
  const { data: memberships, error: membershipError } = await supabase
    .from("portfolio_members")
    .select("role")
    .eq("user_id", data.user.id)
    .in("role", ["owner", "editor"])
    .limit(1);
  if (membershipError || !memberships?.length) {
    return Response.json({ error: "当前账户没有写入权限。" }, { status: 403 });
  }
  // Target-portfolio authorization remains enforced by existing RLS/RPC guards.
  return null;
}
