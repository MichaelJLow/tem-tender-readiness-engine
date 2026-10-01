import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { IntakeRequestSchema } from '../../apps/api/src/contracts.js';

type JsonRecord = Record<string, unknown>;

interface WorkflowNode {
  name: string;
  type: string;
  credentials?: unknown;
  parameters: JsonRecord;
}

interface WorkflowExport {
  name: string;
  active: boolean;
  nodes: WorkflowNode[];
  connections: JsonRecord;
}

const root = new URL('.', import.meta.url);
const workflow = readJson<WorkflowExport>('tender-intake.workflow.json');
const clean = readJson<JsonRecord>('fixtures/clean.json');
const textBearing = readJson<JsonRecord>('fixtures/text-bearing.json');

function readJson<T>(relativePath: string): T {
  return JSON.parse(readFileSync(new URL(relativePath, root), 'utf8')) as T;
}

function node(name: string): WorkflowNode {
  const result = workflow.nodes.find((candidate) => candidate.name === name);
  if (!result) throw new Error(`Workflow node not found: ${name}`);
  return result;
}

async function normalize(body: unknown, headers: JsonRecord = {}): Promise<JsonRecord> {
  const code = node('Normalize Transport').parameters.jsCode;
  if (typeof code !== 'string') throw new Error('Normalization code is missing.');
  const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor as new (
    ...args: string[]
  ) => (...values: unknown[]) => Promise<Array<{ json: JsonRecord }>>;
  const execute = new AsyncFunction('$input', code);
  const result = await execute({ first: () => ({ json: { body, headers } }) });
  return result[0]!.json;
}

async function prepareApiResponse(
  response: JsonRecord,
  correlationId: string,
): Promise<JsonRecord> {
  const code = node('Prepare API Response').parameters.jsCode;
  if (typeof code !== 'string') throw new Error('API response code is missing.');
  const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor as new (
    ...args: string[]
  ) => (...values: unknown[]) => Promise<Array<{ json: JsonRecord }>>;
  const execute = new AsyncFunction('$input', '$', code);
  const result = await execute({ first: () => ({ json: response }) }, () => ({
    item: { json: { correlationId } },
  }));
  return result[0]!.json;
}

describe('n8n tender intake export', () => {
  it('is an inactive, credential-free transport workflow with no copied rules or prompts', () => {
    expect(workflow.name).toBe('Tender intake and transport normalization');
    expect(workflow.active).toBe(false);
    expect(workflow.nodes.every((candidate) => candidate.credentials === undefined)).toBe(true);

    const exportText = JSON.stringify(workflow);
    expect(exportText).not.toContain('TDR-');
    expect(exportText).not.toContain('READY_FOR_PRICING');
    expect(exportText).not.toContain('systemPrompt');
    expect(exportText).not.toMatch(/api[_-]?key/i);
  });

  it('forwards only the existing API request with the correlation header', () => {
    const submit = node('Submit to Tender API');
    expect(submit.parameters.url).toContain('TENDER_API_URL');
    expect(submit.parameters.url).toContain('/tenders');
    expect(submit.parameters.body).toContain('Normalize Transport');
    expect(JSON.stringify(submit.parameters.headerParameters)).toContain('X-Correlation-ID');
    expect(JSON.stringify(submit.parameters.options)).toContain('neverError');
  });

  it('keeps the exported webhook inactive until an operator imports and activates it', () => {
    expect(node('Tender Intake Webhook').parameters).toMatchObject({
      httpMethod: 'POST',
      path: 'tender-intake',
      responseMode: 'responseNode',
    });
  });

  it('preserves API validation status and response details', async () => {
    const apiError = {
      error: 'INVALID_TENDER',
      correlationId: 'n8n-invalid-001',
      issues: [{ path: 'tender.customer', message: 'Invalid input' }],
    };
    await expect(
      prepareApiResponse({ statusCode: 400, body: apiError }, 'n8n-invalid-001'),
    ).resolves.toEqual({ statusCode: 400, body: apiError });
  });

  it('turns an unreachable API into a visible correlated gateway failure', async () => {
    await expect(
      prepareApiResponse({ message: 'Connection refused' }, 'n8n-api-down-001'),
    ).resolves.toEqual({
      statusCode: 502,
      body: {
        error: 'TENDER_API_UNAVAILABLE',
        correlationId: 'n8n-api-down-001',
        detail: 'Connection refused',
      },
    });
  });
});

describe('n8n transport fixtures and normalization', () => {
  it('normalizes the clean fixture without changing its API request', async () => {
    expect(IntakeRequestSchema.parse(clean.request)).toEqual(clean.request);
    await expect(normalize(clean)).resolves.toMatchObject({
      ok: true,
      correlationId: 'n8n-clean-001',
      tenderId: 'tender-n8n-clean-001',
      idempotencyKey: 'intake-n8n-clean-001',
      request: clean.request,
    });
  });

  it('accepts correlation from the webhook header without changing identifiers', async () => {
    const body = { request: clean.request };
    await expect(normalize(body, { 'x-correlation-id': 'n8n-header-001' })).resolves.toMatchObject({
      ok: true,
      correlationId: 'n8n-header-001',
      tenderId: 'tender-n8n-clean-001',
      idempotencyKey: 'intake-n8n-clean-001',
    });
  });

  it('keeps NOTE and DOCUMENT_TEXT input with a valid document reference', async () => {
    expect(IntakeRequestSchema.parse(textBearing.request)).toEqual(textBearing.request);
    const request = textBearing.request as JsonRecord;
    const textSources = request.textSources as JsonRecord[];
    expect(textSources.map((source) => source.kind)).toEqual(['NOTE', 'DOCUMENT_TEXT']);
    expect(textSources[1]?.documentId).toBe('document-n8n-001');
    await expect(normalize(textBearing)).resolves.toMatchObject({ ok: true, request });
  });

  it.each([
    ['correlation ID', { request: clean.request }, 'correlationId'],
    [
      'tender ID',
      {
        correlationId: 'missing-tender-id',
        request: { ...(clean.request as JsonRecord), tender: { idempotencyKey: 'key-001' } },
      },
      'request.tender.tenderId',
    ],
    [
      'idempotency key',
      {
        correlationId: 'missing-idempotency-key',
        request: { ...(clean.request as JsonRecord), tender: { tenderId: 'tender-001' } },
      },
      'request.tender.idempotencyKey',
    ],
  ])('rejects a missing %s visibly', async (_label, body, expectedIssue) => {
    const result = await normalize(body);
    expect(result).toMatchObject({
      ok: false,
      statusCode: 400,
      body: { error: 'TRANSPORT_VALIDATION_FAILED' },
    });
    expect(JSON.stringify(result)).toContain(expectedIssue);
  });

  it('rejects a webhook body larger than 1 MiB', async () => {
    const oversized = {
      ...clean,
      padding: 'x'.repeat(1_048_576),
    };
    const result = await normalize(oversized);
    expect(result).toMatchObject({
      ok: false,
      statusCode: 400,
      body: { error: 'TRANSPORT_VALIDATION_FAILED' },
    });
    expect(JSON.stringify(result)).toContain('1 MiB');
  });

  it('leaves detailed contract validation to the API schema', async () => {
    const invalidRequest = {
      tender: { tenderId: 'tender-invalid', idempotencyKey: 'invalid-001' },
    };
    await expect(
      normalize({ correlationId: 'n8n-invalid-001', request: invalidRequest }),
    ).resolves.toMatchObject({ ok: true, request: invalidRequest });
    expect(IntakeRequestSchema.safeParse(invalidRequest).success).toBe(false);
  });
});
