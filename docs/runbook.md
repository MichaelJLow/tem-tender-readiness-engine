# Runbook

## Status

This is a **living operational document**. It describes the local API, including bounded interpretation of notes and extracted document text. Cloud operations and operator-controlled replay will be added when those capabilities exist.

## Local API

- Start with `npm run dev:api` after `npm ci`.
- Start the operations console in a second terminal with `npm run dev:console`; open `http://localhost:3001`. It reads the API at `TENDER_API_URL` (default `http://127.0.0.1:3000`) and the retained report files in `EVALS_DIR` (default `./evals`). Mastra Studio remains on `4113`. Use only synthetic tender data. The review mutation API is enabled only when `HOST` is loopback; the console's demo operator label is not production authentication.
- To populate the local console with three repeatable synthetic examples, start the API and run `npm run demo:seed`. The clean example records one mocked handoff; the missing-information and conflicting-date examples do not. Re-running uses the fixture idempotency keys and returns the stored results.
- Configure `PORT`, `HOST`, and `TENDER_STATE_PATH` with environment variables. Defaults are port `3000`, host `127.0.0.1` (loopback only), and `./data/tender-state.json`. Set `HOST` explicitly only when the API must accept connections from another interface.
- Structured-only requests do not call a model and do not need a model-provider key. Requests with `textSources` invoke the Mastra Tender Interpretation Agent. Set `OPENROUTER_API_KEY` to use OpenRouter (default model `openai/gpt-6-luna`), or set `OPENAI_API_KEY` to use OpenAI (default model `gpt-6-luna`). `OPENROUTER_MODEL` and `OPENAI_MODEL` override provider defaults. For another OpenAI-compatible provider, set `MODEL_API_KEY`, `MODEL_API_BASE_URL`, and `MODEL_ID`; these generic settings take precedence. Keep keys in an untracked `.env` file or deployment secrets.
- Model responses default to a 8,192-token output cap to avoid providers reserving unnecessary spend for unusually long responses. Set `MODEL_MAX_OUTPUT_TOKENS` to a positive integer to override it for a provider/model that needs more room.
- To open the registered interpretation agent and eval workflows in Mastra Studio, set `PORT=4113` and run `npm run dev:studio --workspace @tem-tender-readiness/api` from the repository root, then open `http://localhost:4113` (PowerShell: `$env:PORT = '4113'`). Port `4113` is reserved for this repository's Studio so its datasets, experiments, traces, and metrics are in the expected project UI. Do not start a second Studio instance for this repo; if the port is occupied, identify its process before restarting it. The command needs a provider key above in the process environment (or local `.env`). Studio is for agent inspection and local experiments; the tender API remains the production decision path.
- Studio stores local traces, metrics, logs, datasets, and experiments under its ignored `src/mastra/public/data/` directory. A Studio agent call appears in that Studio's observability views. The tender API runs in a separate process and currently writes its own structured logs and model trace records to tender state; its calls do not appear in Studio's traces. Use synthetic data in Studio because traces include model inputs and outputs.
- Interpretation runs inside the API process. The model receives only the tender context needed for site association and the submitted note/extracted text. It has no tools or pricing access. Provider failure returns a technical failure and cannot assign a route or call pricing.
- A site-scoped extracted fact must cite a quote containing both its value and a unique known site ID, meter identifier, or full address. Unclear or conflicting identity routes to `HUMAN_REVIEW`, including for a single-site tender.
- Submit a JSON domain `ReadinessInput` to `POST /tenders` with `Content-Type: application/json`.

## Local n8n intake

The credential-free Milestone 7 webhook export, pinned n8n version, synthetic
fixtures, Docker host-gateway setup, and verification commands live in
[`integrations/n8n/README.md`](../integrations/n8n/README.md). n8n normalizes transport, forwards the existing API contract, and records
synthetic integration outcomes. The API continues to own validation,
idempotency, readiness rules, interpretation, and the pricing guard.

Keep n8n's editor bound to loopback. Do not expose it, the operations Console,
or review endpoints publicly. Containerized n8n reaches the host API through the
documented host-gateway name rather than `localhost`; a host-installed n8n can
use the API's loopback URL.

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

## Milestone 5 console walkthrough

For a screenshot session, start the API with a new `TENDER_STATE_PATH` (for
example `data/console-screenshot-state.json`) and a free loopback `PORT`. Point
the Console and `npm run demo:seed` at that API using `TENDER_API_URL`. Stop any
existing Console dev process in this checkout before starting another one;
Next.js uses one build directory per checkout. For clean captures without the
development badge, run `npm run build:console` and then `npm run start --workspace
@tem-tender-readiness/console`. Use a 1500 px wide desktop viewport. The
resulting PNGs and captions are in [the screenshot set](screenshots/operations-console/README.md).

