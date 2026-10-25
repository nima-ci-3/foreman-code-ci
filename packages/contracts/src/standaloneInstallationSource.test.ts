import { expect, it } from 'vitest'
import { INSTALLATION_NAMES, standaloneInstallationSource } from './installationNames.mjs'
import { PACKAGE_MANAGER, PACKAGE_RELEASE_POLICY } from './packagePolicy.mjs'

it('inlines installation names and the package policy into standalone installed files', async () => {
  // Installed Workers run raw copies of these files without node_modules; a policy import that stayed would not load.
  const source = "import { PACKAGE_MANAGER, PACKAGE_RELEASE_POLICY } from '@foreman-code/contracts/package-policy';\n"
    + "import { INSTALLATION_NAMES } from '../../contracts/src/installationNames.mjs'\n"
    + 'export const read = () => [PACKAGE_MANAGER, PACKAGE_RELEASE_POLICY, INSTALLATION_NAMES.environment]\n'
  const standalone = standaloneInstallationSource(source)
  expect(standalone).not.toMatch(/^import /m)
  const module = await import(`data:text/javascript,${encodeURIComponent(standalone)}`) as { read: () => unknown[] }
  expect(module.read()).toEqual([PACKAGE_MANAGER, { ...PACKAGE_RELEASE_POLICY }, INSTALLATION_NAMES.environment])
})

it('leaves an import that also names a function, which needs the real module', () => {
  const line = "import { INSTALLATION_NAMES, standaloneInstallationSource } from '@foreman-code/contracts/installation-names'\n"
  expect(standaloneInstallationSource(line)).toBe(line)
})
