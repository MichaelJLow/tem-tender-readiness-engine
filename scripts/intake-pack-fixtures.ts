import { createHash } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  INTAKE_PACK_LIMITS,
  INTAKE_PACK_FIXTURE_DISCLAIMER,
  IntakePackFixtureManifestSchema,
  type IntakePackFixtureExpectedFact,
  type IntakePackFixtureExpectedSite,
  type IntakePackFixtureFile,
  type IntakePackFixtureManifest,
  type IntakePackFixturePack,
  type IntakePackTicketScenario,
} from '../packages/domain/src/index.js';
import {
  buildCorruptPdf,
  buildSyntheticPdf,
  padBytesToSize,
  type PdfPage,
} from './synthetic-pdf.js';

export const INTAKE_PACK_FIXTURES_ROOT = join(
  dirname(fileURLToPath(import.meta.url)),
  '../fixtures/intake-packs',
);

const CUSTOMER = 'Northstar Foods Ltd';
const BROKER = 'Harbour Energy Partners';

const WAREHOUSE: IntakePackFixtureExpectedSite = {
  siteId: 'site-warehouse',
  label: 'Northstar warehouse (synthetic)',
  address: '10 Example Street, London',
  meterIdentifier: '1234567890123',
  annualConsumptionKwh: 24_000,
  contractEndDate: '2027-03-31',
};

const RETAIL: IntakePackFixtureExpectedSite = {
  siteId: 'site-retail',
  label: 'Northstar retail (synthetic)',
  address: '22 Harbour Lane, Manchester',
  meterIdentifier: '2345678901234',
  annualConsumptionKwh: 18_500,
  contractEndDate: '2027-09-30',
};

const PAGE_LIMIT_PREFIX = 'SYNTHETIC / DEMONSTRATION. Dense page limit fixture.';
export const PAGE_LIMIT_SELECTABLE_CHARS =
  PAGE_LIMIT_PREFIX +
  'A'.repeat(INTAKE_PACK_LIMITS.maxExtractedCharsPerPage + 1 - PAGE_LIMIT_PREFIX.length);

const MINIMAL_PNG = Buffer.from(
  '89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d4944415478da63f8cfc000000301010018dd8d7f0000000049454e44ae426082',
  'hex',
);

export interface FixtureFileBytes {
  relativePath: string;
  bytes: Buffer;
}

interface FileSpec {
  fileName: string;
  contentType: string;
  kind: IntakePackFixtureFile['kind'];
  materialization: IntakePackFixtureFile['materialization'];
  documentId?: string;
  noteId?: string;
  expectedPageCount?: number;
  expectedSelectableText?: boolean;
  expectedStatus?: IntakePackFixtureFile['expectedStatus'];
  expectedFailureCode?: IntakePackFixtureFile['expectedFailureCode'];
  bytes: Buffer;
}

interface PackSpec {
  packId: string;
  ticketScenario: IntakePackTicketScenario;
  title: string;
  description: string;
  expectedPackFailureCode?: IntakePackFixturePack['expectedPackFailureCode'];
  expectedSites?: IntakePackFixtureExpectedSite[];
  expectedFacts?: IntakePackFixtureExpectedFact[];
  files: FileSpec[];
}

function banner(packId: string): string[] {
  return [
    'SYNTHETIC / DEMONSTRATION',
    'Not a real tender. Not tem customer, broker, or meter data.',
    `Fixture pack: ${packId}`,
  ];
}

function noteText(packId: string, body: string[]): string {
  return [...banner(packId), '', ...body, ''].join('\n');
}

