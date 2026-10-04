# Local n8n tender intake

This directory contains the exported local intake workflow for n8n `1.112.6`. It
normalizes a small webhook transport envelope, forwards the existing API-owned
`IntakeRequest` to `POST /tenders`, and records the integration outcome returned
by the API. It does not contain readiness rules, model prompts, document parsing,
credentials, or downstream pricing logic.

## Contract

Send `POST /webhook/tender-intake` with `Content-Type: application/json`:

```json
{
  "correlationId": "n8n-clean-001",
  "request": {
    "tender": {},
    "signals": {},
    "textSources": []
  }
}
```

`request` is passed unchanged to the Tender API. The workflow requires printable
ASCII `correlationId`, `request.tender.tenderId`, and
`request.tender.idempotencyKey` values, limits the serialized webhook body to 1
MiB, and sends the correlation ID as `X-Correlation-ID`. The API remains the
authority for full Zod validation, idempotency, routing, model interpretation,
and the `READY_FOR_PRICING` pricing guard.

Only structured records, notes, and already-extracted document text are accepted.
A `DOCUMENT_TEXT` source must reference a document already present in
`request.tender.documents`; that relationship is validated by the API. This
integration does not download or parse PDFs and does not introduce live S3
intake.

Transport failures return visible 4xx JSON responses. Tender API responses,
including validation and processing failures, retain their HTTP status and body.
Malformed JSON is rejected by n8n before the normalization node runs.

## Outcome contract

Successful API response bodies are returned unchanged except for an added
`integrationOutcome` object. The object is a synthetic execution receipt in the
n8n response and execution record; it is not a new domain decision or durable
delivery service.

| API status and route                                                 | `integrationOutcome.type`      | Integration behaviour                                                                                                                                       |
| -------------------------------------------------------------------- | ------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `COMPLETED` + `READY_FOR_PRICING`                                    | `PRICING_HANDOFF_RECORDED`     | Records that the API-owned mock handoff succeeded. `pricingOwner` is `TENDER_API` and `handoffAttemptsInitiatedByWorkflow` is `0`; n8n never calls pricing. |
| `COMPLETED` + `NEEDS_INFORMATION`                                    | `INFORMATION_REQUEST_RECORDED` | Produces a synthetic receipt with `deliveryStatus: NOT_SENT`. No email, chat message, webhook, or other outbound message is sent.                           |
| `COMPLETED` + `HUMAN_REVIEW`                                         | `HUMAN_REVIEW_AVAILABLE`       | Returns `consolePath: /tenders/{runId}` for the existing Console case. It does not create a review task or change the route.                                |
| `COMPLETED` + `DUPLICATE`                                            | `DUPLICATE_RECORDED`           | Stops with an inspectable run/key and no downstream action.                                                                                                 |
| `PROCESSING` with no route                                           | `PENDING`                      | Retains HTTP `202` and waits for a later replay after document processing.                                                                                  |
| `FAILED`, a non-2xx API response, or any response carrying `failure` | `TECHNICAL_ERROR`              | Preserves any retained business route and follows the technical error path. No business action is reported as successful.                                   |

Every outcome explicitly reports `outboundMessagesSent: 0`. The stable synthetic
information-request key is `information-request:{runId}`. API idempotency returns
the same `runId` on redelivery, so the key is stable for the subsequent
reliability/idempotency work without pretending that a message has been sent.
The workflow has only one HTTP Request node, and that node calls `POST /tenders`.

A Console review disposition of `REQUEST_INFORMATION` is a separate audit event.
It remains attached to the `HUMAN_REVIEW` case and is not transformed into an
`INFORMATION_REQUEST_RECORDED` receipt or presented as outbound delivery.

## Run locally with Docker (recommended)

Start the Tender API in one terminal with disposable synthetic state. It must
listen on an interface reachable from the n8n container; do not expose the
Console, review endpoints, or n8n editor publicly.

```sh
HOST=0.0.0.0 PORT=3000 TENDER_STATE_PATH=/tmp/eng-5-tender-state.json npm run dev:api
```

Start the pinned n8n image in another terminal:

```sh
docker run --rm --name tem-n8n \
  --add-host=host.docker.internal:host-gateway \
  -p 127.0.0.1:5678:5678 \
  -e TENDER_API_URL=http://host.docker.internal:3000 \
  -v tem-n8n-data:/home/node/.n8n \
  docker.n8n.io/n8nio/n8n:1.112.6
```

The `127.0.0.1` port binding keeps the unauthenticated local editor off external
interfaces. Import `tender-intake.workflow.json`, open it, and activate it. Do
not publish port `3000`, port `5678`, the operations Console, or review mutation
routes to the internet. Binding the API to `0.0.0.0` is only for container-to-host
development on a trusted machine with no public port forwarding.

