import { execFileSync } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import process from 'node:process';
import prettier from 'prettier';
import { resolveProviderConfiguration } from '../apps/api/src/reasoning/interpreter.js';
import { INTERPRETATION_PROMPT_VERSION } from '../apps/api/src/reasoning/contracts.js';
import {
  EvalReportSchema,
  EvalThresholdsSchema,
  calculateMetrics,
  hashEvalDataset,
  scoreEvalRun,
  type EvalOutcome,
} from './metrics.js';
import { evalDataset } from './cases.js';
import {
  findTenderInterpretation,
  interpretationIsAmbiguous,
  toAgentFacts,
} from './interpretation.js';
import { ensureStudioDataset, selectAgentCases, selectEvalCases } from './mastra-datasets.js';
import thresholdsConfig from './thresholds.json' with { type: 'json' };
import { EvalOutcomeSchema } from './metrics.js';

const suite = parseSuite(process.argv.slice(2));
const cases = selectEvalCases(suite);
const agentCases = selectAgentCases(cases);
const datasetSnapshot = { ...evalDataset, cases };
const datasetHash = hashEvalDataset(datasetSnapshot);
const startedAt = new Date();
const providerConfig = resolveProviderConfiguration();
const thresholds = EvalThresholdsSchema.parse(thresholdsConfig);
const model = providerConfig.model;
const provider = providerName(providerConfig.baseURL, providerConfig.apiKey);
const sourceRevision = gitOutput(['rev-parse', 'HEAD'], 'unknown');
const gitDirty = gitOutput(['status', '--porcelain'], '').length > 0;

let suiteStatus: 'completed' | 'incomplete' | 'not_run' = 'not_run';
let outcomes: EvalOutcome[] = [];
let agentOutcomes: EvalOutcome[] = [];
const studioExperiments: Array<{
  targetType: 'agent' | 'workflow';
  targetId: string;
  experimentId: string;
}> = [];
let agentMetricSummary: Record<string, unknown> = {
  caseCount: 0,
  meanFactF1: null,
  meanAmbiguityScore: null,
};
let studioDatasetIds: Record<string, string> = {};

