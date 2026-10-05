import { mkdtemp, mkdir, readFile, rm, writeFile, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { FileStateStore, JsonFileTenderRepository } from '../apps/api/src/file-repository.js';
import { MockPricingGateway } from '../apps/api/src/pricing-gateway.js';
import { TenderService } from '../apps/api/src/service.js';
import { readEvalOverview } from '../apps/api/src/eval-reports.js';
import {
  cleanTender,
  conflictingDatesTender,
  missingConsumptionTender,
} from '../tests/fixtures/tenders.js';
import {
  ArchiveManifestSchema,
  localSnapshotReader,
  prepareSnapshot,
  restoreSnapshot,
  uploadSnapshot,
  verifySnapshot,
} from './demo-archive.js';
import { s3SnapshotStore } from './s3-snapshot.js';

let directory: string;
let statePath: string;
let stateStore: FileStateStore;
let prepared: string;
const evalsDirectory = resolve('evals');

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'tender-demo-archive-'));
  statePath = join(directory, 'state.json');
  prepared = join(directory, 'prepared');
  stateStore = new FileStateStore(statePath);
  const repository = new JsonFileTenderRepository(stateStore);
  const service = new TenderService(repository, new MockPricingGateway(repository));
  await service.submit(cleanTender, 'archive-ready');
  await service.submit(missingConsumptionTender, 'archive-missing');
  const review = await service.submit(conflictingDatesTender, 'archive-conflict');
  await service.recordReviewEvent(
    {
      eventId: randomUUID(),
      runId: review.runId,
      actor: 'Synthetic demo reviewer',
      createdAt: new Date().toISOString(),
      reviewVersion: 1,
      requestId: 'archive-review-001',
      action: 'REQUEST_INFORMATION',
      reason:
        'Please confirm the end date: site-001 and contract-a say 2027-03-31; contract-b says 30/09/2026.',
      sourceIds: ['site-001', 'contract-a', 'contract-b'],
    },
    0,
  );
});

afterEach(async () => {
  await rm(directory, { recursive: true, force: true });
});

async function prepare() {
  return prepareSnapshot({
    statePath,
    evalsDirectory,
    destination: prepared,
    apiStopped: true,
    synthetic: true,
  });
}

async function changeMember(path: string, change: (value: unknown) => unknown) {
  const manifest = ArchiveManifestSchema.parse(
    JSON.parse(await readFile(join(prepared, 'manifest.json'), 'utf8')) as unknown,
  );
  const target = join(prepared, path);
  const bytes = Buffer.from(
    JSON.stringify(change(JSON.parse(await readFile(target, 'utf8')) as unknown)),
  );
  await writeFile(target, bytes);
  const member = manifest.files.find((file) => file.path === path)!;
  member.size = bytes.length;
  member.sha256 = createHash('sha256').update(bytes).digest('hex');
  await writeFile(join(prepared, 'manifest.json'), JSON.stringify(manifest));
}

