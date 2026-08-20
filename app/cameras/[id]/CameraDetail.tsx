"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { Camera, batchLabel, landedCost } from "../../data";

const STORAGE_KEY = "lensfolio-custom-cameras-v1";

const cny = (value: number) =>
  new Intl.NumberFormat("zh-CN", {
    style: "currency",
    currency: "CNY",
    maximumFractionDigits: 0,
  }).format(value);

const number = (value: number) => new Intl.NumberFormat("zh-CN").format(value);

export default function CameraDetail({ id, initialCamera }: { id: string; initialCamera: Camera | null }) {
  const [camera, setCamera] = useState<Camera | null>(initialCamera);
  const [salePrice, setSalePrice] = useState(initialCamera?.targetSaleCny ?? 0);

  useEffect(() => {
    if (initialCamera) return;
    const loadSavedCamera = () => {
      try {
        const saved = JSON.parse(window.localStorage.getItem(STORAGE_KEY) || "[]") as Camera[];
        const match = saved.find((item) => item.id === id) ?? null;
        setCamera(match);
        if (match) setSalePrice(match.targetSaleCny);
      } catch {
        setCamera(null);
      }
    };
    const timer = window.setTimeout(loadSavedCamera, 0);
    return () => window.clearTimeout(timer);
  }, [id, initialCamera]);

  if (!camera) {
    return (
      <main className="detail-shell missing-state">
        <span className="brand-disc">LF</span>
        <p className="section-kicker">ASSET NOT AVAILABLE</p>
        <h1>这条本地资产记录不在当前浏览器中。</h1>
        <p>如果它是在另一台设备新增的，请回到那台设备继续查看。</p>
        <Link className="button button-dark" href="/">返回组合总览</Link>
      </main>
    );
  }

  const cost = landedCost(camera);
  const profit = salePrice - cost;
  const roi = cost ? profit / cost * 100 : 0;
  const costShare = cost ? camera.paidCny / cost * 100 : 0;

  return (
    <main className="detail-shell">
      <header className="detail-header">
        <Link className="wordmark" href="/">
          <span className="brand-disc">LF</span>
          <span><b>LENSFOLIO</b><small>CAMERA CAPITAL</small></span>
        </Link>
        <Link className="back-link" href="/">← 返回组合总览</Link>
      </header>

      <section className="detail-hero">
        <div>
          <p className="section-kicker">ASSET DOSSIER / {camera.brand.toUpperCase()}</p>
          <h1>{camera.model}</h1>
          <div className="detail-badges"><span>{batchLabel(camera.batchId)}</span><span>{camera.status}</span>{camera.shippingEstimate && <span>物流预算</span>}</div>
        </div>
        <div className="detail-hero-index"><span>落地成本</span><strong>{cny(cost)}</strong><small>{camera.allocationNote ? "包含套装均摊口径" : "商品实付 + 国际物流"}</small></div>
      </section>

      {camera.allocationNote && <div className="allocation-banner"><b>均摊说明</b><p>{camera.allocationNote}</p></div>}

      <section className="detail-kpis">
        <article><span>商品实付</span><strong>{cny(camera.paidCny)}</strong><small>人民币扣款</small></article>
        <article><span>买入账面</span><strong>¥{number(camera.purchaseJpy)}</strong><small>JPY · 汇率 {camera.exchangeRate.toFixed(4)}</small></article>
        <article><span>物流分摊</span><strong>{cny(camera.shippingCny)}</strong><small>{camera.shippingEstimate ? "预算值" : "已发生"}</small></article>
        <article><span>目标售价</span><strong>{cny(camera.targetSaleCny)}</strong><small>基准估值口径</small></article>
        <article className="detail-kpi-accent"><span>潜在毛 ROI</span><strong>{roi >= 0 ? "+" : ""}{roi.toFixed(1)}%</strong><small>按右侧可调售价</small></article>
      </section>

      <section className="detail-grid">
        <article className="card cost-card">
          <div className="card-heading"><div><p className="section-kicker">COST BASIS</p><h2>成本构成</h2></div><span className="outline-tag">RMB</span></div>
          <div className="cost-stack" aria-label="成本构成">
            <i style={{ width: `${costShare}%` }} /><i className="shipping" style={{ width: `${100 - costShare}%` }} />
          </div>
          <div className="cost-rows">
            <div><span><i />商品实付</span><b>{cny(camera.paidCny)}</b></div>
            <div><span><i className="shipping-dot" />国际物流{camera.shippingEstimate && "（预算）"}</span><b>{cny(camera.shippingCny)}</b></div>
            <div className="total-row"><span>预计落地成本</span><b>{cny(cost)}</b></div>
          </div>
          <div className="sale-control">
            <label htmlFor="detail-sale-price">调整预计成交价</label>
            <div><span>¥</span><input id="detail-sale-price" inputMode="numeric" value={salePrice} onChange={(event) => setSalePrice(Number(event.target.value))} /></div>
            <p>潜在利润 <b className={profit >= 0 ? "positive-text" : "negative-text"}>{profit >= 0 ? "+" : ""}{cny(profit)}</b></p>
          </div>
        </article>

        <article className="card timeline-card">
          <div className="card-heading"><div><p className="section-kicker">ORDER JOURNEY</p><h2>采购与物流节点</h2></div><span className="outline-tag">{camera.orderAt.slice(5, 10)}</span></div>
          <ol className="asset-timeline">
            {camera.timeline.map((event, index) => (
              <li key={`${event.label}-${event.at}`}>
                <div><i /><em>{String(index + 1).padStart(2, "0")}</em></div>
                <span><b>{event.label}</b>{event.detail && <small>{event.detail}</small>}</span>
                <strong>{event.at}</strong>
              </li>
            ))}
          </ol>
        </article>
      </section>

      <section className="detail-grid lower-detail-grid">
        <article className="thesis-card positive-thesis"><span>投资判断</span><h2>{camera.thesis}</h2></article>
        <article className="thesis-card risk-thesis"><span>主要风险</span><h2>{camera.risk}</h2></article>
      </section>

      <section className="data-ledger">
        <div><span>品牌</span><b>{camera.brand}</b></div>
        <div><span>下单时间</span><b>{camera.orderAt}</b></div>
        <div><span>裸重</span><b>{number(camera.weightG)} g</b></div>
        <div><span>物流批次</span><b>{batchLabel(camera.batchId)}</b></div>
        {camera.originalJpy && <div><span>原商品价</span><b>¥{number(camera.originalJpy)} JPY</b></div>}
      </section>

      <footer className="detail-footer"><p>此页面为投资台账原型，不构成买卖建议。税费、维修与销售平台费用需在成交前补录。</p><Link href="/#assets">查看全部资产 →</Link></footer>
    </main>
  );
}