If n8n runs directly on the host instead, start it with
`TENDER_API_URL=http://127.0.0.1:3000`; the API can retain its default loopback
binding. Docker's `localhost` refers to the container, which is why the Docker
command uses the host-gateway name.

## Verify

With the imported workflow active, submit the structured-only fixture (no model
provider key is needed):

```sh
curl --fail-with-body --silent --show-error \
  -H 'Content-Type: application/json' \
  --data @integrations/n8n/fixtures/clean.json \
  http://127.0.0.1:5678/webhook/tender-intake
```

The response should contain the fixture's `tenderId` and `correlationId`, a UUID
`runId`, `status: "COMPLETED"`, `route: "READY_FOR_PRICING"`, and a
`PRICING_HANDOFF_RECORDED` integration outcome. Inspect the disposable state or
query `GET /tenders` to correlate that run. Repeating the same request returns
the same stored outcome with `replayed: true`, the same integration key, and does
not create a second pricing handoff.

### Reproducible route walkthrough

Use a fresh disposable API state file, then send these fixtures **in order**.
They are derived from the repository's domain fixtures and retain deliberately
synthetic source/document references.

| Order | Fixture                  | Expected HTTP and observed workflow outcome                                                               |
| ----- | ------------------------ | --------------------------------------------------------------------------------------------------------- |
| 1     | `clean.json`             | `200`, `COMPLETED` + `READY_FOR_PRICING`, one API-owned handoff, `PRICING_HANDOFF_RECORDED`               |
| 2     | `needs-information.json` | `200`, `COMPLETED` + `NEEDS_INFORMATION`, `INFORMATION_REQUEST_RECORDED`, no message or handoff           |
| 3     | `human-review.json`      | `200`, `COMPLETED` + `HUMAN_REVIEW`, `HUMAN_REVIEW_AVAILABLE` with the run-based Console path, no handoff |
| 4     | `pending.json`           | `202`, `PROCESSING` with no business route, `PENDING`, no handoff                                         |
| 5     | `duplicate.json`         | `200`, `COMPLETED` + `DUPLICATE`; it reuses the clean tender ID with a new key, so it must follow step 1  |

```sh
for fixture in clean needs-information human-review pending duplicate; do
  printf '\n=== %s ===\n' "$fixture"
  curl --fail-with-body --silent --show-error \
    -H 'Content-Type: application/json' \
    --data "@integrations/n8n/fixtures/$fixture.json" \
    http://127.0.0.1:5678/webhook/tender-intake
  printf '\n'
done

curl --fail-with-body --silent --show-error http://127.0.0.1:3000/tenders
```

The final API projection must contain exactly one pricing handoff, owned by the
clean run. Verify each response retains its fixture correlation ID and a run ID;
the human-review response must also retain both synthetic date-fact evidence
source IDs. The API projection is the authoritative check for source/document
references because `integrationOutcome` is intentionally only a compact receipt.

For the technical failure path, stop the API while leaving n8n running and
submit any valid fixture. Expect HTTP `502`, `TENDER_API_UNAVAILABLE`, the input
correlation ID, `integrationOutcome.type: TECHNICAL_ERROR`, and zero outbound
messages. Restart the API before continuing. This is a transport failure test;
do not edit a successful response or use pinned canvas data as evidence.

The text-bearing fixture includes one `NOTE` and one `DOCUMENT_TEXT` with a valid
document reference. It requires a configured model provider because semantic
interpretation is API-owned:

```sh
curl --fail-with-body --silent --show-error \
  -H 'Content-Type: application/json' \
  --data @integrations/n8n/fixtures/text-bearing.json \
  http://127.0.0.1:5678/webhook/tender-intake
```

Useful failure checks:

```sh
# Missing required transport identifier -> 400 TRANSPORT_VALIDATION_FAILED
curl --silent --show-error -H 'Content-Type: application/json' \
  --data '{"request":{"tender":{"tenderId":"tender-no-key"}}}' \
  http://127.0.0.1:5678/webhook/tender-intake

# Malformed JSON -> n8n 4xx
curl --silent --show-error -H 'Content-Type: application/json' \
  --data '{broken' http://127.0.0.1:5678/webhook/tender-intake

# Valid transport but invalid API contract -> 400 INVALID_TENDER
curl --silent --show-error -H 'Content-Type: application/json' \
  --data '{"correlationId":"n8n-invalid-001","request":{"tender":{"tenderId":"tender-invalid","idempotencyKey":"invalid-001"}}}' \
  http://127.0.0.1:5678/webhook/tender-intake
```

The workflow's 1 MiB transport limit can be checked with a generated request;
the API independently enforces the same byte ceiling. Automated export and
fixture checks run with `npm test -- integrations/n8n/workflow.test.ts`.
Record executed results using the receipt template and evidence rules in
[`docs/milestone-7-verification.md`](../../docs/milestone-7-verification.md).
