"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { FormEvent, ReactNode, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { AssetView, DashboardData, LogisticsView, SaleView } from "../db/queries";
import { getAssetLocalizedName, getLocalizedNameFromFormalName } from "../lib/asset-display-names";
import { allocateEstimateByWeight, estimateShipmentCost } from "../lib/logistics-benchmark";
import { MIGRATION_PROTECTION_MESSAGE } from "../lib/migration-protection";
import {
  buildModelInventoryPools,
  calculateModelPoolScenario,
  type ModelInventoryPool,
} from "../lib/model-inventory-pools";
import { isJapanPostTrackingNumber } from "../lib/tracking/japan-post";

type Section = "dashboard" | "assets" | "logistics" | "repairs" | "sales" | "buy-decision" | "analysis";
type ModalKind = "asset" | "repair" | "valuation" | "sale" | "logistics" | "expense" | "status" | null;

const nav: Array<{ id: Section; href: string; label: string; index: string }> = [
  { id: "dashboard", href: "/", label: "Dashboard", index: "01" },
  { id: "assets", href: "/assets", label: "资产管理", index: "02" },
  { id: "logistics", href: "/logistics", label: "物流中心", index: "03" },
  { id: "repairs", href: "/repairs", label: "维修中心", index: "04" },
  { id: "sales", href: "/sales", label: "销售记录", index: "05" },
  { id: "buy-decision", href: "/buy-decision", label: "买入决策", index: "06" },
  { id: "analysis", href: "/analysis", label: "投资分析", index: "07" },
];

const sectionCopy: Record<Section, { eyebrow: string; title: string; description: string }> = {
  dashboard: { eyebrow: "PORTFOLIO COMMAND", title: "投资组合", description: "用真实成本与退出价格管理每一台相机，而不是只记录买入价。" },
  assets: { eyebrow: "POSITION BOOK", title: "资产管理", description: "采购、物流、维修与估值汇总到单机真实成本。" },
  logistics: { eyebrow: "MOVEMENT CONTROL", title: "物流中心", description: "批次、成本与日本邮政公开轨迹集中管理。" },
  repairs: { eyebrow: "CONDITION DESK", title: "维修中心", description: "每一笔检测与维修费用都会进入该机器的成本基数。" },
  sales: { eyebrow: "EXIT LEDGER", title: "销售记录", description: "只记录已经发生的退出交易、净回款与已实现收益。" },
  "buy-decision": { eyebrow: "ENTRY UNDERWRITING", title: "买入决策", description: "从市场中位价反推最高买入价，把目标回报写在报价之前。" },
  analysis: { eyebrow: "PORTFOLIO ANALYTICS", title: "投资分析", description: "把持仓浮盈与已实现收益分开，再汇总为完整组合表现。" },
};

const BUSINESS_TIME_ZONE = "Asia/Hong_Kong";
const cny = (value: number, digits = 0) => new Intl.NumberFormat("zh-CN", {
  style: "currency", currency: "CNY", maximumFractionDigits: digits,
}).format(value);
const nullableCny = (value: number | null, missing = "—") => value === null ? missing : cny(value);
const jpy = (value: number) => `¥${new Intl.NumberFormat("ja-JP", { maximumFractionDigits: 0 }).format(value)}`;
const number = (value: number, digits = 1) => new Intl.NumberFormat("zh-CN", { maximumFractionDigits: digits }).format(value);
const grams = (value: number | null) => value !== null && value > 0 ? `${number(value)} g` : "—";
const kilograms = (value: number | null) => value !== null && value > 0 ? `${number(value / 1000, 3)} kg` : "—";
const signed = (value: number | null) => value === null ? "—" : `${value >= 0 ? "+" : "−"}${cny(Math.abs(value))}`;
const signedMoney = (value: number | null, digits = 2) => value === null ? "—" : `${value >= 0 ? "+" : "−"}${cny(Math.abs(value), digits)}`;
const pct = (value: number | null) => value === null ? "—" : `${value >= 0 ? "+" : ""}${value.toFixed(1)}%`;
const precisePct = (value: number | null) => value === null ? "—" : `${value >= 0 ? "+" : ""}${value.toFixed(2)}%`;
const performanceClass = (value: number | null) => value === null ? "" : value >= 0 ? "gain" : "loss";
const sampleCount = (value: number | null) => value === null ? "样本未记录" : `${value} 条`;
const date = (value: string | null) => value
  ? new Intl.DateTimeFormat("zh-CN", { month: "2-digit", day: "2-digit", hour: value.includes(":") ? "2-digit" : undefined, minute: value.includes(":") ? "2-digit" : undefined, timeZone: BUSINESS_TIME_ZONE }).format(new Date(value.replace(" ", "T") + (value.includes("T") ? "" : "+08:00")))
  : "—";
const refreshedTime = (value: string) => new Intl.DateTimeFormat("zh-CN", {
  hour: "2-digit", minute: "2-digit", timeZone: BUSINESS_TIME_ZONE,
}).format(new Date(value));
const calendarDate = (value: string | null) => value
  ? new Intl.DateTimeFormat("zh-CN", { year: "numeric", month: "2-digit", day: "2-digit", timeZone: BUSINESS_TIME_ZONE }).format(new Date(value))
  : "—";
const today = () => new Date().toISOString().slice(0, 10);
const fullName = (asset: AssetView) => `${asset.brand} ${asset.model}${asset.variant ? ` ${asset.variant}` : ""}`;

export default function ManagementApp({
  initialData,
  section = "dashboard",
  selectedAssetId,
  canCreateAsset = false,
  canRefreshTracking = false,
}: {
  initialData: DashboardData;
  section?: Section;
  selectedAssetId?: string;
  canCreateAsset?: boolean;
  canRefreshTracking?: boolean;
}) {
  const router = useRouter();
  const [dataOverride, setData] = useState<DashboardData | null>(null);
  const data = dataOverride ?? initialData;
  const [modal, setModal] = useState<ModalKind>(null);
  const [cameraId, setCameraId] = useState(selectedAssetId ?? initialData.assets[0]?.id ?? "");
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState("");
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);
  const mobileCloseButtonRef = useRef<HTMLButtonElement>(null);
  const mobileMenuButtonRef = useRef<HTMLButtonElement>(null);
  const migrationReadOnly = data.migrationReadOnly;
  const selectedAsset = selectedAssetId ? data.assets.find((asset) => asset.id === selectedAssetId) : undefined;

  const reload = async () => {
    const response = await fetch("/api/dashboard", { cache: "no-store" });
    if (!response.ok) throw new Error("数据刷新失败");
    setData(await response.json() as DashboardData);
  };

  useEffect(() => {
    if (!modal) return;
    const close = (event: KeyboardEvent) => event.key === "Escape" && setModal(null);
    window.addEventListener("keydown", close);
    return () => window.removeEventListener("keydown", close);
  }, [modal]);

  useEffect(() => {
    if (!mobileMenuOpen) return;
    const previousBodyOverflow = document.body.style.overflow;
    const previousHtmlOverflow = document.documentElement.style.overflow;
    const close = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      setMobileMenuOpen(false);
      mobileMenuButtonRef.current?.focus();
    };
    document.body.style.overflow = "hidden";
    document.documentElement.style.overflow = "hidden";
    mobileCloseButtonRef.current?.focus();
    window.addEventListener("keydown", close);
    return () => {
      document.body.style.overflow = previousBodyOverflow;
      document.documentElement.style.overflow = previousHtmlOverflow;
      window.removeEventListener("keydown", close);
    };
  }, [mobileMenuOpen]);

  const closeMobileMenu = (restoreFocus = false) => {
    setMobileMenuOpen(false);
    if (restoreFocus) window.requestAnimationFrame(() => mobileMenuButtonRef.current?.focus());
  };

  const open = (kind: Exclude<ModalKind, null>, id?: string) => {
    if (migrationReadOnly) return;
    if (id) setCameraId(id);
    setNotice("");
    setModal(kind);
  };

  const submit = async (endpoint: string, event: FormEvent<HTMLFormElement>, method = "POST") => {
    event.preventDefault();
    if (migrationReadOnly) {
      setNotice(MIGRATION_PROTECTION_MESSAGE);
      return;
    }
    setBusy(true);
    setNotice("");
    const form = new FormData(event.currentTarget);
    const payload: Record<string, FormDataEntryValue | FormDataEntryValue[]> = Object.fromEntries(form.entries());
    if (form.has("cameraIds")) payload.cameraIds = form.getAll("cameraIds");
    try {
      const response = await fetch(endpoint, {
        method,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      const result = await response.json() as { error?: string };
      if (!response.ok) throw new Error(result.error || "保存失败");
      await reload();
      setModal(null);
      setNotice("已写入投资台账");
      window.setTimeout(() => setNotice(""), 3200);
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "保存失败");
    } finally {
      setBusy(false);
    }
  };

  const refreshTracking = async (order: LogisticsView) => {
    if (!canRefreshTracking) {
      setNotice("当前账户没有物流写入权限");
      return;
    }
    setBusy(true);
    setNotice(`正在查询 ${order.trackingNumber}…`);
    try {
      const response = await fetch("/api/logistics/refresh", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ shipmentId: order.id }),
      });
      const result = await response.json() as { error?: string };
      if (!response.ok) throw new Error(result.error || "查询失败");
      router.refresh();
      setNotice("日本邮政轨迹已同步");
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "物流查询失败");
    } finally {
      setBusy(false);
    }
  };

  const page = selectedAsset
    ? <AssetDetail asset={selectedAsset} data={data} open={open} />
    : section === "dashboard" ? <DashboardView data={data} open={open} />
      : section === "assets" ? <AssetsView data={data} canCreateAsset={canCreateAsset} open={open} />
        : section === "logistics" ? <LogisticsViewPage data={data} open={open} refreshTracking={refreshTracking} busy={busy} canRefreshTracking={canRefreshTracking} />
          : section === "repairs" ? <RepairsView data={data} open={open} />
            : section === "sales" ? <SalesView data={data} open={open} />
              : section === "buy-decision" ? <BuyDecisionView />
                : <AnalysisView data={data} />;

  const selectedAssetLocalizedName = selectedAsset ? getAssetLocalizedName(selectedAsset.brand, selectedAsset.model) : null;
  const copy = selectedAsset
    ? { eyebrow: "ASSET FILE", title: fullName(selectedAsset), description: `${selectedAssetLocalizedName ? `${selectedAssetLocalizedName} · ` : ""}单机真实成本、市场区间、维修与退出回报。` }
    : sectionCopy[section];

  const mobileNavigation = mobileMenuOpen && typeof document !== "undefined"
    ? createPortal(
      <div className="mobile-navigation-layer">
        <button className="mobile-nav-backdrop" type="button" aria-label="关闭主导航" onClick={() => closeMobileMenu(true)} />
        <aside className="mobile-nav-drawer" id="mobile-main-navigation" role="dialog" aria-modal="true" aria-label="Lensfolio 主导航">
          <header><div><small>PRIVATE PORTFOLIO</small><strong>Lensfolio</strong></div><button ref={mobileCloseButtonRef} className="mobile-nav-close" type="button" aria-label="关闭主导航" onClick={() => closeMobileMenu(true)}>×</button></header>
          <nav aria-label="移动端系统导航">
            {nav.map((item) => <Link aria-current={section === item.id ? "page" : undefined} className={section === item.id ? "active" : ""} href={item.href} key={item.id} onClick={() => closeMobileMenu()}><small>{item.index}</small><span>{item.label}</span>{section === item.id && <i>当前</i>}</Link>)}
          </nav>
          <footer><i /><span>SUPABASE · RLS PROTECTED</span></footer>
        </aside>
      </div>,
      document.body,
    )
    : null;

  return (
    <>
      <div className="app-shell">
      <aside className="side-rail">
        <Link className="system-mark" href="/" aria-label="Lensfolio 首页">
          <span>LF</span><b>LENSFOLIO</b><small>CAMERA INVESTMENT SYSTEM</small>
        </Link>
        <nav aria-label="系统导航">
          {nav.map((item) => (
            <Link aria-current={section === item.id ? "page" : undefined} className={section === item.id ? "active" : ""} href={item.href} key={item.id}>
              <small>{item.index}</small><span>{item.label}</span><i>↗</i>
            </Link>
          ))}
        </nav>
        <div className="rail-status">
          <i /><span>{data.dataSource === "supabase" ? "DATABASE ONLINE" : migrationReadOnly ? "MIGRATION PROTECTION" : "DATABASE ONLINE"}</span>
          <small>{data.dataSource === "supabase" ? "SUPABASE · RLS PROTECTED" : migrationReadOnly ? "READ ONLY · D1 FROZEN" : "D1 · 持久化存储"}</small>
        </div>
      </aside>

      <main className="workspace">
        <header className="mobile-bar">
          <Link href="/" className="mini-mark">LF</Link><span>{copy.title}</span>
          <div className="mobile-header-actions">
            {section === "assets" && !selectedAsset && canCreateAsset && <Link className="mobile-add" href="/assets/new" aria-label="新增相机">＋</Link>}
            <button ref={mobileMenuButtonRef} className="mobile-menu-trigger" type="button" aria-label="打开主导航" aria-expanded={mobileMenuOpen} aria-controls="mobile-main-navigation" onClick={() => setMobileMenuOpen(true)}>
              <svg aria-hidden="true" viewBox="0 0 24 24"><path d="M4 6h16M4 12h16M4 18h16" /></svg>
            </button>
          </div>
        </header>
        <header className="page-head">
          <div>
            <p className="eyebrow">{copy.eyebrow}</p>
            <h1>{copy.title}</h1>
            <p>{copy.description}</p>
          </div>
          <div className="head-meta">
            <span><i /> {data.dataSource === "supabase" ? "SUPABASE ONLINE" : migrationReadOnly ? "READ ONLY" : "LIVE LEDGER"}</span>
            <small>刷新于 {refreshedTime(data.refreshedAt)}</small>
          </div>
        </header>
        {migrationReadOnly && data.dataSource !== "supabase" && <div className="migration-banner" role="status"><strong>Migration Protection Mode</strong><span>{MIGRATION_PROTECTION_MESSAGE}</span></div>}
        {notice && <div className={`notice ${notice.includes("失败") || notice.includes("请") ? "error" : ""}`} role="status">{notice}</div>}
        {page}
        <footer className="system-footer">
          <span>Lensfolio / Camera Investment Management System</span>
          <span>金额单位 CNY · 日元采购另行标注 · 私人台账</span>
        </footer>
      </main>

      {modal && !migrationReadOnly && (
        <div className="modal-layer" role="presentation" onMouseDown={(event) => event.target === event.currentTarget && setModal(null)}>
          <div className="record-modal" role="dialog" aria-modal="true" aria-label="新增记录">
            <button className="modal-close" type="button" onClick={() => setModal(null)} aria-label="关闭">×</button>
            {modal === "asset" && <AssetForm onSubmit={(event) => submit("/api/cameras", event)} busy={busy} />}
            {modal === "repair" && <RepairForm assets={data.assets} cameraId={cameraId} onSubmit={(event) => submit("/api/repairs", event)} busy={busy} />}
            {modal === "valuation" && <ValuationForm assets={data.assets} cameraId={cameraId} onSubmit={(event) => submit("/api/valuations", event)} busy={busy} />}
            {modal === "sale" && <SaleForm assets={data.assets} cameraId={cameraId} onSubmit={(event) => submit("/api/sales", event)} busy={busy} />}
            {modal === "logistics" && <LogisticsForm assets={data.assets} onSubmit={(event) => submit("/api/logistics", event)} busy={busy} />}
            {modal === "expense" && <ExpenseForm assets={data.assets} cameraId={cameraId} onSubmit={(event) => submit("/api/expenses", event)} busy={busy} />}
            {modal === "status" && <StatusForm assets={data.assets} cameraId={cameraId} onSubmit={(event) => submit("/api/cameras", event, "PATCH")} busy={busy} />}
            {notice && <p className="form-error" role="alert">{notice}</p>}
          </div>
        </div>
      )}
      </div>
      {mobileNavigation}
    </>
  );
}

