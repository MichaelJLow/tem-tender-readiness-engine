import { z } from 'zod';
import {
  BrokerSchema,
  CustomerSchema,
  DocumentProcessingStatusSchema,
  DocumentSchema,
  ReadinessInputSchema,
  SiteSchema,
  TEXT_SOURCE_COMBINED_MAX_CHARS,
  TEXT_SOURCE_IDENTIFIER_MAX_CHARS,
  TEXT_SOURCE_MAX_CHARS,
  TEXT_SOURCE_MAX_COUNT,
  TenderSchema,
  TextSourceSchema,
  collectTextSourceCollectionIssues,
} from './schemas.js';

const identifier = z.string().trim().min(1).max(TEXT_SOURCE_IDENTIFIER_MAX_CHARS);

/** Console and docs entry-point name. Not an API path segment. */
export const INTAKE_PACK_ENTRY_NAME = 'Intake pack';

/**
 * Demonstration bounds for local Intake pack. They keep PDF registration inside
 * the existing POST /tenders text-source contract (8 sources, 40k each, 120k combined).
 */
export const INTAKE_PACK_LIMITS = {
  maxDocuments: 7,
  maxNotes: 1,
  maxFileBytes: 8 * 1024 * 1024,
  maxPackBytes: 24 * 1024 * 1024,
  maxPagesPerDocument: 25,
  maxPagesPerPack: 50,
  maxExtractedCharsPerPage: 8_000,
  maxExtractedCharsPerDocument: TEXT_SOURCE_MAX_CHARS,
  maxExtractedCharsPerPack: TEXT_SOURCE_COMBINED_MAX_CHARS,
  maxNoteChars: TEXT_SOURCE_MAX_CHARS,
  maxMappedTextSources: TEXT_SOURCE_MAX_COUNT,
  allowedContentTypes: ['application/pdf'] as const,
  allowedFilenameExtensions: ['.pdf'] as const,
} as const;

export const IntakePackStatusSchema = z.enum([
  'CREATED',
  'RECEIVING',
  'EXTRACTING',
  'REVIEWABLE',
  'CONFIRMED',
  'FAILED',
]);

export const IntakeDocumentStatusSchema = z.enum([
  'UPLOADED',
  'VALIDATING',
  'EXTRACTING',
  'EXTRACTED',
  'OCR_REQUIRED',
  'CORRUPT',
  'UNSUPPORTED',
  'OVERSIZED',
  'EXTRACTION_FAILED',
]);

export const IntakeDocumentFailureCodeSchema = z.enum([
  'OCR_REQUIRED',
  'CORRUPT',
  'UNSUPPORTED',
  'OVERSIZED',
  'EXTRACTION_FAILED',
]);

export const IntakePackFailureCodeSchema = z.enum([
  'PACK_FILE_COUNT',
  'PACK_TOTAL_SIZE',
  'PAGE_LIMIT',
  'EXTRACTED_TEXT_LIMIT',
  'NOTES_LIMIT',
  'DRAFT_STALE',
  'NOT_CONFIRMABLE',
  'ALREADY_CONFIRMED',
  'IDEMPOTENCY_CONFLICT',
  'UNSUPPORTED',
  'OVERSIZED',
  'CORRUPT',
  'OCR_REQUIRED',
  'EXTRACTION_FAILED',
]);

export const IntakeFailureTaxonomySchema = z.enum([
  'OCR_REQUIRED',
  'CORRUPT',
  'UNSUPPORTED',
  'OVERSIZED',
  'EXTRACTION_FAILED',
  'PACK_FILE_COUNT',
  'PACK_TOTAL_SIZE',
  'PAGE_LIMIT',
  'EXTRACTED_TEXT_LIMIT',
  'NOTES_LIMIT',
  'DRAFT_STALE',
  'NOT_CONFIRMABLE',
  'ALREADY_CONFIRMED',
  'IDEMPOTENCY_CONFLICT',
]);

export const IntakeDocumentFailureSchema = z.object({
  code: IntakeDocumentFailureCodeSchema,
  message: z.string().trim().min(1).max(1_000),
  retryable: z.boolean(),
});

