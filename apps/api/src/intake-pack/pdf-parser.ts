import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { getDocument, OPS } from 'pdfjs-dist/legacy/build/pdf.mjs';
import { hasPdfMagic } from '../../../../packages/domain/src/index.js';
import type {
  ParsedIntakeDocument,
  ParsedIntakePage,
} from '../../../../packages/domain/src/index.js';

const require = createRequire(import.meta.url);
const pdfjsDirectory = dirname(require.resolve('pdfjs-dist/package.json'));
const standardFontDataUrl = `${pathToFileURL(join(pdfjsDirectory, 'standard_fonts')).href}/`;

const STREAM_FAILURE = /invalid stream|formaterror|flate|unknown compression|zlib/i;

export type PdfParseSuccess = Extract<ParsedIntakeDocument, { outcome: 'EXTRACTED' }>;
export type PdfParseFailure = Extract<
  ParsedIntakeDocument,
  { outcome: 'OCR_REQUIRED' | 'CORRUPT' | 'EXTRACTION_FAILED' }
>;

export async function parseSelectablePdf(input: {
  documentId: string;
  bytes: Uint8Array;
}): Promise<ParsedIntakeDocument> {
  if (!hasPdfMagic(input.bytes)) {
    return {
      documentId: input.documentId,
      outcome: 'CORRUPT',
      message: 'The file is not a parseable PDF.',
      pageCount: 0,
    };
  }

  let pdf;
  try {
    pdf = await getDocument({
      data: Uint8Array.from(input.bytes),
      useSystemFonts: true,
      stopAtErrors: true,
      standardFontDataUrl,
    }).promise;
  } catch (error) {
    return {
      documentId: input.documentId,
      outcome: 'CORRUPT',
      message: parseErrorMessage(
        error,
        'The PDF could not be opened because its structure is invalid or truncated.',
      ),
      pageCount: 0,
    };
  }

  const pages: ParsedIntakePage[] = [];
  const streamFailures: string[] = [];

  for (let pageNumber = 1; pageNumber <= pdf.numPages; pageNumber += 1) {
    try {
      const page = await pdf.getPage(pageNumber);
      const { text, operatorCount, warnings } = await extractPageText(page);
      const streamWarning = warnings.find((warning) => STREAM_FAILURE.test(warning));
      if (streamWarning || (operatorCount === 0 && text.length === 0)) {
        streamFailures.push(streamWarning ?? 'Page content stream produced no operators.');
      }
      pages.push({
        pageNumber,
        text,
        selectableText: text.trim().length > 0,
      });
    } catch (error) {
      return {
        documentId: input.documentId,
        outcome: 'EXTRACTION_FAILED',
        message: parseErrorMessage(error, 'Selectable-text extraction failed for this PDF.'),
        pageCount: pdf.numPages,
      };
    }
  }

  if (streamFailures.length > 0 && pages.every((page) => !page.selectableText)) {
    return {
      documentId: input.documentId,
      outcome: 'EXTRACTION_FAILED',
      message: `PDF content streams could not be decoded (${streamFailures[0]}).`,
      pageCount: pdf.numPages,
    };
  }

  if (pages.length === 0 || pages.every((page) => !page.selectableText)) {
    return {
      documentId: input.documentId,
      outcome: 'OCR_REQUIRED',
      message: 'No selectable text was found. OCR is out of scope for Intake pack.',
      pageCount: pdf.numPages,
    };
  }

  return {
    documentId: input.documentId,
    outcome: 'EXTRACTED',
    pages,
  };
}

async function extractPageText(page: {
  getOperatorList: () => Promise<{ fnArray: number[]; argsArray: unknown[] }>;
}): Promise<{ text: string; operatorCount: number; warnings: string[] }> {
  const { value, warnings } = await withCapturedWarnings(() => page.getOperatorList());
  const lines: string[] = [];
  let current = '';

  const flush = (): void => {
    if (current.length > 0) lines.push(current);
    current = '';
  };

  for (let index = 0; index < value.fnArray.length; index += 1) {
    const fn = value.fnArray[index]!;
    const args = value.argsArray[index];
    if (fn === OPS.showText || fn === OPS.showSpacedText) {
      current += glyphsToText(Array.isArray(args) ? args[0] : args);
    } else if (fn === OPS.nextLineShowText) {
      flush();
      current += glyphsToText(Array.isArray(args) ? args[0] : args);
    } else if (fn === OPS.nextLine) {
      flush();
    }
  }
  flush();

  return {
    text: lines.join('\n'),
    operatorCount: value.fnArray.length,
    warnings,
  };
}

function glyphsToText(glyphs: unknown): string {
  if (typeof glyphs === 'string') return glyphs;
  if (!Array.isArray(glyphs)) return '';
  let text = '';
  for (const glyph of glyphs) {
    if (typeof glyph === 'string') {
      text += glyph;
      continue;
    }
    if (typeof glyph === 'number') {
      if (glyph < -100) text += ' ';
      continue;
    }
    if (glyph && typeof glyph === 'object' && 'unicode' in glyph) {
      const unicode = (glyph as { unicode?: unknown }).unicode;
      if (typeof unicode === 'string') text += unicode;
    }
  }
  return text;
}

async function withCapturedWarnings<T>(
  work: () => Promise<T>,
): Promise<{ value: T; warnings: string[] }> {
  const warnings: string[] = [];
  const original = console.warn;
  console.warn = (...args: unknown[]) => {
    warnings.push(args.map(String).join(' '));
  };
  try {
    const value = await work();
    return { value, warnings };
  } finally {
    console.warn = original;
  }
}

function parseErrorMessage(error: unknown, fallback: string): string {
  if (error instanceof Error && error.message.trim()) {
    return error.message.slice(0, 1_000);
  }
  return fallback;
}
