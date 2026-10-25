export { DeviceApplicationError } from '../modules/devices/deviceApplicationError.js'
export { DeviceConnectionError } from '../modules/devices/deviceWire.js'
import { createInstalledWorkerDomains as createDomains } from '../modules/devices/installedWorkerDomains.js'
import { installedWorkflowClaudeAdapter } from '../modules/harnesses/installedWorkflowClaude.js'
export { createWorkerConnection } from '../modules/devices/workerConnection.js'
export { DeviceApplicationAdmissionError, deviceApplicationFailure } from '../modules/devices/deviceApplicationError.js'
export { createWorkerRuntimeDrain } from '../modules/devices/installedWorkerDomains.js'

/** The packaged Worker's domains, with the Claude workflow adapter its bundle can carry. */
export const createInstalledWorkerDomains = (input: Parameters<typeof createDomains>[0]) =>
  createDomains({ workflowClaude: installedWorkflowClaudeAdapter, ...input })