function DashboardView({ data, open }: { data: DashboardData; open: (kind: Exclude<ModalKind, null>, id?: string) => void }) {
  const { summary } = data;
  const active = data.assets.filter((asset) => asset.lifecycleStatus !== "已出售");
  const valuedActive = active.filter((asset) => asset.normalProfit !== null && asset.roi !== null);
  const highestProfit = [...valuedActive].sort((a, b) => (b.normalProfit ?? 0) - (a.normalProfit ?? 0))[0];
  const highestRoi = [...valuedActive].sort((a, b) => (b.roi ?? 0) - (a.roi ?? 0))[0];
  const riskScore = (asset: AssetView) => asset.marketMedianCny === null
    ? Number.POSITIVE_INFINITY
    : (1 - asset.valuationConfidence) * 100 - (asset.roi ?? 0);
  const highestRisk = [...active].sort((a, b) => riskScore(b) - riskScore(a))[0];
  const largest = [...active].sort((a, b) => b.trueCost - a.trueCost)[0];
  const partialCoverage = !summary.valuationCoverageComplete;
  return (
    <>
      <section className="metric-ledger" aria-label="投资核心指标">
        <Metric label="实际已投入" value={cny(summary.totalInvested)} note={`已付物流 ${cny(summary.logisticsCost - summary.estimatedLogisticsCost)} · 不含待付`} tone="ink" />
        <Metric label={partialCoverage ? "已估值资产估值" : "当前市场估值"} value={nullableCny(summary.currentMarketValue, "未估值")} note={`持仓估值覆盖 ${summary.valuedAssetCount} / ${summary.heldAssetCount}`} tone="acid" />
        <Metric label={partialCoverage ? "已估值资产浮盈" : "浮盈金额"} value={signed(summary.unrealizedProfit)} note={`${partialCoverage ? "已估值资产" : "投资"} ROI ${pct(summary.roi)} · 成本 ${nullableCny(summary.valuedAssetCarryingCost)}`} tone={summary.unrealizedProfit === null ? undefined : summary.unrealizedProfit >= 0 ? "positive" : "negative"} />
        <Metric label="当前资产数量" value={`${summary.assetCount} 台`} note={`预计完全落地成本 ${cny(summary.projectedCostBasis)}`} />
        <Metric label="平均持有周期" value={`${number(summary.averageHoldingDays, 0)} 天`} note="从采购日期计算" compact />
        <Metric label="物流总成本" value={cny(summary.logisticsCost)} note={`其中预算 ${cny(summary.estimatedLogisticsCost)}`} compact />
        <Metric label="维修总成本" value={cny(summary.repairCost)} note={`${data.repairs.length} 条维修记录`} compact />
        <Metric label="已实现利润" value={signed(summary.realizedProfit)} note={`${data.sales.filter((sale) => sale.status === "已出售").length} 台已成交`} compact />
      </section>

      <section className="investor-ranking" aria-label="组合排行">
        <article><small>最高利润</small><strong>{highestProfit?.model ?? "—"}</strong><b className={performanceClass(highestProfit?.normalProfit ?? null)}>{highestProfit ? signed(highestProfit.normalProfit) : "—"}</b></article>
        <article><small>最高 ROI</small><strong>{highestRoi?.model ?? "—"}</strong><b className={performanceClass(highestRoi?.roi ?? null)}>{highestRoi ? pct(highestRoi.roi) : "—"}</b></article>
        <article><small>最高风险</small><strong>{highestRisk?.model ?? "—"}</strong><b>{highestRisk ? `${Math.round(highestRisk.valuationConfidence * 5)} / 5 可信` : "—"}</b></article>
        <article><small>最大资金占用</small><strong>{largest?.model ?? "—"}</strong><b>{largest ? cny(largest.trueCost) : "—"}</b></article>
      </section>

      <PortfolioCharts data={data} />

      <section className="daily-brief">
        <div><p className="eyebrow">DAILY ANSWERS</p><h2>今天该关注什么</h2></div>
        <ol className="decision-list">
          <li><b>01</b><span><strong>先处理最大仓位 {largest?.model ?? "—"}</strong><small>{largest?.repairStatus === "未检测" ? "尚未检测，真实退出价值仍有不确定性。" : `当前估值可信度 ${Math.round((largest?.valuationConfidence ?? 0) * 100)}%。`}</small></span></li>
          <li><b>02</b><span><strong>{highestRisk?.model ?? "资产"} 是当前风险位</strong><small>估值可信度、维修状态与安全边际共同决定风险排序。</small></span></li>
          <li><b>03</b><span><strong>下一笔报价先过买入决策</strong><small><Link href="/buy-decision">按目标回报反推最高买入价 →</Link></small></span></li>
        </ol>
      </section>

      <SectionTitle kicker="POSITION MONITOR" title="核心仓位" action={!data.migrationReadOnly ? <button className="text-action" type="button" onClick={() => open("asset")}>＋ 新增机器</button> : undefined} />
      <div className="asset-card-grid">
        {data.assets.slice(0, 3).map((asset) => <InvestmentCard asset={asset} sale={data.sales.find((record) => record.cameraId === asset.id)} open={open} readOnly={data.migrationReadOnly} key={asset.id} />)}
      </div>
      <div className="view-all"><Link href="/assets">查看全部 {data.assets.length} 台资产 →</Link></div>
    </>
  );
}

