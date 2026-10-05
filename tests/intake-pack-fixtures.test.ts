import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  FAILED_INTAKE_DOCUMENT_STATUSES,
  INTAKE_PACK_FIXTURE_DISCLAIMER,
  INTAKE_PACK_LIMITS,
  IntakePackFixtureManifestSchema,
  IntakePackTicketScenarioSchema,
} from '../packages/domain/src/index.js';
import {
  INTAKE_PACK_FIXTURES_ROOT,
  PAGE_LIMIT_SELECTABLE_CHARS,
  buildIntakePackFixtureCatalog,
  intakePackFixtureRelPath,
} from '../scripts/intake-pack-fixtures.js';
import {
  buildCorruptPdf,
  buildSyntheticPdf,
  pdfHasShowTextOperator,
  pdfSelectableText,
} from '../scripts/synthetic-pdf.js';

function sha256(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}

describe('synthetic PDF writer', () => {
  it('emits a labelled text PDF and a truncated corrupt PDF', () => {
    const pdf = buildSyntheticPdf({
      title: 'unit test',
      pages: [
        { type: 'text', lines: ['SYNTHETIC / DEMONSTRATION', 'Warehouse MPAN 1234567890123'] },
      ],
    });
    expect(pdf.subarray(0, 8).toString('latin1')).toBe('%PDF-1.4');
    expect(pdfHasShowTextOperator(pdf)).toBe(true);
    expect(pdfSelectableText(pdf)).toContain('Warehouse MPAN 1234567890123');
    expect(pdfSelectableText(pdf)).toContain('SYNTHETIC / DEMONSTRATION');

    const corrupt = buildCorruptPdf();
    expect(corrupt.toString('utf8')).toContain('SYNTHETIC / DEMONSTRATION');
    expect(corrupt.includes(Buffer.from('%%EOF'))).toBe(false);
  });

  it('emits image-only pages without show-text operators', () => {
    const pdf = buildSyntheticPdf({
      title: 'ocr unit test',
      pages: [{ type: 'image-only' }],
    });
    expect(pdfHasShowTextOperator(pdf)).toBe(false);
  });
});

