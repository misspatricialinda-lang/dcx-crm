begin;
alter table public.email_threads drop constraint email_threads_topic_source_check;
alter table public.email_threads add constraint email_threads_topic_source_check check(topic_source in ('rules','owner','ai'));
alter table public.email_threads add column classification_state text not null default 'needs_review' check(classification_state in ('pending','classified','needs_review'));
create table public.email_ai_classifications (
 message_id uuid primary key references public.email_messages(id) on delete cascade,
 fingerprint text not null, purpose text check(purpose in ('support','upgrade','quotation','billing','meeting','incomplete_inquiry')),
 relationship text check(relationship in ('employee','customer','lead','supplier','wholesale_partner')),
 purpose_confidence numeric not null check(purpose_confidence between 0 and 1),
 relationship_confidence numeric not null check(relationship_confidence between 0 and 1),
 needs_review boolean not null, reason text not null check(length(reason)<=600),
 model text not null, prompt_version text not null, classified_at timestamptz not null default now()
);
alter table public.email_ai_classifications enable row level security;
revoke all on public.email_ai_classifications from public,anon,authenticated;
grant select,insert,update,delete on public.email_ai_classifications to service_role;
-- Verified identities outrank AI and cannot be changed by an email's claims.
create function public.crm_verified_correspondent_role(p_email text) returns text
language sql stable security definer set search_path='' as $$
select case when split_part(lower(trim(p_email)),'@',2)='dcx-tech.com' then 'employee'
else coalesce((select role from public.email_correspondent_roles where email=lower(trim(p_email))),
(select 'supplier' from public.product_supplier_routes where supplier_email=lower(trim(p_email)) limit 1),
(select case when count(distinct c.id)=1 then min(c.relationship_type) end from public.crm_customers c
left join public.crm_contacts x on x.customer_id=c.id where c.deleted_at is null
and (lower(c.email)=lower(trim(p_email)) or lower(x.email)=lower(trim(p_email))))) end;
$$;
create function public.crm_email_classification_input(p_message_id uuid) returns jsonb
language sql stable security definer set search_path='' as $$
select jsonb_build_object('message_id',m.id,'thread_id',m.thread_id,'sender',m.sender,'subject',m.subject,
 'body',left(case when m.body_html<>'' then regexp_replace(m.body_html,'<[^>]*>',' ','g') else m.body_text end,12000),
 'fingerprint',md5(m.sender||m.subject||m.body_text||m.body_html),'verified_relationship',public.crm_verified_correspondent_role(m.sender),
 'identity_ambiguous',(select count(distinct c.id)>1 from public.crm_customers c left join public.crm_contacts x on x.customer_id=c.id where c.deleted_at is null and (lower(c.email)=lower(m.sender) or lower(x.email)=lower(m.sender))),
 'manual_purpose',case when t.topic_source='owner' then t.topic end)
