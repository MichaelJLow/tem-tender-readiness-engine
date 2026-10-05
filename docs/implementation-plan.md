# Implementation Plan

## Execution goal

Build the smallest production-style system that convincingly demonstrates the intended operating model: clean engineering boundaries, explicit business rules, bounded AI reasoning, human review, evals, AWS-aligned deployment, and observable failure handling.

**Target build window:** approximately 7 days.

The project ends at `READY_FOR_PRICING`. Real pricing and Rosso remain outside scope behind a mocked downstream gateway.

## Delivery principles

1. Build vertical slices before infrastructure breadth.
2. Keep business rules deterministic wherever possible.
3. Use AI only where interpretation is required.
4. Prefer safety over maximum automation rate.
5. Treat evals as part of the product.
6. Use AWS to support the system, not as the project itself.
7. Keep branches, commits, tests, and docs reviewable.
8. Stop adding features once the core story is strong.

## Definition of done

V1 is ready when an engineer can clone the repo and understand:

- what problem the system solves
- what is synthetic versus based on public information
- why deterministic rules, AI, and human review are separated
- how a tender moves through the system
- how behaviour is tested and evaluated
- how failures are observed and recovered
- how the local demo runs and how its synthetic evidence is archived
- why only `READY_FOR_PRICING` can cross the downstream boundary

The final demo should reliably show:

```text
Clean tender          → READY_FOR_PRICING
Missing information   → NEEDS_INFORMATION
Critical conflict     → HUMAN_REVIEW
Duplicate submission  → DUPLICATE
Technical failure     → FAILED / recoverable
```

---

## Milestone 0 - Repository bootstrap

**Goal:** establish a clean engineering foundation.

### Tasks

- [x] Initialise TypeScript workspace/monorepo.
- [x] Enable strict TypeScript.
- [x] Configure package-manager scripts.
- [x] Add ESLint and formatting.
- [x] Add Vitest.
- [x] Add Zod.
- [x] Add `.env.example` and secure `.gitignore`.
- [x] Establish public README and engineering docs.
- [x] Create top-level implementation structure:

```text
apps/
packages/
integrations/
infra/
docs/
.github/
```

- [x] Add CI skeleton for lint, typecheck, and tests.

### Acceptance criteria

- install, lint, typecheck, and test commands run successfully
- no secrets are committed
- structure is understandable without explanation

### Suggested branch

`chore/repo-bootstrap`

---

## Milestone 1 - Domain core

**Goal:** make the tender decision model work locally with zero AI and zero AWS.

### Tasks

- [x] Implement Zod schemas for tender, broker, customer, site, and document.
- [x] Implement processing states.
- [x] Implement business routes.
- [x] Implement `RuleResult` and evidence structures.
- [x] Implement routing-policy interface.
- [x] Implement `TDR-001` through `TDR-012`.
- [x] Make rule precedence explicit.
- [x] Create deterministic fixtures for clean, missing, conflict, and duplicate cases.
- [x] Unit-test rules and routing precedence.
- [x] Test rejection of invalid external payloads.

### Acceptance criteria

```text
clean fixture        → READY_FOR_PRICING
missing consumption  → NEEDS_INFORMATION
conflicting dates    → HUMAN_REVIEW
duplicate tender     → DUPLICATE
```

No model call is required.

### Suggested branch

`feat/domain-core`

---

## Milestone 2 - Local vertical slice

**Goal:** process a tender through a real API locally before adding probabilistic reasoning.

### Tasks

- [x] Create minimal TypeScript API/service.
- [x] Implement `POST /tenders`.
- [x] Validate incoming payload with Zod.
- [x] Create processing record.
- [x] Execute deterministic readiness rules.
- [x] Produce one final route for completed runs; keep required pending documents in `PROCESSING` without a route.
- [x] Persist locally behind a repository abstraction.
- [x] Implement mocked pricing gateway.
- [x] Enforce pricing guard.
- [x] Add integration tests.
- [x] Add correlation/run IDs.

### Acceptance criteria

A clean tender can be submitted over HTTP and a non-ready tender cannot reach pricing.

### Suggested branch

`feat/milestone-2`

---

## Milestone 3 - Bounded Mastra reasoning

**Goal:** introduce AI only for tasks deterministic code cannot reliably perform.

### Initial agent scope

One bounded **Tender Interpretation Agent** for:

1. fact extraction from unstructured text/documents,
2. association of ambiguous information to a site/entity,
3. semantic conflict explanation.

### Tasks

