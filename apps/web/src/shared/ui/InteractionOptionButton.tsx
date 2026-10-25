import { useId } from 'react'
import type { ApprovalResponseOption } from '@foreman-code/contracts'
import { Button, type ButtonProps } from './nocturne'
import { approvalOptionScope } from './approvalOptionScope'
import './interactionOptionButton.css'

/** One response option: its button, with the option's structured scope always readable beside it. */
export function InteractionOptionButton({ option, label = option.label, variant, disabled, loading, compact = false, onSelect }: {
  option: ApprovalResponseOption; label?: string; variant?: ButtonProps['variant']; disabled?: boolean; loading?: boolean
  /** Dense rows (the approval inbox): the scope stays the button's description but is not shown. */
  compact?: boolean
  onSelect(optionId: string): void
}) {
  const descriptionId = useId()
  const scope = approvalOptionScope(option)
  return <div className={compact ? 'operator-approval-choice operator-approval-choice--compact' : 'operator-approval-choice'}>
    <Button size="sm" variant={variant} disabled={disabled} loading={loading} aria-describedby={descriptionId} title={scope}
      onClick={() => onSelect(option.optionId)}>{label}</Button>
    <p id={descriptionId} className={compact ? 'n-sr-only' : 'operator-approval-scope'}>
      {typeof option.scopeSummary === 'string' && option.scopeSummary.trim() ? <span>{option.scopeSummary} </span> : null}{scope}
    </p>
  </div>
}