function PortfolioCharts({ data }: { data: DashboardData }) {
  const active = data.assets.filter((asset) => asset.lifecycleStatus !== "已出售");
  const valuedActive = active.filter((asset) => asset.roi !== null);
  const capitalTotal = active.reduce((sum, asset) => sum + asset.trueCost, 0) || 1;
  const roiScale = Math.max(1, ...valuedActive.map((asset) => Math.abs(asset.roi ?? 0)));
  const logisticsMax = Math.max(1, ...data.logistics.map((order) => order.shippingCny));
  const repairMax = Math.max(1, ...data.repairs.map((repair) => repair.costCny));
  const valuationByDate = new Map<string, number>();
  for (const valuation of data.valuationHistory) {
    valuationByDate.set(valuation.valuedAt, (valuationByDate.get(valuation.valuedAt) ?? 0) + valuation.medianCny);
  }
  const valuationTrend = [...valuationByDate].sort(([a], [b]) => a.localeCompare(b));
  const valuationMax = Math.max(1, ...valuationTrend.map(([, value]) => value));

  return (
    <section className="portfolio-visuals" aria-label="投资组合分析">
      <article className="chart-card capital-chart">
        <ChartHead label="CAPITAL SHARE" title="资金占比分布" note="按单机真实成本" />
        <div className="capital-stack" aria-label="资产成本占比">
          {active.map((asset, index) => <i key={asset.id} style={{ width: `${asset.trueCost / capitalTotal * 100}%`, background: `var(--chart-${index % 6})` }} title={`${asset.model} ${cny(asset.trueCost)}`} />)}
        </div>
        <div className="capital-legend">{[...active].sort((a, b) => b.trueCost - a.trueCost).map((asset) => <span key={asset.id}><i style={{ background: `var(--chart-${active.indexOf(asset) % 6})` }} /><b>{asset.model}</b><small>{number(asset.trueCost / capitalTotal * 100, 1)}%</small></span>)}</div>
      </article>

      <article className="chart-card roi-chart">
        <ChartHead label="RETURN RANK" title="ROI 排行" note={`仅含已估值资产 ${valuedActive.length} / ${active.length}`} />
        <div className="rank-bars">{[...valuedActive].sort((a, b) => (b.roi ?? 0) - (a.roi ?? 0)).map((asset) => {
          const roi = asset.roi ?? 0;
          const width = Math.max(2, Math.abs(roi) / roiScale * 48);
          return <div key={asset.id}><b>{asset.model}</b><span className="signed-track"><i className={roi >= 0 ? "profit-bar" : "loss-bar"} style={roi >= 0 ? { left: "50%", width: `${width}%` } : { left: `${50 - width}%`, width: `${width}%` }} /></span><em className={performanceClass(asset.roi)}>{pct(asset.roi)}</em></div>;
        })}</div>
      </article>

      <article className="chart-card valuation-trend">
        <ChartHead label="MARK TO MARKET" title="市场价格趋势" note={valuationTrend.length < 2 ? "当前只有一个估值日期" : "组合市场中位价"} />
        <div className="trend-bars">{valuationTrend.map(([day, value]) => <div key={day}><span><i style={{ height: `${Math.max(8, value / valuationMax * 100)}%` }} /></span><b>{cny(value)}</b><small>{day.slice(5)}</small></div>)}</div>
        {valuationTrend.length < 2 && <p className="chart-empty">再录入一个日期的市场估价后，系统才会形成真实趋势；当前不补造历史。</p>}
      </article>

      <article className="chart-card cost-trend">
        <ChartHead label="LOGISTICS COST" title="物流成本趋势" note="按批次实际与预算" />
        <div className="mini-cost-bars">{data.logistics.map((order) => <div key={order.id}><span><i style={{ width: `${order.shippingCny / logisticsMax * 100}%` }} /></span><b>{order.batchCode}</b><small>{cny(order.shippingCny)}{order.isEstimated ? " 预算" : ""}</small></div>)}</div>
      </article>

      <article className="chart-card cost-trend">
        <ChartHead label="REPAIR COST" title="维修成本趋势" note="按发生日期" />
        {data.repairs.length ? <div className="mini-cost-bars repair-bars">{data.repairs.slice(0, 8).map((repair) => <div key={repair.id}><span><i style={{ width: `${repair.costCny / repairMax * 100}%` }} /></span><b>{repair.repairDate.slice(5)}</b><small>{repair.cameraName} · {cny(repair.costCny)}</small></div>)}</div> : <p className="chart-empty strong-empty">尚无维修支出。新增记录后，这里会按日期形成成本轨迹。</p>}
      </article>
    </section>
  );
}

function ChartHead({ label, title, note }: { label: string; title: string; note: string }) {
  return <header className="chart-head"><div><p>{label}</p><h3>{title}</h3></div><span>{note}</span></header>;
}

function AssetsView({ data, canCreateAsset, open }: { data: DashboardData; canCreateAsset: boolean; open: (kind: Exclude<ModalKind, null>, id?: string) => void }) {
  return (
    <>
      <div className="toolbar-row">
        <div className="position-summary"><span>持有中 <b>{data.assets.filter((asset) => asset.lifecycleStatus !== "已出售").length}</b></span><span>待检测 <b>{data.assets.filter((asset) => asset.repairStatus === "未检测").length}</b></span><span>可出售 <b>{data.assets.filter((asset) => asset.lifecycleStatus === "可出售").length}</b></span></div>
        {canCreateAsset && <Link className="primary-action" href="/assets/new">＋ 新增相机</Link>}
      </div>
      <ModelInventoryPools assets={data.assets} mode="assets" />
      <div className="asset-card-grid wide">
        {data.assets.map((asset) => <InvestmentCard asset={asset} sale={data.sales.find((record) => record.cameraId === asset.id)} open={open} readOnly={data.migrationReadOnly} key={asset.id} />)}
      </div>
    </>
  );
}

type ModelPoolSort = "advantage" | "capital" | "profit" | "units";

function ModelInventoryPools({ assets, mode }: { assets: AssetView[]; mode: "assets" | "analysis" }) {
  const pools = buildModelInventoryPools(assets);
  const [sortBy, setSortBy] = useState<ModelPoolSort>("advantage");
  if (!pools.length) return null;
  const sortedPools = [...pools].sort((a, b) => modelPoolSortValue(b, sortBy) - modelPoolSortValue(a, sortBy));
  return (
    <section className={`model-pool-section ${mode}`}>
      <header>
        <div><h2>同型号持仓</h2><span>聚合同型号持仓的成本与定价空间，单机真实成本保持独立。</span></div>
        {mode === "analysis" && <label className="model-pool-sort"><span>排序方式</span><select value={sortBy} onChange={(event) => setSortBy(event.target.value as ModelPoolSort)}><option value="advantage">混合成本优势</option><option value="capital">资金占用</option><option value="profit">市场中位预测利润</option><option value="units">持有数量</option></select></label>}
      </header>
      <div className="model-pool-list">{sortedPools.map((pool) => <ModelPoolCard key={pool.key} pool={pool} />)}</div>
    </section>
  );
}

function ModelPoolCard({ pool }: { pool: ModelInventoryPool }) {
  const [expanded, setExpanded] = useState(false);
  const [averageSalePrice, setAverageSalePrice] = useState(Math.round(pool.latestModelMarketMedian ?? pool.averageCarryingCost));
  const [sellingFeePerUnit, setSellingFeePerUnit] = useState(0);
  const [targetRoi, setTargetRoi] = useState(20);
  const potential = calculateModelPoolScenario(pool.totalCarryingCost, pool.heldUnits, averageSalePrice, sellingFeePerUnit, targetRoi);
  const confirmed = calculateModelPoolScenario(pool.confirmedCarryingCost, pool.confirmedUnits, averageSalePrice, sellingFeePerUnit, targetRoi);
  const localizedName = getAssetLocalizedName(pool.brand, pool.model);
  return (
    <article className={`model-pool-card${expanded ? " is-expanded" : ""}`}>
      <header className="model-pool-card-head">
        <div className="model-pool-identity"><span>{pool.brand}</span><h3>{pool.model}</h3>{localizedName && <small>{localizedName}</small>}</div>
        <div className="model-pool-counts"><b>{pool.heldUnits} 台持有</b><span>{pool.confirmedUnits} 台已确认</span>{pool.riskUnits > 0 && <span className="risk">{pool.riskUnits} 台未检测</span>}</div>
      </header>
      <dl className="model-pool-metrics">
        <div><dt>总持仓成本</dt><dd>{cny(pool.totalCarryingCost, 2)}</dd></div>
        <div><dt>潜在平均成本</dt><dd>{cny(pool.averageCarryingCost, 2)}</dd></div>
        <div><dt>单机成本区间</dt><dd>{cny(pool.minimumCarryingCost, 2)}–{cny(pool.maximumCarryingCost, 2)}</dd></div>
        <div><dt>市场中位价</dt><dd>{nullableCny(pool.latestModelMarketMedian, "未估值")}</dd></div>
      </dl>
      <div className="model-pool-economics">
        <span><small>已确认成本</small><b>{pool.confirmedAverageCarryingCost === null ? "暂无确认库存" : `${cny(pool.confirmedAverageCarryingCost, 2)} / 台`}</b><em>{pool.confirmedUnits} 台功能正常 / 可销售</em></span>
        <span className={pool.riskUnits > 0 ? "potential-risk" : ""}><small>潜在成本</small><b>{cny(pool.averageCarryingCost, 2)} / 台</b><em>{pool.heldUnits} 台{pool.riskUnits > 0 ? ` · 含 ${pool.riskUnits} 台未检测` : " · 全部已确认"}</em></span>
        <small className="model-pool-coverage">估值覆盖 {pool.valuedUnits} / {pool.heldUnits}</small>
      </div>
      <div className="model-pool-disclosure">
        <div><b>定价测算</b><span>平均成交价 {cny(averageSalePrice)} · Pool Profit <strong className={performanceClass(potential.totalPoolProfit)}>{signedMoney(potential.totalPoolProfit)}</strong> · ROI <strong className={performanceClass(potential.poolRoi)}>{precisePct(potential.poolRoi)}</strong></span></div>
        <button type="button" aria-expanded={expanded} onClick={() => setExpanded((value) => !value)}>{expanded ? "收起" : "展开"}<span aria-hidden="true">{expanded ? "↑" : "↓"}</span></button>
      </div>
      {expanded && <div className="model-pool-scenario">
        <div className="model-pool-controls">
          <NumberControl label="预计平均成交价" value={averageSalePrice} setValue={setAverageSalePrice} prefix="¥" />
          <NumberControl label="单台销售费用" value={sellingFeePerUnit} setValue={setSellingFeePerUnit} prefix="¥" />
          <NumberControl label="目标 ROI" value={targetRoi} setValue={setTargetRoi} suffix="%" />
        </div>
        <div className="model-pool-results">
          <span><small>预计净回款总额</small><b>{cny(potential.totalExpectedProceeds, 2)}</b></span>
          <span><small>型号池预计利润</small><b className={performanceClass(potential.totalPoolProfit)}>{signedMoney(potential.totalPoolProfit)}</b></span>
          <span><small>型号池 ROI</small><b className={performanceClass(potential.poolRoi)}>{precisePct(potential.poolRoi)}</b></span>
          <span><small>{number(targetRoi, 1)}% ROI 最低平均成交价</small><b>{cny(potential.requiredAverageSalePrice, 2)}</b></span>
        </div>
        <div className="model-pool-thresholds">
          <span>平均保本价 <b>{cny(potential.averageBreakEvenPrice, 2)}</b></span>
          <span>平均单机利润 <b className={performanceClass(potential.averageProfitPerUnit)}>{signedMoney(potential.averageProfitPerUnit)}</b></span>
          <span>已确认池保本价 <b>{pool.confirmedUnits ? cny(confirmed.averageBreakEvenPrice, 2) : "—"}</b></span>
        </div>
        {pool.blendedCostAdvantage !== null && pool.blendedCostAdvantage > 0 && potential.totalPoolProfit > 0 && <p className="model-pool-insight">即使高成本单机利润较低，型号成本池整体仍有利润空间；单机真实成本与实际盈亏保持独立。</p>}
      </div>}
    </article>
  );
}

function modelPoolSortValue(pool: ModelInventoryPool, sortBy: ModelPoolSort) {
  if (sortBy === "capital") return pool.totalCarryingCost;
  if (sortBy === "units") return pool.heldUnits;
  if (sortBy === "profit") {
    const salePrice = pool.latestModelMarketMedian ?? pool.averageCarryingCost;
    return calculateModelPoolScenario(pool.totalCarryingCost, pool.heldUnits, salePrice, 0, 0).totalPoolProfit;
  }
  return pool.blendedCostAdvantage ?? Number.NEGATIVE_INFINITY;
}

