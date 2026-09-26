# Milestone 2: Local vertical slice plan

## Outcome

A synthetic tender can be submitted to a local HTTP API, validated, evaluated by the existing deterministic domain package, recorded locally, and handed to a mocked pricing gateway only when its final route is `READY_FOR_PRICING`. The API exposes technical status and the rule evidence needed to understand the decision.

## Context and evidence

- `docs/implementation-plan.md` defines Milestone 2 as a local API and service with `POST /tenders`, Zod validation, processing records, local persistence, a mocked pricing gateway, correlation/run IDs, and integration tests.
- `packages/domain/src/evaluate.ts` already validates `ReadinessInput`, evaluates twelve rules, and returns `ReadinessResult`. A required document in `PENDING` yields `PROCESSING` with no route. This behavior must remain visible in the API.
- `packages/domain/src/schemas.ts` defines `TenderSchema`, `ReadinessInputSchema`, `ProcessingRecordSchema`, and `ReadinessResultSchema`. `ProcessingRecordSchema` currently carries only tender ID, status, and optional route; the local service needs separate run/correlation and stored result metadata.
- `apps/api/` is an empty npm workspace; there is no server, repository implementation, or pricing adapter yet. Root scripts run TypeScript, lint, formatting, and Vitest checks.
- `AGENTS.md`, `docs/architecture.md`, and `docs/business-rules.md` require deterministic routing, separate technical status, evidence traceability, safe replay, and a hard pricing guard.

This is a standard, single-repository implementation plan for an already defined milestone. The capability-routing reference named by the CE Plan skill was unavailable locally; the classification follows the skill's stated standard default because this plan does not choose a new platform or change the documented architecture.

## Decisions and assumptions

1. `POST /tenders` accepts one JSON `ReadinessInput` shape. Evidence signals are optional as the domain schema allows. The server derives duplicate/idempotency signals from stored tender identity, and never accepts client-supplied duplicate flags as authority. Other supplied signals are validated evidence for synthetic local examples; AI extraction arrives in Milestone 3.
2. A repeated idempotency key with the same normalized request returns the previously stored outcome and does not reevaluate or call pricing again. Reuse of the key with different content returns a clear conflict response. A different key for an already active tender identity is evaluated with server-derived duplicate evidence and may route `DUPLICATE` under TDR-009. The exact identity comparison should use the existing tender ID at this milestone; broader customer/site/period matching needs explicit policy before implementation.
3. Local persistence uses one file-backed JSON repository behind a small interface. Writes are serialized within the process and replace the file atomically. This supports restart persistence for a single local process; multi-process concurrency belongs to the later AWS state milestone.
4. The mocked pricing gateway records a handoff locally behind an interface. The application service checks the final route immediately before calling it, and the mock also rejects any handoff without `READY_FOR_PRICING`. A stable handoff key tied to the tender and idempotency key prevents repeat calls.
5. A valid completed request returns the stored status, route, rule results, and correlation/run IDs. A required `PENDING` document returns `PROCESSING` with no final route or pricing action. Milestone 2 does not add document processing or a background worker.
6. A gateway failure leaves the decided route as `READY_FOR_PRICING` and marks technical processing `FAILED`, with a typed failure visible in the response and stored record. No automatic retry is introduced in this milestone.

## Scope

### In scope

- Local HTTP intake, Zod boundary validation, explicit error responses, and a small composition root.
- Application service that creates `RECEIVED`, advances through `PROCESSING`, persists a terminal result, and preserves rule evidence.
- Local repository contract and file-backed implementation for tender runs and handoff deduplication.
- Mocked pricing handoff with defense at both the service and gateway boundary.
- Structured logs carrying tender, run, and correlation IDs; local setup instructions and representative synthetic fixtures.
- Behavioral integration tests for successful, blocked, duplicate, pending, malformed, replay, and failure cases.

### Out of scope

- Mastra/OpenAI, document parsing/upload, S3, AWS runtime/state, n8n workflows, operations UI, real pricing, and production authentication.
- Fuzzy duplicate matching, automatic retries, recovery UI, and multiple API processes sharing the same file.
- Business-rule changes unless integration reveals an actual domain defect; any such change requires separate rationale and domain tests.

