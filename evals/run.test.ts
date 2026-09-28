import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { EvalReportSchema } from './metrics.js';
import { selectEvalCases } from './mastra-datasets.js';

describe('eval runner interruption reporting', () => {
  it('writes an incomplete report for a partial provider configuration', () => {
    const temporaryRoot = realpathSync(tmpdir());
    const reportDirectory = mkdtempSync(join(temporaryRoot, 'tem-eval-config-'));
    try {
      const result = spawnSync(
        process.execPath,
        ['--import', 'tsx', 'evals/run.ts', '--suite', 'pr'],
        {
          cwd: process.cwd(),
          env: {
            ...process.env,
            MODEL_API_KEY: '',
            MODEL_API_BASE_URL: '',
            MODEL_ID: 'synthetic-model-only',
            OPENROUTER_API_KEY: '',
            OPENAI_API_KEY: '',
            EVAL_REPORT_DIR: reportDirectory,
          },
          encoding: 'utf8',
          timeout: 30_000,
        },
      );
      expect(result.error).toBeUndefined();
      expect(result.status).toBe(1);
      const reportFile = readdirSync(reportDirectory).find((name) => name.endsWith('.json'));
      expect(reportFile).toBeDefined();
      const report = EvalReportSchema.parse(
        JSON.parse(readFileSync(join(reportDirectory, reportFile!), 'utf8')) as unknown,
      );
      expect(report.suiteStatus).toBe('incomplete');
      expect(report.runError?.stage).toBe('provider-configuration');
    } finally {
      if (dirname(reportDirectory) === temporaryRoot) {
        rmSync(reportDirectory, { recursive: true, force: true });
      }
    }
  }, 15_000);

  it('writes an incomplete report when Studio storage cannot initialize', () => {
    const temporaryRoot = realpathSync(tmpdir());
    const reportDirectory = mkdtempSync(join(temporaryRoot, 'tem-eval-failure-'));
    try {
      const result = spawnSync(
        process.execPath,
        ['--import', 'tsx', 'evals/run.ts', '--suite', 'pr'],
        {
          cwd: process.cwd(),
          env: {
            ...process.env,
            MODEL_API_KEY: 'synthetic-test-key',
            MODEL_API_BASE_URL: 'https://example.invalid',
            MODEL_ID: 'synthetic-test-model',
            MASTRA_DATA_DIR: resolve('package.json'),
            EVAL_REPORT_DIR: reportDirectory,
          },
          encoding: 'utf8',
          timeout: 30_000,
        },
      );
      expect(result.error).toBeUndefined();
      expect(result.status).toBe(1);
      const reportFile = readdirSync(reportDirectory).find((name) => name.endsWith('.json'));
      expect(reportFile).toBeDefined();
      const report = EvalReportSchema.parse(
        JSON.parse(readFileSync(join(reportDirectory, reportFile!), 'utf8')) as unknown,
      );
      expect(report.suiteStatus).toBe('incomplete');
      expect(report.verdict).toBe('incomplete');
      expect(report.runError).toMatchObject({
        code: 'EVAL_RUN_INTERRUPTED',
        stage: 'mastra-import',
      });
      expect(report.outcomes).toHaveLength(selectEvalCases('pr').length);
      expect(report.outcomes.every((outcome) => outcome.actualStatus === 'FAILED')).toBe(true);
    } finally {
      if (dirname(reportDirectory) === temporaryRoot) {
        rmSync(reportDirectory, { recursive: true, force: true });
      }
    }
  }, 15_000);
});
