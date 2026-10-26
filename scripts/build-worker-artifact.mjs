import { verificationRuntimeFiles, verificationArtifactPath } from '../packages/verification-runner/runtime-files.mjs';
import { INSTALLATION_NAMES, standaloneInstallationSource } from '../packages/contracts/src/installationNames.mjs'

import { readProductEnvironment } from '../packages/contracts/src/productEnvironment.mjs'
import { inspectQuotaHelperAbi } from './quota-helper-abi.mjs';
import { buildBrowserRuntimeRecipe } from './browser-runtime-install.mjs';
import { downloadPinnedNodeArchive } from '../apps/worker/src/nodeRuntime.mjs';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire, isBuiltin } from 'node:module';
import {
  assertWorkerSnapshotSource, rsyncWriterEntrypoint, schemaWorkerEntrypoint,
  verificationScripts, workerEntryPoints, workerPackageAliases,
} from './worker-snapshot-policy.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(join(root, 'apps/worker/package.json'));
const { build } = require('esbuild');
const { parse } = require('yaml');
const { Unpackr } = require('msgpackr');
const unpacker = new Unpackr({ useRecords: true, moreTypes: true });
import {
  copySharpPackagesFromStore, copyClaudeSdkPackagesFromStore, artifactFiles, assertWorkerDependency,
  committedWorkerInputPath, workerReleaseVersion, validateWorkerTarget, assertWorkerUpdateToolchain,
} from './worker-artifact-files.mjs';