if (!providerConfig.apiKey) {
  console.warn(
    'No model API key is configured; writing an explicit not-run report without importing Mastra Studio configuration.',
  );
} else {
  const { mastra } = await import('../apps/api/src/mastra/index.js');
  const {
    evidenceFactF1Scorer,
    ambiguityRecallScorer,
    decisionFlagsScorer,
    decisionRouteScorer,
    pricingGuardScorer,
  } = await import('./mastra-scorers.js');
  const agentDatasetResult =
    agentCases.length > 0
      ? await ensureStudioDataset({
          mastra,
          target: 'agent',
          cases: agentCases,
          targetId: 'tender-interpretation-agent',
        })
      : undefined;
  const workflowId = mastra.getWorkflow('decisionPathEvalWorkflow').id;
  const workflowDatasetResult = await ensureStudioDataset({
    mastra,
    target: 'workflow',
    cases,
    targetId: workflowId,
  });
  studioDatasetIds = {
    ...(agentDatasetResult ? { agent: agentDatasetResult.datasetId } : {}),
    workflow: workflowDatasetResult.datasetId,
  };

  const agentRun = agentDatasetResult
    ? await agentDatasetResult.dataset.startExperiment({
        targetType: 'agent',
        targetId: 'tender-interpretation-agent',
        name: `Tender interpretation ${suite} ${new Date().toISOString()}`,
        description: 'Canonical synthetic fact, evidence attribution, and ambiguity evaluation.',
        metadata: { suite, datasetHash, promptVersion: INTERPRETATION_PROMPT_VERSION },
        maxConcurrency: 1,
        itemTimeout: 60_000,
        scorers: [evidenceFactF1Scorer, ambiguityRecallScorer],
      })
    : undefined;
  const workflowRun = await workflowDatasetResult.dataset.startExperiment({
    targetType: 'workflow',
    targetId: workflowId,
    name: `Tender decision path ${suite} ${new Date().toISOString()}`,
    description:
      'Complete TenderService and deterministic domain route with isolated state and a mock pricing gateway.',
    metadata: { suite, datasetHash, promptVersion: INTERPRETATION_PROMPT_VERSION },
    maxConcurrency: 1,
    itemTimeout: 90_000,
    scorers: [decisionRouteScorer, decisionFlagsScorer, pricingGuardScorer],
  });

  if (agentRun) {
    studioExperiments.push({
      targetType: 'agent',
      targetId: 'tender-interpretation-agent',
      experimentId: agentRun.experimentId,
    });
    const scoreMeans = new Map<string, number[]>();
    const perCaseScores = agentRun.results.map((result) => ({
      caseId: String(result.metadata?.caseId ?? result.itemId),
      scores: Object.fromEntries(result.scores.map((score) => [score.scorerId, score.score])),
      error: result.error?.code ?? null,
    }));
    agentOutcomes = agentRun.results.flatMap((result) => {
      const caseId = String(result.metadata?.caseId ?? '');
      const testCase = agentCases.find((item) => item.id === caseId);
      if (!testCase) return [];
      const interpretation = findTenderInterpretation(result.output);
      return [
        EvalOutcomeSchema.parse({
          caseId,
          category: testCase.category,
          safetySet: testCase.safetySet,
          expectedRoute: null,
          actualRoute: null,
          expectedStatus: 'COMPLETED',
          actualStatus: result.error ? 'FAILED' : 'COMPLETED',
          expectedFacts: testCase.expected.facts,
          actualFacts: interpretation ? toAgentFacts(interpretation) : [],
          expectedAmbiguous: testCase.expected.ambiguous,
          actualAmbiguous: interpretation ? interpretationIsAmbiguous(interpretation) : false,
          expectedPricingHandoffs: 0,
          actualPricingHandoffs: 0,
          expectedFlags: [],
          actualFlags: [],
          ...(result.error?.code ? { errorCode: result.error.code } : {}),
        }),
      ];
    });
    for (const result of agentRun.results) {
      for (const score of result.scores) {
        if (score.score === null) continue;
        const list = scoreMeans.get(score.scorerId) ?? [];
        list.push(score.score);
        scoreMeans.set(score.scorerId, list);
      }
    }
    agentMetricSummary = {
      caseCount: agentRun.totalItems,
      succeededCount: agentRun.succeededCount,
      failedCount: agentRun.failedCount,
      meanFactF1: mean(scoreMeans.get('tender-evidence-f1')),
      meanAmbiguityScore: mean(scoreMeans.get('tender-ambiguity-recall')),
      facts: calculateMetrics(agentOutcomes).criticalFacts,
      perCaseScores,
    };
  }
  studioExperiments.push({
    targetType: 'workflow',
    targetId: workflowId,
    experimentId: workflowRun.experimentId,
  });

  const actualById = new Map<string, EvalOutcome>();
  for (const result of workflowRun.results) {
    const caseId = String(result.metadata?.caseId ?? '');
    const testCase = cases.find((item) => item.id === caseId);
    if (!testCase) continue;
    const output = EvalOutcomeSchema.safeParse(result.output);
    if (output.success) actualById.set(caseId, output.data);
    else
      actualById.set(
        caseId,
        failedOutcome(
          testCase.id,
          testCase.category,
          testCase.safetySet,
          testCase.expected,
          result.error?.code,
        ),
      );
  }
  outcomes = cases.map(
    (testCase) =>
      actualById.get(testCase.id) ??
      failedOutcome(
        testCase.id,
        testCase.category,
        testCase.safetySet,
        testCase.expected,
        'EXPERIMENT_ITEM_MISSING',
      ),
  );
  const workflowComplete =
    workflowRun.status === 'completed' &&
    workflowRun.failedCount === 0 &&
    (workflowRun.persistenceFailures ?? 0) === 0 &&
    outcomes.every((outcome) => outcome.actualStatus !== 'FAILED');
  const agentComplete =
    !agentRun ||
    (agentRun.status === 'completed' &&
      agentRun.failedCount === 0 &&
      (agentRun.persistenceFailures ?? 0) === 0);
  suiteStatus = workflowComplete && agentComplete ? 'completed' : 'incomplete';
}

