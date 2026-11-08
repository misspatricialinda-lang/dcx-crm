-- Rules apply either to inbox replies (customer emails, n8n Workflows 1 and 2) or to supplier price
-- requests (Supplier quotes). Rules learned on Supplier quotes never reach the inbox AI, and the reverse.
begin;
alter table public.ai_owner_rules add column scope text not null default 'customer' check(scope in ('customer','supplier'));
update public.ai_owner_rules set scope='supplier' where rule ilike 'In price requests to suppliers%';
create or replace function public.crm_owner_rules() returns jsonb
language sql stable security definer set search_path='' as $$
 select coalesce(jsonb_agg(x.rule order by x.created_at desc),'[]') from (
 select rule,created_at from public.ai_owner_rules where active and scope='customer' order by created_at desc limit 50) x;
$$;
revoke all on function public.crm_owner_rules() from public, anon, authenticated;
grant execute on function public.crm_owner_rules() to service_role;
commit;
