import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import type { LocalState, PricingHandoff, TenderRun } from '../contracts.js';
import type { PricingGateway } from '../pricing-gateway.js';
import type { LocalStateStore, TenderRepository } from '../repository.js';
import { TenderProcessingError, TenderService } from '../service.js';
import type { TenderInterpretation } from './contracts.js';
import { InterpretationError, type TenderInterpreter } from './interpreter.js';
import { cleanTender } from '../../../../tests/fixtures/tenders.js';

const source = {
  sourceId: 'broker-note-1',
  kind: 'NOTE' as const,
  text: 'The contract for site-001 ends on 2027-03-31.',
};

const output: TenderInterpretation = {
  summary: 'The note states the structured contract date.',
  sourceAssessments: [
    {
      sourceId: source.sourceId,
      relevance: 'RELEVANT',
      confidence: 0.99,
      ambiguous: false,
      explanation: 'The contract end date is clear.',
      evidence: [{ sourceId: source.sourceId, quote: 'site-001 ends on 2027-03-31' }],
    },
  ],
  observations: [
    {
      field: 'contractEndDate',
      value: '2027-03-31',
      siteIds: ['site-001'],
      confidence: 0.99,
      ambiguous: false,
      evidence: [{ sourceId: source.sourceId, quote: 'site-001 ends on 2027-03-31' }],
    },
  ],
  siteAssociations: [],
  conflicts: [],
};

class MemoryStore implements LocalStateStore {
  state: LocalState = { version: 1, runs: [], handoffs: [], reviewEvents: [] };
  async read() {
    return structuredClone(this.state);
  }
  async write(state: LocalState) {
    this.state = structuredClone(state);
  }
}

class MemoryRepository implements TenderRepository {
  readonly store = new MemoryStore();
  async findRunByIdempotencyKey(key: string) {
    return (await this.store.read()).runs.find((run) => run.idempotencyKey === key);
  }
  async findRunByTenderId(tenderId: string) {
    return (await this.store.read()).runs.find((run) => run.tenderId === tenderId);
  }
  async saveRun(run: TenderRun) {
    const state = await this.store.read();
    const index = state.runs.findIndex((item) => item.runId === run.runId);
    if (index < 0) state.runs.push(structuredClone(run));
    else state.runs[index] = structuredClone(run);
    await this.store.write(state);
  }
  async findHandoff(key: string) {
    return (await this.store.read()).handoffs.find((handoff) => handoff.handoffKey === key);
  }
  async saveHandoff(handoff: PricingHandoff) {
    const state = await this.store.read();
    if (!state.handoffs.some((item) => item.handoffKey === handoff.handoffKey)) {
      state.handoffs.push(structuredClone(handoff));
      await this.store.write(state);
    }
  }
}

class FailOnceAfterInterpretationRepository extends MemoryRepository {
  private shouldFail = true;

  override async saveRun(run: TenderRun) {
    if (this.shouldFail && run.interpretation) {
      this.shouldFail = false;
      throw new Error('simulated state write failure');
    }
    await super.saveRun(run);
  }
}

class FailOnceOnPricingRecoveryRepository extends MemoryRepository {
  failRecovery = false;

  override async saveRun(run: TenderRun) {
    const stored = await this.findRunByIdempotencyKey(run.idempotencyKey);
    if (
      this.failRecovery &&
      stored?.status === 'PROCESSING' &&
      stored.failure?.stage === 'PRICING' &&
      run.status === 'COMPLETED'
    ) {
      this.failRecovery = false;
      throw new Error('simulated recovery write failure');
    }
    await super.saveRun(run);
  }
}

