-- Transactional, RLS-respecting entry points for confirmed Codex evidence imports.

-- Evidence that is not present stays NULL; zero is a financial fact, not a placeholder.
alter table public.purchase_orders
  alter column original_subtotal_jpy drop not null,
  alter column original_subtotal_jpy drop default,
  alter column coupon_jpy drop not null,
  alter column coupon_jpy drop default,
  alter column fee_jpy drop not null,
  alter column fee_jpy drop default,
  alter column domestic_shipping_jpy drop not null,
  alter column domestic_shipping_jpy drop default,
  alter column exchange_rate_jpy_to_cny drop not null;

alter table public.purchase_items
  alter column original_price_jpy drop not null;

create unique index shipments_portfolio_tracking_number_key
  on public.shipments (portfolio_id, tracking_number)
  where tracking_number is not null;

create or replace function public.import_purchase_evidence(
  p_portfolio_id uuid,
  p_evidence_fingerprint text,
  p_payload_hash text,
  p_source_files jsonb,
  p_payload jsonb
)
returns jsonb
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_user_id uuid := (select auth.uid());
  v_order_id uuid;
  v_asset_id uuid;
  v_item_id uuid;
  v_cost_id uuid;
  v_audit_id uuid := gen_random_uuid();
  v_asset jsonb;
  v_asset_ids uuid[] := array[]::uuid[];
  v_item_ids uuid[] := array[]::uuid[];
  v_cost_ids uuid[] := array[]::uuid[];
  v_actual_paid numeric(20, 2);
  v_allocated_total numeric(20, 2);
  v_purchase_date date;
  v_occurred_at timestamptz;
  v_order_legacy_id text;
  v_index integer := 0;
