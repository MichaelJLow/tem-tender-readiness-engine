import { createHash, randomUUID } from 'node:crypto';
import { lstat, mkdir, readFile, writeFile } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { z } from 'zod';
import {
  IntakeRequestSchema,
  LocalStateSchema,
  type LocalState,
} from '../apps/api/src/contracts.js';
import {
  AcceptedBaselineSchema,
  readEvalOverview,
  validateAcceptedPointer,
} from '../apps/api/src/eval-reports.js';
import { EvalReportSchema } from '../evals/metrics.js';
import {
  cleanTender,
  conflictingDatesTender,
  missingConsumptionTender,
} from '../tests/fixtures/tenders.js';

const MAX_FILE_BYTES = 16 * 1024 * 1024;
const MAX_TOTAL_BYTES = 64 * 1024 * 1024;
const reportName = /^full-[A-Za-z0-9._-]+\.(json|md)$/;
const sourceName = /^[A-Za-z0-9][A-Za-z0-9._-]*\.(txt|csv|json|pdf)$/;
const snapshotId = z.string().regex(/^snapshot-[0-9TZ-]+-[a-f0-9-]{36}$/);
const memberPath = z
  .string()
  .max(200)
  .refine((path) => {
    if (path === 'state/tender-state.json' || path === 'evals/accepted-baseline.json') return true;
    const segments = path.split('/');
    if (segments.length === 3 && segments[0] === 'evals' && segments[1] === 'reports') {
      return reportName.test(segments[2]!);
    }
    return (
      segments.length === 2 &&
      segments[0] === 'sources' &&
      /^\d{3}-/.test(segments[1]!) &&
      sourceName.test(segments[1]!)
    );
  }, 'Unsupported archive member path.');

export const ArchiveManifestSchema = z
  .object({
    schemaVersion: z.literal(1),
    snapshotId,
    createdAt: z.string().datetime(),
    synthetic: z.literal(true),
    apiStopped: z.literal(true),
    acceptedRunId: z.string().regex(/^full-[A-Za-z0-9._-]+$/),
    latestRunId: z.string().regex(/^full-[A-Za-z0-9._-]+$/),
    files: z
      .array(
        z
          .object({
            path: memberPath,
            size: z.number().int().positive().max(MAX_FILE_BYTES),
            sha256: z.string().regex(/^[a-f0-9]{64}$/),
          })
          .strict(),
      )
      .min(3)
      .max(32),
  })
  .strict()
  .superRefine((manifest, context) => {
    const paths = manifest.files.map((file) => file.path);
    const required = [
      'state/tender-state.json',
      'evals/accepted-baseline.json',
      `evals/reports/${manifest.acceptedRunId}.json`,
      `evals/reports/${manifest.latestRunId}.json`,
    ];
    if (new Set(paths).size !== paths.length || required.some((path) => !paths.includes(path))) {
      context.addIssue({
        code: 'custom',
        message: 'Manifest has duplicate or missing required files.',
      });
    }
    const allowedReports = new Set([manifest.acceptedRunId, manifest.latestRunId]);
    if (
      paths.some(
        (path) =>
          path.startsWith('evals/reports/') &&
          !allowedReports.has(basename(path).replace(/\.(json|md)$/, '')),
      )
    ) {
      context.addIssue({ code: 'custom', message: 'Manifest contains an unselected eval report.' });
    }
    if (manifest.files.reduce((sum, file) => sum + file.size, 0) > MAX_TOTAL_BYTES) {
      context.addIssue({ code: 'custom', message: 'Snapshot exceeds the 64 MiB demo limit.' });
    }
  });
export type ArchiveManifest = z.infer<typeof ArchiveManifestSchema>;
export interface SnapshotReader {
  read(path: string, maximumBytes: number): Promise<Buffer>;
}
export interface SnapshotWriter {
  put(path: string, bytes: Buffer): Promise<void>;
}

function sha256(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}
function json(bytes: Buffer): unknown {
  return JSON.parse(bytes.toString('utf8')) as unknown;
}

function rejectCredentials(bytes: Buffer): void {
  // This catches common accidental credentials; synthetic-data attestation is still required.
  if (
    /-----BEGIN (?:[A-Z ]+ )?PRIVATE KEY-----|\b(?:AKIA|ASIA)[A-Z0-9]{16}\b|\bsk-(?:or-v1-|proj-)?[A-Za-z0-9_-]{20,}|\bgh[pousr]_[A-Za-z0-9]{20,}/.test(
      bytes.toString('utf8'),
    )
  ) {
    throw new Error('Possible credential detected; snapshot refused.');
  }
}

