# Runbook

## Status

This is a **living operational document**. It describes the local API, including bounded interpretation of notes and extracted document text. Cloud operations and operator-controlled replay will be added when those capabilities exist.

## Local API

- Start with `npm run dev:api` after `npm ci`.
- Configure `PORT`, `HOST`, and `TENDER_STATE_PATH` with environment variables. Defaults are port `3000`, host `127.0.0.1` (loopback only), and `./data/tender-state.json`. Set `HOST` explicitly only when the API must accept connections from another interface.
- Structured-only requests do not call a model and do not need a model-provider key. Requests with `textSources` invoke the Mastra Tender Interpretation Agent. Set `OPENROUTER_API_KEY` to use OpenRouter (default model `openai/gpt-6-luna`), or set `OPENAI_API_KEY` to use OpenAI (default model `gpt-6-luna`). `OPENROUTER_MODEL` and `OPENAI_MODEL` override provider defaults. For another OpenAI-compatible provider, set `MODEL_API_KEY`, `MODEL_API_BASE_URL`, and `MODEL_ID`; these generic settings take precedence. Keep keys in an untracked `.env` file or deployment secrets.
- To open the registered interpretation agent in Mastra Studio, run `npm run dev:studio --workspace @tem-tender-readiness/api` from the repository root, then open the Studio URL printed by the CLI. The default port is `4111`; Mastra chooses another available port if it is occupied. The command needs a provider key above in the process environment (or local `.env`). Studio is for agent inspection and local experiments; the tender API remains the production decision path.
- Studio stores local traces, metrics, logs, datasets, and experiments under its ignored `src/mastra/public/data/` directory. A Studio agent call appears in that Studio's observability views. The tender API runs in a separate process and currently writes its own structured logs and model trace records to tender state; its calls do not appear in Studio's traces. Use synthetic data in Studio because traces include model inputs and outputs.
- Interpretation runs inside the API process. The model receives only the tender context needed for site association and the submitted note/extracted text. It has no tools or pricing access. Provider failure returns a technical failure and cannot assign a route or call pricing.
- A site-scoped extracted fact must cite a quote containing both its value and a unique known site ID, meter identifier, or full address. Unclear or conflicting identity routes to `HUMAN_REVIEW`, including for a single-site tender.
- Submit a JSON domain `ReadinessInput` to `POST /tenders` with `Content-Type: application/json`.
- The service returns `200` for a completed decision, `202` while a required document remains pending, `400` for invalid JSON/input, `409` when an idempotency key is reused for different content, and `502` when the model provider or mock pricing handoff fails. Invalid model evidence returns a technical failure without a business route.
- Each response includes `X-Correlation-ID`. Supply a printable `X-Correlation-ID` of up to 128 characters to carry one through the request; otherwise the API generates one.
- State is stored in a versioned JSON file and writes are atomic within one local process. Do not run multiple API instances against the same file.
- If the state file is malformed or inaccessible, the API returns a technical failure and logs the correlation ID. Preserve the file for diagnosis; repair or move it only after inspecting it.

Example request body with an optional note (omit `textSources` for structured-only intake):

```json
{
  "tender": {
    "tenderId": "tender-local-001",
    "idempotencyKey": "intake-local-001",
    "customer": { "customerId": "customer-001", "legalName": "Northstar Foods Ltd" },
    "broker": { "brokerId": "broker-001", "legalName": "Harbour Energy Partners" },
    "sites": [
      {
        "siteId": "site-001",
        "address": "10 Example Street, London",
        "meterIdentifier": "1234567890123",
        "annualConsumptionKwh": 24000,
        "contractEndDate": "2027-03-31"
      }
    ],
    "documents": []
  },
  "textSources": [
    {
      "sourceId": "broker-note-001",
      "kind": "NOTE",
      "text": "The contract for site-001 ends on 2027-03-31."
    }
  ]
}
```

Stop the process with Ctrl+C. A repeated request with the same idempotency key and normalized payload returns the stored result and does not create another mock pricing handoff.

## Milestone 3 live model smoke check

Completed locally on 2026-09-26 using `OPENROUTER_API_KEY` and `openai/gpt-6-luna`: a synthetic tender with `textSources` returned `COMPLETED`, `READY_FOR_PRICING`, a successful interpretation, and a model trace. The pricing handoff was mocked. API logs contained run metadata but neither the key nor source text. Repeat this check after material model or prompt changes. Do not use real tender or customer data.

A separate Studio smoke call confirmed one persisted agent trace and metrics for model usage, tokens, and latency. Studio logs captured startup events; agent runs are inspected in Traces. Studio does not score readiness routes by itself; labelled eval fixtures and the deterministic rules remain the release gate.

With Studio running, run `node tests/studio-smoke.mjs` from the repository root to record eight synthetic interpretation cases as a Studio dataset experiment. Set `MASTRA_STUDIO_URL` if Studio is on another port. The dataset name includes a fixture hash, so changed cases create a new version and an unchanged rerun verifies the stored inputs before use. Run with `--verify-only` to check stored fixtures without making model calls. Open the dataset in Studio to inspect each input, expected behavior, output, and trace. A completed experiment means the model calls succeeded; these cases have descriptive ground truth for manual review and no automatic accuracy scorer yet. Run `npm run check` separately for deterministic tests, lint, formatting, and typecheck; those results are not stored as Studio agent runs. Milestone 4 adds scored, labelled evals and release thresholds.

## Milestone 3 merge gate

- Run `npm run check`, `npm run build:api`, and `git diff --check` on the complete change set.
- Confirm the synthetic safety cases cover matching, missing, wrong, unknown, and multiple site references; document and note evidence; non-ready pricing guards; provider failures; replay; and Milestone 2 state compatibility.
- Resolve all known P1/P2 findings in one change set. Repeat the provider-backed smoke check if model configuration, prompt, or interpretation behavior changes.

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
