import type { Server } from 'node:http';
import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { evaluateReadiness } from '../../../../packages/domain/src/index.js';
import { cleanTender } from '../../../../tests/fixtures/tenders.js';
import type {
  InformationRequestReceipt,
  IntakeRequest,
  LocalState,
  PricingHandoff,
  TenderRun,
} from '../contracts.js';
import { MockPricingGateway } from '../pricing-gateway.js';
import type { PricingGateway } from '../pricing-gateway.js';
import type { LocalStateStore, TenderRepository } from '../repository.js';
import { createTenderServer } from '../server.js';
import { TenderService } from '../service.js';
import type { TenderInterpreter } from '../reasoning/interpreter.js';
import { buildIntakePackFixtureCatalog } from '../../../../scripts/intake-pack-fixtures.js';
import { createIntakeConfirmationHandoff } from './confirmation-adapter.js';
import { MemoryIntakeOriginalsStore } from './originals-store.js';
import { parseSelectablePdf } from './pdf-parser.js';
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
    const gateway = new CountingGateway(tenders);
    const { origin } = await listenWired(tenders, gateway);
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

    const stale = await fetch(`${origin}/intake-packs/${pack.packId}/confirm`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ expectedDraftVersion: 1, idempotencyKey: `confirm:${pack.packId}` }),
    });
    expect(stale.status).toBe(409);
    expect(((await stale.json()) as { error: string }).error).toBe('DRAFT_STALE');
    expect(gateway.calls).toBe(0);
    expect((await tenders.snapshot()).handoffs).toHaveLength(0);
    expect((await tenders.snapshot()).runs).toHaveLength(0);

    const missingConfirmation = await fetch(`${origin}/intake-packs/${pack.packId}/confirmation`);
    expect(missingConfirmation.status).toBe(404);

    const confirm = await fetch(`${origin}/intake-packs/${pack.packId}/confirm`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ expectedDraftVersion: 2, idempotencyKey: `confirm:${pack.packId}` }),
    });
    expect(confirm.status).toBe(200);
    const confirmed = (await confirm.json()) as {
      packId: string;
      tenderId: string;
      runId: string;
      confirmation: {
        actor: string;
        draftVersion: number;
        submission: { tender: { customer: { legalName?: string } } };
      };
    };
    expect(confirmed.packId).toBe(pack.packId);
    expect(confirmed.runId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
    );
    expect(confirmed.confirmation.actor).toBe('local-demo-operator');
    expect(confirmed.confirmation.draftVersion).toBe(2);
    expect(confirmed.confirmation.submission.tender.customer.legalName ?? '').toBe('');
    const snapshot = await tenders.snapshot();
    expect(snapshot.runs).toHaveLength(1);
    expect(snapshot.runs[0]?.route).toBeDefined();
    expect(snapshot.runs[0]?.route).not.toBe('READY_FOR_PRICING');
    expect(snapshot.handoffs).toHaveLength(0);
    expect(gateway.calls).toBe(0);

    const replay = await fetch(`${origin}/intake-packs/${pack.packId}/confirm`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ expectedDraftVersion: 2, idempotencyKey: `confirm:${pack.packId}` }),
    });
    expect(replay.status).toBe(200);
    const replayed = (await replay.json()) as { tenderId: string; runId: string };
    expect(replayed.tenderId).toBe(confirmed.tenderId);
    expect(replayed.runId).toBe(confirmed.runId);
    expect((await tenders.snapshot()).runs).toHaveLength(1);
    expect((await tenders.snapshot()).handoffs).toHaveLength(0);
    expect(gateway.calls).toBe(0);

    const stored = await fetch(`${origin}/intake-packs/${pack.packId}/confirmation`);
    expect(stored.status).toBe(200);
    expect(((await stored.json()) as { tenderId: string }).tenderId).toBe(confirmed.tenderId);
  });

  it('confirms a complete operator-edited draft without forcing READY_FOR_PRICING or calling pricing', async () => {
    const tenders = new MemoryRepository();
    const gateway = new CountingGateway(tenders);
    const { origin, intake } = await listenWired(tenders, gateway);
    const created = await intake.createPack();
    await registerHttpFixture(origin, created.packId, 'pack-clean-single-site');
    await fetch(`${origin}/intake-packs/${created.packId}/extractions`, { method: 'POST' });
    const drafted = await fetch(`${origin}/intake-packs/${created.packId}/draft`);
    expect(drafted.status).toBe(200);
    expect(gateway.calls).toBe(0);

    const patched = await fetch(`${origin}/intake-packs/${created.packId}/draft`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        expectedDraftVersion: 1,
        fieldEdits: {
          customerLegalName: 'Northstar Foods Ltd',
          brokerLegalName: 'Harbour Energy Partners',
          sites: [
            {
              siteId: 'site-warehouse',
              address: '10 Example Street, London',
              meterIdentifier: '1234567890123',
              annualConsumptionKwh: 24000,
              contractEndDate: '2027-03-31',
            },
          ],
        },
      }),
    });
    expect(patched.status).toBe(200);
    expect(gateway.calls).toBe(0);

    const spoofed = await fetch(`${origin}/intake-packs/${created.packId}/confirm`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        expectedDraftVersion: 2,
        idempotencyKey: `confirm:${created.packId}`,
        actor: 'spoofed-operator',
      }),
    });
    expect(spoofed.status).toBe(400);
    expect(gateway.calls).toBe(0);

    const confirm = await fetch(`${origin}/intake-packs/${created.packId}/confirm`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        expectedDraftVersion: 2,
        idempotencyKey: `confirm:${created.packId}`,
      }),
    });
    expect(confirm.status).toBe(200);
    const confirmed = (await confirm.json()) as {
      tenderId: string;
      runId: string;
      confirmation: { submission: Parameters<typeof evaluateReadiness>[0] };
    };
    expect(evaluateReadiness(confirmed.confirmation.submission).route).toBe('READY_FOR_PRICING');
    const snapshot = await tenders.snapshot();
    expect(snapshot.runs).toHaveLength(1);
    expect(snapshot.runs[0]?.runId).toBe(confirmed.runId);
    expect(snapshot.runs[0]?.route).not.toBe('READY_FOR_PRICING');
    expect(snapshot.handoffs).toHaveLength(0);
    expect(gateway.calls).toBe(0);

    const replay = await fetch(`${origin}/intake-packs/${created.packId}/confirm`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        expectedDraftVersion: 2,
        idempotencyKey: `confirm:${created.packId}`,
      }),
    });
    expect(replay.status).toBe(200);
    expect(((await replay.json()) as { runId: string }).runId).toBe(confirmed.runId);
    expect((await tenders.snapshot()).runs).toHaveLength(1);
    expect((await tenders.snapshot()).handoffs).toHaveLength(0);
    expect(gateway.calls).toBe(0);
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
  gateway: PricingGateway = new MockPricingGateway(repository),
  interpreter?: TenderInterpreter,
): Promise<{ origin: string }> {
  const service = new TenderService(repository, gateway, undefined, interpreter);
  const server = createTenderServer(service, false, intake);
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string')
    throw new Error('Server did not bind to a TCP port.');
  return { origin: `http://127.0.0.1:${address.port}` };
}

