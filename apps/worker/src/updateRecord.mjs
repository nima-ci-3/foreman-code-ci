import { lstat, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { WorkerError, requirePrivateDirectory } from './diagnostics.mjs';

// Kept apart from updateSupervisor.mjs so modules the installer loads never import the contracts package.
export async function readUpdateRecord(stateDirectory) {
  await requirePrivateDirectory(stateDirectory);
  const path = join(stateDirectory, 'worker-update.json');
  try {
    const info = await lstat(path);
    if (!info.isFile() || info.uid !== process.getuid() || (info.mode & 0o077)) {
      throw new WorkerError('worker_update_state_invalid');
    }
    const record = JSON.parse(await readFile(path, 'utf8'));
    if (record.format !== 1) throw new WorkerError('worker_update_state_invalid');
    return record;
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
}
