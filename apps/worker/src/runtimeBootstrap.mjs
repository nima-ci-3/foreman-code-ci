import { basename, dirname, join, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { setTimeout as wait } from 'node:timers/promises';
import { installPinnedNodeRuntime, readArtifactNodeRuntime } from './nodeRuntime.mjs';
import { locateWorkerLaunch, migrateWorkerService, readUpdateRecord } from './updateSupervisor.mjs';
import { WorkerError, workerUpdateErrorMessage } from './diagnostics.mjs';

async function persistConfirmedRuntime(directory, manifestSha256, stateDirectory, run) {
  for (;;) {
    const record = await readUpdateRecord(stateDirectory);
    if (record?.restart?.directory !== directory) return;
    if (record.status.state === 'restarting') {
      await wait(1000, undefined, { ref: false });
      continue;
    }
    if (record.status.state === 'current' && record.status.manifestSha256 === manifestSha256) {
      const launch = await locateWorkerLaunch({ stateDirectory, releaseDirectory: directory, run });
      await migrateWorkerService({ ...launch, node: process.execPath }, { run });
    }
    return;
  }
}

/** Runs before the application graph, including when an older updater installed this release. */
export async function bootstrapWorkerRuntime(directory, { run, fetchRuntime } = {}) {
  directory = resolve(directory);
  const bytes = await readFile(join(directory, 'manifest.json'));
  const manifest = JSON.parse(bytes);
  const metadata = await readArtifactNodeRuntime(directory, manifest);
  if (!metadata) return;
  const args = process.argv.slice(2);
  const transition = manifest.target.node !== metadata.version;
  if (process.version === metadata.version) {
    if (transition && args[0] === 'run' && args[1] === '--state' && args.length === 3) {
      // The old supervisor can restore only the release pointer. Keep its interpreter until it accepts the update.
      void persistConfirmedRuntime(directory, createHash('sha256').update(bytes).digest('hex'), args[2], run)
        .catch(error => console.error(`Worker runtime service migration failed: ${workerUpdateErrorMessage(error)}`));
    }
    return;
  }
  if (basename(dirname(directory)) !== 'versions') throw new WorkerError('node_runtime_bootstrap_requires_installation');
  if (transition && !manifest.runtime.archivePath) throw new WorkerError('node_runtime_transition_archive_missing');
  const archivePath = manifest.runtime.archivePath ? join(directory, manifest.runtime.archivePath) : undefined;
  const node = await installPinnedNodeRuntime(join(dirname(dirname(directory)), 'node-runtimes'), metadata, { fetchRuntime, archivePath });
  console.warn(`Worker runtime switching from ${process.version} to ${metadata.version}`);
  process.execve(node, [node, ...process.argv.slice(1)], process.env);
  throw new WorkerError('node_runtime_exec_failed');
}
