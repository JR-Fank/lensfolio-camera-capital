-- The initial remote function body assigned text directly to an enum variable.
-- Patch that exact body without changing the function signature or permissions.

do $migration$
declare
  v_function regprocedure := 'public.import_logistics_evidence(uuid,text,text,jsonb,jsonb)'::regprocedure;
  v_definition text;
  v_patched text;
  v_original text := 'v_entry_status := case when v_payment_status = ''paid'' then ''posted'' else ''pending'' end;';
  v_replacement text := 'v_entry_status := (case when v_payment_status = ''paid'' then ''posted'' else ''pending'' end)::public.cost_entry_status;';
begin
  select pg_get_functiondef(v_function) into v_definition;
  v_patched := replace(v_definition, v_original, v_replacement);

  if v_patched = v_definition then
    if position('::public.cost_entry_status' in v_definition) = 0 then
      raise exception 'Could not locate evidence cost status assignment to patch.';
    end if;
    return;
  end if;

  execute v_patched;
end;
$migration$;
