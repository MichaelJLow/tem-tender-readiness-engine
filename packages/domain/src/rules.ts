import { normalizeMeterIdentifier, normalizeTenderDate } from './date.js';
import { ReadinessConfigSchema, type ReadinessConfig } from './config.js';
import type { EvidenceRef, ReadinessInput, Rule, RuleResult } from './types.js';

function passed(
  ruleId: RuleResult['ruleId'],
  reason: string,
  evidence: EvidenceRef[] = [],
): RuleResult {
  return { ruleId, passed: true, severity: 'info', reason, evidence };
}

function routed(
  ruleId: RuleResult['ruleId'],
  route: NonNullable<RuleResult['route']>,
  severity: RuleResult['severity'],
  reason: string,
  evidence: EvidenceRef[],
): RuleResult {
  return { ruleId, passed: false, route, severity, reason, evidence };
}

const customerEvidence = (input: ReadinessInput): EvidenceRef => ({
  sourceId: input.tender.customer.customerId,
  sourceType: 'CUSTOMER',
  locator: 'legalName',
});

const siteEvidence = (siteId: string, locator: string): EvidenceRef => ({
  sourceId: siteId,
  sourceType: 'SITE',
  locator,
});

export const rule001CustomerLegalName: Rule = (input) => {
  const legalName = input.tender.customer.legalName.trim();
  return legalName
    ? passed('TDR-001', 'Customer legal name is present.', [customerEvidence(input)])
    : routed(
        'TDR-001',
        'NEEDS_INFORMATION',
        'blocking',
        'Tender cannot be associated reliably with a customer because the legal name is missing.',
        [customerEvidence(input)],
      );
};

export const rule002AtLeastOneSite: Rule = (input) => {
  const evidence: EvidenceRef[] = [
    { sourceId: input.tender.tenderId, sourceType: 'TENDER', locator: 'sites' },
  ];
  return input.tender.sites.length > 0
    ? passed('TDR-002', 'Tender contains at least one supply site.', evidence)
    : routed(
        'TDR-002',
        'NEEDS_INFORMATION',
        'blocking',
        'There is no supply location to assess.',
        evidence,
      );
};

export const rule003MeterIdentifier: Rule = (input) => {
  const missing = input.tender.sites.filter((site) => !site.meterIdentifier?.trim());
  const evidence = missing.map((site) => siteEvidence(site.siteId, 'meterIdentifier'));
  return missing.length === 0
    ? passed(
        'TDR-003',
        'Every site has a meter identifier.',
        input.tender.sites.map((site) => siteEvidence(site.siteId, 'meterIdentifier')),
      )
    : routed(
        'TDR-003',
        'NEEDS_INFORMATION',
        'blocking',
        `A meter identifier is missing for ${missing.map((site) => site.siteId).join(', ')}.`,
        evidence,
      );
};

export const rule004AnnualConsumption: Rule = (input) => {
  const missing = input.tender.sites.filter(
    (site) =>
      site.annualConsumptionKwh === undefined ||
      site.annualConsumptionKwh === null ||
      site.annualConsumptionKwh <= 0,
  );
  const evidence = missing.map((site) => siteEvidence(site.siteId, 'annualConsumptionKwh'));
  return missing.length === 0
    ? passed(
        'TDR-004',
        'Every site has positive annual consumption.',
        input.tender.sites.map((site) => siteEvidence(site.siteId, 'annualConsumptionKwh')),
      )
    : routed(
        'TDR-004',
        'NEEDS_INFORMATION',
        'blocking',
        `A positive annual consumption figure is missing for ${missing.map((site) => site.siteId).join(', ')}.`,
        evidence,
      );
};

export const rule005ContractEndDate: Rule = (input) => {
  const missing = input.tender.sites.filter(
    (site) => !site.contractEndDate || !normalizeTenderDate(site.contractEndDate),
  );
  const evidence = missing.map((site) => siteEvidence(site.siteId, 'contractEndDate'));
  return missing.length === 0
    ? passed(
        'TDR-005',
        'Every site has a contract end date in a supported format.',
        input.tender.sites.map((site) => siteEvidence(site.siteId, 'contractEndDate')),
      )
    : routed(
        'TDR-005',
        'NEEDS_INFORMATION',
        'blocking',
        `A valid contract end date is missing for ${missing.map((site) => site.siteId).join(', ')}.`,
        evidence,
      );
};

