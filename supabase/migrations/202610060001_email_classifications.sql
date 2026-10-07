begin;
alter table public.email_threads drop constraint email_threads_topic_check;
alter table public.email_threads alter column topic drop not null;
alter table public.email_threads alter column topic drop default;
alter table public.email_correspondent_roles drop constraint email_correspondent_roles_role_check;
alter table public.crm_customers drop constraint crm_customers_relationship_type_check;
alter table public.crm_customers alter column relationship_type drop not null;
update public.email_correspondent_roles set role='wholesale_partner' where role='qualified_company';
delete from public.email_correspondent_roles where role='other';
update public.crm_customers set relationship_type=case when relationship_type='qualified_company' then 'wholesale_partner' when relationship_type='other' then null else relationship_type end;
update public.email_threads set topic=case when topic in ('pricing','order') then 'quotation' when topic in ('service','technical') then 'support' when topic='other' then null else topic end;
alter table public.crm_customers add constraint crm_customers_relationship_type_check check(relationship_type in ('employee','customer','lead','supplier','wholesale_partner'));
alter table public.email_correspondent_roles add constraint email_correspondent_roles_role_check check(role in ('employee','customer','lead','supplier','wholesale_partner'));
alter table public.email_threads add constraint email_threads_topic_check check(topic in ('support','upgrade','quotation','billing','meeting','incomplete_inquiry'));
create or replace function public.crm_correspondent_role(p_email text) returns text
language sql stable security definer set search_path='' as $$
select case when split_part(lower(trim(p_email)),'@',2)='dcx-tech.com' then 'employee'
else coalesce((select role from public.email_correspondent_roles where email=lower(trim(p_email))),
(select 'supplier' from public.product_supplier_routes where supplier_email=lower(trim(p_email)) limit 1),
(select case when count(distinct c.id)=1 then min(c.relationship_type) end from public.crm_customers c
left join public.crm_contacts x on x.customer_id=c.id where c.deleted_at is null
and (lower(c.email)=lower(trim(p_email)) or lower(x.email)=lower(trim(p_email))))) end;
$$;
create function public.crm_email_purpose(p_content text) returns text language sql immutable set search_path='' as $$
select case
when lower(p_content) ~ '(meeting|appointment|schedule a call|when.*available|what time.*available|availability|book.*call)' then 'meeting'
when lower(p_content) ~ '(invoice|payment|billing)' then 'billing'
when lower(p_content) ~ '(upgrade|replace.*larger|increase.*capacity)' then 'upgrade'
when lower(p_content) ~ '(fault|alarm|troubleshoot|technical|repair|maintenance|not working|support|service visit)' then 'support'
when lower(p_content) ~ '(quotation|quote|estimate|price|pricing|how much|cost of|purchase order|order confirmation)' then 'quotation'
when lower(p_content) ~ '(ups|battery|batteries|backup|inquiry|interested|requirement)' then 'incomplete_inquiry'
end;
$$;
create or replace function public.crm_classify_email() returns trigger language plpgsql security definer set search_path='' as $$
declare content text; category text; route public.product_supplier_routes; qty numeric; ref text; requested_sku text; matched boolean:=false; sku_count integer;
begin
 if new.direction<>'incoming' then return new;end if;
 content:=lower(new.subject||' '||left(new.body_text,5000));
 category:=public.crm_email_purpose(content);
 update public.email_threads set topic=category where id=new.thread_id and topic_source='rules'
 and not exists(select 1 from public.email_messages where thread_id=new.thread_id and direction='incoming' and occurred_at>new.occurred_at);
 -- Supplier replies require both a request reference and the exact mapped sender.
 ref:=substring(new.subject from 'DCX-PR-([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})');
 if ref is not null then
 with answered as (
  update public.supplier_price_requests set status='answered',supplier_reply_id=new.id,updated_at=now()
  where id=ref::uuid and lower(supplier_email)=lower(trim(new.sender)) and status in ('sent','dispatching','uncertain') returning thread_id
 ) update public.email_threads set status='needs_attention',next_action='Supplier pricing received. Review supplier terms and regenerate the customer draft.',updated_at=now()
 where id in(select thread_id from answered);
 end if;
 -- Auto routing requires an explicit SKU token and quantity, never a guessed product.
 if category='quotation' and content ~ '(price|pricing|how much|cost of)' then
  select count(*) into sku_count from regexp_matches(content,'sku:[[:space:]]*([a-z0-9_.-]{1,100})','g');
  qty:=substring(content from '(?:quantity|qty)[[:space:]:]+([0-9]{1,6}(?:\.[0-9]{1,3})?)(?![0-9.])')::numeric;
  if sku_count<>1 or qty<=0 then qty:=null;end if;
  for route in select * from public.product_supplier_routes loop
   if position(lower('sku: '||route.sku)||' ' in content||' ')>0 or position(lower('sku: '||route.sku)||E'\n' in content||E'\n')>0 then
    matched:=true;
    perform public.crm_supplier_request(new.id,route.sku,qty);
   end if;
  end loop;
  if not matched then
   requested_sku:=substring(new.subject||' '||left(new.body_text,5000) from '(?i)sku:[[:space:]]*([a-z0-9_.-]{1,100})');
   if requested_sku is not null then perform public.crm_supplier_request(new.id,requested_sku,qty);end if;
  end if;
 end if;
 return new;
end $$;

create or replace function public.crm_email_categories() returns jsonb language sql stable security definer set search_path='' as $$
 with latest as (select distinct on (m.thread_id) m.thread_id,lower(trim(m.sender)) email,m.occurred_at,t.last_message_at last_activity_at,t.subject,t.topic,t.status
 from public.email_messages m join public.email_threads t on t.id=m.thread_id where m.direction='incoming'
 order by m.thread_id,m.occurred_at desc,m.id desc), classified as (
 select *,public.crm_correspondent_role(email) role from latest), people as (
 select c.*,coalesce(r.company,'') company from classified c left join public.email_correspondent_roles r on r.email=c.email
 order by last_activity_at desc limit 200)
 select jsonb_build_object('roles',coalesce((select jsonb_object_agg(role,n) from (select role,count(*) n from classified where role is not null group by role)x),'{}'),
 'topics',coalesce((select jsonb_object_agg(topic,n) from (select topic,count(*) n from classified where topic is not null group by topic)x),'{}'),
 'records',coalesce((select jsonb_agg(to_jsonb(people)) from people),'[]'),'needs_review',(select count(*) from classified where role is null or topic is null),'total',(select count(*) from classified));
$$;

-- Reclassify existing rules-based conversations without firing supplier-routing triggers.
with latest as (select distinct on(thread_id) thread_id,subject,body_text,body_html from public.email_messages where direction='incoming' order by thread_id,occurred_at desc,id desc)
update public.email_threads t set topic=public.crm_email_purpose(m.subject||' '||left(case when m.body_html<>'' then regexp_replace(m.body_html,'<[^>]*>',' ','g') else m.body_text end,5000)) from latest m where t.id=m.thread_id and t.topic_source='rules';
revoke all on function public.crm_email_purpose(text) from public,anon,authenticated;
grant execute on function public.crm_email_purpose(text) to service_role;
notify pgrst,'reload schema';
commit;