export const IntakePackFailureSchema = z.object({
  code: IntakePackFailureCodeSchema,
  message: z.string().trim().min(1).max(1_000),
  retryable: z.boolean(),
  documentId: identifier.optional(),
});

export const IntakeProvenanceSourceKindSchema = z.enum(['DOCUMENT_PAGE', 'NOTE']);

export const IntakeProvenanceSchema = z
  .object({
    sourceKind: IntakeProvenanceSourceKindSchema,
    sourceId: identifier,
    documentId: identifier.optional(),
    pageNumber: z.number().int().positive().max(INTAKE_PACK_LIMITS.maxPagesPerDocument).optional(),
    quote: z.string().trim().min(1).max(500),
    locator: z.string().trim().min(1).max(256).optional(),
  })
  .superRefine((provenance, context) => {
    if (provenance.sourceKind === 'DOCUMENT_PAGE') {
      if (!provenance.documentId) {
        context.addIssue({
          code: 'custom',
          path: ['documentId'],
          message: 'Document-page provenance must identify its document.',
        });
      }
      if (provenance.pageNumber === undefined) {
        context.addIssue({
          code: 'custom',
          path: ['pageNumber'],
          message: 'Document-page provenance must identify a 1-indexed page.',
        });
      }
    }
    if (provenance.sourceKind === 'NOTE' && provenance.documentId) {
      context.addIssue({
        code: 'custom',
        path: ['documentId'],
        message: 'Note provenance cannot claim a document ID.',
      });
    }
    if (provenance.sourceKind === 'NOTE' && provenance.pageNumber !== undefined) {
      context.addIssue({
        code: 'custom',
        path: ['pageNumber'],
        message: 'Note provenance cannot claim a PDF page.',
      });
    }
  });

export const IntakeDraftFieldSchema = z.enum([
  'customerLegalName',
  'brokerLegalName',
  'siteAddress',
  'meterIdentifier',
  'annualConsumptionKwh',
  'contractEndDate',
]);

export const IntakeAssociationStatusSchema = z.enum(['RESOLVED', 'AMBIGUOUS', 'UNRESOLVED']);

export const IntakeCandidateSchema = z.object({
  candidateId: identifier,
  field: IntakeDraftFieldSchema,
  value: z.string().trim().min(1).max(256),
  siteId: identifier.nullable().optional(),
  associationStatus: IntakeAssociationStatusSchema,
  /** Operator audit only. Confirmation snapshots draft structured fields, never this value. */
  accepted: z.boolean().default(false),
  provenance: z.array(IntakeProvenanceSchema).min(1).max(8),
});

export const IntakeNoteSchema = z.object({
  noteId: identifier,
  text: z.string().trim().min(1).max(INTAKE_PACK_LIMITS.maxNoteChars),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});

