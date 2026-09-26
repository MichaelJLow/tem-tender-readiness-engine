import { describe, expect, it } from 'vitest';
import { evaluateReadiness } from '../../../../packages/domain/src/index.js';
import { cleanTender, missingConsumptionTender } from '../../../../tests/fixtures/tenders.js';
import { IntakeRequestSchema } from '../contracts.js';
import { toReadinessSignals, InvalidInterpretationError } from './to-readiness-signals.js';
import type { TenderInterpretation } from './contracts.js';

const note = {
  sourceId: 'broker-note-1',
  kind: 'NOTE' as const,
  text: 'The contract for site-001 ends on 2027-03-31.',
};

function interpretation(overrides: Partial<TenderInterpretation> = {}): TenderInterpretation {
  return {
    summary: 'The note states the contract end date.',
    sourceAssessments: [
      {
        sourceId: note.sourceId,
        relevance: 'RELEVANT',
        confidence: 0.99,
        ambiguous: false,
        explanation: 'A contract end date is stated.',
        evidence: [{ sourceId: note.sourceId, quote: 'site-001 ends on 2027-03-31' }],
      },
    ],
    observations: [
      {
        field: 'contractEndDate',
        value: '2027-03-31',
        siteIds: ['site-001'],
        confidence: 0.99,
        ambiguous: false,
        evidence: [{ sourceId: note.sourceId, quote: 'site-001 ends on 2027-03-31' }],
      },
    ],
    siteAssociations: [],
    conflicts: [],
    ...overrides,
  };
}

