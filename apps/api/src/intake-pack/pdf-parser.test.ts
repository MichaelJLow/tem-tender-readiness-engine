import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseSelectablePdf } from './pdf-parser.js';
import { INTAKE_PACK_LIMITS } from '../../../../packages/domain/src/index.js';
import { buildIntakePackFixtureCatalog } from '../../../../scripts/intake-pack-fixtures.js';

const catalog = buildIntakePackFixtureCatalog();

function fixturePdf(packId: string, fileName: string): Uint8Array {
  const pack = catalog.specs.find((item) => item.packId === packId);
  const file = pack?.files.find((item) => item.fileName === fileName);
  if (!file) throw new Error(`Missing fixture ${packId}/${fileName}`);
  return new Uint8Array(file.bytes);
}

describe('selectable-text PDF parser', () => {
  it('segments clean fixture pages with 1-indexed numbers and provenance quotes', async () => {
    const parsed = await parseSelectablePdf({
      documentId: 'doc-clean-single-site-contract',
      bytes: fixturePdf('pack-clean-single-site', 'northstar-electricity-contract.pdf'),
    });
    expect(parsed.outcome).toBe('EXTRACTED');
    if (parsed.outcome !== 'EXTRACTED') return;
    expect(parsed.pages.map((page) => page.pageNumber)).toEqual([1, 2]);
    expect(parsed.pages[0]?.text).toContain('Customer: Northstar Foods Ltd');
    expect(parsed.pages[1]?.text).toContain('Warehouse MPAN 1234567890123');
    expect(parsed.pages.every((page) => page.selectableText)).toBe(true);
  });

  it('marks the scanned fixture as OCR_REQUIRED', async () => {
    const parsed = await parseSelectablePdf({
      documentId: 'doc-scanned-invoice',
      bytes: fixturePdf('pack-scanned-ocr-required', 'scanned-invoice.pdf'),
    });
    expect(parsed.outcome).toBe('OCR_REQUIRED');
  });

  it('marks the truncated fixture as CORRUPT', async () => {
    const parsed = await parseSelectablePdf({
      documentId: 'doc-corrupt-contract',
      bytes: fixturePdf('pack-corrupt', 'truncated-contract.pdf'),
    });
    expect(parsed.outcome).toBe('CORRUPT');
  });

  it('marks the invalid FlateDecode fixture as EXTRACTION_FAILED', async () => {
    const parsed = await parseSelectablePdf({
      documentId: 'doc-extraction-failed',
      bytes: fixturePdf('pack-extraction-failed', 'deflate-broken.pdf'),
    });
    expect(parsed.outcome).toBe('EXTRACTION_FAILED');
  });

  it('extracts the dense page past the per-page character cap', async () => {
    const parsed = await parseSelectablePdf({
      documentId: 'doc-extracted-text-limit',
      bytes: fixturePdf('pack-extracted-text-limit', 'dense-page.pdf'),
    });
    expect(parsed.outcome).toBe('EXTRACTED');
    if (parsed.outcome !== 'EXTRACTED') return;
    expect(parsed.pages[0]?.text.length).toBe(INTAKE_PACK_LIMITS.maxExtractedCharsPerPage + 1);
  });

  it('reports 26 pages for the document page-limit fixture', async () => {
    const parsed = await parseSelectablePdf({
      documentId: 'doc-document-page-limit',
      bytes: fixturePdf('pack-document-page-limit', 'too-many-pages.pdf'),
    });
    expect(parsed.outcome).toBe('EXTRACTED');
    if (parsed.outcome !== 'EXTRACTED') return;
    expect(parsed.pages).toHaveLength(INTAKE_PACK_LIMITS.maxPagesPerDocument + 1);
  });

  it('marks empty bytes and a truncated header as CORRUPT', async () => {
    const empty = await parseSelectablePdf({ documentId: 'doc-empty', bytes: new Uint8Array() });
    expect(empty.outcome).toBe('CORRUPT');

    const truncated = await parseSelectablePdf({
      documentId: 'doc-header-only',
      bytes: new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x34]),
    });
    expect(truncated.outcome).toBe('CORRUPT');
  });

  it('does not treat a committed non-PDF as selectable text', async () => {
    const bytes = new Uint8Array(
      await readFile(
        join(process.cwd(), 'fixtures/intake-packs/packs/pack-unsupported/not-a-pdf.pdf'),
      ),
    );
    const parsed = await parseSelectablePdf({ documentId: 'doc-unsupported', bytes });
    expect(parsed.outcome).toBe('CORRUPT');
  });
});