## High-level technical design

The HTTP adapter validates JSON and calls an application service. The service loads existing state, computes server-owned duplicate information, invokes `evaluateReadiness`, persists the decision and its rule evidence, and conditionally invokes the pricing port. The file repository stores enough input and output to reconstruct a route and detect replays. Its schema/version is explicit so incompatible local state fails visibly. The mocked gateway records only accepted ready handoffs. A response maps technical status separately from business route; malformed requests never create a processing record.

The plan proposes a minimal Node HTTP server using the dependencies already present. If a framework becomes necessary during implementation, document the concrete need before adding it. `POST /tenders` is the required endpoint; a small `GET /tenders/:id` may be added only if needed to observe persisted or pending state in the local demo.

## Implementation units

### U-001 — Define the API and application contracts

- **Depends on:** none.
- **Files:** proposed `apps/api/src/contracts.ts`, `apps/api/src/service.ts`; existing `packages/domain/src/schemas.ts` and `packages/domain/src/types.ts` for reuse.
- **Outcome:** request/response and service types distinguish status, optional final route, rule evidence, correlation/run IDs, and typed errors. Specify HTTP mapping for valid completion, pending work, malformed input, idempotency conflict, and technical failure.
- **Check:** contract examples for clean, pending, and malformed synthetic requests can be validated without inventing a route for pending work.

### U-002 — Persist runs and protect intake idempotency

- **Depends on:** U-001.
- **Files:** proposed `apps/api/src/repository.ts`, `apps/api/src/file-repository.ts`, corresponding tests; `.env.example` if storage path is configurable.
- **Outcome:** repository saves input, lifecycle state, rule results, and handoff keys; lookup by tender ID and idempotency key supports exact replay and conflict detection. A restart retains state. Corrupt or unwritable state produces an explicit technical error.
- **Check:** write a synthetic record, construct a new repository instance, read the same record, then verify same-key replay and changed-payload conflict without another record.

### U-003 — Orchestrate deterministic evaluation

- **Depends on:** U-001, U-002.
- **Files:** proposed `apps/api/src/service.ts`, service tests; `packages/domain/src/evaluate.ts` only if a demonstrated integration defect requires correction.
- **Outcome:** service creates and persists status transitions, derives duplicate evidence from repository state, invokes the domain evaluator once for a new submission, persists all rule results, and maps pending documents to `PROCESSING` without a route.
- **Check:** clean, missing-information, review, duplicate, and pending inputs retain the domain's expected routes/status and rule evidence in storage.

### U-004 — Enforce and record the pricing handoff

- **Depends on:** U-003.
- **Files:** proposed `apps/api/src/pricing-gateway.ts`, `apps/api/src/mock-pricing-gateway.ts`, service and gateway tests.
- **Outcome:** ready completed tenders create at most one mock handoff. The guard exists at the caller and receiving adapter. Gateway failure marks processing `FAILED` while preserving the ready route and traceable failure details.
- **Check:** submit each non-ready route and a pending document; mock call count stays zero. Submit and replay a clean tender; exactly one handoff exists. Force gateway failure; stored status is `FAILED`, route remains ready, and no success is reported.

### U-005 — Expose the local HTTP flow

- **Depends on:** U-003, U-004.
- **Files:** proposed `apps/api/src/server.ts`, `apps/api/src/main.ts`, `apps/api/package.json`, root `package.json`, HTTP integration tests.
- **Outcome:** `POST /tenders` validates transport and domain input, generates or propagates a correlation ID, returns the persisted result with appropriate HTTP status, and logs structured identifiers. Server startup accepts a local port and repository path through validated environment settings.
- **Check:** start on an ephemeral port, submit the synthetic clean fixture over HTTP, inspect the response and persisted record, and verify the mock handoff. Invalid JSON and invalid schemas return bounded errors and leave storage unchanged.

### U-006 — Document operation and demonstrate the slice