With the API and console running, use `npm run demo:seed` to create the three
synthetic cases. In Queue, open the conflicting-date case. The Contract end
date evidence panel places the submitted site date beside each recorded date
fact, its site ID, and source reference. Compare the values before choosing a
review disposition. Source references in this fixture do not include original
contract files, so an unresolved conflict should be recorded as
`REQUEST_INFORMATION` with a reason and the relevant evidence IDs.
For this fixture, cite `site-001`, `contract-a`, and `contract-b`; the site
record and `contract-a` say `2027-03-31`, while `contract-b` says `30/09/2026`.

Recording a disposition appends an audit event and closes the review task. It
does not send an information request, change the automatic `HUMAN_REVIEW`
route, or invoke pricing. Refresh to inspect Review history. Open the clean and
missing-information cases to confirm they offer no review action. In
Performance, compare the accepted baseline with the latest completed report;
the Studio links are optional drill-down. The latest full report passed 9/9
gates on 63 synthetic workflow cases, with 0 unsafe-ready outcomes, 0 non-ready
pricing calls, 51/51 agent facts, and 51/51 workflow critical facts. The
accepted baseline passed 7/7 gates on 63 cases, with 51/51 agent facts and
49/51 workflow critical facts. The latest run is not the accepted baseline.

## Milestone 3 live model smoke check

Completed locally on 2026-09-26 using `OPENROUTER_API_KEY` and `openai/gpt-6-luna`: a synthetic tender with `textSources` returned `COMPLETED`, `READY_FOR_PRICING`, a successful interpretation, and a model trace. The pricing handoff was mocked. API logs contained run metadata but neither the key nor source text. Repeat this check after material model or prompt changes. Do not use real tender or customer data.

A separate Studio smoke call confirmed one persisted agent trace and metrics for model usage, tokens, and latency. Studio logs captured startup events; agent runs are inspected in Traces. Studio does not score readiness routes by itself; labelled eval fixtures and the deterministic rules remain the release gate.

With Studio running, run `node tests/studio-smoke.mjs` from the repository root to record eight synthetic Milestone 3 cases as an unscored Studio agent experiment. Milestone 4's scored suites and reports are documented below.

## Milestone 4 scored evals

The canonical synthetic cases are in `evals/cases.ts`; the same immutable, hash-versioned cases seed agent and decision-path datasets. Stop Studio before running either scored eval because it shares the eval runner's DuckDB store. With the configured model provider key in the environment, run:

```powershell
npm run eval:pr
npm run eval:full
```

The PR command evaluates 14 representative cases; the full command evaluates the current complete labelled set. Each runs an agent experiment for text-bearing, non-duplicate cases and a workflow experiment for all selected cases. Duplicate handling short-circuits interpretation in the real workflow, so duplicate cases are covered by the workflow experiment only. The workflow exercises the existing `TenderService` and deterministic domain rules with fresh in-memory state and a mock pricing gateway. Model facts are evaluated as evidence only; they never fill missing structured tender fields.

Run the commands from the repository root with the same `MASTRA_DATA_DIR` used by Studio (the default is `apps/api/src/mastra/public/data`). After the eval finishes, restart Studio on port `4113` to inspect its persisted experiments and traces. Do not run Studio and an eval concurrently against the same store.

Both runs persist datasets, experiments, scorer results, and traces to the same local Mastra storage used by this repository's Studio (`apps/api/src/mastra/public/data` by default) and write a portable JSON report plus Markdown summary under `evals/reports/`. Set `MASTRA_DATA_DIR` explicitly if Studio is configured with a different path. Reports include labels, denominators, per-case outcomes, metrics, thresholds, verdict, source revision, and Studio experiment IDs. If Studio setup or an experiment is interrupted, the report records an incomplete verdict, a `runError` stage, and failed outcomes, then exits unsuccessfully. Review a report before accepting it as a baseline. Cases and reports remain readable when Studio traces expire. The current dataset has 63 cases. The accepted synthetic Milestone 4 baseline is identified by `evals/accepted-baseline.json`; earlier incomplete runs remain diagnostic evidence in `docs/eval-findings.md`. A passing PR report does not substitute for a passing full run, manual QA, or review before accepting a baseline.

These commands make live model calls and may incur provider charges. Without a configured API key they write an explicit `not_run` report and exit with a nonzero status. Set `EVAL_REPORT_DIR` to change the report output directory. Never include real tender data in Studio, traces, or reports.

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

## Failure taxonomy and operator response

