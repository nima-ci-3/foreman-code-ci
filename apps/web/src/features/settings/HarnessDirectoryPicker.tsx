import { InfoHint } from '../../shared/ui/InfoHint'
import { Button } from '../../shared/ui/nocturne'
import { useHarnessSessionEpoch } from '../../shared/api/harnessSettings'
import { WorkspaceFolderPicker } from './WorkspaceFolderPicker'

type Props = { value: string[]; onChange(value: string[]): void; error?: string }
function DirectoryPicker({ value, onChange, error }: Props) {
  return <section className="harness-directory-picker" aria-label="Additional writable directories">
    <div className="harness-section-heading"><h4>Additional folders{!value.length ? <InfoHint label="Additional folders">Only the current workspace is added.</InfoHint> : null}</h4>
      {/* The same folder browser as workspace locations: history, destination path and focus handling. */}
      <WorkspaceFolderPicker disabled={false} onSelect={(path) => onChange([...new Set([...value, path])])} /></div>
    {value.length ? <ul className="harness-folder-list">{value.map((path, index) => <li key={`${path}-${index}`}><span title={path}>{path}</span>
      <Button size="sm" variant="ghost" aria-label={`Remove writable folder ${path}`} onClick={() => onChange(value.filter((_, position) => position !== index))}>Remove</Button></li>)}</ul>
      : null}
    {error ? <p className="n-field-error" role="alert">{error}</p> : null}
  </section>
}

export function HarnessDirectoryPicker(props: Props) {
  const epoch = useHarnessSessionEpoch()
  return <DirectoryPicker key={epoch} {...props} />
}
