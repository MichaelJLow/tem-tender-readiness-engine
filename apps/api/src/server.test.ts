import type { Server } from 'node:http';
import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  cleanTender,
  conflictingDatesTender,
  missingConsumptionTender,
} from '../../../tests/fixtures/tenders.js';
import type {
  InformationRequestReceipt,
  LocalState,
  PricingHandoff,
  TenderRun,
} from './contracts.js';
import { JsonFileTenderRepository } from './file-repository.js';
import { createTenderServer } from './server.js';
import type { PricingGateway } from './pricing-gateway.js';
import type { LocalStateStore, TenderRepository } from './repository.js';
import { TenderService } from './service.js';

class MemoryStore implements LocalStateStore {
  state: LocalState = {
    version: 1,
    runs: [],
    handoffs: [],
    reviewEvents: [],
    informationRequestReceipts: [],
  };

  async read(): Promise<LocalState> {
    return structuredClone(this.state);
  }

  async write(state: LocalState): Promise<void> {
    this.state = structuredClone(state);
  }
}

class MemoryRepository implements TenderRepository {
  constructor(private readonly store = new MemoryStore()) {}

  async findRunByIdempotencyKey(key: string): Promise<TenderRun | undefined> {
    return (await this.store.read()).runs.find((run) => run.idempotencyKey === key);
  }

  async findRunByTenderId(tenderId: string): Promise<TenderRun | undefined> {
    return (await this.store.read()).runs.find((run) => run.tenderId === tenderId);
  }

  async saveRun(run: TenderRun): Promise<void> {
    const state = await this.store.read();
    const index = state.runs.findIndex((item) => item.runId === run.runId);
    if (index === -1) state.runs.push(structuredClone(run));
    else state.runs[index] = structuredClone(run);
    await this.store.write(state);
  }

  async findHandoff(key: string): Promise<PricingHandoff | undefined> {
    return (await this.store.read()).handoffs.find((handoff) => handoff.handoffKey === key);
  }

  async saveHandoff(handoff: PricingHandoff): Promise<void> {
    const state = await this.store.read();
    if (!state.handoffs.some((item) => item.handoffKey === handoff.handoffKey)) {
      state.handoffs.push(structuredClone(handoff));
      await this.store.write(state);
    }
  }

  async findInformationRequestReceipt(key: string): Promise<InformationRequestReceipt | undefined> {
    return (await this.store.read()).informationRequestReceipts?.find(
      (receipt) => receipt.key === key,
    );
  }

  async saveInformationRequestReceipt(receipt: InformationRequestReceipt): Promise<void> {
    const state = await this.store.read();
    const receipts = state.informationRequestReceipts ?? [];
    if (!receipts.some((item) => item.key === receipt.key)) {
      state.informationRequestReceipts = [...receipts, structuredClone(receipt)];
      await this.store.write(state);
    }
  }

  async snapshot(): Promise<LocalState> {
    return this.store.read();
  }

  async replaceState(state: LocalState): Promise<void> {
    await this.store.write(state);
  }
}

class InterruptOnCompletionRepository extends MemoryRepository {
  private interrupt = true;

  override async saveRun(run: TenderRun): Promise<void> {
    if (this.interrupt && run.status === 'COMPLETED') {
      this.interrupt = false;
      throw new Error('simulated interruption before completion was persisted');
    }
    await super.saveRun(run);
  }
}

class WriteFailureRepository extends MemoryRepository {
  override async saveRun(): Promise<void> {
    throw new Error('synthetic secret should never be logged');
  }
}

class ReadFailureRepository extends MemoryRepository {
  override async findRunByIdempotencyKey(): Promise<TenderRun | undefined> {
    throw new Error('synthetic read details');
  }
}

const servers: Server[] = [];
afterEach(async () => {
  await Promise.all(
    servers.splice(0).map(
      (server) =>
        new Promise<void>((resolve, reject) => {
          server.close((error) => (error ? reject(error) : resolve()));
        }),
    ),
  );
});

