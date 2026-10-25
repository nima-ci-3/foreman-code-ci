import { useId, type InputHTMLAttributes, type TextareaHTMLAttributes, type SelectHTMLAttributes, type ReactNode, type Ref } from 'react'
import { cx, clamp } from './utils'
import { Icon } from './Icon'

interface FieldMeta { label: string; labelHint?: ReactNode; hint?: ReactNode; error?: string; className?: string }
function descriptions(id: string, hint: ReactNode, error: string | undefined, supplied?: string) {
  return [supplied, hint ? `${id}-hint` : '', error ? `${id}-error` : ''].filter(Boolean).join(' ') || undefined
}
/** `labelHidden` keeps the label for screen readers only, where the surrounding layout already names the field. */
interface HideableLabel { labelHidden?: boolean }
function FieldLabel({ id, label, labelHint, required, hidden }: { id: string; label: string; labelHint?: ReactNode; required?: boolean; hidden?: boolean }) {
  const text = <label htmlFor={id} className={hidden && !labelHint ? 'n-sr-only' : undefined}>{label}{required && <span aria-hidden="true"> *</span>}</label>
  return labelHint ? <div className={cx('n-field-label', hidden && 'n-sr-only')}>{text}{labelHint}</div> : text
}
function FieldNotes({ id, hint, error }: { id: string; hint?: ReactNode; error?: string }) {
  return <>{hint && <span id={`${id}-hint`} className="n-field-hint">{hint}</span>}{error && <span id={`${id}-error`} className="n-field-error"><Icon name="warning" size={14} />{error}</span>}</>
}

export function TextField({ label, labelHint, labelHidden, hint, error, className, id: suppliedId, leading, trailing, ...props }:
  InputHTMLAttributes<HTMLInputElement> & { ref?: Ref<HTMLInputElement> } & FieldMeta & HideableLabel & { leading?: ReactNode; trailing?: ReactNode; labelHint?: ReactNode }) {
  const generated = useId()
  const id = suppliedId ?? generated
  return <div className={cx('n-field', className)}>
    <FieldLabel id={id} label={label} labelHint={labelHint} required={props.required} hidden={labelHidden} />
    <div className="n-input-wrap" data-invalid={Boolean(error)}>
      {leading && <span className="n-input-leading">{leading}</span>}
      <input {...props} id={id} className="n-input" aria-invalid={error ? true : props['aria-invalid']}
        aria-describedby={descriptions(id, hint, error, props['aria-describedby'])} />
      {trailing && <span className="n-input-trailing">{trailing}</span>}
    </div><FieldNotes id={id} hint={hint} error={error} /></div>
}

export function SearchField(props: InputHTMLAttributes<HTMLInputElement> & { ref?: Ref<HTMLInputElement> } & FieldMeta & HideableLabel) {
  return <TextField {...props} type="search" leading={<Icon name="search" size={16} />} />
}

export function Textarea({ label, labelHint, labelHidden, hint, error, className, id: suppliedId, ...props }: TextareaHTMLAttributes<HTMLTextAreaElement> & { ref?: Ref<HTMLTextAreaElement> } & FieldMeta & HideableLabel) {
  const generated = useId()
  const id = suppliedId ?? generated
  return <div className={cx('n-field', className)}>
    <FieldLabel id={id} label={label} labelHint={labelHint} required={props.required} hidden={labelHidden} />
    <textarea {...props} id={id} className="n-input n-textarea" aria-invalid={error ? true : props['aria-invalid']}
      aria-describedby={descriptions(id, hint, error, props['aria-describedby'])} /><FieldNotes id={id} hint={hint} error={error} /></div>
}

export interface SelectOption { value: string; label: string; disabled?: boolean }
export function Select({ label, labelHint, labelHidden, hint, error, options, className, id: suppliedId, ...props }:
  SelectHTMLAttributes<HTMLSelectElement> & { ref?: Ref<HTMLSelectElement> } & FieldMeta & HideableLabel & { options: readonly SelectOption[]; labelHint?: ReactNode }) {
  const generated = useId()
  const id = suppliedId ?? generated
  return <div className={cx('n-field', className)}>
    <FieldLabel id={id} label={label} labelHint={labelHint} required={props.required} hidden={labelHidden} />
    <div className="n-select-wrap"><select {...props} id={id} className="n-input" aria-invalid={error ? true : props['aria-invalid']}
      aria-describedby={descriptions(id, hint, error, props['aria-describedby'])}>{options.map((option) => <option key={option.value} value={option.value} disabled={option.disabled}>{option.label}</option>)}</select><Icon name="down" size={15} /></div>
    <FieldNotes id={id} hint={hint} error={error} /></div>
}

