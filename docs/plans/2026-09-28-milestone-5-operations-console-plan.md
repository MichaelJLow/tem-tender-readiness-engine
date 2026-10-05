# Milestone 5 — Operations console plan

> Historical planning record. Current Console behaviour is in the runbook, ADR-002, and `docs/screenshots/operations-console/README.md`.

## Outcome

Build a local, portfolio-ready internal console where an operator can find a synthetic tender, understand its route from rules and cited evidence, record and close a human review with an audit trail, and inspect the retained Milestone 4 eval verdict. The console should be useful when Mastra Studio is stopped or its recent traces have expired. It must not create an unguarded route to pricing.

## Context and evidence

- `docs/implementation-plan.md` defines Queue, Tender detail, Human review, and Performance as the four views and sets the acceptance test: resolve a blocked case without backend logs; explain an eval verdict from retained evidence.
- `apps/api/src/server.ts` currently exposes only `POST /tenders`. `TenderService` owns processing and the pricing call. The API has no case list, case detail, or review endpoint.
- `TenderRun` in `apps/api/src/contracts.ts` already retains the original intake, rule result, interpretation, model trace summary, route, status, and failure. `TenderRepository` exposes lookup and save methods, but no list or review-event methods. `LocalStateSchema` is version 1 with runs and mock pricing handoffs. `FileStateStore` is safe for one local API process only.
- `evals/accepted-baseline.json` identifies the reviewed synthetic prototype baseline. The newer passing 63-case report `evals/reports/full-2026-09-28T19-39-31.237Z.json` is a retained run compared with that baseline; its presence does **not** silently make it the accepted baseline. The report includes a versioned schema, verdict, gates, metrics, sample sizes, model/prompt/dataset metadata, and Studio experiment IDs.
- `docs/plans/2026-09-26-milestone-4-eval-system-plan.md` requires the console to read portable reports through a backend projection, keep case evidence independent of Studio, and keep human corrections out of the canonical dataset until reviewed. `docs/adr/001-bounded-mastra-agent.md` explains that API runs do not automatically appear in Studio.
- User direction: use a Layer client-app type visual treatment for the console. This is a visual reference, not a request to use LayerOS policy or claim this project is a Layer product. Planning continues in the user-selected SOL session.

## Decisions and assumptions

1. **One local API remains the owner of operational state and decisions.** The proposed Next.js app in `apps/console/` consumes typed, Zod-validated API projections. It does not read the JSON state file or Studio database, run model calls, or calculate business routes in React. Keep the API and console on loopback during Milestone 5; cloud deployment and authentication are Milestone 6 design gates.
2. **Review state is separate from the automatic business route and technical status.** Preserve the original run and result. A review action appends an immutable event and updates a derived review-work-item state in one serialized local write. The actor, timestamp, reason, action, case/run IDs, and cited evidence IDs are recorded. A UI label such as “resolved” must never imply the tender was priced.
3. **Conservative local review actions.** For an open `HUMAN_REVIEW` case, allow a reviewer to record `REQUEST_INFORMATION`, `CONFIRM_DUPLICATE`, or `RESOLVE_MANUALLY` with a mandatory reason and optional source references. `RESOLVE_MANUALLY` means the operator has documented a determination and closed the review task; it does not change the automatic route or send pricing. Reopening records another event. An actual corrected tender or automated handoff requires a new, explicitly designed intake/re-evaluation path; it must not be simulated by changing the old route in place. This keeps Milestone 5 operable without inventing a human bypass of the pricing guard.
4. **Reports are immutable evidence.** The Performance view distinguishes the explicitly accepted baseline pointer from the latest completed passing report and from failed/incomplete reports. The backend validates the report schema and restricts reads to the repository's report directory; it never treats a passing report as accepted merely because it is newest. It shows comparability only when dataset hashes match. Missing, invalid, or non-comparable reports fail visibly.
5. **Studio is optional drill-down.** Build experiment URLs from configured `MASTRA_STUDIO_URL` (local project default `http://localhost:4113`) and allow the link to be unavailable. Do not assert an API trace is in Studio. The report and operational case detail retain enough evidence to stand alone.
6. **Synthetic local demo only.** A local operator identity is supplied by server-side demo configuration and recorded in audit events, not trusted from a client-submitted actor field. It is clearly labelled as demo identity, not production authentication. Prevent external binding for review endpoints until an authentication design is implemented.

