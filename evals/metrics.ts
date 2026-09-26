import { createHash } from 'node:crypto';
import { z } from 'zod';
import {
  ProcessingStatusSchema,
  RuleIdSchema,
  TenderRouteSchema,
} from '../packages/domain/src/index.js';
import { EvalCategorySchema, EvalDatasetSchema, EvalFactSchema } from './schema.js';

const NullableRouteSchema = TenderRouteSchema.nullable();

export const EvalOutcomeSchema = z.object({
  caseId: z.string().min(1),
  category: EvalCategorySchema,
  safetySet: z.boolean(),
  expectedRoute: NullableRouteSchema,
  actualRoute: NullableRouteSchema,
  expectedStatus: ProcessingStatusSchema,
  actualStatus: ProcessingStatusSchema,
  expectedFacts: z.array(EvalFactSchema),
  actualFacts: z.array(EvalFactSchema),
  expectedAmbiguous: z.boolean(),
  actualAmbiguous: z.boolean(),
  expectedPricingHandoffs: z.number().int().nonnegative(),
  actualPricingHandoffs: z.number().int().nonnegative(),
  expectedFlags: z.array(RuleIdSchema).default([]),
  actualFlags: z.array(RuleIdSchema).default([]),
  modelTraceId: z.string().optional(),
  modelDurationMs: z.number().int().nonnegative().optional(),
  errorCode: z.string().optional(),
});

export type EvalOutcome = z.infer<typeof EvalOutcomeSchema>;

export const EvalThresholdsSchema = z.object({
  goldenSafetyUnsafeReady: z.literal(0),
  minimumHumanReviewRecall: z.number().min(0).max(1),
  minimumCriticalFactPrecision: z.number().min(0).max(1),
  minimumCriticalFactRecall: z.number().min(0).max(1),
  minimumAmbiguityRecall: z.number().min(0).max(1),
});

export const EvalReportSchema = z.object({
  schemaVersion: z.literal(1),
  runId: z.string().min(1),
  runType: z.enum(['pr', 'release', 'manual']),
  startedAt: z.string().datetime(),
  completedAt: z.string().datetime().optional(),
  gitSha: z.string().min(1),
  gitDirty: z.boolean(),
  datasetId: z.string().min(1),
  datasetHash: z.string().regex(/^[a-f0-9]{64}$/),
  promptVersion: z.string().min(1),
  runnerVersion: z.string().min(1),
  provider: z.string().min(1),
  model: z.string().min(1),
  thresholds: EvalThresholdsSchema,
  suiteStatus: z.enum(['completed', 'incomplete', 'not_run']),
  studioExperiments: z.array(
    z.object({
      targetType: z.enum(['agent', 'workflow']),
      targetId: z.string().min(1),
      experimentId: z.string().min(1),
    }),
  ),
  caseCount: z.number().int().nonnegative(),
  outcomes: z.array(EvalOutcomeSchema),
  metrics: z.record(z.string(), z.unknown()),
  gates: z.array(
    z.object({
      id: z.string().min(1),
      passed: z.boolean(),
      detail: z.string().min(1),
    }),
  ),
  verdict: z.enum(['pass', 'fail', 'incomplete']),
});

export type EvalReport = z.infer<typeof EvalReportSchema>;

const routes = ['READY_FOR_PRICING', 'NEEDS_INFORMATION', 'HUMAN_REVIEW', 'DUPLICATE'] as const;
type Route = (typeof routes)[number];

function factKey(fact: z.infer<typeof EvalFactSchema>): string {
  return [
    fact.field,
    normalizeFactValue(fact.field, fact.value),
    fact.siteId ?? '',
    fact.sourceId,
  ].join('\u001f');
}

function normalizeFactValue(field: string, value: string): string {
  const trimmed = value.trim();
  if (field === 'contractEndDate') {
    const iso = trimmed.match(/^(\d{4})-(\d{2})-(\d{2})$/);
    if (iso) return `${iso[1]}-${iso[2]}-${iso[3]}`;
    const dayFirst = trimmed.match(/^(\d{2})[/-](\d{2})[/-](\d{4})$/);
    if (dayFirst) return `${dayFirst[3]}-${dayFirst[2]}-${dayFirst[1]}`;
  }
  if (field === 'meterIdentifier') return trimmed.replace(/\s/g, '').toUpperCase();
  if (field === 'annualConsumptionKwh') {
    const quantity = trimmed.match(/\d[\d,]*(?:\.\d+)?/);
    return quantity ? quantity[0].replace(/,/g, '') : trimmed.replace(/[,\s]|kwh/gi, '');
  }
  if (field === 'customerLegalName') {
    return trimmed
      .replace(/[.,;:!?]+$/g, '')
      .replace(/\s+/g, ' ')
      .toLocaleLowerCase('en');
  }
  return trimmed.toLocaleLowerCase('en');
}

function ratio(numerator: number, denominator: number): number | null {
  return denominator === 0 ? null : numerator / denominator;
}

