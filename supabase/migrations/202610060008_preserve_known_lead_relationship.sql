create or replace function public.crm_correspondent_role(p_email text) returns text
language sql stable security definer set search_path='' as $$
select coalesce(public.crm_verified_correspondent_role(p_email),(select a.relationship from public.email_ai_classifications a join public.email_messages m on m.id=a.message_id where lower(m.sender)=lower(trim(p_email)) and a.relationship='lead' and a.fingerprint=md5(m.sender||m.subject||m.body_text||m.body_html) order by m.occurred_at desc,m.id desc limit 1));
$$;
notify pgrst,'reload schema';
