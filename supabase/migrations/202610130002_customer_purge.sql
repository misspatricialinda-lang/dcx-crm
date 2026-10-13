-- Permanent customer deletion. A customer must be in Deleted customers first.
-- Quotations and proposals are business records: by default they are kept, detached from the
-- removed customer with a snapshot of who it was, and listed as archived quotations until the
-- owner deletes them. Email conversations stay in the mailbox and lose only their customer link.
begin;

alter table public.crm_quotations alter column customer_id drop not null;
alter table public.crm_proposals alter column customer_id drop not null;
alter table public.crm_quotations add column if not exists archived_customer jsonb;
alter table public.crm_proposals add column if not exists archived_customer jsonb;
create index if not exists crm_quotations_archived_idx on public.crm_quotations (created_at desc) where customer_id is null;

create or replace function public.crm_customer_purge(p_id uuid, p_updated_at timestamptz, p_keep_records boolean default true)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  c public.crm_customers;
  snapshot jsonb;
  quotations int;
  proposals int;
begin
  select * into c from public.crm_customers where id = p_id for update;
  if not found then return jsonb_build_object('ok', false, 'reason', 'Customer not found. Reload the list.'); end if;
  if c.deleted_at is null then return jsonb_build_object('ok', false, 'reason', 'Move the customer to Deleted customers before deleting it permanently.'); end if;
  if date_trunc('milliseconds', c.updated_at) <> date_trunc('milliseconds', p_updated_at) then return jsonb_build_object('ok', false, 'reason', 'Customer changed. Reload it.'); end if;
  snapshot := jsonb_build_object('id', c.id, 'name', c.name, 'contact', c.contact, 'email', c.email, 'phone', c.phone,
    'billing_address', c.billing_address, 'price_book', c.price_book, 'removed_at', now());

  select count(*) into quotations from public.crm_quotations where customer_id = c.id;
  select count(*) into proposals from public.crm_proposals where customer_id = c.id;
  if p_keep_records then
    update public.crm_quotations set customer_id = null, archived_customer = snapshot, updated_at = now() where customer_id = c.id;
    update public.crm_proposals set customer_id = null, archived_customer = snapshot, updated_at = now() where customer_id = c.id;
  else
    delete from public.crm_quotation_items where quotation_id in (select id from public.crm_quotations where customer_id = c.id);
    delete from public.crm_quotations where customer_id = c.id;
    delete from public.crm_proposals where customer_id = c.id;
  end if;

  update public.email_threads set customer_id = null where customer_id = c.id;
  delete from public.crm_purchases where customer_id = c.id;
  delete from public.crm_services where customer_id = c.id;
  delete from public.crm_equipment where customer_id = c.id;
  delete from public.crm_sites where customer_id = c.id;
  delete from public.crm_contacts where customer_id = c.id;
  delete from public.crm_customers where id = c.id;
  return jsonb_build_object('ok', true, 'quotations', quotations, 'proposals', proposals, 'kept', p_keep_records);
end $$;

-- Archived quotations (customer removed) are deleted directly; they have no Trash step.
create or replace function public.crm_archived_quotation_purge(p_id uuid, p_version integer)
returns boolean language plpgsql security definer set search_path = '' as $$
begin
  if not exists (select 1 from public.crm_quotations where id = p_id and customer_id is null and version = p_version) then
    raise exception 'Quotation changed or is not archived';
  end if;
  delete from public.crm_quotation_items where quotation_id = p_id;
  delete from public.crm_quotations where id = p_id;
  return true;
end $$;

revoke all on function public.crm_customer_purge(uuid, timestamptz, boolean) from public, anon, authenticated;
revoke all on function public.crm_archived_quotation_purge(uuid, integer) from public, anon, authenticated;
grant execute on function public.crm_customer_purge(uuid, timestamptz, boolean) to service_role;
grant execute on function public.crm_archived_quotation_purge(uuid, integer) to service_role;
notify pgrst, 'reload schema';
commit;