const [targetFile, outputDirectory, runtimeFile = 'apps/worker/artifacts/node-24.22.1-linux-x64.json', bootstrapNode] = process.argv.slice(2);
if (!targetFile || !outputDirectory) throw new Error('Usage: build-worker-artifact.mjs apps/worker/artifacts/approved-target.json /new-output-directory [apps/worker/artifacts/reviewed-runtime.json]');
const requestedCommit = readProductEnvironment(process.env, 'WORKER_BUILD_COMMIT');
if (requestedCommit && !/^[a-f0-9]{40}$/.test(requestedCommit)) throw new Error('Invalid captured commit');
const commit = execFileSync('git', ['rev-parse', requestedCommit ? `${requestedCommit}^{commit}` : 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
const snapshot = new Map();
function snapshotSource(path) {
  assertWorkerSnapshotSource(path);
  if (!snapshot.has(path)) {
    const bytes = execFileSync('git', ['show', `${commit}:${path}`], { cwd: root, stdio: ['ignore', 'pipe', 'pipe'] });
    const gitBlobSha1 = execFileSync('git', ['rev-parse', `${commit}:${path}`], { cwd: root, encoding: 'utf8' }).trim();
    snapshot.set(path, { bytes, gitBlobSha1, sha256: hash(bytes) });
  }
  return snapshot.get(path).bytes;
}
async function requirePinnedSource(path) {
  if (!snapshotSource(path).equals(await readFile(join(root, path)))) throw new Error(`Uncommitted build control input: ${path}`);
}
for (const path of ['scripts/build-worker-artifact.mjs', 'scripts/browser-runtime-install.mjs', 'scripts/worker-artifact-files.mjs', 'packages/contracts/package.json', 'packages/contracts-node/package.json', 'apps/api/package.json', 'apps/ci/package.json', 'packages/contracts/src/productEnvironment.mjs', 'packages/contracts/src/installationNames.mjs', 'packages/contracts/src/packagePolicy.mjs', 'apps/worker/package.json', 'package.json', 'pnpm-workspace.yaml', 'pnpm-lock.yaml']) await requirePinnedSource(path);
await requirePinnedSource('scripts/quota-helper-abi.mjs');
await requirePinnedSource('scripts/worker-snapshot-policy.mjs');
await requirePinnedSource('apps/worker/artifacts/licenses/cfworker.txt');
function reviewedInput(input) {
  const path = committedWorkerInputPath(root, input);
  let bytes;
  try {
    bytes = snapshotSource(path);
  } catch (error) {
    throw new Error(`Reviewed input ${path} must exist in captured commit ${commit}. Commit and review it before building.`,
      { cause: error });
  }
  return { path, value: JSON.parse(bytes.toString('utf8')) };
}
assertWorkerUpdateToolchain(JSON.parse(snapshotSource('package.json')));
const targetInput = reviewedInput(targetFile);
if (bootstrapNode && !['v22.23.2', 'v22.23.3'].includes(bootstrapNode)) throw new Error('Unsupported Worker bootstrap runtime');
const target = { ...targetInput.value, ...(bootstrapNode ? { node: bootstrapNode } : {}) };
validateWorkerTarget(targetInput.value);
const runtimeInput = runtimeFile ? reviewedInput(runtimeFile) : null;
const runtime = runtimeInput?.value;
if (runtime && (runtime.format !== 1 || runtime.runtime !== 'node' || runtime.platform !== 'linux' || runtime.arch !== target.arch || runtime.version !== targetInput.value.node
  || !/^[a-f0-9]{64}$/.test(runtime.archive?.sha256) || !/^[a-f0-9]{64}$/.test(runtime.nodeExecutable?.sha256)
  || !/^[A-F0-9]{40}$/.test(runtime.trustedRelease?.primarySignerFingerprint))) throw new Error('Reviewed runtime does not match target');
// Fresh directories only: never mix files from another release or ship credentials.
const output = resolve(outputDirectory); await mkdir(output, { mode: 0o700 }); await mkdir(join(output, 'src'));
const buildOptions = { absWorkingDir: root, outdir: join(output, 'src'), outExtension: { '.js': '.mjs' }, bundle: true, platform: 'node', format: 'esm', target: 'node24', metafile: true, sourcemap: false, packages: 'bundle', external: ['sharp'],
  alias: workerPackageAliases({ contracts: JSON.parse(snapshotSource('packages/contracts/package.json')).exports,
    'contracts-node': JSON.parse(snapshotSource('packages/contracts-node/package.json')).exports,
    ci: JSON.parse(snapshotSource('apps/ci/package.json')).exports,
    api: JSON.parse(snapshotSource('apps/api/package.json')).exports }),
  plugins: [{ name: 'committed-source-snapshot', setup(builder) {
    builder.onResolve({ filter: /.*/ }, input => { assertWorkerDependency(input.path); });
    builder.onLoad({ filter: /\.(?:[cm]?[jt]s|json)$/ }, (input) => {
      const path = relative(root, input.path);
      if (path.startsWith('node_modules/') || path.includes('/node_modules/')) return;
      return { contents: snapshotSource(path).toString('utf8'), loader: path.endsWith('.json') ? 'json' : path.endsWith('ts') ? 'ts' : 'js', resolveDir: dirname(input.path) };
    });
  } }],
  define: { 'process.env.WS_NO_BUFFER_UTIL': '"1"', 'process.env.WS_NO_UTF_8_VALIDATE': '"1"' },
  banner: { js: "import { createRequire as workerCreateRequire } from 'node:module'; const require = workerCreateRequire(import.meta.url);" } };
const entryPoints = { ...workerEntryPoints, 'cli-main': workerEntryPoints.cli };
delete entryPoints.cli;
const built = await build({ ...buildOptions, entryPoints });
await writeFile(join(output, 'src/cli.mjs'), `import { fileURLToPath } from 'node:url';\nimport { bootstrapWorkerRuntime } from './runtimeBootstrap.mjs';\nawait bootstrapWorkerRuntime(fileURLToPath(new URL('../', import.meta.url)));\nawait import('./cli-main.mjs');\n`, { mode: 0o600 });
if (rsyncWriterEntrypoint in built.metafile.inputs) throw new Error('Standalone rsync writer imported by normal worker graph');
const writer = await build({ ...buildOptions, entryPoints: { 'rsync-writer': rsyncWriterEntrypoint } });
const schemaWorker = await build({ ...buildOptions,
  entryPoints: { schemaWorker: schemaWorkerEntrypoint } });
for (const source of new Set([...Object.keys(built.metafile.inputs), ...Object.keys(writer.metafile.inputs), ...Object.keys(schemaWorker.metafile.inputs)])) {
  if (!source.startsWith('node_modules/') && !source.includes('/node_modules/')) snapshotSource(source);
}
for (const entry of [...Object.values(built.metafile.outputs), ...Object.values(writer.metafile.outputs), ...Object.values(schemaWorker.metafile.outputs)]) for (const dependency of entry.imports) {
  if (dependency.external && !isBuiltin(dependency.path) && dependency.path !== 'sharp') throw new Error(`Unbundled dependency: ${dependency.path}`);
}
for (const name of ['installation.mjs', 'diagnostics.mjs', 'service.mjs', 'install-cli.mjs', 'runtime.mjs', 'setup.mjs', 'companion.mjs', 'setupInput.mjs', 'companionServer.mjs', 'companionService.mjs', 'companionLauncher.mjs', 'harnessPath.mjs',
  'updateSupervisor.mjs', 'update-supervisor-cli.mjs', 'updateOperation.mjs', 'updateRecord.mjs', 'ciSmokeTiming.mjs', 'browserRuntimeInstall.mjs', 'browserRuntime.mjs', 'browserDeviceExtension.mjs', 'nodeRuntime.mjs', 'runtimeBootstrap.mjs']) {
  await writeFile(join(output, 'src', name === 'companion.mjs' ? 'companion-main.mjs' : name), standaloneInstallationSource(snapshotSource(`apps/worker/src/${name}`).toString('utf8')), { mode: 0o600 });
}
await writeFile(join(output, 'src/companion.mjs'), `import { fileURLToPath } from 'node:url';\nimport { bootstrapWorkerRuntime } from './runtimeBootstrap.mjs';\nawait bootstrapWorkerRuntime(fileURLToPath(new URL('../', import.meta.url)));\nawait import('./companion-main.mjs');\n`, { mode: 0o600 });
await mkdir(join(output, 'artifacts'));
const browserProfile = 'runtime/browser/apparmor/foreman-browser-runtime';
await mkdir(dirname(join(output, browserProfile)), { recursive: true });
await writeFile(join(output, browserProfile), snapshotSource(browserProfile), { mode: 0o600 });
const quotaQuerySource = 'apps/worker/artifacts/job-quota-query.c';
const quotaQueryPath = join(output, 'artifacts/job-quota-query.c');
await writeFile(quotaQueryPath, snapshotSource(quotaQuerySource), { mode: 0o600 });
execFileSync('cc', ['-std=c11', '-O2', '-Wall', '-Wextra', '-Werror', quotaQueryPath,
  '-o', join(output, 'artifacts/job-quota-query')], { stdio: ['ignore', 'pipe', 'pipe'] });
await inspectQuotaHelperAbi(join(output, 'artifacts/job-quota-query'), target);

await writeFile(join(output, INSTALLATION_NAMES.artifacts.icon), snapshotSource('apps/web/public/graphql.svg'), { mode: 0o600 });
await writeFile(join(output, INSTALLATION_NAMES.artifacts.mcpLauncher), standaloneInstallationSource(snapshotSource('scripts/foreman-mcp.mjs').toString('utf8')), { mode: 0o600 });
await writeFile(join(output, INSTALLATION_NAMES.artifacts.workerService), snapshotSource('apps/worker/artifacts/foreman-worker.service.in'), { mode: 0o600 });
await writeFile(join(output, 'artifacts/companion.html'), snapshotSource('apps/worker/artifacts/companion.html'), { mode: 0o600 });
const ciRuntimeControls = ['Containerfile', 'corepack', 'context.mjs', 'seed-policy.mjs', 'verification-policy.mjs', 'verification-observation.mjs'];
await mkdir(join(output, 'artifacts/ci-runtime'));
for (const name of ciRuntimeControls) {
  await writeFile(join(output, 'artifacts/ci-runtime', name), standaloneInstallationSource(snapshotSource(`apps/worker/artifacts/ci-runtime/${name}`).toString('utf8')),
    { mode: name === 'corepack' ? 0o700 : 0o600 });
}
const committedScripts = new Set(execFileSync('git', ['ls-tree', '-r', '--name-only', commit, '--', ...verificationScripts],
  { cwd: root, encoding: 'utf8' }).trim().split('\n'));
if (verificationScripts.every(path => committedScripts.has(path))) {
  for (const path of verificationRuntimeFiles) {
    const destination = join(output, 'artifacts', verificationArtifactPath(path));
    await mkdir(dirname(destination), { recursive: true });
    await writeFile(destination, standaloneInstallationSource(snapshotSource(path).toString('utf8')), { mode: 0o600 });
  }
}
await writeFile(join(output, 'install'), snapshotSource('apps/worker/artifacts/install.sh.in').toString('utf8').replaceAll('@NODE_VERSION@', target.node), { mode: 0o700 });
if (runtime) await writeFile(join(output, 'artifacts/node-runtime.json'), snapshotSource(runtimeInput.path), { mode: 0o600 });
// Old updaters verify and download ordinary manifest files before starting their readiness window.
const runtimeArchivePath = bootstrapNode ? 'artifacts/node-runtime.tar.xz' : undefined;
if (runtimeArchivePath) await copyPinnedNodeArchive(join(output, runtimeArchivePath), runtime);
const { storeDir: store } = parse(await readFile(join(root, 'node_modules/.modules.yaml'), 'utf8'));
const nativePackages = await copySharpPackagesFromStore({
  root,
  output,
  store,
  lock: parse(snapshotSource('pnpm-lock.yaml').toString('utf8')),
  decode: blob => unpacker.unpack(blob),
});
const runtimePackages = await copyClaudeSdkPackagesFromStore({
  root, output, store, lock: parse(snapshotSource('pnpm-lock.yaml').toString('utf8')),
  decode: blob => unpacker.unpack(blob),
});
const releaseVersion = workerReleaseVersion(JSON.parse(snapshotSource('package.json').toString('utf8')));
// The browser runs under the execution Node (a transition bundle carries Node 24 but targets Node 22 for transport).
const browserRuntime = await buildBrowserRuntimeRecipe({ repository: root, commit, target: targetInput.value, foremanVersion: releaseVersion,
  output: join(output, 'artifacts/browser-runtime'), snapshot: { read: async path => snapshotSource(path) } });
const browserRuntimeStatus = { state: 'ready', retryable: false, reason: null };
const files = await artifactFiles(output);
if (files.length > 512 || files.some(file => file.size > 64 * 1024 * 1024)) {
  throw new Error('Worker artifact exceeds its existing ordinary package limits. Browser dependencies must remain outside the release.');
}
const manifest = { format: 1, version: releaseVersion, commit, lockfileSha256: hash(snapshotSource('pnpm-lock.yaml')), packageManager: 'pnpm@11.27.0', protocolVersion: 1, identityFormat: 1, target, nativePackages, runtimePackages, workerApiModules: Object.keys(built.metafile.inputs).filter(path => path.startsWith('apps/api/')).sort(), rsyncWriterApiModules: Object.keys(writer.metafile.inputs).filter(path => path.startsWith('apps/api/')).sort(), sourceSnapshot: { commit, files: [...snapshot.entries()].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([path, { gitBlobSha1, sha256 }]) => ({ path, gitBlobSha1, sha256 })) },
  browserRuntimeStatus,
  ...(browserRuntime ? { browserRuntime: { descriptorPath: 'artifacts/browser-runtime/browser-runtime.json', descriptorSha256: browserRuntime.descriptorSha256,
    recipeSha256: browserRuntime.descriptorSha256 } } : {}),
  ...(runtime ? { runtime: { metadataPath: 'artifacts/node-runtime.json', ...(runtimeArchivePath ? { archivePath: runtimeArchivePath } : {}), version: runtime.version, archiveSha256: runtime.archive.sha256, executableSha256: runtime.nodeExecutable.sha256, qualification: 'future installation requires actual target readback' } } : {}), files };
await writeFile(join(output, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 });
console.log(JSON.stringify({ manifestSha256: hash(await readFile(join(output, 'manifest.json'))), version: releaseVersion, commit: manifest.commit, files: files.length }));

/** One download of the pinned Node archive serves every transition carrier and later builds; each copy is rechecked. */
async function copyPinnedNodeArchive(destination, metadata) {
  const cache = join(homedir(), '.cache', 'foreman-code', 'node-runtime');
  await mkdir(cache, { recursive: true, mode: 0o700 });
  const cached = join(cache, `${metadata.archive.sha256}.tar.xz`);
  if (!existsSync(cached)) {
    const partial = `${cached}.${process.pid}.partial`;
    try {
      await downloadPinnedNodeArchive(partial, metadata);
      await rename(partial, cached);
    } finally { await rm(partial, { force: true }); }
  }
  await downloadPinnedNodeArchive(destination, metadata, { archivePath: cached });
}
