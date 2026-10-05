import { z } from 'zod';
import {
  INTAKE_PACK_LIMITS,
  IntakeAssociationStatusSchema,
  IntakeDocumentFailureCodeSchema,
  IntakeDocumentStatusSchema,
  IntakeDraftFieldSchema,
  IntakePackFailureCodeSchema,
  IntakeProvenanceSchema,
} from './intake-pack.js';
import { TEXT_SOURCE_IDENTIFIER_MAX_CHARS } from './schemas.js';

const identifier = z.string().trim().min(1).max(TEXT_SOURCE_IDENTIFIER_MAX_CHARS);

/** Ticket ENG-18 scenario families. Limit-test packs share `oversized-limit-test`. */
export const IntakePackTicketScenarioSchema = z.enum([
  'clean-single-site',
  'clean-multi-site',
  'conflicting-evidence',
  'ambiguous-site-association',
  'scanned-ocr-required',
  'corrupt',
  'unsupported',
  'oversized-limit-test',
]);

export const IntakePackFixtureFileKindSchema = z.enum(['PDF', 'NOTE', 'UNSUPPORTED']);

export const IntakePackFixtureMaterializationSchema = z.enum(['committed', 'generated']);

export const IntakePackFixtureFileSchema = z.object({
  path: z.string().trim().min(1),
  fileName: z.string().trim().min(1).max(256),
  contentType: z.string().trim().min(1),
  kind: IntakePackFixtureFileKindSchema,
  materialization: IntakePackFixtureMaterializationSchema,
  documentId: identifier.optional(),
  noteId: identifier.optional(),
  expectedByteSize: z.number().int().nonnegative(),
  sha256: z
    .string()
    .regex(/^[a-f0-9]{64}$/)
    .optional(),
  expectedPageCount: z.number().int().nonnegative().optional(),
  expectedSelectableText: z.boolean().optional(),
  expectedStatus: IntakeDocumentStatusSchema.optional(),
  expectedFailureCode: IntakeDocumentFailureCodeSchema.optional(),
});

export const IntakePackFixtureExpectedSiteSchema = z.object({
  siteId: identifier,
  label: z.string().trim().min(1),
  address: z.string().trim().min(1),
  meterIdentifier: z.string().nullable().optional(),
  annualConsumptionKwh: z.number().finite().nullable().optional(),
  contractEndDate: z.string().nullable().optional(),
});

export const IntakePackFixtureExpectedFactSchema = z.object({
  field: IntakeDraftFieldSchema,
  value: z.string().trim().min(1).max(256),
  siteId: identifier.nullable().optional(),
  associationStatus: IntakeAssociationStatusSchema,
  provenance: z.array(IntakeProvenanceSchema).min(1).max(8),
});

export const IntakePackFixturePackSchema = z
  .object({
    packId: identifier,
    ticketScenario: IntakePackTicketScenarioSchema,
    title: z.string().trim().min(1),
    description: z.string().trim().min(1),
    synthetic: z.literal(true),
    directory: z.string().trim().min(1),
    expectedNoteCount: z.number().int().nonnegative(),
    expectedPackFailureCode: IntakePackFailureCodeSchema.optional(),
    files: z.array(IntakePackFixtureFileSchema).min(1),
    expectedSites: z.array(IntakePackFixtureExpectedSiteSchema).default([]),
    expectedFacts: z.array(IntakePackFixtureExpectedFactSchema).default([]),
  })
  .superRefine((pack, context) => {
    const notes = pack.files.filter((file) => file.kind === 'NOTE');
    if (notes.length !== pack.expectedNoteCount) {
      context.addIssue({
        code: 'custom',
        path: ['expectedNoteCount'],
        message: 'expectedNoteCount must equal the number of NOTE files.',
      });
    }
    if (pack.expectedNoteCount > INTAKE_PACK_LIMITS.maxNotes && !pack.expectedPackFailureCode) {
      context.addIssue({
        code: 'custom',
        path: ['expectedPackFailureCode'],
        message: 'A pack that exceeds the note limit must declare NOTES_LIMIT.',
      });
    }
  });

export const IntakePackFixtureLimitsSchema = z.object({
  maxDocuments: z.literal(INTAKE_PACK_LIMITS.maxDocuments),
  maxNotes: z.literal(INTAKE_PACK_LIMITS.maxNotes),
  maxFileBytes: z.literal(INTAKE_PACK_LIMITS.maxFileBytes),
  maxPackBytes: z.literal(INTAKE_PACK_LIMITS.maxPackBytes),
  maxPagesPerDocument: z.literal(INTAKE_PACK_LIMITS.maxPagesPerDocument),
  maxPagesPerPack: z.literal(INTAKE_PACK_LIMITS.maxPagesPerPack),
  maxExtractedCharsPerPage: z.literal(INTAKE_PACK_LIMITS.maxExtractedCharsPerPage),
  maxExtractedCharsPerDocument: z.literal(INTAKE_PACK_LIMITS.maxExtractedCharsPerDocument),
  maxExtractedCharsPerPack: z.literal(INTAKE_PACK_LIMITS.maxExtractedCharsPerPack),
  maxNoteChars: z.literal(INTAKE_PACK_LIMITS.maxNoteChars),
  allowedContentTypes: z.tuple([z.literal('application/pdf')]),
  allowedFilenameExtensions: z.tuple([z.literal('.pdf')]),
});

export const IntakePackFixtureManifestSchema = z
  .object({
    schemaVersion: z.literal(1),
    synthetic: z.literal(true),
    disclaimer: z.string().trim().min(1),
    generatedBy: z.string().trim().min(1),
    limits: IntakePackFixtureLimitsSchema,
    packs: z.array(IntakePackFixturePackSchema).min(1),
  })
  .superRefine((manifest, context) => {
    const packIds = new Set<string>();
    const ticketScenarios = new Set<string>();
    manifest.packs.forEach((pack, index) => {
      if (packIds.has(pack.packId)) {
        context.addIssue({
          code: 'custom',
          path: ['packs', index, 'packId'],
          message: `Duplicate fixture pack ID: ${pack.packId}`,
        });
      }
      packIds.add(pack.packId);
      ticketScenarios.add(pack.ticketScenario);
    });
    for (const scenario of IntakePackTicketScenarioSchema.options) {
      if (!ticketScenarios.has(scenario)) {
        context.addIssue({
          code: 'custom',
          path: ['packs'],
          message: `Fixture manifest is missing ticket scenario ${scenario}.`,
        });
      }
    }
  });

export const INTAKE_PACK_FIXTURE_DISCLAIMER =
  'SYNTHETIC / DEMONSTRATION. All packs, PDFs, notes, meters, sites, and companies in this directory are demonstration materials. They are not real tenders, customers, brokers, or tem data.';

export type IntakePackTicketScenario = z.infer<typeof IntakePackTicketScenarioSchema>;
export type IntakePackFixtureFile = z.infer<typeof IntakePackFixtureFileSchema>;
export type IntakePackFixtureExpectedSite = z.infer<typeof IntakePackFixtureExpectedSiteSchema>;
export type IntakePackFixtureExpectedFact = z.infer<typeof IntakePackFixtureExpectedFactSchema>;
export type IntakePackFixturePack = z.infer<typeof IntakePackFixturePackSchema>;
export type IntakePackFixtureManifest = z.infer<typeof IntakePackFixtureManifestSchema>;
