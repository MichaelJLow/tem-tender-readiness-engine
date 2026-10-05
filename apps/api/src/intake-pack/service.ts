import { createHash, randomUUID } from 'node:crypto';
import {
  INTAKE_PACK_ENTRY_NAME,
  INTAKE_PACK_LIMITS,
  IntakePackSchema,
  applyIntakeDraftPatch,
  applyParsedDocumentToIntakeDocument,
  buildIntakeExtraction,
  canAddIntakeDocument,
  canPrepareIntakeDraft,
  canPutIntakeNote,
  classifyIntakeUpload,
  deriveIntakePackStatus,
  evaluateExtractionBounds,
  intakeLayerMayInvokePricing,
  prepareIntakeDraftFromEvidence,
  storedIntakeByteSize,
  transitionIntakeDocument,
  type IntakeDocument,
  type IntakeDraft,
  type IntakeDraftPatchInput,
  type IntakeExtraction,
  type IntakeNote,
  type IntakePack,
  type IntakePackFailure,
  type ParsedIntakeDocument,
} from '../../../../packages/domain/src/index.js';
import { parseSelectablePdf } from './pdf-parser.js';
import type { IntakeOriginalsStore } from './originals-store.js';
import type { IntakePackRepository } from './repository.js';

export class IntakePackNotFoundError extends Error {
  override name = 'IntakePackNotFoundError';
}

export class IntakePackConflictError extends Error {
  override name = 'IntakePackConflictError';
  constructor(
    readonly failure: IntakePackFailure,
    readonly pack?: IntakePack,
  ) {
    super(failure.message);
  }
}

export class IntakeDocumentNotFoundError extends Error {
  override name = 'IntakeDocumentNotFoundError';
}

export class IntakeExtractionNotFoundError extends Error {
  override name = 'IntakeExtractionNotFoundError';
}

export class IntakeDraftNotFoundError extends Error {
  override name = 'IntakeDraftNotFoundError';
}

export class IntakePackService {
  private queue: Promise<void> = Promise.resolve();

  constructor(
    private readonly repository: IntakePackRepository,
    private readonly originals: IntakeOriginalsStore,
    private readonly now: () => Date = () => new Date(),
    private readonly parsePdf: typeof parseSelectablePdf = parseSelectablePdf,
  ) {}

  createPack(): Promise<IntakePack> {
    return this.enqueue(async () => {
      const timestamp = this.now().toISOString();
      const pack = IntakePackSchema.parse({
        packId: `pack-${randomUUID()}`,
        kind: 'INTAKE_PACK',
        entryPoint: INTAKE_PACK_ENTRY_NAME,
        synthetic: true,
        status: 'CREATED',
        createdAt: timestamp,
        updatedAt: timestamp,
        documents: [],
        notes: [],
      });
      await this.repository.savePack(pack);
      return pack;
    });
  }

  async getPack(packId: string): Promise<IntakePack> {
    const pack = await this.repository.getPack(packId);
    if (!pack) throw new IntakePackNotFoundError(`Intake pack ${packId} was not found.`);
    return pack;
  }

  addDocument(input: {
    packId: string;
    fileName: string;
    contentType: string;
    bytes: Uint8Array;
  }): Promise<{ pack: IntakePack; document: IntakeDocument }> {
    return this.enqueue(async () => {
      const pack = await this.getPack(input.packId);
      const fileName = input.fileName.trim();
      const byteSize = input.bytes.byteLength;
      const classification = classifyIntakeUpload({
        fileName,
        contentType: input.contentType,
        byteSize,
        bytes: input.bytes,
      });

      if (classification.accepted) {
        const limit = canAddIntakeDocument(pack, byteSize);
        if (!limit.ok) {
          const failed = this.withPackFailure(pack, limit.failure);
          await this.repository.savePack(failed);
          throw new IntakePackConflictError(limit.failure, failed);
        }
      } else if (
        classification.documentFailure.code === 'OVERSIZED' ||
        classification.documentFailure.code === 'UNSUPPORTED'
      ) {
        const limit = canAddIntakeDocument(pack, storedIntakeByteSize(byteSize));
        if (!limit.ok) {
          const failed = this.withPackFailure(pack, limit.failure);
          await this.repository.savePack(failed);
          throw new IntakePackConflictError(limit.failure, failed);
        }
      }

      const timestamp = this.now().toISOString();
      const documentId = `doc-${randomUUID()}`;
      const storedSize = storedIntakeByteSize(byteSize);
      const sha256 = createHash('sha256').update(input.bytes).digest('hex');
      const failedClassification = classification.accepted ? undefined : classification;

      const document: IntakeDocument = {
        documentId,
        packId: pack.packId,
        fileName: fileName.slice(0, 256),
        contentType: 'application/pdf',
        byteSize: storedSize,
        status: failedClassification ? failedClassification.documentFailure.code : 'UPLOADED',
        sha256: failedClassification?.documentFailure.code === 'OVERSIZED' ? undefined : sha256,
        failure: failedClassification?.documentFailure,
        createdAt: timestamp,
        updatedAt: timestamp,
      };

      if (document.status !== 'OVERSIZED') {
        await this.originals.putOriginal(pack.packId, documentId, input.bytes);
      }

      const next: IntakePack = {
        ...pack,
        documents: [...pack.documents, document],
        failure: failedClassification ? failedClassification.packFailure : pack.failure,
        updatedAt: timestamp,
      };
      const saved = await this.persistDerived(next);
      return { pack: saved, document };
    });
  }

