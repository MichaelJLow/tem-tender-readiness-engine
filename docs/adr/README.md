# Architecture Decision Records

This directory records material architecture decisions made during implementation.

ADRs are added when a choice has meaningful consequences for system behaviour, reliability, maintainability, cost, or reviewability. They are not used for every small implementation detail.

## Suggested format

```md
# ADR-00X: Decision title

## Status

Accepted | Superseded | Proposed

## Context

What problem or constraint requires a decision?

## Decision

What are we choosing?

## Alternatives considered

What realistic alternatives were considered?

## Rationale

Why is this the best fit for this project?

## Consequences

What becomes easier, harder, or constrained because of this choice?
```

## Current decisions

- [ADR-001: Keep the bounded Mastra agent in the API workspace](001-bounded-mastra-agent.md)
- [ADR-002: Separate review history from automatic decisions](002-local-review-state-and-console-boundary.md)
- [ADR-003: Archive the local demo as private S3 snapshots](003-private-s3-demo-snapshots.md)
- [ADR-004: Keep n8n as integration orchestration only](004-n8n-integration-boundary.md)

Related decisions that live in the documents above rather than extra ADRs:

- Deterministic business rules stay outside prompts (`docs/business-rules.md`).
- The configured model provider is OpenAI-compatible (OpenAI or OpenRouter), not a claim that one vendor is required.
- PR eval subset versus full release suite (`docs/eval-strategy.md`).
- Hosted runtime, concurrent database, authentication, GitHub-to-AWS OIDC, real pricing/data, and PDF intake remain deferred.

ADRs should describe **this project's** choices. They should not present implementation assumptions as facts about tem's private architecture.
