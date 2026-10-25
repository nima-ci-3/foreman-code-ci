import { memo, useState, type ReactNode } from 'react'
import type { Message } from '@foreman-code/contracts'
import { useMutation } from '@tanstack/react-query'
import { errorMessage } from '../../../shared/errorMessage'
import { Button, CodeBlock, Icon, MessageBubble } from '../../../shared/ui/nocturne'
import { TextTruncationNotice } from '../../chat-core'
import { ChatMarkdown } from '../ChatMessageBody'
import { partialStructuredResult, structuredResult } from './structuredResult'

export const AgentChatMessage = memo(function AgentChatMessage({ message, name, status, actions, children, onExpand }: {
  message: Omit<Message, 'conversationId'>
  name: string
  status?: ReactNode
  actions?: ReactNode
  children?: ReactNode
  onExpand?(): Promise<void>
}) {
  const user = message.role === 'user'
  const timestamp = message.createdAt
  const time = timestamp ? new Date(timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : undefined
  if (message.role === 'tool') return <details className="agent-chat-tool">
    <summary>Tool output</summary><CodeBlock code={message.content} label="Tool output" />
    <TextTruncationNotice truncation={message.truncation} />{children}
  </details>
  // Same look as the Operator chat: avatar and name above, the reply in a bubble; time shows on hover.
  return <div className={`agent-chat-message agent-chat-message--${user ? 'user' : 'agent'}`} data-message-role={message.role}
    title={timestamp ? new Date(timestamp).toLocaleString() : undefined}>
    <MessageBubble author={user ? 'You' : name} role={user ? 'user' : 'assistant'} status={status} actions={actions}
      {...(time ? { time, dateTime: timestamp } : {})}>
      <div className={user ? undefined : 'agent-chat-answer'}>
        <div className={user ? 'conversation-message-content' : 'conversation-message-content chat-message-body'}>{user ? message.content : <AgentContent content={message.content} />}</div>
      </div>
      <TextTruncationNotice truncation={message.truncation} />
      {message.truncation?.truncated && onExpand ? <MessageExpansion key={`${message.id}:${message.revision}`}
        onExpand={onExpand} /> : null}
      {children}
    </MessageBubble>
  </div>
})

function MessageExpansion({ onExpand }: { onExpand(): Promise<void> }) {
  const expansion = useMutation({ mutationFn: onExpand, retry: false })
  return <>
    {!expansion.isSuccess ? <Button size="sm" variant="ghost" disabled={expansion.isPending}
      onClick={() => expansion.mutate()}>{expansion.isPending ? 'Loading full message…' : 'Show full message'}</Button> : null}
    {expansion.isError ? <p role="alert">{errorMessage(expansion.error, 'The full message could not be loaded.')}</p> : null}
  </>
}

/** A structured turn result (routing, board patches) reads as its summary line; the JSON stays one click away. */
function AgentContent({ content }: { content: string }) {
  const result = structuredResult(content)
  // While the result is still streaming its JSON, show progress instead of the raw text.
  if (!result && partialStructuredResult(content)) return <p className="agent-chat-writing" role="status">Writing the result…</p>
  if (!result) return <ChatMarkdown content={content} />
  return <>
    {result.prose ? <ChatMarkdown content={result.prose} /> : null}
    {result.summary ? <ChatMarkdown content={result.summary} /> : <p>Turn finished.</p>}
    <ResultDetails value={result.value} />
  </>
}

/** Opened details close from their end too, so a long result never needs scrolling back to its toggle. */
function ResultDetails({ value }: { value: unknown }) {
  const [open, setOpen] = useState(false)
  return <details className="agent-chat-tool" open={open} onToggle={event => setOpen(event.currentTarget.open)}>
    <summary>Result details</summary>
    {open ? <>
      <CodeBlock code={JSON.stringify(value, null, 2)} label="Result details" />
      <button type="button" className="agent-chat-tool-close" aria-label="Hide result details" title="Hide result details"
        onClick={() => setOpen(false)}><Icon name="minus" size={14} aria-hidden="true" /></button>
    </> : null}
  </details>
}
