# AGENTS.md

## Purpose

This repository contains a production-style Tender Readiness Engine for business-energy tenders.

The project is built with synthetic data and demonstration business rules. It does not claim to reproduce tem's internal tender process, business policy, pricing interfaces, or Rosso architecture.

The system boundary ends at `READY_FOR_PRICING`. Downstream pricing is represented by a mocked internal pricing gateway.

---

## Read before making changes

Start with:

- `README.md`
- `docs/architecture.md`
- `docs/assumptions.md`
- `docs/process-map.md`
- `docs/business-rules.md`
- `docs/eval-strategy.md`
- `docs/implementation-plan.md`

For operational behaviour, also read:

- `docs/runbook.md`

### Local Mastra Studio

- Use port `4113` for this repository's Mastra Studio. Other ports such as `4111` may belong to separate agent projects; do not move this project's Studio to another port just because those are occupied. If `4113` is already occupied, identify and resolve this repository's own Studio process before starting another instance.

For significant architecture changes, check:

- `docs/adr/`

Do not duplicate these documents inside prompts, comments, or new files unless necessary.

## Git checkout boundary

Before implementation, identify whether the task is running in a Codex sandbox/worktree or a writable Git checkout. Source files may be writable while .git is protected. If Git metadata operations are blocked, preserve the working tree and use the Codex/host Git workflow instead of retrying commands, changing .git permissions, resetting the repository, or recreating work.

---

## Core architecture principles

### 1. Deterministic first

If behaviour can be expressed reliably as explicit code, implement it in TypeScript rather than in an LLM prompt.

Examples include:

- required-field validation
- date parsing and normalization
- routing precedence
- duplicate detection
- idempotency
- downstream-action guards

Business policy must remain inspectable and testable outside the model.

### 2. AI is bounded

Mastra/OpenAI is used for tasks that genuinely require semantic interpretation, such as:

- extracting structured facts from unstructured text
- associating evidence with the correct site/entity
- identifying semantic ambiguity
- explaining conflicts using source evidence

The model provides structured facts and evidence.

The model must not:

- approve a tender independently
- override deterministic rules
- silently resolve critical ambiguity
- write directly to the pricing gateway
- modify business-rule configuration

### 3. Human review is intentional

`HUMAN_REVIEW` is a valid business route, not a technical failure.

When critical information is ambiguous or conflicting and no deterministic policy safely resolves it, stop automatic progression and expose the evidence to a human.

### 4. Pricing is guarded

Only a final route of:

`READY_FOR_PRICING`

may invoke the mocked pricing gateway.

This is a hard system invariant and must be covered by automated tests.

### 5. Business routes and technical status are separate

Business routes:

- `READY_FOR_PRICING`
- `NEEDS_INFORMATION`
- `HUMAN_REVIEW`
- `DUPLICATE`

Processing status:

- `RECEIVED`
- `PROCESSING`
- `COMPLETED`
- `FAILED`

A technical failure must never silently change a case into a successful business route.

---

## Engineering standards

### TypeScript

- Use strict TypeScript.
- Avoid `any` unless there is a documented reason.
- Validate external inputs with Zod.
- Prefer explicit domain types over loosely shaped objects.

### Architecture

Keep boundaries clear between:

- domain logic
- reasoning / model interaction
- persistence
- integration/orchestration
- infrastructure
- UI

Do not place business rules inside:

- prompts
- React components
- AWS adapters
- n8n condition trees

### Tests

Changes to business behaviour must include appropriate tests.

At minimum:

- unit-test deterministic rules
- test routing precedence
- test non-ready cases cannot reach pricing
- test failure paths where relevant
- update eval fixtures when model-dependent behaviour changes

Do not optimize for test count. Optimize for meaningful behavioural coverage.

### Evals

Model-dependent changes must preserve the evaluation strategy in `docs/eval-strategy.md`.

Safety-critical regressions take precedence over improvements in aggregate accuracy.

An unsafe `READY_FOR_PRICING` decision is considered more serious than unnecessary escalation to human review.

### Logging and errors

- Prefer structured logs.
- Preserve tender/run correlation identifiers.
- Fail visibly.
- Do not swallow exceptions that affect workflow state.
- Keep retryable and terminal failures distinguishable.

### Security

- Never commit secrets or credentials.
- Use environment variables and `.env.example`.
- Prefer least-privilege AWS permissions.
- Do not commit real customer, broker, or tem data.

All fixtures must be synthetic.

---

## Scope control

This project is intentionally small.

Do not introduce new frameworks, AWS services, databases, queues, agents, or abstractions unless they solve a concrete requirement in the current milestone.

Avoid premature:

- microservices
- multi-agent architectures
- generic framework abstractions
- event infrastructure
- Kubernetes
- unnecessary AWS services

Prefer the smallest implementation that preserves the architecture and demonstrates production-quality behaviour.

---

## Working with n8n

n8n is the external integration/orchestration layer.

Use it for:

- webhooks
- transport-level normalization
- external API calls
- workflow triggers
- downstream orchestration

Do not recreate the domain decision engine inside n8n.

---

## Architecture changes

If a change materially alters one of the following:

- reasoning framework
- model-provider boundary
- persistence strategy
- AWS runtime
- domain/routing architecture
- safety policy
- integration boundary

create or update an ADR under `docs/adr/`.

An ADR should capture:

- context
- decision
- alternatives considered
- consequences

---

## Before completing a task

Run the relevant checks.

Once repository scripts exist, this should normally include:

- formatting
- lint
- TypeScript typecheck
- unit tests
- relevant integration tests
- relevant eval smoke tests

Also verify:

- no secrets were added
- documentation still matches behaviour
- no non-ready route can reach pricing
- synthetic/public-data boundaries remain clear

If a requested implementation conflicts with documented architecture, do not silently work around it. Surface the conflict and explain the proposed change.

