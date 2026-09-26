import { randomUUID } from 'node:crypto';
import {
  IntakeRequestSchema,
  TenderRunSchema,
  fingerprintRequest,
  type IntakeRequest,
  type ReadinessResult,
  type TenderResponse,
  type TenderRun,
} from './contracts.js';
import type { PricingGateway } from './pricing-gateway.js';
import type { TenderRepository } from './repository.js';
import { evaluateReadiness } from '../../../packages/domain/src/index.js';

export class IdempotencyConflictError extends Error {
  constructor() {
    super('The idempotency key was already used with a different request.');
    this.name = 'IdempotencyConflictError';
  }
}

export class TenderProcessingError extends Error {
  constructor(
    message: string,
    readonly response: TenderResponse,
    readonly httpStatus: number,
  ) {
    super(message);
    this.name = 'TenderProcessingError';
  }
}

export class TenderService {
  private queue: Promise<void> = Promise.resolve();

  constructor(
    private readonly repository: TenderRepository,
    private readonly pricingGateway: PricingGateway,
    private readonly now: () => Date = () => new Date(),
  ) {}

  submit(rawInput: unknown, correlationId: string): Promise<TenderResponse> {
    const operation = this.queue.then(() => this.submitSerial(rawInput, correlationId));
    this.queue = operation.then(
      () => undefined,
      () => undefined,
    );
    return operation;
  }

  private async submitSerial(rawInput: unknown, correlationId: string): Promise<TenderResponse> {
    const request: IntakeRequest = IntakeRequestSchema.parse(rawInput);
    const requestForFingerprint = {
      ...request,
      signals: {
        ...request.signals,
        duplicate: { matchesActiveTender: false, idempotencyKeyPreviouslyProcessed: false },
      },
    };
    const requestHash = fingerprintRequest(requestForFingerprint);
    const key = request.tender.idempotencyKey;
    const priorRun = await this.repository.findRunByIdempotencyKey(key);

    if (priorRun) {
      if (priorRun.requestHash !== requestHash) throw new IdempotencyConflictError();
      return responseFromRun(priorRun, true, correlationId);
    }

    const activeTender = await this.repository.findRunByTenderId(request.tender.tenderId);
    const input: IntakeRequest = {
      ...request,
      signals: {
        ...request.signals,
        duplicate: {
          matchesActiveTender: Boolean(activeTender),
          ...(activeTender ? { matchedTenderId: activeTender.tenderId } : {}),
          idempotencyKeyPreviouslyProcessed: false,
        },
      },
    };
    const timestamp = this.now().toISOString();
    const run = TenderRunSchema.parse({
      runId: randomUUID(),
      correlationId,
      idempotencyKey: key,
      requestHash,
      tenderId: input.tender.tenderId,
      input,
      status: 'RECEIVED',
      createdAt: timestamp,
      updatedAt: timestamp,
    });
    await this.repository.saveRun(run);

    run.status = 'PROCESSING';
    run.updatedAt = this.now().toISOString();
    await this.repository.saveRun(run);

    let result: ReadinessResult;
    try {
      result = evaluateReadiness(input);
    } catch {
      run.status = 'FAILED';
      run.failure = {
        code: 'READINESS_EVALUATION_FAILED',
        message: 'Readiness evaluation failed.',
        retryable: false,
      };
      run.updatedAt = this.now().toISOString();
      await this.repository.saveRun(run);
      throw new TenderProcessingError(
        'Readiness evaluation failed.',
        responseFromRun(run, false),
        500,
      );
    }

    run.status = result.processingStatus;
    run.route = result.route;
    run.result = result;
    run.updatedAt = this.now().toISOString();
    await this.repository.saveRun(run);

    if (result.route === 'READY_FOR_PRICING') {
      try {
        await this.pricingGateway.submit({
          tenderId: run.tenderId,
          runId: run.runId,
          route: result.route,
          handoffKey: `${run.tenderId}:${run.idempotencyKey}`,
        });
      } catch {
        run.status = 'FAILED';
        run.failure = {
          code: 'PRICING_GATEWAY_FAILED',
          message: 'The mocked pricing handoff failed.',
          retryable: true,
        };
        run.updatedAt = this.now().toISOString();
        await this.repository.saveRun(run);
        throw new TenderProcessingError(
          'Pricing handoff failed.',
          responseFromRun(run, false),
          502,
        );
      }
    }

    return responseFromRun(run, false);
  }
}

function responseFromRun(
  run: TenderRun,
  replayed: boolean,
  correlationId = run.correlationId,
): TenderResponse {
  return {
    tenderId: run.tenderId,
    runId: run.runId,
    correlationId,
    status: run.status,
    ...(run.route ? { route: run.route } : {}),
    rules: run.result?.rules ?? [],
    ...(run.failure ? { failure: run.failure } : {}),
    replayed,
  };
}
