import type { CiContext, GitWorktreePorts } from './environment.js'
import type { CiCommits } from './service.js'
import { ciRepositoryCapabilities } from './repository.js'
import { onlyCiInfrastructure } from './priority.js'
import type { CiTestTree } from './resultCache.js'
import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { promisify } from 'node:util'
import { CiSelectionSchema, type CiCoverageSelection } from '@foreman-code/contracts'

const run = promisify(execFile)

/** Main's clone resolves the exact source for admission; dispatch publishes it before a build computer needs it. */
export class GitCiCommits implements CiCommits {
  private readonly published = new Map<string, Promise<void>>()

  constructor(private readonly context: CiContext, private readonly git: GitWorktreePorts = context.platform.systemGitWorktreePorts()) {}

  async infrastructureOnly(repository: string, commit: string) {
    const signal = AbortSignal.timeout(30_000)
    const clone = await this.context.platform.ensureCommit(this.git, repository, commit, signal)
    const diff = await this.git.git(['diff-tree', '--root', '--no-commit-id', '--name-only',
      '--no-renames', '--first-parent', '-r', '-m', '-z', commit], { cwd: clone, signal })
    if (diff.code !== 0) throw new Error('Could not read the CI commit changes.')
    return onlyCiInfrastructure(diff.stdout.split('\0').filter(Boolean))
  }

  async branch(repository: string, defaultBranch: string, commit: string): Promise<string | null> {
    const signal = AbortSignal.timeout(30_000)
    const clone = await this.context.platform.ensureCommit(this.git, repository, commit, signal)
    const result = await this.git.git(['for-each-ref', '--contains', commit, '--format=%(refname)',
      'refs/remotes/origin/'], { cwd: clone, signal })
    if (result.code !== 0) throw this.context.platform.gitFailure('SOURCE_WORKTREE_FAILED', 'for-each-ref')
    const branches = result.stdout.trim().split('\n')
      .filter(ref => ref.startsWith('refs/remotes/origin/'))
      .map(ref => ref.slice('refs/remotes/origin/'.length))
      .filter(branch => branch !== 'HEAD' && !branch.startsWith('foreman/ci/'))
    if (branches.includes(defaultBranch)) return defaultBranch
    return branches.length === 1 ? branches[0]! : null
  }

  async isAncestor(repository: string, ancestor: string, commit: string): Promise<boolean> {
    const signal = AbortSignal.timeout(30_000)
    const clone = await this.context.platform.ensureCommit(this.git, repository, commit, signal)
    await this.context.platform.ensureCommit(this.git, repository, ancestor, signal)
    const result = await this.git.git(['merge-base', '--is-ancestor', ancestor, commit], { cwd: clone, signal })
    if (result.code === 0) return true
    if (result.code === 1) return false
    throw this.context.platform.gitFailure('SOURCE_WORKTREE_FAILED', 'merge-base')
  }

  async coverageAncestors(repository: string, commit: string, candidates: string[]): Promise<string[]> {
    const signal = AbortSignal.timeout(60_000)
    const clone = await this.context.platform.ensureCommit(this.git, repository, commit, signal)
    const retained = new Set(candidates)
    // Date order keeps descendants ahead of parents, then orders independent branches by commit time.
    const ancestors = async () => {
      const result = await this.git.git(['rev-list', '--date-order', commit], { cwd: clone, signal })
      if (result.code !== 0) throw this.context.platform.gitFailure('SOURCE_WORKTREE_FAILED', 'rev-list')
      return result.stdout.trim().split('\n').filter(ancestor => retained.has(ancestor))
    }
    const found = await ancestors()
    if (found.length || !candidates.length) return found
    // A just-fetched commit is a shallow boundary: deepen until the newest candidate's history connects, then read.
    await this.context.platform.ensureCommit(this.git, repository, candidates[0]!, signal)
    await this.context.platform.deepenUntilConnected(this.git, clone, [commit, candidates[0]!],
      async () => (await this.git.git(['merge-base', '--is-ancestor', candidates[0]!, commit], { cwd: clone, signal })).code === 0,
      signal)
    return ancestors()
  }