describe('text source intake and deterministic evidence mapping', () => {
  it('keeps structured-only intake compatible and defaults to no text sources', () => {
    expect(IntakeRequestSchema.parse(cleanTender).textSources).toEqual([]);
  });

  it('rejects duplicate source IDs and unknown document references before interpretation', () => {
    const duplicate = IntakeRequestSchema.safeParse({
      ...cleanTender,
      textSources: [note, note],
    });
    expect(duplicate.success).toBe(false);

    const unknownDocument = IntakeRequestSchema.safeParse({
      ...cleanTender,
      textSources: [
        {
          sourceId: 'document-text-1',
          kind: 'DOCUMENT_TEXT',
          documentId: 'missing-document',
          text: 'Some extracted text.',
        },
      ],
    });
    expect(unknownDocument.success).toBe(false);
  });

  it('rejects identifiers that cannot fit the interpretation contract at intake', () => {
    const longId = 's'.repeat(129);
    const longSiteRequest = {
      ...cleanTender,
      tender: {
        ...cleanTender.tender,
        sites: [{ ...cleanTender.tender.sites[0], siteId: longId }],
      },
    };
    expect(IntakeRequestSchema.safeParse(longSiteRequest).success).toBe(true);
    expect(
      IntakeRequestSchema.safeParse({
        ...longSiteRequest,
        textSources: [note],
      }).success,
    ).toBe(false);
    const longDocumentRequest = {
      ...cleanTender,
      tender: {
        ...cleanTender.tender,
        documents: [
          { documentId: longId, fileName: 'synthetic.pdf', contentType: 'application/pdf' },
        ],
      },
    };
    expect(IntakeRequestSchema.safeParse(longDocumentRequest).success).toBe(true);
    expect(
      IntakeRequestSchema.safeParse({
        ...longDocumentRequest,
        textSources: [note],
      }).success,
    ).toBe(false);
  });

  it('rejects extracted text linked to duplicate tender document IDs', () => {
    const result = IntakeRequestSchema.safeParse({
      ...cleanTender,
      tender: {
        ...cleanTender.tender,
        documents: [
          {
            documentId: 'duplicate-document',
            fileName: 'first.pdf',
            contentType: 'application/pdf',
          },
          {
            documentId: 'duplicate-document',
            fileName: 'second.pdf',
            contentType: 'application/pdf',
          },
        ],
      },
      textSources: [
        {
          sourceId: 'document-text-1',
          kind: 'DOCUMENT_TEXT',
          documentId: 'duplicate-document',
          text: 'Extracted text with an ambiguous document reference.',
        },
      ],
    });

    expect(result.success).toBe(false);
  });

  it('rejects a document/site association supported only by another source', () => {
    const documentText = {
      sourceId: 'document-text-1',
      kind: 'DOCUMENT_TEXT' as const,
      documentId: 'document-001',
      text: 'This supply agreement applies to site site-001.',
    };
    const noteText = {
      sourceId: 'broker-note-2',
      kind: 'NOTE' as const,
      text: 'Site 001 is the main warehouse.',
    };
    const input = IntakeRequestSchema.parse({
      ...cleanTender,
      tender: {
        ...cleanTender.tender,
        documents: [
          {
            documentId: 'document-001',
            fileName: 'agreement.pdf',
            contentType: 'application/pdf',
          },
        ],
      },
      textSources: [documentText, noteText],
    });
    const output = interpretation({
      sourceAssessments: [documentText, noteText].map((source) => ({
        sourceId: source.sourceId,
        relevance: 'RELEVANT' as const,
        confidence: 0.99,
        ambiguous: false,
        explanation: 'The source was reviewed for site association evidence.',
        evidence: [{ sourceId: source.sourceId, quote: source.text }],
      })),
      observations: [],
      siteAssociations: [
        {
          sourceId: documentText.sourceId,
          siteIds: ['site-001'],
          confidence: 0.99,
          ambiguous: false,
          evidence: [{ sourceId: noteText.sourceId, quote: 'Site 001 is the main warehouse.' }],
        },
      ],
    });

    expect(() => toReadinessSignals(input, input.textSources, output)).toThrow(
      InvalidInterpretationError,
    );

    const sourceBackedOutput = {
      ...output,
      siteAssociations: [
        {
          ...output.siteAssociations[0]!,
          evidence: [{ sourceId: documentText.sourceId, quote: 'applies to site site-001' }],
        },
      ],
    };
    expect(toReadinessSignals(input, input.textSources, sourceBackedOutput)).toMatchObject({
      documentSiteAssociations: [
        { documentId: 'document-001', status: 'RESOLVED', siteId: 'site-001' },
      ],
    });
  });

  it('uses an extracted matching date as evidence and preserves deterministic readiness', () => {
    const signals = toReadinessSignals(cleanTender, [note], interpretation());
    expect(signals.dateFacts).toHaveLength(1);
    expect(evaluateReadiness({ ...cleanTender, signals }).route).toBe('READY_FOR_PRICING');
  });

  it('reviews site-scoped facts without quote-level identity, including unknown sites', () => {
    for (const { text, quote } of [
      { text: 'The contract ends on 2027-03-31.', quote: 'The contract ends on 2027-03-31.' },
      {
        text: 'Site site-999 contract ends on 2027-03-31.',
        quote: 'Site site-999 contract ends on 2027-03-31.',
      },
      {
        text: 'Site site-001 is a different location. Site site-999 contract ends on 2027-03-31.',
        quote: 'Site site-999 contract ends on 2027-03-31.',
      },
      {
        text: 'Site site-001 is not the subject. Site site-999 contract ends on 2027-03-31.',
        quote: 'Site site-001 is not the subject. Site site-999 contract ends on 2027-03-31.',
      },
    ]) {
      const source = { ...note, text };
      const output = interpretation({
        sourceAssessments: [
          {
            ...interpretation().sourceAssessments[0]!,
            evidence: [{ sourceId: note.sourceId, quote: text }],
          },
        ],
        observations: [
          {
            ...interpretation().observations[0]!,
            evidence: [{ sourceId: note.sourceId, quote }],
          },
        ],
      });
      const signals = toReadinessSignals(cleanTender, [source], output);
      expect(evaluateReadiness({ ...cleanTender, signals }).route).toBe('HUMAN_REVIEW');
    }
  });

  it('reviews an explicit unknown site even when the model omits all observations', () => {
    const source = {
      ...note,
      text: 'Site site-999 contract ends on 2027-03-31.',
    };
    const output = interpretation({
      sourceAssessments: [
        {
          ...interpretation().sourceAssessments[0]!,
          relevance: 'NO_RELEVANT_FACTS',
          evidence: [{ sourceId: note.sourceId, quote: source.text }],
        },
      ],
      observations: [],
    });
    const signals = toReadinessSignals(cleanTender, [source], output);
    expect(signals.criticalFacts).toContainEqual(
      expect.objectContaining({ field: 'unknownSiteReference', ambiguous: true }),
    );
    expect(evaluateReadiness({ ...cleanTender, signals }).route).toBe('HUMAN_REVIEW');
  });

  it('accepts a full address in the same quote as a matching site fact', () => {
    const source = {
      ...note,
      text: 'At 10 Example Street, London, the contract ends on 2027-03-31.',
    };
    const output = interpretation({
      sourceAssessments: [
        {
          ...interpretation().sourceAssessments[0]!,
          evidence: [{ sourceId: note.sourceId, quote: source.text }],
        },
      ],
      observations: [
        {
          ...interpretation().observations[0]!,
          evidence: [{ sourceId: note.sourceId, quote: source.text }],
        },
      ],
    });
    const signals = toReadinessSignals(cleanTender, [source], output);
    expect(evaluateReadiness({ ...cleanTender, signals }).route).toBe('READY_FOR_PRICING');
  });

  it('reviews a document fact assigned to a different site even when the model omits site association', () => {
    const tender = structuredClone(cleanTender);
    tender.tender.sites.push({
      ...tender.tender.sites[0]!,
      siteId: 'site-002',
      meterIdentifier: '9876543210123',
      contractEndDate: '2026-09-30',
    });
    tender.tender.documents.push({
      documentId: 'document-001',
      fileName: 'agreement.pdf',
      contentType: 'application/pdf',
      required: true,
      processingStatus: 'PROCESSED',
    });
    const documentText = {
      sourceId: 'document-text-1',
      kind: 'DOCUMENT_TEXT' as const,
      documentId: 'document-001',
      text: 'Site site-002 contract ends on 2027-03-31.',
    };
    const output = interpretation({
      sourceAssessments: [
        {
          ...interpretation().sourceAssessments[0]!,
          sourceId: documentText.sourceId,
          evidence: [{ sourceId: documentText.sourceId, quote: documentText.text }],
        },
      ],
      observations: [
        {
          ...interpretation().observations[0]!,
          evidence: [{ sourceId: documentText.sourceId, quote: documentText.text }],
        },
      ],
    });
    const input = IntakeRequestSchema.parse({ ...tender, textSources: [documentText] });
    const signals = toReadinessSignals(input, input.textSources, output);
    expect(signals.criticalFacts).toContainEqual(
      expect.objectContaining({ field: 'contractEndDate', ambiguous: true }),
    );
    expect(evaluateReadiness({ ...input, signals }).route).toBe('HUMAN_REVIEW');

    const withWrongAssociation = {
      ...output,
      siteAssociations: [
        {
          sourceId: documentText.sourceId,
          siteIds: ['site-001'],
          confidence: 0.99,
          ambiguous: false,
          evidence: [{ sourceId: documentText.sourceId, quote: documentText.text }],
        },
      ],
    };
    const withAssociationSignals = toReadinessSignals(
      input,
      input.textSources,
      withWrongAssociation,
    );
    expect(withAssociationSignals.documentSiteAssociations).toContainEqual(
      expect.objectContaining({ documentId: 'document-001', status: 'AMBIGUOUS' }),
    );
    expect(evaluateReadiness({ ...input, signals: withAssociationSignals }).route).toBe(
      'HUMAN_REVIEW',
    );

    const unidentifiedText = {
      ...documentText,
      text: 'The contract ends on 2027-03-31.',
    };
    const unidentifiedInput = IntakeRequestSchema.parse({
      ...tender,
      textSources: [unidentifiedText],
    });
    const unidentifiedOutput = {
      ...output,
      sourceAssessments: [
        {
          ...output.sourceAssessments[0]!,
          evidence: [{ sourceId: documentText.sourceId, quote: unidentifiedText.text }],
        },
      ],
      observations: [
        {
          ...output.observations[0]!,
          evidence: [{ sourceId: documentText.sourceId, quote: unidentifiedText.text }],
        },
      ],
      siteAssociations: [
        {
          ...withWrongAssociation.siteAssociations[0]!,
          evidence: [{ sourceId: documentText.sourceId, quote: unidentifiedText.text }],
        },
      ],
    };
    const unidentifiedSignals = toReadinessSignals(
      unidentifiedInput,
      unidentifiedInput.textSources,
      unidentifiedOutput,
    );
    expect(evaluateReadiness({ ...unidentifiedInput, signals: unidentifiedSignals }).route).toBe(
      'HUMAN_REVIEW',
    );
  });

  it('requires a document site association even when its fact matches structured data', () => {
    const documentText = {
      sourceId: 'document-text-1',
      kind: 'DOCUMENT_TEXT' as const,
      documentId: 'document-001',
      text: 'The contract for site-001 ends on 2027-03-31.',
    };
    const input = IntakeRequestSchema.parse({
      ...cleanTender,
      tender: {
        ...cleanTender.tender,
        documents: [
          {
            documentId: documentText.documentId,
            fileName: 'agreement.pdf',
            contentType: 'application/pdf',
            required: true,
            processingStatus: 'PROCESSED',
          },
        ],
      },
      textSources: [documentText],
    });
    const output = interpretation({
      sourceAssessments: [
        {
          ...interpretation().sourceAssessments[0]!,
          sourceId: documentText.sourceId,
          evidence: [{ sourceId: documentText.sourceId, quote: documentText.text }],
        },
      ],
      observations: [
        {
          ...interpretation().observations[0]!,
          evidence: [{ sourceId: documentText.sourceId, quote: documentText.text }],
        },
      ],
    });
    const missingSignals = toReadinessSignals(input, input.textSources, output);
    expect(evaluateReadiness({ ...input, signals: missingSignals }).route).toBe('HUMAN_REVIEW');

    const associatedSignals = toReadinessSignals(input, input.textSources, {
      ...output,
      siteAssociations: [
        {
          sourceId: documentText.sourceId,
          siteIds: ['site-001'],
          confidence: 0.99,
          ambiguous: false,
          evidence: [{ sourceId: documentText.sourceId, quote: documentText.text }],
        },
      ],
    });
    expect(evaluateReadiness({ ...input, signals: associatedSignals }).route).toBe(
      'READY_FOR_PRICING',
    );
  });

  it('does not resolve a document association that quotes an unknown site', () => {
    const documentText = {
      sourceId: 'document-text-1',
      kind: 'DOCUMENT_TEXT' as const,
      documentId: 'document-001',
      text: 'Site site-999 contract ends on 2027-03-31.',
    };
    const input = IntakeRequestSchema.parse({
      ...cleanTender,
      tender: {
        ...cleanTender.tender,
        documents: [
          {
            documentId: documentText.documentId,
            fileName: 'synthetic.pdf',
            contentType: 'application/pdf',
            required: true,
            processingStatus: 'PROCESSED',
          },
        ],
      },
      textSources: [documentText],
    });
    const output = interpretation({
      sourceAssessments: [
        {
          ...interpretation().sourceAssessments[0]!,
          sourceId: documentText.sourceId,
          evidence: [{ sourceId: documentText.sourceId, quote: documentText.text }],
        },
      ],
      observations: [
        {
          ...interpretation().observations[0]!,
          evidence: [{ sourceId: documentText.sourceId, quote: documentText.text }],
        },
      ],
      siteAssociations: [
        {
          sourceId: documentText.sourceId,
          siteIds: ['site-001'],
          confidence: 0.99,
          ambiguous: false,
          evidence: [{ sourceId: documentText.sourceId, quote: documentText.text }],
        },
      ],
    });
    const signals = toReadinessSignals(input, input.textSources, output);
    expect(signals.documentSiteAssociations[0]?.status).toBe('AMBIGUOUS');
    expect(evaluateReadiness({ ...input, signals }).route).toBe('HUMAN_REVIEW');
  });

  it('accepts a unique meter reference as source evidence for a multi-site document', () => {
    const tender = structuredClone(cleanTender);
    tender.tender.sites.push({
      ...tender.tender.sites[0]!,
      siteId: 'site-002',
      meterIdentifier: '9876543210123',
      contractEndDate: '2026-09-30',
    });
    tender.tender.documents.push({
      documentId: 'document-001',
      fileName: 'agreement.pdf',
      contentType: 'application/pdf',
      required: true,
      processingStatus: 'PROCESSED',
    });
    const documentText = {
      sourceId: 'document-text-1',
      kind: 'DOCUMENT_TEXT' as const,
      documentId: 'document-001',
      text: 'Meter 9876543210123 contract ends on 2026-09-30.',
    };
    const input = IntakeRequestSchema.parse({ ...tender, textSources: [documentText] });
    const output = interpretation({
      sourceAssessments: [
        {
          ...interpretation().sourceAssessments[0]!,
          sourceId: documentText.sourceId,
          evidence: [{ sourceId: documentText.sourceId, quote: documentText.text }],
        },
      ],
      observations: [
        {
          ...interpretation().observations[0]!,
          value: '2026-09-30',
          siteIds: ['site-002'],
          evidence: [{ sourceId: documentText.sourceId, quote: documentText.text }],
        },
      ],
      siteAssociations: [
        {
          sourceId: documentText.sourceId,
          siteIds: ['site-002'],
          confidence: 0.99,
          ambiguous: false,
          evidence: [{ sourceId: documentText.sourceId, quote: documentText.text }],
        },
      ],
    });
    const signals = toReadinessSignals(input, input.textSources, output);
    expect(signals.documentSiteAssociations[0]?.evidence).toContainEqual(
      expect.objectContaining({ locator: '9876543210123' }),
    );
    expect(evaluateReadiness({ ...input, signals }).route).toBe('READY_FOR_PRICING');
  });

  it('rejects a mixed citation that assigns another source’s date to a conflicting note', () => {
    const conflictingNote = {
      sourceId: 'conflicting-note',
      kind: 'NOTE' as const,
      text: 'The contract ends on 2026-09-30.',
    };
    const output = interpretation({
      sourceAssessments: [
        {
          sourceId: conflictingNote.sourceId,
          relevance: 'RELEVANT',
          confidence: 0.99,
          ambiguous: false,
          explanation: 'A contract date is stated.',
          evidence: [{ sourceId: conflictingNote.sourceId, quote: conflictingNote.text }],
        },
        ...interpretation().sourceAssessments,
      ],
      observations: [
        {
          ...interpretation().observations[0]!,
          evidence: [
            { sourceId: conflictingNote.sourceId, quote: conflictingNote.text },
            { sourceId: note.sourceId, quote: 'ends on 2027-03-31' },
          ],
        },
      ],
    });

    expect(() => toReadinessSignals(cleanTender, [conflictingNote, note], output)).toThrow(
      InvalidInterpretationError,
    );
  });

  it('requires each source assessment to cite its own source', () => {
    const otherNote = {
      sourceId: 'broker-note-2',
      kind: 'NOTE' as const,
      text: 'Please call the broker tomorrow.',
    };
    const output = interpretation({
      sourceAssessments: [
        ...interpretation().sourceAssessments,
        {
          sourceId: otherNote.sourceId,
          relevance: 'NO_RELEVANT_FACTS',
          confidence: 0.99,
          ambiguous: false,
          explanation: 'No relevant facts were found.',
          evidence: [{ sourceId: note.sourceId, quote: 'ends on 2027-03-31' }],
        },
      ],
    });

    expect(() => toReadinessSignals(cleanTender, [note, otherNote], output)).toThrow(
      InvalidInterpretationError,
    );
  });

  it('treats supported date formats for the same day as one value', () => {
    const dateNote = {
      ...note,
      text: 'For site-001, the end date is 2027-03-31 (31/03/2027).',
    };
    const output = interpretation({
      sourceAssessments: [
        {
          ...interpretation().sourceAssessments[0]!,
          evidence: [{ sourceId: note.sourceId, quote: '2027-03-31' }],
        },
      ],
      observations: ['2027-03-31', '31/03/2027'].map((value) => ({
        field: 'contractEndDate' as const,
        value,
        siteIds: ['site-001'],
        confidence: 0.99,
        ambiguous: false,
        evidence: [{ sourceId: note.sourceId, quote: dateNote.text }],
      })),
    });

    const signals = toReadinessSignals(cleanTender, [dateNote], output);
    expect(evaluateReadiness({ ...cleanTender, signals }).route).toBe('READY_FOR_PRICING');
  });

  it('treats equivalent consumption formats as one value', () => {
    const consumptionNote = {
      ...note,
      text: 'For site-001, annual consumption is 24,000 kWh (24000 kWh).',
    };
    const output = interpretation({
      sourceAssessments: [
        {
          ...interpretation().sourceAssessments[0]!,
          evidence: [{ sourceId: note.sourceId, quote: '24,000 kWh' }],
        },
      ],
      observations: ['24,000 kWh', '24000 kWh'].map((value) => ({
        field: 'annualConsumptionKwh' as const,
        value,
        siteIds: ['site-001'],
        confidence: 0.99,
        ambiguous: false,
        evidence: [{ sourceId: note.sourceId, quote: consumptionNote.text }],
      })),
    });

    const signals = toReadinessSignals(cleanTender, [consumptionNote], output);
    expect(evaluateReadiness({ ...cleanTender, signals }).route).toBe('READY_FOR_PRICING');
  });

  it('routes an unparseable critical consumption observation to human review', () => {
    const consumptionNote = {
      ...note,
      text: 'Annual consumption is 25 thousand kWh.',
    };
    const output = interpretation({
      sourceAssessments: [
        {
          ...interpretation().sourceAssessments[0]!,
          evidence: [{ sourceId: note.sourceId, quote: '25 thousand kWh' }],
        },
      ],
      observations: [
        {
          field: 'annualConsumptionKwh',
          value: '25 thousand kWh',
          siteIds: ['site-001'],
          confidence: 0.99,
          ambiguous: false,
          evidence: [{ sourceId: note.sourceId, quote: '25 thousand kWh' }],
        },
      ],
    });

    const signals = toReadinessSignals(cleanTender, [consumptionNote], output);
    expect(signals.criticalFacts).toContainEqual(
      expect.objectContaining({ field: 'annualConsumptionKwh', ambiguous: true }),
    );
    expect(evaluateReadiness({ ...cleanTender, signals }).route).toBe('HUMAN_REVIEW');
  });

  it('routes an observation that contradicts its source site association to human review', () => {
    const tender = structuredClone(cleanTender);
    tender.tender.sites[0]!.contractEndDate = '2026-09-30';
    tender.tender.sites.push({
      ...tender.tender.sites[0]!,
      siteId: 'site-002',
      meterIdentifier: '9876543210123',
      contractEndDate: '2027-03-31',
    });
    const associatedNote = {
      ...note,
      text: 'For site-001, the contract ends on 2027-03-31.',
    };
    const output = interpretation({
      sourceAssessments: [
        {
          ...interpretation().sourceAssessments[0]!,
          evidence: [{ sourceId: note.sourceId, quote: '2027-03-31' }],
        },
      ],
      observations: [
        {
          field: 'contractEndDate',
          value: '2027-03-31',
          siteIds: ['site-002'],
          confidence: 0.99,
          ambiguous: false,
          evidence: [{ sourceId: note.sourceId, quote: '2027-03-31' }],
        },
      ],
      siteAssociations: [
        {
          sourceId: note.sourceId,
          siteIds: ['site-001'],
          confidence: 0.99,
          ambiguous: false,
          evidence: [{ sourceId: note.sourceId, quote: 'site-001' }],
        },
      ],
    });

    const signals = toReadinessSignals(tender, [associatedNote], output);
    expect(signals.criticalFacts).toContainEqual(
      expect.objectContaining({ field: 'siteAssociationConflict', ambiguous: true }),
    );
    expect(evaluateReadiness({ ...tender, signals }).route).toBe('HUMAN_REVIEW');
  });

  it('routes a credible conflicting date to human review', () => {
    const conflictNote = {
      ...note,
      text: 'The contract for this site ends on 2026-09-30.',
    };
    const conflict = interpretation({
      sourceAssessments: [
        {
          sourceId: note.sourceId,
          relevance: 'RELEVANT',
          confidence: 0.99,
          ambiguous: false,
          explanation: 'A conflicting contract end date is stated.',
          evidence: [{ sourceId: note.sourceId, quote: 'ends on 2026-09-30' }],
        },
      ],
      observations: [
        {
          field: 'contractEndDate',
          value: '2026-09-30',
          siteIds: ['site-001'],
          confidence: 0.99,
          ambiguous: false,
          evidence: [{ sourceId: note.sourceId, quote: 'ends on 2026-09-30' }],
        },
      ],
    });
    const signals = toReadinessSignals(cleanTender, [conflictNote], conflict);
    expect(evaluateReadiness({ ...cleanTender, signals }).route).toBe('HUMAN_REVIEW');
  });

  it('routes relevant text without a detailed extracted fact to human review', () => {
    const conflictNote = {
      ...note,
      text: 'The contract for this site ends on 2026-09-30.',
    };
    const output = interpretation({
      sourceAssessments: [
        {
          sourceId: note.sourceId,
          relevance: 'RELEVANT',
          confidence: 0.99,
          ambiguous: false,
          explanation: 'A contract end date is stated.',
          evidence: [{ sourceId: note.sourceId, quote: 'ends on 2026-09-30' }],
        },
      ],
      observations: [],
      siteAssociations: [],
      conflicts: [],
    });

    const signals = toReadinessSignals(cleanTender, [conflictNote], output);
    expect(signals.criticalFacts).toContainEqual(
      expect.objectContaining({ field: 'relevantTextWithoutExtractedFact', ambiguous: true }),
    );
    expect(evaluateReadiness({ ...cleanTender, signals }).route).toBe('HUMAN_REVIEW');
  });

  it('does not treat a site association as an extracted relevant fact', () => {
    const conflictNote = {
      ...note,
      text: 'For site-001, the contract ends on 2026-09-30.',
    };
    const output = interpretation({
      sourceAssessments: [
        {
          sourceId: note.sourceId,
          relevance: 'RELEVANT',
          confidence: 0.99,
          ambiguous: false,
          explanation: 'The note states a contract end date.',
          evidence: [{ sourceId: note.sourceId, quote: 'contract ends on 2026-09-30' }],
        },
      ],
      observations: [],
      siteAssociations: [
        {
          sourceId: note.sourceId,
          siteIds: ['site-001'],
          confidence: 0.99,
          ambiguous: false,
          evidence: [{ sourceId: note.sourceId, quote: 'site-001' }],
        },
      ],
      conflicts: [],
    });

    const signals = toReadinessSignals(cleanTender, [conflictNote], output);
    expect(signals.criticalFacts).toContainEqual(
      expect.objectContaining({ field: 'relevantTextWithoutExtractedFact', ambiguous: true }),
    );
    expect(evaluateReadiness({ ...cleanTender, signals }).route).toBe('HUMAN_REVIEW');
  });

  it('allows an irrelevant source with no detailed facts to preserve readiness', () => {
    const irrelevantNote = { ...note, text: 'Please call the broker tomorrow.' };
    const output = interpretation({
      sourceAssessments: [
        {
          sourceId: note.sourceId,
          relevance: 'NO_RELEVANT_FACTS',
          confidence: 0.99,
          ambiguous: false,
          explanation: 'The note contains no tender facts.',
          evidence: [{ sourceId: note.sourceId, quote: irrelevantNote.text }],
        },
      ],
      observations: [],
      siteAssociations: [],
      conflicts: [],
    });

    const signals = toReadinessSignals(cleanTender, [irrelevantNote], output);
    expect(evaluateReadiness({ ...cleanTender, signals }).route).toBe('READY_FOR_PRICING');
  });

  it('routes a credible conflicting customer legal name to human review', () => {
    const customerNote = {
      ...note,
      text: 'The contract customer is Northstar Retail Limited.',
    };
    const output = interpretation({
      sourceAssessments: [
        {
          sourceId: note.sourceId,
          relevance: 'RELEVANT',
          confidence: 0.99,
          ambiguous: false,
          explanation: 'The note names a contract customer.',
          evidence: [
            {
              sourceId: note.sourceId,
              quote: 'contract customer is Northstar Retail Limited',
            },
          ],
        },
      ],
      observations: [
        {
          field: 'customerLegalName',
          value: 'Northstar Retail Limited',
          siteIds: [],
          confidence: 0.99,
          ambiguous: false,
          evidence: [
            {
              sourceId: note.sourceId,
              quote: 'contract customer is Northstar Retail Limited',
            },
          ],
        },
      ],
    });

    const signals = toReadinessSignals(cleanTender, [customerNote], output);
    expect(evaluateReadiness({ ...cleanTender, signals }).route).toBe('HUMAN_REVIEW');
  });

  it('does not fill a missing required field from extracted text', () => {
    const consumptionTender = structuredClone(missingConsumptionTender);
    const consumptionNote = {
      ...note,
      text: 'For site-001, the annual consumption is 25000 kWh.',
    };
    const output = interpretation({
      summary: 'The note states annual consumption.',
      sourceAssessments: [
        {
          sourceId: note.sourceId,
          relevance: 'RELEVANT',
          confidence: 0.99,
          ambiguous: false,
          explanation: 'Annual consumption is stated.',
          evidence: [{ sourceId: note.sourceId, quote: consumptionNote.text }],
        },
      ],
      observations: [
        {
          field: 'annualConsumptionKwh',
          value: '25000 kWh',
          siteIds: ['site-001'],
          confidence: 0.99,
          ambiguous: false,
          evidence: [{ sourceId: note.sourceId, quote: consumptionNote.text }],
        },
      ],
    });
    const signals = toReadinessSignals(consumptionTender, [consumptionNote], output);
    expect(consumptionTender.tender.sites[0]?.annualConsumptionKwh).toBeUndefined();
    expect(evaluateReadiness({ ...consumptionTender, signals }).route).toBe('NEEDS_INFORMATION');
  });

  it('rejects fabricated evidence quotes and unknown site IDs', () => {
    const fabricated = interpretation({
      observations: [
        {
          ...interpretation().observations[0]!,
          evidence: [{ sourceId: note.sourceId, quote: 'made up quote' }],
        },
      ],
    });
    expect(() => toReadinessSignals(cleanTender, [note], fabricated)).toThrow(
      InvalidInterpretationError,
    );

    const unknownSite = interpretation({
      observations: [{ ...interpretation().observations[0]!, siteIds: ['unknown-site'] }],
    });
    expect(() => toReadinessSignals(cleanTender, [note], unknownSite)).toThrow(
      InvalidInterpretationError,
    );
  });
});