function countKeys(keys: string[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const key of keys) counts.set(key, (counts.get(key) ?? 0) + 1);
  return counts;
}

function routeMetrics(outcomes: readonly EvalOutcome[]) {
  return Object.fromEntries(
    routes.map((route: Route) => {
      const predicted = outcomes.filter((outcome) => outcome.actualRoute === route);
      const expected = outcomes.filter((outcome) => outcome.expectedRoute === route);
      const truePositive = predicted.filter((outcome) => outcome.expectedRoute === route).length;
      return [
        route,
        {
          support: expected.length,
          predicted: predicted.length,
          truePositive,
          precision: ratio(truePositive, predicted.length),
          recall: ratio(truePositive, expected.length),
          falsePositive: predicted.length - truePositive,
          falseNegative: expected.length - truePositive,
        },
      ];
    }),
  );
}

function factMetrics(outcomes: readonly EvalOutcome[]) {
  const expected = outcomes.flatMap((outcome) => outcome.expectedFacts.map(factKey));
  const predicted = outcomes.flatMap((outcome) => outcome.actualFacts.map(factKey));
  const expectedCounts = countKeys(expected);
  const predictedCounts = countKeys(predicted);
  let matched = 0;
  for (const [key, count] of expectedCounts)
    matched += Math.min(count, predictedCounts.get(key) ?? 0);
  return {
    expected: expected.length,
    predicted: predicted.length,
    matched,
    precision: ratio(matched, predicted.length),
    recall: ratio(matched, expected.length),
    falsePositive: predicted.length - matched,
    falseNegative: expected.length - matched,
  };
}

function flagMetrics(outcomes: readonly EvalOutcome[]) {
  const expected = outcomes.flatMap((outcome) => outcome.expectedFlags);
  const predicted = outcomes.flatMap((outcome) => outcome.actualFlags);
  const expectedCounts = countKeys(expected);
  const predictedCounts = countKeys(predicted);
  let matched = 0;
  for (const [key, count] of expectedCounts)
    matched += Math.min(count, predictedCounts.get(key) ?? 0);
  return {
    expected: expected.length,
    predicted: predicted.length,
    matched,
    precision: ratio(matched, predicted.length),
    recall: ratio(matched, expected.length),
  };
}

export function calculateMetrics(rawOutcomes: readonly EvalOutcome[]) {
  const outcomes = rawOutcomes.map((outcome) => EvalOutcomeSchema.parse(outcome));
  const route = routeMetrics(outcomes);
  const facts = factMetrics(outcomes);
  const flags = flagMetrics(outcomes);
  const safety = outcomes.filter((outcome) => outcome.safetySet);
  const unsafe = (outcome: EvalOutcome) =>
    outcome.actualRoute === 'READY_FOR_PRICING' && outcome.expectedRoute !== 'READY_FOR_PRICING';
  const unsafeReady = outcomes.filter(unsafe);
  const humanReview = outcomes.filter((outcome) => outcome.expectedRoute === 'HUMAN_REVIEW');
  const ambiguous = outcomes.filter((outcome) => outcome.expectedAmbiguous);
  const nonReadyWithPricingHandoff = outcomes.filter(
    (outcome) => outcome.expectedRoute !== 'READY_FOR_PRICING' && outcome.actualPricingHandoffs > 0,
  );
  const correctlyFlaggedAmbiguity = ambiguous.filter((outcome) => outcome.actualAmbiguous).length;

  return {
    caseCount: outcomes.length,
    route,
    unsafeReady: {
      count: unsafeReady.length,
      denominator: outcomes.length,
      rate: ratio(unsafeReady.length, outcomes.length),
      goldenSafetyCount: safety.filter(unsafe).length,
      goldenSafetyDenominator: safety.length,
    },
    humanReviewRecall: {
      correctlyEscalated: route.HUMAN_REVIEW.truePositive,
      denominator: humanReview.length,
      value: route.HUMAN_REVIEW.recall,
    },
    criticalFacts: facts,
    ruleFlags: flags,
    processingStatus: {
      matched: outcomes.filter((outcome) => outcome.expectedStatus === outcome.actualStatus).length,
      denominator: outcomes.length,
      accuracy: ratio(
        outcomes.filter((outcome) => outcome.expectedStatus === outcome.actualStatus).length,
        outcomes.length,
      ),
    },
    ambiguity: {
      correctlyFlagged: correctlyFlaggedAmbiguity,
      denominator: ambiguous.length,
      recall: ratio(correctlyFlaggedAmbiguity, ambiguous.length),
    },
    pricingGuard: {
      nonReadyWithHandoff: nonReadyWithPricingHandoff.length,
      denominator: outcomes.length,
      passed: nonReadyWithPricingHandoff.length === 0,
    },
    byCategory: Object.fromEntries(
      [...new Set(outcomes.map((outcome) => outcome.category))].sort().map((category) => {
        const group = outcomes.filter((outcome) => outcome.category === category);
        return [category, { caseCount: group.length, unsafeReady: group.filter(unsafe).length }];
      }),
    ),
  };
}

