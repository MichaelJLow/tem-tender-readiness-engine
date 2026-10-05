import { z } from 'zod';

const identifier = z.string().trim().min(1);

export const TenderRouteSchema = z.enum([
  'READY_FOR_PRICING',
  'NEEDS_INFORMATION',
  'HUMAN_REVIEW',
  'DUPLICATE',
]);

export const ProcessingStatusSchema = z.enum(['RECEIVED', 'PROCESSING', 'COMPLETED', 'FAILED']);

export const ProcessingRecordSchema = z.object({
  tenderId: identifier,
  status: ProcessingStatusSchema,
  route: TenderRouteSchema.optional(),
});

export const CustomerSchema = z.object({
  customerId: identifier,
  legalName: z.string(),
});

export const BrokerSchema = z.object({
  brokerId: identifier,
  legalName: z.string(),
});

export const SiteSchema = z.object({
  siteId: identifier,
  address: z.string().trim().min(1),
  meterIdentifier: z.string().nullable().optional(),
  annualConsumptionKwh: z.number().finite().nullable().optional(),
  contractEndDate: z.string().nullable().optional(),
});

export const DocumentProcessingStatusSchema = z.enum([
  'PENDING',
  'PROCESSED',
  'UNREADABLE',
  'UNSUPPORTED',
  'CORRUPTED',
  'FAILED_TERMINAL',
]);

export const DocumentSchema = z.object({
  documentId: identifier,
  fileName: z.string().trim().min(1),
  contentType: z.string().trim().min(1),
  required: z.boolean().default(false),
  processingStatus: DocumentProcessingStatusSchema.default('PENDING'),
});

/** Shared with POST /tenders `textSources` and Intake pack confirmation. */
export const TEXT_SOURCE_MAX_COUNT = 8;
export const TEXT_SOURCE_MAX_CHARS = 40_000;
export const TEXT_SOURCE_COMBINED_MAX_CHARS = 120_000;
export const TEXT_SOURCE_IDENTIFIER_MAX_CHARS = 128;

export const TextSourceKindSchema = z.enum(['NOTE', 'DOCUMENT_TEXT']);

export const TextSourceSchema = z
  .object({
    sourceId: z.string().trim().min(1).max(TEXT_SOURCE_IDENTIFIER_MAX_CHARS),
    kind: TextSourceKindSchema,
    text: z.string().trim().min(1).max(TEXT_SOURCE_MAX_CHARS),
    documentId: z.string().trim().min(1).max(TEXT_SOURCE_IDENTIFIER_MAX_CHARS).optional(),
  })
  .superRefine((source, context) => {
    if (source.kind === 'DOCUMENT_TEXT' && !source.documentId) {
      context.addIssue({
        code: 'custom',
        path: ['documentId'],
        message: 'Extracted document text must identify its tender document.',
      });
    }
    if (source.kind === 'NOTE' && source.documentId) {
      context.addIssue({
        code: 'custom',
        path: ['documentId'],
        message: 'A note cannot claim a document ID.',
      });
    }
  });

export function collectTextSourceCollectionIssues(
  textSources: readonly z.infer<typeof TextSourceSchema>[],
  documentIds: ReadonlySet<string>,
): Array<{ path: Array<string | number>; message: string }> {
  const issues: Array<{ path: Array<string | number>; message: string }> = [];
  const sourceIds = new Set<string>();
  let totalCharacters = 0;

  textSources.forEach((source, index) => {
    if (sourceIds.has(source.sourceId)) {
      issues.push({
        path: [index, 'sourceId'],
        message: `Duplicate text source ID: ${source.sourceId}`,
      });
    }
    sourceIds.add(source.sourceId);
    totalCharacters += source.text.length;
    if (source.documentId && !documentIds.has(source.documentId)) {
      issues.push({
        path: [index, 'documentId'],
        message: `Unknown tender document ID: ${source.documentId}`,
      });
    }
  });

  if (textSources.length > TEXT_SOURCE_MAX_COUNT) {
    issues.push({
      path: [],
      message: `Combined text sources cannot exceed ${TEXT_SOURCE_MAX_COUNT}.`,
    });
  }

  if (totalCharacters > TEXT_SOURCE_COMBINED_MAX_CHARS) {
    issues.push({
      path: [],
      message: 'Combined text source content cannot exceed 120,000 characters.',
    });
  }

  return issues;
}

