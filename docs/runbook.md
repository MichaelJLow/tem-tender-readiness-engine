# Runbook

## Status

This is a **living operational document**. It describes the local Milestone 2 API. Cloud operations, retries, and replay controls will be added when those capabilities exist.

## Local API

- Start with `npm run dev:api` after `npm ci`.
- Configure `PORT` and `TENDER_STATE_PATH` with environment variables. Defaults are port `3000` and `./data/tender-state.json`.
- Submit a JSON domain `ReadinessInput` to `POST /tenders` with `Content-Type: application/json`.
- The service returns `200` for a completed decision, `202` while a required document remains pending, `400` for invalid JSON/input, `409` when an idempotency key is reused for different content, and `502` when the mock pricing handoff fails.
- Each response includes `X-Correlation-ID`. Supply a printable `X-Correlation-ID` of up to 128 characters to carry one through the request; otherwise the API generates one.
- State is stored in a versioned JSON file and writes are atomic within one local process. Do not run multiple API instances against the same file.
- If the state file is malformed or inaccessible, the API returns a technical failure and logs the correlation ID. Preserve the file for diagnosis; repair or move it only after inspecting it.

Example request body:

```json
{
  "tender": {
    "tenderId": "tender-local-001",
    "idempotencyKey": "intake-local-001",
    "customer": { "customerId": "customer-001", "legalName": "Northstar Foods Ltd" },
    "broker": { "brokerId": "broker-001", "legalName": "Harbour Energy Partners" },
    "sites": [{
      "siteId": "site-001",
      "address": "10 Example Street, London",
      "meterIdentifier": "1234567890123",
      "annualConsumptionKwh": 24000,
      "contractEndDate": "2027-03-31"
    }],
    "documents": []
  }
}
```

Stop the process with Ctrl+C. A repeated request with the same idempotency key and normalized payload returns the stored result and does not create another mock pricing handoff.

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

