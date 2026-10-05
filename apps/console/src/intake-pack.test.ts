import { describe, expect, it } from 'vitest';
import {
  INTAKE_PACK_ENTRY_NAME,
  INTAKE_PACK_LIMITS,
  FAILED_INTAKE_DOCUMENT_STATUSES,
} from '../../../packages/domain/src/index.js';
import {
  buildIntakeFileRows,
  canRemoveIntakeFileRow,
  canRetryIntakeFileRow,
  canTriggerIntakeExtract,
  classifyLocalIntakeFile,
  currentIntakePackFlowStep,
  decodeIntakeFileNameHeader,
  displayIntakeStatus,
  encodeIntakeFileNameHeader,
  failedIntakeFileRows,
  formatIntakeBytes,
  intakePackLimitSummary,
  intakeUploadBodyCapBytes,
  sliceIntakeUploadBytes,
  type IntakePackView,
  type LocalIntakeFile,
} from './intake-pack.js';

function pack(overrides: Partial<IntakePackView> = {}): IntakePackView {
  return {
    packId: 'pack-001',
    kind: 'INTAKE_PACK',
    entryPoint: INTAKE_PACK_ENTRY_NAME,
    synthetic: true,
    status: 'RECEIVING',
    createdAt: '2026-10-05T12:00:00.000Z',
    updatedAt: '2026-10-05T12:00:00.000Z',
    documents: [],
    notes: [],
    ...overrides,
  };
}

function localFile(overrides: Partial<LocalIntakeFile> = {}): LocalIntakeFile {
  return {
    localId: 'local-1',
    fileName: 'contract.pdf',
    byteSize: 1200,
    contentType: 'application/pdf',
    phase: 'queued',
    ...overrides,
  };
}

