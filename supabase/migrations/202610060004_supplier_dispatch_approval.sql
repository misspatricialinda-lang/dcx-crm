-- Automatic supplier routes may prepare requests; dispatch still requires recorded approval.
do $$ declare definition text; begin
 select pg_get_functiondef('public.crm_claim_supplier_request()'::regprocedure) into definition;
 definition:=replace(definition,'(s.auto_request or q.approved_at is not null)','q.approved_at is not null');
 execute definition;
end $$;
