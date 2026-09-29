import { readFile, readdir } from 'node:fs/promises';
import { basename, resolve, sep } from 'node:path';
import { z } from 'zod';
import { EvalReportSchema } from '../../../evals/metrics.js';

const AcceptedBaselineSchema = z.object({
  schemaVersion: z.literal(1),
  report: z.string().regex(/^reports\/[A-Za-z0-9._-]+\.json$/),
  datasetId: z.string().min(1),
  datasetHash: z.string().regex(/^[a-f0-9]{64}$/),
  promptVersion: z.string().min(1),
  provider: z.string().min(1),
  model: z.string().min(1),
  acceptedFor: z.string().min(1),
});
const RouteMetricSchema = z.object({
  support: z.number().int().nonnegative().optional(),
  precision: z.number().min(0).max(1).nullable().optional(),
  recall: z.number().min(0).max(1).nullable().optional(),
});
const RouteMetricsSchema = z.record(z.string(), RouteMetricSchema);

export async function readEvalOverview(evalsDirectory = resolve('evals')) {
  const reportDirectory = resolve(evalsDirectory, 'reports');
  const accepted = AcceptedBaselineSchema.parse(
    JSON.parse(
      await readFile(resolve(evalsDirectory, 'accepted-baseline.json'), 'utf8'),
    ) as unknown,
  );
  const acceptedPath = resolve(evalsDirectory, accepted.report);
  if (!acceptedPath.startsWith(`${resolve(evalsDirectory)}${sep}`)) {
    throw new Error('Accepted eval report path is outside the eval directory.');
  }
  const acceptedReport = EvalReportSchema.parse(
    JSON.parse(await readFile(acceptedPath, 'utf8')) as unknown,
  );
  validateAcceptedPointer(accepted, acceptedReport);

  const filenames = (await readdir(reportDirectory)).filter((file) => /^full-.*\.json$/.test(file));
  const reports = await Promise.all(
    filenames.map(async (file) => {
      const report = EvalReportSchema.parse(
        JSON.parse(await readFile(resolve(reportDirectory, basename(file)), 'utf8')) as unknown,
      );
      return { file, report };
    }),
  );
  const latest = reports
    .filter(({ report }) => report.runType === 'release' && report.suiteStatus === 'completed')
    .sort((left, right) => right.report.startedAt.localeCompare(left.report.startedAt))[0];

  return {
    accepted: summarize(accepted.report, acceptedReport),
    latest: latest
      ? {
          ...summarize(`reports/${latest.file}`, latest.report),
          baselineComparison: compareWithAcceptedBaseline(latest.report, acceptedReport),
        }
      : null,
    studioBaseUrl: getStudioBaseUrl(),
  };
}

export async function readEvalReport(runId: string, evalsDirectory = resolve('evals')) {
  if (!/^[A-Za-z0-9._-]{1,128}$/.test(runId)) return undefined;
  const reportDirectory = resolve(evalsDirectory, 'reports');
  const filenames = (await readdir(reportDirectory)).filter((file) => /^full-.*\.json$/.test(file));
  for (const file of filenames) {
    const report = EvalReportSchema.parse(
      JSON.parse(await readFile(resolve(reportDirectory, basename(file)), 'utf8')) as unknown,
    );
    if (report.runId === runId) return report;
  }
  return undefined;
}

function validateAcceptedPointer(
  pointer: z.infer<typeof AcceptedBaselineSchema>,
  report: z.infer<typeof EvalReportSchema>,
): void {
  const reportIdFromPath = basename(pointer.report, '.json');
  if (
    report.runId !== reportIdFromPath ||
    report.datasetId !== pointer.datasetId ||
    report.datasetHash !== pointer.datasetHash ||
    report.promptVersion !== pointer.promptVersion ||
    report.provider !== pointer.provider ||
    report.model !== pointer.model
  ) {
    throw new Error('Accepted baseline pointer does not match its report metadata.');
  }
}

function compareWithAcceptedBaseline(
  report: z.infer<typeof EvalReportSchema>,
  accepted: z.infer<typeof EvalReportSchema>,
) {
  if (report.runId === accepted.runId) {
    return {
      status: 'compared' as const,
      baselineRunId: accepted.runId,
      baselineDatasetHash: accepted.datasetHash,
      detail: 'This report is the currently accepted baseline.',
    };
  }

  const comparison = report.baselineComparison;
  if (
    report.datasetHash !== accepted.datasetHash ||
    comparison?.status !== 'compared' ||
    comparison.baselineRunId !== accepted.runId ||
    comparison.baselineDatasetHash !== accepted.datasetHash
  ) {
    return {
      status: 'not_comparable' as const,
      baselineRunId: accepted.runId,
      baselineDatasetHash: accepted.datasetHash,
      detail:
        'This report was not compared with the current accepted baseline on the same dataset.',
    };
  }
  return comparison;
}

function summarize(reportPath: string, report: z.infer<typeof EvalReportSchema>) {
  const metrics = record(report.metrics);
  const decision = record(metrics.decision);
  const facts = record(decision.criticalFacts);
  const unsafe = record(decision.unsafeReady);
  const review = record(decision.humanReviewRecall);
  const routes = RouteMetricsSchema.parse(record(decision.route));
  return {
    runId: report.runId,
    reportPath,
    startedAt: report.startedAt,
    completedAt: report.completedAt,
    verdict: report.verdict,
    suiteStatus: report.suiteStatus,
    caseCount: report.caseCount,
    datasetId: report.datasetId,
    datasetHash: report.datasetHash,
    gitSha: report.gitSha,
    promptVersion: report.promptVersion,
    provider: report.provider,
    model: report.model,
    baselineComparison: report.baselineComparison,
    metrics: {
      routes,
      unsafeReady: { count: number(unsafe.count), denominator: number(unsafe.denominator) },
      humanReviewRecall: {
        correctlyEscalated: number(review.correctlyEscalated),
        denominator: number(review.denominator),
        value: number(review.value),
      },
      criticalFacts: {
        matched: number(facts.matched),
        predicted: number(facts.predicted),
        expected: number(facts.expected),
        precision: number(facts.precision),
        recall: number(facts.recall),
      },
      gates: report.gates,
    },
    studioExperiments: report.studioExperiments,
  };
}

function record(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {};
}

function number(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function getStudioBaseUrl(): string {
  const candidate = process.env.MASTRA_STUDIO_URL ?? 'http://localhost:4113';
  try {
    const url = new URL(candidate);
    return url.protocol === 'http:' || url.protocol === 'https:'
      ? url.origin
      : 'http://localhost:4113';
  } catch {
    return 'http://localhost:4113';
  }
}
