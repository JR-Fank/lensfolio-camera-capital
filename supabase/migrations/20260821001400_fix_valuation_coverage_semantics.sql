-- Keep portfolio valuation results scoped to assets that actually have a valuation.
-- Full-portfolio ROI remains NULL until every active asset is valued.

create or replace view public.portfolio_metrics
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
  sum(unrealized_profit_cny) filter (
    where sale_id is null and current_valuation_cny is not null
  ) as unrealized_profit_cny,
  sum(realized_profit_cny) as realized_profit_cny,
  case
    when coalesce(sum(total_carrying_cost_cny) filter (
      where sale_id is null and current_valuation_cny is not null
    ), 0::numeric) = 0 then null
    else sum(unrealized_profit_cny) filter (
      where sale_id is null and current_valuation_cny is not null
    ) / sum(total_carrying_cost_cny) filter (
      where sale_id is null and current_valuation_cny is not null
    )
  end as unrealized_roi,
  case
    when sum(total_carrying_cost_cny) filter (where sale_id is not null) = 0 then null
    else sum(realized_profit_cny)
      / sum(total_carrying_cost_cny) filter (where sale_id is not null)
  end as realized_roi,
  case
    when count(*) filter (where sale_id is null and current_valuation_cny is not null)
      <> count(*) filter (where sale_id is null) then null
    when sum(total_carrying_cost_cny) = 0 then null
    else sum(coalesce(realized_profit_cny, unrealized_profit_cny, 0::numeric))
      / sum(total_carrying_cost_cny)
  end as investment_roi,
  count(*) as total_asset_count,
  sum(total_carrying_cost_cny) as total_posted_carrying_cost_cny,
  count(*) filter (
    where sale_id is null and current_valuation_cny is not null
  ) as valued_asset_count,
  sum(total_carrying_cost_cny) filter (
    where sale_id is null and current_valuation_cny is not null
  ) as valued_asset_carrying_cost_cny,
  sum(unrealized_profit_cny) filter (
    where sale_id is null and current_valuation_cny is not null
  ) as valued_unrealized_profit_cny,
  case
    when coalesce(sum(total_carrying_cost_cny) filter (
      where sale_id is null and current_valuation_cny is not null
    ), 0::numeric) = 0 then null
    else sum(unrealized_profit_cny) filter (
      where sale_id is null and current_valuation_cny is not null
    ) / sum(total_carrying_cost_cny) filter (
      where sale_id is null and current_valuation_cny is not null
    )
  end as valued_assets_roi,
  count(*) filter (where sale_id is null and current_valuation_cny is not null)
    = count(*) filter (where sale_id is null) as valuation_coverage_complete,
  case
    when count(*) filter (where sale_id is null and current_valuation_cny is not null)
      <> count(*) filter (where sale_id is null) then null
    when sum(total_carrying_cost_cny) = 0 then null
    else sum(coalesce(realized_profit_cny, unrealized_profit_cny, 0::numeric))
      / sum(total_carrying_cost_cny)
  end as portfolio_roi
from public.asset_financials
group by portfolio_id;

comment on view public.portfolio_metrics is
  'Portfolio totals plus explicit valuation coverage. Valued ROI uses only valued active assets; full portfolio ROI is NULL while coverage is incomplete.';
