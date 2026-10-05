import { describe, expect, it } from 'vitest';
import type { IntakeCandidate, IntakeDraft } from '../../../packages/domain/src/index.js';
import { INTAKE_PACK_ENTRY_NAME } from '../../../packages/domain/src/index.js';
import type { IntakePackView } from './intake-pack.js';
import {
  UNASSIGNED_REVIEW_BUCKET,
  applyCandidateValueToEdits,
  buildIntakeDraftPatch,
  canOpenIntakeDraftReview,
  candidatesForReviewBucket,
  competingCandidatesForAssignment,
  conflictGroups,
  emptyReviewFieldEdits,
  isDraftStaleError,
  isIntakeDraftReadOnly,
  leaveUnassignedCandidate,
  matchingAcceptedIds,
  operatorFieldState,
  packLevelCandidates,
  parseAnnualConsumption,
  rebaseReviewSession,
  resolveConflictChoice,
  reviewFieldEditsFromDraft,
  reviewSaveIssues,
  reviewSiteIds,
  sourceFocusForCandidate,
  splitAroundQuote,
  unassignedConflictGroups,
} from './intake-pack-review.js';

const NOW = '2026-10-05T18:00:00.000Z';

function candidate(
  overrides: Partial<IntakeCandidate> & Pick<IntakeCandidate, 'candidateId' | 'field' | 'value'>,
): IntakeCandidate {
  return {
    associationStatus: 'RESOLVED',
    accepted: false,
    provenance: [
      {
        sourceKind: 'DOCUMENT_PAGE',
        sourceId: 'doc-warehouse',
        documentId: 'doc-warehouse',
        pageNumber: 1,
        quote: overrides.value,
        locator: 'page=1',
      },
    ],
    ...overrides,
  };
}

function draft(overrides: Partial<IntakeDraft> = {}): IntakeDraft {
  return {
    packId: 'pack-001',
    draftVersion: 1,
    updatedAt: NOW,
    customer: {},
    broker: {},
    sites: [],
    candidates: [],
    ...overrides,
  };
}

function multiSiteDraft(): IntakeDraft {
  return draft({
    candidates: [
      candidate({
        candidateId: 'candidate-001',
        field: 'customerLegalName',
        value: 'Northstar Foods Ltd',
        provenance: [
          {
            sourceKind: 'DOCUMENT_PAGE',
            sourceId: 'doc-warehouse',
            documentId: 'doc-warehouse',
            pageNumber: 1,
            quote: 'Customer: Northstar Foods Ltd',
            locator: 'page=1',
          },
        ],
      }),
      candidate({
        candidateId: 'candidate-w-address',
        field: 'siteAddress',
        value: '10 Example Street, London',
        siteId: 'site-warehouse',
      }),
      candidate({
        candidateId: 'candidate-w-meter',
        field: 'meterIdentifier',
        value: '1234567890123',
        siteId: 'site-warehouse',
        provenance: [
          {
            sourceKind: 'DOCUMENT_PAGE',
            sourceId: 'doc-warehouse',
            documentId: 'doc-warehouse',
            pageNumber: 2,
            quote: 'Warehouse MPAN 1234567890123',
            locator: 'page=2',
          },
        ],
      }),
      candidate({
        candidateId: 'candidate-r-address',
        field: 'siteAddress',
        value: '22 Harbour Lane, Manchester',
        siteId: 'site-retail',
        provenance: [
          {
            sourceKind: 'DOCUMENT_PAGE',
            sourceId: 'doc-retail',
            documentId: 'doc-retail',
            pageNumber: 1,
            quote: 'Retail site address: 22 Harbour Lane, Manchester',
            locator: 'page=1',
          },
        ],
      }),
      candidate({
        candidateId: 'candidate-r-meter',
        field: 'meterIdentifier',
        value: '9876543210987',
        siteId: 'site-retail',
        provenance: [
          {
            sourceKind: 'DOCUMENT_PAGE',
            sourceId: 'doc-retail',
            documentId: 'doc-retail',
            pageNumber: 1,
            quote: 'Retail MPAN 9876543210987',
            locator: 'page=1',
          },
        ],
      }),
      candidate({
        candidateId: 'candidate-harbour',
        field: 'siteAddress',
        value: 'the Harbour site',
        siteId: null,
        associationStatus: 'AMBIGUOUS',
        provenance: [
          {
            sourceKind: 'NOTE',
            sourceId: 'note-001',
            quote: 'Please price the Harbour site.',
            locator: 'note',
          },
        ],
      }),
    ],
  });
}