export function validateDemoState(value: unknown): LocalState {
  const state = LocalStateSchema.parse(value);
  const fixtures = [cleanTender, missingConsumptionTender, conflictingDatesTender];
  const expectedRoutes = ['READY_FOR_PRICING', 'NEEDS_INFORMATION', 'HUMAN_REVIEW'];
  if (
    state.runs.length !== fixtures.length ||
    new Set(state.runs.map((run) => run.runId)).size !== fixtures.length
  ) {
    throw new Error('Snapshot must contain exactly the three seeded synthetic demo cases.');
  }
  fixtures.forEach((fixture, index) => {
    const run = state.runs.find((item) => item.tenderId === fixture.tender.tenderId);
    const expectedInput = IntakeRequestSchema.parse({ ...fixture, textSources: [] });
    if (
      !run ||
      JSON.stringify(run.input) !== JSON.stringify(expectedInput) ||
      run.status !== 'COMPLETED' ||
      run.route !== expectedRoutes[index] ||
      run.result?.route !== run.route
    ) {
      throw new Error('Snapshot does not match the completed synthetic Console walkthrough.');
    }
  });
  const ready = state.runs.find((run) => run.route === 'READY_FOR_PRICING')!;
  if (
    state.handoffs.length !== 1 ||
    state.handoffs[0]!.runId !== ready.runId ||
    state.handoffs[0]!.tenderId !== ready.tenderId
  ) {
    throw new Error('Snapshot must retain exactly one ready-only mocked pricing handoff.');
  }
  const missing = state.runs.find((run) => run.route === 'NEEDS_INFORMATION')!;
  const receipts = state.informationRequestReceipts;
  if (
    receipts.length > 1 ||
    receipts.some(
      (receipt) =>
        receipt.runId !== missing.runId ||
        receipt.key !== `information-request:${missing.runId}` ||
        receipt.deliveryStatus !== 'NOT_SENT',
    )
  ) {
    throw new Error(
      'Snapshot may retain at most one synthetic information-request receipt for the missing-information case.',
    );
  }
  const review = state.runs.find((run) => run.route === 'HUMAN_REVIEW')!;
  const allowedSources = new Set(['site-001', 'contract-a', 'contract-b']);
  const requestIds = new Set<string>();
  const eventIds = new Set<string>();
  state.reviewEvents.forEach((event, index) => {
    const previous = state.reviewEvents[index - 1];
    const open = !previous || previous.action === 'REOPEN';
    if (
      event.runId !== review.runId ||
      event.reviewVersion !== index + 1 ||
      requestIds.has(event.requestId) ||
      eventIds.has(event.eventId) ||
      event.sourceIds.some((source) => !allowedSources.has(source)) ||
      (event.action === 'REOPEN' ? open : !open)
    ) {
      throw new Error('Snapshot contains inconsistent review audit history.');
    }
    requestIds.add(event.requestId);
    eventIds.add(event.eventId);
  });
  if (
    !state.reviewEvents.some(
      (event) =>
        event.action === 'REQUEST_INFORMATION' &&
        [...allowedSources].every((source) => event.sourceIds.includes(source)),
    )
  ) {
    throw new Error(
      'Record a REQUEST_INFORMATION disposition citing site-001, contract-a and contract-b before archiving.',
    );
  }
  return state;
}

function validateBundle(manifest: ArchiveManifest, files: Map<string, Buffer>): void {
  for (const file of manifest.files) {
    const bytes = files.get(file.path);
    if (!bytes || bytes.length !== file.size || sha256(bytes) !== file.sha256)
      throw new Error(`Checksum or size mismatch: ${file.path}`);
    rejectCredentials(bytes);
  }
  validateDemoState(json(files.get('state/tender-state.json')!));
  const pointer = AcceptedBaselineSchema.parse(json(files.get('evals/accepted-baseline.json')!));
  const accepted = EvalReportSchema.parse(
    json(files.get(`evals/reports/${manifest.acceptedRunId}.json`)!),
  );
  const latest = EvalReportSchema.parse(
    json(files.get(`evals/reports/${manifest.latestRunId}.json`)!),
  );
  validateAcceptedPointer(pointer, accepted);
  if (
    pointer.report !== `reports/${manifest.acceptedRunId}.json` ||
    accepted.runId !== manifest.acceptedRunId ||
    latest.runId !== manifest.latestRunId ||
    accepted.verdict !== 'pass' ||
    accepted.runType !== 'release' ||
    accepted.suiteStatus !== 'completed' ||
    latest.runType !== 'release' ||
    latest.suiteStatus !== 'completed' ||
    latest.startedAt < accepted.startedAt
  ) {
    throw new Error('Snapshot eval selection is inconsistent or incomplete.');
  }
}

async function readRegularFile(path: string, maximumBytes: number): Promise<Buffer> {
  const info = await lstat(path);
  if (!info.isFile() || info.isSymbolicLink() || info.size > maximumBytes)
    throw new Error('Expected a regular file within the demo size limit.');
  const bytes = await readFile(path);
  if (bytes.length > maximumBytes) throw new Error('File exceeds the demo size limit.');
  return bytes;
}