async function listenWired(
  repository: MemoryRepository,
  gateway: CountingGateway,
): Promise<{ origin: string; intake: IntakePackService; tenderService: TenderService }> {
  const tenderService = new TenderService(repository, gateway, undefined, new EmptyInterpreter());
  const intake = new IntakePackService(
    new MemoryIntakePackRepository(),
    new MemoryIntakeOriginalsStore(),
    () => new Date(),
    parseSelectablePdf,
    createIntakeConfirmationHandoff(tenderService),
  );
  const origin = (await listen(repository, intake, gateway, new EmptyInterpreter())).origin;
  return { origin, intake, tenderService };
}

async function registerHttpFixture(
  origin: string,
  packId: string,
  fixturePackId: string,
): Promise<void> {
  const spec = catalog.specs.find((item) => item.packId === fixturePackId);
  if (!spec) throw new Error(`Missing fixture pack ${fixturePackId}`);
  for (const file of spec.files) {
    if (file.kind === 'NOTE') {
      await fetch(`${origin}/intake-packs/${packId}/notes`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ text: file.bytes.toString('utf8') }),
      });
      continue;
    }
    await fetch(`${origin}/intake-packs/${packId}/documents`, {
      method: 'POST',
      headers: { 'content-type': 'application/pdf', 'x-file-name': file.fileName },
      body: Buffer.from(file.bytes),
    });
  }
}

class CountingGateway implements PricingGateway {
  calls = 0;
  private readonly inner: MockPricingGateway;

  constructor(repository: MemoryRepository) {
    this.inner = new MockPricingGateway(repository);
  }

  async submit(input: {
    tenderId: string;
    runId: string;
    route: PricingHandoff['route'];
    handoffKey: string;
  }): Promise<PricingHandoff> {
    this.calls += 1;
    return this.inner.submit(input);
  }
}

class EmptyInterpreter implements TenderInterpreter {
  readonly model = 'empty-test-model';

  async interpret(request: IntakeRequest, traceId = randomUUID()) {
    return {
      output: {
        summary: 'No additional interpreted facts.',
        sourceAssessments: request.textSources.map((source) => ({
          sourceId: source.sourceId,
          relevance: 'NO_RELEVANT_FACTS' as const,
          confidence: 1,
          ambiguous: false,
          explanation: 'Test interpreter does not extract facts from confirmation text.',
          evidence: [
            {
              sourceId: source.sourceId,
              quote: source.text.trim().slice(0, 80) || source.text.slice(0, 80),
            },
          ],
        })),
        observations: [],
        siteAssociations: [],
        conflicts: [],
      },
      trace: {
        traceId,
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
