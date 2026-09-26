import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { Mastra } from '@mastra/core';
import { MastraCompositeStore } from '@mastra/core/storage';
import { DuckDBStore } from '@mastra/duckdb';
import { LibSQLStore } from '@mastra/libsql';
import { MastraStorageExporter, Observability } from '@mastra/observability';
import { createTenderInterpretationAgent } from '../reasoning/interpreter.js';

const dataDirectory = join(process.cwd(), 'data');
mkdirSync(dataDirectory, { recursive: true });

export const mastra = new Mastra({
  agents: {
    tenderInterpretationAgent: createTenderInterpretationAgent(),
  },
  storage: new MastraCompositeStore({
    id: 'tender-studio-storage',
    default: new LibSQLStore({
      id: 'tender-studio-default',
      url: 'file:./data/studio.db',
    }),
    domains: {
      observability: await new DuckDBStore({
        path: join(dataDirectory, 'studio-observability.duckdb'),
      }).getStore('observability'),
    },
  }),
  observability: new Observability({
    configs: {
      default: {
        serviceName: 'tem-tender-readiness',
        exporters: [new MastraStorageExporter()],
        logging: { enabled: true, level: 'info' },
      },
    },
  }),
});
