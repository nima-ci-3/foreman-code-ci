import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { chmod, copyFile, lstat, mkdir, open, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { promisify } from 'node:util';
import { hashBrowserRuntimeFile, createBrowserRuntimeDirectory, removeBrowserRuntimeDirectory,
  matchesBrowserRuntimeTarget } from './browserRuntimeInstall.mjs';

const execute = promisify(execFile);
const digest = /^[a-f0-9]{64}$/;
const safePath = path => typeof path === 'string' && /^[a-zA-Z0-9_@.+/[\]-]+$/.test(path)
  && path.split('/').every(part => part && part !== '.' && part !== '..');
const invariant = (condition, message) => { if (!condition) throw new Error(`Browser runtime assembly: ${message}`); };

export async function downloadBrowserRuntimeArtifact(url, destination, expected, fetchArtifact = globalThis.fetch) {
  invariant(digest.test(expected ?? ''), 'expected artifact digest required');
  invariant(new URL(url).protocol === 'https:', 'invalid artifact URL');
  // An optional local cache keyed by the pinned digest; a cached copy is re-hashed before use.
  const cache = process.env.FOREMAN_BROWSER_ARTIFACT_CACHE;
  const cached = cache ? join(cache, expected) : undefined;
  if (cached) {
    const bytes = await readFile(cached).catch(error => { if (error.code === 'ENOENT') return undefined; throw error; });
    if (bytes && createHash('sha256').update(bytes).digest('hex') === expected) {
      await writeFile(destination, bytes, { flag: 'wx', mode: 0o600 });
      return { url, sha256: expected, size: bytes.length };
    }
  }
  let result;
  for (let attempt = 0; ; attempt++) {
    try { result = await fetchAndStore(url, destination, expected, fetchArtifact); break; }
    catch (error) {
      if (attempt === 2 || /checksum mismatch|artifact too large|EEXIST/.test(error.message)) throw error;
      console.warn(`Browser artifact download retry ${attempt + 1}: ${url}: ${error.message}`);
    }
  }
  if (cached) {
    await mkdir(cache, { recursive: true, mode: 0o700 });
    await copyFile(destination, cached);
  }
  return result;
}

export async function fetchAndStore(url, destination, expected, fetchArtifact) {
  const response = await fetchArtifact(url, { redirect: 'follow', signal: AbortSignal.timeout(300000) });
  invariant(response.ok && response.body, `artifact unavailable (${response.status})`);
  const handle = await open(destination, 'wx', 0o600), hash = createHash('sha256');
  let size = 0;
  try {
    for await (const value of response.body) {
      const bytes = Buffer.from(value); size += bytes.length;
      invariant(size <= 2 * 1024 ** 3, 'artifact too large');
      hash.update(bytes); await handle.writeFile(bytes);
    }
    const sha256 = hash.digest('hex');
    invariant(sha256 === expected, 'upstream artifact checksum mismatch');
    await handle.sync(); return { url, sha256, size };
  } catch (error) { await rm(destination, { force: true }); throw error; }
  finally { await handle.close(); }
}

export async function extractPinnedPython({ archive, unit, run }) {
  // The executable archive is checksum-pinned before extraction; no untrusted user archives enter this build path.
  const { stdout } = await run('tar', ['-tzf', archive], { maxBuffer: 16 * 1024 * 1024 });
  for (const entry of String(stdout).trim().split('\n')) {
    invariant(entry.startsWith('python/') && safePath(entry.replace(/\/$/, '')), 'unsafe Python archive entry');
  }
  await run('tar', ['--extract', '--gzip', '--file', archive, '--directory', unit, '--no-same-owner', '--no-same-permissions']);
}

export async function extractChromium(python, archive, destination, run) {
  const script = `import os,pathlib,stat,sys,zipfile
root=pathlib.Path(sys.argv[2]); root.mkdir(mode=0o700)
with zipfile.ZipFile(sys.argv[1]) as archive:
 for item in archive.infolist():
  parts=pathlib.PurePosixPath(item.filename).parts
  assert parts and not item.filename.startswith('/') and all(part not in ['.','..'] for part in parts) and '\\\\' not in item.filename
  assert not stat.S_ISLNK(item.external_attr >> 16)
  path=root.joinpath(*parts)
  if item.is_dir(): path.mkdir(mode=0o700,parents=True,exist_ok=True); continue
  path.parent.mkdir(mode=0o700,parents=True,exist_ok=True)
  with archive.open(item) as source, path.open('xb') as output:
   while chunk:=source.read(1048576): output.write(chunk)
  path.chmod(0o700 if item.external_attr >> 16 & 0o111 else 0o600)
`;
  await run(python, ['-I', '-B', '-c', script, archive, destination], { maxBuffer: 65536 });
}

export async function resolvePythonLock({ python, inputs, target, temporary, previous, run }) {
  if (previous) {
    invariant(previous.format === 1 && previous.kind === 'foreman-browser-resolved-lock'
      && matchesBrowserRuntimeTarget(previous.target, target) && previous.python.sha256 === inputs.python.sha256
      && previous.python.url === inputs.python.url && previous.chromium.url === inputs.chromium.url
      && previous.chromium.version === inputs.chromium.version && previous.chromium.sha256 === inputs.chromium.sha256,
    'incompatible resolved lock');
    return previous;
  }
  const report = join(temporary, 'pip-report.json');
  const requirements = inputs.packages.map(item => `${item.name}==${item.version}`);
  await run(python, ['-I', '-B', '-m', 'pip', '--isolated', 'install', '--dry-run', '--ignore-installed', '--only-binary=:all:',
    '--disable-pip-version-check', '--report', report, '--index-url', 'https://pypi.org/simple', ...requirements],
  { timeout: 600000, maxBuffer: 8 * 1024 * 1024, env: { ...process.env, PIP_CONFIG_FILE: '/dev/null' } });
  const resolved = JSON.parse(await readFile(report, 'utf8'));
  invariant(resolved.version === '1' && typeof resolved.pip_version === 'string' && Array.isArray(resolved.install), 'invalid resolver report');
  const packages = resolved.install.map(item => ({ name: item.metadata.name, version: item.metadata.version,
    url: item.download_info.url, sha256: item.download_info.archive_info.hashes.sha256,
    filename: decodeURIComponent(basename(new URL(item.download_info.url).pathname)) }))
    .sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
  return { format: 1, kind: 'foreman-browser-resolved-lock', target, resolver: `pip==${resolved.pip_version}`,
    python: inputs.python, chromium: inputs.chromium, packages };
}

export function validateWheelClosure(lock, inputs) {
  invariant(lock.packages.length > 0 && lock.packages.length <= 1000, 'invalid resolved wheel count');
  const names = new Set();
  for (const item of lock.packages) {
    const name = item.name.toLowerCase().replace(/[-_.]+/g, '-');
    invariant(!names.has(name) && /^[a-zA-Z0-9_.+-]+$/.test(item.version) && safePath(item.filename)
      && !item.filename.includes('/') && item.filename.endsWith('.whl') && digest.test(item.sha256)
      && new URL(item.url).protocol === 'https:', 'invalid locked wheel');
    names.add(name);
  }
  for (const required of inputs.packages) {
    const selected = lock.packages.find(item => item.name.toLowerCase().replace(/[-_.]+/g, '-') === required.name);
    invariant(selected?.version === required.version && selected.sha256 === required.wheelSha256, `unpublished or altered ${required.name} wheel`);
  }
}

export async function installLockedWheels({ lock, inputs, python, wheelhouse, unit, licenseTexts, fetchArtifact, run }) {
  validateWheelClosure(lock, inputs);
  await mkdir(wheelhouse, { mode: 0o700 });
  for (const wheel of lock.packages) await downloadBrowserRuntimeArtifact(wheel.url, join(wheelhouse, wheel.filename), wheel.sha256, fetchArtifact);
  const requirements = join(wheelhouse, 'requirements.lock');
  await writeFile(requirements, lock.packages.map(item => `${item.name}==${item.version} --hash=sha256:${item.sha256}`).sort().join('\n') + '\n', { mode: 0o600 });
  await run(python, ['-I', '-B', '-m', 'pip', '--isolated', 'install', '--no-index', '--no-compile', '--require-hashes',
    '--only-binary=:all:', '--find-links', wheelhouse, '--requirement', requirements, '--disable-pip-version-check'],
  { timeout: 600000, maxBuffer: 8 * 1024 * 1024, env: { ...process.env, PIP_CONFIG_FILE: '/dev/null' } });
  await run(python, ['-I', '-B', '-m', 'pip', '--isolated', 'check'], { timeout: 60000, maxBuffer: 65536 });
  await copyFile(requirements, join(unit, 'requirements.lock'));
  const script = `import email,json,pathlib,sys,zipfile
root=pathlib.Path(sys.argv[2]); root.mkdir(mode=0o700,parents=True)
inventory=[]; license_texts=json.loads(sys.argv[3])
for wheel in sorted(pathlib.Path(sys.argv[1]).glob('*.whl')):
 with zipfile.ZipFile(wheel) as archive:
  metadata_name=next(name for name in archive.namelist() if name.endswith('.dist-info/METADATA'))
  metadata=archive.read(metadata_name); parsed=email.message_from_bytes(metadata)
  prefix=parsed['Name']+'-'+parsed['Version']; directory=root/prefix; directory.mkdir(mode=0o700)
  (directory/'METADATA').write_bytes(metadata)
  notices=[name for name in archive.namelist() if not name.endswith('/') and any(part.lower().startswith(('license','licence','copying','notice')) for part in pathlib.PurePosixPath(name).parts)]
  files=['METADATA']; source={'kind':'wheel'}
  for index,name in enumerate(notices):
   filename=str(index)+'-'+pathlib.PurePosixPath(name).name
   (directory/filename).write_bytes(archive.read(name)); files.append(filename)
  if not notices and len(parsed.get('License',''))<=100:
   expression=(parsed.get('License-Expression') or parsed.get('License','')).strip()
   terms=license_texts.get(expression)
   assert terms, 'Missing license text: '+prefix+' ('+expression+')'
   (directory/'LICENSE.txt').write_text(terms['text']); files.append('LICENSE.txt')
   source={'kind':'spdx','expression':expression,'url':terms['url'],'sha256':terms['sha256']}
  inventory.append({'package':prefix,'files':files,'licenseSource':source})
(root/'index.json').write_text(json.dumps(inventory,indent=2)+'\\n')
`;
  await run(python, ['-I', '-B', '-c', script, wheelhouse, join(unit, 'licenses/python-packages'), JSON.stringify(licenseTexts)], { maxBuffer: 65536 });
}

export async function normalizeBrowserPythonEntrypoints({ python, unit, run = execute }) {
  const script = `import csv,io,json,pathlib,sys
root=pathlib.Path(sys.argv[1]).resolve(); binary=root/'python'/'bin'
for path in sorted(binary.iterdir()):
 if path.name not in ('python','python3','python3.13'):
  assert path.is_file() or path.is_symlink(), 'Unexpected Python entrypoint directory'
  path.unlink()
for info in sorted((root/'python').glob('lib/python*/site-packages/*.dist-info')):
 direct=info/'direct_url.json'
 if direct.exists() and json.loads(direct.read_text()).get('url','').startswith('file:'): direct.unlink()
 record=info/'RECORD'
 if not record.exists(): continue
 rows=[]
 for row in csv.reader(io.StringIO(record.read_text())):
  target=(info.parent/row[0]).resolve()
  if not target.exists(): continue
  if target==record.resolve(): row=[row[0],'','']
  rows.append(row)
 output=io.StringIO(newline=''); writer=csv.writer(output,lineterminator='\\n')
 writer.writerows(sorted(rows,key=lambda row:row[0])); record.write_text(output.getvalue())
`;
  await run(python, ['-I', '-B', '-c', script, unit], { timeout: 60000, maxBuffer: 65536 });
}

export async function listUnitFiles(directory) {
  const root = await realpath(directory), files = [];
  async function walk(path, prefix, ancestors) {
    const actual = await realpath(path);
    invariant(actual === root || actual.startsWith(`${root}/`), 'unit symlink escaped private root');
    const info = await lstat(actual);
    if (info.isDirectory()) {
      invariant(!ancestors.has(actual), 'unit directory cycle');
      const next = new Set(ancestors); next.add(actual);
      await chmod(actual, 0o700);
      for (const name of (await readdir(actual)).sort()) {
        if (name === '__pycache__' || name.endsWith('.pyc')) { await rm(join(actual, name), { recursive: true, force: true }); continue; }
        await walk(join(actual, name), prefix ? `${prefix}/${name}` : name, next);
      }
    } else {
      invariant(info.isFile() && safePath(prefix), `unit contains a nonregular or unsafe file: ${JSON.stringify({
        path: prefix, regular: info.isFile(),
      })}`);
      const mode = info.mode & 0o111 ? 0o700 : 0o600;
      await chmod(actual, mode);
      files.push({ path: prefix, ...await hashBrowserRuntimeFile(actual), mode, source: actual });
    }
  }
  await walk(root, '', new Set());
  return files.sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
}

export async function collectChromiumNotices(chromium, unit, temporary, run = execute) {
  const runtimeDirectory = await createBrowserRuntimeDirectory(temporary);
  try {
  const { stdout, stderr } = await run(join(unit, 'python/bin/python3'), ['-I', '-B', join(unit, 'credits.py'),
    chromium, '--headless=new', '--allow-chrome-scheme-url', '--no-first-run', '--disable-background-networking', '--disable-component-update',
    '--remote-debugging-address=127.0.0.1', '--remote-debugging-port=0',
    `--user-data-dir=${join(temporary, 'credits-profile')}`, 'chrome://credits/'], { timeout: 60000, maxBuffer: 32 * 1024 * 1024,
    env: { ...process.env, TMPDIR: runtimeDirectory?.temporaryDirectory ?? process.env.TMPDIR } });
  invariant(String(stdout).length > 1000 && /license|copyright/i.test(String(stdout)),
    `Chromium credits unavailable: ${JSON.stringify({ bytes: Buffer.byteLength(String(stdout)),
      page: String(stdout).slice(0, 300), stderr: String(stderr ?? '').slice(-1500) })}`);
  await mkdir(join(unit, 'licenses'), { recursive: true, mode: 0o700 });
  await writeFile(join(unit, 'licenses/chromium-credits.html'), stdout, { mode: 0o600 });
  } finally { await removeBrowserRuntimeDirectory(runtimeDirectory); }
}

/** Only checksum-pinned archives and a previously resolved wheel closure enter this directory. */
export async function installBrowserThirdParty({ inputs, lock, target, unit, temporary, licenseTexts,
  fetchArtifact = globalThis.fetch, run = execute, signal }) {
  signal?.throwIfAborted();
  await resolvePythonLock({ inputs, target, previous: lock });
  validateWheelClosure(lock, inputs);
  const pythonArchive = join(temporary, 'python.tar.gz');
  await downloadBrowserRuntimeArtifact(inputs.python.url, pythonArchive, inputs.python.sha256, fetchArtifact);
  await extractPinnedPython({ archive: pythonArchive, unit, run });
  const python = join(unit, 'python/bin/python3');
  await installLockedWheels({ lock, inputs, python, unit, temporary, licenseTexts,
    wheelhouse: join(temporary, 'wheels'), fetchArtifact, run });
  await normalizeBrowserPythonEntrypoints({ python, unit, run });
  signal?.throwIfAborted();
  const archive = join(temporary, 'chromium.zip');
  await downloadBrowserRuntimeArtifact(inputs.chromium.url, archive, inputs.chromium.sha256, fetchArtifact);
  await extractChromium(python, archive, join(unit, 'chromium'), run);
}
