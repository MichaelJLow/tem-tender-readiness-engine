# Release QA receipts

Milestone 9 / [ENG-14](https://linear.app/workwithlayer/issue/ENG-14/complete-final-release-evals-and-manual-demo-qa)
is the V1 release-evidence packet below. Milestone 10 / [ENG-24](https://linear.app/workwithlayer/issue/ENG-24/intake-pack-safety-eval-evidence-and-runbook)
adds Intake pack safety and Console QA as a **sibling** receipt. It does not
replace ENG-14, retarget `evals/release-evidence.json`, or promote the accepted
baseline.

| Packet             | What it is                                                                |
| ------------------ | ------------------------------------------------------------------------- |
| ENG-14 (this file) | V1 full eval + stratified demo QA on source `9fbf16f`                     |
| ENG-24             | Intake pack HTTP/Console QA; deterministic safety tests; runbook handover |

# ENG-24 Intake pack QA receipt

Milestone 10 / [ENG-24](https://linear.app/workwithlayer/issue/ENG-24/intake-pack-safety-eval-evidence-and-runbook)
is a **sibling** of the ENG-14 V1 packet. It does not retarget
`evals/release-evidence.json` or promote the accepted baseline.

| Gate                        | Result                                                                                       | Evidence                                                                                                                                                                                                            |
| --------------------------- | -------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Deterministic Intake safety | Pass on source `186dba5`                                                                     | Domain/API/console tests plus [`tests/intake-pack-safety.test.ts`](../../tests/intake-pack-safety.test.ts). CI [`37376974868`](https://github.com/MichaelJLow/tem-tender-readiness-engine/actions/runs/37376974868) |
| HTTP matrix                 | Empty confirm, multi-site no leakage, OCR visible, stale 409, ready-only handoff             | [`eng-24-intake-http-evidence.json`](eng-24-intake-http-evidence.json) via `npx tsx scripts/run-intake-pack-qa.ts`                                                                                                  |
| Console walkthrough         | Drop → extract → empty fields → operator save → confirm; OCR kept; warehouse/retail isolated | [`eng-24-manual-qa.json`](eng-24-manual-qa.json), [screenshots](#eng-24-screenshots)                                                                                                                                |
| Pricing guard               | 1 mock handoff (`tender-clean-001` only) after 6 Intake confirms                             | Queue screenshot; isolated `data/eng24-qa/tender-state.json` inventory                                                                                                                                              |
| Local confirm without a key | `MODEL_PROVIDER_FAILED`, no business route                                                   | Case-detail screenshot. Confirm maps notes/pages as `textSources`; this environment has no provider key. Tests still cover `NEEDS_INFORMATION` / `HUMAN_REVIEW` with `EmptyInterpreter`.                            |
| Labelled eval pointers      | Unchanged                                                                                    | `evals/pr-evidence.json` / `evals/release-evidence.json` still ENG-14. Dataset hash unchanged. Zero unsafe-ready remains the gate.                                                                                  |

PR: [tem-tender-readiness-engine#32](https://github.com/MichaelJLow/tem-tender-readiness-engine/pull/32).

### ENG-24 screenshots

Real Console captures at a 1500px-wide, full-page viewport against a disposable loopback API. All packs are synthetic.

- [Drop](screenshots/eng-24-01-intake-drop.png) — Intake pack with no tender form; synthetic-data notice; PDF limits.
- [Extract](screenshots/eng-24-02-single-site-extracted.png) — `pack-clean-single-site` stored as immutable evidence; Open review.
- [Empty review fields](screenshots/eng-24-03-review-empty-fields.png) — Customer/broker stay Empty; candidates do not fill fields.
- [Operator save](screenshots/eng-24-04-review-operator-saved.png) — Typed warehouse values at draft version 2.
- [Confirm case](screenshots/eng-24-05-confirm-case-detail.png) — Existing case detail; `FAILED` / `MODEL_PROVIDER_FAILED`; no `READY_FOR_PRICING`.
- [OCR required](screenshots/eng-24-06-ocr-required.png) — `scanned-invoice.pdf` remains listed; 0 extracted characters.
- [Warehouse](screenshots/eng-24-07-multi-warehouse.png) — MPAN `1234567890123` on warehouse; retail meter absent.
- [Retail](screenshots/eng-24-08-multi-retail.png) — MPAN `2345678901234` on retail; warehouse meter absent.
- [Queue](screenshots/eng-24-09-queue.png) — Ready for pricing = 1 (`tender-clean-001`); Intake confirms have no final route.

Walkthrough: [runbook Intake pack](../runbook.md#console-intake-pack-milestone-10).

# ENG-14 release QA receipt

This is the Milestone 9 release-evidence packet for
[ENG-14](https://linear.app/workwithlayer/issue/ENG-14/complete-final-release-evals-and-manual-demo-qa).
It records the clean full-eval result on source `9fbf16f71cb5afef7b91ccabf74920a1feb116d3`, the stratified demo QA, and evidence reused from ENG-4 and ENG-7. All tenders and reports are synthetic.

The accepted baseline remains unchanged; the passing full report is selected for this release packet.

## Verdict

| Gate                            | Result                               | Evidence                                                                                                                                                      |
| ------------------------------- | ------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Deterministic checks and builds | Pass                                 | `npm run check` (243 tests), `npm run build:api`, `npm run build:console`                                                                                     |
| Full labelled release suite     | Pass — 9/9 gates                     | [`full-2026-10-05T14-22-22.835Z.md`](../../evals/reports/full-2026-10-05T14-22-22.835Z.md), source `9fbf16f`                                                  |
| Manual stratified QA            | Completed for inspectable demo paths | This receipt, [`eng-14-manual-qa.json`](eng-14-manual-qa.json), [`stratified-http-evidence.json`](stratified-http-evidence.json), [screenshots](screenshots/) |
| `evals/release-evidence.json`   | Selected                             | Passing full report plus the matching QA record; verified by `npm run evidence:release`                                                                       |
| Accepted baseline promotion     | **Not done**                         | `evals/accepted-baseline.json` still points at `full-2026-09-26T23-53-52.654Z`                                                                                |
| Thresholds                      | Unchanged                            | `evals/thresholds.json`                                                                                                                                       |

The earlier not-run report remains historical diagnostic evidence; its empty-denominator gates correctly failed. The completed clean full suite summarized below is the report selected for this release packet.

## Full provider-backed release eval

The full suite ran on clean PR source `9fbf16f71cb5afef7b91ccabf74920a1feb116d3` using the configured OpenRouter provider and the accepted dataset hash `b99e956923d65884a7eb6fe42ee13ca9c0e87b85456cfbb26b9d928ed2a50708`.

- The first run, [`full-2026-10-05T14-11-56.671Z`](../../evals/reports/full-2026-10-05T14-11-56.671Z.md), completed all 63 cases but was incomplete because `conflicting-three-date-values` emitted no labelled facts (agent facts 48/51). Route, safety, ambiguity, and pricing-guard gates passed. The critical-fact-recall and baseline gates failed. The report remains diagnostic.
- The second run on the same clean source, [`full-2026-10-05T14-22-22.835Z`](../../evals/reports/full-2026-10-05T14-22-22.835Z.md), completed 63/63 and passed all 9 gates: agent facts 51/51, unsafe-ready 0/44, all expected routes and handoffs 63/63, and zero non-ready pricing calls. The formerly failing two-site document case returned `READY_FOR_PRICING` with one mock handoff.
- The source and thresholds did not change between these runs. The first run is retained to show the model-output variation; thresholds were not lowered and the accepted baseline was not changed.

The passing report is selected by `evals/release-evidence.json`. The release evidence verifier confirms that the report is clean, passing, comparable to the accepted baseline, and shares source SHA `9fbf16f71cb5afef7b91ccabf74920a1feb116d3` with the QA record.

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

The ENG-14 agent run reviewed the clean report, the same-revision diagnostic attempt, and the existing stratified QA receipt.

- The passing full report is selected in `evals/release-evidence.json`; `npm run evidence:release` verified it and the matching QA record for source `9fbf16f71cb5afef7b91ccabf74920a1feb116d3`.
- The first clean full run is retained as diagnostic evidence. No threshold or accepted-baseline changes were made.
- The existing Console/API/archive walkthrough remains the manual evidence. The two-site document case was exercised in the passing full eval. The proposed deterministic association fix and its targeted regression test are not in the evaluated source or this PR; that investigation remains follow-up work. Live Console review, n8n runtime, and private S3 restore were not repeated on this revision; ENG-7 and ENG-4 remain those receipts.
- Code-owner review is still required before merging. A passing full eval does not itself promote the accepted baseline.