begin
  if v_user_id is null then
    raise exception using errcode = '28000', message = 'Authentication required.';
  end if;

  if not (select private.can_write_portfolio(p_portfolio_id)) then
    raise exception using errcode = '42501', message = 'Portfolio write access required.';
  end if;

  if p_evidence_fingerprint !~ '^[a-f0-9]{64}$'
    or p_payload_hash !~ '^[a-f0-9]{64}$' then
    raise exception using errcode = '22023', message = 'Evidence fingerprints must be SHA-256 hex strings.';
  end if;

  if jsonb_typeof(p_source_files) <> 'array' or jsonb_typeof(p_payload->'assets') <> 'array'
    or jsonb_array_length(p_payload->'assets') = 0 then
    raise exception using errcode = '22023', message = 'Purchase evidence requires source_files and at least one asset.';
  end if;

  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('purchase:' || p_evidence_fingerprint, 0));
  v_order_legacy_id := 'evidence:purchase:' || p_evidence_fingerprint;

  select po.id into v_order_id
  from public.purchase_orders po
  where po.portfolio_id = p_portfolio_id
    and po.legacy_id = v_order_legacy_id;

  if v_order_id is not null then
    if exists (
      select 1
      from public.purchase_orders po
      where po.id = v_order_id
        and (
          po.actual_paid_cny is distinct from (p_payload->>'actual_paid_cny')::numeric
          or (
            select count(*) from public.purchase_items pi
            where pi.purchase_order_id = v_order_id
          ) <> jsonb_array_length(p_payload->'assets')
          or abs(
            (
              select coalesce(sum(pi.allocated_cost_cny), 0)
              from public.purchase_items pi
              where pi.purchase_order_id = v_order_id
            ) - (
              select coalesce(sum((asset->>'allocated_cost_cny')::numeric), 0)
              from jsonb_array_elements(p_payload->'assets') asset
            )
          ) > 0.01
        )
    ) then
      raise exception using
        errcode = '22023',
        message = 'Conflicting purchase evidence exists for this order reference.';
    end if;

    select
      coalesce(array_agg(pi.asset_id order by pi.created_at), array[]::uuid[]),
      coalesce(array_agg(pi.id order by pi.created_at), array[]::uuid[])
    into v_asset_ids, v_item_ids
    from public.purchase_items pi
    where pi.portfolio_id = p_portfolio_id
      and pi.purchase_order_id = v_order_id;

    select coalesce(array_agg(ce.id order by ce.created_at), array[]::uuid[])
    into v_cost_ids
    from public.cost_entries ce
    where ce.portfolio_id = p_portfolio_id
      and ce.source_type = 'purchase_item'
      and ce.source_id = any(v_item_ids)
      and ce.cost_type = 'purchase';

    insert into public.audit_logs (
      id, portfolio_id, actor_id, action, entity_type, entity_id, after_data
    ) values (
      v_audit_id,
      p_portfolio_id,
      v_user_id,
      'evidence_import_duplicate',
      'purchase_evidence',
      v_order_id,
      jsonb_build_object(
        'evidence_type', 'purchase',
        'normalized_payload_hash', p_payload_hash,
        'evidence_fingerprint', p_evidence_fingerprint,
        'source_files', p_source_files,
        'importing_user', v_user_id,
        'affected_asset_ids', to_jsonb(v_asset_ids),
        'purchase_order_id', v_order_id,
        'purchase_item_ids', to_jsonb(v_item_ids),
        'cost_entry_ids', to_jsonb(v_cost_ids),
        'idempotent_replay', true
      )
    );

    return jsonb_build_object(
      'audit_id', v_audit_id,
      'idempotent', true,
      'purchase_order_id', v_order_id,
      'asset_ids', to_jsonb(v_asset_ids),
      'purchase_item_ids', to_jsonb(v_item_ids),
      'cost_entry_ids', to_jsonb(v_cost_ids)
    );
  end if;

  v_purchase_date := (p_payload->>'purchase_date')::date;
  v_actual_paid := (p_payload->>'actual_paid_cny')::numeric;
  v_allocated_total := (
    select coalesce(sum((asset->>'allocated_cost_cny')::numeric), 0)
    from jsonb_array_elements(p_payload->'assets') asset
  );

  if v_purchase_date is null or v_actual_paid is null or v_actual_paid <= 0
    or v_actual_paid <> round(v_actual_paid, 2) then
    raise exception using errcode = '22023', message = 'Purchase date and a positive two-decimal actual CNY payment are required.';
  end if;

  if abs(v_allocated_total - v_actual_paid) > 0.01 then
    raise exception using errcode = '22023', message = 'Purchase allocations must equal actual paid CNY within 0.01.';
  end if;

  if (p_payload->>'purchase_price_jpy') is not null
    and ((p_payload->>'exchange_rate_jpy_to_cny') is null
      or (p_payload->>'exchange_rate_jpy_to_cny')::numeric <= 0) then
    raise exception using errcode = '22023', message = 'A positive JPY exchange rate is required when JPY price is present.';
  end if;

  v_occurred_at := v_purchase_date::timestamp at time zone 'Asia/Hong_Kong';
  v_order_id := gen_random_uuid();

  insert into public.purchase_orders (
    id, portfolio_id, legacy_id, vendor, platform, order_reference,
    original_currency, ordered_at, status, original_subtotal_jpy,
    coupon_jpy, fee_jpy, domestic_shipping_jpy,
    exchange_rate_jpy_to_cny, actual_paid_cny, allocation_method, created_by
  ) values (
    v_order_id,
    p_portfolio_id,
    v_order_legacy_id,
    nullif(btrim(p_payload->>'seller'), ''),
    nullif(btrim(p_payload->>'platform'), ''),
    nullif(btrim(p_payload->>'order_reference'), ''),
    case when (p_payload->>'purchase_price_jpy') is null then 'CNY' else 'JPY' end,
    v_occurred_at,
    'paid',
    (p_payload->>'purchase_price_jpy')::numeric,
    (p_payload->>'coupon_jpy')::numeric,
    case
      when (p_payload->>'fee_jpy') is null and (p_payload->>'photo_fee_jpy') is null then null
      else coalesce((p_payload->>'fee_jpy')::numeric, 0)
        + coalesce((p_payload->>'photo_fee_jpy')::numeric, 0)
    end,
    (p_payload->>'domestic_shipping_jpy')::numeric,
    (p_payload->>'exchange_rate_jpy_to_cny')::numeric,
    v_actual_paid,
    coalesce(nullif(p_payload->>'allocation_method', ''), 'manual')::public.allocation_method,
    v_user_id
  );

  for v_asset in select value from jsonb_array_elements(p_payload->'assets') loop
    v_index := v_index + 1;

    if nullif(btrim(v_asset->>'brand'), '') is null
      or nullif(btrim(v_asset->>'model'), '') is null then
      raise exception using errcode = '22023', message = 'Every asset requires a confirmed brand and model.';
    end if;

    if (v_asset->>'measured_weight_g') is not null
      and (v_asset->>'measured_weight_g')::integer <= 0 then
      raise exception using errcode = '22023', message = 'Measured weight must be positive when supplied.';
    end if;

    v_asset_id := gen_random_uuid();
    v_item_id := gen_random_uuid();
    v_cost_id := gen_random_uuid();

    insert into public.assets (
      id, portfolio_id, legacy_id, brand, model, serial_number, condition,
      operational_status, acquired_at, measured_weight_g, created_by
    ) values (
      v_asset_id,
      p_portfolio_id,
      'evidence:asset:' || p_evidence_fingerprint || ':' || v_index,
      btrim(v_asset->>'brand'),
      btrim(v_asset->>'model'),
      nullif(btrim(v_asset->>'serial_number'), ''),
      nullif(btrim(v_asset->>'condition'), ''),
      coalesce(nullif(v_asset->>'status', ''), 'acquired')::public.asset_operational_status,
      v_occurred_at,
      (v_asset->>'measured_weight_g')::integer,
      v_user_id
    );

    if nullif(btrim(v_asset->>'notes'), '') is not null then
      insert into public.asset_status_events (
        portfolio_id, asset_id, operational_status, note, occurred_at, created_by
      ) values (
        p_portfolio_id,
        v_asset_id,
        coalesce(nullif(v_asset->>'status', ''), 'acquired')::public.asset_operational_status,
        btrim(v_asset->>'notes'),
        v_occurred_at,
        v_user_id
      );
    end if;

    insert into public.purchase_items (
      id, portfolio_id, purchase_order_id, asset_id, legacy_id,
      original_price_jpy, allocation_method, allocation_ratio,
      allocated_cost_cny, created_by
    ) values (
      v_item_id,
      p_portfolio_id,
      v_order_id,
      v_asset_id,
      'evidence:purchase-item:' || p_evidence_fingerprint || ':' || v_index,
      (v_asset->>'purchase_price_jpy')::numeric,
      coalesce(nullif(v_asset->>'allocation_method', ''), 'manual')::public.allocation_method,
      round((v_asset->>'allocated_cost_cny')::numeric / v_actual_paid, 10),
      (v_asset->>'allocated_cost_cny')::numeric,
      v_user_id
    );

    insert into public.cost_entries (
      id, portfolio_id, asset_id, cost_type, source_type, source_id,
      original_amount, currency, fx_rate_to_cny, amount_cny,
      entry_status, occurred_at, created_by
    ) values (
      v_cost_id,
      p_portfolio_id,
      v_asset_id,
      'purchase',
      'purchase_item',
      v_item_id,
      (v_asset->>'allocated_cost_cny')::numeric,
      'CNY',
      1,
      (v_asset->>'allocated_cost_cny')::numeric,
      'posted',
      v_occurred_at,
      v_user_id
    );

    v_asset_ids := array_append(v_asset_ids, v_asset_id);
    v_item_ids := array_append(v_item_ids, v_item_id);
    v_cost_ids := array_append(v_cost_ids, v_cost_id);
  end loop;

  insert into public.audit_logs (
    id, portfolio_id, actor_id, action, entity_type, entity_id, after_data
  ) values (
    v_audit_id,
    p_portfolio_id,
    v_user_id,
    'evidence_import',
    'purchase_evidence',
    v_order_id,
    jsonb_build_object(
      'evidence_type', 'purchase',
      'normalized_payload_hash', p_payload_hash,
      'evidence_fingerprint', p_evidence_fingerprint,
      'source_files', p_source_files,
      'importing_user', v_user_id,
      'affected_asset_ids', to_jsonb(v_asset_ids),
      'purchase_order_id', v_order_id,
      'purchase_item_ids', to_jsonb(v_item_ids),
      'cost_entry_ids', to_jsonb(v_cost_ids),
      'normalized_payload', p_payload,
      'idempotent_replay', false
    )
  );

  return jsonb_build_object(
    'audit_id', v_audit_id,
    'idempotent', false,
    'purchase_order_id', v_order_id,
    'asset_ids', to_jsonb(v_asset_ids),
    'purchase_item_ids', to_jsonb(v_item_ids),
    'cost_entry_ids', to_jsonb(v_cost_ids)
  );