The API emits one-line JSON logs. `tender.operation_failed` contains a timestamp,
failure code and stage, retryability, attempt number, correlation ID, and the
tender/run IDs when they exist. Model failures also carry the trace ID. Logs do
not include request bodies, source text, credentials, provider errors, or file
contents. A state-write failure while recording another failure uses
`STATE_WRITE_FAILED` and preserves the original classification in `causeCode`;
it is never reported as if the model or gateway write had succeeded.

| Failure / stage                             | Detection and retained state                                                                                                                                                                                       | Retryability                                                                                       | Operator action                                                                                                                                                     |
| ------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `API_TRANSPORT_FAILED` / `API_TRANSPORT`    | HTTP `400`, `413`, or `415`; correlated `tender.operation_failed` log. No run is created.                                                                                                                          | Terminal for the unchanged request.                                                                | Correct the correlation header, content type, size, JSON, or schema issue and submit a new valid request.                                                           |
| `STATE_READ_FAILED` / `STATE_READ`          | HTTP `500` response and correlated failure log; tender ID is present after request validation, but a run ID may not exist. Existing state is not changed.                                                          | Retryable after storage recovery.                                                                  | Preserve and inspect the configured state file and filesystem access. Restore readability, then replay the same idempotency key.                                    |
| `STATE_WRITE_FAILED` / `STATE_WRITE`        | HTTP `500` response and correlated failure log. The response/log includes a run ID if it was already allocated and `causeCode` if recording another failure failed. The attempted update may be absent from state. | Retryable after storage recovery.                                                                  | Inspect disk space, permissions, and the state file without deleting it. Restore writes, inspect the retained run/handoff, then replay the same idempotency key.    |
| `MODEL_PROVIDER_FAILED` / `INTERPRETATION`  | HTTP `502`, failed run without a route, failed model trace, and correlated failure log.                                                                                                                            | The response says whether the provider error was transient/timeout (`true`) or terminal (`false`). | For retryable failures, verify provider health/configuration and replay the same idempotency key. For terminal failures, correct configuration before replay.       |
| `MODEL_OUTPUT_INVALID` / `INTERPRETATION`   | HTTP `500`, failed run without a route, failed trace, and correlated failure log.                                                                                                                                  | Terminal for the same model output.                                                                | Inspect the trace/schema diagnostics without copying source text into logs. Correct the model/prompt/schema issue and use the eval gate before a controlled replay. |
| `READINESS_EVALUATION_FAILED` / `READINESS` | HTTP `500`, failed run without a successful route transition, and correlated failure log.                                                                                                                          | Terminal until code/input handling is corrected.                                                   | Preserve the synthetic input and rule context, fix and test deterministic evaluation, then replay the idempotency key.                                              |
| `PRICING_GATEWAY_FAILED` / `PRICING`        | HTTP `502`, failed technical status with the already-decided `READY_FOR_PRICING` route, and correlated failure log.                                                                                                | Retryable.                                                                                         | Verify gateway health and whether the handoff key already exists, then replay the same idempotency key. The gateway's idempotency guard prevents a second handoff.  |

The local JSON repository is the implemented persistence boundary. The n8n
intake and outcome workflow is documented in
[`integrations/n8n/README.md`](../integrations/n8n/README.md); it does not own
these API failure codes. Source document storage and parsing are not implemented,
so this table does not claim failure codes for those future boundaries.

## Recovery model

Failures are classified as either **retryable** or **terminal** in the response,
persisted run when persistence remains available, and structured log.

A retry/replay action must be idempotent. In particular, it must not:

- create a second tender,
- send a second pricing request,
- create duplicate information requests,
- create duplicate review tasks.

## Failure scenarios to rehearse

Before the stable interview release, document and test the real recovery procedure for:

1. configured model-provider timeout/transient failure
2. invalid model output
3. mocked pricing gateway failure
4. duplicate API delivery
5. state read failure
6. state write failure, including while a failure record is being saved
7. malformed, oversized, or unsupported API transport input

## Runbook completion criteria

This document is considered complete when each implemented failure path includes:

- detection signal,
- observable state/log location,
- retryability classification,
- operator action,
- safe replay procedure,
- verification that no duplicate side effect occurred.

Add document storage and parsing failure cases when those boundaries exist.
Rehearse n8n transport and outcome handling using the synthetic workflow
fixtures documented in [`integrations/n8n/README.md`](../integrations/n8n/README.md).

## Milestone 6 archive and restore

