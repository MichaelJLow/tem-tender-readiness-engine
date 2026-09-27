# Eval Findings and Lessons

This log records what release and PR evals teach us across runs. Machine-readable
outcomes and full metrics remain in `evals/reports/`; this document captures
human-reviewed causes, decisions, and follow-up work. All cases are synthetic.

## How to use this log

For each meaningful eval run, record its report link, dataset and prompt versions,
model, gate outcome, and material findings. Separate confirmed system defects
from model variability and incorrect fixture expectations. Do not change labels
only to make a gate pass: explain why the corrected label matches the documented
policy. Retain failed reports as diagnostic evidence; only a reviewed, passing
report can be considered for an accepted baseline.

## Runs

### Full release eval — 2026-09-26, prompt v4

- Report: [`full-2026-09-26T20-40-42.887Z.md`](../evals/reports/full-2026-09-26T20-40-42.887Z.md)
- Dataset: `tender-readiness-golden-v1`, 63 cases
- Model: OpenRouter `openai/gpt-6-luna`
- Verdict: **incomplete**; do not accept as a baseline
- Safety: 0 unsafe-ready outcomes across 44 safety cases; no non-ready case
  invoked the pricing gateway
- Failed gates: processing status 61/63; human-review recall 19/21; workflow
  critical-fact precision/recall 47/51 and 47/52; agent fact precision/recall
  50/57 and 50/52; ambiguity recall 9/11

#### Findings and disposition

1. **Broad source ambiguity caused avoidable review routes.** The adapter treated
   `sourceAssessment.ambiguous` as a critical fact even when the model had
   separately extracted a clear, attributable observation. This caused extra
   `TDR-010` results on otherwise clear evidence. Prompt v5 directs source
   assessments to describe relevance only, and deterministic routing now relies
   on ambiguity attached to observations and site associations. Unit coverage
   protects this separation. **Status: changed; full-suite retest in progress.**
2. **Some fixture labels did not match the workflow contract.** A duplicate
   replay expected extracted facts even though duplicate detection intentionally
   short-circuits interpretation. A note that merely referred to an unseen
   attachment was labelled ready despite providing no extracted fact. Both
   labels were corrected to reflect the documented behavior. **Status: changed;
   full-suite retest in progress.**
3. **One date fixture exceeded the documented parser formats.** The source used
   a month-name date while the synthetic date parser accepts ISO and numeric
   day-first dates. The fixture now uses an accepted numeric day-first value so
   this case tests extraction from an address-rich sentence, not a new date
   policy. **Status: changed; full-suite retest in progress.**
4. **Ambiguous site alternatives need explicit handling.** The model associated
   one “site A or site B” date with both sites in the v4 run. Prompt v5 now says
   alternatives must remain unassociated and ambiguous; this remains a model
   behavior to verify in the next report.
5. **Invalid structured outputs remain visible failures.** Two v4 cases,
   `ambiguous-two-consumption-values` and `unsupported-possible-meter`, ended in
   `MODEL_OUTPUT_INVALID`. The v5 prompt clarifies how to represent candidate
   values and partial meter identifiers. Do not hide future invalid outputs;
   they must keep the suite incomplete until resolved or explicitly accepted as
   a known model limitation under the release criteria.
6. **Observed safety controls held while quality gates failed.** Zero unsafe
   ready decisions and zero non-ready pricing calls are positive evidence for
   the tested cases, but they do not compensate for failed extraction, review,
   and processing gates.

#### Changes being evaluated next

- Prompt version v5 clarifies alternative site attribution, source-assessment
  semantics, date wording, conflicting candidate values, and incomplete meter
  identifiers.
- The adapter no longer turns broad source-assessment ambiguity into a separate
  critical ambiguity when the source's actual observations and site associations
  carry the actionable uncertainty.
- The full suite is being rerun. Add its final report and review the changed
  cases here before selecting any report as a baseline.

### Full release eval — 2026-09-26, prompt v5

