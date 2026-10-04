import { randomUUID } from 'node:crypto';
import { ZodError } from 'zod';
import {
  IntakeRequestSchema,
  TenderRunSchema,
  fingerprintRequest,
  type ReviewEvent,
  type IntakeRequest,
  type ReadinessResult,
  type TenderResponse,
  type TenderRun,
  type RunFailure,
} from './contracts.js';
import type { PricingGateway } from './pricing-gateway.js';
import type { TenderRepository } from './repository.js';
import { evaluateReadiness } from '../../../packages/domain/src/index.js';
import { InterpretationError, type TenderInterpreter } from './reasoning/interpreter.js';
import { INTERPRETATION_PROMPT_VERSION } from './reasoning/contracts.js';
import {
  InvalidInterpretationError,
  normalizeStructuredConflictEvidence,
  toReadinessSignals,
} from './reasoning/to-readiness-signals.js';
import {
  InvalidReviewTransitionError,
  ReviewNotRequiredError,
  ReviewRequestConflictError,
  ReviewRunNotFoundError,
  StateReadError,
  StateWriteError,
  StaleReviewVersionError,
} from './file-repository.js';

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

export class StatePersistenceError extends Error {
  constructor(
    readonly failure: RunFailure,
    readonly tenderId?: string,
    readonly runId?: string,
  ) {
    super(failure.message);
    this.name = 'StatePersistenceError';
  }
}

export const DEFAULT_RECOVERY_POLICY = {
  maxAttempts: 3,
  backoffMs: [250, 1_000] as readonly number[],
} as const;

export type RecoveryPolicy = {
  maxAttempts: number;
  backoffMs: readonly number[];
  sleep?: (delayMs: number) => Promise<void>;
};

export class TenderService {
  private queue: Promise<void> = Promise.resolve();

  constructor(
    private readonly repository: TenderRepository,
    private readonly pricingGateway: PricingGateway,
    private readonly now: () => Date = () => new Date(),
    private readonly interpreter?: TenderInterpreter,
    private readonly recoveryPolicy: RecoveryPolicy = DEFAULT_RECOVERY_POLICY,
  ) {}

  submit(rawInput: unknown, correlationId: string): Promise<TenderResponse> {
    const operation = this.queue.then(() => this.submitSerial(rawInput, correlationId));
    this.queue = operation.then(
      () => undefined,
      () => undefined,
    );
    return operation;
  }

  listRuns(): Promise<TenderRun[]> {
    if (!this.repository.listRuns) return Promise.reject(new Error('Run listing is unavailable.'));
    return this.readState(() => this.repository.listRuns!());
  }

  findRun(runId: string): Promise<TenderRun | undefined> {
    if (!this.repository.findRunByRunId) {
      return Promise.reject(new Error('Run lookup is unavailable.'));
    }
    return this.readState(() => this.repository.findRunByRunId!(runId));
  }

  async getReviewEvents(runId: string): Promise<ReviewEvent[]> {
    if (!this.repository.findReviewEvents) {
      throw new Error('Review history is unavailable.');
    }
    return this.readState(() => this.repository.findReviewEvents!(runId));
  }

  recordReviewEvent(event: ReviewEvent, expectedVersion: number): Promise<ReviewEvent> {
    if (!this.repository.appendReviewEvent) {
      return Promise.reject(new Error('Review actions are unavailable.'));
    }
    const operation = this.queue.then(async () => {
      try {
        return await this.repository.appendReviewEvent!(event, expectedVersion);
      } catch (error) {
        if (
          error instanceof ReviewRunNotFoundError ||
          error instanceof ReviewNotRequiredError ||
          error instanceof StaleReviewVersionError ||
          error instanceof ReviewRequestConflictError ||
          error instanceof InvalidReviewTransitionError
        ) {
          throw error;
        }
        throw this.stateError(
          error instanceof StateReadError ? 'STATE_READ_FAILED' : 'STATE_WRITE_FAILED',
          event.runId,
        );
      }
    });
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
    const priorRun = await this.readState(
      () => this.repository.findRunByIdempotencyKey(key),
      request.tender.tenderId,
    );

    if (priorRun) {
      if (priorRun.requestHash !== requestHash) throw new IdempotencyConflictError();
      if (priorRun.status === 'FAILED' && priorRun.failure?.retryable !== true) {
        return responseFromRun(priorRun, true, correlationId);
      }
      return this.processRun(priorRun, correlationId, true);
    }

    const activeTender = await this.readState(
      () => this.repository.findRunByTenderId(request.tender.tenderId),
      request.tender.tenderId,
    );
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
    await this.writeRun(run, 1);

    return this.processRun(run, correlationId, false);
  }