export const rule006ConflictingCriticalDates: Rule = (input) => {
  const knownSiteIds = new Set(input.tender.sites.map((site) => site.siteId));
  const credibleFacts = input.signals.dateFacts.filter((fact) => fact.credible);
  const malformedFacts = credibleFacts.filter((fact) => !normalizeTenderDate(fact.value));
  const unknownSiteFacts = credibleFacts.filter((fact) => !knownSiteIds.has(fact.siteId));
  const factsBySite = new Map<string, Array<{ value: string; evidence: EvidenceRef[] }>>();

  for (const site of input.tender.sites) {
    const value = site.contractEndDate ? normalizeTenderDate(site.contractEndDate) : undefined;
    if (value)
      factsBySite.set(site.siteId, [
        { value, evidence: [siteEvidence(site.siteId, 'contractEndDate')] },
      ]);
  }

  for (const fact of credibleFacts) {
    const value = normalizeTenderDate(fact.value);
    if (!value || !knownSiteIds.has(fact.siteId)) continue;
    const facts = factsBySite.get(fact.siteId) ?? [];
    facts.push({ value, evidence: fact.evidence });
    factsBySite.set(fact.siteId, facts);
  }

  const conflicts = [...factsBySite.entries()].filter(([, facts]) =>
    facts.some((fact) => fact.value !== facts[0]?.value),
  );
  const hasReviewIssue =
    malformedFacts.length > 0 || unknownSiteFacts.length > 0 || conflicts.length > 0;
  const evidence = [
    ...malformedFacts.flatMap((fact) => fact.evidence),
    ...unknownSiteFacts.flatMap((fact) => fact.evidence),
    ...conflicts.flatMap(([, facts]) => facts.flatMap((fact) => fact.evidence)),
  ];

  return !hasReviewIssue
    ? passed(
        'TDR-006',
        'No credible contract end date facts conflict with the structured site dates.',
        credibleFacts.flatMap((fact) => fact.evidence),
      )
    : routed(
        'TDR-006',
        'HUMAN_REVIEW',
        'review',
        'A credible contract end date conflicts with the site record, is malformed, or refers to an unknown site.',
        evidence,
      );
};

export const rule007DocumentSiteAssociation: Rule = (input) => {
  const siteIds = new Set(input.tender.sites.map((site) => site.siteId));
  const documentIds = new Set(input.tender.documents.map((document) => document.documentId));
  const associations = input.signals.documentSiteAssociations;
  const siteIdsByDocument = new Map<string, Set<string>>();
  for (const association of associations) {
    if (association.status !== 'RESOLVED' || !association.siteId) continue;
    const associatedSiteIds = siteIdsByDocument.get(association.documentId) ?? new Set<string>();
    associatedSiteIds.add(association.siteId);
    siteIdsByDocument.set(association.documentId, associatedSiteIds);
  }
  const conflictingDocumentIds = new Set(
    [...siteIdsByDocument.entries()]
      .filter(([, associatedSiteIds]) => associatedSiteIds.size > 1)
      .map(([documentId]) => documentId),
  );
  const unresolved = associations.filter(
    (association) =>
      !documentIds.has(association.documentId) ||
      association.status !== 'RESOLVED' ||
      !association.siteId ||
      !siteIds.has(association.siteId) ||
      conflictingDocumentIds.has(association.documentId),
  );
  const evidence = unresolved.flatMap((association) => association.evidence);
  return unresolved.length === 0
    ? passed(
        'TDR-007',
        'All document facts that require a site association resolve to one known site.',
        input.signals.documentSiteAssociations.flatMap((association) => association.evidence),
      )
    : routed(
        'TDR-007',
        'HUMAN_REVIEW',
        'review',
        `Document-to-site association is unresolved for ${unresolved.map((association) => association.documentId).join(', ')}.`,
        evidence,
      );
};

export const rule008MeterSiteAssociation: Rule = (input) => {
  const sitesByMeter = new Map<string, Set<string>>();
  const evidenceByMeter = new Map<string, EvidenceRef[]>();
  const knownSiteIds = new Set(input.tender.sites.map((site) => site.siteId));

  for (const site of input.tender.sites) {
    if (!site.meterIdentifier?.trim()) continue;
    const meter = normalizeMeterIdentifier(site.meterIdentifier);
    const sites = sitesByMeter.get(meter) ?? new Set<string>();
    sites.add(site.siteId);
    sitesByMeter.set(meter, sites);

    const evidence = evidenceByMeter.get(meter) ?? [];
    evidence.push(siteEvidence(site.siteId, 'meterIdentifier'));
    evidenceByMeter.set(meter, evidence);
  }

  for (const association of input.signals.meterSiteAssociations) {
    const meter = normalizeMeterIdentifier(association.meterIdentifier);
    const sites = sitesByMeter.get(meter) ?? new Set<string>();
    sites.add(association.siteId);
    sitesByMeter.set(meter, sites);

    const evidence = evidenceByMeter.get(meter) ?? [];
    evidence.push(...association.evidence);
    evidenceByMeter.set(meter, evidence);
  }

  const conflictedMeters = [...sitesByMeter.entries()].filter(
    ([, siteIds]) => siteIds.size > 1 || [...siteIds].some((siteId) => !knownSiteIds.has(siteId)),
  );
  const evidence = conflictedMeters.flatMap(([meter]) => evidenceByMeter.get(meter) ?? []);
  return conflictedMeters.length === 0
    ? passed(
        'TDR-008',
        'Meter identifiers are associated consistently with known sites.',
        input.signals.meterSiteAssociations.flatMap((association) => association.evidence),
      )
    : routed(
        'TDR-008',
        'HUMAN_REVIEW',
        'review',
        `Meter-to-site association conflicts for meter identifier(s) ${conflictedMeters.map(([meter]) => meter).join(', ')}.`,
        evidence,
      );
};