These are proposed implementation choices grounded in the current boundary. If human review must authorize a pricing handoff in this milestone, decide and document that policy before implementing review mutations; it changes the safety design and requires an ADR.

## Scope

### In scope

- Typed case queue and case-detail API projections, including status, route, blocking rules, evidence citations, failures, timestamps, and correlation IDs.
- Four responsive internal views: Queue, Tender detail, Human review, Performance. Use a restrained Layer client-app style: clear information hierarchy, compact tables, readable evidence panels, visible status badges, and an accessible action area. Use project-specific branding and copy; a screenshot or tokens can refine visuals later without changing architecture.
- Review-event append and derived open/closed state; optimistic concurrency or event precondition to reject stale duplicate decisions; read-only audit timeline.
- Read-only eval-report projection with explicit accepted/latest labels, gates, denominators, versions, report links, and optional Studio experiment links.
- Synthetic local fixtures/demo walkthrough and documentation for the operator workflow.

### Out of scope

- Real customer or tem data; PDF upload/parsing; real information-request delivery; actual pricing; n8n workflows; AWS or hosted storage; multi-operator authentication; role administration; automated correction of tender fields; automatic promotion of human feedback into `evals/cases.ts`; rerunning the live model suite solely to build the UI.
- General-purpose case management, dashboard analytics beyond retained eval reports, or a new Mastra agent.

## High-level technical design

```text
Next.js console (views and server-side API client)
      | typed local HTTP
      v
Existing Tender API (read projections + review command)
      |                           |
      v                           v
TenderRepository / local state    read-only eval report projection
(runs, handoffs, review events)    (accepted pointer + versioned reports)
      |
      v
TenderService remains sole owner of automatic route and mock pricing handoff
```

Queue rows should be derived from stored runs, not a duplicate UI store. Show review work separately from processing failures, pending documents, and completed non-review routes. For a `HUMAN_REVIEW` run with no resolution event, show an open review item; after a valid decision, show resolved with action and time. Case detail should retain original input and evidence with source/site references and show the automatic decision next to the human disposition. Truncate or collapse large source text in the interface while preserving access to the complete synthetic evidence. Escape all source text and never render it as HTML.

The API should return the minimum data each view needs; list endpoints should page and filter by route/status/review state, while detail exposes the full saved record through an explicit response schema. Client queries do not take filesystem paths. Review mutations must validate body and referenced run, require an open `HUMAN_REVIEW` work item, use a stable action/request ID and expected review version, and atomically append the event with the new review state. Duplicated requests return the same event; stale or conflicting requests fail visibly. Persist the state evolution with backward compatibility for version-1 files, or migrate them explicitly with a backed-up local fixture. Keep all operations behind repository methods so Milestone 6 can replace storage.

Performance reads only validated report JSON and an explicit acceptance pointer. Do not expose arbitrary files or secrets. Show the accepted baseline and most recent completed run as separate records, their comparability and verdict, route metrics with numerator/denominator, unsafe-ready count, review recall, fact precision/recall, gates, dataset hash, prompt and model, run time, and links to retained Markdown and Studio experiments. If a report is absent or Studio is down, the page remains useful and says what is unavailable.

## Implementation units

### U-001 — Fix the review-state contract and architecture decision

- **Depends on:** none.
- **Files:** `apps/api/src/contracts.ts`, `apps/api/src/repository.ts`, proposed `docs/adr/002-local-review-state-and-console-boundary.md`.
- **Outcome:** define event schema, review dispositions, current review state, actor/source references, idempotency and expected-version semantics. Record why review events are separate from automatic routes and why the UI cannot call pricing.
- **Check:** invalid transitions, missing reasons, duplicate action IDs with different content, and non-review runs are rejected at the domain/API boundary; version-1 state compatibility is specified.

### U-002 — Persist and query review history safely

- **Depends on:** U-001.
- **Files:** `apps/api/src/file-repository.ts`, `apps/api/src/repository.ts`, `apps/api/src/file-repository.test.ts`, state fixtures or migration test targets.
- **Outcome:** list/paginate runs; fetch a run by ID; append an immutable review event and advance derived state in one local serialized write. Existing runs and handoffs survive state evolution. Keep the single-process constraint explicit.
- **Check:** reload from disk preserves history; stale concurrent action fails without a partial event; duplicate retry does not append twice; legacy version-1 fixture loads or migrates as designed.

