import { randomUUID } from 'node:crypto';
import type { PricingHandoff } from './contracts.js';
import type { TenderRoute } from '../../../packages/domain/src/index.js';
import type { TenderRepository } from './repository.js';

export interface PricingGateway {
  submit(input: {
    tenderId: string;
    runId: string;
    route: TenderRoute;
    handoffKey: string;
  }): Promise<PricingHandoff>;
}

export class MockPricingGateway implements PricingGateway {
  constructor(private readonly repository: TenderRepository) {}

  async submit(input: {
    tenderId: string;
    runId: string;
    route: TenderRoute;
    handoffKey: string;
  }): Promise<PricingHandoff> {
    if (input.route !== 'READY_FOR_PRICING') {
      throw new Error('Pricing gateway accepts READY_FOR_PRICING tenders only.');
    }

    const priorHandoff = await this.repository.findHandoff(input.handoffKey);
    if (priorHandoff) return priorHandoff;

    const handoff: PricingHandoff = {
      handoffId: randomUUID(),
      handoffKey: input.handoffKey,
      tenderId: input.tenderId,
      runId: input.runId,
      route: 'READY_FOR_PRICING',
      createdAt: new Date().toISOString(),
    };
    await this.repository.saveHandoff(handoff);
    return handoff;
  }
}