export const IntakeDocumentSchema = z.object({
  documentId: identifier,
  packId: identifier,
  fileName: z.string().trim().min(1).max(256),
  contentType: z.literal('application/pdf'),
  byteSize: z.number().int().nonnegative().max(INTAKE_PACK_LIMITS.maxFileBytes),
  pageCount: z.number().int().nonnegative().max(INTAKE_PACK_LIMITS.maxPagesPerDocument).optional(),
  status: IntakeDocumentStatusSchema,
  sha256: z
    .string()
    .regex(/^[a-f0-9]{64}$/)
    .optional(),
  failure: IntakeDocumentFailureSchema.optional(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});

export const IntakeExtractedPageSchema = z
  .object({
    documentId: identifier,
    pageNumber: z.number().int().positive().max(INTAKE_PACK_LIMITS.maxPagesPerDocument),
    text: z.string().max(INTAKE_PACK_LIMITS.maxExtractedCharsPerPage),
    charCount: z.number().int().nonnegative().max(INTAKE_PACK_LIMITS.maxExtractedCharsPerPage),
    selectableText: z.boolean(),
  })
  .superRefine((page, context) => {
    if (page.charCount !== page.text.length) {
      context.addIssue({
        code: 'custom',
        path: ['charCount'],
        message: 'Extracted page charCount must equal text length.',
      });
    }
  });

export const IntakeExtractionDocumentSchema = z.object({
  documentId: identifier,
  status: IntakeDocumentStatusSchema,
  pageCount: z.number().int().nonnegative().max(INTAKE_PACK_LIMITS.maxPagesPerDocument),
  extractedCharCount: z
    .number()
    .int()
    .nonnegative()
    .max(INTAKE_PACK_LIMITS.maxExtractedCharsPerDocument),
  failure: IntakeDocumentFailureSchema.optional(),
});

export const IntakeExtractionSchema = z
  .object({
    extractionId: identifier,
    packId: identifier,
    createdAt: z.string().datetime(),
    immutable: z.literal(true),
    pages: z.array(IntakeExtractedPageSchema).max(INTAKE_PACK_LIMITS.maxPagesPerPack),
    documents: z.array(IntakeExtractionDocumentSchema).max(INTAKE_PACK_LIMITS.maxDocuments),
  })
  .superRefine((extraction, context) => {
    const pageChars = extraction.pages.reduce((total, page) => total + page.charCount, 0);
    if (pageChars > INTAKE_PACK_LIMITS.maxExtractedCharsPerPack) {
      context.addIssue({
        code: 'custom',
        path: ['pages'],
        message: `Extracted pack text cannot exceed ${INTAKE_PACK_LIMITS.maxExtractedCharsPerPack} characters.`,
      });
    }
    if (extraction.pages.length > INTAKE_PACK_LIMITS.maxPagesPerPack) {
      context.addIssue({
        code: 'custom',
        path: ['pages'],
        message: `Extracted pack pages cannot exceed ${INTAKE_PACK_LIMITS.maxPagesPerPack}.`,
      });
    }
  });

const IntakeDraftCustomerSchema = z.object({
  customerId: identifier.optional(),
  legalName: z.string().optional(),
});

const IntakeDraftBrokerSchema = z.object({
  brokerId: identifier.optional(),
  legalName: z.string().optional(),
});

export const IntakeDraftSiteSchema = z.object({
  siteId: identifier.optional(),
  address: z.string().optional(),
  meterIdentifier: z.string().nullable().optional(),
  annualConsumptionKwh: z.number().finite().nullable().optional(),
  contractEndDate: z.string().nullable().optional(),
});

export const IntakeDraftSchema = z.object({
  packId: identifier,
  draftVersion: z.number().int().positive(),
  updatedAt: z.string().datetime(),
  customer: IntakeDraftCustomerSchema.default({}),
  broker: IntakeDraftBrokerSchema.default({}),
  sites: z.array(IntakeDraftSiteSchema).default([]),
  candidates: z.array(IntakeCandidateSchema).max(200).default([]),
});

export const IntakeConfirmedSubmissionSchema = ReadinessInputSchema.extend({
  textSources: z.array(TextSourceSchema).max(TEXT_SOURCE_MAX_COUNT).default([]),
}).superRefine((submission, context) => {
  const documentIds = new Set(submission.tender.documents.map((document) => document.documentId));
  for (const issue of collectTextSourceCollectionIssues(submission.textSources, documentIds)) {
    context.addIssue({
      code: 'custom',
      path: ['textSources', ...issue.path],
      message: issue.message,
    });
  }
});

export const IntakeConfirmationSchema = z.object({
  confirmationId: identifier,
  packId: identifier,
  draftVersion: z.number().int().positive(),
  actor: identifier,
  confirmedAt: z.string().datetime(),
  idempotencyKey: identifier,
  submission: IntakeConfirmedSubmissionSchema,
  tenderId: identifier,
  runId: z.string().uuid().optional(),
});

export const IntakePackSchema = z
  .object({
    packId: identifier,
    kind: z.literal('INTAKE_PACK'),
    entryPoint: z.literal(INTAKE_PACK_ENTRY_NAME),
    synthetic: z.literal(true),
    status: IntakePackStatusSchema,
    createdAt: z.string().datetime(),
    updatedAt: z.string().datetime(),
    documents: z.array(IntakeDocumentSchema).max(INTAKE_PACK_LIMITS.maxDocuments).default([]),
    notes: z.array(IntakeNoteSchema).max(INTAKE_PACK_LIMITS.maxNotes).default([]),
    extraction: IntakeExtractionSchema.optional(),
    draft: IntakeDraftSchema.optional(),
    confirmation: IntakeConfirmationSchema.optional(),
    failure: IntakePackFailureSchema.optional(),
  })
  .superRefine((pack, context) => {
    const totalBytes = pack.documents.reduce((total, document) => total + document.byteSize, 0);
    if (totalBytes > INTAKE_PACK_LIMITS.maxPackBytes) {
      context.addIssue({
        code: 'custom',
        path: ['documents'],
        message: `Intake pack files cannot exceed ${INTAKE_PACK_LIMITS.maxPackBytes} bytes.`,
      });
    }

    const pageCount = pack.documents.reduce(
      (total, document) => total + (document.pageCount ?? 0),
      0,
    );
    if (pageCount > INTAKE_PACK_LIMITS.maxPagesPerPack) {
      context.addIssue({
        code: 'custom',
        path: ['documents'],
        message: `Intake pack pages cannot exceed ${INTAKE_PACK_LIMITS.maxPagesPerPack}.`,
      });
    }

    const documentIds = new Set<string>();
    pack.documents.forEach((document, index) => {
      if (document.packId !== pack.packId) {
        context.addIssue({
          code: 'custom',
          path: ['documents', index, 'packId'],
          message: 'Document packId must match the parent pack.',
        });
      }
      if (documentIds.has(document.documentId)) {
        context.addIssue({
          code: 'custom',
          path: ['documents', index, 'documentId'],
          message: `Duplicate intake document ID: ${document.documentId}`,
        });
      }
      documentIds.add(document.documentId);
    });

    if (pack.draft && pack.draft.packId !== pack.packId) {
      context.addIssue({
        code: 'custom',
        path: ['draft', 'packId'],
        message: 'Draft packId must match the parent pack.',
      });
    }

    if (pack.extraction && pack.extraction.packId !== pack.packId) {
      context.addIssue({
        code: 'custom',
        path: ['extraction', 'packId'],
        message: 'Extraction packId must match the parent pack.',
      });
    }

    if (pack.confirmation && pack.confirmation.packId !== pack.packId) {
      context.addIssue({
        code: 'custom',
        path: ['confirmation', 'packId'],
        message: 'Confirmation packId must match the parent pack.',
      });
    }
  });

export const IN_PROGRESS_INTAKE_DOCUMENT_STATUSES = [
  'UPLOADED',
  'VALIDATING',
  'EXTRACTING',
] as const satisfies ReadonlyArray<z.infer<typeof IntakeDocumentStatusSchema>>;

export const FAILED_INTAKE_DOCUMENT_STATUSES = [
  'OCR_REQUIRED',
  'CORRUPT',
  'UNSUPPORTED',
  'OVERSIZED',
  'EXTRACTION_FAILED',
] as const satisfies ReadonlyArray<z.infer<typeof IntakeDocumentStatusSchema>>;

export function isIntakeDocumentInProgress(
  status: z.infer<typeof IntakeDocumentStatusSchema>,
): boolean {
  return (IN_PROGRESS_INTAKE_DOCUMENT_STATUSES as readonly string[]).includes(status);
}

export function isIntakeDocumentFailureStatus(
  status: z.infer<typeof IntakeDocumentStatusSchema>,
): boolean {
  return (FAILED_INTAKE_DOCUMENT_STATUSES as readonly string[]).includes(status);
}

export function mapIntakeDocumentStatusToReadiness(
  status: z.infer<typeof IntakeDocumentStatusSchema>,
): z.infer<typeof DocumentProcessingStatusSchema> | undefined {
  switch (status) {
    case 'EXTRACTED':
      return 'PROCESSED';
    case 'OCR_REQUIRED':
      return 'UNREADABLE';
    case 'CORRUPT':
      return 'CORRUPTED';
    case 'UNSUPPORTED':
      return 'UNSUPPORTED';
    case 'OVERSIZED':
    case 'EXTRACTION_FAILED':
      return 'FAILED_TERMINAL';
    case 'UPLOADED':
    case 'VALIDATING':
    case 'EXTRACTING':
      return undefined;
  }
}

export function canConfirmIntakePack(pack: z.infer<typeof IntakePackSchema>): {
  ok: boolean;
  code?: z.infer<typeof IntakePackFailureCodeSchema>;
  reason: string;
} {
  if (pack.confirmation || pack.status === 'CONFIRMED') {
    return {
      ok: false,
      code: 'ALREADY_CONFIRMED',
      reason: 'A confirmed Intake pack cannot be confirmed again.',
    };
  }
  if (!pack.draft) {
    return {
      ok: false,
      code: 'NOT_CONFIRMABLE',
      reason: 'Confirmation requires a review draft.',
    };
  }
  if (pack.documents.some((document) => isIntakeDocumentInProgress(document.status))) {
    return {
      ok: false,
      code: 'NOT_CONFIRMABLE',
      reason: 'Confirmation requires every document to finish extracting or fail visibly.',
    };
  }
  return { ok: true, reason: 'Pack is eligible for confirmation into POST /tenders.' };
}

export function draftStructuredFieldsAreEmpty(draft: z.infer<typeof IntakeDraftSchema>): boolean {
  const customerEmpty = !draft.customer.legalName?.trim() && !draft.customer.customerId;
  const brokerEmpty = !draft.broker.legalName?.trim() && !draft.broker.brokerId;
  const sitesEmpty = draft.sites.every(
    (site) =>
      !site.siteId &&
      !site.address?.trim() &&
      !site.meterIdentifier?.trim() &&
      site.annualConsumptionKwh == null &&
      !site.contractEndDate?.trim(),
  );
  return customerEmpty && brokerEmpty && sitesEmpty;
}

function concatDocumentText(
  extraction: z.infer<typeof IntakeExtractionSchema>,
  documentId: string,
): string {
  return extraction.pages
    .filter((page) => page.documentId === documentId)
    .sort((left, right) => left.pageNumber - right.pageNumber)
    .map((page) => page.text)
    .join('\n')
    .trim()
    .slice(0, INTAKE_PACK_LIMITS.maxExtractedCharsPerDocument);
}

/**
 * Build the immutable confirmation snapshot that later tickets may POST to /tenders.
 * Operator-edited draft fields become structured tender values. Candidate suggestions
 * are ignored here so extraction cannot silently fill readiness fields. Readiness
 * signals stay empty; existing interpretation remains evidence-only after confirm.
 */
export function snapshotDraftForConfirmation(input: {
  confirmationId: string;
  pack: z.infer<typeof IntakePackSchema>;
  actor: string;
  idempotencyKey: string;
  tenderId: string;
  customerId: string;
  brokerId: string;
  confirmedAt: string;
}): z.infer<typeof IntakeConfirmationSchema> {
  const draft = input.pack.draft;
  if (!draft) {
    throw new Error('Confirmation requires a review draft.');
  }

  const eligibility = canConfirmIntakePack(input.pack);
  if (!eligibility.ok) {
    throw new Error(eligibility.reason);
  }

  const documents = input.pack.documents.map((document) => {
    const processingStatus = mapIntakeDocumentStatusToReadiness(document.status);
    if (!processingStatus) {
      throw new Error(
        `Document ${document.documentId} is still processing and cannot be confirmed.`,
      );
    }
    return DocumentSchema.parse({
      documentId: document.documentId,
      fileName: document.fileName,
      contentType: document.contentType,
      required: true,
      processingStatus,
    });
  });

  const sites = draft.sites
    .filter((site) => site.siteId && site.address?.trim())
    .map((site) =>
      SiteSchema.parse({
        siteId: site.siteId,
        address: site.address,
        meterIdentifier: site.meterIdentifier,
        annualConsumptionKwh: site.annualConsumptionKwh,
        contractEndDate: site.contractEndDate,
      }),
    );

  const textSources: z.infer<typeof TextSourceSchema>[] = [];
  if (input.pack.extraction) {
    for (const document of input.pack.documents) {
      if (document.status !== 'EXTRACTED') continue;
      const text = concatDocumentText(input.pack.extraction, document.documentId);
      if (!text) continue;
      textSources.push(
        TextSourceSchema.parse({
          sourceId: `document-text:${document.documentId}`,
          kind: 'DOCUMENT_TEXT',
          documentId: document.documentId,
          text,
        }),
      );
    }
  }
  for (const note of input.pack.notes) {
    textSources.push(
      TextSourceSchema.parse({
        sourceId: `note:${note.noteId}`,
        kind: 'NOTE',
        text: note.text,
      }),
    );
  }

  const submission = IntakeConfirmedSubmissionSchema.parse({
    tender: TenderSchema.parse({
      tenderId: input.tenderId,
      idempotencyKey: input.idempotencyKey,
      customer: CustomerSchema.parse({
        customerId: draft.customer.customerId ?? input.customerId,
        legalName: draft.customer.legalName ?? '',
      }),
      broker: BrokerSchema.parse({
        brokerId: draft.broker.brokerId ?? input.brokerId,
        legalName: draft.broker.legalName ?? '',
      }),
      sites,
      documents,
    }),
    signals: {
      dateFacts: [],
      documentSiteAssociations: [],
      meterSiteAssociations: [],
      criticalFacts: [],
      duplicate: {
        matchesActiveTender: false,
        idempotencyKeyPreviouslyProcessed: false,
      },
    },
    textSources,
  });

  return IntakeConfirmationSchema.parse({
    confirmationId: input.confirmationId,
    packId: input.pack.packId,
    draftVersion: draft.draftVersion,
    actor: input.actor,
    confirmedAt: input.confirmedAt,
    idempotencyKey: input.idempotencyKey,
    submission,
    tenderId: input.tenderId,
  });
}

export function intakeLayerMayInvokePricing(
  layer: 'extraction' | 'draft' | 'confirmation' | 'ready-tender',
): boolean {
  return layer === 'ready-tender';
}

export type IntakePackStatus = z.infer<typeof IntakePackStatusSchema>;
export type IntakeDocumentStatus = z.infer<typeof IntakeDocumentStatusSchema>;
export type IntakeDocumentFailureCode = z.infer<typeof IntakeDocumentFailureCodeSchema>;
export type IntakePackFailureCode = z.infer<typeof IntakePackFailureCodeSchema>;
export type IntakeFailureTaxonomy = z.infer<typeof IntakeFailureTaxonomySchema>;
export type IntakeDocumentFailure = z.infer<typeof IntakeDocumentFailureSchema>;
export type IntakePackFailure = z.infer<typeof IntakePackFailureSchema>;
export type IntakeProvenance = z.infer<typeof IntakeProvenanceSchema>;
export type IntakeCandidate = z.infer<typeof IntakeCandidateSchema>;
export type IntakeDraftField = z.infer<typeof IntakeDraftFieldSchema>;
export type IntakeAssociationStatus = z.infer<typeof IntakeAssociationStatusSchema>;
export type IntakeNote = z.infer<typeof IntakeNoteSchema>;
export type IntakeDocument = z.infer<typeof IntakeDocumentSchema>;
export type IntakeExtractedPage = z.infer<typeof IntakeExtractedPageSchema>;
export type IntakeExtractionDocument = z.infer<typeof IntakeExtractionDocumentSchema>;
export type IntakeExtraction = z.infer<typeof IntakeExtractionSchema>;
export type IntakeDraft = z.infer<typeof IntakeDraftSchema>;
export type IntakeDraftSite = z.infer<typeof IntakeDraftSiteSchema>;
export type IntakeConfirmedSubmission = z.infer<typeof IntakeConfirmedSubmissionSchema>;
export type IntakeConfirmation = z.infer<typeof IntakeConfirmationSchema>;
export type IntakePack = z.infer<typeof IntakePackSchema>;