  async capabilities(repository: string, commit: string) {
    const signal = AbortSignal.timeout(30_000)
    const clone = await this.context.platform.ensureCommit(this.git, repository, commit, signal)
    const tree = await this.git.git(['ls-tree', '-r', '--name-only', commit], { cwd: clone, signal })
    if (tree.code !== 0) throw new Error('Could not read the CI repository capabilities.')
    return ciRepositoryCapabilities(tree.stdout.trim().split('\n'))
  }

  async unitInventory(repository: string, commit: string) {
    const signal = AbortSignal.timeout(30_000)
    const clone = await this.context.platform.ensureCommit(this.git, repository, commit, signal)
    const read = (args: string[]) => this.git.git(args, { cwd: clone, signal })
    const [tree, heavy] = await Promise.all([
      read(['ls-tree', '-r', '--name-only', commit]),
      read(['show', `${commit}:apps/web/heavy-tests.json`]),
    ])
    if (tree.code !== 0) throw new Error('Could not read the CI commit inventory.')
    const files = tree.stdout.trim().split('\n').filter(file => /\.(?:test|spec)\.[cm]?[jt]sx?$/.test(file)
      && !/(?:^|\/)(?:node_modules|dist|\.git)\//.test(file)
      && !(file.startsWith('apps/api/') && /\.(?:integration|acceptance)\.test\.ts$/.test(file))
      && (!file.startsWith('apps/web/') || /^apps\/web\/src\/.*\.(?:test|spec)\.tsx?$/.test(file)))
    return { files, durations: {},
      heavy: heavy.code === 0 ? (JSON.parse(heavy.stdout) as { files: string[] }).files : [] }
  }

  async integrationInventory(repository: string, commit: string) {
    const signal = AbortSignal.timeout(30_000)
    const clone = await this.context.platform.ensureCommit(this.git, repository, commit, signal)
    const tree = await this.git.git(['ls-tree', '-r', '--name-only', commit], { cwd: clone, signal })
    if (tree.code !== 0) throw new Error('Could not read the CI integration inventory.')
    return { files: tree.stdout.trim().split('\n').filter(file =>
      /^apps\/api\/test\/[^/]+\.integration\.test\.ts$/.test(file)).sort(),
    durations: {} }
  }

  async testTree(repository: string, commit: string, signal = AbortSignal.timeout(30_000)): Promise<CiTestTree> {
    const clone = await this.context.platform.ensureCommit(this.git, repository, commit, signal)
    const tree = await this.git.git(['ls-tree', '-r', '-z', commit], { cwd: clone, signal })
    if (tree.code !== 0) throw new Error('Could not read the CI commit tree.')
    const blobs = new Map<string, string>()
    for (const entry of tree.stdout.split('\0').filter(Boolean)) {
      const tab = entry.indexOf('\t')
      const [mode, type, id] = entry.slice(0, tab).split(' ')
      // Submodules have no blob; a test reaching one has no key.
      if (type === 'blob') blobs.set(entry.slice(tab + 1), `${mode}:${id}`)
    }
    return { blobs, read: async (path, readSignal) => {
      const id = blobs.get(path)?.split(':')[1]
      if (!id) throw new Error(`The CI commit has no file ${path}.`)
      const blob = await this.git.git(['cat-file', 'blob', id], { cwd: clone,
        signal: AbortSignal.any([readSignal, AbortSignal.timeout(30_000)]) })
      if (blob.code !== 0) throw new Error(`Could not read ${path} from the CI commit.`)
      return blob.stdout
    } }
  }

