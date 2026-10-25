import type { ReactElement } from 'react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { render as renderView, screen } from '@testing-library/react'
import { http, HttpResponse } from 'msw'
import { expect, it } from 'vitest'
import { server } from '../../mocks/server'
import { JobQueueFacts } from './JobSpecFacts'
import { autoQueueTicket, definition, verificationQueueTicket } from './fixtures'

const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
const wrapper = ({ children }: { children: React.ReactNode }) => <QueryClientProvider client={client}>{children}</QueryClientProvider>
const render = (ui: ReactElement) => renderView(ui, { wrapper })

it('shows the saved job name, verification suite and request identity before acceptance', () => {
  render(<JobQueueFacts ticket={verificationQueueTicket} />)
  expect(screen.getByText(verificationQueueTicket.definition.name)).toBeVisible()
  expect(screen.getByText('Verification suite').nextElementSibling).toHaveTextContent('unit')
  expect(screen.getByText(verificationQueueTicket.id)).toBeVisible()
})

it.each(['accepted', 'terminal'] as const)('shows the original computer for %s tickets with preferred placement', state => {
  const preferred = { kind: 'prefer' as const, hostRef: definition.spec.target.hostRef }
  const ticket = { ...autoQueueTicket, placement: preferred, placementOverride: preferred }
  const view = render(<JobQueueFacts ticket={ticket} />)
  expect(screen.getByText('Preferred computer')).toBeInTheDocument()
  expect(screen.getByText(/Then try eligible computers in build priority order/)).toBeInTheDocument()
  expect(screen.getByText(/Not assigned/)).toBeInTheDocument()
  view.rerender(<JobQueueFacts ticket={{ ...ticket, state, reservationId: ticket.id,
    terminalReason: state === 'terminal' ? 'completed' : null,
    finishedAt: state === 'terminal' ? ticket.enqueuedAt : null,
    selectedComputer: { target: { ...definition.spec.target, labelAtAcceptance: 'Build laptop' },
      rootId: '11111111-1111-4111-8111-111111111111', bindingRevision: 1, profileId: 'profile', profileRevision: 1 } }} />)
  expect(screen.getByText('Accepted computer')).toBeInTheDocument()
  expect(screen.getByText('Build laptop')).toBeInTheDocument()
  expect(screen.getByText('Preferred computer')).toBeInTheDocument()
})

it('names an explicit computer accepted without a label by its current name', async () => {
  const { labelAtAcceptance: _label, ...target } = { ...definition.spec.target,
    hostRef: { kind: 'device' as const, mainId: definition.spec.target.hostRef.mainId, deviceId: '22222222-2222-4222-8222-222222222222' } }
  void _label
  server.use(http.get('*/api/management/computers/activity', () => HttpResponse.json({ mainId: target.hostRef.mainId,
    computers: [{ target: { hostRef: target.hostRef, applicationInstallationId: '33333333-3333-4333-8333-333333333333',
      keyRevision: 1, authorizationRevision: 1 }, online: true, name: 'Office laptop', jobs: [], agents: [] }],
    cloud: [], truncated: false, activityComplete: true })))
  render(<JobQueueFacts ticket={{ ...verificationQueueTicket, placement: { kind: 'explicit', target } }} />)
  expect(await screen.findByText('Office laptop')).toBeVisible()
})