function InvestmentCard({ asset, sale, open, readOnly }: { asset: AssetView; sale?: SaleView; open: (kind: Exclude<ModalKind, null>, id?: string) => void; readOnly: boolean }) {
  const [expanded, setExpanded] = useState(false);
  const normalRoi = asset.roi;
  const isSold = asset.lifecycleStatus === "已出售";
  const hasValuation = asset.marketMedianCny !== null;
  const pendingShipping = asset.pendingShippingCny ?? 0;
  const confidence = Math.max(0, Math.min(5, Math.round(asset.valuationConfidence * 5)));
  const localizedName = getAssetLocalizedName(asset.brand, asset.model);
  const valuationSource = asset.valuationSource.includes("闲鱼") ? "闲鱼挂牌价" : asset.valuationSource;
  return (
    <article className={`investment-card compact${isSold ? " sold-card" : ""}${hasValuation ? "" : " unvalued-card"}${expanded ? " is-expanded" : ""}`}>
      <header>
        <div><p>{asset.brand.toUpperCase()}</p><h3>{asset.model}</h3>{localizedName && <small className="asset-localized-name">{localizedName}</small>}{asset.variant && <small>{asset.variant}</small>}</div>
        <div className="asset-card-badges">{asset.conditionGrade && <span className="asset-condition">{asset.conditionGrade}</span>}<span className={`asset-status${isSold ? " sold" : ""}`}><i className={`status-dot ${asset.repairStatus === "待维修" ? "warn" : ""}`} />{isSold ? "已出售" : asset.repairStatus}</span></div>
      </header>
      <dl className="asset-card-metrics">
        <div><dt>真实成本</dt><dd>{cny(asset.trueCost)}</dd></div>
        <div><dt>{isSold ? "净回款" : "当前估值"}</dt><dd>{isSold ? nullableCny(sale?.netProceedsCny ?? null) : nullableCny(asset.expectedSaleCny)}</dd></div>
        <div><dt>{isSold ? "已实现利润" : "未实现利润"}</dt><dd className={performanceClass(isSold ? sale?.finalProfit ?? null : asset.normalProfit)}>{signed(isSold ? sale?.finalProfit ?? null : asset.normalProfit)}</dd></div>
        <div><dt>{isSold ? "已实现 ROI" : "ROI"}</dt><dd className={performanceClass(isSold ? sale?.realizedRoi ?? null : normalRoi)}>{pct(isSold ? sale?.realizedRoi ?? null : normalRoi)}</dd></div>
      </dl>
      <div className="asset-cost-summary">
        <span>采购 {cny(asset.purchaseCny)}</span><span>国际物流 {cny(asset.internationalShippingCny)}</span><span className={asset.repairCny > 0 ? "has-extra-cost" : ""}>维修 {cny(asset.repairCny)}</span><span className={asset.otherCostCny > 0 ? "has-extra-cost" : ""}>其他 {cny(asset.otherCostCny)}</span>{pendingShipping > 0 && <span className="pending-cost">待付物流 {cny(pendingShipping)} 预算</span>}
      </div>
      {isSold ? <div className="asset-sale-summary"><span>成交 {calendarDate(sale?.soldAt ?? null)}</span><span>{sale?.platform ?? "未记录平台"}</span><span>净回款 {nullableCny(sale?.netProceedsCny ?? null)}</span></div> : <div className={`asset-valuation-summary${hasValuation ? "" : " unvalued"}`}><span>估值区间 <b>{hasValuation ? `${nullableCny(asset.marketLowCny)}–${nullableCny(asset.marketHighCny)}` : "—"}</b></span><small>{asset.valuationDate ? `${valuationSource} · ${sampleCount(asset.valuationSampleSize)} · ${"★".repeat(confidence)}${"☆".repeat(5 - confidence)}` : "待录入估价"}</small></div>}
      {expanded && <div className="asset-card-expanded">
        <div className="card-split">
          <div className="cost-ledger">
            <p className="micro-title">真实成本 / COST BASIS</p>
            <div className="true-cost"><span>实际已投入成本</span><strong>{cny(asset.trueCost)}</strong></div>
            <LedgerRow label="采购人民币实付" value={cny(asset.purchaseCny)} />
            <LedgerRow label="已付国际物流" value={cny(asset.internationalShippingCny)} />
            {pendingShipping > 0 && <LedgerRow label="待付国际物流" value={`${cny(pendingShipping)} 预算`} />}
            <LedgerRow label="维修费用" value={cny(asset.repairCny)} />
            <LedgerRow label="其他费用" value={cny(asset.otherCostCny)} />
            {pendingShipping > 0 && <LedgerRow label="预计完全落地" value={cny(asset.trueCost + pendingShipping)} total />}
            <details className="procurement-detail"><summary>展开日元采购明细</summary><div><LedgerRow label="日本购买价格" value={jpy(asset.purchaseJpy)} /><LedgerRow label="日元汇率" value={asset.exchangeRate.toFixed(4)} /><LedgerRow label="订单日本境内运费" value={jpy(asset.domesticShippingJpy)} /></div></details>
          </div>
          {isSold ? <div className="market-ledger realized-ledger">
            <p className="micro-title">退出结算 / REALIZED EXIT</p>
            <div className="exit-price"><small>实际净回款 / NET PROCEEDS</small><strong>{nullableCny(sale?.netProceedsCny ?? null)}</strong><em>{sale?.platform ?? "未记录平台"} · {calendarDate(sale?.soldAt ?? null)}</em></div>
            <LedgerRow label="销售成交总额" value={nullableCny(sale?.grossProceedsCny ?? null)} />
            <LedgerRow label="销售费用 / 出库物流" value={sale ? cny(sale.platformFeeCny + sale.shippingCny) : "—"} />
            {hasValuation && <details className="historical-valuation"><summary>查看出售前历史估值</summary><div className="market-range"><span><small>P25 / 下限</small><b>{nullableCny(asset.marketLowCny)}</b></span><span><small>历史中位</small><b>{nullableCny(asset.marketMedianCny)}</b></span><span><small>P75 / 上限</small><b>{nullableCny(asset.marketHighCny)}</b></span></div></details>}
          </div> : <div className={`market-ledger${hasValuation ? "" : " unvalued"}`}>
            <p className="micro-title">市场估值 / MARK TO MARKET</p>
            <div className="market-range"><span><small>P25 / 下限</small><b>{nullableCny(asset.marketLowCny)}</b></span><span><small>市场中位</small><b>{nullableCny(asset.marketMedianCny, "未估值")}</b></span><span><small>P75 / 上限</small><b>{nullableCny(asset.marketHighCny)}</b></span></div>
            <div className="expected-price"><small>当前估值</small><strong>{nullableCny(asset.expectedSaleCny, "未估值")}</strong><em>{asset.valuationDate ? `${valuationSource} · ${sampleCount(asset.valuationSampleSize)} · ${"★".repeat(confidence)}${"☆".repeat(5 - confidence)}` : "待录入估价"}</em></div>
          </div>}
        </div>
        {isSold ? <div className="scenario-ledger realized-scenario"><span><small>净回款</small><b>{nullableCny(sale?.netProceedsCny ?? null)}</b></span><span><small>已实现利润</small><b className={performanceClass(sale?.finalProfit ?? null)}>{signed(sale?.finalProfit ?? null)}</b></span><span className="roi-cell"><small>已实现 ROI</small><b className={performanceClass(sale?.realizedRoi ?? null)}>{pct(sale?.realizedRoi ?? null)}</b></span><span><small>成交 / 持有</small><b>{calendarDate(sale?.soldAt ?? null)} · {sale?.holdingDays ?? 0} 天</b></span></div> : <div className="scenario-ledger"><span><small>保守利润</small><b className={performanceClass(asset.conservativeProfit)}>{signed(asset.conservativeProfit)}</b></span><span><small>中性利润</small><b className={performanceClass(asset.normalProfit)}>{signed(asset.normalProfit)}</b></span><span><small>乐观利润</small><b className={performanceClass(asset.optimisticProfit)}>{signed(asset.optimisticProfit)}</b></span><span className="roi-cell"><small>中位价 ROI</small><b className={performanceClass(normalRoi)}>{pct(normalRoi)}</b></span></div>}
        <div className="asset-card-detail-actions">{!readOnly && !isSold && <button type="button" onClick={() => open("valuation", asset.id)}>更新估价</button>}<Link href={`/cameras/${asset.id}`}>机器详情 →</Link></div>
      </div>}
      <footer>
        <span>{isSold ? `${calendarDate(sale?.soldAt ?? null)} 成交 · ${sale?.holdingDays ?? 0} 天持有` : `${asset.holdingDays} 天持有 · ${asset.lifecycleStatus}`}</span>
        <button className="asset-card-disclosure" type="button" aria-expanded={expanded} onClick={() => setExpanded((value) => !value)}>{expanded ? "收起详情" : "展开详情"}<span aria-hidden="true">{expanded ? "↑" : "↓"}</span></button>
      </footer>
    </article>
  );
}

function LogisticsShipmentCard({ order, refreshTracking, busy, canRefreshTracking }: { order: LogisticsView; refreshTracking: (order: LogisticsView) => void; busy: boolean; canRefreshTracking: boolean }) {
  const localizedAssetNames = order.allocations.map((allocation) => getLocalizedNameFromFormalName(allocation.cameraName)).filter((name): name is string => Boolean(name));
  return (
    <article className="shipment-card">
            <header>
              <div><span className="batch-code">{order.batchCode}</span><h2>{order.carrier}</h2><p>{order.cameraNames}</p>{localizedAssetNames.length > 0 && <small className="shipment-localized-names">{localizedAssetNames.join(" · ")}</small>}</div>
              <div className={`shipment-state ${order.anomaly ? "has-alert" : ""}`}><i /><strong>{order.status}</strong><small>{order.anomaly || order.latestEvent || "尚无轨迹"}</small></div>
            </header>
            <div className="shipment-facts">
              <span><small>国际单号</small><b>{order.trackingNumber || "待录入"}</b></span>
              <span><small>路线</small><b>{order.origin} → {order.destination}</b></span>
              <span><small>运输天数</small><b>{order.totalTransitDays === null ? "—" : order.transitDurationComplete ? `${number(order.totalTransitDays, 1)} 天` : `运输中约 ${number(order.totalTransitDays, 1)} 天`}</b>{order.pickupWaitDays !== null && <em className="pickup-wait">待领取约 {number(order.pickupWaitDays, 1)} 天</em>}</span>
              <span><small>预计到达</small><b>{date(order.estimatedArrivalAt)}</b></span>
              <span><small>计费重量</small><b>{kilograms(order.chargeableWeightG)}</b></span>
              <span><small>批次运费</small><b>{cny(order.shippingCny)}{order.isEstimated ? " 预算" : ""}</b></span>
            </div>
            <div className="shipment-body">
              <div className="milestone-grid">
                <Milestone label="日本发货" value={order.sellerShippedAt} />
                <Milestone label="仓库入库" value={order.warehouseInAt} />
                <Milestone label="国际发货" value={order.internationalShippedAt} />
                <Milestone label="香港到达" value={order.hongKongArrivedAt} />
              </div>
              <ol className="tracking-timeline">
                {order.events.length ? order.events.slice(-6).reverse().map((event, index) => (
                  <li className={index === 0 ? "latest" : ""} key={event.id}><i /><span><b>{event.statusLabel}</b><small>{date(event.occurredAt)} · {event.office}{event.country ? ` / ${event.country}` : ""}</small></span></li>
                )) : <li><i /><span><b>等待物流轨迹</b><small>填写有效日本邮政单号后即可查询</small></span></li>}
              </ol>
            </div>
            <div className="allocation-ledger">
              <header><span>{order.isEstimated ? "预算费用分摊" : "实际费用分摊"}</span><b>{order.allocationMethod}</b></header>
              {order.allocations.map((allocation) => {
                const allocationLocalizedName = getLocalizedNameFromFormalName(allocation.cameraName);
                const showBudget = allocation.actualAllocatedShippingCny !== null
                  && allocation.actualAllocatedShippingCny !== undefined
                  && allocation.budgetAllocatedShippingCny !== null
                  && allocation.budgetAllocatedShippingCny !== undefined
                  && Math.abs(allocation.actualAllocatedShippingCny - allocation.budgetAllocatedShippingCny) >= 0.01;
                return <div key={allocation.cameraId}><span className="allocation-asset-name">{allocation.cameraName}{allocationLocalizedName && <em>{allocationLocalizedName}</em>}</span><small>{grams(allocation.weightG)}</small><span className="allocation-amount"><b>{cny(allocation.allocatedShippingCny, 2)}</b>{showBudget && <small>预算 {cny(allocation.budgetAllocatedShippingCny ?? 0)}</small>}</span></div>;
              })}
            </div>
            <footer>
              <span>{order.costPerKg === null ? "成本 — / kg" : `成本 ${cny(order.costPerKg)}/kg`} · {cny(order.costPerCamera)}/台</span>
              <span>{order.lastCheckedAt ? `上次查询 ${date(order.lastCheckedAt)}` : "尚未查询"}{order.trackingError ? ` · ${order.trackingError}` : ""}</span>
              <div>
                {order.trackingNumber && (order.carrier.includes("EMS") || order.carrier.includes("日本邮政")) && <a href={`https://trackings.post.japanpost.jp/services/srv/search/direct?reqCodeNo1=${order.trackingNumber}&searchKind=S004&locale=en`} target="_blank" rel="noreferrer">官方查询 ↗</a>}
                {canRefreshTracking && isJapanPostTrackingNumber(order.trackingNumber) && (order.carrier.includes("EMS") || order.carrier.includes("日本邮政")) && <button type="button" disabled={busy} onClick={() => refreshTracking(order)}>立即同步</button>}
              </div>
            </footer>
    </article>
  );
}