The API, Console and Studio remain local. S3 stores private, manual snapshots
of synthetic evidence. It is not the live tender database and does not contain
Studio's DuckDB files, experiments or raw traces. The live S3 upload, restore,
private-access checks, and local Console walkthrough against a fresh S3 restore passed on 4 October 2026; see the
[Milestone 6 acceptance receipt](milestone-6-verification.md). Checking the
promotional AWS credit balance/expiry remains a non-blocking account follow-up.

Use a separate demo state path and `npm run demo:seed`, then record a
`REQUEST_INFORMATION` disposition for the conflicting-date case with a reason
and citations to `site-001`, `contract-a` and `contract-b`. Stop the API using
that file before preparing a snapshot. Other local processes using different
state files can remain running. Inspect reviewer notes and any optional source
files to confirm they are synthetic and contain no credentials.

From the repository root, prepare and restore locally without AWS credentials:

```powershell
npm run demo:archive -- --state data/screenshot-state-2026-09-29.json --output data/archive-local --api-stopped --synthetic
npm run demo:restore -- --from data/archive-local --output data/restored-local
```

The parent `data` directory must exist, and each output directory must be new.
The archive takes `--state` / `--evals`, or `TENDER_STATE_PATH` / `EVALS_DIR`,
falling back to `data/tender-state.json` / `evals`. Add an individually reviewed
synthetic file with `--source path/to/synthetic-note.txt`; repeat the option for
another file. Allowed source extensions are TXT, CSV, JSON and PDF. No PDFs
are generated or parsed here, and the current seed has source references rather
than original contract files. Do not add invented source files to fill that gap.

The snapshot contains:

```text
manifest.json
state/tender-state.json
evals/accepted-baseline.json
evals/reports/<accepted-run>.json
evals/reports/<accepted-run>.md   # when available
evals/reports/<latest-run>.json
evals/reports/<latest-run>.md     # when available
sources/<number>-<filename>      # only explicitly selected files
```

The manifest records time, snapshot ID, sizes and SHA-256 checksums. Accepted
and latest may refer to the same report in a future demo; the pointer remains
the acceptance authority. Snapshots are limited to 32 files, 16 MiB per file
and 64 MiB total. State must match the three known seeded cases, their review
audit and one ready-only mocked handoff. An absent audit or extra case fails
visibly; use a separate fresh demo state rather than editing existing state.

After account/region/credits and the private bucket are verified, install AWS
CLI v2 if needed and configure a normal profile outside the repository. A web
Console sign-in does not by itself authenticate the local CLI. Upload the
already prepared snapshot with your actual bucket, region, account ID and
profile (omit `--profile` to use the default credential chain):

```powershell
npm run demo:archive -- --output data/archive-local --upload-existing --synthetic --bucket YOUR_PRIVATE_BUCKET --region YOUR_REGION --owner YOUR_12_DIGIT_ACCOUNT_ID --profile YOUR_PROFILE
npm run demo:restore -- --bucket YOUR_PRIVATE_BUCKET --region YOUR_REGION --owner YOUR_12_DIGIT_ACCOUNT_ID --profile YOUR_PROFILE --snapshot SNAPSHOT_ID_FROM_ARCHIVE_OUTPUT --output data/restored-s3
```

Objects live under `snapshots/<snapshot-id>/`. Upload verifies the local package
and writes its manifest last, with conditional writes that refuse existing
keys. A failed upload leaves no complete manifest. For a retry after a partial
upload, prepare a new snapshot in another fresh output directory; do not delete
or overwrite an existing S3 prefix. The local snapshot remains intact if an
AWS operation fails. No CLI stderr, key or environment contents are logged.

Restore verifies every object before creating the destination. Missing files,
changed checksums, unsupported paths, invalid schemas or broken report pointers
fail visibly. An existing directory is always refused, even if empty. A local
write failure can leave an incomplete directory without a manifest; preserve it
for diagnosis and use a different fresh destination after resolving the error.

To inspect a restored demo, start a separate API against its files on a free
loopback port, then point the Console at that API:

```powershell
# API terminal
$env:TENDER_STATE_PATH = (Resolve-Path data/restored-local/state/tender-state.json).Path
$env:EVALS_DIR = (Resolve-Path data/restored-local/evals).Path
$env:PORT = '3002'
npm run dev:api

# Console terminal: stop this checkout's existing Console before restarting it.
$env:TENDER_API_URL = 'http://127.0.0.1:3002'
npm run dev:console
```

For an S3 restore replace `restored-local` with `restored-s3`. Do not reseed or
submit cases during this verification. Confirm the same three routes, recorded
review disposition, distinct accepted/latest metrics and one mocked handoff
for the ready case. Restarting and viewing the archive must not make another
handoff. Studio stays on `4113`; its links are optional local drill-down and
the restored reports remain readable without it.
