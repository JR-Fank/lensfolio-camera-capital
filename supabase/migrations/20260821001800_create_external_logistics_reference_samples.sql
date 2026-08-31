-- Private logistics references are intentionally isolated from assets and the
-- portfolio cost ledger. They are available only as estimator inputs.

create table public.logistics_reference_samples (
  id uuid primary key default gen_random_uuid(),
  portfolio_id uuid not null references public.portfolios(id) on delete cascade,
  legacy_id text not null,
  reference_type text not null default 'logistics_cost',
  reference_scope text not null,
  reference_model text,
  carrier text not null,
  service text not null,
  chargeable_weight_g integer not null,
  gross_cost_original numeric(20, 2) not null,
  original_currency text not null,
  fx_rate_to_cny numeric(20, 10),
  gross_cost_cny numeric(20, 2) not null,
  cash_refund_cny numeric(20, 2) not null default 0,
  non_cash_refund_points numeric(20, 2),
  net_cost_cny numeric(20, 2) not null,
  paid_at timestamptz,
  refunded_at timestamptz,
  carrier_posted_at timestamptz,
  carrier_delivered_at timestamptz,
  evidence jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  created_by uuid not null references auth.users(id),
  unique (portfolio_id, legacy_id),
  constraint logistics_reference_type_check check (reference_type = 'logistics_cost'),
  constraint logistics_reference_scope_check check (reference_scope = 'external_private'),
  constraint logistics_reference_carrier_not_blank check (btrim(carrier) <> ''),
  constraint logistics_reference_service_not_blank check (btrim(service) <> ''),
  constraint logistics_reference_weight_positive check (chargeable_weight_g > 0),
  constraint logistics_reference_currency_iso_like check (original_currency ~ '^[A-Z]{3}$'),
  constraint logistics_reference_fx_positive check (fx_rate_to_cny is null or fx_rate_to_cny > 0),
  constraint logistics_reference_amounts_nonnegative check (
    gross_cost_original >= 0
    and gross_cost_cny >= 0
    and cash_refund_cny >= 0
    and (non_cash_refund_points is null or non_cash_refund_points >= 0)
    and net_cost_cny >= 0
  ),
  constraint logistics_reference_net_cost_check check (
    net_cost_cny = gross_cost_cny - cash_refund_cny
  ),
  constraint logistics_reference_transit_order check (
    carrier_delivered_at is null
    or carrier_posted_at is null
    or carrier_delivered_at >= carrier_posted_at
  )
);

comment on table public.logistics_reference_samples is
  'Private external logistics cost references. Never included in asset, ledger, valuation, or portfolio metrics.';
comment on column public.logistics_reference_samples.non_cash_refund_points is
  'Non-cash points evidence only; never converted into CNY cost.';

create index logistics_reference_samples_portfolio_service_idx
  on public.logistics_reference_samples (portfolio_id, carrier, service, paid_at desc);

alter table public.logistics_reference_samples enable row level security;

create policy logistics_reference_samples_select_member
on public.logistics_reference_samples for select to authenticated
using ((select private.is_portfolio_member(portfolio_id)));

create policy logistics_reference_samples_insert_writer
on public.logistics_reference_samples for insert to authenticated
with check (
  (select private.can_write_portfolio(portfolio_id))
  and created_by = (select auth.uid())
);

create policy logistics_reference_samples_update_writer
on public.logistics_reference_samples for update to authenticated
using ((select private.can_write_portfolio(portfolio_id)))
with check (
  (select private.can_write_portfolio(portfolio_id))
  and created_by = (select auth.uid())
);

create policy logistics_reference_samples_delete_writer
on public.logistics_reference_samples for delete to authenticated
using ((select private.can_write_portfolio(portfolio_id)));

revoke all on public.logistics_reference_samples from public, anon;
grant select, insert, update, delete on public.logistics_reference_samples to authenticated;
grant all on public.logistics_reference_samples to service_role;
