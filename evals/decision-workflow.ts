import { randomUUID } from 'node:crypto';
import { createStep, createWorkflow } from '@mastra/core/workflows';
import {
  fingerprintRequest,
  TenderRunSchema,
  type IntakeRequest,
  type PricingHandoff,
  type TenderRun,
} from '../apps/api/src/contracts.js';
import { TenderProcessingError, TenderService } from '../apps/api/src/service.js';
import {
  createTenderInterpretationAgent,
  MastraTenderInterpreter,
} from '../apps/api/src/reasoning/interpreter.js';
import { MockPricingGateway, type PricingGateway } from '../apps/api/src/pricing-gateway.js';
import type { TenderRepository } from '../apps/api/src/repository.js';
import { evaluateReadiness, type RuleId } from '../packages/domain/src/index.js';
import { EvalCaseSchema } from './schema.js';
import { EvalOutcomeSchema } from './metrics.js';
import { toAgentFacts } from './interpretation.js';

class IsolatedTenderRepository implements TenderRepository {
  private readonly runs = new Map<string, TenderRun>();
  private readonly handoffs = new Map<string, PricingHandoff>();

  async findRunByIdempotencyKey(key: string): Promise<TenderRun | undefined> {
    return [...this.runs.values()].find((run) => run.idempotencyKey === key);
  }

  async findRunByTenderId(tenderId: string): Promise<TenderRun | undefined> {
    return [...this.runs.values()].find((run) => run.tenderId === tenderId);
  }

  async saveRun(run: TenderRun): Promise<void> {
    this.runs.set(run.runId, TenderRunSchema.parse(run));
  }

  async findHandoff(handoffKey: string): Promise<PricingHandoff | undefined> {
    return this.handoffs.get(handoffKey);
  }

  async saveHandoff(handoff: PricingHandoff): Promise<void> {
    this.handoffs.set(handoff.handoffKey, handoff);
  }

  seedExistingTender(tenderId: string, input: IntakeRequest): void {
    const result = evaluateReadiness(input);
    const timestamp = new Date().toISOString();
    const run = TenderRunSchema.parse({
      runId: randomUUID(),
      correlationId: `eval-seed-${tenderId}`,
      idempotencyKey: `eval-seed-${tenderId}`,
      requestHash: fingerprintRequest(input),
      tenderId,
      input,
      status: result.processingStatus,
      route: result.route,
      result,
      createdAt: timestamp,
      updatedAt: timestamp,
    });
    this.runs.set(run.runId, run);
  }

  handoffCount(): number {
    return this.handoffs.size;
  }
}

class CountingPricingGateway implements PricingGateway {
  calls = 0;
  private readonly delegate: MockPricingGateway;

  constructor(repository: TenderRepository) {
    this.delegate = new MockPricingGateway(repository);
  }

  submit(input: Parameters<PricingGateway['submit']>[0]) {
    this.calls += 1;
    return this.delegate.submit(input);
  }
}

function hasAmbiguity(response: {
  interpretation?: unknown;
  rules: { ruleId: string; passed: boolean }[];
}) {
  if (response.rules.some((rule) => !rule.passed && ['TDR-007', 'TDR-010'].includes(rule.ruleId))) {
    return true;
  }
  if (typeof response.interpretation !== 'object' || response.interpretation === null) return false;
  const interpretation = response.interpretation as {
    observations?: { ambiguous?: boolean }[];
    siteAssociations?: { ambiguous?: boolean }[];
  };
  return [...(interpretation.observations ?? []), ...(interpretation.siteAssociations ?? [])].some(
    (item) => item.ambiguous === true,
  );
}

export const decisionPathEvalStep = createStep({
  id: 'run-tender-decision-path',
  inputSchema: EvalCaseSchema,
  outputSchema: EvalOutcomeSchema,
  execute: async ({ inputData, mastra }) => {
    const testCase = EvalCaseSchema.parse(inputData);
    const repository = new IsolatedTenderRepository();
    if (testCase.setup.activeTenderId) {
      repository.seedExistingTender(testCase.setup.activeTenderId, testCase.input);
    }
    const gateway = new CountingPricingGateway(repository);
    const interpreter = new MastraTenderInterpreter(
      {},
      mastra.getAgent('tenderInterpretationAgent') as unknown as ReturnType<
        typeof createTenderInterpretationAgent
      >,
    );
    const service = new TenderService(repository, gateway, undefined, interpreter);
    const correlationId = `eval-${testCase.id}`;
    let response;
    try {
      response = await service.submit(testCase.input, correlationId);
    } catch (error) {
      if (!(error instanceof TenderProcessingError)) throw error;
      response = error.response;
    }

    const actualFlags = response.rules
      .filter((rule) => !rule.passed)
      .map((rule) => rule.ruleId as RuleId);
    return EvalOutcomeSchema.parse({
      caseId: testCase.id,
      category: testCase.category,
      safetySet: testCase.safetySet,
      expectedRoute: testCase.expected.route,
      actualRoute: response.route ?? null,
      expectedStatus: testCase.expected.status,
      actualStatus: response.status,
      expectedFacts: testCase.expected.facts,
      actualFacts: response.interpretation ? toAgentFacts(response.interpretation) : [],
      expectedAmbiguous: testCase.expected.ambiguous,
      actualAmbiguous: hasAmbiguity(response),
      expectedPricingHandoffs: testCase.expected.pricingHandoffs,
      actualPricingHandoffs: gateway.calls,
      expectedFlags: testCase.expected.flaggedRules,
      actualFlags,
      ...(response.modelTrace
        ? {
            modelTraceId: response.modelTrace.traceId,
            modelDurationMs: response.modelTrace.durationMs,
          }
        : {}),
      ...(response.failure ? { errorCode: response.failure.code } : {}),
    });
  },
});

export const decisionPathEvalWorkflow = createWorkflow({
  id: 'tender-decision-path-eval',
  inputSchema: EvalCaseSchema,
  outputSchema: EvalOutcomeSchema,
})
  .then(decisionPathEvalStep)
  .commit();