function LogisticsViewPage({ data, open, refreshTracking, busy, canRefreshTracking }: { data: DashboardData; open: (kind: Exclude<ModalKind, null>) => void; refreshTracking: (order: LogisticsView) => void; busy: boolean; canRefreshTracking: boolean }) {
  const benchmarks = data.logisticsBenchmarks ?? [];
  const benchmarkKey = (item: (typeof benchmarks)[number]) => `${item.scope}:${item.carrierService}`;
  const externalAirPacket = benchmarks.find((item) => item.scope === "external_private" && item.carrierService.includes("AIR Packet"));
  const portfolioEms = benchmarks.find((item) => item.scope === "portfolio_actual" && item.carrierService.includes("EMS"));
  const defaultBenchmark = externalAirPacket ?? benchmarks[0];
  const [selectedCarrier, setSelectedCarrier] = useState(defaultBenchmark ? benchmarkKey(defaultBenchmark) : "");
  const [estimatorExpanded, setEstimatorExpanded] = useState(false);
  const [estimatedWeightG, setEstimatedWeightG] = useState(600);
  const [bundleWeightText, setBundleWeightText] = useState("");
  const benchmark = benchmarks.find((item) => benchmarkKey(item) === selectedCarrier) ?? defaultBenchmark;
  const estimatedCost = benchmark ? estimateShipmentCost(benchmark, estimatedWeightG) : null;
  const selectedAt600 = benchmark ? estimateShipmentCost(benchmark, 600) : null;
  const comparisonBenchmark = benchmark?.scope === "external_private" ? portfolioEms : externalAirPacket;
  const comparisonAt600 = comparisonBenchmark ? estimateShipmentCost(comparisonBenchmark, 600) : null;
  const comparisonDifference = selectedAt600 !== null && comparisonAt600 !== null
    ? comparisonAt600 - selectedAt600
    : null;
  const comparisonPercent = comparisonDifference !== null && comparisonAt600
    ? Math.abs(comparisonDifference) / comparisonAt600 * 100
    : null;
  const t2ReferenceWeight = data.assets.find((asset) =>
    asset.brand.toLowerCase() === "contax"
    && asset.model.toLowerCase().startsWith("t2")
    && asset.weightG > 0
  )?.weightG ?? null;
  const bundleWeights = bundleWeightText
    .split(/[,，\s]+/)
    .map(Number)
    .filter((weight) => Number.isFinite(weight) && weight > 0);
  const bundleAllocations = estimatedCost === null || bundleWeights.length < 2
    ? []
    : allocateEstimateByWeight(estimatedCost, bundleWeights);
  const activeShipments = data.logistics.filter((order) => order.status !== "已签收" && order.status !== "已取消");
  const deliveredShipments = data.logistics.filter((order) => order.status === "已签收");
  const otherShipments = data.logistics.filter((order) => order.status === "已取消");
  const shipmentGroup = (label: string, title: string, orders: LogisticsView[]) => orders.length > 0 && (
    <section className="shipment-group">
      <header className="shipment-group-heading"><div><span>{label}</span><h2>{title}</h2></div><b>{orders.length} 批</b></header>
      <div className="shipment-stack">{orders.map((order) => <LogisticsShipmentCard key={order.id} order={order} refreshTracking={refreshTracking} busy={busy} canRefreshTracking={canRefreshTracking} />)}</div>
    </section>
  );

  return (
    <>
      <div className="toolbar-row"><div className="position-summary"><span>追踪中 <b>{data.logistics.filter((order) => order.trackingNumber && order.status !== "已签收").length}</b></span><span>总批次 <b>{data.logistics.length}</b></span></div>{!data.migrationReadOnly && <button className="primary-action" type="button" onClick={() => open("logistics")}>＋ 新增物流单</button>}</div>
      {shipmentGroup("ACTIVE SHIPMENTS", "运输中与待处理", activeShipments)}
      {benchmark ? <section className={`logistics-benchmark${estimatorExpanded ? " is-expanded" : ""}`} aria-label="物流经验参考">
        <header>
          <div><p className="eyebrow">COST BENCHMARK</p><h2>物流经验参考</h2></div>
          {benchmarks.length > 1 ? <label><span className="sr-only">承运服务</span><select aria-label="承运服务" value={benchmarkKey(benchmark)} onChange={(event) => setSelectedCarrier(event.target.value)}>{benchmarks.map((item) => <option key={benchmarkKey(item)} value={benchmarkKey(item)}>{item.carrierService}{item.scope === "external_private" ? " · 外部私人参考" : ""}</option>)}</select></label> : <b>{benchmark.carrierService}</b>}
        </header>
        <div className="benchmark-compact-summary">
          <div className="benchmark-primary"><small>{benchmark.scope === "external_private" ? "600g 外部参考" : "600g 历史估算"}</small><strong>{selectedAt600 === null ? "—" : cny(selectedAt600, 0)}</strong><span>{benchmark.carrierService}</span></div>
          <div className="benchmark-compare"><small>{comparisonBenchmark ? `${comparisonBenchmark.carrierService.replace("日本邮政 ", "")} 同重量估算` : "同重量比较"}</small><b>{comparisonAt600 === null ? "—" : cny(comparisonAt600, 0)}</b></div>
          <div className="benchmark-saving"><small>{comparisonDifference !== null && comparisonDifference >= 0 ? "节省" : "差额"}</small><b>{comparisonDifference === null ? "—" : `${comparisonDifference >= 0 ? "约 " : "+"}${cny(Math.abs(comparisonDifference), 0)}${comparisonPercent === null ? "" : ` / ${number(comparisonPercent, 1)}%`}`}</b></div>
          <div className="benchmark-confidence"><small>样本</small><b>{benchmark.sampleCount}</b><span>{benchmark.confidenceLabel}置信度</span></div>
        </div>
        <div className="benchmark-disclosure-bar"><p>{benchmark.scope === "external_private" ? "外部私人参考样本，仅用于物流比较，不计入投资组合。" : "基于 Lensfolio 历史实际物流成本的经验估算，不是承运商官方运价。"}</p><button type="button" aria-expanded={estimatorExpanded} onClick={() => setEstimatorExpanded((expanded) => !expanded)}>{estimatorExpanded ? "收起估算" : "展开估算"}<span aria-hidden="true">{estimatorExpanded ? "↑" : "↓"}</span></button></div>
        {estimatorExpanded && <div className="benchmark-expanded-detail">
          <dl className="benchmark-detail-rows">
            <div><dt>平均实际运费</dt><dd>{cny(benchmark.averageActualCostCny, 2)}</dd></div>
            <div><dt>历史区间</dt><dd>{cny(benchmark.minimumActualCostCny)}–{cny(benchmark.maximumActualCostCny)}</dd></div>
            <div><dt>加权成本</dt><dd>{cny(benchmark.weightedCostPerKgCny, 2)} / kg</dd></div>
            <div><dt>完整时效样本</dt><dd>{benchmark.completedTransitSampleCount}{benchmark.typicalTransitDays === null ? "" : ` · ${number(benchmark.typicalTransitDays, 1)} 天`}</dd></div>
          </dl>
          <div className="shipment-estimator">
            <div className="estimator-inputs">
              <label><span>预计计费重量</span><div><input type="number" min="1" step="10" inputMode="decimal" value={estimatedWeightG} onChange={(event) => setEstimatedWeightG(Math.max(0, Number(event.target.value)))} /><b>g</b></div>{t2ReferenceWeight && <small>同系 Contax T2 实测参考约 {t2ReferenceWeight}g，仅用于估算</small>}</label>
              <label><span>多资产分摊重量（可选）</span><input type="text" inputMode="decimal" value={bundleWeightText} onChange={(event) => setBundleWeightText(event.target.value)} placeholder="例如 551, 603" /></label>
            </div>
            <div className="estimator-output">
              <span>预计批次总运费</span><strong>{estimatedCost === null ? "—" : cny(estimatedCost, 2)}</strong>
              <small>{estimatedCost === null || estimatedWeightG <= 0 ? "请输入有效计费重量" : `${cny(estimatedCost / (estimatedWeightG / 1000), 2)} / kg · ${benchmark.confidenceLabel} · ${benchmark.sampleCount} 个样本`}</small>
            </div>
            {bundleAllocations.length > 0 && <div className="estimate-allocation"><span>按资产重量占比分摊预计总额</span>{bundleAllocations.map((allocation, index) => <b key={`${allocation.weightG}-${index}`}>资产 {index + 1} · {allocation.weightG}g · {cny(allocation.amountCny, 2)}</b>)}</div>}
          </div>
          <p className="benchmark-model-note">{benchmark.modelKind === "linear" ? `经验模型：${cny(benchmark.fixedComponentCny, 2)} 固定项 + ${cny(benchmark.variablePerKgCny, 2)}/kg` : `样本不足，使用历史中位数 ${cny(benchmark.medianActualCostCny, 2)}`}</p>
        </div>}
      </section> : <p className="panel-empty">尚无可用于估算的已结算物流样本。</p>}
      {shipmentGroup("DELIVERED", "已签收批次", deliveredShipments)}
      {shipmentGroup("OTHER", "其他批次", otherShipments)}
      <p className="source-note">{data.dataSource === "supabase" ? "追踪数据仅在 owner / editor 明确点击“立即同步”后从日本邮政公开查询页面写入；页面加载不会自动查询。" : data.migrationReadOnly ? "迁移保护期间，自动物流更新与状态变化已暂停。" : "追踪数据来自日本邮政公开查询页面。"}</p>
    </>
  );
}

