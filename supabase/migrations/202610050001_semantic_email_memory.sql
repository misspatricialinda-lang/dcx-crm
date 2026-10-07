-- Private, source-versioned semantic evidence. Existing email/approval records are untouched.
begin;
create extension if not exists vector with schema extensions;

create view public.crm_email_memory_sources as
select 'pst'::text source,a.source_key source_id,a.thread_key,null::uuid mailbox_id,
 lower(a.sender_email) sender_email,a.sender_name,a.subject,coalesce(a.sent_at,a.received_at) occurred_at,
 a.participant_emails,
 coalesce(nullif(a.body_text,''),regexp_replace(a.body_html,'<[^>]*>',' ','g')) body_text,
 a.attachments,md5(a.subject||'|'||a.body_text||'|'||a.body_html) source_version
from public.crm_email_archive a where not a.is_draft
union all
select 'tracked',m.id::text,m.thread_id::text,m.mailbox_id,lower(m.sender),''::text,m.subject,m.occurred_at,
 array(select distinct lower(x) from unnest(array[m.sender]||array(select jsonb_array_elements_text(m.to_addresses||m.cc_addresses))) x),
 case when m.body_html<>'' then regexp_replace(m.body_html,'<[^>]*>',' ','g') else m.body_text end,
 coalesce((select jsonb_agg(jsonb_build_object('name',f.name,'storage_path',f.storage_path)) from public.email_attachments f where f.message_id=m.id),'[]'::jsonb),
 md5(m.subject||'|'||m.body_text||'|'||m.body_html)
from public.email_messages m where m.body_loaded;
revoke all on public.crm_email_memory_sources from public,anon,authenticated;
grant select on public.crm_email_memory_sources to service_role;

create table public.crm_email_embedding_queue (
 id uuid primary key default gen_random_uuid(),source text not null check(source in ('pst','tracked')),
 source_id text not null,source_version text not null,chunk_index integer not null,
 content text not null,status text not null default 'pending' check(status in ('pending','processing','ready','failed')),
 attempts integer not null default 0,lease_token uuid,lease_until timestamptz,error text,
 updated_at timestamptz not null default now(),unique(source,source_id,chunk_index)
);
create index crm_email_embedding_pending on public.crm_email_embedding_queue(status,updated_at);
create table public.crm_email_vectors (
 id uuid primary key default gen_random_uuid(),content text not null,metadata jsonb not null default '{}',
 embedding extensions.vector(1536),created_at timestamptz not null default now()
);
create index crm_email_vectors_queue on public.crm_email_vectors((metadata->>'queue_id'));
-- Exact search is deliberate: identity is filtered before ranking. No approximate
-- global search can discard a small customer's relevant records before filtering.
alter table public.crm_email_embedding_queue enable row level security;
alter table public.crm_email_vectors enable row level security;
revoke all on public.crm_email_embedding_queue,public.crm_email_vectors from public,anon,authenticated;
grant select,insert,update,delete on public.crm_email_embedding_queue,public.crm_email_vectors to service_role;

create function public.crm_queue_email_embedding(p_source text,p_source_id text) returns integer
language plpgsql security definer set search_path='' as $$
declare s record; pos integer; n integer:=0; text_value text;
begin
 select * into s from public.crm_email_memory_sources where source=p_source and source_id=p_source_id;
 if not found then delete from public.crm_email_embedding_queue where source=p_source and source_id=p_source_id;return 0;end if;
 text_value:=trim(s.subject||E'\n'||s.body_text);
 if text_value='' then return 0;end if;
 for pos in select generate_series(1,length(text_value),3500) loop
  insert into public.crm_email_embedding_queue(source,source_id,source_version,chunk_index,content)
  values(p_source,p_source_id,s.source_version,n,substring(text_value from pos for 4000))
  on conflict(source,source_id,chunk_index) do update set source_version=excluded.source_version,
   content=excluded.content,status='pending',attempts=0,lease_token=null,lease_until=null,error=null,updated_at=now()
   where crm_email_embedding_queue.source_version<>excluded.source_version;
  n:=n+1;
 end loop;
 delete from public.crm_email_embedding_queue where source=p_source and source_id=p_source_id and chunk_index>=n;
 return n;
