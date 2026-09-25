# Runbook

## Status

This is a **living operational document**. The production runbook will be completed as runtime, persistence, retry, and replay behaviour are implemented and tested.

The repository intentionally does not invent operational procedures before the system exists.

## Operational invariants already defined

Regardless of implementation details, the system must preserve these behaviours:

- A technical failure must never silently become `READY_FOR_PRICING`.
- A non-ready business route must never call the pricing gateway.
- Replaying an operation must not create duplicate downstream actions.
- Critical model uncertainty must fail safe to human review or explicit failure.
- Every run should be traceable through a correlation/run ID.
- Human overrides should be recorded as immutable audit events.

## Planned failure taxonomy

The exact error types will be finalised during implementation. Candidate classes include:

```text
DOCUMENT_STORAGE_FAILED
DOCUMENT_PARSE_FAILED
MODEL_PROVIDER_FAILED
MODEL_OUTPUT_INVALID
STATE_WRITE_FAILED
PRICING_GATEWAY_FAILED
WORKFLOW_TIMEOUT
```

Each failed run should expose enough context to identify:

- tender ID
- run/correlation ID
- error type
- failed step
- retry count
- last successful step
- timestamp

## Planned recovery model

Failures will be classified as either **retryable** or **terminal**.

A retry/replay action must be idempotent. In particular, it must not:

- create a second tender,
- send a second pricing request,
- create duplicate information requests,
- create duplicate review tasks.

## Failure scenarios to rehearse

Before the stable interview release, document and test the real recovery procedure for:

1. OpenAI/provider failure
2. source-document storage/read failure
3. invalid model output
4. downstream pricing gateway `500`
5. duplicate webhook delivery
6. state persistence failure

## Runbook completion criteria

This document is considered complete when each implemented failure path includes:

- detection signal,
- observable state/log location,
- retryability classification,
- operator action,
- safe replay procedure,
- verification that no duplicate side effect occurred.

Until those behaviours exist in code, this file should remain deliberately concise.
