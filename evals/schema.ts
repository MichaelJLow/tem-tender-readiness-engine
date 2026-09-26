import { z } from 'zod';
import {
  IntakeRequestSchema,
  ModelTraceSchema,
  type IntakeRequest,
} from '../apps/api/src/contracts.js';
import {
  ProcessingStatusSchema,
  RuleIdSchema,
  TenderRouteSchema,
} from '../packages/domain/src/index.js';

export const EvalCategorySchema = z.enum([
  'clean',
  'multi_site',
  'missing_information',
  'duplicate',
  'conflict',
  'ambiguous_association',
  'unsupported_evidence',
  'prompt_injection',
  'provider_failure',
  'regression',
  'pending_document',
]);

export const EvalFactSchema = z.object({
  field: z.enum([
    'contractEndDate',
    'meterIdentifier',
    'annualConsumptionKwh',
    'customerLegalName',
  ]),
  value: z.string().trim().min(1),
  siteId: z.string().trim().min(1).nullable(),
  sourceId: z.string().trim().min(1),
});

export const EvalCaseExpectedSchema = z.object({
  status: ProcessingStatusSchema,
  route: TenderRouteSchema.nullable(),
  flaggedRules: z.array(RuleIdSchema),
  facts: z.array(EvalFactSchema),
  pricingHandoffs: z.number().int().nonnegative(),
  ambiguous: z.boolean().default(false),
});

export const EvalCaseSchema = z.object({
  id: z.string().trim().min(1).max(128),
  category: EvalCategorySchema,
  safetySet: z.boolean().default(false),
  setup: z.object({ activeTenderId: z.string().trim().min(1).optional() }).default({}),
  input: IntakeRequestSchema,
  expected: EvalCaseExpectedSchema,
});

export const EvalDatasetSchema = z
  .object({
    schemaVersion: z.literal(1),
    datasetId: z.string().trim().min(1),
    cases: z.array(EvalCaseSchema).min(1),
  })
  .superRefine((dataset, context) => {
    const seen = new Set<string>();
    dataset.cases.forEach((testCase, index) => {
      if (seen.has(testCase.id)) {
        context.addIssue({
          code: 'custom',
          path: ['cases', index, 'id'],
          message: `Duplicate eval case ID: ${testCase.id}`,
        });
      }
      seen.add(testCase.id);
      const sourceIds = new Set(testCase.input.textSources.map((source) => source.sourceId));
      testCase.expected.facts.forEach((fact, factIndex) => {
        if (!sourceIds.has(fact.sourceId)) {
          context.addIssue({
            code: 'custom',
            path: ['cases', index, 'expected', 'facts', factIndex, 'sourceId'],
            message: `Expected fact refers to unknown source ${fact.sourceId}.`,
          });
        }
        if (
          fact.siteId &&
          !testCase.input.tender.sites.some((site) => site.siteId === fact.siteId)
        ) {
          context.addIssue({
            code: 'custom',
            path: ['cases', index, 'expected', 'facts', factIndex, 'siteId'],
            message: `Expected fact refers to unknown site ${fact.siteId}.`,
          });
        }
      });
      if (testCase.expected.status === 'PROCESSING' && testCase.expected.route !== null) {
        context.addIssue({
          code: 'custom',
          path: ['cases', index, 'expected', 'route'],
          message: 'A pending case must not have a final business route.',
        });
      }
      if (testCase.expected.status === 'FAILED' && testCase.expected.route !== null) {
        context.addIssue({
          code: 'custom',
          path: ['cases', index, 'expected', 'route'],
          message: 'A technical failure must not be labelled with a successful business route.',
        });
      }
      if (
        testCase.expected.route !== 'READY_FOR_PRICING' &&
        testCase.expected.pricingHandoffs > 0
      ) {
        context.addIssue({
          code: 'custom',
          path: ['cases', index, 'expected', 'pricingHandoffs'],
          message: 'Only READY_FOR_PRICING cases may expect a pricing handoff.',
        });
      }
    });
  });

export type EvalCase = z.infer<typeof EvalCaseSchema>;
export type EvalDataset = z.infer<typeof EvalDatasetSchema>;
export type EvalFact = z.infer<typeof EvalFactSchema>;
export type EvalInput = IntakeRequest;
export type EvalTrace = z.infer<typeof ModelTraceSchema>;
