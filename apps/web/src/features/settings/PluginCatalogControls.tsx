import type { ReactNode, Ref } from 'react'
import { Button, TextField } from '../../shared/ui/nocturne'
import { PLUGIN_PAGE_SIZE, type PluginCatalogMove as Move } from './usePluginCatalogNavigation'

/** Installed/Discover, the caller's refresh button and the search field; a change of view or search starts at page one. */
export function PluginCatalogControls({ view, query, move, refresh, searchRef }: {
  view: 'installed' | 'available'; query: string; move: Move; refresh: ReactNode; searchRef?: Ref<HTMLInputElement>
}) {
  return <>
    <div className="codex-plugins-controls">
      <div className="codex-plugins-tabs" role="group" aria-label="Plugin catalog view">
        <Button size="sm" variant={view === 'installed' ? 'primary' : 'ghost'} aria-pressed={view === 'installed'}
          onClick={() => move({ pluginView: 'installed', pluginOffset: 0 })}>Installed</Button>
        <Button size="sm" variant={view === 'available' ? 'primary' : 'ghost'} aria-pressed={view === 'available'}
          onClick={() => move({ pluginView: 'available', pluginOffset: 0 })}>Discover</Button>
      </div>
      {refresh}
    </div>
    <TextField ref={searchRef} label="Search plugins" type="search" maxLength={100} value={query} placeholder="Name or marketplace"
      onChange={event => move({ pluginQuery: event.target.value || undefined, pluginOffset: 0 })} />
  </>
}

/** Previous/Next over a catalog longer than one page. */
export function PluginCatalogPages({ offset, catalog, disabled, move }: {
  offset: number; catalog: { total: number; nextOffset: number | null }; disabled: boolean; move: Move
}) {
  if (catalog.total <= PLUGIN_PAGE_SIZE) return null
  return <div className="codex-plugins-pages">
    <Button size="sm" variant="ghost" disabled={offset === 0 || disabled}
      onClick={() => move({ pluginOffset: Math.max(0, offset - PLUGIN_PAGE_SIZE) })}>Previous</Button>
    <span className="harness-muted">{`${offset + 1}–${Math.min(offset + PLUGIN_PAGE_SIZE, catalog.total)} of ${catalog.total}`}</span>
    <Button size="sm" variant="ghost" disabled={catalog.nextOffset === null || disabled}
      onClick={() => move({ pluginOffset: catalog.nextOffset ?? offset })}>Next</Button>
  </div>
}
