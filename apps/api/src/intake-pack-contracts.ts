import { z } from 'zod';
import {
  INTAKE_PACK_LIMITS,
  IntakeConfirmationSchema,
  IntakeDocumentSchema,
  IntakeDraftSchema,
  IntakeDraftSiteSchema,
  IntakeExtractionSchema,
  IntakeNoteSchema,
  IntakePackSchema,
  TEXT_SOURCE_IDENTIFIER_MAX_CHARS,
} from '../../../packages/domain/src/index.js';

const identifier = z.string().trim().min(1).max(TEXT_SOURCE_IDENTIFIER_MAX_CHARS);

/**
 * HTTP contract sketch for Intake pack. Routes are not wired in ENG-17.
 *
 * POST /intake-packs
 * GET  /intake-packs/:packId
 * POST /intake-packs/:packId/documents
 * GET  /intake-packs/:packId/documents
 * GET  /intake-packs/:packId/documents/:documentId
 * PUT  /intake-packs/:packId/notes
 * GET  /intake-packs/:packId/notes
 * POST /intake-packs/:packId/extractions
 * GET  /intake-packs/:packId/extractions
 * GET  /intake-packs/:packId/draft
 * PATCH /intake-packs/:packId/draft
 * POST /intake-packs/:packId/confirm
 * GET  /intake-packs/:packId/confirmation
 */
export const IntakePackApiPathSchema = z.enum([
  '/intake-packs',
  '/intake-packs/:packId',
  '/intake-packs/:packId/documents',
  '/intake-packs/:packId/documents/:documentId',
  '/intake-packs/:packId/notes',
  '/intake-packs/:packId/extractions',
  '/intake-packs/:packId/draft',
  '/intake-packs/:packId/confirm',
  '/intake-packs/:packId/confirmation',
]);

export const CreateIntakePackRequestSchema = z
  .object({
    synthetic: z.literal(true).default(true),
  })
  .strict();

export const CreateIntakePackResponseSchema = IntakePackSchema;

export const AddIntakeDocumentMetadataSchema = z.object({
  fileName: z.string().trim().min(1).max(256),
  contentType: z.literal('application/pdf'),
  byteSize: z.number().int().positive().max(INTAKE_PACK_LIMITS.maxFileBytes),
});

export const PutIntakeNotesRequestSchema = z
  .object({
    text: z.string().trim().min(1).max(INTAKE_PACK_LIMITS.maxNoteChars),
  })
  .strict();

export const PutIntakeNotesResponseSchema = z.object({
  packId: identifier,
  notes: z.array(IntakeNoteSchema).max(INTAKE_PACK_LIMITS.maxNotes),
});

export const TriggerIntakeExtractionRequestSchema = z.object({}).strict();

export const IntakeDraftFieldEditSchema = z.object({
  customerLegalName: z.string().optional(),
  brokerLegalName: z.string().optional(),
  sites: z.array(IntakeDraftSiteSchema).optional(),
});

export const PatchIntakeDraftRequestSchema = z
  .object({
    expectedDraftVersion: z.number().int().positive(),
    acceptedCandidateIds: z.array(identifier).max(200).default([]),
    rejectedCandidateIds: z.array(identifier).max(200).default([]),
    fieldEdits: IntakeDraftFieldEditSchema.default({}),
  })
  .strict();

export const ConfirmIntakePackRequestSchema = z
  .object({
    expectedDraftVersion: z.number().int().positive(),
    idempotencyKey: identifier,
  })
  .strict();

export const ConfirmIntakePackResponseSchema = z.object({
  packId: identifier,
  confirmation: IntakeConfirmationSchema,
  tenderId: identifier,
  runId: z.string().uuid().optional(),
});

export const IntakePackDocumentListResponseSchema = z.object({
  packId: identifier,
  documents: z.array(IntakeDocumentSchema).max(INTAKE_PACK_LIMITS.maxDocuments),
});

export const IntakePackExtractionResponseSchema = IntakeExtractionSchema;
export const IntakePackDraftResponseSchema = IntakeDraftSchema;
export const IntakePackConfirmationResponseSchema = IntakeConfirmationSchema;

export const DEFAULT_INTAKE_PACK_ACTOR = 'local-demo-operator';

export function intakePackActorFromEnv(env: NodeJS.ProcessEnv = process.env): string {
  return env.REVIEW_ACTOR?.trim() || DEFAULT_INTAKE_PACK_ACTOR;
}

export type CreateIntakePackRequest = z.infer<typeof CreateIntakePackRequestSchema>;
export type AddIntakeDocumentMetadata = z.infer<typeof AddIntakeDocumentMetadataSchema>;
export type PutIntakeNotesRequest = z.infer<typeof PutIntakeNotesRequestSchema>;
export type PatchIntakeDraftRequest = z.infer<typeof PatchIntakeDraftRequestSchema>;
export type ConfirmIntakePackRequest = z.infer<typeof ConfirmIntakePackRequestSchema>;
export type ConfirmIntakePackResponse = z.infer<typeof ConfirmIntakePackResponseSchema>;
export type IntakePackApiPath = z.infer<typeof IntakePackApiPathSchema>;
