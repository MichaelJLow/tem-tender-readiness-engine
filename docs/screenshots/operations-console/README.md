# Operations Console screenshot set

These are real Console captures at a 1500 × 1000 desktop viewport, using a disposable state seeded on 29 September 2026. All tender data and evaluation cases are synthetic; this prototype does not describe TEM's private workflow or pricing policy.

- [Queue](queue.png) — Three synthetic tenders show distinct business routes alongside processing and review states; only the ready route crosses the mocked pricing boundary.
- [Tender detail and human review](human-review.png) — The open `HUMAN_REVIEW` case shows TDR-006, the submitted date, both source dates, provenance, and the reviewer action.
- [Review audit](review-audit.png) — A recorded `REQUEST_INFORMATION` disposition cites `site-001`, `contract-a`, and `contract-b` while the automatic route remains `HUMAN_REVIEW`.
- [Performance](performance.png) — The latest completed full run and the accepted baseline are separate, with their own gates, safety results, agent facts, and workflow facts.

The open-review image was captured before the review event; the audit image was captured after it. The API state then contained one pricing handoff, belonging only to `tender-clean-001`. The performance image reads retained reports: latest `full-2026-09-28T19-39-31.237Z` and accepted `full-2026-09-26T23-53-52.654Z`. The latest passing run has not been promoted to the accepted baseline. The card’s unsafe-ready figure is the all-cases count (0/63); the release gate remains 0/44 on the golden safety set.

Follow the [Milestone 5 console walkthrough](../../runbook.md#milestone-5-console-walkthrough) to reproduce the state and captures with fresh run IDs. Do not submit real tenders or credentials to the demo.