### U-003 — Expose typed operational API

- **Depends on:** U-002.
- **Files:** `apps/api/src/server.ts`, `apps/api/src/service.ts` or a focused review service, `apps/api/src/contracts.ts`, `apps/api/src/server.test.ts`.
- **Outcome:** read-only queue/detail/audit endpoints and a validated review-command endpoint with consistent correlation IDs and explicit 4xx/5xx errors. A review command cannot invoke `PricingGateway` or mutate an old run's automatic route.
- **Check:** open-review action succeeds; wrong route, malformed input, stale version, repeat command, missing run, and state-write failure produce the defined response and no unsafe side effect.

### U-004 — Project retained eval reports through the API

- **Depends on:** none; can proceed alongside U-001–U-003.
- **Files:** `evals/metrics.ts` (reuse schema), proposed `apps/api/src/eval-reports.ts`, `apps/api/src/server.ts`, report-projection tests.
- **Outcome:** return a small validated performance summary plus controlled report/experiment references. Accepted pointer is authoritative for “accepted”; latest passing report is labelled separately. No direct browser read of `evals/reports/` or Studio's local database.
- **Check:** accepted and latest records remain distinct; a mismatched dataset is marked non-comparable; malformed/missing report and path traversal fail visibly; Studio absence does not affect summary.

### U-005 — Build the console shell, queue, and case detail

- **Depends on:** U-003; U-004 for shared navigation to Performance.
- **Files:** proposed `apps/console/` Next.js workspace, root `package.json` and lockfile, console components/routes, shared API client and view-model tests.
- **Outcome:** responsive, accessible Layer client-app type shell with Queue and Tender detail. Filters and links survive reload; views distinguish business route, processing status, and review state. Detail explains each failed rule and cited interpretation evidence in context.
- **Check:** keyboard navigation, empty/loading/error states, narrow viewport, long text, missing evidence, and failed API requests remain understandable. No domain policy lives in a React component.

### U-006 — Add human-review workflow and audit timeline

- **Depends on:** U-003, U-005.
- **Files:** proposed `apps/console/` review route/components and tests; API review endpoint tests.
- **Outcome:** an operator can choose a disposition, cite evidence, enter a reason, see the saved event, and understand that manual resolution does not price the tender. The page prevents accidental double submission and handles server-side stale-state conflicts by refreshing the case.
- **Check:** open review → decision → audit timeline → reload retains state; another tab with an old version is rejected; non-review case has no enabled review command; no pricing handoff is added.

### U-007 — Add Performance and Studio drill-down

- **Depends on:** U-004, U-005.
- **Files:** proposed `apps/console/` performance route/components and tests; `docs/runbook.md`.
- **Outcome:** show accepted baseline, latest completed run, verdict and gates with denominators, model/prompt/dataset versions, retained report link, and optional Studio experiment links. State clearly when the latest report is only a candidate, failed, or non-comparable.
- **Check:** page remains readable with Studio offline or trace expired; missing report displays a diagnostic state, never a fabricated zero or pass; values agree with the source report.

### U-008 — Verify and document the complete local operator demo

- **Depends on:** U-001–U-007.
- **Files:** `docs/runbook.md`, `docs/implementation-plan.md`, `README.md`, synthetic demo fixtures or script under a proposed `tests/`/`scripts/` location, and relevant tests.
- **Outcome:** repeatable local path from submitting synthetic clean, missing, review, and failed cases through queue/detail/review/performance. Document process ports, local-only trust boundary, report/Studio relationship, known limits, and how to reset synthetic demo state safely. Check off Milestone 5 tasks only after acceptance evidence exists.
- **Check:** a fresh local setup can complete the demonstration without backend log inspection, and no non-ready route reaches pricing.

## File impact

Existing: `apps/api/src/{contracts,repository,file-repository,service,server}.ts`, relevant API tests, `evals/metrics.ts`, `evals/accepted-baseline.json` (read only unless a baseline is separately reviewed), `docs/{architecture,runbook,implementation-plan}.md`, `README.md`, root package scripts/lockfile. Proposed: `apps/console/`, `apps/api/src/eval-reports.ts`, `docs/adr/002-local-review-state-and-console-boundary.md`, and synthetic demo assets. No `apps/console/` directory exists yet.

## Verification scenarios

