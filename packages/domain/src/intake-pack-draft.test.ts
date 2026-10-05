import { describe, expect, it } from 'vitest';
import { evaluateReadiness } from './evaluate.js';
import {
  applyIntakeDraftPatch,
  canPrepareIntakeDraft,
  prepareIntakeDraftFromEvidence,
} from './intake-pack-draft.js';
import {
  INTAKE_PACK_ENTRY_NAME,
  IntakePackSchema,
  draftStructuredFieldsAreEmpty,
  intakeLayerMayInvokePricing,
  snapshotDraftForConfirmation,
  type IntakeExtraction,
  type IntakeNote,
  type IntakePack,
} from './intake-pack.js';

const NOW = '2026-10-05T18:00:00.000Z';

function extraction(pages: IntakeExtraction['pages']): IntakeExtraction {
  return {
    extractionId: 'extraction-001',
    packId: 'pack-001',
    createdAt: NOW,
    immutable: true,
    pages,
    documents: [
      {
        documentId: pages[0]?.documentId ?? 'doc-001',
        status: 'EXTRACTED',
        pageCount: pages.length,
        extractedCharCount: pages.reduce((sum, page) => sum + page.charCount, 0),
      },
    ],
  };
}

function page(
  documentId: string,
  pageNumber: number,
  text: string,
): IntakeExtraction['pages'][number] {
  return {
    documentId,
    pageNumber,
    text,
    charCount: text.length,
    selectableText: true,
  };
}

function note(text: string, noteId = 'note-001'): IntakeNote {
  return {
    noteId,
    text,
    createdAt: NOW,
    updatedAt: NOW,
  };
}

function reviewablePack(overrides: Partial<IntakePack> = {}): IntakePack {
  return IntakePackSchema.parse({
    packId: 'pack-001',
    kind: 'INTAKE_PACK',
    entryPoint: INTAKE_PACK_ENTRY_NAME,
    synthetic: true,
    status: 'REVIEWABLE',
    createdAt: NOW,
    updatedAt: NOW,
    documents: [
      {
        documentId: 'doc-001',
        packId: 'pack-001',
        fileName: 'synthetic-contract.pdf',
        contentType: 'application/pdf',
        byteSize: 1_200,
        pageCount: 2,
        status: 'EXTRACTED',
        createdAt: NOW,
        updatedAt: NOW,
      },
    ],
    notes: [],
    ...overrides,
  });
}

