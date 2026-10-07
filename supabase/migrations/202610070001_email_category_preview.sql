-- Adds a short plain-text preview of the latest incoming message to each Email activity record.
-- Quoted earlier replies are cut so the preview shows what the sender actually wrote.
begin;

create or replace function public.crm_email_preview(p_text text, p_html text) returns text
language sql immutable set search_path='' as $$
 select left(trim(regexp_replace(regexp_replace(regexp_replace(
   case when coalesce(p_text,'')<>'' then p_text
        else regexp_replace(regexp_replace(coalesce(p_html,''),'<(style|script|head)[^>]*>.*?</\1>','','gi'),'<[^>]*>',' ','g') end,
   '&nbsp;|&#160;',' ','gi'),
   '(\mOn\s[^\n]{0,200}\swrote:|\mFrom:\s|-----\s*Original Message|_{10,}).*$','','i'),
   '\s+',' ','g')),220)
$$;

create or replace function public.crm_email_categories() returns jsonb
language sql stable security definer set search_path='' as $$
 with latest as (select distinct on (m.thread_id) m.thread_id,lower(trim(m.sender)) email,m.occurred_at,t.last_message_at last_activity_at,t.subject,t.topic,t.status,t.classification_state,
 public.crm_email_preview(m.body_text,m.body_html) preview
 from public.email_messages m join public.email_threads t on t.id=m.thread_id where m.direction='incoming'
 order by m.thread_id,m.occurred_at desc,m.id desc), classified as (
 select *,public.crm_correspondent_role(email) role from latest), people as (
 select c.*,coalesce(r.company,'') company from classified c left join public.email_correspondent_roles r on r.email=c.email
 order by last_activity_at desc limit 200)
 select jsonb_build_object('roles',coalesce((select jsonb_object_agg(role,n) from (select role,count(*) n from classified where role is not null group by role)x),'{}'),
 'topics',coalesce((select jsonb_object_agg(topic,n) from (select topic,count(*) n from classified where topic is not null group by topic)x),'{}'),
 'records',coalesce((select jsonb_agg(to_jsonb(people)) from people),'[]'),'needs_review',(select count(*) from classified where role is null or topic is null),'total',(select count(*) from classified));
$$;

revoke all on function public.crm_email_preview(text,text) from public,anon,authenticated;
revoke all on function public.crm_email_categories() from public,anon,authenticated;
grant execute on function public.crm_email_categories() to service_role;
notify pgrst,'reload schema';
commit;
