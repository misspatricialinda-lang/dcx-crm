-- DCX staff (@dcx-tech.com) have no per-person email memory. The archive is a DCX mailbox, so
-- "every email involving a staff member" is nearly all of it (7,932 of 8,145 for raza.iqbal@):
-- tells the AI nothing about that person, and the semantic search over it exceeded the 8s API
-- statement timeout, failing every draft for an internal sender.
create or replace function public.crm_memory_owned_sources(p_address text)
 returns table(source text, source_id text)
 language sql stable security definer set search_path to ''
as $function$
 with who as (select lower(trim(p_address)) email where position('@' in coalesce(p_address,''))>1
   and split_part(lower(trim(p_address)),'@',2)<>'dcx-tech.com'),
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
$function$;
