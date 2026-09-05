export const transactionKindLabels = {
  sale_proceeds: "销售回款", purchase_funding: "采购出资", cost_funding: "费用出资",
  refund: "退款", distribution: "分配", adjustment: "调整", reversal: "冲销",
} as const;

export function capitalTransactionKind(kind: string): string {
  return Object.hasOwn(transactionKindLabels, kind)
    ? transactionKindLabels[kind as keyof typeof transactionKindLabels] : "其他资金事件";
}

export function capitalOccurrence(occurredAt: string | null, occurredOn: string | null): string {
  // occurred_on is evidence of a calendar date, never evidence of midnight.
  if (!occurredAt) return occurredOn ?? "日期未记录";
  const occurrence = new Date(occurredAt);
  return new Intl.DateTimeFormat("sv-SE", {
    timeZone: "Asia/Hong_Kong", year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit",
    second: occurrence.getUTCSeconds() === 0 ? undefined : "2-digit", hourCycle: "h23",
  }).format(occurrence);
}

/** Remove technical identifiers even when embedded in otherwise useful notes/names. */
export function capitalVisibleText(value: string | null): string | null {
  if (!value) return null;
  const text = value
    .replace(/\b(?:idempotency|provenance)(?:[_ -]?key)?\s*[:=]\s*["']?[^\s,;"']+["']?/gi, "")
    .replace(/\bconfirmed-capital-[a-z0-9_:./-]+/gi, "")
    .replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, "")
    .replace(/\bConfirmed capital funding v\d+\b/gi, "")
    .replace(/\s+/g, " ").replace(/^[\s,;·|]+|[\s,;·|]+$/g, "").trim();
  return text || null;
}

type Money = number | string;
export type ParticipantRow = {
  participant_id: string; display_name: string; gross_contribution_cny: Money;
  reversed_or_distributed_cny: Money; net_contribution_cny: Money;
};
export type PoolRow = { account_id: string; gross_inflow_cny: Money; gross_outflow_cny: Money; balance_cny: Money };
export type AccountRow = { account_id: string; account_kind: string; participant_id: string | null };
export type TransactionRow = {
  id: string; transaction_kind: string; amount_cny: Money; occurred_at: string | null;
  occurred_on: string | null; sale_id: string | null; purchase_item_id: string | null;
  cost_entry_id: string | null; shipment_id: string | null; reversal_of: string | null; note: string | null;
};
export type AllocationRow = { transaction_id: string; account_id: string; amount_cny: Money };
export type SourceRow = { id: string; asset_id: string };
export type AssetRow = { id: string; brand: string; model: string };
export type CapitalLedgerData = {
  participants: { name: string; gross: number; returned: number; net: number }[];
  pool: { inflow: number; outflow: number; balance: number } | null;
  realizedProfit: number;
  transactions: {
    occurrence: string; kind: string; amount: number; source: string; note: string | null;
    allocations: { account: string; amount: number }[];
  }[];
};

function money(value: Money): number {
  if ((typeof value !== "number" && typeof value !== "string") || value === "" || !Number.isFinite(Number(value))) {
    throw new Error("Invalid capital ledger amount.");
  }
  return Number(value);
}

/** Explicit presentation projection: no raw rows or internal IDs cross into the UI. */
export function projectCapitalLedger(input: {
  participants: ParticipantRow[]; pools: PoolRow[]; accounts: AccountRow[];
  transactions: TransactionRow[]; allocations: AllocationRow[];
  sales: SourceRow[]; costs: SourceRow[]; purchases: SourceRow[]; assets: AssetRow[];
  realizedProfit: Money;
}): CapitalLedgerData {
  const participantNames = new Map(input.participants.map((row) => [row.participant_id, capitalVisibleText(row.display_name) ?? "参与人"]));
  const accounts = new Map(input.accounts.map((row) => [row.account_id, row.account_kind === "sales_proceeds_pool"
    ? "销售回款池" : `${participantNames.get(row.participant_id ?? "") ?? "参与人"} · 出资账户`]));
  const assets = new Map(input.assets.map((row) => [row.id, capitalVisibleText(`${row.brand} ${row.model}`)]));
  const sales = new Map(input.sales.map((row) => [row.id, row.asset_id]));
  const costs = new Map(input.costs.map((row) => [row.id, row.asset_id]));
  const purchases = new Map(input.purchases.map((row) => [row.id, row.asset_id]));
  const transactions = new Map(input.transactions.map((row) => [row.id, row]));
  const allocations = new Map<string, CapitalLedgerData["transactions"][number]["allocations"]>();
  for (const row of input.allocations) {
    if (!transactions.has(row.transaction_id)) continue;
    const account = accounts.get(row.account_id);
    if (!account) throw new Error("Funding allocation account is missing.");
    const entries = allocations.get(row.transaction_id) ?? [];
    entries.push({ account, amount: money(row.amount_cny) });
    allocations.set(row.transaction_id, entries);
  }
  function source(row: TransactionRow): string {
    const evidence = row.reversal_of ? transactions.get(row.reversal_of) ?? row : row;
    const assetId = sales.get(evidence.sale_id ?? "") ?? costs.get(evidence.cost_entry_id ?? "") ?? purchases.get(evidence.purchase_item_id ?? "");
    const name = assetId ? assets.get(assetId) : null;
    const label = evidence.sale_id ? "销售" : evidence.purchase_item_id ? "采购" : evidence.shipment_id ? "物流费用" : evidence.cost_entry_id ? "资产费用" : "资金账户";
    const prefix = row.transaction_kind === "refund" ? "退款 · " : row.transaction_kind === "reversal" ? "冲销 · " : "";
    return `${prefix}${label}${name ? ` · ${name}` : ""}`;
  }
  if (input.pools.length > 1) throw new Error("Expected at most one sales proceeds pool.");
  const pool = input.pools[0];
  return {
    participants: input.participants.map((row) => ({
      name: participantNames.get(row.participant_id)!, gross: money(row.gross_contribution_cny),
      returned: money(row.reversed_or_distributed_cny), net: money(row.net_contribution_cny),
    })),
    pool: pool ? { inflow: money(pool.gross_inflow_cny), outflow: money(pool.gross_outflow_cny), balance: money(pool.balance_cny) } : null,
    realizedProfit: money(input.realizedProfit),
    transactions: input.transactions.map((row) => {
      const entries = allocations.get(row.id) ?? [];
      if (!entries.length || entries.reduce((sum, entry) => sum + Math.round(Math.abs(entry.amount) * 100), 0) !== Math.round(money(row.amount_cny) * 100)) {
        throw new Error("Posted funding allocations do not reconcile.");
      }
      return {
        occurrence: capitalOccurrence(row.occurred_at, row.occurred_on),
        kind: capitalTransactionKind(row.transaction_kind), amount: money(row.amount_cny),
        source: source(row), note: capitalVisibleText(row.note), allocations: entries,
      };
    }).sort((a, b) => b.occurrence.slice(0, 10).localeCompare(a.occurrence.slice(0, 10))),
  };
}
