# CI cache hubs after rebase, 2026-10-26

Rebased `fix/ci-hubs` onto `integration/next` at `687e83a9c2`, including
`d929906018` and merge `3598fb9395`. The replayed implementation is
`305fbcea90`. The shared closure index, reads/process/doubt rules, execution-file
scoping, CONFIG identities and `masked-v2` function-proof scope are preserved.
The follow-up corrects a test fixture's filesystem anchor and replaces the old
measurement report.

## Measurement

This is a fresh comparison of the incoming builder and the resolved builder on
the same rebased source tree (`643ace71e9142d1f72ed012e970da26af752d245`),
covering all 1,018 integration files. For each candidate, actual public
`CiResultKeys.key` results before/after a content mutation were compared.
Unlike the original input-list count, this includes CONFIG, project-data and
build/tool identity effects. No integration tests were executed.

Both builders compute keys for **891 files** and return null for the same **127**.
Those files must run when selected; they are not counted as newly invalidated
keys. If all 1,018 files are considered, add 127 to either table column before
allowing further function proofs. A round's coverage selection may consider a
smaller set.

The table measures whole-file input reach: a trailing newline changes each
ordinary file's blob without changing its imports. This is a conservative
ceiling for a function-body edit, not a measurement of executed functions.
Manifest probes independently changed description, version and runtime `type`;
all three gave the displayed counts in this repository's real harness.
The lockfile probe changes whitespace, so it measures raw consumers rather than
an upgraded dependency's reach. All probes leave the 127 null-key files unchanged.

**Loaded** comes from the latest complete saved coverage map,
`2bae99bc4d193754766c1cb2ca3e8074643adfee.json` (1,016/1,016 files;
298 requiring static selection). The newer `fd33cbacf2b72c388ed66dd8e2040b8227f51d8a.json`
is partial (686/1,018; 197 requiring static selection). Both are under
`~/.cache/foreman-code/integration-coverage/71553f250da3c8b621fa328653dde23c8ab9a98a489bb9b023c726eb768ec295/`.
Saved maps omit function sets, so exact per-body proof savings cannot be recovered
from them. **Edits** counts commits naming each current path in
`git log --since=30.days --name-only main`, pinned to
`1bc3826c2eb20a5fea675889a51bdac098695075`, without following renames.
Selected candidates are ranked by before-key reach × edit frequency.

| File | Raw key invalidations: incoming → resolved | Loaded | Edits | Rule |
|---|---:|---:|---:|---|
| `apps/api/src/modules/interactions/execution.ts` | 839 → 839 | 869 | 209 | Own closure/read inputs from the inherited index; masks remain available |
| `package.json` | 891 → 891 | 0 | 179 | Raw harness references retain full manifests; CONFIG identities also retained |
| `apps/api/src/infrastructure/migrations.ts` | 891 → 891 | 963 | 179 | Parent template applies the complete migration list |
| `apps/api/src/modules/conversations/agentChat.ts` | 837 → 837 | 297 | 179 | Own closure/read inputs from the inherited index; masks remain available |
| `packages/contracts/src/index.ts` | 891 → 891 | 1,004 | 145 | Shared contracts initialization and re-exports |
| `packages/contracts/src/management/index.ts` | 891 → 891 | 979 | 122 | Shared contracts initialization and re-exports |
| `apps/api/src/modules/conversations/operatorChat.ts` | 837 → 837 | 312 | 127 | Own closure/read inputs from the inherited index; masks remain available |
| `apps/api/src/modules/harnesses/codexAppServer.ts` | 839 → 839 | 930 | 124 | Own closure/read inputs from the inherited index; masks remain available |
| `apps/api/test/helpers/remoteReviewProduction.ts` | 826 → 826 | 66 | 119 | Own closure/read inputs from the inherited index; masks remain available |
| `scripts/test-integration.mjs` | 891 → 891 | 2 | 91 | Parent execution runner; stays a whole shared dependency |
| `scripts/test-integration.test.mjs` | 891 → 0 | 0 | 82 | Runner regression file excluded; direct imports/reads still count |
| `packages/contracts/src/ciHost.ts` | 891 → 891 | 1,004 | 78 | Shared contracts initialization and re-exports |
| `packages/contracts/src/ci.ts` | 891 → 891 | 1,004 | 70 | Shared contracts initialization and re-exports |
| `apps/api/src/modules/devices/deviceApplicationChannel.ts` | 891 → 839 | 933 | 59 | Alias dependency moved from shared harness to own closures; masks now apply |
| `apps/api/src/modules/harnesses/recovery/processRegistry.ts` | 891 → 891 | 982 | 54 | Shared parent resource-recovery harness |
| `apps/api/src/app.ts` | 839 → 839 | 589 | 51 | Own closure/read inputs from the inherited index; masks remain available |
| `apps/api/package.json` | 891 → 891 | 0 | 47 | Raw harness references retain full manifests; CONFIG identities also retained |
| `packages/contracts/src/workerConversations.ts` | 891 → 842 | 936 | 41 | Alias dependency moved from shared harness to own closures; masks now apply |
| `packages/contracts/src/agentChat.ts` | 891 → 842 | 936 | 39 | Alias dependency moved from shared harness to own closures; masks now apply |
| `pnpm-lock.yaml` | 825 → 825 | 0 | 41 | Raw/build/data inputs; locked package/tool identities also retained |
| `apps/api/src/modules/byte-transfer/service.ts` | 891 → 840 | 934 | 29 | Alias dependency moved from shared harness to own closures; masks now apply |
| `packages/contracts/src/remoteExecutionRpc.ts` | 891 → 842 | 936 | 29 | Alias dependency moved from shared harness to own closures; masks now apply |
| `apps/api/vitest.config.mjs` | 891 → 891 | 0 | 22 | Execution config stays whole; alias binding edits still invalidate |
| `apps/api/src/modules/byte-transfer/rsync.ts` | 891 → 838 | 27 | 21 | Alias dependency moved from shared harness to own closures; masks now apply |
| `apps/api/src/modules/byte-transfer/installedRsyncSelection.ts` | 891 → 838 | 25 | 12 | Alias dependency moved from shared harness to own closures; masks now apply |
| `scripts/integration-process.test.mjs` | 891 → 0 | 0 | 9 | Runner regression file excluded; direct imports/reads still count |
| `apps/api/test/helpers/testResources.ts` | 891 → 891 | 1,016 | 8 | Shared setup helper and transitive imports |
| `apps/api/src/worker/byteTransfer.ts` | 891 → 828 | 0 | 1 | Alias dependency moved from shared harness to own closures; masks now apply |
| `packages/ci-protocol/src/testResults.d.mts` | 891 → 0 | 0 | 1 | Declaration excluded from runner roots; explicit reads still count |
| `scripts/integration-capacity.test.mjs` | 891 → 0 | 0 | 1 | Runner regression file excluded; direct imports/reads still count |
| `scripts/integration-phase.test.mjs` | 891 → 0 | 0 | 1 | Runner regression file excluded; direct imports/reads still count |
| `apps/api/src/modules/browser-runtime/bridge.py` | 890 → 890 | 0 | 1 | Parameterized I/O and concrete data inputs |