- Report: [`full-2026-09-26T20-57-57.706Z.md`](../evals/reports/full-2026-09-26T20-57-57.706Z.md)
- Dataset: `tender-readiness-golden-v1`, 63 cases
- Model: OpenRouter `openai/gpt-6-luna`
- Verdict: **incomplete**; do not accept as a baseline
- Safety: 0 unsafe-ready outcomes across 44 safety cases; no non-ready case
  invoked the pricing gateway
- Gates: processing status 62/63; human-review recall 21/22 (passes its 95%
  threshold); workflow fact precision/recall 49/49 and 49/51; ambiguity recall
  11/12; the agent score in this report predates the duplicate-case and customer
  punctuation scoring corrections below

#### Findings and disposition

1. The ambiguous two-consumption-value case still returned
   `MODEL_OUTPUT_INVALID`; technical failure remains visible and prevents a
   completed release report.
2. The prompt change fixed the partial-meter output case, but over-escalation
   remains on clear evidence, and a document containing separate facts for two
   sites still hits `TDR-007`. These are open interpretation/workflow findings;
   the v5 report must not be treated as proof they are resolved.
3. The agent experiment initially included duplicate cases even though the
   workflow exits before interpretation. It also compared customer-name
   punctuation differently from workflow metrics. The agent suite now excludes
   duplicate short-circuits and uses the same trailing-punctuation tolerance.
   **Status: corrected in code; covered by tests and the current PR run.**

### PR eval — 2026-09-26, prompt v5

- Report: [`pr-2026-09-26T21-15-52.823Z.md`](../evals/reports/pr-2026-09-26T21-15-52.823Z.md)
- Dataset: 14 cases; verdict **pass**; suite completed
- Experiments: agent `d9a5f827-3c46-4092-a9f3-b37a025af03c`, workflow
  `d77b8868-8b42-47ef-a26f-9819ebf52b72`
- This validates the fast PR gates only; it does not replace the incomplete full
  run or the remaining manual QA.

### Refreshed full release eval — 2026-09-26, prompt v5

- Report: [`full-2026-09-26T21-20-41.568Z.md`](../evals/reports/full-2026-09-26T21-20-41.568Z.md)
- Dataset: `tender-readiness-golden-v1`, 63 cases
- Model: OpenRouter `openai/gpt-6-luna`
- Verdict: **incomplete**; do not accept as a baseline
- Safety: 0 unsafe-ready outcomes across 44 safety cases; no non-ready case
  invoked pricing
- Completed quality gates: human-review recall 21/22 (95.5%); workflow
  critical-fact precision/recall 49/49 and 49/51; agent fact precision/recall
  51/51 and 51/51
- Incomplete/failed gates: technical processing 62/63 because
  `ambiguous-two-consumption-values` returned `MODEL_OUTPUT_INVALID`; ambiguity
  recall 11/12
- Route-level misses include clear cases over-routed to `HUMAN_REVIEW`. These
  remain visible in the report and need case-by-case review; passing precision
  and safety checks do not erase them.
- The refreshed run includes the corrected agent-only case selection and
  customer-name normalization. **Status: current full-run evidence; not accepted
  as a release baseline.**

### PR eval after harness fixes — 2026-09-26, prompt v5

- Report: [`pr-2026-09-26T22-23-59.188Z.md`](../evals/reports/pr-2026-09-26T22-23-59.188Z.md)
- Dataset: 14 cases; verdict **pass**; suite completed; all 7 configured gates
  passed
- Experiments: agent `8a7052c3-d4ec-40e7-a945-8fbd7e9b0c7c`, workflow
  `148b8e4f-f0e0-462c-a8a8-1db33f9b1d2a`
- The revised pricing gate, case-scoped metric matching, agent-result
  reconciliation, and interrupted-Studio reporting passed their deterministic
  regression checks. The live PR run confirms the fast subset only.

### Full release eval after harness fixes — 2026-09-26, prompt v5

- Report: [`full-2026-09-26T22-25-24.194Z.md`](../evals/reports/full-2026-09-26T22-25-24.194Z.md)
- Dataset: `tender-readiness-golden-v1`, 63 cases; model OpenRouter
  `openai/gpt-6-luna`
