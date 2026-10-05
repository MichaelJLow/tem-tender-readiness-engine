import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { z } from 'zod';
import { IntakeRequestSchema, ReviewActionSchema, ReviewEventSchema } from './contracts.js';
import { readEvalOverview, readEvalReport } from './eval-reports.js';
import {
  InvalidReviewTransitionError,
  ReviewNotRequiredError,
  ReviewRequestConflictError,
  ReviewRunNotFoundError,
  StaleReviewVersionError,
} from './file-repository.js';
import {
  IdempotencyConflictError,
  StatePersistenceError,
  TenderProcessingError,
  TenderService,
} from './service.js';
import type { RunFailure } from './contracts.js';
import { tryHandleIntakePackRequest } from './intake-pack/http.js';
import type { IntakePackService } from './intake-pack/service.js';

const CorrelationIdSchema = z.string().regex(/^[\x21-\x7e]{1,128}$/);
const MAX_BODY_BYTES = 1_048_576;
const ReviewCommandSchema = z.object({
  requestId: z.string().trim().min(1).max(128),
  action: ReviewActionSchema,
  reason: z.string().trim().min(1).max(4000),
  sourceIds: z.array(z.string().trim().min(1).max(128)).max(32).default([]),
  expectedVersion: z.number().int().nonnegative(),
});

export function createTenderServer(
  service: TenderService,
  allowReviewMutations = false,
  intakePackService?: IntakePackService,
): Server {
  return createServer((request, response) => {
    void handleRequest(request, response, service, allowReviewMutations, intakePackService);
  });
}

