import { describe, expect, it } from 'vitest';
import { reconcileAgentOutcomes } from './agent-outcomes.js';
import { evalCases } from './cases.js';
import { selectAgentCases } from './mastra-datasets.js';

const testCase = selectAgentCases(evalCases)[0]!;
const validOutput = {
  summary: 'No relevant facts were extracted.',
  sourceAssessments: [],
  observations: [],
  siteAssociations: [],
  conflicts: [],
};

describe('agent experiment reconciliation', () => {
  it('marks a missing experiment item as failed and incomplete', () => {
    const result = reconcileAgentOutcomes([testCase], []);
    expect(result.complete).toBe(false);
    expect(result.outcomes).toMatchObject([
      { caseId: testCase.id, actualStatus: 'FAILED', errorCode: 'EXPERIMENT_ITEM_MISSING' },
    ]);
  });

  it('marks an unparseable model output as failed even without a Mastra error', () => {
    const result = reconcileAgentOutcomes(
      [testCase],
      [{ caseId: testCase.id, output: { unexpected: true }, failed: false }],
    );
    expect(result.complete).toBe(false);
    expect(result.outcomes[0]).toMatchObject({
      actualStatus: 'FAILED',
      errorCode: 'MODEL_OUTPUT_INVALID',
    });
  });

  it('does not complete with an unknown or duplicate result', () => {
    const valid = { caseId: testCase.id, output: validOutput, failed: false };
    expect(reconcileAgentOutcomes([testCase], [valid]).complete).toBe(true);
    expect(reconcileAgentOutcomes([testCase], [valid, valid]).complete).toBe(false);
    expect(
      reconcileAgentOutcomes([testCase], [{ ...valid, caseId: 'unknown-case' }]).complete,
    ).toBe(false);
  });
});