describe('Console Intake pack draft review', () => {
  it('opens review only for REVIEWABLE or CONFIRMED packs with extraction', () => {
    const pack: IntakePackView = {
      packId: 'pack-001',
      kind: 'INTAKE_PACK',
      entryPoint: INTAKE_PACK_ENTRY_NAME,
      synthetic: true,
      status: 'RECEIVING',
      createdAt: NOW,
      updatedAt: NOW,
      documents: [],
      notes: [],
    };
    const extraction = {
      extractionId: 'ex-1',
      packId: 'pack-001',
      createdAt: NOW,
      immutable: true as const,
      pages: [],
      documents: [],
    };
    expect(canOpenIntakeDraftReview(pack)).toBe(false);
    expect(canOpenIntakeDraftReview({ ...pack, extraction, status: 'EXTRACTING' })).toBe(false);
    expect(canOpenIntakeDraftReview({ ...pack, extraction, status: 'REVIEWABLE' })).toBe(true);
    expect(canOpenIntakeDraftReview({ ...pack, extraction, status: 'CONFIRMED' })).toBe(true);
    expect(isIntakeDraftReadOnly({ ...pack, extraction, status: 'CONFIRMED' })).toBe(true);
    expect(isIntakeDraftReadOnly({ ...pack, extraction, status: 'REVIEWABLE' })).toBe(false);
  });

  it('does not leak warehouse evidence into the retail draft the operator sees', () => {
    const current = multiSiteDraft();
    const warehouse = candidatesForReviewBucket(current.candidates, 'site-warehouse');
    const retail = candidatesForReviewBucket(current.candidates, 'site-retail');
    const unassigned = candidatesForReviewBucket(current.candidates, UNASSIGNED_REVIEW_BUCKET);
    const packLevel = packLevelCandidates(current.candidates);

    expect(warehouse.map((item) => item.candidateId)).toEqual([
      'candidate-w-address',
      'candidate-w-meter',
    ]);
    expect(retail.map((item) => item.candidateId)).toEqual([
      'candidate-r-address',
      'candidate-r-meter',
    ]);
    expect(warehouse.some((item) => item.value.includes('Manchester'))).toBe(false);
    expect(retail.some((item) => item.value.includes('London'))).toBe(false);
    expect(unassigned.map((item) => item.candidateId)).toEqual(['candidate-harbour']);
    expect(packLevel.map((item) => item.field)).toEqual(['customerLegalName']);
    expect(reviewSiteIds(current)).toEqual(['site-retail', 'site-warehouse']);
  });

  it('groups conflicting values together and lets the operator resolve or leave them', () => {
    const dates: IntakeCandidate[] = [
      candidate({
        candidateId: 'date-a',
        field: 'contractEndDate',
        value: '2027-03-31',
        siteId: 'site-warehouse',
      }),
      candidate({
        candidateId: 'date-b',
        field: 'contractEndDate',
        value: '30/09/2026',
        siteId: 'site-warehouse',
        provenance: [
          {
            sourceKind: 'DOCUMENT_PAGE',
            sourceId: 'doc-b',
            documentId: 'doc-b',
            pageNumber: 1,
            quote: 'Schedule B contract end date 30/09/2026',
            locator: 'page=1',
          },
        ],
      }),
    ];
    const groups = conflictGroups(dates);
    expect(groups).toHaveLength(1);
    expect(groups[0]?.candidates.map((item) => item.value)).toEqual(['2027-03-31', '30/09/2026']);

    const resolved = resolveConflictChoice({
      edits: emptyReviewFieldEdits(),
      acceptedIds: [],
      group: dates,
      chosenCandidateId: 'date-a',
    });
    expect(resolved.edits.sites['site-warehouse']?.contractEndDate).toBe('2027-03-31');
    expect(resolved.acceptedIds).toEqual(['date-a']);

    const left = resolveConflictChoice({
      edits: resolved.edits,
      acceptedIds: resolved.acceptedIds,
      group: dates,
      chosenCandidateId: null,
    });
    expect(left.edits.sites['site-warehouse']?.contractEndDate).toBe('');
    expect(left.acceptedIds).toEqual([]);
  });

  it('keeps empty operator fields empty until an explicit write, and records audit separately from evidence', () => {
    const current = multiSiteDraft();
    expect(operatorFieldState(current.customer.legalName)).toBe('empty');
    const edits = applyCandidateValueToEdits(
      reviewFieldEditsFromDraft(current),
      current.candidates[0]!,
    );
    expect(edits.customerLegalName).toBe('Northstar Foods Ltd');
    expect(operatorFieldState(edits.customerLegalName)).toBe('operator');
    expect(current.candidates[0]?.value).toBe('Northstar Foods Ltd');
    expect(current.customer.legalName).toBeUndefined();

    const assigned = applyCandidateValueToEdits(
      emptyReviewFieldEdits(),
      current.candidates.find((item) => item.candidateId === 'candidate-harbour')!,
      'site-retail',
    );
    expect(assigned.sites['site-retail']?.address).toBe('the Harbour site');
    expect(assigned.sites['site-warehouse']).toBeUndefined();
    expect(
      candidatesForReviewBucket(current.candidates, 'site-retail').some(
        (item) => item.candidateId === 'candidate-harbour',
      ),
    ).toBe(false);
  });

  it('builds a PATCH that writes operator fields without silently filling from accepted evidence', () => {
    const current = multiSiteDraft();
    const customer = current.candidates[0]!;
    const assignedHarbour = applyCandidateValueToEdits(
      { ...emptyReviewFieldEdits(), customerLegalName: 'Northstar Foods Ltd' },
      current.candidates.find((item) => item.candidateId === 'candidate-harbour')!,
      'site-retail',
    );
    const patch = buildIntakeDraftPatch({
      expectedDraftVersion: 1,
      original: current,
      edits: assignedHarbour,
      acceptedIds: [customer.candidateId],
    });

    expect(patch.expectedDraftVersion).toBe(1);
    expect(patch.acceptedCandidateIds).toEqual([customer.candidateId]);
    expect(patch.fieldEdits.customerLegalName).toBe('Northstar Foods Ltd');
    expect(patch.fieldEdits.sites?.[0]).toMatchObject({
      siteId: 'site-retail',
      address: 'the Harbour site',
    });
    expect(patch.fieldEdits.sites?.some((site) => site.siteId === 'site-warehouse')).toBe(false);
    expect(current.customer.legalName).toBeUndefined();
  });

  it('opens the supporting document page and quote for a candidate', () => {
    const meter = multiSiteDraft().candidates.find(
      (item) => item.candidateId === 'candidate-w-meter',
    )!;
    const focus = sourceFocusForCandidate(meter);
    expect(focus).toMatchObject({
      sourceKind: 'DOCUMENT_PAGE',
      documentId: 'doc-warehouse',
      pageNumber: 2,
      quote: 'Warehouse MPAN 1234567890123',
      candidateId: 'candidate-w-meter',
    });
    const split = splitAroundQuote(
      'Warehouse site address: 10 Example Street, London\nWarehouse MPAN 1234567890123\n',
      'Warehouse MPAN 1234567890123',
    );
    expect(split.kind).toBe('hit');
    if (split.kind === 'hit') {
      expect(split.match).toBe('Warehouse MPAN 1234567890123');
    }
  });

  it('treats DRAFT_STALE 409 as a recoverable version conflict', () => {
    expect(
      isDraftStaleError(409, {
        error: 'DRAFT_STALE',
        failure: { code: 'DRAFT_STALE', message: 'Draft version 1 is stale.', retryable: false },
      }),
    ).toBe(true);
    expect(isDraftStaleError(400, { error: 'INVALID_INTAKE_DRAFT' })).toBe(false);
  });

  it('rebases a stale customer-name edit onto concurrent warehouse work without wiping it', () => {
    const meter = candidate({
      candidateId: 'candidate-w-meter',
      field: 'meterIdentifier',
      value: '1234567890123',
      siteId: 'site-warehouse',
    });
    const base = draft({
      draftVersion: 1,
      candidates: [
        candidate({
          candidateId: 'candidate-001',
          field: 'customerLegalName',
          value: 'Northstar Foods Ltd',
        }),
        meter,
      ],
    });
    const latest = draft({
      draftVersion: 2,
      candidates: [base.candidates[0]!, { ...meter, accepted: true }],
      sites: [{ siteId: 'site-warehouse', meterIdentifier: '1234567890123' }],
    });
    const rebased = rebaseReviewSession({
      base,
      latest,
      edits: { ...emptyReviewFieldEdits(), customerLegalName: 'Northstar Foods Ltd' },
      acceptedIds: [],
    });
    const patch = buildIntakeDraftPatch({
      expectedDraftVersion: latest.draftVersion,
      original: latest,
      edits: rebased.edits,
      acceptedIds: rebased.acceptedIds,
    });

    expect(rebased.edits.customerLegalName).toBe('Northstar Foods Ltd');
    expect(rebased.edits.sites['site-warehouse']?.meterIdentifier).toBe('1234567890123');
    expect(rebased.acceptedIds).toEqual(['candidate-w-meter']);
    expect(patch.fieldEdits.customerLegalName).toBe('Northstar Foods Ltd');
    expect(patch.fieldEdits.sites).toBeUndefined();
    expect(patch.rejectedCandidateIds).toEqual([]);
    expect(patch.acceptedCandidateIds).toEqual([]);
    expect(
      rebased.concurrentChanges.some((change) => change.detail.includes('1234567890123')),
    ).toBe(true);
  });

  it('does not treat independent unassigned meters as one conflict', () => {
    const meters: IntakeCandidate[] = [
      candidate({
        candidateId: 'm1',
        field: 'meterIdentifier',
        value: '1234567890123',
        siteId: null,
        associationStatus: 'UNRESOLVED',
      }),
      candidate({
        candidateId: 'm2',
        field: 'meterIdentifier',
        value: '9876543210987',
        siteId: null,
        associationStatus: 'UNRESOLVED',
      }),
    ];
    expect(conflictGroups(meters)).toEqual([]);
    expect(unassignedConflictGroups(meters, {})).toEqual([]);
    expect(
      unassignedConflictGroups(meters, { m1: 'site-warehouse', m2: 'site-warehouse' }),
    ).toHaveLength(1);
  });

  it('assigns unassigned facts to different sites without dropping the first audit', () => {
    const m1 = candidate({
      candidateId: 'm1',
      field: 'meterIdentifier',
      value: '1234567890123',
      siteId: null,
      associationStatus: 'UNRESOLVED',
    });
    const m2 = candidate({
      candidateId: 'm2',
      field: 'meterIdentifier',
      value: '9876543210987',
      siteId: null,
      associationStatus: 'UNRESOLVED',
    });
    const first = resolveConflictChoice({
      edits: emptyReviewFieldEdits(),
      acceptedIds: [],
      group: competingCandidatesForAssignment({
        candidates: [m1, m2],
        candidate: m1,
        targetSiteId: 'site-warehouse',
        assignedSiteByCandidate: {},
      }),
      chosenCandidateId: 'm1',
      siteId: 'site-warehouse',
    });
    const second = resolveConflictChoice({
      edits: first.edits,
      acceptedIds: first.acceptedIds,
      group: competingCandidatesForAssignment({
        candidates: [m1, m2],
        candidate: m2,
        targetSiteId: 'site-retail',
        assignedSiteByCandidate: { m1: 'site-warehouse' },
      }),
      chosenCandidateId: 'm2',
      siteId: 'site-retail',
    });

    expect(first.acceptedIds).toEqual(['m1']);
    expect(second.acceptedIds).toEqual(['m1', 'm2']);
    expect(second.edits.sites['site-warehouse']?.meterIdentifier).toBe('1234567890123');
    expect(second.edits.sites['site-retail']?.meterIdentifier).toBe('9876543210987');
    expect(reviewSiteIds(draft(), second.edits)).toEqual(['site-retail', 'site-warehouse']);

    const left = leaveUnassignedCandidate({
      edits: second.edits,
      acceptedIds: second.acceptedIds,
      candidate: m1,
      assignedSiteByCandidate: { m1: 'site-warehouse', m2: 'site-retail' },
    });
    expect(left.acceptedIds).toEqual(['m2']);
    expect(left.edits.sites['site-warehouse']?.meterIdentifier).toBe('');
    expect(left.edits.sites['site-retail']?.meterIdentifier).toBe('9876543210987');
    expect(left.assignedSiteByCandidate.m1).toBeUndefined();
    expect(left.assignedSiteByCandidate.m2).toBe('site-retail');

    const neverAssigned = leaveUnassignedCandidate({
      edits: second.edits,
      acceptedIds: second.acceptedIds,
      candidate: m1,
      assignedSiteByCandidate: { m2: 'site-retail' },
    });
    expect(neverAssigned.acceptedIds).toEqual(['m2']);
    expect(neverAssigned.edits.sites['site-warehouse']?.meterIdentifier).toBe('1234567890123');
    expect(neverAssigned.edits.sites['site-retail']?.meterIdentifier).toBe('9876543210987');
  });

  it('rejects invalid annual consumption instead of rewriting digits', () => {
    expect(parseAnnualConsumption('24000')).toEqual({ ok: true, value: 24000 });
    expect(parseAnnualConsumption('')).toEqual({ ok: true, value: null });
    expect(parseAnnualConsumption('24,000.5').ok).toBe(false);
    expect(parseAnnualConsumption('-100').ok).toBe(false);
    expect(
      reviewSaveIssues({
        ...emptyReviewFieldEdits(),
        sites: {
          'site-warehouse': {
            siteId: 'site-warehouse',
            address: '',
            meterIdentifier: '',
            annualConsumptionKwh: '24,000.5',
            contractEndDate: '',
          },
        },
      }).some((issue) => issue.includes('24,000.5')),
    ).toBe(true);
  });

  it('drops accepted audit when the operator retypes away from that candidate', () => {
    const customer = candidate({
      candidateId: 'candidate-001',
      field: 'customerLegalName',
      value: 'Northstar Foods Ltd',
    });
    expect(
      matchingAcceptedIds({
        candidates: [customer],
        edits: { ...emptyReviewFieldEdits(), customerLegalName: 'Other Ltd' },
        acceptedIds: ['candidate-001'],
      }),
    ).toEqual([]);
    expect(
      matchingAcceptedIds({
        candidates: [customer],
        edits: emptyReviewFieldEdits(),
        acceptedIds: ['candidate-001'],
      }),
    ).toEqual(['candidate-001']);
  });

  it('does not highlight a fallback token when the exact quote is missing', () => {
    const split = splitAroundQuote(
      'Warehouse MPAN 1234567890123',
      'Schedule A contract end date 2027-03-31',
    );
    expect(split.kind).toBe('miss');
  });
});
