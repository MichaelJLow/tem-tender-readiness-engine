import { readFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { isAbsolute, relative, resolve } from 'node:path';
import process from 'node:process';
import { pathToFileURL } from 'node:url';
import { z } from 'zod';
import { EvalReportSchema, type EvalReport } from './metrics.js';

const sha = z.string().regex(/^[a-f0-9]{40}$/, 'must be a full lowercase Git SHA');
const pointerPath = z.string().min(1);

export const PrEvidenceSchema = z.object({
  schemaVersion: z.literal(1),
  report: pointerPath,
});

export const ManualQaSchema = z.object({
  schemaVersion: z.literal(1),
  sourceSha: sha,
  completedAt: z.string().datetime(),
  reviewer: z.string().trim().min(1),
  ciUrl: z.string().url(),
  pullRequestUrl: z.string().url(),
  checklist: z
    .record(z.string(), z.literal(true))
    .refine((items) => Object.keys(items).length > 0, {
      message: 'at least one completed QA item is required',
    }),
  notes: z.string().trim().min(1),
});

export const ReleaseEvidenceSchema = z.object({
  schemaVersion: z.literal(1),
  report: pointerPath,
  manualQa: pointerPath,
});

export function verifyReport(report: EvalReport, kind: 'pr' | 'release'): void {
  if (report.suiteStatus !== 'completed' || report.verdict !== 'pass') {
    throw new Error('Eval evidence must be a completed passing run.');
  }
  if (report.caseCount === 0 || report.outcomes.length !== report.caseCount) {
    throw new Error('Eval evidence must contain every reported case outcome.');
  }
  if (report.gates.length === 0 || report.gates.some((gate) => !gate.passed)) {
    throw new Error('Every recorded eval gate must pass.');
  }
  if (report.gitDirty) throw new Error('Eval evidence must be produced from a clean checkout.');
  sha.parse(report.gitSha);
  if (report.provider === 'unconfigured' || report.model === 'unconfigured') {
    throw new Error('Eval evidence must identify its provider and model.');
  }
  if (!report.datasetId || !report.datasetHash || !report.promptVersion) {
    throw new Error('Eval evidence must retain dataset and prompt configuration.');
  }
  if (kind === 'pr' && report.runType !== 'pr')
    throw new Error('PR evidence must use the PR suite.');
  if (kind === 'release') {
    if (report.runType !== 'release') throw new Error('Release evidence must use the full suite.');
    if (report.baselineComparison?.status !== 'compared') {
      throw new Error('Release evidence must be comparable with the accepted baseline.');
    }
  }
}

function verifySourceRevision(report: EvalReport, kind: 'pr' | 'release', root: string): void {
  const paths =
    kind === 'pr'
      ? [
          'apps/api/src/reasoning',
          'apps/api/src/mastra',
          'evals/cases.ts',
          'evals/mastra-scorers.ts',
          'evals/thresholds.json',
        ]
      : [
          'apps',
          'packages',
          'evals',
          ':(exclude)evals/reports',
          ':(exclude)evals/pr-evidence.json',
          ':(exclude)evals/release-evidence.json',
          'package.json',
          'package-lock.json',
          'tsconfig.json',
          'tsconfig.api.json',
        ];
  const ancestor = spawnSync('git', ['merge-base', '--is-ancestor', report.gitSha, 'HEAD'], {
    cwd: root,
  });
  if (ancestor.status !== 0) throw new Error('Evidence source SHA is not an ancestor of HEAD.');
  const changed = spawnSync('git', ['diff', '--quiet', report.gitSha, 'HEAD', '--', ...paths], {
    cwd: root,
  });
  if (changed.status !== 0) {
    throw new Error(`Relevant ${kind} sources changed after the evidence was produced.`);
  }
}

async function readRepositoryJson(path: string, root: string): Promise<unknown> {
  const absolute = resolve(root, path);
  const rel = relative(root, absolute);
  if (isAbsolute(path) || rel.startsWith('..') || isAbsolute(rel)) {
    throw new Error(`Evidence path escapes the repository: ${path}`);
  }
  return JSON.parse(await readFile(absolute, 'utf8')) as unknown;
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const kind = args[args.indexOf('--kind') + 1];
  const pointer = args[args.indexOf('--pointer') + 1];
  if ((kind !== 'pr' && kind !== 'release') || !pointer) {
    throw new Error('Usage: --kind pr|release --pointer <repository-relative JSON path>');
  }
  const root = process.cwd();
  const rawPointer = await readRepositoryJson(pointer, root);
  const parsedPointer =
    kind === 'pr' ? PrEvidenceSchema.parse(rawPointer) : ReleaseEvidenceSchema.parse(rawPointer);
  const report = EvalReportSchema.parse(await readRepositoryJson(parsedPointer.report, root));
  verifyReport(report, kind);
  verifySourceRevision(report, kind, root);
  if (kind === 'release') {
    const releasePointer = ReleaseEvidenceSchema.parse(parsedPointer);
    const qa = ManualQaSchema.parse(await readRepositoryJson(releasePointer.manualQa, root));
    if (qa.sourceSha !== report.gitSha) {
      throw new Error('Manual QA and the full eval must reference the same source SHA.');
    }
  }
  console.log(`Verified ${kind} evidence for ${report.gitSha}.`);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
