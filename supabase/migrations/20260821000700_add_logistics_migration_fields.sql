alter table public.shipments
  add column origin text,
  add column destination text,
  add column bare_weight_g integer,
  add column chargeable_weight_g integer,
  add column legacy_status text;

alter table public.shipment_items
  add column legacy_id text;

alter table public.shipment_items
  add constraint shipment_items_portfolio_id_legacy_id_key
  unique (portfolio_id, legacy_id);

alter table public.tracking_events
  add column legacy_id text,
  add column raw_status text;

alter table public.tracking_events
  add constraint tracking_events_portfolio_id_legacy_id_key
  unique (portfolio_id, legacy_id);
