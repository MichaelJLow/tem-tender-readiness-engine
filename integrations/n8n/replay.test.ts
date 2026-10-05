import { readFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  informationRequestReceiptKey,
  type LocalState,
  type TenderInterpretation,
} from '../../apps/api/src/contracts.js';
import {
  FileStateStore,
  JsonFileTenderRepository,
  StateWriteError,
} from '../../apps/api/src/file-repository.js';
import { MockPricingGateway, type PricingGateway } from '../../apps/api/src/pricing-gateway.js';
import type { LocalStateStore } from '../../apps/api/src/repository.js';
import {
  InterpretationError,
  type TenderInterpreter,
} from '../../apps/api/src/reasoning/interpreter.js';
import { IdempotencyConflictError, TenderService } from '../../apps/api/src/service.js';

type JsonRecord = Record<string, unknown>;

interface WorkflowNode {
  name: string;
  parameters: JsonRecord;
}

const root = new URL('.', import.meta.url);
const workflow = readJson<{ nodes: WorkflowNode[] }>('tender-intake.workflow.json');
const clean = readJson<JsonRecord>('fixtures/clean.json');
const duplicate = readJson<JsonRecord>('fixtures/duplicate.json');
const humanReview = readJson<JsonRecord>('fixtures/human-review.json');
const needsInformation = readJson<JsonRecord>('fixtures/needs-information.json');
const textReplay = {
  correlationId: 'n8n-text-replay-001',
  request: {
    ...(clean.request as JsonRecord),
    textSources: [
      {
        sourceId: 'note-n8n-replay-001',
        kind: 'NOTE',
        text: 'The contract for site-n8n-001 ends on 2027-03-31.',
      },
    ],
  },
};

const textReplayInterpretation: TenderInterpretation = {
  summary: 'The note restates the structured contract end date.',
  sourceAssessments: [
    {
      sourceId: 'note-n8n-replay-001',
      relevance: 'RELEVANT',
      confidence: 0.99,
      ambiguous: false,
      explanation: 'The contract end date is clear.',
      evidence: [
        {
          sourceId: 'note-n8n-replay-001',
          quote: 'site-n8n-001 ends on 2027-03-31',
        },
      ],
    },
  ],
  observations: [
    {
      field: 'contractEndDate',
      value: '2027-03-31',
      siteIds: ['site-n8n-001'],
      confidence: 0.99,
      ambiguous: false,
      evidence: [
        {
          sourceId: 'note-n8n-replay-001',
          quote: 'site-n8n-001 ends on 2027-03-31',
        },
      ],
    },
  ],
  siteAssociations: [],
  conflicts: [],
};

let directory: string;
let statePath: string;

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'n8n-replay-'));
  statePath = join(directory, 'tender-state.json');
});

afterEach(async () => {
  await rm(directory, { recursive: true, force: true });
});

