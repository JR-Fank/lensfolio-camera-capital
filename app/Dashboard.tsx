"use client";

import { FormEvent, useEffect, useMemo, useState } from "react";
import { Camera, batchLabel, landedCost, logisticsBatches, seedCameras } from "./data";

const STORAGE_KEY = "lensfolio-custom-cameras-v1";
const palette = ["#d8ff5f", "#91a8ff", "#75d9bb", "#ffb66f", "#d2a5ff", "#63c7dc", "#f0939b"];

const cny = (value: number, digits = 0) =>
  new Intl.NumberFormat("zh-CN", {
    style: "currency",
    currency: "CNY",
    maximumFractionDigits: digits,
  }).format(value);

const number = (value: number, digits = 0) =>
  new Intl.NumberFormat("zh-CN", { maximumFractionDigits: digits }).format(value);

const percent = (value: number) => `${value >= 0 ? "+" : ""}${value.toFixed(1)}%`;

export default function Dashboard() {
  const [cameras, setCameras] = useState<Camera[]>(seedCameras);
  const [showAdd, setShowAdd] = useState(false);
  const [calcId, setCalcId] = useState("portfolio");
  const [salePrice, setSalePrice] = useState(16211);
  const [platformFee, setPlatformFee] = useState(0);
  const [extraCosts, setExtraCosts] = useState(0);

  useEffect(() => {
    const loadSavedCameras = () => {
      try {
        const saved = window.localStorage.getItem(STORAGE_KEY);
        if (saved) {
          const custom = JSON.parse(saved) as Camera[];
          setCameras([...seedCameras, ...custom.filter((item) => item.isCustom)]);
        }
      } catch {
        // The seeded dashboard remains fully usable when browser storage is unavailable.
      }
    };
    const timer = window.setTimeout(loadSavedCameras, 0);
    return () => window.clearTimeout(timer);
  }, []);

  useEffect(() => {
    if (!showAdd) return;
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") setShowAdd(false);
    };
    window.addEventListener("keydown", closeOnEscape);
    return () => window.removeEventListener("keydown", closeOnEscape);
  }, [showAdd]);

  const totals = useMemo(() => {
    const paid = cameras.reduce((sum, item) => sum + item.paidCny, 0);
    const shipping = cameras.reduce((sum, item) => sum + item.shippingCny, 0);
    const landed = paid + shipping;
    const target = cameras.reduce((sum, item) => sum + item.targetSaleCny, 0);
    const totalWeight = cameras.reduce((sum, item) => sum + item.weightG, 0);
    const weightedRate = cameras.reduce((sum, item) => sum + item.purchaseJpy, 0)
      ? paid / cameras.reduce((sum, item) => sum + item.purchaseJpy, 0)
      : 0;
    return {
      paid,
      shipping,
      landed,
      target,
      totalWeight,
      weightedRate,
      roi: landed ? ((target - landed) / landed) * 100 : 0,
    };
  }, [cameras]);

  const sortedByCapital = useMemo(
    () => [...cameras].sort((a, b) => b.paidCny - a.paidCny),
    [cameras],
  );

  const concentration = totals.paid
    ? ((sortedByCapital[0]?.paidCny ?? 0) + (sortedByCapital[1]?.paidCny ?? 0)) / totals.paid * 100
    : 0;

  const donutStops = sortedByCapital.reduce<{ cursor: number; stops: string[] }>((result, camera, index) => {
    const end = result.cursor + (totals.paid ? (camera.paidCny / totals.paid) * 100 : 0);
    return {
      cursor: end,
      stops: [...result.stops, `${palette[index % palette.length]} ${result.cursor.toFixed(2)}% ${end.toFixed(2)}%`],
    };
  }, { cursor: 0, stops: [] }).stops;

  const calcCamera = cameras.find((camera) => camera.id === calcId);
  const calcCost = calcCamera ? landedCost(calcCamera) : totals.landed;
  const calcTarget = calcCamera ? calcCamera.targetSaleCny : totals.target;
  const feeValue = salePrice * (platformFee / 100);
  const netProceeds = salePrice - feeValue - extraCosts;
  const profit = netProceeds - calcCost;
  const roi = calcCost ? (profit / calcCost) * 100 : 0;
  const breakEven = platformFee < 100 ? (calcCost + extraCosts) / (1 - platformFee / 100) : 0;

  const scenarios = [
    { label: "保守", value: totals.target * 0.858, tone: "risk" },
    { label: "基准", value: totals.target, tone: "base" },
    { label: "乐观", value: totals.target * 1.21, tone: "upside" },
  ].map((item) => ({
    ...item,
    roi: totals.landed ? ((item.value - totals.landed) / totals.landed) * 100 : 0,
  }));

  const selectCalculatorAsset = (id: string) => {
    setCalcId(id);
    const camera = cameras.find((item) => item.id === id);
    setSalePrice(Math.round(camera ? camera.targetSaleCny : totals.target));
  };

  const addCamera = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const purchaseJpy = Number(form.get("purchaseJpy")) || 0;
    const paidCny = Number(form.get("paidCny")) || 0;
    const shippingCny = Number(form.get("shippingCny")) || 0;
    const model = String(form.get("model") || "未命名资产").trim();
    const created: Camera = {
      id: `custom-${Date.now()}`,
      brand: String(form.get("brand") || "其他").trim(),
      model,
      purchaseJpy,
      paidCny,
      exchangeRate: purchaseJpy ? paidCny / purchaseJpy : 0,
      weightG: Number(form.get("weightG")) || 0,
      batchId: "unassigned",
      status: "待入库",
      shippingCny,
      shippingEstimate: true,
      targetSaleCny: Number(form.get("targetSaleCny")) || paidCny + shippingCny,
      orderAt: new Date().toISOString().slice(0, 16).replace("T", " "),
      thesis: "新录入资产，等待补充市场估值与投资判断。",
      risk: "尚未完成状态核验，ROI 仅基于当前录入数据。",
      timeline: [{ label: "录入台账", at: new Date().toLocaleDateString("zh-CN") }],
      isCustom: true,
    };
    const custom = [...cameras.filter((item) => item.isCustom), created];
    setCameras([...seedCameras, ...custom]);
    try {
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify(custom));
    } catch {
      // Keep the new record in memory for the active session.
    }
    setShowAdd(false);
  };

  return (
    <main className="site-shell">
      <header className="site-header">
        <a className="wordmark" href="#top" aria-label="Lensfolio 首页">
          <span className="brand-disc">LF</span>
          <span><b>LENSFOLIO</b><small>CAMERA CAPITAL</small></span>
        </a>
        <nav aria-label="主导航">
          <a href="#overview">总览</a>
          <a href="#assets">资产</a>
          <a href="#logistics">物流</a>
          <a href="#roi">回报</a>
        </nav>
        <div className="as-of"><i />数据截至 2026.08.19</div>
      </header>

      <section className="intro-hero" id="top">
        <div className="intro-copy">
          <p className="section-kicker">PRIVATE ALTERNATIVE ASSETS / HONG KONG</p>
          <h1>每一台相机，<br /><span>都是一笔仓位。</span></h1>
          <p>从日本采购到香港落地，把成本、物流与潜在回报放进同一张资产负债表。</p>
        </div>
        <div className="hero-actions">
          <button className="button button-dark" type="button" onClick={() => setShowAdd(true)}>＋ 新增机器</button>
          <a className="button button-quiet" href="#roi">测算出售回报 ↘</a>
        </div>
      </section>

      <section className="kpi-strip" id="overview" aria-label="核心指标">
        <article className="kpi-card kpi-primary">
          <div><p>预计全部落地</p><span className="data-tag">含预算</span></div>
          <strong>{cny(totals.landed)}</strong>
          <small>商品 {cny(totals.paid)} + 物流 {cny(totals.shipping)}</small>
        </article>
        <article className="kpi-card">
          <p>商品采购投入</p>
          <strong>{cny(totals.paid)}</strong>
          <small>{cameras.length > 5 ? `${cameras.length} 笔资产记录` : "4 笔订单 · 人民币实付"}</small>
        </article>
        <article className="kpi-card">
          <p>当前机器数量</p>
          <strong>{cameras.length}<em> 台</em></strong>
          <small>{number(totals.totalWeight / 1000, 3)} kg 裸重</small>
        </article>
        <article className="kpi-card">
          <p>物流成本</p>
          <strong>{cny(totals.shipping)}</strong>
          <small>已付 ¥221 · 其余为预算</small>
        </article>
        <article className="kpi-card kpi-positive">
          <p>基准毛 ROI</p>
          <strong>{percent(totals.roi)}</strong>
          <small>基准估值 {cny(totals.target)}</small>
        </article>
      </section>

      <section className="overview-grid">
        <article className="card capital-card">
          <div className="card-heading">
            <div><p className="section-kicker">CAPITAL ALLOCATION</p><h2>资金占用结构</h2></div>
            <span className="outline-tag">商品本金</span>
          </div>
          <div className="capital-content">
            <div className="donut-wrap">
              <div className="donut" style={{ background: `conic-gradient(${donutStops.join(",")})` }}>
                <div><strong>{concentration.toFixed(1)}%</strong><span>前两大仓位</span></div>
              </div>
            </div>
            <div className="capital-legend">
              {sortedByCapital.slice(0, 6).map((camera, index) => (
                <div key={camera.id}>
                  <i style={{ background: palette[index % palette.length] }} />
                  <span><b>{camera.model}</b><small>{totals.paid ? (camera.paidCny / totals.paid * 100).toFixed(1) : 0}%</small></span>
                  <strong>{cny(camera.paidCny)}</strong>
                </div>
              ))}
            </div>
          </div>
          <div className="callout-line">
            <span>集中度</span>
            <p>Nikon 28Ti 与 Contax T2 决定组合的大部分盈亏，建议优先完成两台机器的功能检测。</p>
          </div>
        </article>

        <article className="card scenario-card">
          <div className="card-heading">
            <div><p className="section-kicker">VALUATION RANGE</p><h2>回报情景</h2></div>
            <span className="outline-tag">未扣平台费</span>
          </div>
          <div className="scenario-chart">
            <div className="zero-line"><span>0%</span></div>
            {scenarios.map((scenario) => (
              <div className="scenario-row" key={scenario.label}>
                <span>{scenario.label}</span>
                <div className="scenario-track">
                  <i className={scenario.tone} style={{ width: `${Math.max(4, Math.min(100, (scenario.roi + 5) / 45 * 100))}%` }} />
                </div>
                <strong className={scenario.roi >= 0 ? "positive-text" : "negative-text"}>{percent(scenario.roi)}</strong>
                <small>{cny(scenario.value)}</small>
              </div>
            ))}
          </div>
          <div className="scenario-note">
            <span>BASE</span>
            <p>基准估值沿用原始分析的 366,000 JPY 组合口径，折合约 {cny(totals.target)}。</p>
          </div>
        </article>
      </section>

      <section className="section-block" id="assets">
        <div className="section-heading">
          <div><p className="section-kicker">ASSET REGISTER</p><h2>资产明细</h2></div>
          <div className="section-meta"><b>{cameras.length}</b><span>台机器<br />逐台核算</span></div>
        </div>
        <div className="table-shell" role="region" aria-label="相机资产明细">
          <table className="asset-table">
            <thead>
              <tr>
                <th>资产</th><th>批次 / 状态</th><th>买入 JPY</th><th>实付 RMB</th><th>汇率</th><th>重量</th><th>物流分摊</th><th>预计落地</th><th>目标售价</th><th>潜在 ROI</th><th aria-label="操作" />
              </tr>
            </thead>
            <tbody>
              {cameras.map((camera, index) => {
                const cost = landedCost(camera);
                const rowRoi = cost ? (camera.targetSaleCny - cost) / cost * 100 : 0;
                return (
                  <tr key={camera.id}>
                    <td>
                      <span className="asset-name"><i style={{ background: palette[index % palette.length] }} /><span><b>{camera.brand}</b>{camera.model}</span></span>
                      {camera.allocationNote && <small className="estimate-label">套装均摊</small>}
                    </td>
                    <td><span className="batch-copy">{batchLabel(camera.batchId)}<small>{camera.status}</small></span></td>
                    <td>¥{number(camera.purchaseJpy)}</td>
                    <td>{cny(camera.paidCny)}</td>
                    <td>{camera.exchangeRate.toFixed(4)}</td>
                    <td>{number(camera.weightG)}g</td>
                    <td>{cny(camera.shippingCny)} {camera.shippingEstimate && <small className="estimate-label">E</small>}</td>
                    <td><b>{cny(cost)}</b></td>
                    <td>{cny(camera.targetSaleCny)}</td>
                    <td><span className={`roi-chip ${rowRoi >= 0 ? "gain" : "loss"}`}>{percent(rowRoi)}</span></td>
                    <td><a className="row-link" href={`/cameras/${camera.id}`} aria-label={`查看 ${camera.model} 详情`}>↗</a></td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        <div className="table-footnote"><span><b>E</b> 预算值</span><p>Canon 两台套装的人民币成本与重量按 50% 均摊；税费和维修费尚未计入落地成本。</p></div>
      </section>

      <section className="section-block" id="logistics">
        <div className="section-heading">
          <div><p className="section-kicker">LOGISTICS INTELLIGENCE</p><h2>物流分析</h2></div>
          <div className="section-meta"><b>EMS</b><span>日本仓<br />发往香港</span></div>
        </div>
        <div className="logistics-grid">
          {logisticsBatches.map((batch) => (
            <article className="logistics-card" key={batch.id}>
              <div className="batch-top">
                <div><span className={batch.estimate ? "batch-number estimated" : "batch-number"}>{batch.label}</span><h3>{batch.assets}</h3><p>{batch.route}</p></div>
                <span className={`batch-status ${batch.estimate ? "waiting" : "moving"}`}><i />{batch.status}</span>
              </div>
              <div className="batch-metrics">
                <div><span>承运方式</span><b>{batch.carrier}</b></div>
                <div><span>裸重 → 计费重</span><b>{number(batch.bareWeightG / 1000, 3)} → {batch.chargeableWeight}</b></div>
                <div><span>{batch.estimate ? "预算运费" : "已付运费"}</span><b>¥{batch.shippingJpy} JPY</b><small>{cny(batch.shippingCny)} RMB</small></div>
                <div><span>单机物流</span><b>{cny(batch.unitCostCny, 1)}</b><small>{batch.count} 台合单</small></div>
              </div>
              <ol className="batch-timeline">
                {batch.timeline.map((event, index) => (
                  <li key={event.label} className={event.at.includes("待") ? "future" : "done"}>
                    <i /><span>{event.label}</span><b>{event.at}</b>{index < batch.timeline.length - 1 && <em />}
                  </li>
                ))}
              </ol>
              <div className="batch-footer"><span>运费效率</span><strong>{batch.id === "batch-1" ? "包装增重 43%" : "预计单机成本降低 30.6%"}</strong><small>处理时长：{batch.duration}</small></div>
            </article>
          ))}
        </div>

        <div className="transit-detail card">
          <div className="card-heading">
            <div><p className="section-kicker">DOMESTIC LEAD TIME</p><h2>第二批日本境内时效</h2></div>
            <span className="outline-tag">付款 → 入库</span>
          </div>
          <div className="leadtime-grid">
            <div className="leadtime-item">
              <div><span>Nikon 28Ti</span><strong>3天 14小时 44分</strong></div>
              <div className="leadtime-bar"><i style={{ width: "100%" }} /><em style={{ left: "76%" }}>发货</em></div>
              <p><b>2天 17小时</b> 等待卖家发货 · <b>21小时 31分</b> 日本境内运输</p>
            </div>
            <div className="leadtime-item">
              <div><span>Canon 两台套装</span><strong>1天 12小时 01分</strong></div>
              <div className="leadtime-bar"><i style={{ width: "42%" }} /><em style={{ left: "15%" }}>发货</em></div>
              <p><b>12小时 55分</b> 等待卖家发货 · <b>23小时 06分</b> 日本境内运输</p>
            </div>
          </div>
        </div>
      </section>

      <section className="roi-section" id="roi">
        <div className="roi-copy">
          <p className="section-kicker light">EXIT MODEL / INTERACTIVE</p>
          <h2>出售前，先算清<br />真正能留下多少。</h2>
          <p>选择整组或单台资产，输入未来成交价、平台费和后续成本，即时得到净利润与 ROI。</p>
          <div className="formula-note"><span>公式</span><code>净利润 = 售价 − 平台费 − 额外成本 − 落地成本</code></div>
        </div>
        <div className="calculator-card">
          <label className="field-label">测算对象
            <select value={calcId} onChange={(event) => selectCalculatorAsset(event.target.value)}>
              <option value="portfolio">全部资产组合</option>
              {cameras.map((camera) => <option value={camera.id} key={camera.id}>{camera.model}</option>)}
            </select>
          </label>
          <div className="calculator-inputs">
            <label className="field-label">预计成交价（RMB）<span className="money-input"><i>¥</i><input aria-label="预计成交价" inputMode="decimal" value={salePrice} onChange={(event) => setSalePrice(Number(event.target.value))} /></span></label>
            <label className="field-label">平台手续费<span className="money-input"><input aria-label="平台手续费百分比" inputMode="decimal" value={platformFee} onChange={(event) => setPlatformFee(Number(event.target.value))} /><i>%</i></span></label>
            <label className="field-label">维修 / 销售运费<span className="money-input"><i>¥</i><input aria-label="额外成本" inputMode="decimal" value={extraCosts} onChange={(event) => setExtraCosts(Number(event.target.value))} /></span></label>
          </div>
          <div className="calc-benchmarks"><span>落地成本 <b>{cny(calcCost)}</b></span><span>账面目标 <button type="button" onClick={() => setSalePrice(Math.round(calcTarget))}>{cny(calcTarget)}</button></span><span>盈亏平衡 <b>{cny(breakEven)}</b></span></div>
          <div className="calculator-results">
            <div><span>净回款</span><strong>{cny(netProceeds)}</strong></div>
            <div><span>净利润</span><strong className={profit >= 0 ? "positive-text" : "negative-text"}>{profit >= 0 ? "+" : ""}{cny(profit)}</strong></div>
            <div className={roi >= 0 ? "result-highlight" : "result-highlight loss-bg"}><span>ROI</span><strong>{percent(roi)}</strong><small>{roi >= 0 ? "高于落地成本" : "低于盈亏平衡"}</small></div>
          </div>
        </div>
      </section>

      <footer className="site-footer">
        <div className="wordmark"><span className="brand-disc inverse">LF</span><span><b>LENSFOLIO</b><small>CAMERA CAPITAL</small></span></div>
        <p>原型数据以订单与实际人民币扣款为准。第二批物流、目标售价与套装拆分均为估算口径。</p>
        <a href="#top">返回顶部 ↑</a>
      </footer>

      {showAdd && (
        <div className="modal-backdrop" role="presentation">
          <section className="add-modal" role="dialog" aria-modal="true" aria-labelledby="add-title">
            <div className="modal-heading"><div><p className="section-kicker">NEW POSITION</p><h2 id="add-title">新增机器</h2></div><button type="button" onClick={() => setShowAdd(false)} aria-label="关闭新增机器窗口">×</button></div>
            <p className="modal-intro">新增记录会保存在当前浏览器，页面上的总额、资金占用与 ROI 会自动重算。</p>
            <form onSubmit={addCamera}>
              <div className="form-grid">
                <label>品牌<input name="brand" placeholder="例如 Nikon" required /></label>
                <label>型号<input name="model" placeholder="例如 35Ti" required /></label>
                <label>买入金额（JPY）<input name="purchaseJpy" type="number" min="0" placeholder="140000" required /></label>
                <label>人民币实付<input name="paidCny" type="number" min="0" step="0.01" placeholder="6200" required /></label>
                <label>裸重（g）<input name="weightG" type="number" min="0" placeholder="600" required /></label>
                <label>预计国际物流（RMB）<input name="shippingCny" type="number" min="0" step="0.01" placeholder="90" required /></label>
                <label className="wide-field">目标售价（RMB）<input name="targetSaleCny" type="number" min="0" step="0.01" placeholder="7600" required /></label>
              </div>
              <div className="modal-actions"><button className="button button-quiet" type="button" onClick={() => setShowAdd(false)}>取消</button><button className="button button-dark" type="submit">保存并重算</button></div>
            </form>
          </section>
        </div>
      )}
    </main>
  );
}
