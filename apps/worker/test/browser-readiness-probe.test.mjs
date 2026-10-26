import test from 'node:test';
import assert from 'node:assert/strict';
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { probeBrowserRuntime } from '../src/browserRuntimeInstall.mjs';

test('reports a sandbox failure with the actual install command and can recheck after repair', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'foreman-browser-probe-'));
  const previous = process.env.PATH;
  process.env.PATH = directory;
  t.after(async () => {
    if (previous === undefined) delete process.env.PATH; else process.env.PATH = previous;
    await rm(directory, { recursive: true, force: true });
  });
  await writeFile(join(directory, 'manifest.json'), '{}');
  await writeFile(join(directory, 'Xvfb'), '#!/bin/sh\nexit 0\n', { mode: 0o700 });
  await chmod(join(directory, 'Xvfb'), 0o700);
  const python = join(directory, 'python');
  const descriptor = { rootDirectory: directory, pythonExecutable: python, chromiumExecutable: 'chromium' };
  await writeFile(python, `#!${process.execPath}\nprocess.stderr.write('No usable sandbox!'); process.exit(1);\n`, { mode: 0o700 });
  const failure = await probeBrowserRuntime(descriptor, { releaseDirectory: directory });
  assert.equal(failure.ready, false);
  assert.match(failure.reason, /sudo install -m 0644/);
  assert.ok(failure.reason.includes(join(directory, 'runtime/browser/apparmor/foreman-browser-runtime')));
  await writeFile(python, `#!${process.execPath}\nconsole.log(JSON.stringify({ready:true}));\n`, { mode: 0o700 });
  assert.deepEqual(await probeBrowserRuntime(descriptor, { releaseDirectory: directory }), { ready: true, reason: null });
});
