import { createHash, randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { createReadStream, createWriteStream } from 'node:fs';
import { chmod, lstat, mkdir, mkdtemp, readFile, rename, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { promisify } from 'node:util';
import { WorkerError, requirePrivateDirectory } from './diagnostics.mjs';

const execute = promisify(execFile);
const hash = bytes => createHash('sha256').update(bytes).digest('hex');

export async function readArtifactNodeRuntime(directory, manifest) {
  if (!manifest.runtime) return null;
  const pin = manifest.runtime;
  const file = manifest.files.find(file => file.path === pin.metadataPath);
  if (!file || pin.metadataPath !== 'artifacts/node-runtime.json' || file.size > 16384) throw new WorkerError('node_runtime_metadata_invalid');
  const path = join(directory, pin.metadataPath);
  if (!(await lstat(path)).isFile()) throw new WorkerError('node_runtime_metadata_invalid');
  const bytes = await readFile(path);
  if (bytes.length !== file.size || hash(bytes) !== file.sha256) throw new WorkerError('node_runtime_metadata_checksum_mismatch');
  const metadata = JSON.parse(bytes);
  if (metadata.version !== pin.version || metadata.archive?.sha256 !== pin.archiveSha256
    || metadata.nodeExecutable?.sha256 !== pin.executableSha256) throw new WorkerError('node_runtime_metadata_mismatch');
  return metadata;
}

async function verifyNode(path, metadata, signal) {
  const info = await lstat(path);
  if (!info.isFile() || info.size !== metadata.nodeExecutable.bytes || (info.mode & 0o022)) throw new WorkerError('node_runtime_executable_size_mismatch');
  const digest = createHash('sha256');
  for await (const bytes of createReadStream(path)) { signal?.throwIfAborted(); digest.update(bytes); }
  if (digest.digest('hex') !== metadata.nodeExecutable.sha256) throw new WorkerError('node_runtime_executable_checksum_mismatch');
  const result = await execute(path, ['--version'], { signal, timeout: 10_000, maxBuffer: 4096 });
  if (result.stdout.trim() !== metadata.version) throw new WorkerError('node_runtime_version_mismatch');
}

/** The signed release's pinned archive and executable must both match before activation. */
export async function installPinnedNodeRuntime(root, metadata, { fetchRuntime = fetch, signal } = {}) {
  if (metadata.format !== 1 || metadata.runtime !== 'node' || metadata.platform !== process.platform || metadata.arch !== process.arch
    || !/^v\d+\.\d+\.\d+$/.test(metadata.version) || !/^[a-f0-9]{64}$/.test(metadata.archive?.sha256)
    || !/^[a-f0-9]{64}$/.test(metadata.nodeExecutable?.sha256)
    || !Number.isSafeInteger(metadata.archive.bytes) || metadata.archive.bytes <= 0 || metadata.archive.bytes > 64 * 1024 * 1024
    || !Number.isSafeInteger(metadata.nodeExecutable.bytes) || metadata.nodeExecutable.bytes <= 0 || metadata.nodeExecutable.bytes > 128 * 1024 * 1024
    || metadata.nodeExecutable.archivePath !== `node-${metadata.version}-linux-x64/bin/node`
    || !metadata.archive.url.startsWith(`https://nodejs.org/dist/${metadata.version}/`) && !metadata.archive.url.startsWith(`https://nodejs.org/download/release/${metadata.version}/`)) throw new WorkerError('node_runtime_metadata_invalid');
  await mkdir(root, { recursive: true, mode: 0o700 });
  await requirePrivateDirectory(root);
  const installed = join(root, `${metadata.version}-${metadata.nodeExecutable.sha256}`), node = join(installed, 'bin/node');
  try { await verifyNode(node, metadata, signal); return node; }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  const stage = await mkdtemp(join(root, '.node-'));
  try {
    const response = await fetchRuntime(metadata.archive.url, { signal: AbortSignal.any([AbortSignal.timeout(600_000), ...(signal ? [signal] : [])]) });
    if (!response.ok || !response.body) throw new WorkerError('node_runtime_download_failed');
    const digest = createHash('sha256');
    let size = 0;
    const archive = join(stage, 'archive');
    await pipeline(Readable.fromWeb(response.body), new Transform({ transform(bytes, _encoding, done) {
      size += bytes.length;
      if (size > metadata.archive.bytes) { done(new WorkerError('node_runtime_archive_size_mismatch')); return; }
      digest.update(bytes); done(null, bytes);
    } }), createWriteStream(archive, { flags: 'wx', mode: 0o600 }), { signal });
    if (size !== metadata.archive.bytes) throw new WorkerError('node_runtime_archive_size_mismatch');
    if (digest.digest('hex') !== metadata.archive.sha256) throw new WorkerError('node_runtime_archive_checksum_mismatch');
    await execute('/usr/bin/tar', ['-xf', archive, '-C', stage, '--no-same-owner', '--no-same-permissions', metadata.nodeExecutable.archivePath],
      { signal, timeout: 60_000, maxBuffer: 4096 });
    const extracted = join(stage, metadata.nodeExecutable.archivePath);
    await chmod(extracted, 0o500);
    await verifyNode(extracted, metadata, signal);
    const ready = join(stage, `ready-${randomUUID()}`);
    await mkdir(join(ready, 'bin'), { recursive: true, mode: 0o700 });
    await rename(extracted, join(ready, 'bin/node'));
    await rename(ready, installed);
    return node;
  } finally { await rm(stage, { recursive: true, force: true }); }
}
