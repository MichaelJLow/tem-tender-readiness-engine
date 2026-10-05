import {
  FAILED_INTAKE_DOCUMENT_STATUSES,
  INTAKE_PACK_ENTRY_NAME,
  INTAKE_PACK_LIMITS,
  classifyIntakeUpload,
  isIntakeDocumentFailureStatus,
  type IntakeDocumentFailure,
  type IntakeDocumentStatus,
  type IntakePackFailure,
} from '../../../packages/domain/src/index.js';

export { INTAKE_PACK_ENTRY_NAME, INTAKE_PACK_LIMITS };

export const INTAKE_PACK_FLOW_STEPS = [
  { id: 'drop', label: 'Drop' },
  { id: 'extract', label: 'Extract' },
  { id: 'review', label: 'Review' },
  { id: 'confirm', label: 'Confirm' },
  { id: 'assess', label: 'Assess readiness' },
] as const;

export type IntakePackFlowStepId = (typeof INTAKE_PACK_FLOW_STEPS)[number]['id'];

export type IntakeFailureView = {
  code: string;
  message: string;
  retryable: boolean;
  documentId?: string;
};

export type IntakeDocumentView = {
  documentId: string;
  packId: string;
  fileName: string;
  contentType: 'application/pdf';
  byteSize: number;
  pageCount?: number;
  status: IntakeDocumentStatus;
  failure?: IntakeDocumentFailure;
  createdAt: string;
  updatedAt: string;
};

export type IntakeNoteView = {
  noteId: string;
  text: string;
  createdAt: string;
  updatedAt: string;
};

export type IntakeExtractionView = {
  extractionId: string;
  packId: string;
  createdAt: string;
  immutable: true;
  pages: Array<{
    documentId: string;
    pageNumber: number;
    text: string;
    charCount: number;
    selectableText: boolean;
  }>;
  documents: Array<{
    documentId: string;
    status: IntakeDocumentStatus;
    pageCount: number;
    extractedCharCount: number;
    failure?: IntakeDocumentFailure;
  }>;
};

export type IntakePackView = {
  packId: string;
  kind: 'INTAKE_PACK';
  entryPoint: typeof INTAKE_PACK_ENTRY_NAME;
  synthetic: true;
  status: string;
  createdAt: string;
  updatedAt: string;
  documents: IntakeDocumentView[];
  notes: IntakeNoteView[];
  extraction?: IntakeExtractionView;
  draft?: unknown;
  confirmation?: unknown;
  failure?: IntakePackFailure;
};

export type LocalIntakeFilePhase = 'queued' | 'uploading' | 'registered' | 'rejected' | 'failed';

export type LocalIntakeFile = {
  localId: string;
  fileName: string;
  byteSize: number;
  contentType: string;
  phase: LocalIntakeFilePhase;
  documentId?: string;
  failure?: IntakeFailureView;
};

export type IntakeFileRowStatus =
  IntakeDocumentStatus | 'PENDING' | 'UPLOADING' | 'UPLOAD_FAILED' | 'REJECTED';

export type IntakeFileRow = {
  key: string;
  fileName: string;
  byteSize: number;
  documentId?: string;
  pageCount?: number;
  status: IntakeFileRowStatus;
  failure?: IntakeFailureView;
  source: 'pack' | 'local';
};

export type IntakeApiErrorBody = {
  error?: string;
  message?: string;
  failure?: IntakeFailureView;
  pack?: IntakePackView;
};

const MIB = 1024 * 1024;

export function formatIntakeBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < MIB) return `${(bytes / 1024).toFixed(bytes < 10 * 1024 ? 1 : 0)} KiB`;
  return `${(bytes / MIB).toFixed(bytes % MIB === 0 ? 0 : 1)} MiB`;
}

export function intakePackLimitSummary(): string {
  return [
    `${INTAKE_PACK_LIMITS.maxDocuments} PDFs`,
    `${formatIntakeBytes(INTAKE_PACK_LIMITS.maxFileBytes)} per file`,
    `${formatIntakeBytes(INTAKE_PACK_LIMITS.maxPackBytes)} pack`,
    `${INTAKE_PACK_LIMITS.maxPagesPerDocument} pages/file`,
    `${INTAKE_PACK_LIMITS.maxPagesPerPack} pages/pack`,
    `1 broker-notes field (${INTAKE_PACK_LIMITS.maxNoteChars.toLocaleString('en-GB')} characters)`,
  ].join(' · ');
}

export function intakeUploadBodyCapBytes(): number {
  return INTAKE_PACK_LIMITS.maxFileBytes + 1;
}

export function sliceIntakeUploadBytes(bytes: Uint8Array): Uint8Array {
  const cap = intakeUploadBodyCapBytes();
  return bytes.byteLength <= cap ? bytes : bytes.slice(0, cap);
}

