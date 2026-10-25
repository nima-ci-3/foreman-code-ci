import { useInfiniteQuery, useQuery, type InfiniteData, type QueryClient } from '@tanstack/react-query'
import type { WorkflowHierarchyReadInput, WorkflowReportsPage } from '@foreman-code/contracts'
import { sessionGeneration } from '../../shared/api/sessionBoundary'
import { readHierarchy, readHierarchyReports } from './client'
import { isTransientReadError } from '../../shared/api/readFailure'

export const hierarchyKey = (scope: WorkflowHierarchyReadInput, generation = sessionGeneration()) =>
  ['workflow-hierarchy', generation, scope.workspaceId, scope.workflowId, scope.runId ?? null, scope.workflowVersionId ?? null] as const
export const hierarchyReportKey = (scope: WorkflowHierarchyReadInput) => [...hierarchyKey(scope), 'reports', 'children'] as const
/** Lifecycle notifications refresh one bounded page per visible branch, never its loaded history. */
export function refreshHierarchyReports(cache: QueryClient, scope: WorkflowHierarchyReadInput) {
  const queryKey = hierarchyReportKey(scope)
  cache.setQueriesData<InfiniteData<WorkflowReportsPage>>({ queryKey }, current => current && ({
    pages: current.pages.slice(0, 1), pageParams: current.pageParams.slice(0, 1),
  }))
  return cache.invalidateQueries({ queryKey })
}

export function useHierarchy(scope: WorkflowHierarchyReadInput, { enabled = true } = {}) {
  const current = !scope.runId && !scope.workflowVersionId
  return useQuery({ queryKey: hierarchyKey(scope), enabled, queryFn: ({ signal }) => readHierarchy(scope, { signal }),
    staleTime: current ? 30_000 : Infinity, refetchOnMount: 'always', refetchOnWindowFocus: current,
    refetchInterval: query => {
      if (!enabled || !current || query.state.error && !isTransientReadError(query.state.error)) return false
      return 30_000
    }, refetchIntervalInBackground: false })
}
export function useHierarchyReports(scope: WorkflowHierarchyReadInput, parentNodeId: string, enabled: boolean) {
  return useInfiniteQuery({ queryKey: [...hierarchyReportKey(scope), parentNodeId], enabled: enabled && !!scope.runId,
    initialPageParam: undefined as string | undefined,
    queryFn: ({ signal, pageParam }) => readHierarchyReports({ workspaceId: scope.workspaceId,
      workflowId: scope.workflowId, runId: scope.runId!, parentNodeId, limit: 50, ...(pageParam ? { cursor: pageParam } : {}) }, { signal }),
    getNextPageParam: page => page.nextCursor ?? undefined, staleTime: Infinity,
    refetchOnWindowFocus: false, refetchOnMount: 'always', maxPages: 20,
  })
}
