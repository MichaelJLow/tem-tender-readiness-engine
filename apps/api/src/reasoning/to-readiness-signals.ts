import {
  normalizeMeterIdentifier,
  normalizeTenderDate,
} from '../../../../packages/domain/src/index.js';
import type { EvidenceRef, ReadinessInput } from '../../../../packages/domain/src/index.js';
import type { TextSource } from '../contracts.js';
import {
  MIN_CONFIDENCE_FOR_CREDIBLE_EVIDENCE,
  TenderInterpretationSchema,
  type TenderInterpretation,
} from './contracts.js';

export class InvalidInterpretationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidInterpretationError';
  }
}

/** Drop Mastra's unsupported structured-record citation only when the conflict also cites text. */
export function normalizeStructuredConflictEvidence(
  textSources: readonly TextSource[],
  rawInterpretation: TenderInterpretation,
): TenderInterpretation {
  const interpretation = TenderInterpretationSchema.parse(rawInterpretation);
  const sourceById = new Map(textSources.map((source) => [source.sourceId, source]));
  return {
    ...interpretation,
    conflicts: interpretation.conflicts.map((conflict) => {
      const isSupported = (citation: (typeof conflict.evidence)[number]) => {
        const source = sourceById.get(citation.sourceId);
        return Boolean(source?.text.includes(citation.quote));
      };
      const hasUnsupportedTenderCitation = conflict.evidence.some(
        (citation) => citation.sourceId === 'tender' && !isSupported(citation),
      );
      const hasOtherUnsupportedCitation = conflict.evidence.some(
        (citation) => citation.sourceId !== 'tender' && !isSupported(citation),
      );
      const supportedEvidence = conflict.evidence.filter(isSupported);
      if (
        hasUnsupportedTenderCitation &&
        !hasOtherUnsupportedCitation &&
        supportedEvidence.length > 0
      ) {
        return { ...conflict, evidence: supportedEvidence };
      }
      return conflict;
    }),
  };
}

