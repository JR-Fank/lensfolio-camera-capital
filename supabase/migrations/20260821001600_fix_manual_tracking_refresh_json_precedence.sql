-- Preserve the manual tracking refresh function while making JSON extraction
-- explicit before concatenating deterministic event identifiers.

create or replace function public.complete_manual_tracking_sync(
  p_run_id uuid,
  p_shipment_id uuid,
  p_finished_at timestamptz,
  p_events jsonb
)
returns jsonb
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_user_id uuid := (select auth.uid());
  v_portfolio_id uuid;
  v_current_status public.shipment_status;
  v_next_status public.shipment_status;
  v_latest_raw_status text;
  v_latest_status_label text;
  v_shipped_at timestamptz;
  v_delivered_at timestamptz;
  v_events_seen integer;
  v_events_inserted integer;
begin
  if v_user_id is null then
    raise exception using errcode = '28000', message = 'Authentication required.';
  end if;

  if p_finished_at is null
    or p_events is null
    or jsonb_typeof(p_events) <> 'array'
    or jsonb_array_length(p_events) = 0 then
    raise exception using errcode = '22023', message = 'A finish time and at least one tracking event are required.';
  end if;

  if exists (
    select 1
    from jsonb_array_elements(p_events) event
    where coalesce(event->>'event_fingerprint', '') !~ '^[a-f0-9]{64}$'
      or nullif(btrim(event->>'raw_status'), '') is null
      or nullif(btrim(event->>'status_label'), '') is null
      or nullif(event->>'occurred_at', '') is null
  ) then
    raise exception using errcode = '22023', message = 'Tracking event payload is incomplete.';
  end if;

  select shipment.portfolio_id, shipment.status
  into v_portfolio_id, v_current_status
  from public.shipments shipment
  where shipment.id = p_shipment_id;

  if v_portfolio_id is null then
    raise exception using errcode = 'P0002', message = 'Shipment was not found through RLS.';
  end if;

  if not (select private.can_write_portfolio(v_portfolio_id)) then
    raise exception using errcode = '42501', message = 'Portfolio write access required.';
  end if;

  if not exists (
    select 1
    from public.tracking_sync_runs run
    where run.id = p_run_id
      and run.portfolio_id = v_portfolio_id
      and run.shipment_id = p_shipment_id
      and run.created_by = v_user_id
      and run.status = 'running'
  ) then
    raise exception using errcode = '22023', message = 'Running tracking sync record was not found.';
  end if;

  with inserted as (
    insert into public.tracking_events (
      portfolio_id,
      shipment_id,
      legacy_id,
      external_event_id,
      raw_status,
      status,
      description,
      location,
      occurred_at,
      created_by
    )
    select
      v_portfolio_id,
      p_shipment_id,
      'tracking:japan-post:' || (event->>'event_fingerprint'),
      'japan-post:' || (event->>'event_fingerprint'),
      btrim(event->>'raw_status'),
      btrim(event->>'status_label'),
      nullif(btrim(event->>'description'), ''),
      nullif(btrim(event->>'location'), ''),
      (event->>'occurred_at')::timestamptz,
      v_user_id
    from jsonb_array_elements(p_events) event
    on conflict (shipment_id, external_event_id) do nothing
    returning id
  )
  select count(*) into v_events_inserted from inserted;

  v_events_seen := jsonb_array_length(p_events);

  select btrim(event->>'raw_status'), btrim(event->>'status_label')
  into v_latest_raw_status, v_latest_status_label
  from jsonb_array_elements(p_events) event
  order by (event->>'occurred_at')::timestamptz desc,
    event->>'event_fingerprint' desc
  limit 1;

  select min((event->>'occurred_at')::timestamptz)
  into v_shipped_at
  from jsonb_array_elements(p_events) event
  where event->>'raw_status' in (
    'Posting/Collection',
    'Dispatch from outward office of exchange'
  );

  select max((event->>'occurred_at')::timestamptz)
  into v_delivered_at
  from jsonb_array_elements(p_events) event
  where event->>'raw_status' = 'Final delivery';

  if v_delivered_at is not null then
    v_next_status := 'delivered';
  elsif v_current_status in ('delivered', 'cancelled') then
    v_next_status := v_current_status;
  elsif v_latest_raw_status = 'Arrival at inward office of exchange' then
    v_next_status := 'customs';
  else
    v_next_status := 'in_transit';
  end if;

  update public.shipments
  set status = v_next_status,
      shipped_at = coalesce(shipped_at, v_shipped_at),
      delivered_at = coalesce(delivered_at, v_delivered_at),
      legacy_status = coalesce(v_latest_status_label, legacy_status)
  where id = p_shipment_id
    and portfolio_id = v_portfolio_id;

  update public.tracking_sync_runs
  set finished_at = p_finished_at,
      status = 'succeeded',
      events_seen = v_events_seen,
      events_inserted = v_events_inserted,
      error_message = null
  where id = p_run_id
    and portfolio_id = v_portfolio_id
    and shipment_id = p_shipment_id
    and status = 'running';

  return jsonb_build_object(
    'run_id', p_run_id,
    'shipment_id', p_shipment_id,
    'events_seen', v_events_seen,
    'events_inserted', v_events_inserted,
    'shipment_status', v_next_status,
    'shipped_at', v_shipped_at,
    'delivered_at', v_delivered_at,
    'latest_status', v_latest_status_label
  );
end;
$$;

revoke all on function public.complete_manual_tracking_sync(uuid, uuid, timestamptz, jsonb)
  from public, anon;
grant execute on function public.complete_manual_tracking_sync(uuid, uuid, timestamptz, jsonb)
  to authenticated;
