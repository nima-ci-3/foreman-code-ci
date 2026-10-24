import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { copyFile, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as wait } from 'node:timers/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import test, { before, after } from 'node:test';
import { INSTALLATION_NAMES } from '../../../packages/contracts/src/installationNames.mjs';
import { readUpdateRecord } from '../src/updateSupervisor.mjs';
import { readWorkerStatus } from '../src/runtime.mjs';

const repository = fileURLToPath(new URL('../../../', import.meta.url));
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const facts = { os: 'ubuntu', osRelease: '24.04', arch: 'x64', libc: 'glibc-2.39', node: 'v22.23.3',
  rootPersistent: true, homePersistent: true, storagePersistent: true };
const expected = { protocolVersion: 1, identityFormat: 1 };
let storage, old, oldInstallation, metadata, archiveBytes;

before(async () => {
  const parent = join(homedir(), '.cache/foreman-tmp');
  await mkdir(parent, { recursive: true });
  storage = await mkdtemp(join(parent, 'runtime-transition-'));
  // Unchanged update, supervisor and installation modules from 97a1c0b77ef07b22759fc432c7e57a894cb9965e.
  // Keep this executable fixture independent of the CI mirror's shallow Git history.
  const snapshot = join(storage, 'old');
  await mkdir(snapshot);
  execFileSync('tar', ['-xzf', fileURLToPath(new URL('./fixtures/node22-updater.tar.gz', import.meta.url)), '-C', snapshot]);
  await symlink(join(repository, 'packages'), join(snapshot, 'packages'));
  await symlink(join(repository, 'apps/worker/node_modules'), join(snapshot, 'apps/worker/node_modules'));
  for (const name of ['ciInstallSmoke.mjs', 'updateOperation.mjs', 'diagnostics.mjs', 'browserRuntimeInstall.mjs',
    'workerArtifactArchive.mjs', 'runtime.mjs', 'companionLauncher.mjs']) {
    await symlink(join(repository, 'apps/worker/src', name), join(snapshot, 'apps/worker/src', name));
  }
  const load = name => import(pathToFileURL(join(snapshot, 'apps/worker/src', name)).href);
  old = { ...await load('update.mjs'), ...await load('updateSupervisor.mjs') };
  oldInstallation = await load('installation.mjs');
  const runtime = join(storage, 'node-v24.22.1-linux-x64');
  await mkdir(join(runtime, 'bin'), { recursive: true });
  await copyFile(process.execPath, join(runtime, 'bin/node'));
  const runtimeArchive = join(storage, 'node.tar.gz');
  execFileSync('tar', ['-czf', runtimeArchive, '-C', storage, 'node-v24.22.1-linux-x64']);
  archiveBytes = await readFile(runtimeArchive);
  const executable = await readFile(process.execPath);
  metadata = { format: 1, runtime: 'node', version: 'v24.22.1', platform: 'linux', arch: 'x64',
    archive: { url: 'https://nodejs.org/dist/v24.22.1/node.tar.gz', sha256: hash(archiveBytes), bytes: archiveBytes.length },
    nodeExecutable: { archivePath: 'node-v24.22.1-linux-x64/bin/node', sha256: hash(executable), bytes: executable.length } };
});
after(async () => { if (storage) await rm(storage, { recursive: true, force: true }); });

async function until(predicate) {
  for (let attempt = 0; attempt < 500; attempt++) {
    if (await predicate()) return;
    await wait(10);
  }
  assert.fail('Worker transition did not settle');
}

