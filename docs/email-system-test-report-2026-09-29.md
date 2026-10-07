# Email system test report

**Review date:** 29 September 2026  
**Scope:** DCX Operations Workspace email, Outlook integration, in-app Conversation AI, n8n-related flows, and whether the system resolves customer issues.  
**Verdict:** The app can receive and track mail, create and send an owner-reviewed reply, and produce useful AI analysis. The active n8n intake also processed the self-test. It does **not** autonomously resolve customer issues. AI drafts still make unsupported technical and timing claims; an end-to-end n8n draft/review/send for a controlled customer-like test was not performed in this review.

## What was actually tested

This review used the current local working tree connected to the configured Microsoft account, Supabase project and OpenAI API. It did not prove that the same code is deployed on Vercel. The one live email was a clearly marked self-test sent from the active Outlook account back to that same account, with the owner's explicit approval. No customer was emailed.

| Test | Result | Evidence and limit |
| --- | --- | --- |
| App tests | **Pass: 69/69** | `npm test`, including mocked mail, tracked draft, Graph, security and Conversation AI cases. Mocks do not establish provider delivery or draft quality. |
| Production build | **Pass** | `npm run build`; an existing large bundle warning remains. |
| Conversation AI browser flow | **Pass: 1/1** | `npx playwright test tests/browser/conversation-ai-reply.spec.ts` opened an editable AI suggestion in the selected conversation. Browser fixtures do not use real Outlook or OpenAI. |
| Configured database | **Pass for schema/query checks** | `npm run db:check` found required CRM/mail tables, relationships and RPCs. At check time: 78 threads, 123 messages, 20 drafts, 8 attachment records, **0 automation jobs**, **0 notifications**, **0 push subscriptions**. Scheduled tracking draft worker reported **not configured**. |
| Live Microsoft connection | **Pass** | The current server handler authenticated to the active delegated Outlook connection. The account address was not included in this report. |
| Live draft, review, send | **Pass for submission** | Created a new self-addressed Outlook draft, checked recipient, subject and body in the review response, then sent once. Microsoft returned HTTP 202. |
| Sent and received copy | **Pass** | The unique self-test subject appeared in Sent Items and then Inbox; both records had the same Microsoft conversation ID. This proves this test message reached the connected mailbox, not general external delivery. |
| Real mailbox Conversation AI | **Pass for execution** | The app analyzed the self-test conversation through real Microsoft Graph, Supabase knowledge lookup and OpenAI. It saw two messages and correctly returned `reply_needed: false`. |
| Automatic CRM tracking | **Pass for self-test intake** | The self-test appeared in `email_threads` and `email_messages` without a manual sync. The two recorded messages were classified `outgoing`; there was no draft, job or notification for this self-addressed mail. n8n executions 138 and 139 both reached `Persist Incoming Email` and stopped at `Incoming Message?`. |
| n8n phase-one scaffold verifier | **Fail** | `node automation/n8n/verify.mjs` stops at the `Sample input` assertion. This concerns the separate WF00–WF06 scaffold, whose `/api/automation/v1/*` adapters are not implemented. |
| Active n8n workflow state | **Verified** | Direct n8n API shows active workflow 1 (`lrktCABRGu93BBXD`), workflow 2 (`rWKsBzLw1BCjXugn`) and workflow 3 (`ia38UVye6S2PhzEp`). The separate duplicate of workflow 1 (`TBr0z6lXBIFgDvz1`) is inactive. Workflow 1 is triggered by Outlook mail; workflows 2 and 3 handle draft actions and send handoff. |
| Live n8n intake and AI path | **Observed in execution history** | Workflow 1 executions **138** and **139** succeeded on the self-test, reaching persistence and the incoming-message branch. Earlier execution **135** on 29 September succeeded through attachment listing/download/storage, customer context, model and knowledge tools, `Save Dashboard Draft`, and `Mark Email Read`. A successful path does not score the draft's accuracy. |
| Attachment use in n8n drafting | **Gap confirmed** | The active workflow downloads and stores attachments, but its `Format Customer Context` and `Draft Reply` inputs contain the email thread and CRM context, with no extracted attachment contents. There is no extraction node in that active path. Its AI draft therefore cannot be treated as having read an attached PDF, spreadsheet or scope. |
| n8n draft-action and send path | **Observed historically; not exercised by this self-test** | Workflow 2 execution **132** and workflow 3 execution **133** on 29 September were marked successful. Execution 133 reached `Send Outlook Reply Draft` and `Record Outgoing Email`. This review did not inspect the prior message content or independent recipient delivery, and did not invoke a new n8n send. The self-test used the app's direct Outlook compose/review/send path. |
| Customer issue resolved | **Not established** | No real service action, technician dispatch, corrected quotation, customer acceptance or support outcome was observed. |

## AI answer-quality checks

