import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { cleanTender } from '../../../tests/fixtures/tenders.js';
import { FileStateStore, JsonFileTenderRepository } from './file-repository.js';
import { MockPricingGateway } from './pricing-gateway.js';
import { TenderService } from './service.js';

let directory: string;
let statePath: string;

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

  it('rejects corrupted state instead of resetting it', async () => {
    const store = new FileStateStore(statePath);
    await store.write({ version: 1, runs: [], handoffs: [] });
    await writeFile(statePath, '{broken');

    await expect(store.read()).rejects.toThrow('Unable to read tender state');
  });
});

function createRepository(): JsonFileTenderRepository {
  return new JsonFileTenderRepository(new FileStateStore(statePath));
}