async function fixture(t, failure) {
  const base = await mkdtemp(join(storage, 'installation-'));
  const root = join(base, 'app'), stateDirectory = join(base, 'state');
  await mkdir(stateDirectory, { mode: 0o700 });
  const workerInstallationId = randomUUID();
  const unitPath = join(base, '.config/systemd/user', INSTALLATION_NAMES.services.worker);
  await mkdir(join(unitPath, '..'), { recursive: true });
  const oldNode = join(base, 'node22');
  // Model the installed interpreter; execve drops this CLI-only version override on transition.
  await writeFile(oldNode, `#!/bin/sh\nexec '${process.execPath}' --import 'data:text/javascript,Object.defineProperty(process,"version",{value:"v22.23.3"})' "$@"\n`, { mode: 0o700 });
  const systemctl = `async (_command, args) => ({ stdout: args.includes('--property=MainPID')
    ? (args.includes(${JSON.stringify(INSTALLATION_NAMES.services.worker)}) ? String(process.pid) : '0')
    : args.includes('--property=FragmentPath') ? ${JSON.stringify(unitPath)} : '' })`;
  const network = join(base, 'runtime-network');
  const createArtifact = async version => {
    const directory = join(base, version);
    await mkdir(join(directory, 'src'), { recursive: true, mode: 0o700 });
    const installationUrl = version === '1.0.0'
      ? pathToFileURL(join(storage, 'old/apps/worker/src/installation.mjs')).href
      : new URL('../src/installation.mjs', import.meta.url).href;
    const bootstrap = version === '1.0.0' ? '' : `
import { bootstrapWorkerRuntime } from ${JSON.stringify(new URL('../src/runtimeBootstrap.mjs', import.meta.url).href)};
await bootstrapWorkerRuntime(directory, { run: ${systemctl}, fetchRuntime: async () => {
  await writeFile(${JSON.stringify(network)}, 'network transfer after restart');
  ${failure === 'slow' ? 'await new Promise(resolve => setTimeout(resolve, 65_000));' : ''}
  return new Response(await readFile(${JSON.stringify(join(storage, 'node.tar.gz'))}));
} });`;
    const shared = `
import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
const directory = fileURLToPath(new URL('../', import.meta.url));
${bootstrap}
import { readInstalledRelease } from ${JSON.stringify(installationUrl)};
const release = await readInstalledRelease({ root: ${JSON.stringify(root)},
  facts: { ...${JSON.stringify(facts)}, node: process.version }, expected: ${JSON.stringify(expected)} });
`;
    const cli = `${shared}
import { startWorker } from ${JSON.stringify(new URL('../src/runtime.mjs', import.meta.url).href)};
const runtime = await startWorker({ stateDirectory: ${JSON.stringify(stateDirectory)}, appVersion: release.manifest.version,
  loadIdentity: async () => ({ workerInstallationId: ${JSON.stringify(workerInstallationId)} }),
  readBootId: async () => '11111111-1111-4111-8111-111111111111',
  createConnection: async () => ({ start: async () => {}, stop: async () => {}, status: () =>
    (${JSON.stringify(version === '1.1.0' && failure === 'startup' ? { phase: 'blocked', failure: 'injected startup failure' } : { phase: 'ready' })}) }) });
process.on('SIGTERM', async () => { await runtime.stop(); process.exit(0); });
`;
    const files = { 'src/cli.mjs': Buffer.from(cli),
      'src/companion.mjs': Buffer.from(`${shared}\nconsole.log(JSON.stringify({ version: release.manifest.version, node: process.version }));`) };
    if (version === '1.1.0') {
      files['artifacts/node-runtime.json'] = Buffer.from(JSON.stringify(metadata));
      files['artifacts/node-runtime.tar.xz'] = archiveBytes;
    }
    for (const [path, bytes] of Object.entries(files)) {
      await mkdir(join(directory, path, '..'), { recursive: true });
      await writeFile(join(directory, path), bytes, { mode: 0o600 });
    }
    const { os, osRelease, arch, libc, node } = facts;
    const manifest = { format: 1, version, commit: 'a'.repeat(40), lockfileSha256: 'b'.repeat(64),
      packageManager: 'pnpm@11.27.0', protocolVersion: 1, identityFormat: 1, target: { os, osRelease, arch, libc, node },
      ...(version === '1.1.0' ? { runtime: { metadataPath: 'artifacts/node-runtime.json', version: metadata.version,
        archivePath: 'artifacts/node-runtime.tar.xz', archiveSha256: metadata.archive.sha256,
        executableSha256: metadata.nodeExecutable.sha256 } } : {}),
      files: Object.entries(files).map(([path, bytes]) => ({ path, size: bytes.length, sha256: hash(bytes) })) };
    const bytes = Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`);
    await writeFile(join(directory, 'manifest.json'), bytes, { mode: 0o600 });
    return { directory, manifest, manifestSha256: hash(bytes), version,
      github: { repository: 'example/product', tag: `worker-${manifest.commit}` } };
  };
  const previous = await createArtifact('1.0.0'), incoming = await createArtifact('1.1.0');
  const installed = await oldInstallation.installVersion({ root, stateDirectory, facts, expected,
    artifact: previous.directory, approvedManifestSha256: previous.manifestSha256 });
  await writeFile(unitPath, `ExecStart=${oldNode} ${installed.directory}/src/cli.mjs run --state ${stateDirectory}\n`, { mode: 0o600 });
  const companion = join(root, INSTALLATION_NAMES.launchers.companion);
  await writeFile(companion, `#!/bin/sh\nexec '${oldNode}' '${root}/current/src/companion.mjs' "$@"\n`, { mode: 0o700 });
  let child, closed, stderr = '', restarts = 0;
  const stop = async () => {
    if (child && child.exitCode === null) child.kill('SIGTERM');
    await closed;
  };
  t.after(stop);
  const restart = async () => {
    await stop();
    const unit = await readFile(unitPath, 'utf8');
    const [, node, entrypoint] = unit.match(/^ExecStart=(\S+) (\S+)/m);
    stderr = '';
    child = spawn(node, [entrypoint, 'run', '--state', stateDirectory], { env: { ...process.env, HOME: base }, stdio: ['ignore', 'ignore', 'pipe'] });
    child.stderr.on('data', bytes => { stderr += bytes; });
    closed = new Promise((resolve, reject) => { child.once('error', reject); child.once('close', resolve); });
    restarts++;
  };
  await restart();
  await old.waitForWorkerReady({ stateDirectory, version: '1.0.0', workerInstallationId, timeoutMs: 5000, pollMs: 10 });
  const updater = await new old.WorkerUpdater({ stateDirectory, version: '1.0.0',
    releaseDirectory: installed.directory, manifestSha256: previous.manifestSha256, workerInstallationId, facts,
    assertStateOwnership: () => {}, drain: async () => {}, resume: async () => {},
    connection: () => ({ captureRequest: () => ({ request: async payload => ({ payload: payload.operation === 'release'
      ? { operation: 'release', release: incoming } : { operation: 'ci-smoke', ciSmoke: { repository: 'example/product', commit: incoming.manifest.commit } } }) }) }),
    locateLaunch: async () => ({ service: INSTALLATION_NAMES.services.worker, root, stateDirectory, unitPath,
      pointer: { kind: 'symlink', path: join(root, 'current') }, previousDirectory: installed.directory }),
    fetchAsset: async ({ destination }) => {
      if (failure === 'slow') {
        t.mock.timers.tick(65_000);
        await old.waitForWorkerReady({ stateDirectory, version: '1.0.0', workerInstallationId, timeoutMs: 5000, pollMs: 10 });
        assert.equal(restarts, 1);
      }
      execFileSync('tar', ['-czf', destination, '-C', incoming.directory, '.']);
    },
    launchSupervisor: async () => old.superviseWorkerUpdate(await readUpdateRecord(stateDirectory), {
      prepareService: plan => old.migrateWorkerService(plan, { run: async (_command, args) => ({ stdout: args.includes('--property=FragmentPath') ? unitPath : '' }) }),
      restart,
      ready: async options => {
        assert.equal(options.timeoutMs, options.version === '1.1.0' ? 60_000 : undefined);
        const readiness = old.waitForWorkerReady({ ...options,
          timeoutMs: failure === 'slow' && options.version === '1.1.0' ? options.timeoutMs : 3000, pollMs: 10 });
        if (failure === 'slow' && options.version === '1.1.0') {
          await until(async () => (await readWorkerStatus(stateDirectory))?.phase === 'ready'
            || await readFile(network).then(() => true, error => { if (error.code === 'ENOENT') return false; throw error; }));
          if ((await readWorkerStatus(stateDirectory))?.phase !== 'ready') t.mock.timers.tick(65_000);
        }
        await readiness;
      },
      readStartupFailure: async () => stderr,
      smoke: async () => { if (failure === 'smoke') throw new Error('injected CI smoke failure'); },
    }),
  }).initialize();
  t.after(() => updater.close());
  return { updater, root, stateDirectory, unitPath, companion, oldNode, network, restarts: () => restarts };
}

for (const failure of ['startup', 'smoke']) {
  test(`the old updater rolls a Node transition back onto its original interpreter after ${failure} failure`, async t => {
    const f = await fixture(t, failure);
    await f.updater.start();
    const record = await readUpdateRecord(f.stateDirectory);
    assert.equal(record.status.state, 'rolled-back');
    assert.match(record.status.lastError, /injected/);
    assert.equal(f.restarts(), 3);
    const previous = await oldInstallation.readInstalledRelease({ root: f.root, facts, expected });
    assert.equal(previous.manifest.version, '1.0.0');
    assert.match(await readFile(f.unitPath, 'utf8'), new RegExp(`^ExecStart=${f.oldNode} `));
    const report = JSON.parse(execFileSync(f.companion, ['--state', f.stateDirectory], { encoding: 'utf8' }));
    assert.deepEqual(report, { version: '1.0.0', node: 'v22.23.3' });
  });
}

test('the old updater downloads a transition longer than its startup window before restart', async t => {
  const f = await fixture(t, 'slow');
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: Date.now() });
  await f.updater.start();
  assert.equal((await readUpdateRecord(f.stateDirectory)).status.state, 'current');
  await until(async () => !(await readFile(f.unitPath, 'utf8')).includes(f.oldNode));
  assert.equal(f.restarts(), 2);
  await assert.rejects(readFile(f.network), { code: 'ENOENT' });
  const report = JSON.parse(execFileSync(f.companion, ['--state', f.stateDirectory], { encoding: 'utf8' }));
  assert.deepEqual(report, { version: '1.1.0', node: 'v24.22.1' });
});
