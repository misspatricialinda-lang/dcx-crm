begin;
create or replace function public.crm_save_email_classification(p_message_id uuid,p_fingerprint text,p_result jsonb) returns jsonb
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
 chosen_topic:=case when pc>=0.80 and not coalesce((p_result->>'purpose_needs_review')::boolean,(p_result->>'needs_review')::boolean) then p_result->>'purpose' end;
 -- A cold inquiry can be a lead. Employee/customer/partner/vendor identity needs verified records.
 chosen_role:=coalesce(verified,case when rc>=0.60 and pc>=0.80 and not coalesce((p_result->>'relationship_needs_review')::boolean,(p_result->>'needs_review')::boolean) and p_result->>'relationship'='lead' then 'lead' end,case when public.crm_correspondent_role(m.sender)='lead' then 'lead' end);
 if (select count(distinct c.id)>1 from public.crm_customers c left join public.crm_contacts x on x.customer_id=c.id where c.deleted_at is null and (lower(c.email)=lower(m.sender) or lower(x.email)=lower(m.sender))) then chosen_role:=null;chosen_topic:=null;end if;
 review:=chosen_role is null or chosen_topic is null;
 insert into public.email_ai_classifications(message_id,fingerprint,purpose,relationship,purpose_confidence,relationship_confidence,needs_review,reason,model,prompt_version)
 values(m.id,p_fingerprint,chosen_topic,chosen_role,pc,rc,review,left(coalesce(p_result->>'reason',''),600),'gpt-5-mini','email-classification-v2')
 on conflict(message_id) do update set fingerprint=excluded.fingerprint,purpose=excluded.purpose,relationship=excluded.relationship,purpose_confidence=excluded.purpose_confidence,relationship_confidence=excluded.relationship_confidence,needs_review=excluded.needs_review,reason=excluded.reason,prompt_version=excluded.prompt_version,classified_at=now();
 select m.id=(select id from public.email_messages where thread_id=m.thread_id and direction='incoming' order by occurred_at desc,id desc limit 1) into is_latest;
 if is_latest then update public.email_threads set topic=case when topic_source='owner' then topic else chosen_topic end,
 topic_source=case when topic_source='owner' then 'owner' else 'ai' end,
 classification_state=case when (case when topic_source='owner' then topic else chosen_topic end) is null or chosen_role is null then 'needs_review' else 'classified' end,updated_at=now() where id=m.thread_id;end if;
 result:=jsonb_build_object('purpose',case when t.topic_source='owner' then t.topic else chosen_topic end,'relationship',chosen_role,'needs_review',chosen_role is null or (case when t.topic_source='owner' then t.topic else chosen_topic end) is null,'applied_to_latest',is_latest,'source',case when t.topic_source='owner' then 'owner' else 'ai' end);
 insert into public.email_activity(thread_id,action,actor,details) values(m.thread_id,'email_classified','ai',result||jsonb_build_object('message_id',m.id,'prompt_version','email-classification-v2'));
 return result;
end $$;


with corrected as (
 update public.email_ai_classifications a set relationship='lead',needs_review=(a.purpose is null)
 from public.email_messages m where m.id=a.message_id and a.relationship is null and a.fingerprint=md5(m.sender||m.subject||m.body_text||m.body_html) and public.crm_correspondent_role(m.sender)='lead'
 returning m.thread_id,a.message_id
) insert into public.email_activity(thread_id,action,actor,details) select thread_id,'sender_relationship_reused','ai',jsonb_build_object('message_id',message_id,'relationship','lead') from corrected;
update public.email_threads t set classification_state=case when t.topic is not null and public.crm_correspondent_role((select sender from public.email_messages where thread_id=t.id and direction='incoming' order by occurred_at desc,id desc limit 1)) is not null then 'classified' else 'needs_review' end where t.topic_source='ai' and t.classification_state<>'pending';
notify pgrst,'reload schema';
commit;