end $$;
create function public.crm_queue_email_backfill(p_limit integer default 200) returns integer
language plpgsql security definer set search_path='' as $$
declare s record; n integer:=0;
begin
 for s in select x.source,x.source_id from public.crm_email_memory_sources x
 where not exists(select 1 from public.crm_email_embedding_queue q where q.source=x.source and q.source_id=x.source_id and q.source_version=x.source_version)
 order by x.occurred_at desc nulls last,x.source_id limit greatest(1,least(p_limit,500)) loop
  perform public.crm_queue_email_embedding(s.source,s.source_id);n:=n+1;
 end loop;return n;
end $$;
create function public.crm_email_embedding_changed() returns trigger language plpgsql security definer set search_path='' as $$
begin
 if tg_table_name='crm_email_archive' then perform public.crm_queue_email_embedding('pst',coalesce(new.source_key,old.source_key));
 else perform public.crm_queue_email_embedding('tracked',coalesce(new.id,old.id)::text);end if;
 return coalesce(new,old);
end $$;
create trigger crm_index_archive after insert or update of subject,body_text,body_html,is_draft,participant_emails or delete on public.crm_email_archive for each row execute function public.crm_email_embedding_changed();
create trigger crm_index_live after insert or update of subject,body_text,body_html,body_loaded,sender,to_addresses,cc_addresses or delete on public.email_messages for each row execute function public.crm_email_embedding_changed();

create function public.crm_claim_email_embeddings(p_limit integer default 32) returns setof public.crm_email_embedding_queue
language plpgsql security definer set search_path='' as $$
begin
 update public.crm_email_embedding_queue set status=case when attempts>=8 then 'failed' else 'pending' end,lease_token=null,lease_until=null
 where status='processing' and lease_until<now();
 return query with picked as (
 select q.id from public.crm_email_embedding_queue q where q.status='pending' and q.attempts<8
 order by q.updated_at,q.id for update skip locked limit greatest(1,least(p_limit,64)))
 update public.crm_email_embedding_queue q set status='processing',attempts=q.attempts+1,lease_token=gen_random_uuid(),lease_until=now()+interval '10 minutes',updated_at=now()
 from picked where q.id=picked.id returning q.*;
end $$;
create function public.crm_finish_email_embeddings(p_claims jsonb,p_error text default null) returns integer
language plpgsql security definer set search_path='' as $$
declare n integer;
begin
 update public.crm_email_embedding_queue q set
 status=case when p_error is null then 'ready' when attempts>=8 then 'failed' else 'pending' end,
 error=left(p_error,300),lease_token=null,lease_until=null,updated_at=now()
 from jsonb_to_recordset(p_claims) x(id uuid,lease_token uuid,source_version text)
 where q.id=x.id and q.lease_token=x.lease_token and q.source_version=x.source_version and q.status='processing'
 and (p_error is not null or exists(select 1 from public.crm_email_vectors v where v.metadata->>'queue_id'=q.id::text and v.metadata->>'source_version'=q.source_version and v.embedding is not null));
 get diagnostics n=row_count;return n;
end $$;

create function public.crm_email_index_status() returns jsonb language sql stable security definer set search_path='' as $$
 select jsonb_build_object('sources',(select count(*) from public.crm_email_memory_sources),
 'queued_sources',(select count(distinct(source,source_id)) from public.crm_email_embedding_queue),
 'ready_sources',(select count(*) from (select source,source_id from public.crm_email_embedding_queue group by source,source_id having bool_and(status='ready')) x),
 'pending_chunks',(select count(*) from public.crm_email_embedding_queue where status='pending'),
 'processing_chunks',(select count(*) from public.crm_email_embedding_queue where status='processing'),
 'failed_chunks',(select count(*) from public.crm_email_embedding_queue where status='failed'),
 'ready_chunks',(select count(*) from public.crm_email_embedding_queue where status='ready'));
$$;