| Setup/input                                                    | Action                                                | Expected observable result                                                                                                          |
| -------------------------------------------------------------- | ----------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| Synthetic conflict with cited note/document text               | Open queue, then case                                 | `HUMAN_REVIEW` is visibly separate from `COMPLETED`; blocking rules and site/source quotes explain why; pricing count remains zero. |
| Open review, valid local operator                              | Record `REQUEST_INFORMATION` with reason and citation | One immutable event appears with actor/time; review task closes; automatic route remains `HUMAN_REVIEW`; no pricing call.           |
| Same action/request ID sent twice                              | Retry command                                         | Same recorded event is returned or recognized; timeline has one event.                                                              |
| Two tabs hold the same open review version                     | Submit first, then second                             | First succeeds; second receives stale-state response and refresh guidance; no conflicting second decision.                          |
| Completed `NEEDS_INFORMATION` or `READY_FOR_PRICING` run       | Try review command directly against API               | Rejected; no review event and no pricing side effect.                                                                               |
| Version-1 local state with prior handoff                       | Start upgraded API and view case                      | Run and handoff are preserved; review fields are compatible or explicit migration succeeds; no replayed handoff.                    |
| Accepted pointer to older report, newer passing report present | Open Performance                                      | Accepted and latest are distinct, both show dataset/versions and correct denominators; no silent promotion.                         |
| Studio stopped or trace expired                                | Open Performance and case detail                      | Retained verdict, metrics, evidence, and audit remain available; Studio link is optional/unavailable.                               |
| Missing, malformed, or mismatched report                       | Open Performance                                      | Explicit unavailable/non-comparable state; no fabricated pass or unsafe filesystem access.                                          |
| State write failure during review                              | Submit action                                         | Visible failure with correlation ID; no partial event or false “resolved” UI state.                                                 |

At completion run formatting, lint, typecheck, unit/integration tests, API and console builds, and relevant deterministic eval smoke checks. Re-run paid live evals only if reasoning, routing, or model-dependent behavior changes or a new baseline is proposed. Manually inspect the four views and the local demo using synthetic data.

## Risks and mitigations

- **False human approval or pricing bypass:** keep review disposition separate from the route; prove review mutations cannot call pricing; require a separate reviewed design for corrected intake or manual-to-pricing flow.
- **Lost or conflicting review events in a file store:** one API process, serialized repository mutation, stable command IDs, stale-version rejection, atomic state write, and explicit failure. Multi-process/cloud concurrency belongs to Milestone 6.
- **Misleading eval status:** accepted pointer and latest run are separate; validate reports and comparison hash; show denominators and incompleteness.
- **Transient Studio links:** use retained report and case records as primary evidence; label Studio drill-down as optional.
- **Demo-only operator identity:** local loopback binding and server-owned identity; no public deployment of review mutations before auth is designed.
- **Visual polish obscuring operational facts:** use color plus text for routes/status, preserve source citations and audit chronology, and test keyboard/narrow-screen use.

## Permission and operational impact

Implementation adds local state fields and review mutations to the existing API, a local Next.js process, and read-only access to checked-in synthetic report files. It does not require model credentials for normal console use, cloud resources, a paid Mastra plan, external connectors, production data, or a change to GitHub. The local development setup must avoid a port collision with Mastra Studio at 4113; console port should be configurable and documented. Before any hosted exposure, design authentication/authorization, persistent concurrent storage, and least-privilege access as part of Milestone 6.

## Rollout and rollback

Implement in the order above on a dedicated branch from merged main, with a reviewable PR. Demonstrate against a copied synthetic state fixture. Back up the local state before any schema migration. If the UI is rolled back, the API should still read prior state; if a new event schema cannot be read by the old API, rollback must restore the backed-up synthetic fixture or retain a compatible reader. Do not edit or delete accepted eval reports during rollback. Production data migration is outside this milestone.

## Open questions and approval gates

- The proposed Milestone 5 action set records and closes review tasks without automatically turning them into `READY_FOR_PRICING`. If the intended operator workflow includes approving a corrected tender for the mock pricing handoff now, settle that business policy first, specify what structured facts change, and add an ADR plus safety tests before U-006.
- Exact Layer visual tokens or a reference screenshot can refine the interface during U-005. The established direction is enough to plan and start the console structure.
- No new live eval baseline is needed for a read-only Performance page. Promotion of a newer report to “accepted” remains an explicit reviewed eval decision, outside the console.
