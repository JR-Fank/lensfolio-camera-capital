-- Lensfolio Supabase foundation: Auth/RLS boundary.

create or replace function private.is_portfolio_member(target_portfolio_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.portfolio_members member
    where member.portfolio_id = target_portfolio_id
      and member.user_id = (select auth.uid())
  );
$$;

create or replace function private.can_write_portfolio(target_portfolio_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.portfolio_members member
    where member.portfolio_id = target_portfolio_id
      and member.user_id = (select auth.uid())
      and member.role in ('owner', 'editor')
  );
$$;

create or replace function private.is_portfolio_owner(target_portfolio_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.portfolio_members member
    where member.portfolio_id = target_portfolio_id
      and member.user_id = (select auth.uid())
      and member.role = 'owner'
  );
$$;

create or replace function private.can_bootstrap_portfolio_owner(
  target_portfolio_id uuid,
  target_user_id uuid,
  target_role public.portfolio_role
)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select
    target_user_id = (select auth.uid())
    and target_role = 'owner'
    and exists (
      select 1
      from public.portfolios portfolio
      where portfolio.id = target_portfolio_id
        and portfolio.created_by = (select auth.uid())
    )
    and not exists (
      select 1
      from public.portfolio_members member
      where member.portfolio_id = target_portfolio_id
    );
$$;

revoke all on function private.is_portfolio_member(uuid) from public;
revoke all on function private.can_write_portfolio(uuid) from public;
revoke all on function private.is_portfolio_owner(uuid) from public;
revoke all on function private.can_bootstrap_portfolio_owner(uuid, uuid, public.portfolio_role) from public;
grant usage on schema private to authenticated, service_role;
grant execute on function private.is_portfolio_member(uuid) to authenticated, service_role;
grant execute on function private.can_write_portfolio(uuid) to authenticated, service_role;
grant execute on function private.is_portfolio_owner(uuid) to authenticated, service_role;
grant execute on function private.can_bootstrap_portfolio_owner(uuid, uuid, public.portfolio_role)
  to authenticated, service_role;

alter table public.profiles enable row level security;
alter table public.portfolios enable row level security;
alter table public.portfolio_members enable row level security;
alter table public.assets enable row level security;
alter table public.asset_status_events enable row level security;
alter table public.purchase_orders enable row level security;
alter table public.purchase_items enable row level security;
alter table public.shipments enable row level security;
alter table public.shipment_items enable row level security;
alter table public.tracking_events enable row level security;
alter table public.tracking_sync_runs enable row level security;
alter table public.cost_entries enable row level security;
alter table public.repairs enable row level security;
alter table public.market_sources enable row level security;
alter table public.market_listings enable row level security;
alter table public.valuation_snapshots enable row level security;
alter table public.sales enable row level security;
alter table public.audit_logs enable row level security;
alter table public.attachments enable row level security;

create policy profiles_select_self
on public.profiles for select to authenticated
using (id = (select auth.uid()));

create policy profiles_update_self
on public.profiles for update to authenticated
using (id = (select auth.uid()))
with check (id = (select auth.uid()));

create policy portfolios_select_member
on public.portfolios for select to authenticated
using ((select private.is_portfolio_member(id)));

create policy portfolios_insert_creator
on public.portfolios for insert to authenticated
with check (created_by = (select auth.uid()));

create policy portfolios_update_owner
on public.portfolios for update to authenticated
using ((select private.is_portfolio_owner(id)))
with check ((select private.is_portfolio_owner(id)));

create policy portfolios_delete_owner
on public.portfolios for delete to authenticated
using ((select private.is_portfolio_owner(id)));

create policy portfolio_members_select_member
on public.portfolio_members for select to authenticated
using ((select private.is_portfolio_member(portfolio_id)));

create policy portfolio_members_insert_owner
on public.portfolio_members for insert to authenticated
with check (
  (select private.is_portfolio_owner(portfolio_id))
  or (select private.can_bootstrap_portfolio_owner(portfolio_id, user_id, role))
);

create policy portfolio_members_update_owner
on public.portfolio_members for update to authenticated
using ((select private.is_portfolio_owner(portfolio_id)))
with check ((select private.is_portfolio_owner(portfolio_id)));

create policy portfolio_members_delete_owner
on public.portfolio_members for delete to authenticated
using ((select private.is_portfolio_owner(portfolio_id)));

do $policy_setup$
declare
  table_name text;
begin
  foreach table_name in array array[
    'assets',
    'asset_status_events',
    'purchase_orders',
    'purchase_items',
    'shipments',
    'shipment_items',
    'tracking_events',
    'tracking_sync_runs',
    'cost_entries',
    'repairs',
    'market_sources',
    'market_listings',
    'valuation_snapshots',
    'sales',
    'attachments'
  ]
  loop
    execute format(
      'create policy %I on public.%I for select to authenticated using ((select private.is_portfolio_member(portfolio_id)))',
      table_name || '_select_member',
      table_name
    );
    execute format(
      'create policy %I on public.%I for insert to authenticated with check ((select private.can_write_portfolio(portfolio_id)))',
      table_name || '_insert_writer',
      table_name
    );
    execute format(
      'create policy %I on public.%I for update to authenticated using ((select private.can_write_portfolio(portfolio_id))) with check ((select private.can_write_portfolio(portfolio_id)))',
      table_name || '_update_writer',
      table_name
    );
    execute format(
      'create policy %I on public.%I for delete to authenticated using ((select private.can_write_portfolio(portfolio_id)))',
      table_name || '_delete_writer',
      table_name
    );
  end loop;
end;
$policy_setup$;

create policy audit_logs_select_member
on public.audit_logs for select to authenticated
using ((select private.is_portfolio_member(portfolio_id)));

create policy audit_logs_insert_writer
on public.audit_logs for insert to authenticated
with check (
  (select private.can_write_portfolio(portfolio_id))
  and (actor_id is null or actor_id = (select auth.uid()))
);

create policy audit_logs_update_writer
on public.audit_logs for update to authenticated
using ((select private.can_write_portfolio(portfolio_id)))
with check (
  (select private.can_write_portfolio(portfolio_id))
  and (actor_id is null or actor_id = (select auth.uid()))
);

create policy audit_logs_delete_writer
on public.audit_logs for delete to authenticated
using ((select private.can_write_portfolio(portfolio_id)));

revoke all on all tables in schema public from public, anon;
revoke all on all sequences in schema public from public, anon;

grant select, insert, update, delete on public.portfolios to authenticated;
grant select, insert, update, delete on public.portfolio_members to authenticated;
grant select, update on public.profiles to authenticated;
grant select, insert, update, delete on
  public.assets,
  public.asset_status_events,
  public.purchase_orders,
  public.purchase_items,
  public.shipments,
  public.shipment_items,
  public.tracking_events,
  public.tracking_sync_runs,
  public.cost_entries,
  public.repairs,
  public.market_sources,
  public.market_listings,
  public.valuation_snapshots,
  public.sales,
  public.attachments
to authenticated;
grant select, insert, update, delete on public.audit_logs to authenticated;
grant select on public.asset_financials, public.portfolio_metrics to authenticated;

grant all on all tables in schema public to service_role;
grant all on all sequences in schema public to service_role;
