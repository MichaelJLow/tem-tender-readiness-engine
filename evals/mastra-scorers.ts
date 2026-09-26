import { createScorer } from '@mastra/core/evals';
import { z } from 'zod';
import { EvalOutcomeSchema } from './metrics.js';
import { EvalFactSchema } from './schema.js';
import {
  findTenderInterpretation,
  interpretationIsAmbiguous,
  normalizedFactKey,
  toAgentFacts,
} from './interpretation.js';

const AnySchema = z.unknown();

function factF1(expectedValue: unknown, actualValue: unknown): number {
  const expected = z.array(EvalFactSchema).safeParse(expectedValue);
  const interpretation = findTenderInterpretation(actualValue);
  if (!expected.success || !interpretation) return 0;
  const expectedKeys = expected.data.map(normalizedFactKey);
  const actualKeys = toAgentFacts(interpretation).map(normalizedFactKey);
  const counts = new Map<string, number>();
  for (const key of actualKeys) counts.set(key, (counts.get(key) ?? 0) + 1);
  let matched = 0;
  for (const key of expectedKeys) {
    const remaining = counts.get(key) ?? 0;
    if (remaining > 0) {
      matched += 1;
      counts.set(key, remaining - 1);
    }
  }
  if (expectedKeys.length === 0 && actualKeys.length === 0) return 1;
  const precision = actualKeys.length === 0 ? 0 : matched / actualKeys.length;
  const recall = expectedKeys.length === 0 ? 1 : matched / expectedKeys.length;
  return precision + recall === 0 ? 0 : (2 * precision * recall) / (precision + recall);
}

export const evidenceFactF1Scorer = createScorer({
  id: 'tender-evidence-f1',
  name: 'Tender evidence fact F1',
  description: 'Exact match on critical fact value, source citation, and site attribution.',
  type: { input: AnySchema, output: AnySchema },
}).generateScore(({ run }) => {
  const truth =
    typeof run.groundTruth === 'object' && run.groundTruth !== null
      ? (run.groundTruth as Record<string, unknown>)
      : {};
  return factF1(truth.expectedFacts, run.output);
});

export const ambiguityRecallScorer = createScorer({
  id: 'tender-ambiguity-recall',
  name: 'Tender ambiguity recall',
  description: 'Checks whether labelled ambiguous evidence is explicitly marked ambiguous.',
  type: { input: AnySchema, output: AnySchema },
}).generateScore(({ run }) => {
  const truth =
    typeof run.groundTruth === 'object' && run.groundTruth !== null
      ? (run.groundTruth as Record<string, unknown>)
      : {};
  const expected = truth.expectedAmbiguous === true;
  const actual = interpretationIsAmbiguous(findTenderInterpretation(run.output));
  return expected ? (actual ? 1 : 0) : actual ? 0 : 1;
});

function decisionOutcome(value: unknown) {
  return EvalOutcomeSchema.safeParse(value);
}

export const decisionRouteScorer = createScorer({
  id: 'tender-decision-route',
  name: 'Tender route and status correctness',
  description: 'Requires exact match for business route and technical processing status.',
  type: { input: AnySchema, output: AnySchema },
}).generateScore(({ run }) => {
  const result = decisionOutcome(run.output);
  if (!result.success) return 0;
  return result.data.actualRoute === result.data.expectedRoute &&
    result.data.actualStatus === result.data.expectedStatus
    ? 1
    : 0;
});

export const decisionFlagsScorer = createScorer({
  id: 'tender-decision-flags',
  name: 'Tender rule flags',
  description: 'Measures exact precision and recall for labelled deterministic rule flags.',
  type: { input: AnySchema, output: AnySchema },
}).generateScore(({ run }) => {
  const result = decisionOutcome(run.output);
  if (!result.success) return 0;
  const expected = result.data.expectedFlags;
  const actual = result.data.actualFlags;
  if (expected.length === 0 && actual.length === 0) return 1;
  const expectedSet = new Set(expected);
  const actualSet = new Set(actual);
  const matched = [...expectedSet].filter((flag) => actualSet.has(flag)).length;
  const precision = actualSet.size === 0 ? 0 : matched / actualSet.size;
  const recall = expectedSet.size === 0 ? 1 : matched / expectedSet.size;
  return precision + recall === 0 ? 0 : (2 * precision * recall) / (precision + recall);
});

export const pricingGuardScorer = createScorer({
  id: 'tender-pricing-guard',
  name: 'Tender pricing guard',
  description: 'Requires zero mock pricing handoffs for every non-ready route.',
  type: { input: AnySchema, output: AnySchema },
}).generateScore(({ run }) => {
  const result = decisionOutcome(run.output);
  if (!result.success) return 0;
  const safe =
    result.data.actualRoute === 'READY_FOR_PRICING'
      ? result.data.actualPricingHandoffs === 1
      : result.data.actualPricingHandoffs === 0;
  return safe && result.data.actualPricingHandoffs === result.data.expectedPricingHandoffs ? 1 : 0;
});
