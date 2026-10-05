import { describe, expect, it } from 'vitest';
import {
  INTAKE_PACK_LIMITS,
  draftStructuredFieldsAreEmpty,
  intakeLayerMayInvokePricing,
} from '../../../../packages/domain/src/index.js';
import { buildIntakePackFixtureCatalog } from '../../../../scripts/intake-pack-fixtures.js';
import { MemoryIntakeOriginalsStore } from './originals-store.js';
import { MemoryIntakePackRepository } from './repository.js';
import { IntakeDraftNotFoundError, IntakePackConflictError, IntakePackService } from './service.js';

const catalog = buildIntakePackFixtureCatalog();

function createService(): IntakePackService {
  return new IntakePackService(new MemoryIntakePackRepository(), new MemoryIntakeOriginalsStore());
}

async function registerFixture(
  service: IntakePackService,
  packId: string,
  fixturePackId: string,
): Promise<void> {
  const spec = catalog.specs.find((item) => item.packId === fixturePackId);
  if (!spec) throw new Error(`Missing fixture pack ${fixturePackId}`);
  for (const file of spec.files) {
    if (file.kind === 'NOTE') {
      try {
        await service.addNote({ packId, text: file.bytes.toString('utf8') });
      } catch (error) {
        if (!(error instanceof IntakePackConflictError)) throw error;
      }
      continue;
    }
    try {
      await service.addDocument({
        packId,
        fileName: file.fileName,
        contentType: file.contentType,
        bytes: new Uint8Array(file.bytes),
      });
    } catch (error) {
      if (!(error instanceof IntakePackConflictError)) throw error;
    }
  }
}

