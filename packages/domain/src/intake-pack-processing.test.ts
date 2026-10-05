import { describe, expect, it } from 'vitest';
import { INTAKE_PACK_LIMITS } from './intake-pack.js';
import {
  applyParsedDocumentToIntakeDocument,
  buildIntakeExtraction,
  canAddIntakeDocument,
  canPutIntakeNote,
  classifyIntakeUpload,
  deriveIntakePackStatus,
  evaluateExtractionBounds,
  hasPdfMagic,
  persistablePageCount,
  storedIntakeByteSize,
  type ParsedIntakeDocument,
} from './intake-pack-processing.js';
import { INTAKE_PACK_ENTRY_NAME, type IntakeDocument, type IntakePack } from './intake-pack.js';

const NOW = '2026-10-05T17:00:00.000Z';

function document(overrides: Partial<IntakeDocument> = {}): IntakeDocument {
  return {
    documentId: 'doc-001',
    packId: 'pack-001',
    fileName: 'synthetic-contract.pdf',
    contentType: 'application/pdf',
    byteSize: 1_000,
    status: 'UPLOADED',
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

function pack(overrides: Partial<IntakePack> = {}): IntakePack {
  return {
    packId: 'pack-001',
    kind: 'INTAKE_PACK',
    entryPoint: INTAKE_PACK_ENTRY_NAME,
    synthetic: true,
    status: 'CREATED',
    createdAt: NOW,
    updatedAt: NOW,
    documents: [],
    notes: [],
    ...overrides,
  };
}

describe('intake pack upload classification', () => {
  it('accepts a PDF filename, content type, and magic header', () => {
    const bytes = new Uint8Array(Buffer.from('%PDF-1.4\n'));
    expect(hasPdfMagic(bytes)).toBe(true);
    expect(
      classifyIntakeUpload({
        fileName: 'contract.pdf',
        contentType: 'application/pdf',
        byteSize: bytes.byteLength,
        bytes,
      }),
    ).toEqual({ accepted: true });
  });

  it('marks oversized files without treating them as corrupt', () => {
    const result = classifyIntakeUpload({
      fileName: 'huge.pdf',
      contentType: 'application/pdf',
      byteSize: INTAKE_PACK_LIMITS.maxFileBytes + 1,
    });
    expect(result.accepted).toBe(false);
    if (result.accepted) return;
    expect(result.documentFailure.code).toBe('OVERSIZED');
    expect(result.packFailure.code).toBe('OVERSIZED');
    expect(storedIntakeByteSize(INTAKE_PACK_LIMITS.maxFileBytes + 1)).toBe(
      INTAKE_PACK_LIMITS.maxFileBytes,
    );
  });

  it('marks non-PDF names, types, and missing magic as UNSUPPORTED', () => {
    expect(
      classifyIntakeUpload({
        fileName: 'cover-letter.txt',
        contentType: 'text/plain; charset=utf-8',
        byteSize: 20,
      }).accepted,
    ).toBe(false);
    expect(
      classifyIntakeUpload({
        fileName: 'not-a-pdf.pdf',
        contentType: 'application/pdf',
        byteSize: 8,
        bytes: new Uint8Array(Buffer.from('SYNTHETIC')),
      }),
    ).toMatchObject({
      accepted: false,
      documentFailure: { code: 'UNSUPPORTED' },
    });
  });
});

describe('intake pack registration limits', () => {
  it('rejects an eighth document with PACK_FILE_COUNT', () => {
    const current = pack({
      documents: Array.from({ length: INTAKE_PACK_LIMITS.maxDocuments }, (_, index) =>
        document({ documentId: `doc-${index}` }),
      ),
    });
    const result = canAddIntakeDocument(current, 100);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.failure.code).toBe('PACK_FILE_COUNT');
  });

  it('rejects a file that would exceed pack bytes with PACK_TOTAL_SIZE', () => {
    const current = pack({
      documents: [
        document({
          documentId: 'doc-large',
          byteSize: INTAKE_PACK_LIMITS.maxPackBytes - 10,
        }),
      ],
    });
    const result = canAddIntakeDocument(current, 11);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.failure.code).toBe('PACK_TOTAL_SIZE');
  });

  it('rejects a second note with NOTES_LIMIT', () => {
    const current = pack({
      notes: [
        {
          noteId: 'note-001',
          text: 'First note',
          createdAt: NOW,
          updatedAt: NOW,
        },
      ],
    });
    const result = canPutIntakeNote(current);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.failure.code).toBe('NOTES_LIMIT');
  });
});

describe('intake pack extraction bounds', () => {
  it('detects per-document and pack page limits', () => {
    const tooManyPages: ParsedIntakeDocument = {
      documentId: 'doc-pages',
      outcome: 'EXTRACTED',
      pages: Array.from({ length: INTAKE_PACK_LIMITS.maxPagesPerDocument + 1 }, (_, index) => ({
        pageNumber: index + 1,
        text: `page ${index + 1}`,
        selectableText: true,
      })),
    };
    expect(evaluateExtractionBounds([tooManyPages])?.code).toBe('PAGE_LIMIT');
    expect(persistablePageCount(tooManyPages.pages.length)).toBeUndefined();

    const packPages: ParsedIntakeDocument[] = Array.from({ length: 3 }, (_, index) => ({
      documentId: `doc-${index}`,
      outcome: 'EXTRACTED',
      pages: Array.from({ length: 17 }, (unused, page) => ({
        pageNumber: page + 1,
        text: 'x',
        selectableText: true,
      })),
    }));
    expect(evaluateExtractionBounds(packPages)?.code).toBe('PAGE_LIMIT');
  });

  it('detects per-page extracted text limits', () => {
    const parsed: ParsedIntakeDocument = {
      documentId: 'doc-dense',
      outcome: 'EXTRACTED',
      pages: [
        {
          pageNumber: 1,
          text: 'A'.repeat(INTAKE_PACK_LIMITS.maxExtractedCharsPerPage + 1),
          selectableText: true,
        },
      ],
    };
    expect(evaluateExtractionBounds([parsed])?.code).toBe('EXTRACTED_TEXT_LIMIT');
  });

  it('builds an immutable extraction without filling a draft', () => {
    const extraction = buildIntakeExtraction({
      extractionId: 'extraction-001',
      packId: 'pack-001',
      createdAt: NOW,
      parsed: [
        {
          documentId: 'doc-001',
          outcome: 'EXTRACTED',
          pages: [
            {
              pageNumber: 1,
              text: 'Customer: Northstar Foods Ltd',
              selectableText: true,
            },
          ],
        },
      ],
    });
    expect(extraction.immutable).toBe(true);
    expect(extraction.pages[0]?.pageNumber).toBe(1);
    expect(extraction.pages[0]?.charCount).toBe('Customer: Northstar Foods Ltd'.length);
  });

  it('keeps failed documents visible when applying parse outcomes', () => {
    const failed = applyParsedDocumentToIntakeDocument(
      document({ status: 'UNSUPPORTED', fileName: 'cover-letter.txt' }),
      {
        documentId: 'doc-001',
        outcome: 'CORRUPT',
        message: 'should not replace unsupported',
      },
      NOW,
    );
    expect(failed.status).toBe('UNSUPPORTED');
    expect(failed.fileName).toBe('cover-letter.txt');
  });

  it('derives FAILED when the pack records a failure', () => {
    expect(
      deriveIntakePackStatus(
        pack({
          failure: {
            code: 'PAGE_LIMIT',
            message: 'too many pages',
            retryable: false,
          },
        }),
      ),
    ).toBe('FAILED');
  });
});