function RepairsView({ data, open }: { data: DashboardData; open: (kind: Exclude<ModalKind, null>, id?: string) => void }) {
  const statuses = ["未检测", "正常", "待维修", "已维修"];
  return (
    <>
      <div className="toolbar-row"><div className="position-summary"><span>维修成本 <b>{cny(data.summary.repairCost)}</b></span><span>记录 <b>{data.repairs.length}</b></span></div>{!data.migrationReadOnly && <button className="primary-action" type="button" onClick={() => open("repair")}>＋ 新增维修记录</button>}</div>
      <div className="condition-board">{statuses.map((status) => <div key={status}><small>{status}</small><strong>{data.assets.filter((asset) => asset.repairStatus === status).length}</strong><p>{data.assets.filter((asset) => asset.repairStatus === status).map((asset) => asset.model).join(" · ") || "暂无"}</p></div>)}</div>
      <SectionTitle kicker="SERVICE LEDGER" title="维修记录" />
      <div className="data-table-wrap"><table className="system-table"><thead><tr><th>日期</th><th>机器</th><th>问题 / 项目</th><th>维修商</th><th>费用</th><th>价值变化</th><th>结果</th></tr></thead><tbody>
        {data.repairs.length ? data.repairs.map((repair) => <tr key={repair.id}><td>{repair.repairDate}</td><td>{data.migrationReadOnly ? repair.cameraName : <button className="table-link" onClick={() => open("repair", repair.cameraId)} type="button">{repair.cameraName}</button>}</td><td>{repair.problem}<small className="cell-note">{repair.workPerformed}</small></td><td>{repair.vendor || "—"}</td><td>{cny(repair.costCny)}</td><td className={repair.valueChangeCny >= 0 ? "gain" : "loss"}>{repair.valueBeforeCny || repair.valueAfterCny ? signed(repair.valueChangeCny) : "—"}</td><td><span className="table-status">{repair.resultingStatus}</span></td></tr>) : <tr><td colSpan={7} className="empty-cell">尚无维修记录。检测结果也可以用 0 元维修记录保存。</td></tr>}
      </tbody></table></div>
    </>
  );
}

function SalesView({ data, open }: { data: DashboardData; open: (kind: Exclude<ModalKind, null>, id?: string) => void }) {
  const completed = data.sales.filter((sale) => sale.status === "已出售");
  const netProceeds = completed.reduce((total, sale) => total + (sale.netProceedsCny ?? 0), 0);
  return (
    <>
      <div className="toolbar-row"><div className="position-summary"><span>已成交 <b>{completed.length} 台</b></span><span>累计净回款 <b>{cny(netProceeds)}</b></span><span>已实现利润 <b className={performanceClass(data.summary.realizedProfit)}>{signed(data.summary.realizedProfit)}</b></span></div>{!data.migrationReadOnly && <button className="primary-action" type="button" onClick={() => open("sale")}>＋ 记录出售</button>}</div>
      <SectionTitle kicker="DISPOSITION LEDGER" title="已完成交易" />
      <div className="data-table-wrap sales-ledger"><table className="system-table"><thead><tr><th>资产</th><th>成交日期</th><th>成交总额</th><th>销售费用</th><th>净回款</th><th>成本基数</th><th>已实现利润</th><th>已实现 ROI</th></tr></thead><tbody>
        {completed.length ? completed.map((sale) => <tr key={sale.id}><td><Link className="table-link" href={`/cameras/${sale.cameraId}`}>{sale.cameraName}</Link><small className="cell-note">{sale.platform} · {sale.status}</small></td><td>{calendarDate(sale.soldAt)}</td><td>{nullableCny(sale.grossProceedsCny)}</td><td>{cny(sale.platformFeeCny + sale.shippingCny)}</td><td>{nullableCny(sale.netProceedsCny)}</td><td>{cny(sale.carryingCostCny)}</td><td className={performanceClass(sale.finalProfit)}>{signed(sale.finalProfit)}</td><td className={performanceClass(sale.realizedRoi)}>{pct(sale.realizedRoi)}</td></tr>) : <tr><td colSpan={8} className="empty-cell">尚无已完成出售记录。</td></tr>}
      </tbody></table></div>
      <p className="source-note">销售记录只呈现真实交易事实。闲鱼挂牌估值仍保留在资产历史中，不作为成交价或净回款。</p>
    </>
  );
}

function BuyDecisionView() {
  const [targetName, setTargetName] = useState("");
  const [saleLow, setSaleLow] = useState(6000);
  const [saleMedian, setSaleMedian] = useState(8000);
  const [saleHigh, setSaleHigh] = useState(10000);
  const [sellingFees, setSellingFees] = useState(0);
  const [internationalShipping, setInternationalShipping] = useState(200);
  const [domesticShipping, setDomesticShipping] = useState(0);
  const [repairReserve, setRepairReserve] = useState(0);
  const [otherCosts, setOtherCosts] = useState(0);
  const [targetRoi, setTargetRoi] = useState(30);
  const carryingCosts = internationalShipping + domesticShipping + repairReserve + otherCosts;
  const scenarios = [
    buildBuyScenario("LOW", "保守", saleLow, sellingFees, carryingCosts, targetRoi),
    buildBuyScenario("MEDIAN", "中位", saleMedian, sellingFees, carryingCosts, targetRoi),
    buildBuyScenario("HIGH", "乐观", saleHigh, sellingFees, carryingCosts, targetRoi),
  ];

  return (
    <>
      <section className="decision-workbench">
        <div className="decision-intro"><p className="eyebrow">ENTRY UNDERWRITING</p><h2>先锁定回报，再决定最高买价。</h2><p>所有金额以人民币计算。目标 ROI 的分母是完整持有成本，不是售价；销售费用先从退出价格扣除。</p></div>
        <div className="decision-fieldset">
          <label className="decision-name">目标机型 / 备注（可选）<input value={targetName} onChange={(event) => setTargetName(event.target.value)} placeholder="例如：Leica M6 · 黑漆" /></label>
          <div className="decision-control-grid three"><NumberControl label="预计售价 LOW" value={saleLow} setValue={setSaleLow} prefix="¥" /><NumberControl label="预计售价 MEDIAN" value={saleMedian} setValue={setSaleMedian} prefix="¥" /><NumberControl label="预计售价 HIGH" value={saleHigh} setValue={setSaleHigh} prefix="¥" /></div>
          <div className="decision-control-grid costs"><NumberControl label="销售 / 平台费用" value={sellingFees} setValue={setSellingFees} prefix="¥" /><NumberControl label="国际物流" value={internationalShipping} setValue={setInternationalShipping} prefix="¥" /><NumberControl label="国内物流" value={domesticShipping} setValue={setDomesticShipping} prefix="¥" /><NumberControl label="维修预算" value={repairReserve} setValue={setRepairReserve} prefix="¥" /><NumberControl label="其他成本" value={otherCosts} setValue={setOtherCosts} prefix="¥" /><NumberControl label="目标 ROI" value={targetRoi} setValue={setTargetRoi} suffix="%" /></div>
          <p className="model-source">成本预留 {cny(carryingCosts)} · 销售费用 {cny(sellingFees)} · 目标回报 {pct(targetRoi)}</p>
        </div>
      </section>
      <SectionTitle kicker="THREE-CASE ENTRY LIMITS" title={targetName || "买入上限情景"} />
      <div className="decision-scenarios">{scenarios.map((scenario) => <article key={scenario.code} className={scenario.code === "MEDIAN" ? "primary" : ""}><header><span>{scenario.code}</span><h3>{scenario.label}情景</h3><small>预计售价 {cny(scenario.salePrice)}</small></header><strong>{cny(scenario.maxAcquisitionCost)}</strong><p>最大采购价</p><dl><div><dt>净销售回款</dt><dd>{cny(scenario.netProceeds)}</dd></div><div><dt>最大总成本</dt><dd>{cny(scenario.maxTotalCarryingCost)}</dd></div><div><dt>预计利润</dt><dd className={performanceClass(scenario.expectedProfit)}>{signed(scenario.expectedProfit)}</dd></div><div><dt>预计 ROI</dt><dd className={performanceClass(scenario.expectedRoi)}>{pct(scenario.expectedRoi)}</dd></div><div><dt>安全边际</dt><dd>{cny(scenario.safetyMargin)}</dd></div></dl></article>)}</div>
      <p className="decision-formula light">最大总成本 = 净销售回款 ÷ (1 + 目标 ROI)；最大采购价 = 最大总成本 − 国际物流 − 国内物流 − 维修 − 其他成本。</p>
    </>
  );
}

type AnalysisPerformance = {
  asset: AssetView;
  sold: boolean;
  value: number | null;
  profit: number | null;
  roi: number | null;
  holdingDays: number;
};

function AnalysisView({ data }: { data: DashboardData }) {
  const saleByAsset = new Map(data.sales.map((sale) => [sale.cameraId, sale]));
  const performance: AnalysisPerformance[] = data.assets.map((asset) => {
    const sale = saleByAsset.get(asset.id);
    const sold = asset.lifecycleStatus === "已出售";
    return {
      asset,
      sold,
      value: sold ? sale?.netProceedsCny ?? null : asset.marketMedianCny,
      profit: sold ? sale?.finalProfit ?? null : asset.normalProfit,
      roi: sold ? sale?.realizedRoi ?? null : asset.roi,
      holdingDays: sold ? sale?.holdingDays ?? 0 : asset.holdingDays,
    };
  });
  const roiRanking = [...performance].sort((a, b) => (b.roi ?? Number.NEGATIVE_INFINITY) - (a.roi ?? Number.NEGATIVE_INFINITY));
  const profitRanking = [...performance].sort((a, b) => (b.profit ?? Number.NEGATIVE_INFINITY) - (a.profit ?? Number.NEGATIVE_INFINITY));
  const capitalRanking = [...performance].sort((a, b) => b.asset.trueCost - a.asset.trueCost);
  const held = performance.filter((item) => !item.sold);
  const heldCapital = held.reduce((total, item) => total + item.asset.trueCost, 0);
  return (
    <>
      <section className="analysis-metrics">
        <Metric label="组合总利润" value={signed(data.summary.totalProfit)} note="已实现 + 当前持仓未实现" tone={data.summary.totalProfit === null ? undefined : data.summary.totalProfit >= 0 ? "positive" : "negative"} />
        <Metric label="Portfolio ROI" value={pct(data.summary.portfolioRoi)} note={`基于全部 ${data.summary.totalAssetCount} 台历史投入`} tone="ink" />
        <Metric label="已实现利润" value={signed(data.summary.realizedProfit)} note={`${data.summary.soldAssetCount} 台已成交 · ROI ${pct(data.summary.realizedRoi)}`} />
        <Metric label="未实现利润" value={signed(data.summary.unrealizedProfit)} note={`${data.summary.heldAssetCount} 台持仓 · ROI ${pct(data.summary.roi)}`} />
        <Metric label="当前持仓成本" value={cny(data.summary.heldCarryingCost)} note="只含未出售资产" compact />
        <Metric label="持仓市场价值" value={nullableCny(data.summary.currentMarketValue, "未估值")} note="不含 sold 历史估值" compact />
        <Metric label="估值覆盖" value={`${data.summary.valuedAssetCount} / ${data.summary.heldAssetCount}`} note={data.summary.valuationCoverageComplete ? "当前持仓全部已估值" : "部分持仓尚未估值"} compact />
        <Metric label="资产生命周期" value={`${data.summary.heldAssetCount} / ${data.summary.soldAssetCount}`} note="持有 / 已售" compact />
      </section>
      <ModelInventoryPools assets={data.assets} mode="analysis" />
      <SectionTitle kicker="ASSET PERFORMANCE" title="单机表现" />
      <div className="performance-ledger">{performance.map((item) => { const localizedName = getAssetLocalizedName(item.asset.brand, item.asset.model); return <article key={item.asset.id}><header><div><span>{item.asset.brand}</span><h3>{item.asset.model}</h3>{localizedName && <small>{localizedName}</small>}</div><b className={item.sold ? "sold" : "held"}>{item.asset.lifecycleStatus}</b></header><dl><div><dt>成本基数</dt><dd>{cny(item.asset.trueCost)}</dd></div><div><dt>{item.sold ? "净回款" : "当前估值"}</dt><dd>{nullableCny(item.value, item.sold ? "未记录" : "未估值")}</dd></div><div><dt>{item.sold ? "已实现盈亏" : "未实现盈亏"}</dt><dd className={performanceClass(item.profit)}>{signed(item.profit)}</dd></div><div><dt>{item.sold ? "已实现 ROI" : "未实现 ROI"}</dt><dd className={performanceClass(item.roi)}>{pct(item.roi)}</dd></div><div><dt>持有周期</dt><dd>{item.holdingDays} 天</dd></div></dl></article>; })}</div>
      <SectionTitle kicker="RANKINGS" title="组合排名" />
      <div className="analysis-rankings"><Ranking title="ROI 排名" items={roiRanking} value={(item) => pct(item.roi)} /><Ranking title="绝对利润排名" items={profitRanking} value={(item) => signed(item.profit)} /><Ranking title="资金占用排名" items={capitalRanking} value={(item) => cny(item.asset.trueCost)} /></div>
      <SectionTitle kicker="CAPITAL ALLOCATION" title="当前持仓资金占用" />
      <div className="allocation-analysis">{held.map((item) => { const share = heldCapital ? item.asset.trueCost / heldCapital * 100 : 0; return <div key={item.asset.id}><span><b>{item.asset.model}</b><small>{cny(item.asset.trueCost)}</small></span><i><em style={{ width: `${share}%` }} /></i><strong>{number(share, 1)}%</strong></div>; })}</div>
    </>
  );
}

