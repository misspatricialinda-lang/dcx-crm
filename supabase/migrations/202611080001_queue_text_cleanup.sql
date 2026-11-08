-- The embedding queue kept a second copy of each email's text after indexing. Search reads the text
-- from crm_email_vectors, so a finished ('ready') chunk no longer needs it. Saves ~30 MB on the free plan.
begin;
update public.crm_email_embedding_queue set content='' where status='ready' and content<>'';

create or replace function public.crm_finish_email_embeddings(p_claims jsonb, p_error text default null)
returns integer language plpgsql security definer set search_path='' as $$
declare n integer;
begin
 update public.crm_email_embedding_queue q set
 status=case when p_error is null then 'ready' when attempts>=8 then 'failed' else 'pending' end,
 -- Indexed text lives in crm_email_vectors; keep the queue copy only while it may be retried.
 content=case when p_error is null then '' else q.content end,
 error=left(p_error,300),lease_token=null,lease_until=null,updated_at=now()
 from jsonb_to_recordset(p_claims) x(id uuid,lease_token uuid,source_version text)
 where q.id=x.id and q.lease_token=x.lease_token and q.source_version=x.source_version and q.status='processing'
 and (p_error is not null or exists(select 1 from public.crm_email_vectors v where v.metadata->>'queue_id'=q.id::text and v.metadata->>'source_version'=q.source_version and v.embedding is not null));
 get diagnostics n=row_count;return n;
end $$;
commit;
