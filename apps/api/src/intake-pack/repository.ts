import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { z } from 'zod';
import { IntakePackSchema, type IntakePack } from '../../../../packages/domain/src/index.js';

export const IntakePackStateSchema = z.object({
  version: z.literal(1),
  packs: z.array(IntakePackSchema).default([]),
});

export type IntakePackState = z.infer<typeof IntakePackStateSchema>;

export interface IntakePackRepository {
  getPack(packId: string): Promise<IntakePack | undefined>;
  savePack(pack: IntakePack): Promise<void>;
}

export interface IntakePackStateStore {
  read(): Promise<IntakePackState>;
  write(state: IntakePackState): Promise<void>;
}

export class MemoryIntakePackRepository implements IntakePackRepository {
  constructor(private readonly store = new MemoryIntakePackStateStore()) {}

  async getPack(packId: string): Promise<IntakePack | undefined> {
    const pack = (await this.store.read()).packs.find((item) => item.packId === packId);
    return pack ? structuredClone(pack) : undefined;
  }

  async savePack(pack: IntakePack): Promise<void> {
    const validated = IntakePackSchema.parse(pack);
    const state = await this.store.read();
    const index = state.packs.findIndex((item) => item.packId === validated.packId);
    if (index === -1) state.packs.push(structuredClone(validated));
    else state.packs[index] = structuredClone(validated);
    await this.store.write(state);
  }
}

export class MemoryIntakePackStateStore implements IntakePackStateStore {
  private state: IntakePackState = { version: 1, packs: [] };

  async read(): Promise<IntakePackState> {
    return structuredClone(this.state);
  }

  async write(state: IntakePackState): Promise<void> {
    this.state = structuredClone(IntakePackStateSchema.parse(state));
  }
}

export class FileIntakePackStateStore implements IntakePackStateStore {
  constructor(private readonly filePath: string) {}

  async read(): Promise<IntakePackState> {
    try {
      const contents = await readFile(this.filePath, 'utf8');
      return IntakePackStateSchema.parse(JSON.parse(contents) as unknown);
    } catch (error) {
      if (isMissingFile(error)) {
        return { version: 1, packs: [] };
      }
      throw new IntakePackStateReadError(`Unable to read Intake pack state at ${this.filePath}.`, {
        cause: error,
      });
    }
  }

  async write(state: IntakePackState): Promise<void> {
    const validated = IntakePackStateSchema.parse(state);
    const directory = dirname(this.filePath);
    const tempPath = `${this.filePath}.${randomUUID()}.tmp`;
    try {
      await mkdir(directory, { recursive: true });
      await writeFile(tempPath, `${JSON.stringify(validated, null, 2)}\n`, { flag: 'wx' });
      await rename(tempPath, this.filePath);
    } catch (error) {
      throw new IntakePackStateWriteError(
        `Unable to write Intake pack state at ${this.filePath}.`,
        {
          cause: error,
        },
      );
    }
  }
}

export class JsonFileIntakePackRepository implements IntakePackRepository {
  constructor(private readonly store: IntakePackStateStore) {}

  async getPack(packId: string): Promise<IntakePack | undefined> {
    return (await this.store.read()).packs.find((pack) => pack.packId === packId);
  }

  async savePack(pack: IntakePack): Promise<void> {
    const validated = IntakePackSchema.parse(pack);
    const state = await this.store.read();
    const index = state.packs.findIndex((item) => item.packId === validated.packId);
    if (index === -1) state.packs.push(validated);
    else state.packs[index] = validated;
    await this.store.write(state);
  }
}

export class IntakePackStateReadError extends Error {
  override name = 'IntakePackStateReadError';
}

export class IntakePackStateWriteError extends Error {
  override name = 'IntakePackStateWriteError';
}

function isMissingFile(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT';
}
