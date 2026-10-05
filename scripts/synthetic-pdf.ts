/**
 * Minimal deterministic PDF 1.4 writer for synthetic Intake pack fixtures.
 * This is not the ENG-19 extractor. It only emits inspectable demonstration bytes.
 */

const SYNTHETIC_PRODUCER = 'tem-tender-readiness-engine ENG-18 SYNTHETIC / DEMONSTRATION';

export type PdfPage =
  { type: 'text'; lines: string[] } | { type: 'image-only' } | { type: 'invalid-flate' };

function escapePdfString(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/\(/g, '\\(').replace(/\)/g, '\\)');
}

function latin1(value: string): Buffer {
  return Buffer.from(value, 'latin1');
}

function buildTextStream(lines: string[]): Buffer {
  const operations = ['BT', '/F1 11 Tf', '50 760 Td', '13 TL'];
  for (const line of lines) {
    operations.push(`(${escapePdfString(line)}) Tj`);
    operations.push('T*');
  }
  operations.push('ET');
  return latin1(operations.join('\n'));
}

function buildImageOnlyStream(): Buffer {
  // 8x8 1-bit image, ASCIIHex. No text operators — ENG-19 should treat this as OCR_REQUIRED.
  return latin1(
    [
      'q',
      '120 0 0 40 72 680 cm',
      'BI',
      '/W 8',
      '/H 8',
      '/BPC 1',
      '/CS /G',
      '/F /AHx',
      'ID',
      'FF00FF00FF00FF00>',
      'EI',
      'Q',
    ].join('\n'),
  );
}

function buildInvalidFlateStream(): Buffer {
  return latin1('not-deflated');
}

function objectBuffer(id: number, body: Buffer): Buffer {
  return Buffer.concat([latin1(`${id} 0 obj\n`), body, latin1('\nendobj\n')]);
}

function streamObject(id: number, stream: Buffer, extraDict = ''): Buffer {
  const dict = latin1(`<<${extraDict} /Length ${stream.length} >>\nstream\n`);
  return objectBuffer(id, Buffer.concat([dict, stream, latin1('\nendstream')]));
}

function xrefEntry(offset: number, inUse: boolean): string {
  const flag = inUse ? 'n' : 'f';
  const generation = inUse ? '00000' : '65535';
  return `${offset.toString(10).padStart(10, '0')} ${generation} ${flag} \n`;
}

export function buildSyntheticPdf(input: { title: string; pages: PdfPage[] }): Buffer {
  if (input.pages.length < 1) {
    throw new Error('A synthetic PDF must contain at least one page.');
  }

  const fontId = 3;
  const pageIds = input.pages.map((_, index) => 4 + index * 2);
  const contentIds = input.pages.map((_, index) => 5 + index * 2);
  const infoId = 4 + input.pages.length * 2;

  const catalog = objectBuffer(1, latin1('<< /Type /Catalog /Pages 2 0 R >>'));
  const kids = pageIds.map((id) => `${id} 0 R`).join(' ');
  const pages = objectBuffer(
    2,
    latin1(`<< /Type /Pages /Kids [${kids}] /Count ${input.pages.length} >>`),
  );
  const font = objectBuffer(
    fontId,
    latin1('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>'),
  );

  const pageObjects = input.pages.flatMap((page, index) => {
    const pageId = pageIds[index]!;
    const contentId = contentIds[index]!;
    const resources =
      page.type === 'text'
        ? ` /Resources << /Font << /F1 ${fontId} 0 R >> >>`
        : ' /Resources << >>';
    const pageDict = objectBuffer(
      pageId,
      latin1(
        `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792]${resources} /Contents ${contentId} 0 R >>`,
      ),
    );
    if (page.type === 'text') {
      return [pageDict, streamObject(contentId, buildTextStream(page.lines))];
    }
    if (page.type === 'image-only') {
      return [pageDict, streamObject(contentId, buildImageOnlyStream())];
    }
    return [pageDict, streamObject(contentId, buildInvalidFlateStream(), ' /Filter /FlateDecode')];
  });

  const info = objectBuffer(
    infoId,
    latin1(
      `<< /Title (${escapePdfString(`SYNTHETIC / DEMONSTRATION - ${input.title}`)}) /Producer (${escapePdfString(SYNTHETIC_PRODUCER)}) /Subject (${escapePdfString('Synthetic demonstration fixture. Not a real tender.')}) >>`,
    ),
  );

  const header = latin1('%PDF-1.4\n%\x80\x80\x80\x80\n% SYNTHETIC / DEMONSTRATION\n');
  const objects = [catalog, pages, font, ...pageObjects, info];
  const offsets = [0];
  let cursor = header.length;
  for (const object of objects) {
    offsets.push(cursor);
    cursor += object.length;
  }

  const xrefOffset = cursor;
  const xref = latin1(
    `xref\n0 ${objects.length + 1}\n${xrefEntry(0, false)}${offsets
      .slice(1)
      .map((offset) => xrefEntry(offset, true))
      .join('')}`,
  );
  const trailer = latin1(
    `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R /Info ${infoId} 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`,
  );

  return Buffer.concat([header, ...objects, xref, trailer]);
}

export function buildCorruptPdf(): Buffer {
  return latin1(
    '%PDF-1.4\n% SYNTHETIC / DEMONSTRATION - deliberately truncated corrupt fixture\n1 0 obj\n<< /Type /Catalog /Pages 2 0 R\n',
  );
}

export function padBytesToSize(bytes: Buffer, size: number): Buffer {
  if (bytes.length > size) {
    throw new Error(`Cannot pad ${bytes.length} bytes down to ${size}.`);
  }
  if (bytes.length === size) {
    return bytes;
  }
  const marker = latin1('\n% SYNTHETIC / DEMONSTRATION PADDING\n');
  const padding = Buffer.alloc(size - bytes.length);
  for (let offset = 0; offset < padding.length; offset += marker.length) {
    marker.copy(padding, offset, 0, Math.min(marker.length, padding.length - offset));
  }
  return Buffer.concat([bytes, padding]);
}

/** Test helper only: collect literal PDF strings. Not a document extractor. */
export function collectPdfLiteralStrings(bytes: Buffer): string[] {
  const source = bytes.toString('latin1');
  const literals: string[] = [];
  const pattern = /\((?:\\.|[^\\)])*\)/g;
  for (const match of source.matchAll(pattern)) {
    literals.push(
      match[0]
        .slice(1, -1)
        .replace(/\\n/g, '\n')
        .replace(/\\r/g, '\r')
        .replace(/\\t/g, '\t')
        .replace(/\\\(/g, '(')
        .replace(/\\\)/g, ')')
        .replace(/\\\\/g, '\\'),
    );
  }
  return literals;
}

export function pdfSelectableText(bytes: Buffer): string {
  return collectPdfLiteralStrings(bytes).join('\n');
}

export function pdfHasShowTextOperator(bytes: Buffer): boolean {
  return /(?<![A-Za-z])Tj(?![A-Za-z])/.test(bytes.toString('latin1'));
}