- Verdict: **incomplete**; do not accept as a baseline
- Experiments: agent `c7adbe1e-b682-442e-95a2-24b0122514e6`, workflow
  `df5f5ed8-b002-42c9-ba01-bfc6deaa5327`
- Safety checks: 0 unsafe-ready decisions across 44 cases and 0 non-ready
  pricing calls. Critical fact extraction was 49/49 workflow and 51/51 agent;
  human-review recall was 21/22 (95.5%).
- Failed gates: processing 62/63 because `ambiguous-two-consumption-values`
  returned `MODEL_OUTPUT_INVALID`; ambiguity recall was 11/12 (91.7%).
- Manual case review confirmed the clean structured tender,
  `second-site-missing-consumption`, conflicting-date case, ambiguous multi-site case, duplicate replay,
  and pending-document case matched their expected route/status and pricing
  handoff. The malformed model output failed closed with no route or handoff.
- Clear cases remain over-routed to `HUMAN_REVIEW`, including
  `ready-two-facts`, `ready-second-site-consumption-note`,
  `missing-consumption-evidence`, and multiple
  missing-information cases. Human-review precision is 72.4% (21/29). Review
  the affected cases and document their disposition before accepting a
  baseline; passing safety checks do not resolve this quality issue.
- The plan's provider-timeout fixture and expired-trace scenario were not
  exercised by this run. The interrupted-Studio path was separately verified
  by an injected startup failure, which wrote an incomplete report and exited
  nonzero. **Status: earlier diagnostic; manual QA and baseline acceptance
  remain incomplete.**

### Studio-backed reruns — 2026-09-26, prompt v5

- PR report: [`pr-2026-09-26T22-44-18.426Z.md`](../evals/reports/pr-2026-09-26T22-44-18.426Z.md).
  All 14 cases ran and all 7 configured gates passed. Studio experiments:
  agent `a83bc434-f0f9-4388-8e34-cc5f9418ad67`, workflow
  `bc1530af-fef6-443f-ae73-c932af912623`.
- Full report: [`full-2026-09-26T22-45-48.864Z.md`](../evals/reports/full-2026-09-26T22-45-48.864Z.md).
  All 63 cases were attempted; the verdict is **incomplete** because
  `ambiguous-two-consumption-values` ended in `MODEL_OUTPUT_INVALID` rather
  than the expected completed human-review route. Processing matched 62/63
  labels; ambiguity recall was 11/12. Human-review recall was 21/22 and
  precision was 21/30; 0 unsafe-ready outcomes and 0 non-ready pricing calls.
  Studio experiments: agent `573d71b4-c5df-473d-91a1-4d2c97c08129`,
  workflow `7e89714a-ba94-4ad0-8fce-446a338229a2`.
- The immediately preceding runs at 22:23 and 22:25 wrote to a separate local
  store and remain diagnostic evidence. These reruns use the Studio store on
  port 4113 and are the current reports for review.

### Studio persistence and manual QA confirmation — 2026-09-26

- Confirmed the PR and full eval datasets and experiments are present in the
  same local Mastra Studio store served on port 4113. The `/api/datasets` and
  `/api/experiments` read-only endpoints return the records linked from the
  reports above. This resolves the earlier mismatch where evals were written
  to a second `data/` directory and were not visible to Studio.
- Manual case review covered a clean ready case, missing consumption evidence,
  conflicting dates, ambiguous multi-site evidence, duplicate replay, pending
  required documents, and invalid model output. The invalid output failed
  closed with no business route and no pricing handoff; the other reviewed
  cases showed the expected safety behavior. The full report still identifies
  over-escalation on clear or missing-information cases.
- Provider-timeout behavior and expired-trace handling remain unverified.
  The full run is incomplete due to `MODEL_OUTPUT_INVALID`, and the remaining
  route mismatches need disposition. **Status: Studio record visibility
  confirmed; manual QA and baseline acceptance remain incomplete.**