export function Checkbox({ label, labelHint, hint, error, className, id: suppliedId, ...props }: Omit<InputHTMLAttributes<HTMLInputElement>, 'type'> & { ref?: Ref<HTMLInputElement> } & FieldMeta) {
  const generated = useId()
  const id = suppliedId ?? generated
  const control = <label className="n-check" htmlFor={id}>
    <input {...props} type="checkbox" id={id} aria-invalid={error ? true : props['aria-invalid']} aria-describedby={descriptions(id, hint, error, props['aria-describedby'])} />
    <span>{label}</span></label>
  return <div className={cx('n-check-field', className)}>
    {labelHint ? <div className="n-field-label">{control}{labelHint}</div> : control}
    <FieldNotes id={id} hint={hint} error={error} /></div>
}

export function Switch({ label, labelHint, hint, className, id: suppliedId, ...props }: Omit<InputHTMLAttributes<HTMLInputElement>, 'type'> & { ref?: Ref<HTMLInputElement> } & Omit<FieldMeta, 'error'>) {
  const generated = useId()
  const id = suppliedId ?? generated
  const text = <span className="n-switch-text">
    {labelHint ? <span className="n-field-label"><label htmlFor={id}>{label}</label>{labelHint}</span> : <span>{label}</span>}
    {hint && <span className="n-field-hint" id={`${id}-hint`}>{hint}</span>}
  </span>
  const control = <span className="n-switch"><input {...props} type="checkbox" role="switch" id={id}
    aria-describedby={descriptions(id, hint, undefined, props['aria-describedby'])} />
    <span aria-hidden="true" className="n-switch-track" /></span>
  return labelHint ? <div className={cx('n-switch-field', className)}>
    {text}<label htmlFor={id}>{control}</label>
  </div> : <label className={cx('n-switch-field', className)} htmlFor={id}>{text}{control}</label>
}

export function RadioGroup({ label, name, value, options, onValueChange, disabled = false, hint, labelHint }:
  { label: string; name?: string; value: string; options: readonly (SelectOption & { description?: string })[]; onValueChange: (value: string) => void; disabled?: boolean; hint?: string; labelHint?: ReactNode }) {
  const id = useId()
  return <fieldset className="n-radio-group" disabled={disabled} aria-describedby={hint ? `${id}-hint` : undefined}>
    <legend>{label}{labelHint}</legend>{hint && <p className="n-field-hint" id={`${id}-hint`}>{hint}</p>}
    {options.map((option) => <label key={option.value} className="n-radio-option" data-selected={value === option.value}>
      <input type="radio" name={name ?? id} value={option.value} checked={value === option.value} disabled={option.disabled} onChange={() => onValueChange(option.value)} />
      <span>{option.label}{option.description && <small>{option.description}</small>}</span></label>)}
  </fieldset>
}

export function Slider({ label, value, min = 0, max = 100, step = 1, onValueChange, format = String, disabled = false }:
  { label: string; value: number; min?: number; max?: number; step?: number; onValueChange: (value: number) => void; format?: (value: number) => string; disabled?: boolean }) {
  const id = useId()
  const lower = Number.isFinite(min) ? min : 0
  const upper = Math.max(lower, Number.isFinite(max) ? max : 100)
  const safe = clamp(value, lower, upper)
  return <div className="n-field"><div className="n-between"><label htmlFor={id}>{label}</label><output htmlFor={id} className="n-mono">{format(safe)}</output></div>
    <input className="n-range" id={id} type="range" value={safe} min={lower} max={upper} step={Number.isFinite(step) && step > 0 ? step : 1} disabled={disabled || lower === upper}
      aria-valuetext={format(safe)} onChange={(event) => onValueChange(Number(event.currentTarget.value))} /></div>
}
