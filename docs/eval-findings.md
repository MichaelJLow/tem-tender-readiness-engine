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

## Follow-up log

| Date       | Report                        | Finding / decision                                     | Status                                    |
| ---------- | ----------------------------- | ------------------------------------------------------ | ----------------------------------------- |
| 2026-09-26 | v4 full release run           | Documented above; multiple quality gates failed        | Retained as diagnostic                    |
| 2026-09-26 | v5 full release run           | One invalid model output and remaining over-escalation | Retained as diagnostic                    |
| 2026-09-26 | v5 PR run                     | All configured PR gates passed                         | Reviewable; not an accepted full baseline |
| 2026-09-26 | refreshed v5 full release run | Agent scoring clean; one invalid model output remains  | Current diagnostic; not baseline          |
