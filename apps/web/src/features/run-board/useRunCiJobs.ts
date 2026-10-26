import { useCallback } from 'react'
import { useQuery } from '@tanstack/react-query'
import { useProtectedAccessError } from '../../shared/api/useProtectedAccessError'
import { isRunAccessError } from '../runs-selector'
import { ciJobRefreshing, runCiApi, runInspectionQueryKey } from '../workflow-board'

type RunScope = Parameters<typeof runInspectionQueryKey>[0]

/** The Run's CI jobs as every Board shows them. `active` (the Run or one of its CI requests is still going) keeps
 * them polling, as does any job still refreshing. The CI panel keeps the last jobs read through a transient failure;
 * a denied read never leaves authorized-looking jobs behind, and node activity only uses a clean read. */
export function useRunCiJobs(scope: RunScope, { enabled, active }: { enabled: boolean; active: boolean }) {
  const list = useQuery({
    queryKey: [...runInspectionQueryKey(scope), 'ci-jobs'], enabled,
    queryFn: ({ signal }) => runCiApi.list({ workspaceId: scope.workspaceId, runId: scope.runId }, { signal }),
    refetchInterval: query => !enabled || isRunAccessError(query.state.error) ? false
      : active || query.state.data?.jobs.some(ciJobRefreshing) ? 1500 : false,
  })
  const denied = useProtectedAccessError(list)
  const { refetch } = list
  const onRefresh = useCallback(() => { void refetch() }, [refetch])
  const current = !denied && list.data?.runId === scope.runId ? list.data : undefined
  const panel = {
    jobs: current?.jobs, truncated: current?.truncated ?? false, error: Boolean(denied) || list.isError, loading: list.isPending,
    readError: denied ?? list.error, onRefresh }
  return { panel, nodeJobs: list.isError ? undefined : current?.jobs }
}
