"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import type {
  ValuationResearchListing,
  ValuationResearchRun,
} from "../../../../../../lib/supabase/valuations";
import {
  exclusionReasons,
  type ExclusionReason,
  type ListingReviewStatus,
} from "../../../../../../lib/valuation/xianyu";

const cny = (value: number | null) => value === null
  ? "—"
  : new Intl.NumberFormat("zh-CN", { style: "currency", currency: "CNY", maximumFractionDigits: 2 }).format(value);

const dateTime = (value: string | null) => value
  ? new Intl.DateTimeFormat("zh-CN", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    timeZone: "Asia/Hong_Kong",
  }).format(new Date(value))
  : "未记录";

const exclusionLabels: Record<ExclusionReason, string> = {
  accessory: "配件",
  wanted: "求购",
  wrong_model: "型号不符",
  body_or_shell_only: "空壳 / 拆机件",
  broken_or_junk: "故障 / 尸体机",
  collector_premium: "收藏级溢价",
  different_variant: "不同版本",
  duplicate: "重复挂牌",
  suspicious_price: "异常价格",
  insufficient_information: "信息不足",
};

export default function ValuationResearchReview({
  asset,
  canWrite,
  initialListings,
  initialRun,
}: {
  asset: { id: string; brand: string; model: string };
  canWrite: boolean;
  initialListings: ValuationResearchListing[];
  initialRun: ValuationResearchRun;
}) {
  const router = useRouter();
  const [run, setRun] = useState(initialRun);
  const [listings, setListings] = useState(initialListings);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [notice, setNotice] = useState("");
  const closed = run.status === "confirmed" || run.status === "cancelled";
  const pendingCount = listings.filter((listing) => listing.review_status === "pending").length;
  const canConfirm = canWrite
    && !closed
    && run.included_count > 0
    && pendingCount === 0
    && busyId === null;

  const updateListing = async (
    listing: ValuationResearchListing,
    reviewStatus: ListingReviewStatus,
    exclusionReason: ExclusionReason | null = null,
  ) => {
    if (!canWrite || closed) return;
    setBusyId(listing.id);
    setNotice("");
    try {
      const response = await fetch("/api/valuations/research", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          runId: run.id,
          listingId: listing.id,
          reviewStatus,
          exclusionReason: reviewStatus === "excluded" ? exclusionReason || "insufficient_information" : null,
        }),
      });
      const result = await response.json() as { error?: string; run?: ValuationResearchRun };
      if (!response.ok || !result.run) throw new Error(result.error || "样本复核失败。");
      setRun(result.run);
      setListings((current) => current.map((item) => item.id === listing.id ? {
        ...item,
        review_status: reviewStatus,
        exclusion_reason: reviewStatus === "excluded" ? exclusionReason || "insufficient_information" : null,
      } : item));
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "样本复核失败。");
    } finally {
      setBusyId(null);
    }
  };

  const confirm = async () => {
    if (!canConfirm) return;
    setBusyId("confirm");
    setNotice("");
    try {
      const response = await fetch("/api/valuations/confirm", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ runId: run.id }),
      });
      const result = await response.json() as { error?: string };
      if (!response.ok) throw new Error(result.error || "确认估值失败。");
      router.push(`/cameras/${asset.id}`);
      router.refresh();
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "确认估值失败。");
      setBusyId(null);
    }
  };

  const cancel = async () => {
    if (!canWrite || closed || busyId !== null) return;
    setBusyId("cancel");
    setNotice("");
    try {
      const response = await fetch("/api/valuations/research", {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ runId: run.id }),
      });
      const result = await response.json() as { error?: string; run?: ValuationResearchRun };
      if (!response.ok || !result.run) throw new Error(result.error || "取消研究失败。");
      router.push(`/cameras/${asset.id}`);
      router.refresh();
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "取消研究失败。");
    } finally {
      setBusyId(null);
    }
  };

  const groups: Array<{ status: ListingReviewStatus; title: string }> = [
    { status: "included", title: "Included · 纳入样本" },
    { status: "pending", title: "Pending · 待人工判断" },
    { status: "excluded", title: "Excluded · 已排除" },
  ];

  return (
    <main className="valuation-research-shell">
      <header className="valuation-research-topbar"><Link href={`/cameras/${asset.id}`}>← 返回机器详情</Link><span>{run.status}</span></header>
      <section className="valuation-research-head">
        <p className="eyebrow">XIANYU MARKET RESEARCH</p>
        <h1>闲鱼挂牌价研究</h1>
        <p>{asset.brand} {asset.model}</p>
        <strong>以下均为闲鱼挂牌价 asking prices，不代表真实成交价。</strong>
      </section>
      <section className="valuation-run-summary">
        <div className="valuation-run-terms"><small>搜索词</small><p>{run.search_terms.map((term) => <span key={term}>{term}</span>)}</p></div>
        <dl>
          <div><dt>原始样本</dt><dd>{run.raw_count}</dd></div>
          <div><dt>去重后</dt><dd>{run.deduplicated_count}</dd></div>
          <div><dt>纳入样本</dt><dd>{run.included_count}</dd></div>
          <div><dt>研究置信度</dt><dd>{run.confidence === null ? "—" : `${Math.round(run.confidence * 100)}%`}</dd></div>
        </dl>
        <div className="valuation-statistics"><span><small>P25</small><b>{cny(run.p25_cny)}</b></span><span className="median"><small>Median</small><b>{cny(run.median_cny)}</b></span><span><small>P75</small><b>{cny(run.p75_cny)}</b></span><span><small>Sample count</small><b>{run.sample_count}</b></span></div>
      </section>
      {groups.map((group) => {
        const rows = listings.filter((listing) => listing.review_status === group.status);
        return (
          <section className="valuation-listing-group" key={group.status}>
            <header><h2>{group.title}</h2><span>{rows.length}</span></header>
            {rows.length ? <div className="valuation-listing-list">{rows.map((listing) => (
              <article key={listing.id}>
                <div className="valuation-listing-main"><small>{listing.seller_name || "卖家未记录"}</small><h3>{listing.title}</h3><strong>{cny(Number(listing.asking_price))}</strong><p>{listing.condition_text || "成色信息未记录"}</p>{listing.listing_url && <a href={listing.listing_url} target="_blank" rel="noreferrer">查看原挂牌 ↗</a>}</div>
                <div className="valuation-listing-review"><small>采集于 {dateTime(listing.captured_at)}</small><label>复核结果<select disabled={!canWrite || closed || busyId === listing.id} value={listing.review_status} onChange={(event) => updateListing(listing, event.target.value as ListingReviewStatus, listing.exclusion_reason)}><option value="pending">待复核</option><option value="included">纳入</option><option value="excluded">排除</option></select></label>{listing.review_status === "excluded" && <label>排除原因<select disabled={!canWrite || closed || busyId === listing.id} value={listing.exclusion_reason || "insufficient_information"} onChange={(event) => updateListing(listing, "excluded", event.target.value as ExclusionReason)}>{exclusionReasons.map((reason) => <option value={reason} key={reason}>{exclusionLabels[reason]}</option>)}</select></label>}</div>
              </article>
            ))}</div> : <p className="valuation-empty">暂无此类样本。</p>}
          </section>
        );
      })}
      {notice && <p className="valuation-research-notice" role="alert">{notice}</p>}
      <footer className="valuation-research-actions">
        <Link href={`/cameras/${asset.id}`}>返回，不改变正式估值</Link>
        <div className="valuation-research-controls">
          {pendingCount > 0 && !closed && (
            <p>还有 {pendingCount} 条待复核样本，全部处理后才能采用估值。</p>
          )}
          <div>
            <button type="button" disabled={!canWrite || closed || busyId !== null} onClick={cancel}>取消研究</button>
            <button className="primary-action" type="button" disabled={!canConfirm} onClick={confirm}>采用此估值</button>
          </div>
        </div>
      </footer>
    </main>
  );
}
