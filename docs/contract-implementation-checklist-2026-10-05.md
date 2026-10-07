> Update, 6 October 2026: private semantic indexing is complete and AI classification is published. See [classification verification](ai-email-classification-2026-10-06.md). The original gap assessment below is retained; this update does not establish full contract acceptance.

# CRM implementation checklist

Reviewed 5 October 2026 against the agreement dated 29 September 2026 supplied in this chat. This is a technical gap assessment, not acceptance or a legal opinion. A working screen or successful workflow execution does not establish compliance with every requirement. No external mail was sent for this review.

| Agreement requirement | Status | Evidence and remaining work |
| --- | --- | --- |
| 3.1 Correct identity and relevant history | Partial | Exact-address historical lookup and current Outlook chain are connected to published n8n intake. Private vector and keyword retrieval is now connected; all 7,977 eligible sources have been indexed. Bounded retrieval can still miss relevant context. Uncertain identity currently can produce a general draft rather than always stopping and asking Raza. |
| 3.1 One customer timeline | Partial | Customers, contacts, sites, equipment, services, purchases, emails and quotations exist. A unified timeline covering meetings, tasks and every source is not verified. |
| Existing support and upgrades | Partial | Context-aware drafts exist; representative acceptance tests for verified equipment, missing questions and support claims remain necessary. |
| Detailed RFQ with 12–20 Word/Excel/PDF files | Gap | n8n saves attachments on a separate branch but does not supply their extracted contents to the drafting AI. On-demand Conversation AI has file support and limits, which does not prove the automated RFQ requirement. Conflict extraction, completeness checks and draft blocking remain. |
| Incomplete inquiry sequence | Partial | Thread history supports replies; structured mandatory requirements and a tested completion gate are not established. |
| Internal/team email | Partial | DCX domain returns employee; owner mappings and AI classification are now included in drafting context. Personal-address staff overrides, project decisions/tasks and confidentiality tests remain. |
| Meeting availability and priority conflicts | Gap | Separate published Calendar Agent exists. Email intake does not check free/busy or escalate insistent customer conflicts to Raza. |
| Wholesale profiles | Partial | Named versioned agreements and customer assignment exist. Separate formula/template/commercial terms and isolation acceptance tests remain. |
| Other/uncertain and configurable categories | Partial | Controlled AI classification, manual corrections, confidence review, exact-message persistence and supersession guards are now implemented and tested. Categories are fixed in code/schema; ambiguity does not universally stop drafting. |
| 4.1 Database rate administration | Partial | Versioned Supabase rate books and worksheet price saving exist. Approval, activation, expiry, search and complete effective-date controls are not established for every required rate. |
| 4.2 Latest active approved rates at every stage | Gap | Browser estimates and saved snapshots exist. Complete live database validation at create/revise/approval/send, with rate-change invalidation, is not verified. Historical emails must never supply current prices. |
| 4.3 Configurable formula engine | Partial | Deterministic costing calculations exist. Formula definitions and version assignment editable without code changes are not implemented as required. |
| 4.5 Versioned quotation templates | Partial | Branded quotation/PDF generation exists. Database template management, profile-specific versions, mandatory draft marking and all required fields need reconciliation. |
| 4.6 Immutable configuration audit | Partial | Rate history, quotations and email revisions are present. Complete immutable prior/new-value audit and linked rate/formula/template snapshots remain unverified. |
| 5.1–5.2 Exact-version approval and send | Partial | Draft revisions, approval records and a published send workflow exist. Contract acceptance requires recipient/attachment/content/configuration invalidation and fail-closed testing across all send paths. Approval Channel agreement is not recorded in this review. |
| 5.3 First 30 days draft-only | Unverified | Verify explicit go-live date, category permissions and every external send path. Supplier automatic requests require reconciliation with this clause and recorded authorization. |
| 5.4 Private calendar and confirmation | Partial | Calendar assistant has confirmed-action guidance. Email free/busy integration, conflict checks, private-data filtering and booking acceptance tests remain. |
| 6.1 Complete reporting | Partial | Email activity, follow-ups and fixed relationship/topic counts exist. The dashboard performance block was removed at user request; underlying reporting remains. Full configurable support/upgrade/RFQ/opportunity/quotation lifecycle/response-time/escalation/failure reporting remains. |
| 6.2 Roles, administrator controls | Gap | Current system is a signed single-owner login, not named multi-role access. |
| 6.2 Leads, opportunities, tasks and escalation | Partial | Customer records and follow-up workflow exist. Complete distinct modules and end-to-end acceptance are not established. |
| 6.2 Handover and backups | Unverified | Source, migrations and setup documents exist. Recorded restore test, credential inventory, admin/Raza guides, training and assistance evidence remain. |
| 6.3 Client-controlled production accounts | Gap | Live intake is configured for a test Outlook account. Production mailbox, hosting, repository ownership and recovery handover need verification. |
| 7.2–7.3 Security and privacy | Partial | Server-only Supabase secrets, signed sessions, restricted tables and untrusted-input prompts exist. Named roles, approved processing/storage, quarantine and complete injection/security tests remain. |
| 8.4 Acceptance | Not complete | Required recorded end-to-end evidence and express TecShor acceptance have not been established. |

## Recommended implementation order

1. Reconcile the Approval Channel, client-controlled mailbox, named roles and all outbound paths with the contract. Preserve draft-only behavior and exact-version approval.
2. Make rate/formula/template configuration authoritative in the database and validate it again at approval and send.
3. Add attachment extraction and structured requirement completeness, with failure/conflict flags.
4. Improve historical retrieval, then add scheduling free/busy context and conflict escalation.
5. Expand configurable categories, timeline and reporting; run all acceptance cases and complete restore/handover evidence.

## Adding semantic historical retrieval

Keep historical email evidence separate from the company knowledge collection. Add a private email chunk table with source message ID, mailbox/customer scope, correspondent addresses, thread, date, text, embedding and extraction version. Split long emails into chunks; retain provenance and attachment read status. Generate embeddings once for the archive in bounded resumable batches, and only for new or changed live messages thereafter. Paid processing requires the agreement's applicable written approval before execution.

At drafting time, identify the sender and authorized customer/mailbox scope first. Embed the new request and search vectors inside that scope, alongside keyword and exact-reference searches. Combine rankings, include recent context, deduplicate repeated quoted mail, and expand the best matches with adjacent thread messages. Return dates/source IDs and explicit completeness limits. Wire this context into the existing n8n Load Email Brain stage and the app's historical lookup. Do not mix email vectors into an unrestricted company knowledge tool.

Validate with synthetic and authorized held-out cases: old request with paraphrased wording, exact old reference number, changed equipment, same name/different address, confidential partner rates, unavailable database and prompt injection. Compare retrieved evidence and draft accuracy with the present keyword lookup. Vectors improve recall; they do not guarantee complete history or authorize using historical prices.