export function toReadinessSignals(
  input: ReadinessInput,
  textSources: readonly TextSource[],
  rawInterpretation: TenderInterpretation,
): ReadinessInput['signals'] {
  const interpretation = TenderInterpretationSchema.parse(rawInterpretation);
  const sourceById = new Map(textSources.map((source) => [source.sourceId, source]));
  const siteIds = new Set(input.tender.sites.map((site) => site.siteId));
  const lowercaseSiteIds = new Set(
    input.tender.sites.map((site) => site.siteId.toLocaleLowerCase('en')),
  );
  const siteMentions = (quote: string) =>
    input.tender.sites.flatMap((site) => {
      const locator = findSiteLocator(quote, site);
      return locator ? [{ siteId: site.siteId, locator }] : [];
    });
  const quoteIdentifiesSite = (quote: string, siteId: string | undefined) => {
    if (!siteId) return false;
    const mentions = siteMentions(quote);
    return (
      mentions.length === 1 &&
      mentions[0]?.siteId === siteId &&
      unknownSiteLabels(quote, lowercaseSiteIds).length === 0
    );
  };
  const documentIds = new Set(input.tender.documents.map((document) => document.documentId));
  const outputSources = interpretation.sourceAssessments.map((assessment) => assessment.sourceId);
  if (
    outputSources.length !== sourceById.size ||
    new Set(outputSources).size !== outputSources.length ||
    outputSources.some((sourceId) => !sourceById.has(sourceId))
  ) {
    throw new InvalidInterpretationError(
      'Every submitted text source must receive exactly one interpretation assessment.',
    );
  }

  const citationsToEvidence = (citations: readonly { sourceId: string; quote: string }[]) =>
    citations.map((citation): EvidenceRef => {
      const source = sourceById.get(citation.sourceId);
      if (!source || !source.text.includes(citation.quote)) {
        throw new InvalidInterpretationError(
          `Interpretation evidence does not match submitted source ${citation.sourceId}.`,
        );
      }
      return { sourceId: source.sourceId, sourceType: 'TEXT', locator: citation.quote };
    });
  const ensureKnownSites = (candidateSiteIds: readonly string[]) => {
    if (candidateSiteIds.some((siteId) => !siteIds.has(siteId))) {
      throw new InvalidInterpretationError('Interpretation referenced an unknown site.');
    }
  };
  const criticalFacts: ReadinessInput['signals']['criticalFacts'] = [];
  const dateFacts: ReadinessInput['signals']['dateFacts'] = [];
  const meterSiteAssociations: ReadinessInput['signals']['meterSiteAssociations'] = [];
  const documentSiteAssociations: ReadinessInput['signals']['documentSiteAssociations'] = [];
  const sourcesWithExtractedFacts = new Set([
    ...interpretation.observations.flatMap((observation) =>
      observation.evidence.map((citation) => citation.sourceId),
    ),
    ...interpretation.conflicts.flatMap((conflict) =>
      conflict.evidence.map((citation) => citation.sourceId),
    ),
  ]);
  const sourcesWithAssociations = new Set(
    interpretation.siteAssociations.map((association) => association.sourceId),
  );

  for (const [index, assessment] of interpretation.sourceAssessments.entries()) {
    if (assessment.evidence.some((citation) => citation.sourceId !== assessment.sourceId)) {
      throw new InvalidInterpretationError(
        'Source assessment evidence must cite the source being assessed.',
      );
    }
    const evidence = citationsToEvidence(assessment.evidence);
    const source = sourceById.get(assessment.sourceId)!;
    const unknownLabels = unknownSiteLabels(source.text, lowercaseSiteIds);
    const hasExtractedFact = sourcesWithExtractedFacts.has(assessment.sourceId);
    const hasDetailedEvidence =
      hasExtractedFact || sourcesWithAssociations.has(assessment.sourceId);
    const unresolvedRelevantSource = assessment.relevance === 'RELEVANT' && !hasExtractedFact;
    const inconsistentIrrelevantSource =
      assessment.relevance === 'NO_RELEVANT_FACTS' && hasDetailedEvidence;
    criticalFacts.push({
      factId: `interpretation:source:${assessment.sourceId}:${index}`,
      field: unresolvedRelevantSource
        ? 'relevantTextWithoutExtractedFact'
        : inconsistentIrrelevantSource
          ? 'irrelevantAssessmentWithFact'
          : unknownLabels.length > 0
            ? 'unknownSiteReference'
            : 'textSourceAssessment',
      confidence: assessment.confidence,
      ambiguous:
        assessment.ambiguous ||
        unresolvedRelevantSource ||
        inconsistentIrrelevantSource ||
        unknownLabels.length > 0,
      evidence: [
        ...evidence,
        ...unknownLabels.map((locator): EvidenceRef => ({
          sourceId: source.sourceId,
          sourceType: 'TEXT',
          locator,
        })),
      ],
    });
  }

  for (const [index, association] of interpretation.siteAssociations.entries()) {
    const source = sourceById.get(association.sourceId);
    if (!source) throw new InvalidInterpretationError('Association references an unknown source.');
    ensureKnownSites(association.siteIds);
    if (association.evidence.some((citation) => citation.sourceId !== association.sourceId)) {
      throw new InvalidInterpretationError(
        'Site association evidence must cite the source being associated.',
      );
    }
    const evidence = citationsToEvidence(association.evidence);
    const siteId = association.siteIds.length === 1 ? association.siteIds[0] : undefined;
    const sourceSiteConflict = association.evidence.some(
      (citation) => !quoteIdentifiesSite(citation.quote, siteId),
    );
    const resolved = Boolean(
      siteId &&
      !association.ambiguous &&
      !sourceSiteConflict &&
      association.confidence >= MIN_CONFIDENCE_FOR_CREDIBLE_EVIDENCE,
    );

    if (source.documentId) {
      if (!documentIds.has(source.documentId)) {
        throw new InvalidInterpretationError('Association references an unknown document.');
      }
      documentSiteAssociations.push({
        documentId: source.documentId,
        status: resolved
          ? 'RESOLVED'
          : association.siteIds.length === 0
            ? 'UNRESOLVED'
            : 'AMBIGUOUS',
        ...(resolved && siteId ? { siteId } : {}),
        candidateSiteIds: association.siteIds,
        evidence: [
          ...evidence,
          ...association.evidence
            .flatMap((citation) => siteMentions(citation.quote))
            .map((mention): EvidenceRef => ({
              sourceId: source.sourceId,
              sourceType: 'TEXT',
              locator: mention.locator,
            })),
        ],
      });
    } else if (!resolved) {
      criticalFacts.push({
        factId: `interpretation:association:${index}`,
        field: 'siteAssociation',
        confidence: association.confidence,
        ambiguous: true,
        evidence,
      });
    }
  }

  const valuesByFieldAndSite = new Map<string, Set<string>>();
  for (const [index, observation] of interpretation.observations.entries()) {
    ensureKnownSites(observation.siteIds);
    const evidence = citationsToEvidence(observation.evidence);
    if (
      observation.evidence.some(
        (citation) =>
          !citation.quote
            .toLocaleLowerCase('en')
            .includes(observation.value.toLocaleLowerCase('en')),
      )
    ) {
      throw new InvalidInterpretationError(
        `The observed ${observation.field} value must appear in every cited quote.`,
      );
    }
    const siteId = observation.siteIds.length === 1 ? observation.siteIds[0] : undefined;
    const citedSources = [...new Set(observation.evidence.map((citation) => citation.sourceId))];
    const missingAssociation =
      siteScoped(observation.field) &&
      citedSources.some((sourceId) => {
        const source = sourceById.get(sourceId)!;
        return (
          (Boolean(source.documentId) || input.tender.sites.length > 1) &&
          !interpretation.siteAssociations.some((association) => association.sourceId === sourceId)
        );
      });
    const sourceSiteConflict =
      siteScoped(observation.field) &&
      observation.evidence.some((citation) => !quoteIdentifiesSite(citation.quote, siteId));
    const contradictoryAssociations = siteId
      ? interpretation.siteAssociations.filter(
          (association) =>
            observation.evidence.some((citation) => citation.sourceId === association.sourceId) &&
            association.siteIds.length === 1 &&
            !association.ambiguous &&
            association.confidence >= MIN_CONFIDENCE_FOR_CREDIBLE_EVIDENCE &&
            association.siteIds[0] !== siteId,
        )
      : [];
    const invalidConsumption =
      observation.field === 'annualConsumptionKwh' &&
      parseConsumption(observation.value) === undefined;
    const ambiguous =
      observation.ambiguous ||
      (siteScoped(observation.field) && !siteId) ||
      missingAssociation ||
      sourceSiteConflict ||
      invalidConsumption ||
      contradictoryAssociations.length > 0;
    criticalFacts.push({
      factId: `interpretation:observation:${index}`,
      field: observation.field,
      confidence: observation.confidence,
      ambiguous,
      evidence: [
        ...evidence,
        ...observation.evidence.flatMap((citation) =>
          siteMentions(citation.quote).map((mention): EvidenceRef => ({
            sourceId: citation.sourceId,
            sourceType: 'TEXT',
            locator: mention.locator,
          })),
        ),
      ],
    });
    if (contradictoryAssociations.length > 0) {
      criticalFacts.push({
        factId: `interpretation:association-conflict:${index}`,
        field: 'siteAssociationConflict',
        confidence: 1,
        ambiguous: true,
        evidence: [
          ...evidence,
          ...contradictoryAssociations.flatMap((association) =>
            citationsToEvidence(association.evidence),
          ),
        ],
      });
    }

    if (siteId && !ambiguous) {
      const key = `${observation.field}:${siteId}`;
      const values = valuesByFieldAndSite.get(key) ?? new Set<string>();
      values.add(normalizeObservedValue(observation.field, observation.value));
      valuesByFieldAndSite.set(key, values);
    }

    if (observation.field === 'contractEndDate' && siteId) {
      dateFacts.push({
        factId: `interpretation:date:${index}`,
        siteId,
        field: 'contractEndDate',
        value: observation.value,
        credible: observation.confidence >= MIN_CONFIDENCE_FOR_CREDIBLE_EVIDENCE,
        evidence,
      });
    }

    if (
      observation.field === 'meterIdentifier' &&
      siteId &&
      !ambiguous &&
      observation.confidence >= MIN_CONFIDENCE_FOR_CREDIBLE_EVIDENCE
    ) {
      meterSiteAssociations.push({ meterIdentifier: observation.value, siteId, evidence });
    }

    if (
      !ambiguous &&
      observation.confidence >= MIN_CONFIDENCE_FOR_CREDIBLE_EVIDENCE &&
      conflictsWithStructured(observation.field, observation.value, input, siteId)
    ) {
      criticalFacts.push({
        factId: `interpretation:structured-conflict:${index}`,
        field: `${observation.field}Conflict`,
        confidence: observation.confidence,
        ambiguous: true,
        evidence,
      });
    }
  }

  for (const [key, values] of valuesByFieldAndSite) {
    if (values.size > 1) {
      criticalFacts.push({
        factId: `interpretation:internal-conflict:${key}`,
        field: `${key.split(':', 1)[0]}Conflict`,
        confidence: 1,
        ambiguous: true,
        evidence: interpretation.observations
          .filter(
            (observation) =>
              observation.siteIds.length === 1 &&
              `${observation.field}:${observation.siteIds[0]}` === key,
          )
          .flatMap((observation) => citationsToEvidence(observation.evidence)),
      });
    }
  }

  for (const [index, conflict] of interpretation.conflicts.entries()) {
    criticalFacts.push({
      factId: `interpretation:conflict:${index}`,
      field: 'semanticConflict',
      confidence: 1,
      ambiguous: true,
      evidence: citationsToEvidence(conflict.evidence),
    });
  }

  return {
    ...input.signals,
    dateFacts: [...input.signals.dateFacts, ...dateFacts],
    documentSiteAssociations: [
      ...input.signals.documentSiteAssociations,
      ...documentSiteAssociations,
    ],
    meterSiteAssociations: [...input.signals.meterSiteAssociations, ...meterSiteAssociations],
    criticalFacts: [...input.signals.criticalFacts, ...criticalFacts],
  };
}

