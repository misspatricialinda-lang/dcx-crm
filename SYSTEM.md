# DCX Operations Workspace: system map

This is the canonical orientation document for people and AI agents working on this repository. Read it before changing behavior. It describes the code as inspected on 29 September 2026, with later changes recorded in dated sections at the end (latest: **7 October 2026**); the implementation and tests remain the source of truth when they change. The older `README.md` and some files under `docs/` include historical plans and UI descriptions.

## What this software is

DCX Operations Workspace is a private, single-owner CRM for DCX Technical Inc.'s UPS maintenance, battery, and critical-power business. It combines customer records, Microsoft mailbox conversations, follow-ups, customer quotations and proposals, an internal cost worksheet, reporting, a Calendar Agent, notifications, and an in-app feature-request queue. The frontend is a React/TypeScript Vite app. Server handlers run as Vercel functions in production and as Vite middleware during local development. Supabase stores shared business data; Microsoft Graph is the mailbox system of record; n8n can run scheduled integrations when configured.

It is **not yet a multi-tenant product**. The login is a custom signed owner session, not Supabase Auth. The browser does not receive the Supabase service key. Do not infer production readiness from the existence of a UI, database table, workflow JSON, or local test alone.

## Current user-facing areas

The actual navigation is defined in `src/App.tsx`.

| Area | Purpose | Main implementation |
| --- | --- | --- |
| Overview | Email activity (classification chips, clickable summary cards, date presets and custom range, message preview), follow-up queues, reports and quick links | `src/components/operations/WorkspacePages.tsx`, `EmailBrainPanel.tsx`, `TrackingOverview.tsx`, `EmailReport.tsx` |
| Inbox | One Outlook-style mailbox: real folders plus virtual **AI drafts** and **Discarded AI drafts** folders, an **AI draft** tag on conversations, and the AI reply edited inline under the email (Send, Discard, Write again, quick changes, attachments, Next) | `MicrosoftInbox.tsx`, `InlineAiReply.tsx`, `TrackedInbox.tsx` (discarded drafts only), `MailConnection.tsx`, `server/mail-api.js`, `server/email-assistant-api.js`, `server/email-tracking-api.js` |
| Customers | Companies, contacts, sites, equipment, purchases, services, proposals | `CustomerHub.tsx`, `CustomerProposals.tsx`, `server/crm-api.js` |
| Quotations | Customer-linked quotations, live preview, PDF, draft/issued state | `QuotationLanding.tsx`, `CustomerQuotations.tsx`, `src/lib/customer-quotation.ts` |
| Cost calculator | Internal pricing worksheet, rate books, Excel export | `CostWorkspace.tsx`, `WorkbookCalculator.tsx`, `src/lib/costing.ts`, `cost-workbook.ts`, `cost-export.ts` |
| Calendar Agent | Chat request sent to an n8n webhook; `@` email suggestions | `CalendarAgent.tsx`, `server/calendar-agent-api.js` |
| Notifications | In-app new-mail feed and optional phone push enrollment | `NotificationsPage.tsx`, `server/notifications-api.js`, `public/sw.js` |
| Feature requests | Submit and track issues or ideas, with status and owner notes | `FeatureRequestsPage.tsx`, `server/feature-requests-api.js` |

The Rates editor exists but is hidden by `SHOW_RATES = false` in `src/lib/features.ts`. Older references to a Tender navigation tab are stale; there is no current Tender tab. Customer quotations and proposals are separate from the **internal** cost worksheet.

## Repository map

| Path | Role |
| --- | --- |
| `src/App.tsx` | App shell, navigation, browser-local worksheet state and shared customer/rate loading |
| `src/components/operations/` | Feature screens and interactive workflows |
| `src/lib/` | Browser API clients, costing, workbook export, quotation logic, local workspace persistence |
| `src/types/` | Frontend domain types |
| `api/` | Thin production HTTP entry points; each delegates to a `server/*-api.js` handler |
| `server/` | Authentication, Supabase access, CRM, mail, tracking, AI, notifications and integration handlers |
| `supabase/migrations/` | Ordered database schema changes; use these for new installations |
| `automation/n8n/` | Workflow JSON exports, contracts, prompts and a scaffold verifier |
| `tests/` and `tests/browser/` | Node tests and Playwright browser scenarios |
| `docs/` | Feature setup notes and historical design/plan documents |
| `deliverables/` | Client-facing guide artifact |
| `.env.example` | Names of required or optional settings, never real credentials |