-- Native n8n Supabase Vector Store contract. Both sender and mailbox are mandatory.
create function public.match_email_memory_chunks(query_embedding extensions.vector(1536),match_count integer default 12,filter jsonb default '{}')
returns table(id uuid,content text,metadata jsonb,similarity double precision)
language sql stable security definer set search_path='' as $$
 with scoped as materialized (
 select v.id,v.content,v.embedding,q.chunk_index,s.*
 from public.crm_email_vectors v join public.crm_email_embedding_queue q on q.id::text=v.metadata->>'queue_id'
 join public.crm_email_memory_sources s on s.source=q.source and s.source_id=q.source_id
 where v.embedding is not null and q.source_version=s.source_version and v.metadata->>'source_version'=s.source_version
 and length(coalesce(filter->>'address',''))>3 and position('@' in filter->>'address')>1
 and s.participant_emails @> array[lower(trim(filter->>'address'))]
 and (s.mailbox_id is null or s.mailbox_id::text=filter->>'mailbox_id')
 and nullif(filter->>'mailbox_id','') is not null
 ), distinct_chunks as (
 select distinct on(source,source_id,chunk_index) * from scoped order by source,source_id,chunk_index,id
 ), scores as (
 select *,1-(embedding operator(extensions.<=>) query_embedding) as semantic_similarity,
 ts_rank_cd(to_tsvector('english',content),websearch_to_tsquery('english',coalesce(filter->>'query',''))) as keyword_score
 from distinct_chunks
 ), ranks as (
 select *,row_number() over(order by semantic_similarity desc,id) semantic_rank,
 row_number() over(order by keyword_score desc,id) keyword_rank from scores
 ), fused as (
 select *,case when semantic_similarity>=0.2 then 1.0/(60+semantic_rank) else 0 end+
 case when keyword_score>0 then 1.0/(60+keyword_rank) else 0 end rank_score from ranks
 ), unique_messages as (
 select distinct on(source,source_id) * from fused where rank_score>0 order by source,source_id,rank_score desc,chunk_index
 )
 select id,content,jsonb_build_object('vector_id',id,'source',source,'id',source_id,'thread_key',thread_key,
 'occurred_at',occurred_at,'subject',subject,'sender_email',sender_email,'source_version',source_version,
 'chunk_index',chunk_index,'attachments',attachments,'retrieval','semantic_and_keyword'),semantic_similarity
 from unique_messages order by rank_score desc,occurred_at desc nulls last,id limit greatest(1,least(match_count,30));
$$;

-- Never infer a purchase from a quotation: authoritative CRM facts are separate evidence.
create function public.crm_customer_memory(p_address text) returns jsonb language plpgsql stable security definer set search_path='' as $$
declare ids uuid[]; customer_id uuid;
begin
 select array_agg(distinct c.id) into ids from public.crm_customers c left join public.crm_contacts x on x.customer_id=c.id
 where c.deleted_at is null and (lower(c.email)=lower(trim(p_address)) or lower(x.email)=lower(trim(p_address)));
 if coalesce(cardinality(ids),0)<>1 then return jsonb_build_object('status',case when cardinality(ids)>1 then 'needs_review' else 'not_found' end);end if;
 customer_id:=ids[1];
 return jsonb_build_object('status','matched','customer',(select to_jsonb(c) from public.crm_customers c where id=customer_id),
 'equipment',coalesce((select jsonb_agg(to_jsonb(x)) from (select * from public.crm_equipment where crm_equipment.customer_id=ids[1] order by updated_at desc limit 20) x),'[]'),
 'sites',coalesce((select jsonb_agg(to_jsonb(x)) from (select * from public.crm_sites where crm_sites.customer_id=ids[1] order by updated_at desc limit 20) x),'[]'),
 'purchases',coalesce((select jsonb_agg(to_jsonb(x)) from (select * from public.crm_purchases where crm_purchases.customer_id=ids[1] order by occurred_on desc limit 20) x),'[]'),
 'services',coalesce((select jsonb_agg(to_jsonb(x)) from (select * from public.crm_services where crm_services.customer_id=ids[1] order by occurred_on desc limit 20) x),'[]'),
 'quotations',coalesce((select jsonb_agg(to_jsonb(x)) from (select id,estimate_number,status,created_at from public.crm_quotations where crm_quotations.customer_id=ids[1] and deleted_at is null order by created_at desc limit 10) x),'[]'),
 'evidence_rule','Purchases and completed service records are separate from quoted or requested work. Empty lists do not prove no business relationship. History is bounded.');
end $$;

