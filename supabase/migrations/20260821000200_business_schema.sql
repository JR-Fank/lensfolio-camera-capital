-- Lensfolio Supabase foundation: portfolio-scoped business tables.

create table public.assets (
  id uuid primary key default gen_random_uuid(),
  portfolio_id uuid not null references public.portfolios(id) on delete cascade,
  legacy_id text,
  brand text not null,
  model text not null,
  serial_number text,
  condition text,
  operational_status public.asset_operational_status not null default 'acquired',
  repair_status public.asset_repair_status not null default 'unknown',
  acquired_at timestamptz,
  measured_weight_g integer,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  created_by uuid not null references auth.users(id),
  unique (portfolio_id, id),
  unique (portfolio_id, legacy_id),
  constraint assets_brand_not_blank check (btrim(brand) <> ''),
  constraint assets_model_not_blank check (btrim(model) <> ''),
  constraint assets_measured_weight_positive check (measured_weight_g is null or measured_weight_g > 0)
);

create table public.asset_status_events (
  id uuid primary key default gen_random_uuid(),
  portfolio_id uuid not null,
  asset_id uuid not null,
  operational_status public.asset_operational_status,
  repair_status public.asset_repair_status,
  note text,
  occurred_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  created_by uuid not null references auth.users(id),
  foreign key (portfolio_id, asset_id)
    references public.assets(portfolio_id, id) on delete cascade,
  constraint asset_status_events_has_change check (
    operational_status is not null or repair_status is not null or note is not null
  )
);

create table public.purchase_orders (
  id uuid primary key default gen_random_uuid(),
  portfolio_id uuid not null references public.portfolios(id) on delete cascade,
  legacy_id text,
  vendor text,
  ordered_at timestamptz not null,
  status public.purchase_status not null default 'paid',
  original_subtotal_jpy numeric(20, 2) not null default 0,
  coupon_jpy numeric(20, 2) not null default 0,
  fee_jpy numeric(20, 2) not null default 0,
  domestic_shipping_jpy numeric(20, 2) not null default 0,
  exchange_rate_jpy_to_cny numeric(20, 10) not null,
  actual_paid_cny numeric(20, 2) not null,
  allocation_method public.allocation_method not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  created_by uuid not null references auth.users(id),
  unique (portfolio_id, id),
  unique (portfolio_id, legacy_id),
  constraint purchase_orders_amounts_nonnegative check (
    original_subtotal_jpy >= 0 and coupon_jpy >= 0 and fee_jpy >= 0
    and domestic_shipping_jpy >= 0 and actual_paid_cny >= 0
  ),
  constraint purchase_orders_exchange_rate_positive check (exchange_rate_jpy_to_cny > 0)
);

create table public.purchase_items (
  id uuid primary key default gen_random_uuid(),
  portfolio_id uuid not null,
  purchase_order_id uuid not null,
  asset_id uuid not null,
  original_price_jpy numeric(20, 2) not null,
  allocation_method public.allocation_method not null,
  allocation_ratio numeric(20, 10),
  allocated_cost_cny numeric(20, 2) not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  created_by uuid not null references auth.users(id),
  unique (purchase_order_id, asset_id),
  foreign key (portfolio_id, purchase_order_id)
    references public.purchase_orders(portfolio_id, id) on delete cascade,
  foreign key (portfolio_id, asset_id)
    references public.assets(portfolio_id, id) on delete restrict,
  constraint purchase_items_amounts_nonnegative check (
    original_price_jpy >= 0 and allocated_cost_cny >= 0
  ),
  constraint purchase_items_ratio_range check (
    allocation_ratio is null or (allocation_ratio >= 0 and allocation_ratio <= 1)
  )
);

create table public.shipments (
  id uuid primary key default gen_random_uuid(),
  portfolio_id uuid not null references public.portfolios(id) on delete cascade,
  legacy_id text,
  carrier text,
  tracking_number text,
  status public.shipment_status not null default 'draft',
  shipped_at timestamptz,
  delivered_at timestamptz,
  actual_paid_cny numeric(20, 2) not null default 0,
  budget_cny numeric(20, 2) not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  created_by uuid not null references auth.users(id),
  unique (portfolio_id, id),
  unique (portfolio_id, legacy_id),
  constraint shipments_amounts_nonnegative check (actual_paid_cny >= 0 and budget_cny >= 0),
  constraint shipments_date_order check (
    delivered_at is null or shipped_at is null or delivered_at >= shipped_at
  )
);

