import { describe, expect, it } from 'vitest';
import { EvalReportSchema } from './metrics.js';
import { verifyReport } from './verify-evidence.js';

const report = EvalReportSchema.parse({
  schemaVersion: 1,
  runId: 'full-test',
  runType: 'release',
  startedAt: '2026-09-30T00:00:00.000Z',
  completedAt: '2026-09-30T00:01:00.000Z',
  gitSha: 'a'.repeat(40),
  gitDirty: false,
  datasetId: 'synthetic-v1',
  datasetHash: 'b'.repeat(64),
  promptVersion: 'prompt-v1',
  runnerVersion: '1',
  provider: 'openai',
  model: 'test-model',
  thresholds: {
    goldenSafetyUnsafeReady: 0,
    minimumHumanReviewRecall: 0.95,
    minimumCriticalFactPrecision: 0.95,
    minimumCriticalFactRecall: 0.95,
    minimumAmbiguityRecall: 0.95,
    maximumBaselineSafetyDrop: 0.01,
  },
  suiteStatus: 'completed',
  studioExperiments: [],
  caseCount: 1,
  outcomes: [
    {
      caseId: 'synthetic-case',
      category: 'clean',
      safetySet: true,
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
    },
  ],
  metrics: {},
  gates: [{ id: 'safety', passed: true, detail: 'passed' }],
  verdict: 'pass',
  baselineComparison: { status: 'compared', detail: 'same dataset' },
});

describe('release evidence verification', () => {
  it('accepts complete, clean, comparable full evidence', () => {
    expect(() => verifyReport(report, 'release')).not.toThrow();
  });

  it.each([
    ['not-run evidence', { suiteStatus: 'not_run', verdict: 'incomplete' }],
    ['dirty evidence', { gitDirty: true }],
    ['missing outcomes', { outcomes: [] }],
    ['a failed gate', { gates: [{ id: 'safety', passed: false, detail: 'failed' }] }],
    [
      'non-comparable evidence',
      { baselineComparison: { status: 'unavailable', detail: 'missing' } },
    ],
  ])('rejects %s', (_label, change) => {
    expect(() =>
      verifyReport(EvalReportSchema.parse({ ...report, ...change }), 'release'),
    ).toThrow();
  });

  it('requires the PR suite for PR evidence', () => {
    expect(() => verifyReport(report, 'pr')).toThrow('PR suite');
    expect(() => verifyReport({ ...report, runType: 'pr' }, 'pr')).not.toThrow();
  });
});