describe('Console Intake pack presentation', () => {
  it('uses the Intake pack product name and published limits', () => {
    expect(INTAKE_PACK_ENTRY_NAME).toBe('Intake pack');
    expect(intakePackLimitSummary()).toContain('7 PDFs');
    expect(intakePackLimitSummary()).toContain('8 MiB per file');
    expect(intakePackLimitSummary()).toContain('24 MiB pack');
    expect(formatIntakeBytes(INTAKE_PACK_LIMITS.maxFileBytes)).toBe('8 MiB');
  });

  it('keeps failed pack documents visible and never omits them for local-only rows', () => {
    const current = pack({
      status: 'FAILED',
      documents: FAILED_INTAKE_DOCUMENT_STATUSES.map((status) => ({
        documentId: `doc-${status.toLowerCase()}`,
        packId: 'pack-001',
        fileName: `${status.toLowerCase()}.pdf`,
        contentType: 'application/pdf',
        byteSize: 512,
        status,
        failure: {
          code: status,
          message: `${status} stays on the pack.`,
          retryable: false,
        },
        createdAt: '2026-10-05T12:00:00.000Z',
        updatedAt: '2026-10-05T12:00:00.000Z',
      })),
      failure: {
        code: 'CORRUPT',
        message: 'At least one file failed.',
        retryable: false,
      },
    });

    const rows = buildIntakeFileRows(current, [
      localFile({ localId: 'pending', fileName: 'next.pdf', phase: 'queued' }),
    ]);
    const failed = failedIntakeFileRows(rows);

    expect(rows.map((row) => row.status)).toEqual([...FAILED_INTAKE_DOCUMENT_STATUSES, 'PENDING']);
    expect(failed.map((row) => row.status)).toEqual([...FAILED_INTAKE_DOCUMENT_STATUSES]);
    expect(rows.filter((row) => row.source === 'pack')).toHaveLength(
      FAILED_INTAKE_DOCUMENT_STATUSES.length,
    );
    for (const row of rows.filter((item) => item.source === 'pack')) {
      expect(canRemoveIntakeFileRow(row)).toBe(false);
      expect(canRetryIntakeFileRow(row)).toBe(false);
    }
  });

  it('allows remove and retry only where the file is still local', () => {
    const registered = buildIntakeFileRows(
      pack({
        documents: [
          {
            documentId: 'doc-1',
            packId: 'pack-001',
            fileName: 'kept.pdf',
            contentType: 'application/pdf',
            byteSize: 2048,
            status: 'CORRUPT',
            failure: { code: 'CORRUPT', message: 'Truncated PDF.', retryable: false },
            createdAt: '2026-10-05T12:00:00.000Z',
            updatedAt: '2026-10-05T12:00:00.000Z',
          },
        ],
      }),
      [
        localFile({
          localId: 'dup',
          documentId: 'doc-1',
          phase: 'registered',
          fileName: 'kept.pdf',
        }),
        localFile({
          localId: 'network',
          fileName: 'retry.pdf',
          phase: 'failed',
          failure: { code: 'UPLOAD_FAILED', message: 'Network dropped.', retryable: true },
        }),
        localFile({
          localId: 'count',
          fileName: 'eighth.pdf',
          phase: 'rejected',
          failure: {
            code: 'PACK_FILE_COUNT',
            message: 'Pack already has 7 files.',
            retryable: false,
          },
        }),
      ],
    );

    expect(registered.map((row) => row.fileName)).toEqual(['kept.pdf', 'retry.pdf', 'eighth.pdf']);
    expect(canRemoveIntakeFileRow(registered[0]!)).toBe(false);
    expect(canRetryIntakeFileRow(registered[0]!)).toBe(false);
    expect(canRemoveIntakeFileRow(registered[1]!)).toBe(true);
    expect(canRetryIntakeFileRow(registered[1]!)).toBe(true);
    expect(canRemoveIntakeFileRow(registered[2]!)).toBe(true);
    expect(canRetryIntakeFileRow(registered[2]!)).toBe(false);
  });

  it('does not treat a pack-limit rejection as a silent omission from the file list', () => {
    const rows = buildIntakeFileRows(pack({ documents: [] }), [
      localFile({
        localId: 'rejected',
        fileName: 'too-big.pdf',
        phase: 'rejected',
        failure: {
          code: 'PACK_TOTAL_SIZE',
          message: 'Adding this file would exceed the pack byte limit.',
          retryable: false,
        },
      }),
    ]);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.status).toBe('REJECTED');
    expect(rows[0]?.failure?.code).toBe('PACK_TOTAL_SIZE');
    expect(failedIntakeFileRows(rows)).toHaveLength(1);
  });

  it('enables extract only after registered files are idle and extraction is absent', () => {
    const receiving = pack({
      documents: [
        {
          documentId: 'doc-1',
          packId: 'pack-001',
          fileName: 'site.pdf',
          contentType: 'application/pdf',
          byteSize: 100,
          status: 'UPLOADED',
          createdAt: '2026-10-05T12:00:00.000Z',
          updatedAt: '2026-10-05T12:00:00.000Z',
        },
      ],
    });
    expect(canTriggerIntakeExtract({ pack: receiving, localFiles: [], extracting: false })).toBe(
      true,
    );
    expect(
      canTriggerIntakeExtract({
        pack: receiving,
        localFiles: [localFile({ phase: 'uploading' })],
        extracting: false,
      }),
    ).toBe(false);
    expect(
      canTriggerIntakeExtract({
        pack: { ...receiving, extraction: undefined, status: 'EXTRACTING' },
        localFiles: [],
        extracting: true,
      }),
    ).toBe(false);
    expect(
      canTriggerIntakeExtract({
        pack: {
          ...receiving,
          status: 'REVIEWABLE',
          extraction: {
            extractionId: 'ex-1',
            packId: 'pack-001',
            createdAt: '2026-10-05T12:00:00.000Z',
            immutable: true,
            pages: [],
            documents: [],
          },
        },
        localFiles: [],
        extracting: false,
      }),
    ).toBe(false);
  });

  it('treats extraction as the review-ready step without exposing confirm or assess', () => {
    expect(currentIntakePackFlowStep(undefined)).toBe('drop');
    expect(currentIntakePackFlowStep(pack({ status: 'RECEIVING' }))).toBe('drop');
    expect(currentIntakePackFlowStep(pack({ status: 'EXTRACTING' }))).toBe('extract');
    expect(
      currentIntakePackFlowStep(
        pack({
          status: 'REVIEWABLE',
          extraction: {
            extractionId: 'ex-1',
            packId: 'pack-001',
            createdAt: '2026-10-05T12:00:00.000Z',
            immutable: true,
            pages: [],
            documents: [],
          },
        }),
      ),
    ).toBe('review');
    expect(currentIntakePackFlowStep(pack({ status: 'FAILED' }))).toBe('extract');
  });

  it('classifies oversized and unsupported files locally without dropping a status', () => {
    const oversized = classifyLocalIntakeFile({
      fileName: 'huge.pdf',
      contentType: 'application/pdf',
      byteSize: INTAKE_PACK_LIMITS.maxFileBytes + 1,
    });
    expect(oversized?.code).toBe('OVERSIZED');
    const unsupported = classifyLocalIntakeFile({
      fileName: 'notes.txt',
      contentType: 'text/plain',
      byteSize: 12,
    });
    expect(unsupported?.code).toBe('UNSUPPORTED');
    expect(displayIntakeStatus('OCR_REQUIRED')).toBe('OCR REQUIRED');
    const overflowing = new Uint8Array(INTAKE_PACK_LIMITS.maxFileBytes + 50);
    expect(sliceIntakeUploadBytes(overflowing).byteLength).toBe(intakeUploadBodyCapBytes());
    expect(decodeIntakeFileNameHeader(encodeIntakeFileNameHeader('Northstar contract.pdf'))).toBe(
      'Northstar contract.pdf',
    );
  });
});