create function public.crm_ai_context_hybrid(p_thread_id uuid,p_matches jsonb default '[]') returns jsonb
language plpgsql stable security definer set search_path='' as $$
declare brain jsonb; m public.email_messages; extra jsonb; combined jsonb;
begin
 brain:=public.crm_ai_context(p_thread_id);
 select * into m from public.email_messages where thread_id=p_thread_id and direction='incoming' order by occurred_at desc,id desc limit 1;
 if not found then return brain;end if;
 -- Revalidate native vector-store results instead of trusting client-supplied text.
 select coalesce(jsonb_agg(jsonb_build_object('source',s.source,'id',s.source_id,'subject',s.subject,'thread_key',s.thread_key,
 'occurred_at',s.occurred_at,'sender_email',s.sender_email,'body_text',v.content,'body_truncated',true,
 'attachments',s.attachments,'retrieval','semantic_and_keyword')),'[]') into extra
 from jsonb_array_elements(p_matches) candidate
 join public.crm_email_vectors v on v.id::text=coalesce(candidate->>'vector_id',candidate->>'id')
 join public.crm_email_embedding_queue q on q.id::text=v.metadata->>'queue_id'
 join public.crm_email_memory_sources s on s.source=q.source and s.source_id=q.source_id
 where q.source_version=s.source_version and v.metadata->>'source_version'=s.source_version
 and s.participant_emails @> array[lower(m.sender)] and (s.mailbox_id is null or s.mailbox_id=m.mailbox_id);
 select coalesce(jsonb_agg(x order by ord),'[]') into combined from (
 select distinct on(x->>'source',x->>'id') x,ord from jsonb_array_elements(extra||coalesce(brain#>'{history,messages}','[]')) with ordinality t(x,ord)
 where x->>'source'='pst' or exists(select 1 from public.email_messages live where live.id::text=x->>'id' and live.mailbox_id=m.mailbox_id)
 order by x->>'source',x->>'id',ord limit 20) picks;
 return jsonb_set(brain,'{history,messages}',combined)||jsonb_build_object('retrieval','hybrid','semantic_records',jsonb_array_length(extra),
 'customer_records',public.crm_customer_memory(m.sender),'index_status',public.crm_email_index_status());
end $$;

create function public.crm_email_memory_hybrid(p_addresses text[],p_query text,p_embedding extensions.vector(1536),p_mailbox_address text)
returns jsonb language plpgsql stable security definer set search_path='' as $$
declare box uuid; base jsonb; semantic jsonb; combined jsonb;
begin
 if cardinality(p_addresses)<>1 then return jsonb_build_object('status','no_identity','messages','[]'::jsonb);end if;
 select id into box from public.email_mailboxes where provider='microsoft' and lower(address)=lower(trim(p_mailbox_address));
 if box is null then return jsonb_build_object('status','no_mailbox_scope','messages','[]'::jsonb);end if;
 base:=public.crm_email_memory(p_addresses,p_query,12);
 select coalesce(jsonb_agg(v.metadata||jsonb_build_object('body_text',v.content,'body_truncated',true)),'[]') into semantic
 from public.match_email_memory_chunks(p_embedding,8,jsonb_build_object('address',p_addresses[1],'mailbox_id',box::text,'query',p_query)) v;
 select coalesce(jsonb_agg(x order by ord),'[]') into combined from (
 select distinct on(x->>'source',x->>'id') x,ord from jsonb_array_elements(semantic||coalesce(base->'messages','[]')) with ordinality t(x,ord)
 where x->>'source'='pst' or exists(select 1 from public.email_messages live where live.id::text=x->>'id' and live.mailbox_id=box)
 order by x->>'source',x->>'id',ord limit 20) picks;
 return base||jsonb_build_object('status','available','messages',combined,'retrieval','hybrid','semantic_records',jsonb_array_length(semantic),
 'customer_records',public.crm_customer_memory(p_addresses[1]),'index_status',public.crm_email_index_status());
end $$;

do $$ declare f record;begin
 for f in select p.oid::regprocedure signature from pg_proc p join pg_namespace n on n.oid=p.pronamespace
 where n.nspname='public' and p.proname in ('crm_queue_email_embedding','crm_queue_email_backfill','crm_email_embedding_changed','crm_claim_email_embeddings','crm_finish_email_embeddings','crm_email_index_status','match_email_memory_chunks','crm_customer_memory','crm_ai_context_hybrid','crm_email_memory_hybrid') loop
 execute format('revoke all on function %s from public,anon,authenticated',f.signature);
 execute format('grant execute on function %s to service_role',f.signature);
 end loop;
end $$;
notify pgrst,'reload schema';
commit;
