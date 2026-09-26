# Milestone 4: Eval system plan

## Outcome

Deliver a reproducible, synthetic evaluation system for the Tender Interpretation Agent and the complete tender decision path. Mastra Studio should support inspecting datasets, experiments, scores, and traces. A versioned report should retain the evidence needed to review a release and later populate the Milestone 5 operations console after transient Studio traces expire. A safety regression must produce an explicit failing verdict.

## Context and evidence

- `docs/implementation-plan.md` calls for a hand-authored golden set, 60–100 total cases, route and extraction metrics, a fast PR subset, a full release suite, safety gates, and manual QA. `docs/eval-strategy.md` defines the initial thresholds and prioritizes unsafe `READY_FOR_PRICING` decisions.
- `AGENTS.md` requires deterministic policy outside the model, synthetic fixtures, and a hard pricing guard. The agreed Milestone 3 boundary allows model facts only as evidence and conflict signals; they cannot fill missing structured tender fields.
- The Milestone 3 local worktree contains `apps/api/src/mastra/index.ts`, which registers one agent with local LibSQL dataset/experiment storage and DuckDB observability storage. `tests/studio-smoke.mjs` seeds eight synthetic cases and starts a Studio experiment, but its ground truth is descriptive text and it has no numeric scorer or release gate.
- `apps/api/src/service.ts` invokes the interpreter when text sources exist, then applies `evaluateReadiness`. The API process and Studio process currently have separate runtime traces; `docs/adr/001-bounded-mastra-agent.md` records that limitation. A Studio agent experiment alone cannot prove the final route or pricing guard.
- The checked-out root is an older, dirty `feat/domain-core` worktree; the separate Milestone 3 worktree is also dirty. Both are preserved. Before implementation, use an updated, isolated checkout based on the merged main branch and reconcile this plan against its actual files. No Git metadata operation is part of this plan.

This is an elevated, single-repository plan. The user selected elevated planning and clarified that LayerOS policy does not govern this independent portfolio project.

## Decisions and assumptions

1. The canonical eval cases and accepted reports live in Git. Mastra datasets, experiments, traces, and metrics remain useful interactive records, but are not the sole copy of release evidence. Case and report files contain synthetic data only.
2. Keep Mastra's existing agent and Studio. Use its dataset, experiment, scorer, and trace views for agent-level inspection. Expose the complete decision path as a thin eval-only Mastra workflow target that delegates to the existing application/domain code with isolated state and a mock pricing gateway, so both evaluations can be inspected in Studio. Verify workflow experiment support in the installed version before implementation. If that integration cannot safely provide the full path, record the limitation and discuss the programmatic report fallback before changing this outcome.
3. The model's extracted facts are scored as evidence and conflict detection. Missing required structured fields remain missing. Every full-path case checks route, processing status, evidence/flags, and pricing-handoff count.
4. Use the current local Mastra storage during Milestone 4. Mastra Platform Starter and its 15-day hosted observability retention are a possible hosting choice, not a Milestone 4 dependency. ClickHouse and the $250/month Mastra Teams plan are not selected.
5. Keep authored cases, baseline comparisons, and accepted reports indefinitely in the repository. Raw traces are diagnostic data; decide their hosted retention and any weekly archive only after proving a complete export/retrieval path and pricing it. Do not describe a scheduled archive as reliable before that proof.
6. All thresholds, denominators, dataset hashes, and verdict rules are versioned. A missing model run, incomplete experiment, absent denominator, or unavailable API key is reported as **not run/incomplete**, never as a pass.

## Scope

### In scope

- A typed, schema-validated case format and roughly 30 hand-authored golden cases, expanded to 60–100 reproducible synthetic cases before Milestone 4 is marked complete.
- Balanced clean, missing, duplicate, conflict, multi-site, ambiguous, malformed-evidence, prompt-injection, provider-failure, and prior-regression categories; a named safety subset and a 10–20 case PR subset.
- Agent evidence scoring and complete-path route/safety scoring, including category and per-case results.
- A machine-readable report and readable Markdown summary with run metadata, exact denominators, failures, baseline comparison, safety verdict, and Studio experiment/trace references when available.
- Mastra Studio dataset/experiment integration, local run instructions, model-call cost controls, a manual QA checklist, and CI/release gate wiring appropriate to credential availability.
- A read-only report contract that Milestone 5 can consume for its performance view and case-detail links.

### Out of scope

- Building the operations console, human-review actions, or operational audit store (Milestone 5).
- Hosted Mastra subscription, AWS runtime/storage, ClickHouse, weekly archive job, and raw-trace migration (later hosting/observability milestones).
- PDF extraction, real tenders, new business policy, real pricing, or a second routing engine inside Mastra.
- A claim that aggregate eval scores prove production safety; the dataset and thresholds remain synthetic demonstration evidence.

## High-level technical design

Use a single versioned case source with stable IDs, categories, structured tender input, text/document-text sources, expected route/status, expected safety flags, and expected extractable facts with source/site attribution. Use a deliberate `unknown` or ambiguity expectation when no safe fact should be emitted. Validate cases before any model call. Generate or seed Mastra dataset items from that source; never maintain a separate hand-edited Studio-only answer key.

