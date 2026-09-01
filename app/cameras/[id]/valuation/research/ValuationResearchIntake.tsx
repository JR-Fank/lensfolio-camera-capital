"use client";

import { useRouter } from "next/navigation";
import { FormEvent, useState } from "react";

const examplePayload = `[
  {
    "externalListingId": "example-123",
    "title": "康泰时 T2 功能正常",
    "listingUrl": "https://example.com/item?id=123",
    "askingPrice": 6888,
    "currency": "CNY",
    "sellerName": "示例卖家",
    "listedAt": "2026-09-01T12:00:00+08:00",
    "capturedAt": "2026-09-01T12:30:00+08:00",
    "conditionText": "功能正常，有正常使用痕迹",
    "metadata": {}
  }
]`;

function parseIntake(value: string) {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new Error("JSON 无法解析，请检查逗号、引号和括号。");
  }

  const payload = parsed && typeof parsed === "object" && !Array.isArray(parsed)
    ? parsed as Record<string, unknown>
    : null;
  const listings = Array.isArray(parsed) ? parsed : payload?.listings;
  if (!Array.isArray(listings) || listings.length === 0) {
    throw new Error("研究样本必须是非空数组。");
  }
  listings.forEach((listing, index) => {
    if (!listing || typeof listing !== "object" || Array.isArray(listing)) {
      throw new Error(`第 ${index + 1} 条样本必须是 JSON object。`);
    }
    const row = listing as Record<string, unknown>;
    if (typeof row.title !== "string" || !row.title.trim()) {
      throw new Error(`第 ${index + 1} 条样本缺少 title。`);
    }
    const hasNumericPrice = (typeof row.askingPrice === "number"
      || (typeof row.askingPrice === "string" && row.askingPrice.trim() !== ""))
      && Number.isFinite(Number(row.askingPrice));
    if (!hasNumericPrice) {
      throw new Error(`第 ${index + 1} 条样本的 askingPrice 必须是数字。`);
    }
  });

  const suppliedTerms = Array.isArray(payload?.searchTerms)
    ? payload.searchTerms.filter((term): term is string => typeof term === "string" && Boolean(term.trim()))
    : [];
  return { listings, suppliedTerms };
}

export default function ValuationResearchIntake({
  assetId,
  canWrite,
  defaultSearchTerms,
}: {
  assetId: string;
  canWrite: boolean;
  defaultSearchTerms: string[];
}) {
  const router = useRouter();
  const [rawJson, setRawJson] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!canWrite || busy) return;
    setError("");

    try {
      const { listings, suppliedTerms } = parseIntake(rawJson);
      setBusy(true);
      const response = await fetch("/api/valuations/research", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          assetId,
          searchTerms: [...defaultSearchTerms, ...suppliedTerms],
          listings,
        }),
      });
      const result = await response.json() as { error?: string; reviewUrl?: string };
      if (!response.ok || !result.reviewUrl) {
        throw new Error(result.error || "研究样本导入失败。");
      }
      router.push(result.reviewUrl);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "研究样本导入失败。");
      setBusy(false);
    }
  };

  return (
    <form className="valuation-intake" onSubmit={submit}>
      {!canWrite && (
        <p className="valuation-permission-note" role="status">
          当前账户只有查看权限，不能创建估值研究。
        </p>
      )}
      <label htmlFor="valuation-research-json">
        <span>粘贴研究样本 JSON</span>
        <small>必填字段：title、askingPrice。其他证据字段均可留空。</small>
      </label>
      <textarea
        id="valuation-research-json"
        value={rawJson}
        onChange={(event) => setRawJson(event.target.value)}
        placeholder="粘贴 listings JSON array"
        spellCheck={false}
        disabled={!canWrite || busy}
        aria-describedby="valuation-intake-guidance"
      />
      <p id="valuation-intake-guidance" className="valuation-intake-guidance">
        此页面不会自动登录或抓取闲鱼。请将浏览器、Codex 或人工采集结果粘贴到这里。
      </p>
      <details className="valuation-intake-example">
        <summary>查看 JSON 示例</summary>
        <pre>{examplePayload}</pre>
        <small>高级说明：提交后由 Lensfolio research API 执行型号判断、去重、筛选与统计。</small>
      </details>
      {error && <p className="valuation-intake-error" role="alert">{error}</p>}
      <button className="primary-action" type="submit" disabled={!canWrite || busy}>
        {busy ? "正在导入…" : "导入并开始复核"}
      </button>
    </form>
  );
}