export const rule009DuplicateTender: Rule = (input) => {
  const duplicate = input.signals.duplicate;
  if (!duplicate.matchesActiveTender && !duplicate.idempotencyKeyPreviouslyProcessed) {
    return passed(
      'TDR-009',
      'No active matching tender or previously processed intake key was found.',
      [{ sourceId: input.tender.idempotencyKey, sourceType: 'IDEMPOTENCY' }],
    );
  }

  const evidence: EvidenceRef[] = [];
  if (duplicate.matchesActiveTender && duplicate.matchedTenderId) {
    evidence.push({
      sourceId: duplicate.matchedTenderId,
      sourceType: 'TENDER',
      locator: 'active duplicate match',
    });
  }
  if (duplicate.idempotencyKeyPreviouslyProcessed) {
    evidence.push({ sourceId: input.tender.idempotencyKey, sourceType: 'IDEMPOTENCY' });
  }
  return routed(
    'TDR-009',
    'DUPLICATE',
    'blocking',
    'An active matching tender or this intake event has already been processed.',
    evidence,
  );
};

export function rule010CriticalExtraction(
  config: ReadinessConfig = ReadinessConfigSchema.parse({}),
): Rule {
  return (input) => {
    const uncertain = input.signals.criticalFacts.filter(
      (fact) => fact.ambiguous || fact.confidence < config.minimumCriticalFactConfidence,
    );
    const evidence = uncertain.flatMap((fact) => fact.evidence);
    return uncertain.length === 0
      ? passed(
          'TDR-010',
          'All supplied critical extracted facts meet the configured confidence and ambiguity policy.',
          input.signals.criticalFacts.flatMap((fact) => fact.evidence),
        )
      : routed(
          'TDR-010',
          'HUMAN_REVIEW',
          'review',
          `Critical extracted fact(s) ${uncertain.map((fact) => fact.field).join(', ')} are ambiguous or below the configured confidence threshold.`,
          evidence,
        );
  };
}

export const rule011RequiredDocumentProcessing: Rule = (input) => {
  const pending = input.tender.documents.filter(
    (document) => document.required && document.processingStatus === 'PENDING',
  );
  const terminalFailures = input.tender.documents.filter(
    (document) =>
      document.required &&
      document.processingStatus !== 'PROCESSED' &&
      document.processingStatus !== 'PENDING',
  );
  const evidence = [...pending, ...terminalFailures].map((document) => ({
    sourceId: document.documentId,
    sourceType: 'DOCUMENT' as const,
    locator: document.processingStatus,
  }));
  if (terminalFailures.length > 0) {
    return routed(
      'TDR-011',
      'HUMAN_REVIEW',
      'review',
      `Required document(s) ${terminalFailures.map((document) => document.documentId).join(', ')} failed processing or use an unsupported format.`,
      evidence,
    );
  }

  if (pending.length > 0) {
    return {
      ruleId: 'TDR-011',
      passed: false,
      severity: 'info',
      reason: `Required document(s) ${pending.map((document) => document.documentId).join(', ')} are still processing.`,
      evidence,
    };
  }

  return passed(
    'TDR-011',
    'Every required document has been processed successfully.',
    input.tender.documents
      .filter((document) => document.required)
      .map((document) => ({ sourceId: document.documentId, sourceType: 'DOCUMENT' as const })),
  );
};

export function rule012ReadinessSatisfied(priorResults: readonly RuleResult[]): RuleResult {
  const blockers = priorResults.filter((result) => !result.passed);
  const evidence = priorResults.flatMap((result) => result.evidence);
  return blockers.length === 0
    ? {
        ...passed(
          'TDR-012',
          'Tender is complete and consistent according to the V1 synthetic policy.',
          evidence,
        ),
        route: 'READY_FOR_PRICING',
      }
    : {
        ruleId: 'TDR-012',
        passed: false,
        severity: 'info',
        reason: 'Readiness is not satisfied because one or more earlier rules require action.',
        evidence,
      };
}

export function getReadinessRules(config: ReadinessConfig): readonly Rule[] {
  const validatedConfig = ReadinessConfigSchema.parse(config);
  return [
    rule001CustomerLegalName,
    rule002AtLeastOneSite,
    rule003MeterIdentifier,
    rule004AnnualConsumption,
    rule005ContractEndDate,
    rule006ConflictingCriticalDates,
    rule007DocumentSiteAssociation,
    rule008MeterSiteAssociation,
    rule009DuplicateTender,
    rule010CriticalExtraction(validatedConfig),
    rule011RequiredDocumentProcessing,
  ];
}
