-- Reject a repeated order identity when its financial facts do not match.
-- Migration 011 already contains this guard for fresh databases; this patch
-- upgrades the function that was applied before the guard was added.

do $migration$
declare
  v_function regprocedure := 'public.import_purchase_evidence(uuid,text,text,jsonb,jsonb)'::regprocedure;
  v_definition text;
  v_patched text;
  v_marker text := E'if v_order_id is not null then\n    select';
  v_guard text := E'if v_order_id is not null then\n'
    || E'    if exists (\n'
    || E'      select 1\n'
    || E'      from public.purchase_orders po\n'
    || E'      where po.id = v_order_id\n'
    || E'        and (\n'
    || E'          po.actual_paid_cny is distinct from (p_payload->>''actual_paid_cny'')::numeric\n'
    || E'          or (select count(*) from public.purchase_items pi where pi.purchase_order_id = v_order_id) <> jsonb_array_length(p_payload->''assets'')\n'
    || E'          or abs(\n'
    || E'            (select coalesce(sum(pi.allocated_cost_cny), 0) from public.purchase_items pi where pi.purchase_order_id = v_order_id)\n'
    || E'            - (select coalesce(sum((asset->>''allocated_cost_cny'')::numeric), 0) from jsonb_array_elements(p_payload->''assets'') asset)\n'
    || E'          ) > 0.01\n'
    || E'        )\n'
    || E'    ) then\n'
    || E'      raise exception using errcode = ''22023'', message = ''Conflicting purchase evidence exists for this order reference.'';\n'
    || E'    end if;\n\n'
    || E'    select';
begin
  select pg_get_functiondef(v_function) into v_definition;
  v_patched := replace(v_definition, v_marker, v_guard);

  if v_patched = v_definition then
    if position('Conflicting purchase evidence exists for this order reference.' in v_definition) = 0 then
      raise exception 'Could not locate purchase evidence replay branch to patch.';
    end if;
    return;
  end if;

  execute v_patched;
end;
$migration$;
