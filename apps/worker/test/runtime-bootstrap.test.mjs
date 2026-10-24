import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFile, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';
import { persistentFixtureRoot } from './fixtureStorage.mjs';
import { INSTALLATION_NAMES } from '../../../packages/contracts/src/installationNames.mjs';

const hash = bytes => createHash('sha256').update(bytes).digest('hex');

test('a release accepted by an old updater bootstraps bundled Node and persists the interpreter after confirmation', async t => {
  const base = await mkdtemp(join(persistentFixtureRoot, 'worker-node-bootstrap-'));
  t.after(() => rm(base, { recursive: true, force: true }));
  const root = join(base, 'app'), directory = join(root, 'versions', `1.1.0-${'a'.repeat(64)}`), state = join(base, 'state');
  await mkdir(join(directory, 'src'), { recursive: true, mode: 0o700 });
  await mkdir(join(directory, 'artifacts'), { mode: 0o700 });
  await mkdir(state, { mode: 0o700 });
  await symlink(directory, join(root, 'current'));
  const archiveRoot = join(base, 'node-v24.22.1-linux-x64');
  await mkdir(join(archiveRoot, 'bin'), { recursive: true });
  await copyFile(process.execPath, join(archiveRoot, 'bin/node'));
  const archive = join(base, 'node.tar.gz');
  assert.equal(spawnSync('tar', ['-czf', archive, '-C', base, 'node-v24.22.1-linux-x64']).status, 0);
  const archiveBytes = await readFile(archive), executable = await readFile(process.execPath);
  const metadata = { format: 1, runtime: 'node', version: 'v24.22.1', platform: 'linux', arch: 'x64',
    archive: { url: 'https://nodejs.org/dist/v24.22.1/node.tar.gz', sha256: hash(archiveBytes), bytes: archiveBytes.length },
    nodeExecutable: { archivePath: 'node-v24.22.1-linux-x64/bin/node', sha256: hash(executable), bytes: executable.length } };
  const bytes = Buffer.from(JSON.stringify(metadata));
  await writeFile(join(directory, 'artifacts/node-runtime.json'), bytes);
  await writeFile(join(directory, 'artifacts/node-runtime.tar.xz'), archiveBytes);
  const manifestBytes = Buffer.from(JSON.stringify({
    target: { node: 'v22.23.3' },
    runtime: { metadataPath: 'artifacts/node-runtime.json', version: metadata.version,
      archivePath: 'artifacts/node-runtime.tar.xz', archiveSha256: metadata.archive.sha256,
      executableSha256: metadata.nodeExecutable.sha256 },
    files: [{ path: 'artifacts/node-runtime.json', size: bytes.length, sha256: hash(bytes) },
      { path: 'artifacts/node-runtime.tar.xz', size: archiveBytes.length, sha256: hash(archiveBytes) }],
  }));
  await writeFile(join(directory, 'manifest.json'), manifestBytes);
  await writeFile(join(state, 'worker-update.json'), JSON.stringify({ format: 1,
    status: { state: 'current', manifestSha256: hash(manifestBytes) }, restart: { directory } }), { mode: 0o600 });
  const unit = join(base, '.config/systemd/user', INSTALLATION_NAMES.services.worker);
  await mkdir(join(unit, '..'), { recursive: true, mode: 0o700 });
  await writeFile(unit, `ExecStart=${process.execPath} ${directory}/src/cli.mjs run --state ${state}\n`, { mode: 0o600 });
  const bootstrap = new URL('../src/runtimeBootstrap.mjs', import.meta.url).href;
  await writeFile(join(directory, 'src/cli.mjs'), `
import { readFile } from 'node:fs/promises';
import { bootstrapWorkerRuntime } from ${JSON.stringify(bootstrap)};
if (!process.env.NODE_BOOTSTRAP_PID) {
  process.env.NODE_BOOTSTRAP_PID = String(process.pid);
  Object.defineProperty(process, 'version', { value: 'v22.23.3' });
}
await bootstrapWorkerRuntime(${JSON.stringify(directory)}, {
  fetchRuntime: async () => { throw new Error('Transition runtime must already be downloaded'); },
  run: async (_command, args) => ({ stdout: args.includes('--property=MainPID')
    ? (args.includes(${JSON.stringify(INSTALLATION_NAMES.services.worker)}) ? String(process.pid) : '0')
    : args.includes('--property=FragmentPath') ? ${JSON.stringify(unit)} : '' }),
});
console.log(JSON.stringify({ node: process.execPath, version: process.version, pid: process.pid, originalPid: Number(process.env.NODE_BOOTSTRAP_PID) }));
`);
  const child = spawnSync(process.execPath, [join(directory, 'src/cli.mjs'), 'run', '--state', state],
    { encoding: 'utf8', timeout: 30_000, env: { ...process.env, HOME: base } });
  assert.equal(child.status, 0, child.stderr);
  const report = JSON.parse(child.stdout);
  assert.equal(report.version, 'v24.22.1');
  assert.equal(report.pid, report.originalPid);
  assert.notEqual(report.node, process.execPath);
  const installedUnit = await readFile(unit, 'utf8');
  assert.equal(installedUnit.trim(), `ExecStart=${report.node} ${root}/current/src/cli.mjs run --state ${state}`);
});