describe('n8n + API duplicate delivery and restart replay', () => {
  it('keeps one ready run and one API-owned handoff across webhook redelivery', async () => {
    const first = await deliver(clean);
    const before = await readState();
    const replay = await deliver(clean);
    const after = await readState();

    expect(first.api.route).toBe('READY_FOR_PRICING');
    expect(first.outcome).toMatchObject({
      type: 'PRICING_HANDOFF_RECORDED',
      handoffAttemptsInitiatedByWorkflow: 0,
    });
    expect(replay.api.replayed).toBe(true);
    expect(replay.api.runId).toBe(first.api.runId);
    expect(replay.outcome).toMatchObject({
      type: 'PRICING_HANDOFF_RECORDED',
      key: first.outcome.key,
    });
    expect(effectCounts(before)).toEqual({
      runs: 1,
      handoffs: 1,
      informationRequestReceipts: 0,
      reviewEvents: 0,
    });
    expect(effectCounts(after)).toEqual(effectCounts(before));
    expect(after.runs[0]?.runId).toBe(first.api.runId);
    expect(after.handoffs[0]?.handoffKey).toBe('tender-n8n-clean-001:intake-n8n-clean-001');
  });

  it('returns a visible conflict for a changed payload and DUPLICATE for a new key', async () => {
    const first = await deliver(clean);
    const changed = structuredClone(clean);
    const request = changed.request as JsonRecord;
    const tender = request.tender as JsonRecord;
    const sites = structuredClone(tender.sites as JsonRecord[]);
    sites[0]!.annualConsumptionKwh = 26000;
    tender.sites = sites;

    await expect(deliver(changed)).rejects.toBeInstanceOf(IdempotencyConflictError);
    const afterConflict = await readState();

    const duplicateDelivery = await deliver(duplicate);
    const afterDuplicate = await readState();

    expect(first.api.route).toBe('READY_FOR_PRICING');
    expect(duplicateDelivery.api.route).toBe('DUPLICATE');
    expect(duplicateDelivery.api.runId).not.toBe(first.api.runId);
    expect(duplicateDelivery.outcome).toMatchObject({
      type: 'DUPLICATE_RECORDED',
      stopped: true,
    });
    expect(effectCounts(afterConflict)).toEqual({
      runs: 1,
      handoffs: 1,
      informationRequestReceipts: 0,
      reviewEvents: 0,
    });
    expect(effectCounts(afterDuplicate)).toEqual({
      runs: 2,
      handoffs: 1,
      informationRequestReceipts: 0,
      reviewEvents: 0,
    });
  });

  it('does not repeat information-request receipts or create review tasks on non-ready redelivery', async () => {
    const missing = await deliver(needsInformation);
    const afterMissing = await readState();
    const missingReplay = await deliver(needsInformation);
    const afterMissingReplay = await readState();

    const review = await deliver(humanReview);
    const afterReview = await readState();
    const reviewReplay = await deliver(humanReview);
    const afterReviewReplay = await readState();

    expect(missing.api.route).toBe('NEEDS_INFORMATION');
    expect(missing.outcome).toMatchObject({
      type: 'INFORMATION_REQUEST_RECORDED',
      key: informationRequestReceiptKey(String(missing.api.runId)),
      synthetic: true,
      deliveryStatus: 'NOT_SENT',
      outboundMessagesSent: 0,
    });
    expect(missingReplay.api.replayed).toBe(true);
    expect(missingReplay.api.runId).toBe(missing.api.runId);
    expect(missingReplay.outcome.key).toBe(missing.outcome.key);
    expect(effectCounts(afterMissing)).toEqual({
      runs: 1,
      handoffs: 0,
      informationRequestReceipts: 1,
      reviewEvents: 0,
    });
    expect(effectCounts(afterMissingReplay)).toEqual(effectCounts(afterMissing));
    expect(afterMissing.informationRequestReceipts[0]).toMatchObject({
      key: informationRequestReceiptKey(String(missing.api.runId)),
      deliveryStatus: 'NOT_SENT',
    });

    expect(review.api.route).toBe('HUMAN_REVIEW');
    expect(review.outcome).toMatchObject({
      type: 'HUMAN_REVIEW_AVAILABLE',
      reviewTaskCreatedByWorkflow: false,
      consolePath: `/tenders/${review.api.runId}`,
    });
    expect(reviewReplay.api.replayed).toBe(true);
    expect(reviewReplay.api.runId).toBe(review.api.runId);
    expect(effectCounts(afterReview)).toEqual({
      runs: 2,
      handoffs: 0,
      informationRequestReceipts: 1,
      reviewEvents: 0,
    });
    expect(effectCounts(afterReviewReplay)).toEqual(effectCounts(afterReview));
  });

  it('resumes interrupted ready and needs-information runs from the same file after restart', async () => {
    const interruptReady = new InterruptAfterHandoffStore(new FileStateStore(statePath));
    await expect(deliver(clean, { store: interruptReady })).rejects.toMatchObject({
      failure: { code: 'STATE_WRITE_FAILED' },
    });
    const interruptedReady = await readState();
    expect(interruptedReady.runs).toHaveLength(1);
    expect(interruptedReady.handoffs).toHaveLength(1);
    expect(interruptedReady.runs[0]?.status).not.toBe('COMPLETED');

    const recoveredReady = await deliver(clean);
    const afterReady = await readState();
    expect(recoveredReady.api).toMatchObject({
      replayed: true,
      status: 'COMPLETED',
      route: 'READY_FOR_PRICING',
      runId: interruptedReady.runs[0]?.runId,
    });
    expect(effectCounts(afterReady)).toEqual({
      runs: 1,
      handoffs: 1,
      informationRequestReceipts: 0,
      reviewEvents: 0,
    });

    const interruptReceipt = new InterruptOnReceiptStore(new FileStateStore(statePath));
    await expect(deliver(needsInformation, { store: interruptReceipt })).rejects.toMatchObject({
      failure: { code: 'STATE_WRITE_FAILED' },
    });
    const interruptedMissing = await readState();
    expect(interruptedMissing.runs).toHaveLength(2);
    expect(interruptedMissing.informationRequestReceipts).toHaveLength(0);

    const recoveredMissing = await deliver(needsInformation);
    const afterMissing = await readState();
    expect(recoveredMissing.api).toMatchObject({
      replayed: true,
      status: 'COMPLETED',
      route: 'NEEDS_INFORMATION',
      runId: interruptedMissing.runs.find((run) => run.route === 'NEEDS_INFORMATION')?.runId,
    });
    expect(effectCounts(afterMissing)).toEqual({
      runs: 2,
      handoffs: 1,
      informationRequestReceipts: 1,
      reviewEvents: 0,
    });
    expect(afterMissing.informationRequestReceipts[0]?.key).toBe(
      informationRequestReceiptKey(String(recoveredMissing.api.runId)),
    );
  });

  it('does not repeat stored interpretation work after a file-backed restart', async () => {
    const firstInterpreter = new CountingInterpreter();
    await expect(
      deliver(textReplay, {
        store: new InterruptAfterHandoffStore(new FileStateStore(statePath)),
        interpreter: firstInterpreter,
      }),
    ).rejects.toMatchObject({
      failure: { code: 'STATE_WRITE_FAILED' },
    });
    const interrupted = await readState();
    expect(firstInterpreter.calls).toBe(1);
    expect(interrupted.runs[0]?.interpretation).toBeDefined();
    expect(effectCounts(interrupted)).toEqual({
      runs: 1,
      handoffs: 1,
      informationRequestReceipts: 0,
      reviewEvents: 0,
    });

    const replayInterpreter = new CountingInterpreter();
    replayInterpreter.failure = providerFailure();
    const replay = await deliver(textReplay, { interpreter: replayInterpreter });
    const after = await readState();

    expect(replay.api).toMatchObject({
      replayed: true,
      status: 'COMPLETED',
      route: 'READY_FOR_PRICING',
      runId: interrupted.runs[0]?.runId,
    });
    expect(replayInterpreter.calls).toBe(0);
    expect(effectCounts(after)).toEqual({
      runs: 1,
      handoffs: 1,
      informationRequestReceipts: 0,
      reviewEvents: 0,
    });
  });

  it('reconciles a saved pricing handoff after an in-flight gateway interruption and restart', async () => {
    let calls = 0;
    let markSaved!: () => void;
    const saved = new Promise<void>((resolve) => {
      markSaved = resolve;
    });
    const interruptedGateway: PricingGateway = {
      async submit(input) {
        calls += 1;
        const repository = new JsonFileTenderRepository(new FileStateStore(statePath));
        await repository.saveHandoff({
          handoffId: randomUUID(),
          handoffKey: input.handoffKey,
          tenderId: input.tenderId,
          runId: input.runId,
          route: 'READY_FOR_PRICING',
          createdAt: new Date().toISOString(),
        });
        markSaved();
        return new Promise(() => undefined);
      },
    };
    void deliver(clean, {
      pricingGateway: interruptedGateway,
      recoveryPolicy: { maxAttempts: 1, backoffMs: [], sleep: async () => undefined },
    });
    await saved;
    const interrupted = await readState();
    expect(calls).toBe(1);
    expect(interrupted.runs[0]).toMatchObject({
      status: 'PROCESSING',
      failure: { stage: 'PRICING', attempt: 1, retryable: true },
    });
    expect(effectCounts(interrupted)).toEqual({
      runs: 1,
      handoffs: 1,
      informationRequestReceipts: 0,
      reviewEvents: 0,
    });

    let replayCalls = 0;
    const replayGateway: PricingGateway = {
      async submit() {
        replayCalls += 1;
        throw new Error('restart must not call the gateway again after a saved receipt');
      },
    };
    const replay = await deliver(clean, {
      pricingGateway: replayGateway,
      recoveryPolicy: { maxAttempts: 1, backoffMs: [], sleep: async () => undefined },
    });
    const after = await readState();

    expect(replay.api).toMatchObject({
      replayed: true,
      status: 'COMPLETED',
      route: 'READY_FOR_PRICING',
      runId: interrupted.runs[0]?.runId,
    });
    expect(replayCalls).toBe(0);
    expect(effectCounts(after)).toEqual(effectCounts(interrupted));
    expect(after.runs[0]?.status).toBe('COMPLETED');
  });
});

