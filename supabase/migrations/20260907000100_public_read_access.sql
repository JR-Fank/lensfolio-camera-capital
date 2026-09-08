-- Public presentation reads only. Existing authenticated write policies are unchanged.
-- No credentials, membership rows, auth identifiers, evidence blobs or audit logs.
begin;

-- Close both direct and inherited anonymous grants before applying the allowlist.
revoke all on all tables in schema public from anon, public;
revoke all on all sequences in schema public from anon, public;
revoke execute on all functions in schema public from anon, public;
revoke execute on all functions in schema private from anon, public;
revoke all on schema private from anon;
alter default privileges in schema public revoke execute on functions from public, anon;
alter default privileges in schema private revoke execute on functions from public, anon;
grant usage on schema public to anon;

grant select (id) on public.portfolios to anon;
create policy portfolios_select_public
on public.portfolios for select to anon using (id = 'c9392708-c769-5f74-9587-b3071bc354bd'::uuid);

grant select (id,portfolio_id,legacy_id,brand,model,serial_number,condition,operational_status,repair_status,acquired_at,measured_weight_g) on public.assets to anon;
create policy assets_select_public
on public.assets for select to anon using (portfolio_id = 'c9392708-c769-5f74-9587-b3071bc354bd'::uuid);

grant select (id,portfolio_id,asset_id,amount_cny,entry_status,cost_type,source_id,source_type,reversal_of) on public.cost_entries to anon;
create policy cost_entries_select_public
on public.cost_entries for select to anon using (portfolio_id = 'c9392708-c769-5f74-9587-b3071bc354bd'::uuid);

grant select (id,portfolio_id,asset_id,market_source_id,low,median,high,sample_count,confidence,methodology_version,valued_at) on public.valuation_snapshots to anon;
create policy valuation_snapshots_select_public
on public.valuation_snapshots for select to anon using (portfolio_id = 'c9392708-c769-5f74-9587-b3071bc354bd'::uuid);

grant select (id,portfolio_id,name) on public.market_sources to anon;
create policy market_sources_select_public
on public.market_sources for select to anon using (portfolio_id = 'c9392708-c769-5f74-9587-b3071bc354bd'::uuid);

grant select (id,portfolio_id,asset_id,purchase_order_id,original_price_jpy,allocation_method) on public.purchase_items to anon;
create policy purchase_items_select_public
on public.purchase_items for select to anon using (portfolio_id = 'c9392708-c769-5f74-9587-b3071bc354bd'::uuid);

grant select (id,portfolio_id,vendor,platform,order_reference,original_currency,ordered_at,domestic_shipping_jpy,exchange_rate_jpy_to_cny) on public.purchase_orders to anon;
create policy purchase_orders_select_public
on public.purchase_orders for select to anon using (portfolio_id = 'c9392708-c769-5f74-9587-b3071bc354bd'::uuid);

grant select (portfolio_id,asset_id,note,occurred_at) on public.asset_status_events to anon;
create policy asset_status_events_select_public
on public.asset_status_events for select to anon using (portfolio_id = 'c9392708-c769-5f74-9587-b3071bc354bd'::uuid);

grant select (id,portfolio_id,asset_id,status,platform,listing_price_cny,sold_price_cny,net_proceeds_cny,platform_fees_cny,outbound_shipping_cny,listed_at,sold_at) on public.sales to anon;
create policy sales_select_public
on public.sales for select to anon using (portfolio_id = 'c9392708-c769-5f74-9587-b3071bc354bd'::uuid);

grant select (id,portfolio_id,legacy_id,carrier,tracking_number,status,shipped_at,delivered_at,actual_paid_cny,budget_cny,origin,destination,bare_weight_g,chargeable_weight_g,legacy_status,created_at) on public.shipments to anon;
create policy shipments_select_public
on public.shipments for select to anon using (portfolio_id = 'c9392708-c769-5f74-9587-b3071bc354bd'::uuid);

grant select (id,portfolio_id,shipment_id,asset_id,weight_snapshot_g,allocation_method,allocated_shipping_cny) on public.shipment_items to anon;
create policy shipment_items_select_public
on public.shipment_items for select to anon using (portfolio_id = 'c9392708-c769-5f74-9587-b3071bc354bd'::uuid);

