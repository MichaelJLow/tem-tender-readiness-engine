# Milestone 7 n8n verification receipt

## Purpose and status

This receipt distinguishes inspectable repository checks from an actual n8n
execution. The fresh-import execution matrix passed in a real n8n `1.112.6`
runtime. Unit tests remain supporting contract evidence rather than a substitute
for the recorded n8n executions. Milestone 7 is **accepted** after
[PR #19](https://github.com/MichaelJLow/tem-tender-readiness-engine/pull/19)
merged to `main` as `12f4c6c`. Document registration/upload remains deferred.

## Versioned inputs

- Workflow: `integrations/n8n/tender-intake.workflow.json`
- Workflow name: `Tender intake and outcome handling`
- Required n8n version: `1.112.6`
- Verified workflow source revision: `2dc770e`
- API contract: `POST /tenders`
- Walkthrough and endpoint configuration: `integrations/n8n/README.md`
- Synthetic scenario fixtures: `clean.json`, `needs-information.json`,
  `human-review.json`, `pending.json`, and `duplicate.json`

The source revision above contains the corrected export used for the recorded
executions. The immutable accepted history on `main` is merge commit `12f4c6c`
([PR #19](https://github.com/MichaelJLow/tem-tender-readiness-engine/pull/19)).

## Automated evidence recorded on 4 October 2026

| Input                           | Action                                          | Observed outcome                                                                                                                               |
| ------------------------------- | ----------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| Export and walkthrough fixtures | `npm test -- integrations/n8n/workflow.test.ts` | Passed: 31 tests covered export shape/security, normalization, route receipts, pending behavior, technical errors, IDs, and pricing ownership. |
| Repository                      | `npm run format:check`                          | Passed as part of `npm run check`.                                                                                                             |
| Repository                      | `npm run lint`                                  | Passed as part of `npm run check`.                                                                                                             |
| Repository                      | `npm run typecheck`                             | Passed as part of `npm run check`.                                                                                                             |
| Repository                      | `npm test`                                      | Passed: 18 files and 226 tests as part of `npm run check`.                                                                                     |
| n8n `1.112.6` npm runtime       | Fresh import plus six webhook executions        | Passed using a temporary local install; execution IDs 1–6 all report `success`.                                                                |

The export test asserts that there are no credential bindings, API keys, copied
domain rule identifiers/prompts, review mutations, mail/chat nodes, or a second
HTTP handoff. The only HTTP Request node calls the Tender API. Fixtures contain
synthetic names and references only.

## Fresh-runtime execution recorded on 4 October 2026

The first direct `npm exec` attempt was blocked by the environment's outbound
proxy, which returned `403` for SheetJS's separate `cdn.sheetjs.com` tarball.
This was not an npm-registry rejection, an application test failure, or a
credential problem. Docker was unavailable in the runner. Verification continued
with a temporary n8n `1.112.6` install that overrode only the unused `xlsx`
package to the npm-registry `0.18.5` release; the imported workflow has no
spreadsheet node. SQLite was built locally from the installed Node headers. No
workaround or dependency was added to this repository.

The tracked export was imported into a new n8n user directory and activated,
with `TENDER_API_URL=http://127.0.0.1:3000`. The API used a new disposable state
file. These are actual webhook executions, not pinned data or an illustrative
canvas.

| n8n execution | Scenario input                | HTTP  | Observed outcome                                                                                                      |
| ------------- | ----------------------------- | ----- | --------------------------------------------------------------------------------------------------------------------- |
| 1             | `clean.json`                  | `200` | `COMPLETED` + `READY_FOR_PRICING`; run `553a205e-60e2-4d5f-b6a7-5a4b612d472f`; `PRICING_HANDOFF_RECORDED`             |
| 2             | `needs-information.json`      | `200` | `COMPLETED` + `NEEDS_INFORMATION`; run `8c85802a-bcac-4a1f-9a4b-f5d1887f2986`; non-delivering receipt                 |
| 3             | `human-review.json`           | `200` | `COMPLETED` + `HUMAN_REVIEW`; run `2b70d31b-b441-4d22-b53f-25673bf2b3bf`; both synthetic contract source IDs retained |
| 4             | `pending.json`                | `202` | `PROCESSING` with no route; run `a0b4bb1f-ae44-42dc-b190-fdf5c3474849`; `PENDING`                                     |
| 5             | `duplicate.json` after clean  | `200` | `COMPLETED` + `DUPLICATE`; run `0c03acca-0506-4fea-8560-8213063cc882`; stopped without handoff                        |
| 6             | `clean.json` with API stopped | `502` | Correlated `TENDER_API_UNAVAILABLE` + `TECHNICAL_ERROR`; no successful business action                                |

The final API state contained five runs and exactly one pricing handoff. That
handoff belongs to the clean `READY_FOR_PRICING` run. All six n8n execution rows
reported `success`, because execution 6 correctly completed the workflow's
observable technical-error path.

During the first live pass, the HTTP Request node exposed a real export defect:
raw request-body mode caused n8n `1.112.6` to return a response stream instead of
the configured JSON full response. The export now uses n8n's JSON-body mode.
The clean-state matrix above is from the corrected, freshly re-imported export.

## Implementation review recorded on 4 October 2026

Review confirmed the workflow remains credential-free, has one HTTP Request node,
does not duplicate domain routing or initiate pricing, and covers every required
business and technical outcome. The review found and corrected one documentation
error: `GET /tenders` returns a run overview, not pricing handoffs or full rule
evidence. The walkthrough now inspects the disposable state for the sole handoff
and queries `GET /tenders/{runId}` for authoritative evidence detail. No
implementation blocker remains.

## Review and merge gate

- [x] Fresh import performed with n8n `1.112.6` and documented endpoint setting.
- [x] Actual execution IDs and observed outcomes are recorded for every scenario.
- [x] Export rechecked for credentials, secrets, real recipients/customer data,
      and machine-specific credential IDs.
- [x] Pull request URL recorded: https://github.com/MichaelJLow/tem-tender-readiness-engine/pull/19.
- [x] Merge commit recorded: `12f4c6c` on `main`.
- [x] Execution state confirms the API owns the sole `READY_FOR_PRICING` handoff.
- [x] Implementation review completed with no remaining code or documentation blocker.

Milestone 7 is accepted for the implemented local contract. Document
registration/upload and PDF intake remain deferred.
