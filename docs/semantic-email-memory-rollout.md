> Current status: the new account workflows are published and credentials assigned. See [activation test report](n8n-activation-test-report-2026-10-06.md) for verified checks and remaining work. Historical indexing is still in progress. Earlier rollout notes below describe preparation steps.

# Semantic email memory rollout — 5 October 2026

## Current state

The local CRM database connection is working; the user confirmed this. The semantic search implementation is prepared and passes local checks, but has not been installed in the live Supabase project or enabled in the published intake workflows.

The attempted database migration through the existing n8n verification workflow did not execute: n8n returned “Execution limit reached. Consider upgrading your plan”. The verification workflow was restored to its original read-only query. The Supabase dashboard opened at its sign-in screen, so installation requires the project owner's authenticated session.

## Prepared components

- `supabase/migrations/202610050001_semantic_email_memory.sql`: private service-only vectors, resumable source-change queue, mailbox/address-scoped hybrid search, provenance, stale-evidence exclusion, and verified customer records.
- `scripts/index-email-memory.mjs`: bounded initial backfill; run with `npm run memory:index` after applying the migration. The script only prints processing counters, not email content or credentials.
- `server/email-memory.js`: app-side hybrid retrieval with an explicit keyword/recent fallback while the migration is absent.
- `automation/n8n/email-memory-indexer.sdk.js`: validated native n8n indexing workflow. Saved as unpublished workflow `8yPSNmAU0FSzSNPX`.
- `automation/n8n/semantic-memory-workflow-patches.json`: prepared intake and regeneration changes. These patches have not been applied or published.

The design combines semantic similarity with keyword matches and recent conversation context. It reads stored purchases, equipment and service records separately from quotations. A quotation does not prove a purchase. Missing records remain missing; indexing emails does not automatically reconcile every historical purchase into the CRM.

## Activation and verification

1. Sign in to the owning Supabase project and apply the migration. Confirm the `extensions.vector(1536)` type, restricted functions and actual vector distance operation in the live database.
2. Run a small backfill first, verify source/version provenance and address/mailbox isolation, then complete the archive backfill. Embedding processing must use approved service accounts and the applicable processing authorization.
3. Restore n8n execution capacity. Test the unpublished indexer on synthetic or minimized approved records; publish only after successful indexing and lease completion.
4. Apply the saved intake/regeneration patches, test actual native vector output metadata and no-match behavior, and publish the verified versions. Until then the published intake retains its existing keyword/recent retrieval.
5. Test an old paraphrased request, an exact reference, changed/deleted source, same sender across mailboxes, ambiguous customer identity, and a new incoming message becoming searchable. Inspect unsent drafts and retrieved source IDs. Do not use live external sending as a search test.

## Evidence and limits

All 80 application tests pass and the production build passes. The new database tests use isolated PGlite with a test cosine operator because pgvector is unavailable there; they verify scope, queues, versioning and customer facts but do not replace a live pgvector/n8n integration test. Native n8n indexer validation and retrieval-node configuration validation pass. No live semantic deployment or external email send is claimed.

Semantic recall improves access to older relevant evidence; it does not guarantee complete history. Historical commercial terms remain evidence only and cannot replace current approved CRM pricing. Other contract gaps are recorded in `contract-implementation-checklist-2026-10-05.md`.
