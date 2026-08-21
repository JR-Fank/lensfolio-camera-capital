-- Lensfolio Supabase foundation: shared types and identity boundary.
-- This directory is the sole source of truth for the new PostgreSQL schema.

create schema if not exists private;
revoke all on schema private from public, anon, authenticated;

create type public.portfolio_role as enum ('owner', 'editor', 'viewer');
create type public.asset_operational_status as enum (
  'acquired',
  'in_transit',
  'in_storage',
  'inspection',
  'repair',
  'ready_for_sale',
  'listed',
  'sold',
  'retired'
);
create type public.asset_repair_status as enum (
  'unknown',
  'not_inspected',
  'normal',
  'needs_repair',
  'in_repair',
  'repaired'
);
create type public.allocation_method as enum (
  'equal',
  'weight',
  'manual',
  'legacy_equal_allocation'
);
create type public.purchase_status as enum ('draft', 'paid', 'received', 'cancelled');
create type public.shipment_status as enum (
  'draft',
  'booked',
  'in_transit',
  'customs',
  'delivered',
  'cancelled'
);
create type public.cost_type as enum (
  'purchase',
  'domestic_shipping',
  'international_shipping',
  'repair',
  'other',
  'adjustment',
  'reversal'
);
create type public.cost_source_type as enum (
  'purchase_order',
  'purchase_item',
  'shipment',
  'shipment_item',
  'repair',
  'manual',
  'adjustment',
  'reversal'
);
create type public.cost_entry_status as enum ('pending', 'posted', 'void');
create type public.repair_status as enum ('planned', 'in_progress', 'completed', 'cancelled');
create type public.sale_status as enum ('listed', 'sold', 'cancelled');

create table public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  display_name text,
  display_timezone text not null default 'Asia/Hong_Kong',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint profiles_display_timezone_not_blank check (btrim(display_timezone) <> '')
);

create table public.portfolios (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  base_currency text not null default 'CNY',
  display_timezone text not null default 'Asia/Hong_Kong',
  created_by uuid not null references auth.users(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint portfolios_name_not_blank check (btrim(name) <> ''),
  constraint portfolios_base_currency_cny check (base_currency = 'CNY'),
  constraint portfolios_display_timezone_not_blank check (btrim(display_timezone) <> '')
);

create table public.portfolio_members (
  portfolio_id uuid not null references public.portfolios(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  role public.portfolio_role not null,
  created_by uuid not null references auth.users(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (portfolio_id, user_id)
);

create index portfolio_members_user_id_idx
  on public.portfolio_members (user_id, portfolio_id);

create or replace function private.set_updated_at()
returns trigger
language plpgsql
set search_path = pg_catalog
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

create trigger profiles_set_updated_at
before update on public.profiles
for each row execute function private.set_updated_at();

create trigger portfolios_set_updated_at
before update on public.portfolios
for each row execute function private.set_updated_at();

create trigger portfolio_members_set_updated_at
before update on public.portfolio_members
for each row execute function private.set_updated_at();

create or replace function private.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  insert into public.profiles (id, display_name)
  values (new.id, nullif(new.raw_user_meta_data ->> 'display_name', ''))
  on conflict (id) do nothing;
  return new;
end;
$$;

create trigger on_auth_user_created
after insert on auth.users
for each row execute function private.handle_new_user();
