import type { ReactNode } from 'react'
import type { MemoryCard as Card } from '@foreman-code/contracts'
import { Button } from '../../shared/ui/nocturne/Button'
import { MemoryCard } from './MemoryCard'
import { statusLabels } from './presentation'
import { mergedMemoryItems, type useMemoryCards } from './queries'
import type { MemoryNodeOption } from './ports'

/** One status column's cards and its "Load more" button, for the memory board and the Board's Kanban.
 * `decorate` wraps each rendered card (the Kanban marks cards an Agent just changed). */
export function MemoryCardList({ query, status, nodes, onOpen, decorate, compact = false }: {
  query: ReturnType<typeof useMemoryCards>; status: Card['status']; nodes: readonly MemoryNodeOption[]; onOpen(cardId: string): void
  decorate?(card: Card, rendered: ReactNode): ReactNode; compact?: boolean
}) {
  return <>
    {mergedMemoryItems(query.data?.pages).map(card => {
      const rendered = <MemoryCard key={card.id} card={card} nodes={nodes} onOpen={() => onOpen(card.id)} />
      return decorate ? decorate(card, rendered) : rendered
    })}
    {query.hasNextPage ? <Button size={compact ? 'sm' : undefined} variant={compact ? 'ghost' : undefined} loading={query.isFetchingNextPage}
      loadingLabel="Loading cards…" onClick={() => void query.fetchNextPage()}>Load more {statusLabels[status]}</Button> : null}
  </>
}
