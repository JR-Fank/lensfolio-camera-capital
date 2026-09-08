import { notFound } from "next/navigation";
import { getPortfolioAccess } from "../../../../../../lib/supabase/portfolio-access";
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
  const { supabase, canWrite: portfolioCanWrite, portfolioId } = await getPortfolioAccess();

  const [run, listings] = await Promise.all([
    getValuationResearchRun(supabase, runId),
    getValuationResearchListings(supabase, runId),
  ]);
  if (!run || run.asset_id !== id) notFound();
  const { data: asset, error: assetError } = await supabase.from("assets").select("id,brand,model").eq("id", id).maybeSingle();
  if (assetError) throw new Error(`Asset query failed: ${assetError.message}`);
  if (!asset) notFound();

  return (
    <ValuationResearchReview
      asset={asset}
      canWrite={portfolioCanWrite && portfolioId === run.portfolio_id}
      initialListings={listings}
      initialRun={run}
    />
  );
}
