import { browserHostTarget, matchesBrowserTarget, nativeWorkerTarget } from './fixtures/browserTarget.mjs';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import test from 'node:test';
import { persistentFixtureRoot } from './fixtureStorage.mjs';
import { createBrowserRuntimeArtifact } from './fixtures/browserRuntimeArtifact.mjs';
import { stageBundledBrowserRuntime } from '../src/browserRuntimeInstall.mjs';

const repository = fileURLToPath(new URL('../../../', import.meta.url));

const native = await nativeWorkerTarget(repository);
const host = await browserHostTarget();
const candidates = [
  { runtime: native.target.node.slice(1), target: native.file },
  { runtime: '24.22.1', target: 'apps/worker/artifacts/ubuntu-26.04-x64-target.json' },
  { runtime: '24.22.1', target: 'apps/worker/artifacts/test-hosts/ubuntu-26.04-x64-node-24.22.1-target.json' },
];
for (const { runtime, target } of candidates.filter((candidate, index) => candidates.findIndex(value => value.target === candidate.target) === index)) {
  const expected = JSON.parse(await readFile(join(repository, target), 'utf8'));
  test(`the committed worker package builds and loads its complete execution graph on ${expected.os} ${expected.osRelease} with Node ${runtime}`, async t => {
    if (!matchesBrowserTarget(host, expected)) {
      t.skip(`Requires native ${JSON.stringify(expected)}; this runner is ${JSON.stringify(host)}`);
      return;
    }
    const directory = await mkdtemp(join(persistentFixtureRoot, 'worker-build-'));
    t.after(() => rm(directory, { recursive: true, force: true }));
    const output = join(directory, 'release');
    execFileSync(process.execPath, [join(repository, 'scripts/build-worker-artifact.mjs'),
      target, output,
      ...(runtime === '24.22.1' ? ['apps/worker/artifacts/node-24.22.1-linux-x64.json'] : [])],
    { cwd: join(repository, 'apps/worker'), encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    const manifest = JSON.parse(await readFile(join(output, 'manifest.json'), 'utf8'));
    const product = JSON.parse(await readFile(join(repository, 'package.json'), 'utf8'));
    assert.equal(manifest.version, product.version);
    assert.equal(manifest.target.node, `v${runtime}`);
    assert.deepEqual(manifest.target, host);
    const { createWorkerConnection } = await import(pathToFileURL(join(output, 'src/worker.mjs')).href);
    const connection = createWorkerConnection({
      pairing: {
        mainId: randomUUID(), deviceId: randomUUID(), workerInstallationId: randomUUID(),
        keyRevision: 1, authorizationRevision: 1,
        endpoint: 'wss://worker-build.example/device/connect',
        credential: 'a'.repeat(64), mainPublicKeyFingerprint: 'b'.repeat(64),
      },
      bootId: randomUUID(), appVersion: '0.1.0', extensions: [],
    });
    assert.equal(connection.status().phase, 'disconnected');
    await connection.stop();
    const browser = await createBrowserRuntimeArtifact(join(directory, 'browser'),
      { target: expected, commit: manifest.commit, version: product.version });
    const transition = join(directory, 'transition');
    execFileSync(process.execPath, [join(repository, 'scripts/build-worker-artifact.mjs'), target, transition,
      'apps/worker/artifacts/node-24.22.1-linux-x64.json', 'v22.23.3'],
    { cwd: join(repository, 'apps/worker'), stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, FOREMAN_CODE_BROWSER_RUNTIME_ARTIFACTS: browser.directory } });
    const bridge = JSON.parse(await readFile(join(transition, 'manifest.json'), 'utf8'));
    assert.equal(bridge.browserRuntimeStatus.state, 'ready');
    assert.equal(bridge.browserRuntime.manifestSha256, browser.descriptor.manifestSha256);
    const installedBrowser = await stageBundledBrowserRuntime({ root: join(directory, 'app'), artifact: transition,
      manifest: bridge, target: expected, readiness: async () => ({ ready: true }) });
    assert.equal(installedBrowser.runtimeVersion, product.version);
    const pin = JSON.parse(await readFile(join(transition, bridge.runtime.metadataPath), 'utf8'));
    const archive = await readFile(join(transition, bridge.runtime.archivePath));
    assert.equal(bridge.target.node, 'v22.23.3');
    assert.equal(archive.length, pin.archive.bytes);
    assert.equal(createHash('sha256').update(archive).digest('hex'), pin.archive.sha256);
    assert.deepEqual(bridge.files.find(file => file.path === bridge.runtime.archivePath), {
      path: bridge.runtime.archivePath, size: pin.archive.bytes, sha256: pin.archive.sha256,
    });
    assert.match(execFileSync(process.execPath, [join(transition, 'src/cli.mjs'), '--help'], { encoding: 'utf8' }), /Foreman Code worker/);
  });
}