end;
$$;

create or replace function public.import_logistics_evidence(
  p_portfolio_id uuid,
  p_evidence_fingerprint text,
  p_payload_hash text,
  p_source_files jsonb,
  p_payload jsonb
)
returns jsonb
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_user_id uuid := (select auth.uid());
  v_shipment_id uuid;
  v_item_id uuid;
  v_event_id uuid;
  v_cost_id uuid;
  v_audit_id uuid := gen_random_uuid();
  v_asset jsonb;
  v_event jsonb;
  v_asset_ids uuid[] := array[]::uuid[];
  v_item_ids uuid[] := array[]::uuid[];
  v_event_ids uuid[] := array[]::uuid[];
  v_cost_ids uuid[] := array[]::uuid[];
  v_tracking_number text := nullif(btrim(p_payload->>'tracking_number'), '');
  v_shipment_legacy_id text;
  v_cost numeric(20, 2) := (p_payload->>'shipping_cost_cny')::numeric;
  v_allocation_total numeric(20, 2);
  v_payment_status text := nullif(p_payload->>'payment_status', '');
  v_entry_status public.cost_entry_status;
  v_existing_entry_status public.cost_entry_status;
  v_created boolean := false;
  v_index integer := 0;
begin
  if v_user_id is null then
    raise exception using errcode = '28000', message = 'Authentication required.';
  end if;

  if not (select private.can_write_portfolio(p_portfolio_id)) then
    raise exception using errcode = '42501', message = 'Portfolio write access required.';
  end if;

  if p_evidence_fingerprint !~ '^[a-f0-9]{64}$'
    or p_payload_hash !~ '^[a-f0-9]{64}$' then
    raise exception using errcode = '22023', message = 'Evidence fingerprints must be SHA-256 hex strings.';
  end if;

  if jsonb_typeof(p_source_files) <> 'array'
    or jsonb_typeof(p_payload->'assets') <> 'array'
    or jsonb_array_length(p_payload->'assets') = 0
    or jsonb_typeof(p_payload->'tracking_events') <> 'array' then
    raise exception using errcode = '22023', message = 'Logistics evidence requires source_files, assets, and tracking_events arrays.';
  end if;

  if v_cost is not null and (v_cost < 0 or v_cost <> round(v_cost, 2)) then
    raise exception using errcode = '22023', message = 'Shipping cost CNY must be nonnegative with at most two decimals.';
  end if;

  if v_cost is not null and v_payment_status not in ('paid', 'pending', 'budget') then
    raise exception using errcode = '22023', message = 'A confirmed paid, pending, or budget payment status is required with a CNY cost.';
  end if;

  v_allocation_total := (
    select coalesce(sum((asset->>'allocated_shipping_cny')::numeric), 0)
    from jsonb_array_elements(p_payload->'assets') asset
  );

  if v_cost is not null and abs(v_allocation_total - v_cost) > 0.01 then
    raise exception using errcode = '22023', message = 'Shipment allocations must equal shipping cost CNY within 0.01.';
  end if;

  if v_cost is null and abs(v_allocation_total) > 0.01 then
    raise exception using errcode = '22023', message = 'Shipment allocations require a confirmed shipping cost CNY.';
  end if;

  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('logistics:' || p_evidence_fingerprint, 0));
  v_shipment_legacy_id := 'evidence:logistics:' || p_evidence_fingerprint;

  if v_tracking_number is not null then
    select s.id into v_shipment_id
    from public.shipments s
    where s.portfolio_id = p_portfolio_id
      and s.tracking_number = v_tracking_number;
  end if;

  if v_shipment_id is null then
    select s.id into v_shipment_id
    from public.shipments s
    where s.portfolio_id = p_portfolio_id
      and s.legacy_id = v_shipment_legacy_id;
  end if;

  if v_shipment_id is null then
    v_shipment_id := gen_random_uuid();
    v_created := true;

    insert into public.shipments (
      id, portfolio_id, legacy_id, carrier, tracking_number, status,
      shipped_at, actual_paid_cny, budget_cny, origin, destination,
      bare_weight_g, chargeable_weight_g, legacy_status, created_by
    ) values (
      v_shipment_id,
      p_portfolio_id,
      v_shipment_legacy_id,
      nullif(btrim(p_payload->>'carrier'), ''),
      v_tracking_number,
      coalesce(nullif(p_payload->>'status', ''), 'draft')::public.shipment_status,
      (p_payload->>'shipping_date')::date::timestamp at time zone 'Asia/Hong_Kong',
      case when v_payment_status = 'paid' then coalesce(v_cost, 0) else 0 end,
      case when v_payment_status in ('pending', 'budget') then coalesce(v_cost, 0) else 0 end,
      nullif(btrim(p_payload->>'origin'), ''),
      nullif(btrim(p_payload->>'destination'), ''),
      (p_payload->>'bare_weight_g')::integer,
      (p_payload->>'chargeable_weight_g')::integer,
      nullif(btrim(p_payload->>'legacy_status'), ''),
      v_user_id
    );
  else
    update public.shipments
    set carrier = coalesce(nullif(btrim(p_payload->>'carrier'), ''), carrier),
        tracking_number = coalesce(v_tracking_number, tracking_number),
        status = coalesce(nullif(p_payload->>'status', '')::public.shipment_status, status),
        shipped_at = coalesce(
          (p_payload->>'shipping_date')::date::timestamp at time zone 'Asia/Hong_Kong',
          shipped_at
        ),
        actual_paid_cny = case
          when v_cost is null then actual_paid_cny
          when v_payment_status = 'paid' then v_cost
          else actual_paid_cny
        end,
        budget_cny = case
          when v_cost is null then budget_cny
          when v_payment_status = 'paid' then 0
          else v_cost
        end,
        origin = coalesce(nullif(btrim(p_payload->>'origin'), ''), origin),
        destination = coalesce(nullif(btrim(p_payload->>'destination'), ''), destination),
        bare_weight_g = coalesce((p_payload->>'bare_weight_g')::integer, bare_weight_g),
        chargeable_weight_g = coalesce((p_payload->>'chargeable_weight_g')::integer, chargeable_weight_g),
        legacy_status = coalesce(nullif(btrim(p_payload->>'legacy_status'), ''), legacy_status)
    where id = v_shipment_id and portfolio_id = p_portfolio_id;
  end if;

  for v_asset in select value from jsonb_array_elements(p_payload->'assets') loop
    v_index := v_index + 1;

    if (v_asset->>'asset_id') is null then
      raise exception using errcode = '22023', message = 'Every shipment item requires a resolved asset UUID.';
    end if;

    if not exists (
      select 1 from public.assets a
      where a.id = (v_asset->>'asset_id')::uuid and a.portfolio_id = p_portfolio_id
    ) then
      raise exception using errcode = '23503', message = 'Resolved asset does not belong to this portfolio.';
    end if;

    select si.id into v_item_id
    from public.shipment_items si
    where si.shipment_id = v_shipment_id
      and si.asset_id = (v_asset->>'asset_id')::uuid;

    if v_item_id is null then
      v_item_id := gen_random_uuid();
      insert into public.shipment_items (
        id, portfolio_id, shipment_id, asset_id, legacy_id,
        weight_snapshot_g, allocation_method, allocation_ratio,
        allocated_shipping_cny, allocation_locked_at, allocation_version, created_by
      ) values (
        v_item_id,
        p_portfolio_id,
        v_shipment_id,
        (v_asset->>'asset_id')::uuid,
        'evidence:shipment-item:' || p_evidence_fingerprint || ':' || v_index,
        (v_asset->>'weight_snapshot_g')::integer,
        (v_asset->>'allocation_method')::public.allocation_method,
        (v_asset->>'allocation_ratio')::numeric,
        (v_asset->>'allocated_shipping_cny')::numeric,
        now(),
        1,
        v_user_id
      );
    else
      if exists (
        select 1 from public.shipment_items si
        where si.id = v_item_id
          and (
            si.weight_snapshot_g is distinct from (v_asset->>'weight_snapshot_g')::integer
            or si.allocation_method is distinct from (v_asset->>'allocation_method')::public.allocation_method
            or si.allocation_ratio is distinct from (v_asset->>'allocation_ratio')::numeric
            or si.allocated_shipping_cny is distinct from (v_asset->>'allocated_shipping_cny')::numeric
          )
      ) then
        raise exception using errcode = 'P0001', message = 'Existing locked shipment allocation differs from evidence.';
      end if;
    end if;

    v_asset_ids := array_append(v_asset_ids, (v_asset->>'asset_id')::uuid);
    v_item_ids := array_append(v_item_ids, v_item_id);

    if v_cost is not null then
      v_entry_status := (
        case when v_payment_status = 'paid' then 'posted' else 'pending' end
      )::public.cost_entry_status;
      v_cost_id := null;
      v_existing_entry_status := null;

      select ce.id, ce.entry_status into v_cost_id, v_existing_entry_status
      from public.cost_entries ce
      where ce.asset_id = (v_asset->>'asset_id')::uuid
        and ce.source_type = 'shipment_item'
        and ce.source_id = v_item_id
        and ce.cost_type = 'international_shipping';

      if v_cost_id is null then
        v_cost_id := gen_random_uuid();
        insert into public.cost_entries (
          id, portfolio_id, asset_id, cost_type, source_type, source_id,
          original_amount, currency, fx_rate_to_cny, amount_cny,
          entry_status, occurred_at, created_by
        ) values (
          v_cost_id,
          p_portfolio_id,
          (v_asset->>'asset_id')::uuid,
          'international_shipping',
          'shipment_item',
          v_item_id,
          (v_asset->>'allocated_shipping_cny')::numeric,
          'CNY',
          1,
          (v_asset->>'allocated_shipping_cny')::numeric,
          v_entry_status,
          coalesce(
            (p_payload->>'shipping_date')::date::timestamp at time zone 'Asia/Hong_Kong',
            now()
          ),
          v_user_id
        );
      elsif v_existing_entry_status = 'posted' and v_entry_status = 'pending' then
        raise exception using errcode = '22023', message = 'Posted shipping cost cannot be downgraded to pending.';
      elsif v_existing_entry_status = 'posted'
        and exists (
          select 1 from public.cost_entries ce
          where ce.id = v_cost_id
            and ce.amount_cny is distinct from (v_asset->>'allocated_shipping_cny')::numeric
        ) then
        raise exception using errcode = '22023', message = 'Posted shipping cost amount cannot be changed by evidence replay.';
      else
        update public.cost_entries
        set original_amount = (v_asset->>'allocated_shipping_cny')::numeric,
            amount_cny = (v_asset->>'allocated_shipping_cny')::numeric,
            entry_status = v_entry_status
        where id = v_cost_id and portfolio_id = p_portfolio_id;
      end if;

      v_cost_ids := array_append(v_cost_ids, v_cost_id);
    end if;
  end loop;

  for v_event in select value from jsonb_array_elements(p_payload->'tracking_events') loop
    if nullif(btrim(v_event->>'event_fingerprint'), '') is null
      or nullif(btrim(v_event->>'status'), '') is null
      or (v_event->>'occurred_at') is null then
      raise exception using errcode = '22023', message = 'Tracking events require fingerprint, status, and occurred_at.';
    end if;

    v_event_id := null;
    insert into public.tracking_events (
      id, portfolio_id, shipment_id, legacy_id, external_event_id,
      raw_status, status, description, location, occurred_at, created_by
    ) values (
      gen_random_uuid(),
      p_portfolio_id,
      v_shipment_id,
      'evidence:tracking-event:' || (v_event->>'event_fingerprint'),
      'evidence:' || (v_event->>'event_fingerprint'),
      nullif(btrim(v_event->>'raw_status'), ''),
      btrim(v_event->>'status'),
      nullif(btrim(v_event->>'status_label'), ''),
      nullif(btrim(v_event->>'location'), ''),
      (v_event->>'occurred_at')::timestamptz,
      v_user_id
    )
    on conflict (shipment_id, external_event_id) do nothing
    returning id into v_event_id;

    if v_event_id is null then
      select te.id into v_event_id
      from public.tracking_events te
      where te.shipment_id = v_shipment_id
        and te.external_event_id = 'evidence:' || (v_event->>'event_fingerprint');
    end if;

    v_event_ids := array_append(v_event_ids, v_event_id);
  end loop;

  insert into public.audit_logs (
    id, portfolio_id, actor_id, action, entity_type, entity_id, after_data
  ) values (
    v_audit_id,
    p_portfolio_id,
    v_user_id,
    case when v_created then 'evidence_import' else 'evidence_import_update' end,
    'logistics_evidence',
    v_shipment_id,
    jsonb_build_object(
      'evidence_type', 'logistics',
      'normalized_payload_hash', p_payload_hash,
      'evidence_fingerprint', p_evidence_fingerprint,
      'source_files', p_source_files,
      'importing_user', v_user_id,
      'affected_asset_ids', to_jsonb(v_asset_ids),
      'shipment_id', v_shipment_id,
      'shipment_item_ids', to_jsonb(v_item_ids),
      'tracking_event_ids', to_jsonb(v_event_ids),
      'cost_entry_ids', to_jsonb(v_cost_ids),
      'normalized_payload', p_payload,
      'created_shipment', v_created
    )
  );

  return jsonb_build_object(
    'audit_id', v_audit_id,
    'idempotent', not v_created,
    'shipment_id', v_shipment_id,
    'asset_ids', to_jsonb(v_asset_ids),
    'shipment_item_ids', to_jsonb(v_item_ids),
    'tracking_event_ids', to_jsonb(v_event_ids),
    'cost_entry_ids', to_jsonb(v_cost_ids)
  );
end;
$$;

revoke all on function public.import_purchase_evidence(uuid, text, text, jsonb, jsonb)
  from public, anon;
grant execute on function public.import_purchase_evidence(uuid, text, text, jsonb, jsonb)
  to authenticated;

revoke all on function public.import_logistics_evidence(uuid, text, text, jsonb, jsonb)
  from public, anon;
grant execute on function public.import_logistics_evidence(uuid, text, text, jsonb, jsonb)
  to authenticated;
