#!/usr/bin/env bash
# Publishes this run's typecheck/lint caches to the ci-state release. The state only speeds later runs (they
# restore an older one otherwise), so a GitHub outage while uploading warns instead of failing a passing check.
# Usage: ASSET=<name> GITHUB_REPOSITORY=<owner/repo> RUNNER_TEMP=<dir> scripts/ci-publish-suite-state.sh
set -euo pipefail
changed=$(node "$(dirname "$0")/ci-suite-state.mjs" changed)
[ "$changed" = true ] || { echo 'State unchanged; nothing to publish.'; exit 0; }
paths=$(ls -d apps/*/node_modules/.cache/tsc apps/*/node_modules/.cache/eslint \
  packages/*/node_modules/.cache/tsc packages/*/node_modules/.cache/eslint 2>/dev/null || true)
[ -n "$paths" ] || exit 0
# shellcheck disable=SC2086 # one path per word
tar -czf "$RUNNER_TEMP/$ASSET" $paths
gh release view ci-state -R "$GITHUB_REPOSITORY" >/dev/null 2>&1 || gh release create ci-state -R "$GITHUB_REPOSITORY" \
  --title 'CI state' --notes 'Typecheck and lint state for CI jobs.' --latest=false || true
for attempt in 1 2 3; do
  gh release upload ci-state -R "$GITHUB_REPOSITORY" "$RUNNER_TEMP/$ASSET" --clobber && exit 0
  [ "$attempt" = 3 ] || sleep "${CI_STATE_RETRY_SECONDS:-5}"
done
echo "::warning::Could not publish $ASSET to the ci-state release; later runs restore older state."