describe('POST /tenders', () => {
  it('evaluates a clean tender and creates one pricing handoff', async () => {
    const repository = new MemoryRepository();
    const { response, body } = await postTender(repository, cleanTender);

    expect(response.status).toBe(200);
    expect(body.status).toBe('COMPLETED');
    expect(body.route).toBe('READY_FOR_PRICING');
    expect(body.rules).toHaveLength(12);
    expect((await repository.snapshot()).handoffs).toHaveLength(1);
  });

  it('does not call pricing for a non-ready tender', async () => {
    const repository = new MemoryRepository();
    const { response, body } = await postTender(repository, missingConsumptionTender);
    const state = await repository.snapshot();

    expect(response.status).toBe(200);
    expect(body.route).toBe('NEEDS_INFORMATION');
    expect(state.handoffs).toHaveLength(0);
    expect(state.informationRequestReceipts).toEqual([
      expect.objectContaining({
        key: `information-request:${body.runId}`,
        route: 'NEEDS_INFORMATION',
        synthetic: true,
        deliveryStatus: 'NOT_SENT',
      }),
    ]);
  });

  it('does not call pricing for a tender routed to human review', async () => {
    const repository = new MemoryRepository();
    const { body } = await postTender(repository, conflictingDatesTender);

    expect(body.route).toBe('HUMAN_REVIEW');
    expect((await repository.snapshot()).handoffs).toHaveLength(0);
  });

  it('keeps a required pending document in PROCESSING without a route', async () => {
    const repository = new MemoryRepository();
    const pending = structuredClone(cleanTender);
    pending.tender.documents = [
      {
        documentId: 'document-required-001',
        fileName: 'contract.pdf',
        contentType: 'application/pdf',
        required: true,
        processingStatus: 'PENDING',
      },
    ];
    const { response, body } = await postTender(repository, pending);

    expect(response.status).toBe(202);
    expect(body.status).toBe('PROCESSING');
    expect(body.route).toBeUndefined();
    expect((await repository.snapshot()).handoffs).toHaveLength(0);
  });

  it('returns the prior result on replay and rejects a changed payload under the same key', async () => {
    const repository = new MemoryRepository();
    await postTender(repository, cleanTender);
    const replay = await postTender(repository, cleanTender);
    const changed = structuredClone(cleanTender);
    changed.tender.sites[0]!.annualConsumptionKwh = 26000;
    const conflict = await postTender(repository, changed);

    expect(replay.response.status).toBe(200);
    expect(replay.body.replayed).toBe(true);
    expect(replay.body.correlationId).toBe(replay.response.headers.get('x-correlation-id'));
    expect(conflict.response.status).toBe(409);
    expect((await repository.snapshot()).handoffs).toHaveLength(1);
  });

  it('resumes an interrupted run and completes its pricing handoff on replay', async () => {
    const repository = new InterruptOnCompletionRepository();
    const pricingGateway = new CountingPricingGateway(repository);
    const service = new TenderService(repository, pricingGateway);

    await expect(service.submit(cleanTender, 'correlation-first')).rejects.toMatchObject({
      failure: { code: 'STATE_WRITE_FAILED' },
    });
    const replay = await service.submit(cleanTender, 'correlation-replay');

    expect(replay.replayed).toBe(true);
    expect(replay.status).toBe('COMPLETED');
    expect(replay.route).toBe('READY_FOR_PRICING');
    expect((await repository.snapshot()).handoffs).toHaveLength(1);
  });

  it('reconciles a ready run whose handoff was not recorded before interruption', async () => {
    const repository = new MemoryRepository();
    await postTender(repository, cleanTender);
    const state = await repository.snapshot();
    state.handoffs = [];
    await repository.replaceState(state);

    const replay = await postTender(repository, cleanTender);

    expect(replay.body.replayed).toBe(true);
    expect(replay.body.route).toBe('READY_FOR_PRICING');
    expect((await repository.snapshot()).handoffs).toHaveLength(1);
  });

  it('routes a repeated tender ID with a new key to DUPLICATE', async () => {
    const repository = new MemoryRepository();
    await postTender(repository, cleanTender);
    const repeated = structuredClone(cleanTender);
    repeated.tender.idempotencyKey = 'different-intake-key';
    const { body } = await postTender(repository, repeated);

    expect(body.route).toBe('DUPLICATE');
    expect((await repository.snapshot()).handoffs).toHaveLength(1);
  });

  it('returns 400 for invalid JSON without persisting a run', async () => {
    const repository = new MemoryRepository();
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const server = await listen(repository);
    const response = await fetch(`${baseUrl(server)}/tenders`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{',
    });

    expect(response.status).toBe(400);
    expect((await repository.snapshot()).runs).toHaveLength(0);
    expect(JSON.parse(String(error.mock.calls.at(-1)?.[0]))).toMatchObject({
      event: 'tender.operation_failed',
      failureCode: 'API_TRANSPORT_FAILED',
      failureStage: 'API_TRANSPORT',
      retryable: false,
      attempt: 1,
    });
    error.mockRestore();
  });

  it('serializes safe, correlated state-write failure logs', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const repository = new WriteFailureRepository();
    const server = await listen(repository);
    const requestBody = JSON.stringify({
      ...cleanTender,
      textSources: [{ sourceId: 'private-note', kind: 'NOTE', text: 'raw source secret' }],
    });
    const response = await fetch(`${baseUrl(server)}/tenders`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-correlation-id': 'correlation-state-write',
        authorization: 'Bearer api-key-secret',
      },
      body: requestBody,
    });
    const body = (await response.json()) as { failure?: { code: string; stage: string } };
    const log = JSON.parse(String(error.mock.calls.at(-1)?.[0])) as Record<string, unknown>;

    expect(response.status).toBe(500);
    expect(body.failure).toMatchObject({ code: 'STATE_WRITE_FAILED', stage: 'STATE_WRITE' });
    expect(log).toMatchObject({
      event: 'tender.operation_failed',
      correlationId: 'correlation-state-write',
      failureCode: 'STATE_WRITE_FAILED',
      failureStage: 'STATE_WRITE',
      retryable: true,
      attempt: 1,
    });
    expect(log.timestamp).toEqual(expect.any(String));
    const serialized = JSON.stringify(log);
    expect(serialized).not.toContain('raw source secret');
    expect(serialized).not.toContain('api-key-secret');
    expect(serialized).not.toContain('synthetic secret');
    error.mockRestore();
  });

  it('distinguishes state-read failures at the API boundary', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const server = await listen(new ReadFailureRepository());
    const response = await fetch(`${baseUrl(server)}/tenders`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-correlation-id': 'correlation-state-read' },
      body: JSON.stringify(cleanTender),
    });
    const body = (await response.json()) as { failure?: { code: string; stage: string } };
    const log = JSON.parse(String(error.mock.calls.at(-1)?.[0])) as Record<string, unknown>;

    expect(body.failure).toMatchObject({ code: 'STATE_READ_FAILED', stage: 'STATE_READ' });
    expect(log).toMatchObject({
      correlationId: 'correlation-state-read',
      failureCode: 'STATE_READ_FAILED',
      failureStage: 'STATE_READ',
      retryable: true,
    });
    error.mockRestore();
  });

  it('keeps READY_FOR_PRICING and returns failure status when the gateway fails, including replay', async () => {
    const repository = new MemoryRepository();
    const failedGateway: PricingGateway = {
      async submit() {
        throw new Error('simulated gateway failure');
      },
    };
    const server = createTenderServer(new TenderService(repository, failedGateway));
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const submit = () =>
      fetch(`${baseUrl(server)}/tenders`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(cleanTender),
      });
    const response = await submit();
    const body = (await response.json()) as {
      status: string;
      route?: string;
      failure?: { code: string };
    };
    const saved = (await repository.snapshot()).runs[0];

    expect(response.status).toBe(502);
    expect(body.status).toBe('FAILED');
    expect(body.route).toBe('READY_FOR_PRICING');
    expect(body.failure?.code).toBe('PRICING_GATEWAY_FAILED');
    expect(saved?.route).toBe('READY_FOR_PRICING');
    expect(saved?.status).toBe('FAILED');

    const replay = await submit();
    const replayBody = (await replay.json()) as { status: string; replayed: boolean };
    expect(replay.status).toBe(502);
    expect(replayBody.status).toBe('FAILED');
    expect(replayBody.replayed).toBe(true);
  });
});