async function handleRequest(
  request: IncomingMessage,
  response: ServerResponse,
  service: TenderService,
  allowReviewMutations: boolean,
  intakePackService?: IntakePackService,
): Promise<void> {
  const correlationIdResult = parseCorrelationId(request.headers['x-correlation-id']);
  const correlationId = correlationIdResult.success ? correlationIdResult.data : randomUUID();
  response.setHeader('X-Correlation-ID', correlationId);

  if (
    await tryHandleIntakePackRequest({
      request,
      response,
      service: intakePackService,
      correlationId,
    })
  ) {
    return;
  }

  if (request.method === 'GET' && request.url === '/tenders') {
    try {
      const runs = await service.listRuns();
      const items = await Promise.all(
        runs.map(async (run) => {
          const events = await service.getReviewEvents(run.runId);
          return {
            runId: run.runId,
            tenderId: run.tenderId,
            status: run.status,
            route: run.route ?? null,
            createdAt: run.createdAt,
            updatedAt: run.updatedAt,
            failure: run.failure ?? null,
            reviewVersion: events.length,
            reviewState: reviewState(events),
            lastReviewEvent: events.at(-1) ?? null,
          };
        }),
      );
      sendJson(response, 200, { items });
    } catch (error) {
      logStateBoundaryFailure(error, correlationId);
      sendJson(response, 500, { error: 'TENDER_LIST_UNAVAILABLE', correlationId });
    }
    return;
  }

  if (request.method === 'GET' && request.url === '/evals') {
    try {
      const overview = await readEvalOverview(resolve(process.env.EVALS_DIR ?? './evals'));
      sendJson(response, 200, overview);
    } catch {
      sendJson(response, 500, { error: 'EVAL_REPORTS_UNAVAILABLE', correlationId });
    }
    return;
  }

  const evalReportMatch = request.url?.match(/^\/evals\/reports\/([A-Za-z0-9._-]{1,128})$/);
  if (request.method === 'GET' && evalReportMatch?.[1]) {
    try {
      const report = await readEvalReport(
        evalReportMatch[1],
        resolve(process.env.EVALS_DIR ?? './evals'),
      );
      if (!report) {
        sendJson(response, 404, { error: 'EVAL_REPORT_NOT_FOUND', correlationId });
        return;
      }
      sendJson(response, 200, report);
    } catch {
      sendJson(response, 500, { error: 'EVAL_REPORT_UNAVAILABLE', correlationId });
    }
    return;
  }

  const detailMatch = request.url?.match(/^\/tenders\/([0-9a-f-]+)$/i);
  if (request.method === 'GET' && detailMatch?.[1]) {
    try {
      const run = await service.findRun(detailMatch[1]);
      if (!run) {
        sendJson(response, 404, { error: 'TENDER_RUN_NOT_FOUND', correlationId });
        return;
      }
      const reviewEvents = await service.getReviewEvents(run.runId);
      sendJson(response, 200, {
        run,
        reviewEvents,
        reviewState: reviewState(reviewEvents),
        reviewVersion: reviewEvents.length,
      });
    } catch (error) {
      logStateBoundaryFailure(error, correlationId);
      sendJson(response, 500, { error: 'TENDER_DETAIL_UNAVAILABLE', correlationId });
    }
    return;
  }

  const reviewMatch = request.url?.match(/^\/tenders\/([0-9a-f-]+)\/reviews$/i);
  if (request.method === 'POST' && reviewMatch?.[1]) {
    if (!allowReviewMutations) {
      sendJson(response, 403, { error: 'REVIEW_ACTIONS_LOOPBACK_ONLY', correlationId });
      return;
    }
    try {
      if (
        request.headers['content-type']?.split(';', 1)[0]?.trim().toLowerCase() !==
        'application/json'
      ) {
        sendJson(response, 415, { error: 'CONTENT_TYPE_MUST_BE_JSON', correlationId });
        return;
      }
      const body = ReviewCommandSchema.safeParse(await readJsonBody(request));
      if (!body.success) {
        sendJson(response, 400, {
          error: 'INVALID_REVIEW_ACTION',
          correlationId,
          issues: body.error.issues.map((issue) => ({
            path: issue.path.join('.'),
            message: issue.message,
          })),
        });
        return;
      }
      const currentRun = await service.findRun(reviewMatch[1]);
      if (!currentRun) {
        sendJson(response, 404, { error: 'TENDER_RUN_NOT_FOUND', correlationId });
        return;
      }
      const allowedSources = new Set([
        ...currentRun.input.textSources.map((source) => source.sourceId),
        ...currentRun.input.tender.documents.map((document) => document.documentId),
        ...(currentRun.result?.rules.flatMap((rule) =>
          rule.evidence.map((evidence) => evidence.sourceId),
        ) ?? []),
      ]);
      if (body.data.sourceIds.some((sourceId) => !allowedSources.has(sourceId))) {
        sendJson(response, 400, { error: 'UNKNOWN_REVIEW_EVIDENCE_SOURCE', correlationId });
        return;
      }
      const event = ReviewEventSchema.parse({
        eventId: randomUUID(),
        requestId: body.data.requestId,
        runId: reviewMatch[1],
        action: body.data.action,
        actor: process.env.REVIEW_ACTOR?.trim() || 'local-demo-operator',
        reason: body.data.reason,
        sourceIds: body.data.sourceIds,
        reviewVersion: body.data.expectedVersion + 1,
        createdAt: new Date().toISOString(),
      });
      const saved = await service.recordReviewEvent(event, body.data.expectedVersion);
      const latestEvents = await service.getReviewEvents(reviewMatch[1]);
      sendJson(response, 200, {
        event: saved,
        reviewVersion: latestEvents.length,
        reviewState: reviewState(latestEvents),
      });
    } catch (error) {
      const status =
        error instanceof ReviewRunNotFoundError
          ? 404
          : error instanceof ReviewNotRequiredError || error instanceof InvalidReviewTransitionError
            ? 409
            : error instanceof StaleReviewVersionError ||
                error instanceof ReviewRequestConflictError
              ? 409
              : 500;
      sendJson(response, status, {
        error: reviewErrorCode(error),
        correlationId,
      });
      if (error instanceof StatePersistenceError) {
        logOperationalFailure(error.failure, correlationId, error.tenderId, error.runId);
      }
    }
    return;
  }

  if (request.method !== 'POST' || request.url !== '/tenders') {
    sendJson(response, 404, { error: 'NOT_FOUND', correlationId });
    return;
  }

  if (!correlationIdResult.success) {
    logTransportFailure('INVALID_CORRELATION_ID', correlationId);
    sendJson(response, 400, { error: 'INVALID_CORRELATION_ID', correlationId });
    return;
  }

  if (
    request.headers['content-type']?.split(';', 1)[0]?.trim().toLowerCase() !== 'application/json'
  ) {
    logTransportFailure('CONTENT_TYPE_MUST_BE_JSON', correlationId);
    sendJson(response, 415, { error: 'CONTENT_TYPE_MUST_BE_JSON', correlationId });
    return;
  }

  let body: unknown;
  try {
    body = await readJsonBody(request);
  } catch (error) {
    if (error instanceof BodyTooLargeError) {
      logTransportFailure('REQUEST_BODY_TOO_LARGE', correlationId);
      sendJson(response, 413, { error: 'REQUEST_BODY_TOO_LARGE', correlationId });
      return;
    }
    logTransportFailure('INVALID_JSON', correlationId);
    sendJson(response, 400, { error: 'INVALID_JSON', correlationId });
    return;
  }

  const validation = IntakeRequestSchema.safeParse(body);
  if (!validation.success) {
    logTransportFailure('INVALID_TENDER', correlationId);
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
    const statusCode =
      result.status === 'PROCESSING'
        ? 202
        : result.status === 'FAILED'
          ? result.failure?.code === 'PRICING_GATEWAY_FAILED'
            ? 502
            : result.failure?.code === 'MODEL_PROVIDER_FAILED'
              ? 502
              : 500
          : 200;
    sendJson(response, statusCode, result);
    console.info(
      JSON.stringify({
        event: 'tender.processed',
        tenderId: result.tenderId,
        runId: result.runId,
        correlationId: result.correlationId,
        status: result.status,
        route: result.route,
        replayed: result.replayed,
        traceId: result.modelTrace?.traceId,
        model: result.modelTrace?.model,
      }),
    );
  } catch (error) {
    if (error instanceof IdempotencyConflictError) {
      sendJson(response, 409, { error: 'IDEMPOTENCY_KEY_CONFLICT', correlationId });
      return;
    }
    if (error instanceof StatePersistenceError) {
      sendJson(response, 500, {
        error: error.failure.code,
        correlationId,
        failure: error.failure,
        ...(error.tenderId ? { tenderId: error.tenderId } : {}),
        ...(error.runId ? { runId: error.runId } : {}),
      });
      logOperationalFailure(error.failure, correlationId, error.tenderId, error.runId);
      return;
    }
    if (error instanceof TenderProcessingError) {
      sendJson(response, error.httpStatus, error.response);
      if (error.response.failure) {
        logOperationalFailure(
          error.response.failure,
          correlationId,
          error.response.tenderId,
          error.response.runId,
          error.response.status,
          error.response.modelTrace?.traceId,
          error.response.modelTrace?.model,
        );
      }
      return;
    }
    console.error(JSON.stringify({ event: 'tender.intake_failed', correlationId }));
    sendJson(response, 500, { error: 'TENDER_PROCESSING_FAILED', correlationId });
  }
}

