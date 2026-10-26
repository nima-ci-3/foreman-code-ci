import { useImperativeHandle, useState, type Ref } from 'react'
import { Button, Dialog, TextField } from '../../shared/ui/nocturne'
import { useInlineNameEditor } from '../../shared/ui/useInlineNameEditor'

export interface WorkflowNameHandle { begin(): void }
/** Enter renames (an undoable draft edit). Leaving the field with a changed name asks to rename or discard. */
export function WorkflowName({ name, disabled, onRename, ref }: { name: string; disabled: boolean; onRename(name: string): void;
  ref?: Ref<WorkflowNameHandle> }) {
  const [confirming, setConfirming] = useState<string>()
  // A blurred rename asks first; Enter renames directly.
  const editor = useInlineNameEditor({ name, disabled, onCommit: (next, { keyboard }) => keyboard ? onRename(next) : setConfirming(next) })
  const decide = (rename: boolean) => {
    if (rename && confirming) onRename(confirming)
    setConfirming(undefined)
  }
  useImperativeHandle(ref, () => ({ begin: editor.begin }))
  return <><h2 className="board-name"><span className="board-name-sizing" aria-hidden="true">{name}</span>{editor.editing ? <TextField {...editor.field} className="board-name-field" label="Workflow name" aria-label="Workflow name" disabled={disabled} />
    : <button ref={editor.title} className="board-name-button" title="Rename workflow" disabled={disabled}
      onClick={editor.begin}>{name}</button>}</h2>
    {confirming !== undefined ? <Dialog open title={`Rename to “${confirming}”?`} closeLabel="Discard new name" returnFocusRef={editor.title} size="sm"
      description="You can undo it with Ctrl+Z. Save keeps it."
      onOpenChange={(open) => { if (!open) decide(false) }}>
      <div className="n-actions">
        <Button onClick={() => decide(false)}>Discard</Button>
        <Button variant="primary" onClick={() => decide(true)}>Rename</Button>
      </div>
    </Dialog> : null}</>
}
