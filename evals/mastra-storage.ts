import { resolve } from 'node:path';

export function configureMastraDataDirectory(env: NodeJS.ProcessEnv, repositoryRoot: string) {
  if (!env.MASTRA_DATA_DIR?.trim()) {
    env.MASTRA_DATA_DIR = resolve(repositoryRoot, 'apps/api/src/mastra/public/data');
  }
  return env.MASTRA_DATA_DIR;
}
