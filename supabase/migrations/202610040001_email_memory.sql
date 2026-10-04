-- Historical evidence is separate from active queues: importing cannot draft/send mail.
begin;
create table public.crm_email_archive (
 source_key text primary key, archive_id text not null, source_id text not null,
 source_id_type text not null default 'outlook_entry_id',
 folder text not null, internet_message_id text, in_reply_to text,
 conversation_id text, thread_key text not null,
 sender_name text not null default '', sender_email text not null default '',
 recipients jsonb not null default '[]', participant_emails text[] not null default '{}',
 subject text not null default '', sent_at timestamptz, received_at timestamptz,
 body_text text not null default '', body_html text not null default '', is_draft boolean not null default false,
 attachments jsonb not null default '[]',
 imported_at timestamptz not null default now(),
 search_text tsvector generated always as
   (to_tsvector('english', coalesce(subject,'') || ' ' || coalesce(body_text,''))) stored,
 unique(archive_id,source_id)
);
create index crm_email_archive_participants on public.crm_email_archive using gin(participant_emails);
create index crm_email_archive_search on public.crm_email_archive using gin(search_text);
create index crm_email_archive_thread on public.crm_email_archive(archive_id,thread_key,sent_at);
create index crm_email_archive_date on public.crm_email_archive(sent_at desc);
alter table public.crm_email_archive enable row level security;
revoke all on public.crm_email_archive from public,anon,authenticated;
grant select,insert,update,delete on public.crm_email_archive to service_role;

-- Same-address evidence only. Names alone never merge two people's histories.
-- Both relevant older requests and recent context are returned with source IDs.
create function public.crm_email_memory(p_addresses text[], p_query text default '', p_limit integer default 12)
returns jsonb language sql stable security definer set search_path = '' as $$
 with addresses as (
   select distinct lower(trim(a)) as email from unnest(p_addresses) a
   where position('@' in a)>1
 ), archive as (
   select distinct on (coalesce(nullif(a.internet_message_id,''),a.source_key),md5(a.body_text))
     'pst'::text as source, a.source_key as id, a.thread_key,
     a.sender_email, a.sender_name, a.subject, coalesce(a.sent_at,a.received_at) as occurred_at,
     a.body_text, a.attachments,
     case when trim(p_query)='' then 0 else
       ts_rank_cd(a.search_text,websearch_to_tsquery('english',p_query)) end as relevance
   from public.crm_email_archive a
   where not a.is_draft and a.participant_emails && array(select email from addresses)
   order by coalesce(nullif(a.internet_message_id,''),a.source_key),md5(a.body_text),a.source_key
 ), live as (
   select 'tracked'::text as source, m.id::text as id, m.thread_id::text as thread_key,
     m.sender as sender_email, ''::text as sender_name, m.subject, m.occurred_at,
     m.body_text, coalesce((select jsonb_agg(jsonb_build_object('name',f.name,'storage_path',f.storage_path))
       from public.email_attachments f where f.message_id=m.id),'[]'::jsonb) as attachments,
     case when trim(p_query)='' then 0 else ts_rank_cd(
       to_tsvector('english',m.subject || ' ' || m.body_text),websearch_to_tsquery('english',p_query)) end as relevance
   from public.email_messages m
   where m.body_loaded and (
     lower(m.sender) in (select email from addresses) or
     exists(select 1 from jsonb_array_elements_text(m.to_addresses || m.cc_addresses) r
       where lower(r) in (select email from addresses)))
 ), evidence as (select * from archive union all select * from live),
 ranked as (
   select *, row_number() over(order by relevance desc,occurred_at desc nulls last,id) as topic_rank,
     row_number() over(order by occurred_at desc nulls last,id) as recent_rank from evidence
 ), picked as (
   select * from ranked where topic_rank<=greatest(1,least(p_limit,30)/2)
     or recent_rank<=greatest(1,least(p_limit,30)/2)
   order by relevance desc,occurred_at desc nulls last limit greatest(1,least(p_limit,30))
 )
 select jsonb_build_object(
   'matching_messages',(select count(*) from evidence),
   'earliest_at',(select min(occurred_at) from evidence),
   'latest_at',(select max(occurred_at) from evidence),
   'contacts',coalesce((select jsonb_agg(jsonb_build_object('id',c.id,'name',c.name,'email',c.email,'customer_id',c.customer_id))
     from public.crm_contacts c where c.email in (select email from addresses)),'[]'::jsonb),
   'messages',coalesce((select jsonb_agg(jsonb_build_object('source',source,'id',id,'thread_key',thread_key,
     'sender_email',sender_email,'sender_name',sender_name,'subject',subject,'occurred_at',occurred_at,
     'body_text',left(body_text,6000),'body_truncated',length(body_text)>6000,'attachments',attachments)) from picked),'[]'::jsonb)
 );
$$;
revoke all on function public.crm_email_memory(text[],text,integer) from public,anon,authenticated;
grant execute on function public.crm_email_memory(text[],text,integer) to service_role;
commit;
