begin;
-- Supplier quotes: one price request (RFQ) for a customer's need, sent to several suppliers.
-- Each supplier gets its own email and row, so the panel shows when each was asked and who answered.
-- Suppliers are customers with relationship_type 'supplier' (Customers page), so there is one directory.
create table public.supplier_rfqs (
 id uuid primary key default gen_random_uuid(),
 number bigint generated always as identity (start with 1001) unique,
 thread_id uuid references public.email_threads(id),
 message_id uuid references public.email_messages(id),
 customer_id uuid references public.crm_customers(id),
 customer_label text not null default '' check(length(customer_label)<=300),
 title text not null check(length(trim(title)) between 1 and 200),
 request_text text not null default '' check(length(request_text)<=20000),
 status text not null default 'draft' check(status in ('draft','open','closed')),
 created_by text not null default '',
 created_at timestamptz not null default now(), updated_at timestamptz not null default now()
);
create table public.supplier_rfq_recipients (
 id uuid primary key default gen_random_uuid(),
 rfq_id uuid not null references public.supplier_rfqs(id) on delete cascade,
 supplier_id uuid references public.crm_customers(id),
 supplier_name text not null check(length(trim(supplier_name)) between 1 and 200),
 supplier_email text not null check(supplier_email=lower(trim(supplier_email)) and supplier_email ~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$'),
 subject text not null check(length(subject) between 1 and 300),
 body text not null check(length(body) between 1 and 20000),
 -- sending: claimed for one send; uncertain: Outlook did not confirm, never resent automatically.
 status text not null default 'draft' check(status in ('draft','sending','sent','uncertain','replied')),
 sent_at timestamptz, sent_by text, provider_message_id text, provider_conversation_id text,
 supplier_thread_id uuid references public.email_threads(id),
 reply_message_id uuid references public.email_messages(id), replied_at timestamptz, last_reply_at timestamptz,
 -- Filled by the AI from the supplier's reply; the owner can correct them.
 reply_text text not null default '', price text not null default '', lead_time text not null default '', reply_notes text not null default '',
 reply_read_at timestamptz,
 nudge_count integer not null default 0, last_nudged_at timestamptz,
 error text, created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
 unique(rfq_id,supplier_email)
);
create index supplier_rfq_recipients_supplier on public.supplier_rfq_recipients(supplier_email) where status in ('sent','uncertain','replied');
create index supplier_rfq_recipients_thread on public.supplier_rfq_recipients(supplier_thread_id);

-- Creates the request and one draft per supplier in one step. '{REF}' in subject/body becomes DCX-RFQ-<number>.
create function public.crm_create_supplier_rfq(p jsonb) returns jsonb language plpgsql security definer set search_path='' as $$
declare q public.supplier_rfqs; s jsonb; ref text;
begin
 if jsonb_array_length(coalesce(p->'recipients','[]'))=0 then raise exception 'Choose at least one supplier.';end if;
 insert into public.supplier_rfqs(thread_id,message_id,customer_id,customer_label,title,request_text,created_by)
 values(nullif(p->>'thread_id','')::uuid,nullif(p->>'message_id','')::uuid,nullif(p->>'customer_id','')::uuid,coalesce(p->>'customer_label',''),p->>'title',coalesce(p->>'request_text',''),coalesce(p->>'created_by',''))
 returning * into q;
 ref:='DCX-RFQ-'||q.number;
 for s in select * from jsonb_array_elements(p->'recipients') loop
  insert into public.supplier_rfq_recipients(rfq_id,supplier_id,supplier_name,supplier_email,subject,body)
  values(q.id,nullif(s->>'supplier_id','')::uuid,s->>'supplier_name',lower(trim(s->>'supplier_email')),replace(s->>'subject','{REF}',ref),replace(s->>'body','{REF}',ref));
 end loop;
 return to_jsonb(q);
end $$;

-- Links supplier mail to its request. A reply counts only from the exact supplier address, and only
-- when it carries the request's reference or arrives in the same Outlook conversation we started.
create function public.crm_match_supplier_rfq() returns trigger language plpgsql security definer set search_path='' as $$
declare v_number bigint; v_key text; r record;
begin
 v_number:=substring(new.subject from '(?i)DCX-RFQ-([0-9]{1,12})')::bigint;
 select provider_thread_key into v_key from public.email_threads where id=new.thread_id;
 if new.direction='outgoing' then
  -- Our sent copy, synced from Sent Items, tells us which conversation the supplier will answer in.
  if v_number is not null then
   update public.supplier_rfq_recipients x set supplier_thread_id=new.thread_id,updated_at=now()
   from public.supplier_rfqs q where q.id=x.rfq_id and q.number=v_number and x.supplier_thread_id is null
   and coalesce(new.to_addresses,'[]'::jsonb) ? x.supplier_email;
  end if;
  return new;
 end if;
 select x.id,x.rfq_id,x.supplier_name,q.thread_id customer_thread,q.number into r
 from public.supplier_rfq_recipients x join public.supplier_rfqs q on q.id=x.rfq_id
 where x.supplier_email=lower(trim(new.sender)) and x.status in ('sent','uncertain','replied')
 and ((v_number is not null and q.number=v_number) or x.provider_conversation_id=v_key or x.supplier_thread_id=new.thread_id)
 order by (v_number is not null and q.number=v_number) desc,x.sent_at desc nulls last limit 1;
 if r.id is null then return new;end if;
 update public.supplier_rfq_recipients set status='replied',reply_message_id=new.id,
  replied_at=coalesce(replied_at,new.occurred_at),last_reply_at=greatest(coalesce(last_reply_at,new.occurred_at),new.occurred_at),
  supplier_thread_id=coalesce(supplier_thread_id,new.thread_id),reply_read_at=null,updated_at=now()
 where id=r.id;
 update public.supplier_rfqs set updated_at=now() where id=r.rfq_id;
 if r.customer_thread is not null then
  update public.email_threads set next_action=r.supplier_name||' replied to supplier request DCX-RFQ-'||r.number,updated_at=now() where id=r.customer_thread;
 end if;
 return new;
end $$;
create trigger crm_match_supplier_rfq after insert on public.email_messages for each row execute function public.crm_match_supplier_rfq();

alter table public.supplier_rfqs enable row level security;
alter table public.supplier_rfq_recipients enable row level security;
revoke all on public.supplier_rfqs, public.supplier_rfq_recipients from anon, authenticated;
grant select, insert, update, delete on public.supplier_rfqs, public.supplier_rfq_recipients to service_role;
revoke all on function public.crm_create_supplier_rfq(jsonb) from public, anon, authenticated;
grant execute on function public.crm_create_supplier_rfq(jsonb) to service_role;
revoke all on function public.crm_match_supplier_rfq() from public, anon, authenticated;
notify pgrst, 'reload schema';
commit;
