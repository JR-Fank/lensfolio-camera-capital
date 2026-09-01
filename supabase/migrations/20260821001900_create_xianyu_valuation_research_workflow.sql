-- Draft Xianyu asking-price research stays separate from confirmed valuation snapshots.

alter table public.valuation_snapshots
  add constraint valuation_snapshots_portfolio_id_key
  unique (portfolio_id, id);

create table public.valuation_research_runs (
  id uuid primary key default gen_random_uuid(),
  portfolio_id uuid not null references public.portfolios(id) on delete cascade,
  asset_id uuid not null,
  market_source_id uuid not null,
  status text not null default 'researching',
  search_terms text[] not null default '{}',
  raw_count integer not null default 0,
  deduplicated_count integer not null default 0,
  included_count integer not null default 0,
  p25_cny numeric(20, 2),
  median_cny numeric(20, 2),
  p75_cny numeric(20, 2),
  sample_count integer not null default 0,
  confidence numeric(6, 5),
  methodology text,
  price_semantics text not null default 'asking_price',
  error_message text,
  created_at timestamptz not null default now(),
  created_by uuid not null references auth.users(id),
  confirmed_at timestamptz,
  confirmed_by uuid references auth.users(id),
  confirmed_snapshot_id uuid,
  unique (portfolio_id, id),
  unique (portfolio_id, id, asset_id, market_source_id),
  foreign key (portfolio_id, asset_id)
    references public.assets(portfolio_id, id) on delete cascade,
  foreign key (portfolio_id, market_source_id)
    references public.market_sources(portfolio_id, id) on delete restrict,
  foreign key (portfolio_id, confirmed_snapshot_id)
    references public.valuation_snapshots(portfolio_id, id) on delete restrict,
  constraint valuation_research_runs_status_valid check (
    status in ('researching', 'ready_for_review', 'failed', 'confirmed', 'cancelled')
  ),
  constraint valuation_research_runs_counts_nonnegative check (
    raw_count >= 0
    and deduplicated_count >= 0
    and included_count >= 0
    and sample_count >= 0
  ),
  constraint valuation_research_runs_count_order check (
    included_count <= deduplicated_count
    and deduplicated_count <= raw_count
    and sample_count = included_count
  ),
  constraint valuation_research_runs_prices_nonnegative check (
    (p25_cny is null or p25_cny >= 0)
    and (median_cny is null or median_cny >= 0)
    and (p75_cny is null or p75_cny >= 0)
  ),
  constraint valuation_research_runs_prices_ordered check (
    (p25_cny is null or median_cny is null or p25_cny <= median_cny)
    and (median_cny is null or p75_cny is null or median_cny <= p75_cny)
  ),
  constraint valuation_research_runs_confidence_range check (
    confidence is null or (confidence >= 0 and confidence <= 1)
  ),
  constraint valuation_research_runs_asking_price_only check (
    price_semantics = 'asking_price'
  ),
  constraint valuation_research_runs_confirmed_complete check (
    status <> 'confirmed'
    or (
      confirmed_at is not null
      and confirmed_by is not null
      and confirmed_snapshot_id is not null
    )
  )
);

alter table public.market_listings
  drop constraint market_listings_market_source_id_external_listing_id_key;

create index market_listings_source_external_id_idx
  on public.market_listings (market_source_id, external_listing_id);

alter table public.market_listings
  add column research_run_id uuid,
  add column seller_name text,
  add column listed_at timestamptz,
  add column captured_at timestamptz,
  add column condition_text text,
  add column review_status text not null default 'pending',
  add column exclusion_reason text,
  add column listing_fingerprint text,
  add column metadata jsonb not null default '{}'::jsonb,
  add constraint market_listings_research_run_fk
    foreign key (portfolio_id, research_run_id, asset_id, market_source_id)
    references public.valuation_research_runs(portfolio_id, id, asset_id, market_source_id) on delete cascade,
  add constraint market_listings_review_status_valid check (
    review_status in ('pending', 'included', 'excluded')
  ),
  add constraint market_listings_exclusion_reason_consistent check (
    (review_status = 'excluded' and nullif(btrim(exclusion_reason), '') is not null)
    or (review_status <> 'excluded' and exclusion_reason is null)
  ),
  add constraint market_listings_fingerprint_not_blank check (
    listing_fingerprint is null or btrim(listing_fingerprint) <> ''
  ),
  add constraint market_listings_research_identity_complete check (
    research_run_id is null
    or (asset_id is not null and listing_fingerprint is not null)
  ),
  add constraint market_listings_research_fingerprint_key
    unique (research_run_id, listing_fingerprint);

create unique index market_listings_research_external_id_key
  on public.market_listings (research_run_id, external_listing_id)
  where research_run_id is not null and external_listing_id is not null;

create index valuation_research_runs_asset_idx
  on public.valuation_research_runs (portfolio_id, asset_id, created_at desc);

create index market_listings_research_review_idx
  on public.market_listings (research_run_id, review_status, asking_price);

