import type { CapitalLedgerData } from "../../lib/capital-ledger";

const cny = (value: number) => new Intl.NumberFormat("zh-CN", {
  style: "currency", currency: "CNY", minimumFractionDigits: 0, maximumFractionDigits: 2,
}).format(value);
const signed = (value: number) => `${value < 0 ? "−" : "+"}${cny(Math.abs(value))}`;

export default function CapitalLedgerView({ data }: { data: CapitalLedgerData }) {
  return <div className="capital-ledger-page">
    <section className="capital-metrics" aria-label="资金核心指标">
      <article className="capital-metric pool-metric"><small>销售回款池余额</small><strong>{data.pool ? cny(data.pool.balance) : "—"}</strong><span>可用回款 · 全部净回款的留存</span></article>
      {data.participants.map((participant, index) => <article className="capital-metric" key={index}><small>{participant.name} 累计净投入</small><strong>{cny(participant.net)}</strong><span>累计出资扣除退款、冲销与分配</span></article>)}
      <article className="capital-metric"><small>已实现利润</small><strong>{cny(data.realizedProfit)}</strong><span>已售资产净回款 − 真实持有成本</span></article>
    </section>

    <aside className="capital-explainer" aria-label="资金与利润口径">
      <strong>销售回款池 ≠ 利润</strong>
      <div><p>销售发生后，全部净回款进入销售回款池，可用于后续采购与费用。利润是销售净回款减去该资产的真实持有成本（carrying cost）。</p>
      <p><code>cost_entries</code> 仍然是资产成本的唯一真相。资金账本只说明“钱从哪里来、去了哪里”，不修改资产成本基数（cost basis）或 ROI。</p></div>
    </aside>

    <section className="capital-section" aria-labelledby="participants-title">
      <header><div><p className="eyebrow">PARTICIPANT CAPITAL</p><h2 id="participants-title">参与人资金</h2></div><span>{data.participants.length} 位参与人</span></header>
      <div className="capital-participants">{data.participants.map((participant, index) => <article key={index}><h3>{participant.name}</h3><dl>
        <div><dt>累计出资</dt><dd>{cny(participant.gross)}</dd></div>
        <div><dt>退款 / 冲销 / 分配</dt><dd>{cny(participant.returned)}</dd></div>
        <div className="capital-total"><dt>累计净投入</dt><dd>{cny(participant.net)}</dd></div>
      </dl></article>)}</div>
      {!data.participants.length && <p className="capital-empty">暂无参与人资金记录。</p>}
    </section>

    <section className="capital-section" aria-labelledby="pool-title">
      <header><div><p className="eyebrow">SALES PROCEEDS</p><h2 id="pool-title">销售回款池</h2></div><span>资金账户收支</span></header>
      {data.pool ? <dl className="capital-pool-summary">
        <div><dt>累计流入</dt><dd>{cny(data.pool.inflow)}</dd></div>
        <div><dt>累计流出</dt><dd>{cny(data.pool.outflow)}</dd></div>
        <div className="capital-total"><dt>当前余额</dt><dd>{cny(data.pool.balance)}</dd></div>
      </dl> : <p className="capital-empty">尚未设立销售回款池。</p>}
    </section>

    <section className="capital-section" aria-labelledby="transactions-title">
      <header><div><p className="eyebrow">POSTED TRANSACTIONS</p><h2 id="transactions-title">资金流水</h2></div><span>{data.transactions.length} 条已入账事件 · 只读</span></header>
      <p className="capital-section-note">时间按香港时区显示；仅有日期证据的事件只显示日期，同日内不推定先后。账户金额的正负号表示该账户余额或净投入的增减。</p>
      <ol className="capital-transactions">{data.transactions.map((transaction, index) => <li key={index}>
        <article>
          <div className="capital-transaction-main"><p>{transaction.occurrence}</p><h3>{transaction.kind}</h3><p className="capital-source">{transaction.source}</p><dl className="capital-allocations">{transaction.allocations.map((allocation, allocationIndex) => <div key={allocationIndex}><dt>{allocation.account}</dt><dd>{signed(allocation.amount)}</dd></div>)}</dl><strong>{cny(transaction.amount)}</strong></div>
          {transaction.note && <p className="capital-note">{transaction.note}</p>}
        </article>
      </li>)}</ol>
      {!data.transactions.length && <p className="capital-empty">暂无已入账资金事件。</p>}
    </section>
  </div>;
}
