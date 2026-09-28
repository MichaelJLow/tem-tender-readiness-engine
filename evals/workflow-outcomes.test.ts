import { describe, expect, it } from 'vitest';
import { evalCases } from './cases.js';
import { EvalOutcomeSchema } from './metrics.js';
import { reconcileWorkflowOutcomes } from './workflow-outcomes.js';

const testCase = evalCases.find((item) => item.id === 'ready-structured-single')!;
const validOutput = EvalOutcomeSchema.parse({
  caseId: testCase.id,
  category: testCase.category,
  safetySet: testCase.safetySet,
  expectedRoute: testCase.expected.route,
  actualRoute: testCase.expected.route,
  expectedStatus: testCase.expected.status,
  actualStatus: testCase.expected.status,
  expectedFacts: testCase.expected.facts,
  actualFacts: testCase.expected.facts,
  expectedAmbiguous: testCase.expected.ambiguous,
  actualAmbiguous: testCase.expected.ambiguous,
  expectedPricingHandoffs: testCase.expected.pricingHandoffs,
  actualPricingHandoffs: testCase.expected.pricingHandoffs,
  expectedFlags: testCase.expected.flaggedRules,
  actualFlags: testCase.expected.flaggedRules,
});

describe('workflow experiment reconciliation', () => {
  it('accepts a result bound to its canonical case and labels', () => {
    const result = reconcileWorkflowOutcomes(
      [testCase],
      [{ caseId: testCase.id, output: validOutput, failed: false }],
    );
    expect(result.complete).toBe(true);
    expect(result.outcomes[0]).toEqual(validOutput);
  });

  it('rejects an output that carries another case ID or changed expected labels', () => {
    for (const output of [
      { ...validOutput, caseId: 'different-case' },
      { ...validOutput, expectedRoute: 'HUMAN_REVIEW' },
      { ...validOutput, expectedPricingHandoffs: 0 },
    ]) {
      const result = reconcileWorkflowOutcomes(
        [testCase],
        [{ caseId: testCase.id, output, failed: false }],
      );
      expect(result.complete).toBe(false);
      expect(result.outcomes[0]).toMatchObject({
        caseId: testCase.id,
        actualStatus: 'FAILED',
        errorCode: 'EVAL_LABEL_MISMATCH',
      });
    }
  });

  it('does not silently accept an extra or duplicate experiment item', () => {
    const valid = { caseId: testCase.id, output: validOutput, failed: false };
    expect(reconcileWorkflowOutcomes([testCase], [valid, valid])).toMatchObject({
      complete: false,
      unexpectedResults: 1,
    });
    expect(
      reconcileWorkflowOutcomes([testCase], [valid, { ...valid, caseId: 'unknown-case' }]),
    ).toMatchObject({ complete: false, unexpectedResults: 1 });
  });
});