alter table public.valuation_research_runs enable row level security;

create policy valuation_research_runs_select_member
on public.valuation_research_runs for select to authenticated
using ((select private.is_portfolio_member(portfolio_id)));

create policy valuation_research_runs_insert_writer
on public.valuation_research_runs for insert to authenticated
with check ((select private.can_write_portfolio(portfolio_id)));

create policy valuation_research_runs_update_writer
on public.valuation_research_runs for update to authenticated
using ((select private.can_write_portfolio(portfolio_id)))
with check ((select private.can_write_portfolio(portfolio_id)));

create policy valuation_research_runs_delete_writer
on public.valuation_research_runs for delete to authenticated
using (
  (select private.can_write_portfolio(portfolio_id))
  and status <> 'confirmed'
);

revoke all on public.valuation_research_runs from public, anon;
grant select, insert, update, delete on public.valuation_research_runs to authenticated;

create or replace function private.protect_confirmed_valuation_research_evidence()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  v_old_confirmed boolean := false;
  v_new_confirmed boolean := false;
begin
  if tg_op in ('UPDATE', 'DELETE') and old.research_run_id is not null then
    select research_run.status = 'confirmed' into v_old_confirmed
    from public.valuation_research_runs research_run
    where research_run.id = old.research_run_id
      and research_run.portfolio_id = old.portfolio_id;
  end if;

  if tg_op in ('INSERT', 'UPDATE') and new.research_run_id is not null then
    select research_run.status = 'confirmed' into v_new_confirmed
    from public.valuation_research_runs research_run
    where research_run.id = new.research_run_id
      and research_run.portfolio_id = new.portfolio_id;
  end if;

  if coalesce(v_old_confirmed, false) or coalesce(v_new_confirmed, false) then
    raise exception using errcode = '55000', message = 'Confirmed valuation research evidence is immutable.';
  end if;

  return case when tg_op = 'DELETE' then old else new end;
end;
$$;

create trigger market_listings_protect_confirmed_research
before insert or update or delete on public.market_listings
for each row execute function private.protect_confirmed_valuation_research_evidence();

create or replace function private.protect_confirmed_valuation_research_run()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if old.status = 'confirmed' then
    raise exception using errcode = '55000', message = 'Confirmed valuation research runs are immutable.';
  end if;
  return case when tg_op = 'DELETE' then old else new end;
end;
$$;

create trigger valuation_research_runs_protect_confirmed
before update or delete on public.valuation_research_runs
for each row execute function private.protect_confirmed_valuation_research_run();

create or replace function public.confirm_valuation_research_run(p_run_id uuid)
returns jsonb
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_user_id uuid := (select auth.uid());
  v_run public.valuation_research_runs%rowtype;
  v_snapshot public.valuation_snapshots%rowtype;
  v_snapshot_id uuid;
  v_sample_count integer;
  v_low numeric;
  v_p25 numeric;
  v_median numeric;
  v_p75 numeric;
  v_high numeric;
  v_legacy_id text;