describe('Intake pack registration and extraction', () => {
  it('extracts a clean single-site pack without filling a draft or calling pricing', async () => {
    const service = createService();
    const created = await service.createPack();
    await registerFixture(service, created.packId, 'pack-clean-single-site');
    const { pack, extraction } = await service.extract(created.packId);

    expect(intakeLayerMayInvokePricing('extraction')).toBe(false);
    expect(pack.status).toBe('REVIEWABLE');
    expect(pack.draft).toBeUndefined();
    expect(pack.confirmation).toBeUndefined();
    expect(pack.documents.map((document) => document.status)).toEqual(['EXTRACTED']);
    expect(extraction.immutable).toBe(true);
    expect(extraction.pages).toHaveLength(2);
    expect(extraction.pages[0]?.pageNumber).toBe(1);
    expect(extraction.pages[0]?.text).toContain('Customer: Northstar Foods Ltd');
    expect(extraction.pages[1]?.text).toContain(
      'Warehouse site address: 10 Example Street, London',
    );
  });

  it('keeps multi-site page text that contains expected provenance quotes', async () => {
    const service = createService();
    const created = await service.createPack();
    await registerFixture(service, created.packId, 'pack-clean-multi-site');
    const { pack, extraction } = await service.extract(created.packId);
    const fixture = catalog.manifest.packs.find((item) => item.packId === 'pack-clean-multi-site')!;

    expect(pack.documents.every((document) => document.status === 'EXTRACTED')).toBe(true);
    for (const fact of fixture.expectedFacts) {
      for (const provenance of fact.provenance) {
        if (provenance.sourceKind !== 'DOCUMENT_PAGE' || provenance.pageNumber === undefined) {
          continue;
        }
        const file = fixture.files.find((item) => item.documentId === provenance.documentId);
        const document = pack.documents.find((item) => item.fileName === file?.fileName);
        const page = extraction.pages.find(
          (item) =>
            item.documentId === document?.documentId && item.pageNumber === provenance.pageNumber,
        );
        expect(page?.text, provenance.quote).toContain(provenance.quote);
      }
    }
  });

  it('keeps OCR_REQUIRED, CORRUPT, UNSUPPORTED, and EXTRACTION_FAILED files on the pack', async () => {
    const cases = [
      ['pack-scanned-ocr-required', 'OCR_REQUIRED'],
      ['pack-corrupt', 'CORRUPT'],
      ['pack-extraction-failed', 'EXTRACTION_FAILED'],
    ] as const;

    for (const [fixturePackId, status] of cases) {
      const service = createService();
      const created = await service.createPack();
      await registerFixture(service, created.packId, fixturePackId);
      const { pack } = await service.extract(created.packId);
      const pdf = pack.documents.find((document) => document.fileName.endsWith('.pdf'));
      expect(pdf?.status, fixturePackId).toBe(status);
      expect(pdf?.failure?.code, fixturePackId).toBe(status);
      expect(pack.documents).not.toHaveLength(0);
    }

    const service = createService();
    const created = await service.createPack();
    await registerFixture(service, created.packId, 'pack-unsupported');
    const pack = await service.getPack(created.packId);
    expect(pack.documents.map((document) => document.status)).toEqual([
      'UNSUPPORTED',
      'UNSUPPORTED',
      'UNSUPPORTED',
    ]);
    expect(pack.documents.map((document) => document.fileName).sort()).toEqual([
      'cover-letter.txt',
      'logo.png',
      'not-a-pdf.pdf',
    ]);
    expect(pack.failure?.code).toBe('UNSUPPORTED');
    expect(pack.status).toBe('FAILED');
  });

  it('records OVERSIZED without storing overflowing original bytes', async () => {
    const originals = new MemoryIntakeOriginalsStore();
    const bounded = new IntakePackService(new MemoryIntakePackRepository(), originals);
    const created = await bounded.createPack();
    await registerFixture(bounded, created.packId, 'pack-oversized-file');
    const pack = await bounded.getPack(created.packId);
    const document = pack.documents[0];
    expect(document?.status).toBe('OVERSIZED');
    expect(document?.failure?.code).toBe('OVERSIZED');
    expect(pack.failure?.code).toBe('OVERSIZED');
    expect(
      document ? await originals.getOriginal(pack.packId, document.documentId) : 'missing',
    ).toBeUndefined();
  });

  it('rejects an eighth PDF with PACK_FILE_COUNT and keeps the first seven visible', async () => {
    const service = createService();
    const created = await service.createPack();
    await registerFixture(service, created.packId, 'pack-file-count');
    const pack = await service.getPack(created.packId);
    expect(pack.documents).toHaveLength(INTAKE_PACK_LIMITS.maxDocuments);
    expect(pack.failure?.code).toBe('PACK_FILE_COUNT');
    expect(pack.status).toBe('FAILED');
  });

  it('rejects a file that would exceed pack bytes with PACK_TOTAL_SIZE', async () => {
    const service = createService();
    const created = await service.createPack();
    await registerFixture(service, created.packId, 'pack-total-size');
    const pack = await service.getPack(created.packId);
    expect(pack.failure?.code).toBe('PACK_TOTAL_SIZE');
    expect(pack.documents.length).toBeGreaterThan(0);
    expect(pack.documents.length).toBeLessThan(4);
    const total = pack.documents.reduce((sum, document) => sum + document.byteSize, 0);
    expect(total).toBeLessThanOrEqual(INTAKE_PACK_LIMITS.maxPackBytes);
  });

  it('fails extraction with PAGE_LIMIT while keeping the documents visible', async () => {
    for (const fixturePackId of ['pack-page-limit', 'pack-document-page-limit']) {
      const service = createService();
      const created = await service.createPack();
      await registerFixture(service, created.packId, fixturePackId);
      await expect(service.extract(created.packId)).rejects.toBeInstanceOf(IntakePackConflictError);
      const pack = await service.getPack(created.packId);
      expect(pack.failure?.code, fixturePackId).toBe('PAGE_LIMIT');
      expect(pack.documents.length, fixturePackId).toBeGreaterThan(0);
      expect(pack.extraction, fixturePackId).toBeUndefined();
    }
  });

  it('fails extraction with EXTRACTED_TEXT_LIMIT for the dense-page fixture', async () => {
    const service = createService();
    const created = await service.createPack();
    await registerFixture(service, created.packId, 'pack-extracted-text-limit');
    await expect(service.extract(created.packId)).rejects.toBeInstanceOf(IntakePackConflictError);
    const pack = await service.getPack(created.packId);
    expect(pack.failure?.code).toBe('EXTRACTED_TEXT_LIMIT');
    expect(pack.documents[0]?.fileName).toBe('dense-page.pdf');
  });

  it('rejects a second appended note with NOTES_LIMIT', async () => {
    const service = createService();
    const created = await service.createPack();
    await registerFixture(service, created.packId, 'pack-notes-limit');
    const pack = await service.getPack(created.packId);
    expect(pack.notes).toHaveLength(INTAKE_PACK_LIMITS.maxNotes);
    expect(pack.failure?.code).toBe('NOTES_LIMIT');
  });

  it('returns the same immutable extraction on a second trigger', async () => {
    const service = createService();
    const created = await service.createPack();
    await registerFixture(service, created.packId, 'pack-clean-single-site');
    const first = await service.extract(created.packId);
    const second = await service.extract(created.packId);
    expect(second.extraction.extractionId).toBe(first.extraction.extractionId);
    expect(second.pack.draft).toBeUndefined();
  });
});

