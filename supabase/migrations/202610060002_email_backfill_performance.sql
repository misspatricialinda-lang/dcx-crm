begin;
-- Queue archive chunks in one operation instead of scanning the source view per email.
create or replace function public.crm_queue_email_backfill(p_limit integer default 200) returns integer
language sql security definer set search_path='' as $$
with candidates as materialized (
select source,source_id from (
 select 'pst'::text source,a.source_key source_id,coalesce(a.sent_at,a.received_at) occurred_at
 from public.crm_email_archive a where not a.is_draft and trim(a.subject||a.body_text||a.body_html)<>''
 and not exists(select 1 from public.crm_email_embedding_queue q where q.source='pst' and q.source_id=a.source_key and q.source_version=md5(a.subject||'|'||a.body_text||'|'||a.body_html))
 union all
 select 'tracked',m.id::text,m.occurred_at from public.email_messages m where m.body_loaded and trim(m.subject||m.body_text||m.body_html)<>''
 and not exists(select 1 from public.crm_email_embedding_queue q where q.source='tracked' and q.source_id=m.id::text and q.source_version=md5(m.subject||'|'||m.body_text||'|'||m.body_html))
) x order by occurred_at desc nulls last,source_id limit greatest(1,least(p_limit,500))
), sources as materialized (
 select s.source,s.source_id,s.source_version,trim(s.subject||E'\n'||s.body_text) content
 from candidates c join public.crm_email_memory_sources s on s.source=c.source and s.source_id=c.source_id
), inserted as (
 insert into public.crm_email_embedding_queue(source,source_id,source_version,chunk_index,content)
 select s.source,s.source_id,s.source_version,(p.pos-1)/3500,substring(s.content from p.pos for 4000)
 from sources s cross join lateral generate_series(1,length(s.content),3500) p(pos)
 on conflict(source,source_id,chunk_index) do update set source_version=excluded.source_version,content=excluded.content,status='pending',attempts=0,lease_token=null,lease_until=null,error=null,updated_at=now()
 where crm_email_embedding_queue.source_version<>excluded.source_version returning source,source_id
)
select count(distinct (source,source_id))::integer from inserted;
$$;
commit;
