import type { Dataset } from '@mastra/core/datasets';
import type { Mastra } from '@mastra/core';
import { hashEvalDataset } from './metrics.js';
import { evalDataset, evalCases, pullRequestCases } from './cases.js';
import type { EvalCase } from './schema.js';

type DatasetTarget = 'agent' | 'workflow';

function asItems(value: Awaited<ReturnType<Dataset['listItems']>>) {
  if (Array.isArray(value)) return value;
  return value.items;
}

function agentPrompt(testCase: EvalCase): string {
  return JSON.stringify({
    tender: {
      tenderId: testCase.input.tender.tenderId,
      customerName: testCase.input.tender.customer.legalName,
      sites: testCase.input.tender.sites.map((site) => ({
        siteId: site.siteId,
        address: site.address,
        meterIdentifier: site.meterIdentifier,
        annualConsumptionKwh: site.annualConsumptionKwh,
        contractEndDate: site.contractEndDate,
      })),
      documents: testCase.input.tender.documents.map((document) => ({
        documentId: document.documentId,
        fileName: document.fileName,
      })),
    },
    sources: testCase.input.textSources.map((source) => ({
      sourceId: source.sourceId,
      kind: source.kind,
      documentId: source.documentId,
      text: source.text,
    })),
  });
}

function itemPayloads(target: DatasetTarget, cases: readonly EvalCase[]) {
  return cases.map((testCase) => ({
    externalId: testCase.id,
    input: target === 'agent' ? agentPrompt(testCase) : jsonSerializable(testCase),
    groundTruth:
      target === 'agent'
        ? { expectedFacts: testCase.expected.facts, expectedAmbiguous: testCase.expected.ambiguous }
        : testCase.expected,
    metadata: {
      caseId: testCase.id,
      category: testCase.category,
      safetySet: testCase.safetySet,
      synthetic: true,
      schemaVersion: evalDataset.schemaVersion,
    },
    source: { type: 'json' as const, referenceId: 'evals/cases.ts' },
  }));
}

function jsonSerializable<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

export async function ensureStudioDataset(args: {
  mastra: Mastra;
  target: DatasetTarget;
  cases: readonly EvalCase[];
  targetId: string;
}) {
  const snapshot = {
    schemaVersion: evalDataset.schemaVersion,
    datasetId: evalDataset.datasetId,
    cases: [...args.cases],
  };
  const datasetHash = hashEvalDataset(snapshot);
  const version = datasetHash.slice(0, 12);
  const name = `Tender readiness ${args.target} ${version}`;
  const datasetId = `tender-readiness-${args.target}-${version}`;
  const listed = await args.mastra.datasets.list({ perPage: 100, filters: { name } });
  const existing = listed.datasets.find((dataset) => dataset.id === datasetId);
  const payloads = itemPayloads(args.target, args.cases);
  const dataset = existing
    ? await args.mastra.datasets.get({ id: existing.id })
    : await args.mastra.datasets.create({
        id: datasetId,
        name,
        description: `Immutable synthetic ${args.target} evaluation dataset. SHA-256 ${datasetHash}.`,
        metadata: {
          datasetId: evalDataset.datasetId,
          datasetHash,
          schemaVersion: 1,
          synthetic: true,
        },
        targetType: args.target,
        targetIds: [args.targetId],
      });

  const items = asItems(await dataset.listItems({ perPage: 1_000 }));
  if (items.length === 0) {
    await dataset.addItems({ items: payloads });
  } else {
    const byExternalId = new Map(items.map((item) => [item.externalId, item]));
    const same =
      items.length === payloads.length &&
      payloads.every((payload) => {
        const stored = byExternalId.get(payload.externalId);
        return (
          stored &&
          JSON.stringify(stored.input) === JSON.stringify(payload.input) &&
          JSON.stringify(stored.groundTruth) === JSON.stringify(payload.groundTruth)
        );
      });
    if (!same) {
      throw new Error(
        `Studio dataset ${datasetId} differs from the immutable canonical eval snapshot.`,
      );
    }
  }
  return { dataset, datasetHash, datasetId, version, caseCount: payloads.length };
}

export function selectEvalCases(suite: 'pr' | 'full') {
  return suite === 'pr' ? pullRequestCases : evalCases;
}

export function selectAgentCases(cases: readonly EvalCase[]) {
  return cases.filter(
    (testCase) => testCase.input.textSources.length > 0 && testCase.expected.route !== 'DUPLICATE',
  );
}