The stricter inherited closure/read rules make several raw reaches much larger
than in the pre-rebase report: `rsync.ts` now reaches 838 keyed tests after this
fix, rather than the old estimate of 111; `byteTransfer.ts` reaches 828 rather
than 75. These new measurements supersede the old numbers. Moving those files
out of the shared harness still enables function masks on them. The tests prove
an unused body edit preserves a masked key while an executed body edit changes it.

The environment shrinks from **40 to 35** inputs and the shared harness from
**528 to 495**. Script regression files and the protocol declaration change zero
of the 891 computed keys after the fix; 127 inherited null-key files remain.

## Soundness and cache version

- Script regression and declaration exclusions: **high confidence**. They remain
  reachable through direct imports, filesystem reads and declared inputs. The
  real runtime runner still invalidates keys.
- Static alias correction: **high confidence for the recognized form**. Only a
  literal Vitest `resolve`/`test` config and a direct node:url expression qualify,
  and the alias must resolve through the workspace exports to the exact same file.
  Unknown aliases, overrides, plugins, composed configs, actual imports, setup
  references and other expressions retain conservative edges. The incoming
  filesystem/process analysis and cyclic closure index remain intact.
- Cache version stays **2**, following the incoming rule. Removing false inputs
  changes the affected path lists; moving a shared file under a mask changes its
  identity. Old incompatible proofs therefore do not match naturally. There is
  no reason for an additional global key-space reset. The incoming `masked-v2`
  reset remains in place for its separate function-proof correctness changes.

Migrations still apply to every database template, so no migration/schema pruning
was attempted. Barrels evaluate re-exported modules and construct schemas; named
export pruning would miss initialization failures and side effects. CONFIG field
normalization and explicit raw manifest/config reads are both preserved: isolated
metadata-only changes can remain proven, but real harness raw references dominate
these repository measurements. Parameterized I/O retains its project-data and
caller dependencies; no inherited doubt or read boundary was removed.

The 127 inherited null-key cases are recorded in the measurement JSON: 125 report
`scripts/build-cache-inputs.mjs imports a glob.`, one reads a host-supplied path,
and one imports a computed module in `apps/api/scripts/local-acceptance-service.mjs`.
The glob diagnostic is triggered by the guard's quoted `import.meta.glob` string
in `build-cache-inputs.mjs`, rather than an actual glob call there. That inherited
guard was left unchanged during this rebase; these cases are never counted as
cache hits or hidden in the savings.

## Verification

The explicitly requested rebuild passed:
`(cd packages/contracts && TMPDIR=~/.cache/foreman-tmp npx tsc -p tsconfig.build.json)`.
Only the requested files were run from `apps/ci`:
`TMPDIR=~/.cache/foreman-tmp npx vitest run test/resultCacheKeys.test.ts test/resultCacheDependencies.test.ts`.
**45 tests pass** across both files, including the inherited shared-closure batch
performance assertion. The first run exposed a declaration-reader fixture whose
raw cwd-relative path escaped the repository; it now uses `new URL(..., import.meta.url)`.
Its positive read-invalidation assertions remain intact, and the stricter doubt
rule was preserved. No other tests, builds or package-wide sanity checks ran.

Rebase measurement scripts, JSON and test logs are retained locally as
`~/.cache/foreman-tmp/ci-hubs-rebased-*`. Temporary measurement sources and the
contracts-node source-resolution link are removed from the worktree before
committing. No push or merge was performed.
