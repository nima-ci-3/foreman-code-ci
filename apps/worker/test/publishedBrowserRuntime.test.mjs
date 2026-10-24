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
import { matchesBrowserRuntimeTarget } from '../src/browserRuntimeInstall.mjs';
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
  const installed = await installVersion({ root: join(browser.directory, 'installed-worker'), stateDirectory,
    artifact: output, approvedManifestSha256: createHash('sha256').update(bytes).digest('hex'),
    facts: { ...selected.target, rootPersistent: true, homePersistent: true, storagePersistent: true },
    expected: { protocolVersion: 1, identityFormat: 1 }, stageOnly: true });
  assert.equal(installed.browserRuntimeStatus.state, 'staged');
  assert.ok(installed.browserRuntime);
  t.diagnostic(JSON.stringify({ buildHost: browser.target, publishedTarget: selected.target, requirements,
    browserRuntimeStatus: installed.browserRuntimeStatus.state }));

});
