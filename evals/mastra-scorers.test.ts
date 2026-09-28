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
const agentInput = JSON.stringify({
  tender: {
    sites: [{ siteId: 'site-001', address: '1 Example Road', meterIdentifier: '1234567890' }],
  },
  sources: [
    {
      sourceId: 'note-1',
      text: 'Site site-001 ends on 2027-03-31. The customer is Northstar Foods Ltd.',
    },
  ],
});

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
      input: agentInput,
      output: [
        { role: 'assistant', content: [{ type: 'text', text: JSON.stringify(interpretation) }] },
      ],
      groundTruth: { expectedFacts },
    });
    expect(result.score).toBe(1);

    const wrongSource = structuredClone(interpretation);
    wrongSource.observations[0]!.evidence[0]!.sourceId = 'other-note';
    const mismatch = await evidenceFactF1Scorer.run({
      input: agentInput,
      output: [
        { role: 'assistant', content: [{ type: 'text', text: JSON.stringify(wrongSource) }] },
      ],
      groundTruth: { expectedFacts },
    });
    expect(mismatch.score).toBe(0);
  });

  it('reads the original prompt from the Mastra agent scorer envelope', async () => {
    const result = await evidenceFactF1Scorer.run({
      input: {
        inputMessages: [{ role: 'user', parts: [{ type: 'text', text: agentInput }] }],
        rememberedMessages: [],
        systemMessages: [],
        taggedSystemMessages: [],
      },
      output: [
        { role: 'assistant', content: [{ type: 'text', text: JSON.stringify(interpretation) }] },
      ],
      groundTruth: {
        expectedFacts: [
          {
            field: 'contractEndDate',
            value: '2027-03-31',
            siteId: 'site-001',
            sourceId: 'note-1',
          },
        ],
      },
    });
    expect(result.score).toBe(1);
  });

  it('accepts two consumption candidates that share a trailing kWh unit', async () => {
    const quote =
      'For site-001, the annual usage is either 24,000 or 26,000 kWh; the broker is unsure which figure is current.';
    const input = JSON.stringify({
      tender: { sites: [{ siteId: 'site-001', address: '10 Example Street, London' }] },
      sources: [{ sourceId: 'note-1', text: quote }],
    });
    const output = {
      summary: 'Two ambiguous consumption candidates were extracted.',
      sourceAssessments: [
        {
          sourceId: 'note-1',
          relevance: 'RELEVANT' as const,
          confidence: 1,
          ambiguous: false,
          explanation: 'The note supplies two possible consumption values.',
          evidence: [{ sourceId: 'note-1', quote }],
        },
      ],
      observations: ['24,000 kWh', '26,000 kWh'].map((value) => ({
        field: 'annualConsumptionKwh' as const,
        value,
        siteIds: ['site-001'],
        confidence: 1,
        ambiguous: true,
        evidence: [{ sourceId: 'note-1', quote }],
      })),
      siteAssociations: [
        {
          sourceId: 'note-1',
          siteIds: ['site-001'],
          confidence: 1,
          ambiguous: false,
          evidence: [{ sourceId: 'note-1', quote }],
        },
      ],
      conflicts: [],
    };
    const result = await evidenceFactF1Scorer.run({
      input,
      output: { object: output },
      groundTruth: {
        expectedFacts: ['24,000', '26,000'].map((value) => ({
          field: 'annualConsumptionKwh',
          value,
          siteId: 'site-001',
          sourceId: 'note-1',
        })),
      },
    });
    expect(result.score).toBe(1);
  });

  it('accepts a shared meter fact explicitly attributed to two named sites', async () => {
    const quote =
      'Site site-001 at 10 Example Street, London and site-002 at 20 Sample Road, Bristol both use meter 1234567890123.';
    const input = JSON.stringify({
      tender: {
        sites: [
          { siteId: 'site-001', address: '10 Example Street, London' },
          { siteId: 'site-002', address: '20 Sample Road, Bristol' },
        ],
      },
      sources: [{ sourceId: 'note-1', text: quote }],
    });
    const output = {
      summary: 'The same meter is explicitly assigned to both sites.',
      sourceAssessments: [
        {
          sourceId: 'note-1',
          relevance: 'RELEVANT' as const,
          confidence: 1,
          ambiguous: false,
          explanation: 'The note names both sites and their shared meter.',
          evidence: [{ sourceId: 'note-1', quote }],
        },
      ],
      observations: [
        {
          field: 'meterIdentifier' as const,
          value: '1234567890123',
          siteIds: ['site-001', 'site-002'],
          confidence: 1,
          ambiguous: false,
          evidence: [{ sourceId: 'note-1', quote }],
        },
      ],
      siteAssociations: [
        {
          sourceId: 'note-1',
          siteIds: ['site-001', 'site-002'],
          confidence: 1,
          ambiguous: false,
          evidence: [{ sourceId: 'note-1', quote }],
        },
      ],
      conflicts: [],
    };
    const result = await evidenceFactF1Scorer.run({
      input,
      output: { object: output },
      groundTruth: {
        expectedFacts: ['site-001', 'site-002'].map((siteId) => ({
          field: 'meterIdentifier',
          value: '1234567890123',
          siteId,
          sourceId: 'note-1',
        })),
      },
    });
    expect(result.score).toBe(1);
  });

  it('accepts a multi-site association supported by separate site-specific quotes', async () => {
    const firstQuote = 'Site site-001 meter is 1234567890123.';
    const secondQuote = 'Site site-002 meter is 9876543210987.';
    const input = JSON.stringify({
      tender: {
        sites: [
          { siteId: 'site-001', address: '10 Example Street, London' },
          { siteId: 'site-002', address: '20 Sample Road, Bristol' },
        ],
      },
      sources: [
        {
          sourceId: 'note-1',
          text: `${firstQuote} ${secondQuote}`,
        },
      ],
    });
    const output = {
      summary: 'The document gives a separate meter for each site.',
      sourceAssessments: [
        {
          sourceId: 'note-1',
          relevance: 'RELEVANT' as const,
          confidence: 1,
          ambiguous: false,
          explanation: 'It states one meter for each named site.',
          evidence: [
            { sourceId: 'note-1', quote: firstQuote },
            { sourceId: 'note-1', quote: secondQuote },
          ],
        },
      ],
      observations: [
        {
          field: 'meterIdentifier' as const,
          value: '1234567890123',
          siteIds: ['site-001'],
          confidence: 1,
          ambiguous: false,
          evidence: [{ sourceId: 'note-1', quote: firstQuote }],
        },
        {
          field: 'meterIdentifier' as const,
          value: '9876543210987',
          siteIds: ['site-002'],
          confidence: 1,
          ambiguous: false,
          evidence: [{ sourceId: 'note-1', quote: secondQuote }],
        },
      ],
      siteAssociations: [
        {
          sourceId: 'note-1',
          siteIds: ['site-001', 'site-002'],
          confidence: 1,
          ambiguous: false,
          evidence: [
            { sourceId: 'note-1', quote: firstQuote },
            { sourceId: 'note-1', quote: secondQuote },
          ],
        },
      ],
      conflicts: [],
    };
    const result = await evidenceFactF1Scorer.run({
      input,
      output: { object: output },
      groundTruth: {
        expectedFacts: [
          {
            field: 'meterIdentifier',
            value: '1234567890123',
            siteId: 'site-001',
            sourceId: 'note-1',
          },
          {
            field: 'meterIdentifier',
            value: '9876543210987',
            siteId: 'site-002',
            sourceId: 'note-1',
          },
        ],
      },
    });
    expect(result.score).toBe(1);
  });

  it('counts each site and source fact once when a multi-site observation has several citations', async () => {
    const firstQuote = 'Site site-001 uses meter 1234567890123.';
    const secondQuote = 'Site site-002 uses meter 1234567890123.';
    const input = JSON.stringify({
      tender: { sites: [{ siteId: 'site-001' }, { siteId: 'site-002' }] },
      sources: [
        { sourceId: 'note-1', text: firstQuote },
        { sourceId: 'note-2', text: secondQuote },
      ],
    });
    const output = {
      summary: 'The same meter is stated for both sites in separate notes.',
      sourceAssessments: [
        {
          sourceId: 'note-1',
          relevance: 'RELEVANT' as const,
          confidence: 1,
          ambiguous: false,
          explanation: 'Names the first site and meter.',
          evidence: [{ sourceId: 'note-1', quote: firstQuote }],
        },
        {
          sourceId: 'note-2',
          relevance: 'RELEVANT' as const,
          confidence: 1,
          ambiguous: false,
          explanation: 'Names the second site and meter.',
          evidence: [{ sourceId: 'note-2', quote: secondQuote }],
        },
      ],
      observations: [
        {
          field: 'meterIdentifier' as const,
          value: '1234567890123',
          siteIds: ['site-001', 'site-002'],
          confidence: 1,
          ambiguous: false,
          evidence: [
            { sourceId: 'note-1', quote: firstQuote },
            { sourceId: 'note-1', quote: firstQuote },
            { sourceId: 'note-2', quote: secondQuote },
          ],
        },
      ],
      siteAssociations: [],
      conflicts: [],
    };
    const result = await evidenceFactF1Scorer.run({
      input,
      output: { object: output },
      groundTruth: {
        expectedFacts: [
          {
            field: 'meterIdentifier',
            value: '1234567890123',
            siteId: 'site-001',
            sourceId: 'note-1',
          },
          {
            field: 'meterIdentifier',
            value: '1234567890123',
            siteId: 'site-002',
            sourceId: 'note-2',
          },
        ],
      },
    });
    expect(result.score).toBe(1);
  });

  it('keeps an explicit site attribution when the quoted meter conflicts with another site', async () => {
    const quote = 'Site site-002 at 20 Sample Road, Bristol has meter 1234567890123.';
    const input = JSON.stringify({
      tender: {
        sites: [
          {
            siteId: 'site-001',
            address: '10 Example Street, London',
            meterIdentifier: '1234567890123',
          },
          {
            siteId: 'site-002',
            address: '20 Sample Road, Bristol',
            meterIdentifier: '9876543210987',
          },
        ],
      },
      sources: [{ sourceId: 'note-1', text: quote }],
    });
    const output = {
      summary: 'The text assigns the meter to site-002.',
      sourceAssessments: [
        {
          sourceId: 'note-1',
          relevance: 'RELEVANT' as const,
          confidence: 1,
          ambiguous: false,
          explanation: 'The note explicitly identifies site-002.',
          evidence: [{ sourceId: 'note-1', quote }],
        },
      ],
      observations: [
        {
          field: 'meterIdentifier' as const,
          value: '1234567890123',
          siteIds: ['site-002'],
          confidence: 1,
          ambiguous: false,
          evidence: [{ sourceId: 'note-1', quote }],
        },
      ],
      siteAssociations: [
        {
          sourceId: 'note-1',
          siteIds: ['site-002'],
          confidence: 1,
          ambiguous: false,
          evidence: [{ sourceId: 'note-1', quote }],
        },
      ],
      conflicts: [],
    };
    const result = await evidenceFactF1Scorer.run({
      input,
      output: { object: output },
      groundTruth: {
        expectedFacts: [
          {
            field: 'meterIdentifier',
            value: '1234567890123',
            siteId: 'site-002',
            sourceId: 'note-1',
          },
        ],
      },
    });
    expect(result.score).toBe(1);
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
      input: agentInput,
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
