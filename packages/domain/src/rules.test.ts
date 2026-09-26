import { describe, expect, it } from 'vitest';
import { DEFAULT_READINESS_CONFIG } from './config.js';
import { normalizeMeterIdentifier, normalizeTenderDate } from './date.js';
import { evaluateReadiness } from './evaluate.js';
import { conservativeRoutingPolicy, ROUTE_PRECEDENCE } from './routing-policy.js';
import { ProcessingRecordSchema, ProcessingStatusSchema, TenderRouteSchema } from './schemas.js';
import type { ReadinessInput, RuleResult, TenderRoute } from './types.js';
import {
  cleanTender,
  conflictingDatesTender,
  duplicateTender,
  missingConsumptionTender,
} from '../../../tests/fixtures/tenders.js';

function cloneCleanTender(): ReadinessInput {
  return structuredClone(cleanTender);
}

function resultFor(input: ReadinessInput, ruleId: RuleResult['ruleId']): RuleResult {
  const result = evaluateReadiness(input).rules.find((rule) => rule.ruleId === ruleId);
  if (!result) throw new Error(`Expected result for ${ruleId}`);
  return result;
}

function failingResult(route: TenderRoute): RuleResult {
  return {
    ruleId: 'TDR-001',
    passed: false,
    route,
    severity: route === 'HUMAN_REVIEW' ? 'review' : 'blocking',
    reason: 'Synthetic routing-policy test result.',
    evidence: [],
  };
}

describe('schemas and date normalization', () => {
  it('defaults optional evidence signals and documents safely at the boundary', () => {
    const result = evaluateReadiness({ tender: cleanTender.tender });

    expect(result.route).toBe('READY_FOR_PRICING');
    expect(result.rules).toHaveLength(12);
  });

  it('rejects malformed external tender payloads', () => {
    const malformed = cloneCleanTender() as unknown as Record<string, unknown>;
    const tender = malformed.tender as Record<string, unknown>;
    delete tender.tenderId;

    expect(() => evaluateReadiness(malformed)).toThrow();
  });

  it('rejects duplicate site IDs before conflicting facts can be collapsed', () => {
    const input = cloneCleanTender();
    input.tender.sites.push({
      ...input.tender.sites[0]!,
      meterIdentifier: '2234567890123',
      contractEndDate: '2026-09-30',
    });

    expect(() => evaluateReadiness(input)).toThrow(/Duplicate site ID: site-001/);
  });

  it('keeps legacy structured-only tenders with duplicate document IDs readable', () => {
    const input = cloneCleanTender();
    input.tender.documents = [
      {
        documentId: 'duplicate-document',
        fileName: 'first.pdf',
        contentType: 'application/pdf',
        required: false,
        processingStatus: 'PENDING',
      },
      {
        documentId: 'duplicate-document',
        fileName: 'second.pdf',
        contentType: 'application/pdf',
        required: false,
        processingStatus: 'PENDING',
      },
    ];

    expect(evaluateReadiness(input).route).toBe('READY_FOR_PRICING');
  });

  it('keeps business-invalid values available to deterministic rules', () => {
    const input = cloneCleanTender();
    input.tender.sites[0]!.annualConsumptionKwh = -10;

    expect(evaluateReadiness(input).route).toBe('NEEDS_INFORMATION');
    expect(resultFor(input, 'TDR-004').passed).toBe(false);
  });

  it('keeps processing status separate from business routes', () => {
    expect(ProcessingStatusSchema.parse('FAILED')).toBe('FAILED');
    expect(TenderRouteSchema.parse('READY_FOR_PRICING')).toBe('READY_FOR_PRICING');
    expect(() => ProcessingStatusSchema.parse('READY_FOR_PRICING')).toThrow();
    expect(() => TenderRouteSchema.parse('FAILED')).toThrow();
    expect(
      ProcessingRecordSchema.parse({
        tenderId: 'tender-technical-failure',
        status: 'FAILED',
        route: 'READY_FOR_PRICING',
      }),
    ).toMatchObject({ status: 'FAILED', route: 'READY_FOR_PRICING' });
    expect(DEFAULT_READINESS_CONFIG.minimumCriticalFactConfidence).toBe(0.95);
  });

  it.each([
    ['2027-03-31', '2027-03-31'],
    ['31/03/2027', '2027-03-31'],
    ['31-03-2027', '2027-03-31'],
  ])('normalizes supported contract dates (%s)', (input, expected) => {
    expect(normalizeTenderDate(input)).toBe(expected);
  });

  it.each(['31/02/2027', '2027-02-29', '03/31/2027', '31/03-2027', '31-03/2027', 'not-a-date'])(
    'rejects invalid date %s',
    (input) => {
      expect(normalizeTenderDate(input)).toBeUndefined();
    },
  );

  it('normalizes harmless meter identifier formatting consistently', () => {
    expect(normalizeMeterIdentifier(' ab-12 34 ')).toBe('AB1234');
  });
});

