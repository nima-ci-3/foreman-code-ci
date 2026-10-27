import { INSTALLATION_NAMES } from '@foreman-code/contracts/installation-names'
import { APP_MCP_TOKEN_NAMES } from '@foreman-code/contracts/product'

/** Kept free of control-plane imports: Worker code (computer probes) uses it too. */
export function isDatabaseCredentialVariable(key: string): boolean {
  return key === 'DATABASE_URL' || key.endsWith('_DATABASE_URL') || key === 'PGPASSWORD'
    || key === INSTALLATION_NAMES.environment.PRODUCTION_DB_PASSWORD || key === INSTALLATION_NAMES.privateEnvironment.productDatabasePassword
}

export function isControllerEnvironmentVariable(key: string): boolean {
  return key === 'NODE_OPTIONS' || key.startsWith('OPERATOR_')
    || /^(?:GRAPHQL|FOREMAN_CODE)_(?:OPERATOR|APP|TEST)_/.test(key)
    || (APP_MCP_TOKEN_NAMES as readonly string[]).includes(key) || key === INSTALLATION_NAMES.environment.MCP_TOKEN
    || key.endsWith('DATABASE_URL') || isDatabaseCredentialVariable(key)
}
