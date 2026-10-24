import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { readCommittedWorkerTargets } from '../../../scripts/worker-release-artifacts.mjs';
import { collectBrowserRuntimeArtifacts } from '../../../scripts/browser-runtime-install.mjs';
import { inspectQuotaHelperAbi } from '../../../scripts/quota-helper-abi.mjs';
import { installVersion } from '../src/installation.mjs';
import { matchesBrowserRuntimeTarget, readBrowserRuntimeStatus, checkBrowserRuntimeReadiness,
  readInstalledBrowserRuntime } from '../src/browserRuntimeInstall.mjs';
import { createWorkerBrowserRuntime } from '../src/browserRuntime.mjs';
import { installedBrowserFixture } from './fixtures/installedBrowser.mjs';

test('a published native Worker installs its real Chromium runtime and loads its native dependencies', { timeout: 600_000 }, async t => {
  const browser = await installedBrowserFixture();
  t.after(browser.cleanup);
  const repository = fileURLToPath(new URL('../../../', import.meta.url));
  const commit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repository, encoding: 'utf8' }).trim();
  const reviewed = readCommittedWorkerTargets(repository, commit);
  const selected = reviewed.find(entry => matchesBrowserRuntimeTarget(entry.target, browser.target));
  assert.ok(selected, 'The native runner must have a published Worker target');
  const artifacts = join(browser.directory, 'collected');
  await collectBrowserRuntimeArtifacts({ directories: [join(browser.directory, 'artifact')], output: artifacts, commit });
  const output = join(browser.directory, 'worker');
  execFileSync(process.execPath, ['scripts/build-worker-artifact.mjs', selected.path, output], {
    cwd: repository, encoding: 'utf8', timeout: 120_000, stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, FOREMAN_CODE_BROWSER_RUNTIME_ARTIFACTS: artifacts },
  });
  const bytes = await readFile(join(output, 'manifest.json'));
  const manifest = JSON.parse(bytes);
  assert.deepEqual(manifest.target, selected.target);
  assert.equal(manifest.browserRuntimeStatus.state, 'ready');
  assert.ok(manifest.browserRuntime);
  const helper = join(output, 'artifacts/job-quota-query');
  const requirements = await inspectQuotaHelperAbi(helper, selected.target);
  const probe = spawnSync(helper, [], { encoding: 'utf8', env: { ...process.env, LD_BIND_NOW: '1' } });
  assert.ifError(probe.error);
  assert.equal(probe.status, 2, probe.stderr);
  const sharp = createRequire(join(output, 'package.cjs'))('sharp');
  const image = await sharp({ create: { width: 1, height: 1, channels: 3, background: '#ffffff' } }).png().toBuffer();
  assert.equal((await sharp(image).metadata()).width, 1);
  const stateDirectory = join(browser.directory, 'worker-state');
  await mkdir(stateDirectory, { mode: 0o700 });
  const restriction = '/proc/sys/kernel/apparmor_restrict_unprivileged_userns';
  const previousRestriction = (await readFile(restriction, 'utf8')).trim();
  const profiles = execFileSync('sudo', ['-n', 'cat', '/sys/kernel/security/apparmor/profiles'], { encoding: 'utf8' });
  assert.doesNotMatch(profiles, /^foreman-browser-(runtime|stage|build) /m, 'Qualification needs a host without a preinstalled Foreman profile');
  let profileInstalled = false, owner;
  const root = join(browser.directory, 'installed-worker');
  const facts = { ...selected.target, rootPersistent: true, homePersistent: true, storagePersistent: true };
  const expected = { protocolVersion: 1, identityFormat: 1 };
  try {
    execFileSync('sudo', ['-n', 'sysctl', '-w', 'kernel.apparmor_restrict_unprivileged_userns=1']);
    assert.equal((await readFile(restriction, 'utf8')).trim(), '1');
    const installed = await installVersion({ root, stateDirectory, artifact: output,
      approvedManifestSha256: createHash('sha256').update(bytes).digest('hex'), facts, expected });
    assert.equal(installed.browserRuntimeStatus.state, 'failed');
    assert.equal(installed.browserRuntimeStatus.retryable, true);
    const profile = join(installed.directory, 'runtime/browser/apparmor/foreman-browser-runtime');
    const command = `sudo install -m 0644 '${profile}' /etc/apparmor.d/foreman-browser-runtime && sudo apparmor_parser -r /etc/apparmor.d/foreman-browser-runtime`;
    assert.ok(installed.browserRuntimeStatus.reason.includes(command), installed.browserRuntimeStatus.reason);
    assert.deepEqual(await readBrowserRuntimeStatus(root), installed.browserRuntimeStatus);
    const doctor = spawnSync(process.execPath, [join(installed.directory, 'src/cli.mjs'), 'doctor', '--state', stateDirectory],
      { encoding: 'utf8', timeout: 10_000 });
    assert.equal(doctor.status, 0, doctor.stderr);
    assert.deepEqual(JSON.parse(doctor.stdout).browserRuntime, installed.browserRuntimeStatus);
    const failures = [];
    owner = createWorkerBrowserRuntime({ root, stateDirectory, facts, expected,
      computerId: 'qualification', installationId: 'qualification', subjectAuthority: {}, pairing: {}, keys: {},
      assertHostOwnership: async () => undefined, reportFailure: error => failures.push(error) });
    const failed = await owner.start();
    assert.equal(failed.ready, false);
    assert.ok(failed.message.includes(command), failed.message);
    const provisioned = spawnSync('/bin/sh', ['-c', command], { encoding: 'utf8', timeout: 10_000 });
    profileInstalled = true;
    assert.equal(provisioned.status, 0, provisioned.stderr);
    assert.equal((await owner.retry()).ready, true, failures.map(error => error.message).join('\n'));
    assert.equal((await readBrowserRuntimeStatus(root)).state, 'ready');
    const runtime = await readInstalledBrowserRuntime({ runtimeRoot: join(root, 'browser-runtime'), target: facts });
    assert.deepEqual(await checkBrowserRuntimeReadiness(runtime), { ready: true });
    assert.equal((await readFile(restriction, 'utf8')).trim(), '1');
    t.diagnostic(JSON.stringify({ buildHost: browser.target, publishedTarget: selected.target, requirements,
      browserRuntimeStatus: owner.status(), apparmorRestriction: 1 }));
  } finally {
    try { await owner?.close(); }
    finally {
      if (profileInstalled) {
        execFileSync('sudo', ['-n', 'apparmor_parser', '-R', '/etc/apparmor.d/foreman-browser-runtime']);
        execFileSync('sudo', ['-n', 'rm', '/etc/apparmor.d/foreman-browser-runtime']);
      }
      execFileSync('sudo', ['-n', 'sysctl', '-w', `kernel.apparmor_restrict_unprivileged_userns=${previousRestriction}`]);
    }
  }

});
