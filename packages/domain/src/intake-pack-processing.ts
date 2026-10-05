import {
  INTAKE_PACK_LIMITS,
  IntakeDocumentFailureSchema,
  IntakePackFailureSchema,
  IntakePackSchema,
  isIntakeDocumentFailureStatus,
  isIntakeDocumentInProgress,
  type IntakeDocument,
  type IntakeDocumentFailure,
  type IntakeDocumentStatus,
  type IntakeExtractedPage,
  type IntakeExtraction,
  type IntakeExtractionDocument,
  type IntakePack,
  type IntakePackFailure,
  type IntakePackStatus,
} from './intake-pack.js';

export const PDF_MAGIC = '%PDF-';

export function hasPdfMagic(bytes: Uint8Array): boolean {
  if (bytes.byteLength < PDF_MAGIC.length) return false;
  for (let index = 0; index < PDF_MAGIC.length; index += 1) {
    if (bytes[index] !== PDF_MAGIC.charCodeAt(index)) return false;
  }
  return true;
}

export function intakeFileExtension(fileName: string): string {
  const trimmed = fileName.trim();
  const dot = trimmed.lastIndexOf('.');
  if (dot <= 0 || dot === trimmed.length - 1) return '';
  return trimmed.slice(dot).toLowerCase();
}

export function hasAllowedPdfFilename(fileName: string): boolean {
  return (INTAKE_PACK_LIMITS.allowedFilenameExtensions as readonly string[]).includes(
    intakeFileExtension(fileName),
  );
}

export function normalizeDeclaredContentType(contentType: string): string {
  return contentType.split(';', 1)[0]?.trim().toLowerCase() ?? '';
}

export function hasAllowedPdfContentType(contentType: string): boolean {
  return (INTAKE_PACK_LIMITS.allowedContentTypes as readonly string[]).includes(
    normalizeDeclaredContentType(contentType),
  );
}

export function sanitizeIntakeFileName(fileName: string): string {
  const normalized = fileName.replace(/\\/g, '/');
  const base = normalized.split('/').pop()?.trim() ?? '';
  return base.slice(0, 256);
}

export function intakeDocumentFailure(
  code: IntakeDocumentFailure['code'],
  message: string,
): IntakeDocumentFailure {
  return IntakeDocumentFailureSchema.parse({
    code,
    message,
    retryable: false,
  });
}

export function intakePackFailure(
  code: IntakePackFailure['code'],
  message: string,
  documentId?: string,
): IntakePackFailure {
  return IntakePackFailureSchema.parse({
    code,
    message,
    retryable: false,
    ...(documentId ? { documentId } : {}),
  });
}

export function classifyIntakeUpload(input: {
  fileName: string;
  contentType: string;
  byteSize: number;
  bytes?: Uint8Array;
}):
  | { accepted: true }
  | {
      accepted: false;
      documentFailure: IntakeDocumentFailure;
      packFailure: IntakePackFailure;
    } {
  if (input.byteSize > INTAKE_PACK_LIMITS.maxFileBytes) {
    const failure = intakeDocumentFailure(
      'OVERSIZED',
      `File is ${input.byteSize} bytes; the per-file limit is ${INTAKE_PACK_LIMITS.maxFileBytes} bytes.`,
    );
    return {
      accepted: false,
      documentFailure: failure,
      packFailure: intakePackFailure('OVERSIZED', failure.message),
    };
  }

  if (!hasAllowedPdfFilename(input.fileName) || !hasAllowedPdfContentType(input.contentType)) {
    const failure = intakeDocumentFailure(
      'UNSUPPORTED',
      `Only ${INTAKE_PACK_LIMITS.allowedContentTypes.join(', ')} files with a ${INTAKE_PACK_LIMITS.allowedFilenameExtensions.join(', ')} filename are accepted. Received ${input.contentType || 'unknown type'} named ${input.fileName}.`,
    );
    return {
      accepted: false,
      documentFailure: failure,
      packFailure: intakePackFailure('UNSUPPORTED', failure.message),
    };
  }

  if (input.bytes && !hasPdfMagic(input.bytes)) {
    const failure = intakeDocumentFailure(
      'UNSUPPORTED',
      `File ${input.fileName} is not a PDF (missing %PDF- header).`,
    );
    return {
      accepted: false,
      documentFailure: failure,
      packFailure: intakePackFailure('UNSUPPORTED', failure.message),
    };
  }

  return { accepted: true };
}

