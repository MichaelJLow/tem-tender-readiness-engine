# ENG-14 release QA receipt

This is the Milestone 9 release-evidence packet for
[ENG-14](https://linear.app/workwithlayer/issue/ENG-14/complete-final-release-evals-and-manual-demo-qa).
It records what was run on source `2e725d91c8aad75319a15630779c3420810e689c`
(`main` after ENG-12; ENG-13 later added reviewer-facing documentation only),
what was already proven by earlier issues, and the remaining gap. All tenders
and reports are synthetic.

The accepted baseline is unchanged. Latest completed results were not promoted.

## Verdict

| Gate                            | Result                               | Evidence                                                                                                                                                      |
| ------------------------------- | ------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Deterministic checks and builds | Pass                                 | `npm run check` (243 tests), `npm run build:api`, `npm run build:console`                                                                                     |
| Full labelled release suite     | **not_run / incomplete**             | [`evals/reports/full-2026-10-05T02-17-47.688Z.md`](../../evals/reports/full-2026-10-05T02-17-47.688Z.md)                                                      |
| Manual stratified QA            | Completed for inspectable demo paths | This receipt, [`eng-14-manual-qa.json`](eng-14-manual-qa.json), [`stratified-http-evidence.json`](stratified-http-evidence.json), [screenshots](screenshots/) |
| `evals/release-evidence.json`   | **Not created**                      | No completed passing clean full report exists for this source                                                                                                 |
| Accepted baseline promotion     | **Not done**                         | `evals/accepted-baseline.json` still points at `full-2026-09-26T23-53-52.654Z`                                                                                |
| Thresholds                      | Unchanged                            | `evals/thresholds.json`                                                                                                                                       |

Empty denominators in the not-run report fail the corresponding gates, as
required by `docs/eval-strategy.md`. The pricing-guard gate on that report
passes only because zero cases ran and therefore zero non-ready pricing calls
occurred. That is not a release pass.

## Why a live full eval was not repeated

`npm run eval:full` was invoked from a clean checkout of
`2e725d91c8aad75319a15630779c3420810e689c`. No `OPENROUTER_API_KEY`,
`OPENAI_API_KEY`, or generic `MODEL_API_*` credentials are present in this
remote environment. The runner wrote an explicit `not_run` report and exited
unsuccessfully. That is the configured contract: missing credentials must not
be treated as success.

This remote session cannot see a maintainer `.env`. ENG-1 already recorded that
cloud sessions work from published commits only. No provider key was purchased
or invented to test eval plumbing.

Existing full reports cannot be reused as official release evidence:

- Every retained `full-*.json` report has `gitDirty: true`.
- `verifyReport` rejects dirty evidence.
- Relevant sources under `apps/`, `packages/`, and `evals/` (except reports and
  evidence pointers) changed after the last passing full run
  (`full-2026-09-28T19-39-31.237Z`, SHA `4895d8b`).
- Dataset hash is still `b99e956923d65884a7eb6fe42ee13ca9c0e87b85456cfbb26b9d928ed2a50708`,
  matching the accepted baseline. A later clean full run on this dataset can
  still be compared. That comparison was not executed with a provider.

Studio was not running. The not-run command did not import Mastra or share the
Studio store. Studio cannot be started here without a provider key
(`createTenderInterpretationAgent` refuses an unconfigured key). Port `4113`
remains reserved for this repository.

## What was already covered (do not rebuild)

| Issue                 | Already proven                                                                                                                  | Reused here                                                                                   |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| ENG-11                | Console build in CI; credentialless PR/release evidence gates; CODEOWNERS on baseline and QA paths                              | Gates left intact; no silent promotion                                                        |
| ENG-4 / ENG-2 / ENG-3 | Local archive/restore and live private S3 restore + Console walkthrough                                                         | Local archive/restore reproduced; live S3 not rerun                                           |
| ENG-7                 | Fresh n8n `1.112.6` import and six webhook executions                                                                           | Workflow tests rerun; live n8n runtime not present in this environment                        |
| ENG-12                | Visible failure → no unsafe action → safe recovery                                                                              | `tests/reliability-rehearsal.test.ts` rerun (plus n8n workflow tests: 37 passing)             |
| Milestone 4           | Passing dirty full run `full-2026-09-28T19-39-31.237Z` on 63 cases, 9/9 gates, 0 unsafe-ready, 0 non-ready pricing, 51/51 facts | Inspected as portable labelled evidence only; not accepted as this release's clean full suite |

## Stratified manual QA

Structured cases were submitted to a disposable API. Console review used the
three-case seed required by the archive contract. Extra cases used a second
API on port `3002` so the archive state stayed exactly three runs and one
ready-only handoff.

| Checklist item             | How it was inspected                                                                                                           | Observed route / effect                                                                                                       |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------- |
| Clean happy path           | Seeded `tender-clean-001`; Console detail                                                                                      | `READY_FOR_PRICING` / `COMPLETED`; no review form                                                                             |
| Multi-site happy path      | Structured two-site tender                                                                                                     | `READY_FOR_PRICING` / `COMPLETED`                                                                                             |
| Missing information        | Seeded missing consumption; Console detail                                                                                     | `NEEDS_INFORMATION`; TDR-004 blocking; no review action                                                                       |
| Duplicate                  | n8n `clean.json` then `duplicate.json` (same `tenderId`, new key)                                                              | First `READY_FOR_PRICING`; second `DUPLICATE`; no extra handoff                                                               |
| Contract-date conflict     | Seeded conflicting dates; Console evidence + review                                                                            | `HUMAN_REVIEW`; 2027-03-31 vs 30/09/2026; `REQUEST_INFORMATION` cites `site-001`, `contract-a`, `contract-b`; route unchanged |
| Site-association ambiguity | Structured `documentSiteAssociations.status=AMBIGUOUS`                                                                         | `HUMAN_REVIEW`                                                                                                                |
| Model uncertainty          | Structured `criticalFacts` with `ambiguous: true` and confidence `0.2`                                                         | `HUMAN_REVIEW`                                                                                                                |
| Previous regression        | n8n second intake of an active tender; labelled `duplicate-prior-regression` / validator cases inspected in the 28 Sept report | Live API-owned duplicate as above; labelled report still `DUPLICATE` / expected `HUMAN_REVIEW` on the earlier dirty full run  |
| Technical retry/replay     | ENG-12 rehearsal tests rerun; restored clean replay                                                                            | 37 tests pass; restored replay `replayed: true`, still `runs=3`, `handoffs=1`                                                 |
| Pricing gateway guard      | Console seed replay; extra-state handoff inventory; latest completed report                                                    | One handoff on the ready seed only; extra state `nonReadyWithHandoff=false`; latest completed report 0/63 non-ready pricing   |

Client-supplied `signals.duplicate` is not trusted. The API overwrites it from
stored tender identity. Posting the `duplicateTender` fixture without an
existing same-`tenderId` run therefore returned `READY_FOR_PRICING`. That is
not a live duplicate and was not treated as one.

## Console, n8n, S3, ready-only handoff

- **Console review history:** recorded `REQUEST_INFORMATION` on the conflict
  case. Route stayed `HUMAN_REVIEW`. Clean and missing cases offer no review
  action. Performance still shows accepted `full-2026-09-26T23-53-52.654Z`
  separately from latest completed `full-2026-09-28T19-39-31.237Z`. The
  5 Oct not-run report is excluded from "latest" because it is not
  `suiteStatus=completed`.
- **Local S3-shaped archive:** snapshot
  `snapshot-2026-10-05T02-31-45-772Z-d5c67fc7-3fec-472f-ba40-c66925f43c7c`
  (six members). Restore into `data/eng14-restored-local` reproduced the three
  routes, the review citations, distinct accepted/latest reports, and one
  ready-only handoff. Replay after restore did not add a handoff. Live AWS
  upload was not repeated; ENG-4 already accepted that path.
- **n8n:** `integrations/n8n/workflow.test.ts` passed. The n8n fixtures were
  also posted directly to the API and produced the documented routes, including
  pending `202` / `PROCESSING` with no route. Docker / n8n `1.112.6` was not
  available in this environment, so the fresh-runtime webhook matrix was not
  re-executed. ENG-7 remains the live runtime receipt.
- **Ready-only handoff:** console state after seed + review + replay is
  `runs=3`, `handoffs=1` (`tender-clean-001` only). Extra-state ready tenders
  each have one handoff; non-ready runs have none.

Screenshots from this walkthrough: `screenshots/queue.webp`,
`screenshots/conflict-review.webp`, `screenshots/review-history.webp`,
`screenshots/ready-clean.webp`, `screenshots/missing-information.webp`,
`screenshots/performance.webp`. Earlier Milestone 5 PNG captures remain in
`docs/screenshots/operations-console/`.

## Report review and sign-off

Reviewed by the ENG-14 agent run acting for MichaelJLow.

- Retained the 5 Oct not-run report as diagnostic evidence.
- Did not lower thresholds.
- Did not point `evals/release-evidence.json` at an incomplete or dirty report.
- Did not change `evals/accepted-baseline.json`.
- Manual QA of the inspectable demo paths is signed off in
  [`eng-14-manual-qa.json`](eng-14-manual-qa.json) (`sourceSha` =
  `2e725d91c8aad75319a15630779c3420810e689c`).
- The complete full-run verdict required for a stable interview release is
  **not** signed off until a maintainer runs `npm run eval:full` from a clean
  checkout with the configured OpenRouter/OpenAI credentials, the report is
  `completed` + `pass` + `gitDirty: false`, and
  `npm run evidence:release` verifies a new `evals/release-evidence.json`
  pointer plus a manual-QA record whose `sourceSha` matches that report.

A later clean full run should keep the current thresholds and the current
accepted baseline unless a reviewer explicitly promotes a new baseline.
