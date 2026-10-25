import { createHash } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { packBrowserRuntime } from '../../../../scripts/browser-runtime-install.mjs';

/** Small, verified browser carrier; its fixture executables are never launched. */
export async function createBrowserRuntimeArtifact(directory, { target, commit, version }) {
  const unit = join(directory, 'unit'), output = join(directory, 'artifact');
  const lock = JSON.stringify({ fixture: true });
  const files = { 'python/bin/python3': 'fixture python', 'chromium/chrome': 'fixture chromium',
    'bridge.py': '# fixture bridge', 'browser-use.md': '# fixture skill', 'LICENSES.txt': 'Fixture notices',
    'runtime-lock.json': lock, 'native-host.mjs': 'export const fixture = true;\n' };
  for (const [path, bytes] of Object.entries(files)) {
    await mkdir(dirname(join(unit, path)), { recursive: true, mode: 0o700 });
    await writeFile(join(unit, path), bytes, { mode: path === 'python/bin/python3' || path === 'chromium/chrome' ? 0o700 : 0o600 });
  }
  const packed = await packBrowserRuntime({ unit, output, manifest: { format: 1, kind: 'foreman-browser-runtime',
    runtimeVersion: version, foremanVersion: version, sourceCommit: commit, profileFormat: 1, target, sourceInputs: [],
    pythonVersion: '3.13.16', browserUseVersion: '0.13.11', browserHarnessVersion: '0.1.13', chromiumVersion: '153.0.8010.12',
    resolvedLockSha256: createHash('sha256').update(lock).digest('hex'), pythonExecutable: 'python/bin/python3',
    chromiumExecutable: 'chromium/chrome', bridgeScript: 'bridge.py', nativeHostModule: 'native-host.mjs', skill: 'browser-use.md' } });
  await writeFile(join(output, 'index.json'), JSON.stringify({ format: 1, sourceCommit: commit,
    artifacts: [{ directory: '.', target, descriptorSha256: packed.descriptorSha256 }] }), { mode: 0o600 });
  return { ...packed, directory: output };
}
