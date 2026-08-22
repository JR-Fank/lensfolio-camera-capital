alter table public.purchase_orders
  add column platform text,
  add column order_reference text,
  add column original_currency text;

alter table public.purchase_items
  add column legacy_id text;

alter table public.purchase_items
  add constraint purchase_items_portfolio_id_legacy_id_key
  unique (portfolio_id, legacy_id);