describe('TDR-001 through TDR-005: required customer and site data', () => {
  it.each(['', '   '])('routes a blank customer legal name to NEEDS_INFORMATION', (legalName) => {
    const input = cloneCleanTender();
    input.tender.customer.legalName = legalName;

    expect(resultFor(input, 'TDR-001').route).toBe('NEEDS_INFORMATION');
  });

  it('passes TDR-001 when a legal name is present', () => {
    expect(resultFor(cloneCleanTender(), 'TDR-001').passed).toBe(true);
  });

  it('routes a tender with no sites to NEEDS_INFORMATION', () => {
    const input = cloneCleanTender();
    input.tender.sites = [];

    expect(resultFor(input, 'TDR-002').route).toBe('NEEDS_INFORMATION');
  });

  it('passes TDR-002 for one or multiple sites', () => {
    const input = cloneCleanTender();
    input.tender.sites.push({
      ...input.tender.sites[0]!,
      siteId: 'site-002',
      meterIdentifier: '2234567890123',
    });

    expect(resultFor(input, 'TDR-002').passed).toBe(true);
  });

  it('routes a missing meter identifier on any site to NEEDS_INFORMATION', () => {
    const input = cloneCleanTender();
    input.tender.sites.push({
      ...input.tender.sites[0]!,
      siteId: 'site-002',
      meterIdentifier: undefined,
    });

    expect(resultFor(input, 'TDR-003').route).toBe('NEEDS_INFORMATION');
    expect(resultFor(input, 'TDR-003').evidence).toContainEqual({
      sourceId: 'site-002',
      sourceType: 'SITE',
      locator: 'meterIdentifier',
    });
  });

  it('passes TDR-003 when every site has a meter identifier', () => {
    expect(resultFor(cloneCleanTender(), 'TDR-003').passed).toBe(true);
  });

  it.each([undefined, null, 0, -1])(
    'routes missing or non-positive consumption to NEEDS_INFORMATION',
    (value) => {
      const input = cloneCleanTender();
      input.tender.sites[0]!.annualConsumptionKwh = value;

      expect(resultFor(input, 'TDR-004').route).toBe('NEEDS_INFORMATION');
    },
  );

  it('passes TDR-004 for positive consumption', () => {
    expect(resultFor(cloneCleanTender(), 'TDR-004').passed).toBe(true);
    expect(evaluateReadiness(missingConsumptionTender).route).toBe('NEEDS_INFORMATION');
  });

  it.each([undefined, null, '', 'not-a-date', '31/02/2027'])(
    'routes missing or invalid contract dates to NEEDS_INFORMATION',
    (value) => {
      const input = cloneCleanTender();
      input.tender.sites[0]!.contractEndDate = value;

      expect(resultFor(input, 'TDR-005').route).toBe('NEEDS_INFORMATION');
    },
  );

  it('passes TDR-005 for ISO and normalized UK date formats', () => {
    const input = cloneCleanTender();
    input.tender.sites[0]!.contractEndDate = '31/03/2027';

    expect(resultFor(input, 'TDR-005').passed).toBe(true);
  });
});

