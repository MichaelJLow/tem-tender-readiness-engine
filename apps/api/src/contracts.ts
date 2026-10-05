import { createHash } from 'node:crypto';
import { z } from 'zod';
import {
  ReadinessInputSchema,
  ReadinessResultSchema,
  RuleResultSchema,
  TEXT_SOURCE_COMBINED_MAX_CHARS,
  TEXT_SOURCE_IDENTIFIER_MAX_CHARS,
  TEXT_SOURCE_MAX_CHARS,
  TEXT_SOURCE_MAX_COUNT,
  TenderRouteSchema,
  TextSourceSchema,
  collectTextSourceCollectionIssues,
  type ReadinessInput,
  type ReadinessResult,
  type TextSource,
} from '../../../packages/domain/src/index.js';
import { TenderInterpretationSchema } from './reasoning/contracts.js';

export {
  TEXT_SOURCE_COMBINED_MAX_CHARS,
  TEXT_SOURCE_IDENTIFIER_MAX_CHARS,
  TEXT_SOURCE_MAX_CHARS,
  TEXT_SOURCE_MAX_COUNT,
  TextSourceSchema,
  type TextSource,
};

const baseReadiness = ReadinessInputSchema;
export const IntakeRequestSchema = baseReadiness
  .extend({
    textSources: z.array(TextSourceSchema).max(TEXT_SOURCE_MAX_COUNT).default([]),
  })
  .superRefine((request, context) => {
    const documentIds = new Set(request.tender.documents.map((document) => document.documentId));

    if (request.textSources.length > 0) {
      if (documentIds.size !== request.tender.documents.length) {
        context.addIssue({
          code: 'custom',
          path: ['tender', 'documents'],
          message: 'Document IDs must be unique when extracted text is submitted.',
        });
      }
      request.tender.sites.forEach((site, index) => {
        if (site.siteId.length > TEXT_SOURCE_IDENTIFIER_MAX_CHARS) {
          context.addIssue({
            code: 'custom',
            path: ['tender', 'sites', index, 'siteId'],
            message: 'Site IDs sent for interpretation cannot exceed 128 characters.',
          });
        }
      });
      request.tender.documents.forEach((document, index) => {
        if (document.documentId.length > TEXT_SOURCE_IDENTIFIER_MAX_CHARS) {
          context.addIssue({
            code: 'custom',
            path: ['tender', 'documents', index, 'documentId'],
            message: 'Document IDs sent for interpretation cannot exceed 128 characters.',
          });
        }
      });
    }

    for (const issue of collectTextSourceCollectionIssues(request.textSources, documentIds)) {
      context.addIssue({
        code: 'custom',
        path: ['textSources', ...issue.path],
        message: issue.message,
      });
    }
  });
export type IntakeRequest = ReadinessInput & { textSources: TextSource[] };

export const ModelTraceSchema = z.object({
  traceId: z.string().uuid(),
  model: z.string().min(1),
  promptVersion: z.string().min(1),
  startedAt: z.string().datetime(),
  completedAt: z.string().datetime(),
  durationMs: z.number().int().nonnegative(),
  outcome: z.enum(['SUCCEEDED', 'FAILED']),
  providerRunId: z.string().optional(),
});
export type ModelTrace = z.infer<typeof ModelTraceSchema>;

export const InterpretationRecordSchema = TenderInterpretationSchema;
export type InterpretationRecord = z.infer<typeof InterpretationRecordSchema>;

export const RunFailureSchema = z.object({
  code: z.enum([
    'PRICING_GATEWAY_FAILED',
    'READINESS_EVALUATION_FAILED',
    'MODEL_PROVIDER_FAILED',
    'MODEL_OUTPUT_INVALID',
    'STATE_READ_FAILED',
    'STATE_WRITE_FAILED',
    'API_TRANSPORT_FAILED',
  ]),
  message: z.string().min(1),
  retryable: z.boolean(),
  stage: z
    .enum(['API_TRANSPORT', 'STATE_READ', 'STATE_WRITE', 'INTERPRETATION', 'READINESS', 'PRICING'])
    .optional(),
  occurredAt: z.string().datetime().optional(),
  attempt: z.number().int().positive().optional(),
  causeCode: z
    .enum([
      'PRICING_GATEWAY_FAILED',
      'READINESS_EVALUATION_FAILED',
      'MODEL_PROVIDER_FAILED',
      'MODEL_OUTPUT_INVALID',
    ])
    .optional(),
});
export type RunFailure = z.infer<typeof RunFailureSchema>;

