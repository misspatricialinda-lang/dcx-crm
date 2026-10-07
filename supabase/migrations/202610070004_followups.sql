-- Follow-up reminders (client proposal, "Customer Follow-Up Automation").
-- The clock starts when DCX sends the last message in a conversation and stops when the
-- customer replies. Every stored email re-plans its conversation, so replies sent from the
-- app and from Outlook both count. Reminders are prepared as drafts; nothing is sent.

alter table public.email_threads
  add column if not exists followup_reason text,
  add column if not exists followup_stage smallint not null default 0,
  add column if not exists followup_source text,
  add column if not exists followup_notified_at timestamptz;

create table if not exists public.crm_followup_settings (
  id smallint primary key default 1 check (id = 1),
  enabled boolean not null default true,
  quote_days integer[] not null default '{3,7}',
  question_days integer[] not null default '{3,7}',
  lead_days integer[] not null default '{7,14}',
  updated_at timestamptz not null default now(),
  updated_by text
);
insert into public.crm_followup_settings (id) values (1) on conflict (id) do nothing;
alter table public.crm_followup_settings enable row level security;
revoke all on public.crm_followup_settings from anon, authenticated;
grant all on public.crm_followup_settings to service_role;

-- Follow-up notifications sit beside email notifications: one per email for new mail,
-- one per conversation and due time for reminders.
alter table public.crm_notifications add column if not exists kind text not null default 'email';
alter table public.crm_notifications add column if not exists due_at timestamptz;
alter table public.crm_notifications drop constraint if exists crm_notifications_message_id_key;
create unique index if not exists crm_notifications_email_message on public.crm_notifications (message_id) where kind = 'email';
create unique index if not exists crm_notifications_followup_due on public.crm_notifications (thread_id, due_at) where kind = 'followup';

create or replace function public.crm_notify_incoming_email()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if new.direction = 'incoming' and new.occurred_at >= now() - interval '24 hours' then
    insert into public.crm_notifications(message_id, thread_id, sender, subject, preview, occurred_at)
    values(new.id, new.thread_id, new.sender, new.subject, left(regexp_replace(new.body_text, '[[:space:]]+', ' ', 'g'), 180), new.occurred_at)
    on conflict (message_id) where kind = 'email' do nothing;
  end if;
  return new;
end $$;

-- 09:00 Toronto on the business day p_days after p_from (weekends skipped).
create or replace function public.crm_business_due(p_from timestamptz, p_days integer)
returns timestamptz language plpgsql stable set search_path = '' as $$
declare d date := (p_from at time zone 'America/Toronto')::date; n integer := 0;
begin
  while n < greatest(p_days, 1) loop
    d := d + 1;
    if extract(isodow from d) < 6 then n := n + 1; end if;
  end loop;
  return (d + time '09:00') at time zone 'America/Toronto';
end $$;

-- Our own words in a stored email, without the quoted history below them.
create or replace function public.crm_own_text(p_text text)
returns text language sql immutable set search_path = '' as $$
  select regexp_replace(coalesce(p_text, ''), '(\n[>]|\nFrom:\s|\n-----\s*Original Message|\nOn\s[^\n]{0,200}\swrote:|\n_{10,}|\nSent from my ).*$', '', 'is')
$$;

create or replace function public.crm_plan_followup(p_thread uuid)
returns void language plpgsql security definer set search_path = '' as $$
declare
  s public.crm_followup_settings;
  t public.email_threads;
  last_in public.email_messages;
  last_out public.email_messages;
  first_out timestamptz;
  sent_since integer;
  contact text;
  role text;
  reason text;
  days integer[];
  due timestamptz;
