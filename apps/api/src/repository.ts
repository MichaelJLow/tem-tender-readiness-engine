import type { LocalState, PricingHandoff, TenderRun } from './contracts.js';

export interface TenderRepository {
  findRunByIdempotencyKey(key: string): Promise<TenderRun | undefined>;
  findRunByTenderId(tenderId: string): Promise<TenderRun | undefined>;
  saveRun(run: TenderRun): Promise<void>;
  findHandoff(handoffKey: string): Promise<PricingHandoff | undefined>;
  saveHandoff(handoff: PricingHandoff): Promise<void>;
}

export interface LocalStateStore {
  read(): Promise<LocalState>;
  write(state: LocalState): Promise<void>;
}

