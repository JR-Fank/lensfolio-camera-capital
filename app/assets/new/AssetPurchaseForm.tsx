"use client";

import { useActionState } from "react";
import { createAssetWithPurchase, type CreateAssetState } from "./actions";

const initialState: CreateAssetState = { error: null };

export default function AssetPurchaseForm({ defaultPurchaseDate }: { defaultPurchaseDate: string }) {
  const [state, formAction, pending] = useActionState(createAssetWithPurchase, initialState);

  return (
    <form className="asset-entry-form" action={formAction}>
      <section className="entry-section" aria-labelledby="asset-fields-title">
        <header><p>01 / ASSET</p><h2 id="asset-fields-title">相机信息</h2><span>建立一台独立实体资产。</span></header>
        <div className="entry-fields">
          <label><span>品牌 *</span><input name="brand" required autoComplete="off" placeholder="例如 Contax" /></label>
          <label><span>型号 *</span><input name="model" required autoComplete="off" placeholder="例如 T2 Date Back" /></label>
          <label><span>购买日期 *</span><input name="purchase_date" type="date" required defaultValue={defaultPurchaseDate} /></label>
          <label><span>人民币实付 *</span><span className="money-input"><i>¥</i><input name="actual_paid_cny" type="number" inputMode="decimal" min="0.01" step="0.01" required placeholder="0.00" /></span></label>
          <label><span>序列号</span><input name="serial_number" autoComplete="off" /></label>
          <label><span>实测重量 g</span><input name="measured_weight_g" type="number" inputMode="numeric" min="1" step="1" placeholder="未测量请留空" /></label>
          <label><span>成色</span><input name="condition" autoComplete="off" placeholder="例如 A− / 有轻微使用痕迹" /></label>
          <label><span>当前状态</span><select name="status" defaultValue="acquired"><option value="acquired">已采购</option><option value="in_transit">运输中</option><option value="in_storage">已入库</option><option value="inspection">检测中</option><option value="repair">维修中</option><option value="ready_for_sale">可出售</option><option value="listed">已挂牌</option><option value="sold">已出售</option><option value="retired">已退役</option></select></label>
          <label className="entry-wide"><span>备注</span><textarea name="notes" rows={4} placeholder="可记录来源、附件或待确认事项" /></label>
        </div>
      </section>

      <details className="purchase-details">
        <summary><span><b>02 / PURCHASE DETAIL</b><strong>日元采购详情</strong></span><em>可选展开</em></summary>
        <div className="entry-fields">
          <label><span>日本购买价 JPY</span><input name="purchase_price_jpy" type="number" inputMode="decimal" min="0.01" step="0.01" placeholder="留空则按 CNY 采购" /></label>
          <label><span>实际汇率 JPY → CNY</span><input name="exchange_rate_jpy_to_cny" type="number" inputMode="decimal" min="0.0000000001" step="0.0000000001" placeholder="与日元购买价同时填写" /></label>
          <label><span>采购平台</span><input name="platform" autoComplete="off" placeholder="例如 Mercari / 任意门" /></label>
          <label><span>订单号 / Reference</span><input name="order_reference" autoComplete="off" /></label>
        </div>
      </details>

      <aside className="entry-accounting-note">
        <span>ATOMIC LEDGER</span>
        <p>一次保存同时建立资产、采购订单、采购明细和一笔已入账采购成本。任一步失败，整笔操作都会回滚。</p>
        <strong>真实成本以人民币实付为准</strong>
      </aside>

      {state.error && <p className="entry-error" role="alert">{state.error}</p>}
      <button className="entry-submit" type="submit" disabled={pending}>{pending ? "正在写入四张台账…" : "保存资产与采购成本"}</button>
    </form>
  );
}