async function deliver(
  envelope: JsonRecord,
  options: {
    store?: LocalStateStore;
    interpreter?: TenderInterpreter;
    pricingGateway?: PricingGateway;
    recoveryPolicy?: ConstructorParameters<typeof TenderService>[4];
  } = {},
) {
  const normalized = await normalize(envelope);
  expect(normalized.ok).toBe(true);
  const store = options.store ?? new FileStateStore(statePath);
  const repository = new JsonFileTenderRepository(store);
  const service = new TenderService(
    repository,
    options.pricingGateway ?? new MockPricingGateway(repository),
    undefined,
    options.interpreter,
    options.recoveryPolicy ?? { maxAttempts: 3, backoffMs: [], sleep: async () => undefined },
  );
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

function readJson<T>(relativePath: string): T {
  return JSON.parse(readFileSync(new URL(relativePath, root), 'utf8')) as T;
}

function providerFailure() {
  return new InterpretationError('MODEL_PROVIDER_FAILED', 'provider unavailable', true, {
    traceId: randomUUID(),
    model: 'replay-test-model',
    promptVersion: 'test-prompt-v1',
    startedAt: new Date().toISOString(),
    completedAt: new Date().toISOString(),
    durationMs: 1,
    outcome: 'FAILED',
  });
}

class CountingInterpreter implements TenderInterpreter {
  readonly model = 'replay-test-model';
  calls = 0;
  failure?: InterpretationError;
  failuresBeforeSuccess = Number.POSITIVE_INFINITY;

  async interpret() {
    this.calls += 1;
    if (this.failure && this.calls <= this.failuresBeforeSuccess) throw this.failure;
    return {
      output: textReplayInterpretation,
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

class InterruptAfterHandoffStore implements LocalStateStore {
  private interrupted = false;

  constructor(private readonly store: LocalStateStore) {}

  read(): Promise<LocalState> {
    return this.store.read();
  }

  async write(state: LocalState): Promise<void> {
    if (
      !this.interrupted &&
      state.handoffs.length > 0 &&
      state.runs.some((run) => run.status === 'COMPLETED')
    ) {
      this.interrupted = true;
      throw new StateWriteError('simulated interruption after the handoff was persisted');
    }
    await this.store.write(state);
  }
}

class InterruptOnReceiptStore implements LocalStateStore {
  private interrupted = false;

  constructor(private readonly store: LocalStateStore) {}

  read(): Promise<LocalState> {
    return this.store.read();
  }

  async write(state: LocalState): Promise<void> {
    if (!this.interrupted && (state.informationRequestReceipts?.length ?? 0) > 0) {
      this.interrupted = true;
      throw new StateWriteError('simulated interruption before the receipt was persisted');
    }
    await this.store.write(state);
  }
}
