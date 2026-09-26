import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { IntakeRequestSchema } from './contracts.js';
import { IdempotencyConflictError, TenderProcessingError, TenderService } from './service.js';

const CorrelationIdSchema = z.string().regex(/^[\x21-\x7e]{1,128}$/);
const MAX_BODY_BYTES = 1_048_576;

export function createTenderServer(service: TenderService): Server {
  return createServer((request, response) => {
    void handleRequest(request, response, service);
  });
}

async function handleRequest(
  request: IncomingMessage,
  response: ServerResponse,
  service: TenderService,
): Promise<void> {
  const correlationIdResult = parseCorrelationId(request.headers['x-correlation-id']);
  const correlationId = correlationIdResult.success ? correlationIdResult.data : randomUUID();
  response.setHeader('X-Correlation-ID', correlationId);

  if (request.method !== 'POST' || request.url !== '/tenders') {
    sendJson(response, 404, { error: 'NOT_FOUND', correlationId });
    return;
  }

  if (!correlationIdResult.success) {
    sendJson(response, 400, { error: 'INVALID_CORRELATION_ID', correlationId });
    return;
  }

  if (
    request.headers['content-type']?.split(';', 1)[0]?.trim().toLowerCase() !== 'application/json'
  ) {
    sendJson(response, 415, { error: 'CONTENT_TYPE_MUST_BE_JSON', correlationId });
    return;
  }

  let body: unknown;
  try {
    body = await readJsonBody(request);
  } catch (error) {
    if (error instanceof BodyTooLargeError) {
      sendJson(response, 413, { error: 'REQUEST_BODY_TOO_LARGE', correlationId });
      return;
    }
    sendJson(response, 400, { error: 'INVALID_JSON', correlationId });
    return;
  }

  const validation = IntakeRequestSchema.safeParse(body);
  if (!validation.success) {
    sendJson(response, 400, {
      error: 'INVALID_TENDER',
      correlationId,
      issues: validation.error.issues.map((issue) => ({
        path: issue.path.map(String).join('.'),
        message: issue.message,
      })),
    });
    return;
  }

  try {
    const result = await service.submit(validation.data, correlationId);
    sendJson(response, result.status === 'PROCESSING' ? 202 : 200, result);
    console.info(
      JSON.stringify({
        event: 'tender.processed',
        tenderId: result.tenderId,
        runId: result.runId,
        correlationId: result.correlationId,
        status: result.status,
        route: result.route,
        replayed: result.replayed,
      }),
    );
  } catch (error) {
    if (error instanceof IdempotencyConflictError) {
      sendJson(response, 409, { error: 'IDEMPOTENCY_KEY_CONFLICT', correlationId });
      return;
    }
    if (error instanceof TenderProcessingError) {
      sendJson(response, error.httpStatus, error.response);
      console.error(
        JSON.stringify({
          event: 'tender.processing_failed',
          tenderId: error.response.tenderId,
          runId: error.response.runId,
          correlationId,
          status: error.response.status,
          failure: error.response.failure?.code,
        }),
      );
      return;
    }
    console.error(JSON.stringify({ event: 'tender.intake_failed', correlationId }));
    sendJson(response, 500, { error: 'TENDER_PROCESSING_FAILED', correlationId });
  }
}

function parseCorrelationId(value: string | string[] | undefined) {
  return CorrelationIdSchema.safeParse(value === undefined ? randomUUID() : value);
}

async function readJsonBody(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    bytes += buffer.byteLength;
    if (bytes > MAX_BODY_BYTES) throw new BodyTooLargeError();
    chunks.push(buffer);
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
}

function sendJson(response: ServerResponse, statusCode: number, body: unknown): void {
  response.statusCode = statusCode;
  response.setHeader('Content-Type', 'application/json; charset=utf-8');
  response.end(`${JSON.stringify(body)}\n`);
}

class BodyTooLargeError extends Error {}
