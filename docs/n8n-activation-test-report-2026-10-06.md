> Update: semantic indexing is complete and AI classification is now published and verified. See [AI classification report](ai-email-classification-2026-10-06.md) for current results. Earlier activation results below are retained.

# New n8n account activation and verification, 6 October 2026

All six operational workflows are published in the TecShor n8n account. The diagnostic workflow stays manual and unpublished. Both local environment webhook URLs point to this account. Header authentication is assigned and the Calendar Agent proxy forwards the secret from the server.

## Recorded checks

- All 81 existing local tests passed. A new Calendar Agent authentication test also passed (82 tests total across these runs). Production build passed.
- Email webhook: incorrect secret returned 403; correct secret with an invalid request returned 400 without database writes.
- Outlook calendar: authenticated read-only request for 12 October 2026 returned HTTP 200 and zero events. No invitations or event changes were made.
- n8n database diagnostic, execution 3: successful.
- Invalid send request, execution 6: rejected successfully before Outlook.
- Missing approved draft, simulated execution 8: rejected successfully before Outlook.
- Empty supplier queue, simulated execution 9: successful, no send.
- Native Supabase indexer, execution 7: successful after increasing embedding timeout. The initial execution 4 failed with a provider timeout. Final configured timeout is 120 seconds.
- Actual PostgreSQL vector retrieval returned scoped results. Missing identity and nonexistent sender both returned zero results. A nonexistent draft could not be claimed for sending.
- At the latest status check: 7,977 eligible sources, 4,676 fully indexed sources, 14,750 ready chunks, zero failed chunks. Historical backfill remains running locally; these numbers will change.

## Changes made during verification

The dispatch claim now requires a recorded approval for the current revision, unexpired review, unchanged conversation version and body/subject/recipients matching the saved revision. Supplier dispatch now requires explicit approval rather than allowing an automatic route to authorize sending. Owner Calendar Agent requests require the shared header secret. Calendar creation maps an explicitly supplied attendee into Outlook attendees and asks for missing duration. Embedding requests have a 120-second timeout, and the local worker retries network failures.

Memory maintenance runs daily at 02:00 and approved supplier dispatch daily at 09:00, America/Toronto. This saves scheduled executions but supplier dispatch can wait until the next daily run. Outlook incoming-email trigger remains enabled. Initial historical indexing runs locally and consumes no n8n executions.

## Remaining acceptance work

This is not complete contract acceptance. No real external email or calendar invitation was sent during these tests. A controlled test recipient and explicit version approval are still needed for the full delivery/attachment audit test. Incoming email to availability draft, conflict escalation, confirmed booking, exact commercial configuration snapshot approval, detailed RFQ attachment sets and the rest of the contract checklist still require end-to-end acceptance evidence. Calendar availability currently works through the owner Calendar Agent; automatic meeting-email drafting has not been verified. Historical indexing is not yet complete. Classification currently uses configured database rules and verified identities, not a verified AI classifier.

No GitHub push was performed. Secrets are not included in this report.
