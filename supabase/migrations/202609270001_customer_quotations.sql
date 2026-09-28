begin;

create sequence public.crm_estimate_number_seq start with 6538;

create table public.crm_quotations (
  id uuid primary key default gen_random_uuid(),
  customer_id uuid not null references public.crm_customers(id),
  estimate_number bigint not null unique default nextval('public.crm_estimate_number_seq'),
  recipient_snapshot jsonb not null,
  address_1 text not null default '',
  status text not null default 'draft' check (status in ('draft','issued')),
  version integer not null default 1 check (version > 0),
  tax_rate numeric(5,2) not null default 13.00 check (tax_rate >= 0 and tax_rate <= 100),
  subtotal numeric(14,2) not null default 0 check (subtotal >= 0),
  tax_total numeric(14,2) not null default 0 check (tax_total >= 0),
  grand_total numeric(14,2) not null default 0 check (grand_total >= 0),
  issued_at timestamptz,
  deleted_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index crm_quotations_customer_history on public.crm_quotations(customer_id,created_at desc) where deleted_at is null;

create table public.crm_quotation_items (
  id uuid primary key default gen_random_uuid(),
  quotation_id uuid not null references public.crm_quotations(id),
  position integer not null check (position >= 0),
  product_service text not null check (length(trim(product_service)) > 0),
  description text not null default '',
  quantity numeric(12,3) not null check (quantity > 0),
  unit_price numeric(12,2) not null check (unit_price >= 0),
  line_total numeric(14,2) generated always as (round(quantity * unit_price,2)) stored,
  unique (quotation_id,position)
);

create or replace function public.crm_save_quotation(p_customer_id uuid,p_quotation_id uuid,p_version integer,p_address_1 text,p_items jsonb,p_issue boolean default false)
returns uuid language plpgsql security definer set search_path = '' as $$
declare q public.crm_quotations%rowtype; c public.crm_customers%rowtype; item jsonb; n integer := 0; v_subtotal numeric(14,2) := 0;
begin
  if jsonb_typeof(p_items) <> 'array' or jsonb_array_length(p_items) < 1 or jsonb_array_length(p_items) > 500 then raise exception 'Add 1 to 500 quotation rows'; end if;
  select * into c from public.crm_customers where id=p_customer_id;
  if not found then raise exception 'Customer not found'; end if;
  if p_quotation_id is null then
    insert into public.crm_quotations(customer_id,recipient_snapshot,address_1)
    values(c.id,jsonb_build_object('name',c.name,'contact',c.contact,'email',c.email,'phone',c.phone,'billing_address',c.billing_address),left(coalesce(p_address_1,''),1000)) returning * into q;
  else
    update public.crm_quotations set version=version+1,address_1=left(coalesce(p_address_1,''),1000),updated_at=now()
    where id=p_quotation_id and customer_id=p_customer_id and version=p_version and status='draft' and deleted_at is null returning * into q;
    if not found then raise exception 'Quotation changed, was issued, or was deleted. Reload it before editing'; end if;
    delete from public.crm_quotation_items where quotation_id=q.id;
  end if;
  for item in select value from jsonb_array_elements(p_items) loop
    if length(trim(coalesce(item->>'product_service',''))) < 1 or length(item->>'product_service') > 200
      or length(coalesce(item->>'description','')) > 2000
      or coalesce(item->>'quantity','') !~ '^\d{1,9}(\.\d{1,3})?$'
      or coalesce(item->>'unit_price','') !~ '^\d{1,10}(\.\d\d?)?$'
      or (item->>'quantity')::numeric <= 0 then raise exception 'Invalid quotation row %',n+1; end if;
    insert into public.crm_quotation_items(quotation_id,position,product_service,description,quantity,unit_price)
    values(q.id,n,trim(item->>'product_service'),coalesce(item->>'description',''),(item->>'quantity')::numeric,(item->>'unit_price')::numeric);
    v_subtotal := v_subtotal + round((item->>'quantity')::numeric*(item->>'unit_price')::numeric,2);
    n := n+1;
  end loop;
  update public.crm_quotations set subtotal=v_subtotal,tax_total=round(v_subtotal*tax_rate/100,2),grand_total=v_subtotal+round(v_subtotal*tax_rate/100,2),
    status=case when p_issue then 'issued' else status end,issued_at=case when p_issue then now() else issued_at end,updated_at=now()
  where id=q.id;
  return q.id;
end $$;

create or replace function public.crm_delete_quotation(p_customer_id uuid,p_quotation_id uuid,p_version integer)
returns boolean language plpgsql security definer set search_path = '' as $$
begin
  update public.crm_quotations set deleted_at=now(),version=version+1,updated_at=now()
  where id=p_quotation_id and customer_id=p_customer_id and version=p_version and deleted_at is null;
  return found;
end $$;

alter table public.crm_quotations enable row level security;
alter table public.crm_quotation_items enable row level security;
revoke all on public.crm_quotations,public.crm_quotation_items from anon,authenticated;
grant select on public.crm_quotations,public.crm_quotation_items to service_role;
grant usage,select on sequence public.crm_estimate_number_seq to service_role;
revoke all on function public.crm_save_quotation(uuid,uuid,integer,text,jsonb,boolean) from public,anon,authenticated;
revoke all on function public.crm_delete_quotation(uuid,uuid,integer) from public,anon,authenticated;
grant execute on function public.crm_save_quotation(uuid,uuid,integer,text,jsonb,boolean) to service_role;
grant execute on function public.crm_delete_quotation(uuid,uuid,integer) to service_role;
commit;
