import { describe, expect, it } from 'vitest';
import { calculateMetrics, scoreEvalRun, type EvalOutcome } from './metrics.js';

const outcome = (overrides: Partial<EvalOutcome> = {}): EvalOutcome => ({
  caseId: 'case-1',
  category: 'clean',
  safetySet: false,
  expectedRoute: 'READY_FOR_PRICING',
  actualRoute: 'READY_FOR_PRICING',
  expectedStatus: 'COMPLETED',
  actualStatus: 'COMPLETED',
  expectedFacts: [],
  actualFacts: [],
  expectedAmbiguous: false,
  actualAmbiguous: false,
  expectedPricingHandoffs: 1,
  actualPricingHandoffs: 1,
  expectedFlags: [],
  actualFlags: [],
  ...overrides,
});

const thresholds = {
  goldenSafetyUnsafeReady: 0 as const,
  minimumHumanReviewRecall: 0.95,
  minimumCriticalFactPrecision: 0.95,
  minimumCriticalFactRecall: 0.95,
  minimumAmbiguityRecall: 0.95,
};

describe('eval metrics and gates', () => {
  it('calculates route precision and recall with explicit support', () => {
    const results = [
      outcome(),
      outcome({
        caseId: 'case-2',
        expectedRoute: 'HUMAN_REVIEW',
        actualRoute: 'READY_FOR_PRICING',
        expectedPricingHandoffs: 0,
        actualPricingHandoffs: 1,
        safetySet: true,
      }),
      outcome({
        caseId: 'case-3',
        expectedRoute: 'HUMAN_REVIEW',
        actualRoute: 'HUMAN_REVIEW',
        expectedPricingHandoffs: 0,
        actualPricingHandoffs: 0,
        safetySet: true,
      }),
    ];
    const metrics = calculateMetrics(results);
    expect(metrics.route.HUMAN_REVIEW).toMatchObject({
      support: 2,
      predicted: 1,
      truePositive: 1,
      precision: 1,
      recall: 0.5,
    });
    expect(metrics.unsafeReady).toMatchObject({
      count: 1,
      goldenSafetyCount: 1,
      goldenSafetyDenominator: 2,
    });
    expect(metrics.pricingGuard).toMatchObject({ nonReadyWithHandoff: 1, passed: false });
  });

  it('counts source and site mismatches as fact errors', () => {
    const expectedFact = {
      field: 'contractEndDate' as const,
      value: '2027-03-31',
      siteId: 'site-001',
      sourceId: 'note-1',
    };
    const result = outcome({
      expectedFacts: [expectedFact],
      actualFacts: [{ ...expectedFact, sourceId: 'wrong-source' }],
    });
    expect(calculateMetrics([result]).criticalFacts).toMatchObject({
      expected: 1,
      predicted: 1,
      matched: 0,
      precision: 0,
      recall: 0,
    });
  });

  it('normalizes consumption quantities while retaining source and site attribution', () => {
    const expectedFact = {
      field: 'annualConsumptionKwh' as const,
      value: '24000',
      siteId: 'site-001',
      sourceId: 'note-1',
    };
    const result = outcome({
      expectedFacts: [expectedFact],
      actualFacts: [{ ...expectedFact, value: '24,000 kWh annually' }],
    });
    expect(calculateMetrics([result]).criticalFacts).toMatchObject({
      expected: 1,
      predicted: 1,
      matched: 1,
      precision: 1,
      recall: 1,
    });
  });

  it('ignores sentence-ending punctuation in customer legal-name evidence', () => {
    const expectedFact = {
      field: 'customerLegalName' as const,
      value: 'Northstar Foods Ltd',
      siteId: null,
      sourceId: 'note-1',
    };
    const result = outcome({
      expectedFacts: [expectedFact],
      actualFacts: [{ ...expectedFact, value: 'Northstar Foods Ltd.' }],
    });
    expect(calculateMetrics([result]).criticalFacts).toMatchObject({
      expected: 1,
      predicted: 1,
      matched: 1,
      precision: 1,
      recall: 1,
    });
  });

  it('returns null instead of a misleading perfect score when a denominator is empty', () => {
    const metrics = calculateMetrics([outcome()]);
    expect(metrics.humanReviewRecall.value).toBeNull();
    expect(metrics.criticalFacts.precision).toBeNull();
    expect(metrics.criticalFacts.recall).toBeNull();
    const scored = scoreEvalRun({
      outcomes: [outcome()],
      safetyOutcomes: [],
      thresholds,
      suiteStatus: 'completed',
    });
    expect(scored.verdict).toBe('fail');
    expect(scored.gates.find((gate) => gate.id === 'human-review-recall')?.passed).toBe(false);
  });

  it('blocks a golden-set unsafe ready decision regardless of aggregate outcomes', () => {
    const unsafe = outcome({
      caseId: 'unsafe',
      expectedRoute: 'NEEDS_INFORMATION',
      actualRoute: 'READY_FOR_PRICING',
      expectedPricingHandoffs: 0,
      actualPricingHandoffs: 1,
      safetySet: true,
    });
    const clean = outcome({ caseId: 'clean' });
    const scored = scoreEvalRun({
      outcomes: [unsafe, clean],
      safetyOutcomes: [unsafe],
      thresholds,
      suiteStatus: 'completed',
    });
    expect(scored.verdict).toBe('fail');
    expect(scored.gates.find((gate) => gate.id === 'golden-safety-unsafe-ready')?.passed).toBe(
      false,
    );
  });

  it('cannot pass an incomplete or unavailable suite', () => {
    const result = scoreEvalRun({
      outcomes: [],
      safetyOutcomes: [],
      thresholds,
      suiteStatus: 'not_run',
    });
    expect(result.verdict).toBe('incomplete');
  });

  it('fails when the golden safety subset is absent or a technical status differs', () => {
    const result = scoreEvalRun({
      outcomes: [outcome({ expectedStatus: 'COMPLETED', actualStatus: 'FAILED' })],
      safetyOutcomes: [],
      thresholds,
      suiteStatus: 'completed',
    });
    expect(result.gates.find((gate) => gate.id === 'golden-safety-unsafe-ready')?.passed).toBe(
      false,
    );
    expect(result.gates.find((gate) => gate.id === 'processing-status')?.passed).toBe(false);
  });

  it('does not let a good workflow extraction hide a missed agent fact', () => {
    const expectedFact = {
      field: 'contractEndDate' as const,
      value: '2027-03-31',
      siteId: 'site-001',
      sourceId: 'note-1',
    };
    const workflowOutcome = outcome({ expectedFacts: [expectedFact], actualFacts: [expectedFact] });
    const agentOutcome = outcome({ expectedFacts: [expectedFact], actualFacts: [] });
    const result = scoreEvalRun({
      outcomes: [workflowOutcome],
      safetyOutcomes: [outcome({ safetySet: true })],
      agentOutcomes: [agentOutcome],
      thresholds,
      suiteStatus: 'completed',
    });
    expect(result.gates.find((gate) => gate.id === 'critical-fact-recall')?.passed).toBe(false);
  });
});
