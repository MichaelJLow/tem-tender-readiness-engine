import { readFileSync } from 'node:fs';
import { access, mkdtemp, rm } from 'node:fs/promises';
import type { Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { LocalState, PricingHandoff, TenderResponse } from '../apps/api/src/contracts.js';
import type { TenderInterpretation } from '../apps/api/src/reasoning/contracts.js';
import { FileStateStore, JsonFileTenderRepository } from '../apps/api/src/file-repository.js';
import { MockPricingGateway, type PricingGateway } from '../apps/api/src/pricing-gateway.js';
import {
  InterpretationError,
  type TenderInterpreter,
} from '../apps/api/src/reasoning/interpreter.js';
import { createTenderServer } from '../apps/api/src/server.js';
import { TenderService } from '../apps/api/src/service.js';
import {
  cleanTender,
  conflictingDatesTender,
  missingConsumptionTender,
} from './fixtures/tenders.js';
import { localSnapshotReader, prepareSnapshot, restoreSnapshot } from '../scripts/demo-archive.js';

type JsonRecord = Record<string, unknown>;

const cleanWebhook = readJson<JsonRecord>('../integrations/n8n/fixtures/clean.json');
const workflow = readJson<{ nodes: Array<{ name: string; parameters: JsonRecord }> }>(
  '../integrations/n8n/tender-intake.workflow.json',
);
const evalsDirectory = resolve('evals');

const note = {
  sourceId: 'rehearsal-note-001',
  kind: 'NOTE' as const,
  text: 'The contract for site-001 ends on 2027-03-31.',
};

const interpretation: TenderInterpretation = {
  summary: 'The note restates the structured contract end date.',
  sourceAssessments: [
    {
      sourceId: note.sourceId,
      relevance: 'RELEVANT',
      confidence: 0.99,
      ambiguous: false,
      explanation: 'The contract end date is clear.',
      evidence: [{ sourceId: note.sourceId, quote: 'site-001 ends on 2027-03-31' }],
    },
  ],
  observations: [
    {
      field: 'contractEndDate',
      value: '2027-03-31',
      siteIds: ['site-001'],
      confidence: 0.99,
      ambiguous: false,
      evidence: [{ sourceId: note.sourceId, quote: 'site-001 ends on 2027-03-31' }],
    },
  ],
  siteAssociations: [],
  conflicts: [],
};

let directory: string;
let statePath: string;
const servers: Server[] = [];

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'eng-12-rehearsal-'));
  statePath = join(directory, 'tender-state.json');
});

afterEach(async () => {
  await Promise.all(
    servers.splice(0).map(
      (server) =>
        new Promise<void>((resolveClose, reject) => {
          server.close((error) => (error ? reject(error) : resolveClose()));
        }),
    ),
  );
  await rm(directory, { recursive: true, force: true });
});

