# Local n8n tender intake

This directory contains the exported local intake workflow for n8n `1.112.6`. It
normalizes a small webhook transport envelope and forwards the existing API-owned
`IntakeRequest` to `POST /tenders`. It does not contain readiness rules, model
prompts, document parsing, credentials, or downstream pricing logic.

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
`runId`, `status: "COMPLETED"`, and `route: "READY_FOR_PRICING"`. Inspect the
disposable state or query `GET /tenders` to correlate that run. Repeating the
same request returns the same stored outcome with `replayed: true` and does not
create a second pricing handoff.

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
