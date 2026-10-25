import { screen, waitFor } from '@testing-library/react'
import { expect, it } from 'vitest'
import { inspectionBoardFixture } from './inspect/inspectionFixtures'
import { installBoardTestLifecycle, measureBoardWire, mountMeasuredBoard, setRunState } from './eng05D.testSupport'

installBoardTestLifecycle()

it('passes the Run painted on the draft Board to its browser sidebar', async () => {
  const fixture = await inspectionBoardFixture('browser-painted-run')
  setRunState(fixture, fixture.runs.after.scope, 'running')
  measureBoardWire(fixture.mock)
  const mounted = await mountMeasuredBoard(`/workspaces/${fixture.mock.workspaceId}?workflowId=${fixture.after.workflowId}&boardBrowsers=1`, {
    workflow: () => ({ browserSidebar: scope => <output aria-label="Browser Run scope">{JSON.stringify(scope)}</output> }),
  })
  await waitFor(() => expect(screen.getByLabelText('Browser Run scope')).toHaveTextContent(`"runId":"${fixture.runs.after.run.id}"`))
  expect(screen.getByLabelText('Browser Run scope')).toHaveTextContent(`"workflowVersionId":"${fixture.runs.after.scope.workflowVersionId}"`)
  expect(mounted.router.state.location.search.selectedRunId).toBeUndefined()
})
