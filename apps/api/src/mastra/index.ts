import { mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { Mastra } from '@mastra/core';
import { MastraCompositeStore } from '@mastra/core/storage';
import { DuckDBStore } from '@mastra/duckdb';
import { LibSQLStore } from '@mastra/libsql';
import { MastraStorageExporter, Observability } from '@mastra/observability';
import { createTenderInterpretationAgent } from '../reasoning/interpreter.js';
import { decisionPathEvalWorkflow } from '../../../../evals/decision-workflow.js';
import {
  ambiguityRecallScorer,
  decisionFlagsScorer,
  decisionRouteScorer,
  evidenceFactF1Scorer,
  pricingGuardScorer,
} from '../../../../evals/mastra-scorers.js';

const dataDirectory = resolve(process.env.MASTRA_DATA_DIR ?? join(process.cwd(), 'data'));
mkdirSync(dataDirectory, { recursive: true });
const studioDatabaseUrl = pathToFileURL(join(dataDirectory, 'studio.db')).href;

export const mastra = new Mastra({
  agents: {
    tenderInterpretationAgent: createTenderInterpretationAgent(),
  },
  workflows: {
    decisionPathEvalWorkflow,
  },
  scorers: {
    evidenceFactF1Scorer,
    ambiguityRecallScorer,
    decisionFlagsScorer,
    decisionRouteScorer,
    pricingGuardScorer,
  },
  storage: new MastraCompositeStore({
    id: 'tender-studio-storage',
    default: new LibSQLStore({
      id: 'tender-studio-default',
      url: studioDatabaseUrl,
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
