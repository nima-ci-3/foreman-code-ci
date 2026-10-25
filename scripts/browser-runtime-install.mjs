import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { createReadStream, createWriteStream } from 'node:fs';
import { copyFile, lstat, mkdir, mkdtemp, open, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { basename, dirname, join, relative, resolve } from 'node:path';
import { createRequire, isBuiltin } from 'node:module';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { createGzip } from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { BROWSER_RUNTIME_MAGIC, BROWSER_RUNTIME_CHUNK_BYTES, hashBrowserRuntimeFile,
  validateBrowserRuntimeManifest, checkBrowserRuntimeReadiness,
  copyBuiltBrowserRuntime, matchesBrowserRuntimeTarget } from '../apps/worker/src/browserRuntimeInstall.mjs';
import { cfworkerLicense, validateWorkerTarget, assertWorkerDependency } from './worker-artifact-files.mjs';
import { assertWorkerSnapshotSource, workerPackageAliases } from './worker-snapshot-policy.mjs';

import { downloadBrowserRuntimeArtifact, extractPinnedPython, extractChromium, resolvePythonLock,
  installLockedWheels, normalizeBrowserPythonEntrypoints, listUnitFiles, collectChromiumNotices,
  validateWheelClosure } from '../apps/worker/src/browserRuntimeBuild.mjs';
export { downloadBrowserRuntimeArtifact, normalizeBrowserPythonEntrypoints, collectChromiumNotices } from '../apps/worker/src/browserRuntimeBuild.mjs';

const execute = promisify(execFile);
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const controls = new Set(['runtime/browser/manifest.json', 'runtime/browser/runtime-lock.json', 'runtime/browser/LICENSES.txt',
  'scripts/browser-runtime-install.mjs', 'apps/worker/src/browserRuntimeInstall.mjs', 'apps/worker/src/browserRuntimeBuild.mjs', 'scripts/worker-artifact-files.mjs',
  'scripts/worker-snapshot-policy.mjs', 'runtime/browser/licenses/MIT.txt', 'runtime/browser/credits.py', 'package.json', 'pnpm-lock.yaml', 'pnpm-workspace.yaml', 'packages/contracts/package.json', 'packages/contracts-node/package.json', 'apps/ci/package.json']);
const invariant = (condition, message) => { if (!condition) throw new Error(`Browser runtime assembly: ${message}`); };

async function sourceSnapshot(repository, commit, run) {
  invariant(/^[a-f0-9]{40}$/.test(commit), 'exact source commit required');
  const files = new Map();
  const read = async path => {
    if (!controls.has(path)) assertWorkerSnapshotSource(path);
    if (files.has(path)) return files.get(path).bytes;
    const result = await run('git', ['show', `${commit}:${path}`], { cwd: repository, encoding: 'buffer', maxBuffer: 32 * 1024 * 1024 });
    const bytes = Buffer.from(result.stdout);
    const { stdout } = await run('git', ['rev-parse', `${commit}:${path}`], { cwd: repository });
    files.set(path, { bytes, path, gitBlobSha1: String(stdout).trim(), sha256: sha256(bytes) });
    return bytes;
  };
  for (const path of controls) {
    invariant((await read(path)).equals(await readFile(join(repository, path))), `uncommitted control input ${path}`);
  }
  return { read, entries: () => [...files.values()].map(({ path, gitBlobSha1, sha256 }) => ({ path, gitBlobSha1, sha256 }))
    .sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0) };
}

async function requireNativeTarget(target) {
  validateWorkerTarget(target);
  const osRelease = await readFile('/etc/os-release', 'utf8');
  const values = Object.fromEntries(osRelease.split('\n').filter(line => /^[A-Z_]+=/.test(line))
    .map(line => { const index = line.indexOf('='); return [line.slice(0, index), line.slice(index + 1).replace(/^"|"$/g, '')]; }));
  invariant(values.ID === target.os && values.VERSION_ID === target.osRelease && process.arch === target.arch
    && process.version === target.node && `glibc-${process.report.getReport().header.glibcVersionRuntime}` === target.libc,
  'build on the exact committed supported target; cross-building is not qualified');
}

