import type { ReactElement } from 'react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { cleanup, render as renderView, screen } from '@testing-library/react'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { seedComputerNames } from '../../shared/api/computerNames.testSupport'
import { JobQueueFacts } from './JobSpecFacts'
import { autoQueueTicket, definition, verificationQueueTicket } from './fixtures'

let client: QueryClient
beforeEach(() => {
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
})
afterEach(() => { cleanup(); client.clear() })
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
  seedComputerNames(client, target.hostRef.mainId, [{ hostRef: target.hostRef, name: 'Office laptop' }])
  render(<JobQueueFacts ticket={{ ...verificationQueueTicket, placement: { kind: 'explicit', target } }} />)
  expect(await screen.findByText('Office laptop')).toBeVisible()
})
