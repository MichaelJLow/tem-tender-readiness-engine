import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import {
  LocalStateSchema,
  type LocalState,
  type PricingHandoff,
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
      if (isMissingFile(error)) return { version: 1, runs: [], handoffs: [] };
      throw new Error(`Unable to read tender state at ${this.filePath}.`, { cause: error });
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
      throw new Error(`Unable to write tender state at ${this.filePath}.`, { cause: error });
    }
  }
}

export class JsonFileTenderRepository implements TenderRepository {
  constructor(private readonly store: LocalStateStore) {}

  async findRunByIdempotencyKey(key: string): Promise<TenderRun | undefined> {
    return (await this.store.read()).runs.find((run) => run.idempotencyKey === key);
  }

  async findRunByTenderId(tenderId: string): Promise<TenderRun | undefined> {
    return (await this.store.read()).runs.find((run) => run.tenderId === tenderId);
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
}

function isMissingFile(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT';
}