begin
  select * into t from public.email_threads where id = p_thread for update;
  if not found then return; end if;
  -- A reminder Raza set himself stays until he changes it.
  if t.followup_source = 'manual' and t.followup_reason = 'manual' then return; end if;
  select * into s from public.crm_followup_settings where id = 1;
  select * into last_in from public.email_messages where thread_id = t.id and direction = 'incoming' order by occurred_at desc, id desc limit 1;
  select * into last_out from public.email_messages where thread_id = t.id and direction = 'outgoing' order by occurred_at desc, id desc limit 1;

  -- Nothing to chase: disabled, closed, never replied, or the customer spoke last.
  if not coalesce(s.enabled, false) or t.status = 'closed' or last_out.id is null
     or (last_in.id is not null and last_in.occurred_at > last_out.occurred_at) then
    update public.email_threads set followup_at = null, followup_reason = null, followup_stage = 0, followup_source = null
      where id = t.id and (followup_at is not null or followup_reason is not null);
    return;
  end if;

  contact := lower(coalesce(last_out.to_addresses->>0, last_in.sender, ''));
  role := public.crm_correspondent_role(contact);
  -- Staff, suppliers and our own addresses (this mailbox, or any address it has sent from) are never chased.
  if role in ('employee', 'supplier') or contact = ''
     or exists (select 1 from public.email_mailboxes b where b.id = t.mailbox_id and lower(b.address) = contact)
     or exists (select 1 from public.email_messages o where o.mailbox_id = t.mailbox_id and o.direction = 'outgoing' and lower(o.sender) = contact) then
    update public.email_threads set followup_at = null, followup_reason = null, followup_stage = 0, followup_source = null where id = t.id and followup_at is not null;
    return;
  end if;

  -- One send can be stored twice (the app's record and the Outlook sync copy), so sends
  -- within ten minutes of an earlier one count once.
  select count(*) filter (where not exists (select 1 from public.email_messages o where o.thread_id = m.thread_id and o.direction = 'outgoing'
           and o.occurred_at > m.occurred_at - interval '10 minutes' and (o.occurred_at, o.id) < (m.occurred_at, m.id))),
         min(m.occurred_at)
    into sent_since, first_out from public.email_messages m
    where m.thread_id = t.id and m.direction = 'outgoing' and m.occurred_at > coalesce(last_in.occurred_at, '-infinity'::timestamptz);

  -- What did we last send? A quotation, a question, or information to a prospect.
  if t.topic = 'quotation' or exists (
       select 1 from public.email_attachments a join public.email_messages m on m.id = a.message_id
       where m.thread_id = t.id and m.direction = 'outgoing' and m.occurred_at >= first_out and a.name ~* '(estimate|quot|proposal)') then
    reason := 'quote'; days := s.quote_days;
  elsif public.crm_own_text(last_out.body_text) like '%?%' then
    reason := 'awaiting_answer'; days := s.question_days;
  elsif role = 'lead' or t.topic in ('incomplete_inquiry', 'upgrade') then
    reason := 'quiet_lead'; days := s.lead_days;
  else
    reason := null;
  end if;

  if reason is null then
    update public.email_threads set followup_at = null, followup_reason = null, followup_stage = 0, followup_source = null where id = t.id and followup_at is not null;
    return;
  end if;
  if sent_since > coalesce(array_length(days, 1), 0) then
    -- Both reminders were sent without an answer: stop chasing.
    update public.email_threads set followup_at = null, followup_reason = 'gone_quiet', followup_stage = sent_since, followup_source = 'auto' where id = t.id;
    return;
  end if;
  due := greatest(public.crm_business_due(first_out, days[sent_since]), public.crm_business_due(last_out.occurred_at, 1));
  if t.followup_at is distinct from due or t.followup_reason is distinct from reason then
    update public.email_threads set followup_at = due, followup_reason = reason, followup_stage = sent_since, followup_source = 'auto' where id = t.id;
    insert into public.email_activity (thread_id, action, actor, details)
      values (t.id, 'followup_scheduled', 'system', jsonb_build_object('reason', reason, 'stage', sent_since, 'due', due));
  end if;
end $$;

create or replace function public.crm_followup_on_message()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  perform public.crm_plan_followup(new.thread_id);
  return new;
end $$;
drop trigger if exists crm_followup_on_message on public.email_messages;
create trigger crm_followup_on_message after insert on public.email_messages
for each row execute function public.crm_followup_on_message();

-- Snooze, mark done, or set a personal reminder on a conversation.
create or replace function public.crm_set_followup(p_thread uuid, p_action text, p_until timestamptz, p_actor text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare t public.email_threads;
begin
  select * into t from public.email_threads where id = p_thread for update;
  if not found then raise exception 'Conversation not found'; end if;
  if p_action in ('snooze', 'remind') then
    if p_until is null or p_until < now() - interval '1 minute' or p_until > now() + interval '1 year' then raise exception 'Choose a reminder date in the next year'; end if;
    update public.email_threads set followup_at = p_until, followup_notified_at = null,
      followup_reason = case when p_action = 'remind' or t.followup_reason is null then 'manual' else t.followup_reason end,
      followup_source = case when p_action = 'remind' or t.followup_reason is null then 'manual' else t.followup_source end
      where id = t.id returning * into t;
  elsif p_action = 'done' then
    update public.email_threads set followup_at = null, followup_reason = 'done', followup_source = 'auto' where id = t.id returning * into t;
  else
    raise exception 'Unknown follow-up action';
  end if;
  insert into public.email_activity (thread_id, action, actor, details)
    values (t.id, 'followup_' || p_action, p_actor, jsonb_build_object('until', p_until));
  return jsonb_build_object('followup_at', t.followup_at, 'followup_reason', t.followup_reason, 'followup_stage', t.followup_stage, 'followup_source', t.followup_source);
end $$;

-- Conversations with a reminder, newest due first, for the inbox and the daily run.
create or replace function public.crm_followups(p_days integer default 30)
returns jsonb language sql stable security definer set search_path = '' as $$
  select coalesce(jsonb_agg(row_to_json(x) order by x.followup_at), '[]'::jsonb) from (
    select t.id thread_id, t.provider_thread_key, t.subject, t.followup_at, t.followup_reason reason, t.followup_stage stage,
      t.followup_source source, t.followup_notified_at notified_at, t.followup_at <= now() due,
      coalesce((select m.to_addresses->>0 from public.email_messages m where m.thread_id = t.id and m.direction = 'outgoing' order by m.occurred_at desc limit 1),
               (select m.sender from public.email_messages m where m.thread_id = t.id and m.direction = 'incoming' order by m.occurred_at desc limit 1)) contact,
      (select max(m.occurred_at) from public.email_messages m where m.thread_id = t.id and m.direction = 'outgoing') last_sent_at
    from public.email_threads t
    where t.followup_at is not null and t.status <> 'closed' and t.followup_at <= now() + make_interval(days => p_days)
  ) x
$$;

revoke all on function public.crm_business_due(timestamptz, integer), public.crm_own_text(text), public.crm_plan_followup(uuid),
  public.crm_set_followup(uuid, text, timestamptz, text), public.crm_followups(integer) from public, anon, authenticated;
grant execute on function public.crm_business_due(timestamptz, integer), public.crm_own_text(text), public.crm_plan_followup(uuid),
  public.crm_set_followup(uuid, text, timestamptz, text), public.crm_followups(integer) to service_role;
-- Plan recent conversations once; older ones start fresh on their next email.
select public.crm_plan_followup(id) from public.email_threads where last_message_at > now() - interval '21 days';
notify pgrst, 'reload schema';
