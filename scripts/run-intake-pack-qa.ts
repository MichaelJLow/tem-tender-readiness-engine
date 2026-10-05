import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { buildIntakePackFixtureCatalog } from './intake-pack-fixtures.js';
import { cleanTender } from '../tests/fixtures/tenders.js';

const api = (process.env.TENDER_API_URL ?? 'http://127.0.0.1:3000').replace(/\/$/, '');
const catalog = buildIntakePackFixtureCatalog();

type JsonPayload = Record<string, unknown>;

type Candidate = {
  field?: string;
  value?: string;
  siteId?: string | null;
};

type Site = {
  siteId?: string;
  meterIdentifier?: string;
};

const evidence: {
  startedAt: string;
  finishedAt?: string;
  synthetic: true;
  api: string;
  cases: JsonPayload[];
  snapshot?: JsonPayload;
} = {
  startedAt: new Date().toISOString(),
  synthetic: true,
  api,
  cases: [],
};

async function json(response: Response): Promise<{ status: number; payload: JsonPayload }> {
  return { status: response.status, payload: (await response.json()) as JsonPayload };
}

async function createPack(): Promise<{ status: number; payload: JsonPayload }> {
  return json(
    await fetch(`${api}/intake-packs`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ synthetic: true }),
    }),
  );
}

async function registerFixture(packId: string, fixturePackId: string): Promise<void> {
  const spec = catalog.specs.find((item) => item.packId === fixturePackId);
  if (!spec) throw new Error(`Missing fixture ${fixturePackId}`);
  for (const file of spec.files) {
    if (file.kind === 'NOTE') {
      await fetch(`${api}/intake-packs/${packId}/notes`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ text: file.bytes.toString('utf8') }),
      });
      continue;
    }
    await fetch(`${api}/intake-packs/${packId}/documents`, {
      method: 'POST',
      headers: {
        'content-type': 'application/pdf',
        'x-file-name': file.fileName,
      },
      body: Buffer.from(file.bytes),
    });
  }
}

async function confirmRunFields(runId: unknown): Promise<{
  runStatus?: unknown;
  runRoute?: unknown;
  failureCode?: unknown;
}> {
  if (typeof runId !== 'string' || runId.length === 0) return {};
  const detail = await json(await fetch(`${api}/tenders/${runId}`));
  const run = (detail.payload.run as JsonPayload | undefined) ?? detail.payload;
  const failure = run.failure as { code?: string } | null | undefined;
  return {
    runStatus: run.status,
    runRoute: run.route ?? null,
    failureCode: failure?.code,
  };
}

async function snapshot(): Promise<JsonPayload> {
  const tenders = await json(await fetch(`${api}/tenders`));
  const items = Array.isArray(tenders.payload.items)
    ? (tenders.payload.items as Array<JsonPayload>)
    : [];
  const statePath = process.env.TENDER_STATE_PATH;
  let handoffCount = 0;
  if (statePath) {
    const state = JSON.parse(await readFile(statePath, 'utf8')) as {
      handoffs?: unknown[];
    };
    handoffCount = state.handoffs?.length ?? 0;
  }
  return {
    runCount: items.length,
    routes: items.map((item) => ({
      tenderId: item.tenderId,
      route: item.route,
      status: item.status,
    })),
    handoffCount,
  };
}

const emptyDraft = await createPack();
const emptyPackId = String(emptyDraft.payload.packId);
await registerFixture(emptyPackId, 'pack-clean-single-site');
await fetch(`${api}/intake-packs/${emptyPackId}/extractions`, { method: 'POST' });
const emptyPrepared = await json(await fetch(`${api}/intake-packs/${emptyPackId}/draft`));
const emptyConfirm = await json(
  await fetch(`${api}/intake-packs/${emptyPackId}/confirm`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      expectedDraftVersion: emptyPrepared.payload.draftVersion,
      idempotencyKey: `confirm:${emptyPackId}`,
    }),
  }),
);
const emptyConfirmation = emptyConfirm.payload.confirmation as JsonPayload | undefined;
const emptySubmission = emptyConfirmation?.submission as JsonPayload | undefined;
const emptyTender = emptySubmission?.tender as JsonPayload | undefined;
const emptyCustomer = emptyTender?.customer as JsonPayload | undefined;
evidence.cases.push({
  id: 'empty-draft-confirm',
  packId: emptyPackId,
  draftCustomer: emptyPrepared.payload.customer,
  confirmStatus: emptyConfirm.status,
  runId: emptyConfirm.payload.runId,
  confirmedLegalName: emptyCustomer?.legalName,
  ...(await confirmRunFields(emptyConfirm.payload.runId)),
});

const multi = await createPack();
const multiPackId = String(multi.payload.packId);
await registerFixture(multiPackId, 'pack-clean-multi-site');
await fetch(`${api}/intake-packs/${multiPackId}/extractions`, { method: 'POST' });
const multiDraft = await json(await fetch(`${api}/intake-packs/${multiPackId}/draft`));
const candidates = Array.isArray(multiDraft.payload.candidates)
  ? (multiDraft.payload.candidates as Candidate[])
  : [];
