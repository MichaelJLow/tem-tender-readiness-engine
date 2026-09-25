import { ReadinessConfigSchema, type ReadinessConfig } from './config.js';
import { ReadinessInputSchema, ReadinessResultSchema } from './schemas.js';
import { conservativeRoutingPolicy } from './routing-policy.js';
import type { ReadinessResult, RuleResult } from './types.js';
import { getReadinessRules, rule012ReadinessSatisfied } from './rules.js';

/** Validate an intake/evidence payload, evaluate every rule, and choose a conservative route. */
export function evaluateReadiness(
  rawInput: unknown,
  configInput: Partial<ReadinessConfig> = {},
): ReadinessResult {
  const input = ReadinessInputSchema.parse(rawInput);
  const config = ReadinessConfigSchema.parse(configInput);
  const priorResults = getReadinessRules(config).map((rule) => rule(input));
  const ruleResults: RuleResult[] = [...priorResults, rule012ReadinessSatisfied(priorResults)];
  const hasPendingRequiredDocument = input.tender.documents.some(
    (document) => document.required && document.processingStatus === 'PENDING',
  );

  return ReadinessResultSchema.parse({
    route: hasPendingRequiredDocument
      ? undefined
      : conservativeRoutingPolicy.determineRoute(ruleResults),
    processingStatus: hasPendingRequiredDocument ? 'PROCESSING' : 'COMPLETED',
    rules: ruleResults,
  });
}
