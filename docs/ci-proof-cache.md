# CI proof cache: one contract for every check

Every check (typecheck, lint, unit, integration, release gates and computer smoke runs) follows the same rules:

1. **A file is proven by its own result at its current inputs.** A file's key hashes its text, every repository file
   it imports (transitively, workspace packages through their exports to their sources) and the shared inputs
   (lockfile, CI scripts and workflows, test or lint configuration). A pass is recorded per file, also when other
   files in the same run failed. Failed, skipped and unreported files never get a proof.
2. **A run runs exactly what has no proof.** Failed files, edited files and every file that imports an edited file
   have no proof for their new key and run; everything else is skipped and named in the run (`cachedFiles`).
3. **Files no key can prove still run.** Tests that start processes, read files by computed paths or import computed
   modules have no key: they run when the change affects them or their latest result failed, and always in a gate.
4. **Cache is the default.** `scope: affected` (the default for `ci_run` and releases) uses proofs; only `scope: full`
   (`--full` for releases) runs every file.

Where each check keeps its proofs:

| Check | Key | Proofs |
| --- | --- | --- |
| unit, integration, gate, smoke | `CiResultKeys` (apps/ci/src/resultCache.ts); smoke keys are per computer | `ci_test_result_cache` on Main; `ci_test_failures` keeps each file's latest failure |
| lint | `scripts/eslint-closure-cache.mjs` (TypeScript module resolution, type-only inputs) | per-part state restored by every CI job |
| typecheck | `tsc --incremental` build info (content hashes) | per-part state restored by every CI job |

The keys differ only where the checks observe different inputs (a typed lint rule sees ambient declarations and the
tsconfig chain; a test sees its setup files and the files it reads); the rules above are the same.
