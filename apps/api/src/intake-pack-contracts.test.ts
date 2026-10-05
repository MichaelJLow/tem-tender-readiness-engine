import { describe, expect, it } from 'vitest';
import { IntakeRequestSchema } from './contracts.js';
import {
  ConfirmIntakePackRequestSchema,
  CreateIntakePackRequestSchema,
  DEFAULT_INTAKE_PACK_ACTOR,
  IntakePackApiPathSchema,
  PatchIntakeDraftRequestSchema,
  intakePackActorFromEnv,
} from './intake-pack-contracts.js';
import {
  INTAKE_PACK_ENTRY_NAME,
  IntakeDraftSchema,
  IntakePackSchema,
  snapshotDraftForConfirmation,
  type IntakeDocument,
  type IntakePack,
} from '../../../packages/domain/src/index.js';

const NOW = '2026-10-05T16:00:00.000Z';

function document(overrides: Partial<IntakeDocument> = {}): IntakeDocument {
  return {
    documentId: 'doc-001',
    packId: 'pack-001',
    fileName: 'synthetic-contract.pdf',
    contentType: 'application/pdf',
    byteSize: 12_000,
    pageCount: 1,
    status: 'EXTRACTED',
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

function reviewedPack(): IntakePack {
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
          text: 'Contract text',
          charCount: 'Contract text'.length,
          selectableText: true,
        },
      ],
      documents: [
        {
          documentId: 'doc-001',
          status: 'EXTRACTED',
          pageCount: 1,
          extractedCharCount: 'Contract text'.length,
        },
      ],
    },
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
      candidates: [],
    }),
  });
}

describe('Intake pack API contracts', () => {
  it('sketches pack, document, notes, extraction, draft, and confirm routes', () => {
    expect(IntakePackApiPathSchema.options).toEqual(
      expect.arrayContaining([
        '/intake-packs',
        '/intake-packs/:packId',
        '/intake-packs/:packId/documents',
        '/intake-packs/:packId/documents/:documentId',
        '/intake-packs/:packId/notes',
        '/intake-packs/:packId/extractions',
        '/intake-packs/:packId/draft',
        '/intake-packs/:packId/confirm',
        '/intake-packs/:packId/confirmation',
      ]),
    );
  });

  it('rejects a client-supplied actor on confirm and uses the loopback demo operator', () => {
    expect(
      ConfirmIntakePackRequestSchema.safeParse({
        expectedDraftVersion: 2,
        idempotencyKey: 'intake-pack-confirm-001',
        actor: 'spoofed-operator',
      }).success,
    ).toBe(false);
    expect(intakePackActorFromEnv({})).toBe(DEFAULT_INTAKE_PACK_ACTOR);
    expect(intakePackActorFromEnv({ REVIEW_ACTOR: 'local-demo-operator' })).toBe(
      'local-demo-operator',
    );
  });

  it('maps a confirmed pack onto the existing POST /tenders IntakeRequest contract', () => {
    const confirmation = snapshotDraftForConfirmation({
      confirmationId: 'confirmation-api-001',
      pack: reviewedPack(),
      actor: intakePackActorFromEnv({}),
      idempotencyKey: 'intake-pack-confirm-001',
      tenderId: 'tender-from-pack-001',
      customerId: 'customer-001',
      brokerId: 'broker-001',
      confirmedAt: NOW,
    });

    const intake = IntakeRequestSchema.parse(confirmation.submission);
    expect(intake.tender.tenderId).toBe('tender-from-pack-001');
    expect(intake.textSources).toHaveLength(2);
    expect(intake.signals.criticalFacts).toEqual([]);
  });

  it('keeps create and draft-patch bodies free of pricing fields', () => {
    expect(CreateIntakePackRequestSchema.safeParse({ synthetic: true }).success).toBe(true);
    expect(
      PatchIntakeDraftRequestSchema.safeParse({
        expectedDraftVersion: 1,
        acceptedCandidateIds: ['candidate-001'],
        route: 'READY_FOR_PRICING',
      }).success,
    ).toBe(false);
  });
});