/** Runtime supports the managed Python/module interface only, never pip-generated console launchers. */

export async function copyNativeLicenses(inputs, repository, unit, readSource = path => readFile(join(repository, path))) {
  const seen = new Set();
  for (const input of inputs.filter(path => path.includes('node_modules/'))) {
    let directory = dirname(resolve(repository, input)), manifest;
    for (;;) {
      try {
        manifest = JSON.parse(await readFile(join(directory, 'package.json'), 'utf8'));
        if (typeof manifest.name === 'string' && typeof manifest.version === 'string') break;
      }
      catch (error) { if (error.code !== 'ENOENT') throw error; }
      invariant(basename(directory) !== 'node_modules' && dirname(directory) !== directory,
        `native dependency package metadata missing: ${input}`);
      directory = dirname(directory);
    }
    if (seen.has(directory)) continue;
    seen.add(directory);
    const name = `${manifest.name.replace(/[^a-zA-Z0-9_.-]/g, '_')}-${manifest.version}`;
    const destination = join(unit, 'licenses/native-packages', name); await mkdir(destination, { recursive: true, mode: 0o700 });
    const licenses = (await readdir(directory)).filter(name => /^(?:licen[cs]e|copying|notice)(?:\.|$)/i.test(name));
    if (`${manifest.name}@${manifest.version}` === cfworkerLicense.package && manifest.license === 'MIT') {
      const terms = await readSource(cfworkerLicense.path);
      invariant(sha256(terms) === cfworkerLicense.sha256, `native dependency notice checksum mismatch: ${manifest.name}`);
      await writeFile(join(destination, 'LICENSE'), terms);
    } else invariant(licenses.length > 0, `native dependency notice missing: ${manifest.name}`);
    for (const path of licenses) if ((await lstat(join(directory, path))).isFile()) await copyFile(join(directory, path), join(destination, path));
    await writeFile(join(destination, 'package.json'), `${JSON.stringify({ name: manifest.name, version: manifest.version, license: manifest.license }, null, 2)}\n`);
  }
}

async function bundleNativeHost({ repository, unit, snapshot, entrypoint = 'apps/api/src/modules/browser-runtime/hostFactory.ts', filename = 'native-host.mjs' }) {
  const require = createRequire(join(repository, 'apps/worker/package.json')), { build } = require('esbuild');
  const contracts = JSON.parse(await snapshot.read('packages/contracts/package.json')).exports;
  const nodeContracts = JSON.parse(await snapshot.read('packages/contracts-node/package.json')).exports;
  const ci = JSON.parse(await snapshot.read('apps/ci/package.json')).exports;
  const result = await build({ absWorkingDir: repository, entryPoints: [entrypoint],
    outfile: join(unit, filename), bundle: true, platform: 'node', format: 'esm', target: 'node22', metafile: true,
    legalComments: 'linked', sourcemap: false, alias: workerPackageAliases({ contracts, 'contracts-node': nodeContracts, ci }),
    define: { 'process.env.WS_NO_BUFFER_UTIL': '"1"', 'process.env.WS_NO_UTF_8_VALIDATE': '"1"' },
    banner: { js: "import { createRequire as runtimeRequire } from 'node:module'; const require = runtimeRequire(import.meta.url);" },
    plugins: [{ name: 'browser-runtime-exact-source', setup(builder) {
      builder.onResolve({ filter: /.*/ }, input => { assertWorkerDependency(input.path); });
      builder.onLoad({ filter: /\.(?:[cm]?[jt]s|json)$/ }, async input => {
        const path = relative(repository, input.path);
        if (path.includes('node_modules/')) return;
        const contents = await snapshot.read(path);
        return { contents: contents.toString('utf8'), loader: path.endsWith('.ts') ? 'ts' : path.endsWith('.json') ? 'json' : 'js', resolveDir: dirname(input.path) };
      });
    } }] });
  for (const output of Object.values(result.metafile.outputs)) {
    for (const dependency of output.imports) invariant(!dependency.external || isBuiltin(dependency.path), `unbundled native module ${dependency.path}`);
  }
  await copyNativeLicenses(Object.keys(result.metafile.inputs), repository, unit, snapshot.read);
}

