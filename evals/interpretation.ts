import {
  TenderInterpretationSchema,
  type TenderInterpretation,
} from '../apps/api/src/reasoning/contracts.js';
import { EvalFactSchema, type EvalFact } from './schema.js';

export function toAgentFacts(rawInterpretation: unknown): EvalFact[] {
  const interpretation = TenderInterpretationSchema.parse(rawInterpretation);
  return interpretation.observations
    .flatMap((observation) => {
      const siteIds: Array<string | null> =
        observation.siteIds.length > 0 ? observation.siteIds : [null];
      return siteIds.flatMap((siteId) =>
        observation.evidence.map((evidence) => ({
          field: observation.field,
          value: observation.value,
          siteId,
          sourceId: evidence.sourceId,
        })),
      );
    })
    .map((fact) => EvalFactSchema.parse(fact));
}

/** Validate citations against the exact synthetic prompt sent to the agent. */
export function interpretationHasGroundedEvidence(rawInterpretation: unknown, rawInput: unknown) {
  const interpretation = TenderInterpretationSchema.safeParse(rawInterpretation);
  const input = parseAgentInput(rawInput);
  if (!interpretation.success || !input) return false;
  const sourceById = new Map(input.sources.map((source) => [source.sourceId, source.text]));
  const siteById = new Map(input.tender.sites.map((site) => [site.siteId, site]));
  const validCitation = (citation: { sourceId: string; quote: string }) =>
    sourceById.get(citation.sourceId)?.includes(citation.quote) === true;
  const siteMentioned = (quote: string, siteId: string) => {
    const site = siteById.get(siteId);
    if (!site) return false;
    const normalizedQuote = normalizeEvidenceText(quote);
    return [site.siteId, site.address, site.meterIdentifier]
      .filter((value): value is string => typeof value === 'string' && value.length > 0)
      .some((value) => normalizedQuote.includes(normalizeEvidenceText(value)));
  };
  const valueMentioned = (quote: string, field: string, value: string) => {
    const normalizedQuote = normalizeEvidenceText(quote);
    const normalizedValue = normalizeEvidenceText(value);
    if (normalizedValue && normalizedQuote.includes(normalizedValue)) return true;
    if (field === 'contractEndDate') {
      const dayFirst = value.match(/^(\d{4})-(\d{2})-(\d{2})$/);
      if (dayFirst) {
        const [year, month, day] = dayFirst.slice(1);
        return (
          quote.includes(`${day}/${month}/${year}`) || quote.includes(`${day}-${month}-${year}`)
        );
      }
    }
    if (field === 'annualConsumptionKwh') {
      const expected = value.replace(/,/g, '').match(/\d+(?:\.\d+)?/)?.[0];
      return expected !== undefined && quote.replace(/,/g, '').includes(expected);
    }
    return false;
  };

  const result = interpretation.data;
  if (
    [...result.sourceAssessments, ...result.observations, ...result.siteAssociations].some((item) =>
      item.evidence.some((citation) => !validCitation(citation)),
    ) ||
    result.conflicts.some((item) => item.evidence.some((citation) => !validCitation(citation)))
  )
    return false;

  for (const observation of result.observations) {
    if (observation.siteIds.length === 0) {
      if (
        !observation.evidence.some((citation) =>
          valueMentioned(citation.quote, observation.field, observation.value),
        )
      )
        return false;
      continue;
    }
    for (const siteId of observation.siteIds) {
      if (!siteById.has(siteId)) return false;
      if (
        !observation.evidence.some(
          (citation) =>
            valueMentioned(citation.quote, observation.field, observation.value) &&
            siteMentioned(citation.quote, siteId),
        )
      )
        return false;
    }
  }
  for (const association of result.siteAssociations) {
    if (
      !sourceById.has(association.sourceId) ||
      association.siteIds.some(
        (siteId) =>
          !siteById.has(siteId) ||
          !association.evidence.some(
            (citation) =>
              citation.sourceId === association.sourceId && siteMentioned(citation.quote, siteId),
          ),
      )
    )
      return false;
  }
  return true;
}

