begin;

create table if not exists public.crm_notifications (
  id uuid primary key default gen_random_uuid(),
  message_id uuid not null unique references public.email_messages(id) on delete cascade,
  thread_id uuid not null references public.email_threads(id) on delete cascade,
  sender text not null,
  subject text not null,
  preview text not null default '',
  occurred_at timestamptz not null,
  created_at timestamptz not null default now(),
  read_at timestamptz,
  push_claimed_at timestamptz,
  push_sent_at timestamptz,
  push_attempts integer not null default 0,
  push_last_error text
);
create index if not exists crm_notifications_recent on public.crm_notifications(created_at desc);
create index if not exists crm_notifications_unread on public.crm_notifications(created_at desc) where read_at is null;

create table if not exists public.crm_push_subscriptions (
  id uuid primary key default gen_random_uuid(),
  endpoint text not null unique,
  subscription jsonb not null,
  user_agent text not null default '',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create or replace function public.crm_notify_incoming_email()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if new.direction = 'incoming' and new.occurred_at >= now() - interval '24 hours' then
    insert into public.crm_notifications(message_id, thread_id, sender, subject, preview, occurred_at)
    values(new.id, new.thread_id, new.sender, new.subject, left(regexp_replace(new.body_text, '[[:space:]]+', ' ', 'g'), 180), new.occurred_at)
    on conflict (message_id) do nothing;
  end if;
  return new;
end $$;

drop trigger if exists crm_incoming_email_notification on public.email_messages;
create trigger crm_incoming_email_notification after insert on public.email_messages
for each row execute function public.crm_notify_incoming_email();

create or replace function public.crm_claim_push_notifications(p_limit integer default 20)
returns setof public.crm_notifications language plpgsql security definer set search_path = '' as $$
begin
  return query
  with claim as (
    select id from public.crm_notifications
    where push_sent_at is null
      and created_at >= now() - interval '24 hours'
      and (push_claimed_at is null or push_claimed_at < now() - interval '5 minutes')
    order by created_at
    limit least(greatest(coalesce(p_limit, 20), 1), 50)
    for update skip locked
  )
  update public.crm_notifications n
  set push_claimed_at = now(), push_attempts = push_attempts + 1
  from claim where n.id = claim.id
  returning n.*;
end $$;

alter table public.crm_notifications enable row level security;
alter table public.crm_push_subscriptions enable row level security;
revoke all on public.crm_notifications, public.crm_push_subscriptions from anon, authenticated;
grant select, insert, update, delete on public.crm_notifications, public.crm_push_subscriptions to service_role;
revoke all on function public.crm_notify_incoming_email() from public, anon, authenticated;
revoke all on function public.crm_claim_push_notifications(integer) from public, anon, authenticated;
grant execute on function public.crm_claim_push_notifications(integer) to service_role;

commit;