describe('POST /tenders/:runId/reviews', () => {
  it('rejects review of a ready case without changing the pricing handoff', async () => {
    const store = new MemoryStore();
    const repository = new JsonFileTenderRepository(store);
    const service = new TenderService(repository, new CountingPricingGateway(repository));
    const server = createTenderServer(service, true);
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));

    const intakeResponse = await fetch(baseUrl(server) + '/tenders', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(cleanTender),
    });
    const intake = (await intakeResponse.json()) as { runId: string; route: string };
    expect(intake.route).toBe('READY_FOR_PRICING');
    expect((await store.read()).handoffs).toHaveLength(1);

    const reviewResponse = await fetch(baseUrl(server) + '/tenders/' + intake.runId + '/reviews', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        requestId: 'review-ready-case',
        action: 'REQUEST_INFORMATION',
        reason: 'Should not be accepted for a ready case.',
        sourceIds: [],
        expectedVersion: 0,
      }),
    });
    expect(reviewResponse.status).toBe(409);
    expect((await store.read()).reviewEvents).toHaveLength(0);
    expect((await store.read()).handoffs).toHaveLength(1);
  });

  it('accepts known rule evidence, persists the decision, and rejects unknown sources', async () => {
    const store = new MemoryStore();
    const repository = new JsonFileTenderRepository(store);
    const service = new TenderService(repository, new CountingPricingGateway(repository));
    const server = createTenderServer(service, true);
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));

    const intakeResponse = await fetch(baseUrl(server) + '/tenders', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(conflictingDatesTender),
    });
    const intake = (await intakeResponse.json()) as { runId: string; route: string };
    expect(intakeResponse.status).toBe(200);
    expect(intake.route).toBe('HUMAN_REVIEW');

    const reviewUrl = baseUrl(server) + '/tenders/' + intake.runId + '/reviews';
    const submitReview = (
      sourceIds: string[],
      requestId: string,
      expectedVersion: number,
      action: 'REQUEST_INFORMATION' | 'REOPEN' = 'REQUEST_INFORMATION',
    ) =>
      fetch(reviewUrl, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          requestId,
          action,
          reason: 'Conflicting contract end dates require confirmation.',
          sourceIds,
          expectedVersion,
        }),
      });

    const unknown = await submitReview(['unrelated-source'], 'review-unknown', 0);
    expect(unknown.status).toBe(400);
    expect((await unknown.json()) as { error: string }).toMatchObject({
      error: 'UNKNOWN_REVIEW_EVIDENCE_SOURCE',
    });
    expect((await store.read()).reviewEvents).toHaveLength(0);

    const accepted = await submitReview(['contract-a', 'contract-b'], 'review-accepted', 0);
    const decision = (await accepted.json()) as {
      event: { eventId: string; sourceIds: string[] };
      reviewVersion: number;
      reviewState: string;
    };
    expect(accepted.status).toBe(200);
    expect(decision.event.sourceIds).toEqual(['contract-a', 'contract-b']);
    expect(decision.reviewVersion).toBe(1);
    expect(decision.reviewState).toBe('RESOLVED');

    const detailResponse = await fetch(baseUrl(server) + '/tenders/' + intake.runId);
    const detail = (await detailResponse.json()) as {
      run: { route: string };
      reviewEvents: { eventId: string; sourceIds: string[] }[];
      reviewVersion: number;
    };
    expect(detailResponse.status).toBe(200);
    expect(detail.run.route).toBe('HUMAN_REVIEW');
    expect(detail.reviewEvents).toEqual([decision.event]);
    expect(detail.reviewVersion).toBe(1);
    expect((await store.read()).handoffs).toHaveLength(0);

    const replay = await submitReview(['contract-a', 'contract-b'], 'review-accepted', 0);
    const replayBody = (await replay.json()) as { event: { eventId: string } };
    expect(replay.status).toBe(200);
    expect(replayBody.event.eventId).toBe(decision.event.eventId);
    expect((await store.read()).reviewEvents).toHaveLength(1);

    const stale = await submitReview(['contract-a'], 'review-stale', 0);
    expect(stale.status).toBe(409);
    expect((await store.read()).reviewEvents).toHaveLength(1);

    const reopened = await submitReview([], 'review-reopen', 1, 'REOPEN');
    expect(reopened.status).toBe(200);
    expect((await reopened.json()) as { reviewState: string; reviewVersion: number }).toMatchObject(
      {
        reviewState: 'OPEN',
        reviewVersion: 2,
      },
    );

    const replayAfterReopen = await submitReview(
      ['contract-a', 'contract-b'],
      'review-accepted',
      0,
    );
    expect(replayAfterReopen.status).toBe(200);
    expect(
      (await replayAfterReopen.json()) as { reviewState: string; reviewVersion: number },
    ).toMatchObject({
      reviewState: 'OPEN',
      reviewVersion: 2,
    });
    expect((await store.read()).reviewEvents.map((event) => event.action)).toEqual([
      'REQUEST_INFORMATION',
      'REOPEN',
    ]);
  });
});

async function postTender(repository: MemoryRepository, input: unknown) {
  const server = await listen(repository);
  const response = await fetch(`${baseUrl(server)}/tenders`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(input),
  });
  return { response, body: (await response.json()) as Record<string, unknown> };
}

async function listen(repository: MemoryRepository): Promise<Server> {
  const service = new TenderService(repository, new CountingPricingGateway(repository));
  const server = createTenderServer(service);
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return server;
}

function baseUrl(server: Server): string {
  const address = server.address();
  if (!address || typeof address === 'string')
    throw new Error('Server did not bind to a TCP port.');
  return `http://127.0.0.1:${address.port}`;
}

class CountingPricingGateway implements PricingGateway {
  constructor(private readonly repository: TenderRepository) {}

  async submit(input: Parameters<PricingGateway['submit']>[0]): Promise<PricingHandoff> {
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