export function canAddIntakeDocument(
  pack: IntakePack,
  byteSize: number,
): { ok: true } | { ok: false; failure: IntakePackFailure } {
  if (pack.status === 'CONFIRMED' || pack.confirmation) {
    return {
      ok: false,
      failure: intakePackFailure(
        'ALREADY_CONFIRMED',
        'A confirmed Intake pack cannot receive more documents.',
      ),
    };
  }
  if (pack.documents.length >= INTAKE_PACK_LIMITS.maxDocuments) {
    return {
      ok: false,
      failure: intakePackFailure(
        'PACK_FILE_COUNT',
        `Intake pack already has ${pack.documents.length} files; the limit is ${INTAKE_PACK_LIMITS.maxDocuments}.`,
      ),
    };
  }
  const totalBytes = pack.documents.reduce((sum, document) => sum + document.byteSize, 0);
  if (totalBytes + byteSize > INTAKE_PACK_LIMITS.maxPackBytes) {
    return {
      ok: false,
      failure: intakePackFailure(
        'PACK_TOTAL_SIZE',
        `Adding ${byteSize} bytes would exceed the pack limit of ${INTAKE_PACK_LIMITS.maxPackBytes} bytes.`,
      ),
    };
  }
  return { ok: true };
}

export function canPutIntakeNote(
  pack: IntakePack,
): { ok: true } | { ok: false; failure: IntakePackFailure } {
  if (pack.status === 'CONFIRMED' || pack.confirmation) {
    return {
      ok: false,
      failure: intakePackFailure(
        'ALREADY_CONFIRMED',
        'A confirmed Intake pack cannot receive notes.',
      ),
    };
  }
  if (pack.notes.length >= INTAKE_PACK_LIMITS.maxNotes) {
    return {
      ok: false,
      failure: intakePackFailure(
        'NOTES_LIMIT',
        `Intake pack already has ${pack.notes.length} notes; the limit is ${INTAKE_PACK_LIMITS.maxNotes}.`,
      ),
    };
  }
  return { ok: true };
}

export function storedIntakeByteSize(byteSize: number): number {
  return Math.min(Math.max(0, byteSize), INTAKE_PACK_LIMITS.maxFileBytes);
}

export function deriveIntakePackStatus(pack: IntakePack): IntakePackStatus {
  if (pack.confirmation || pack.status === 'CONFIRMED') return 'CONFIRMED';
  if (pack.failure) return 'FAILED';

  const extractInProgress = pack.documents.some(
    (document) => document.status === 'VALIDATING' || document.status === 'EXTRACTING',
  );
  if (extractInProgress) return 'EXTRACTING';

  const extractionFinished =
    pack.extraction !== undefined ||
    (pack.documents.length > 0 &&
      pack.documents.every((document) => !isIntakeDocumentInProgress(document.status)));
  if (extractionFinished) return 'REVIEWABLE';

  if (pack.documents.length > 0 || pack.notes.length > 0) return 'RECEIVING';
  return 'CREATED';
}

export type ParsedIntakePage = {
  pageNumber: number;
  text: string;
  selectableText: boolean;
};

export type ParsedIntakeDocument =
  | {
      documentId: string;
      outcome: 'EXTRACTED';
      pages: ParsedIntakePage[];
    }
  | {
      documentId: string;
      outcome: 'OCR_REQUIRED' | 'CORRUPT' | 'EXTRACTION_FAILED' | 'UNSUPPORTED' | 'OVERSIZED';
      message: string;
      pageCount?: number;
    };

const DOCUMENT_FAILURE_MESSAGES: Record<
  Exclude<IntakeDocumentStatus, 'UPLOADED' | 'VALIDATING' | 'EXTRACTING' | 'EXTRACTED'>,
  string
> = {
  OCR_REQUIRED: 'No selectable text was found. OCR is out of scope for Intake pack.',
  CORRUPT: 'The PDF could not be parsed because its structure is invalid or truncated.',
  UNSUPPORTED: 'The file is not an accepted selectable-text PDF.',
  OVERSIZED: 'The file exceeds the Intake pack per-file size limit.',
  EXTRACTION_FAILED: 'Selectable-text extraction failed for this PDF.',
};

export function documentFailureForStatus(
  status: Exclude<ParsedIntakeDocument['outcome'], 'EXTRACTED'>,
  message?: string,
): IntakeDocumentFailure {
  return intakeDocumentFailure(status, message ?? DOCUMENT_FAILURE_MESSAGES[status]);
}

