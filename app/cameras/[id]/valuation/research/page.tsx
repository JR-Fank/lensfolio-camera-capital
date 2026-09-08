import Link from "next/link";
import { notFound } from "next/navigation";
import { getAssetLocalizedName } from "../../../../../lib/asset-display-names";
import { getPortfolioAccess } from "../../../../../lib/supabase/portfolio-access";
import { normalizeSearchTerms } from "../../../../../lib/valuation/xianyu";
import ValuationResearchIntake from "./ValuationResearchIntake";

export const dynamic = "force-dynamic";

export default async function StartValuationResearchPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const { supabase, canWrite: portfolioCanWrite, portfolioId } = await getPortfolioAccess();
  const { data: asset, error } = await supabase
    .from("assets")
    .select("id,portfolio_id,brand,model,operational_status")
    .eq("id", id)
    .maybeSingle();
  if (error) throw new Error(`Asset query failed: ${error.message}`);
  if (!asset) notFound();
  const { data: completedSale, error: saleError } = await supabase
    .from("sales")
    .select("id")
    .eq("portfolio_id", asset.portfolio_id)
    .eq("asset_id", asset.id)
    .eq("status", "sold")
    .limit(1)
    .maybeSingle();
  if (saleError) throw new Error(`Sale lifecycle query failed: ${saleError.message}`);
  const canWrite = portfolioCanWrite && portfolioId === asset.portfolio_id;
  const sold = asset.operational_status === "sold" || Boolean(completedSale);
  const localizedName = getAssetLocalizedName(asset.brand, asset.model);
  const terms = normalizeSearchTerms(asset);

  return (
    <main className="valuation-research-shell">
      <header className="valuation-research-topbar">
        <Link href={`/cameras/${asset.id}`}>← 返回机器详情</Link>
        <span>XIANYU ASKING PRICE RESEARCH</span>
      </header>
      <section className="valuation-research-waiting">
        <p className="eyebrow">RESEARCH INTAKE</p>
        <h1>{sold ? "已出售资产不再更新估值" : "导入闲鱼研究样本"}</h1>
        <p className="valuation-research-asset">{asset.brand} {asset.model}{localizedName ? ` · ${localizedName}` : ""}</p>
        {sold ? (
          <p>历史估值会继续保留，但不会为已出售资产启动新的 current valuation research。</p>
        ) : (
          <>
            <p>导入只创建待复核研究，不会修改正式估值。所有样本必须经过人工复核，再决定是否采用。</p>
            <div className="valuation-search-terms"><small>建议搜索词</small>{terms.map((term) => <span key={term}>{term}</span>)}</div>
            <p className="asking-price-warning">所有样本必须是闲鱼挂牌价 asking prices，不代表真实成交价。</p>
            <ValuationResearchIntake assetId={asset.id} canWrite={canWrite} defaultSearchTerms={terms} />
          </>
        )}
      </section>
    </main>
  );
}