Four synthetic email scenarios were run against the **real OpenAI model through the app's Conversation AI handler**. Microsoft Graph responses were replaced with synthetic messages; Supabase knowledge search returned no passages. This isolates the current prompt and handler without transmitting a real customer's correspondence. One case supplied a readable `.txt` attachment through the handler; another supplied an unsupported `.zip` attachment.

| Scenario | What worked | Problem or limit |
| --- | --- | --- |
| UPS self-test alarm with known model, alarm code and battery date in the chain | Followed the latest customer question and did not repeat the earlier request for the alarm code. | Suggested a manual battery/load test and made an inference about what the fictional alarm indicates despite saying the exact code meaning was unknown. A qualified owner must check model-specific guidance and safety before using this reply. |
| Automated security notice | Returned `reply_needed: false` and an empty draft. | Single controlled case; this does not prove reliable spam or phishing classification. |
| Price request with an unsupported `.zip` scope | Marked the file `unsupported`, said it could not read the scope, and withheld a firm price. | It offered to confirm whether pricing could go out today, a timing statement that needs owner verification. |
| Price request with a readable `.txt` scope | Marked the file `read`, extracted the stated quantity of **32 battery blocks**, and identified missing specifications. | The draft promised a same-day quotation after answers arrived, subject to supplier availability. The app had no approved price, availability result, or authority to make that commitment. It also asked a longer list of questions than the owner requested. |

The 28 September [n8n draft test report](n8n-email-draft-test-report.md) provides a separate baseline for the older n8n agent: 15 synthetic scenarios had **7 failures, 8 partial results, and no full pass**. That test did not run the whole live Outlook-to-CRM path. Its recurring problems were unsupported commitments, technical overreach, excessive questions, inconsistent knowledge retrieval and replies to spam. The current on-demand Conversation AI is a different implementation, but this review still found unsupported technical and timing language.

## Does it fix issues for people?

**It helps the owner identify and answer issues; it does not complete service work.** A customer may describe a UPS alarm, request a report, ask for a quotation or want a site visit. The software can keep the chain together, expose attachments, suggest a summary, prepare a draft and track a follow-up. It does not diagnose equipment, confirm inventory, verify a price, retrieve every requested report, book a technician, or confirm that a customer's problem was solved. A sent email is a communication event, not a resolved service case.

For the current pilot, every AI reply about safety, equipment condition, quotation totals, availability, visits, deadlines, attached files or completed actions should be reviewed against actual records and approved by the owner. The UI's editable draft is useful because this review found examples that should be changed before sending.

## Priority findings

1. **High — AI can make unverified commitments.** The live-model readable-attachment case offered a same-day quote with no approved pricing or supplier confirmation. Keep owner review mandatory; add deterministic checks or a structured “needs verification” state before a draft can be treated as ready.
2. **High — Technical language can outrun evidence.** The fictional alarm case recommended a manual test and suggested alarm meaning without verified model documentation. Require approved source evidence for model-specific diagnosis, procedures and safety claims; otherwise ask the owner to check.
3. **High — n8n drafts do not read attachment contents.** Workflow 1 stores attached files, then drafts from the email chain and CRM context without extracted file text. Add a bounded extraction/reading step with per-file status, pass verified text into the model, and surface unread files to the owner. Until then, require manual inspection for attachment-dependent requests.
4. **High — n8n execution success is not customer success.** The active intake, drafting and send workflows have successful execution records, including attachment storage and a prior send. A green n8n run does not show that a reply was factual, the recipient received it, or the issue was resolved. Run a controlled customer-like chain through all three workflows and score the actual draft and outcome.
5. **Medium — Tracking attribution needs instrumentation.** The self-test was mirrored in the CRM and matching n8n executions were visible, but the database records inspected here did not carry a directly comparable execution ID. Persist an execution/source ID for intake and draft events or include it in an existing activity record.
6. **Medium — Phase-one scaffold validation is red.** Fix the `Sample input` assertion in `automation/n8n/verify.mjs` and validate each export in the target n8n version before considering that package usable. This does not by itself diagnose the separate root workflows.
7. **Medium — Customer outcome is not measured.** Add a resolution state and evidence such as a confirmed answer, quotation issued/accepted, service visit completed, or customer confirmation. Report response quality and actual closure separately from message counts.

The missing local `EMAIL_TRACKING_TOKEN` applies to the **separate** TRACK01–TRACK03 templates, not to the already active root Outlook-trigger workflows. Do not treat it as evidence that those active workflows are disabled.

## Next acceptance run

Use a dedicated test sender other than the connected mailbox, a synthetic service question, and a harmless readable attachment. In the actual n8n workspace, capture the trigger execution ID, classification, attachment result, model output, draft record ID and any error. Verify the new message appears once in Outlook and CRM, the owner can edit the draft, and no email sends before deliberate review. Then send to the controlled test address, verify Sent Items and receipt, and check the conversation, notification, reporting and status updates. Finally, score the reply for factual accuracy, necessary questions, unsupported promises and whether the user's issue was actually resolved. Do not use a live customer as the test recipient.
