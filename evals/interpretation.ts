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