  async listDocuments(packId: string): Promise<IntakeDocument[]> {
    return (await this.getPack(packId)).documents;
  }

  async getDocument(packId: string, documentId: string): Promise<IntakeDocument> {
    const pack = await this.getPack(packId);
    const document = pack.documents.find((item) => item.documentId === documentId);
    if (!document) {
      throw new IntakeDocumentNotFoundError(
        `Intake document ${documentId} was not found on pack ${packId}.`,
      );
    }
    return document;
  }

  putNote(input: {
    packId: string;
    text: string;
  }): Promise<{ pack: IntakePack; notes: IntakeNote[] }> {
    return this.enqueue(async () => {
      const pack = await this.getPack(input.packId);
      const timestamp = this.now().toISOString();
      const text = input.text.trim().slice(0, INTAKE_PACK_LIMITS.maxNoteChars);
      const existing = pack.notes[0];
      const note: IntakeNote = existing
        ? { ...existing, text, updatedAt: timestamp }
        : {
            noteId: `note-${randomUUID()}`,
            text,
            createdAt: timestamp,
            updatedAt: timestamp,
          };
      const saved = await this.persistDerived({
        ...pack,
        notes: [note],
        updatedAt: timestamp,
      });
      return { pack: saved, notes: saved.notes };
    });
  }

  addNote(input: {
    packId: string;
    text: string;
  }): Promise<{ pack: IntakePack; notes: IntakeNote[] }> {
    return this.enqueue(async () => {
      const pack = await this.getPack(input.packId);
      const limit = canPutIntakeNote(pack);
      if (!limit.ok) {
        const failed = this.withPackFailure(pack, limit.failure);
        await this.repository.savePack(failed);
        throw new IntakePackConflictError(limit.failure, failed);
      }
      const timestamp = this.now().toISOString();
      const note: IntakeNote = {
        noteId: `note-${randomUUID()}`,
        text: input.text.trim().slice(0, INTAKE_PACK_LIMITS.maxNoteChars),
        createdAt: timestamp,
        updatedAt: timestamp,
      };
      const saved = await this.persistDerived({
        ...pack,
        notes: [...pack.notes, note],
        updatedAt: timestamp,
      });
      return { pack: saved, notes: saved.notes };
    });
  }

  async getNotes(packId: string): Promise<IntakeNote[]> {
    return (await this.getPack(packId)).notes;
  }

  extract(packId: string): Promise<{ pack: IntakePack; extraction: IntakeExtraction }> {
    return this.enqueue(async () => {
      if (intakeLayerMayInvokePricing('extraction')) {
        throw new Error('Intake pack extraction must never invoke pricing.');
      }
      const pack = await this.getPack(packId);
      if (pack.extraction) {
        return { pack, extraction: pack.extraction };
      }

      const timestamp = this.now().toISOString();
      const extracting: IntakePack = {
        ...pack,
        status: 'EXTRACTING',
        documents: pack.documents.map((document) =>
          document.status === 'UPLOADED'
            ? transitionIntakeDocument(document, 'VALIDATING', timestamp)
            : document,
        ),
        updatedAt: timestamp,
      };
      await this.repository.savePack(extracting);

      const parsedById = new Map<string, ParsedIntakeDocument>();
      const documents: IntakeDocument[] = [];

      for (const document of extracting.documents) {
        if (document.status === 'UNSUPPORTED' || document.status === 'OVERSIZED') {
          parsedById.set(document.documentId, {
            documentId: document.documentId,
            outcome: document.status,
            message: document.failure?.message ?? `Document is ${document.status}.`,
            pageCount: document.pageCount,
          });
          documents.push(document);
          continue;
        }

        const extractingDocument = transitionIntakeDocument(document, 'EXTRACTING', timestamp);
        const original = await this.originals.getOriginal(pack.packId, document.documentId);
        if (!original) {
          const failed: ParsedIntakeDocument = {
            documentId: document.documentId,
            outcome: 'EXTRACTION_FAILED',
            message: 'Original PDF bytes are missing; extraction cannot proceed.',
            pageCount: 0,
          };
          parsedById.set(document.documentId, failed);
          documents.push(
            applyParsedDocumentToIntakeDocument(extractingDocument, failed, timestamp),
          );
          continue;
        }

        const parsed = await this.parsePdf({
          documentId: document.documentId,
          bytes: original,
        });
        parsedById.set(document.documentId, parsed);
        documents.push(applyParsedDocumentToIntakeDocument(extractingDocument, parsed, timestamp));
      }

      const parsed = [...parsedById.values()];
      const boundFailure = evaluateExtractionBounds(parsed);
      const extraction =
        boundFailure === undefined
          ? buildIntakeExtraction({
              extractionId: `extraction-${randomUUID()}`,
              packId: pack.packId,
              createdAt: timestamp,
              parsed,
            })
          : undefined;
      const boundedDocuments =
        boundFailure?.code === 'PAGE_LIMIT'
          ? documents.map((document) => ({ ...document, pageCount: undefined }))
          : documents;

      const next: IntakePack = {
        ...extracting,
        documents: boundedDocuments,
        extraction,
        failure: boundFailure ?? extracting.failure,
        updatedAt: timestamp,
      };
      const saved = await this.persistDerived(next);
      if (!saved.extraction) {
        throw new IntakePackConflictError(
          saved.failure ?? {
            code: 'EXTRACTION_FAILED',
            message: 'Extraction did not produce a schema-valid immutable extraction.',
            retryable: false,
          },
          saved,
        );
      }
      return { pack: saved, extraction: saved.extraction };
    });
  }

