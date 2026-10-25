import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { expect, it, vi } from 'vitest'
import { AgentBrowserPanel } from './AgentBrowserPanel'
import { browserFilesFake, browserPortFake, browserRead, subject } from './testFixtures'

function mount(fake: ReturnType<typeof browserPortFake>, sessionId: string | null = 'session') {
  const choose = vi.fn(), files = browserFilesFake(), cleanup = vi.fn()
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } })
  render(<QueryClientProvider client={client}><AgentBrowserPanel visible compact selection={{
    authBoundary: 'login', visitKey: 'recovery', subject, sessionId, tabId: null, enabled: true, historical: true,
  }} port={fake.port} files={files} computerName="Main" profileName="Work" readOnly={false}
    onOpenSettings={vi.fn()} onSelectSession={choose} onSelectTab={choose} onCleanupError={cleanup} /></QueryClientProvider>)
  return { choose, files, cleanup }
}

it('keeps a completed session’s downloads available without opening a browser viewer', async () => {
  const read = browserRead()
  read.session.state = 'closed'; read.session.selectedTabId = null; read.tabs = []
  read.files = [{ id: 'download', name: 'report.txt', mimeType: 'text/plain', byteLength: 3,
    receivedBytes: 3, state: 'ready', purpose: 'download' }]
  const fake = browserPortFake(read), { files } = mount(fake)
  await userEvent.click(await screen.findByRole('button', { name: 'Delete file' }))
  await waitFor(() => expect(files.remove).toHaveBeenCalledWith(expect.objectContaining({ id: 'session', state: 'closed' }),
    'download', expect.any(String)))
  expect(fake.port.openView).not.toHaveBeenCalled()
  expect(fake.port.acquire).not.toHaveBeenCalled()
})

it('offers ended browser sessions in the compact sidebar so their retained files can be opened', async () => {
  const read = browserRead()
  read.session.state = 'closed'; read.session.selectedTabId = null; read.tabs = []
  const fake = browserPortFake(read), { choose } = mount(fake, null)
  await userEvent.click(await screen.findByRole('button', { name: /Downloads.*ended/i }))
  expect(choose).toHaveBeenCalledWith('session')
  expect(fake.port.openView).not.toHaveBeenCalled()
})

it('can create a page after closing the last page without inventing a browser lease', async () => {
  const read = browserRead()
  read.tabs = []; read.session.selectedTabId = null
  const fake = browserPortFake(read), { choose } = mount(fake)
  const created = browserRead()
  vi.mocked(fake.port.createTab).mockResolvedValue({ ...created, createdTabId: 'tab' })
  const button = await screen.findByRole('button', { name: 'New tab' })
  expect(fake.port.openView).not.toHaveBeenCalled()
  await userEvent.click(button)
  await waitFor(() => expect(choose).toHaveBeenCalledWith('tab'))
  expect(fake.port.createTab).toHaveBeenCalledWith(expect.objectContaining({ id: 'session' }), expect.any(String), 1, expect.any(String))
  await waitFor(() => expect(fake.port.openView).toHaveBeenCalledWith(created.session, created.tabs[0], expect.any(String), expect.any(Object), expect.any(AbortSignal)))
  expect(fake.port.prepare).not.toHaveBeenCalled()
})

it('accepts fresh runtime ownership when reconnecting the same saved Agent session', async () => {
  const fake = browserPortFake(), restored = browserRead()
  restored.session.browserGeneration = 2
  restored.tabs = restored.tabs.map(tab => ({ ...tab, browserGeneration: 2 }))
  vi.mocked(fake.port.reconnect).mockResolvedValue(restored)
  vi.mocked(fake.port.releasePressed).mockRejectedValue(new Error('The previous browser generation is gone.'))
  const { cleanup } = mount(fake)
  await waitFor(() => expect(fake.port.openView).toHaveBeenCalled())
  act(() => fake.observer!.disconnected(new Error('The browser host restarted.')))
  await userEvent.click(await screen.findByRole('button', { name: 'Reconnect' }))
  await waitFor(() => expect(fake.port.openView).toHaveBeenCalledWith(expect.objectContaining({ id: 'session', browserGeneration: 2 }),
    expect.objectContaining({ tabId: 'tab', browserGeneration: 2 }), expect.any(String), expect.any(Object), expect.any(AbortSignal)))
  expect(screen.queryByText('Browser access is unavailable.')).not.toBeInTheDocument()
  await waitFor(() => expect(fake.closeView).toHaveBeenCalled())
  expect(fake.port.releasePressed).not.toHaveBeenCalled()
  expect(cleanup).not.toHaveBeenCalled()
})
