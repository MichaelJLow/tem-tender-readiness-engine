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

## Expected early ADRs

Likely decisions include:

- deterministic business rules outside prompts
- Mastra as the bounded reasoning layer
- OpenAI as the model provider for V1
- n8n limited to integration orchestration
- AWS persistence/runtime choice
- human-review policy for critical ambiguity
- PR eval subset versus full release eval suite

Current decisions:

- [ADR-001: Keep the bounded Mastra agent in the API workspace](001-bounded-mastra-agent.md)

ADRs should describe **this project's** choices. They should not present implementation assumptions as facts about tem's private architecture.
