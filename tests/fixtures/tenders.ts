import type { ReadinessInput } from '../../packages/domain/src/types.js';

export const cleanTender: ReadinessInput = {
  tender: {
    tenderId: 'tender-clean-001',
    idempotencyKey: 'intake-clean-001',
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
    ],
    documents: [],
  },
  signals: {
    dateFacts: [],
    documentSiteAssociations: [],
    meterSiteAssociations: [],
    criticalFacts: [],
    duplicate: {
      matchesActiveTender: false,
      idempotencyKeyPreviouslyProcessed: false,
    },
  },
};

export const missingConsumptionTender: ReadinessInput = {
  ...cleanTender,
  tender: {
    ...cleanTender.tender,
    tenderId: 'tender-missing-consumption',
    idempotencyKey: 'intake-missing-consumption',
    sites: [{ ...cleanTender.tender.sites[0]!, annualConsumptionKwh: undefined }],
  },
};

export const conflictingDatesTender: ReadinessInput = {
  ...cleanTender,
  tender: {
    ...cleanTender.tender,
    tenderId: 'tender-conflicting-dates',
    idempotencyKey: 'intake-conflicting-dates',
  },
  signals: {
    ...cleanTender.signals,
    dateFacts: [
      {
        factId: 'date-fact-001',
        siteId: 'site-001',
        field: 'contractEndDate',
        value: '2027-03-31',
        credible: true,
        evidence: [{ sourceId: 'contract-a', sourceType: 'DOCUMENT' }],
      },
      {
        factId: 'date-fact-002',
        siteId: 'site-001',
        field: 'contractEndDate',
        value: '30/09/2026',
        credible: true,
        evidence: [{ sourceId: 'contract-b', sourceType: 'DOCUMENT' }],
      },
    ],
  },
};

export const duplicateTender: ReadinessInput = {
  ...cleanTender,
  tender: {
    ...cleanTender.tender,
    tenderId: 'tender-duplicate',
    idempotencyKey: 'intake-duplicate',
  },
  signals: {
    ...cleanTender.signals,
    duplicate: {
      matchesActiveTender: true,
      matchedTenderId: 'tender-existing-001',
      idempotencyKeyPreviouslyProcessed: false,
    },
  },
};