`vite.config.ts` mounts the same server handlers under `/api/*` for local development. `vercel.json` configures the production build. When adding an endpoint, account for **both** the `api/` entry point and local Vite middleware.

## Data ownership and important boundaries

- **Supabase:** `crm_*` customer and quotation records, `calculator_rate_versions`, `email_*` tracking and drafts, `microsoft_oauth_connections`, feature requests, notifications, push subscriptions and deliveries. The server uses `SUPABASE_URL` and `SUPABASE_SECRET_KEY`. Database migrations are in `supabase/migrations/`; the root `supabase_schema.sql` is an older prototype, not the migration source.
- **Microsoft Graph:** mailbox messages, folders, provider drafts and actual outbound mail. OAuth tokens are encrypted in the database. The tracking tables mirror the information needed for CRM workflow and reporting; they do not replace the provider mailbox.
- **Browser storage:** working cost estimates and saved internal cost quotations in this browser. They are not automatically shared across devices. The downloadable XLSX contains internal costs and margins. Customer-facing quotation PDFs use the separate Supabase-backed quotation flow.
- **n8n:** external automation runtime. A checked-in workflow export is a template, not proof that it was imported, activated, or run successfully.
- **AI:** Conversation AI is requested on demand for a Microsoft email chain. It generates a concise analysis and suggested reply that a person can open and edit. It attempts to include supported attachments subject to limits. Scheduled AI drafting through n8n is a separate workflow. AI output does not authorize or send mail.

Preserve the signed-session boundary and server-only secrets. Do not expose service credentials with a `VITE_` prefix or open Supabase tables to anonymous access to work around a backend issue. Treat sending mail, issuing quotations, and push dispatch as distinct actions requiring their own verification.

## Main flows

1. **Sign-in:** `src/components/Login.tsx` calls `/api/auth`; `server/auth-core.js` validates credentials and issues the signed session cookie. Preview mode uses local example data and does not prove live integration.
2. **Mail:** the owner connects a Microsoft account through `/api/microsoft-oauth`. `/api/mail` serves provider mailbox operations. `/api/tracking` persists conversation status, shared draft revisions, activity, scheduled sync jobs and reporting. Synced incoming messages can produce one `crm_notifications` row each. A provider send must be reviewed and reconciled with Sent Items; a submitted send is not proof of delivery.
3. **Conversation AI:** `/api/conversation-ai` builds context from the selected Microsoft chain and readable supported attachments; the UI offers an editable draft reply. Check attachment limits and failure states in the current handler before changing claims about coverage.
4. **Customer work:** `/api/crm` serves shared customer records, proposals, quotations, and rate versions. A customer quotation is saved and rendered as a customer PDF. Cost calculations and internal XLSX exports follow separate code paths.
5. **Calendar Agent:** `/api/calendar-agent` forwards chat requests to `N8N_CALENDAR_WEBHOOK_URL`; the frontend holds the current chat in session storage. A configured URL is not evidence of a successful live calendar action.
6. **Notifications:** the app polls the feed while open. Phone push requires VAPID credentials, a dispatch token, a database webhook/retry schedule, HTTPS and a phone enrollment. See `docs/notifications-setup.md`.
7. **Feedback:** `/api/feature-requests` stores submitted issues or ideas, status, priority and planning notes. This is the in-product feedback path; it is not an automatic bug-fix or external support ticket.

## n8n workflow inventory

There are two different workflow sets. Keep their status and contracts separate. **For the live state of the n8n account as of 7 October 2026, see the October 7 section at the end of this file**; the table below describes the checked-in exports.

