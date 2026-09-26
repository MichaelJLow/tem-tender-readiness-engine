import { z } from 'zod';

export const INTERPRETATION_PROMPT_VERSION = 'tender-interpretation-v3';
export const MIN_CONFIDENCE_FOR_CREDIBLE_EVIDENCE = 0.95;

export const CitationSchema = z.object({
  sourceId: z.string().trim().min(1).max(128),
  quote: z.string().trim().min(1).max(500),
});

export const TenderInterpretationSchema = z.object({
  summary: z.string().trim().min(1).max(2_000),
  sourceAssessments: z
    .array(
      z.object({
        sourceId: z.string().trim().min(1).max(128),
        relevance: z.enum(['RELEVANT', 'NO_RELEVANT_FACTS']),
        confidence: z.number().min(0).max(1),
        ambiguous: z.boolean(),
        explanation: z.string().trim().min(1).max(1_000),
        evidence: z.array(CitationSchema).min(1).max(5),
      }),
    )
    .max(8),
  observations: z
    .array(
      z.object({
        field: z.enum([
          'contractEndDate',
          'meterIdentifier',
          'annualConsumptionKwh',
          'customerLegalName',
        ]),
        value: z.string().trim().min(1).max(256),
        siteIds: z.array(z.string().trim().min(1).max(128)).max(10),
        confidence: z.number().min(0).max(1),
        ambiguous: z.boolean(),
        evidence: z.array(CitationSchema).min(1).max(5),
      }),
    )
    .max(100),
  siteAssociations: z
    .array(
      z.object({
        sourceId: z.string().trim().min(1).max(128),
        siteIds: z.array(z.string().trim().min(1).max(128)).max(10),
        confidence: z.number().min(0).max(1),
        ambiguous: z.boolean(),
        evidence: z.array(CitationSchema).min(1).max(5),
      }),
    )
    .max(50),
  conflicts: z
    .array(
      z.object({
        explanation: z.string().trim().min(1).max(1_000),
        evidence: z.array(CitationSchema).min(1).max(5),
      }),
    )
    .max(20),
});

export type TenderInterpretation = z.infer<typeof TenderInterpretationSchema>;