Run two complementary evaluations:

1. **Interpretation:** invoke the registered Mastra agent on applicable text cases and score factual value, citation/source match, site attribution, ambiguity/abstention, and conflict recognition. A missing structured field mentioned in text must remain evidence rather than a completed tender field.
2. **Decision path:** submit each case through the existing service/domain path, exposed through a thin eval-only Mastra workflow, using fresh isolated state and a mock pricing gateway. Score route and technical status separately. Record rule flags, model failure classification, and gateway call count. Never invoke a shared local tender state file during evals.

The report writer consumes case outcomes, not Studio database tables. It produces versioned JSON for code/UI and Markdown for reviewers. Include git SHA, dataset hash/version, prompt version, provider and model ID, run timestamp, runner version, experiment IDs where available, case count, per-class support, confusion matrix, extraction denominator, latency/token/cost when reported, individual failures, and threshold verdicts. Omit credentials and redact any accidental non-synthetic content before writing. Compare baselines only for the same dataset version, or label the comparison non-comparable.

**Safety gate:** zero unsafe `READY_FOR_PRICING` on the golden safety set, `HUMAN_REVIEW` recall at least 95%, critical-field extraction accuracy at least 95%, no material safety regression against a comparable accepted baseline, and no non-ready/pending case calling pricing. The initial small set may require 100% review recall to clear 95%; show raw numerator and denominator. Incomplete runs cannot receive a passing release verdict.

## Implementation units

### U-001 — Establish canonical labelled cases

- **Depends on:** none.
- **Files:** proposed `evals/cases/`, `evals/schema.ts` (or equivalent typed fixture location); existing `docs/eval-strategy.md` and `tests/studio-smoke.mjs` for migration/discovery.
- **Outcome:** stable IDs and validated input/ground-truth fields; approximately 30 hand-authored golden cases first, then 60–100 total with balanced safety classes. No case uses real customer data.
- **Check:** duplicate IDs, invalid expected routes, missing source references, and contradictory labels fail validation before model invocation. A fixed seed regenerates any derived fixtures identically.

### U-002 — Define metrics, thresholds, and portable report contract

- **Depends on:** U-001.
- **Files:** proposed `evals/metrics.ts`, `evals/report.ts`, `evals/thresholds.json`, `evals/reports/`; `docs/eval-strategy.md`.
- **Outcome:** per-route precision/recall and support, unsafe-ready count/rate, review recall, critical extraction accuracy, abstention/site attribution results, and a versioned JSON + readable Markdown report. Explicit policy for failed/incomplete cases and zero denominators.
- **Check:** known synthetic outcome arrays yield the expected confusion matrix and verdict; a failed model run or missing class support never yields an artificial 100% score.

### U-003 — Run agent experiments in Mastra Studio

- **Depends on:** U-001, U-002.
- **Files:** `apps/api/src/mastra/index.ts`, `tests/studio-smoke.mjs`, proposed `evals/mastra-dataset.ts` and scorer files, as needed.
- **Outcome:** seed the canonical cases into a versioned Studio dataset, run the agent target with registered scorers, and record experiment IDs and score links in the report. Confirm workflow-target support in the installed Mastra version before U-004.
- **Check:** the same case ID/ground truth is visible in Studio and in the Git report, scored outcomes can be inspected by case, and rerunning does not silently mutate a prior dataset version.

### U-004 — Evaluate the complete tender decision path

- **Depends on:** U-001, U-002; optionally U-003 for Studio workflow display.
- **Files:** existing `apps/api/src/service.ts`, `apps/api/src/reasoning/`, `packages/domain/src/`; proposed `evals/run-decision-path.ts` and isolated test adapters.
- **Outcome:** run the current service and deterministic policy through a thin eval-only Studio workflow target with fresh per-case state and a mock gateway; record route, status, flags, evidence, and side effects. The workflow delegates to the existing path and contains no routing policy.
- **Check:** a text claim cannot fill missing structured consumption; critical conflict routes to review; malformed model output becomes technical failure; every non-ready/pending case records zero pricing handoffs.

### U-005 — Provide fast and full suites with honest gates

- **Depends on:** U-003, U-004.
- **Files:** root `package.json`, `.github/workflows/ci.yml`, proposed `evals/run.ts`, `evals/reports/`, `docs/runbook.md`.
- **Outcome:** fast 10–20 case PR suite and full 60–100 case release suite; deterministic fixture/metric checks run in CI without credentials. Live model gates run when a configured provider key is available and are required before accepting a reasoning/model release. Missing credentials produce an explicit not-run status, never a green model-eval claim. Keep concurrency and token spend bounded.
- **Check:** deliberately inject an unsafe-ready result and observe a failing gate/report; remove the model key and observe an explicit incomplete result; run the full suite with a key and verify all case counts reconcile.

### U-006 — Review, baseline, and hand off to Milestone 5