describe('prepareIntakeDraftFromEvidence', () => {
  it('builds review-only candidates with source, page, quote, and site association', () => {
    const draft = prepareIntakeDraftFromEvidence({
      packId: 'pack-001',
      updatedAt: NOW,
      extraction: extraction([
        page(
          'doc-001',
          1,
          [
            'SYNTHETIC / DEMONSTRATION',
            'Customer: Northstar Foods Ltd',
            'Broker: Harbour Energy Partners',
          ].join('\n'),
        ),
        page(
          'doc-001',
          2,
          [
            'Warehouse site address: 10 Example Street, London',
            'Warehouse MPAN 1234567890123',
            'Warehouse annual consumption 24000 kWh',
            'Warehouse contract end date 2027-03-31',
          ].join('\n'),
        ),
      ]),
      notes: [
        note(
          [
            'Customer Northstar Foods Ltd. Broker Harbour Energy Partners.',
            'Please price the single London warehouse site at 10 Example Street, London.',
            'MPAN 1234567890123, 24000 kWh, contract end 2027-03-31.',
          ].join('\n'),
        ),
      ],
    });

    expect(draftStructuredFieldsAreEmpty(draft)).toBe(true);
    expect(draft.customer).toEqual({});
    expect(draft.broker).toEqual({});
    expect(draft.sites).toEqual([]);
    expect(draft.candidates.every((candidate) => candidate.accepted === false)).toBe(true);

    const customer = draft.candidates.find(
      (candidate) =>
        candidate.field === 'customerLegalName' && candidate.value === 'Northstar Foods Ltd',
    );
    expect(customer?.associationStatus).toBe('RESOLVED');
    expect(customer?.provenance.some((item) => item.sourceKind === 'DOCUMENT_PAGE')).toBe(true);
    expect(customer?.provenance.some((item) => item.sourceKind === 'NOTE')).toBe(true);
    expect(
      customer?.provenance[0]?.pageNumber ?? customer?.provenance[1]?.pageNumber,
    ).toBeDefined();
    expect(customer?.provenance.some((item) => item.quote.includes('Northstar Foods Ltd'))).toBe(
      true,
    );

    const meter = draft.candidates.find(
      (candidate) =>
        candidate.field === 'meterIdentifier' &&
        candidate.value === '1234567890123' &&
        candidate.associationStatus === 'RESOLVED',
    );
    expect(meter?.siteId).toBe('site-warehouse');
    expect(meter?.provenance[0]).toMatchObject({
      sourceKind: 'DOCUMENT_PAGE',
      documentId: 'doc-001',
      pageNumber: 2,
    });
    expect(meter?.provenance[0]?.quote).toContain('Warehouse MPAN 1234567890123');
  });

  it('retains conflicting contract-end candidates instead of choosing a winner', () => {
    const draft = prepareIntakeDraftFromEvidence({
      packId: 'pack-001',
      updatedAt: NOW,
      extraction: extraction([
        page(
          'doc-schedule-a',
          1,
          [
            'Customer: Northstar Foods Ltd',
            'Warehouse site address: 10 Example Street, London',
            'Warehouse MPAN 1234567890123',
            'Schedule A contract end date 2027-03-31',
          ].join('\n'),
        ),
        page(
          'doc-schedule-b',
          1,
          [
            'Customer: Northstar Foods Ltd',
            'Warehouse site address: 10 Example Street, London',
            'Warehouse MPAN 1234567890123',
            'Schedule B contract end date 30/09/2026',
          ].join('\n'),
        ),
      ]),
      notes: [
        note(
          'Schedule A says 2027-03-31. Schedule B says 30/09/2026.\nDo not silently pick a date.',
        ),
      ],
    });

    expect(draftStructuredFieldsAreEmpty(draft)).toBe(true);
    const dates = draft.candidates.filter((candidate) => candidate.field === 'contractEndDate');
    const values = new Set(dates.map((candidate) => candidate.value));
    expect(values.has('2027-03-31')).toBe(true);
    expect(values.has('30/09/2026')).toBe(true);
    expect(dates.length).toBeGreaterThanOrEqual(2);
    expect(dates.filter((candidate) => candidate.accepted)).toHaveLength(0);
  });

  it('keeps unassociated Harbour-site facts unassociated until reviewed', () => {
    const draft = prepareIntakeDraftFromEvidence({
      packId: 'pack-001',
      updatedAt: NOW,
      extraction: extraction([
        page(
          'doc-letter',
          1,
          [
            'Customer: Northstar Foods Ltd',
            'Broker: Harbour Energy Partners',
            'Please price the Harbour site.',
            'No MPAN is printed. The letter does not say London or Manchester.',
          ].join('\n'),
        ),
      ]),
      notes: [
        note(
          [
            'Customer has both 10 Example Street, London and 22 Harbour Lane, Manchester.',
            'The attached letter only says the Harbour site. Do not guess the site.',
          ].join('\n'),
        ),
      ],
    });

    expect(draftStructuredFieldsAreEmpty(draft)).toBe(true);
    const harbour = draft.candidates.filter(
      (candidate) => candidate.field === 'siteAddress' && candidate.value === 'the Harbour site',
    );
    expect(harbour.length).toBeGreaterThan(0);
    expect(harbour.every((candidate) => candidate.associationStatus === 'AMBIGUOUS')).toBe(true);
    expect(harbour.every((candidate) => candidate.siteId == null)).toBe(true);

    const siteScoped = draft.candidates.filter(
      (candidate) =>
        candidate.field === 'siteAddress' ||
        candidate.field === 'meterIdentifier' ||
        candidate.field === 'annualConsumptionKwh' ||
        candidate.field === 'contractEndDate',
    );
    expect(
      siteScoped.every(
        (candidate) =>
          candidate.associationStatus === 'AMBIGUOUS' ||
          candidate.associationStatus === 'UNRESOLVED' ||
          candidate.siteId == null,
      ),
    ).toBe(true);
    expect(draft.sites).toEqual([]);
  });

  it('leaves unlabeled note meters unassociated when no site cue is present', () => {
    const draft = prepareIntakeDraftFromEvidence({
      packId: 'pack-001',
      updatedAt: NOW,
      extraction: extraction([
        page('doc-001', 1, 'Customer: Northstar Foods Ltd\nBroker: Harbour Energy Partners'),
      ]),
      notes: [note('Please price MPAN 9998887776665. No site is named.')],
    });

    const meter = draft.candidates.find(
      (candidate) => candidate.field === 'meterIdentifier' && candidate.value === '9998887776665',
    );
    expect(meter?.associationStatus).toBe('UNRESOLVED');
    expect(meter?.siteId).toBeNull();
    expect(draftStructuredFieldsAreEmpty(draft)).toBe(true);
  });

  it('does not let draft preparation fill structured fields or invoke pricing', () => {
    const draft = prepareIntakeDraftFromEvidence({
      packId: 'pack-001',
      updatedAt: NOW,
      extraction: extraction([
        page('doc-001', 1, 'Customer: Northstar Foods Ltd\nBroker: Harbour Energy Partners'),
      ]),
      notes: [],
    });

    expect(intakeLayerMayInvokePricing('draft')).toBe(false);
    expect(draftStructuredFieldsAreEmpty(draft)).toBe(true);

    const pack = reviewablePack({
      extraction: extraction([
        page('doc-001', 1, 'Customer: Northstar Foods Ltd\nBroker: Harbour Energy Partners'),
      ]),
      draft,
    });
    expect(canPrepareIntakeDraft(pack).ok).toBe(true);

    const confirmation = snapshotDraftForConfirmation({
      confirmationId: 'confirmation-draft-001',
      pack,
      actor: 'local-demo-operator',
      idempotencyKey: 'intake-pack-draft-001',
      tenderId: 'tender-from-pack-draft-001',
      customerId: 'customer-from-pack-draft-001',
      brokerId: 'broker-from-pack-draft-001',
      confirmedAt: NOW,
    });

    expect(confirmation.submission.tender.customer.legalName).toBe('');
    expect(confirmation.submission.tender.sites).toEqual([]);
    expect(evaluateReadiness(confirmation.submission).route).toBe('NEEDS_INFORMATION');
  });

  it('requires extracted evidence before a draft can be prepared', () => {
    expect(canPrepareIntakeDraft(reviewablePack({ extraction: undefined })).ok).toBe(false);
  });
});

