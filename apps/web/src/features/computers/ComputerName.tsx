import { Pencil } from 'lucide-react'
import { COMPUTER_NAME_MAX_LENGTH } from '@foreman-code/contracts/computer-activity'
import type { DeviceProvisioningTarget } from '@foreman-code/contracts/device-resources'
import { useRenameComputer } from '../../shared/api/computerActivity'
import { TextField } from '../../shared/ui/nocturne'
import { useInlineNameEditor } from '../../shared/ui/useInlineNameEditor'

/** A computer's name; click it to rename. Enter or leaving the field saves, Esc cancels. */
export function ComputerName({ name, target }: { name: string; target: DeviceProvisioningTarget }) {
  const rename = useRenameComputer()
  const editor = useInlineNameEditor({ name, onCommit: next => rename.mutate({ target, name: next }) })
  if (!editor.editing) {
    return <>
      <h3><button ref={editor.title} type="button" className="computer-name" title="Rename" onClick={editor.begin}>
        <span>{rename.isPending ? rename.variables.name : name}</span><Pencil size={12} aria-hidden="true" />
      </button></h3>
      {rename.isError ? <small role="alert">{rename.error.message}</small> : null}
    </>
  }
  return <TextField {...editor.field} className="computer-name-field" label="Computer name" labelHidden maxLength={COMPUTER_NAME_MAX_LENGTH} />
}
