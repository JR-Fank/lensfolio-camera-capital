alter table public.cost_entries
  add constraint cost_entries_asset_source_cost_key
  unique (asset_id, source_type, source_id, cost_type);
