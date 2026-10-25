import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readBrowserRuntimeArtifact } from '../src/browserRuntimeInstall.mjs';

for (const release of ['24.04', '26.04']) {
  test(`Ubuntu ${release} Worker release is code-sized and ships an approved recipe without browser binaries`, async t => {
    const directory = await mkdtemp(join(homedir(), '.cache', 'foreman-tmp', 'worker-recipe-build-'));
    t.after(() => rm(directory, { recursive: true, force: true }));
    const repository = fileURLToPath(new URL('../../../', import.meta.url));
    const output = join(directory, 'artifact');
    execFileSync(process.execPath, ['scripts/build-worker-artifact.mjs',
      `apps/worker/artifacts/ubuntu-${release}-x64-target.json`, output],
    { cwd: repository, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    const manifest = JSON.parse(await readFile(join(output, 'manifest.json'), 'utf8'));
    assert.equal(manifest.browserRuntimeStatus.state, 'ready');
    assert.ok(manifest.files.some(file => file.path === 'src/cli.mjs'));
    const recipe = await readBrowserRuntimeArtifact(join(output, 'artifacts/browser-runtime'),
      manifest.browserRuntime.recipeSha256);
    assert.equal(recipe.kind, 'foreman-browser-runtime-recipe');
    assert.equal(recipe.target.osRelease, release);
    assert.ok(recipe.resolvedLock.packages.length > 50);
    assert.ok(manifest.files.every(file => !/\.(?:whl|zip)$|chunk-\d+\.bin$|\/(?:python|chromium)\//.test(file.path)));
    const archive = join(directory, 'worker.tar.gz');
    execFileSync('tar', ['-czf', archive, '-C', output, '.']);
    const bytes = (await stat(archive)).size;
    t.diagnostic(JSON.stringify({ target: manifest.target, compressedBytes: bytes }));
    assert.ok(bytes <= 25 * 1024 * 1024, `${bytes} compressed bytes exceeds the release budget`);
  });
}