function parseAgentInput(value: unknown):
  | {
      tender: { sites: Array<{ siteId: string; address?: string; meterIdentifier?: string }> };
      sources: Array<{ sourceId: string; text: string }>;
    }
  | undefined {
  try {
    const parsed = typeof value === 'string' ? (JSON.parse(value) as unknown) : value;
    if (typeof parsed !== 'object' || parsed === null) return undefined;
    const record = parsed as Record<string, unknown>;
    const tender = record.tender as Record<string, unknown> | undefined;
    if (!tender || !Array.isArray(tender.sites) || !Array.isArray(record.sources)) return undefined;
    const sites = tender.sites.map((site) => site as Record<string, unknown>);
    const sources = record.sources.map((source) => source as Record<string, unknown>);
    if (
      sites.some((site) => typeof site.siteId !== 'string') ||
      sources.some(
        (source) => typeof source.sourceId !== 'string' || typeof source.text !== 'string',
      )
    )
      return undefined;
    return {
      tender: {
        sites: sites as Array<{ siteId: string; address?: string; meterIdentifier?: string }>,
      },
      sources: sources as Array<{ sourceId: string; text: string }>,
    };
  } catch {
    return undefined;
  }
}

function normalizeEvidenceText(value: string) {
  return value.toLocaleLowerCase('en').replace(/[^\p{L}\p{N}]/gu, '');
}

export function findTenderInterpretation(
  value: unknown,
  seen = new Set<object>(),
): TenderInterpretation | undefined {
  const direct = TenderInterpretationSchema.safeParse(value);
  if (direct.success) return direct.data;
  if (typeof value === 'string') {
    try {
      return findTenderInterpretation(JSON.parse(value) as unknown, seen);
    } catch {
      return undefined;
    }
  }
  if (typeof value !== 'object' || value === null || seen.has(value)) return undefined;
  seen.add(value);
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = findTenderInterpretation(item, seen);
      if (found) return found;
    }
    return undefined;
  }
  const record = value as Record<string, unknown>;
  for (const key of [
    'object',
    'structuredOutput',
    'data',
    'payload',
    'content',
    'parts',
    'text',
    'result',
    'output',
  ]) {
    if (!(key in record)) continue;
    const found = findTenderInterpretation(record[key], seen);
    if (found) return found;
  }
  return undefined;
}

export function interpretationIsAmbiguous(value: unknown): boolean {
  const interpretation = TenderInterpretationSchema.safeParse(value);
  if (!interpretation.success) return false;
  const result = interpretation.data;
  return [...result.observations, ...result.siteAssociations].some((item) => item.ambiguous);
}

export function normalizedFactKey(fact: EvalFact): string {
  let value = fact.value.trim().toLocaleLowerCase('en');
  if (fact.field === 'contractEndDate') {
    const iso = value.match(/^(\d{4})-(\d{2})-(\d{2})$/);
    const dayFirst = value.match(/^(\d{2})[/-](\d{2})[/-](\d{4})$/);
    if (iso) value = `${iso[1]}-${iso[2]}-${iso[3]}`;
    else if (dayFirst) value = `${dayFirst[3]}-${dayFirst[2]}-${dayFirst[1]}`;
  }
  if (fact.field === 'meterIdentifier') value = value.replace(/\s/g, '').toUpperCase();
  if (fact.field === 'annualConsumptionKwh') {
    const quantity = value.match(/\d[\d,]*(?:\.\d+)?/);
    value = quantity ? quantity[0].replace(/,/g, '') : value.replace(/[\s,]|kwh/gi, '');
  }
  if (fact.field === 'customerLegalName') {
    value = value.replace(/[.,;:!?]+$/g, '').replace(/\s+/g, ' ');
  }
  return [fact.field, value, fact.siteId ?? '', fact.sourceId].join('\u001f');
}