describe('Intake pack evidence-to-draft preparation', () => {
  it('prepares a review-only draft from extracted pages and notes without filling fields', async () => {
    const service = createService();
    const created = await service.createPack();
    await registerFixture(service, created.packId, 'pack-clean-single-site');
    await service.extract(created.packId);
    expect((await service.getPack(created.packId)).draft).toBeUndefined();

    const draft = await service.getDraft(created.packId);
    expect(intakeLayerMayInvokePricing('draft')).toBe(false);
    expect(draftStructuredFieldsAreEmpty(draft)).toBe(true);
    expect(draft.candidates.length).toBeGreaterThan(0);
    expect(
      draft.candidates.some(
        (candidate) =>
          candidate.field === 'customerLegalName' &&
          candidate.value === 'Northstar Foods Ltd' &&
          candidate.provenance.some(
            (item) => item.sourceKind === 'DOCUMENT_PAGE' && item.pageNumber === 1,
          ),
      ),
    ).toBe(true);
    expect(
      draft.candidates.some(
        (candidate) =>
          candidate.field === 'meterIdentifier' &&
          candidate.value === '1234567890123' &&
          candidate.associationStatus === 'RESOLVED' &&
          candidate.provenance[0]?.quote.includes('Warehouse MPAN'),
      ),
    ).toBe(true);
    expect(draft.candidates.every((candidate) => candidate.accepted === false)).toBe(true);

    const persisted = await service.getPack(created.packId);
    expect(persisted.draft?.draftVersion).toBe(1);
    expect(draftStructuredFieldsAreEmpty(persisted.draft!)).toBe(true);
    expect(await service.getDraft(created.packId)).toEqual(draft);
  });

  it('keeps both conflicting contract-end candidates and does not pick a winner', async () => {
    const service = createService();
    const created = await service.createPack();
    await registerFixture(service, created.packId, 'pack-conflicting-evidence');
    await service.extract(created.packId);
    const draft = await service.getDraft(created.packId);
    const dates = draft.candidates.filter((candidate) => candidate.field === 'contractEndDate');
    expect(dates.map((candidate) => candidate.value)).toEqual(
      expect.arrayContaining(['2027-03-31', '30/09/2026']),
    );
    expect(new Set(dates.map((candidate) => candidate.value)).size).toBeGreaterThanOrEqual(2);
    expect(draftStructuredFieldsAreEmpty(draft)).toBe(true);
  });

  it('leaves Harbour-site facts unassociated until reviewed', async () => {
    const service = createService();
    const created = await service.createPack();
    await registerFixture(service, created.packId, 'pack-ambiguous-site-association');
    await service.extract(created.packId);
    const draft = await service.getDraft(created.packId);
    const harbour = draft.candidates.filter(
      (candidate) => candidate.field === 'siteAddress' && candidate.value === 'the Harbour site',
    );
    expect(harbour.length).toBeGreaterThan(0);
    expect(harbour.every((candidate) => candidate.associationStatus === 'AMBIGUOUS')).toBe(true);
    expect(harbour.every((candidate) => candidate.siteId == null)).toBe(true);
    expect(draft.sites).toEqual([]);
    expect(draftStructuredFieldsAreEmpty(draft)).toBe(true);
  });

  it('does not prepare a draft before extraction and does not copy accepted values', async () => {
    const service = createService();
    const created = await service.createPack();
    await registerFixture(service, created.packId, 'pack-clean-single-site');
    await expect(service.getDraft(created.packId)).rejects.toBeInstanceOf(IntakeDraftNotFoundError);

    await service.extract(created.packId);
    const prepared = await service.getDraft(created.packId);
    const customer = prepared.candidates.find(
      (candidate) => candidate.field === 'customerLegalName',
    );
    const patched = await service.patchDraft(created.packId, {
      expectedDraftVersion: 1,
      acceptedCandidateIds: customer ? [customer.candidateId] : [],
    });
    expect(patched.draftVersion).toBe(2);
    expect(draftStructuredFieldsAreEmpty(patched)).toBe(true);

    const edited = await service.patchDraft(created.packId, {
      expectedDraftVersion: 2,
      fieldEdits: { customerLegalName: 'Northstar Foods Ltd' },
    });
    expect(edited.customer.legalName).toBe('Northstar Foods Ltd');
    await expect(
      service.patchDraft(created.packId, {
        expectedDraftVersion: 2,
        fieldEdits: { customerLegalName: 'Stale Ltd' },
      }),
    ).rejects.toBeInstanceOf(IntakePackConflictError);
  });
});
