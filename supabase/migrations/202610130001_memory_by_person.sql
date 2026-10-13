-- Email memory belongs to a person, not to whichever DCX mailbox is connected.
-- A message counts for an address when that person sent it, or when it is our side
-- of a conversation they wrote in (same tracked conversation, or a direct reply link).
-- Being only a recipient is not enough: internal forwards of another client's work
-- to that address stay out of their memory.
-- The conversation being answered is excluded; every caller already reads it in full.
begin;

create function public.crm_memory_owned_sources(p_address text)
returns table(source text, source_id text)
language sql stable security definer set search_path='' as $$
 with who as (select lower(trim(p_address)) email where position('@' in coalesce(p_address,''))>1),
 arc as materialized (
   select a.source_key,lower(a.sender_email) sender,nullif(a.internet_message_id,'') imid,nullif(a.in_reply_to,'') irt
   from public.crm_email_archive a,who where not a.is_draft and a.participant_emails @> array[who.email]
 ), arc_theirs as (select arc.* from arc,who where arc.sender=who.email),
 live as materialized (
   select m.id,m.thread_id,lower(m.sender) sender,nullif(m.internet_message_id,'') imid,nullif(m.in_reply_to,'') irt
   from public.email_messages m,who where m.body_loaded and (lower(m.sender)=who.email or exists(
     select 1 from jsonb_array_elements_text(m.to_addresses||m.cc_addresses) r where lower(r)=who.email))
 ), live_theirs as (select live.* from live,who where live.sender=who.email)
 select 'pst'::text,x.source_key from arc_theirs x
 union select 'pst',x.source_key from arc x join arc_theirs t on t.irt=x.imid
 union select 'pst',x.source_key from arc x join arc_theirs t on x.irt=t.imid
 union select 'tracked',x.id::text from live x where x.thread_id in (select thread_id from live_theirs)
 union select 'tracked',x.id::text from live x join live_theirs t on t.irt=x.imid or x.irt=t.imid;
$$;

