# ADR-002: Keep local review history separate from automatic tender decisions

## Status

Accepted for Milestone 5 local prototype

## Context

Milestone 5 adds an operator console to an API that currently stores runs and mock pricing handoffs in a versioned local JSON file. The API owns deterministic readiness decisions and is the only component that can call the pricing gateway. The console needs to show cases, retain human dispositions, and display portable eval reports. The local file store supports one API process and the console has no production authentication.

## Decision

- Keep human review dispositions in append-only review events with actor label, timestamp, action, reason, source references, request ID, and review version. Derive whether a review task is open from its event history; do not rewrite an earlier event.
- Keep the human disposition separate from the run's automatic route and technical processing status. A manual resolution or duplicate determination records operator judgment and closes the review task; it does not set a new route, edit the original decision, or invoke pricing. Reopening appends a new event.
- Permit review writes only while the API is bound to a loopback host. The local demo actor comes from server configuration and is not accepted from request input. A hosted console requires an authentication and authorization design before exposing these commands.
- Keep the console as a separate Next.js workspace that accesses tender state and eval summaries through API projections. The browser does not read local state or Mastra Studio storage directly.
- Read eval reports as validated, read-only files. `accepted-baseline.json` remains the acceptance authority; a newer passing report is not promoted automatically.

## Alternatives considered

- Let the UI rewrite the route or mark a blocked tender ready: rejected because it would bypass the deterministic decision path and could create an unsafe pricing side effect.
- Store review state in browser-local storage: rejected because the history would be lost, per-browser, and unavailable to later operators.
- Read JSON state and Studio database files directly from the console: rejected because it duplicates storage contracts and couples UI behavior to local-only internals.
- Add hosted database/auth infrastructure now: deferred to Milestone 6, where runtime and persistence choices are in scope.

## Rationale

An operator must be able to document a reasoned outcome without mutating the evidence that produced the original decision. This preserves an auditable history and the invariant that only a deterministic `READY_FOR_PRICING` route can reach the mocked gateway. API projections keep the future persistence replacement behind an existing repository boundary.

## Consequences

- A resolved review task can still display its original `HUMAN_REVIEW` business route. The UI labels this distinction explicitly.
- `REQUEST_INFORMATION` records the disposition but does not send a real message. Corrected information must enter a separately designed intake/re-evaluation path.
- Local single-process write serialization is sufficient for this demo; concurrent hosted operators require transactional persistence and authentication in a later milestone.
- Eval performance remains readable when Studio traces are unavailable because the source report and summary are stored in the repository.