describe('ENG-12 visible failure and safe recovery rehearsal', () => {
  it('recovers a retryable provider timeout on the same identity without a handoff during the outage', async () => {
    const interpreter = new FakeInterpreter();
    interpreter.failure = providerTimeout();
    let releaseBackoff!: () => void;
    const held = new Promise<void>((resolveHold) => {
      releaseBackoff = resolveHold;
    });
    let failedAttemptReady!: () => void;
    const failedAttempt = new Promise<void>((resolveReady) => {
      failedAttemptReady = resolveReady;
    });
    const repository = createRepository();
    const service = new TenderService(
      repository,
      new MockPricingGateway(repository),
      undefined,
      interpreter,
      {
        maxAttempts: 3,
        backoffMs: [1],
        sleep: async () => {
          failedAttemptReady();
          await held;
        },
      },
    );
    const request = { ...cleanTender, textSources: [note] };
    const firstSubmit = service.submit(request, 'rehearsal-provider-timeout');
    await failedAttempt;
    const duringOutage = await readState();

    try {
      expect(duringOutage.runs[0]).toMatchObject({
        status: 'FAILED',
        failure: {
          code: 'MODEL_PROVIDER_FAILED',
          stage: 'INTERPRETATION',
          retryable: true,
          attempt: 1,
        },
      });
      expect(duringOutage.runs[0]?.route).toBeUndefined();
      expect(effectCounts(duringOutage)).toEqual({
        runs: 1,
        handoffs: 0,
        informationRequestReceipts: 0,
        reviewEvents: 0,
      });
      interpreter.failure = undefined;
    } finally {
      releaseBackoff();
    }
    const recovered = await firstSubmit;
    expect(recovered).toMatchObject({
      status: 'COMPLETED',
      route: 'READY_FOR_PRICING',
      replayed: false,
      runId: duringOutage.runs[0]?.runId,
    });
    expect(effectCounts(await readState())).toEqual({
      runs: 1,
      handoffs: 1,
      informationRequestReceipts: 0,
      reviewEvents: 0,
    });
    expect(interpreter.calls).toBe(2);
  });

  it('keeps malformed model output terminal and never creates a pricing handoff', async () => {
    const interpreter = new FakeInterpreter();
    interpreter.result = { ...interpretation, summary: '' } as unknown as TenderInterpretation;
    const repository = createRepository();
    const service = new TenderService(
      repository,
      new MockPricingGateway(repository),
      undefined,
      interpreter,
      { maxAttempts: 3, backoffMs: [], sleep: async () => undefined },
    );
    const request = { ...cleanTender, textSources: [note] };

    await expect(service.submit(request, 'rehearsal-invalid-output')).rejects.toMatchObject({
      httpStatus: 500,
      response: {
        status: 'FAILED',
        failure: { code: 'MODEL_OUTPUT_INVALID', stage: 'INTERPRETATION', retryable: false },
      },
    });
    const afterFailure = await readState();
    expect(afterFailure.runs[0]?.route).toBeUndefined();
    expect(effectCounts(afterFailure)).toEqual({
      runs: 1,
      handoffs: 0,
      informationRequestReceipts: 0,
      reviewEvents: 0,
    });

    const replay = await service.submit(request, 'rehearsal-invalid-output-replay');
    expect(replay).toMatchObject({
      status: 'FAILED',
      replayed: true,
      failure: { code: 'MODEL_OUTPUT_INVALID', retryable: false },
    });
    expect(replay.route).toBeUndefined();
    expect(effectCounts(await readState())).toEqual(effectCounts(afterFailure));
    expect(interpreter.calls).toBe(1);
  });

  it('fails closed on persistence read/write faults and recovers the same identity after storage is restored', async () => {
    const store = new ToggleFaultStore(new FileStateStore(statePath));
    const repository = new JsonFileTenderRepository(store);
    const service = new TenderService(
      repository,
      new MockPricingGateway(repository),
      undefined,
      undefined,
      {
        maxAttempts: 3,
        backoffMs: [],
        sleep: async () => undefined,
      },
    );

    store.failRead = true;
    await expect(service.submit(cleanTender, 'rehearsal-state-read')).rejects.toMatchObject({
      failure: { code: 'STATE_READ_FAILED', stage: 'STATE_READ', retryable: true },
    });
    store.failRead = false;
    expect(effectCounts(await readState())).toEqual({
      runs: 0,
      handoffs: 0,
      informationRequestReceipts: 0,
      reviewEvents: 0,
    });

    store.failWrite = true;
    await expect(service.submit(cleanTender, 'rehearsal-state-write')).rejects.toMatchObject({
      failure: { code: 'STATE_WRITE_FAILED', stage: 'STATE_WRITE', retryable: true },
    });
    store.failWrite = false;
    expect(effectCounts(await readState())).toEqual({
      runs: 0,
      handoffs: 0,
      informationRequestReceipts: 0,
      reviewEvents: 0,
    });

    const recovered = await service.submit(cleanTender, 'rehearsal-state-recover');
    expect(recovered).toMatchObject({
      status: 'COMPLETED',
      route: 'READY_FOR_PRICING',
      replayed: false,
    });
    expect(effectCounts(await readState())).toEqual({
      runs: 1,
      handoffs: 1,
      informationRequestReceipts: 0,
      reviewEvents: 0,
    });
  });

  it('shows a mocked downstream 500 through the API, then recovers once without a second handoff', async () => {
    const gateway = new ControllableGateway(createRepository());
    gateway.fail = true;
    let releaseBackoff!: () => void;
    const held = new Promise<void>((resolveHold) => {
      releaseBackoff = resolveHold;
    });
    let failedAttemptReady!: () => void;
    const failedAttempt = new Promise<void>((resolveReady) => {
      failedAttemptReady = resolveReady;
    });
    const service = new TenderService(createRepository(), gateway, undefined, undefined, {
      maxAttempts: 3,
      backoffMs: [1],
      sleep: async () => {
        failedAttemptReady();
        await held;
      },
    });
    const server = await listen(service);
    const url = baseUrl(server);
    const request = (cleanWebhook.request ?? cleanWebhook) as JsonRecord;

    const firstPost = fetch(`${url}/tenders`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-correlation-id': 'rehearsal-gateway-500',
      },
      body: JSON.stringify(request),
    });
    await failedAttempt;

    let failedRunId: string | undefined;
    try {
      const queueDuringFailure = (await (await fetch(`${url}/tenders`)).json()) as {
        items: Array<{
          runId: string;
          status: string;
          route: string | null;
          failure: { code: string; retryable: boolean; stage: string; attempt: number } | null;
        }>;
      };
      failedRunId = queueDuringFailure.items[0]!.runId;
      const detailDuringFailure = (await (await fetch(`${url}/tenders/${failedRunId}`)).json()) as {
        run: {
          runId: string;
          tenderId: string;
          status: string;
          route?: string;
          failure?: { code: string; stage: string; retryable: boolean; attempt: number };
        };
      };
      const duringFailure = await readState();
      const n8nFailure = await recordIntegrationOutcome({
        statusCode: 502,
        body: {
          tenderId: detailDuringFailure.run.tenderId,
          runId: detailDuringFailure.run.runId,
          status: 'FAILED',
          route: 'READY_FOR_PRICING',
          failure: detailDuringFailure.run.failure,
        },
      });

      expect(queueDuringFailure.items[0]).toMatchObject({
        status: 'FAILED',
        route: 'READY_FOR_PRICING',
        failure: { code: 'PRICING_GATEWAY_FAILED', retryable: true },
      });
      expect(detailDuringFailure.run).toMatchObject({
        status: 'FAILED',
        route: 'READY_FOR_PRICING',
        failure: { code: 'PRICING_GATEWAY_FAILED', stage: 'PRICING', retryable: true, attempt: 1 },
      });
      expect(n8nFailure.body).toMatchObject({
        integrationOutcome: {
          type: 'TECHNICAL_ERROR',
          businessRouteRetained: 'READY_FOR_PRICING',
          outboundMessagesSent: 0,
        },
      });
      expect(effectCounts(duringFailure)).toEqual({
        runs: 1,
        handoffs: 0,
        informationRequestReceipts: 0,
        reviewEvents: 0,
      });

      gateway.fail = false;
    } finally {
      releaseBackoff();
    }
    const firstResponse = await firstPost;
    const firstBody = (await firstResponse.json()) as TenderResponse;
    const afterRecovery = await readState();
    const queueAfterRecovery = (await (await fetch(`${url}/tenders`)).json()) as {
      items: Array<{ status: string; route: string | null; runId: string }>;
    };
    const n8nRecovery = await recordIntegrationOutcome({
      statusCode: 200,
      body: firstBody,
    });

    expect(firstResponse.status).toBe(200);
    expect(firstBody).toMatchObject({
      status: 'COMPLETED',
      route: 'READY_FOR_PRICING',
      replayed: false,
      runId: failedRunId,
    });
    expect(queueAfterRecovery.items[0]).toMatchObject({
      status: 'COMPLETED',
      route: 'READY_FOR_PRICING',
      runId: firstBody.runId,
    });
    expect(n8nRecovery.body).toMatchObject({
      integrationOutcome: {
        type: 'PRICING_HANDOFF_RECORDED',
        pricingOwner: 'TENDER_API',
        handoffAttemptsInitiatedByWorkflow: 0,
        outboundMessagesSent: 0,
      },
    });
    expect(effectCounts(afterRecovery)).toEqual({
      runs: 1,
      handoffs: 1,
      informationRequestReceipts: 0,
      reviewEvents: 0,
    });
    expect(gateway.calls).toBe(2);

    const replayResponse = await fetch(`${url}/tenders`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-correlation-id': 'rehearsal-gateway-500-replay',
      },
      body: JSON.stringify(request),
    });
    const replayBody = (await replayResponse.json()) as TenderResponse;
    expect(replayResponse.status).toBe(200);
    expect(replayBody).toMatchObject({
      status: 'COMPLETED',
      route: 'READY_FOR_PRICING',
      replayed: true,
      runId: firstBody.runId,
    });
    expect(effectCounts(await readState())).toEqual(effectCounts(afterRecovery));
    expect(afterRecovery.handoffs[0]?.handoffKey).toBe(
      `${firstBody.tenderId}:${String((request.tender as JsonRecord).idempotencyKey)}`,
    );
  });

  it('treats duplicate webhook delivery as a no-effect replay of the same n8n fixture', async () => {
    const repository = createRepository();
    const service = new TenderService(
      repository,
      new MockPricingGateway(repository),
      undefined,
      undefined,
      { maxAttempts: 3, backoffMs: [], sleep: async () => undefined },
    );
    const first = await deliverWebhook(service, cleanWebhook);
    const beforeReplay = await readState();
    const replay = await deliverWebhook(service, cleanWebhook);
    const afterReplay = await readState();

    expect(first.api).toMatchObject({
      status: 'COMPLETED',
      route: 'READY_FOR_PRICING',
      replayed: false,
    });
    expect(first.outcome).toMatchObject({
      type: 'PRICING_HANDOFF_RECORDED',
      outboundMessagesSent: 0,
      handoffAttemptsInitiatedByWorkflow: 0,
    });
    expect(replay.api).toMatchObject({
      replayed: true,
      runId: first.api.runId,
      route: 'READY_FOR_PRICING',
    });
    expect(replay.outcome).toMatchObject({
      type: 'PRICING_HANDOFF_RECORDED',
      key: first.outcome.key,
    });
    expect(effectCounts(beforeReplay)).toEqual({
      runs: 1,
      handoffs: 1,
      informationRequestReceipts: 0,
      reviewEvents: 0,
    });
    expect(effectCounts(afterReplay)).toEqual(effectCounts(beforeReplay));
  });

  it('keeps archive missing-object failure off the live decision path', async () => {
    const repository = createRepository();
    const service = new TenderService(repository, new MockPricingGateway(repository));
    await service.submit(cleanTender, 'archive-ready');
    await service.submit(missingConsumptionTender, 'archive-missing');
    const review = await service.submit(conflictingDatesTender, 'archive-conflict');
    await service.recordReviewEvent(
      {
        eventId: randomUUID(),
        runId: review.runId,
        actor: 'Synthetic rehearsal reviewer',
        createdAt: new Date().toISOString(),
        reviewVersion: 1,
        requestId: 'rehearsal-archive-review-001',
        action: 'REQUEST_INFORMATION',
        reason:
          'Please confirm the end date: site-001 and contract-a say 2027-03-31; contract-b says 30/09/2026.',
        sourceIds: ['site-001', 'contract-a', 'contract-b'],
      },
      0,
    );
    const liveBefore = await readState();
    const prepared = join(directory, 'prepared-archive');
    await prepareSnapshot({
      statePath,
      evalsDirectory,
      destination: prepared,
      apiStopped: true,
      synthetic: true,
    });

    const localReader = localSnapshotReader(prepared);
    const missingMemberReader = {
      async read(path: string, maximumBytes: number) {
        if (path === 'state/tender-state.json') throw new Error('Object not found.');
        return localReader.read(path, maximumBytes);
      },
    };
    const destination = join(directory, 'missing-object-restore');
    await expect(restoreSnapshot(missingMemberReader, destination)).rejects.toThrow(
      'Object not found.',
    );
    await expect(access(destination)).rejects.toThrow();
    expect(effectCounts(await readState())).toEqual(effectCounts(liveBefore));
    expect(liveBefore.handoffs).toHaveLength(1);
    expect(liveBefore.runs.map((run) => run.route)).toEqual([
      'READY_FOR_PRICING',
      'NEEDS_INFORMATION',
      'HUMAN_REVIEW',
    ]);
  });
});

