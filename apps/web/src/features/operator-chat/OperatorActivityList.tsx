import type { OperatorActivity } from '@foreman-code/contracts'
import { AgentChatActivity, activityStatusLabels } from '../conversations'
import { OperatorThinking } from './OperatorThinking'

export function OperatorActivityList({ entries, activeRequestId, parts, onBrowse }: {
  entries: readonly OperatorActivity[]; activeRequestId?: string | null; parts?: Record<string, string>; onBrowse(): void;
}) {
  if (!entries.length) return null
  return <div className="operator-activity-list" aria-label="Agent activity">
    {entries.map((entry) => {
      if (entry.kind === 'thinking') {
        const live = entry.requestId === activeRequestId ? parts?.[`thinking:${entry.id}`] : undefined
        const text = entry.status === 'completed' ? entry.output || live : live || entry.output
        if (!text) return null
        return <OperatorThinking key={`${entry.requestId}:${entry.id}`} text={text} onBrowse={onBrowse} />
      }
      if (entry.kind === 'mcp') {
        if (entry.status === 'completed') return null
        return <div key={`${entry.requestId}:${entry.id}`} className="operator-mcp-activity" role="status">
          MCP tool call{activityStatusLabels[entry.status] ? ` · ${activityStatusLabels[entry.status]}` : ''}
        </div>
      }
      // Tool activity renders the same disclosure as Agent chats: copyable input and output blocks.
      return <div key={`${entry.requestId}:${entry.id}`} className="operator-tool-activity" data-activity-kind={entry.kind}>
        <AgentChatActivity entry={entry} onBrowse={onBrowse} />
      </div>
    })}
  </div>
}
