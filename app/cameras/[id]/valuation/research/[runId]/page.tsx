import { notFound, redirect } from "next/navigation";
import { createClient } from "../../../../../../lib/supabase/server";
import {
  getValuationResearchListings,
  getValuationResearchRun,
} from "../../../../../../lib/supabase/valuations";
import ValuationResearchReview from "./ValuationResearchReview";

export const dynamic = "force-dynamic";

export default async function ValuationResearchReviewPage({
  params,
}: {
  params: Promise<{ id: string; runId: string }>;
}) {
  const { id, runId } = await params;
  const supabase = await createClient();
  const { data: authData, error: authError } = await supabase.auth.getUser();
  if (authError || !authData.user) redirect("/login");

  const [run, listings] = await Promise.all([
    getValuationResearchRun(supabase, runId),
    getValuationResearchListings(supabase, runId),
  ]);
  if (!run || run.asset_id !== id) notFound();
  const [{ data: asset, error: assetError }, { data: membership, error: membershipError }] = await Promise.all([
    supabase.from("assets").select("id,brand,model").eq("id", id).maybeSingle(),
    supabase.from("portfolio_members").select("role").eq("portfolio_id", run.portfolio_id).eq("user_id", authData.user.id).maybeSingle(),
  ]);
  if (assetError) throw new Error(`Asset query failed: ${assetError.message}`);
  if (membershipError) throw new Error(`Portfolio role query failed: ${membershipError.message}`);
  if (!asset) notFound();

  return (
    <ValuationResearchReview
      asset={asset}
      canWrite={membership?.role === "owner" || membership?.role === "editor"}
      initialListings={listings}
      initialRun={run}
    />
  );
}