function createRepository() {
  return new JsonFileTenderRepository(new FileStateStore(statePath));
}

async function readState(): Promise<LocalState> {
  return new FileStateStore(statePath).read();
}

function effectCounts(state: LocalState) {
  return {
    runs: state.runs.length,
    handoffs: state.handoffs.length,
    informationRequestReceipts: state.informationRequestReceipts?.length ?? 0,
    reviewEvents: state.reviewEvents.length,
  };
}

async function listen(service: TenderService): Promise<Server> {
  const server = createTenderServer(service);
  servers.push(server);
  await new Promise<void>((resolveListen) => server.listen(0, '127.0.0.1', resolveListen));
  return server;
}

function baseUrl(server: Server): string {
  const address = server.address();
  if (!address || typeof address === 'string') {
    throw new Error('Server did not bind to a TCP port.');
  }
  return `http://127.0.0.1:${address.port}`;
}

async function deliverWebhook(service: TenderService, envelope: JsonRecord) {
  const normalized = await normalize(envelope);
  expect(normalized.ok).toBe(true);
  const api = await service.submit(normalized.request, String(normalized.correlationId));
  const recorded = await recordIntegrationOutcome({
    statusCode: api.status === 'PROCESSING' && !api.route ? 202 : 200,
    body: api,
  });
  return {
    api,
    outcome: (recorded.body as JsonRecord).integrationOutcome as JsonRecord,
  };
}