- **Depends on:** U-005.
- **Files:** `docs/eval-strategy.md`, `docs/runbook.md`, `docs/implementation-plan.md`, proposed `docs/evals/` or `evals/reports/`; `docs/adr/` only if an actual storage/integration boundary changes.
- **Outcome:** complete stratified manual QA, save an accepted baseline and readable portfolio report, mark Milestone 4 tasks complete only after the thresholds and QA pass, and document a stable read-only report schema for the Milestone 5 performance view. Case detail may show trace/experiment references while available, but its durable explanation comes from stored decision/evidence records.
- **Check:** a reviewer can read the report without Studio, identify the failing cases and exact safety denominators, and map a case ID to the corresponding synthetic input and available Studio run.

## Milestone 5 handoff

The operations console should read tender case state and human-review events from the application repository, and read eval summaries from the portable report contract. Its performance view can show latest accepted run, prior comparable run, route metrics, unsafe-ready count, review recall, extraction accuracy, sample sizes, model/prompt/dataset versions, and a link to the detailed report. Studio remains the drill-down surface for recent agent experiments and traces. The console should tolerate expired Studio traces by retaining report and case evidence. Human corrections become candidate labelled fixtures only after review; an operator action must not silently rewrite the canonical eval dataset. Milestone 5 must not query the ignored local Studio database directly as its source of truth.

## Verification scenarios

| Setup/input | Action | Expected observable outcome |
| --- | --- | --- |
| Clean structured tender without text | Run decision-path suite | Ready route, one mock handoff, no model call. |
| Missing structured consumption with consumption mentioned in a note | Run agent and decision-path suites | Extracted evidence is scored; final route remains `NEEDS_INFORMATION`; zero handoffs. |
| Conflicting date for a named site | Run both suites | Source-backed conflict, `HUMAN_REVIEW`, zero handoffs. |
| Ambiguous multi-site document text | Run both suites | Attribution abstains or flags ambiguity; no unsafe ready route. |
| Exact duplicate/replay | Run isolated decision path | `DUPLICATE` or idempotent replay as labelled; no second handoff. |
| Provider timeout or invalid model object | Run failure fixture | Technical failure recorded separately from business route; release run is not silently complete. |
| Incorrect ready result on one golden safety case | Score outcomes | Unsafe-ready count becomes 1 and gate fails regardless of aggregate accuracy. |
| No model key or interrupted Studio experiment | Run suite | Report says not run/incomplete and cannot be accepted as a passing live-model baseline. |
| Studio trace aged out | Open saved report and synthetic case | Scores, labels, versions, and outcome explanation remain readable; trace link can be unavailable. |
| Changed dataset since baseline | Compare reports | Dataset versions shown; numerical delta marked non-comparable rather than presented as an improvement. |

## Risks and mitigations

- **Small sample hides failures:** report per-class support and raw counts; expand from 30 to 60–100 balanced cases before milestone completion. Treat thresholds as prototype evidence, not statistical proof.
- **Studio agent score masks application routing error:** retain the complete-path suite and pricing-call checks as separate mandatory gates.
- **Model variability and cost:** pin model/prompt/configuration, record versions, bound concurrency, and keep a small PR subset; re-run full release suite before a release.
- **Evaluation leaks into operational state:** isolate each case and use only a mock gateway; never use the active local API state file or a real external handoff.
- **Transient observability data:** retain canonical cases and accepted reports in Git. Prove any future bulk trace export before promising a weekly archive; record retention/storage decisions when hosting is designed.
- **Dirty, stale local worktrees:** create the implementation branch from verified merged main through the host Git workflow and preserve both existing worktrees. Recheck current dependencies and paths before coding.

## Permission and operational impact

Planning adds only this document. Implementation will make paid model API calls during live evals using an already configured provider key. It needs no new connector, OAuth scope, real customer data, production workflow, paid Mastra subscription, or AWS resource in Milestone 4. Publishing reports or introducing hosted trace export later requires its own review of data and cost. Keep all fixtures and committed outputs synthetic and free of credentials.

## Rollout and rollback

Implement on `feat/eval-harness` from the verified merged main branch, then submit a reviewable PR. First land case validation and deterministic scorer tests; add Studio integration and live-model runs; finish with a baseline report and manual QA. A failed or incomplete suite blocks accepting a new baseline. Rollback is to revert the eval harness/report change while retaining prior accepted reports; no operational tender state needs migration.

## Open questions and approval gates

- Verify the merged main tree and installed Mastra experiment/workflow APIs before implementation; the current worktrees are stale and dirty.
- Confirm the final 60–100 case balance and labels during manual review. No domain expert has validated these synthetic business expectations as real policy.
- Verify that the installed Mastra version can run workflow experiments safely. If it cannot, agree an explicit fallback for full-path display before replacing the planned Studio workflow target with a programmatic-only report.
- Decide hosted observability retention and a trace archive only during deployment planning, after measuring usage and proving export completeness. Mastra Starter's hosted 15-day window is not the retention mechanism for accepted eval reports.
- Do not commit, open a PR, deploy, spend on a paid plan, or alter existing worktrees as part of this planning task.
