# Synthetic Intake pack fixtures

**SYNTHETIC / DEMONSTRATION.** These packs, PDFs, notes, meters, sites, and
company names are demonstration materials. They are not real tenders, customers,
brokers, or tem data.

This is the ENG-18 fixture set for Console **Intake pack**. ENG-19 uses the files
and manifest to test bounded registration and selectable-text extraction.
ENG-20 uses the same packs to prepare review-only drafts with candidates and
provenance. Later Console tickets can attach the same packs in the UI.

## Layout

```text
fixtures/intake-packs/
  README.md           this file
  manifest.json       pack inventory, expected statuses, page-to-site provenance
  packs/<packId>/     committed PDFs, broker notes, and unsupported files
  .generated/         optional oversized blobs; gitignored
```

`manifest.json` is the inventory. It is generated from
`scripts/intake-pack-fixtures.ts` and validated by
`tests/intake-pack-fixtures.test.ts` against
`IntakePackFixtureManifestSchema` in the domain package.

## Scenarios

| Pack ID                           | Ticket scenario            | What it is for                                                     |
| --------------------------------- | -------------------------- | ------------------------------------------------------------------ |
| `pack-clean-single-site`          | clean single-site          | One selectable-text PDF + one note. Expected `EXTRACTED`.          |
| `pack-clean-multi-site`           | clean multi-site           | Two PDFs, one per site, with page→site quotes/locators for ENG-19. |
| `pack-conflicting-evidence`       | conflicting evidence       | Same warehouse site, two contract-end dates.                       |
| `pack-ambiguous-site-association` | ambiguous site association | “the Harbour site” with no MPAN.                                   |
| `pack-scanned-ocr-required`       | scanned / OCR-required     | Image-only PDF. Expected `OCR_REQUIRED`.                           |
| `pack-corrupt`                    | corrupt                    | Truncated PDF. Expected `CORRUPT`.                                 |
| `pack-unsupported`                | unsupported                | `.txt`, `.png`, and a non-PDF `.pdf` name. Expected `UNSUPPORTED`. |
| `pack-extraction-failed`          | oversized / limit-test     | Invalid FlateDecode stream. Expected `EXTRACTION_FAILED`.          |
| `pack-oversized-file`             | oversized / limit-test     | PDF of `maxFileBytes + 1`. Generated, not committed.               |
| `pack-file-count`                 | oversized / limit-test     | 8 PDFs. Expected `PACK_FILE_COUNT`.                                |
| `pack-total-size`                 | oversized / limit-test     | Combined size just over `maxPackBytes`. Generated.                 |
| `pack-page-limit`                 | oversized / limit-test     | 51 pages across 3 PDFs. Expected `PAGE_LIMIT`.                     |
| `pack-document-page-limit`        | oversized / limit-test     | 26 pages in one PDF. Expected `PAGE_LIMIT`.                        |
| `pack-notes-limit`                | oversized / limit-test     | Two broker notes. Expected `NOTES_LIMIT`.                          |
| `pack-extracted-text-limit`       | oversized / limit-test     | One page with 8001 selectable characters.                          |

Each pack has at most one broker note except `pack-notes-limit`, which exists to
breach `INTAKE_PACK_LIMITS.maxNotes`.

## How later tickets should consume them

1. Read `manifest.json` and parse it with `IntakePackFixtureManifestSchema`.
2. Load committed files from `packs/<directory>/<path>`.
3. For `materialization: "generated"`, build the bytes with
   `buildIntakePackFixtureCatalog()` or write them once using the command below.
   Do not commit the 8–24 MiB blobs.
4. Assert extraction/status against `expectedStatus`, `expectedFailureCode`,
   `expectedPackFailureCode`, and — for multi-site — `expectedFacts[].provenance`.
   Draft preparation should retain conflicting `expectedFacts` as separate
   candidates and must not copy them onto structured draft fields.
5. Do not treat these files as real customer evidence. Failed files must stay
   visible; they are never silently omitted.

Selectable-text PDFs are generated as PDF 1.4 with Helvetica `Tj` operators.
Image-only and broken streams are labelled in PDF metadata. This writer is not
the ENG-19 extractor.

## Regenerate

```sh
npm run fixtures:intake-packs
npx tsx scripts/generate-intake-pack-fixtures.ts --include-generated
```

The first command rewrites committed packs and `manifest.json`. The second also
writes oversized blobs under `.generated/`. Automated tests rebuild those bytes
in memory and do not require the flag.
