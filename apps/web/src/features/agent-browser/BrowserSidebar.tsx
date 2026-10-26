import { useId, useRef, type ReactNode } from 'react'
import { FloatingWindow } from '../../shared/ui/FloatingWindow'
import { Icon, IconButton, TabList } from '../../shared/ui/nocturne'
import './browserSidebar.css'

export type BrowserSidebarStatus = 'working' | 'idle' | 'ended' | 'not_started'
export interface BrowserSidebarTab { id: string; name: string; status: BrowserSidebarStatus; page?: string }

const statusLabel: Record<BrowserSidebarStatus, string> = { working: 'Working', idle: 'Idle', ended: 'Ended', not_started: 'No browser' }

/** Movable browser window: one tab per Agent, the selected tab's browser below. */
export function BrowserSidebar({ tabs, selectedId, emptyText, notice, onSelect, onCloseTab, onClose, children }: {
  tabs: readonly BrowserSidebarTab[]; selectedId?: string; emptyText: string; notice?: ReactNode
  onSelect(id: string): void; onCloseTab(id: string): void; onClose(): void; children?: ReactNode
}) {
  const id = useId()
  const selected = tabs.find(tab => tab.id === selectedId)
  const opener = useRef<HTMLElement | null>(document.querySelector('.workflow-floating-panel:not([hidden])'))
  return <FloatingWindow label="Agent browsers" title="Agent browsers" closeLabel="Close browsers"
    opener={opener} onClose={onClose} className="browser-sidebar">
      <TabList label="Agent browsers" className="browser-sidebar-tabs" itemClassName="browser-sidebar-tab" value={selectedId}
        activation="manual" onSelect={onSelect} tabId={value => `${id}-${value}`} panelId={() => `${id}-panel`}
        items={tabs.map(tab => ({ value: tab.id, title: `${tab.name} · ${statusLabel[tab.status]}${tab.page ? ` · ${tab.page}` : ''}`,
          label: <><span className="browser-sidebar-dot" data-status={tab.status} aria-hidden="true" />
            <span className="browser-sidebar-name">{tab.name}</span></>,
          action: <IconButton label={`Close ${tab.name} browser`} variant="ghost" size="sm" onClick={() => onCloseTab(tab.id)}>
            <Icon name="close" size={12} /></IconButton> }))} />
    {notice}
    <div className="browser-sidebar-body" id={`${id}-panel`} role={selected ? 'tabpanel' : undefined}
      aria-labelledby={selected ? `${id}-${selected.id}` : undefined}>
      {selected ? children : <p className="browser-sidebar-empty">{tabs.length ? 'Choose an Agent above to watch its browser.' : emptyText}</p>}
    </div>
  </FloatingWindow>
}
