import { randomUUID } from 'node:crypto';
import { ZodError } from 'zod';
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
import { InterpretationError, type TenderInterpreter } from './reasoning/interpreter.js';
import { INTERPRETATION_PROMPT_VERSION } from './reasoning/contracts.js';
import {
  InvalidInterpretationError,
  normalizeStructuredConflictEvidence,
  toReadinessSignals,
} from './reasoning/to-readiness-signals.js';

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
    private readonly interpreter?: TenderInterpreter,
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
      if (priorRun.status === 'FAILED' && priorRun.failure?.retryable !== true) {
        return responseFromRun(priorRun, true, correlationId);
      }
      return this.processRun(priorRun, correlationId, true);
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

    return this.processRun(run, correlationId, false);
  }

  private async processRun(
    run: TenderRun,
    correlationId: string,
    replayed: boolean,
  ): Promise<TenderResponse> {
    if (!run.result) {
      run.status = 'PROCESSING';
      delete run.failure;
      run.updatedAt = this.now().toISOString();
      await this.repository.saveRun(run);

      const duplicateKnown =
        run.input.signals.duplicate.matchesActiveTender ||
        run.input.signals.duplicate.idempotencyKeyPreviouslyProcessed;
      if (run.input.textSources.length > 0 && !duplicateKnown && !run.interpretation) {
        await this.interpretTextSources(run, replayed, correlationId);
      }

      let result: ReadinessResult;
      try {
        result = evaluateReadiness(run.input);
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
          responseFromRun(run, replayed, correlationId),
          500,
        );
      }

      run.status = result.processingStatus;
      run.route = result.route;
      run.result = result;
      run.updatedAt = this.now().toISOString();
      await this.repository.saveRun(run);
    }

    if (run.result?.route === 'READY_FOR_PRICING') {
      try {
        await this.pricingGateway.submit({
          tenderId: run.tenderId,
          runId: run.runId,
          route: run.result.route,
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
          responseFromRun(run, replayed, correlationId),
          502,
        );
      }
      if (run.status === 'FAILED') {
        run.status = run.result.processingStatus;
        delete run.failure;
        run.updatedAt = this.now().toISOString();
        await this.repository.saveRun(run);
      }
    }

    return responseFromRun(run, replayed, correlationId);
  }

  private async interpretTextSources(
    run: TenderRun,
    replayed: boolean,
    correlationId: string,
  ): Promise<void> {
    const traceId = randomUUID();
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
      run.failure = {
        code,
        message:
          code === 'MODEL_OUTPUT_INVALID'
            ? 'The model returned invalid or untrusted interpretation output.'
            : 'Tender interpretation failed at the configured model provider.',
        retryable: error instanceof InterpretationError && error.retryable,
      };
      run.updatedAt = this.now().toISOString();
      await this.repository.saveRun(run);
      throw new TenderProcessingError(
        run.failure.message,
        responseFromRun(run, replayed, correlationId),
        code === 'MODEL_PROVIDER_FAILED' ? 502 : 500,
      );
    }

    run.updatedAt = this.now().toISOString();
    await this.repository.saveRun(run);
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
