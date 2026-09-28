import { EvalOutcomeSchema, type EvalOutcome } from './metrics.js';
import type { EvalCase } from './schema.js';

export interface WorkflowExperimentItem {
  caseId: unknown;
  output: unknown;
  failed: boolean;
  errorCode?: string;
}

export function failedWorkflowOutcome(testCase: EvalCase, errorCode: string): EvalOutcome {
  return EvalOutcomeSchema.parse({
    caseId: testCase.id,
    category: testCase.category,
    safetySet: testCase.safetySet,
    expectedRoute: testCase.expected.route,
    actualRoute: null,
    expectedStatus: testCase.expected.status,
    actualStatus: 'FAILED',
    expectedFacts: testCase.expected.facts,
    actualFacts: [],
    expectedAmbiguous: testCase.expected.ambiguous,
    actualAmbiguous: false,
    expectedPricingHandoffs: testCase.expected.pricingHandoffs,
    actualPricingHandoffs: 0,
    expectedFlags: testCase.expected.flaggedRules,
    actualFlags: [],
    errorCode,
  });
}

function hasCanonicalLabels(outcome: EvalOutcome, testCase: EvalCase): boolean {
  return (
    outcome.caseId === testCase.id &&
    outcome.category === testCase.category &&
    outcome.safetySet === testCase.safetySet &&
    outcome.expectedRoute === testCase.expected.route &&
    outcome.expectedStatus === testCase.expected.status &&
    outcome.expectedAmbiguous === testCase.expected.ambiguous &&
    outcome.expectedPricingHandoffs === testCase.expected.pricingHandoffs &&
    JSON.stringify(outcome.expectedFacts) === JSON.stringify(testCase.expected.facts) &&
    JSON.stringify(outcome.expectedFlags) === JSON.stringify(testCase.expected.flaggedRules)
  );
}

export function reconcileWorkflowOutcomes(
  cases: readonly EvalCase[],
  results: readonly WorkflowExperimentItem[],
) {
  const casesById = new Map(cases.map((testCase) => [testCase.id, testCase]));
  const outcomesById = new Map<string, EvalOutcome>();
  let unexpectedResults = 0;

  for (const result of results) {
    const testCase = typeof result.caseId === 'string' ? casesById.get(result.caseId) : undefined;
    if (!testCase || outcomesById.has(testCase.id)) {
      unexpectedResults += 1;
      continue;
    }
    const parsed = result.failed ? undefined : EvalOutcomeSchema.safeParse(result.output);
    outcomesById.set(
      testCase.id,
      parsed?.success && hasCanonicalLabels(parsed.data, testCase)
        ? parsed.data
        : failedWorkflowOutcome(
            testCase,
            result.errorCode ?? (parsed?.success ? 'EVAL_LABEL_MISMATCH' : 'EVAL_OUTPUT_INVALID'),
          ),
    );
  }

  const outcomes = cases.map(
    (testCase) =>
      outcomesById.get(testCase.id) ?? failedWorkflowOutcome(testCase, 'EXPERIMENT_ITEM_MISSING'),
  );
  return {
    outcomes,
    unexpectedResults,
    complete:
      unexpectedResults === 0 &&
      results.length === cases.length &&
      outcomes.every((outcome) => outcome.actualStatus !== 'FAILED'),
  };
}