function siteScoped(field: string): boolean {
  return field !== 'customerLegalName';
}

function findSiteLocator(
  text: string,
  site: ReadinessInput['tender']['sites'][number],
): string | undefined {
  const siteId = matchIdentifier(text, site.siteId);
  if (siteId) return siteId;
  const meter = site.meterIdentifier && matchIdentifier(text, site.meterIdentifier);
  if (meter) return meter;
  return new RegExp(escapeRegExp(site.address), 'iu').exec(text)?.[0];
}

function matchIdentifier(text: string, identifier: string): string | undefined {
  const escaped = escapeRegExp(identifier);
  return new RegExp(`(?<![\\p{L}\\p{N}_-])${escaped}(?![\\p{L}\\p{N}_-])`, 'iu').exec(text)?.[0];
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function unknownSiteLabels(quote: string, knownSiteIds: ReadonlySet<string>): string[] {
  const labels = quote.matchAll(/(?<![\p{L}\p{N}_-])site[-\s:#]+([\p{L}\p{N}_-]+)/giu);
  return [...labels].flatMap((match) => {
    const candidate = match[1]?.toLocaleLowerCase('en');
    const fullLabel = match[0].trim().toLocaleLowerCase('en');
    return knownSiteIds.has(candidate ?? '') || knownSiteIds.has(fullLabel) ? [] : [match[0]];
  });
}

function normalizeObservedValue(field: string, value: string): string {
  if (field === 'meterIdentifier') return normalizeMeterIdentifier(value);
  if (field === 'customerLegalName') return normalizeCustomerLegalName(value);
  if (field === 'contractEndDate') return normalizeTenderDate(value) ?? value.trim();
  if (field === 'annualConsumptionKwh') {
    const consumption = parseConsumption(value);
    if (consumption !== undefined) return String(consumption);
  }
  return value.trim().replace(/\s+/g, '').toLocaleLowerCase('en');
}

function normalizeCustomerLegalName(value: string): string {
  return value
    .normalize('NFKD')
    .replace(/\p{Diacritic}/gu, '')
    .toLocaleLowerCase('en')
    .replace(/[^\p{L}\p{N}]/gu, '');
}

function conflictsWithStructured(
  field: string,
  value: string,
  input: ReadinessInput,
  siteId: string | undefined,
): boolean {
  if (field === 'customerLegalName') {
    return (
      normalizeCustomerLegalName(value) !==
      normalizeCustomerLegalName(input.tender.customer.legalName)
    );
  }
  const site = input.tender.sites.find((candidate) => candidate.siteId === siteId);
  if (!site) return false;
  if (field === 'contractEndDate') {
    return Boolean(
      site.contractEndDate &&
      normalizeObservedValue(field, site.contractEndDate) !== normalizeObservedValue(field, value),
    );
  }
  if (field === 'meterIdentifier') {
    return Boolean(
      site.meterIdentifier &&
      normalizeMeterIdentifier(site.meterIdentifier) !== normalizeMeterIdentifier(value),
    );
  }
  if (field === 'annualConsumptionKwh') {
    const observed = parseConsumption(value);
    return (
      observed !== undefined &&
      site.annualConsumptionKwh !== undefined &&
      site.annualConsumptionKwh !== null &&
      observed !== site.annualConsumptionKwh
    );
  }
  return false;
}

function parseConsumption(value: string): number | undefined {
  const normalized = value
    .trim()
    .replace(/,/g, '')
    .replace(/\s*kwh$/i, '');
  if (!/^\d+(?:\.\d+)?$/.test(normalized)) return undefined;
  const number = Number(normalized);
  return Number.isFinite(number) ? number : undefined;
}
