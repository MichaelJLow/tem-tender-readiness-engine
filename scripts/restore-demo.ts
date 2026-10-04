import { parseArgs } from 'node:util';
import { join, resolve } from 'node:path';
import { localSnapshotReader, restoreSnapshot } from './demo-archive.js';
import { s3SnapshotStore } from './s3-snapshot.js';

try {
  const { values } = parseArgs({
    options: {
      from: { type: 'string' },
      output: { type: 'string' },
      snapshot: { type: 'string' },
      bucket: { type: 'string' },
      region: { type: 'string' },
      owner: { type: 'string' },
      profile: { type: 'string' },
    },
  });
  if (!values.output || Boolean(values.from) === Boolean(values.bucket))
    throw new Error(
      'Provide --output and exactly one of --from (local snapshot) or --bucket (S3).',
    );
  if (
    values.bucket
      ? !values.region || !values.owner || !values.snapshot
      : values.region || values.owner || values.snapshot || values.profile
  )
    throw new Error(
      'S3 restore requires --bucket, --region, --owner and --snapshot; --profile is optional.',
    );
  const reader = values.from
    ? localSnapshotReader(values.from)
    : s3SnapshotStore(
        {
          bucket: values.bucket!,
          region: values.region!,
          owner: values.owner!,
          profile: values.profile,
        },
        values.snapshot!,
      );
  // Bind the selected S3 prefix to the manifest; local restores use the manifest's own ID.
  const checkedReader = {
    async read(path: string, maximumBytes: number) {
      const bytes = await reader.read(path, maximumBytes);
      if (path === 'manifest.json' && values.snapshot) {
        const manifest: unknown = JSON.parse(bytes.toString('utf8'));
        if (
          typeof manifest !== 'object' ||
          manifest === null ||
          !('snapshotId' in manifest) ||
          manifest.snapshotId !== values.snapshot
        )
          throw new Error('Snapshot manifest does not match the selected S3 prefix.');
      }
      return bytes;
    },
  };
  const manifest = await restoreSnapshot(checkedReader, values.output);
  console.info(
    JSON.stringify({
      event: 'demo.archive.restored',
      snapshotId: manifest.snapshotId,
      statePath: resolve(join(values.output, 'state/tender-state.json')),
      evalsDirectory: resolve(join(values.output, 'evals')),
      acceptedRunId: manifest.acceptedRunId,
      latestRunId: manifest.latestRunId,
    }),
  );
} catch (error) {
  console.error(error instanceof Error ? error.message : 'Demo restore failed.');
  process.exitCode = 1;
}
