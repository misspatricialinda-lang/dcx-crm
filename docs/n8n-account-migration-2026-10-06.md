> Current status: the new account workflows are published and credentials assigned. See [activation test report](n8n-activation-test-report-2026-10-06.md) for verified checks and remaining work. Historical indexing is still in progress. Earlier rollout notes below describe preparation steps.

# n8n migration — 6 October 2026

New account: https://tecshorai.app.n8n.cloud

Imported into the personal project named tecshors. All seven operational workflows are unpublished. Node counts, connections and error/retry behavior were checked against the source. Internal workflow references point to the imported send workflow.

| Workflow | New ID | Required connections |
| --- | --- | --- |
| DCX private email memory indexer | TGfpSedsjU9fJ3E2 | postgres, supabaseApi |
| Workflow 3 - Send approved CRM email reply | RgAjpIfQHy7Lg09I | postgres, microsoftOutlookOAuth2Api, supabaseApi |
| Workflow 4 - Supplier price requests | CoY6ZLNdcJbkQYDK | postgres, microsoftOutlookOAuth2Api |
| Workflow 1 - Track Outlook conversations and draft incoming replies | dAr13OsWOV2pSZbi | microsoftOutlookOAuth2Api, postgres, supabaseApi |
| Workflow 2 - Edit and regenerate owner email drafts | lXxNYQSjtRw8uVRc | httpHeaderAuth, supabaseApi, postgres |
| Calendar Assistant v3 - verified event actions | UVcm6WEsv8jXPPxk | microsoftOutlookOAuth2Api |
| DCX email brain verification (manual only) | 3jF91YqwpRkk279D | postgres |

The new account currently has no user-created credentials. Reconnect Microsoft Outlook, PostgreSQL, Supabase and the CRM webhook header credential. AI model credentials may be assigned through n8n Gateway credits; confirm approved billing/account configuration before tests.

No workflow was published, no external mail sent, no GitHub push made. Unneeded staging/test copies were archived. Existing production workflows in the old account were preserved.

Before activation: verify imported credentials; update local CRM webhook URLs only after the new endpoints are tested; integrate semantic retrieval and calendar availability; reduce unnecessary worker schedules; test approval and recipient safeguards with synthetic data.