/** Exported artifact packer also accepts tiny fixture units through its public interface. */
export async function packBrowserRuntime({ unit, output, manifest, outputOwned = false, onProgress }) {
  const files = await listUnitFiles(unit);
  onProgress?.('runtime-inventory-hashed');
  manifest = validateBrowserRuntimeManifest({ ...manifest, files: files.map(({ source, ...file }) => file) }, manifest.target);
  const bytes = Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`), length = Buffer.alloc(4); length.writeUInt32BE(bytes.length);
  if (!outputOwned) await mkdir(output, { mode: 0o700 });
  const archive = join(output, '.runtime.gz');
  async function* payload() {
    yield Buffer.from(BROWSER_RUNTIME_MAGIC); yield length; yield bytes;
    for (const file of files) for await (const chunk of createReadStream(file.source)) yield chunk;
  }
  try {
    await pipeline(Readable.from(payload()), createGzip({ level: 6 }), createWriteStream(archive, { flags: 'wx', mode: 0o600 }));
    onProgress?.('runtime-compressed');
    const identity = await hashBrowserRuntimeFile(archive), handle = await open(archive, 'r'), chunks = [];
    try {
      let offset = 0;
      while (offset < identity.size) {
        const bytes = Buffer.alloc(Math.min(BROWSER_RUNTIME_CHUNK_BYTES, identity.size - offset));
        const read = await handle.read(bytes, 0, bytes.length, offset); invariant(read.bytesRead === bytes.length, 'truncated assembled archive');
        const path = `chunk-${String(chunks.length).padStart(6, '0')}.bin`;
        await writeFile(join(output, path), bytes, { flag: 'wx', mode: 0o600 });
        chunks.push({ path, size: bytes.length, sha256: sha256(bytes) }); offset += bytes.length;
      }
    } finally { await handle.close(); }
    invariant(chunks.length <= 256, 'runtime unit exceeds bounded chunk inventory');
    const descriptor = { format: 1, kind: 'foreman-browser-runtime-artifact', target: manifest.target,
      runtimeVersion: manifest.runtimeVersion, sourceCommit: manifest.sourceCommit, sourceInputs: manifest.sourceInputs,
      archiveSha256: identity.sha256, compressedBytes: identity.size, manifestSha256: sha256(bytes), chunks };
    const descriptorBytes = Buffer.from(`${JSON.stringify(descriptor, null, 2)}\n`);
    await writeFile(join(output, 'browser-runtime.json'), descriptorBytes, { flag: 'wx', mode: 0o600 });
    return { descriptor, descriptorSha256: sha256(descriptorBytes), manifest };
  } finally { await rm(archive, { force: true }); }
}

/** Deliberate release assembly only. Startup/install consume its locked immutable output. */
export async function assembleBrowserRuntime({ repository, commit, target, foremanVersion, output, resolvedLock,
  run = execute, fetchArtifact = globalThis.fetch, readiness = checkBrowserRuntimeReadiness, onProgress }) {
  // Reservation happens before any cleanup scope. An existing destination is never owned or deleted here.
  await mkdir(output, { mode: 0o700 });
  let temporary;
  try {
  await requireNativeTarget(target);
  const snapshot = await sourceSnapshot(repository, commit, run);
  const recipe = JSON.parse(await snapshot.read('runtime/browser/manifest.json'));
  const inputs = JSON.parse(await snapshot.read('runtime/browser/runtime-lock.json'));
  invariant(recipe.kind === 'foreman-browser-runtime-recipe' && inputs.kind === 'foreman-browser-build-inputs', 'invalid source recipe');
  temporary = await mkdtemp(join(dirname(resolve(output)), '.browser-build-'));
  const unit = join(temporary, 'unit'); await mkdir(unit, { mode: 0o700 });
    const pythonArchive = join(temporary, 'python.tar.gz');
    await downloadBrowserRuntimeArtifact(inputs.python.url, pythonArchive, inputs.python.sha256, fetchArtifact);
    await extractPinnedPython({ archive: pythonArchive, unit, run });
    onProgress?.('python-extracted');
    const python = join(unit, 'python/bin/python3');
    const lock = await resolvePythonLock({ python, inputs, target, temporary, previous: resolvedLock, run });
    const licenseTexts = {};
    for (const [expression, entry] of Object.entries(inputs.licenseTexts)) {
      const bytes = await snapshot.read(entry.path);
      invariant(sha256(bytes) === entry.sha256, `license text checksum mismatch: ${expression}`);
      licenseTexts[expression] = { ...entry, text: bytes.toString('utf8') };
    }
    await installLockedWheels({ lock, inputs, python, licenseTexts, wheelhouse: join(temporary, 'wheels'), unit, fetchArtifact, run });
    await normalizeBrowserPythonEntrypoints({ python, unit, run });
    onProgress?.('python-dependencies-installed');
    const chromiumArchive = join(temporary, 'chromium.zip');
    const chromium = await downloadBrowserRuntimeArtifact(inputs.chromium.url, chromiumArchive,
      resolvedLock?.chromium.sha256 ?? inputs.chromium.sha256, fetchArtifact);
    lock.chromium = { ...inputs.chromium, ...chromium };
    await extractChromium(python, chromiumArchive, join(unit, 'chromium'), run);
    onProgress?.('chromium-extracted');
    await writeFile(join(unit, 'bridge.py'), await snapshot.read(recipe.bridgeSource), { mode: 0o600 });
    await writeFile(join(unit, 'browser-use.md'), await snapshot.read(recipe.skillSource), { mode: 0o600 });
    await bundleNativeHost({ repository, unit, snapshot });
    await writeFile(join(unit, 'credits.py'), await snapshot.read('runtime/browser/credits.py'), { mode: 0o600 });
    await collectChromiumNotices(join(unit, 'chromium/chrome-linux64/chrome'), unit, temporary, run);
    onProgress?.('host-and-browser-notices-built');
    const pythonNotices = (await listUnitFiles(join(unit, 'python'))).filter(file => /(?:license|licence|copying|notice)/i.test(file.path));
    invariant(pythonNotices.length > 0, 'standalone Python notices missing');
    await writeFile(join(unit, 'LICENSES.txt'), (await snapshot.read('runtime/browser/LICENSES.txt')).toString()
      + '\nBundled notice inventory:\nlicenses/chromium-credits.html\nlicenses/python-packages/index.json\nlicenses/native-packages/\n'
      + pythonNotices.map(file => `python/${file.path}`).join('\n') + '\n', { mode: 0o600 });
    lock.nativeDependencyLockSha256 = sha256(await snapshot.read('pnpm-lock.yaml'));
    const lockBytes = Buffer.from(`${JSON.stringify(lock, null, 2)}\n`);
    await writeFile(join(unit, 'runtime-lock.json'), lockBytes, { mode: 0o600 });
    onProgress?.('dependency-notices-indexed');
    const manifest = { format: 1, kind: 'foreman-browser-runtime', runtimeVersion: recipe.runtimeVersion, foremanVersion,
      profileFormat: recipe.profileFormat, target, sourceCommit: commit, sourceInputs: snapshot.entries(),
      pythonVersion: recipe.pythonVersion, browserUseVersion: recipe.browserUseVersion, browserHarnessVersion: recipe.browserHarnessVersion,
      chromiumVersion: recipe.chromiumVersion, chromiumRevision: recipe.chromiumRevision,
      pythonEntrypointPolicy: 'managed-python-module-only',
      resolvedLockSha256: sha256(lockBytes), pythonExecutable: 'python/bin/python3', chromiumExecutable: 'chromium/chrome-linux64/chrome',
      bridgeScript: 'bridge.py', nativeHostModule: 'native-host.mjs', skill: 'browser-use.md' };
    await writeFile(join(unit, 'manifest.json'), `${JSON.stringify(manifest)}\n`, { mode: 0o600 });
    invariant((await readiness({ rootDirectory: unit, pythonExecutable: python,
      chromiumExecutable: join(unit, manifest.chromiumExecutable) }))?.ready === true, 'runtime readiness was not confirmed');
    onProgress?.('runtime-readiness-verified');
    await rm(join(unit, 'manifest.json'));
    const result = await packBrowserRuntime({ unit, output, manifest, outputOwned: true, onProgress });
    onProgress?.('runtime-packed');
    await writeFile(join(output, 'resolved-lock.json'), lockBytes, { flag: 'wx', mode: 0o600 });
    await writeFile(join(output, 'index.json'), `${JSON.stringify({ format: 1, sourceCommit: commit,
      artifacts: [{ directory: '.', target, descriptorSha256: result.descriptorSha256 }] })}\n`, { flag: 'wx', mode: 0o600 });
    return result;
  } catch (error) { await rm(output, { recursive: true, force: true }); throw error; }
  finally { if (temporary) await rm(temporary, { recursive: true, force: true }); }
}

/** Release assembly ships code and an approved recipe, never target executables. */
export async function buildBrowserRuntimeRecipe({ repository, commit, target, foremanVersion, output, snapshot }) {
  snapshot ??= await sourceSnapshot(repository, commit, execute);
  const read = async path => Buffer.from(await snapshot.read(path));
  const recipe = JSON.parse(await read('runtime/browser/manifest.json'));
  const inputBytes = await read('runtime/browser/runtime-lock.json'), inputs = JSON.parse(inputBytes);
  const lock = JSON.parse(await read(`runtime/browser/ubuntu-${target.osRelease}-${target.arch}-resolved-lock.json`));
  await resolvePythonLock({ inputs, target, previous: lock });
  validateWheelClosure(lock, inputs);
  await mkdir(output, { mode: 0o700 });
  await bundleNativeHost({ repository, unit: output, snapshot });
  await bundleNativeHost({ repository, unit: output, snapshot,
    entrypoint: 'apps/worker/src/browserRuntimeBuild.mjs', filename: 'installer.mjs' });
  for (const [path, source] of Object.entries({ 'bridge.py': recipe.bridgeSource, 'browser-use.md': recipe.skillSource,
    'credits.py': 'runtime/browser/credits.py', 'LICENSES.txt': 'runtime/browser/LICENSES.txt' })) {
    await writeFile(join(output, path), await read(source), { mode: 0o600 });
  }
  const licenseTexts = {};
  for (const [expression, entry] of Object.entries(inputs.licenseTexts)) {
    const bytes = await read(entry.path);
    invariant(sha256(bytes) === entry.sha256, `license text checksum mismatch: ${expression}`);
    licenseTexts[expression] = { ...entry, text: bytes.toString('utf8') };
  }
  const lockBytes = Buffer.from(`${JSON.stringify(lock, null, 2)}\n`);
  const manifest = { format: 1, kind: 'foreman-browser-runtime', runtimeVersion: recipe.runtimeVersion, foremanVersion,
    profileFormat: recipe.profileFormat, target, sourceCommit: commit,
    pythonVersion: recipe.pythonVersion, browserUseVersion: recipe.browserUseVersion, browserHarnessVersion: recipe.browserHarnessVersion,
    chromiumVersion: recipe.chromiumVersion, chromiumRevision: recipe.chromiumRevision,
    pythonEntrypointPolicy: 'managed-python-module-only', resolvedLockSha256: sha256(lockBytes),
    pythonExecutable: 'python/bin/python3', chromiumExecutable: 'chromium/chrome-linux64/chrome',
    bridgeScript: 'bridge.py', nativeHostModule: 'native-host.mjs', skill: 'browser-use.md' };
  const files = (await listUnitFiles(output)).map(({ source, ...file }) => file);
  const descriptor = { format: 2, kind: 'foreman-browser-runtime-recipe', target, manifest, inputs,
    inputsSha256: sha256(inputBytes), resolvedLock: lock, licenseTexts, files };
  const bytes = Buffer.from(`${JSON.stringify(descriptor, null, 2)}\n`);
  await writeFile(join(output, 'browser-runtime.json'), bytes, { flag: 'wx', mode: 0o600 });
  return { descriptor, descriptorSha256: sha256(bytes) };
}

/** Collect native runner outputs for Main without relabelling or launching their executables. */
export async function collectBrowserRuntimeArtifacts({ directories, output, commit }) {
  invariant(directories.length > 0, 'native runner artifacts required');
  await mkdir(output, { mode: 0o700 });
  try {
    const artifacts = [];
    for (const directory of directories) {
      const index = JSON.parse(await readFile(join(directory, 'index.json'), 'utf8'));
      invariant(index.format === 1 && index.sourceCommit === commit && Array.isArray(index.artifacts)
        && index.artifacts.length > 0, 'build index source mismatch');
      for (const entry of index.artifacts) {
        validateWorkerTarget(entry.target);
        invariant(!artifacts.some(artifact => matchesBrowserRuntimeTarget(artifact.target, entry.target)),
          'duplicate native browser target');
        const name = `runtime-${artifacts.length}`;
        const copied = await copyBuiltBrowserRuntime({ directory, output: join(output, name), target: entry.target, commit });
        artifacts.push({ directory: name, target: copied.descriptor.target, descriptorSha256: copied.descriptorSha256 });
      }
    }
    const index = { format: 1, sourceCommit: commit, artifacts };
    await writeFile(join(output, 'index.json'), `${JSON.stringify(index)}\n`, { flag: 'wx', mode: 0o600 });
    return index;
  } catch (error) { await rm(output, { recursive: true, force: true }); throw error; }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [command, targetFile, output, lockFile] = process.argv.slice(2);
  const repository = resolve(dirname(fileURLToPath(import.meta.url)), '..');
  const { stdout } = await execute('git', ['rev-parse', 'HEAD'], { cwd: repository });
  const commit = String(stdout).trim();
  if (command === 'collect') {
    invariant(targetFile && output, 'usage: browser-runtime-install.mjs collect <new-output-directory> <native-artifact-directory>...');
    const index = await collectBrowserRuntimeArtifacts({ output: resolve(targetFile), commit,
      directories: process.argv.slice(4).map(directory => resolve(directory)) });
    process.stdout.write(`${JSON.stringify(index)}\n`);
  } else {
    invariant(command === 'assemble' && targetFile && output, 'usage: browser-runtime-install.mjs assemble <approved-target.json> <new-output-directory> [resolved-lock.json]');
    const target = JSON.parse(await readFile(resolve(repository, targetFile), 'utf8'));
    const foremanVersion = JSON.parse(await readFile(join(repository, 'package.json'), 'utf8')).version;
    const result = await assembleBrowserRuntime({ repository, commit, target, foremanVersion, output: resolve(output),
      ...(lockFile ? { resolvedLock: JSON.parse(await readFile(resolve(lockFile), 'utf8')) } : {}) });
    process.stdout.write(`${JSON.stringify({ descriptorSha256: result.descriptorSha256, manifestSha256: result.descriptor.manifestSha256 })}\n`);
  }
}
