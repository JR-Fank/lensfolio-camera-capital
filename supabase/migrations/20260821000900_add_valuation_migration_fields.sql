alter table public.market_sources
  add column source_type text null;

alter table public.valuation_snapshots
  add column legacy_id text null,
  alter column sample_count drop default,
  add constraint valuation_snapshots_portfolio_legacy_key
    unique (portfolio_id, legacy_id);