describe('TDR-006 through TDR-008: evidence conflicts and association', () => {
  it('routes conflicting credible dates for the same site to HUMAN_REVIEW', () => {
    expect(evaluateReadiness(conflictingDatesTender).route).toBe('HUMAN_REVIEW');
    expect(resultFor(conflictingDatesTender, 'TDR-006').route).toBe('HUMAN_REVIEW');
  });

  it('treats equivalent date formats and dates for different sites as non-conflicting', () => {
    const input = cloneCleanTender();
    input.tender.sites[0]!.contractEndDate = '2027-03-31';
    input.tender.sites.push({
      ...input.tender.sites[0]!,
      siteId: 'another-site',
      meterIdentifier: '2234567890123',
      contractEndDate: '2026-09-30',
    });
    input.signals.dateFacts = [
      {
        factId: 'date-1',
        siteId: 'site-001',
        field: 'contractEndDate',
        value: '2027-03-31',
        credible: true,
        evidence: [{ sourceId: 'doc-1', sourceType: 'DOCUMENT' }],
      },
      {
        factId: 'date-2',
        siteId: 'site-001',
        field: 'contractEndDate',
        value: '31/03/2027',
        credible: true,
        evidence: [{ sourceId: 'doc-2', sourceType: 'DOCUMENT' }],
      },
      {
        factId: 'date-3',
        siteId: 'another-site',
        field: 'contractEndDate',
        value: '30/09/2026',
        credible: true,
        evidence: [{ sourceId: 'doc-3', sourceType: 'DOCUMENT' }],
      },
    ];

    expect(resultFor(input, 'TDR-006').passed).toBe(true);
  });

  it('compares credible dates with the structured site date', () => {
    const input = cloneCleanTender();
    input.signals.dateFacts = [
      {
        factId: 'date-conflicts-with-site',
        siteId: 'site-001',
        field: 'contractEndDate',
        value: '2027-04-01',
        credible: true,
        evidence: [{ sourceId: 'doc-1', sourceType: 'DOCUMENT' }],
      },
    ];

    expect(resultFor(input, 'TDR-006').route).toBe('HUMAN_REVIEW');
    expect(resultFor(input, 'TDR-006').evidence).toContainEqual({
      sourceId: 'site-001',
      sourceType: 'SITE',
      locator: 'contractEndDate',
    });
  });

  it('routes malformed credible dates and credible dates for unknown sites to HUMAN_REVIEW', () => {
    const input = cloneCleanTender();
    input.signals.dateFacts = [
      {
        factId: 'malformed-date',
        siteId: 'site-001',
        field: 'contractEndDate',
        value: '31/02/2027',
        credible: true,
        evidence: [{ sourceId: 'doc-malformed', sourceType: 'DOCUMENT' }],
      },
    ];
    expect(resultFor(input, 'TDR-006').route).toBe('HUMAN_REVIEW');

    input.signals.dateFacts[0]!.value = '2027-03-31';
    input.signals.dateFacts[0]!.siteId = 'unknown-site';
    expect(resultFor(input, 'TDR-006').route).toBe('HUMAN_REVIEW');
  });

  it('does not treat non-credible date facts as authoritative conflicts', () => {
    const input = structuredClone(conflictingDatesTender);
    input.signals.dateFacts[1]!.credible = false;

    expect(resultFor(input, 'TDR-006').passed).toBe(true);
  });

  it('routes ambiguous, unresolved, and unknown-site document associations to HUMAN_REVIEW', () => {
    const associations: ReadinessInput['signals']['documentSiteAssociations'] = [
      {
        documentId: 'doc-1',
        status: 'AMBIGUOUS',
        candidateSiteIds: ['site-001'],
        evidence: [{ sourceId: 'doc-1', sourceType: 'DOCUMENT' }],
      },
      {
        documentId: 'doc-2',
        status: 'UNRESOLVED',
        candidateSiteIds: [],
        evidence: [{ sourceId: 'doc-2', sourceType: 'DOCUMENT' }],
      },
      {
        documentId: 'doc-3',
        status: 'RESOLVED',
        siteId: 'unknown-site',
        candidateSiteIds: ['unknown-site'],
        evidence: [{ sourceId: 'doc-3', sourceType: 'DOCUMENT' }],
      },
      {
        documentId: 'not-attached',
        status: 'RESOLVED',
        siteId: 'site-001',
        candidateSiteIds: ['site-001'],
        evidence: [{ sourceId: 'not-attached', sourceType: 'DOCUMENT' }],
      },
    ];

    for (const association of associations) {
      const input = cloneCleanTender();
      input.signals.documentSiteAssociations = [association];

      expect(resultFor(input, 'TDR-007').route).toBe('HUMAN_REVIEW');
    }
  });

  it('passes TDR-007 when a document resolves to one known site', () => {
    const input = cloneCleanTender();
    input.tender.documents = [
      {
        documentId: 'doc-1',
        fileName: 'contract.pdf',
        contentType: 'application/pdf',
        required: false,
        processingStatus: 'PROCESSED',
      },
    ];
    input.signals.documentSiteAssociations = [
      {
        documentId: 'doc-1',
        status: 'RESOLVED',
        siteId: 'site-001',
        candidateSiteIds: ['site-001'],
        evidence: [{ sourceId: 'doc-1', sourceType: 'DOCUMENT' }],
      },
    ];

    expect(resultFor(input, 'TDR-007').passed).toBe(true);
  });

  it('routes a document assigned to conflicting known sites to HUMAN_REVIEW', () => {
    const input = cloneCleanTender();
    input.tender.sites.push({
      ...input.tender.sites[0]!,
      siteId: 'site-002',
      meterIdentifier: '2234567890123',
    });
    input.tender.documents = [
      {
        documentId: 'multi-site-doc',
        fileName: 'contract.pdf',
        contentType: 'application/pdf',
        required: false,
        processingStatus: 'PROCESSED',
      },
    ];
    input.signals.documentSiteAssociations = [
      {
        documentId: 'multi-site-doc',
        status: 'RESOLVED',
        siteId: 'site-001',
        candidateSiteIds: ['site-001'],
        evidence: [{ sourceId: 'multi-site-doc', sourceType: 'DOCUMENT' }],
      },
      {
        documentId: 'multi-site-doc',
        status: 'RESOLVED',
        siteId: 'site-002',
        candidateSiteIds: ['site-002'],
        evidence: [{ sourceId: 'multi-site-doc', sourceType: 'DOCUMENT' }],
      },
    ];

    expect(resultFor(input, 'TDR-007').route).toBe('HUMAN_REVIEW');
  });

  it('allows consistent meter mappings despite display formatting', () => {
    const input = cloneCleanTender();
    input.signals.meterSiteAssociations = [
      {
        meterIdentifier: 'AB-1234',
        siteId: 'site-001',
        evidence: [{ sourceId: 'doc-1', sourceType: 'DOCUMENT' }],
      },
      {
        meterIdentifier: ' ab 1234 ',
        siteId: 'site-001',
        evidence: [{ sourceId: 'form-1', sourceType: 'TENDER' }],
      },
    ];

    expect(resultFor(input, 'TDR-008').passed).toBe(true);
  });

  it('routes one meter mapped to incompatible sites or unknown sites to HUMAN_REVIEW', () => {
    const input = cloneCleanTender();
    input.signals.meterSiteAssociations = [
      {
        meterIdentifier: 'AB-1234',
        siteId: 'site-001',
        evidence: [{ sourceId: 'doc-1', sourceType: 'DOCUMENT' }],
      },
      {
        meterIdentifier: 'AB1234',
        siteId: 'site-002',
        evidence: [{ sourceId: 'doc-2', sourceType: 'DOCUMENT' }],
      },
    ];

    expect(resultFor(input, 'TDR-008').route).toBe('HUMAN_REVIEW');

    input.tender.sites.push({
      ...input.tender.sites[0]!,
      siteId: 'site-002',
      meterIdentifier: '2234567890123',
    });
    input.signals.meterSiteAssociations = [
      {
        meterIdentifier: input.tender.sites[0]!.meterIdentifier!,
        siteId: 'site-002',
        evidence: [{ sourceId: 'doc-3', sourceType: 'DOCUMENT' }],
      },
    ];
    expect(resultFor(input, 'TDR-008').route).toBe('HUMAN_REVIEW');

    input.signals.meterSiteAssociations = [
      {
        meterIdentifier: 'UNKNOWN-1',
        siteId: 'unknown-site',
        evidence: [{ sourceId: 'doc-4', sourceType: 'DOCUMENT' }],
      },
    ];
    expect(resultFor(input, 'TDR-008').route).toBe('HUMAN_REVIEW');
  });
});