function sha256(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function documentPageProvenance(
  documentId: string,
  pageNumber: number,
  quote: string,
): IntakePackFixtureExpectedFact['provenance'][number] {
  return {
    sourceKind: 'DOCUMENT_PAGE',
    sourceId: documentId,
    documentId,
    pageNumber,
    quote,
    locator: `page=${pageNumber}`,
  };
}

function noteProvenance(
  noteId: string,
  quote: string,
): IntakePackFixtureExpectedFact['provenance'][number] {
  return {
    sourceKind: 'NOTE',
    sourceId: noteId,
    quote,
    locator: 'note',
  };
}

function fact(input: {
  field: IntakePackFixtureExpectedFact['field'];
  value: string;
  siteId?: string | null;
  associationStatus: IntakePackFixtureExpectedFact['associationStatus'];
  provenance: IntakePackFixtureExpectedFact['provenance'];
}): IntakePackFixtureExpectedFact {
  return {
    field: input.field,
    value: input.value,
    siteId: input.siteId,
    associationStatus: input.associationStatus,
    provenance: input.provenance,
  };
}

function textPdf(title: string, pages: string[][]): Buffer {
  return buildSyntheticPdf({
    title,
    pages: pages.map((lines) => ({ type: 'text', lines }) satisfies PdfPage),
  });
}

function numberedPages(packId: string, label: string, count: number): string[][] {
  return Array.from({ length: count }, (_, index) => [
    ...banner(packId),
    `${label} page ${index + 1} of ${count}`,
  ]);
}

function fileSpec(input: FileSpec): FileSpec {
  return input;
}

function pdfFile(
  documentId: string,
  fileName: string,
  bytes: Buffer,
  extra: Partial<FileSpec> = {},
): FileSpec {
  return fileSpec({
    fileName,
    contentType: 'application/pdf',
    kind: 'PDF',
    materialization: 'committed',
    documentId,
    expectedSelectableText: true,
    expectedStatus: 'EXTRACTED',
    bytes,
    ...extra,
  });
}

function noteFile(noteId: string, fileName: string, text: string): FileSpec {
  return fileSpec({
    fileName,
    contentType: 'text/plain; charset=utf-8',
    kind: 'NOTE',
    materialization: 'committed',
    noteId,
    bytes: Buffer.from(text, 'utf8'),
  });
}

function buildPackSpecs(): PackSpec[] {
  const warehouseDoc = 'doc-warehouse-contract';
  const retailDoc = 'doc-retail-contract';
  const singleDoc = 'doc-clean-single-site-contract';
  const singleNote = 'note-clean-single-site';
  const multiNote = 'note-clean-multi-site';
  const conflictA = 'doc-conflict-schedule-a';
  const conflictB = 'doc-conflict-schedule-b';
  const conflictNote = 'note-conflicting-evidence';
  const ambiguousDoc = 'doc-ambiguous-portfolio-letter';
  const ambiguousNote = 'note-ambiguous-site-association';

  const packTotalSizeEach = Math.floor(INTAKE_PACK_LIMITS.maxPackBytes / 4) + 1;

  return [
    {
      packId: 'pack-clean-single-site',
      ticketScenario: 'clean-single-site',
      title: 'Clean single-site synthetic pack',
      description:
        'One selectable-text PDF and one broker note for a single warehouse site. Expected EXTRACTED.',
      expectedSites: [WAREHOUSE],
      expectedFacts: [
        fact({
          field: 'customerLegalName',
          value: CUSTOMER,
          associationStatus: 'RESOLVED',
          provenance: [
            documentPageProvenance(singleDoc, 1, `Customer: ${CUSTOMER}`),
            noteProvenance(singleNote, `Customer ${CUSTOMER}`),
          ],
        }),
        fact({
          field: 'brokerLegalName',
          value: BROKER,
          associationStatus: 'RESOLVED',
          provenance: [documentPageProvenance(singleDoc, 1, `Broker: ${BROKER}`)],
        }),
        fact({
          field: 'siteAddress',
          value: WAREHOUSE.address,
          siteId: WAREHOUSE.siteId,
          associationStatus: 'RESOLVED',
          provenance: [
            documentPageProvenance(singleDoc, 2, `Warehouse site address: ${WAREHOUSE.address}`),
          ],
        }),
        fact({
          field: 'meterIdentifier',
          value: WAREHOUSE.meterIdentifier!,
          siteId: WAREHOUSE.siteId,
          associationStatus: 'RESOLVED',
          provenance: [
            documentPageProvenance(singleDoc, 2, `Warehouse MPAN ${WAREHOUSE.meterIdentifier}`),
          ],
        }),
        fact({
          field: 'annualConsumptionKwh',
          value: String(WAREHOUSE.annualConsumptionKwh),
          siteId: WAREHOUSE.siteId,
          associationStatus: 'RESOLVED',
          provenance: [
            documentPageProvenance(
              singleDoc,
              2,
              `Warehouse annual consumption ${WAREHOUSE.annualConsumptionKwh} kWh`,
            ),
          ],
        }),
        fact({
          field: 'contractEndDate',
          value: WAREHOUSE.contractEndDate!,
          siteId: WAREHOUSE.siteId,
          associationStatus: 'RESOLVED',
          provenance: [
            documentPageProvenance(
              singleDoc,
              2,
              `Warehouse contract end date ${WAREHOUSE.contractEndDate}`,
            ),
          ],
        }),
      ],
      files: [
        pdfFile(
          singleDoc,
          'northstar-electricity-contract.pdf',
          textPdf('clean single-site contract', [
            [
              ...banner('pack-clean-single-site'),
              'SYNTHETIC-LOCATOR pack-clean-single-site page-1',
              `Customer: ${CUSTOMER}`,
              `Broker: ${BROKER}`,
              'Commodity: electricity',
              'This pack contains one warehouse site only.',
            ],
            [
              ...banner('pack-clean-single-site'),
              'SYNTHETIC-LOCATOR pack-clean-single-site page-2',
              `Warehouse site address: ${WAREHOUSE.address}`,
              `Warehouse MPAN ${WAREHOUSE.meterIdentifier}`,
              `Warehouse annual consumption ${WAREHOUSE.annualConsumptionKwh} kWh`,
              `Warehouse contract end date ${WAREHOUSE.contractEndDate}`,
            ],
          ]),
          { expectedPageCount: 2 },
        ),
        noteFile(
          singleNote,
          'broker-note.txt',
          noteText('pack-clean-single-site', [
            `Customer ${CUSTOMER}. Broker ${BROKER}.`,
            `Please price the single London warehouse site at ${WAREHOUSE.address}.`,
            `MPAN ${WAREHOUSE.meterIdentifier}, ${WAREHOUSE.annualConsumptionKwh} kWh, contract end ${WAREHOUSE.contractEndDate}.`,
          ]),
        ),
      ],
    },
    {
      packId: 'pack-clean-multi-site',
      ticketScenario: 'clean-multi-site',
      title: 'Clean multi-site synthetic pack',
      description:
        'Two selectable-text PDFs, one per site, plus a broker note. Core provenance fixture for ENG-19 page-to-site assertions.',
      expectedSites: [WAREHOUSE, RETAIL],
      expectedFacts: [
        fact({
          field: 'customerLegalName',
          value: CUSTOMER,
          associationStatus: 'RESOLVED',
          provenance: [
            documentPageProvenance(warehouseDoc, 1, `Customer: ${CUSTOMER}`),
            documentPageProvenance(retailDoc, 1, `Customer: ${CUSTOMER}`),
          ],
        }),
        fact({
          field: 'brokerLegalName',
          value: BROKER,
          associationStatus: 'RESOLVED',
          provenance: [documentPageProvenance(warehouseDoc, 1, `Broker: ${BROKER}`)],
        }),
        fact({
          field: 'siteAddress',
          value: WAREHOUSE.address,
          siteId: WAREHOUSE.siteId,
          associationStatus: 'RESOLVED',
          provenance: [
            documentPageProvenance(warehouseDoc, 2, `Warehouse site address: ${WAREHOUSE.address}`),
            noteProvenance(multiNote, 'London warehouse'),
          ],
        }),
        fact({
          field: 'meterIdentifier',
          value: WAREHOUSE.meterIdentifier!,
          siteId: WAREHOUSE.siteId,
          associationStatus: 'RESOLVED',
          provenance: [
            documentPageProvenance(warehouseDoc, 2, `Warehouse MPAN ${WAREHOUSE.meterIdentifier}`),
          ],
        }),
        fact({
          field: 'annualConsumptionKwh',
          value: String(WAREHOUSE.annualConsumptionKwh),
          siteId: WAREHOUSE.siteId,
          associationStatus: 'RESOLVED',
          provenance: [
            documentPageProvenance(
              warehouseDoc,
              2,
              `Warehouse annual consumption ${WAREHOUSE.annualConsumptionKwh} kWh`,
            ),
          ],
        }),
        fact({
          field: 'contractEndDate',
          value: WAREHOUSE.contractEndDate!,
          siteId: WAREHOUSE.siteId,
          associationStatus: 'RESOLVED',
          provenance: [
            documentPageProvenance(
              warehouseDoc,
              2,
              `Warehouse contract end date ${WAREHOUSE.contractEndDate}`,
            ),
          ],
        }),
        fact({
          field: 'siteAddress',
          value: RETAIL.address,
          siteId: RETAIL.siteId,
          associationStatus: 'RESOLVED',
          provenance: [
            documentPageProvenance(retailDoc, 2, `Retail site address: ${RETAIL.address}`),
            noteProvenance(multiNote, 'Manchester retail'),
          ],
        }),
        fact({
          field: 'meterIdentifier',
          value: RETAIL.meterIdentifier!,
          siteId: RETAIL.siteId,
          associationStatus: 'RESOLVED',
          provenance: [
            documentPageProvenance(retailDoc, 2, `Retail MPAN ${RETAIL.meterIdentifier}`),
          ],
        }),
        fact({
          field: 'annualConsumptionKwh',
          value: String(RETAIL.annualConsumptionKwh),
          siteId: RETAIL.siteId,
          associationStatus: 'RESOLVED',
          provenance: [
            documentPageProvenance(
              retailDoc,
              2,
              `Retail annual consumption ${RETAIL.annualConsumptionKwh} kWh`,
            ),
          ],
        }),
        fact({
          field: 'contractEndDate',
          value: RETAIL.contractEndDate!,
          siteId: RETAIL.siteId,
          associationStatus: 'RESOLVED',
          provenance: [
            documentPageProvenance(
              retailDoc,
              2,
              `Retail contract end date ${RETAIL.contractEndDate}`,
            ),
          ],
        }),
      ],
      files: [
        pdfFile(
          warehouseDoc,
          'northstar-warehouse-contract.pdf',
          textPdf('clean multi-site warehouse contract', [
            [
              ...banner('pack-clean-multi-site'),
              'SYNTHETIC-LOCATOR pack-clean-multi-site doc-warehouse page-1',
              `Customer: ${CUSTOMER}`,
              `Broker: ${BROKER}`,
              'This document belongs only to the warehouse site.',
            ],
            [
              ...banner('pack-clean-multi-site'),
              'SYNTHETIC-LOCATOR pack-clean-multi-site doc-warehouse page-2',
              `Warehouse site address: ${WAREHOUSE.address}`,
              `Warehouse MPAN ${WAREHOUSE.meterIdentifier}`,
              `Warehouse annual consumption ${WAREHOUSE.annualConsumptionKwh} kWh`,
              `Warehouse contract end date ${WAREHOUSE.contractEndDate}`,
            ],
          ]),
          { expectedPageCount: 2 },
        ),
        pdfFile(
          retailDoc,
          'northstar-retail-contract.pdf',
          textPdf('clean multi-site retail contract', [
            [
              ...banner('pack-clean-multi-site'),
              'SYNTHETIC-LOCATOR pack-clean-multi-site doc-retail page-1',
              `Customer: ${CUSTOMER}`,
              `Broker: ${BROKER}`,
              'This document belongs only to the retail site.',
            ],
            [
              ...banner('pack-clean-multi-site'),
              'SYNTHETIC-LOCATOR pack-clean-multi-site doc-retail page-2',
              `Retail site address: ${RETAIL.address}`,
              `Retail MPAN ${RETAIL.meterIdentifier}`,
              `Retail annual consumption ${RETAIL.annualConsumptionKwh} kWh`,
              `Retail contract end date ${RETAIL.contractEndDate}`,
            ],
          ]),
          { expectedPageCount: 2 },
        ),
        noteFile(
          multiNote,
          'broker-note.txt',
          noteText('pack-clean-multi-site', [
            `Customer ${CUSTOMER}. Broker ${BROKER}.`,
            'Please price both the London warehouse and the Manchester retail sites together.',
            `Warehouse: ${WAREHOUSE.address}, MPAN ${WAREHOUSE.meterIdentifier}.`,
            `Retail: ${RETAIL.address}, MPAN ${RETAIL.meterIdentifier}.`,
          ]),
        ),
      ],
    },
    {
      packId: 'pack-conflicting-evidence',
      ticketScenario: 'conflicting-evidence',
      title: 'Conflicting contract-end evidence',
      description:
        'Two selectable-text PDFs for the same warehouse site with different contract end dates. Extraction should succeed; routing later escalates.',
      expectedSites: [WAREHOUSE],
      expectedFacts: [
        fact({
          field: 'contractEndDate',
          value: '2027-03-31',
          siteId: WAREHOUSE.siteId,
          associationStatus: 'RESOLVED',
          provenance: [
            documentPageProvenance(conflictA, 1, 'Schedule A contract end date 2027-03-31'),
          ],
        }),
        fact({
          field: 'contractEndDate',
          value: '30/09/2026',
          siteId: WAREHOUSE.siteId,
          associationStatus: 'RESOLVED',
          provenance: [
            documentPageProvenance(conflictB, 1, 'Schedule B contract end date 30/09/2026'),
          ],
        }),
        fact({
          field: 'siteAddress',
          value: WAREHOUSE.address,
          siteId: WAREHOUSE.siteId,
          associationStatus: 'RESOLVED',
          provenance: [
            documentPageProvenance(conflictA, 1, `Warehouse site address: ${WAREHOUSE.address}`),
            documentPageProvenance(conflictB, 1, `Warehouse site address: ${WAREHOUSE.address}`),
          ],
        }),
      ],
      files: [
        pdfFile(
          conflictA,
          'contract-schedule-a.pdf',
          textPdf('conflicting schedule A', [
            [
              ...banner('pack-conflicting-evidence'),
              'SYNTHETIC-LOCATOR pack-conflicting-evidence schedule-a page-1',
              `Customer: ${CUSTOMER}`,
              `Warehouse site address: ${WAREHOUSE.address}`,
              `Warehouse MPAN ${WAREHOUSE.meterIdentifier}`,
              'Schedule A contract end date 2027-03-31',
            ],
          ]),
          { expectedPageCount: 1 },
        ),
        pdfFile(
          conflictB,
          'contract-schedule-b.pdf',
          textPdf('conflicting schedule B', [
            [
              ...banner('pack-conflicting-evidence'),
              'SYNTHETIC-LOCATOR pack-conflicting-evidence schedule-b page-1',
              `Customer: ${CUSTOMER}`,
              `Warehouse site address: ${WAREHOUSE.address}`,
              `Warehouse MPAN ${WAREHOUSE.meterIdentifier}`,
              'Schedule B contract end date 30/09/2026',
            ],
          ]),
          { expectedPageCount: 1 },
        ),
        noteFile(
          conflictNote,
          'broker-note.txt',
          noteText('pack-conflicting-evidence', [
            'Schedule A says 2027-03-31. Schedule B says 30/09/2026.',
            'Do not silently pick a date. This conflict is intentional demonstration evidence.',
          ]),
        ),
      ],
    },
    {
      packId: 'pack-ambiguous-site-association',
      ticketScenario: 'ambiguous-site-association',
      title: 'Ambiguous Harbour site association',
      description:
        'One letter refers to the Harbour site without a meter or full address, so it can attach to warehouse or retail.',
      expectedSites: [WAREHOUSE, RETAIL],
      expectedFacts: [
        fact({
          field: 'siteAddress',
          value: 'the Harbour site',
          siteId: null,
          associationStatus: 'AMBIGUOUS',
          provenance: [
            documentPageProvenance(ambiguousDoc, 1, 'Please price the Harbour site'),
            noteProvenance(ambiguousNote, 'the Harbour site'),
          ],
        }),
      ],
      files: [
        pdfFile(
          ambiguousDoc,
          'portfolio-letter.pdf',
          textPdf('ambiguous harbour site letter', [
            [
              ...banner('pack-ambiguous-site-association'),
              'SYNTHETIC-LOCATOR pack-ambiguous-site-association page-1',
              `Customer: ${CUSTOMER}`,
              `Broker: ${BROKER}`,
              'Please price the Harbour site.',
              'No MPAN is printed. The letter does not say London or Manchester.',
            ],
          ]),
          { expectedPageCount: 1 },
        ),
        noteFile(
          ambiguousNote,
          'broker-note.txt',
          noteText('pack-ambiguous-site-association', [
            `Customer has both ${WAREHOUSE.address} and ${RETAIL.address}.`,
            'The attached letter only says the Harbour site. Do not guess the site.',
          ]),
        ),
      ],
    },
    {
      packId: 'pack-scanned-ocr-required',
      ticketScenario: 'scanned-ocr-required',
      title: 'Scanned image-only PDF',
      description:
        'Image-only PDF with no selectable text. ENG-19 should mark OCR_REQUIRED. OCR is out of scope.',
      files: [
        pdfFile(
          'doc-scanned-invoice',
          'scanned-invoice.pdf',
          buildSyntheticPdf({
            title: 'scanned OCR-required invoice',
            pages: [{ type: 'image-only' }],
          }),
          {
            expectedPageCount: 1,
            expectedSelectableText: false,
            expectedStatus: 'OCR_REQUIRED',
            expectedFailureCode: 'OCR_REQUIRED',
          },
        ),
        noteFile(
          'note-scanned-ocr-required',
          'broker-note.txt',
          noteText('pack-scanned-ocr-required', [
            'The attached invoice is a scanned demonstration image with no selectable text.',
            'Expected document status: OCR_REQUIRED.',
          ]),
        ),
      ],
    },
    {
      packId: 'pack-corrupt',
      ticketScenario: 'corrupt',
      title: 'Truncated corrupt PDF',
      description: 'PDF header is present but the file is truncated before xref. Expected CORRUPT.',
      files: [
        pdfFile('doc-corrupt-contract', 'truncated-contract.pdf', buildCorruptPdf(), {
          expectedPageCount: 0,
          expectedSelectableText: false,
          expectedStatus: 'CORRUPT',
          expectedFailureCode: 'CORRUPT',
        }),
        noteFile(
          'note-corrupt',
          'broker-note.txt',
          noteText('pack-corrupt', [
            'The attached PDF is deliberately truncated demonstration garbage.',
            'Expected document status: CORRUPT.',
          ]),
        ),
      ],
    },
    {
      packId: 'pack-unsupported',
      ticketScenario: 'unsupported',
      title: 'Unsupported non-PDF files',
      description:
        'A text file, a PNG, and a .pdf filename that is not PDF bytes. Expected UNSUPPORTED.',
      expectedPackFailureCode: 'UNSUPPORTED',
      files: [
        fileSpec({
          fileName: 'cover-letter.txt',
          contentType: 'text/plain; charset=utf-8',
          kind: 'UNSUPPORTED',
          materialization: 'committed',
          documentId: 'doc-unsupported-text',
          expectedSelectableText: false,
          expectedStatus: 'UNSUPPORTED',
          expectedFailureCode: 'UNSUPPORTED',
          bytes: Buffer.from(
            noteText('pack-unsupported', [
              'This is a plain-text cover letter, not an application/pdf file.',
            ]),
            'utf8',
          ),
        }),
        fileSpec({
          fileName: 'logo.png',
          contentType: 'image/png',
          kind: 'UNSUPPORTED',
          materialization: 'committed',
          documentId: 'doc-unsupported-png',
          expectedSelectableText: false,
          expectedStatus: 'UNSUPPORTED',
          expectedFailureCode: 'UNSUPPORTED',
          bytes: MINIMAL_PNG,
        }),
        fileSpec({
          fileName: 'not-a-pdf.pdf',
          contentType: 'text/plain; charset=utf-8',
          kind: 'UNSUPPORTED',
          materialization: 'committed',
          documentId: 'doc-unsupported-pdf-name',
          expectedSelectableText: false,
          expectedStatus: 'UNSUPPORTED',
          expectedFailureCode: 'UNSUPPORTED',
          bytes: Buffer.from(
            'SYNTHETIC / DEMONSTRATION\nThis text file uses a .pdf filename but is not PDF bytes.\n',
            'utf8',
          ),
        }),
        noteFile(
          'note-unsupported',
          'broker-note.txt',
          noteText('pack-unsupported', [
            'These attachments are intentionally not PDFs.',
            'Expected document status: UNSUPPORTED.',
          ]),
        ),
      ],
    },
    {
      packId: 'pack-extraction-failed',
      ticketScenario: 'oversized-limit-test',
      title: 'Invalid FlateDecode PDF',
      description:
        'Structurally wrapped PDF whose content stream is not valid FlateDecode. Expected EXTRACTION_FAILED.',
      files: [
        pdfFile(
          'doc-extraction-failed',
          'deflate-broken.pdf',
          buildSyntheticPdf({
            title: 'invalid FlateDecode extraction-failed fixture',
            pages: [{ type: 'invalid-flate' }],
          }),
          {
            expectedPageCount: 1,
            expectedSelectableText: false,
            expectedStatus: 'EXTRACTION_FAILED',
            expectedFailureCode: 'EXTRACTION_FAILED',
          },
        ),
        noteFile(
          'note-extraction-failed',
          'broker-note.txt',
          noteText('pack-extraction-failed', [
            'The attached PDF looks like a PDF but the page stream is not valid FlateDecode.',
            'Expected document status: EXTRACTION_FAILED, not silent empty text.',
          ]),
        ),
      ],
    },
    {
      packId: 'pack-oversized-file',
      ticketScenario: 'oversized-limit-test',
      title: 'Single file just over 8 MiB',
      description:
        'One PDF padded to maxFileBytes + 1. Generated at runtime so Git does not store an 8 MiB blob.',
      expectedPackFailureCode: 'OVERSIZED',
      files: [
        pdfFile(
          'doc-oversized-file',
          'oversized-contract.pdf',
          padBytesToSize(
            textPdf('oversized file limit test', [banner('pack-oversized-file')]),
            INTAKE_PACK_LIMITS.maxFileBytes + 1,
          ),
          {
            materialization: 'generated',
            expectedPageCount: 1,
            expectedStatus: 'OVERSIZED',
            expectedFailureCode: 'OVERSIZED',
          },
        ),
        noteFile(
          'note-oversized-file',
          'broker-note.txt',
          noteText('pack-oversized-file', [
            `This pack includes one PDF of ${INTAKE_PACK_LIMITS.maxFileBytes + 1} bytes.`,
            'Expected document status: OVERSIZED.',
          ]),
        ),
      ],
    },
    {
      packId: 'pack-file-count',
      ticketScenario: 'oversized-limit-test',
      title: 'Eight PDFs exceed maxDocuments',
      description: `Eight tiny PDFs. INTAKE_PACK_LIMITS.maxDocuments is ${INTAKE_PACK_LIMITS.maxDocuments}. Expected PACK_FILE_COUNT.`,
      expectedPackFailureCode: 'PACK_FILE_COUNT',
      files: [
        ...Array.from({ length: INTAKE_PACK_LIMITS.maxDocuments + 1 }, (_, index) => {
          const n = String(index + 1).padStart(2, '0');
          return pdfFile(
            `doc-file-count-${n}`,
            `synthetic-doc-${n}.pdf`,
            textPdf(`file-count document ${n}`, [
              [
                ...banner('pack-file-count'),
                `Document ${n} of ${INTAKE_PACK_LIMITS.maxDocuments + 1}`,
              ],
            ]),
            { expectedPageCount: 1 },
          );
        }),
        noteFile(
          'note-file-count',
          'broker-note.txt',
          noteText('pack-file-count', [
            `This pack contains ${INTAKE_PACK_LIMITS.maxDocuments + 1} PDFs to exceed maxDocuments.`,
            'Expected pack failure: PACK_FILE_COUNT.',
          ]),
        ),
      ],
    },
    {
      packId: 'pack-total-size',
      ticketScenario: 'oversized-limit-test',
      title: 'Four PDFs just over 24 MiB combined',
      description:
        'Four PDFs each just over one quarter of maxPackBytes. Generated at runtime; not committed.',
      expectedPackFailureCode: 'PACK_TOTAL_SIZE',
      files: [
        ...Array.from({ length: 4 }, (_, index) => {
          const n = String(index + 1).padStart(2, '0');
          return pdfFile(
            `doc-pack-total-size-${n}`,
            `padded-contract-${n}.pdf`,
            padBytesToSize(
              textPdf(`pack total size document ${n}`, [
                [...banner('pack-total-size'), `Padded document ${n}`],
              ]),
              packTotalSizeEach,
            ),
            {
              materialization: 'generated',
              expectedPageCount: 1,
              expectedStatus: 'EXTRACTED',
            },
          );
        }),
        noteFile(
          'note-pack-total-size',
          'broker-note.txt',
          noteText('pack-total-size', [
            `Four PDFs of ${packTotalSizeEach} bytes each exceed maxPackBytes ${INTAKE_PACK_LIMITS.maxPackBytes}.`,
            'Expected pack failure: PACK_TOTAL_SIZE.',
          ]),
        ),
      ],
    },
    {
      packId: 'pack-page-limit',
      ticketScenario: 'oversized-limit-test',
      title: 'Fifty-one pages across three PDFs',
      description:
        'Three 17-page PDFs = 51 pages, over maxPagesPerPack 50, each under maxPagesPerDocument 25.',
      expectedPackFailureCode: 'PAGE_LIMIT',
      files: [
        ...['a', 'b', 'c'].map((suffix) =>
          pdfFile(
            `doc-page-limit-${suffix}`,
            `multi-page-${suffix}.pdf`,
            textPdf(
              `pack page-limit document ${suffix}`,
              numberedPages('pack-page-limit', `Document ${suffix}`, 17),
            ),
            { expectedPageCount: 17 },
          ),
        ),
        noteFile(
          'note-page-limit',
          'broker-note.txt',
          noteText('pack-page-limit', [
            'Three 17-page PDFs provide 51 pages.',
            'Expected pack failure: PAGE_LIMIT.',
          ]),
        ),
      ],
    },
    {
      packId: 'pack-document-page-limit',
      ticketScenario: 'oversized-limit-test',
      title: 'Twenty-six pages in one PDF',
      description: 'One PDF with 26 pages, over maxPagesPerDocument 25. Expected PAGE_LIMIT.',
      expectedPackFailureCode: 'PAGE_LIMIT',
      files: [
        pdfFile(
          'doc-document-page-limit',
          'too-many-pages.pdf',
          textPdf(
            'document page-limit',
            numberedPages('pack-document-page-limit', 'Single document', 26),
          ),
          { expectedPageCount: 26 },
        ),
        noteFile(
          'note-document-page-limit',
          'broker-note.txt',
          noteText('pack-document-page-limit', [
            'This PDF has 26 pages, one over maxPagesPerDocument.',
            'Expected pack failure: PAGE_LIMIT.',
          ]),
        ),
      ],
    },
    {
      packId: 'pack-notes-limit',
      ticketScenario: 'oversized-limit-test',
      title: 'Two broker notes',
      description: 'The contract allows one note per pack. Two note files expect NOTES_LIMIT.',
      expectedPackFailureCode: 'NOTES_LIMIT',
      files: [
        pdfFile(
          'doc-notes-limit',
          'placeholder-contract.pdf',
          textPdf('notes-limit placeholder', [banner('pack-notes-limit')]),
          { expectedPageCount: 1 },
        ),
        noteFile(
          'note-notes-limit-1',
          'broker-note-1.txt',
          noteText('pack-notes-limit', ['First synthetic broker note.']),
        ),
        noteFile(
          'note-notes-limit-2',
          'broker-note-2.txt',
          noteText('pack-notes-limit', ['Second synthetic broker note. This exceeds maxNotes.']),
        ),
      ],
    },
    {
      packId: 'pack-extracted-text-limit',
      ticketScenario: 'oversized-limit-test',
      title: 'Page text just over 8000 characters',
      description:
        'One selectable-text page with 8001 characters. Expected EXTRACTED_TEXT_LIMIT after extraction.',
      expectedPackFailureCode: 'EXTRACTED_TEXT_LIMIT',
      files: [
        pdfFile(
          'doc-extracted-text-limit',
          'dense-page.pdf',
          textPdf('extracted text page limit', [[PAGE_LIMIT_SELECTABLE_CHARS]]),
          { expectedPageCount: 1 },
        ),
        noteFile(
          'note-extracted-text-limit',
          'broker-note.txt',
          noteText('pack-extracted-text-limit', [
            'Page 1 is a single selectable-text string of 8001 characters.',
            'Expected pack failure once extracted: EXTRACTED_TEXT_LIMIT.',
          ]),
        ),
      ],
    },
  ];
}

function toFixtureFile(spec: FileSpec): IntakePackFixtureFile {
  const file: IntakePackFixtureFile = {
    path: spec.fileName,
    fileName: spec.fileName,
    contentType: spec.contentType,
    kind: spec.kind,
    materialization: spec.materialization,
    expectedByteSize: spec.bytes.length,
  };
  if (spec.documentId) file.documentId = spec.documentId;
  if (spec.noteId) file.noteId = spec.noteId;
  if (spec.expectedPageCount !== undefined) file.expectedPageCount = spec.expectedPageCount;
  if (spec.expectedSelectableText !== undefined) {
    file.expectedSelectableText = spec.expectedSelectableText;
  }
  if (spec.expectedStatus) file.expectedStatus = spec.expectedStatus;
  if (spec.expectedFailureCode) file.expectedFailureCode = spec.expectedFailureCode;
  if (spec.materialization === 'committed') {
    file.sha256 = sha256(spec.bytes);
  }
  return file;
}

function toFixturePack(spec: PackSpec): IntakePackFixturePack {
  const notes = spec.files.filter((file) => file.kind === 'NOTE');
  return {
    packId: spec.packId,
    ticketScenario: spec.ticketScenario,
    title: spec.title,
    description: spec.description,
    synthetic: true,
    directory: spec.packId,
    expectedNoteCount: notes.length,
    ...(spec.expectedPackFailureCode
      ? { expectedPackFailureCode: spec.expectedPackFailureCode }
      : {}),
    files: spec.files.map(toFixtureFile),
    expectedSites: spec.expectedSites ?? [],
    expectedFacts: spec.expectedFacts ?? [],
  };
}

export function buildIntakePackFixtureCatalog(): {
  specs: PackSpec[];
  manifest: IntakePackFixtureManifest;
} {
  const specs = buildPackSpecs();
  const manifest = IntakePackFixtureManifestSchema.parse({
    schemaVersion: 1,
    synthetic: true,
    disclaimer: INTAKE_PACK_FIXTURE_DISCLAIMER,
    generatedBy: 'scripts/generate-intake-pack-fixtures.ts',
    limits: {
      maxDocuments: INTAKE_PACK_LIMITS.maxDocuments,
      maxNotes: INTAKE_PACK_LIMITS.maxNotes,
      maxFileBytes: INTAKE_PACK_LIMITS.maxFileBytes,
      maxPackBytes: INTAKE_PACK_LIMITS.maxPackBytes,
      maxPagesPerDocument: INTAKE_PACK_LIMITS.maxPagesPerDocument,
      maxPagesPerPack: INTAKE_PACK_LIMITS.maxPagesPerPack,
      maxExtractedCharsPerPage: INTAKE_PACK_LIMITS.maxExtractedCharsPerPage,
      maxExtractedCharsPerDocument: INTAKE_PACK_LIMITS.maxExtractedCharsPerDocument,
      maxExtractedCharsPerPack: INTAKE_PACK_LIMITS.maxExtractedCharsPerPack,
      maxNoteChars: INTAKE_PACK_LIMITS.maxNoteChars,
      allowedContentTypes: INTAKE_PACK_LIMITS.allowedContentTypes,
      allowedFilenameExtensions: INTAKE_PACK_LIMITS.allowedFilenameExtensions,
    },
    packs: specs.map(toFixturePack),
  });
  return { specs, manifest };
}

export function intakePackFixtureRelPath(
  packDirectory: string,
  file: Pick<IntakePackFixtureFile, 'path' | 'materialization'>,
): string {
  const root = file.materialization === 'generated' ? '.generated' : 'packs';
  return join(root, packDirectory, file.path);
}

export function listIntakePackFixtureFiles(includeGenerated: boolean): FixtureFileBytes[] {
  const { specs } = buildIntakePackFixtureCatalog();
  const files: FixtureFileBytes[] = [];
  for (const spec of specs) {
    for (const file of spec.files) {
      if (!includeGenerated && file.materialization === 'generated') continue;
      files.push({
        relativePath: intakePackFixtureRelPath(spec.packId, {
          path: file.fileName,
          materialization: file.materialization,
        }),
        bytes: file.bytes,
      });
    }
  }
  return files;
}

export async function writeIntakePackFixtures(options: {
  root?: string;
  includeGenerated?: boolean;
}): Promise<{ manifestPath: string; written: string[] }> {
  const root = options.root ?? INTAKE_PACK_FIXTURES_ROOT;
  const includeGenerated = options.includeGenerated ?? false;
  const { manifest } = buildIntakePackFixtureCatalog();
  const written: string[] = [];

  for (const file of listIntakePackFixtureFiles(includeGenerated)) {
    const destination = join(root, file.relativePath);
    await mkdir(dirname(destination), { recursive: true });
    await writeFile(destination, file.bytes);
    written.push(destination);
  }

  const manifestPath = join(root, 'manifest.json');
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  written.push(manifestPath);
  return { manifestPath, written };
}
