import { useCallback, useEffect } from 'react'
import { useNavigate, useSearch } from '@tanstack/react-router'

export const PLUGIN_PAGE_SIZE = 24

/** The plugin catalog's place in the harness settings URL: view, search, page and the open plugin. */
export function usePluginCatalogNavigation() {
  const search = useSearch({ from: '/settings/harnesses' })
  const navigate = useNavigate({ from: '/settings/harnesses' })
  const move = useCallback((fields: Partial<typeof search>) => void navigate({ search: { ...search, ...fields }, replace: true }), [navigate, search])
  return { view: search.pluginView ?? 'installed', query: search.pluginQuery ?? '', offset: search.pluginOffset ?? 0,
    selectedId: search.pluginId, move }
}

export type PluginCatalogMove = ReturnType<typeof usePluginCatalogNavigation>['move']

/** A page past the catalog's end (after removals or a narrower search) moves back to its last page. */
export function useLastPluginPage(catalog: { total: number } | undefined, offset: number, move: PluginCatalogMove) {
  useEffect(() => {
    if (catalog && offset > 0 && offset >= catalog.total) {
      move({ pluginOffset: Math.max(0, Math.floor((catalog.total - 1) / PLUGIN_PAGE_SIZE) * PLUGIN_PAGE_SIZE) })
    }
  }, [catalog, offset, move])
}
