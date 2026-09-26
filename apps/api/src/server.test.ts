import type { Server } from 'node:http';
import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { cleanTender, missingConsumptionTender } from '../../../tests/fixtures/tenders.js';
import type { LocalState, PricingHandoff, TenderRun } from './contracts.js';
import { createTenderServer } from './server.js';
import type { PricingGateway } from './pricing-gateway.js';
import type { LocalStateStore, TenderRepository } from './repository.js';
import { TenderService } from './service.js';

class MemoryStore implements LocalStateStore {
  state: LocalState = { version: 1, runs: [], handoffs: [] };

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

  async snapshot(): Promise<LocalState> {
    return this.store.read();
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

    expect(response.status).toBe(200);
    expect(body.route).toBe('NEEDS_INFORMATION');
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
    const server = await listen(repository);
    const response = await fetch(`${baseUrl(server)}/tenders`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{',
    });

    expect(response.status).toBe(400);
    expect((await repository.snapshot()).runs).toHaveLength(0);
  });

  it('keeps READY_FOR_PRICING when the mock gateway fails', async () => {
    const repository = new MemoryRepository();
    const failedGateway: PricingGateway = {
      async submit() {
        throw new Error('simulated gateway failure');
      },
    };
    const server = createTenderServer(new TenderService(repository, failedGateway));
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const response = await fetch(`${baseUrl(server)}/tenders`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(cleanTender),
    });
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