const scored = scoreEvalRun({
  outcomes,
  safetyOutcomes: outcomes.filter((outcome) => outcome.safetySet),
  agentOutcomes,
  thresholds,
  suiteStatus,
  datasetHash,
});
const completedAt = new Date();
const report = EvalReportSchema.parse({
  schemaVersion: 1,
  runId: `${suite}-${startedAt.toISOString().replaceAll(':', '-')}`,
  runType: suite === 'pr' ? 'pr' : 'release',
  startedAt: startedAt.toISOString(),
  completedAt: completedAt.toISOString(),
  gitSha: sourceRevision,
  gitDirty,
  datasetId: evalDataset.datasetId,
  datasetHash,
  promptVersion: INTERPRETATION_PROMPT_VERSION,
  runnerVersion: '0.1.0',
  provider,
  model,
  thresholds,
  suiteStatus,
  studioExperiments,
  caseCount: cases.length,
  outcomes,
  metrics: {
    decision: calculateMetrics(outcomes),
    agent: agentMetricSummary,
    studioDatasetIds,
  },
  gates: scored.gates,
  verdict: scored.verdict,
});

const reportDirectory = resolve(process.env.EVAL_REPORT_DIR ?? 'evals/reports');
const outputBase = join(reportDirectory, report.runId);
await mkdir(dirname(outputBase), { recursive: true });
const formattedReport = await prettier.format(`${JSON.stringify(report, null, 2)}\n`, {
  parser: 'json',
});
await writeFile(`${outputBase}.json`, formattedReport, 'utf8');
await writeFile(`${outputBase}.md`, renderMarkdown(report), 'utf8');
console.log(
  JSON.stringify(
    {
      runId: report.runId,
      suiteStatus: report.suiteStatus,
      verdict: report.verdict,
      caseCount: report.caseCount,
      completedOutcomes: report.outcomes.length,
      studioExperiments: report.studioExperiments,
      jsonReport: `${outputBase}.json`,
      markdownReport: `${outputBase}.md`,
    },
    null,
    2,
  ),
);

if (report.verdict !== 'pass') process.exitCode = 1;

function parseSuite(args: string[]): 'pr' | 'full' {
  const suiteIndex = args.indexOf('--suite');
  const selected = suiteIndex >= 0 ? args[suiteIndex + 1] : 'pr';
  if (selected !== 'pr' && selected !== 'full') throw new Error('Use --suite pr or --suite full.');
  return selected;
}

function providerName(baseURL: string | undefined, apiKey: string | undefined) {
  if (!apiKey) return 'unconfigured';
  if (baseURL?.includes('openrouter.ai')) return 'openrouter';
  if (baseURL) return 'compatible-api';
  return 'openai';
}

function gitOutput(args: string[], fallback: string) {
  try {
    return execFileSync('git', args, { encoding: 'utf8' }).trim();
  } catch {
    return fallback;
  }
}

function mean(values: number[] | undefined): number | null {
  return values?.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null;
}

function failedOutcome(
  caseId: string,
  category: EvalOutcome['category'],
  safetySet: boolean,
  expected: (typeof cases)[number]['expected'],
  errorCode?: string,
): EvalOutcome {
  return EvalOutcomeSchema.parse({
    caseId,
    category,
    safetySet,
    expectedRoute: expected.route,
    actualRoute: null,
    expectedStatus: expected.status,
    actualStatus: 'FAILED',
    expectedFacts: expected.facts,
    actualFacts: [],
    expectedAmbiguous: expected.ambiguous,
    actualAmbiguous: false,
    expectedPricingHandoffs: expected.pricingHandoffs,
    actualPricingHandoffs: 0,
    expectedFlags: expected.flaggedRules,
    actualFlags: [],
    errorCode: errorCode ?? 'EXPERIMENT_TARGET_FAILED',
  });
}