| Set | Files | Role and current boundary |
| --- | --- | --- |
| Tracking | `automation/n8n/workflows/TRACK01-mail-intake.json`, `TRACK02-draft-worker.json`, `TRACK03-daily-report.json` | Inactive templates for scheduled mailbox intake, AI draft work, and optional report data. TRACK03 does not send a notification. Requires `EMAIL_TRACKING_TOKEN`, n8n configuration, model connection and live testing. |
| Calendar Agent | External workflow addressed by `N8N_CALENDAR_WEBHOOK_URL` | App endpoint exists. Workflow deployment and actual calendar execution must be verified in the target n8n account. |
| Active Outlook workflows | Root `workflow 1.json`, `workflow 2 - draft actions.json`, `workflow 3 - send reply.json` | The connected n8n workspace showed these three active on 29 September 2026. Workflow 1 processed a self-test; execution history also shows earlier attachment storage, drafting and send paths. The n8n draft prompt does not receive extracted attachment contents. See `docs/email-system-test-report-2026-09-29.md` for evidence and limits. |
| Phase-one package | `WF00`, `WF01`, `WF02`, `WF03`, `WF05`, `WF05B`, `WF06` JSON files | Integration scaffolds. Their proposed `/api/automation/v1/*` adapters are **not implemented** in this repository. Do not activate them as if production-ready. `automation/n8n/README.md` and `CONTRACTS.md` define their intended behavior. |

Scheduled tracking drafts and on-demand Conversation AI are different features. Neither should silently send an email. For tracking setup, use `docs/email-tracking-setup.md`; for the broader scaffold, use `automation/n8n/README.md`.

## Configuration and deployment

1. Run `npm ci`.
2. Copy the variable names in `.env.example` into a local `.env.local` or the deployed server environment and set only values needed for the integration being used. Keep secrets out of commits, screenshots and client documents.
3. For a new Supabase project, apply `supabase/migrations/` in filename order. Check existing projects before running any migration; do not reapply blindly.
4. Run `npm run dev` for the local app on port 3000. `npm run build` creates the Vercel build output. Deploying code and configuring Vercel environment variables are separate steps.
5. Connect Microsoft using `docs/microsoft-mail-setup.md`. Configure n8n tracking with `docs/email-tracking-setup.md`. Configure phone push with `docs/notifications-setup.md`.

Relevant server settings include `APP_LOGIN_EMAIL`, `APP_LOGIN_PASSWORD`, `APP_SESSION_SECRET`, Supabase settings, Microsoft OAuth settings, `OPENAI_API_KEY`, `EMAIL_TRACKING_TOKEN`, `N8N_CALENDAR_WEBHOOK_URL`, `WEB_PUSH_VAPID_PUBLIC_KEY`, `WEB_PUSH_VAPID_PRIVATE_KEY`, and `PUSH_DISPATCH_TOKEN`. `.env.example` is the complete key-name reference. Do not copy secret values into this file.

## Verification and release status

Commands:

```sh
npm test
npm run build
npm run db:check
npx playwright test
node automation/n8n/verify.mjs
```

At the 29 September 2026 review, `npm test` passed 69/69 checks, the production build passed, and `npm run db:check` found the required tables, RPCs and relationships in the configured database. Browser tests passed 7/9; the two failing dashboard scenarios use older UI assumptions. The phase-one n8n scaffold verifier failed a sample-input assertion. The latest Conversation AI and UI changes were local working-tree changes at review time, so deployment parity was not established. Controlled real-mail sending, live n8n execution, and phone push delivery were not verified. Notification tables existed but had no live notifications, subscriptions or deliveries in that check. Re-run the commands and live acceptance checks before making a newer release claim.

## How to work safely in this codebase

- Start with this file, then inspect the exact screen, handler, migration and test for the feature. Historical docs may describe designs that changed.
- Trace a feature end to end: UI → browser client → `/api` entry → `server` handler → Supabase/Microsoft/n8n → visible result. Confirm both success and failure behavior.
- Keep browser-local estimates, shared customer quotations, proposals and rate versions distinct. Keep provider mail separate from mirrored tracking records.
- Treat workflow JSON, local environment presence, database schema, automated tests and production behavior as different levels of evidence. Record which one was actually checked.
- Do not include customer message bodies, secrets, OAuth tokens or service keys in documentation or test output.
- Preserve existing working-tree changes. Check `git status` before editing, especially around inbox and Conversation AI files.
- Update this file when navigation, storage ownership, integrations or release status materially changes. Keep details in focused docs and link them from here.

## Focused references

