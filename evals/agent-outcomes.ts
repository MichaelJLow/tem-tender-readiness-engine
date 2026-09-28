import { EvalOutcomeSchema, type EvalOutcome } from './metrics.js';
import type { EvalCase } from './schema.js';
import { agentPrompt } from './mastra-datasets.js';
import {
  findTenderInterpretation,
  interpretationIsAmbiguous,
  interpretationHasGroundedEvidence,
  toAgentFacts,
} from './interpretation.js';

export interface AgentExperimentItem {
  caseId: unknown;
  output: unknown;
  failed: boolean;
  errorCode?: string;
}

function agentOutcome(
  testCase: EvalCase,
  interpretation: ReturnType<typeof findTenderInterpretation>,
  errorCode?: string,
): EvalOutcome {
  return EvalOutcomeSchema.parse({
    caseId: testCase.id,
    category: testCase.category,
    safetySet: testCase.safetySet,
    expectedRoute: null,
    actualRoute: null,
    expectedStatus: 'COMPLETED',
    actualStatus: errorCode ? 'FAILED' : 'COMPLETED',
    expectedFacts: testCase.expected.facts,
    actualFacts: errorCode || !interpretation ? [] : toAgentFacts(interpretation, testCase.input),
    expectedAmbiguous: testCase.expected.ambiguous,
    actualAmbiguous:
      errorCode || !interpretation ? false : interpretationIsAmbiguous(interpretation),
    expectedPricingHandoffs: 0,
    actualPricingHandoffs: 0,
    expectedFlags: [],
    actualFlags: [],
    ...(errorCode ? { errorCode } : {}),
  });
}

export function reconcileAgentOutcomes(
  cases: readonly EvalCase[],
  results: readonly AgentExperimentItem[],
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
    const parsedInterpretation = result.failed
      ? undefined
      : findTenderInterpretation(result.output);
    const interpretation =
      parsedInterpretation &&
      interpretationHasGroundedEvidence(parsedInterpretation, agentPrompt(testCase))
        ? parsedInterpretation
        : undefined;
    const errorCode = result.failed
      ? result.errorCode || 'EXPERIMENT_TARGET_FAILED'
      : interpretation
        ? undefined
        : 'MODEL_OUTPUT_INVALID';
    outcomesById.set(testCase.id, agentOutcome(testCase, interpretation, errorCode));
  }

  const outcomes = cases.map(
    (testCase) =>
      outcomesById.get(testCase.id) ?? agentOutcome(testCase, undefined, 'EXPERIMENT_ITEM_MISSING'),
  );
  return {
    outcomes,
    unexpectedResults,
    complete:
      unexpectedResults === 0 &&
      outcomes.length === results.length &&
      outcomes.every((outcome) => outcome.actualStatus === 'COMPLETED'),
  };
}
