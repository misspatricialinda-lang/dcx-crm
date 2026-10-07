begin;
-- Keep the established supplier routing exclusion aligned with the new label.
do $$ declare definition text;
begin
 select pg_get_functiondef('public.crm_supplier_request(uuid,text,numeric)'::regprocedure) into definition;
 execute replace(definition,'''staff''','''employee''');
end $$;
commit;