begin
  if v_user_id is null then
    raise exception using errcode = '28000', message = 'Authentication required.';
  end if;

  select * into v_run
  from public.valuation_research_runs research_run
  where research_run.id = p_run_id
  for update;

  if not found then
    raise exception using errcode = 'P0002', message = 'Valuation research run was not found through RLS.';
  end if;

  if not (select private.can_write_portfolio(v_run.portfolio_id)) then
    raise exception using errcode = '42501', message = 'Portfolio write access required.';
  end if;

  if v_run.status = 'confirmed' then
    select * into v_snapshot
    from public.valuation_snapshots snapshot
    where snapshot.id = v_run.confirmed_snapshot_id
      and snapshot.portfolio_id = v_run.portfolio_id
      and snapshot.asset_id = v_run.asset_id
      and snapshot.market_source_id = v_run.market_source_id;

    if not found then
      raise exception using errcode = '23503', message = 'Confirmed valuation snapshot is missing or inconsistent.';
    end if;

    return jsonb_build_object(
      'run_id', v_run.id,
      'snapshot_id', v_snapshot.id,
      'sample_count', v_snapshot.sample_count,
      'low', v_snapshot.low,
      'p25', v_snapshot.p25,
      'median', v_snapshot.median,
      'p75', v_snapshot.p75,
      'high', v_snapshot.high,
      'confidence', v_snapshot.confidence
    );
  end if;

  if v_run.status <> 'ready_for_review' then
    raise exception using errcode = '22023', message = 'Research run is not ready for confirmation.';
  end if;

  if v_run.price_semantics <> 'asking_price' then
    raise exception using errcode = '22023', message = 'Only asking-price research can be confirmed.';
  end if;

  if not exists (
    select 1
    from public.market_sources source
    where source.id = v_run.market_source_id
      and source.portfolio_id = v_run.portfolio_id
      and source.source_type = 'xianyu'
  ) then
    raise exception using errcode = '22023', message = 'Research run must use a Xianyu market source.';
  end if;

  if exists (
    select 1
    from public.sales sale
    where sale.portfolio_id = v_run.portfolio_id
      and sale.asset_id = v_run.asset_id
      and sale.status = 'sold'
  ) then
    raise exception using errcode = '22023', message = 'Sold assets cannot receive a new current valuation snapshot.';
  end if;

  perform 1
  from public.market_listings listing
  where listing.research_run_id = v_run.id
    and listing.portfolio_id = v_run.portfolio_id
    and listing.asset_id = v_run.asset_id
    and listing.market_source_id = v_run.market_source_id
  for update;

  if exists (
    select 1
    from public.market_listings listing
    where listing.research_run_id = v_run.id
      and listing.portfolio_id = v_run.portfolio_id
      and listing.asset_id = v_run.asset_id
      and listing.market_source_id = v_run.market_source_id
      and listing.review_status = 'pending'
  ) then
    raise exception using errcode = '22023', message = 'All research listings must be reviewed before confirmation.';
  end if;

  if exists (
    select 1
    from public.market_listings listing
    where listing.research_run_id = v_run.id
      and listing.portfolio_id = v_run.portfolio_id
      and listing.asset_id = v_run.asset_id
      and listing.market_source_id = v_run.market_source_id
      and listing.review_status = 'included'
      and listing.currency <> 'CNY'
  ) then
    raise exception using errcode = '22023', message = 'Included listings must all use CNY.';
  end if;

  if exists (
    select 1
    from public.market_listings listing
    where listing.research_run_id = v_run.id
      and listing.portfolio_id = v_run.portfolio_id
      and listing.asset_id = v_run.asset_id
      and listing.market_source_id = v_run.market_source_id
      and listing.review_status = 'included'
      and listing.asking_price <= 0
  ) then
    raise exception using errcode = '22023', message = 'Included listings must have a positive asking price.';
  end if;

  select
    count(*)::integer,
    min(listing.asking_price),
    percentile_cont(0.25) within group (order by listing.asking_price),
    percentile_cont(0.50) within group (order by listing.asking_price),
    percentile_cont(0.75) within group (order by listing.asking_price),
    max(listing.asking_price)
  into v_sample_count, v_low, v_p25, v_median, v_p75, v_high
  from public.market_listings listing
  where listing.research_run_id = v_run.id
    and listing.portfolio_id = v_run.portfolio_id
    and listing.asset_id = v_run.asset_id
    and listing.market_source_id = v_run.market_source_id
    and listing.review_status = 'included';

  if v_sample_count = 0 then
    raise exception using errcode = '22023', message = 'At least one included listing is required.';
  end if;

  v_legacy_id := 'valuation:xianyu:research:' || v_run.id::text;

  insert into public.valuation_snapshots (
    portfolio_id,
    asset_id,
    market_source_id,
    legacy_id,
    low,
    p25,
    median,
    p75,
    high,
    sample_count,
    confidence,
    methodology_version,
    valued_at,
    created_by
  ) values (
    v_run.portfolio_id,
    v_run.asset_id,
    v_run.market_source_id,
    v_legacy_id,
    v_low,
    v_p25,
    v_median,
    v_p75,
    v_high,
    v_sample_count,
    v_run.confidence,
    'xianyu-asking-v1',
    now(),
    v_user_id
  )
  on conflict on constraint valuation_snapshots_portfolio_legacy_key do nothing
  returning id into v_snapshot_id;

  if v_snapshot_id is null then
    select snapshot.id into v_snapshot_id
    from public.valuation_snapshots snapshot
    where snapshot.portfolio_id = v_run.portfolio_id
      and snapshot.legacy_id = v_legacy_id
      and snapshot.asset_id = v_run.asset_id
      and snapshot.market_source_id = v_run.market_source_id;
  end if;

  if v_snapshot_id is null then
    raise exception using errcode = '23505', message = 'Conflicting valuation research snapshot exists.';
  end if;

  update public.valuation_research_runs
  set status = 'confirmed',
      included_count = v_sample_count,
      sample_count = v_sample_count,
      p25_cny = v_p25,
      median_cny = v_median,
      p75_cny = v_p75,
      confirmed_at = now(),
      confirmed_by = v_user_id,
      confirmed_snapshot_id = v_snapshot_id,
      error_message = null
  where id = v_run.id
    and portfolio_id = v_run.portfolio_id;

  return jsonb_build_object(
    'run_id', v_run.id,
    'snapshot_id', v_snapshot_id,
    'sample_count', v_sample_count,
    'low', v_low,
    'p25', v_p25,
    'median', v_median,
    'p75', v_p75,
    'high', v_high,
    'confidence', v_run.confidence
  );
end;
$$;

revoke all on function public.confirm_valuation_research_run(uuid) from public, anon;
grant execute on function public.confirm_valuation_research_run(uuid) to authenticated;

comment on table public.valuation_research_runs is
  'Draft research lifecycle for asking-price samples. Only a confirmed run creates a valuation snapshot.';
comment on column public.market_listings.asking_price is
  'Observed asking price; never a sold price or transaction price.';