function renderMarkdown(value: typeof report) {
  const metrics = value.metrics.decision as ReturnType<typeof calculateMetrics>;
  const gateRows = value.gates.map(
    (gate) => `| ${gate.passed ? 'PASS' : 'FAIL'} | ${gate.id} | ${gate.detail} |`,
  );
  const outcomeRows = value.outcomes.map(
    (outcome) =>
      `| ${outcome.caseId} | ${outcome.expectedRoute ?? '—'} / ${outcome.expectedStatus} | ${outcome.actualRoute ?? '—'} / ${outcome.actualStatus} | ${outcome.errorCode ?? '—'} |`,
  );
  return [
    `# Tender readiness ${value.runType} eval`,
    '',
    `- Verdict: **${value.verdict.toUpperCase()}** (${value.suiteStatus})`,
    `- Run: \`${value.runId}\``,
    `- Source revision: \`${value.gitSha}\`${value.gitDirty ? ' (working tree has local changes)' : ''}`,
    `- Dataset: \`${value.datasetId}\` (${value.caseCount} cases, SHA-256 \`${value.datasetHash}\`)`,
    `- Prompt: \`${value.promptVersion}\``,
    `- Provider/model: \`${value.provider}\` / \`${value.model}\``,
    `- Started: ${value.startedAt}`,
    '',
    '## Decision metrics',
    '',
    '| Route | Support | Predicted | Precision | Recall |',
    '| --- | ---: | ---: | ---: | ---: |',
    ...Object.entries(metrics.route).map(
      ([route, item]) =>
        `| ${route} | ${item.support} | ${item.predicted} | ${formatRatio(item.precision)} | ${formatRatio(item.recall)} |`,
    ),
    '',
    `- Golden unsafe-ready: ${metrics.unsafeReady.goldenSafetyCount}/${metrics.unsafeReady.goldenSafetyDenominator}`,
    `- Human-review recall: ${formatRatio(metrics.humanReviewRecall.value)} (${metrics.humanReviewRecall.correctlyEscalated}/${metrics.humanReviewRecall.denominator})`,
    `- Critical fact precision/recall: ${formatRatio(metrics.criticalFacts.precision)} / ${formatRatio(metrics.criticalFacts.recall)} (${metrics.criticalFacts.matched} matched; ${metrics.criticalFacts.predicted} predicted; ${metrics.criticalFacts.expected} expected)`,
    `- Ambiguity recall: ${formatRatio(metrics.ambiguity.recall)} (${metrics.ambiguity.correctlyFlagged}/${metrics.ambiguity.denominator})`,
    `- Non-ready pricing calls: ${metrics.pricingGuard.nonReadyWithHandoff}`,
    '',
    '## Gates',
    '',
    '| Result | Gate | Evidence |',
    '| --- | --- | --- |',
    ...gateRows,
    '',
    '## Per-case outcomes',
    '',
    '| Case | Expected | Actual | Error |',
    '| --- | --- | --- | --- |',
    ...outcomeRows,
    '',
    '## Mastra Studio experiments',
    '',
    ...(value.studioExperiments.length
      ? value.studioExperiments.map(
          (experiment) =>
            `- ${experiment.targetType}: \`${experiment.experimentId}\` (${experiment.targetId})`,
        )
      : ['- No experiment was run.']),
    '',
    'This synthetic report is engineering evidence, not a claim of production safety or real tender policy.',
    '',
  ].join('\n');
}

function formatRatio(value: number | null) {
  return value === null ? 'n/a' : `${(value * 100).toFixed(1)}%`;
}