export const TenderRunSchema = z.object({
  runId: z.string().uuid(),
  correlationId: z.string().min(1).max(128),
  idempotencyKey: z.string().trim().min(1),
  requestHash: z.string().regex(/^[a-f0-9]{64}$/),
  tenderId: z.string().trim().min(1),
  input: IntakeRequestSchema,
  status: z.enum(['RECEIVED', 'PROCESSING', 'COMPLETED', 'FAILED']),
  route: TenderRouteSchema.optional(),
  result: ReadinessResultSchema.optional(),
  interpretation: InterpretationRecordSchema.optional(),
  modelTrace: ModelTraceSchema.optional(),
  failure: RunFailureSchema.optional(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});
export type TenderRun = z.infer<typeof TenderRunSchema>;

export const PricingHandoffSchema = z.object({
  handoffId: z.string().uuid(),
  handoffKey: z.string().min(1),
  tenderId: z.string().min(1),
  runId: z.string().uuid(),
  route: z.literal('READY_FOR_PRICING'),
  createdAt: z.string().datetime(),
});
export type PricingHandoff = z.infer<typeof PricingHandoffSchema>;

export const InformationRequestReceiptSchema = z.object({
  receiptId: z.string().uuid(),
  key: z.string().regex(/^information-request:[0-9a-f-]{36}$/),
  runId: z.string().uuid(),
  tenderId: z.string().min(1),
  route: z.literal('NEEDS_INFORMATION'),
  synthetic: z.literal(true),
  deliveryStatus: z.literal('NOT_SENT'),
  createdAt: z.string().datetime(),
});
export type InformationRequestReceipt = z.infer<typeof InformationRequestReceiptSchema>;

export function informationRequestReceiptKey(runId: string): string {
  return `information-request:${runId}`;
}

export const ReviewActionSchema = z.enum([
  'REQUEST_INFORMATION',
  'CONFIRM_DUPLICATE',
  'RESOLVE_MANUALLY',
  'REOPEN',
]);

export const ReviewEventSchema = z.object({
  eventId: z.string().uuid(),
  requestId: z.string().trim().min(1).max(128),
  runId: z.string().uuid(),
  action: ReviewActionSchema,
  actor: z.string().trim().min(1).max(128),
  reason: z.string().trim().min(1).max(4000),
  sourceIds: z.array(z.string().trim().min(1).max(128)).max(32),
  reviewVersion: z.number().int().positive(),
  createdAt: z.string().datetime(),
});
export type ReviewAction = z.infer<typeof ReviewActionSchema>;
export type ReviewEvent = z.infer<typeof ReviewEventSchema>;

export const LocalStateSchema = z.object({
  version: z.literal(1),
  runs: z.array(TenderRunSchema),
  handoffs: z.array(PricingHandoffSchema),
  reviewEvents: z.array(ReviewEventSchema).default([]),
  informationRequestReceipts: z.array(InformationRequestReceiptSchema).default([]),
});
export type LocalState = Omit<z.output<typeof LocalStateSchema>, 'informationRequestReceipts'> & {
  informationRequestReceipts?: InformationRequestReceipt[];
};

export const TenderResponseSchema = z.object({
  tenderId: z.string(),
  runId: z.string().uuid(),
  correlationId: z.string(),
  status: z.enum(['RECEIVED', 'PROCESSING', 'COMPLETED', 'FAILED']),
  route: TenderRouteSchema.optional(),
  rules: z.array(RuleResultSchema),
  interpretation: InterpretationRecordSchema.optional(),
  modelTrace: ModelTraceSchema.optional(),
  failure: RunFailureSchema.optional(),
  replayed: z.boolean(),
});
export type TenderResponse = z.infer<typeof TenderResponseSchema>;

export function fingerprintRequest(input: IntakeRequest): string {
  return createHash('sha256').update(JSON.stringify(input)).digest('hex');
}

export type { ReadinessResult };