class RecordingGateway implements PricingGateway {
  readonly repository: MemoryRepository;
  failuresRemaining = 0;
  calls = 0;
  constructor(repository: MemoryRepository) {
    this.repository = repository;
  }
  async submit(input: Parameters<PricingGateway['submit']>[0]) {
    this.calls += 1;
    if (this.failuresRemaining > 0) {
      this.failuresRemaining -= 1;
      throw new Error('temporary gateway failure');
    }
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

class FakeInterpreter implements TenderInterpreter {
  readonly model = 'fake-model';
  calls = 0;
  result: TenderInterpretation = output;
  failure?: InterpretationError;
  failuresBeforeSuccess = Number.POSITIVE_INFINITY;
  beforeInterpret?: () => Promise<void>;
  async interpret() {
    this.calls += 1;
    await this.beforeInterpret?.();
    if (this.failure && this.calls <= this.failuresBeforeSuccess) throw this.failure;
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

describe('TenderService interpretation boundary', () => {
  it('skips interpretation for structured-only requests', async () => {
    const repository = new MemoryRepository();
    const interpreter = new FakeInterpreter();
    const service = new TenderService(
      repository,
      new RecordingGateway(repository),
      undefined,
      interpreter,
      { maxAttempts: 1, backoffMs: [], sleep: async () => undefined },
    );
    const result = await service.submit(cleanTender, 'correlation-structured');
    expect(result.route).toBe('READY_FOR_PRICING');
    expect(interpreter.calls).toBe(0);
  });

  it('interprets text once and persists evidence before routing', async () => {
    const repository = new MemoryRepository();
    const interpreter = new FakeInterpreter();
    const service = new TenderService(
      repository,
      new RecordingGateway(repository),
      undefined,
      interpreter,
      { maxAttempts: 1, backoffMs: [], sleep: async () => undefined },
    );
    const request = { ...cleanTender, textSources: [source] };
    const result = await service.submit(request, 'correlation-text');
    const replay = await service.submit(request, 'correlation-replay');
    const saved = await repository.findRunByIdempotencyKey(cleanTender.tender.idempotencyKey);

    expect(result.route).toBe('READY_FOR_PRICING');
    expect(result.interpretation?.observations).toHaveLength(1);
    expect(result.modelTrace?.outcome).toBe('SUCCEEDED');
    expect(replay.replayed).toBe(true);
    expect(interpreter.calls).toBe(1);
    expect(saved?.input.tender.sites[0]?.contractEndDate).toBe('2027-03-31');
    expect(saved?.input.signals.dateFacts).toHaveLength(1);
    expect((await repository.store.read()).handoffs).toHaveLength(1);
  });

  it('routes a text-to-structured conflict to review when the model adds an unsupported tender citation', async () => {
    const repository = new MemoryRepository();
    const gateway = new RecordingGateway(repository);
    const interpreter = new FakeInterpreter();
    const conflictingSource = {
      ...source,
      text: 'The contract for site-001 ends on 2026-09-30.',
    };
    const quote = 'contract for site-001 ends on 2026-09-30';
    interpreter.result = {
      ...output,
      sourceAssessments: [
        {
          ...output.sourceAssessments[0]!,
          evidence: [{ sourceId: source.sourceId, quote }],
        },
      ],
      observations: [
        {
          ...output.observations[0]!,
          value: '2026-09-30',
          evidence: [{ sourceId: source.sourceId, quote }],
        },
      ],
      conflicts: [
        {
          explanation: 'The text date conflicts with the contract date in the structured tender.',
          evidence: [
            { sourceId: source.sourceId, quote },
            { sourceId: 'tender', quote: 'siteId: site-001; contractEndDate: 2027-03-31' },
          ],
        },
      ],
    };
    const service = new TenderService(repository, gateway, undefined, interpreter);

    const result = await service.submit(
      { ...cleanTender, textSources: [conflictingSource] },
      'correlation-structured-conflict',
    );

    expect(result.route).toBe('HUMAN_REVIEW');
    expect(gateway.calls).toBe(0);
    expect(result.interpretation?.conflicts[0]?.evidence).toEqual([
      { sourceId: source.sourceId, quote },
    ]);
    expect(result.rules.find((rule) => rule.ruleId === 'TDR-006')?.route).toBe('HUMAN_REVIEW');
  });

  it('does not hand off a model-assigned fact quoted for an unknown site', async () => {
    const repository = new MemoryRepository();
    const gateway = new RecordingGateway(repository);
    const interpreter = new FakeInterpreter();
    const unknownSiteSource = {
      ...source,
      text: 'Site site-999 contract ends on 2027-03-31.',
    };
    interpreter.result = {
      ...output,
      sourceAssessments: [
        {
          ...output.sourceAssessments[0]!,
          evidence: [{ sourceId: source.sourceId, quote: unknownSiteSource.text }],
        },
      ],
      observations: [
        {
          ...output.observations[0]!,
          evidence: [{ sourceId: source.sourceId, quote: unknownSiteSource.text }],
        },
      ],
    };
    const service = new TenderService(repository, gateway, undefined, interpreter);

    const result = await service.submit(
      { ...cleanTender, textSources: [unknownSiteSource] },
      'correlation-unknown-site',
    );
    expect(result.route).toBe('HUMAN_REVIEW');
    expect(gateway.calls).toBe(0);
    expect((await repository.store.read()).handoffs).toHaveLength(0);
  });

  it('reuses persisted interpretation when resuming before readiness evaluation', async () => {
    const repository = new MemoryRepository();
    const firstInterpreter = new FakeInterpreter();
    const firstService = new TenderService(
      repository,
      new RecordingGateway(repository),
      undefined,
      firstInterpreter,
    );
    const request = { ...cleanTender, textSources: [source] };
    await firstService.submit(request, 'correlation-first-attempt');

    const interruptedRun = repository.store.state.runs[0]!;
    interruptedRun.status = 'PROCESSING';
    delete interruptedRun.route;
    delete interruptedRun.result;

    const retryInterpreter = new FakeInterpreter();
    retryInterpreter.failure = new InterpretationError(
      'MODEL_PROVIDER_FAILED',
      'provider unavailable',
      true,
      {
        traceId: randomUUID(),
        model: retryInterpreter.model,
        promptVersion: 'test-prompt-v1',
        startedAt: new Date().toISOString(),
        completedAt: new Date().toISOString(),
        durationMs: 1,
        outcome: 'FAILED',
      },
    );
    const resumedService = new TenderService(
      repository,
      new RecordingGateway(repository),
      undefined,
      retryInterpreter,
    );

    const resumed = await resumedService.submit(request, 'correlation-resume');
    expect(resumed.route).toBe('READY_FOR_PRICING');
    expect(retryInterpreter.calls).toBe(0);
    expect((await repository.store.read()).handoffs).toHaveLength(1);
  });

  it('does not classify an interpretation persistence failure as a model failure', async () => {
    const repository = new FailOnceAfterInterpretationRepository();
    const interpreter = new FakeInterpreter();
    const service = new TenderService(
      repository,
      new RecordingGateway(repository),
      undefined,
      interpreter,
    );
    const request = { ...cleanTender, textSources: [source] };

    await expect(service.submit(request, 'correlation-write-failure')).rejects.toMatchObject({
      failure: { code: 'STATE_WRITE_FAILED' },
    });
    const afterFailure = await repository.findRunByIdempotencyKey(
      cleanTender.tender.idempotencyKey,
    );
    expect(afterFailure?.status).toBe('PROCESSING');
    expect(afterFailure?.failure).toMatchObject({
      code: 'MODEL_PROVIDER_FAILED',
      stage: 'INTERPRETATION',
      attempt: 1,
      retryable: true,
    });
    expect(interpreter.calls).toBe(1);

    const resumed = await service.submit(request, 'correlation-write-retry');
    expect(resumed.status).toBe('COMPLETED');
    expect(resumed.route).toBe('READY_FOR_PRICING');
    expect(resumed.failure).toBeUndefined();
    expect(interpreter.calls).toBe(2);
    expect((await repository.store.read()).handoffs).toHaveLength(1);
  });

  it('routes a known duplicate without calling the interpreter', async () => {
    const repository = new MemoryRepository();
    const interpreter = new FakeInterpreter();
    const service = new TenderService(
      repository,
      new RecordingGateway(repository),
      undefined,
      interpreter,
    );
    await service.submit(cleanTender, 'correlation-first');
    const duplicate = {
      ...cleanTender,
      tender: { ...cleanTender.tender, idempotencyKey: 'another-key' },
      textSources: [source],
    };

    const result = await service.submit(duplicate, 'correlation-duplicate');
    expect(result.route).toBe('DUPLICATE');
    expect(result.status).toBe('COMPLETED');
    expect(interpreter.calls).toBe(0);
    expect((await repository.store.read()).handoffs).toHaveLength(1);
  });

  it('fails without a route or pricing handoff when the provider fails', async () => {
    const repository = new MemoryRepository();
    const interpreter = new FakeInterpreter();
    const trace = {
      traceId: randomUUID(),
      model: interpreter.model,
      promptVersion: 'test-prompt-v1',
      startedAt: new Date().toISOString(),
      completedAt: new Date().toISOString(),
      durationMs: 1,
      outcome: 'FAILED' as const,
    };
    interpreter.failure = new InterpretationError(
      'MODEL_PROVIDER_FAILED',
      'provider unavailable',
      true,
      trace,
    );
    const service = new TenderService(
      repository,
      new RecordingGateway(repository),
      undefined,
      interpreter,
    );

    await expect(
      service.submit({ ...cleanTender, textSources: [source] }, 'correlation-failure'),
    ).rejects.toMatchObject({ httpStatus: 502 });
    const saved = await repository.findRunByIdempotencyKey(cleanTender.tender.idempotencyKey);
    expect(saved?.status).toBe('FAILED');
    expect(saved?.route).toBeUndefined();
    expect(saved?.result).toBeUndefined();
    expect(saved?.failure).toMatchObject({
      code: 'MODEL_PROVIDER_FAILED',
      stage: 'INTERPRETATION',
      retryable: false,
      attempt: 3,
    });
    expect(saved?.failure?.occurredAt).toEqual(expect.any(String));
    expect((await repository.store.read()).handoffs).toHaveLength(0);
  });

  it('automatically retries a transient provider failure with bounded backoff', async () => {
    const repository = new MemoryRepository();
    const interpreter = new FakeInterpreter();
    const trace = {
      traceId: randomUUID(),
      model: interpreter.model,
      promptVersion: 'test-prompt-v1',
      startedAt: new Date().toISOString(),
      completedAt: new Date().toISOString(),
      durationMs: 1,
      outcome: 'FAILED' as const,
    };
    interpreter.failure = new InterpretationError(
      'MODEL_PROVIDER_FAILED',
      'provider unavailable',
      true,
      trace,
    );
    interpreter.failuresBeforeSuccess = 1;
    const delays: number[] = [];
    const service = new TenderService(
      repository,
      new RecordingGateway(repository),
      undefined,
      interpreter,
      { maxAttempts: 3, backoffMs: [250, 1_000], sleep: async (ms) => void delays.push(ms) },
    );
    const request = { ...cleanTender, textSources: [source] };

    const retried = await service.submit(request, 'correlation-before-retry');

    expect(retried.status).toBe('COMPLETED');
    expect(retried.route).toBe('READY_FOR_PRICING');
    expect(retried.failure).toBeUndefined();
    expect(retried.replayed).toBe(false);
    expect(interpreter.calls).toBe(2);
    expect(delays).toEqual([250]);
    expect((await repository.store.read()).handoffs).toHaveLength(1);
  });

  it('continues the retained attempt budget after a process restart', async () => {
    const repository = new MemoryRepository();
    const firstInterpreter = new FakeInterpreter();
    firstInterpreter.failure = new InterpretationError(
      'MODEL_PROVIDER_FAILED',
      'provider unavailable',
      true,
      {
        traceId: randomUUID(),
        model: firstInterpreter.model,
        promptVersion: 'test-prompt-v1',
        startedAt: new Date().toISOString(),
        completedAt: new Date().toISOString(),
        durationMs: 1,
        outcome: 'FAILED',
      },
    );
    const request = { ...cleanTender, textSources: [source] };
    const interruptedService = new TenderService(
      repository,
      new RecordingGateway(repository),
      undefined,
      firstInterpreter,
      {
        maxAttempts: 2,
        backoffMs: [250],
        sleep: async () => {
          throw new Error('simulated process stop during backoff');
        },
      },
    );
    await expect(interruptedService.submit(request, 'restart-before')).rejects.toThrow(
      'simulated process stop',
    );
    expect(
      (await repository.findRunByIdempotencyKey(request.tender.idempotencyKey))?.failure,
    ).toMatchObject({ attempt: 1, retryable: true });

    const resumedInterpreter = new FakeInterpreter();
    resumedInterpreter.beforeInterpret = async () => {
      expect(await repository.findRunByIdempotencyKey(request.tender.idempotencyKey)).toMatchObject(
        {
          status: 'PROCESSING',
          failure: { stage: 'INTERPRETATION', attempt: 2, retryable: true },
        },
      );
    };
    const resumedGateway = new RecordingGateway(repository);
    const resumedService = new TenderService(
      repository,
      resumedGateway,
      undefined,
      resumedInterpreter,
      { maxAttempts: 2, backoffMs: [250], sleep: async () => undefined },
    );
    const resumed = await resumedService.submit(request, 'restart-after');

    expect(resumed).toMatchObject({
      status: 'COMPLETED',
      route: 'READY_FOR_PRICING',
      replayed: true,
    });
    expect(resumed.runId).toBe(repository.store.state.runs[0]?.runId);
    expect(resumedInterpreter.calls).toBe(1);
    expect(resumedGateway.calls).toBe(1);
    expect(repository.store.state.handoffs).toHaveLength(1);
  });

  it('counts an interpretation attempt interrupted while the provider call is in flight', async () => {
    const repository = new MemoryRepository();
    const interpreter = new FakeInterpreter();
    const trace = {
      traceId: randomUUID(),
      model: interpreter.model,
      promptVersion: 'test-prompt-v1',
      startedAt: new Date().toISOString(),
      completedAt: new Date().toISOString(),
      durationMs: 1,
      outcome: 'FAILED' as const,
    };
    interpreter.beforeInterpret = async () => {
      if (interpreter.calls === 1) {
        throw new InterpretationError('MODEL_PROVIDER_FAILED', 'provider unavailable', true, trace);
      }
      if (interpreter.calls === 2) await new Promise<void>(() => undefined);
    };
    const request = { ...cleanTender, textSources: [source] };
    const interruptedService = new TenderService(
      repository,
      new RecordingGateway(repository),
      undefined,
      interpreter,
      { maxAttempts: 2, backoffMs: [0], sleep: async () => undefined },
    );
    void interruptedService.submit(request, 'interpretation-in-flight');
    while (interpreter.calls < 2) await new Promise((resolve) => setTimeout(resolve, 0));

    expect(await repository.findRunByIdempotencyKey(request.tender.idempotencyKey)).toMatchObject({
      status: 'PROCESSING',
      failure: { stage: 'INTERPRETATION', attempt: 2, retryable: true },
    });

    const resumedInterpreter = new FakeInterpreter();
    const resumedService = new TenderService(
      repository,
      new RecordingGateway(repository),
      undefined,
      resumedInterpreter,
      { maxAttempts: 2, backoffMs: [0], sleep: async () => undefined },
    );
    await expect(
      resumedService.submit(request, 'interpretation-in-flight-replay'),
    ).rejects.toMatchObject({
      httpStatus: 502,
      response: {
        status: 'FAILED',
        failure: {
          code: 'MODEL_PROVIDER_FAILED',
          stage: 'INTERPRETATION',
          attempt: 2,
          retryable: false,
        },
      },
    });

    expect(interpreter.calls).toBe(2);
    expect(resumedInterpreter.calls).toBe(0);
    expect((await repository.store.read()).handoffs).toHaveLength(0);
  });

  it('automatically retries a failed pricing handoff without duplicating the handoff', async () => {
    const repository = new MemoryRepository();
    const gateway = new RecordingGateway(repository);
    gateway.failuresRemaining = 1;
    const service = new TenderService(repository, gateway);

    const retried = await service.submit(cleanTender, 'correlation-pricing-before-retry');

    expect(retried.status).toBe('COMPLETED');
    expect(retried.route).toBe('READY_FOR_PRICING');
    expect(retried.failure).toBeUndefined();
    expect(retried.replayed).toBe(false);
    expect(gateway.calls).toBe(2);
    expect((await repository.store.read()).handoffs).toHaveLength(1);
  });

  it('stops after pricing retry exhaustion and does not treat a retained ready route as success', async () => {
    const repository = new MemoryRepository();
    const gateway = new RecordingGateway(repository);
    gateway.failuresRemaining = 4;
    const service = new TenderService(repository, gateway, undefined, undefined, {
      maxAttempts: 3,
      backoffMs: [250, 1_000],
      sleep: async () => undefined,
    });

    await expect(service.submit(cleanTender, 'pricing-exhaustion')).rejects.toMatchObject({
      httpStatus: 502,
      response: {
        status: 'FAILED',
        route: 'READY_FOR_PRICING',
        failure: { retryable: false, attempt: 3 },
      },
    });
    const replay = await service.submit(cleanTender, 'pricing-exhaustion-replay');

    expect(replay).toMatchObject({
      status: 'FAILED',
      route: 'READY_FOR_PRICING',
      replayed: true,
    });
    expect(gateway.calls).toBe(3);
    expect((await repository.store.read()).handoffs).toHaveLength(0);
  });

  it('counts a pricing attempt interrupted in flight and reconciles a saved handoff', async () => {
    const repository = new MemoryRepository();
    let calls = 0;
    let markInFlight!: () => void;
    const inFlight = new Promise<void>((resolve) => {
      markInFlight = resolve;
    });
    const interruptedGateway: PricingGateway = {
      async submit(input) {
        calls += 1;
        if (calls === 1) throw new Error('temporary gateway failure');
        if (calls === 2) {
          const handoff: PricingHandoff = {
            handoffId: randomUUID(),
            handoffKey: input.handoffKey,
            tenderId: input.tenderId,
            runId: input.runId,
            route: 'READY_FOR_PRICING',
            createdAt: new Date().toISOString(),
          };
          await repository.saveHandoff(handoff);
          markInFlight();
          return new Promise<PricingHandoff>(() => undefined);
        }
        throw new Error('unexpected extra gateway attempt');
      },
    };
    const request = cleanTender;
    const interruptedService = new TenderService(
      repository,
      interruptedGateway,
      undefined,
      undefined,
      { maxAttempts: 2, backoffMs: [0], sleep: async () => undefined },
    );
    void interruptedService.submit(request, 'pricing-in-flight');
    await inFlight;
    expect(await repository.findRunByIdempotencyKey(request.tender.idempotencyKey)).toMatchObject({
      status: 'PROCESSING',
      failure: { stage: 'PRICING', attempt: 2, retryable: true },
    });

    const resumedGateway = new RecordingGateway(repository);
    const resumedService = new TenderService(repository, resumedGateway, undefined, undefined, {
      maxAttempts: 2,
      backoffMs: [0],
      sleep: async () => undefined,
    });
    const resumed = await resumedService.submit(request, 'pricing-in-flight-replay');

    expect(resumed).toMatchObject({ status: 'COMPLETED', route: 'READY_FOR_PRICING' });
    expect(calls).toBe(2);
    expect(resumedGateway.calls).toBe(0);
    expect((await repository.store.read()).handoffs).toHaveLength(1);
  });

  it('does not label a pricing recovery write failure as a gateway failure', async () => {
    const repository = new FailOnceOnPricingRecoveryRepository();
    const gateway = new RecordingGateway(repository);
    gateway.failuresRemaining = 1;
    const service = new TenderService(repository, gateway, undefined, undefined, {
      maxAttempts: 3,
      backoffMs: [0, 0],
      sleep: async () => undefined,
    });

    repository.failRecovery = true;
    await expect(service.submit(cleanTender, 'pricing-first')).rejects.toMatchObject({
      failure: { code: 'STATE_WRITE_FAILED', causeCode: 'PRICING_GATEWAY_FAILED' },
    });
    const afterFailure = await repository.findRunByIdempotencyKey(
      cleanTender.tender.idempotencyKey,
    );
    expect(afterFailure).toMatchObject({
      status: 'PROCESSING',
      failure: { code: 'PRICING_GATEWAY_FAILED', stage: 'PRICING', attempt: 2, retryable: true },
    });
    expect((await repository.store.read()).handoffs).toHaveLength(1);

    const resumed = await service.submit(cleanTender, 'pricing-recovery-retry');
    expect(resumed.status).toBe('COMPLETED');
    expect(resumed.failure).toBeUndefined();
    expect((await repository.store.read()).handoffs).toHaveLength(1);
  });

  it('treats invalid source evidence as a technical failure', async () => {
    const repository = new MemoryRepository();
    const interpreter = new FakeInterpreter();
    interpreter.result = {
      ...output,
      observations: [
        {
          ...output.observations[0]!,
          evidence: [{ sourceId: source.sourceId, quote: 'fabricated evidence' }],
        },
      ],
    };
    const service = new TenderService(
      repository,
      new RecordingGateway(repository),
      undefined,
      interpreter,
    );

    await expect(
      service.submit({ ...cleanTender, textSources: [source] }, 'correlation-invalid'),
    ).rejects.toBeInstanceOf(TenderProcessingError);
    const saved = await repository.findRunByIdempotencyKey(cleanTender.tender.idempotencyKey);
    expect(saved?.failure?.code).toBe('MODEL_OUTPUT_INVALID');
    expect(saved?.route).toBeUndefined();
    expect((await repository.store.read()).handoffs).toHaveLength(0);
  });

  it('classifies schema-invalid interpreter output as MODEL_OUTPUT_INVALID', async () => {
    const repository = new MemoryRepository();
    const interpreter = new FakeInterpreter();
    interpreter.result = {
      ...output,
      summary: '',
    } as unknown as TenderInterpretation;
    const service = new TenderService(
      repository,
      new RecordingGateway(repository),
      undefined,
      interpreter,
    );

    await expect(
      service.submit({ ...cleanTender, textSources: [source] }, 'correlation-schema-invalid'),
    ).rejects.toMatchObject({
      httpStatus: 500,
      response: { failure: { code: 'MODEL_OUTPUT_INVALID', retryable: false } },
    });
    const saved = await repository.findRunByIdempotencyKey(cleanTender.tender.idempotencyKey);
    expect(saved?.failure?.code).toBe('MODEL_OUTPUT_INVALID');
    expect((await repository.store.read()).handoffs).toHaveLength(0);
  });
});
