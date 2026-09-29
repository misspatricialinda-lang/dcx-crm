begin;

create table if not exists public.crm_push_deliveries (
  notification_id uuid not null references public.crm_notifications(id) on delete cascade,
  subscription_id uuid not null references public.crm_push_subscriptions(id) on delete cascade,
  delivered_at timestamptz not null default now(),
  primary key (notification_id, subscription_id)
);

alter table public.crm_push_deliveries enable row level security;
revoke all on public.crm_push_deliveries from anon, authenticated;
grant select, insert, delete on public.crm_push_deliveries to service_role;

create or replace function public.crm_claim_push_notifications(p_limit integer default 20)
returns setof public.crm_notifications language plpgsql security definer set search_path = '' as $$
begin
  return query
  with claim as (
    select n.id from public.crm_notifications n
    where n.created_at >= now() - interval '24 hours'
      and (n.push_claimed_at is null or n.push_claimed_at < now() - interval '5 minutes')
      and exists (
        select 1 from public.crm_push_subscriptions s
        where s.created_at <= n.created_at
        and not exists (
          select 1 from public.crm_push_deliveries d
          where d.notification_id = n.id and d.subscription_id = s.id
        )
      )
    order by n.created_at
    limit least(greatest(coalesce(p_limit, 20), 1), 50)
    for update of n skip locked
  )
  update public.crm_notifications n
  set push_claimed_at = now(), push_attempts = push_attempts + 1
  from claim where n.id = claim.id
  returning n.*;
end $$;

commit;