from public.email_messages m join public.email_threads t on t.id=m.thread_id where m.id=p_message_id and m.direction='incoming';
$$;
create function public.crm_save_email_classification(p_message_id uuid,p_fingerprint text,p_result jsonb) returns jsonb
language plpgsql security definer set search_path='' as $$
declare m public.email_messages; t public.email_threads; verified text; chosen_role text; chosen_topic text; pc numeric; rc numeric; review boolean; result jsonb; is_latest boolean;
begin
 select * into m from public.email_messages where id=p_message_id and direction='incoming';
 if not found then raise exception 'Incoming message not found';end if;
 select * into t from public.email_threads where id=m.thread_id for update;
 if p_fingerprint<>md5(m.sender||m.subject||m.body_text||m.body_html) then raise exception 'Message changed during classification';end if;
 if jsonb_typeof(p_result->'purpose_confidence')<>'number' or jsonb_typeof(p_result->'relationship_confidence')<>'number' or jsonb_typeof(p_result->'needs_review')<>'boolean' then raise exception 'Invalid classification output';end if;
 pc:=(p_result->>'purpose_confidence')::numeric;rc:=(p_result->>'relationship_confidence')::numeric;
 if pc not between 0 and 1 or rc not between 0 and 1 then raise exception 'Invalid classification confidence';end if;
 if p_result->>'purpose' is not null and p_result->>'purpose' not in ('support','upgrade','quotation','billing','meeting','incomplete_inquiry') then raise exception 'Invalid purpose';end if;
 if p_result->>'relationship' is not null and p_result->>'relationship' not in ('employee','customer','lead','supplier','wholesale_partner') then raise exception 'Invalid relationship';end if;
 verified:=public.crm_verified_correspondent_role(m.sender);
 chosen_topic:=case when pc>=0.80 and not (p_result->>'needs_review')::boolean then p_result->>'purpose' end;
 -- A cold inquiry can be a lead. Employee/customer/partner/vendor identity needs verified records.
 chosen_role:=coalesce(verified,case when rc>=0.85 and not (p_result->>'needs_review')::boolean and p_result->>'relationship'='lead' then 'lead' end);
 if (select count(distinct c.id)>1 from public.crm_customers c left join public.crm_contacts x on x.customer_id=c.id where c.deleted_at is null and (lower(c.email)=lower(m.sender) or lower(x.email)=lower(m.sender))) then chosen_role:=null;chosen_topic:=null;end if;
 review:=chosen_role is null or chosen_topic is null;
 insert into public.email_ai_classifications(message_id,fingerprint,purpose,relationship,purpose_confidence,relationship_confidence,needs_review,reason,model,prompt_version)
 values(m.id,p_fingerprint,chosen_topic,chosen_role,pc,rc,review,left(coalesce(p_result->>'reason',''),600),'gpt-5-mini','email-classification-v1')
 on conflict(message_id) do update set fingerprint=excluded.fingerprint,purpose=excluded.purpose,relationship=excluded.relationship,purpose_confidence=excluded.purpose_confidence,relationship_confidence=excluded.relationship_confidence,needs_review=excluded.needs_review,reason=excluded.reason,classified_at=now();
 select m.id=(select id from public.email_messages where thread_id=m.thread_id and direction='incoming' order by occurred_at desc,id desc limit 1) into is_latest;
 if is_latest then update public.email_threads set topic=case when topic_source='owner' then topic else chosen_topic end,
 topic_source=case when topic_source='owner' then 'owner' else 'ai' end,
 classification_state=case when (case when topic_source='owner' then topic else chosen_topic end) is null or chosen_role is null then 'needs_review' else 'classified' end,updated_at=now() where id=m.thread_id;end if;
 result:=jsonb_build_object('purpose',case when t.topic_source='owner' then t.topic else chosen_topic end,'relationship',chosen_role,'needs_review',chosen_role is null or (case when t.topic_source='owner' then t.topic else chosen_topic end) is null,'applied_to_latest',is_latest,'source',case when t.topic_source='owner' then 'owner' else 'ai' end);
 insert into public.email_activity(thread_id,action,actor,details) values(m.thread_id,'email_classified','ai',result||jsonb_build_object('message_id',m.id,'prompt_version','email-classification-v1'));
 return result;
end $$;
create or replace function public.crm_correspondent_role(p_email text) returns text
language sql stable security definer set search_path='' as $$
select coalesce(public.crm_verified_correspondent_role(p_email),(select a.relationship from public.email_ai_classifications a join public.email_messages m on m.id=a.message_id where lower(m.sender)=lower(trim(p_email)) and a.fingerprint=md5(m.sender||m.subject||m.body_text||m.body_html) order by m.occurred_at desc,m.id desc limit 1));
$$;
create function public.crm_mark_classification_pending() returns trigger language plpgsql security definer set search_path='' as $$
begin
 if new.direction='incoming' and (tg_op='INSERT' or new.sender is distinct from old.sender or new.subject is distinct from old.subject or new.body_text is distinct from old.body_text or new.body_html is distinct from old.body_html) then
 update public.email_threads set classification_state='pending',topic=case when topic_source='owner' then topic else null end
 where id=new.thread_id and new.id=(select id from public.email_messages where thread_id=new.thread_id and direction='incoming' order by occurred_at desc,id desc limit 1);
 end if;return new;
end $$;
create trigger zz_classification_pending after insert or update of sender,subject,body_text,body_html on public.email_messages for each row execute function public.crm_mark_classification_pending();
-- Include the classification progress in existing dashboard records.
do $$ declare definition text;begin
 select pg_get_functiondef('public.crm_email_categories()'::regprocedure) into definition;
 definition:=replace(definition,'t.subject, t.topic, t.status','t.subject, t.topic, t.status, t.classification_state');
 definition:=replace(definition,'t.subject,t.topic,t.status','t.subject,t.topic,t.status,t.classification_state');
 execute definition;
end $$;
revoke all on function public.crm_verified_correspondent_role(text),public.crm_email_classification_input(uuid),public.crm_save_email_classification(uuid,text,jsonb) from public,anon,authenticated;
grant execute on function public.crm_verified_correspondent_role(text),public.crm_email_classification_input(uuid),public.crm_save_email_classification(uuid,text,jsonb) to service_role;
notify pgrst,'reload schema';
commit;
