import { Button } from '../../../shared/ui/nocturne'
import type { useCanonicalDelivery } from './useCanonicalDelivery'

/** The notices a delivery needs the user to act on: a changed target, feedback, and unconfirmed control or delivery. */
export function DeliveryNotices({ flow }: { flow: Pick<ReturnType<typeof useCanonicalDelivery>, 'delivery' | 'pin'> }) {
  const { delivery, pin } = flow
  return <>
    {pin.stale ? <Button onClick={pin.refresh}>Refresh target</Button> : null}
    {delivery.feedback ? <p role="alert">{delivery.feedback}</p> : null}
    {delivery.pendingControl ? <p role="status">Control is not confirmed. <Button disabled={delivery.busy || !delivery.online}
      onClick={delivery.retryControl}>Retry original control</Button></p> : null}
    {delivery.pending ? <p role="status">Delivery is not confirmed. <Button onClick={() => void delivery.reconcile()}>Check status</Button>
      <Button onClick={() => void delivery.reconcile(true)}>Retry original message</Button></p> : null}
  </>
}