grant select (id,portfolio_id,shipment_id,external_event_id,legacy_id,status,description,location,occurred_at,recorded_at,raw_status) on public.tracking_events to anon;
create policy tracking_events_select_public
on public.tracking_events for select to anon using (portfolio_id = 'c9392708-c769-5f74-9587-b3071bc354bd'::uuid);

grant select (portfolio_id,shipment_id,finished_at,status) on public.tracking_sync_runs to anon;
create policy tracking_sync_runs_select_public
on public.tracking_sync_runs for select to anon using (portfolio_id = 'c9392708-c769-5f74-9587-b3071bc354bd'::uuid);

grant select (portfolio_id,carrier,service,chargeable_weight_g,net_cost_cny,reference_scope) on public.logistics_reference_samples to anon;
create policy logistics_reference_samples_select_public
on public.logistics_reference_samples for select to anon using (portfolio_id = 'c9392708-c769-5f74-9587-b3071bc354bd'::uuid);

grant select (id,portfolio_id,display_name) on public.funding_participants to anon;
create policy funding_participants_select_public
on public.funding_participants for select to anon using (portfolio_id = 'c9392708-c769-5f74-9587-b3071bc354bd'::uuid);

grant select (id,portfolio_id,account_code,display_name,account_kind,participant_id) on public.funding_accounts to anon;
create policy funding_accounts_select_public
on public.funding_accounts for select to anon using (portfolio_id = 'c9392708-c769-5f74-9587-b3071bc354bd'::uuid);

grant select (id,portfolio_id,transaction_kind,transaction_status,amount_cny,occurred_at,occurred_on,sale_id,purchase_item_id,cost_entry_id,shipment_id,reversal_of,note) on public.funding_transactions to anon;
create policy funding_transactions_select_public
on public.funding_transactions for select to anon using (portfolio_id = 'c9392708-c769-5f74-9587-b3071bc354bd'::uuid);

grant select (id,portfolio_id,transaction_id,account_id,amount_cny) on public.funding_allocations to anon;
create policy funding_allocations_select_public
on public.funding_allocations for select to anon using (portfolio_id = 'c9392708-c769-5f74-9587-b3071bc354bd'::uuid);

grant select (id,portfolio_id,asset_id,vendor,description,status,amount_cny,started_at,completed_at) on public.repairs to anon;
create policy repairs_select_public
on public.repairs for select to anon using (portfolio_id = 'c9392708-c769-5f74-9587-b3071bc354bd'::uuid);

grant select (id,portfolio_id,asset_id,market_source_id,status,search_terms,raw_count,deduplicated_count,included_count,p25_cny,median_cny,p75_cny,sample_count,confidence,methodology,price_semantics,created_at,confirmed_at,confirmed_snapshot_id) on public.valuation_research_runs to anon;
create policy valuation_research_runs_select_public
on public.valuation_research_runs for select to anon using (portfolio_id = 'c9392708-c769-5f74-9587-b3071bc354bd'::uuid);

grant select (id,portfolio_id,market_source_id,asset_id,research_run_id,external_listing_id,title,listing_url,asking_price,currency,seller_name,listed_at,captured_at,condition_text,review_status,exclusion_reason,observed_at) on public.market_listings to anon;
create policy market_listings_select_public
on public.market_listings for select to anon using (portfolio_id = 'c9392708-c769-5f74-9587-b3071bc354bd'::uuid);

-- These existing views contain business projections only and retain invoker RLS.
alter view public.asset_financials set (security_invoker = true);
grant select on public.asset_financials to anon;
alter view public.portfolio_metrics set (security_invoker = true);
grant select on public.portfolio_metrics to anon;
alter view public.funding_account_balances set (security_invoker = true);
grant select on public.funding_account_balances to anon;
alter view public.funding_participant_contributions set (security_invoker = true);
grant select on public.funding_participant_contributions to anon;
alter view public.sales_proceeds_pool_balances set (security_invoker = true);
grant select on public.sales_proceeds_pool_balances to anon;

commit;