describe('synthetic demo archive', () => {
  it('restores exact state, audit and separate accepted/latest reports without reprocessing tenders', async () => {
    const original = await readFile(statePath);
    const baseline = await readFile(join(evalsDirectory, 'accepted-baseline.json'));
    const manifest = await prepare();
    expect(manifest.acceptedRunId).not.toBe(manifest.latestRunId);
    const restored = join(directory, 'restored');
    await restoreSnapshot(localSnapshotReader(prepared), restored);
    expect(await readFile(join(restored, 'state/tender-state.json'))).toEqual(original);
    expect(await readFile(statePath)).toEqual(original);
    expect(await readFile(join(restored, 'evals/accepted-baseline.json'))).toEqual(baseline);
    const state = await new FileStateStore(join(restored, 'state/tender-state.json')).read();
    expect(state.runs.map((run) => run.route)).toEqual([
      'READY_FOR_PRICING',
      'NEEDS_INFORMATION',
      'HUMAN_REVIEW',
    ]);
    expect(state.reviewEvents[0]?.sourceIds).toEqual(['site-001', 'contract-a', 'contract-b']);
    expect(state.handoffs).toHaveLength(1);
    const overview = await readEvalOverview(join(restored, 'evals'));
    expect(overview.accepted.runId).toBe(manifest.acceptedRunId);
    expect(overview.latest?.runId).toBe(manifest.latestRunId);
    expect(overview.accepted.metrics.criticalFacts.matched).toBe(49);
    expect(overview.latest?.metrics.criticalFacts.matched).toBe(49);
  });

  it('requires stopped-API and synthetic attestations before creating a snapshot', async () => {
    for (const confirmations of [
      { apiStopped: false, synthetic: true },
      { apiStopped: true, synthetic: false },
    ]) {
      await expect(
        prepareSnapshot({ statePath, evalsDirectory, destination: prepared, ...confirmations }),
      ).rejects.toThrow('Confirm');
    }
    await expect(access(prepared)).rejects.toThrow();
  });

  it('never overwrites an existing destination', async () => {
    await prepare();
    const existing = join(directory, 'existing');
    await mkdir(existing);
    await writeFile(join(existing, 'keep.txt'), 'preserve');
    await expect(restoreSnapshot(localSnapshotReader(prepared), existing)).rejects.toThrow();
    expect(await readFile(join(existing, 'keep.txt'), 'utf8')).toBe('preserve');
    await expect(prepare()).rejects.toThrow();
  });

  it('rejects changed bytes before creating the restore directory', async () => {
    await prepare();
    await writeFile(join(prepared, 'state/tender-state.json'), '{}');
    const destination = join(directory, 'restored');
    await expect(restoreSnapshot(localSnapshotReader(prepared), destination)).rejects.toThrow(
      'Checksum',
    );
    await expect(access(destination)).rejects.toThrow();
  });

  it('rejects malformed state even when its checksum has been updated', async () => {
    await prepare();
    await changeMember('state/tender-state.json', () => ({ version: 99 }));
    await expect(verifySnapshot(localSnapshotReader(prepared))).rejects.toThrow();
  });

  it('rejects unsafe handoffs and absent review audit', async () => {
    const original = await stateStore.read();
    const wrong = structuredClone(original);
    wrong.handoffs[0]!.runId = wrong.runs.find((run) => run.route === 'HUMAN_REVIEW')!.runId;
    await stateStore.write(wrong);
    await expect(prepare()).rejects.toThrow('ready-only');
    await stateStore.write({ ...original, reviewEvents: [] });
    await expect(prepare()).rejects.toThrow('REQUEST_INFORMATION');
  });

  it('rejects a foreign tender even if it reuses a known synthetic tender ID', async () => {
    const state = await stateStore.read();
    state.runs[0]!.input.tender.customer.legalName = 'Real customer';
    await stateStore.write(state);
    await expect(prepare()).rejects.toThrow('synthetic Console');
  });

  it('rejects broken review versions and evidence references', async () => {
    const state = await stateStore.read();
    state.reviewEvents[0]!.reviewVersion = 7;
    await stateStore.write(state);
    await expect(prepare()).rejects.toThrow('audit history');
    state.reviewEvents[0]!.reviewVersion = 1;
    state.reviewEvents[0]!.sourceIds.push('unknown-document');
    await stateStore.write(state);
    await expect(prepare()).rejects.toThrow('audit history');
  });

  it('fails visibly on a missing member before creating the restore directory', async () => {
    await prepare();
    const localReader = localSnapshotReader(prepared);
    const missingMemberReader = {
      async read(path: string, maximumBytes: number) {
        if (path === 'state/tender-state.json') throw new Error('Object not found.');
        return localReader.read(path, maximumBytes);
      },
    };
    const destination = join(directory, 'missing-member-restore');
    await expect(restoreSnapshot(missingMemberReader, destination)).rejects.toThrow(
      'Object not found.',
    );
    await expect(access(destination)).rejects.toThrow();

    await rm(join(prepared, 'manifest.json'));
    await expect(verifySnapshot(localSnapshotReader(prepared))).rejects.toThrow();
    // A failed/partial snapshot stays available for diagnosis but cannot be restored.
    await expect(access(join(prepared, 'state/tender-state.json'))).resolves.toBeUndefined();
  });

  it('publishes the manifest last and never marks an interrupted upload complete', async () => {
    await prepare();
    const paths: string[] = [];
    await uploadSnapshot(prepared, {
      async put(path) {
        paths.push(path);
      },
    });
    expect(paths.at(-1)).toBe('manifest.json');
    const interrupted: string[] = [];
    await expect(
      uploadSnapshot(prepared, {
        async put(path) {
          interrupted.push(path);
          if (interrupted.length === 2) throw new Error('Storage unavailable');
        },
      }),
    ).rejects.toThrow('Storage unavailable');
    expect(interrupted).not.toContain('manifest.json');
  });

  it('rejects traversal, duplicate paths, missing required members and excessive sizes', async () => {
    const manifest = await prepare();
    for (const path of [
      '../state.json',
      'sources/../outside.json',
      'C:/outside.json',
      'sources/001-.env',
      'sources\\outside.json',
    ]) {
      expect(
        ArchiveManifestSchema.safeParse({
          ...manifest,
          files: [{ ...manifest.files[0]!, path }, ...manifest.files.slice(1)],
        }).success,
      ).toBe(false);
    }
    expect(
      ArchiveManifestSchema.safeParse({
        ...manifest,
        files: [...manifest.files, manifest.files[0]],
      }).success,
    ).toBe(false);
    expect(
      ArchiveManifestSchema.safeParse({ ...manifest, files: manifest.files.slice(1) }).success,
    ).toBe(false);
    expect(
      ArchiveManifestSchema.safeParse({
        ...manifest,
        files: [{ ...manifest.files[0]!, size: 17 * 1024 * 1024 }, ...manifest.files.slice(1)],
      }).success,
    ).toBe(false);
  });

  it('rejects a mismatched accepted pointer and malformed report with valid checksums', async () => {
    const manifest = await prepare();
    await changeMember('evals/accepted-baseline.json', (value) => ({
      ...(value as object),
      datasetHash: 'a'.repeat(64),
    }));
    await expect(verifySnapshot(localSnapshotReader(prepared))).rejects.toThrow('pointer');
    await changeMember(`evals/reports/${manifest.latestRunId}.json`, () => ({}));
    await expect(verifySnapshot(localSnapshotReader(prepared))).rejects.toThrow();
  });

  it('archives only individually selected source files and rejects common credentials', async () => {
    const source = join(directory, 'synthetic-note.txt');
    await writeFile(source, 'Synthetic demo source: site-001 ends on 2027-03-31.');
    const manifest = await prepareSnapshot({
      statePath,
      evalsDirectory,
      destination: prepared,
      sources: [source],
      apiStopped: true,
      synthetic: true,
    });
    expect(manifest.files.some((file) => file.path === 'sources/001-synthetic-note.txt')).toBe(
      true,
    );
    await writeFile(source, `sk-or-v1-${'x'.repeat(40)}`);
    await expect(
      prepareSnapshot({
        statePath,
        evalsDirectory,
        destination: join(directory, 'with-secret'),
        sources: [source],
        apiStopped: true,
        synthetic: true,
      }),
    ).rejects.toThrow('credential');
    const env = join(directory, '.env');
    await writeFile(env, 'PRIVATE=true');
    await expect(
      prepareSnapshot({
        statePath,
        evalsDirectory,
        destination: join(directory, 'with-env'),
        sources: [env],
        apiStopped: true,
        synthetic: true,
      }),
    ).rejects.toThrow('explicitly selected');
  });

  it('validates S3 account, region and snapshot prefix before any external call', () => {
    expect(() =>
      s3SnapshotStore(
        { bucket: 'demo-private-bucket', region: 'eu-west-2', owner: 'invalid' },
        'snapshot-2026-09-30T10-00-00-000Z-12345678-1234-1234-1234-123456789abc',
      ),
    ).toThrow();
    expect(() =>
      s3SnapshotStore(
        { bucket: 'demo-private-bucket', region: 'eu-west-2', owner: '123456789012' },
        '../outside',
      ),
    ).toThrow();
  });
});
