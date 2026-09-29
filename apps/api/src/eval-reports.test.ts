import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { EvalReport } from '../../../evals/metrics.js';
import { readEvalOverview } from './eval-reports.js';

let directory: string;
let reportDirectory: string;

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'tender-readiness-evals-'));
  reportDirectory = join(directory, 'reports');
  await mkdir(reportDirectory);
});

afterEach(async () => {
  await rm(directory, { recursive: true, force: true });
});

describe('readEvalOverview', () => {
  it('validates the accepted pointer and compares the latest report to that exact baseline', async () => {
    const accepted = makeReport('full-accepted', 'a'.repeat(64));
    const latest = makeReport('full-latest', 'a'.repeat(64), {
      status: 'compared',
      baselineRunId: accepted.runId,
      baselineDatasetHash: accepted.datasetHash,
      detail: 'Compared with accepted baseline.',
    });
    await saveReport(accepted);
    await saveReport(latest);
    await savePointer(accepted);

    const overview = await readEvalOverview(directory);

    expect(overview.accepted.runId).toBe(accepted.runId);
    expect(overview.latest?.runId).toBe(latest.runId);
    expect(overview.latest?.baselineComparison).toMatchObject({
      status: 'compared',
      baselineRunId: accepted.runId,
      baselineDatasetHash: accepted.datasetHash,
    });
  });

  it('marks a latest report not comparable when its dataset hash differs', async () => {
    const accepted = makeReport('full-accepted', 'a'.repeat(64));
    const latest = makeReport('full-latest', 'b'.repeat(64), {
      status: 'compared',
      baselineRunId: accepted.runId,
      baselineDatasetHash: accepted.datasetHash,
      detail: 'Compared with accepted baseline.',
    });
    await saveReport(accepted);
    await saveReport(latest);
    await savePointer(accepted);

    const overview = await readEvalOverview(directory);

    expect(overview.latest?.baselineComparison).toMatchObject({
      status: 'not_comparable',
      baselineRunId: accepted.runId,
      baselineDatasetHash: accepted.datasetHash,
    });
  });

  it('marks a same-dataset report not comparable when it used an older accepted run', async () => {
    const accepted = makeReport('full-accepted', 'a'.repeat(64));
    const latest = makeReport('full-latest', accepted.datasetHash, {
      status: 'compared',
      baselineRunId: 'full-obsolete-baseline',
      baselineDatasetHash: accepted.datasetHash,
      detail: 'Compared with a previous accepted run on the same dataset.',
    });
    await saveReport(accepted);
    await saveReport(latest);
    await savePointer(accepted);

    const overview = await readEvalOverview(directory);

    expect(overview.latest?.baselineComparison).toMatchObject({
      status: 'not_comparable',
      baselineRunId: accepted.runId,
      baselineDatasetHash: accepted.datasetHash,
    });
  });

  it('rejects an accepted pointer whose metadata disagrees with its report', async () => {
    const accepted = makeReport('full-accepted', 'a'.repeat(64));
    await saveReport(accepted);
    await savePointer(accepted, { datasetHash: 'b'.repeat(64) });

    await expect(readEvalOverview(directory)).rejects.toThrow(
      'Accepted baseline pointer does not match its report metadata.',
    );
  });
});

async function saveReport(report: EvalReport): Promise<void> {
  await writeFile(join(reportDirectory, `${report.runId}.json`), JSON.stringify(report));
}

async function savePointer(
  report: EvalReport,
  override: Partial<{ datasetHash: string }> = {},
): Promise<void> {
  await writeFile(
    join(directory, 'accepted-baseline.json'),
    JSON.stringify({
      schemaVersion: 1,
      report: `reports/${report.runId}.json`,
      datasetId: report.datasetId,
      datasetHash: override.datasetHash ?? report.datasetHash,
      promptVersion: report.promptVersion,
      provider: report.provider,
      model: report.model,
      acceptedFor: 'test',
    }),
  );
}

function makeReport(
  runId: string,
  datasetHash: string,
  baselineComparison?: NonNullable<EvalReport['baselineComparison']>,
): EvalReport {
  return {
    schemaVersion: 1,
    runId,
    runType: 'release',
    startedAt: runId === 'full-latest' ? '2026-09-29T12:00:00.000Z' : '2026-09-28T12:00:00.000Z',
    completedAt: '2026-09-29T12:05:00.000Z',
    gitSha: 'test-sha',
    gitDirty: false,
    datasetId: 'synthetic-test-dataset',
    datasetHash,
    promptVersion: 'test-prompt-v1',
    runnerVersion: 'test-runner-v1',
    provider: 'test-provider',
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
    caseCount: 2,
    outcomes: [],
    metrics: {
      decision: {
        route: {},
        unsafeReady: { count: 0, denominator: 2 },
        humanReviewRecall: { correctlyEscalated: 1, denominator: 1, value: 1 },
        criticalFacts: { matched: 2, predicted: 2, expected: 2, precision: 1, recall: 1 },
      },
    },
    gates: [],
    verdict: 'pass',
    ...(baselineComparison ? { baselineComparison } : {}),
  };
}