async function normalize(body: unknown): Promise<JsonRecord> {
  return runWorkflowCode('Normalize Transport', { first: () => ({ json: { body, headers: {} } }) });
}

async function recordIntegrationOutcome(prepared: JsonRecord): Promise<JsonRecord> {
  return runWorkflowCode(
    'Record Integration Outcome',
    { first: () => ({ json: prepared }) },
    () => ({
      item: {
        json: {
          correlationId: (prepared.body as JsonRecord | undefined)?.correlationId,
          tenderId: (prepared.body as JsonRecord | undefined)?.tenderId,
        },
      },
    }),
  );
}

async function runWorkflowCode(
  name: string,
  input: { first: () => { json: JsonRecord } },
  dollar?: () => { item: { json: JsonRecord } },
): Promise<JsonRecord> {
  const node = workflow.nodes.find((candidate) => candidate.name === name);
  const code = node?.parameters.jsCode;
  if (typeof code !== 'string') throw new Error(`${name} code is missing.`);
  const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor as new (
    ...args: string[]
  ) => (...values: unknown[]) => Promise<Array<{ json: JsonRecord }>>;
  const execute = new AsyncFunction('$input', '$', code);
  const result = await execute(input, dollar ?? (() => ({ item: { json: {} } })));
  return result[0]!.json;
}

