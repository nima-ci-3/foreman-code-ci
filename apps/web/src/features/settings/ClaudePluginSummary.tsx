import { Alert, Button, LoadingState, StatusBadge } from '../../shared/ui/nocturne'
import { useClaudePlugins } from '../../shared/api/claudePlugins'
import { useAccessFailureLatch } from '../../shared/api/useAccessFailureLatch'
import { askOperator } from '../operator-chat/operatorChatStore'
import { PluginCatalogControls, PluginCatalogPages } from './PluginCatalogControls'
import { PLUGIN_PAGE_SIZE, useLastPluginPage, usePluginCatalogNavigation } from './usePluginCatalogNavigation'
import './codexPlugins.css'

function stateLabel(enabled: boolean): string {
  return enabled ? 'Enabled' : 'Disabled'
}

export function ClaudePluginSummary({ onClose, accessUnavailable = false }: {
  onClose(): void; accessUnavailable?: boolean
}) {
  const { view, query, offset, move } = usePluginCatalogNavigation()
  const list = useClaudePlugins({ view, query, offset, limit: PLUGIN_PAGE_SIZE }, !accessUnavailable)
  const listDenied = useAccessFailureLatch(list)
  const denied = accessUnavailable || listDenied
  const catalog = denied ? undefined : list.data
  useLastPluginPage(catalog, offset, move)
  const ask = (content: string) => {
    onClose()
    askOperator(content, { send: false })
  }
  return <section className="codex-plugins" aria-label="Claude plugins">
    <PluginCatalogControls view={view} query={query} move={move} refresh={<Button size="sm" variant="ghost"
      disabled={accessUnavailable || list.isFetching} loading={list.isRefetching} onClick={() => {
        if (!accessUnavailable) void list.refresh()
      }}>Refresh</Button>} />
    {list.isPending ? <LoadingState label="Loading Claude plugins…" rows={3} /> : null}
    {list.isError ? <Alert tone="danger" title="Claude plugins could not be loaded"
      action={<Button size="sm" disabled={accessUnavailable} onClick={() => {
        if (!accessUnavailable) void list.refetch()
      }}>Retry</Button>}>{list.error.message}</Alert> : null}
    {denied ? <Alert tone="danger" live title="Plugin access unavailable">Protected plugin information is hidden until access is restored.</Alert> : null}
    {catalog ? <>
      <Button size="sm" onClick={() => ask('Add a Claude Code plugin marketplace: ')}>
        Add marketplace with Operator
      </Button>
      <p className="harness-muted" role="status">{catalog.total} {view === 'installed' ? 'installed' : 'available'} plugins</p>
      {catalog.items.length ? <ul className="codex-plugin-grid">{catalog.items.map(plugin => <li key={plugin.pluginId}>
        <button type="button" className="codex-plugin-card" aria-label={`Ask Operator to ${plugin.installed ? 'manage' : 'install'} ${plugin.name}`}
          onClick={() => ask(`${plugin.installed ? 'Manage' : 'Install'} the Claude Code plugin ${plugin.pluginId}. `)}>
          <span className="codex-plugin-identity"><strong>{plugin.name}</strong><small>{plugin.marketplaceName}</small></span>
          <StatusBadge label={plugin.installed ? stateLabel(plugin.enabled) : 'Available'}
            tone={plugin.installed && plugin.enabled ? 'success' : 'neutral'} />
        </button>
      </li>)}</ul> : <p className="harness-empty">{query ? 'No plugins match this search.' : 'No plugins found.'}</p>}
      <PluginCatalogPages offset={offset} catalog={catalog} disabled={list.isFetching} move={move} />
    </> : null}
  </section>
}