export function classifyLocalIntakeFile(input: {
  fileName: string;
  contentType: string;
  byteSize: number;
  bytes?: Uint8Array;
}): IntakeFailureView | undefined {
  const result = classifyIntakeUpload(input);
  if (result.accepted) return undefined;
  return result.documentFailure;
}

export function buildIntakeFileRows(
  pack: IntakePackView | undefined,
  localFiles: LocalIntakeFile[],
): IntakeFileRow[] {
  const rows: IntakeFileRow[] = [];
  const registeredIds = new Set<string>();

  for (const document of pack?.documents ?? []) {
    registeredIds.add(document.documentId);
    rows.push({
      key: document.documentId,
      fileName: document.fileName,
      byteSize: document.byteSize,
      documentId: document.documentId,
      pageCount: document.pageCount,
      status: document.status,
      failure: document.failure,
      source: 'pack',
    });
  }

  for (const local of localFiles) {
    if (local.documentId && registeredIds.has(local.documentId)) continue;
    if (local.phase === 'registered') continue;
    rows.push({
      key: local.localId,
      fileName: local.fileName,
      byteSize: local.byteSize,
      documentId: local.documentId,
      status: localRowStatus(local.phase),
      failure: local.failure,
      source: 'local',
    });
  }

  return rows;
}

function localRowStatus(phase: LocalIntakeFilePhase): IntakeFileRowStatus {
  switch (phase) {
    case 'uploading':
      return 'UPLOADING';
    case 'queued':
      return 'PENDING';
    case 'failed':
      return 'UPLOAD_FAILED';
    case 'rejected':
      return 'REJECTED';
    case 'registered':
      return 'UPLOADED';
  }
}

export function failedIntakeFileRows(rows: IntakeFileRow[]): IntakeFileRow[] {
  return rows.filter((row) => {
    if (row.failure) return true;
    if (row.status === 'UPLOAD_FAILED' || row.status === 'REJECTED') return true;
    return isIntakeDocumentStatus(row.status) && isIntakeDocumentFailureStatus(row.status);
  });
}

export function canRemoveIntakeFileRow(row: IntakeFileRow): boolean {
  return row.source === 'local';
}

export function canRetryIntakeFileRow(row: IntakeFileRow): boolean {
  return row.source === 'local' && Boolean(row.failure?.retryable);
}

export function canTriggerIntakeExtract(input: {
  pack?: IntakePackView;
  localFiles: LocalIntakeFile[];
  extracting: boolean;
}): boolean {
  if (input.extracting) return false;
  if (!input.pack) return false;
  if (input.pack.extraction) return false;
  if (input.pack.documents.length === 0) return false;
  if (input.localFiles.some((file) => file.phase === 'queued' || file.phase === 'uploading')) {
    return false;
  }
  return true;
}

export function currentIntakePackFlowStep(pack?: IntakePackView): IntakePackFlowStepId {
  if (!pack || pack.status === 'CREATED' || pack.status === 'RECEIVING') return 'drop';
  if (pack.status === 'EXTRACTING') return 'extract';
  if (pack.extraction) return 'review';
  if (pack.status === 'FAILED' || pack.status === 'REVIEWABLE') return 'extract';
  return 'drop';
}

export function intakeStatusTone(status: string): string {
  if (status === 'EXTRACTED' || status === 'REVIEWABLE' || status === 'COMPLETED') {
    return 'pill-success';
  }
  if (
    status === 'OCR_REQUIRED' ||
    status === 'VALIDATING' ||
    status === 'EXTRACTING' ||
    status === 'UPLOADING' ||
    status === 'PENDING'
  ) {
    return 'pill-warning';
  }
  if (
    (FAILED_INTAKE_DOCUMENT_STATUSES as readonly string[]).includes(status) ||
    status === 'FAILED' ||
    status === 'UPLOAD_FAILED' ||
    status === 'REJECTED' ||
    status === 'CORRUPT' ||
    status === 'UNSUPPORTED' ||
    status === 'OVERSIZED' ||
    status === 'EXTRACTION_FAILED'
  ) {
    return 'pill-danger';
  }
  return 'pill-neutral';
}

export function displayIntakeStatus(status: string): string {
  return status.replaceAll('_', ' ');
}

export function encodeIntakeFileNameHeader(fileName: string): string {
  return encodeURIComponent(fileName);
}

export function decodeIntakeFileNameHeader(value: string | null): string {
  if (!value) return '';
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function isIntakeDocumentStatus(status: string): status is IntakeDocumentStatus {
  return (
    status === 'UPLOADED' ||
    status === 'VALIDATING' ||
    status === 'EXTRACTING' ||
    status === 'EXTRACTED' ||
    (FAILED_INTAKE_DOCUMENT_STATUSES as readonly string[]).includes(status)
  );
}
