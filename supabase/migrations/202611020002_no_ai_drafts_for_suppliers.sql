begin;
-- Supplier conversations are handled in Supplier quotes, never answered by the AI drafter.
-- A conversation counts as a supplier conversation when it belongs to a supplier price request, or its
-- latest incoming sender is a verified supplier (Customers with type Supplier, or a saved supplier role).
-- This is by role, not address, so changing a supplier's email on the Customers page keeps working.
create function public.crm_supplier_conversation(p_thread uuid) returns boolean
language sql stable security definer set search_path='' as $$
 select exists(select 1 from public.supplier_rfq_recipients where supplier_thread_id=p_thread)
 or coalesce((select public.crm_verified_correspondent_role(m.sender)='supplier' from public.email_messages m
   where m.thread_id=p_thread and m.direction='incoming' order by m.occurred_at desc,m.id desc limit 1),false);
$$;

-- Every AI writer (n8n Workflow 1, the inbox sync queue, follow-ups) inserts with original_ai_body set.
-- Skipping the row here covers all of them; manual drafts (no original_ai_body) are unaffected.
create function public.crm_skip_supplier_ai_draft() returns trigger language plpgsql security definer set search_path='' as $$
begin
 if new.original_ai_body is not null and public.crm_supplier_conversation(new.thread_id) then return null;end if;
 return new;
end $$;
create trigger crm_skip_supplier_ai_draft before insert on public.email_drafts for each row execute function public.crm_skip_supplier_ai_draft();

-- AI drafts already waiting on supplier conversations go to Discarded AI drafts (restorable).
update public.email_drafts set deleted_at=now(),updated_at=now()
where deleted_at is null and status not in ('sent','sending','submitted','uncertain') and original_ai_body is not null
and public.crm_supplier_conversation(thread_id);

revoke all on function public.crm_supplier_conversation(uuid) from public, anon, authenticated;
grant execute on function public.crm_supplier_conversation(uuid) to service_role;
revoke all on function public.crm_skip_supplier_ai_draft() from public, anon, authenticated;
commit;
