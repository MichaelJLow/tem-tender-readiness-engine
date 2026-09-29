export interface QueueItem {
  runId: string;
  tenderId: string;
  status: string;
  route: string | null;
  createdAt: string;
  updatedAt: string;
  failure: { code: string; message: string; retryable: boolean } | null;
  reviewVersion: number;
  reviewState: 'OPEN' | 'RESOLVED';
  lastReviewEvent: ReviewEvent | null;
}

export interface ReviewEvent {
  eventId: string;
  requestId: string;
  runId: string;
  action: 'REQUEST_INFORMATION' | 'CONFIRM_DUPLICATE' | 'RESOLVE_MANUALLY' | 'REOPEN';
  actor: string;
  reason: string;
  sourceIds: string[];
  reviewVersion: number;
  createdAt: string;
}

export interface RunDetail {
  run: {
    runId: string;
    tenderId: string;
    status: string;
    route?: string;
    createdAt: string;
    updatedAt: string;
    input: {
      tender: {
        customer: { legalName: string };
        broker: { legalName: string };
        sites: {
          siteId: string;
          address: string;
          meterIdentifier?: string;
          annualConsumptionKwh?: number;
          contractEndDate?: string;
        }[];
        documents: { documentId: string; fileName: string; processingStatus?: string }[];
      };
      textSources: { sourceId: string; kind: string; text: string }[];
      signals: {
        dateFacts: {
          factId: string;
          siteId: string;
          value: string;
          credible: boolean;
          evidence: { sourceId: string; sourceType: string; locator?: string }[];
        }[];
      };
    };
    result?: {
      rules: {
        ruleId: string;
        passed: boolean;
        route?: string;
        severity: string;
        reason: string;
        evidence: { sourceId?: string; locator?: string }[];
      }[];
    };
    interpretation?: {
      summary?: string;
      observations?: {
        field: string;
        value: string;
        siteIds: string[];
        evidence: { sourceId: string; quote: string }[];
      }[];
    };
    modelTrace?: { model: string; promptVersion: string; outcome: string; durationMs: number };
    failure?: { code: string; message: string; retryable: boolean };
  };
  reviewEvents: ReviewEvent[];
  reviewState: 'OPEN' | 'RESOLVED';
  reviewVersion: number;
}

export interface MetricRun {
  runId: string;
  reportPath: string;
  startedAt: string;
  completedAt?: string;
  verdict: 'pass' | 'fail' | 'incomplete';
  suiteStatus: string;
  caseCount: number;
  datasetId: string;
  datasetHash: string;
  gitSha: string;
  promptVersion: string;
  provider: string;
  model: string;
  baselineComparison?: { status: string; detail: string };
  metrics: {
    routes: Record<string, { support?: number; precision?: number; recall?: number }>;
    unsafeReady: { count: number | null; denominator: number | null };
    humanReviewRecall: {
      correctlyEscalated: number | null;
      denominator: number | null;
      value: number | null;
    };
    criticalFacts: {
      matched: number | null;
      predicted: number | null;
      expected: number | null;
      precision: number | null;
      recall: number | null;
    };
    gates: { id: string; passed: boolean; detail: string }[];
  };
  studioExperiments: { targetType: 'agent' | 'workflow'; targetId: string; experimentId: string }[];
}

export interface EvalOverview {
  accepted: MetricRun;
  latest: MetricRun | null;
  studioBaseUrl: string;
}

const apiBase = (process.env.TENDER_API_URL ?? 'http://127.0.0.1:3000').replace(/\/$/, '');

export async function apiGet<T>(path: string): Promise<T> {
  const response = await fetch(`${apiBase}${path}`, { cache: 'no-store' });
  if (!response.ok) throw new Error(`Tender API returned ${response.status}.`);
  return (await response.json()) as T;
}

export function getApiBase(): string {
  return apiBase;
}

export function displayDate(value: string): string {
  return new Intl.DateTimeFormat('en-GB', { dateStyle: 'medium', timeStyle: 'short' }).format(
    new Date(value),
  );
}

export function percent(value: number | null | undefined): string {
  return typeof value === 'number' ? `${(value * 100).toFixed(1)}%` : 'Not reported';
}
