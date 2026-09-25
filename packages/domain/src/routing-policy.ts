import type { RuleResult, TenderRoute } from './types.js';

export interface RoutingPolicy {
  determineRoute(results: readonly RuleResult[]): TenderRoute;
}

export const ROUTE_PRECEDENCE: readonly TenderRoute[] = [
  'DUPLICATE',
  'HUMAN_REVIEW',
  'NEEDS_INFORMATION',
  'READY_FOR_PRICING',
];

export const conservativeRoutingPolicy: RoutingPolicy = {
  determineRoute(results) {
    for (const route of ROUTE_PRECEDENCE.slice(0, -1)) {
      if (results.some((result) => !result.passed && result.route === route)) return route;
    }

    return results.some((result) => result.passed && result.route === 'READY_FOR_PRICING')
      ? 'READY_FOR_PRICING'
      : 'HUMAN_REVIEW';
  },
};
