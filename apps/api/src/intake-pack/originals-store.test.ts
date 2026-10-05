import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  FileIntakeOriginalsStore,
  MemoryIntakeOriginalsStore,
  OriginalImmutableError,
} from './originals-store.js';

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe('Intake pack originals store', () => {
  it('keeps original bytes immutable in memory', async () => {
    const store = new MemoryIntakeOriginalsStore();
    const bytes = new Uint8Array([1, 2, 3]);
    await store.putOriginal('pack-1', 'doc-1', bytes);
    bytes[0] = 9;
    expect(await store.getOriginal('pack-1', 'doc-1')).toEqual(new Uint8Array([1, 2, 3]));
    await expect(store.putOriginal('pack-1', 'doc-1', new Uint8Array([4]))).rejects.toBeInstanceOf(
      OriginalImmutableError,
    );
  });

  it('writes original files once on disk', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'intake-originals-'));
    directories.push(directory);
    const store = new FileIntakeOriginalsStore(directory);
    await store.putOriginal('pack-1', 'doc-1', new Uint8Array([10, 11]));
    expect(await store.getOriginal('pack-1', 'doc-1')).toEqual(new Uint8Array([10, 11]));
    await expect(store.putOriginal('pack-1', 'doc-1', new Uint8Array([12]))).rejects.toBeInstanceOf(
      OriginalImmutableError,
    );
  });
});
