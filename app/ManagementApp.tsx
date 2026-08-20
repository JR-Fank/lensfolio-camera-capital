"use client";

import Link from "next/link";
import { FormEvent, ReactNode, useEffect, useRef, useState } from "react";
import type { AssetView, DashboardData, LogisticsView } from "../db/queries";

type Section = "dashboard" | "assets" | "logistics" | "repairs" | "sales" | "analysis";
type ModalKind = "asset" | "repair" | "valuation" | "sale" | "logistics" | null;

const nav: Array<{ id: Section; href: string; label: string; index: string }> = [
  { id: "dashboard", href: "/", label: "Dashboard", index: "01" },
  { id: "assets", href: "/assets", label: "资产管理", index: "02" },
  { id: "logistics", href: "/logistics", label: "物流中心", index: "03" },
  { id: "repairs", href: "/repairs", label: "维修中心", index: "04" },
  { id: "sales", href: "/sales", label: "销售中心", index: "05" },
  { id: "analysis", href: "/analysis", label: "投资分析", index: "06" },
];

const sectionCopy: Record<Section, { eyebrow: string; title: string; description: string }> = {
  dashboard: { eyebrow: "PORTFOLIO COMMAND", title: "投资组合", description: "用真实成本与退出价格管理每一台相机，而不是只记录买入价。" },
  assets: { eyebrow: "POSITION BOOK", title: "资产管理", description: "采购、物流、维修与估值汇总到单机真实成本。" },
  logistics: { eyebrow: "MOVEMENT CONTROL", title: "物流中心", description: "批次、成本与日本邮政公开轨迹集中管理。" },
  repairs: { eyebrow: "CONDITION DESK", title: "维修中心", description: "每一笔检测与维修费用都会进入该机器的成本基数。" },
  sales: { eyebrow: "EXIT DESK", title: "销售中心", description: "从闲鱼估价到实际成交，完整结算最终利润。" },
  analysis: { eyebrow: "UNDERWRITING", title: "投资分析", description: "在买入或维修之前，用退出价格模拟回报与安全边际。" },
};

const cny = (value: number, digits = 0) => new Intl.NumberFormat("zh-CN", {
  style: "currency", currency: "CNY", maximumFractionDigits: digits,
}).format(value);
const jpy = (value: number) => `¥${new Intl.NumberFormat("ja-JP", { maximumFractionDigits: 0 }).format(value)}`;
const number = (value: number, digits = 1) => new Intl.NumberFormat("zh-CN", { maximumFractionDigits: digits }).format(value);
const signed = (value: number) => `${value >= 0 ? "+" : "−"}${cny(Math.abs(value))}`;
const pct = (value: number) => `${value >= 0 ? "+" : ""}${value.toFixed(1)}%`;
const date = (value: string | null) => value
  ? new Intl.DateTimeFormat("zh-CN", { month: "2-digit", day: "2-digit", hour: value.includes(":") ? "2-digit" : undefined, minute: value.includes(":") ? "2-digit" : undefined }).format(new Date(value.replace(" ", "T") + (value.includes("T") ? "" : "+08:00")))
  : "—";
const today = () => new Date().toISOString().slice(0, 10);
const fullName = (asset: AssetView) => `${asset.brand} ${asset.model}${asset.variant ? ` ${asset.variant}` : ""}`;

