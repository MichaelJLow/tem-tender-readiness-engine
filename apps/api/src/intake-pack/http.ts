import type { IncomingMessage, ServerResponse } from 'node:http';
import { INTAKE_PACK_LIMITS } from '../../../../packages/domain/src/index.js';
import {
  ConfirmIntakePackRequestSchema,
  ConfirmIntakePackResponseSchema,
  CreateIntakePackRequestSchema,
  PatchIntakeDraftRequestSchema,
  PutIntakeNotesRequestSchema,
  TriggerIntakeExtractionRequestSchema,
} from '../intake-pack-contracts.js';
import {
  IntakeConfirmationNotFoundError,
  IntakeDocumentNotFoundError,
  IntakeDraftNotFoundError,
  IntakeExtractionNotFoundError,
  IntakePackConflictError,
  IntakePackNotFoundError,
  IntakePackService,
} from './service.js';
import { sanitizeIntakeFileName } from '../../../../packages/domain/src/index.js';

const JSON_BODY_MAX = 1_048_576;
const DOCUMENT_BODY_MAX = INTAKE_PACK_LIMITS.maxFileBytes + 1;

export async function tryHandleIntakePackRequest(input: {
  request: IncomingMessage;
  response: ServerResponse;
  service: IntakePackService | undefined;
  correlationId: string;
}): Promise<boolean> {
  const path = input.request.url?.split('?')[0] ?? '';
  if (!path.startsWith('/intake-packs')) return false;

  if (!input.service) {
    sendJson(input.response, 404, { error: 'NOT_FOUND', correlationId: input.correlationId });
    return true;
  }

  try {
    if (input.request.method === 'POST' && path === '/intake-packs') {
      const body = await readOptionalJson(input.request);
      const parsed = CreateIntakePackRequestSchema.safeParse(body ?? { synthetic: true });
      if (!parsed.success) {
        sendJson(input.response, 400, {
          error: 'INVALID_INTAKE_PACK',
          correlationId: input.correlationId,
        });
        return true;
      }
      const pack = await input.service.createPack();
      sendJson(input.response, 201, pack);
      return true;
    }

    const packMatch = path.match(/^\/intake-packs\/([^/]+)$/);
    if (input.request.method === 'GET' && packMatch?.[1]) {
      sendJson(input.response, 200, await input.service.getPack(decodeURIComponent(packMatch[1])));
      return true;
    }

    const documentsMatch = path.match(/^\/intake-packs\/([^/]+)\/documents$/);
    if (documentsMatch?.[1]) {
      const packId = decodeURIComponent(documentsMatch[1]);
      if (input.request.method === 'GET') {
        const pack = await input.service.getPack(packId);
        sendJson(input.response, 200, { packId: pack.packId, documents: pack.documents });
        return true;
      }
      if (input.request.method === 'POST') {
        const fileName = sanitizeIntakeFileName(headerValue(input.request.headers['x-file-name']));
        if (!fileName) {
          sendJson(input.response, 400, {
            error: 'INVALID_INTAKE_DOCUMENT',
            correlationId: input.correlationId,
            message: 'X-File-Name is required.',
          });
          return true;
        }
        const contentType =
          input.request.headers['content-type']?.split(';', 1)[0]?.trim() ??
          'application/octet-stream';
        const bytes = await readRawBody(input.request, DOCUMENT_BODY_MAX);
        const result = await input.service.addDocument({
          packId,
          fileName,
          contentType,
          bytes,
        });
        sendJson(input.response, 201, result.document);
        return true;
      }
    }

    const documentMatch = path.match(/^\/intake-packs\/([^/]+)\/documents\/([^/]+)$/);
    if (input.request.method === 'GET' && documentMatch?.[1] && documentMatch[2]) {
      sendJson(
        input.response,
        200,
        await input.service.getDocument(
          decodeURIComponent(documentMatch[1]),
          decodeURIComponent(documentMatch[2]),
        ),
      );
      return true;
    }

    const notesMatch = path.match(/^\/intake-packs\/([^/]+)\/notes$/);
    if (notesMatch?.[1]) {
      const packId = decodeURIComponent(notesMatch[1]);
      if (input.request.method === 'GET') {
        const pack = await input.service.getPack(packId);
        sendJson(input.response, 200, { packId: pack.packId, notes: pack.notes });
        return true;
      }
      if (input.request.method === 'PUT') {
        const parsed = PutIntakeNotesRequestSchema.safeParse(await readJsonBody(input.request));
        if (!parsed.success) {
          sendJson(input.response, 400, {
            error: 'INVALID_INTAKE_NOTE',
            correlationId: input.correlationId,
          });
          return true;
        }
        const result = await input.service.putNote({ packId, text: parsed.data.text });
        sendJson(input.response, 200, { packId: result.pack.packId, notes: result.notes });
        return true;
      }
    }

    const extractionsMatch = path.match(/^\/intake-packs\/([^/]+)\/extractions$/);
    if (extractionsMatch?.[1]) {
      const packId = decodeURIComponent(extractionsMatch[1]);
      if (input.request.method === 'GET') {
        sendJson(input.response, 200, await input.service.getExtraction(packId));
        return true;
      }
      if (input.request.method === 'POST') {
        const body = await readOptionalJson(input.request);
        const parsed = TriggerIntakeExtractionRequestSchema.safeParse(body ?? {});
        if (!parsed.success) {
          sendJson(input.response, 400, {
            error: 'INVALID_INTAKE_EXTRACTION',
            correlationId: input.correlationId,
          });
          return true;
        }
        const result = await input.service.extract(packId);
        sendJson(input.response, 200, result.extraction);
        return true;
      }
    }

    const draftMatch = path.match(/^\/intake-packs\/([^/]+)\/draft$/);
    if (draftMatch?.[1]) {
      const packId = decodeURIComponent(draftMatch[1]);
      if (input.request.method === 'GET') {
        sendJson(input.response, 200, await input.service.getDraft(packId));
        return true;
      }
      if (input.request.method === 'PATCH') {
        const parsed = PatchIntakeDraftRequestSchema.safeParse(await readJsonBody(input.request));
        if (!parsed.success) {
          sendJson(input.response, 400, {
            error: 'INVALID_INTAKE_DRAFT',
            correlationId: input.correlationId,
          });
          return true;
        }
        sendJson(input.response, 200, await input.service.patchDraft(packId, parsed.data));
        return true;
      }
    }

    const confirmMatch = path.match(/^\/intake-packs\/([^/]+)\/confirm$/);
    if (input.request.method === 'POST' && confirmMatch?.[1]) {
      const parsed = ConfirmIntakePackRequestSchema.safeParse(await readJsonBody(input.request));
      if (!parsed.success) {
        sendJson(input.response, 400, {
          error: 'INVALID_INTAKE_CONFIRMATION',
          correlationId: input.correlationId,
        });
        return true;
      }
      const result = await input.service.confirm({
        packId: decodeURIComponent(confirmMatch[1]),
        expectedDraftVersion: parsed.data.expectedDraftVersion,
        idempotencyKey: parsed.data.idempotencyKey,
        correlationId: input.correlationId,
      });
      sendJson(
        input.response,
        200,
        ConfirmIntakePackResponseSchema.parse({
          packId: result.pack.packId,
          confirmation: result.confirmation,
          tenderId: result.confirmation.tenderId,
          runId: result.confirmation.runId,
        }),
      );
      return true;
    }

    const confirmationMatch = path.match(/^\/intake-packs\/([^/]+)\/confirmation$/);
    if (input.request.method === 'GET' && confirmationMatch?.[1]) {
      sendJson(
        input.response,
        200,
        await input.service.getConfirmation(decodeURIComponent(confirmationMatch[1])),
      );
      return true;
    }
  } catch (error) {
    if (error instanceof BodyTooLargeError) {
      sendJson(input.response, 413, {
        error: 'OVERSIZED',
        correlationId: input.correlationId,
      });
      return true;
    }
    if (error instanceof IntakePackNotFoundError) {
      sendJson(input.response, 404, {
        error: 'INTAKE_PACK_NOT_FOUND',
        correlationId: input.correlationId,
      });
      return true;
    }
    if (error instanceof IntakeDocumentNotFoundError) {
      sendJson(input.response, 404, {
        error: 'INTAKE_DOCUMENT_NOT_FOUND',
        correlationId: input.correlationId,
      });
      return true;
    }
    if (error instanceof IntakeExtractionNotFoundError) {
      sendJson(input.response, 404, {
        error: 'INTAKE_EXTRACTION_NOT_FOUND',
        correlationId: input.correlationId,
      });
      return true;
    }
    if (error instanceof IntakeDraftNotFoundError) {
      sendJson(input.response, 404, {
        error: 'INTAKE_DRAFT_NOT_FOUND',
        correlationId: input.correlationId,
      });
      return true;
    }
    if (error instanceof IntakeConfirmationNotFoundError) {
      sendJson(input.response, 404, {
        error: 'INTAKE_CONFIRMATION_NOT_FOUND',
        correlationId: input.correlationId,
      });
      return true;
    }
    if (error instanceof IntakePackConflictError) {
      sendJson(input.response, 409, {
        error: error.failure.code,
        correlationId: input.correlationId,
        failure: error.failure,
        pack: error.pack,
      });
      return true;
    }
    if (error instanceof SyntaxError) {
      sendJson(input.response, 400, {
        error: 'INVALID_JSON',
        correlationId: input.correlationId,
      });
      return true;
    }
    throw error;
  }

  sendJson(input.response, 404, { error: 'NOT_FOUND', correlationId: input.correlationId });
  return true;
}

function headerValue(value: string | string[] | undefined): string {
  if (Array.isArray(value)) return value[0] ?? '';
  return value ?? '';
}

async function readOptionalJson(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    bytes += buffer.byteLength;
    if (bytes > JSON_BODY_MAX) throw new BodyTooLargeError();
    chunks.push(buffer);
  }
  if (chunks.length === 0 || bytes === 0) return {};
  return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
}

async function readJsonBody(request: IncomingMessage): Promise<unknown> {
  return readOptionalJson(request);
}

async function readRawBody(request: IncomingMessage, maxBytes: number): Promise<Uint8Array> {
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    bytes += buffer.byteLength;
    if (bytes > maxBytes) throw new BodyTooLargeError();
    chunks.push(buffer);
  }
  return new Uint8Array(Buffer.concat(chunks));
}

function sendJson(response: ServerResponse, statusCode: number, body: unknown): void {
  response.statusCode = statusCode;
  response.setHeader('Content-Type', 'application/json; charset=utf-8');
  response.end(`${JSON.stringify(body)}\n`);
}

class BodyTooLargeError extends Error {}
