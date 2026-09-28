import { describe, expect, it } from 'vitest';
import { evalCases, goldenSafetyCases, pullRequestCases } from './cases.js';
import { selectAgentCases, selectEvalCases } from './mastra-datasets.js';
import { EvalDatasetSchema } from './schema.js';

describe('canonical eval cases', () => {
  it('contains unique, schema-validated cases and an explicit safety subset', () => {
    const ids = evalCases.map((testCase) => testCase.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(evalCases.length).toBeGreaterThanOrEqual(60);
    expect(evalCases.length).toBeLessThanOrEqual(100);
    expect(goldenSafetyCases.length).toBeGreaterThan(0);
    expect(
      goldenSafetyCases.every((testCase) => testCase.expected.route !== 'READY_FOR_PRICING'),
    ).toBe(true);
  });

  it('keeps the pull request suite within its fast representative range', () => {
    expect(pullRequestCases.length).toBeGreaterThanOrEqual(10);
    expect(pullRequestCases.length).toBeLessThanOrEqual(20);
    expect(pullRequestCases.map((testCase) => testCase.id)).toContain(
      'second-site-missing-consumption',
    );
    expect(pullRequestCases.map((testCase) => testCase.id)).toContain(
      'meter-associated-unknown-site',
    );
    expect(selectEvalCases('pr').map((testCase) => testCase.id)).toEqual(
      pullRequestCases.map((testCase) => testCase.id),
    );
  });

  it('scores only cases where interpretation runs, excluding duplicate short-circuits', () => {
    const agentCases = selectAgentCases(evalCases);
    expect(agentCases.length).toBeGreaterThan(0);
    expect(agentCases.every((testCase) => testCase.input.textSources.length > 0)).toBe(true);
    expect(agentCases.every((testCase) => testCase.expected.route !== 'DUPLICATE')).toBe(true);
  });

  it('never labels model evidence as filling a missing structured field', () => {
    const evidenceOnly = evalCases.filter(
      (testCase) => testCase.id.startsWith('missing-') && testCase.input.textSources.length > 0,
    );
    expect(evidenceOnly.length).toBeGreaterThan(0);
    expect(evidenceOnly.every((testCase) => testCase.expected.route === 'NEEDS_INFORMATION')).toBe(
      true,
    );
  });

  it('rejects unknown evidence sources and pricing actions on non-ready labels', () => {
    const clean = structuredCase();
    const withEvidence = {
      ...clean,
      input: {
        ...clean.input,
        textSources: [
          { sourceId: 'known-source', kind: 'NOTE' as const, text: 'A synthetic note.' },
        ],
      },
      expected: {
        ...clean.expected,
        facts: [
          {
            field: 'contractEndDate' as const,
            value: '2027-03-31',
            siteId: 'site-001',
            sourceId: 'missing-source',
          },
        ],
      },
    };
    expect(() =>
      EvalDatasetSchema.parse({ schemaVersion: 1, datasetId: 'invalid', cases: [withEvidence] }),
    ).toThrow(/unknown source/i);

    const nonReady = {
      ...clean,
      expected: { ...clean.expected, route: 'HUMAN_REVIEW' as const, pricingHandoffs: 1 },
    };
    expect(() =>
      EvalDatasetSchema.parse({ schemaVersion: 1, datasetId: 'invalid', cases: [nonReady] }),
    ).toThrow(/only READY_FOR_PRICING/i);
  });

  it('keeps the corrected UK date and conflicting source pair labels faithful to the case text', () => {
    const ukDate = evalCases.find((testCase) => testCase.id === 'ready-date-note-uk');
    const conflictingPair = evalCases.find(
      (testCase) => testCase.id === 'conflicting-date-source-pair',
    );
    const ambiguousDate = evalCases.find((testCase) => testCase.id === 'ambiguous-multisite-date');
    expect(ukDate?.expected.route).toBe('READY_FOR_PRICING');
    expect(ukDate?.expected.facts[0]?.value).toBe('31/03/2027');
    expect(conflictingPair?.expected.facts.map((fact) => fact.value)).toEqual([
      '2026-09-30',
      '2026-12-31',
    ]);
    expect(ambiguousDate?.expected.facts).toMatchObject([
      { field: 'contractEndDate', value: '2026-09-30', siteId: null },
    ]);
    expect(ambiguousDate?.expected.ambiguous).toBe(true);
  });

  it('builds the missing second-site consumption regression as a real multi-site case', () => {
    const secondSite = evalCases.find(
      (testCase) => testCase.id === 'second-site-missing-consumption',
    );
    expect(secondSite?.input.tender.sites).toHaveLength(2);
    expect(secondSite?.input.tender.sites[1]?.annualConsumptionKwh).toBeUndefined();
    expect(secondSite?.expected.route).toBe('NEEDS_INFORMATION');
    expect(secondSite?.expected.pricingHandoffs).toBe(0);
    expect(secondSite?.safetySet).toBe(true);
  });

  it('labels clear ambiguous observations as unassociated evidence for human review', () => {
    for (const id of [
      'unknown-site-date',
      'meter-associated-unknown-site',
      'ambiguous-entity-note',
      'ambiguous-second-site-meter',
    ]) {
      const testCase = evalCases.find((item) => item.id === id);
      expect(testCase?.expected.facts.length, id).toBeGreaterThan(0);
      expect(
        testCase?.expected.facts.every((fact) => fact.siteId === null),
        id,
      ).toBe(true);
      expect(testCase?.expected.ambiguous, id).toBe(true);
    }
  });

  it('keeps conflicting facts attached to their separate note and document sources', () => {
    const conflict = evalCases.find((testCase) => testCase.id === 'conflicting-date-note-document');
    expect(conflict?.input.textSources.map((source) => source.sourceId)).toEqual([
      'conflicting-date-note-document-note',
      'conflicting-date-note-document-contract',
    ]);
    expect(conflict?.expected.facts.map((fact) => fact.sourceId)).toEqual([
      'conflicting-date-note-document-note',
      'conflicting-date-note-document-contract',
    ]);
    expect(conflict?.input.tender.documents).toContainEqual(
      expect.objectContaining({ documentId: 'document-002', processingStatus: 'PROCESSED' }),
    );
  });
});

function structuredCase() {
  const testCase = evalCases.find((item) => item.id === 'ready-structured-single');
  if (!testCase) throw new Error('Canonical structured ready case is missing.');
  return testCase;
}
