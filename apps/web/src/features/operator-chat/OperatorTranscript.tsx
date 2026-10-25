import type { ComponentProps, ReactNode } from 'react'
import type { Message, OperatorActivity } from '@foreman-code/contracts'
import { Button } from '../../shared/ui/nocturne'
import { useInfiniteQuery, useQueryClient } from '@tanstack/react-query'
import { identityEpoch } from '../../shared/api/protectedChatStorage'
import { getOperatorActivity, mergeOperatorActivity } from '../../shared/api/operatorActivity'
import { useNativeHarnessOptions } from '../../shared/api/harnessSettings'
import { OperatorMessages } from './OperatorMessages'
import { OperatorHistory } from './OperatorHistory'
import { HistoryWindowNotice, useChatTurnCompleted } from '../chat-core'
import { ConversationViewport } from '../conversations/ConversationViewport'
import type { OperatorTextProjection } from './operatorTextProjection'

function AcceptedModelMessages(props: ComponentProps<typeof OperatorMessages>) {
  const harnesses = new Set(props.messages.map((message) => message.acceptedModel?.harness))
  const codex = useNativeHarnessOptions('codex', harnesses.has('codex'))
  const claude = useNativeHarnessOptions('claude', harnesses.has('claude'))
  return <OperatorMessages {...props} modelCatalogs={{ codex: codex.data?.models, claude: claude.data?.models }} />
}

/** Follow meaningful new output, never the identity of a freshly created React element. */
export function OperatorTranscript({ messages, partialText, thinkingText = '', hasEarlierMessages = false, working = false,
  conversationId, activities = [], activityNextCursor, activeRequestId, parts, timeline, approval, approvalRevision }: {
  messages: Message[]; partialText: string; thinkingText?: string; hasEarlierMessages?: boolean; working?: boolean;
  conversationId?: string; activities?: OperatorActivity[]; activityNextCursor?: string | null;
  activeRequestId?: string | null; parts?: Record<string, string>;
  timeline?: OperatorTextProjection;
  approval?: ReactNode | ((onBrowse: () => void) => ReactNode);
  approvalRevision?: string;
}) {
  const client = useQueryClient()
  const turnCompleted = useChatTurnCompleted(conversationId, activeRequestId)
  const activityKey = ['operator-chat', 'activity', conversationId ?? '', identityEpoch()] as const
  const earlierActivity = useInfiniteQuery({
    maxPages: 5, queryKey: activityKey,
    queryFn: ({ pageParam, signal }) => getOperatorActivity(conversationId ?? '', pageParam ? { before: pageParam } : {}, { signal }),
    initialPageParam: activityNextCursor ?? undefined,
    getNextPageParam: (page) => page.nextCursor ?? undefined,
    enabled: false,
  })
  const entries = mergeOperatorActivity(...(earlierActivity.data?.pages.map((page) => page.activities) ?? []), activities)
  // Polling can create new arrays/elements with identical contents. Loading old
  // pages is browsing, not new output, so only the recent stream participates.
  const contentRevision = JSON.stringify([
    messages.map((message) => [message.id, message.content, message.afterActivitySequence, message.nativeMessageComplete, message.attachments]),
    activities.map((entry) => [entry.id, entry.revision]), partialText, thinkingText, timeline?.timeline,
    approvalRevision ?? Boolean(approval),
  ])
  const renderMessages = (older: Message[], onBrowse: () => void) => <AcceptedModelMessages messages={[...older, ...messages]}
    activities={entries} activeRequestId={activeRequestId} parts={parts} timeline={timeline} working={working && !turnCompleted}
    partialText={partialText} thinkingText={thinkingText} onBrowse={onBrowse} />
  return <ConversationViewport classPrefix="operator-chat-transcript" label="Operator transcript" revision={contentRevision}
    storageKey={conversationId ? `operator:${conversationId}` : undefined}>{(onBrowse) => <>
    {earlierActivity.data && earlierActivity.data.pageParams[0] !== (activityNextCursor ?? undefined)
      ? <HistoryWindowNotice pending={earlierActivity.isFetching && !earlierActivity.isRefetching} onReload={() => {
        onBrowse()
        void client.resetQueries({ queryKey: activityKey, exact: true }).then(() => earlierActivity.fetchNextPage())
      }} /> : null}
    {(activityNextCursor && !earlierActivity.data) || earlierActivity.hasNextPage ? <Button size="sm" variant="ghost" disabled={earlierActivity.isFetching && !earlierActivity.isRefetching}
      onClick={() => { onBrowse(); void earlierActivity.fetchNextPage() }}>Load earlier activity</Button> : null}
    {earlierActivity.isError ? <p role="alert">Earlier activity could not be loaded. <Button size="sm" onClick={() => { onBrowse(); void earlierActivity.fetchNextPage() }}>Retry activity</Button></p> : null}
    {hasEarlierMessages ? <OperatorHistory conversationId={conversationId} recentMessages={messages} onBrowse={onBrowse}
      renderMessages={(older) => renderMessages(older, onBrowse)} /> : renderMessages([], onBrowse)}
    {typeof approval === 'function' ? approval(onBrowse) : approval}
  </>}</ConversationViewport>
}
