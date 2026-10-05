# ADR-006: Use PDF.js for selectable-text extraction and local JSON originals

## Status

Accepted for ENG-19.

## Context

ENG-19 implements bounded Intake pack registration and selectable-text PDF
extraction against the ENG-17 contracts and ENG-18 fixtures. The API already
persists tender runs as local JSON. Original PDF bytes must stay immutable and
outside the 1 MiB `POST /tenders` JSON body. OCR is out of scope.

`getTextContent()` in PDF.js clips glyphs that render past the page edge, so
the dense 8,001-character fixture would silently under-count if that API were
used as the extractor.

## Decision

- Parse PDFs with `pdfjs-dist` (Mozilla PDF.js) inside `apps/api`.
- Recover page text from the page operator list (`showText` / `Tj` family),
  not from clipped `getTextContent()` output. Page numbers are 1-indexed.
- Classify image-only pages with no selectable text as `OCR_REQUIRED`.
- Classify truncated or structurally invalid PDFs as `CORRUPT`.
- Classify content-stream decode failures (invalid FlateDecode) as
  `EXTRACTION_FAILED`.
- Persist pack metadata in a local JSON file
  (`INTAKE_PACK_STATE_PATH`, default `data/intake-pack-state.json`).
- Persist original bytes write-once beside it
  (`INTAKE_PACK_ORIGINALS_PATH`, default `data/intake-pack-originals`).
- Tests and local demo also use an in-memory originals store. This is not a
  new database and not production S3.

Extraction still must not fill draft tender fields or invoke pricing.

## Alternatives considered

- `pdf-parse` / `unpdf`: thinner wrappers, still PDF.js underneath, and
  `getTextContent()` would miss the extracted-text limit fixture.
- Homegrown PDF 1.4 tokenizer only: enough for these synthetic fixtures, too
  narrow for a production-style extractor.
- Store originals inside `tender-state.json`: mixes binary evidence into the
  tender run file and races with tender read-modify-write.
- S3 for live originals: rejected for this local demo; S3 remains the
  Milestone 6 archive, not the live store.

## Consequences

- `pdfjs-dist` is an API workspace dependency.
- Pack metadata and originals are separate from tender JSON state.
- An extraction that would exceed `INTAKE_PACK_LIMITS` page or character caps
  is not persisted as a complete extraction; the pack records `PAGE_LIMIT` or
  `EXTRACTED_TEXT_LIMIT` and the documents remain visible.
