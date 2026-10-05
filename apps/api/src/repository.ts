import type {
  InformationRequestReceipt,
  LocalState,
  PricingHandoff,
  ReviewEvent,
  TenderRun,
} from './contracts.js';

export interface TenderRepository {
  findRunByIdempotencyKey(key: string): Promise<TenderRun | undefined>;
  findRunByTenderId(tenderId: string): Promise<TenderRun | undefined>;
  listRuns?(): Promise<TenderRun[]>;
  findRunByRunId?(runId: string): Promise<TenderRun | undefined>;
  saveRun(run: TenderRun): Promise<void>;
  findReviewEvents?(runId: string): Promise<ReviewEvent[]>;
  appendReviewEvent?(event: ReviewEvent, expectedVersion: number): Promise<ReviewEvent>;
  findHandoff(handoffKey: string): Promise<PricingHandoff | undefined>;
  saveHandoff(handoff: PricingHandoff): Promise<void>;
  findInformationRequestReceipt?(key: string): Promise<InformationRequestReceipt | undefined>;
  saveInformationRequestReceipt?(receipt: InformationRequestReceipt): Promise<void>;
}

export interface LocalStateStore {
  read(): Promise<LocalState>;
  write(state: LocalState): Promise<void>;
}
