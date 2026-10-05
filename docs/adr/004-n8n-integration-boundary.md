# ADR-004: Keep n8n as integration orchestration only

## Status

Accepted for the local Milestone 7 intake workflow. Fresh-import execution and
merge evidence are in the [Milestone 7 receipt](../milestone-7-verification.md).

## Context

The Tender API already owns Zod validation, deterministic routing, bounded
interpretation, idempotency, review audit, and the mocked pricing guard. n8n is
the advertised integration layer, but a second copy of business policy on the
canvas would hide the decision engine and could initiate an unsafe pricing call.

## Decision

- Export one credential-free workflow that normalizes a small webhook envelope
  and forwards the existing `IntakeRequest` to `POST /tenders`.
- Give the workflow a single HTTP Request node, and point that node at the
  Tender API. n8n does not call the pricing gateway.
- Map `COMPLETED` routes to synthetic receipts. `NEEDS_INFORMATION` reports the
  API-persisted `NOT_SENT` receipt. `HUMAN_REVIEW` links the existing Console
  case. `DUPLICATE` stops. Technical failures stay on the error path even when
  the API retains `READY_FOR_PRICING`.
- Accept structured records, notes, and already-extracted document text only.
  Do not download, parse, or register PDFs in this workflow.

## Alternatives considered

- Recreate routing inside n8n Switch/IF nodes: rejected because it duplicates
  domain policy and is harder to test.
- Let n8n call the mocked pricing gateway after a ready route: rejected because
  it breaks the API-owned pricing guard and can create a second handoff.
- Send a real information-request email from n8n: rejected; the prototype only
  records a synthetic `NOT_SENT` receipt.

## Rationale

Keeping n8n at the transport boundary preserves inspectable TypeScript policy
and the hard `READY_FOR_PRICING` invariant. The exported JSON can be imported
into a pinned n8n `1.112.6` runtime without credentials.

## Consequences

- Reviewers reproduce intake with Docker or a host-installed n8n, not by
  reading unit tests alone.
- Document registration/upload remains a later, optional intake step.
- n8n retry loops are forbidden; the API owns transient model and gateway
  retries.
