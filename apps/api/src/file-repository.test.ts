import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { cleanTender } from '../../../tests/fixtures/tenders.js';
import type { LocalState } from './contracts.js';
import type { LocalStateStore } from './repository.js';
import { FileStateStore, JsonFileTenderRepository } from './file-repository.js';
import { MockPricingGateway } from './pricing-gateway.js';
import { TenderService } from './service.js';

let directory: string;
let statePath: string;

class InterruptOnCompletionStore implements LocalStateStore {
  private interrupted = false;

  constructor(private readonly store: LocalStateStore) {}

  read(): Promise<LocalState> {
    return this.store.read();
  }

  async write(state: LocalState): Promise<void> {
    if (!this.interrupted && state.runs.some((run) => run.status === 'COMPLETED')) {
      this.interrupted = true;
      throw new Error('simulated interruption before completion was persisted');
    }
    await this.store.write(state);
  }
}

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'tender-readiness-api-'));
  statePath = join(directory, 'state.json');
});

afterEach(async () => {
  await rm(directory, { recursive: true, force: true });
});

describe('JsonFileTenderRepository', () => {
  it('persists decisions and handoffs across repository instances', async () => {
    const firstRepository = createRepository();
    const firstService = new TenderService(
      firstRepository,
      new MockPricingGateway(firstRepository),
    );
    const firstResult = await firstService.submit(cleanTender, 'correlation-first');

    const secondRepository = createRepository();
    const secondService = new TenderService(
      secondRepository,
      new MockPricingGateway(secondRepository),
    );
    const replay = await secondService.submit(cleanTender, 'correlation-replay');
    const state = await new FileStateStore(statePath).read();

    expect(firstResult.route).toBe('READY_FOR_PRICING');
    expect(replay.replayed).toBe(true);
    expect(replay.correlationId).toBe('correlation-replay');
    expect(state.runs).toHaveLength(1);
    expect(state.handoffs).toHaveLength(1);
  });

  it('reads Milestone 2 state with long IDs and no textSources field', async () => {
    const longId = 's'.repeat(129);
    const legacy = {
      ...cleanTender,
      tender: {
        ...cleanTender.tender,
        sites: [{ ...cleanTender.tender.sites[0], siteId: longId }],
        documents: [
          { documentId: longId, fileName: 'legacy-a.pdf', contentType: 'application/pdf' },
          { documentId: longId, fileName: 'legacy-b.pdf', contentType: 'application/pdf' },
        ],
      },
    };
    const repository = createRepository();
    await new TenderService(repository, new MockPricingGateway(repository)).submit(
      legacy,
      'correlation-legacy',
    );
    const stored = JSON.parse(await readFile(statePath, 'utf8')) as {
      runs: { input: { textSources?: unknown } }[];
    };
    delete stored.runs[0]!.input.textSources;
    await writeFile(statePath, JSON.stringify(stored));

    const restored = await new FileStateStore(statePath).read();
    expect(restored.runs[0]?.input.tender.sites[0]?.siteId).toBe(longId);
    expect(restored.runs[0]?.input.tender.documents[0]?.documentId).toBe(longId);
    expect(restored.runs[0]?.input.tender.documents).toHaveLength(2);
    expect(restored.runs[0]?.input.textSources).toEqual([]);
  });

  it('resumes an interrupted file-backed run after creating a new repository instance', async () => {
    const interruptedRepository = new JsonFileTenderRepository(
      new InterruptOnCompletionStore(new FileStateStore(statePath)),
    );
    const firstService = new TenderService(
      interruptedRepository,
      new MockPricingGateway(interruptedRepository),
    );

    await expect(firstService.submit(cleanTender, 'correlation-first')).rejects.toThrow(
      'simulated interruption',
    );

    const restartedRepository = createRepository();
    const restartedService = new TenderService(
      restartedRepository,
      new MockPricingGateway(restartedRepository),
    );
    const replay = await restartedService.submit(cleanTender, 'correlation-replay');
    const state = await new FileStateStore(statePath).read();

    expect(replay.replayed).toBe(true);
    expect(replay.status).toBe('COMPLETED');
    expect(replay.route).toBe('READY_FOR_PRICING');
    expect(state.runs).toHaveLength(1);
    expect(state.handoffs).toHaveLength(1);
  });

  it('rejects corrupted state instead of resetting it', async () => {
    const store = new FileStateStore(statePath);
    await store.write({ version: 1, runs: [], handoffs: [] });
    await writeFile(statePath, '{broken');

    await expect(store.read()).rejects.toThrow('Unable to read tender state');
  });

  it('rejects a non-ready route at the mocked pricing gateway boundary', async () => {
    const repository = createRepository();
    const gateway = new MockPricingGateway(repository);

    await expect(
      gateway.submit({
        tenderId: 'tender-not-ready',
        runId: randomUUID(),
        route: 'HUMAN_REVIEW',
        handoffKey: 'not-ready-handoff',
      }),
    ).rejects.toThrow('accepts READY_FOR_PRICING tenders only');
    expect((await new FileStateStore(statePath).read()).handoffs).toHaveLength(0);
  });
});

function createRepository(): JsonFileTenderRepository {
  return new JsonFileTenderRepository(new FileStateStore(statePath));
}
