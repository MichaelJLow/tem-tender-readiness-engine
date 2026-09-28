import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { configureMastraDataDirectory } from './mastra-storage.js';

describe('eval Mastra storage path', () => {
  it('defaults to the storage directory used by this project Studio', () => {
    const env: NodeJS.ProcessEnv = {};
    expect(configureMastraDataDirectory(env, 'C:/repo')).toBe(
      resolve('C:/repo', 'apps/api/src/mastra/public/data'),
    );
  });

  it('respects an explicitly configured storage directory', () => {
    const env: NodeJS.ProcessEnv = { MASTRA_DATA_DIR: 'C:/custom/mastra-data' };
    expect(configureMastraDataDirectory(env, 'C:/repo')).toBe('C:/custom/mastra-data');
  });
});