  private async processRun(
    run: TenderRun,
    correlationId: string,
    replayed: boolean,
  ): Promise<TenderResponse> {
    const priorFailure = run.failure;
    let attempt = priorFailure?.stage === 'INTERPRETATION' ? (priorFailure.attempt ?? 0) + 1 : 1;
    if (!run.result) {
      run.status = 'PROCESSING';
      // Keep the retained failure durable until the resumed provider attempt resolves.
      if (priorFailure?.stage !== 'INTERPRETATION') {
        delete run.failure;
        run.updatedAt = this.now().toISOString();
        await this.writeRun(run, attempt);
      }

      const duplicateKnown =
        run.input.signals.duplicate.matchesActiveTender ||
        run.input.signals.duplicate.idempotencyKeyPreviouslyProcessed;
      if (run.input.textSources.length > 0 && !duplicateKnown && !run.interpretation) {
        attempt = await this.interpretTextSources(run, replayed, correlationId, attempt);
      }

      let result: ReadinessResult;
      try {
        result = evaluateReadiness(run.input);
      } catch {
        run.status = 'FAILED';
        run.updatedAt = this.now().toISOString();
        run.failure = {
          code: 'READINESS_EVALUATION_FAILED',
          message: 'Readiness evaluation failed.',
          retryable: false,
          stage: 'READINESS',
          occurredAt: run.updatedAt,
          attempt,
        };
        await this.writeFailureRun(run, attempt, 'READINESS_EVALUATION_FAILED');
        throw new TenderProcessingError(
          'Readiness evaluation failed.',
          responseFromRun(run, replayed, correlationId),
          500,
        );
      }

      run.status = result.processingStatus;
      run.route = result.route;
      run.result = result;
      run.updatedAt = this.now().toISOString();
      await this.writeRun(run, attempt);
    }

    if (run.result?.route === 'READY_FOR_PRICING') {
      const pricingAttempt =
        priorFailure?.stage === 'PRICING' ? (priorFailure.attempt ?? 0) + 1 : 1;
      await this.submitPricingWithRetry(run, replayed, correlationId, pricingAttempt);
    }

    return responseFromRun(run, replayed, correlationId);
  }

  private async submitPricingWithRetry(
    run: TenderRun,
    replayed: boolean,
    correlationId: string,
    initialAttempt: number,
  ): Promise<void> {
    let attempt = initialAttempt;
    while (true) {
      if (attempt > this.recoveryPolicy.maxAttempts) {
        const handoffKey = `${run.tenderId}:${run.idempotencyKey}`;
        const recordedHandoff = await this.readState(() => this.repository.findHandoff(handoffKey));
        if (recordedHandoff) {
          run.status = 'COMPLETED';
          delete run.failure;
          run.updatedAt = this.now().toISOString();
          await this.writeRun(run, this.recoveryPolicy.maxAttempts, 'PRICING_GATEWAY_FAILED');
          return;
        }
        run.status = 'FAILED';
        run.updatedAt = this.now().toISOString();
        run.failure = {
          code: 'PRICING_GATEWAY_FAILED',
          message: `The mocked pricing handoff exhausted ${this.recoveryPolicy.maxAttempts} attempts.`,
          retryable: false,
          stage: 'PRICING',
          occurredAt: run.updatedAt,
          attempt: this.recoveryPolicy.maxAttempts,
        };
        await this.writeFailureRun(run, this.recoveryPolicy.maxAttempts, 'PRICING_GATEWAY_FAILED');
        throw new TenderProcessingError(
          'Pricing handoff failed.',
          responseFromRun(run, replayed, correlationId),
          502,
        );
      }

      run.status = 'PROCESSING';
      run.updatedAt = this.now().toISOString();
      run.failure = {
        code: 'PRICING_GATEWAY_FAILED',
        message: 'A pricing handoff attempt is in progress; recovery must count this attempt.',
        retryable: true,
        stage: 'PRICING',
        occurredAt: run.updatedAt,
        attempt,
      };
      await this.writeRun(run, attempt);
      try {
        await this.pricingGateway.submit({
          tenderId: run.tenderId,
          runId: run.runId,
          route: 'READY_FOR_PRICING',
          handoffKey: `${run.tenderId}:${run.idempotencyKey}`,
        });
      } catch (error) {
        if (error instanceof StateReadError || error instanceof StateWriteError) {
          throw new StatePersistenceError(
            {
              code: error instanceof StateReadError ? 'STATE_READ_FAILED' : 'STATE_WRITE_FAILED',
              message:
                error instanceof StateReadError
                  ? 'Tender state could not be read.'
                  : 'Tender state could not be written.',
              retryable: true,
              stage: error instanceof StateReadError ? 'STATE_READ' : 'STATE_WRITE',
              occurredAt: this.now().toISOString(),
              attempt,
            },
            run.tenderId,
            run.runId,
          );
        }
        const exhausted = attempt >= this.recoveryPolicy.maxAttempts;
        run.status = 'FAILED';
        run.updatedAt = this.now().toISOString();
        run.failure = {
          code: 'PRICING_GATEWAY_FAILED',
          message: exhausted
            ? `The mocked pricing handoff exhausted ${this.recoveryPolicy.maxAttempts} attempts.`
            : 'The mocked pricing handoff failed and will be retried.',
          retryable: !exhausted,
          stage: 'PRICING',
          occurredAt: run.updatedAt,
          attempt,
        };
        await this.writeFailureRun(run, attempt, 'PRICING_GATEWAY_FAILED');
        if (!exhausted) {
          await this.waitBeforeRetry(attempt);
          attempt += 1;
          continue;
        }
        throw new TenderProcessingError(
          'Pricing handoff failed.',
          responseFromRun(run, replayed, correlationId),
          502,
        );
      }
      run.status = 'COMPLETED';
      delete run.failure;
      run.updatedAt = this.now().toISOString();
      await this.writeRun(run, attempt, 'PRICING_GATEWAY_FAILED');
      return;
    }
  }