function readJson<T>(relativePath: string): T {
  return JSON.parse(readFileSync(new URL(relativePath, import.meta.url), 'utf8')) as T;
}

function providerTimeout() {
  return new InterpretationError('MODEL_PROVIDER_FAILED', 'provider timeout', true, {
    traceId: randomUUID(),
    model: 'rehearsal-test-model',
    promptVersion: 'test-prompt-v1',
    startedAt: new Date().toISOString(),
    completedAt: new Date().toISOString(),
    durationMs: 20_000,
    outcome: 'FAILED',
  });
}

class FakeInterpreter implements TenderInterpreter {
  readonly model = 'rehearsal-test-model';
  calls = 0;
  result: TenderInterpretation = interpretation;
  failure?: InterpretationError;

  async interpret() {
    this.calls += 1;
    if (this.failure) throw this.failure;
    return {
      output: this.result,
      trace: {
        traceId: randomUUID(),
        model: this.model,
        promptVersion: 'test-prompt-v1',
        startedAt: new Date().toISOString(),
        completedAt: new Date().toISOString(),
        durationMs: 1,
        outcome: 'SUCCEEDED' as const,
      },
    };
  }
}

class ControllableGateway implements PricingGateway {
  fail = false;
  calls = 0;

  constructor(private readonly repository: JsonFileTenderRepository) {}

  async submit(input: Parameters<PricingGateway['submit']>[0]): Promise<PricingHandoff> {
    this.calls += 1;
    if (this.fail) throw new Error('simulated downstream 500');
    const prior = await this.repository.findHandoff(input.handoffKey);
    if (prior) return prior;
    const handoff: PricingHandoff = {
      handoffId: randomUUID(),
      handoffKey: input.handoffKey,
      tenderId: input.tenderId,
      runId: input.runId,
      route: 'READY_FOR_PRICING',
      createdAt: new Date().toISOString(),
    };
    await this.repository.saveHandoff(handoff);
    return handoff;
  }
}

class ToggleFaultStore {
  failRead = false;
  failWrite = false;

  constructor(private readonly store: FileStateStore) {}

  async read(): Promise<LocalState> {
    if (this.failRead) throw new Error('simulated persistence read failure');
    return this.store.read();
  }

  async write(state: LocalState): Promise<void> {
    if (this.failWrite) throw new Error('simulated persistence write failure');
    await this.store.write(state);
  }
}
