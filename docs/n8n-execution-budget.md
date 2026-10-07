# Execution budget and rollout

The initial historical email indexing runs from the local script and consumes no n8n executions. Embedding API usage is separate.

n8n counts workflow runs rather than individual nodes. A five-minute recurring worker has 288 scheduled runs daily, or 8,640 in a 30-day month. An hourly worker has 720 runs in that period. Empty-work checks reduce processing but do not eliminate executions already started by a schedule.

Before activating the replacement account:

- Export/import and verify workflows, credentials and webhook URLs.
- Integrate classification, relevant-history retrieval and availability lookup into the existing intake run.
- Index newly saved messages during intake where feasible, and batch retries through a bounded maintenance process.
- Keep the initial archive backfill outside n8n.
- Replace frequent supplier queue polling with approved dispatch events or an explicitly budgeted schedule.
- Keep retries bounded and observe execution usage during the first week.
- Calculate allowance from actual incoming-message volume, owner revisions, approval/send runs, supplier dispatches and maintenance. Changing accounts alone does not prevent another exhaustion.

Do not activate the existing five-minute indexer unchanged under a 1,000-run allowance. All live workflow changes require successful integration tests after execution capacity is restored.

Current CRM classification vocabulary is restricted to employee, customer, lead, supplier, wholesale partner; and support, upgrade, quotation, billing, meeting, incomplete inquiry. Missing evidence is a pending-review state, not an additional classification.
