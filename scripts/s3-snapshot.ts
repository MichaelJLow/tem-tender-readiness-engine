import { execFile } from 'node:child_process';
import { mkdtemp, readFile, writeFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { z } from 'zod';
import { ArchiveManifestSchema, type SnapshotReader, type SnapshotWriter } from './demo-archive.js';

const execute = promisify(execFile);
const S3OptionsSchema = z.object({
  bucket: z.string().regex(/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/),
  region: z.string().regex(/^[a-z]{2}(?:-[a-z]+)+-\d$/),
  owner: z.string().regex(/^\d{12}$/),
  profile: z
    .string()
    .regex(/^[A-Za-z0-9._-]+$/)
    .optional(),
});
export type S3Options = z.infer<typeof S3OptionsSchema>;

export function s3SnapshotStore(
  rawOptions: S3Options,
  snapshotId: string,
): SnapshotReader & SnapshotWriter {
  const options = S3OptionsSchema.parse(rawOptions);
  const id = ArchiveManifestSchema.shape.snapshotId.parse(snapshotId);
  const common = [
    '--bucket',
    options.bucket,
    '--expected-bucket-owner',
    options.owner,
    '--region',
    options.region,
    '--no-cli-pager',
    '--output',
    'json',
    ...(options.profile ? ['--profile', options.profile] : []),
  ];
  const aws = async (command: string, args: string[]): Promise<string> => {
    try {
      const { stdout } = await execute('aws', ['s3api', command, ...common, ...args], {
        timeout: 120_000,
        maxBuffer: 1024 * 1024,
        windowsHide: true,
        env: { ...process.env, AWS_PAGER: '', AWS_CLI_AUTO_PROMPT: 'off' },
      });
      return stdout;
    } catch (error) {
      // Do not print CLI stderr or the inherited environment; either may contain credentials.
      const missing = error instanceof Error && 'code' in error && error.code === 'ENOENT';
      throw new Error(
        missing
          ? 'AWS CLI v2 is required for S3 archive commands.'
          : `S3 ${command} failed; check profile, permissions, owner, region and object availability.`,
        { cause: error },
      );
    }
  };
  const key = (path: string) => `snapshots/${id}/${path}`;
  return {
    async put(path, bytes) {
      const directory = await mkdtemp(join(tmpdir(), 'tender-s3-upload-'));
      try {
        const file = join(directory, 'object');
        await writeFile(file, bytes, { flag: 'wx' });
        await aws('put-object', [
          '--key',
          key(path),
          '--body',
          file,
          '--if-none-match',
          '*',
          '--server-side-encryption',
          'AES256',
        ]);
      } finally {
        await rm(directory, { recursive: true, force: true });
      }
    },
    async read(path, maximumBytes) {
      const info: unknown = JSON.parse(await aws('head-object', ['--key', key(path)]));
      const size = z
        .object({ ContentLength: z.number().int().nonnegative().max(maximumBytes) })
        .parse(info);
      const directory = await mkdtemp(join(tmpdir(), 'tender-s3-download-'));
      try {
        const file = join(directory, 'object');
        await aws('get-object', ['--key', key(path), file]);
        if ((await stat(file)).size !== size.ContentLength)
          throw new Error('S3 object size changed during download.');
        return await readFile(file);
      } finally {
        await rm(directory, { recursive: true, force: true });
      }
    },
  };
}