- Client-facing usage and acceptance summary: `deliverables/DCX_CRM_Client_Guide_2026-09-29.docx`
- Microsoft connection: `docs/microsoft-mail-setup.md`
- Tracking and scheduled draft setup: `docs/email-tracking-setup.md`
- Phone notifications: `docs/notifications-setup.md`
- Customer quotations: `docs/customer-quotations-setup.md`
- Supabase installation: `docs/supabase-setup-guide.md`
- n8n phase-one contract and limitations: `automation/n8n/README.md`, `automation/n8n/CONTRACTS.md`
- Email system test and n8n execution evidence: `docs/email-system-test-report-2026-09-29.md`
- Proposed owner-guided learning loop: `docs/learning-agent-design.md`
- Historical email identity and memory: `docs/email-memory-setup.md`. Full PST exports remain local under ignored `.tools/email-archive/`. The new `crm_email_archive` table and `crm_email_memory` RPC require migration/import before historical recall works. Conversation AI retrieves exact-address history; deployed n8n draft workflows are not connected to this new retrieval yet. Attachment metadata is retained for future private storage links; attachment contents are not extracted by this archive phase.
- Feeding process and 4 October extraction/verification status: `docs/email-brain-feeding-plan.md`. The complete local archive contains 8,145 records and a searchable contact/history index; live migration/import completed on 4 October; semantic indexing remains pending.


## October 4 local implementation: email brain and workspace controls

See [workspace email rollout](docs/workspace-email-rollout.md) for the implementation checklist, activation sequence and supplier flow. This section supersedes earlier descriptions of the current checked-in workflow exports, not historical observations of live n8n.

The root workflows 1 and 2 retrieve exact-correspondent history and confirmed reply examples through `crm_ai_context`. Workflow 3 rejects trashed drafts. `workflow 4 - supplier pricing.json` claims and dispatches saved supplier price requests once, using exact recipient verification. All four current exports have `active: false`; live activation was not performed.

The dashboard adds sender relationship and email-topic categories, supplier route/request management and client learning controls. Inbox shows saved AI reply drafts and supports draft trash/restore. Conversation AI analysis is hidden. Customers have recoverable deletion, pricing agreements can be named/retired, quotation tax is editable, and quotation deletion has Trash/restore/permanent-delete controls.

These changes require `202610040002_workspace_controls.sql` and `202610040003_email_relationships_learning.sql` after the existing schema and `202610040001_email_memory.sql`. New server fields must not be deployed before the database migration. All three October migrations were applied through the existing n8n Postgres credential, and all 8,145 archive records were imported. Workflows 1–4 are published. Dashboard/server deployment remains pending because the Vercel CLI is logged out and no local project linkage is available. See the rollout document for live verification evidence.

## October 7 session: live n8n fixes, RFQ attachments, availability and the unified inbox

This section records what was changed on 7 October 2026 and where the project stands. n8n changes were made directly in the live account through the n8n MCP connector (claude.ai connector) and **published**. App changes are **local working-tree changes, not committed or deployed**.

### Live n8n account (`tecshorai.app.n8n.cloud`)

| Workflow | ID | State on 7 Oct |
| --- | --- | --- |
| Workflow 1 - Track Outlook conversations and draft incoming replies | `dAr13OsWOV2pSZbi` | Published; Outlook trigger every minute. Changed today (see below). |
| Workflow 2 - Edit and regenerate owner email drafts | `lXxNYQSjtRw8uVRc` | Published; webhook `crm-email-assistant`. Embedding timeout fixed. |
| Follow-up reminders - 9 AM | `ApCCfjtiqteeOLrM` | Created 7 Oct, URL set to dcx-crm.vercel.app, **unpublished** until the CRM code is deployed. |
| Workflow 3 - Send approved CRM email reply | `RgAjpIfQHy7Lg09I` | **Retired from use (7 Oct).** Still published but nothing calls it: the app no longer forwards `send` to Workflow 2. Unpublish once the first real app send is confirmed. |
| Workflow 4 - Supplier price requests | `CoY6ZLNdcJbkQYDK` | Published. Unchanged. |
| Calendar Assistant v3 - verified event actions | `UVcm6WEsv8jXPPxk` | Published; webhook `crm-calendar-agent`. Unchanged; its Outlook calendar is now also read by Workflow 1. |
| DCX private email memory indexer | `TGfpSedsjU9fJ3E2` | Published. Unchanged. |
| DCX classify existing tracked emails (manual only) | `vdj2eDcEg5JFxVcC` | Unpublished, manual. |

AI nodes use n8n's **Gateway credits** OpenAI credential, not the client's own OpenAI key. Temporary test workflows created during the session were archived. The n8n workflow descriptions still say "Unpublished pending credential reconnection" from the account migration; that text is stale.

