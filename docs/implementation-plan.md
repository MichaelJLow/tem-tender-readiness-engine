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
- how the application is deployed
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

- [ ] Create an initial hand-authored golden dataset of roughly 30 strong cases.
- [ ] Expand toward 60 to 100 reproducible synthetic cases.
- [ ] Store expected route, flags, and critical facts.
- [ ] Calculate routing precision/recall.
- [ ] Calculate critical-field extraction accuracy.
- [ ] Calculate `HUMAN_REVIEW` recall.
- [ ] Calculate unsafe auto-proceed rate.
- [ ] Create a golden safety set.
- [ ] Create fast PR eval subset.
- [ ] Create full release suite.
- [ ] Record prompt/model configuration with results.
- [ ] Add manual QA checklist.

### Initial prototype gates

```text
Golden safety set unsafe-ready cases = 0
HUMAN_REVIEW recall                 >= 95%
Critical-field extraction           >= 95%
```

### Acceptance criteria

A safety regression caused by a prompt/model change fails visibly.

### Suggested branch

`feat/eval-harness`

---

## Milestone 5 - Operations console

**Goal:** make the automation operable by a human, not just visible in logs.

### Core views

- Queue
- Tender detail
- Human review
- Performance

### Tasks

- [ ] Build minimal TypeScript/Next.js internal UI.
- [ ] Build queue and case detail.
- [ ] Show deterministic rule results and AI evidence.
- [ ] Implement human-review actions.
- [ ] Store immutable review/audit events.
- [ ] Add performance/eval view once metrics exist.

### Acceptance criteria

A reviewer can understand why a case was blocked and resolve it without reading backend logs.

### Suggested branch

`feat/ops-console`

---

## Milestone 6 - AWS storage and runtime

**Goal:** move the working system into a deliberately small AWS-native architecture.

### 6A. S3

- [ ] Create private bucket.
- [ ] Store original tender documents.
- [ ] Persist only object references in domain records.
- [ ] Test missing/unreadable object handling.

### 6B. AWS-native state

- [ ] Define access patterns before choosing/finalising schema.
- [ ] Persist tenders, decisions, review state, and idempotency records.
- [ ] Keep persistence behind repository interfaces.

### 6C. Runtime

- [ ] Deploy TypeScript backend using the smallest practical AWS runtime.
- [ ] Expose a minimal API.
- [ ] Confirm Mastra/OpenAI execution works reliably in the selected runtime.

### 6D. IAM and observability

- [ ] Use least-privilege IAM.
- [ ] Emit structured logs.
- [ ] Include correlation ID, tender ID, and run ID.
- [ ] Make technical failures visible.

### 6E. Infrastructure as code

- [ ] Codify the final AWS resources in TypeScript where practical.

### Acceptance criteria

A deployed request can process synthetic data using real AWS storage/state with observable logs and no committed credentials.

### Suggested branches

`feat/aws-s3-storage`  
`feat/aws-state`  
`feat/aws-runtime`

---

## Milestone 7 - n8n integration

**Goal:** demonstrate integration orchestration without hiding domain logic inside n8n.

### Tasks

- [ ] Build tender intake webhook workflow.
- [ ] Normalize transport-level inputs.
- [ ] Register/upload supporting documents.
- [ ] Call Tender Readiness API.
- [ ] Branch on returned business route.
- [ ] `READY_FOR_PRICING` → mocked pricing handoff.
- [ ] `NEEDS_INFORMATION` → mocked information-request event.
- [ ] `HUMAN_REVIEW` → review queue only.
- [ ] `DUPLICATE` → stop cleanly.
- [ ] Export workflow JSON into the repo.

### Acceptance criteria

The n8n canvas contains integration orchestration, not a hidden second implementation of business policy.

### Suggested branch

`feat/n8n-intake`

---

## Milestone 8 - Reliability, observability, and CI/CD

**Goal:** make failure visible, replay safe, and release controlled.

### Tasks

- [ ] Implement idempotency for intake and downstream handoff.
- [ ] Test duplicate webhook delivery.
- [ ] Add retry policy for transient failures.
- [ ] Distinguish retryable and terminal failures.
- [ ] Add explicit error taxonomy.
- [ ] Add safe replay/retry operation.
- [ ] Add structured logging and audit events.
- [ ] Add GitHub Actions for format/lint, typecheck, tests, eval smoke suite, and build.
- [ ] Add stable-release workflow with full evals and manual QA.
- [ ] Use GitHub-to-AWS OIDC where practical.
- [ ] Rehearse OpenAI failure, storage failure, downstream `500`, and duplicate webhook.

### Acceptance criteria

At least one failure can be demonstrated end to end: visible failure → no unsafe action → safe recovery.

### Suggested branch

`feat/reliability-observability`

---

## Milestone 9 - Public interview release

**Goal:** stop adding features and package the work for review.

### Tasks

- [ ] Cut stable release/tag.
- [ ] Finish README and architecture diagram.
- [ ] Add local setup and deployment instructions.
- [ ] Document key architecture decisions.
- [ ] Add known limitations and realistic future improvements.
- [ ] Remove dead code and experimental paths.
- [ ] Run secrets/security check.
- [ ] Run full tests and eval suite.
- [ ] Complete manual QA.
- [ ] Capture clean screenshots.
- [ ] Prepare happy path, missing information, human review, and technical failure demo fixtures.
- [ ] Verify every displayed metric is real project output or clearly labelled illustrative.

### Acceptance criteria

An engineer can review the repository without verbal context and the demo can be run repeatedly without fragile manual setup.

---

## Seven-day focus

| Day | Primary goal | Must-have outcome |
| --- | --- | --- |
| 1 | Repo + domain core | deterministic routes and tests |
| 2 | Local vertical slice + reasoning | API flow and bounded model integration |
| 3 | Evals | golden set, metrics, safety gate |
| 4 | Ops console | queue, case detail, human review |
| 5 | AWS | documents/state/runtime working in cloud |
| 6 | n8n + reliability + CI | integrated workflow, retries, observable failure |
| 7 | Hardening + presentation | stable release, docs, screenshots, rehearsed demo |

The sequence is intentionally flexible. If infrastructure threatens eval quality or system reliability, reduce infrastructure scope rather than weakening the core demonstration.