  private async interpretTextSources(
    run: TenderRun,
    replayed: boolean,
    correlationId: string,
    attempt: number,
  ): Promise<number> {
    let currentAttempt = attempt;
    while (true) {
      if (currentAttempt > this.recoveryPolicy.maxAttempts) {
        run.status = 'FAILED';
        run.updatedAt = this.now().toISOString();
        run.failure = {
          code: 'MODEL_PROVIDER_FAILED',
          message: `Tender interpretation exhausted ${this.recoveryPolicy.maxAttempts} provider attempts.`,
          retryable: false,
          stage: 'INTERPRETATION',
          occurredAt: run.updatedAt,
          attempt: this.recoveryPolicy.maxAttempts,
        };
        await this.writeFailureRun(run, this.recoveryPolicy.maxAttempts, 'MODEL_PROVIDER_FAILED');
        throw new TenderProcessingError(
          run.failure.message,
          responseFromRun(run, replayed, correlationId),
          502,
        );
      }

      const traceId = randomUUID();
      run.status = 'PROCESSING';
      run.updatedAt = this.now().toISOString();
      run.failure = {
        code: 'MODEL_PROVIDER_FAILED',
        message: 'A provider attempt is in progress; recovery must count this attempt.',
        retryable: true,
        stage: 'INTERPRETATION',
        occurredAt: run.updatedAt,
        attempt: currentAttempt,
      };
      await this.writeRun(run, currentAttempt);
      try {
        if (!this.interpreter) throw new Error('No tender interpreter is configured.');
        const { output, trace } = await this.interpreter.interpret(run.input, traceId);
        run.modelTrace = trace;
        const interpretation = normalizeStructuredConflictEvidence(run.input.textSources, output);
        const signals = toReadinessSignals(run.input, run.input.textSources, interpretation);
        run.input = { ...run.input, signals };
        run.interpretation = interpretation;
      } catch (error) {
        const code =
          error instanceof InterpretationError
            ? error.code
            : error instanceof InvalidInterpretationError || error instanceof ZodError
              ? 'MODEL_OUTPUT_INVALID'
              : 'MODEL_PROVIDER_FAILED';
        const trace =
          error instanceof InterpretationError
            ? error.trace
            : run.modelTrace
              ? { ...run.modelTrace, outcome: 'FAILED' as const }
              : undefined;
        run.modelTrace = trace ?? {
          traceId,
          model: this.interpreter?.model ?? 'unconfigured',
          promptVersion: INTERPRETATION_PROMPT_VERSION,
          startedAt: this.now().toISOString(),
          completedAt: this.now().toISOString(),
          durationMs: 0,
          outcome: 'FAILED',
        };
        run.status = 'FAILED';
        run.updatedAt = this.now().toISOString();
        const eligible = error instanceof InterpretationError && error.retryable;
        const exhausted = currentAttempt >= this.recoveryPolicy.maxAttempts;
        run.failure = {
          code,
          message:
            code === 'MODEL_OUTPUT_INVALID'
              ? 'The model returned invalid or untrusted interpretation output.'
              : eligible && exhausted
                ? `Tender interpretation exhausted ${this.recoveryPolicy.maxAttempts} provider attempts.`
                : 'Tender interpretation failed at the configured model provider.',
          retryable: eligible && !exhausted,
          stage: 'INTERPRETATION',
          occurredAt: run.updatedAt,
          attempt: currentAttempt,
        };
        await this.writeFailureRun(run, run.failure.attempt ?? 1, code);
        if (eligible && !exhausted) {
          await this.waitBeforeRetry(currentAttempt);
          currentAttempt += 1;
          run.status = 'PROCESSING';
          delete run.failure;
          continue;
        }
        throw new TenderProcessingError(
          run.failure.message,
          responseFromRun(run, replayed, correlationId),
          code === 'MODEL_PROVIDER_FAILED' ? 502 : 500,
        );
      }

      break;
    }

    run.updatedAt = this.now().toISOString();
    run.status = 'PROCESSING';
    delete run.failure;
    await this.writeRun(run, currentAttempt);
    console.info(
      JSON.stringify({
        event: 'tender.interpretation_completed',
        tenderId: run.tenderId,
        runId: run.runId,
        correlationId,
        traceId: run.modelTrace?.traceId,
        model: run.modelTrace?.model,
        promptVersion: run.modelTrace?.promptVersion,
        durationMs: run.modelTrace?.durationMs,
        outcome: run.modelTrace?.outcome,
      }),
    );
    return currentAttempt;
  }

