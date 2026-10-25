// The pinned package manager and the 48-hour package release-age policy. Defined in installationNames.mjs (which
// every installed copy carries and the standalone installer inlines); this module is their name for everyone else.
export { PACKAGE_MANAGER, PACKAGE_RELEASE_POLICY, PNPM_VERSION, RELEASE_AGE_MINUTES } from './installationNames.mjs'