export default function ManagementApp({
  initialData,
  section = "dashboard",
  selectedAssetId,
}: {
  initialData: DashboardData;
  section?: Section;
  selectedAssetId?: string;
}) {
  const [data, setData] = useState(initialData);
  const [modal, setModal] = useState<ModalKind>(null);
  const [cameraId, setCameraId] = useState(selectedAssetId ?? initialData.assets[0]?.id ?? "");
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState("");
  const refreshedTracking = useRef(false);
  const selectedAsset = selectedAssetId ? data.assets.find((asset) => asset.id === selectedAssetId) : undefined;

  const reload = async () => {
    const response = await fetch("/api/dashboard", { cache: "no-store" });
    if (!response.ok) throw new Error("数据刷新失败");
    setData(await response.json() as DashboardData);
  };

  useEffect(() => {
    if (refreshedTracking.current || !["dashboard", "logistics"].includes(section)) return;
    refreshedTracking.current = true;
    fetch("/api/logistics/refresh-due", { method: "POST" })
      .then((response) => response.ok ? response.json() : null)
      .then((result) => result?.outcomes?.some((item: { ok: boolean }) => item.ok) ? reload() : null)
      .catch(() => undefined);
  }, [section]);

  useEffect(() => {
    if (!modal) return;
    const close = (event: KeyboardEvent) => event.key === "Escape" && setModal(null);
    window.addEventListener("keydown", close);
    return () => window.removeEventListener("keydown", close);
  }, [modal]);

  const open = (kind: Exclude<ModalKind, null>, id?: string) => {
    if (id) setCameraId(id);
    setNotice("");
    setModal(kind);
  };

  const submit = async (endpoint: string, event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setBusy(true);
    setNotice("");
    const form = new FormData(event.currentTarget);
    const payload: Record<string, FormDataEntryValue | FormDataEntryValue[]> = Object.fromEntries(form.entries());
    if (form.has("cameraIds")) payload.cameraIds = form.getAll("cameraIds");
    try {
      const response = await fetch(endpoint, {
        method: "POST",
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
    setBusy(true);
    setNotice(`正在查询 ${order.trackingNumber}…`);
    try {
      const response = await fetch("/api/logistics/refresh", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ logisticsOrderId: order.id }),
      });
      const result = await response.json() as { error?: string };
      if (!response.ok) throw new Error(result.error || "查询失败");
      await reload();
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
      : section === "assets" ? <AssetsView data={data} open={open} />
        : section === "logistics" ? <LogisticsViewPage data={data} open={open} refreshTracking={refreshTracking} busy={busy} />
          : section === "repairs" ? <RepairsView data={data} open={open} />
            : section === "sales" ? <SalesView data={data} open={open} />
              : <AnalysisView data={data} />;

  const copy = selectedAsset
    ? { eyebrow: "ASSET FILE", title: fullName(selectedAsset), description: "单机真实成本、市场区间、维修与退出回报。" }
    : sectionCopy[section];

  return (
    <div className="app-shell">
      <aside className="side-rail">
        <Link className="system-mark" href="/" aria-label="Lensfolio 首页">
          <span>LF</span><b>LENSFOLIO</b><small>CAMERA INVESTMENT SYSTEM</small>
        </Link>
        <nav aria-label="系统导航">
          {nav.map((item) => (
            <Link className={section === item.id && !selectedAsset ? "active" : ""} href={item.href} key={item.id}>
              <small>{item.index}</small><span>{item.label}</span><i>↗</i>
            </Link>
          ))}
        </nav>
        <div className="rail-status">
          <i /><span>DATABASE ONLINE</span>
          <small>D1 · 持久化存储</small>
        </div>
      </aside>

      <main className="workspace">
        <header className="mobile-bar">
          <Link href="/" className="mini-mark">LF</Link><span>{copy.title}</span>
          <button type="button" onClick={() => open("asset")}>＋</button>
        </header>
        <header className="page-head">
          <div>
            <p className="eyebrow">{copy.eyebrow}</p>
            <h1>{copy.title}</h1>
            <p>{copy.description}</p>
          </div>
          <div className="head-meta">
            <span><i /> LIVE LEDGER</span>
            <small>刷新于 {new Date(data.refreshedAt).toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" })}</small>
          </div>
        </header>
        {notice && <div className={`notice ${notice.includes("失败") || notice.includes("请") ? "error" : ""}`} role="status">{notice}</div>}
        {page}
        <footer className="system-footer">
          <span>Lensfolio / Camera Investment Management System</span>
          <span>金额单位 CNY · 日元采购另行标注 · 私人台账</span>
        </footer>
      </main>

      {modal && (
        <div className="modal-layer" role="presentation" onMouseDown={(event) => event.target === event.currentTarget && setModal(null)}>
          <div className="record-modal" role="dialog" aria-modal="true" aria-label="新增记录">
            <button className="modal-close" type="button" onClick={() => setModal(null)} aria-label="关闭">×</button>
            {modal === "asset" && <AssetForm onSubmit={(event) => submit("/api/cameras", event)} busy={busy} />}
            {modal === "repair" && <RepairForm assets={data.assets} cameraId={cameraId} onSubmit={(event) => submit("/api/repairs", event)} busy={busy} />}
            {modal === "valuation" && <ValuationForm assets={data.assets} cameraId={cameraId} onSubmit={(event) => submit("/api/valuations", event)} busy={busy} />}
            {modal === "sale" && <SaleForm assets={data.assets} cameraId={cameraId} onSubmit={(event) => submit("/api/sales", event)} busy={busy} />}
            {modal === "logistics" && <LogisticsForm assets={data.assets} onSubmit={(event) => submit("/api/logistics", event)} busy={busy} />}
            {notice && <p className="form-error" role="alert">{notice}</p>}
          </div>
        </div>
      )}
    </div>
  );
}

function DashboardView({ data, open }: { data: DashboardData; open: (kind: Exclude<ModalKind, null>, id?: string) => void }) {
  const { summary } = data;
  const riskAssets = [...data.assets].sort((a, b) => a.normalProfit - b.normalProfit);
  const largest = [...data.assets].sort((a, b) => b.trueCost - a.trueCost)[0];
  const marketCoverage = data.assets.filter((asset) => asset.valuationDate).length;
  const capitalSpread = summary.projectedCostBasis ? Math.min(100, summary.currentMarketValue / summary.projectedCostBasis * 100) : 0;
  return (
    <>
      <section className="metric-ledger" aria-label="投资核心指标">
        <Metric label="总投入资金" value={cny(summary.totalInvested)} note={`含已付物流 ${cny(summary.logisticsCost - summary.estimatedLogisticsCost)}`} tone="ink" />
        <Metric label="当前市场估值" value={cny(summary.currentMarketValue)} note={`${marketCoverage}/${data.assets.length} 台已估价`} tone="acid" />
        <Metric label="浮盈金额" value={signed(summary.unrealizedProfit)} note={`投资 ROI ${pct(summary.roi)}`} tone={summary.unrealizedProfit >= 0 ? "positive" : "negative"} />
        <Metric label="当前资产数量" value={`${summary.assetCount} 台`} note={`预计成本基数 ${cny(summary.projectedCostBasis)}`} />
        <Metric label="平均持有周期" value={`${number(summary.averageHoldingDays, 0)} 天`} note="从采购日期计算" compact />
        <Metric label="物流总成本" value={cny(summary.logisticsCost)} note={`其中预算 ${cny(summary.estimatedLogisticsCost)}`} compact />
        <Metric label="维修总成本" value={cny(summary.repairCost)} note={`${data.repairs.length} 条维修记录`} compact />
        <Metric label="已实现利润" value={signed(summary.realizedProfit)} note={`${data.sales.filter((sale) => sale.status === "已出售").length} 台已成交`} compact />
      </section>

      <section className="command-grid">
        <article className="brief-card dark-panel">
          <div className="panel-head"><div><p className="eyebrow">CAPITAL BRIEF</p><h2>组合价值差</h2></div><span>BASE CASE</span></div>
          <div className="value-bridge">
            <div><small>成本基数</small><strong>{cny(summary.projectedCostBasis)}</strong></div>
            <i>→</i>
            <div><small>预计退出</small><strong>{cny(summary.currentMarketValue)}</strong></div>
          </div>
          <div className="bridge-track"><i style={{ width: `${Math.min(100, capitalSpread)}%` }} /></div>
          <p>当前组合按闲鱼预期售价退出，预计浮盈 <b>{cny(summary.unrealizedProfit)}</b>。平台费与出售运费将在销售中心成交时计入。</p>
        </article>

        <article className="brief-card action-panel">
          <div className="panel-head"><div><p className="eyebrow">DECISION QUEUE</p><h2>下一步动作</h2></div><span>{riskAssets.length} POSITIONS</span></div>
          <ol className="decision-list">
            <li><b>01</b><span><strong>优先检测 {largest?.model ?? "高价值机器"}</strong><small>最大资金仓位，检测结果对组合价值最敏感。</small></span></li>
            <li><b>02</b><span><strong>{riskAssets[0]?.normalProfit < 0 ? `${riskAssets[0].model} 正常情景亏损` : `${riskAssets[0]?.model ?? "资产"} 安全边际最低`}</strong><small>正常利润 {riskAssets[0] ? signed(riskAssets[0].normalProfit) : "—"}，谨慎追加费用。</small></span></li>
            <li><b>03</b><span><strong>第二批 EMS 等待国际单号</strong><small>录入后即可纳入每天 09:00 的自动追踪。</small></span></li>
          </ol>
        </article>
      </section>

      <SectionTitle kicker="POSITION MONITOR" title="核心仓位" action={<button className="text-action" type="button" onClick={() => open("asset")}>＋ 新增机器</button>} />
      <div className="asset-card-grid">
        {data.assets.slice(0, 3).map((asset) => <InvestmentCard asset={asset} open={open} key={asset.id} />)}
      </div>
      <div className="view-all"><Link href="/assets">查看全部 {data.assets.length} 台资产 →</Link></div>
    </>
  );
}

function AssetsView({ data, open }: { data: DashboardData; open: (kind: Exclude<ModalKind, null>, id?: string) => void }) {
  return (
    <>
      <div className="toolbar-row">
        <div className="position-summary"><span>持有中 <b>{data.assets.filter((asset) => asset.lifecycleStatus === "持有中").length}</b></span><span>待检测 <b>{data.assets.filter((asset) => asset.repairStatus === "未检测").length}</b></span><span>待出售 <b>{data.assets.filter((asset) => asset.lifecycleStatus === "待出售").length}</b></span></div>
        <button className="primary-action" type="button" onClick={() => open("asset")}>＋ 新增机器</button>
      </div>
      <div className="asset-card-grid wide">
        {data.assets.map((asset) => <InvestmentCard asset={asset} open={open} key={asset.id} />)}
      </div>
    </>
  );
}

function InvestmentCard({ asset, open }: { asset: AssetView; open: (kind: Exclude<ModalKind, null>, id?: string) => void }) {
  const normalRoi = asset.trueCost ? asset.normalProfit / asset.trueCost * 100 : 0;
  return (
    <article className="investment-card">
      <header>
        <div><p>{asset.brand.toUpperCase()}</p><h3>{asset.model}</h3>{asset.variant && <small>{asset.variant}</small>}</div>
        <div className="asset-status"><span className={`status-dot ${asset.repairStatus === "待维修" ? "warn" : ""}`} />{asset.repairStatus}</div>
      </header>
      <div className="card-split">
        <div className="cost-ledger">
          <p className="micro-title">采购 / COST BASIS</p>
          <LedgerRow label="日本购买价格" value={jpy(asset.purchaseJpy)} />
          <LedgerRow label="日元汇率" value={asset.exchangeRate.toFixed(4)} />
          <LedgerRow label="人民币实付" value={cny(asset.purchaseCny)} />
          <LedgerRow label="日本国内运费" value={`${jpy(asset.domesticShippingJpy)} / ${cny(asset.domesticShippingCny)}`} />
          <LedgerRow label="国际物流" value={`${cny(asset.internationalShippingCny)}${asset.shippingEstimated ? " 预算" : ""}`} />
          <LedgerRow label="维修费用" value={cny(asset.repairCny)} />
          <LedgerRow label="真实总成本" value={cny(asset.trueCost)} total />
        </div>
        <div className="market-ledger">
          <p className="micro-title">市场 / XIANYU</p>
          <div className="market-range"><span><small>最低</small><b>{cny(asset.marketLowCny)}</b></span><span><small>均价</small><b>{cny(asset.marketAverageCny)}</b></span><span><small>精品</small><b>{cny(asset.marketPremiumCny)}</b></span></div>
          <div className="expected-price"><small>预计售价</small><strong>{cny(asset.expectedSaleCny)}</strong><em>{asset.valuationDate ? `${asset.valuationSource} · ${asset.valuationDate}` : "待录入估价"}</em></div>
        </div>
      </div>
      <div className="scenario-ledger">
        <span><small>保守利润</small><b className={asset.conservativeProfit >= 0 ? "gain" : "loss"}>{signed(asset.conservativeProfit)}</b></span>
        <span><small>正常利润</small><b className={asset.normalProfit >= 0 ? "gain" : "loss"}>{signed(asset.normalProfit)}</b></span>
        <span><small>乐观利润</small><b className={asset.optimisticProfit >= 0 ? "gain" : "loss"}>{signed(asset.optimisticProfit)}</b></span>
        <span className="roi-cell"><small>正常 ROI</small><b>{pct(normalRoi)}</b></span>
      </div>
      <footer>
        <span>{asset.holdingDays} 天持有 · {asset.lifecycleStatus}</span>
        <div><button type="button" onClick={() => open("valuation", asset.id)}>更新估价</button><Link href={`/cameras/${asset.id}`}>机器详情 →</Link></div>
      </footer>
    </article>
  );
}

function LogisticsViewPage({ data, open, refreshTracking, busy }: { data: DashboardData; open: (kind: Exclude<ModalKind, null>) => void; refreshTracking: (order: LogisticsView) => void; busy: boolean }) {
  const actual = data.logistics.filter((order) => !order.isEstimated);
  const avgDays = actual.filter((order) => order.totalTransitDays !== null).reduce((sum, order) => sum + (order.totalTransitDays ?? 0), 0) / Math.max(1, actual.filter((order) => order.totalTransitDays !== null).length);
  const totalWeight = actual.reduce((sum, order) => sum + order.chargeableWeightG, 0);
  const totalCost = actual.reduce((sum, order) => sum + order.shippingCny, 0);
  const totalUnits = actual.reduce((sum, order) => sum + order.itemCount, 0);
  return (
    <>
      <div className="toolbar-row"><div className="position-summary"><span>追踪中 <b>{data.logistics.filter((order) => order.trackingNumber && order.status !== "已签收").length}</b></span><span>总批次 <b>{data.logistics.length}</b></span></div><button className="primary-action" type="button" onClick={() => open("logistics")}>＋ 新增物流单</button></div>
      <section className="operating-metrics">
        <Metric label="EMS 平均速度" value={avgDays ? `${number(avgDays, 1)} 天` : "—"} note="国际发货至最新节点" compact />
        <Metric label="EMS 平均成本 / kg" value={totalWeight ? cny(totalCost / (totalWeight / 1000)) : "—"} note="按实际计费重量" compact />
        <Metric label="EMS 平均成本 / 台" value={totalUnits ? cny(totalCost / totalUnits) : "—"} note="按已支付批次" compact />
        <Metric label="物流总预算" value={cny(data.summary.logisticsCost)} note={`待确认 ${cny(data.summary.estimatedLogisticsCost)}`} compact />
      </section>
      <div className="shipment-stack">
        {data.logistics.map((order) => (
          <article className="shipment-card" key={order.id}>
            <header>
              <div><span className="batch-code">{order.batchCode}</span><h2>{order.carrier}</h2><p>{order.cameraNames}</p></div>
              <div className="shipment-state"><i /><strong>{order.status}</strong><small>{order.latestEvent || "尚无轨迹"}</small></div>
            </header>
            <div className="shipment-facts">
              <span><small>国际单号</small><b>{order.trackingNumber || "待录入"}</b></span>
              <span><small>路线</small><b>{order.origin} → {order.destination}</b></span>
              <span><small>运输天数</small><b>{order.totalTransitDays === null ? "—" : `${number(order.totalTransitDays, 1)} 天`}</b></span>
              <span><small>预计到达</small><b>{date(order.estimatedArrivalAt)}</b></span>
              <span><small>计费重量</small><b>{number(order.chargeableWeightG / 1000, 3)} kg</b></span>
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
            <footer>
              <span>成本 {cny(order.costPerKg)}/kg · {cny(order.costPerCamera)}/台</span>
              <span>{order.lastCheckedAt ? `上次查询 ${date(order.lastCheckedAt)}` : "尚未自动查询"}{order.trackingError ? ` · ${order.trackingError}` : ""}</span>
              <div>
                {order.trackingNumber && <a href={`https://trackings.post.japanpost.jp/services/srv/search/direct?reqCodeNo1=${order.trackingNumber}&searchKind=S004&locale=en`} target="_blank" rel="noreferrer">官方查询 ↗</a>}
                {order.trackingNumber && <button type="button" disabled={busy} onClick={() => refreshTracking(order)}>立即同步</button>}
              </div>
            </footer>
          </article>
        ))}
      </div>
      <p className="source-note">追踪数据来自日本邮政公开查询页面，系统每天 09:00（上海时间）刷新未完成包裹；进入物流页也会检查超过 24 小时未更新的记录。</p>
    </>
  );
}

function RepairsView({ data, open }: { data: DashboardData; open: (kind: Exclude<ModalKind, null>, id?: string) => void }) {
  const statuses = ["未检测", "正常", "待维修", "已维修"];
  return (
    <>
      <div className="toolbar-row"><div className="position-summary"><span>维修成本 <b>{cny(data.summary.repairCost)}</b></span><span>记录 <b>{data.repairs.length}</b></span></div><button className="primary-action" type="button" onClick={() => open("repair")}>＋ 新增维修记录</button></div>
      <div className="condition-board">{statuses.map((status) => <div key={status}><small>{status}</small><strong>{data.assets.filter((asset) => asset.repairStatus === status).length}</strong><p>{data.assets.filter((asset) => asset.repairStatus === status).map((asset) => asset.model).join(" · ") || "暂无"}</p></div>)}</div>
      <SectionTitle kicker="SERVICE LEDGER" title="维修记录" />
      <div className="data-table-wrap"><table className="system-table"><thead><tr><th>日期</th><th>机器</th><th>问题</th><th>维修项目</th><th>维修商</th><th>费用</th><th>结果</th></tr></thead><tbody>
        {data.repairs.length ? data.repairs.map((repair) => <tr key={repair.id}><td>{repair.repairDate}</td><td><button className="table-link" onClick={() => open("repair", repair.cameraId)} type="button">{repair.cameraName}</button></td><td>{repair.problem}</td><td>{repair.workPerformed}</td><td>{repair.vendor || "—"}</td><td>{cny(repair.costCny)}</td><td><span className="table-status">{repair.resultingStatus}</span></td></tr>) : <tr><td colSpan={7} className="empty-cell">尚无维修记录。检测结果也可以用 0 元维修记录保存。</td></tr>}
      </tbody></table></div>
    </>
  );
}

function SalesView({ data, open }: { data: DashboardData; open: (kind: Exclude<ModalKind, null>, id?: string) => void }) {
  return (
    <>
      <div className="toolbar-row"><div className="position-summary"><span>组合预计售价 <b>{cny(data.summary.currentMarketValue)}</b></span><span>已实现利润 <b>{signed(data.summary.realizedProfit)}</b></span></div><button className="primary-action" type="button" onClick={() => open("sale")}>＋ 记录出售</button></div>
      <SectionTitle kicker="MARKET MARKS" title="闲鱼估价" action={<button className="text-action" type="button" onClick={() => open("valuation")}>＋ 更新估价</button>} />
      <div className="valuation-grid">{data.assets.map((asset) => <article key={asset.id}><header><span>{asset.brand}</span><h3>{asset.model}</h3></header><div><small>最低</small><b>{cny(asset.marketLowCny)}</b></div><div><small>平均</small><b>{cny(asset.marketAverageCny)}</b></div><div><small>精品</small><b>{cny(asset.marketPremiumCny)}</b></div><footer><span>预期 {cny(asset.expectedSaleCny)}</span><button type="button" onClick={() => open("valuation", asset.id)}>更新</button></footer></article>)}</div>
      <SectionTitle kicker="EXIT LEDGER" title="出售记录" />
      <div className="data-table-wrap"><table className="system-table"><thead><tr><th>机器</th><th>平台 / 状态</th><th>挂牌价</th><th>成交价</th><th>平台费</th><th>运费</th><th>最终利润</th></tr></thead><tbody>
        {data.sales.length ? data.sales.map((sale) => <tr key={sale.id}><td>{sale.cameraName}</td><td>{sale.platform} · {sale.status}</td><td>{cny(sale.askingPriceCny)}</td><td>{sale.actualPriceCny ? cny(sale.actualPriceCny) : "—"}</td><td>{cny(sale.platformFeeCny)}</td><td>{cny(sale.shippingCny)}</td><td className={sale.finalProfit >= 0 ? "gain" : "loss"}>{signed(sale.finalProfit)}</td></tr>) : <tr><td colSpan={7} className="empty-cell">尚无出售记录。成交后系统会从资产估值转为已实现利润。</td></tr>}
      </tbody></table></div>
    </>
  );
}

function AnalysisView({ data }: { data: DashboardData }) {
  const [assetId, setAssetId] = useState(data.assets[0]?.id ?? "");
  const asset = data.assets.find((item) => item.id === assetId) ?? data.assets[0];
  const [salePrice, setSalePrice] = useState(asset?.expectedSaleCny ?? 0);
  const [extraRepair, setExtraRepair] = useState(0);
  const [platformFee, setPlatformFee] = useState(0);
  const [outboundShipping, setOutboundShipping] = useState(0);
  if (!asset) return <p>请先新增机器。</p>;
  const adjustedCost = asset.trueCost + extraRepair;
  const net = salePrice - salePrice * platformFee / 100 - outboundShipping;
  const profit = net - adjustedCost;
  const roi = adjustedCost ? profit / adjustedCost * 100 : 0;
  const breakEven = platformFee < 100 ? (adjustedCost + outboundShipping) / (1 - platformFee / 100) : 0;
  return (
    <>
      <section className="exit-lab">
        <div className="lab-copy"><p className="eyebrow">EXIT PRICE SIMULATOR</p><h2>出售前，先算清。</h2><p>维修追加、平台费和寄给买家的运费都进入退出模型。输入任何报价，立即看到真实利润与 ROI。</p><div className="formula">净利润 = 成交价 − 平台费 − 出售运费 − 真实总成本</div></div>
        <div className="lab-form">
          <label>选择机器<select value={assetId} onChange={(event) => { const next = data.assets.find((item) => item.id === event.target.value); setAssetId(event.target.value); setSalePrice(next?.expectedSaleCny ?? 0); }}>{data.assets.map((item) => <option value={item.id} key={item.id}>{fullName(item)}</option>)}</select></label>
          <div className="lab-input-grid"><NumberControl label="模拟成交价" value={salePrice} setValue={setSalePrice} prefix="¥" /><NumberControl label="新增维修" value={extraRepair} setValue={setExtraRepair} prefix="¥" /><NumberControl label="平台费率" value={platformFee} setValue={setPlatformFee} suffix="%" /><NumberControl label="出售运费" value={outboundShipping} setValue={setOutboundShipping} prefix="¥" /></div>
          <div className="market-presets"><span>闲鱼参考</span><button type="button" onClick={() => setSalePrice(asset.marketLowCny)}>最低 {cny(asset.marketLowCny)}</button><button type="button" onClick={() => setSalePrice(asset.marketAverageCny)}>平均 {cny(asset.marketAverageCny)}</button><button type="button" onClick={() => setSalePrice(asset.marketPremiumCny)}>精品 {cny(asset.marketPremiumCny)}</button></div>
          <div className="lab-results"><span><small>调整后成本</small><b>{cny(adjustedCost)}</b></span><span><small>保本售价</small><b>{cny(breakEven)}</b></span><span><small>预计净利润</small><b className={profit >= 0 ? "gain" : "loss"}>{signed(profit)}</b></span><span className={profit >= 0 ? "result-positive" : "result-negative"}><small>投资 ROI</small><b>{pct(roi)}</b></span></div>
        </div>
      </section>
      <SectionTitle kicker="SCENARIO MATRIX" title="组合退出情景" />
      <div className="scenario-matrix"><div className="matrix-head"><span>资产</span><span>真实成本</span><span>保守利润</span><span>正常利润</span><span>乐观利润</span><span>预期 ROI</span></div>{data.assets.map((item) => <div className="matrix-row" key={item.id}><span><b>{item.model}</b><small>{item.repairStatus}</small></span><span>{cny(item.trueCost)}</span><span className={item.conservativeProfit >= 0 ? "gain" : "loss"}>{signed(item.conservativeProfit)}</span><span className={item.normalProfit >= 0 ? "gain" : "loss"}>{signed(item.normalProfit)}</span><span className={item.optimisticProfit >= 0 ? "gain" : "loss"}>{signed(item.optimisticProfit)}</span><span><b>{pct(item.roi)}</b></span></div>)}</div>
    </>
  );
}

function AssetDetail({ asset, data, open }: { asset: AssetView; data: DashboardData; open: (kind: Exclude<ModalKind, null>, id?: string) => void }) {
  const repairs = data.repairs.filter((record) => record.cameraId === asset.id);
  const sales = data.sales.filter((record) => record.cameraId === asset.id);
  return (
    <>
      <div className="detail-actions"><Link href="/assets">← 返回资产管理</Link><div><button type="button" onClick={() => open("repair", asset.id)}>＋ 维修记录</button><button type="button" onClick={() => open("valuation", asset.id)}>更新估价</button><button className="primary-action" type="button" onClick={() => open("sale", asset.id)}>记录出售</button></div></div>
      <InvestmentCard asset={asset} open={open} />
      <div className="detail-grid">
        <article className="record-panel"><p className="eyebrow">ASSET STATUS</p><h2>机器档案</h2><dl><div><dt>采购日期</dt><dd>{asset.acquiredAt}</dd></div><div><dt>当前状态</dt><dd>{asset.lifecycleStatus}</dd></div><div><dt>维修状态</dt><dd>{asset.repairStatus}</dd></div><div><dt>成色等级</dt><dd>{asset.conditionGrade || "未记录"}</dd></div><div><dt>持有周期</dt><dd>{asset.holdingDays} 天</dd></div><div><dt>备注</dt><dd>{asset.notes || "—"}</dd></div></dl></article>
        <article className="record-panel"><p className="eyebrow">COST EVENTS</p><h2>维修与销售</h2>{repairs.length || sales.length ? <ul className="record-list">{repairs.map((item) => <li key={item.id}><span>{item.repairDate}</span><b>{item.workPerformed}</b><em>−{cny(item.costCny)}</em></li>)}{sales.map((item) => <li key={item.id}><span>{item.soldAt || item.listedAt || "—"}</span><b>{item.platform} · {item.status}</b><em className={item.finalProfit >= 0 ? "gain" : "loss"}>{signed(item.finalProfit)}</em></li>)}</ul> : <p className="panel-empty">暂无维修或销售记录。</p>}</article>
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
    <Field label="购买日期"><input name="acquiredAt" type="date" defaultValue={today()} required /></Field><Field label="采购平台"><input name="platform" defaultValue="任意门" /></Field>
    <Field label="采购订单号"><input name="orderRef" placeholder="留空自动生成" /></Field><Field label="卖家"><input name="seller" /></Field>
    <Field label="日本购买价 JPY"><input name="purchaseJpy" type="number" min="0" required /></Field><Field label="日本境内运费 JPY"><input name="domesticShippingJpy" type="number" min="0" defaultValue="0" /></Field>
    <Field label="日元订单总额"><input name="totalJpy" type="number" min="0" placeholder="含费用及优惠后" /></Field><Field label="人民币实付 CNY"><input name="paidCny" type="number" min="0" step="0.01" required /></Field>
    <Field label="实际汇率"><input name="exchangeRate" type="number" min="0" step="0.0001" placeholder="留空自动计算" /></Field><Field label="维修状态"><select name="repairStatus"><option>未检测</option><option>正常</option><option>待维修</option><option>已维修</option></select></Field>
    <Field label="成色"><input name="conditionGrade" placeholder="例如 A−" /></Field><Field label="闲鱼平均价"><input name="marketAverageCny" type="number" min="0" /></Field>
    <Field label="闲鱼最低价"><input name="marketLowCny" type="number" min="0" /></Field><Field label="闲鱼精品价"><input name="marketPremiumCny" type="number" min="0" /></Field>
    <Field label="预计售价"><input name="expectedSaleCny" type="number" min="0" /></Field><Field label="备注" wide><textarea name="notes" rows={3} /></Field>
  </div><Submit busy={busy} label="写入资产台账" /></form>;
}

function AssetSelect({ assets, defaultValue, name = "cameraId" }: { assets: AssetView[]; defaultValue: string; name?: string }) {
  return <select name={name} defaultValue={defaultValue}>{assets.map((asset) => <option value={asset.id} key={asset.id}>{fullName(asset)}</option>)}</select>;
}
function RepairForm({ assets, cameraId, onSubmit, busy }: { assets: AssetView[]; cameraId: string; onSubmit: (event: FormEvent<HTMLFormElement>) => void; busy: boolean }) {
  return <form onSubmit={onSubmit}><ModalHeader kicker="SERVICE EVENT" title="新增维修记录" copy="费用保存后会立即进入单机真实总成本。检测也可记录为 0 元。" /><div className="form-grid">
    <Field label="机器" wide><AssetSelect assets={assets} defaultValue={cameraId} /></Field><Field label="日期"><input name="repairDate" type="date" defaultValue={today()} required /></Field><Field label="维修结果"><select name="resultingStatus" defaultValue="已维修"><option>未检测</option><option>正常</option><option>待维修</option><option>已维修</option></select></Field>
    <Field label="发现问题" wide><input name="problem" required placeholder="例如：闪光灯不工作" /></Field><Field label="维修项目" wide><input name="workPerformed" required placeholder="例如：更换闪光灯电容并清洁" /></Field><Field label="维修费用 CNY"><input name="costCny" type="number" min="0" step="0.01" defaultValue="0" required /></Field><Field label="维修商"><input name="vendor" /></Field><Field label="备注" wide><textarea name="notes" rows={3} /></Field>
  </div><Submit busy={busy} label="保存维修记录" /></form>;
}
function ValuationForm({ assets, cameraId, onSubmit, busy }: { assets: AssetView[]; cameraId: string; onSubmit: (event: FormEvent<HTMLFormElement>) => void; busy: boolean }) {
  const selected = assets.find((asset) => asset.id === cameraId) ?? assets[0];
  return <form onSubmit={onSubmit}><ModalHeader kicker="MARK TO MARKET" title="更新闲鱼估价" copy="每次估价都会保留历史；首页使用最新一条记录。" /><div className="form-grid">
    <Field label="机器" wide><AssetSelect assets={assets} defaultValue={cameraId} /></Field><Field label="估价来源"><input name="source" defaultValue="闲鱼" /></Field><Field label="估价日期"><input name="valuedAt" type="date" defaultValue={today()} required /></Field>
    <Field label="最低售价"><input name="lowCny" type="number" min="0" defaultValue={selected?.marketLowCny} required /></Field><Field label="平均售价"><input name="averageCny" type="number" min="0" defaultValue={selected?.marketAverageCny} required /></Field><Field label="精品售价"><input name="premiumCny" type="number" min="0" defaultValue={selected?.marketPremiumCny} required /></Field><Field label="预计售价"><input name="expectedCny" type="number" min="0" defaultValue={selected?.expectedSaleCny} required /></Field><Field label="样本数"><input name="sampleSize" type="number" min="0" /></Field><Field label="备注" wide><textarea name="notes" rows={3} /></Field>
  </div><Submit busy={busy} label="保存市场估价" /></form>;
}
function SaleForm({ assets, cameraId, onSubmit, busy }: { assets: AssetView[]; cameraId: string; onSubmit: (event: FormEvent<HTMLFormElement>) => void; busy: boolean }) {
  const selected = assets.find((asset) => asset.id === cameraId) ?? assets[0];
  return <form onSubmit={onSubmit}><ModalHeader kicker="EXIT EVENT" title="记录出售" copy="已出售记录会结转最终利润；待出售记录用于管理挂牌。" /><div className="form-grid">
    <Field label="机器" wide><AssetSelect assets={assets} defaultValue={cameraId} /></Field><Field label="平台"><input name="platform" defaultValue="闲鱼" /></Field><Field label="状态"><select name="status"><option>待出售</option><option>已出售</option></select></Field>
    <Field label="上架日期"><input name="listedAt" type="date" defaultValue={today()} /></Field><Field label="成交日期"><input name="soldAt" type="date" defaultValue={today()} /></Field><Field label="挂牌价"><input name="askingPriceCny" type="number" min="0" defaultValue={selected?.expectedSaleCny} /></Field>
    <Field label="实际成交价"><input name="actualPriceCny" type="number" min="0" defaultValue="0" /></Field><Field label="平台费用"><input name="platformFeeCny" type="number" min="0" defaultValue="0" /></Field><Field label="出售运费"><input name="shippingCny" type="number" min="0" defaultValue="0" /></Field><Field label="买家 / 备注" wide><textarea name="buyerNotes" rows={3} /></Field>
  </div><Submit busy={busy} label="保存出售记录" /></form>;
}
function LogisticsForm({ assets, onSubmit, busy }: { assets: AssetView[]; onSubmit: (event: FormEvent<HTMLFormElement>) => void; busy: boolean }) {
  return <form onSubmit={onSubmit}><ModalHeader kicker="NEW SHIPMENT" title="新增物流订单" copy="批次运费会平均分配到所选机器；日本邮政单号可自动追踪。" /><div className="form-grid">
    <Field label="批次"><input name="batchCode" required placeholder="BATCH 003" /></Field><Field label="快递公司"><input name="carrier" defaultValue="日本邮政 EMS" required /></Field><Field label="国际单号"><input name="trackingNumber" placeholder="EN533720370JP" /></Field><Field label="当前状态"><input name="status" defaultValue="待发货" /></Field><Field label="起点"><input name="origin" defaultValue="日本" /></Field><Field label="终点"><input name="destination" defaultValue="香港" /></Field>
    <Field label="日本发货时间"><input name="sellerShippedAt" type="datetime-local" /></Field><Field label="仓库入库时间"><input name="warehouseInAt" type="datetime-local" /></Field><Field label="国际发货时间"><input name="internationalShippedAt" type="datetime-local" /></Field><Field label="预计到达时间"><input name="estimatedArrivalAt" type="datetime-local" /></Field>
    <Field label="裸重 g"><input name="bareWeightG" type="number" min="0" defaultValue="0" /></Field><Field label="计费重量 g"><input name="chargeableWeightG" type="number" min="0" defaultValue="0" /></Field><Field label="运费 JPY"><input name="shippingJpy" type="number" min="0" defaultValue="0" /></Field><Field label="运费 CNY"><input name="shippingCny" type="number" min="0" step="0.01" defaultValue="0" /></Field>
    <Field label="关联机器" wide><div className="check-grid">{assets.filter((asset) => asset.lifecycleStatus !== "已出售").map((asset) => <label key={asset.id}><input type="checkbox" name="cameraIds" value={asset.id} /><span>{fullName(asset)}</span></label>)}</div></Field>
    <Field label="费用状态"><select name="isEstimated"><option value="false">已支付</option><option value="true">预算 / 待确认</option></select></Field><Field label="备注"><input name="notes" /></Field>
  </div><Submit busy={busy} label="保存物流订单" /></form>;
}