export const TenderSchema = z
  .object({
    tenderId: identifier,
    idempotencyKey: identifier,
    customer: CustomerSchema,
    broker: BrokerSchema,
    sites: z.array(SiteSchema),
    documents: z.array(DocumentSchema).default([]),
  })
  .superRefine((tender, context) => {
    const seenSiteIds = new Set<string>();
    tender.sites.forEach((site, index) => {
      if (seenSiteIds.has(site.siteId)) {
        context.addIssue({
          code: 'custom',
          path: ['sites', index, 'siteId'],
          message: `Duplicate site ID: ${site.siteId}`,
        });
      }
      seenSiteIds.add(site.siteId);
    });
  });

export const EvidenceSourceTypeSchema = z.enum([
  'TENDER',
  'CUSTOMER',
  'BROKER',
  'SITE',
  'DOCUMENT',
  'FACT',
  'TEXT',
  'IDEMPOTENCY',
]);

export const EvidenceRefSchema = z.object({
  sourceId: identifier,
  sourceType: EvidenceSourceTypeSchema,
  locator: z.string().optional(),
});

export const DateFactSchema = z.object({
  factId: identifier,
  siteId: identifier,
  field: z.literal('contractEndDate'),
  value: z.string(),
  credible: z.boolean(),
  evidence: z.array(EvidenceRefSchema).min(1),
});

export const DocumentSiteAssociationSchema = z.object({
  documentId: identifier,
  status: z.enum(['RESOLVED', 'AMBIGUOUS', 'UNRESOLVED']),
  siteId: identifier.optional(),
  candidateSiteIds: z.array(identifier).default([]),
  evidence: z.array(EvidenceRefSchema).min(1),
});

export const MeterSiteAssociationSchema = z.object({
  meterIdentifier: identifier,
  siteId: identifier,
  evidence: z.array(EvidenceRefSchema).min(1),
});

export const CriticalFactSchema = z.object({
  factId: identifier,
  field: identifier,
  confidence: z.number().min(0).max(1),
  ambiguous: z.boolean(),
  evidence: z.array(EvidenceRefSchema).min(1),
});

export const DuplicateSignalsSchema = z
  .object({
    matchesActiveTender: z.boolean().default(false),
    matchedTenderId: identifier.optional(),
    idempotencyKeyPreviouslyProcessed: z.boolean().default(false),
  })
  .default({ matchesActiveTender: false, idempotencyKeyPreviouslyProcessed: false })
  .superRefine((signals, context) => {
    if (signals.matchesActiveTender && !signals.matchedTenderId) {
      context.addIssue({
        code: 'custom',
        path: ['matchedTenderId'],
        message: 'An active duplicate match must identify the matched tender.',
      });
    }
  });

export const ReadinessSignalsSchema = z
  .object({
    dateFacts: z.array(DateFactSchema).default([]),
    documentSiteAssociations: z.array(DocumentSiteAssociationSchema).default([]),
    meterSiteAssociations: z.array(MeterSiteAssociationSchema).default([]),
    criticalFacts: z.array(CriticalFactSchema).default([]),
    duplicate: DuplicateSignalsSchema,
  })
  .default({
    dateFacts: [],
    documentSiteAssociations: [],
    meterSiteAssociations: [],
    criticalFacts: [],
    duplicate: { matchesActiveTender: false, idempotencyKeyPreviouslyProcessed: false },
  });

export const ReadinessInputSchema = z.object({
  tender: TenderSchema,
  signals: ReadinessSignalsSchema.default({
    dateFacts: [],
    documentSiteAssociations: [],
    meterSiteAssociations: [],
    criticalFacts: [],
    duplicate: { matchesActiveTender: false, idempotencyKeyPreviouslyProcessed: false },
  }),
});

export const RuleIdSchema = z.enum([
  'TDR-001',
  'TDR-002',
  'TDR-003',
  'TDR-004',
  'TDR-005',
  'TDR-006',
  'TDR-007',
  'TDR-008',
  'TDR-009',
  'TDR-010',
  'TDR-011',
  'TDR-012',
]);

export const RuleResultSchema = z.object({
  ruleId: RuleIdSchema,
  passed: z.boolean(),
  route: TenderRouteSchema.optional(),
  severity: z.enum(['info', 'blocking', 'review']),
  reason: z.string().trim().min(1),
  evidence: z.array(EvidenceRefSchema),
});

export const ReadinessResultSchema = z.object({
  route: TenderRouteSchema.optional(),
  processingStatus: ProcessingStatusSchema,
  rules: z.array(RuleResultSchema).length(12),
});