  async getExtraction(packId: string): Promise<IntakeExtraction> {
    const pack = await this.getPack(packId);
    if (!pack.extraction) {
      if (pack.failure) throw new IntakePackConflictError(pack.failure, pack);
      throw new IntakeExtractionNotFoundError(`Intake pack ${packId} has no extraction yet.`);
    }
    return pack.extraction;
  }

  getDraft(packId: string): Promise<IntakeDraft> {
    return this.enqueue(async () => {
      this.assertDraftLayerCannotPrice();
      const pack = await this.getPack(packId);
      const ensured = await this.ensureDraft(pack);
      return ensured.draft!;
    });
  }

  patchDraft(packId: string, patch: IntakeDraftPatchInput): Promise<IntakeDraft> {
    return this.enqueue(async () => {
      this.assertDraftLayerCannotPrice();
      const pack = await this.getPack(packId);
      if (pack.status === 'CONFIRMED' || pack.confirmation) {
        throw new IntakePackConflictError(
          {
            code: 'ALREADY_CONFIRMED',
            message: 'A confirmed Intake pack draft cannot be patched.',
            retryable: false,
          },
          pack,
        );
      }
      const withDraft = await this.ensureDraft(pack);
      const timestamp = this.now().toISOString();
      const applied = applyIntakeDraftPatch(withDraft.draft!, patch, timestamp);
      if (!applied.ok) {
        throw new IntakePackConflictError(
          {
            code: applied.code,
            message: applied.message,
            retryable: false,
          },
          withDraft,
        );
      }
      const saved = await this.persistDerived({
        ...withDraft,
        draft: applied.draft,
        updatedAt: timestamp,
      });
      return saved.draft!;
    });
  }

  private async ensureDraft(pack: IntakePack): Promise<IntakePack> {
    if (pack.draft) return pack;
    const eligible = canPrepareIntakeDraft(pack);
    if (!eligible.ok) {
      throw new IntakeDraftNotFoundError(
        `Intake pack ${pack.packId} has no review draft yet. ${eligible.reason}`,
      );
    }
    this.assertDraftLayerCannotPrice();
    const timestamp = this.now().toISOString();
    const draft = prepareIntakeDraftFromEvidence({
      packId: pack.packId,
      updatedAt: timestamp,
      extraction: pack.extraction,
      notes: pack.notes,
    });
    return this.persistDerived({
      ...pack,
      draft,
      updatedAt: timestamp,
    });
  }

  private assertDraftLayerCannotPrice(): void {
    if (intakeLayerMayInvokePricing('draft')) {
      throw new Error('Intake pack draft preparation must never invoke pricing.');
    }
  }

  private withPackFailure(pack: IntakePack, failure: IntakePackFailure): IntakePack {
    return this.derived({
      ...pack,
      failure,
      updatedAt: this.now().toISOString(),
    });
  }

  private derived(pack: IntakePack): IntakePack {
    return IntakePackSchema.parse({
      ...pack,
      status: deriveIntakePackStatus(pack),
    });
  }

  private async persistDerived(pack: IntakePack): Promise<IntakePack> {
    const saved = this.derived(pack);
    await this.repository.savePack(saved);
    return saved;
  }

  private enqueue<T>(work: () => Promise<T>): Promise<T> {
    const run = this.queue.then(work, work);
    this.queue = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }
}
