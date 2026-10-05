import type { Server } from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import { cleanTender } from '../../../../tests/fixtures/tenders.js';
import type {
  InformationRequestReceipt,
  LocalState,
  PricingHandoff,
  TenderRun,
} from '../contracts.js';
import { MockPricingGateway } from '../pricing-gateway.js';
import type { LocalStateStore, TenderRepository } from '../repository.js';
import { createTenderServer } from '../server.js';
import { TenderService } from '../service.js';
import { buildIntakePackFixtureCatalog } from '../../../../scripts/intake-pack-fixtures.js';
import { MemoryIntakeOriginalsStore } from './originals-store.js';
import { MemoryIntakePackRepository } from './repository.js';
import { IntakePackService } from './service.js';

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
}

const servers: Server[] = [];
const catalog = buildIntakePackFixtureCatalog();

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

describe('Intake pack HTTP routes', () => {
  it('registers a clean fixture, extracts selectable text, and never calls pricing', async () => {
    const tenders = new MemoryRepository();
    const intake = new IntakePackService(
      new MemoryIntakePackRepository(),
      new MemoryIntakeOriginalsStore(),
    );
    const { origin } = await listen(tenders, intake);
    const spec = catalog.specs.find((item) => item.packId === 'pack-clean-single-site')!;

    const created = await fetch(`${origin}/intake-packs`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ synthetic: true }),
    });
    expect(created.status).toBe(201);
    const pack = (await created.json()) as { packId: string; draft?: unknown };
    expect(pack.draft).toBeUndefined();

    const pdf = spec.files.find((file) => file.kind === 'PDF')!;
    const uploaded = await fetch(`${origin}/intake-packs/${pack.packId}/documents`, {
      method: 'POST',
      headers: {
        'content-type': 'application/pdf',
        'x-file-name': pdf.fileName,
      },
      body: Buffer.from(pdf.bytes),
    });
    expect(uploaded.status).toBe(201);

    const note = spec.files.find((file) => file.kind === 'NOTE')!;
    const noted = await fetch(`${origin}/intake-packs/${pack.packId}/notes`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text: note.bytes.toString('utf8') }),
    });
    expect(noted.status).toBe(200);

    const extracted = await fetch(`${origin}/intake-packs/${pack.packId}/extractions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    });
    expect(extracted.status).toBe(200);
    const extraction = (await extracted.json()) as {
      immutable: boolean;
      pages: Array<{ pageNumber: number; text: string }>;
    };
    expect(extraction.immutable).toBe(true);
    expect(extraction.pages[0]?.pageNumber).toBe(1);
    expect(extraction.pages.some((page) => page.text.includes('Northstar Foods Ltd'))).toBe(true);

    const fetched = await fetch(`${origin}/intake-packs/${pack.packId}/extractions`);
    expect(fetched.status).toBe(200);
    expect((await tenders.snapshot()).handoffs).toHaveLength(0);
  });

  it('keeps a corrupt fixture document visible after extraction', async () => {
    const tenders = new MemoryRepository();
    const intake = new IntakePackService(
      new MemoryIntakePackRepository(),
      new MemoryIntakeOriginalsStore(),
    );
    const { origin } = await listen(tenders, intake);
    const spec = catalog.specs.find((item) => item.packId === 'pack-corrupt')!;
    const created = await fetch(`${origin}/intake-packs`, { method: 'POST' });
    const pack = (await created.json()) as { packId: string };
    const pdf = spec.files.find((file) => file.kind === 'PDF')!;
    await fetch(`${origin}/intake-packs/${pack.packId}/documents`, {
      method: 'POST',
      headers: { 'content-type': 'application/pdf', 'x-file-name': pdf.fileName },
      body: Buffer.from(pdf.bytes),
    });
    const extracted = await fetch(`${origin}/intake-packs/${pack.packId}/extractions`, {
      method: 'POST',
    });
    expect(extracted.status).toBe(200);
    const current = await fetch(`${origin}/intake-packs/${pack.packId}`);
    const body = (await current.json()) as {
      documents: Array<{ status: string; failure?: { code: string } }>;
      draft?: unknown;
    };
    expect(body.documents).toHaveLength(1);
    expect(body.documents[0]?.status).toBe('CORRUPT');
    expect(body.documents[0]?.failure?.code).toBe('CORRUPT');
    expect(body.draft).toBeUndefined();
  });

  it('prepares a review-only draft over HTTP without calling pricing or readiness', async () => {
    const tenders = new MemoryRepository();
    const intake = new IntakePackService(
      new MemoryIntakePackRepository(),
      new MemoryIntakeOriginalsStore(),
    );
    const { origin } = await listen(tenders, intake);
    const spec = catalog.specs.find((item) => item.packId === 'pack-conflicting-evidence')!;
    const created = await fetch(`${origin}/intake-packs`, { method: 'POST' });
    const pack = (await created.json()) as { packId: string };
    for (const file of spec.files) {
      if (file.kind === 'NOTE') {
        await fetch(`${origin}/intake-packs/${pack.packId}/notes`, {
          method: 'PUT',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ text: file.bytes.toString('utf8') }),
        });
        continue;
      }
      await fetch(`${origin}/intake-packs/${pack.packId}/documents`, {
        method: 'POST',
        headers: { 'content-type': 'application/pdf', 'x-file-name': file.fileName },
        body: Buffer.from(file.bytes),
      });
    }
    await fetch(`${origin}/intake-packs/${pack.packId}/extractions`, { method: 'POST' });

    const missing = await fetch(`${origin}/intake-packs/unknown-pack/draft`);
    expect(missing.status).toBe(404);

    const drafted = await fetch(`${origin}/intake-packs/${pack.packId}/draft`);
    expect(drafted.status).toBe(200);
    const draft = (await drafted.json()) as {
      draftVersion: number;
      customer: Record<string, unknown>;
      broker: Record<string, unknown>;
      sites: unknown[];
      candidates: Array<{
        field: string;
        value: string;
        associationStatus: string;
        siteId?: string | null;
        accepted: boolean;
        provenance: Array<{ sourceKind: string; pageNumber?: number; quote: string }>;
      }>;
    };
    expect(draft.draftVersion).toBe(1);
    expect(draft.customer).toEqual({});
    expect(draft.broker).toEqual({});
    expect(draft.sites).toEqual([]);
    expect(
      draft.candidates
        .filter((candidate) => candidate.field === 'contractEndDate')
        .map((candidate) => candidate.value),
    ).toEqual(expect.arrayContaining(['2027-03-31', '30/09/2026']));
    expect(draft.candidates[0]?.provenance[0]?.quote.length).toBeGreaterThan(0);

    const patched = await fetch(`${origin}/intake-packs/${pack.packId}/draft`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        expectedDraftVersion: 1,
        acceptedCandidateIds: [],
        fieldEdits: {},
      }),
    });
    expect(patched.status).toBe(200);
    expect(((await patched.json()) as { draftVersion: number }).draftVersion).toBe(2);

    const confirm = await fetch(`${origin}/intake-packs/${pack.packId}/confirm`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ expectedDraftVersion: 2, idempotencyKey: 'should-not-confirm' }),
    });
    expect(confirm.status).toBe(404);
    expect((await tenders.snapshot()).handoffs).toHaveLength(0);
    expect((await tenders.snapshot()).runs).toHaveLength(0);
  });

  it('does not treat intake-pack extraction as a tender pricing submission', async () => {
    const tenders = new MemoryRepository();
    const { origin } = await listen(
      tenders,
      new IntakePackService(new MemoryIntakePackRepository(), new MemoryIntakeOriginalsStore()),
    );
    const created = await fetch(`${origin}/intake-packs`, { method: 'POST' });
    expect(created.status).toBe(201);
    const tender = await fetch(`${origin}/tenders`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(cleanTender),
    });
    expect(tender.status).toBe(200);
    expect((await tenders.snapshot()).handoffs).toHaveLength(1);
  });
});

async function listen(
  repository: MemoryRepository,
  intake: IntakePackService,
): Promise<{ origin: string }> {
  const service = new TenderService(repository, new MockPricingGateway(repository));
  const server = createTenderServer(service, false, intake);
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string')
    throw new Error('Server did not bind to a TCP port.');
  return { origin: `http://127.0.0.1:${address.port}` };
}