  /** The files the commit's own affected selector picks, run here on Main so ci_run knows them before dispatch. */
  async affectedSelection(repository: string, input: { commit: string; suite: string; defaultBranch: string
    baseCommit?: string; coverage?: CiCoverageSelection; signal: AbortSignal }) {
    const clone = await this.context.platform.ensureCommit(this.git, repository, input.commit, input.signal)
    let defaultRef = input.defaultBranch
    if (!input.baseCommit) {
      defaultRef = await this.context.platform.fetchRepositoryBranch(this.git, clone, repository, input.defaultBranch, input.signal)
      await this.context.platform.ensureCommit(this.git, repository, defaultRef, input.signal)
    } else await this.context.platform.ensureCommit(this.git, repository, input.baseCommit, input.signal)
    // Beside the clone on disk, not in /tmp (a RAM tmpfs on Main computers).
    const directory = await mkdtemp(join(dirname(clone), '.ci-main-selection-'))
    try {
      // The selector and the import graph it reads come from the tested commit, as on a runner.
      const code = join(directory, 'code')
      await mkdir(code)
      const archive = await this.git.git(['archive', '--format=tar', '-o', join(directory, 'code.tar'), input.commit,
        // The selector's import graph: scripts and the workspace packages it reads (contracts, verification runner).
        'scripts', 'packages'], { cwd: clone, signal: input.signal })
      if (archive.code !== 0) throw this.context.platform.gitFailure('SOURCE_WORKTREE_FAILED', 'archive')
      await run('tar', ['-xf', join(directory, 'code.tar'), '-C', code], { signal: input.signal })
      const coveragePath = join(directory, 'coverage.json')
      await writeFile(coveragePath, JSON.stringify(input.coverage ?? null))
      const script = [
        "import { readFileSync } from 'node:fs'",
        "import { gunzipSync } from 'node:zlib'",
        'const [code, commit, suite, cwd, defaultRef, baseCommit, coveragePath] = process.argv.slice(1)',
        "const { affectedSnapshot } = await import(`${code}/scripts/ci-affected.mjs`)",
        "const { expandIntegrationCoverage } = await import(`${code}/packages/contracts/src/ciCoverage.mjs`)",
        "const coverage = JSON.parse(readFileSync(coveragePath, 'utf8'))",
        'const prepared = coverage ? { changedFiles: coverage.changedFiles, coverageReason: coverage.reason,',
        "  coverageMap: coverage.map ? expandIntegrationCoverage(JSON.parse(gunzipSync(Buffer.from(coverage.map, 'base64'),",
        '    { maxOutputLength: 64 * 1024 * 1024 }).toString())) : undefined } : undefined',
        'console.log(JSON.stringify(affectedSnapshot(commit, suite, cwd, defaultRef, baseCommit || undefined, [], prepared)))',
      ].join('\n')
      const { stdout } = await run(process.execPath, ['--input-type=module', '-e', script, code, input.commit, input.suite,
        clone, defaultRef, input.baseCommit ?? '', coveragePath], { signal: input.signal, maxBuffer: 64 * 1024 * 1024,
        env: { ...process.env, TMPDIR: directory } })
      return CiSelectionSchema.parse(JSON.parse(stdout))
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  }

  async resolve(repository: string, defaultBranch: string, commit: string | undefined,
    snapshot: { baseCommit: string; commit: string; bundle: Buffer | null } | null): Promise<string> {
    const knownCommit = commit ?? snapshot?.commit
    const signal = AbortSignal.timeout(180_000)
    if (knownCommit) {
      if (!commit && snapshot?.bundle) {
        const clone = await this.context.platform.ensureCommit(this.git, repository, snapshot.baseCommit, signal)
        await this.context.platform.importAgentSnapshot(this.git, clone, { commit: snapshot.commit, bundle: snapshot.bundle }, signal)
      } else {
        await this.context.platform.ensureCommit(this.git, repository, knownCommit, signal)
      }
      return knownCommit
    }
    const clone = await this.context.platform.ensureClone(this.git, repository, signal)
    return this.context.platform.fetchRepositoryBranch(this.git, clone, repository, defaultBranch, signal)
  }

  publish(repository: string, commit: string): Promise<void> {
    const key = `${repository}:${commit}`
    const cached = this.published.get(key)
    if (cached) return cached
    const publication: Promise<void> = (async () => {
      const signal = AbortSignal.timeout(180_000)
      await this.context.platform.publishCommit(this.git, repository, commit, signal)
    })().catch(error => {
      if (this.published.get(key) === publication) this.published.delete(key)
      throw error
    })
    this.published.set(key, publication)
    if (this.published.size > 256) this.published.delete(this.published.keys().next().value!)
    return publication
  }
}