create table public.shipment_items (
  id uuid primary key default gen_random_uuid(),
  portfolio_id uuid not null,
  shipment_id uuid not null,
  asset_id uuid not null,
  weight_snapshot_g integer,
  allocation_method public.allocation_method not null,
  allocation_ratio numeric(20, 10) not null,
  allocated_shipping_cny numeric(20, 2) not null,
  allocation_locked_at timestamptz,
  allocation_version integer not null default 1,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  created_by uuid not null references auth.users(id),
  unique (shipment_id, asset_id),
  foreign key (portfolio_id, shipment_id)
    references public.shipments(portfolio_id, id) on delete cascade,
  foreign key (portfolio_id, asset_id)
    references public.assets(portfolio_id, id) on delete restrict,
  constraint shipment_items_weight_positive check (weight_snapshot_g is null or weight_snapshot_g > 0),
  constraint shipment_items_ratio_range check (allocation_ratio >= 0 and allocation_ratio <= 1),
  constraint shipment_items_allocated_nonnegative check (allocated_shipping_cny >= 0),
  constraint shipment_items_version_positive check (allocation_version > 0)
);

create table public.tracking_events (
  id uuid primary key default gen_random_uuid(),
  portfolio_id uuid not null,
  shipment_id uuid not null,
  external_event_id text,
  status text not null,
  description text,
  location text,
  occurred_at timestamptz not null,
  recorded_at timestamptz not null default now(),
  created_by uuid references auth.users(id),
  foreign key (portfolio_id, shipment_id)
    references public.shipments(portfolio_id, id) on delete cascade,
  unique (shipment_id, external_event_id),
  constraint tracking_events_status_not_blank check (btrim(status) <> '')
);

create table public.tracking_sync_runs (
  id uuid primary key default gen_random_uuid(),
  portfolio_id uuid not null references public.portfolios(id) on delete cascade,
  shipment_id uuid,
  started_at timestamptz not null default now(),
  finished_at timestamptz,
  status text not null,
  events_seen integer not null default 0,
  events_inserted integer not null default 0,
  error_message text,
  created_by uuid references auth.users(id),
  foreign key (portfolio_id, shipment_id)
    references public.shipments(portfolio_id, id) on delete cascade,
  constraint tracking_sync_runs_counts_nonnegative check (events_seen >= 0 and events_inserted >= 0),
  constraint tracking_sync_runs_date_order check (finished_at is null or finished_at >= started_at)
);

create table public.cost_entries (
  id uuid primary key default gen_random_uuid(),
  portfolio_id uuid not null references public.portfolios(id) on delete cascade,
  asset_id uuid not null,
  cost_type public.cost_type not null,
  source_type public.cost_source_type not null,
  source_id uuid,
  original_amount numeric(20, 6) not null,
  currency text not null,
  fx_rate_to_cny numeric(20, 10) not null,
  amount_cny numeric(20, 2) not null,
  entry_status public.cost_entry_status not null default 'posted',
  occurred_at timestamptz not null,
  reversal_of uuid,
  created_at timestamptz not null default now(),
  created_by uuid not null references auth.users(id),
  unique (portfolio_id, id),
  unique (portfolio_id, asset_id, id),
  foreign key (portfolio_id, asset_id)
    references public.assets(portfolio_id, id) on delete restrict,
  foreign key (portfolio_id, asset_id, reversal_of)
    references public.cost_entries(portfolio_id, asset_id, id) on delete restrict,
  constraint cost_entries_currency_iso_like check (currency ~ '^[A-Z]{3}$'),
  constraint cost_entries_fx_rate_positive check (fx_rate_to_cny > 0),
  constraint cost_entries_reversal_shape check (
    (cost_type = 'reversal' and reversal_of is not null and amount_cny <= 0)
    or (cost_type <> 'reversal' and reversal_of is null and amount_cny >= 0)
  )
);

create unique index cost_entries_one_reversal_per_entry_idx
  on public.cost_entries (reversal_of)
  where reversal_of is not null;

create table public.repairs (
  id uuid primary key default gen_random_uuid(),
  portfolio_id uuid not null,
  asset_id uuid not null,
  legacy_id text,
  vendor text,
  description text not null,
  status public.repair_status not null default 'planned',
  original_amount numeric(20, 6) not null default 0,
  currency text not null default 'CNY',
  fx_rate_to_cny numeric(20, 10) not null default 1,
  amount_cny numeric(20, 2) not null default 0,
  started_at timestamptz,
  completed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  created_by uuid not null references auth.users(id),
  foreign key (portfolio_id, asset_id)
    references public.assets(portfolio_id, id) on delete restrict,
  unique (portfolio_id, legacy_id),
  constraint repairs_currency_iso_like check (currency ~ '^[A-Z]{3}$'),
  constraint repairs_amounts_nonnegative check (original_amount >= 0 and amount_cny >= 0),
  constraint repairs_fx_rate_positive check (fx_rate_to_cny > 0),
  constraint repairs_date_order check (completed_at is null or started_at is null or completed_at >= started_at)
);