function AssetDetail({ asset, data, open }: { asset: AssetView; data: DashboardData; open: (kind: Exclude<ModalKind, null>, id?: string) => void }) {
  const repairs = data.repairs.filter((record) => record.cameraId === asset.id);
  const sales = data.sales.filter((record) => record.cameraId === asset.id);
  const expenses = data.expenses.filter((record) => record.cameraId === asset.id);
  return (
    <>
      <div className="detail-actions"><Link href="/assets">← 返回资产管理</Link>{!data.migrationReadOnly && <div><button type="button" onClick={() => open("status", asset.id)}>更新状态</button><button type="button" onClick={() => open("expense", asset.id)}>＋ 其他费用</button><button type="button" onClick={() => open("repair", asset.id)}>＋ 维修记录</button><button type="button" onClick={() => open("valuation", asset.id)}>更新估价</button><button className="primary-action" type="button" onClick={() => open("sale", asset.id)}>记录出售</button></div>}</div>
      <InvestmentCard asset={asset} sale={sales[0]} open={open} readOnly={data.migrationReadOnly} />
      <div className="detail-grid">
        <article className="record-panel"><p className="eyebrow">ASSET STATUS</p><h2>机器档案</h2><dl><div><dt>采购日期</dt><dd>{asset.acquiredAt}</dd></div><div><dt>采购平台</dt><dd>{asset.purchasePlatform || "—"}</dd></div><div><dt>订单 / 卖家</dt><dd>{asset.purchaseOrderRef || "—"} · {asset.purchaseSeller || "—"}</dd></div><div><dt>序列号</dt><dd>{asset.serialNumber || "未记录"}</dd></div><div><dt>机器重量</dt><dd>{asset.weightG ? `${asset.weightG} g` : "未记录"}</dd></div><div><dt>当前状态</dt><dd>{asset.lifecycleStatus}</dd></div><div><dt>维修状态</dt><dd>{asset.repairStatus}</dd></div><div><dt>成色等级</dt><dd>{asset.conditionGrade || "未记录"}</dd></div><div><dt>持有周期</dt><dd>{sales[0]?.holdingDays ?? asset.holdingDays} 天</dd></div><div><dt>备注</dt><dd>{asset.notes || "—"}</dd></div></dl></article>
        <article className="record-panel"><p className="eyebrow">COST EVENTS</p><h2>费用、维修与销售</h2>{repairs.length || sales.length || expenses.length ? <ul className="record-list">{expenses.map((item) => <li key={item.id}><span>{item.expenseDate}</span><b>{item.category} · {item.notes || "其他费用"}</b><em>−{cny(item.amountCny)}</em></li>)}{repairs.map((item) => <li key={item.id}><span>{item.repairDate}</span><b>{item.workPerformed}</b><em>−{cny(item.costCny)}</em></li>)}{sales.map((item) => <li key={item.id}><span>{item.soldAt || item.listedAt || "—"}</span><b>{item.platform} · {item.status}</b><em className={item.finalProfit >= 0 ? "gain" : "loss"}>{signed(item.finalProfit)}</em></li>)}</ul> : <p className="panel-empty">暂无其他费用、维修或销售记录。</p>}</article>
      </div>
    </>
  );
}

function Metric({ label, value, note, tone = "", compact = false }: { label: string; value: string; note: string; tone?: string; compact?: boolean }) {
  return <article className={`metric ${tone} ${compact ? "compact" : ""}`}><span>{label}</span><strong>{value}</strong><small>{note}</small></article>;
}
function LedgerRow({ label, value, total = false }: { label: string; value: string; total?: boolean }) {
  return <div className={total ? "total" : ""}><span>{label}</span><b>{value}</b></div>;
}
function SectionTitle({ kicker, title, action }: { kicker: string; title: string; action?: ReactNode }) {
  return <div className="section-title"><div><p className="eyebrow">{kicker}</p><h2>{title}</h2></div>{action}</div>;
}
function Milestone({ label, value }: { label: string; value: string | null }) {
  return <div className={value ? "done" : ""}><i /><span><small>{label}</small><b>{date(value)}</b></span></div>;
}
function NumberControl({ label, value, setValue, prefix, suffix }: { label: string; value: number; setValue: (value: number) => void; prefix?: string; suffix?: string }) {
  return <label>{label}<span className="number-control">{prefix && <i>{prefix}</i>}<input type="number" min="0" step="0.01" value={value} onChange={(event) => setValue(Number(event.target.value))} />{suffix && <i>{suffix}</i>}</span></label>;
}

function buildBuyScenario(code: string, label: string, salePrice: number, sellingFees: number, carryingCosts: number, targetRoi: number) {
  const netProceeds = Math.max(0, salePrice - sellingFees);
  const roiRate = Math.max(0, targetRoi) / 100;
  const maxTotalCarryingCost = netProceeds / (1 + roiRate);
  const maxAcquisitionCost = Math.max(0, maxTotalCarryingCost - carryingCosts);
  const expectedProfit = netProceeds - maxTotalCarryingCost;
  const expectedRoi = maxTotalCarryingCost ? expectedProfit / maxTotalCarryingCost * 100 : 0;
  return {
    code,
    label,
    salePrice,
    netProceeds,
    maxTotalCarryingCost,
    maxAcquisitionCost,
    expectedProfit,
    expectedRoi,
    safetyMargin: Math.max(0, netProceeds - maxAcquisitionCost),
  };
}

function Ranking({ title, items, value }: { title: string; items: AnalysisPerformance[]; value: (item: AnalysisPerformance) => string }) {
  return <article><header><p className="eyebrow">RANK</p><h3>{title}</h3></header><ol>{items.map((item, index) => <li key={item.asset.id}><b>{String(index + 1).padStart(2, "0")}</b><span><strong>{item.asset.model}</strong><small>{item.sold ? "已实现" : "持仓"}</small></span><em className={title === "资金占用排名" ? "" : performanceClass(title === "ROI 排名" ? item.roi : item.profit)}>{value(item)}</em></li>)}</ol></article>;
}

function ModalHeader({ kicker, title, copy }: { kicker: string; title: string; copy: string }) {
  return <header className="modal-head"><p className="eyebrow">{kicker}</p><h2>{title}</h2><p>{copy}</p></header>;
}
function Field({ label, children, wide = false }: { label: string; children: ReactNode; wide?: boolean }) {
  return <label className={wide ? "wide" : ""}><span>{label}</span>{children}</label>;
}
function Submit({ busy, label }: { busy: boolean; label: string }) {
  return <button className="form-submit" type="submit" disabled={busy}>{busy ? "正在保存…" : label}</button>;
}

function AssetForm({ onSubmit, busy }: { onSubmit: (event: FormEvent<HTMLFormElement>) => void; busy: boolean }) {
  return <form onSubmit={onSubmit}><ModalHeader kicker="NEW POSITION" title="新增机器" copy="一次建立相机资产与采购订单；所有数据将写入数据库。" /><div className="form-grid">
    <Field label="品牌"><input name="brand" required placeholder="Contax" /></Field><Field label="型号"><input name="model" required placeholder="T2" /></Field>
    <Field label="版本"><input name="variant" placeholder="Date Back" /></Field><Field label="序列号"><input name="serialNumber" /></Field>
    <Field label="机器重量 g"><input name="weightG" type="number" min="0" required /></Field><Field label="资产状态"><select name="lifecycleStatus"><option>待入库</option><option>运输中</option><option>已入库</option><option>检测中</option><option>维修中</option><option>可出售</option><option>已出售</option></select></Field>
    <Field label="购买日期"><input name="acquiredAt" type="date" defaultValue={today()} required /></Field><Field label="采购平台"><input name="platform" defaultValue="任意门" /></Field>
    <Field label="采购订单号"><input name="orderRef" placeholder="留空自动生成" /></Field><Field label="卖家"><input name="seller" /></Field><Field label="商品名称"><input name="productName" placeholder="留空使用品牌型号" /></Field><Field label="支付方式"><input name="paymentMethod" defaultValue="人民币支付" /></Field><Field label="支付日期"><input name="paidAt" type="date" defaultValue={today()} /></Field><Field label="优惠券 JPY"><input name="discountJpy" type="number" min="0" defaultValue="0" /></Field>
    <Field label="日本购买价 JPY"><input name="purchaseJpy" type="number" min="0" required /></Field><Field label="日本境内运费 JPY"><input name="domesticShippingJpy" type="number" min="0" defaultValue="0" /></Field>
    <Field label="日元订单总额"><input name="totalJpy" type="number" min="0" placeholder="含费用及优惠后" /></Field><Field label="人民币实付 CNY"><input name="paidCny" type="number" min="0" step="0.01" required /></Field>
    <Field label="实际汇率"><input name="exchangeRate" type="number" min="0" step="0.0001" placeholder="留空自动计算" /></Field><Field label="维修状态"><select name="repairStatus"><option>未检测</option><option>正常</option><option>待维修</option><option>已维修</option></select></Field>
    <Field label="成色"><input name="conditionGrade" placeholder="例如 A−" /></Field><Field label="其他初始费用 CNY"><input name="otherCostCny" type="number" min="0" defaultValue="0" /></Field>
    <Field label="市场区间下限"><input name="marketLowCny" type="number" min="0" /></Field><Field label="市场中位价"><input name="marketMedianCny" type="number" min="0" /></Field><Field label="市场区间上限"><input name="marketHighCny" type="number" min="0" /></Field><Field label="预计售价"><input name="expectedSaleCny" type="number" min="0" /></Field><Field label="样本数"><input name="sampleSize" type="number" min="0" /></Field><Field label="备注" wide><textarea name="notes" rows={3} /></Field><p className="cleaning-rule">可信度将根据样本数量与价格离散程度自动计算。</p>
  </div><Submit busy={busy} label="写入资产台账" /></form>;
}