drop function public.crm_email_memory(text[],text,integer);
-- Topic matches use any meaningful word (a whole email as an AND query almost never
-- matched). The rest is filled from recent conversations, at most two messages each,
-- so one long chain cannot crowd out the person's other conversations.
create function public.crm_email_memory(p_addresses text[], p_query text default '', p_limit integer default 12, p_exclude_thread text default null)
returns jsonb language sql stable security definer set search_path = '' as $$
 with addresses as (
   select distinct lower(trim(a)) as email from unnest(p_addresses) a
   where position('@' in a)>1
 ), owned as materialized (
   select o.source,o.source_id from addresses cross join lateral public.crm_memory_owned_sources(addresses.email) o
 ), excluded as (
   select t.id from public.email_threads t
   where nullif(p_exclude_thread,'') is not null and (t.id::text=p_exclude_thread or t.provider_thread_key=p_exclude_thread)
 ), q as (
   select nullif(replace(plainto_tsquery('english',left(coalesce(p_query,''),2000))::text,' & ',' | '),'')::tsquery as tsq
 ), archive as (
   select distinct on (coalesce(nullif(a.internet_message_id,''),a.source_key),md5(a.body_text))
     'pst'::text as source, a.source_key as id, a.thread_key,
     a.sender_email, a.sender_name, a.subject, coalesce(a.sent_at,a.received_at) as occurred_at,
     a.body_text, a.attachments,
     coalesce(ts_rank_cd(a.search_text,q.tsq),0) as relevance
   from public.crm_email_archive a,q
   where not a.is_draft and a.participant_emails && array(select email from addresses)
     and a.source_key in (select source_id from owned where source='pst')
   order by coalesce(nullif(a.internet_message_id,''),a.source_key),md5(a.body_text),a.source_key
 ), live as (
   -- The app's send record and Outlook's sync copy of one email count once.
   select distinct on (m.thread_id,m.direction,md5(left(regexp_replace(m.body_text,'\s','','g'),400)))
     'tracked'::text as source, m.id::text as id, m.thread_id::text as thread_key,
     m.sender as sender_email, ''::text as sender_name, m.subject, m.occurred_at,
     m.body_text, coalesce((select jsonb_agg(jsonb_build_object('name',f.name,'storage_path',f.storage_path))
       from public.email_attachments f where f.message_id=m.id),'[]'::jsonb) as attachments,
     coalesce(ts_rank_cd(to_tsvector('english',m.subject || ' ' || m.body_text),q.tsq),0) as relevance
   from public.email_messages m,q
   where m.id::text in (select source_id from owned where source='tracked')
     and m.thread_id not in (select id from excluded)
   order by m.thread_id,m.direction,md5(left(regexp_replace(m.body_text,'\s','','g'),400)),m.occurred_at,m.id
 ), evidence as (select * from archive union all select * from live),
 sizes as (select greatest(1,least(p_limit,30)) as total, greatest(1,least(p_limit,30)/2) as topical),
 ranked as (
   select *, row_number() over(partition by source,thread_key order by relevance desc,occurred_at desc nulls last,id) as topic_pos,
     row_number() over(partition by source,thread_key order by occurred_at desc nulls last,id) as thread_pos
   from evidence
 ), topical as (
   select x.* from (select r.*, row_number() over(order by r.relevance desc,r.occurred_at desc nulls last,r.id) as topic_rank
     from ranked r where r.relevance>0 and r.topic_pos<=2) x,sizes where x.topic_rank<=sizes.topical
 ), recent as (
   -- Newest message of each conversation first, then each one's second newest.
   select r.*, row_number() over(order by r.thread_pos,r.occurred_at desc nulls last,r.id) as recent_rank
   from ranked r where r.thread_pos<=2 and not exists(select 1 from topical t where t.source=r.source and t.id=r.id)
 ), picked as (
   select source,id,thread_key,sender_email,sender_name,subject,occurred_at,body_text,attachments,relevance from topical
   union all
   select source,id,thread_key,sender_email,sender_name,subject,occurred_at,body_text,attachments,relevance from recent,sizes
   where recent.recent_rank<=sizes.total-(select count(*) from topical)
 )
 select jsonb_build_object(
   'matching_messages',(select count(*) from evidence),
   'earliest_at',(select min(occurred_at) from evidence),
   'latest_at',(select max(occurred_at) from evidence),
   'excludes_current_conversation',nullif(p_exclude_thread,'') is not null,
   'contacts',coalesce((select jsonb_agg(jsonb_build_object('id',c.id,'name',c.name,'email',c.email,'customer_id',c.customer_id))
     from public.crm_contacts c where c.email in (select email from addresses)),'[]'::jsonb),
   'messages',coalesce((select jsonb_agg(jsonb_build_object('source',source,'id',id,'thread_key',thread_key,
     'sender_email',sender_email,'sender_name',sender_name,'subject',subject,'occurred_at',occurred_at,
     'body_text',left(body_text,6000),'body_truncated',length(body_text)>6000,'attachments',attachments)
     order by relevance desc,occurred_at desc nulls last) from picked),'[]'::jsonb)
 );
$$;