create table public.market_sources (
  id uuid primary key default gen_random_uuid(),
  portfolio_id uuid not null references public.portfolios(id) on delete cascade,
  name text not null,
  source_url text,
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  created_by uuid not null references auth.users(id),
  unique (portfolio_id, id),
  unique (portfolio_id, name),
  constraint market_sources_name_not_blank check (btrim(name) <> '')
);

create table public.market_listings (
  id uuid primary key default gen_random_uuid(),
  portfolio_id uuid not null,
  market_source_id uuid not null,
  asset_id uuid,
  external_listing_id text,
  title text not null,
  listing_url text,
  asking_price numeric(20, 2) not null,
  currency text not null default 'CNY',
  observed_at timestamptz not null,
  created_at timestamptz not null default now(),
  created_by uuid not null references auth.users(id),
  foreign key (portfolio_id, market_source_id)
    references public.market_sources(portfolio_id, id) on delete cascade,
  foreign key (portfolio_id, asset_id)
    references public.assets(portfolio_id, id) on delete restrict,
  unique (market_source_id, external_listing_id),
  constraint market_listings_price_nonnegative check (asking_price >= 0),
  constraint market_listings_currency_iso_like check (currency ~ '^[A-Z]{3}$')
);

create table public.valuation_snapshots (
  id uuid primary key default gen_random_uuid(),
  portfolio_id uuid not null,
  asset_id uuid not null,
  market_source_id uuid,
  low numeric(20, 2),
  p25 numeric(20, 2),
  median numeric(20, 2) not null,
  p75 numeric(20, 2),
  high numeric(20, 2),
  sample_count integer not null default 0,
  confidence numeric(6, 5),
  methodology_version text not null,
  valued_at timestamptz not null,
  created_at timestamptz not null default now(),
  created_by uuid not null references auth.users(id),
  foreign key (portfolio_id, asset_id)
    references public.assets(portfolio_id, id) on delete cascade,
  foreign key (portfolio_id, market_source_id)
    references public.market_sources(portfolio_id, id) on delete restrict,
  constraint valuation_snapshots_nonnegative check (
    (low is null or low >= 0)
    and (p25 is null or p25 >= 0)
    and median >= 0
    and (p75 is null or p75 >= 0)
    and (high is null or high >= 0)
  ),
  constraint valuation_snapshots_ordered check (
    (low is null or p25 is null or low <= p25)
    and (p25 is null or p25 <= median)
    and (p75 is null or median <= p75)
    and (p75 is null or high is null or p75 <= high)
  ),
  constraint valuation_snapshots_sample_count_nonnegative check (sample_count >= 0),
  constraint valuation_snapshots_confidence_range check (
    confidence is null or (confidence >= 0 and confidence <= 1)
  ),
  constraint valuation_snapshots_method_not_blank check (btrim(methodology_version) <> '')
);

create table public.sales (
  id uuid primary key default gen_random_uuid(),
  portfolio_id uuid not null,
  asset_id uuid not null,
  legacy_id text,
  status public.sale_status not null default 'listed',
  platform text,
  listing_price_cny numeric(20, 2),
  sold_price_cny numeric(20, 2),
  platform_fees_cny numeric(20, 2) not null default 0,
  outbound_shipping_cny numeric(20, 2) not null default 0,
  net_proceeds_cny numeric(20, 2) generated always as (
    case
      when sold_price_cny is null then null
      else sold_price_cny - platform_fees_cny - outbound_shipping_cny
    end
  ) stored,
  listed_at timestamptz,
  sold_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  created_by uuid not null references auth.users(id),
  foreign key (portfolio_id, asset_id)
    references public.assets(portfolio_id, id) on delete restrict,
  unique (portfolio_id, legacy_id),
  constraint sales_amounts_nonnegative check (
    (listing_price_cny is null or listing_price_cny >= 0)
    and (sold_price_cny is null or sold_price_cny >= 0)
    and platform_fees_cny >= 0
    and outbound_shipping_cny >= 0
  ),
  constraint sales_sold_shape check (
    (status = 'sold' and sold_price_cny is not null and sold_at is not null)
    or status <> 'sold'
  )
);

