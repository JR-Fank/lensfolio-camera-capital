import type { Metadata } from "next";
import Link from "next/link";
import { getPortfolioAccess } from "../../../lib/supabase/portfolio-access";
import AssetPurchaseForm from "./AssetPurchaseForm";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "新增相机与采购 · Lensfolio",
  description: "原子建立相机资产、采购记录与采购成本。",
};

function hongKongDate() {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Hong_Kong",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date());
  const value = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${value.year}-${value.month}-${value.day}`;
}

export default async function NewAssetPage() {
  const access = await getPortfolioAccess();

  return (
    <main className="asset-entry-page">
      <header className="entry-topbar"><Link className="entry-mark" href="/">LF</Link><Link href="/assets">← 返回资产管理</Link><span>SUPABASE · RLS</span></header>
      <div className="entry-layout">
        <section className="entry-intro">
          <p className="eyebrow">NEW POSITION</p>
          <h1>新增相机<br />与采购成本</h1>
          <p>先记录能解释真实成本的最小事实。市场估值、物流、维修和销售保持独立，稍后再补。</p>
          <dl><div><dt>权限</dt><dd>{access.role.toUpperCase()}</dd></div><div><dt>基础货币</dt><dd>CNY</dd></div><div><dt>记账方式</dt><dd>POSTED</dd></div></dl>
        </section>
        {access.canWrite
          ? <AssetPurchaseForm defaultPurchaseDate={hongKongDate()} />
          : <section className="entry-denied"><p className="eyebrow">VIEWER ACCESS</p><h2>当前账户不能新增资产</h2><p>只有 owner 或 editor 可以写入资产和采购记录。</p><Link href="/assets">返回资产管理</Link></section>}
      </div>
    </main>
  );
}