export function evaluateExtractionBounds(
  parsed: ParsedIntakeDocument[],
): IntakePackFailure | undefined {
  const extracted = parsed.filter(
    (document): document is Extract<ParsedIntakeDocument, { outcome: 'EXTRACTED' }> =>
      document.outcome === 'EXTRACTED',
  );

  if (
    extracted.some((document) => document.pages.length > INTAKE_PACK_LIMITS.maxPagesPerDocument)
  ) {
    const offending = extracted.find(
      (document) => document.pages.length > INTAKE_PACK_LIMITS.maxPagesPerDocument,
    )!;
    return intakePackFailure(
      'PAGE_LIMIT',
      `Document ${offending.documentId} has ${offending.pages.length} pages; the per-document limit is ${INTAKE_PACK_LIMITS.maxPagesPerDocument}.`,
      offending.documentId,
    );
  }

  const packPages = extracted.reduce((sum, document) => sum + document.pages.length, 0);
  if (packPages > INTAKE_PACK_LIMITS.maxPagesPerPack) {
    return intakePackFailure(
      'PAGE_LIMIT',
      `Pack extraction produced ${packPages} pages; the pack limit is ${INTAKE_PACK_LIMITS.maxPagesPerPack}.`,
    );
  }

  for (const document of extracted) {
    for (const page of document.pages) {
      if (page.text.length > INTAKE_PACK_LIMITS.maxExtractedCharsPerPage) {
        return intakePackFailure(
          'EXTRACTED_TEXT_LIMIT',
          `Page ${page.pageNumber} of document ${document.documentId} has ${page.text.length} characters; the per-page limit is ${INTAKE_PACK_LIMITS.maxExtractedCharsPerPage}.`,
          document.documentId,
        );
      }
    }
    const documentChars = document.pages.reduce((sum, page) => sum + page.text.length, 0);
    if (documentChars > INTAKE_PACK_LIMITS.maxExtractedCharsPerDocument) {
      return intakePackFailure(
        'EXTRACTED_TEXT_LIMIT',
        `Document ${document.documentId} has ${documentChars} extracted characters; the per-document limit is ${INTAKE_PACK_LIMITS.maxExtractedCharsPerDocument}.`,
        document.documentId,
      );
    }
  }

  const packChars = extracted.reduce(
    (sum, document) =>
      sum + document.pages.reduce((pageSum, page) => pageSum + page.text.length, 0),
    0,
  );
  if (packChars > INTAKE_PACK_LIMITS.maxExtractedCharsPerPack) {
    return intakePackFailure(
      'EXTRACTED_TEXT_LIMIT',
      `Pack extraction produced ${packChars} characters; the pack limit is ${INTAKE_PACK_LIMITS.maxExtractedCharsPerPack}.`,
    );
  }

  return undefined;
}

export function persistablePageCount(pageCount: number | undefined): number | undefined {
  if (pageCount === undefined) return undefined;
  if (pageCount > INTAKE_PACK_LIMITS.maxPagesPerDocument) return undefined;
  return pageCount;
}

export function buildIntakeExtraction(input: {
  extractionId: string;
  packId: string;
  createdAt: string;
  parsed: ParsedIntakeDocument[];
}): IntakeExtraction {
  const pages: IntakeExtractedPage[] = [];
  const documents: IntakeExtractionDocument[] = [];

  for (const document of input.parsed) {
    if (document.outcome === 'EXTRACTED') {
      const extractedCharCount = document.pages.reduce((sum, page) => sum + page.text.length, 0);
      for (const page of document.pages) {
        pages.push({
          documentId: document.documentId,
          pageNumber: page.pageNumber,
          text: page.text,
          charCount: page.text.length,
          selectableText: page.selectableText,
        });
      }
      documents.push({
        documentId: document.documentId,
        status: 'EXTRACTED',
        pageCount: document.pages.length,
        extractedCharCount,
      });
      continue;
    }

    documents.push({
      documentId: document.documentId,
      status: document.outcome,
      pageCount: persistablePageCount(document.pageCount) ?? 0,
      extractedCharCount: 0,
      failure: documentFailureForStatus(document.outcome, document.message),
    });
  }

  return {
    extractionId: input.extractionId,
    packId: input.packId,
    createdAt: input.createdAt,
    immutable: true,
    pages,
    documents,
  };
}

export function applyParsedDocumentToIntakeDocument(
  document: IntakeDocument,
  parsed: ParsedIntakeDocument | undefined,
  updatedAt: string,
): IntakeDocument {
  if (!parsed) return document;
  if (document.status === 'UNSUPPORTED' || document.status === 'OVERSIZED') {
    return document;
  }

  if (parsed.outcome !== 'EXTRACTED') {
    return {
      ...document,
      status: parsed.outcome,
      pageCount: persistablePageCount(parsed.pageCount),
      failure: documentFailureForStatus(parsed.outcome, parsed.message),
      updatedAt,
    };
  }

  return {
    ...document,
    status: 'EXTRACTED',
    pageCount: persistablePageCount(parsed.pages.length),
    failure: undefined,
    updatedAt,
  };
}

export function transitionIntakeDocument(
  document: IntakeDocument,
  status: IntakeDocumentStatus,
  updatedAt: string,
  failure?: IntakeDocumentFailure,
): IntakeDocument {
  return {
    ...document,
    status,
    failure,
    updatedAt,
  };
}

export function intakeDocumentsStillVisible(pack: IntakePack): boolean {
  return pack.documents.every((document) => document.documentId.length > 0);
}

export function packHasInProgressDocuments(pack: IntakePack): boolean {
  return pack.documents.some((document) => isIntakeDocumentInProgress(document.status));
}

export function packHasFailedDocuments(pack: IntakePack): boolean {
  return pack.documents.some((document) => isIntakeDocumentFailureStatus(document.status));
}

export function parsePersistedIntakePack(pack: IntakePack): IntakePack {
  return IntakePackSchema.parse(pack);
}