  private waitBeforeRetry(failedAttempt: number): Promise<void> {
    const delay = this.recoveryPolicy.backoffMs[failedAttempt - 1] ?? 0;
    const sleep =
      this.recoveryPolicy.sleep ??
      ((ms: number) => new Promise((resolve) => setTimeout(resolve, ms)));
    return sleep(delay);
  }

  private async readState<T>(operation: () => Promise<T>, tenderId?: string): Promise<T> {
    try {
      return await operation();
    } catch {
      throw this.stateError('STATE_READ_FAILED', undefined, tenderId);
    }
  }

  private async writeRun(run: TenderRun, attempt: number, causeCode?: RunFailure['causeCode']) {
    try {
      await this.repository.saveRun(run);
    } catch (error) {
      const reading = error instanceof StateReadError;
      throw new StatePersistenceError(
        {
          code: reading ? 'STATE_READ_FAILED' : 'STATE_WRITE_FAILED',
          message: reading
            ? 'Tender state could not be read.'
            : 'Tender state could not be written.',
          retryable: true,
          stage: reading ? 'STATE_READ' : 'STATE_WRITE',
          occurredAt: this.now().toISOString(),
          attempt,
          ...(causeCode ? { causeCode } : {}),
        },
        run.tenderId,
        run.runId,
      );
    }
  }

  private writeFailureRun(run: TenderRun, attempt: number, causeCode: RunFailure['causeCode']) {
    return this.writeRun(run, attempt, causeCode);
  }

  private stateError(
    code: 'STATE_READ_FAILED' | 'STATE_WRITE_FAILED',
    runId?: string,
    tenderId?: string,
  ): StatePersistenceError {
    const reading = code === 'STATE_READ_FAILED';
    return new StatePersistenceError(
      {
        code,
        message: reading ? 'Tender state could not be read.' : 'Tender state could not be written.',
        retryable: true,
        stage: reading ? 'STATE_READ' : 'STATE_WRITE',
        occurredAt: this.now().toISOString(),
        attempt: 1,
      },
      tenderId,
      runId,
    );
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
    ...(run.interpretation ? { interpretation: run.interpretation } : {}),
    ...(run.modelTrace ? { modelTrace: run.modelTrace } : {}),
    rules: run.result?.rules ?? [],
    ...(run.failure ? { failure: run.failure } : {}),
    replayed,
  };
}
