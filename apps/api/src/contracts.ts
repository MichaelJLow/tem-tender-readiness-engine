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

export const IntakeRequestSchema = ReadinessInputSchema;
export type IntakeRequest = ReadinessInput;

export const RunFailureSchema = z.object({
  code: z.enum(['PRICING_GATEWAY_FAILED', 'READINESS_EVALUATION_FAILED']),
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
  failure: RunFailureSchema.optional(),
  replayed: z.boolean(),
});
export type TenderResponse = z.infer<typeof TenderResponseSchema>;

export function fingerprintRequest(input: IntakeRequest): string {
  return createHash('sha256').update(JSON.stringify(input)).digest('hex');
}

export type { ReadinessResult };

