import "server-only";

import { cache } from "react";
import {
  projectCapitalLedger, type AccountRow, type AllocationRow, type AssetRow,
  type ParticipantRow, type PoolRow, type SourceRow, type TransactionRow,
} from "../capital-ledger";
import { getPortfolioAccess } from "./portfolio-access";
import { createClient } from "./server";

export const getCapitalLedgerData = cache(async () => {
  const { portfolioId } = await getPortfolioAccess();
  const supabase = await createClient();

  // Read every page; PostgREST's default row cap must not silently truncate the ledger.
  async function all<T>(table: string, columns: string, order: string, postedOnly = false): Promise<T[]> {
    const result: T[] = [];
    const pageSize = 500;
    for (let offset = 0; ; offset += pageSize) {
      let query = supabase.from(table).select(columns).eq("portfolio_id", portfolioId).order(order);
      if (postedOnly) query = query.eq("transaction_status", "posted");
      const { data, error } = await query.range(offset, offset + pageSize - 1);
      if (error || !data) throw new Error("资金账本读取失败，请稍后重试。");
      result.push(...data as T[]);
      if (data.length < pageSize) return result;
    }
  }
  const [participants, pools, accounts, transactions, allocations, sales, costs, purchases, assets, metrics] = await Promise.all([
    all<ParticipantRow>("funding_participant_contributions", "participant_id,display_name,gross_contribution_cny,reversed_or_distributed_cny,net_contribution_cny", "participant_id"),
    all<PoolRow>("sales_proceeds_pool_balances", "account_id,gross_inflow_cny,gross_outflow_cny,balance_cny", "account_id"),
    all<AccountRow>("funding_account_balances", "account_id,account_kind,participant_id", "account_id"),
    all<TransactionRow>("funding_transactions", "id,transaction_kind,amount_cny,occurred_at,occurred_on,sale_id,purchase_item_id,cost_entry_id,shipment_id,reversal_of,note", "id", true),
    all<AllocationRow>("funding_allocations", "transaction_id,account_id,amount_cny", "id"),
    all<SourceRow>("sales", "id,asset_id", "id"),
    all<SourceRow>("cost_entries", "id,asset_id", "id"),
    all<SourceRow>("purchase_items", "id,asset_id", "id"),
    all<AssetRow>("assets", "id,brand,model", "id"),
    supabase.from("portfolio_metrics").select("realized_profit_cny").eq("portfolio_id", portfolioId).single(),
  ]);
  if (metrics.error || !metrics.data) throw new Error("已实现利润读取失败，请稍后重试。");
  // Profit is derived by the existing cost/sale view, never by funding allocations.
  return projectCapitalLedger({
    participants: participants.sort((a, b) => a.display_name.localeCompare(b.display_name)),
    pools, accounts, transactions, allocations, sales, costs, purchases, assets,
    realizedProfit: metrics.data.realized_profit_cny,
  });
});
