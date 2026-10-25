import { LoadingState } from '../../../shared/ui/nocturne'
import { useChatReconnect } from '../../chat-core'

/** While the chat loads or reconnects, a quiet status only; the draft stays in its store and returns with the composer. */
export function UnavailableChatDraft({ pending, onRefresh }: { draftKey?: string; pending: boolean; onRefresh(): void }) {
  useChatReconnect(!pending, onRefresh)
  return <LoadingState label={pending ? 'Loading this conversation…' : 'Reconnecting…'} rows={1} />
}
