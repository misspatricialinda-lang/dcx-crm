begin;
alter table public.crm_customers add column deleted_at timestamptz;
alter table public.crm_customers add column relationship_type text not null default 'customer'
 check(relationship_type in ('customer','qualified_company','lead','supplier','other'));
alter table public.calculator_rate_versions add column retired_at timestamptz;
alter table public.email_drafts add column deleted_at timestamptz;
drop index public.email_one_open_draft;
create unique index email_one_open_draft on public.email_drafts(thread_id) where status <> 'sent' and deleted_at is null;

create function public.crm_customer_trash(p_id uuid,p_updated_at timestamptz,p_restore boolean default false)
returns boolean language plpgsql security definer set search_path='' as $$
begin
 update public.crm_customers set deleted_at=case when p_restore then null else now() end
 where id=p_id and updated_at=p_updated_at and (deleted_at is not null)=p_restore;
 return found;
end $$;

-- Retain every price-book version and existing quotation snapshots.
create function public.crm_retire_price_book(p_id text,p_version integer)
returns boolean language plpgsql security definer set search_path='' as $$
begin
 perform pg_advisory_xact_lock(hashtext('price-book:'||p_id));
 if exists(select 1 from public.crm_customers where price_book=p_id and deleted_at is null) then
   raise exception 'Pricing agreement is assigned to a customer. Change their agreement first';
 end if;
 if not exists(select 1 from public.calculator_rate_versions where book_id=p_id and version=p_version and retired_at is null)
   or exists(select 1 from public.calculator_rate_versions where book_id=p_id and version>p_version) then
   raise exception 'Pricing agreement changed. Reload it';
 end if;
 update public.calculator_rate_versions set retired_at=now() where book_id=p_id;
 return found;
end $$;

alter function public.crm_save_quotation(uuid,uuid,integer,text,jsonb,boolean) rename to crm_save_quotation_base;
create function public.crm_save_quotation(p_customer_id uuid,p_quotation_id uuid,p_version integer,p_address_1 text,p_items jsonb,p_issue boolean default false,p_tax_rate numeric default 13)
returns uuid language plpgsql security definer set search_path='' as $$
declare v_id uuid;
begin
 if p_tax_rate is null or p_tax_rate<0 or p_tax_rate>100 or p_tax_rate<>round(p_tax_rate,2) then raise exception 'Tax rate must be between 0 and 100 with up to two decimals'; end if;
 if not exists(select 1 from public.crm_customers where id=p_customer_id and deleted_at is null) then raise exception 'Customer not found'; end if;
 v_id:=public.crm_save_quotation_base(p_customer_id,p_quotation_id,p_version,p_address_1,p_items,p_issue);
 update public.crm_quotations set tax_rate=p_tax_rate,tax_total=round(subtotal*p_tax_rate/100,2),grand_total=subtotal+round(subtotal*p_tax_rate/100,2) where id=v_id;
 return v_id;
end $$;
create function public.crm_quotation_trash(p_customer_id uuid,p_id uuid,p_version integer,p_action text)
returns boolean language plpgsql security definer set search_path='' as $$
declare q public.crm_quotations;
begin
 select * into q from public.crm_quotations where id=p_id and customer_id=p_customer_id for update;
 if not found or q.version<>p_version or q.deleted_at is null then raise exception 'Quotation changed or is not in trash'; end if;
 if p_action='restore' then
  update public.crm_quotations set deleted_at=null,version=version+1,updated_at=now() where id=q.id;
 elsif p_action='purge' then
  delete from public.crm_quotation_items where quotation_id=q.id;
  delete from public.crm_quotations where id=q.id;
 else raise exception 'Unknown trash action'; end if;
 return true;
end $$;

create function public.crm_draft_trash(p_id uuid,p_updated_at timestamptz,p_restore boolean default false,p_actor text default 'owner')
returns jsonb language plpgsql security definer set search_path='' as $$
declare d public.email_drafts;
begin
 select * into d from public.email_drafts where id=p_id for update;
 if not found or d.updated_at<>p_updated_at or (d.deleted_at is not null)<>p_restore then raise exception 'Draft changed. Reload it'; end if;
 if d.status in ('sending','submitted','uncertain','sent') then raise exception 'Dispatch pending or sent. Draft cannot be deleted or restored'; end if;
 if exists(select 1 from public.email_automation_jobs where thread_id=d.thread_id and status='running') then raise exception 'AI is updating this draft. Wait and retry'; end if;
 if p_restore and exists(select 1 from public.email_drafts where thread_id=d.thread_id and deleted_at is null and status<>'sent') then raise exception 'Another active draft exists. Delete it before restoring this one'; end if;
 update public.email_drafts set deleted_at=case when p_restore then null else now() end,status='editing',updated_at=now() where id=d.id;
 if not p_restore then update public.email_automation_jobs set status='failed',error='Draft deleted by owner',updated_at=now() where thread_id=d.thread_id and status='queued';end if;
 delete from public.email_approvals where draft_id=d.id;
 update public.email_threads set status=case when p_restore then 'draft_ready' else 'needs_attention' end,version=version+1,updated_at=now() where id=d.thread_id;
 insert into public.email_activity(thread_id,action,actor,details) values(d.thread_id,case when p_restore then 'draft_restored' else 'draft_deleted' end,p_actor,jsonb_build_object('draft_id',d.id));
 return jsonb_build_object('id',d.id,'thread_id',d.thread_id,'restored',p_restore);
end $$;

-- Existing command/worker transactions must ignore trashed drafts, including ID lookups.
do $$ declare definition text; signature text; begin
 foreach signature in array array['public.email_command(uuid,text,jsonb,text)','public.email_worker(uuid,text,jsonb)'] loop
  definition:=pg_get_functiondef(signature::regprocedure);
  definition:=replace(definition,'where thread_id=t.id and status<>''sent''','where thread_id=t.id and deleted_at is null and status<>''sent''');
  definition:=replace(definition,'where id=(p_input->>''draft_id'')::uuid and thread_id=t.id','where id=(p_input->>''draft_id'')::uuid and thread_id=t.id and deleted_at is null');
  execute definition;
 end loop;
end $$;
do $$ declare signature text; begin
 foreach signature in array array['crm_customer_trash(uuid,timestamptz,boolean)','crm_retire_price_book(text,integer)','crm_save_quotation(uuid,uuid,integer,text,jsonb,boolean,numeric)','crm_quotation_trash(uuid,uuid,integer,text)','crm_draft_trash(uuid,timestamptz,boolean,text)'] loop
  execute 'revoke all on function public.'||signature||' from public,anon,authenticated';
  execute 'grant execute on function public.'||signature||' to service_role';
 end loop;
end $$;
commit;