describe('applyIntakeDraftPatch', () => {
  it('records accepted candidates without copying their values onto structured fields', () => {
    const prepared = prepareIntakeDraftFromEvidence({
      packId: 'pack-001',
      updatedAt: NOW,
      extraction: extraction([
        page('doc-001', 1, 'Customer: Northstar Foods Ltd\nBroker: Harbour Energy Partners'),
      ]),
      notes: [],
    });
    const customer = prepared.candidates.find(
      (candidate) => candidate.field === 'customerLegalName',
    );
    expect(customer).toBeDefined();

    const patched = applyIntakeDraftPatch(
      prepared,
      {
        expectedDraftVersion: 1,
        acceptedCandidateIds: [customer!.candidateId],
      },
      '2026-10-05T18:05:00.000Z',
    );
    expect(patched.ok).toBe(true);
    if (!patched.ok) return;
    expect(patched.draft.draftVersion).toBe(2);
    expect(
      patched.draft.candidates.find((candidate) => candidate.candidateId === customer!.candidateId)
        ?.accepted,
    ).toBe(true);
    expect(draftStructuredFieldsAreEmpty(patched.draft)).toBe(true);
    expect(patched.draft.customer.legalName).toBeUndefined();
  });

  it('writes structured fields only from explicit operator field edits', () => {
    const prepared = prepareIntakeDraftFromEvidence({
      packId: 'pack-001',
      updatedAt: NOW,
      extraction: extraction([page('doc-001', 1, 'Customer: Ignored Candidate Name Ltd')]),
      notes: [],
    });

    const patched = applyIntakeDraftPatch(
      prepared,
      {
        expectedDraftVersion: 1,
        acceptedCandidateIds: prepared.candidates.map((candidate) => candidate.candidateId),
        fieldEdits: {
          customerLegalName: 'Northstar Foods Ltd',
          brokerLegalName: 'Harbour Energy Partners',
          sites: [
            {
              siteId: 'site-warehouse',
              address: '10 Example Street, London',
            },
          ],
        },
      },
      '2026-10-05T18:06:00.000Z',
    );

    expect(patched.ok).toBe(true);
    if (!patched.ok) return;
    expect(patched.draft.customer.legalName).toBe('Northstar Foods Ltd');
    expect(patched.draft.broker.legalName).toBe('Harbour Energy Partners');
    expect(patched.draft.sites[0]?.address).toBe('10 Example Street, London');
    expect(patched.draft.customer.legalName).not.toBe('Ignored Candidate Name Ltd');
  });

  it('rejects a stale expected draft version', () => {
    const prepared = prepareIntakeDraftFromEvidence({
      packId: 'pack-001',
      updatedAt: NOW,
      extraction: extraction([page('doc-001', 1, 'Customer: Northstar Foods Ltd')]),
      notes: [],
    });
    const result = applyIntakeDraftPatch(
      prepared,
      { expectedDraftVersion: 2, fieldEdits: { customerLegalName: 'Nope Ltd' } },
      NOW,
    );
    expect(result).toMatchObject({ ok: false, code: 'DRAFT_STALE' });
    expect(draftStructuredFieldsAreEmpty(prepared)).toBe(true);
  });
});