const warehouseMeters = candidates.filter(
  (candidate) => candidate.field === 'meterIdentifier' && candidate.value === '1234567890123',
);
const retailMeters = candidates.filter(
  (candidate) => candidate.field === 'meterIdentifier' && candidate.value === '2345678901234',
);
await fetch(`${api}/intake-packs/${multiPackId}/draft`, {
  method: 'PATCH',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({
    expectedDraftVersion: multiDraft.payload.draftVersion,
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
        {
          siteId: 'site-retail',
          address: '22 Harbour Lane, Manchester',
          meterIdentifier: '2345678901234',
          annualConsumptionKwh: 18500,
          contractEndDate: '2027-09-30',
        },
      ],
    },
  }),
});
const multiConfirm = await json(
  await fetch(`${api}/intake-packs/${multiPackId}/confirm`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      expectedDraftVersion: 2,
      idempotencyKey: `confirm:${multiPackId}`,
    }),
  }),
);
const multiConfirmation = multiConfirm.payload.confirmation as JsonPayload | undefined;
const multiSubmission = multiConfirmation?.submission as JsonPayload | undefined;
const multiTender = multiSubmission?.tender as JsonPayload | undefined;
const sites = Array.isArray(multiTender?.sites) ? (multiTender.sites as Site[]) : [];
evidence.cases.push({
  id: 'multi-site-no-leakage',
  packId: multiPackId,
  warehouseResolved: warehouseMeters.some((candidate) => candidate.siteId === 'site-warehouse'),
  retailResolved: retailMeters.some((candidate) => candidate.siteId === 'site-retail'),
  warehouseLeakedToRetail: warehouseMeters.some((candidate) => candidate.siteId === 'site-retail'),
  retailLeakedToWarehouse: retailMeters.some((candidate) => candidate.siteId === 'site-warehouse'),
  confirmedWarehouseMeter: sites.find((site) => site.siteId === 'site-warehouse')?.meterIdentifier,
  confirmedRetailMeter: sites.find((site) => site.siteId === 'site-retail')?.meterIdentifier,
  confirmStatus: multiConfirm.status,
  runId: multiConfirm.payload.runId,
  ...(await confirmRunFields(multiConfirm.payload.runId)),
});

const ocr = await createPack();
const ocrPackId = String(ocr.payload.packId);
await registerFixture(ocrPackId, 'pack-scanned-ocr-required');
const ocrExtract = await json(
  await fetch(`${api}/intake-packs/${ocrPackId}/extractions`, { method: 'POST' }),
);
const ocrPack = await json(await fetch(`${api}/intake-packs/${ocrPackId}`));
await fetch(`${api}/intake-packs/${ocrPackId}/draft`);
await fetch(`${api}/intake-packs/${ocrPackId}/draft`, {
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
const ocrConfirm = await json(
  await fetch(`${api}/intake-packs/${ocrPackId}/confirm`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      expectedDraftVersion: 2,
      idempotencyKey: `confirm:${ocrPackId}`,
    }),
  }),
);
const ocrDocuments = Array.isArray(ocrPack.payload.documents)
  ? (ocrPack.payload.documents as Array<{ status?: string }>)
  : [];
evidence.cases.push({
  id: 'ocr-required-visible',
  packId: ocrPackId,
  extractStatus: ocrExtract.status,
  documentStatuses: ocrDocuments.map((document) => document.status),
  confirmStatus: ocrConfirm.status,
  runId: ocrConfirm.payload.runId,
  ...(await confirmRunFields(ocrConfirm.payload.runId)),
});

const stale = await createPack();
const stalePackId = String(stale.payload.packId);
await registerFixture(stalePackId, 'pack-clean-single-site');
await fetch(`${api}/intake-packs/${stalePackId}/extractions`, { method: 'POST' });
await fetch(`${api}/intake-packs/${stalePackId}/draft`);
await fetch(`${api}/intake-packs/${stalePackId}/draft`, {
  method: 'PATCH',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({
    expectedDraftVersion: 1,
    fieldEdits: { customerLegalName: 'Northstar Foods Ltd' },
  }),
});
const staleConfirm = await json(
  await fetch(`${api}/intake-packs/${stalePackId}/confirm`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      expectedDraftVersion: 1,
      idempotencyKey: `confirm:${stalePackId}`,
    }),
  }),
);
evidence.cases.push({
  id: 'stale-confirm-rejected',
  packId: stalePackId,
  confirmStatus: staleConfirm.status,
  error: staleConfirm.payload.error,
});

const beforeReady = await snapshot();
const ready = await json(
  await fetch(`${api}/tenders`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-correlation-id': 'eng24-clean-tender' },
    body: JSON.stringify(cleanTender),
  }),
);
const afterReady = await snapshot();
evidence.cases.push({
  id: 'existing-ready-path-still-prices',
  readyStatus: ready.status,
  readyRoute: ready.payload.route,
  handoffsBeforeReadyTender: beforeReady.handoffCount,
  handoffsAfterReadyTender: afterReady.handoffCount,
});

evidence.finishedAt = new Date().toISOString();
evidence.snapshot = afterReady;

const out = join(process.cwd(), 'docs/release-qa/eng-24-intake-http-evidence.json');
await writeFile(out, `${JSON.stringify(evidence, null, 2)}\n`);
process.stdout.write(`${out}\n`);