export function localSnapshotReader(directory: string): SnapshotReader {
  const root = resolve(directory);
  return {
    async read(path, maximumBytes) {
      if (path !== 'manifest.json') memberPath.parse(path);
      let current = root;
      for (const segment of ['', ...path.split('/').slice(0, -1)]) {
        if (segment) current = join(current, segment);
        const info = await lstat(current);
        if (!info.isDirectory() || info.isSymbolicLink())
          throw new Error('Snapshot directory cannot contain symbolic links.');
      }
      return readRegularFile(join(root, path), maximumBytes);
    },
  };
}

export async function verifySnapshot(
  reader: SnapshotReader,
): Promise<{ manifest: ArchiveManifest; files: Map<string, Buffer> }> {
  const manifest = ArchiveManifestSchema.parse(json(await reader.read('manifest.json', 64 * 1024)));
  const files = new Map<string, Buffer>();
  for (const file of manifest.files) files.set(file.path, await reader.read(file.path, file.size));
  validateBundle(manifest, files);
  return { manifest, files };
}

async function writeFreshDirectory(
  destination: string,
  manifest: ArchiveManifest,
  files: Map<string, Buffer>,
): Promise<void> {
  // Exclusive directory creation reserves the destination; an existing directory is never used.
  await mkdir(destination);
  for (const [path, bytes] of files) {
    const target = join(destination, path);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, bytes, { flag: 'wx' });
  }
  // A partial write has no completion manifest and cannot be restored as a snapshot.
  await writeFile(join(destination, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, {
    flag: 'wx',
  });
}

export async function prepareSnapshot(options: {
  statePath: string;
  evalsDirectory: string;
  destination: string;
  apiStopped: boolean;
  synthetic: boolean;
  sources?: string[];
}): Promise<ArchiveManifest> {
  if (!options.apiStopped || !options.synthetic)
    throw new Error('Confirm the API is stopped and all snapshot content is synthetic.');
  const files = new Map<string, Buffer>();
  const addBytes = (path: string, bytes: Buffer) => {
    if (
      files.size >= 32 ||
      [...files.values()].reduce((total, entry) => total + entry.length, bytes.length) >
        MAX_TOTAL_BYTES
    ) {
      throw new Error('Snapshot exceeds the file count or 64 MiB demo limit.');
    }
    files.set(path, bytes);
  };
  addBytes(
    'state/tender-state.json',
    await readRegularFile(resolve(options.statePath), MAX_FILE_BYTES),
  );
  const overview = await readEvalOverview(resolve(options.evalsDirectory));
  if (!overview.latest) throw new Error('No completed full eval report is available.');
  const add = async (path: string) => {
    const bytes = await readRegularFile(join(options.evalsDirectory, path), MAX_FILE_BYTES);
    addBytes(`evals/${path}`, bytes);
  };
  await add('accepted-baseline.json');
  for (const reportPath of new Set([overview.accepted.reportPath, overview.latest.reportPath])) {
    await add(reportPath);
    const summaryPath = reportPath.replace(/\.json$/, '.md');
    try {
      await add(summaryPath);
    } catch (error) {
      if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error;
    }
  }
  for (const [index, source] of (options.sources ?? []).entries()) {
    const name = basename(source);
    if (!sourceName.test(name))
      throw new Error(
        'Source files must be explicitly selected synthetic TXT, CSV, JSON or PDF files.',
      );
    addBytes(
      `sources/${String(index + 1).padStart(3, '0')}-${name}`,
      await readRegularFile(resolve(source), MAX_FILE_BYTES),
    );
  }
  const now = new Date().toISOString();
  const manifest = ArchiveManifestSchema.parse({
    schemaVersion: 1,
    snapshotId: `snapshot-${now.replace(/[.:]/g, '-')}-${randomUUID()}`,
    createdAt: now,
    synthetic: true,
    apiStopped: true,
    acceptedRunId: overview.accepted.runId,
    latestRunId: overview.latest.runId,
    files: [...files].map(([path, bytes]) => ({ path, size: bytes.length, sha256: sha256(bytes) })),
  });
  validateBundle(manifest, files);
  await writeFreshDirectory(resolve(options.destination), manifest, files);
  return manifest;
}

export async function uploadSnapshot(
  directory: string,
  writer: SnapshotWriter,
): Promise<ArchiveManifest> {
  const { manifest, files } = await verifySnapshot(localSnapshotReader(directory));
  for (const [path, bytes] of files) await writer.put(path, bytes);
  await writer.put('manifest.json', Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`));
  return manifest;
}

export async function restoreSnapshot(
  reader: SnapshotReader,
  destination: string,
): Promise<ArchiveManifest> {
  const { manifest, files } = await verifySnapshot(reader);
  await writeFreshDirectory(resolve(destination), manifest, files);
  return manifest;
}
