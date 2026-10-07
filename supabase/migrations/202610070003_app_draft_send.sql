-- AI drafts are sent by the app through Microsoft Graph (n8n Workflow 3 is retired).
-- Claim and finish run as single statements so a draft is sent at most once and the
-- outcome is always recorded. Pressing Send on the shown revision is the approval.

create or replace function public.crm_claim_draft_send(p_draft uuid, p_updated_at timestamptz, p_actor text, p_mailbox text)
returns jsonb language plpgsql set search_path = '' as $$
declare
  d public.email_drafts;
  m public.email_messages;
  t public.email_threads;
  mailbox text;
begin
  select * into d from public.email_drafts where id = p_draft for update;
  if not found or d.deleted_at is not null then return jsonb_build_object('ok', false, 'reason', 'This draft was discarded.'); end if;
  if d.status not in ('editing', 'approved') then return jsonb_build_object('ok', false, 'reason', 'This draft is already being sent or was sent. Check Outlook Sent Items.'); end if;
  if date_trunc('milliseconds', d.updated_at) <> date_trunc('milliseconds', p_updated_at) then return jsonb_build_object('ok', false, 'reason', 'This draft changed since you opened it. Review the latest version before sending.'); end if;
  if nullif(trim(d.current_body), '') is null then return jsonb_build_object('ok', false, 'reason', 'The reply is empty.'); end if;
  select * into t from public.email_threads where id = d.thread_id;
  select * into m from public.email_messages where id = d.reply_to_message_id and thread_id = d.thread_id;
  select lower(address) into mailbox from public.email_mailboxes where id = t.mailbox_id;
  if m.id is null or m.direction <> 'incoming' or nullif(m.provider_ref, '') is null or m.mailbox_id <> t.mailbox_id then
    return jsonb_build_object('ok', false, 'reason', 'The email this replies to is no longer in Outlook.');
  end if;
  if mailbox is distinct from lower(p_mailbox) then
    return jsonb_build_object('ok', false, 'reason', 'This conversation belongs to ' || coalesce(mailbox, 'another mailbox') || ', not the connected mailbox.');
  end if;
  if jsonb_array_length(d.to_addresses) <> 1 or lower(d.to_addresses->>0) <> lower(m.sender) or lower(m.sender) = mailbox then
    return jsonb_build_object('ok', false, 'reason', 'The reply must go only to the person who sent the email.');
  end if;
  if exists (select 1 from public.email_messages newer where newer.thread_id = d.thread_id and newer.direction = 'incoming' and newer.occurred_at > m.occurred_at) then
    return jsonb_build_object('ok', false, 'reason', 'A newer email arrived in this conversation. Use Write again or check the draft still fits.');
  end if;
  update public.email_drafts set status = 'sending', updated_at = now() where id = d.id;
  insert into public.email_approvals (draft_id, revision, actor, provider_review, approved_at)
    values (d.id, d.revision, p_actor, jsonb_build_object('source', 'app-send', 'mailbox', mailbox), now())
    on conflict (draft_id, revision) do update set actor = excluded.actor, provider_review = excluded.provider_review, approved_at = now();
  return jsonb_build_object('ok', true, 'draft_id', d.id, 'thread_id', d.thread_id, 'revision', d.revision, 'body', d.current_body,
    'subject', d.subject, 'to', d.to_addresses->>0, 'reply_ref', m.provider_ref, 'conversation', t.provider_thread_key);
end $$;

create or replace function public.crm_finish_draft_send(p_draft uuid, p_outcome text, p_provider_ref text, p_body_html text, p_attachments jsonb, p_actor text, p_error text)
returns jsonb language plpgsql set search_path = '' as $$
declare
  d public.email_drafts;
  t public.email_threads;
  message_id uuid;
  file jsonb;
begin
  select * into d from public.email_drafts where id = p_draft and status = 'sending' for update;
  if not found then return jsonb_build_object('ok', false); end if;
  select * into t from public.email_threads where id = d.thread_id;
  if p_outcome = 'released' then
    update public.email_drafts set status = 'editing', updated_at = now() where id = d.id;
    delete from public.email_approvals where draft_id = d.id and revision = d.revision and provider_review->>'source' = 'app-send';
  elsif p_outcome = 'uncertain' then
    update public.email_drafts set status = 'uncertain', provider_draft_id = p_provider_ref, updated_at = now() where id = d.id;
  elsif p_outcome = 'sent' then
    insert into public.email_messages (thread_id, mailbox_id, provider_key, provider_ref, direction, sender, to_addresses, subject, body_text, body_html, body_loaded, has_attachments, occurred_at)
      select d.thread_id, t.mailbox_id, 'crm-send:' || d.id || ':' || d.revision, p_provider_ref, 'outgoing', mb.address, d.to_addresses, d.subject, d.current_body, p_body_html, true,
             jsonb_array_length(coalesce(p_attachments, '[]'::jsonb)) > 0, now()
      from public.email_mailboxes mb where mb.id = t.mailbox_id
      on conflict (mailbox_id, provider_key) do update set body_text = excluded.body_text
      returning id into message_id;
    for file in select * from jsonb_array_elements(coalesce(p_attachments, '[]'::jsonb)) loop
      insert into public.email_attachments (message_id, provider_id, name, content_type, size_bytes)
        values (message_id, 'crm-upload:' || d.id || ':' || (file->>'index'), file->>'name', file->>'content_type', (file->>'size_bytes')::bigint);
    end loop;
    update public.email_drafts set status = 'sent', provider_draft_id = p_provider_ref, updated_at = now() where id = d.id;
    update public.email_threads set status = 'waiting_customer', last_message_at = now(), updated_at = now() where id = d.thread_id;
  else
    raise exception 'Unknown send outcome %', p_outcome;
  end if;
  insert into public.email_activity (thread_id, action, actor, details)
    values (d.thread_id, 'reply_' || p_outcome, p_actor, jsonb_build_object('draft_id', d.id, 'revision', d.revision, 'via', 'app') || case when p_error is null then '{}'::jsonb else jsonb_build_object('error', left(p_error, 500)) end);
  return jsonb_build_object('ok', true, 'message_id', message_id);
end $$;

revoke all on function public.crm_claim_draft_send(uuid, timestamptz, text, text) from public, anon, authenticated;
revoke all on function public.crm_finish_draft_send(uuid, text, text, text, jsonb, text, text) from public, anon, authenticated;
grant execute on function public.crm_claim_draft_send(uuid, timestamptz, text, text) to service_role;
grant execute on function public.crm_finish_draft_send(uuid, text, text, text, jsonb, text, text) to service_role;
notify pgrst, 'reload schema';
