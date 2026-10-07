# AI email classification: implementation and verification

Implemented and published on 6 October 2026 in the TecShor n8n account.

## Current behavior

New incoming Outlook messages are persisted with their exact provider/message identity. The intake workflow matches the sender to CRM contacts, retrieves bounded private history for that sender, classifies the latest request, validates the output and saves the result before semantic draft retrieval and reply generation. The saved classification is included in both the intake draft context and the common CRM AI context used for later editing/regeneration.

Purpose categories: support, upgrade, quotation, billing, meeting, incomplete_inquiry. Relationship categories: employee, customer, lead, supplier, wholesale_partner. Unknown values remain null and are presented as Needs review, rather than introducing another business category.

Owner topic corrections and saved sender mappings take precedence. DCX-domain addresses are employees. Existing customer, supplier and wholesale relationships require verified CRM/mapping records; an AI inference cannot grant those identities or select commercial permissions. Clear prospective interest may be classified as lead, and a previously recognized lead remains recognized on later correspondence from the same address. A changed or ambiguous customer identity requires review. Classified labels do not create purchase records or approve prices, sending or calendar actions.

The two review checks are independent: a clear meeting request can be labelled meeting while its sender relationship still needs review. The model's confidence scores are proposal scores, not measured accuracy. Purpose requires at least 0.80 confidence; a new lead proposal requires at least 0.60 relationship confidence and a clear purpose. Verified identity and existing prospective relationship context take precedence over model guesses.

The CRM displays Classifying while processing, refreshes classification data every 15 seconds and keeps its editable selectors. The dashboard counts the latest incoming conversation category, not every historical message or all archived emails.

## Verification

- All 84 local tests passed; production build passed.
- Live synthetic tests in the current n8n classifier returned the correct purpose for meeting, support, upgrade, billing, incomplete inquiry and detailed quotation requests (executions 20–25).
- An instruction-injection email was routed to review instead of changing its relationship or revealing rates (execution 26).
- A two-message loop retained separate message IDs (execution 16).
- Older classification runs cannot update the latest conversation category. A simulated older run stopped before drafting (28), a current run continued (29), and changed-sender history failed closed before drafting (30). The error in execution 30 is an expected passing guard test.
- SQL tests verify stale-content rejection, controlled category values, owner corrections, DCX employee precedence, independent purpose/relationship review and prospective relationship continuity. Parameterized database writes use the persisted message ID and fingerprint, not an identifier proposed by the AI.
- The classification-only pass finished all 46 existing tracked conversations (execution 27). It created no reply drafts and sent no emails. The revised pass produced no invalid AI outputs.

At the last dashboard check: 46 conversations; 25 classified as lead relationships; purpose counts were support 4, quotation 7, meeting 6, billing 2 and incomplete inquiry 3. Upgrade count was zero in this dataset. 32 conversations still needed review for a missing/uncertain purpose or relationship. A missing classification is intentionally not forced into one of the allowed categories.

Historical semantic indexing is complete for all 7,977 eligible sources: 21,477 ready chunks, zero failed/pending/processing chunks. The separate archive has 8,145 messages, including items ineligible for indexing. Indexing the archive does not import it into CRM reporting or classify every archived message.

## Scope and operation

The incoming workflow is published. The classification-only backfill is manual and unpublished so it does not consume recurring scheduled executions. Classification is an additional AI call inside the normal incoming workflow, not a separate n8n execution for every email. The classifier uses the existing n8n OpenAI model/Gateway credential. The original local embedding worker used OPENAI_API_KEY from the local environment.

Purpose classification uses readable email text, conversation and historical/CRM evidence; it does not prove extraction of newly received Word/Excel/PDF attachments. Complete attachment processing, live calendar availability inside email drafting, commercial configuration approval snapshots and the remaining contract acceptance tests remain separate work. Nothing was pushed to GitHub.
