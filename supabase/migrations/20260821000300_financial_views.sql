-- Lensfolio Supabase foundation: read-only financial projections.
-- Every ROI is profit / total_cost. No view uses profit / selling_price.

create view public.asset_financials
with (security_invoker = true)
as
with posted_costs as (
  select
    entry.portfolio_id,
    entry.asset_id,
    sum(
      case when coalesce(original.cost_type, entry.cost_type) = 'purchase'
        then entry.amount_cny else 0 end
    ) as acquisition_cost_cny,
    sum(
      case when coalesce(original.cost_type, entry.cost_type) in ('domestic_shipping', 'international_shipping')
        then entry.amount_cny else 0 end
    ) as logistics_cost_cny,
    sum(
      case when coalesce(original.cost_type, entry.cost_type) = 'repair'
        then entry.amount_cny else 0 end
    ) as repair_cost_cny,
    sum(
      case when coalesce(original.cost_type, entry.cost_type) in ('other', 'adjustment')
        then entry.amount_cny else 0 end
    ) as other_cost_cny,
    sum(entry.amount_cny) as total_carrying_cost_cny
  from public.cost_entries entry
  left join public.cost_entries original on original.id = entry.reversal_of
  where entry.entry_status = 'posted'
  group by entry.portfolio_id, entry.asset_id
),
latest_valuations as (
  select distinct on (portfolio_id, asset_id)
    portfolio_id,
    asset_id,
    id as valuation_snapshot_id,
    median as current_valuation_cny,
    valued_at
  from public.valuation_snapshots
  order by portfolio_id, asset_id, valued_at desc, id desc
),
completed_sales as (
  select
    portfolio_id,
    asset_id,
    id as sale_id,
    sold_price_cny,
    platform_fees_cny,
    outbound_shipping_cny,
    net_proceeds_cny,
    sold_at
  from public.sales
  where status = 'sold'
)
select
  asset.portfolio_id,
  asset.id as asset_id,
  asset.brand,
  asset.model,
  asset.operational_status,
  coalesce(cost.acquisition_cost_cny, 0::numeric) as acquisition_cost_cny,
  coalesce(cost.logistics_cost_cny, 0::numeric) as logistics_cost_cny,
  coalesce(cost.repair_cost_cny, 0::numeric) as repair_cost_cny,
  coalesce(cost.other_cost_cny, 0::numeric) as other_cost_cny,
  coalesce(cost.total_carrying_cost_cny, 0::numeric) as total_carrying_cost_cny,
  valuation.valuation_snapshot_id,
  valuation.current_valuation_cny,
  valuation.valued_at,
  sale.sale_id,
  sale.sold_price_cny,
  sale.platform_fees_cny,
  sale.outbound_shipping_cny,
  sale.net_proceeds_cny,
  sale.sold_at,
  case
    when sale.sale_id is null and valuation.current_valuation_cny is not null
      then valuation.current_valuation_cny - coalesce(cost.total_carrying_cost_cny, 0::numeric)
    else null
  end as unrealized_profit_cny,
  case
    when sale.sale_id is not null
      then sale.net_proceeds_cny - coalesce(cost.total_carrying_cost_cny, 0::numeric)
    else null
  end as realized_profit_cny,
  case
    when sale.sale_id is null
      and valuation.current_valuation_cny is not null
      and coalesce(cost.total_carrying_cost_cny, 0::numeric) <> 0
      then (valuation.current_valuation_cny - cost.total_carrying_cost_cny)
        / cost.total_carrying_cost_cny
    else null
  end as unrealized_roi,
  case
    when sale.sale_id is not null
      and coalesce(cost.total_carrying_cost_cny, 0::numeric) <> 0
      then (sale.net_proceeds_cny - cost.total_carrying_cost_cny)
        / cost.total_carrying_cost_cny
    else null
  end as realized_roi,
  case
    when coalesce(cost.total_carrying_cost_cny, 0::numeric) = 0 then null
    when sale.sale_id is not null
      then (sale.net_proceeds_cny - cost.total_carrying_cost_cny)
        / cost.total_carrying_cost_cny
    when valuation.current_valuation_cny is not null
      then (valuation.current_valuation_cny - cost.total_carrying_cost_cny)
        / cost.total_carrying_cost_cny
    else null
  end as investment_roi,
  case when sale.sale_id is null then 'unrealized' else 'realized' end as roi_basis
from public.assets asset
left join posted_costs cost
  on cost.portfolio_id = asset.portfolio_id and cost.asset_id = asset.id
left join latest_valuations valuation
  on valuation.portfolio_id = asset.portfolio_id and valuation.asset_id = asset.id
left join completed_sales sale
  on sale.portfolio_id = asset.portfolio_id and sale.asset_id = asset.id;

create view public.portfolio_metrics
with (security_invoker = true)
as
select
  portfolio_id,
  count(*) as asset_count,
  count(*) filter (where sale_id is null) as active_asset_count,
  count(*) filter (where sale_id is not null) as sold_asset_count,
  sum(acquisition_cost_cny) as acquisition_cost_cny,
  sum(logistics_cost_cny) as logistics_cost_cny,
  sum(repair_cost_cny) as repair_cost_cny,
  sum(other_cost_cny) as other_cost_cny,
  sum(total_carrying_cost_cny) as total_carrying_cost_cny,
  sum(current_valuation_cny) filter (where sale_id is null) as current_valuation_cny,
  sum(unrealized_profit_cny) as unrealized_profit_cny,
  sum(realized_profit_cny) as realized_profit_cny,
  case
    when sum(total_carrying_cost_cny) filter (where sale_id is null) = 0 then null
    else sum(unrealized_profit_cny)
      / sum(total_carrying_cost_cny) filter (where sale_id is null)
  end as unrealized_roi,
  case
    when sum(total_carrying_cost_cny) filter (where sale_id is not null) = 0 then null
    else sum(realized_profit_cny)
      / sum(total_carrying_cost_cny) filter (where sale_id is not null)
  end as realized_roi,
  case
    when sum(total_carrying_cost_cny) = 0 then null
    else sum(coalesce(realized_profit_cny, unrealized_profit_cny, 0::numeric))
      / sum(total_carrying_cost_cny)
  end as investment_roi
from public.asset_financials
group by portfolio_id;

comment on view public.asset_financials is
  'Per-asset costs, valuation, realized result, and ROI. ROI denominator is total carrying cost.';
comment on view public.portfolio_metrics is
  'Portfolio aggregates with realized and unrealized results kept separate.';
