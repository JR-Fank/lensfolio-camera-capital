"use client";

import { useEffect, useRef, useState } from "react";
import { aggregateValuationTrend, trendLabelIndices } from "../lib/valuation-trend";
import type { ValuationHistoryView } from "../db/queries";

const money = (value: number) => new Intl.NumberFormat("zh-CN", {
  style: "currency", currency: "CNY", maximumFractionDigits: 2,
}).format(value);

export default function MarketValueTrend({ valuations }: { valuations: ValuationHistoryView[] }) {
  const container = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(0);
  useEffect(() => {
    if (!container.current) return;
    const observer = new ResizeObserver(([entry]) => setWidth(entry.contentRect.width));
    observer.observe(container.current);
    return () => observer.disconnect();
  }, []);
  const points = aggregateValuationTrend(valuations);
  const max = Math.max(1, ...points.map((point) => point.value));
  const indices = trendLabelIndices(points.length, width);
  return <article className="chart-card valuation-trend">
    <header className="chart-head"><div><p>MARK TO MARKET</p><h3>市场价格趋势</h3></div><span>组合市场中位价</span></header>
    <div ref={container}>
      {points.length ? <>
        <div className="market-trend-bars" role="list" aria-label="各业务日期估值合计">
          {points.map((point) => <div key={point.day} role="listitem" aria-label={`${point.day}，${money(point.value)}，${point.assetCount} 台资产`} title={`${point.day} · ${money(point.value)} · ${point.assetCount} 台资产`}>
            <i style={{ height: `${point.value / max * 100}%` }} />
          </div>)}
        </div>
        <div className="market-trend-axis" aria-hidden="true">{indices.map((index) => <span key={points[index].day} style={{ left: `clamp(24px, ${(index + 0.5) / points.length * 100}%, calc(100% - 24px))` }}>{points[index].label}</span>)}</div>
        <details className="market-trend-details"><summary>查看 {points.length} 个日期的估值</summary>
          <dl>{points.map((point) => <div key={point.day}><dt>{point.day}<small>{point.assetCount} 台</small></dt><dd>{money(point.value)}</dd></div>)}</dl>
        </details>
      </> : <p className="chart-empty strong-empty">暂无估值历史</p>}
    </div>
    <p className="chart-empty">香港时间 · 每台资产每日仅取最新估值，仅合计当日有记录的资产；未补齐缺失历史。</p>
  </article>;
}
