begin;
create or replace function public.email_report_range(p_mailbox uuid, p_from date, p_to date, p_timezone text default 'UTC')
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare result jsonb; start_at timestamptz; end_at timestamptz; p_days integer;
begin
 if p_from is null or p_to is null or p_to<p_from or p_to-p_from>365 then raise exception 'Choose a valid date range of up to 366 days'; end if;
 p_days:=p_to-p_from+1;
 if not exists(select 1 from pg_timezone_names where name=p_timezone) then raise exception 'Invalid reporting timezone'; end if;
 start_at := p_from::timestamp at time zone p_timezone;
 end_at := (p_to+1)::timestamp at time zone p_timezone;
 with period as (
  select * from public.email_messages where mailbox_id=p_mailbox and occurred_at>=start_at and occurred_at<end_at
 ), cohort as (
  select thread_id,min(occurred_at) first_incoming from period where direction='incoming' group by thread_id
 ), answered as (
  select c.*, (select min(m.occurred_at) from public.email_messages m where m.mailbox_id=p_mailbox and m.thread_id=c.thread_id and m.direction='outgoing' and m.occurred_at>c.first_incoming and m.occurred_at<end_at) first_reply from cohort c
 ), days as (
  select (p_to - n) as day from generate_series(0,p_days-1) n
 ), daily as (
  select d.day,
   count(m.id) filter(where m.direction='incoming') received,
   count(m.id) filter(where m.direction='outgoing') sent,
   count(distinct m.thread_id) filter(where m.direction='outgoing' and exists(select 1 from public.email_messages i where i.thread_id=m.thread_id and i.mailbox_id=p_mailbox and i.direction='incoming' and i.occurred_at<m.occurred_at)) replied
  from days d left join period m on (m.occurred_at at time zone p_timezone)::date=d.day group by d.day
 ) select jsonb_build_object(
  'days',p_days,'timezone',p_timezone,'from',start_at,'through',end_at,
  'received',(select count(*) from period where direction='incoming'),
  'sent',(select count(*) from period where direction='outgoing'),
  'conversations_received',(select count(*) from cohort),
  'conversations_replied',(select count(*) from answered where first_reply is not null),
  'reply_rate',(select round(100.0*count(first_reply)/nullif(count(*),0),1) from answered),
  'average_response_minutes',(select round(avg(extract(epoch from (first_reply-first_incoming))/60),1) from answered),
  'daily',(select coalesce(jsonb_agg(to_jsonb(daily) order by day desc),'[]'::jsonb) from daily),
  'folders',(select coalesce(jsonb_agg(jsonb_build_object('folder',folder,'updated_at',updated_at,'last_error',last_error,'backfill_complete',position('deltatoken' in lower(coalesce(cursor_url,'')))>0)),'[]'::jsonb) from public.email_sync_cursors where mailbox_id=p_mailbox)
 ) into result;
 return result;
end $$;
revoke all on function public.email_report_range(uuid,date,date,text) from public,anon,authenticated;
grant execute on function public.email_report_range(uuid,date,date,text) to service_role;

create function public.crm_prepare_ai_draft(p_thread uuid,p_actor text default 'owner') returns jsonb
language plpgsql security definer set search_path='' as $$
declare t public.email_threads; m public.email_messages; d public.email_drafts;
begin
 select * into t from public.email_threads where id=p_thread for update;
 if not found then raise exception 'Conversation not found'; end if;
 if exists(select 1 from public.email_automation_jobs where thread_id=t.id and status='running') then raise exception 'AI is updating this conversation. Wait and retry'; end if;
 select * into d from public.email_drafts where thread_id=t.id and deleted_at is null and status<>'sent' order by updated_at desc limit 1 for update;
 if found then
  if d.status in ('sending','submitted','uncertain') then raise exception 'Dispatch pending. Reconcile the existing reply first'; end if;
  return to_jsonb(d);
 end if;
 select * into d from public.email_drafts where thread_id=t.id and deleted_at is not null and status in ('editing','approved') order by deleted_at desc limit 1 for update;
 if found then
  perform public.crm_draft_trash(d.id,d.updated_at,true,p_actor);
  select * into d from public.email_drafts where id=d.id;
  return to_jsonb(d);
 end if;
 select * into m from public.email_messages where thread_id=t.id and direction='incoming' order by occurred_at desc,id desc limit 1;
 if not found or position('@' in m.sender)<2 then raise exception 'Choose a conversation with a received email'; end if;
 insert into public.email_drafts(thread_id,reply_to_message_id,current_body,to_addresses,subject,source_message_version)
 values(t.id,m.id,'',jsonb_build_array(m.sender),'RE: '||regexp_replace(m.subject,'^re:\s*','','i'),t.message_version) returning * into d;
 insert into public.email_activity(thread_id,action,actor,details) values(t.id,'draft_prepared',p_actor,jsonb_build_object('draft_id',d.id));
 return to_jsonb(d);
end $$;
revoke all on function public.crm_prepare_ai_draft(uuid,text) from public,anon,authenticated;
grant execute on function public.crm_prepare_ai_draft(uuid,text) to service_role;

commit;
