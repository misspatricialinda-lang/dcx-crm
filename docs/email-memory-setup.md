# Email identity and historical memory

This implementation preserves original email text and sender/recipient identities from the PST. It does not train a model or replace the existing support-guidance corpus. When Conversation AI analyzes a new email, it can retrieve historical evidence for that sender's exact address, including exchanges outside the current Outlook conversation.

## Local files

Private exports live in ignored `.tools/email-archive/`:

- `messages.jsonl`: full plain-text bodies, names, SMTP addresses, timestamps, Outlook conversation IDs, Internet Message IDs and attachment metadata.
- `inventory.json`, `errors.json`, `summary.json`: coverage and extraction errors. A complete export requires zero errors and matching inventory/export counts.
- `direct-source.json`: stable offline-parser archive identity across resumed extraction (`source.json` belongs to the alternative Outlook exporter).
- `history.sqlite`: local address and text search, generated separately.
- `contact_candidates.jsonl`: observed email addresses/names with first/last exchange and counts. Includes owners, suppliers and shared addresses; it is not an automatically confirmed customer list.

Unlike the earlier knowledge sample, this exporter retains names and addresses, does not strip quoted history, does not cap the number of messages, and traverses every folder for mail items, including deleted, junk and drafts. Drafts remain preserved but are excluded from historical retrieval. Other Outlook items such as appointments are outside scope. Exchange identities are resolved to SMTP addresses when possible; unresolved addresses are counted.

```powershell
node scripts/extract-email-archive.mjs
python automation/normalize_email_archive.py
node scripts/enrich-email-archive.mjs
node scripts/resolve-archive-addresses.mjs
python automation/email_archive_report.py
python automation/email_archive_index.py build
python automation/email_archive_index.py search --email person@example.com --query battery
```

Extraction is resumable. The preferred offline reader reads bodies and attachment metadata without opening Outlook, extracting attachment contents or calling an AI provider. It uses the pinned `pst-extractor` development dependency. A separate Outlook-based alternative exists at `automation/extract_email_archive.py`; Outlook can update PST metadata when mounting it. Do not mix the two methods in one output directory. Use a separate output directory for a different or replaced backup.

## Supabase activation

Apply `supabase/migrations/202610040001_email_memory.sql` after existing CRM and email-tracking migrations. It adds `crm_email_archive` and the service-only `crm_email_memory` function. It leaves active tracking queues and send workflows untouched. This migration cannot be applied through the existing Supabase REST service key alone; it needs SQL Editor or a database connection.

```powershell
node scripts/import-email-archive.mjs --dry-run
node scripts/import-email-archive.mjs
```

The importer uses the existing server-only Supabase environment settings. It validates and imports batches of at most 25 messages or approximately two million text characters, with bounded retries for transient failures. Repeat imports skip existing source keys, preserving later attachment links. They do not create customers, change live thread statuses, issue notifications, queue drafts or send mail. The result reports newly processed records separately from `existing_messages`. Existing source keys are skipped before batching.

## Retrieval and identity

The app's Conversation AI calls `crm_email_memory` before building the model context. It searches both the archive and the existing `email_messages`/`email_attachments` tracking records. Existing `crm_contacts` records for that exact address are included. No company is inferred from a name or domain, and no CRM contact is silently created.

The latest non-draft inbound sender's address is the identity anchor. The connected owner's address and other participants are not treated as aliases. Shared addresses can belong to several people. Alternate addresses require a future explicit identity/alias association; names alone never merge them.

The function returns a bounded mix of relevant and recent messages with dates, source keys and attachment references. Search uses PostgreSQL full-text ranking; it is not semantic vector search and does not guarantee retrieval of every relevant older message. Original text remains in the archive; retrieved bodies are capped and marked when truncated. The app reports included history counts and dates. Historical examples do not establish current pricing or completed work.

If the migration is absent, the app explicitly reports that historical memory is not connected. If the database lookup fails for other reasons, analysis fails rather than silently claiming that history was checked.

This integration covers the in-app **Analyze conversation** action. Existing deployed n8n draft workflows need a separate `crm_email_memory` lookup and context mapping before they can use this history. Continuous mailbox intake is still handled by the existing tracking integration; the PST itself is a historical snapshot.

## Attachments later

Each archive message retains attachment name, original attachment index, size and content ID, with `status: reference_only` and `storage_path: null`. The preferred parser uses PST descriptor IDs, zero-based attachment indices and original attachment numbers; the Outlook alternative uses EntryIDs and one-based indices. `source_id_type` distinguishes these schemes. These are references to the local PST, not public/downloadable URLs. The partial Outlook attempt is preserved separately as `outlook-partial.jsonl` and is not imported along with the canonical offline export.

When attachment ingestion is implemented, save file contents to the existing private `crm-private` storage bucket, set the corresponding attachment's `storage_path`, and change its status only after successful upload/extraction. Generate short-lived authenticated download links when needed; do not persist expiring signed URLs. Until then, the AI receives filenames only and must not claim to have read those files. No file upload UI is added in this phase.

## Verification

`tests/email-memory.test.mjs` exercises the SQL against real embedded PostgreSQL: older relevant evidence, separation of same-name contacts, attachment references, and denial of access to ordinary authenticated database users. `tests/conversation-ai.test.mjs` checks that retrieved history reaches the model context. Local tests do not establish deployment or live import completion.

## Live status — 4 October 2026

The memory migration was applied using the existing n8n Postgres credential, and **8,145** records are now in live `crm_email_archive`. A live exact-address lookup for `naresh@synergyit.com` returned dated UPS-maintenance correspondence. Workflows 1 and 2 now retrieve this memory before drafting. The new dashboard/server release remains pending because Vercel CLI authentication is unavailable. See `docs/workspace-email-rollout.md` for evidence and remaining release steps.