create unique index sales_one_completed_sale_per_asset_idx
  on public.sales (asset_id)
  where status = 'sold';

create table public.audit_logs (
  id uuid primary key default gen_random_uuid(),
  portfolio_id uuid not null references public.portfolios(id) on delete cascade,
  actor_id uuid references auth.users(id),
  action text not null,
  entity_type text not null,
  entity_id uuid,
  before_data jsonb,
  after_data jsonb,
  occurred_at timestamptz not null default now(),
  constraint audit_logs_action_not_blank check (btrim(action) <> ''),
  constraint audit_logs_entity_type_not_blank check (btrim(entity_type) <> '')
);

create table public.attachments (
  id uuid primary key default gen_random_uuid(),
  portfolio_id uuid not null references public.portfolios(id) on delete cascade,
  asset_id uuid,
  entity_type text not null,
  entity_id uuid not null,
  storage_bucket text not null,
  storage_path text not null,
  file_name text not null,
  content_type text,
  size_bytes bigint,
  created_at timestamptz not null default now(),
  created_by uuid not null references auth.users(id),
  foreign key (portfolio_id, asset_id)
    references public.assets(portfolio_id, id) on delete restrict,
  unique (storage_bucket, storage_path),
  constraint attachments_size_nonnegative check (size_bytes is null or size_bytes >= 0)
);

create index assets_portfolio_id_idx on public.assets (portfolio_id);
create index asset_status_events_asset_idx on public.asset_status_events (asset_id, occurred_at);
create index purchase_orders_portfolio_idx on public.purchase_orders (portfolio_id, ordered_at);
create index purchase_items_asset_idx on public.purchase_items (asset_id);
create index shipments_portfolio_idx on public.shipments (portfolio_id, shipped_at);
create index shipment_items_asset_idx on public.shipment_items (asset_id);
create index tracking_events_shipment_idx on public.tracking_events (shipment_id, occurred_at, id);
create index tracking_sync_runs_shipment_idx on public.tracking_sync_runs (shipment_id, started_at);
create index cost_entries_asset_idx on public.cost_entries (asset_id, entry_status, occurred_at);
create index repairs_asset_idx on public.repairs (asset_id, started_at);
create index market_listings_asset_idx on public.market_listings (asset_id, observed_at);
create index valuation_snapshots_asset_idx on public.valuation_snapshots (asset_id, valued_at desc, id desc);
create index sales_asset_idx on public.sales (asset_id, sold_at);
create index audit_logs_portfolio_idx on public.audit_logs (portfolio_id, occurred_at);
create index attachments_portfolio_idx on public.attachments (portfolio_id, entity_type, entity_id);

create trigger assets_set_updated_at
before update on public.assets
for each row execute function private.set_updated_at();
create trigger purchase_orders_set_updated_at
before update on public.purchase_orders
for each row execute function private.set_updated_at();
create trigger purchase_items_set_updated_at
before update on public.purchase_items
for each row execute function private.set_updated_at();
create trigger shipments_set_updated_at
before update on public.shipments
for each row execute function private.set_updated_at();
create trigger shipment_items_set_updated_at
before update on public.shipment_items
for each row execute function private.set_updated_at();
create trigger repairs_set_updated_at
before update on public.repairs
for each row execute function private.set_updated_at();
create trigger market_sources_set_updated_at
before update on public.market_sources
for each row execute function private.set_updated_at();
create trigger sales_set_updated_at
before update on public.sales
for each row execute function private.set_updated_at();

create or replace function private.protect_locked_shipment_allocation()
returns trigger
language plpgsql
set search_path = pg_catalog
as $$
begin
  if old.allocation_locked_at is not null
    and (
      new.shipment_id is distinct from old.shipment_id
      or new.asset_id is distinct from old.asset_id
      or new.weight_snapshot_g is distinct from old.weight_snapshot_g
      or new.allocation_method is distinct from old.allocation_method
      or new.allocation_ratio is distinct from old.allocation_ratio
      or new.allocated_shipping_cny is distinct from old.allocated_shipping_cny
      or new.allocation_locked_at is distinct from old.allocation_locked_at
      or new.allocation_version is distinct from old.allocation_version
    )
  then
    raise exception using
      errcode = 'P0001',
      message = 'Locked shipment allocation is immutable.';
  end if;
  return new;
end;
$$;

create trigger shipment_items_protect_locked_allocation
before update on public.shipment_items
for each row execute function private.protect_locked_shipment_allocation();
