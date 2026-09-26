import { createHash } from 'node:crypto';
import { z } from 'zod';
import {
  ReadinessInputSchema,
  ReadinessResultSchema,
  RuleResultSchema,
  TenderRouteSchema,
  type ReadinessInput,
  type ReadinessResult,
} from '../../../packages/domain/src/index.js';
import { TenderInterpretationSchema } from './reasoning/contracts.js';

const identifier = z.string().trim().min(1).max(128);

export const TextSourceSchema = z
  .object({
    sourceId: identifier,
    kind: z.enum(['NOTE', 'DOCUMENT_TEXT']),
    text: z.string().trim().min(1).max(40_000),
    documentId: identifier.optional(),
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
export type TextSource = z.infer<typeof TextSourceSchema>;

const baseReadiness = ReadinessInputSchema;
export const IntakeRequestSchema = baseReadiness
  .extend({
    textSources: z.array(TextSourceSchema).max(8).default([]),
  })
  .superRefine((request, context) => {
    const sourceIds = new Set<string>();
    let totalCharacters = 0;
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
        if (site.siteId.length > 128) {
          context.addIssue({
            code: 'custom',
            path: ['tender', 'sites', index, 'siteId'],
            message: 'Site IDs sent for interpretation cannot exceed 128 characters.',
          });
        }
      });
      request.tender.documents.forEach((document, index) => {
        if (document.documentId.length > 128) {
          context.addIssue({
            code: 'custom',
            path: ['tender', 'documents', index, 'documentId'],
            message: 'Document IDs sent for interpretation cannot exceed 128 characters.',
          });
        }
      });
    }

    request.textSources.forEach((source, index) => {
      if (sourceIds.has(source.sourceId)) {
        context.addIssue({
          code: 'custom',
          path: ['textSources', index, 'sourceId'],
          message: `Duplicate text source ID: ${source.sourceId}`,
        });
      }
      sourceIds.add(source.sourceId);
      totalCharacters += source.text.length;
      if (source.documentId && !documentIds.has(source.documentId)) {
        context.addIssue({
          code: 'custom',
          path: ['textSources', index, 'documentId'],
          message: `Unknown tender document ID: ${source.documentId}`,
        });
      }
    });

    if (totalCharacters > 120_000) {
      context.addIssue({
        code: 'custom',
        path: ['textSources'],
        message: 'Combined text source content cannot exceed 120,000 characters.',
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
  ]),
  message: z.string().min(1),
  retryable: z.boolean(),
});

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

export const LocalStateSchema = z.object({
  version: z.literal(1),
  runs: z.array(TenderRunSchema),
  handoffs: z.array(PricingHandoffSchema),
});
export type LocalState = z.infer<typeof LocalStateSchema>;

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
