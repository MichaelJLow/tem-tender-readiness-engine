# ADR-005: Keep Intake pack as a three-layer path into POST /tenders

## Status

Accepted for Milestone 10 contracts. PDF upload, extraction, Console pages, and
the confirmation adapter are later ENG-16 children. This decision records the
boundary now so those tickets share one inspectable contract.

## Context

V1 intake is a JSON `IntakeRequest` posted to `POST /tenders`: structured tender
fields, optional notes, and already-extracted document text. The API validates
that payload, runs deterministic readiness rules, optionally invokes the
bounded interpretation agent, and is the only component that may call the
mocked pricing gateway after a final `READY_FOR_PRICING` route.

Milestone 10 adds a Console **Intake pack** flow:

```text
Drop PDFs + paste notes → Extract → Review → Confirm → Assess readiness → existing case detail
```

PDFs plus pasted notes are the only starting inputs. There is no tender form
first. Selectable-text synthetic PDFs are in scope. Scanned PDFs become
`OCR_REQUIRED`; OCR is out of scope. Confirm must reuse the existing loopback
demo operator label (`REVIEW_ACTOR` or `local-demo-operator`). No new
authentication is added.

The risk is that extraction or a review draft would silently populate
structured tender fields, call readiness, or reach pricing before an operator
confirms the pack.

## Decision

- Treat **Intake pack** as a separate API surface from `POST /tenders`.
  Registration, notes, extraction, and draft review never enter the tender
  service.
- Keep three layers:
  1. **Immutable extracted evidence** — original PDFs, page text, and
     provenance. Extraction cannot be edited into a different quote.
  2. **Mutable review draft** — operator-editable fields plus review-only
     candidates. Candidates may suggest values with page/note provenance, but
     they do not become readiness structured fields until the operator writes
     them onto the draft and confirms.
  3. **Confirmed submission** — an immutable snapshot that is the only Intake
     pack artefact allowed to map onto the existing `IntakeRequest` and be
     posted to `POST /tenders`.
- Confirm uses the existing loopback demo operator. The confirm request body
  does not accept an actor.
- Confirmed submissions send empty readiness signals. The existing
  interpretation agent stays evidence-only after confirm. Draft extraction
  must not fill structured fields for readiness.
- Deterministic routing (`TDR-001`–`TDR-012`) and the API-owned
  `READY_FOR_PRICING` pricing guard stay unchanged. Confirm is not ready:
  a confirmed pack may still become `NEEDS_INFORMATION`, `HUMAN_REVIEW`, or
  `DUPLICATE`.
- Extraction, draft GET/PATCH, and confirm itself must not invoke the mocked
  pricing gateway. Only the existing tender path may, and only after a final
  `READY_FOR_PRICING` route.
- Failed files remain on the pack (`OCR_REQUIRED`, `CORRUPT`, `UNSUPPORTED`,
  `OVERSIZED`, `EXTRACTION_FAILED`). They are never silently omitted. On
  confirm they map onto the existing document processing statuses so TDR-011
  can still block or escalate.
- Persist Intake packs in the local API JSON repository in later tickets. Do
  not introduce a new database, queue, or auth system for this milestone.

### Relationship to POST /tenders

```text
Intake pack APIs
  POST/GET /intake-packs
  documents, notes, extractions, draft
        ↓  operator confirm
immutable confirmation snapshot
        ↓  adapter (ENG-23)
POST /tenders  (existing IntakeRequest)
        ↓
deterministic rules + optional evidence-only interpretation
        ↓
READY_FOR_PRICING → API-owned mock pricing gateway
```

n8n continues to post structured `IntakeRequest` payloads. It does not upload
PDFs. Intake pack is a Console path into the same tender contract.

### Bounded limits

Limits live in `INTAKE_PACK_LIMITS` and match the existing text-source
contract so a valid pack can confirm without raising POST /tenders bounds:

| Bound                              | Value              | Why                                                            |
| ---------------------------------- | ------------------ | -------------------------------------------------------------- |
| PDF files per pack                 | 7                  | Leaves one slot for a note inside the existing 8 `textSources` |
| Notes per pack                     | 1                  | One pasted broker-notes field                                  |
| Per-file size                      | 8 MiB              | Selectable-text synthetic PDFs; keeps local storage bounded    |
| Total pack size                    | 24 MiB             | Three times the per-file cap                                   |
| Pages per document                 | 25                 | Demo-scale contracts                                           |
| Pages per pack                     | 50                 | Combined cap across files                                      |
| Extracted text per page            | 8,000 characters   | Page segmentation bound                                        |
| Extracted text per document / note | 40,000 characters  | Existing `TextSource` max                                      |
| Extracted text per pack            | 120,000 characters | Existing combined `textSources` max                            |

Allowed upload media is `application/pdf` with a `.pdf` filename. JSON
`POST /tenders` remains the 1 MiB body used today; PDF bytes are not that
body.

## Alternatives considered

- POST PDFs directly to `/tenders` and parse inside the existing handler:
  rejected because it would mix binary registration with readiness evaluation
  and make it easy for extracted text to become structured fields.
- Let extraction fill `ReadinessInput.tender` and skip review when confidence
  is high: rejected by the safety amendment. Silent field fill can create an
  unsafe ready route.
- Add Intake pack authentication: rejected for this local demo. Confirm
  reuses the loopback review actor already required by ADR-002.
- Run pricing from confirm when the draft looks complete: rejected. Confirm
  is not a route. Only the existing API-owned guard may call the gateway.
- OCR scanned PDFs in this milestone: rejected. Scanned files stop at
  `OCR_REQUIRED`.

## Rationale

Separating evidence, draft, and confirmation preserves the V1 invariant that
business policy stays inspectable TypeScript and that the model cannot approve
a tender. The existing `POST /tenders` contract remains the only way into
readiness and pricing. Intake pack becomes a bounded, testable front door for
synthetic PDFs and notes.

## Consequences

- ENG-18 fixtures, ENG-19 extraction, ENG-20 draft preparation, ENG-21/22
  Console UI, and ENG-23 confirmation must implement these schemas rather than
  inventing a second type system.
- Local JSON state will need an additive Intake pack collection in a later
  ticket. That is a persistence change under this ADR, not a new store.
  ENG-19 stores pack metadata in `data/intake-pack-state.json` and original
  PDF bytes write-once under `data/intake-pack-originals`. Parser choice is
  [ADR-006](006-intake-pack-pdf-extraction.md).
- Operators will see failed files and empty structured fields until they
  accept or type values. Unnecessary `NEEDS_INFORMATION` / `HUMAN_REVIEW`
  after confirm is accepted; an unsafe ready route is not.
- Hosted runtime and production authentication remain out of scope.
