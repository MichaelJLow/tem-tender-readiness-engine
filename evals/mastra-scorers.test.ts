import { describe, expect, it } from 'vitest';
import { ambiguityRecallScorer, evidenceFactF1Scorer } from './mastra-scorers.js';

const interpretation = {
  summary: 'Synthetic evidence extracted.',
  sourceAssessments: [
    {
      sourceId: 'note-1',
      relevance: 'RELEVANT' as const,
      confidence: 0.99,
      ambiguous: false,
      explanation: 'The note identifies the contract date.',
      evidence: [{ sourceId: 'note-1', quote: 'Site site-001 ends on 2027-03-31.' }],
    },
  ],
  observations: [
    {
      field: 'contractEndDate' as const,
      value: '2027-03-31',
      siteIds: ['site-001'],
      confidence: 0.99,
      ambiguous: false,
      evidence: [{ sourceId: 'note-1', quote: 'Site site-001 ends on 2027-03-31.' }],
    },
  ],
  siteAssociations: [],
  conflicts: [],
};

describe('Mastra eval scorers', () => {
  it('scores exact value, site, and source attribution', async () => {
    const expectedFacts = [
      {
        field: 'contractEndDate' as const,
        value: '2027-03-31',
        siteId: 'site-001',
        sourceId: 'note-1',
      },
    ];
    const result = await evidenceFactF1Scorer.run({
      input: 'Synthetic note input.',
      output: [
        { role: 'assistant', content: [{ type: 'text', text: JSON.stringify(interpretation) }] },
      ],
      groundTruth: { expectedFacts },
    });
    expect(result.score).toBe(1);

    const wrongSource = structuredClone(interpretation);
    wrongSource.observations[0]!.evidence[0]!.sourceId = 'other-note';
    const mismatch = await evidenceFactF1Scorer.run({
      input: 'Synthetic note input.',
      output: [
        { role: 'assistant', content: [{ type: 'text', text: JSON.stringify(wrongSource) }] },
      ],
      groundTruth: { expectedFacts },
    });
    expect(mismatch.score).toBe(0);
  });

  it('ignores terminal punctuation in customer legal-name facts', async () => {
    const customer = {
      ...structuredClone(interpretation),
      observations: [
        {
          field: 'customerLegalName' as const,
          value: 'Northstar Foods Ltd.',
          siteIds: [],
          confidence: 0.99,
          ambiguous: false,
          evidence: [{ sourceId: 'note-1', quote: 'The customer is Northstar Foods Ltd.' }],
        },
      ],
    };
    const result = await evidenceFactF1Scorer.run({
      input: 'Synthetic customer-name note.',
      output: [{ role: 'assistant', content: [{ type: 'text', text: JSON.stringify(customer) }] }],
      groundTruth: {
        expectedFacts: [
          {
            field: 'customerLegalName',
            value: 'Northstar Foods Ltd',
            siteId: null,
            sourceId: 'note-1',
          },
        ],
      },
    });
    expect(result.score).toBe(1);
  });

  it('scores explicit ambiguity only when the label expects it', async () => {
    const ambiguous = structuredClone(interpretation);
    ambiguous.observations[0]!.ambiguous = true;
    const expected = await ambiguityRecallScorer.run({
      input: 'Ambiguous synthetic note.',
      output: { object: ambiguous },
      groundTruth: { expectedAmbiguous: true },
    });
    const falsePositive = await ambiguityRecallScorer.run({
      input: 'Clear synthetic note.',
      output: { object: ambiguous },
      groundTruth: { expectedAmbiguous: false },
    });
    expect(expected.score).toBe(1);
    expect(falsePositive.score).toBe(0);
  });
});
