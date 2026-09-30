import { parseArgs } from 'node:util';
import { resolve } from 'node:path';
import {
  localSnapshotReader,
  prepareSnapshot,
  uploadSnapshot,
  verifySnapshot,
} from './demo-archive.js';
import { s3SnapshotStore } from './s3-snapshot.js';

try {
  const { values } = parseArgs({
    options: {
      output: { type: 'string' },
      state: { type: 'string' },
      evals: { type: 'string' },
      source: { type: 'string', multiple: true },
      'api-stopped': { type: 'boolean' },
      synthetic: { type: 'boolean' },
      'upload-existing': { type: 'boolean' },
      bucket: { type: 'string' },
      region: { type: 'string' },
      owner: { type: 'string' },
      profile: { type: 'string' },
    },
  });
  if (!values.output)
    throw new Error(
      'Provide --output with a fresh snapshot directory (or --upload-existing to upload a prepared snapshot).',
    );
  if (
    values['upload-existing'] &&
    (values.state || values.evals || values.source || !values.bucket)
  )
    throw new Error(
      '--upload-existing requires --bucket and cannot select new state, evals or sources.',
    );
  if (
    values.bucket
      ? !values.region || !values.owner
      : values.region || values.owner || values.profile
  )
    throw new Error(
      'For S3 supply --bucket, --region and --owner together; --profile is optional.',
    );
  if (values['upload-existing'] && !values.synthetic)
    throw new Error('Confirm all prepared snapshot content is synthetic with --synthetic.');
  const manifest = values['upload-existing']
    ? (await verifySnapshot(localSnapshotReader(values.output))).manifest
    : await prepareSnapshot({
        statePath: values.state ?? process.env.TENDER_STATE_PATH ?? './data/tender-state.json',
        evalsDirectory: values.evals ?? process.env.EVALS_DIR ?? './evals',
        destination: values.output,
        apiStopped: values['api-stopped'] === true,
        synthetic: values.synthetic === true,
        sources: values.source,
      });
  if (values.bucket)
    await uploadSnapshot(
      values.output,
      s3SnapshotStore(
        {
          bucket: values.bucket,
          region: values.region!,
          owner: values.owner!,
          profile: values.profile,
        },
        manifest.snapshotId,
      ),
    );
  console.info(
    JSON.stringify({
      event: values.bucket ? 'demo.archive.uploaded' : 'demo.archive.prepared',
      snapshotId: manifest.snapshotId,
      directory: resolve(values.output),
      files: manifest.files.length,
      acceptedRunId: manifest.acceptedRunId,
      latestRunId: manifest.latestRunId,
    }),
  );
} catch (error) {
  console.error(error instanceof Error ? error.message : 'Demo archive failed.');
  process.exitCode = 1;
}