describe('TDR-009 through TDR-012: duplicate, safety, and readiness', () => {
  it('routes active matches and replayed idempotency keys to DUPLICATE', () => {
    expect(evaluateReadiness(duplicateTender).route).toBe('DUPLICATE');

    const input = cloneCleanTender();
    input.signals.duplicate.idempotencyKeyPreviouslyProcessed = true;
    expect(resultFor(input, 'TDR-009').route).toBe('DUPLICATE');
  });

  it('rejects an active duplicate signal without its matched tender evidence', () => {
    const input = cloneCleanTender();
    input.signals.duplicate = {
      matchesActiveTender: true,
      matchedTenderId: undefined,
      idempotencyKeyPreviouslyProcessed: false,
    };

    expect(() => evaluateReadiness(input)).toThrow();
  });

  it('passes TDR-009 for a new tender and intake key', () => {
    expect(resultFor(cloneCleanTender(), 'TDR-009').passed).toBe(true);
  });

  it('routes ambiguous or below-threshold critical facts to HUMAN_REVIEW', () => {
    const input = cloneCleanTender();
    input.signals.criticalFacts = [
      {
        factId: 'fact-low-confidence',
        field: 'contractEndDate',
        confidence: 0.94,
        ambiguous: false,
        evidence: [{ sourceId: 'doc-1', sourceType: 'DOCUMENT' }],
      },
    ];
    expect(resultFor(input, 'TDR-010').route).toBe('HUMAN_REVIEW');

    input.signals.criticalFacts[0]!.confidence = 0.99;
    input.signals.criticalFacts[0]!.ambiguous = true;
    expect(resultFor(input, 'TDR-010').route).toBe('HUMAN_REVIEW');
  });

  it('uses the configured confidence threshold and accepts clear high-confidence facts', () => {
    const input = cloneCleanTender();
    input.signals.criticalFacts = [
      {
        factId: 'fact-high-confidence',
        field: 'contractEndDate',
        confidence: 0.9,
        ambiguous: false,
        evidence: [{ sourceId: 'doc-1', sourceType: 'DOCUMENT' }],
      },
    ];

    expect(resultFor(input, 'TDR-010').route).toBe('HUMAN_REVIEW');
    expect(evaluateReadiness(input, { minimumCriticalFactConfidence: 0.9 }).route).toBe(
      'READY_FOR_PRICING',
    );
  });

  it('routes terminally failed required documents to HUMAN_REVIEW', () => {
    const input = cloneCleanTender();
    input.tender.documents = [
      {
        documentId: 'required-doc',
        fileName: 'contract.pdf',
        contentType: 'application/pdf',
        required: true,
        processingStatus: 'UNSUPPORTED',
      },
    ];

    expect(resultFor(input, 'TDR-011').route).toBe('HUMAN_REVIEW');
  });

  it('keeps readiness pending while required documents are processing', () => {
    const input = cloneCleanTender();
    input.tender.documents = [
      {
        documentId: 'required-doc',
        fileName: 'contract.pdf',
        contentType: 'application/pdf',
        required: true,
        processingStatus: 'PENDING',
      },
    ];

    const processingResult = evaluateReadiness(input);
    const pendingRule = processingResult.rules.find((rule) => rule.ruleId === 'TDR-011');
    expect(processingResult.route).toBeUndefined();
    expect(processingResult.processingStatus).toBe('PROCESSING');
    expect(pendingRule).toMatchObject({ passed: false, severity: 'info' });
    expect(pendingRule?.route).toBeUndefined();
    expect(processingResult.rules.find((rule) => rule.ruleId === 'TDR-012')?.passed).toBe(false);

    input.tender.documents[0]!.processingStatus = 'PROCESSED';
    const completedResult = evaluateReadiness(input);
    expect(completedResult.processingStatus).toBe('COMPLETED');
    expect(completedResult.route).toBe('READY_FOR_PRICING');
  });

  it('ignores optional unprocessed documents and passes processed required documents', () => {
    const input = cloneCleanTender();
    input.tender.documents = [
      {
        documentId: 'optional-doc',
        fileName: 'brochure.pdf',
        contentType: 'application/pdf',
        required: false,
        processingStatus: 'CORRUPTED',
      },
      {
        documentId: 'required-doc',
        fileName: 'contract.pdf',
        contentType: 'application/pdf',
        required: true,
        processingStatus: 'PROCESSED',
      },
    ];

    expect(resultFor(input, 'TDR-011').passed).toBe(true);
  });

  it('routes clean single-site and multi-site tenders to READY_FOR_PRICING', () => {
    expect(evaluateReadiness(cleanTender).route).toBe('READY_FOR_PRICING');

    const multiSite = cloneCleanTender();
    multiSite.tender.sites.push({
      ...multiSite.tender.sites[0]!,
      siteId: 'site-002',
      meterIdentifier: '2234567890123',
    });
    expect(evaluateReadiness(multiSite).route).toBe('READY_FOR_PRICING');
    expect(resultFor(multiSite, 'TDR-012').passed).toBe(true);
  });

  it('uses conservative route precedence: duplicate, review, missing information, ready', () => {
    expect(ROUTE_PRECEDENCE).toEqual([
      'DUPLICATE',
      'HUMAN_REVIEW',
      'NEEDS_INFORMATION',
      'READY_FOR_PRICING',
    ]);
    expect(
      conservativeRoutingPolicy.determineRoute([
        failingResult('NEEDS_INFORMATION'),
        failingResult('HUMAN_REVIEW'),
        failingResult('DUPLICATE'),
      ]),
    ).toBe('DUPLICATE');
    expect(
      conservativeRoutingPolicy.determineRoute([
        failingResult('NEEDS_INFORMATION'),
        failingResult('HUMAN_REVIEW'),
      ]),
    ).toBe('HUMAN_REVIEW');
    expect(conservativeRoutingPolicy.determineRoute([failingResult('NEEDS_INFORMATION')])).toBe(
      'NEEDS_INFORMATION',
    );
    expect(conservativeRoutingPolicy.determineRoute([])).toBe('HUMAN_REVIEW');
  });
});
