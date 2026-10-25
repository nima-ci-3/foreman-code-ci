// The pinned package manager and the 48-hour package release-age policy (package.json `packageManager` and
// pnpm-workspace.yaml), defined once for every producer and validator of CI runtimes, seeds and verification
// receipts.

export const PNPM_VERSION = '11.27.0'
export const PACKAGE_MANAGER = 'pnpm@11.27.0'
export const RELEASE_AGE_MINUTES = 2880
/** The pnpm settings that enforce the release-age policy, as pnpm reports them. */
export const PACKAGE_RELEASE_POLICY = Object.freeze({
  minimumReleaseAge: RELEASE_AGE_MINUTES, minimumReleaseAgeStrict: true, minimumReleaseAgeIgnoreMissingTime: false,
})
