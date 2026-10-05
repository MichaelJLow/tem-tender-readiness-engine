import { describe, expect, it } from 'vitest';
import { evaluateReadiness } from './evaluate.js';
import {
  FAILED_INTAKE_DOCUMENT_STATUSES,
  INTAKE_PACK_ENTRY_NAME,
  INTAKE_PACK_LIMITS,
  IntakeCandidateSchema,
  IntakeConfirmationSchema,
  IntakeDocumentFailureCodeSchema,
  IntakeDocumentSchema,
  IntakeDocumentStatusSchema,
  IntakeDraftSchema,
  IntakeExtractionSchema,
  IntakeFailureTaxonomySchema,
  IntakePackSchema,
  IntakeProvenanceSchema,
  canConfirmIntakePack,
  draftStructuredFieldsAreEmpty,
  intakeLayerMayInvokePricing,
  mapIntakeDocumentStatusToReadiness,
  snapshotDraftForConfirmation,
  type IntakeDocument,
  type IntakePack,
} from './intake-pack.js';

const NOW = '2026-10-05T16:00:00.000Z';

function document(overrides: Partial<IntakeDocument> = {}): IntakeDocument {
  return {
    documentId: 'doc-001',
    packId: 'pack-001',
    fileName: 'synthetic-contract.pdf',
    contentType: 'application/pdf',
    byteSize: 12_000,
    pageCount: 2,
    status: 'EXTRACTED',
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

function pack(overrides: Partial<IntakePack> = {}): IntakePack {
  return IntakePackSchema.parse({
    packId: 'pack-001',
    kind: 'INTAKE_PACK',
    entryPoint: INTAKE_PACK_ENTRY_NAME,
    synthetic: true,
    status: 'REVIEWABLE',
    createdAt: NOW,
    updatedAt: NOW,
    documents: [document()],
    notes: [
      {
        noteId: 'note-001',
        text: 'Broker note for the synthetic pack.',
        createdAt: NOW,
        updatedAt: NOW,
      },
    ],
    extraction: {
      extractionId: 'extraction-001',
      packId: 'pack-001',
      createdAt: NOW,
      immutable: true,
      pages: [
        {
          documentId: 'doc-001',
          pageNumber: 1,
          text: 'Northstar Foods Ltd MPAN 1234567890123',
          charCount: 'Northstar Foods Ltd MPAN 1234567890123'.length,
          selectableText: true,
        },
      ],
      documents: [
        {
          documentId: 'doc-001',
          status: 'EXTRACTED',
          pageCount: 2,
          extractedCharCount: 'Northstar Foods Ltd MPAN 1234567890123'.length,
        },
      ],
    },
    draft: {
      packId: 'pack-001',
      draftVersion: 1,
      updatedAt: NOW,
      customer: {},
      broker: {},
      sites: [],
      candidates: [
        {
          candidateId: 'candidate-001',
          field: 'customerLegalName',
          value: 'Northstar Foods Ltd',
          associationStatus: 'UNRESOLVED',
          accepted: false,
          provenance: [
            {
              sourceKind: 'DOCUMENT_PAGE',
              sourceId: 'doc-001',
              documentId: 'doc-001',
              pageNumber: 1,
              quote: 'Northstar Foods Ltd',
            },
          ],
        },
      ],
    },
    ...overrides,
  });
}

describe('Intake pack contracts', () => {
  it('names the Console entry point Intake pack and requires synthetic packs', () => {
    expect(INTAKE_PACK_ENTRY_NAME).toBe('Intake pack');
    expect(() =>
      IntakePackSchema.parse({
        ...pack(),
        synthetic: false,
      }),
    ).toThrow();
  });

  it('encodes document, file, page, and extracted-text bounds', () => {
    expect(INTAKE_PACK_LIMITS).toMatchObject({
      maxDocuments: 7,
      maxNotes: 1,
      maxFileBytes: 8 * 1024 * 1024,
      maxPackBytes: 24 * 1024 * 1024,
      maxPagesPerDocument: 25,
      maxPagesPerPack: 50,
      maxExtractedCharsPerPage: 8_000,
      maxExtractedCharsPerDocument: 40_000,
      maxExtractedCharsPerPack: 120_000,
      maxNoteChars: 40_000,
      maxMappedTextSources: 8,
    });

    expect(
      IntakePackSchema.safeParse({
        ...pack(),
        documents: Array.from({ length: 8 }, (_, index) =>
          document({ documentId: `doc-${index}`, fileName: `file-${index}.pdf` }),
        ),
      }).success,
    ).toBe(false);

    expect(
      IntakeDocumentSchema.safeParse(document({ byteSize: INTAKE_PACK_LIMITS.maxFileBytes + 1 }))
        .success,
    ).toBe(false);

    expect(
      IntakePackSchema.safeParse({
        ...pack(),
        documents: Array.from({ length: 4 }, (_, index) =>
          document({
            documentId: `doc-${index}`,
            fileName: `file-${index}.pdf`,
            byteSize: INTAKE_PACK_LIMITS.maxFileBytes,
            pageCount: 20,
          }),
        ),
      }).success,
    ).toBe(false);
  });

  it('lists document statuses including OCR_REQUIRED and extraction failures', () => {
    expect(IntakeDocumentStatusSchema.options).toEqual([
      'UPLOADED',
      'VALIDATING',
      'EXTRACTING',
      'EXTRACTED',
      'OCR_REQUIRED',
      'CORRUPT',
      'UNSUPPORTED',
      'OVERSIZED',
      'EXTRACTION_FAILED',
    ]);
    expect(IntakeDocumentFailureCodeSchema.options).toEqual([...FAILED_INTAKE_DOCUMENT_STATUSES]);
    expect(IntakeFailureTaxonomySchema.options).toEqual(
      expect.arrayContaining([
        'OCR_REQUIRED',
        'CORRUPT',
        'UNSUPPORTED',
        'OVERSIZED',
        'EXTRACTION_FAILED',
        'DRAFT_STALE',
        'NOT_CONFIRMABLE',
      ]),
    );
  });

  it('maps terminal intake statuses onto existing document processing statuses', () => {
    expect(mapIntakeDocumentStatusToReadiness('EXTRACTED')).toBe('PROCESSED');
    expect(mapIntakeDocumentStatusToReadiness('OCR_REQUIRED')).toBe('UNREADABLE');
    expect(mapIntakeDocumentStatusToReadiness('CORRUPT')).toBe('CORRUPTED');
    expect(mapIntakeDocumentStatusToReadiness('UNSUPPORTED')).toBe('UNSUPPORTED');
    expect(mapIntakeDocumentStatusToReadiness('OVERSIZED')).toBe('FAILED_TERMINAL');
    expect(mapIntakeDocumentStatusToReadiness('EXTRACTION_FAILED')).toBe('FAILED_TERMINAL');
    expect(mapIntakeDocumentStatusToReadiness('UPLOADED')).toBeUndefined();
    expect(mapIntakeDocumentStatusToReadiness('VALIDATING')).toBeUndefined();
    expect(mapIntakeDocumentStatusToReadiness('EXTRACTING')).toBeUndefined();
  });

  it('keeps extraction immutable and rejects page/text bound breaches', () => {
    expect(
      IntakeExtractionSchema.safeParse({
        ...pack().extraction,
        immutable: false,
      }).success,
    ).toBe(false);

    expect(
      IntakeExtractionSchema.safeParse({
        ...pack().extraction,
        pages: [
          {
            documentId: 'doc-001',
            pageNumber: 1,
            text: 'ab',
            charCount: 3,
            selectableText: true,
          },
        ],
      }).success,
    ).toBe(false);
  });

  it('requires document-page provenance to cite a page and forbids note page claims', () => {
    expect(
      IntakeProvenanceSchema.safeParse({
        sourceKind: 'DOCUMENT_PAGE',
        sourceId: 'doc-001',
        quote: 'Northstar Foods Ltd',
      }).success,
    ).toBe(false);

    expect(
      IntakeProvenanceSchema.safeParse({
        sourceKind: 'NOTE',
        sourceId: 'note-001',
        documentId: 'doc-001',
        quote: 'Broker note',
      }).success,
    ).toBe(false);
  });

  it('treats candidates as review-only and leaves structured draft fields empty after extraction', () => {
    const emptyDraft = pack().draft!;
    expect(draftStructuredFieldsAreEmpty(emptyDraft)).toBe(true);
    expect(emptyDraft.candidates[0]?.value).toBe('Northstar Foods Ltd');
    expect(emptyDraft.candidates[0]?.accepted).toBe(false);

    const confirmation = snapshotDraftForConfirmation({
      confirmationId: 'confirmation-001',
      pack: pack(),
      actor: 'local-demo-operator',
      idempotencyKey: 'intake-pack-001',
      tenderId: 'tender-from-pack-001',
      customerId: 'customer-from-pack-001',
      brokerId: 'broker-from-pack-001',
      confirmedAt: NOW,
    });

    expect(confirmation.submission.tender.customer.legalName).toBe('');
    expect(confirmation.submission.signals.criticalFacts).toEqual([]);
    expect(confirmation.submission.signals.dateFacts).toEqual([]);
    expect(evaluateReadiness(confirmation.submission).route).toBe('NEEDS_INFORMATION');
  });

  it('snapshots operator-edited draft fields, not candidate values, into POST /tenders input', () => {
    const reviewed = pack({
      draft: IntakeDraftSchema.parse({
        packId: 'pack-001',
        draftVersion: 2,
        updatedAt: NOW,
        customer: { customerId: 'customer-001', legalName: 'Northstar Foods Ltd' },
        broker: { brokerId: 'broker-001', legalName: 'Harbour Energy Partners' },
        sites: [
          {
            siteId: 'site-001',
            address: '10 Example Street, London',
            meterIdentifier: '1234567890123',
            annualConsumptionKwh: 24000,
            contractEndDate: '2027-03-31',
          },
        ],
        candidates: [
          {
            candidateId: 'candidate-001',
            field: 'customerLegalName',
            value: 'Ignored Candidate Name Ltd',
            associationStatus: 'RESOLVED',
            accepted: true,
            provenance: [
              {
                sourceKind: 'DOCUMENT_PAGE',
                sourceId: 'doc-001',
                documentId: 'doc-001',
                pageNumber: 1,
                quote: 'Ignored Candidate Name Ltd',
              },
            ],
          },
        ],
      }),
    });

    const confirmation = snapshotDraftForConfirmation({
      confirmationId: 'confirmation-002',
      pack: reviewed,
      actor: 'local-demo-operator',
      idempotencyKey: 'intake-pack-002',
      tenderId: 'tender-from-pack-002',
      customerId: 'customer-from-pack-002',
      brokerId: 'broker-from-pack-002',
      confirmedAt: NOW,
    });

    expect(confirmation.actor).toBe('local-demo-operator');
    expect(confirmation.submission.tender.customer.legalName).toBe('Northstar Foods Ltd');
    expect(confirmation.submission.tender.customer.legalName).not.toBe(
      'Ignored Candidate Name Ltd',
    );
    expect(confirmation.submission.textSources.map((source) => source.kind).sort()).toEqual([
      'DOCUMENT_TEXT',
      'NOTE',
    ]);
    expect(evaluateReadiness(confirmation.submission).route).toBe('READY_FOR_PRICING');
  });

  it('blocks confirmation while files are in progress and keeps failed files visible', () => {
    expect(canConfirmIntakePack(pack({ documents: [document({ status: 'EXTRACTING' })] }))).toEqual(
      expect.objectContaining({ ok: false, code: 'NOT_CONFIRMABLE' }),
    );

    const failed = pack({
      documents: [
        document({
          status: 'CORRUPT',
          failure: {
            code: 'CORRUPT',
            message: 'Synthetic PDF header is unreadable.',
            retryable: false,
          },
        }),
      ],
      draft: IntakeDraftSchema.parse({
        packId: 'pack-001',
        draftVersion: 1,
        updatedAt: NOW,
        customer: { legalName: 'Northstar Foods Ltd' },
        broker: { legalName: 'Harbour Energy Partners' },
        sites: [
          {
            siteId: 'site-001',
            address: '10 Example Street, London',
            meterIdentifier: '1234567890123',
            annualConsumptionKwh: 24000,
            contractEndDate: '2027-03-31',
          },
        ],
        candidates: [],
      }),
    });

    const confirmation = snapshotDraftForConfirmation({
      confirmationId: 'confirmation-003',
      pack: failed,
      actor: 'local-demo-operator',
      idempotencyKey: 'intake-pack-003',
      tenderId: 'tender-from-pack-003',
      customerId: 'customer-003',
      brokerId: 'broker-003',
      confirmedAt: NOW,
    });

    expect(confirmation.submission.tender.documents[0]).toMatchObject({
      documentId: 'doc-001',
      processingStatus: 'CORRUPTED',
      required: true,
    });
    expect(evaluateReadiness(confirmation.submission).route).toBe('HUMAN_REVIEW');
  });

  it('does not let extraction, draft, or confirmation invoke pricing', () => {
    expect(intakeLayerMayInvokePricing('extraction')).toBe(false);
    expect(intakeLayerMayInvokePricing('draft')).toBe(false);
    expect(intakeLayerMayInvokePricing('confirmation')).toBe(false);
    expect(intakeLayerMayInvokePricing('ready-tender')).toBe(true);
    expect(IntakeConfirmationSchema.shape).not.toHaveProperty('route');
    expect(IntakeCandidateSchema.shape).not.toHaveProperty('route');
  });
});
