import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

export class OriginalImmutableError extends Error {
  override name = 'OriginalImmutableError';
}

export interface IntakeOriginalsStore {
  putOriginal(packId: string, documentId: string, bytes: Uint8Array): Promise<void>;
  getOriginal(packId: string, documentId: string): Promise<Uint8Array | undefined>;
}

export class MemoryIntakeOriginalsStore implements IntakeOriginalsStore {
  private readonly originals = new Map<string, Uint8Array>();

  async putOriginal(packId: string, documentId: string, bytes: Uint8Array): Promise<void> {
    const key = originalKey(packId, documentId);
    if (this.originals.has(key)) {
      throw new OriginalImmutableError(
        `Original bytes for ${packId}/${documentId} are immutable and cannot be replaced.`,
      );
    }
    this.originals.set(key, Uint8Array.from(bytes));
  }

  async getOriginal(packId: string, documentId: string): Promise<Uint8Array | undefined> {
    const stored = this.originals.get(originalKey(packId, documentId));
    return stored ? Uint8Array.from(stored) : undefined;
  }
}

export class FileIntakeOriginalsStore implements IntakeOriginalsStore {
  constructor(private readonly rootDirectory: string) {}

  async putOriginal(packId: string, documentId: string, bytes: Uint8Array): Promise<void> {
    const filePath = this.pathFor(packId, documentId);
    await mkdir(dirname(filePath), { recursive: true });
    try {
      await writeFile(filePath, bytes, { flag: 'wx' });
    } catch (error) {
      if (isAlreadyExists(error)) {
        throw new OriginalImmutableError(
          `Original bytes for ${packId}/${documentId} are immutable and cannot be replaced.`,
        );
      }
      throw error;
    }
  }

  async getOriginal(packId: string, documentId: string): Promise<Uint8Array | undefined> {
    try {
      const stored = await readFile(this.pathFor(packId, documentId));
      return new Uint8Array(stored);
    } catch (error) {
      if (isMissingFile(error)) return undefined;
      throw error;
    }
  }

  private pathFor(packId: string, documentId: string): string {
    return join(this.rootDirectory, packId, documentId, 'original.pdf');
  }
}

function originalKey(packId: string, documentId: string): string {
  return `${packId}/${documentId}`;
}

function isAlreadyExists(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'EEXIST';
}

function isMissingFile(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT';
}
