import { mkdir, readFile, writeFile } from 'node:fs/promises';
import {
  cleanTender,
  conflictingDatesTender,
  duplicateTender,
  missingConsumptionTender,
} from '../../tests/fixtures/tenders.ts';

const consoleApi = 'http://127.0.0.1:3000';
const extraApi = 'http://127.0.0.1:3002';
const evidence = {
  startedAt: new Date().toISOString(),
  sourceSha: '2e725d91c8aad75319a15630779c3420810e689c',
  synthetic: true,
  cases: [],
};

async function postTender(api, body, label) {
  const response = await fetch(`${api}/tenders`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-correlation-id': `eng14-${label}` },
    body: JSON.stringify(body),
  });
  return { status: response.status, payload: await response.json() };
}

async function getJson(url) {
  const response = await fetch(url);
  return { status: response.status, payload: await response.json() };
}

const queue = await getJson(`${consoleApi}/tenders`);
const evals = await getJson(`${consoleApi}/evals`);
evidence.consoleQueue = queue.payload.items.map((item) => ({
  tenderId: item.tenderId,
  route: item.route,
  status: item.status,
  reviewState: item.reviewState,
}));
evidence.evalOverview = {
  acceptedRunId: evals.payload.accepted?.runId,
  latestRunId: evals.payload.latest?.runId,
  latestSuiteStatus: evals.payload.latest?.suiteStatus,
  latestVerdict: evals.payload.latest?.verdict,
  acceptedUnsafeReady: evals.payload.accepted?.metrics?.unsafeReady,
  latestUnsafeReady: evals.payload.latest?.metrics?.unsafeReady,
  latestPricingGuard: evals.payload.latest?.metrics?.pricingGuard,
};

const conflict = queue.payload.items.find((item) => item.tenderId === 'tender-conflicting-dates');
const conflictDetail = await getJson(`${consoleApi}/tenders/${conflict.runId}`);
evidence.conflictDetail = {
  route: conflictDetail.payload.run.route,
  status: conflictDetail.payload.run.status,
  dateFacts: conflictDetail.payload.run.input.signals.dateFacts.map((fact) => ({
    siteId: fact.siteId,
    value: fact.value,
    sourceIds: fact.evidence.map((item) => item.sourceId),
  })),
  flaggedRules: conflictDetail.payload.run.result?.rules
    .filter((rule) => !rule.passed)
    .map((rule) => rule.ruleId),
  reviewEventsBefore: conflictDetail.payload.reviewEvents.length,
};

const review = await fetch(`${consoleApi}/tenders/${conflict.runId}/reviews`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({
    requestId: 'eng14-request-information-001',
    action: 'REQUEST_INFORMATION',
    reason:
      'Synthetic date conflict: site-001 and contract-a say 2027-03-31; contract-b says 30/09/2026. Request the original contract dates before any pricing handoff.',
    sourceIds: ['site-001', 'contract-a', 'contract-b'],
    expectedVersion: 0,
  }),
});
const reviewPayload = await review.json();
const afterReview = await getJson(`${consoleApi}/tenders/${conflict.runId}`);
evidence.reviewHistory = {
  httpStatus: review.status,
  action: reviewPayload.event?.action,
  sourceIds: reviewPayload.event?.sourceIds,
  reviewState: reviewPayload.reviewState,
  routeUnchanged: afterReview.payload.run.route === 'HUMAN_REVIEW',
  reviewEventCount: afterReview.payload.reviewEvents.length,
};

const replayClean = await postTender(consoleApi, cleanTender, 'clean-replay');
const consoleState = JSON.parse(await readFile('/workspace/data/eng14-console-state.json', 'utf8'));
evidence.readyOnlyHandoff = {
  replayStatus: replayClean.status,
  replayed: replayClean.payload.replayed === true,
  route: replayClean.payload.route,
  runCount: consoleState.runs.length,
  handoffCount: consoleState.handoffs.length,
  handoffTenderIds: consoleState.handoffs.map((item) => item.tenderId),
  informationRequestReceipts: (consoleState.informationRequestReceipts ?? []).map((item) => ({
    key: item.key,
    deliveryStatus: item.deliveryStatus,
  })),
};

const extraReady = await getJson(`${extraApi}/tenders`);
if (extraReady.status !== 200) {
  throw new Error(`Extra API is not ready: ${extraReady.status}`);
}

const multiSite = {
  tender: {
    tenderId: 'tender-eng14-multi-site',
    idempotencyKey: 'intake-eng14-multi-site',
    customer: { customerId: 'customer-001', legalName: 'Northstar Foods Ltd' },
    broker: { brokerId: 'broker-001', legalName: 'Harbour Energy Partners' },
    sites: [
      {
        siteId: 'site-001',
        address: '10 Example Street, London',
        meterIdentifier: '1234567890123',
        annualConsumptionKwh: 24000,
        contractEndDate: '2027-03-31',
      },
      {
        siteId: 'site-002',
        address: '20 Sample Road, Bristol',
        meterIdentifier: '9876543210987',
        annualConsumptionKwh: 18500,
        contractEndDate: '2027-06-30',
      },
    ],
    documents: [],
  },
  signals: structuredClone(cleanTender.signals),
};