function AssetSelect({ assets, defaultValue, name = "cameraId" }: { assets: AssetView[]; defaultValue: string; name?: string }) {
  return <select name={name} defaultValue={defaultValue}>{assets.map((asset) => <option value={asset.id} key={asset.id}>{fullName(asset)}</option>)}</select>;
}
function RepairForm({ assets, cameraId, onSubmit, busy }: { assets: AssetView[]; cameraId: string; onSubmit: (event: FormEvent<HTMLFormElement>) => void; busy: boolean }) {
  return <form onSubmit={onSubmit}><ModalHeader kicker="SERVICE EVENT" title="新增维修记录" copy="费用保存后会立即进入单机真实总成本。检测也可记录为 0 元。" /><div className="form-grid">
    <Field label="机器" wide><AssetSelect assets={assets} defaultValue={cameraId} /></Field><Field label="日期"><input name="repairDate" type="date" defaultValue={today()} required /></Field><Field label="维修结果"><select name="resultingStatus" defaultValue="已维修"><option>未检测</option><option>正常</option><option>待维修</option><option>已维修</option></select></Field>
    <Field label="发现问题" wide><input name="problem" required placeholder="例如：闪光灯不工作" /></Field><Field label="维修项目" wide><input name="workPerformed" required placeholder="例如：更换闪光灯电容并清洁" /></Field><Field label="维修费用 CNY"><input name="costCny" type="number" min="0" step="0.01" defaultValue="0" required /></Field><Field label="维修商"><input name="vendor" /></Field><Field label="维修前估值"><input name="valueBeforeCny" type="number" min="0" defaultValue="0" /></Field><Field label="维修后估值"><input name="valueAfterCny" type="number" min="0" defaultValue="0" /></Field><Field label="备注" wide><textarea name="notes" rows={3} /></Field>
  </div><Submit busy={busy} label="保存维修记录" /></form>;
}
function ValuationForm({ assets, cameraId, onSubmit, busy }: { assets: AssetView[]; cameraId: string; onSubmit: (event: FormEvent<HTMLFormElement>) => void; busy: boolean }) {
  const selected = assets.find((asset) => asset.id === cameraId) ?? assets[0];
  return <form onSubmit={onSubmit}><ModalHeader kicker="MARK TO MARKET" title="更新市场估值" copy="当前阶段人工录入可比样本；每次保存都保留历史，不伪装成自动采集。" /><div className="form-grid">
    <Field label="机器" wide><AssetSelect assets={assets} defaultValue={cameraId} /></Field><Field label="估价来源"><select name="source"><option>闲鱼</option><option>Mercari</option><option>eBay</option><option>人工调研</option></select></Field><Field label="估价日期"><input name="valuedAt" type="date" defaultValue={today()} required /></Field><Field label="搜索关键词" wide><input name="keyword" defaultValue={selected ? `${selected.brand} ${selected.model}${selected.variant ? ` ${selected.variant}` : ""}` : ""} /></Field>
    <Field label="价格区间下限"><input name="lowCny" type="number" min="0" defaultValue={selected?.marketLowCny ?? undefined} required /></Field><Field label="市场中位价"><input name="medianCny" type="number" min="0" defaultValue={selected?.marketMedianCny ?? undefined} required /></Field><Field label="价格区间上限"><input name="highCny" type="number" min="0" defaultValue={selected?.marketHighCny ?? undefined} required /></Field><Field label="预计售价"><input name="expectedCny" type="number" min="0" defaultValue={selected?.expectedSaleCny ?? undefined} required /></Field><Field label="样本数"><input name="sampleSize" type="number" min="0" defaultValue={selected?.valuationSampleSize || ""} /></Field><Field label="样本成色"><input name="conditionGrade" defaultValue={selected?.conditionGrade || ""} /></Field><Field label="备注" wide><textarea name="notes" rows={3} /></Field><p className="cleaning-rule">保存时记录统一清洗口径：排除维修机、故障机、配件、皮套、说明书与空壳；只保留完整且可正常使用的机器样本。可信度由样本量和价格离散程度自动计算。</p>
  </div><Submit busy={busy} label="保存市场估价" /></form>;
}
function SaleForm({ assets, cameraId, onSubmit, busy }: { assets: AssetView[]; cameraId: string; onSubmit: (event: FormEvent<HTMLFormElement>) => void; busy: boolean }) {
  const selected = assets.find((asset) => asset.id === cameraId) ?? assets[0];
  return <form onSubmit={onSubmit}><ModalHeader kicker="EXIT EVENT" title="记录出售" copy="已出售记录会结转最终利润；待出售记录用于管理挂牌。" /><div className="form-grid">
    <Field label="机器" wide><AssetSelect assets={assets} defaultValue={cameraId} /></Field><Field label="平台"><input name="platform" defaultValue="闲鱼" /></Field><Field label="状态"><select name="status"><option>待出售</option><option>已出售</option></select></Field>
    <Field label="上架日期"><input name="listedAt" type="date" defaultValue={today()} /></Field><Field label="成交日期"><input name="soldAt" type="date" defaultValue={today()} /></Field><Field label="挂牌价"><input name="askingPriceCny" type="number" min="0" defaultValue={selected?.expectedSaleCny ?? undefined} /></Field>
    <Field label="当时市场中位价"><input name="marketPriceCny" type="number" min="0" defaultValue={selected?.marketMedianCny ?? undefined} /></Field><Field label="实际成交价"><input name="actualPriceCny" type="number" min="0" defaultValue="0" /></Field><Field label="平台费用"><input name="platformFeeCny" type="number" min="0" defaultValue="0" /></Field><Field label="出售运费"><input name="shippingCny" type="number" min="0" defaultValue="0" /></Field><Field label="买家 / 备注" wide><textarea name="buyerNotes" rows={3} /></Field>
  </div><Submit busy={busy} label="保存出售记录" /></form>;
}
function LogisticsForm({ assets, onSubmit, busy }: { assets: AssetView[]; onSubmit: (event: FormEvent<HTMLFormElement>) => void; busy: boolean }) {
  return <form onSubmit={onSubmit}><ModalHeader kicker="NEW SHIPMENT" title="新增物流订单" copy="系统优先按机器重量自动分摊；重量缺失时才会退回平均分摊。日本邮政 EMS 支持自动追踪。" /><div className="form-grid">
    <Field label="批次"><input name="batchCode" required placeholder="BATCH 003" /></Field><Field label="快递公司"><select name="carrier" defaultValue="日本邮政 EMS"><option>日本邮政 EMS</option><option>DHL</option><option>FedEx</option></select></Field><Field label="国际单号"><input name="trackingNumber" placeholder="EN533720370JP" /></Field><Field label="当前状态"><input name="status" defaultValue="待发货" /></Field><Field label="起点"><input name="origin" defaultValue="日本" /></Field><Field label="终点"><input name="destination" defaultValue="香港" /></Field>
    <Field label="日本发货时间"><input name="sellerShippedAt" type="datetime-local" /></Field><Field label="仓库入库时间"><input name="warehouseInAt" type="datetime-local" /></Field><Field label="国际发货时间"><input name="internationalShippedAt" type="datetime-local" /></Field><Field label="预计到达时间"><input name="estimatedArrivalAt" type="datetime-local" /></Field>
    <Field label="裸重 g"><input name="bareWeightG" type="number" min="0" defaultValue="0" /></Field><Field label="计费重量 g"><input name="chargeableWeightG" type="number" min="0" defaultValue="0" /></Field><Field label="运费 JPY"><input name="shippingJpy" type="number" min="0" defaultValue="0" /></Field><Field label="运费 CNY"><input name="shippingCny" type="number" min="0" step="0.01" defaultValue="0" /></Field><Field label="手续费 CNY"><input name="handlingCny" type="number" min="0" step="0.01" defaultValue="0" /></Field><Field label="分摊方式"><select name="allocationMethod"><option>按重量</option><option>平均分摊</option></select></Field>
    <Field label="关联机器" wide><div className="check-grid">{assets.filter((asset) => asset.lifecycleStatus !== "已出售").map((asset) => <label key={asset.id}><input type="checkbox" name="cameraIds" value={asset.id} /><span>{fullName(asset)}</span></label>)}</div></Field>
    <Field label="费用状态"><select name="isEstimated"><option value="false">已支付</option><option value="true">预算 / 待确认</option></select></Field><Field label="备注"><input name="notes" /></Field>
  </div><Submit busy={busy} label="保存物流订单" /></form>;
}

function ExpenseForm({ assets, cameraId, onSubmit, busy }: { assets: AssetView[]; cameraId: string; onSubmit: (event: FormEvent<HTMLFormElement>) => void; busy: boolean }) {
  return <form onSubmit={onSubmit}><ModalHeader kicker="OTHER COST" title="新增其他费用" copy="配件、检测、仓储等费用会立即进入这台机器的真实成本。" /><div className="form-grid">
    <Field label="机器" wide><AssetSelect assets={assets} defaultValue={cameraId} /></Field><Field label="日期"><input name="expenseDate" type="date" defaultValue={today()} required /></Field><Field label="费用类型"><select name="category"><option>检测</option><option>仓储</option><option>配件</option><option>包装</option><option>其他</option></select></Field><Field label="金额 CNY"><input name="amountCny" type="number" min="0" step="0.01" required /></Field><Field label="备注" wide><textarea name="notes" rows={3} /></Field>
  </div><Submit busy={busy} label="写入真实成本" /></form>;
}

function StatusForm({ assets, cameraId, onSubmit, busy }: { assets: AssetView[]; cameraId: string; onSubmit: (event: FormEvent<HTMLFormElement>) => void; busy: boolean }) {
  const selected = assets.find((asset) => asset.id === cameraId) ?? assets[0];
  return <form onSubmit={onSubmit}><ModalHeader kicker="ASSET STATUS" title="更新机器状态" copy="状态、成色与备注可直接更新，不需要修改网页代码。" /><input type="hidden" name="id" value={selected?.id} /><div className="form-grid">
    <Field label="资产状态"><select name="lifecycleStatus" defaultValue={selected?.lifecycleStatus}><option>待入库</option><option>运输中</option><option>已入库</option><option>检测中</option><option>维修中</option><option>可出售</option><option>已出售</option></select></Field><Field label="维修状态"><select name="repairStatus" defaultValue={selected?.repairStatus}><option>未检测</option><option>正常</option><option>待维修</option><option>已维修</option></select></Field><Field label="成色"><input name="conditionGrade" defaultValue={selected?.conditionGrade || ""} /></Field><Field label="备注" wide><textarea name="notes" rows={3} defaultValue={selected?.notes || ""} /></Field>
  </div><Submit busy={busy} label="保存机器状态" /></form>;
}
