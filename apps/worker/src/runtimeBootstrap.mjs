import { basename, dirname, join } from 'node:path';
import { readFile } from 'node:fs/promises';
import { installPinnedNodeRuntime, readArtifactNodeRuntime } from './nodeRuntime.mjs';
import { locateWorkerLaunch, migrateWorkerService } from './updateSupervisor.mjs';
import { WorkerError } from './diagnostics.mjs';

/** Runs before the application graph, including when an older updater installed this release. */
export async function bootstrapWorkerRuntime(directory, { run, fetchRuntime } = {}) {
  const manifest = JSON.parse(await readFile(join(directory, 'manifest.json'), 'utf8'));
  const metadata = await readArtifactNodeRuntime(directory, manifest);
  if (!metadata || process.version === metadata.version) return;
  const args = process.argv.slice(2);
  if (basename(dirname(directory)) !== 'versions') throw new WorkerError('node_runtime_bootstrap_requires_installation');
  const node = await installPinnedNodeRuntime(join(dirname(dirname(directory)), 'node-runtimes'), metadata, { fetchRuntime });
  if (args[0] === 'run' && args[1] === '--state' && args.length === 3) {
    const launch = await locateWorkerLaunch({ stateDirectory: args[2], releaseDirectory: directory, run });
    await migrateWorkerService({ ...launch, node }, { run });
  }
  console.warn(`Worker runtime switching from ${process.version} to ${metadata.version}`);
  process.execve(node, [node, ...process.argv.slice(1)], process.env);
  throw new WorkerError('node_runtime_exec_failed');
}