- [x] Add Mastra.
- [x] Configure an API-compatible model provider via environment configuration (including OpenAI and OpenRouter).
- [x] Implement structured outputs validated by Zod.
- [x] Preserve source/evidence provenance.
- [x] Add ambiguity fields where useful.
- [x] Invoke the agent only when interpretation is required.
- [x] Prevent direct pricing access from the agent.
- [x] Prevent model output from overriding deterministic policy.
- [x] Route unresolved critical ambiguity to `HUMAN_REVIEW`.
- [x] Add model/workflow tracing.
- [x] Test model failure and malformed output paths.

### Acceptance criteria

Unstructured text can produce schema-valid evidence, and model failure cannot accidentally produce `READY_FOR_PRICING`.

**Completed:** merged in [PR #6](https://github.com/MichaelJLow/tem-tender-readiness-engine/pull/6) on 2026-09-26. Formatting, lint, typecheck, 117 tests, API build, and GitHub CI passed. The local Studio smoke run completed 8/8 cases with traces; scored evals remain in Milestone 4.

### Suggested branch

`feat/mastra-reasoning`

---

## Milestone 4 - Eval system

**Goal:** turn model behaviour into measurable engineering evidence.

### Tasks

- [x] Create an initial hand-authored golden dataset of roughly 30 strong cases.
- [x] Expand toward 60 to 100 reproducible synthetic cases.
- [x] Store expected route, flags, and critical facts.
- [x] Calculate routing precision/recall.
- [x] Calculate critical-field extraction precision/recall.
- [x] Calculate `HUMAN_REVIEW` recall.
- [x] Calculate unsafe auto-proceed rate.
- [x] Create a golden safety set.
- [x] Create fast PR eval subset.
- [x] Create full release suite.
- [x] Record prompt/model configuration with results.
- [x] Add manual QA checklist.

### Initial prototype gates

```text
Golden safety set unsafe-ready cases = 0
HUMAN_REVIEW recall                 >= 95%
Critical-field extraction           >= 95%
```

### Acceptance criteria

A safety regression caused by a prompt/model change fails visibly.

**Current verification (2026-09-28):** the final 63-case release run
[`full-2026-09-28T19-39-31.237Z.md`](../evals/reports/full-2026-09-28T19-39-31.237Z.md)
completed and passed all 9 configured gates. All expected routes, processing
statuses, and pricing handoff counts matched. The run recorded 0 unsafe-ready
cases, 0 non-ready pricing calls, 51/51 agent facts, and a successful comparison
with the accepted baseline. The intermediate validator failures, their causes,
and fixes are documented in `docs/eval-findings.md`; the reports remain in
`evals/reports/`. Manual QA from the accepted synthetic prototype baseline
remains documented above. Milestone 4 full-eval acceptance is met for the
synthetic dataset; review and merge of the current branch remain separate.

### Suggested branch

`feat/eval-harness`

---

## Milestone 5 - Operations console

The historical planning record is
[`2026-09-28-milestone-5-operations-console-plan.md`](plans/2026-09-28-milestone-5-operations-console-plan.md).
Current operator behaviour is in the [runbook](runbook.md) and
[ADR-002](adr/002-local-review-state-and-console-boundary.md).

**Completed (2026-09-30):** the local Next.js console, queue/case detail,
human-review event path, and read-only eval performance view are implemented
and merged in PR #9; screenshot readiness followed in PR #10. Formatting, lint, typecheck, the 170-test suite, and
API/console production builds passed on 2026-09-29.

**Manual QA checkpoint:** a synthetic conflicting-date case saved a
`REQUEST_INFORMATION` review event while its automatic route stayed
`HUMAN_REVIEW`. The user confirmed that `READY_FOR_PRICING` and
`NEEDS_INFORMATION` details offer no review actions and that Performance
distinguishes the accepted baseline from the latest completed run. This
walkthrough exposed missing structured date values and source IDs in the case
view; the console and review API now display and accept those recorded evidence
references. The user visually confirmed the revised case view on
2026-09-29. The seeded screenshot walkthrough and retained captures demonstrate the
review audit and ready-only mocked handoff. Milestone 5 acceptance is met.

**Goal:** make the automation operable by a human, not just visible in logs.

### Core views

- Queue
- Tender detail
- Human review
- Performance

### Tasks

- [x] Build minimal TypeScript/Next.js internal UI.
- [x] Build queue and case detail.
- [x] Show deterministic rule results and AI evidence.
- [x] Implement human-review actions.
- [x] Store immutable review/audit events.
- [x] Add a performance/eval view backed by the versioned Milestone 4 report contract, showing the latest accepted run, comparable baseline, safety verdict, metrics, sample sizes, and model/prompt/dataset versions.
- [x] Link to Mastra Studio experiments and recent traces for drill-down when available; keep the case evidence and eval report readable after those traces expire.
- [x] Keep operational tender/review state in the application repository and expose eval summaries through a read-only backend projection, rather than reading Studio's local database from the UI.
- [x] Treat human corrections as candidate regression cases that require review before entering the canonical eval dataset.

### Acceptance criteria

A reviewer can understand why a case was blocked and resolve it without reading backend logs. The performance view can explain the current eval verdict from the retained report even when a Mastra Studio trace is unavailable.

### Suggested branch

`feat/ops-console`

---

## Milestone 6 - Lightweight AWS evidence archive

**Goal:** demonstrate a small, useful AWS storage boundary for the synthetic
portfolio demo without moving the live API or Operations Console off the local
single-process setup. The historical planning record is
[Milestone 6 lightweight S3 archive](plans/2026-09-29-milestone-6-lightweight-s3-archive-plan.md).
Current archive behaviour is in the [runbook](runbook.md#milestone-6-archive-and-restore)
and [ADR-003](adr/003-private-s3-demo-snapshots.md).

The earlier S3 + database + runtime + hosted Console scope was narrowed at the
user's request. S3 is an archive for synthetic source files, tender-state
snapshots, and durable eval reports; it is not the live review/idempotency
database. The API, Console, and Mastra Studio remain local.

### Tasks

- [x] Confirm AWS account access and region, and record the existing budget alert.
- [ ] Check the promotional AWS credit balance/expiry (account-administration
      follow-up; not part of archive correctness acceptance).
- [x] Define one private S3 bucket with public access blocked.
- [x] Archive a consistent synthetic state snapshot, accepted baseline, latest
      completed eval report, and available synthetic source files.
- [x] Restore a complete snapshot into a fresh local path with checksum/schema
      verification and no overwrite of existing state.
- [x] Re-run the local Console walkthrough from the S3-restored files.
- [x] Document the archive/restore path and the fact that Studio's local
      experiments and traces are separate.

### Acceptance criteria

A small synthetic snapshot can be uploaded to private S3, restored into a new
local directory, and used to show the same three routes, review audit, accepted
baseline, latest run, and ready-only mocked handoff. No credentials, private
customer data, or public S3 objects are used.

A live AWS database/runtime and a hosted Console are deferred. If a public demo
URL becomes important later, plan it separately with a cost and authentication
decision rather than expanding this milestone.

**Accepted (2026-10-04):** archive/restore commands prepare and verify bounded
synthetic snapshots, preserve the accepted/latest distinction, and restore into
a fresh path. The [verification receipt](milestone-6-verification.md) records
the 184-test implementation run, live private-S3 upload and restore, access
checks, and Console walkthrough from a fresh S3 restore.
[PR #14](https://github.com/MichaelJLow/tem-tender-readiness-engine/pull/14)
merged the archive branch and live S3 evidence;
[PR #16](https://github.com/MichaelJLow/tem-tender-readiness-engine/pull/16)
merged the restored-Console evidence. The promotional AWS credit balance/expiry
remains an explicit, non-blocking account-administration follow-up.

### Suggested branch

`feat/aws-demo-archive`

---

## Milestone 7 - n8n integration

**Goal:** demonstrate integration orchestration without hiding domain logic inside n8n.

### Tasks

- [x] Build tender intake webhook workflow.
- [x] Normalize transport-level inputs.
- [ ] Register/upload supporting documents. Deferred; optional PDF intake is ENG-16.
- [x] Call Tender Readiness API.
- [x] Record returned business route without duplicating the routing policy.
- [x] `READY_FOR_PRICING` → observe the API-owned mocked pricing handoff.
- [x] `NEEDS_INFORMATION` → mocked, non-delivering information-request receipt.
- [x] `HUMAN_REVIEW` → link the existing review case only.
- [x] `DUPLICATE` → stop cleanly.
- [x] Export credential-free workflow JSON into the repo.

### Acceptance criteria

The n8n canvas contains integration orchestration, not a hidden second implementation of business policy. The export, automated contract checks, and
fresh-runtime execution matrix are recorded in the
[Milestone 7 verification receipt](milestone-7-verification.md).
[PR #19](https://github.com/MichaelJLow/tem-tender-readiness-engine/pull/19)
merged that evidence to `main` as `12f4c6c`. Document registration/upload is
outside the implemented local contract and remains deferred: the workflow
accepts structured data and already-extracted document text only.

### Suggested branch

`feat/n8n-intake`

---

## Milestone 8 - Reliability, observability, and CI/CD

**Goal:** make failure visible, replay safe, and release controlled.

### Tasks

- [x] Implement idempotency for intake and downstream handoff.
- [x] Test duplicate webhook delivery.
- [x] Add retry policy for transient failures.
- [x] Distinguish retryable and terminal failures.
- [x] Add explicit error taxonomy.
- [x] Add safe replay/retry operation.
- [x] Add structured logging and audit events.
- [x] Add GitHub Actions for format/lint, typecheck, tests, API/Console builds, and committed reasoning-evidence checks.
- [x] Select stable-release evidence (`evals/release-evidence.json` plus manual QA). ENG-14 recorded the pointer; accepted baseline not promoted.
- [ ] Use GitHub-to-AWS OIDC. Not implemented; archive upload uses a local AWS CLI profile. Deferred with hosted runtime.
- [x] Rehearse provider timeout, invalid model output, storage failure, downstream `500`, duplicate webhook, and archive missing-object.

### Acceptance criteria

At least one failure can be demonstrated end to end: visible failure → no unsafe action → safe recovery.

**Accepted (2026-10-05):** ENG-8, ENG-9, ENG-10, ENG-11, and ENG-12 are merged.
The [reliability rehearsal](reliability-rehearsal.md) records the visible
recovery story. CI is [`.github/workflows/ci.yml`](../.github/workflows/ci.yml).
ENG-14 selected [`evals/release-evidence.json`](../evals/release-evidence.json);
the accepted baseline was not promoted.

### Suggested branch

`feat/reliability-observability`

---

## Milestone 9 - Public interview release

**Goal:** stop adding features and package the work for review.

### Tasks

- [ ] Cut stable release/tag `v1.0.0`. Packaging and notes are in [`docs/releases/v1.0.0.md`](releases/v1.0.0.md); do not push the tag until Mike confirms the merge SHA.
- [x] Finish README and architecture diagram for the implemented local V1.
- [x] Add local setup, n8n import, archive/restore, and recovery instructions. Hosted deployment remains deferred.
- [x] Document key architecture decisions in `docs/adr/`.
- [x] Add known limitations and realistic future improvements.
- [x] Remove or mark stale planning paths; keep failure and eval findings.
- [x] Run the tracked secrets/security review ([`docs/releases/security-check-2026-10-05.md`](releases/security-check-2026-10-05.md)).
- [x] Run the final full eval suite and retain release evidence (ENG-14). Do not promote latest results over the accepted baseline here.
- [x] Complete stratified manual QA (ENG-14).
- [x] Capture clean Console screenshots. Existing authentic set: [operations-console](screenshots/operations-console/README.md).
- [x] Prepare happy path, missing information, human review, pending, duplicate, and technical-failure fixtures under `integrations/n8n/fixtures/` and `tests/fixtures/`.
- [x] Verify displayed eval metrics are retained report output, with latest and accepted labelled separately.

### Acceptance criteria

An engineer can review the repository without verbal context and the demo can be run repeatedly without fragile manual setup.

**ENG-13 / ENG-14:** reviewer docs, selected full eval, and manual QA are on
`main`. ENG-15 packages notes and the security receipt. Milestone 9 is not
complete until the confirmed `v1.0.0` tag exists. ENG-16 stays optional.

### Optional portfolio extension after all milestones

Once Milestones 0–9 are complete, build a more realistic fully synthetic tender pack for the demo: a submission form, broker note, and supporting PDF documents with single-site, multi-site, and conflicting-evidence examples. Add a PDF-to-text intake step that feeds extracted text into the existing bounded interpretation flow. Extend the eval fixtures and checks to cover extraction failures, document-to-site attribution, and the existing pricing safety guard. This follow-on is outside Milestone 9 acceptance.

---

## Original delivery sketch

The table below was the original seven-day planning sketch. It is not a remaining
schedule and not evidence that Milestone 9 is finished.

| Day | Primary goal                     | Must-have outcome                                 |
| --- | -------------------------------- | ------------------------------------------------- |
| 1   | Repo + domain core               | deterministic routes and tests                    |
| 2   | Local vertical slice + reasoning | API flow and bounded model integration            |
| 3   | Evals                            | golden set, metrics, safety gate                  |
| 4   | Ops console                      | queue, case detail, human review                  |
| 5   | Lightweight AWS archive          | state and eval evidence restorable from S3        |
| 6   | n8n + reliability + CI           | integrated workflow, retries, observable failure  |
| 7   | Hardening + presentation         | stable release, docs, screenshots, rehearsed demo |

The sequence stayed flexible. Infrastructure was narrowed to a private S3
archive rather than hosted runtime so eval quality and the pricing guard were
not weakened. Historical planning notes live under [`docs/plans/`](plans/README.md)
and are not current status.