const siteAmbiguity = {
  tender: {
    tenderId: 'tender-eng14-site-ambiguity',
    idempotencyKey: 'intake-eng14-site-ambiguity',
    customer: { customerId: 'customer-001', legalName: 'Northstar Foods Ltd' },
    broker: { brokerId: 'broker-001', legalName: 'Harbour Energy Partners' },
    sites: structuredClone(multiSite.tender.sites),
    documents: [
      {
        documentId: 'note-ambiguous',
        fileName: 'synthetic-ambiguous-note.txt',
        contentType: 'text/plain',
        required: false,
        processingStatus: 'PROCESSED',
      },
    ],
  },
  signals: {
    ...structuredClone(cleanTender.signals),
    documentSiteAssociations: [
      {
        documentId: 'note-ambiguous',
        status: 'AMBIGUOUS',
        candidateSiteIds: ['site-001', 'site-002'],
        evidence: [{ sourceId: 'broker-note-ambiguous', sourceType: 'TEXT' }],
      },
    ],
  },
};

const modelUncertainty = {
  tender: {
    tenderId: 'tender-eng14-model-uncertainty',
    idempotencyKey: 'intake-eng14-model-uncertainty',
    customer: { customerId: 'customer-001', legalName: 'Northstar Foods Ltd' },
    broker: { brokerId: 'broker-001', legalName: 'Harbour Energy Partners' },
    sites: [structuredClone(cleanTender.tender.sites[0])],
    documents: [],
  },
  signals: {
    ...structuredClone(cleanTender.signals),
    criticalFacts: [
      {
        factId: 'uncertain-meter-001',
        field: 'meterIdentifier',
        confidence: 0.2,
        ambiguous: true,
        evidence: [{ sourceId: 'partial-meter-note', sourceType: 'TEXT' }],
      },
    ],
  },
};

const n8nClean = JSON.parse(await readFile('integrations/n8n/fixtures/clean.json', 'utf8'));
const n8nDuplicate = JSON.parse(await readFile('integrations/n8n/fixtures/duplicate.json', 'utf8'));
const n8nPending = JSON.parse(await readFile('integrations/n8n/fixtures/pending.json', 'utf8'));

const extraCases = [
  ['happy-structured', cleanTender],
  ['multi-site', multiSite],
  ['missing', missingConsumptionTender],
  ['date-conflict', conflictingDatesTender],
  ['duplicate-signal', duplicateTender],
  ['site-ambiguity', siteAmbiguity],
  ['model-uncertainty', modelUncertainty],
  [
    'previous-regression-duplicate',
    {
      ...duplicateTender,
      tender: {
        ...duplicateTender.tender,
        tenderId: 'tender-duplicate-prior-regression',
        idempotencyKey: 'intake-duplicate-prior-regression',
      },
    },
  ],
];

for (const [label, body] of extraCases) {
  const result = await postTender(extraApi, body, label);
  evidence.cases.push({
    label,
    tenderId: body.tender.tenderId,
    httpStatus: result.status,
    route: result.payload.route ?? null,
    status: result.payload.status,
    failure: result.payload.failure ?? null,
    error: result.payload.error ?? null,
  });
}

const firstN8n = await postTender(extraApi, n8nClean.request, 'n8n-clean-first');
const duplicateDelivery = await postTender(extraApi, n8nDuplicate.request, 'n8n-duplicate');
const pending = await postTender(extraApi, n8nPending.request, 'n8n-pending');
evidence.cases.push(
  {
    label: 'n8n-clean-first',
    tenderId: n8nClean.request.tender.tenderId,
    httpStatus: firstN8n.status,
    route: firstN8n.payload.route ?? null,
    status: firstN8n.payload.status,
    replayed: firstN8n.payload.replayed === true,
  },
  {
    label: 'n8n-duplicate-after-clean',
    tenderId: n8nDuplicate.request.tender.tenderId,
    httpStatus: duplicateDelivery.status,
    route: duplicateDelivery.payload.route ?? null,
    status: duplicateDelivery.payload.status,
  },
  {
    label: 'n8n-pending',
    tenderId: n8nPending.request.tender.tenderId,
    httpStatus: pending.status,
    route: pending.payload.route ?? null,
    status: pending.payload.status,
  },
);

const extraState = JSON.parse(await readFile('/workspace/data/eng14-extra-state.json', 'utf8'));
evidence.extraState = {
  runCount: extraState.runs.length,
  handoffCount: extraState.handoffs.length,
  handoffTenderIds: extraState.handoffs.map((item) => item.tenderId),
  routes: extraState.runs.map((run) => ({
    tenderId: run.tenderId,
    route: run.route ?? null,
    status: run.status,
  })),
  nonReadyWithHandoff: extraState.runs
    .filter((run) => run.route !== 'READY_FOR_PRICING')
    .some((run) => extraState.handoffs.some((handoff) => handoff.runId === run.runId)),
};

evidence.completedAt = new Date().toISOString();
await mkdir('/workspace/docs/release-qa', { recursive: true });
await writeFile(
  '/workspace/docs/release-qa/stratified-http-evidence.json',
  `${JSON.stringify(evidence, null, 2)}\n`,
);
console.log(JSON.stringify(evidence, null, 2));
