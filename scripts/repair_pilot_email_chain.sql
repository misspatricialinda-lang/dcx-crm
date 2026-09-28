-- One-time repair for the pilot conversation only. Review the IDs before running.
-- This preserves the false threads as audit history and hides their unsafe open draft.
BEGIN;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM email_threads t JOIN email_mailboxes b ON b.id=t.mailbox_id
    WHERE t.id='9283eb59-767e-4c04-b645-f58d1283fd8e'
      AND b.address='aliisthebestofthebest@outlook.com'
      AND t.provider_thread_key='AQQkADAwATNiZmYAZC01Y2JkLWQ3NwAyLTAwAi0wMAoAEABZ6IIfKx5EQre6W_UB59Qa'
  ) THEN RAISE EXCEPTION 'Pilot canonical thread does not match the inspected mailbox'; END IF;
  IF NOT EXISTS (
    SELECT 1 FROM email_messages
    WHERE id='eec6fb47-0026-4b2f-9232-fe0ec3ee1364'
      AND thread_id='9283eb59-767e-4c04-b645-f58d1283fd8e'
      AND direction='outgoing' AND provider_key LIKE 'crm-send:%'
      AND to_addresses='["aliameen.co@gmail.com"]'::jsonb
  ) THEN RAISE EXCEPTION 'Pilot sent record changed; review before repair'; END IF;
END $$;

-- Replace the provisional CRM key with Outlook's real Sent Items key.
UPDATE email_messages target SET
  provider_key=source.provider_key,
  provider_ref=source.provider_ref,
  internet_message_id=source.internet_message_id,
  occurred_at=source.occurred_at
FROM email_messages source
WHERE target.id='eec6fb47-0026-4b2f-9232-fe0ec3ee1364'
  AND source.id='e6fd0a63-b37f-432b-8363-d1737e84e69c'
  AND source.sender='outlook_F90CEC84CCC04643@outlook.com'
  AND source.to_addresses='["aliameen.co@gmail.com"]'::jsonb
  AND NOT EXISTS (
    SELECT 1 FROM email_messages existing
    WHERE existing.mailbox_id=target.mailbox_id AND existing.provider_key=source.provider_key
  );

-- Keep the actual self-addressed email visible in the canonical Outlook timeline.
INSERT INTO email_messages (
  thread_id,mailbox_id,provider_key,provider_ref,internet_message_id,in_reply_to,
  direction,sender,to_addresses,cc_addresses,subject,body_text,body_html,
  body_loaded,has_attachments,occurred_at
)
SELECT canonical.id,canonical.mailbox_id,source.provider_key,source.provider_ref,
  source.internet_message_id,source.in_reply_to,'outgoing',source.sender,
  source.to_addresses,source.cc_addresses,source.subject,source.body_text,
  source.body_html,source.body_loaded,source.has_attachments,source.occurred_at
FROM email_messages source
CROSS JOIN email_threads canonical
WHERE source.id='b57c2a5c-0ca5-4f85-ade2-b776f2321555'
  AND canonical.id='9283eb59-767e-4c04-b645-f58d1283fd8e'
ON CONFLICT(mailbox_id,provider_key) DO NOTHING;

-- Retain a reversible copy of the false AI draft, then remove it from the AI queue.
INSERT INTO email_activity(thread_id,action,actor,details)
SELECT d.thread_id,'quarantine_false_self_draft','maintenance',to_jsonb(d)
FROM email_drafts d
WHERE d.id='0990ed64-24e1-454d-aafe-9028585f093d'
  AND d.status='editing' AND d.to_addresses='["outlook_F90CEC84CCC04643@outlook.com"]'::jsonb
  AND d.original_ai_body IS NOT NULL;

UPDATE email_drafts SET original_ai_body=NULL,updated_at=now()
WHERE id='0990ed64-24e1-454d-aafe-9028585f093d'
  AND status='editing' AND to_addresses='["outlook_F90CEC84CCC04643@outlook.com"]'::jsonb;

COMMIT;