create or replace function public.match_email_memory_chunks(query_embedding extensions.vector(1536),match_count integer default 12,filter jsonb default '{}')
returns table(id uuid,content text,metadata jsonb,similarity double precision)
language sql stable security definer set search_path='' as $$
 with owned as materialized (
 select o.source,o.source_id from public.crm_memory_owned_sources(filter->>'address') o
 where length(coalesce(filter->>'address',''))>3
 ), excluded as (
 select t.id::text id from public.email_threads t
 where nullif(filter->>'exclude_thread','') is not null and (t.id::text=filter->>'exclude_thread' or t.provider_thread_key=filter->>'exclude_thread')
 ), scoped as materialized (
 select v.id,v.content,v.embedding,q.chunk_index,s.*
 from public.crm_email_vectors v join public.crm_email_embedding_queue q on q.id::text=v.metadata->>'queue_id'
 join public.crm_email_memory_sources s on s.source=q.source and s.source_id=q.source_id
 join owned o on o.source=s.source and o.source_id=s.source_id
 where v.embedding is not null and q.source_version=s.source_version and v.metadata->>'source_version'=s.source_version
 and s.participant_emails @> array[lower(trim(filter->>'address'))]
 and not (s.source='tracked' and s.thread_key in (select id from excluded))
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

drop function public.crm_email_memory_hybrid(text[],text,extensions.vector(1536),text);
-- p_mailbox_address is still accepted from older callers but no longer limits memory.
create function public.crm_email_memory_hybrid(p_addresses text[],p_query text,p_embedding extensions.vector(1536),p_mailbox_address text default null,p_exclude_thread text default null)
returns jsonb language plpgsql stable security definer set search_path='' as $$
declare base jsonb; semantic jsonb; combined jsonb;
begin
 if cardinality(p_addresses)<>1 then return jsonb_build_object('status','no_identity','messages','[]'::jsonb);end if;
 base:=public.crm_email_memory(p_addresses,p_query,12,p_exclude_thread);
 select coalesce(jsonb_agg(v.metadata||jsonb_build_object('body_text',v.content,'body_truncated',true)),'[]') into semantic
 from public.match_email_memory_chunks(p_embedding,8,jsonb_build_object('address',p_addresses[1],'query',p_query,'exclude_thread',p_exclude_thread)) v;
 select coalesce(jsonb_agg(x order by ord),'[]') into combined from (
 select distinct on(x->>'source',x->>'id') x,ord from jsonb_array_elements(semantic||coalesce(base->'messages','[]')) with ordinality t(x,ord)
 order by x->>'source',x->>'id',ord limit 20) picks;
 return base||jsonb_build_object('status','available','messages',combined,'retrieval','hybrid','semantic_records',jsonb_array_length(semantic),
 'customer_records',public.crm_customer_memory(p_addresses[1]),'index_status',public.crm_email_index_status());
end $$;

create or replace function public.crm_ai_context_hybrid(p_thread_id uuid,p_matches jsonb default '[]') returns jsonb
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
 join public.crm_memory_owned_sources(m.sender) o on o.source=s.source and o.source_id=s.source_id
 where q.source_version=s.source_version and v.metadata->>'source_version'=s.source_version
 and s.participant_emails @> array[lower(m.sender)]
 and not (s.source='tracked' and s.thread_key=p_thread_id::text);
 select coalesce(jsonb_agg(x order by ord),'[]') into combined from (
 select distinct on(x->>'source',x->>'id') x,ord from jsonb_array_elements(extra||coalesce(brain#>'{history,messages}','[]')) with ordinality t(x,ord)
 order by x->>'source',x->>'id',ord limit 20) picks;
 return jsonb_set(brain,'{history,messages}',combined)||jsonb_build_object('retrieval','hybrid','semantic_records',jsonb_array_length(extra),
 'customer_records',public.crm_customer_memory(m.sender),'index_status',public.crm_email_index_status());
end $$;

-- crm_ai_context was extended in place by 202610060006; patch only its history call.
do $$ declare definition text;
 old_call text:='public.crm_email_memory(array[lower(trim(m.sender))],left(m.subject||'' ''||m.body_text,1000),12)';
 new_call text:='public.crm_email_memory(array[lower(trim(m.sender))],left(m.subject||'' ''||m.body_text,1000),12,p_thread_id::text)';
begin
 select pg_get_functiondef('public.crm_ai_context(uuid)'::regprocedure) into definition;
 if position(new_call in definition)=0 then
  if position(old_call in definition)=0 then raise exception 'crm_ai_context history call not found; patch it manually.';end if;
  execute replace(definition,old_call,new_call);
 end if;
end $$;

do $$ declare f record;begin
 for f in select p.oid::regprocedure signature from pg_proc p join pg_namespace n on n.oid=p.pronamespace
 where n.nspname='public' and p.proname in ('crm_memory_owned_sources','crm_email_memory','match_email_memory_chunks','crm_email_memory_hybrid','crm_ai_context_hybrid','crm_ai_context') loop
 execute format('revoke all on function %s from public,anon,authenticated',f.signature);
 execute format('grant execute on function %s to service_role',f.signature);
 end loop;
end $$;
notify pgrst,'reload schema';
commit;
