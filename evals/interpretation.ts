import {
  TenderInterpretationSchema,
  type TenderInterpretation,
} from '../apps/api/src/reasoning/contracts.js';
import { EvalFactSchema, type EvalFact } from './schema.js';

export function toAgentFacts(rawInterpretation: unknown, rawInput: unknown): EvalFact[] {
  const interpretation = TenderInterpretationSchema.parse(rawInterpretation);
  const input = parseAgentInput(rawInput);
  if (!input) throw new Error('Cannot extract facts without the agent input.');
  const facts = new Map<string, EvalFact>();
  for (const observation of interpretation.observations) {
    for (const evidence of observation.evidence) {
      const siteIds: Array<string | null> =
        observation.siteIds.length === 0
          ? [null]
          : sitesLocatedByQuote(input.tender.sites, evidence.quote)
              .map((site) => site.siteId)
              .filter((siteId) => observation.siteIds.includes(siteId));
      for (const siteId of siteIds) {
        const fact = EvalFactSchema.parse({
          field: observation.field,
          value: observation.value,
          siteId,
          sourceId: evidence.sourceId,
        });
        facts.set(normalizedFactKey(fact), fact);
      }
    }
  }
  return [...facts.values()];
}

/** Validate citations against the exact synthetic prompt sent to the agent. */
export function interpretationHasGroundedEvidence(rawInterpretation: unknown, rawInput: unknown) {
  const interpretation = TenderInterpretationSchema.safeParse(rawInterpretation);
  const input = parseAgentInput(rawInput);
  if (!interpretation.success || !input) return false;
  const sourceById = new Map(input.sources.map((source) => [source.sourceId, source.text]));
  const siteById = new Map(input.tender.sites.map((site) => [site.siteId, site]));
  const lowercaseSiteIds = new Set(
    input.tender.sites.map((site) => site.siteId.toLocaleLowerCase('en')),
  );
  const validCitation = (citation: { sourceId: string; quote: string }) =>
    sourceById.get(citation.sourceId)?.includes(citation.quote) === true;
  const sitesInQuote = (quote: string) => sitesLocatedByQuote(input.tender.sites, quote);
  const valueMentioned = (quote: string, field: string, value: string) => {
    if (field === 'meterIdentifier') {
      const escaped = value.trim().split('').map(escapeRegExp).join('[\\s-]*');
      return new RegExp(`(?<!\\d)${escaped}(?!\\d)`, 'u').test(quote);
    }
    const normalizedQuote = normalizeEvidenceText(quote);
    const normalizedValue = normalizeEvidenceText(value);
    if (normalizedValue && ` ${normalizedQuote} `.includes(` ${normalizedValue} `)) return true;
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
      const expected = value.match(/\d[\d,]*(?:\.\d+)?/)?.[0]?.replace(/,/g, '');
      if (!expected) return false;
      return [...quote.matchAll(/\d[\d,]*(?:\.\d+)?/g)].some(
        (match) => match[0].replace(/,/g, '') === expected,
      );
    }
    return false;
  };

  const result = interpretation.data;
  if (
    result.sourceAssessments.length !== sourceById.size ||
    new Set(result.sourceAssessments.map((item) => item.sourceId)).size !== sourceById.size ||
    result.sourceAssessments.some(
      (item) =>
        !sourceById.has(item.sourceId) ||
        item.evidence.some(
          (citation) => citation.sourceId !== item.sourceId || !validCitation(citation),
        ),
    ) ||
    result.conflicts.some((item) => item.evidence.some((citation) => !validCitation(citation)))
  )
    return false;

  for (const observation of result.observations) {
    if (observation.siteIds.some((siteId) => !siteById.has(siteId))) return false;
    if (
      observation.evidence.some((citation) => {
        if (
          !validCitation(citation) ||
          !valueMentioned(citation.quote, observation.field, observation.value) ||
          (observation.siteIds.length > 0 && unknownSiteLabels(citation.quote, lowercaseSiteIds))
        )
          return true;
        if (observation.siteIds.length === 0) return false;
        const matchingSites = sitesInQuote(citation.quote);
        return !siteIdsAreWithin(
          matchingSites.map((site) => site.siteId),
          observation.siteIds,
        );
      })
    )
      return false;
    if (
      observation.siteIds.some(
        (siteId) =>
          !observation.evidence.some((citation) =>
            sitesInQuote(citation.quote).some((site) => site.siteId === siteId),
          ),
      )
    )
      return false;
  }
  for (const association of result.siteAssociations) {
    if (
      !sourceById.has(association.sourceId) ||
      association.siteIds.some((siteId) => !siteById.has(siteId)) ||
      association.evidence.some(
        (citation) =>
          citation.sourceId !== association.sourceId ||
          !validCitation(citation) ||
          (association.siteIds.length > 0 && unknownSiteLabels(citation.quote, lowercaseSiteIds)) ||
          (association.siteIds.length > 0 &&
            !siteIdsAreWithin(
              sitesInQuote(citation.quote).map((site) => site.siteId),
              association.siteIds,
            )),
      ) ||
      association.siteIds.some(
        (siteId) =>
          !association.evidence.some((citation) =>
            sitesInQuote(citation.quote).some((site) => site.siteId === siteId),
          ),
      )
    )
      return false;
  }
  return true;
}

