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

async function recordIntegrationOutcome(
  prepared: JsonRecord,
  normalized: JsonRecord = {
    correlationId: 'n8n-outcome-001',
    tenderId: 'tender-outcome-001',
  },
): Promise<JsonRecord> {
  const code = node('Record Integration Outcome').parameters.jsCode;
  if (typeof code !== 'string') throw new Error('Integration outcome code is missing.');
  const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor as new (
    ...args: string[]
  ) => (...values: unknown[]) => Promise<Array<{ json: JsonRecord }>>;
  const execute = new AsyncFunction('$input', '$', code);
  const result = await execute({ first: () => ({ json: prepared }) }, () => ({
    item: { json: normalized },
  }));
  return result[0]!.json;
}

describe('n8n tender intake export', () => {
  it('is an inactive, credential-free transport workflow with no copied rules or prompts', () => {
    expect(workflow.name).toBe('Tender intake and outcome handling');
    expect(workflow.active).toBe(false);
    expect(workflow.nodes.every((candidate) => candidate.credentials === undefined)).toBe(true);

    const exportText = JSON.stringify(workflow);
    expect(exportText).not.toContain('TDR-');
    expect(exportText).not.toContain('systemPrompt');
    expect(exportText).not.toMatch(/api[_-]?key/i);
    expect(
      workflow.nodes.filter((candidate) => candidate.type === 'n8n-nodes-base.httpRequest'),
    ).toHaveLength(1);
    expect(workflow.nodes.map((candidate) => candidate.type).join(' ')).not.toMatch(
      /email|smtp|sendgrid|slack/i,
    );
  });

  it('forwards only the existing API request with the correlation header', () => {
    const submit = node('Submit to Tender API');
    expect(submit.parameters.url).toContain('TENDER_API_URL');
    expect(submit.parameters.url).toContain('/tenders');
    expect(submit.parameters.body).toContain('Normalize Transport');
    expect(JSON.stringify(submit.parameters.headerParameters)).toContain('X-Correlation-ID');
    expect(JSON.stringify(submit.parameters.options)).toContain('neverError');
    expect(submit.parameters).not.toHaveProperty('retryOnFail');
    expect(submit.parameters).not.toHaveProperty('maxTries');
    expect(submit.parameters).not.toHaveProperty('waitBetweenTries');
    expect(JSON.stringify(workflow)).not.toContain('/reviews');
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

  it.each([
    ['COMPLETED', 'READY_FOR_PRICING', 'PRICING_HANDOFF_RECORDED'],
    ['COMPLETED', 'NEEDS_INFORMATION', 'INFORMATION_REQUEST_RECORDED'],
    ['COMPLETED', 'HUMAN_REVIEW', 'HUMAN_REVIEW_AVAILABLE'],
    ['COMPLETED', 'DUPLICATE', 'DUPLICATE_RECORDED'],
  ])('records the %s + %s outcome as %s', async (status, route, type) => {
    const runId = '2d95a5a5-ad08-4117-b953-a1397a75fbb9';
    const result = await recordIntegrationOutcome({
      statusCode: 200,
      body: {
        tenderId: 'tender-outcome-001',
        runId,
        correlationId: 'n8n-outcome-001',
        status,
        route,
        rules: [],
        replayed: false,
      },
    });

    expect(result).toMatchObject({
      statusCode: 200,
      body: {
        integrationOutcome: {
          type,
          runId,
          tenderId: 'tender-outcome-001',
          outboundMessagesSent: 0,
        },
      },
    });
  });

  it('observes the API-owned pricing handoff without initiating a second handoff', async () => {
    const result = await recordIntegrationOutcome({
      statusCode: 200,
      body: {
        tenderId: 'tender-clean-001',
        runId: '1ad2fa84-b10f-497b-9076-94db56c242eb',
        status: 'COMPLETED',
        route: 'READY_FOR_PRICING',
      },
    });

    expect(result.body).toMatchObject({
      integrationOutcome: {
        pricingOwner: 'TENDER_API',
        handoffStatus: 'SUCCEEDED',
        handoffAttemptsInitiatedByWorkflow: 0,
      },
    });
  });

  it('creates a stable synthetic information-request receipt and sends no message', async () => {
    const prepared = {
      statusCode: 200,
      body: {
        tenderId: 'tender-missing-001',
        runId: 'd6acbd9c-8617-401e-b867-2462d5a421aa',
        status: 'COMPLETED',
        route: 'NEEDS_INFORMATION',
      },
    };
    const first = await recordIntegrationOutcome(prepared);
    const redelivery = await recordIntegrationOutcome({
      ...prepared,
      body: { ...prepared.body, replayed: true },
    });

    expect(first.body).toMatchObject({
      integrationOutcome: {
        key: 'information-request:d6acbd9c-8617-401e-b867-2462d5a421aa',
        synthetic: true,
        deliveryStatus: 'NOT_SENT',
        outboundMessagesSent: 0,
      },
    });
    expect(redelivery.body).toMatchObject({
      integrationOutcome: {
        key: 'information-request:d6acbd9c-8617-401e-b867-2462d5a421aa',
      },
    });
  });

  it('links the existing Console case without creating another review task', async () => {
    const runId = 'b1d46170-b187-4568-bbc8-5ae90954f3b2';
    const result = await recordIntegrationOutcome({
      statusCode: 200,
      body: { tenderId: 'tender-conflict-001', runId, status: 'COMPLETED', route: 'HUMAN_REVIEW' },
    });

    expect(result.body).toMatchObject({
      integrationOutcome: {
        consolePath: `/tenders/${runId}`,
        reviewTaskCreatedByWorkflow: false,
      },
    });
  });

  it('keeps pending document processing separate from a business route', async () => {
    const result = await recordIntegrationOutcome({
      statusCode: 202,
      body: {
        tenderId: 'tender-pending-001',
        runId: '98a164b4-c57e-421f-a3fd-73b300c8bd15',
        status: 'PROCESSING',
      },
    });

    expect(result).toMatchObject({
      statusCode: 202,
      body: { integrationOutcome: { type: 'PENDING', outboundMessagesSent: 0 } },
    });
  });

  it.each([
    [502, 'FAILED', 'READY_FOR_PRICING', { code: 'PRICING_GATEWAY_FAILED' }],
    [502, 'FAILED', undefined, { code: 'MODEL_PROVIDER_FAILED' }],
    [502, undefined, undefined, undefined],
    [400, undefined, undefined, undefined],
  ])(
    'takes the technical error path for HTTP %i with status %s and route %s',
    async (statusCode, status, route, failure) => {
      const result = await recordIntegrationOutcome({
        statusCode,
        body: {
          error:
            statusCode === 400
              ? 'INVALID_TENDER'
              : status === undefined
                ? 'TENDER_API_UNAVAILABLE'
                : undefined,
          tenderId: 'tender-error-001',
          runId: '264c625d-57bc-4b65-8502-a82dc9dfcb73',
          status,
          route,
          failure,
        },
      });

      expect(result).toMatchObject({
        statusCode,
        body: {
          integrationOutcome: {
            type: 'TECHNICAL_ERROR',
            businessRouteRetained: route ?? null,
            outboundMessagesSent: 0,
          },
        },
      });
    },
  );

  it('fails an unexpected successful response closed as a technical error', async () => {
    const result = await recordIntegrationOutcome({
      statusCode: 200,
      body: {
        correlationId: 'n8n-unexpected-001',
        tenderId: 'tender-unexpected-001',
        runId: '7707c75f-487d-475a-bb5a-08bfc7560be5',
        status: 'COMPLETED',
        route: 'UNKNOWN',
      },
    });

    expect(result).toMatchObject({
      statusCode: 502,
      body: {
        integrationOutcome: {
          type: 'TECHNICAL_ERROR',
          failure: 'UNEXPECTED_TENDER_RESPONSE',
        },
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