export function scoreEvalRun(args: {
  outcomes: readonly EvalOutcome[];
  safetyOutcomes: readonly EvalOutcome[];
  agentOutcomes?: readonly EvalOutcome[];
  thresholds: z.infer<typeof EvalThresholdsSchema>;
  suiteStatus: 'completed' | 'incomplete' | 'not_run';
  baseline?: { datasetHash: string; metrics: ReturnType<typeof calculateMetrics> };
  datasetHash?: string;
}) {
  const thresholds = EvalThresholdsSchema.parse(args.thresholds);
  const metrics = calculateMetrics(args.outcomes);
  const safetyMetrics = calculateMetrics(args.safetyOutcomes);
  const agentFactMetrics = args.agentOutcomes
    ? calculateMetrics(args.agentOutcomes).criticalFacts
    : undefined;
  const gates = [
    {
      id: 'golden-safety-unsafe-ready',
      passed:
        safetyMetrics.unsafeReady.goldenSafetyDenominator > 0 &&
        safetyMetrics.unsafeReady.goldenSafetyCount === thresholds.goldenSafetyUnsafeReady,
      detail: `${safetyMetrics.unsafeReady.goldenSafetyCount} unsafe ready outcomes across ${safetyMetrics.unsafeReady.goldenSafetyDenominator} golden safety cases; required ${thresholds.goldenSafetyUnsafeReady}.`,
    },
    {
      id: 'processing-status',
      passed: metrics.processingStatus.accuracy === 1,
      detail: `${metrics.processingStatus.matched}/${metrics.processingStatus.denominator} technical processing statuses match labels.`,
    },
    {
      id: 'human-review-recall',
      passed:
        metrics.humanReviewRecall.value !== null &&
        metrics.humanReviewRecall.value >= thresholds.minimumHumanReviewRecall,
      detail: `${metrics.humanReviewRecall.correctlyEscalated}/${metrics.humanReviewRecall.denominator} expected human-review cases correctly escalated.`,
    },
    {
      id: 'critical-fact-precision',
      passed:
        metrics.criticalFacts.precision !== null &&
        metrics.criticalFacts.precision >= thresholds.minimumCriticalFactPrecision &&
        agentFactMetrics?.precision !== null &&
        agentFactMetrics?.precision !== undefined &&
        agentFactMetrics.precision >= thresholds.minimumCriticalFactPrecision,
      detail: `Workflow ${metrics.criticalFacts.matched}/${metrics.criticalFacts.predicted}; agent ${agentFactMetrics?.matched ?? 0}/${agentFactMetrics?.predicted ?? 0} emitted facts match labels.`,
    },
    {
      id: 'critical-fact-recall',
      passed:
        metrics.criticalFacts.recall !== null &&
        metrics.criticalFacts.recall >= thresholds.minimumCriticalFactRecall &&
        agentFactMetrics?.recall !== null &&
        agentFactMetrics?.recall !== undefined &&
        agentFactMetrics.recall >= thresholds.minimumCriticalFactRecall,
      detail: `Workflow ${metrics.criticalFacts.matched}/${metrics.criticalFacts.expected}; agent ${agentFactMetrics?.matched ?? 0}/${agentFactMetrics?.expected ?? 0} labelled facts extracted.`,
    },
    {
      id: 'ambiguity-recall',
      passed:
        metrics.ambiguity.recall !== null &&
        metrics.ambiguity.recall >= thresholds.minimumAmbiguityRecall,
      detail: `${metrics.ambiguity.correctlyFlagged}/${metrics.ambiguity.denominator} ambiguous cases were flagged.`,
    },
    {
      id: 'pricing-guard',
      passed: metrics.pricingGuard.passed,
      detail: `${metrics.pricingGuard.nonReadyWithHandoff} non-ready cases invoked pricing.`,
    },
  ];
  if (args.baseline && args.datasetHash && args.baseline.datasetHash === args.datasetHash) {
    const currentUnsafe = safetyMetrics.unsafeReady.goldenSafetyCount;
    const baselineUnsafe = args.baseline.metrics.unsafeReady.goldenSafetyCount;
    gates.push({
      id: 'safety-baseline',
      passed: currentUnsafe <= baselineUnsafe,
      detail: `Golden safety unsafe-ready count changed from ${baselineUnsafe} to ${currentUnsafe}.`,
    });
  }
  const verdict =
    args.suiteStatus !== 'completed'
      ? 'incomplete'
      : gates.every((gate) => gate.passed)
        ? 'pass'
        : 'fail';
  return { metrics, gates, verdict } as const;
}

export function hashEvalDataset(rawDataset: unknown): string {
  const dataset = EvalDatasetSchema.parse(rawDataset);
  return createHash('sha256').update(JSON.stringify(dataset)).digest('hex');
}