- **Depends on:** U-005.
- **Files:** `README.md`, `docs/runbook.md`, `.env.example`, optionally `docs/architecture.md`; synthetic HTTP examples under `tests/fixtures/` if needed.
- **Outcome:** local start/submit instructions, response examples, state path, status meanings, and failure handling match implemented behavior. Document the single-process persistence limit and deferred processing of pending documents.
- **Check:** follow documented commands with a fresh local state file; the clean and non-ready examples produce the documented outcomes.

## File impact

Existing: `apps/api/package.json`, root `package.json`, `.env.example`, `README.md`, `docs/runbook.md`, and possibly `docs/architecture.md`. Proposed: `apps/api/src/` contracts, service, repository, file adapter, pricing port/mock, HTTP server and entry point, plus colocated tests. The exact new filenames may vary if the implementation keeps the same boundaries. Domain files change only for evidenced defects.

## Verification scenarios

| Setup/input | Action | Expected outcome |
| --- | --- | --- |
| Valid clean synthetic tender | `POST /tenders` | `COMPLETED`, `READY_FOR_PRICING`, twelve rule results, one persisted mock handoff, IDs in response/logs. |
| Missing annual consumption | Submit | `COMPLETED`, `NEEDS_INFORMATION`, TDR-004 evidence, zero pricing handoffs. |
| Conflicting credible dates | Submit | `COMPLETED`, `HUMAN_REVIEW`, conflict evidence, zero pricing handoffs. |
| Different idempotency key with an already stored tender ID | Submit | `DUPLICATE` through server-derived signal, zero new pricing handoffs. |
| Required document marked `PENDING` | Submit | `PROCESSING`, absent route, persisted rule results, zero handoffs. |
| Same key and same normalized request | Submit twice, including after repository restart | Previously stored outcome returned; no second record or pricing handoff. |
| Same key and changed request | Submit twice | Conflict response; original record and handoff unchanged. |
| Invalid JSON or Zod-invalid input | Submit | Client error with useful field location where available; no record or handoff. |
| Mock gateway throws | Submit otherwise ready tender | Stored route remains ready, status becomes `FAILED`, failure is visible and correlated; no false successful handoff. |
| Corrupt or unwritable local state | Submit | Technical failure is visible; no route is invented and no pricing handoff occurs. |

Before merge, run the repository's formatting, lint, typecheck, and test scripts, plus the new HTTP integration suite. Confirm fixtures remain synthetic, documentation agrees with responses, and no secrets enter the diff.

## Risks and mitigations

- **Crash between record write and mock handoff:** persist a stable handoff key and state before delivery; replays use the key to avoid a second recorded handoff. Document the local recovery boundary. A durable cross-system transaction is deferred until the state and reliability milestones.
- **Concurrent same-key requests:** serialize repository writes and evaluation for one local process; integration test overlapping submissions. Multi-process safety is outside this milestone.
- **Client-supplied duplicate flags:** derive them in the service from persisted identity to prevent a caller from choosing its route.
- **Pending documents cannot complete locally:** return `PROCESSING` explicitly and document that document processing arrives later.
- **Stored-state shape drift:** version the local file and reject incompatible state visibly rather than silently dropping records.

## Permission and operational impact

Implementation will add a local listening server and write synthetic records to a configurable local file. It requires no credentials, external API calls, cloud resources, new connector scopes, or real customer data. The mock pricing action is local only. The default state path should be ignored by Git.

## Rollout and rollback

Deliver on the suggested `feat/local-vertical-slice` branch for review. The change is local and opt-in through the API start command. Rollback is to stop the server and revert the code; the versioned local state file can be retained for inspection or removed intentionally after review. No production migration is involved.

## Open questions and approval gates

- No blocking product decision remains for the synthetic local demonstration. The proposed exact-tender-ID duplicate policy and single-process JSON persistence are explicit Milestone 2 assumptions.
- Before extending duplicate matching beyond exact tender ID, agree on the identity and contract-period policy and update TDR-009 tests.
- Implementation, commits, and a PR are separate work after this plan is reviewed.

