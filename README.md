# DCX Operations Workspace

A private operations dashboard for DCX Technical Inc.'s UPS maintenance, battery and critical-power services. It brings customer records, mailbox conversations, follow-ups, job costing and customer proposals into one workspace.

## What the software does

- **Overview:** conversation queues, follow-ups and email performance reporting for 1, 7 or 30 days. Reporting defaults to Eastern Time (Toronto) and offers Canadian timezones only, regardless of the computer's timezone. Report sync timestamps use the selected Canadian timezone too.
- **Inbox:** Inbox, AI Draft Replies, and Sent views. Connected Outlook conversations can be reopened and replied to; the AI queue contains only drafts awaiting owner review. Outlook replies accept local file attachments, including generated customer quotation PDFs. Supabase retains customer links, workflow status, reply revisions, approval records and send tracking.
- **Customers:** companies, contacts, sites, equipment, completed purchases, service history and proposal PDFs.
- **Cost calculator:** supplier and manual costs, quantities, exchange divisors, gross margins, flat selling items, shipping, brokerage, tax and CAD-only quotations and exports.
- **Tender agent:** a navigation tab displaying **Coming soon**. Tender automation is not implemented.

The workspace-wide search bar has been removed. Search filters inside customer and email screens remain available.

## Cost worksheet export

In **Cost calculator**, enter the estimate and select **Download XLSX**. Every download uses the client's `Cost calculation tempelate.xls` / `Job Cost Sheet` layout, delivered as a modern `.xlsx` workbook.

The export preserves the A–M column order, original input colors, company and ship-to sections, flat items, notes, cost/selling/profit totals, and a CAD-only currency note. It keeps ten cost rows and two flat rows for small estimates and expands both sections for larger estimates. The sheet has no frozen rows or additional app fields below the source layout. The unrelated sample reverse-percentage calculation outside the original cost table is excluded.

Calculated cells contain Excel formulas with current cached results. Manual cost overrides stay numeric inputs. Supplier cost × multiplier, quantity, exchange conversion, margin and totals recalculate when workbook inputs change. Text beginning with `=` is exported as literal text. Sample input values from the source workbook are not embedded in the template asset.

All quotation totals are CAD. Older locally saved currency selections are normalized to CAD without changing the underlying CAD amounts. The USD output selector and conversion fields have been removed.

The UI calculates as inputs change; file downloads are initiated by the export button. Excel is the only cost-calculation download format and includes internal costs and margins.

Implementation:

- `src/lib/costing.ts`: shared calculation rules and validation.
- `src/lib/cost-template.json`: extracted source labels, dimensions, merges and styles.
- `src/lib/cost-workbook.ts`: estimate-to-template mapping and Excel formulas.
- `src/lib/cost-export.ts`: Excel workbook downloads.

## Storage and tracking

The app uses a signed, server-verified owner login. Its server API accesses Supabase with `SUPABASE_URL` and `SUPABASE_SECRET_KEY`; the secret is never sent to the browser. Supabase Auth is not used.

| Data | Storage |
| --- | --- |
| Customers, contacts, sites, equipment, purchases, service history | Supabase `crm_*` tables |
| Customer proposals | Supabase `crm_proposals` |
| Shared rate-book versions | Supabase `calculator_rate_versions` |
| Tracked mailboxes, conversations, messages and attachments | Supabase `email_*` tables |
| Reply revisions, approvals, activity and automation jobs | Supabase `email_*` tables |
| Microsoft OAuth connections | Supabase `microsoft_oauth_connections`, with encrypted tokens |
| Working cost estimates and saved cost quotations | This browser's local storage |
| Development preview | Local example data; no live account session |

Cost quotations are currently browser-local. Download important estimates; they are not automatically shared between devices. Customer proposal documents use a separate Supabase-backed workflow.

Microsoft sync persists a separate, leased delta checkpoint for each folder. Both delegated OAuth and application-credential connections use this path. Completed Inbox and Sent Items imports resume from their saved checkpoints. Database transactions deduplicate messages and prevent stale edits or repeated sends. The dashboard offers manual sync; scheduled intake and AI drafting require the n8n worker setup described in [email tracking setup](docs/email-tracking-setup.md).

## Run and verify

1. Install dependencies with `npm ci`.
2. Set the server variables in `.env.local` using `.env.example` as a guide. Preserve existing configured values.
3. Apply the migrations in `supabase/migrations` in filename order if setting up a new project. The `knowledge_foundation` migration is optional. Do not rerun migrations against an already installed database or use the old root `supabase_schema.sql` prototype schema.
4. Run `npm run dev` and open the local address Vite prints.

```sh
npm test
npm run build
npm run db:check
# With the development server running:
npx playwright test
```

`db:check` is read-only. It verifies the app's required tables, tracking RPCs, foreign-key relationships and live reporting queries without printing credentials or message bodies. It also reports whether the tracking worker token is configured. It does not prove that external n8n workflows are active.

## Changes and verification — 24 September 2026

- Replaced the generic three-tab Excel export with the client's Job Cost Sheet format, including formulas, dynamic row expansion and all estimate totals.
- Made quotation outputs CAD-only across the calculator, saved quotation list, customer print/PDF copies, Excel exports. Removed USD selection, conversion inputs and totals, and normalized older saved currency selections.
- Removed the JPG download button and unused image-export implementation. Cost calculations download as Excel only.
- Added Tender agent / Coming soon and removed global search and its unused state/styles.
- Removed unreachable legacy calculator and quotation implementations while preserving shared rate-editor controls.
- Fixed application-credential Outlook sync to use durable delta checkpoints.
- Added the repeatable Supabase verification command and export/sync/browser regression coverage.
- Verified the configured live Supabase tables, tracking relationships, all four tracking RPCs and reporting queries.
- Completed a live import of the connected Outlook Inbox and Sent Items. Both folders reached their final delta checkpoints; subsequent Sent Items sync returned zero new records. Live Outlook reporting returned 6 received and 1 sent message for the seven-day UTC period at verification time. Existing Hostinger records were retained.
- Verified workbook round-trip values, manual overrides, extra rows, flat amounts, tax, CAD totals, empty estimates and invalid-input rejection. Recalculated a downloaded workbook independently, changed a quantity and confirmed the total updated. Reviewed the exported sheet and Tender agent page visually.
- Automated checks: 50 unit/integration tests across the suite, 2 browser scenarios, and production build. ExcelJS still produces the existing large-chunk build warning; exports load it on demand.
- CAD-only follow-up: production build, all 15 costing/export regression tests (including legacy currency handling), and the calculator browser scenario passed.

**Remaining configuration:** `EMAIL_TRACKING_TOKEN` is not configured in the local environment, so scheduled intake / AI drafting is not verified or enabled. Import and configure the supplied n8n workflows and model credentials to activate that workflow. Live email dispatch was not exercised during verification. No changes were deployed by this update.

Further setup: [Supabase](docs/supabase-setup-guide.md), [Microsoft mail](docs/microsoft-mail-setup.md), [email tracking and n8n](docs/email-tracking-setup.md).