function parseAgentInput(
  value: unknown,
  seen = new Set<object>(),
):
  | {
      tender: { sites: Array<{ siteId: string; address?: string; meterIdentifier?: string }> };
      sources: Array<{ sourceId: string; text: string }>;
    }
  | undefined {
  try {
    if (typeof value === 'string') return parseAgentInput(JSON.parse(value) as unknown, seen);
    const parsed = value;
    if (typeof parsed !== 'object' || parsed === null) return undefined;
    if (seen.has(parsed)) return undefined;
    seen.add(parsed);
    if (Array.isArray(parsed)) {
      for (const item of parsed) {
        const input = parseAgentInput(item, seen);
        if (input) return input;
      }
      return undefined;
    }
    const record = parsed as Record<string, unknown>;
    const tender = record.tender as Record<string, unknown> | undefined;
    const rawSources = Array.isArray(record.sources) ? record.sources : record.textSources;
    if (tender && Array.isArray(tender.sites) && Array.isArray(rawSources)) {
      const sites = tender.sites.map((site) => site as Record<string, unknown>);
      const sources = rawSources.map((source) => source as Record<string, unknown>);
      if (
        sites.every((site) => typeof site.siteId === 'string') &&
        sources.every(
          (source) => typeof source.sourceId === 'string' && typeof source.text === 'string',
        )
      ) {
        return {
          tender: {
            sites: sites as Array<{ siteId: string; address?: string; meterIdentifier?: string }>,
          },
          sources: sources as Array<{ sourceId: string; text: string }>,
        };
      }
    }
    for (const key of ['inputMessages', 'messages', 'content', 'parts', 'text', 'data']) {
      if (!(key in record)) continue;
      const input = parseAgentInput(record[key], seen);
      if (input) return input;
    }
    return undefined;
  } catch {
    return undefined;
  }
}

function normalizeEvidenceText(value: string) {
  return value
    .toLocaleLowerCase('en')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim()
    .replace(/\s+/g, ' ');
}

type InputSite = { siteId: string; address?: string; meterIdentifier?: string };

function sitesLocatedByQuote(sites: readonly InputSite[], quote: string) {
  const explicitSites = sites.filter(
    (site) =>
      quoteHasIdentifier(quote, site.siteId, false) ||
      (site.address
        ? normalizeEvidenceText(quote).includes(normalizeEvidenceText(site.address))
        : false),
  );
  if (explicitSites.length > 0) return explicitSites;
  return sites.filter((site) =>
    site.meterIdentifier ? quoteHasIdentifier(quote, site.meterIdentifier, true) : false,
  );
}

function quoteHasIdentifier(quote: string, identifier: string, allowSpaces: boolean) {
  const escaped = identifier
    .trim()
    .split('')
    .map(escapeRegExp)
    .join(allowSpaces ? '[\\s-]*' : '');
  const pattern = new RegExp(`(?<![\\p{L}\\p{N}_-])${escaped}(?![\\p{L}\\p{N}_-])`, 'iu');
  return pattern.test(quote);
}

function siteIdsAreWithin(actual: readonly string[], claimed: readonly string[]) {
  return actual.length > 0 && actual.every((siteId) => claimed.includes(siteId));
}

function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function unknownSiteLabels(quote: string, knownSiteIds: ReadonlySet<string>) {
  return [...quote.matchAll(/(?<![\p{L}\p{N}_-])site[-\s:#]+([\p{L}\p{N}_-]+)/giu)].some(
    (match) => {
      const candidate = match[1]?.toLocaleLowerCase('en');
      const fullLabel = match[0].trim().toLocaleLowerCase('en');
      return !knownSiteIds.has(candidate ?? '') && !knownSiteIds.has(fullLabel);
    },
  );
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
