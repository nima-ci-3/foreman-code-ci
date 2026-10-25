import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { stageBrowserRuntime, stageBundledBrowserRuntime, activateBrowserRuntime, rollbackBrowserRuntime,
  readInstalledBrowserRuntime, browserRuntimeMatchesRelease } from '../src/browserRuntimeInstall.mjs';
import { downloadBrowserRuntimeArtifact } from '../src/browserRuntimeBuild.mjs';
import { createWorkerBrowserRuntime } from '../src/browserRuntime.mjs';

const hash = value => createHash('sha256').update(value).digest('hex');
const target = { os: 'ubuntu', osRelease: '24.04', arch: 'x64', libc: 'glibc-2.39', node: 'v22.23.3' };
const ready = async () => ({ ready: true });

async function fixture(t) {
  const directory = await mkdtemp(join(homedir(), '.cache', 'foreman-tmp', 'browser-recipe-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const archives = { 'https://github.com/python.tar.gz': 'pinned Python',
    'https://files.pythonhosted.org/example.whl': 'pinned wheel', 'https://cdn.playwright.dev/chromium.zip': 'pinned Chromium' };
  const inputs = { kind: 'foreman-browser-build-inputs', python: { url: Object.keys(archives)[0], sha256: hash('pinned Python') },
    chromium: { version: '153.0.8010.12', url: Object.keys(archives)[2], sha256: hash('pinned Chromium') },
    packages: [{ name: 'example', version: '1.0.0', wheelSha256: hash('pinned wheel') }] };
  const lock = { format: 1, kind: 'foreman-browser-resolved-lock', target, python: inputs.python,
    chromium: inputs.chromium, packages: [{ name: 'example', version: '1.0.0', url: Object.keys(archives)[1],
      sha256: hash('pinned wheel'), filename: 'example.whl' }] };
  const downloads = [];
  const fetchArtifact = async url => {
    downloads.push(url);
    assert.ok(Object.hasOwn(archives, url), url);
    return new Response(archives[url]);
  };
  const put = async (path, value, mode = 0o600) => {
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    await writeFile(path, value, { mode });
  };
  const run = async (command, args) => {
    assert.ok(!args.includes('--dry-run'), 'Worker must never resolve dependency ranges');
    if (args[5] === 'install') {
      assert.ok(args.includes('--no-index'));
      assert.ok(args.includes('--require-hashes'));
    }
    if (command === 'tar') {
      if (args[0] === '-tzf') return { stdout: 'python/bin/python3\npython/LICENSE\n' };
      const unit = args[args.indexOf('--directory') + 1];
      await put(join(unit, 'python/bin/python3'), 'verified Python executable', 0o700);
      await put(join(unit, 'python/LICENSE'), 'Python license');
    } else if (args[2]?.endsWith('credits.py')) {
      return { stdout: '<html>' + 'Copyright license complete.\n'.repeat(80) + '</html>' };
    } else if (args[2] === '-c' && args[5]?.endsWith('/chromium')) {
      await put(join(args[5], 'chrome-linux64/chrome'), 'verified Chromium executable', 0o700);
    } else if (args[2] === '-c' && args[6]) {
      await put(join(args[5], 'index.json'), '[]');
    }
    return { stdout: '' };
  };
  async function recipe(name, change = {}) {
    const artifact = join(directory, name); await mkdir(artifact, { mode: 0o700 });
    const glue = { 'bridge.py': change.bridge ?? '# release bridge', 'browser-use.md': '# skill', 'LICENSES.txt': 'Notices',
      'credits.py': '# collector', 'native-host.mjs': 'export const createBrowserHost = () => {};',
      'installer.mjs': `export { installBrowserThirdParty, collectChromiumNotices, listUnitFiles } from ${JSON.stringify(new URL('../src/browserRuntimeBuild.mjs', import.meta.url).href)};` };
    const files = [];
    for (const [path, bytes] of Object.entries(glue)) {
      await put(join(artifact, path), bytes);
      files.push({ path, size: Buffer.byteLength(bytes), sha256: hash(bytes), mode: 0o600 });
    }
    const resolvedLock = change.lock ?? lock;
    const manifest = { format: 1, kind: 'foreman-browser-runtime', runtimeVersion: '1.0.0', foremanVersion: '1.0.0',
      sourceCommit: change.commit ?? 'a'.repeat(40), profileFormat: 1, target,
      resolvedLockSha256: hash(`${JSON.stringify(resolvedLock, null, 2)}\n`),
      pythonExecutable: 'python/bin/python3', chromiumExecutable: 'chromium/chrome-linux64/chrome',
      nativeHostModule: 'native-host.mjs', bridgeScript: 'bridge.py', skill: 'browser-use.md' };
    const descriptor = { format: 2, kind: 'foreman-browser-runtime-recipe', target, manifest, inputs,
      inputsSha256: hash(JSON.stringify(inputs)), resolvedLock, licenseTexts: {}, files };
    const bytes = `${JSON.stringify(descriptor, null, 2)}\n`;
    await put(join(artifact, 'browser-runtime.json'), bytes);
    return { artifact, descriptor, expectedSha256: hash(bytes) };
  }
  const runtimeRoot = join(directory, 'installed');
  const stage = value => stageBrowserRuntime({ ...value, runtimeRoot, target, readiness: ready, activate: false, run, fetchArtifact });
  return { directory, recipe, stage, runtimeRoot, downloads, run, fetchArtifact, lock };
}

test('a Worker installs the pinned recipe, reuses third-party inputs across commits, and retains drain and rollback', async t => {
  const f = await fixture(t);
  const first = await f.recipe('first'), installed = await f.stage(first);
  assert.equal(f.downloads.length, 3);
  assert.equal(installed.recipeSha256, first.expectedSha256);
  assert.notEqual(installed.manifestSha256, installed.recipeSha256);
  assert.equal(browserRuntimeMatchesRelease({ browserRuntime: { recipeSha256: first.expectedSha256 } }, installed), true);
  await activateBrowserRuntime({ runtimeRoot: f.runtimeRoot, staged: installed, drain: async () => ({}) });
  assert.equal((await stat(installed.pythonExecutable)).mode & 0o777, 0o700);
  assert.equal((await stat(installed.bridgeScript)).mode & 0o777, 0o600);
  const next = await f.recipe('next', { commit: 'b'.repeat(40), bridge: '# cheaper new release glue' });
  const staged = await f.stage(next);
  assert.equal(f.downloads.length, 3, 'glue and source-commit changes do not download third-party bytes');
  assert.equal(await readFile(staged.bridgeScript, 'utf8'), '# cheaper new release glue');
  assert.equal(browserRuntimeMatchesRelease({ browserRuntime: { recipeSha256: first.expectedSha256 } }, staged), false);
  assert.equal((await readInstalledBrowserRuntime({ runtimeRoot: f.runtimeRoot, target })).manifestSha256, installed.manifestSha256);
  let drained = false, restored = false;
  const activation = await activateBrowserRuntime({ runtimeRoot: f.runtimeRoot, staged, drain: async () => {
    drained = true; return { profileCheckpointId: 'before-new-glue' };
  } });
  assert.equal(drained, true);
  await rollbackBrowserRuntime({ runtimeRoot: f.runtimeRoot, ...activation, drain: async () => {},
    restoreProfiles: async checkpoint => { assert.equal(checkpoint, 'before-new-glue'); restored = true; } });
  assert.equal(restored, true);
  assert.equal((await readInstalledBrowserRuntime({ runtimeRoot: f.runtimeRoot, target })).recipeSha256, first.expectedSha256);
  await writeFile(installed.bridgeScript, 'tampered');
  await assert.rejects(readInstalledBrowserRuntime({ runtimeRoot: f.runtimeRoot, target }), /checksum/);
});

test('changing the resolved wheel lock requires a new verified third-party installation', async t => {
  const f = await fixture(t);
  await f.stage(await f.recipe('first'));
  await f.stage(await f.recipe('lock-change', { lock: { ...f.lock, resolver: 'pip==changed' } }));
  assert.equal(f.downloads.length, 6);
});

test('unapproved recipes, changed glue and checksum failures cannot stage or activate a browser', async t => {
  const f = await fixture(t), value = await f.recipe('release');
  await assert.rejects(stageBrowserRuntime({ ...value, expectedSha256: '0'.repeat(64), runtimeRoot: f.runtimeRoot,
    target, readiness: ready, activate: false, run: f.run, fetchArtifact: f.fetchArtifact }), /checksum/);
  const carrier = { files: [{ path: 'artifacts/browser-runtime/browser-runtime.json', sha256: value.expectedSha256 }],
    browserRuntime: { descriptorSha256: value.expectedSha256, recipeSha256: '0'.repeat(64) } };
  await assert.rejects(stageBundledBrowserRuntime({ root: f.directory, artifact: f.directory, manifest: carrier, target }), /ENOENT/);
  await mkdir(join(f.directory, 'artifacts'), { mode: 0o700 });
  const { rename } = await import('node:fs/promises');
  await rename(value.artifact, join(f.directory, 'artifacts/browser-runtime'));
  await assert.rejects(stageBundledBrowserRuntime({ root: f.directory, artifact: f.directory, manifest: carrier, target }), /approval mismatch/);
  value.artifact = join(f.directory, 'artifacts/browser-runtime');
  await assert.rejects(stageBrowserRuntime({ ...value, runtimeRoot: f.runtimeRoot, target, readiness: ready,
    activate: false, run: f.run, fetchArtifact: async () => new Response('corrupt') }), /checksum mismatch/);
  assert.equal(f.downloads.length, 0);
  await writeFile(join(value.artifact, 'bridge.py'), 'tampered glue');
  await assert.rejects(f.stage(value), /checksum/);
  await assert.rejects(readInstalledBrowserRuntime({ runtimeRoot: f.runtimeRoot, target }), /BROWSER_RUNTIME_MISSING/);
});

test('Worker bootstrap rejects a runtime installed for a different approved recipe before importing the native host', async t => {
  const f = await fixture(t), value = await f.recipe('release'), staged = await f.stage(value);
  await activateBrowserRuntime({ runtimeRoot: f.runtimeRoot, staged, drain: async () => ({}) });
  let imported = false;
  const owner = createWorkerBrowserRuntime({ root: f.directory, stateDirectory: f.directory, runtimeRoot: f.runtimeRoot,
    facts: target, assertHostOwnership: async () => {}, reportFailure: () => {},
    readSelectedRelease: async () => ({ manifest: { browserRuntime: { recipeSha256: '0'.repeat(64) } } }),
    loadModule: async () => { imported = true; throw new Error('must not import'); } });
  t.after(() => owner.close());
  assert.equal((await owner.start()).ready, false);
  assert.equal(imported, false);
});

test('downloads retry transient failures but never accept a corrupt archive', async t => {
  const f = await fixture(t);
  let calls = 0;
  const bytes = 'verified archive';
  await downloadBrowserRuntimeArtifact('https://example.org/pinned', join(f.directory, 'download'), hash(bytes), async () => {
    if (++calls === 1) throw new Error('temporary network timeout');
    return new Response(bytes);
  });
  assert.equal(calls, 2);
  await assert.rejects(downloadBrowserRuntimeArtifact('https://example.org/pinned', join(f.directory, 'bad'), hash(bytes),
    async () => new Response('corrupt')), /checksum mismatch/);
});