### What changed

1. **Embedding timeout** (root cause of "Request timed out" in *Find historical email evidence*). The Embeddings OpenAI node passes its *Timeout* option straight to the OpenAI SDK, which reads it as **milliseconds** although the n8n label says seconds. Values 120/180 aborted every request after 0.12–0.18 s and then retried for about 100 s. Set to `30000` on Workflow 1 *Email history search embeddings* and *OpenAI Embeddings* (knowledge base) and on Workflow 2 *Email history search embeddings*. Verified: embedding 0.49 s, vector search about 2 s; Supabase `match_email_memory_chunks` under 0.6 s for the busiest sender. Repo records: `automation/n8n/embedding-timeout-fix.patch.json`; `semantic-memory-workflow-patches.json` updated.
2. **Customer-ready drafts only.** Workflow 1 *Draft Reply* used to write an owner-review memo (CRM notes, classification, option list) into the reply when classification needed review. The prompt now always produces a send-ready email, asks clarifying questions for vague emails, matches the tone of DCX's past replies, and never quotes prices or invents procedures. *Build Draft Query* refuses to save drafts containing internal-note markers (the run errors instead). The one affected draft ("hey there") was regenerated through Workflow 2. Record: `automation/n8n/customer-ready-draft.patch.json`.
3. **RFQ attachments.** Before classification, Workflow 1 lists the latest email's attachments, reads up to 20 files (8 MB each, 20 MB total; PDF, Word, Excel, PowerPoint, text/CSV, images) with OpenAI, and passes the extracted notes to both the classifier and *Draft Reply*. Unsupported or unreadable files are named in the reply, and conflicting quantities between files are asked about. PDF, XLSX and DOCX reading was verified with real files.
4. **Meeting availability.** Before drafting, Workflow 1 reads the same Outlook calendar as Calendar Assistant v3 and computes free times (assumed **Mon–Fri 9:00–17:00 America/Toronto**, next 10 business days, slots of at least 30 minutes starting at least 2 hours ahead). Only free windows reach the AI. Times are offered only when the sender asks; a proposed busy time gets alternatives; bookings are never claimed. Record for 3 and 4: `automation/n8n/rfq-attachments-and-availability.patch.json`.
5. **Email activity panel (Overview).** Relationship and Purpose are chip buttons with live counts. Summary cards are clickable filters with an active state. *All conversations* and *Clear all filters* buttons. Date presets (Today / 7 / 30 / 90 days / All time) plus From/To pickers using Toronto days. Each row shows the subject, a two-line preview of the latest incoming message, the sender and the date. The preview comes from migration `supabase/migrations/202610070001_email_category_preview.sql` (adds `crm_email_preview` and a `preview` field to `crm_email_categories`), which was **applied to the live Supabase database** after a rolled-back dry run.
6. **Unified Outlook-style inbox.** The top view tabs (Inbox / AI Draft Replies / Drafts / Sent / Archive / Deleted) were removed; folders live only in the left pane, which now also has virtual **AI drafts** (with count) and **Discarded AI drafts** folders. Conversations with a waiting reply carry an **AI draft** tag. The AI reply is edited inline **below** the email (`InlineAiReply.tsx`) with Send, Discard draft, Write again, Save, quick changes (Shorter, More formal, Friendlier, Fix grammar), a free-text instruction, file and saved-quotation attachments, and *Next AI draft*. Manual Reply/Forward editors also open below the conversation. Email bodies auto-size instead of using a fixed 350 px frame. `server/email-assistant-api.js` `queue` now returns `provider_thread_key` so drafts map to Outlook conversations. `InboxAiDraft.tsx` was deleted; `TrackedInbox.tsx` is used only for the discarded-drafts view. Links from notifications and the Email activity panel open the conversation in AI drafts when a reply is waiting, otherwise in its mailbox. Discarding a draft does not regenerate it; a new draft is created only when a new email arrives.
7. **Checked, no change needed.** `@dcx-tech.com` senders are forced to *employee* by `crm_verified_correspondent_role` (lookalike domains are not). A staff member's personal address becomes staff once mapped as employee in Email activity. The "TypeError: fetch failed" seen on the dashboard was a transient network failure between the dev server and Supabase.
8. **Short emails stay short; phone inbox.** Some emails carry pasted web-page layout (a Gmail message containing Gmail's own page markup, with 438 px scroll boxes and 566 px empty blocks). The email frame's CSS in `SafeMailBody` now flattens fixed heights, minimum widths and inner scroll areas, so the frame fits the actual text. On phones (≤640 px) the inbox shows one pane at a time, like Outlook mobile: a one-row scrollable toolbar, folders as a scrollable chip row (Inbox, AI drafts, Discarded AI drafts, …), and the conversation list; tapping a conversation opens it full width with a **‹ Back** button (`phone-reading` class on `.outlook-shell`). The "Last refreshed" line and the Calendar Agent label are hidden on phones. Covered by `tests/browser/inbox-mobile.spec.ts`.
9. **Email viewer like Outlook.** Pictures embedded in an email (`cid:` images) are fetched and shown in place and no longer listed as attachments; external images load with no referrer; links open in a new tab (the frame stays script-free: `sandbox="allow-same-origin allow-popups allow-popups-to-escape-sandbox"`, CSP `img-src data: https: http:`). The "External images and links are blocked" line was removed. Clicking a PDF, image or text attachment opens an in-app preview with Download; other types download. Attachments over 3 MB still need Outlook. Graph rejects `contentId` in a plain attachment `$select`; it is requested as `microsoft.graph.fileAttachment/contentId` (verified against the live mailbox). Covered by `tests/browser/mail-viewer.spec.ts`.
10. **Raza's email signature on every send.** Outlook adds signatures only inside the Outlook app, never to Graph/n8n sends. Raza's signature was recovered from `backup.pst` Sent Items (2,379 sent emails) and stored once in `crm_email_signature` (migration `202610070002_email_signature.sql`, seeded by `scripts/seed-email-signature.mjs`, banner image `supabase/seed/dcx-signature-banner.jpg`). `server/email-signature.js` builds the HTML (blue script name, title, phones, emails, DCX/Schneider banner as an inline `cid` attachment) and places it above quoted history. It is added to AI-draft sends and to manual replies/forwards/new mail (`server/mail-api.js` before `/send`). Both editors show a "Signature added when sent" preview with **Edit signature** (fields, on/off). Title note: replies since August use **Field Service Specialist** (1,908 emails); 66 newer *new* emails say **Field Service Manager**. The seed uses Specialist; change it in Edit signature if Manager is current. Hostinger sends do not get the signature yet.
11. **AI drafts send from the app; Workflow 3 retired.** Cause of "Draft is not editable, has changed, or has no Outlook reply target": the live Workflow 3 claim (approved-send guard, 6 Oct) required a fresh `email_approvals` record that no screen creates any more, plus a `message_version` match that drifts. `server/draft-send.js` now sends through Microsoft Graph: `crm_claim_draft_send` (migration `202610070003_app_draft_send.sql`) locks the exact on-screen version (`updated_at`), checks the connected mailbox, single recipient = original sender, and no newer incoming email, and records the approval; the app then creates the Outlook reply, puts the text and signature above the quoted email, attaches files and the banner, verifies recipients/conversation, sends, and `crm_finish_draft_send` records the outgoing message and attachments, marks the draft sent and the thread *waiting for customer*. Failures before sending release the draft and delete the prepared Outlook reply; an unconfirmed send is marked *uncertain* to prevent duplicates. Tested in `tests/draft-send.test.mjs`, against the real draft in a rolled-back transaction, and by a real send on 7 Oct (reply, signature and banner arrived in Gmail; sent HTML 2.1 KB, MIME 46 KB). Gmail may still show "[Message clipped]" on the collapsed quoted original; the reply and signature above it are complete.
12. **Drafts leave the sign-off to the signature.** Workflow 1 *Draft Reply* and Workflow 2 *AI Rewrite Draft* / *AI Regenerate Reply* now end with a closing line such as "Thank you," and no name, team name or contact details (published 7 Oct). Drafts written before this may still end with "The DCX Team"; delete that line or use **Write again**.
13. **Follow-up reminders** (client proposal "Customer Follow-Up Automation": unreplied quotes after 3 and 7 days, quiet prospects, questions left unanswered). Migration `202610070004_followups.sql`: `crm_plan_followup` runs on every stored email (trigger `crm_followup_on_message`), so replies sent from the app and from Outlook both start the clock and any customer reply stops it. Reason comes from the conversation: *quote* (topic quotation or an estimate/quotation attachment), *awaiting_answer* (our own text, without quoted history, asks a question), *quiet_lead* (lead, incomplete inquiry or upgrade). Due at 09:00 Toronto after 3/7 (quotes, questions) or 7/14 (leads) business days, editable in **Rules** (`crm_followup_settings`). After two reminders without an answer it becomes *gone quiet* and stops. Never for staff, suppliers or the mailbox's own addresses; the app's send record and the Outlook sync copy of one send count once (10-minute window). `server/followups-api.js`: `list`, `set` (snooze / done / remind me, by thread or Outlook conversation key), `settings`, and `run`. The run writes an AI follow-up draft under the customer's last email (never revives a discarded draft, skips if a reply is already waiting), or marks it done when the AI judges no follow-up is needed, and creates a `followup` notification (`crm_notifications.kind`, one per conversation and due time; phone push follows the existing notification path). Run schedule: **n8n workflow "Follow-up reminders - 9 AM" (`ApCCfjtiqteeOLrM`)**, weekdays 09:00 America/Toronto. It POSTs `/api/followups?action=run` with the existing *Header Auth account* credential (`x-webhook-secret` = `N8N_CRM_WEBHOOK_SECRET`), and repeats while 4 or more were due (each call handles up to 4, max 10 rounds) to stay inside free-hosting time limits. The CRM itself schedules nothing (no Vercel Cron, no in-browser run). **The workflow points at `https://dcx-crm.vercel.app` and stays unpublished until today's code is deployed there (the endpoint returned 404 on 7 Oct).** Inbox: **Follow-ups** folder with due count, *Follow up* tag on rows, and a follow-up bar under each subject (when/why, Snooze, Done, Remind me, Rules). Not yet: public holidays, battery-lifecycle and tender-deadline reminders, post-maintenance check-ins. Tests: `tests/followups.test.mjs` (rules in PGlite), `tests/followups-run.test.mjs`, `tests/browser/followups.spec.ts`; live AI dry run on three due test conversations produced sensible drafts (nothing saved).

### Verification on 7 October

- `npm test`: 86/86 passed (91/91 after the signature and app-send work, 97/97 after follow-ups). `npm run build`: passed.
- Browser (`npx playwright test`): 11 of 15 passed (the later `inbox-mobile.spec.ts` also passes, run with the inbox tests), including the rewritten `email-categories.spec.ts` and `conversation-ai-reply.spec.ts` and the updated `notifications-mobile.spec.ts`. Failing and unrelated to these changes: two `dashboard.spec.ts` scenarios (they look for the removed "Tender agent" and "Email reporting period" UI), `email-report-dates.spec.ts` (`page.emulateTimezone` is not available in the installed Playwright), and `workspace-controls.spec.ts` "calculator can create and delete a named pricing agreement" (calculator page, not touched; not investigated).
- **Not yet verified end to end with real mail:** an RFQ email with attachments, a "when are you available?" email, and sending from the inline AI draft. The connected test calendar had no events, so busy-time handling was verified only with synthetic availability.

### Decisions still needed

- Raza's signature title: Field Service Specialist (current seed) or Field Service Manager.
- Whether Mon–Fri 9–5 Toronto is the right availability window.
- Staff replying from their own mailboxes: shared mailbox, connect each mailbox, or a CC rule.

### Agreed next steps (not built)

1. **Replies sent directly from Outlook** currently reach the database only when the customer replies again (Workflow 1 pulls the whole conversation) or on a manual CRM sync. Plan: an n8n Sent Items watcher (save the reply, mark the conversation *waiting for customer*, move the pending AI draft to "Replied in Outlook"), a nightly delta-sync catch-up, and Supabase backups with a recorded restore test.
2. **Ambiguous sender identity:** hold the draft and flag it to Raza outside the reply (contract 3.1) instead of drafting.
3. **Unified inbox phases 2 and 3:** keyboard shortcuts, classification tag in the list, "Replied in Outlook" tag.
4. **Contract gaps** from `docs/contract-implementation-checklist-2026-10-05.md`: latest approved rates at every stage, named user roles, client-owned production accounts (mailbox, n8n, Supabase, Vercel, GitHub, own OpenAI key).
5. Commit the working tree and deploy the app; deployment parity with Vercel has not been established.