### Accepted Milestone 4 synthetic baseline — 2026-09-26

- PR report: [`pr-2026-09-26T23-30-23.599Z.md`](../evals/reports/pr-2026-09-26T23-30-23.599Z.md),
  14/14 cases and all 7 gates passed.
- Release report: [`full-2026-09-26T23-53-52.654Z.md`](../evals/reports/full-2026-09-26T23-53-52.654Z.md),
  63/63 processing statuses and 63/63 expected routes and pricing counts;
  all 7 gates passed. The golden safety set had 0/44 unsafe-ready outcomes,
  human-review recall was 22/22, ambiguity recall was 12/12, and no non-ready
  case called pricing. Workflow critical-fact precision and recall were 49/51
  (96.1%); the agent experiment was 51/51. The accepted report is identified
  by [`accepted-baseline.json`](../evals/accepted-baseline.json).
- Manual QA inspected `ready-structured-single`, `ready-structured-multi`,
  `ready-two-site-meters-document`, `missing-consumption-evidence`,
  `duplicate-replay`, `conflicting-date-structured`,
  `ambiguous-multisite-date`, `ambiguous-two-consumption-values`,
  `ready-two-facts`, `required-document-pending`,
  `required-document-unreadable`, and `injection-missing-consumption`.
  Their routes, processing statuses, rule flags, and mock pricing counts
  matched the labels. Stored agent quotes and site associations were reviewed
  for the conflict, ambiguity, and two-site document cases. The two-site
  document has separate cited sentences for each site; a shared ambiguous
  quote still routes to review in the deterministic regression test.
- The provider-timeout test verifies a retryable `MODEL_PROVIDER_FAILED` with
  a failed trace. The service replay test verifies a later successful attempt
  under the same idempotency key and one recorded pricing handoff. The JSON
  release report was parsed with all 63 outcomes and 2 Studio experiment IDs
  while Studio was stopped, confirming that the durable report can be read
  without live traces.
- The two workflow fact mismatches are the second and third dates in
  `conflicting-three-date-values`: the model left their site IDs unset because
  their individual quoted clauses do not name a site. The case still routed
  to `HUMAN_REVIEW` with no pricing call. Labels remain unchanged; this is a
  recorded attribution limitation within the accepted 95% threshold.
- The final live run followed two diagnostic interruptions. The Studio dev
  supervisor held DuckDB until stopped; later, OpenRouter refused requests
  whose default maximum output was 65,536 tokens. The agent now limits output
  to 8,192 tokens. Both interruptions produced incomplete reports rather than
  false passes. The accepted report records a dirty working tree because the
  verified fixes had not yet been committed at run start.

**Manual QA disposition:** complete for the synthetic Milestone 4 prototype.
**Baseline disposition:** accepted for this milestone; review the report and
local changes in PR #8 before merge. This does not assess real tender data or
model behaviour beyond the labelled dataset.

## Follow-up log

| Date       | Report                        | Finding / decision                                     | Status                                    |
| ---------- | ----------------------------- | ------------------------------------------------------ | ----------------------------------------- |
| 2026-09-26 | v4 full release run           | Documented above; multiple quality gates failed        | Retained as diagnostic                    |
| 2026-09-26 | v5 full release run           | One invalid model output and remaining over-escalation | Retained as diagnostic                    |
| 2026-09-26 | v5 PR run                     | All configured PR gates passed                         | Reviewable; not an accepted full baseline |
| 2026-09-26 | refreshed v5 full release run | Agent scoring clean; one invalid model output remains  | Current diagnostic; not baseline          |
| 2026-09-26 | post-fix v5 PR run            | All 7 configured PR gates passed                       | Reviewable; not an accepted full baseline |
| 2026-09-26 | post-fix v5 full release run  | Safety held; invalid output and over-routing remain    | Manual QA incomplete; not a baseline      |
| 2026-09-26 | bounded v5 full release run   | All 7 gates and 63 expected routes passed              | Accepted synthetic prototype baseline     |