function logTransportFailure(reason: string, correlationId: string): void {
  logOperationalFailure(
    {
      code: 'API_TRANSPORT_FAILED',
      message: reason,
      retryable: false,
      stage: 'API_TRANSPORT',
      occurredAt: new Date().toISOString(),
      attempt: 1,
    },
    correlationId,
  );
}

function logOperationalFailure(
  failure: RunFailure,
  correlationId: string,
  tenderId?: string,
  runId?: string,
  status: string = 'FAILED',
  traceId?: string,
  model?: string,
): void {
  console.error(
    JSON.stringify({
      event: 'tender.operation_failed',
      timestamp: failure.occurredAt ?? new Date().toISOString(),
      correlationId,
      ...(tenderId ? { tenderId } : {}),
      ...(runId ? { runId } : {}),
      status,
      failureCode: failure.code,
      failureStage: failure.stage,
      retryable: failure.retryable,
      attempt: failure.attempt,
      causeCode: failure.causeCode,
      ...(traceId ? { traceId } : {}),
      ...(model ? { model } : {}),
    }),
  );
}

function logStateBoundaryFailure(error: unknown, correlationId: string): void {
  if (error instanceof StatePersistenceError) {
    logOperationalFailure(error.failure, correlationId, error.tenderId, error.runId);
  }
}

function reviewState(
  events: { action: z.infer<typeof ReviewActionSchema> }[],
): 'OPEN' | 'RESOLVED' {
  const lastAction = events.at(-1)?.action;
  return lastAction && lastAction !== 'REOPEN' ? 'RESOLVED' : 'OPEN';
}

function reviewErrorCode(error: unknown): string {
  if (error instanceof ReviewRunNotFoundError) return 'TENDER_RUN_NOT_FOUND';
  if (error instanceof ReviewNotRequiredError) return 'REVIEW_NOT_REQUIRED';
  if (error instanceof StaleReviewVersionError) return 'STALE_REVIEW_VERSION';
  if (error instanceof ReviewRequestConflictError) return 'REVIEW_REQUEST_CONFLICT';
  if (error instanceof InvalidReviewTransitionError) return 'INVALID_REVIEW_TRANSITION';
  return 'REVIEW_ACTION_FAILED';
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