describe('Intake pack fixtures', () => {
  const catalog = buildIntakePackFixtureCatalog();

  it('parses the committed manifest against the domain schema', async () => {
    const committed = IntakePackFixtureManifestSchema.parse(
      JSON.parse(await readFile(join(INTAKE_PACK_FIXTURES_ROOT, 'manifest.json'), 'utf8')),
    );
    expect(committed).toEqual(catalog.manifest);
    expect(committed.synthetic).toBe(true);
    expect(committed.disclaimer).toBe(INTAKE_PACK_FIXTURE_DISCLAIMER);
    expect(committed.limits.maxDocuments).toBe(INTAKE_PACK_LIMITS.maxDocuments);
    expect(committed.limits.maxFileBytes).toBe(INTAKE_PACK_LIMITS.maxFileBytes);
    expect(committed.limits.maxPackBytes).toBe(INTAKE_PACK_LIMITS.maxPackBytes);
  });

  it('covers every ENG-18 ticket scenario', () => {
    const present = new Set(catalog.manifest.packs.map((pack) => pack.ticketScenario));
    expect([...IntakePackTicketScenarioSchema.options].sort()).toEqual([...present].sort());
  });

  it('keeps committed files on disk with matching sizes and hashes', async () => {
    for (const pack of catalog.manifest.packs) {
      for (const file of pack.files) {
        if (file.materialization !== 'committed') continue;
        const absolute = join(
          INTAKE_PACK_FIXTURES_ROOT,
          intakePackFixtureRelPath(pack.directory, file),
        );
        const bytes = await readFile(absolute);
        expect(bytes.length, absolute).toBe(file.expectedByteSize);
        expect(sha256(bytes), absolute).toBe(file.sha256);
      }
    }
  });

  it('builds oversized limit-test bytes just over the contract bounds without committing them', () => {
    const oversized = catalog.specs.find((pack) => pack.packId === 'pack-oversized-file');
    const packTotal = catalog.specs.find((pack) => pack.packId === 'pack-total-size');
    expect(oversized).toBeDefined();
    expect(packTotal).toBeDefined();

    const oversizedPdf = oversized!.files.find(
      (file) => file.fileName === 'oversized-contract.pdf',
    )!;
    expect(oversizedPdf.materialization).toBe('generated');
    expect(oversizedPdf.bytes.length).toBe(INTAKE_PACK_LIMITS.maxFileBytes + 1);

    const padded = packTotal!.files.filter((file) => file.kind === 'PDF');
    const totalBytes = padded.reduce((sum, file) => sum + file.bytes.length, 0);
    expect(padded).toHaveLength(4);
    expect(padded.every((file) => file.bytes.length <= INTAKE_PACK_LIMITS.maxFileBytes)).toBe(true);
    expect(totalBytes).toBeGreaterThan(INTAKE_PACK_LIMITS.maxPackBytes);
    expect(totalBytes - INTAKE_PACK_LIMITS.maxPackBytes).toBeLessThan(16);
  });

  it('documents expected document failure statuses used by ENG-19', () => {
    const statuses = new Set(
      catalog.manifest.packs.flatMap((pack) =>
        pack.files.flatMap((file) => (file.expectedFailureCode ? [file.expectedFailureCode] : [])),
      ),
    );
    for (const code of FAILED_INTAKE_DOCUMENT_STATUSES) {
      expect(statuses.has(code), code).toBe(true);
    }
  });

  it('documents pack-level limit failures', () => {
    const codes = new Set(
      catalog.manifest.packs.flatMap((pack) =>
        pack.expectedPackFailureCode ? [pack.expectedPackFailureCode] : [],
      ),
    );
    expect(codes).toEqual(
      expect.arrayContaining([
        'PACK_FILE_COUNT',
        'PACK_TOTAL_SIZE',
        'PAGE_LIMIT',
        'EXTRACTED_TEXT_LIMIT',
        'NOTES_LIMIT',
        'OVERSIZED',
        'UNSUPPORTED',
      ]),
    );
    expect(
      catalog.manifest.packs
        .find((pack) => pack.packId === 'pack-file-count')
        ?.files.filter((file) => file.kind === 'PDF'),
    ).toHaveLength(INTAKE_PACK_LIMITS.maxDocuments + 1);
    expect(
      catalog.manifest.packs
        .find((pack) => pack.packId === 'pack-page-limit')
        ?.files.reduce((pages, file) => pages + (file.expectedPageCount ?? 0), 0),
    ).toBe(INTAKE_PACK_LIMITS.maxPagesPerPack + 1);
    expect(
      catalog.manifest.packs.find((pack) => pack.packId === 'pack-document-page-limit')?.files[0]
        ?.expectedPageCount,
    ).toBe(INTAKE_PACK_LIMITS.maxPagesPerDocument + 1);
    expect(PAGE_LIMIT_SELECTABLE_CHARS).toHaveLength(
      INTAKE_PACK_LIMITS.maxExtractedCharsPerPage + 1,
    );
  });

  it('keeps expected provenance quotes inside the cited multi-site sources', () => {
    const pack = catalog.specs.find((item) => item.packId === 'pack-clean-multi-site');
    expect(pack).toBeDefined();
    if (!pack) return;
    const expectedSites = pack.expectedSites ?? [];
    const expectedFacts = pack.expectedFacts ?? [];
    expect(expectedSites.map((site) => site.siteId)).toEqual(['site-warehouse', 'site-retail']);
    expect(expectedFacts.length).toBeGreaterThan(8);

    for (const expected of expectedFacts) {
      for (const provenance of expected.provenance) {
        const source = pack.files.find(
          (file) => file.documentId === provenance.sourceId || file.noteId === provenance.sourceId,
        );
        expect(source, provenance.sourceId).toBeDefined();
        if (!source) continue;
        const haystack =
          source.kind === 'NOTE' ? source.bytes.toString('utf8') : pdfSelectableText(source.bytes);
        expect(haystack).toContain(provenance.quote);
        if (provenance.sourceKind === 'DOCUMENT_PAGE') {
          expect(provenance.pageNumber).toBeGreaterThan(0);
          expect(provenance.locator).toBe(`page=${provenance.pageNumber}`);
        }
      }
    }
  });

  it('labels every committed human-readable fixture as synthetic demonstration material', async () => {
    for (const pack of catalog.specs) {
      for (const file of pack.files) {
        if (file.materialization !== 'committed') continue;
        if (file.kind === 'NOTE' || file.contentType.startsWith('text/')) {
          expect(file.bytes.toString('utf8')).toContain('SYNTHETIC / DEMONSTRATION');
        }
        if (file.kind === 'PDF' && file.expectedStatus === 'EXTRACTED') {
          expect(pdfHasShowTextOperator(file.bytes)).toBe(true);
          expect(pdfSelectableText(file.bytes)).toContain('SYNTHETIC / DEMONSTRATION');
        }
      }
    }

    const ocr = catalog.specs.find((pack) => pack.packId === 'pack-scanned-ocr-required')!;
    const scanned = ocr.files.find((file) => file.fileName === 'scanned-invoice.pdf')!;
    expect(pdfHasShowTextOperator(scanned.bytes)).toBe(false);

    const unsupported = catalog.specs.find((pack) => pack.packId === 'pack-unsupported')!;
    const fakePdf = unsupported.files.find((file) => file.fileName === 'not-a-pdf.pdf')!;
    expect(fakePdf.bytes.subarray(0, 5).toString('utf8')).not.toBe('%PDF-');
  });

  it('does not implement PDF extraction in this ticket', async () => {
    const generator = await readFile(
      new URL('../scripts/generate-intake-pack-fixtures.ts', import.meta.url),
      'utf8',
    );
    expect(generator).not.toMatch(/pdfjs|unpdf|pdf-parse|extractText/i);
  });
});
