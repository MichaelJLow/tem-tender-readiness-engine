import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import {
  LocalStateSchema,
  ReviewEventSchema,
  type InformationRequestReceipt,
  type LocalState,
  type PricingHandoff,
  type ReviewEvent,
  type TenderRun,
} from './contracts.js';
import type { LocalStateStore, TenderRepository } from './repository.js';

export class FileStateStore implements LocalStateStore {
  constructor(private readonly filePath: string) {}

  async read(): Promise<LocalState> {
    try {
      const contents = await readFile(this.filePath, 'utf8');
      return LocalStateSchema.parse(JSON.parse(contents) as unknown);
    } catch (error) {
      if (isMissingFile(error)) {
        return {
          version: 1,
          runs: [],
          handoffs: [],
          reviewEvents: [],
          informationRequestReceipts: [],
        };
      }
      throw new StateReadError(`Unable to read tender state at ${this.filePath}.`, {
        cause: error,
      });
    }
  }

  async write(state: LocalState): Promise<void> {
    const validatedState = LocalStateSchema.parse(state);
    const directory = dirname(this.filePath);
    const tempPath = `${this.filePath}.${randomUUID()}.tmp`;
    try {
      await mkdir(directory, { recursive: true });
      await writeFile(tempPath, `${JSON.stringify(validatedState, null, 2)}\n`, { flag: 'wx' });
      await rename(tempPath, this.filePath);
    } catch (error) {
      throw new StateWriteError(`Unable to write tender state at ${this.filePath}.`, {
        cause: error,
      });
    }
  }
}

export class StateReadError extends Error {
  override name = 'StateReadError';
}

export class StateWriteError extends Error {
  override name = 'StateWriteError';
}

export class JsonFileTenderRepository implements TenderRepository {
  constructor(private readonly store: LocalStateStore) {}

  async findRunByIdempotencyKey(key: string): Promise<TenderRun | undefined> {
    return (await this.store.read()).runs.find((run) => run.idempotencyKey === key);
  }

  async findRunByTenderId(tenderId: string): Promise<TenderRun | undefined> {
    return (await this.store.read()).runs.find((run) => run.tenderId === tenderId);
  }

  async listRuns(): Promise<TenderRun[]> {
    return (await this.store.read()).runs.sort((left, right) =>
      right.createdAt.localeCompare(left.createdAt),
    );
  }

  async findRunByRunId(runId: string): Promise<TenderRun | undefined> {
    return (await this.store.read()).runs.find((run) => run.runId === runId);
  }

  async findReviewEvents(runId: string): Promise<ReviewEvent[]> {
    return (await this.store.read()).reviewEvents.filter((event) => event.runId === runId);
  }

  async appendReviewEvent(event: ReviewEvent, expectedVersion: number): Promise<ReviewEvent> {
    const validatedEvent = ReviewEventSchema.parse(event);
    const state = await this.store.read();
    const run = state.runs.find((item) => item.runId === validatedEvent.runId);
    if (!run) throw new ReviewRunNotFoundError();
    if (run.route !== 'HUMAN_REVIEW') throw new ReviewNotRequiredError();

    const events = state.reviewEvents.filter((item) => item.runId === run.runId);
    const duplicate = events.find((item) => item.requestId === validatedEvent.requestId);
    if (duplicate) {
      if (!sameReviewCommand(duplicate, validatedEvent)) throw new ReviewRequestConflictError();
      return duplicate;
    }
    if (events.length !== expectedVersion) throw new StaleReviewVersionError();

    const isOpen = events.length === 0 || events.at(-1)?.action === 'REOPEN';
    if (validatedEvent.action === 'REOPEN' ? isOpen : !isOpen) {
      throw new InvalidReviewTransitionError();
    }
    if (validatedEvent.reviewVersion !== expectedVersion + 1) {
      throw new StaleReviewVersionError();
    }

    state.reviewEvents.push(validatedEvent);
    await this.store.write(state);
    return validatedEvent;
  }

  async saveRun(run: TenderRun): Promise<void> {
    const state = await this.store.read();
    const index = state.runs.findIndex((existing) => existing.runId === run.runId);
    if (index === -1) state.runs.push(run);
    else state.runs[index] = run;
    await this.store.write(state);
  }

  async findHandoff(handoffKey: string): Promise<PricingHandoff | undefined> {
    return (await this.store.read()).handoffs.find((handoff) => handoff.handoffKey === handoffKey);
  }

  async saveHandoff(handoff: PricingHandoff): Promise<void> {
    const state = await this.store.read();
    if (!state.handoffs.some((existing) => existing.handoffKey === handoff.handoffKey)) {
      state.handoffs.push(handoff);
      await this.store.write(state);
    }
  }

  async findInformationRequestReceipt(key: string): Promise<InformationRequestReceipt | undefined> {
    return (await this.store.read()).informationRequestReceipts.find(
      (receipt) => receipt.key === key,
    );
  }

  async saveInformationRequestReceipt(receipt: InformationRequestReceipt): Promise<void> {
    const state = await this.store.read();
    if (!state.informationRequestReceipts.some((existing) => existing.key === receipt.key)) {
      state.informationRequestReceipts.push(receipt);
      await this.store.write(state);
    }
  }
}

function sameReviewCommand(left: ReviewEvent, right: ReviewEvent): boolean {
  return (
    left.runId === right.runId &&
    left.action === right.action &&
    left.actor === right.actor &&
    left.reason === right.reason &&
    left.sourceIds.join('\0') === right.sourceIds.join('\0')
  );
}

export class ReviewRunNotFoundError extends Error {}
export class ReviewNotRequiredError extends Error {}
export class StaleReviewVersionError extends Error {}
export class ReviewRequestConflictError extends Error {}
export class InvalidReviewTransitionError extends Error {}

function isMissingFile(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT';
}
