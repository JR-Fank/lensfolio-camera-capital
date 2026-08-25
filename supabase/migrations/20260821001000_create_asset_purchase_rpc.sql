create or replace function public.create_asset_with_purchase(
  p_portfolio_id uuid,
  p_brand text,
  p_model text,
  p_purchase_date date,
  p_actual_paid_cny numeric,
  p_serial_number text,
  p_measured_weight_g integer,
  p_condition text,
  p_operational_status public.asset_operational_status,
  p_notes text,
  p_purchase_price_jpy numeric,
  p_exchange_rate_jpy_to_cny numeric,
  p_platform text,
  p_order_reference text
)
returns table (
  asset_id uuid,
  purchase_order_id uuid,
  purchase_item_id uuid,
  cost_entry_id uuid
)
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_user_id uuid := (select auth.uid());
  v_asset_id uuid := gen_random_uuid();
  v_purchase_order_id uuid := gen_random_uuid();
  v_purchase_item_id uuid := gen_random_uuid();
  v_cost_entry_id uuid := gen_random_uuid();
  v_occurred_at timestamptz;
begin
  if v_user_id is null then
    raise exception using errcode = '28000', message = 'Authentication required.';
  end if;

  if not (select private.can_write_portfolio(p_portfolio_id)) then
    raise exception using errcode = '42501', message = 'Portfolio write access required.';
  end if;

  if nullif(btrim(p_brand), '') is null or nullif(btrim(p_model), '') is null then
    raise exception using errcode = '22023', message = 'Brand and model are required.';
  end if;

  if p_purchase_date is null then
    raise exception using errcode = '22023', message = 'Purchase date is required.';
  end if;

  if p_actual_paid_cny is null or p_actual_paid_cny <= 0
    or p_actual_paid_cny <> round(p_actual_paid_cny, 2) then
    raise exception using errcode = '22023', message = 'Actual paid CNY must be a positive amount with at most two decimal places.';
  end if;

  if p_measured_weight_g is not null and p_measured_weight_g <= 0 then
    raise exception using errcode = '22023', message = 'Measured weight must be positive.';
  end if;

  if (p_purchase_price_jpy is null) <> (p_exchange_rate_jpy_to_cny is null) then
    raise exception using errcode = '22023', message = 'JPY price and exchange rate must be supplied together.';
  end if;

  if p_purchase_price_jpy is not null and p_purchase_price_jpy < 0 then
    raise exception using errcode = '22023', message = 'JPY purchase price cannot be negative.';
  end if;

  if p_exchange_rate_jpy_to_cny is not null and p_exchange_rate_jpy_to_cny <= 0 then
    raise exception using errcode = '22023', message = 'JPY exchange rate must be positive.';
  end if;

  v_occurred_at := p_purchase_date::timestamp at time zone 'Asia/Hong_Kong';

  insert into public.assets (
    id, portfolio_id, brand, model, serial_number, condition,
    operational_status, acquired_at, measured_weight_g, created_by
  ) values (
    v_asset_id,
    p_portfolio_id,
    btrim(p_brand),
    btrim(p_model),
    nullif(btrim(p_serial_number), ''),
    nullif(btrim(p_condition), ''),
    coalesce(p_operational_status, 'acquired'),
    v_occurred_at,
    p_measured_weight_g,
    v_user_id
  );

  if nullif(btrim(p_notes), '') is not null then
    insert into public.asset_status_events (
      portfolio_id, asset_id, operational_status, note, occurred_at, created_by
    ) values (
      p_portfolio_id,
      v_asset_id,
      coalesce(p_operational_status, 'acquired'),
      btrim(p_notes),
      v_occurred_at,
      v_user_id
    );
  end if;

  insert into public.purchase_orders (
    id, portfolio_id, vendor, platform, order_reference, original_currency,
    ordered_at, status, original_subtotal_jpy, coupon_jpy, fee_jpy,
    domestic_shipping_jpy, exchange_rate_jpy_to_cny, actual_paid_cny,
    allocation_method, created_by
  ) values (
    v_purchase_order_id,
    p_portfolio_id,
    null,
    nullif(btrim(p_platform), ''),
    nullif(btrim(p_order_reference), ''),
    case when p_purchase_price_jpy is null then 'CNY' else 'JPY' end,
    v_occurred_at,
    'paid',
    coalesce(p_purchase_price_jpy, 0),
    0,
    0,
    0,
    coalesce(p_exchange_rate_jpy_to_cny, 1),
    p_actual_paid_cny,
    'equal',
    v_user_id
  );

  insert into public.purchase_items (
    id, portfolio_id, purchase_order_id, asset_id, original_price_jpy,
    allocation_method, allocation_ratio, allocated_cost_cny, created_by
  ) values (
    v_purchase_item_id,
    p_portfolio_id,
    v_purchase_order_id,
    v_asset_id,
    coalesce(p_purchase_price_jpy, 0),
    'equal',
    1,
    p_actual_paid_cny,
    v_user_id
  );

  insert into public.cost_entries (
    id, portfolio_id, asset_id, cost_type, source_type, source_id,
    original_amount, currency, fx_rate_to_cny, amount_cny,
    entry_status, occurred_at, created_by
  ) values (
    v_cost_entry_id,
    p_portfolio_id,
    v_asset_id,
    'purchase',
    'purchase_item',
    v_purchase_item_id,
    p_actual_paid_cny,
    'CNY',
    1,
    p_actual_paid_cny,
    'posted',
    v_occurred_at,
    v_user_id
  );

  return query select
    v_asset_id,
    v_purchase_order_id,
    v_purchase_item_id,
    v_cost_entry_id;
end;
$$;

revoke all on function public.create_asset_with_purchase(
  uuid, text, text, date, numeric, text, integer, text,
  public.asset_operational_status, text, numeric, numeric, text, text
) from public, anon;

grant execute on function public.create_asset_with_purchase(
  uuid, text, text, date, numeric, text, integer, text,
  public.asset_operational_status, text, numeric, numeric, text, text
) to authenticated;
