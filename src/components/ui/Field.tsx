/**
 * FIELD — a label, the control, a hint and an error, wired to each other.
 *
 * WHAT WAS WRONG. The merchant dashboard's own kit rendered a `<label>` that
 * named nothing (no `htmlFor`, `merchant/dashboard/ui.tsx`), so a screen reader
 * reached an unnamed box and a tap on the label did not focus the field; its
 * errors were red text somewhere below, not attached to anything, and nothing
 * told assistive technology the value was invalid.
 *
 * WHAT THIS DOES. `<Field>` owns the ids and hands them to the control inside
 * it through context, so a call site writes
 *
 *   <Field label="السعر" hint="بالدينار" error={errors.price}>
 *     <NumberInput value={price} onValueChange={setPrice} />
 *   </Field>
 *
 * and gets: a visible label bound with `htmlFor`; the hint and the error
 * joined into `aria-describedby`; `aria-invalid` while there is an error; the
 * error drawn next to the field it is about (`.lv-field-error`), in words and
 * with an icon, never only in red. The label stays visible — a placeholder is
 * an example, not a name.
 *
 * `focusFirstInvalid(form)` is the other half of the pattern: on a failed
 * submit, focus the first field that says it is invalid, so the person lands
 * on the problem instead of hunting for it.
 *
 * Inputs are `.lv-input` (46px, the focus ring, the 16px coarse-pointer floor
 * in index.css that stops iOS zooming the page on focus).
 */
import React, { createContext, useContext, useId } from 'react';
import { AlertCircle, ChevronDown } from 'lucide-react';
import { useLanguage } from '../../LanguageContext';

interface FieldWiring {
  id: string;
  describedBy?: string;
  invalid: boolean;
  required: boolean;
}

const FieldContext = createContext<FieldWiring | null>(null);

/** The ids and states a control inside a `<Field>` should carry. */
export function useFieldControl(): FieldWiring | null {
  return useContext(FieldContext);
}

export interface FieldProps {
  label: React.ReactNode;
  children: React.ReactNode;
  /** One short line under the control. */
  hint?: React.ReactNode;
  /** Why the value is not accepted — shown next to the field and announced with it. */
  error?: React.ReactNode;
  /** Marks the control required (`required` + `aria-required`). */
  required?: boolean;
  /** Says «اختياري» beside the label. Mark the exception, not the rule. */
  optional?: boolean;
  /** Use a known id for the control instead of a generated one. */
  id?: string;
  className?: string;
}

export function Field({ label, children, hint, error, required = false, optional = false, id: idProp, className = '' }: FieldProps) {
  const { loc } = useLanguage();
  const auto = useId();
  const id = idProp ?? `field-${auto}`;
  const hintId = hint ? `${id}-hint` : undefined;
  const errorId = error ? `${id}-error` : undefined;
  const describedBy = [hintId, errorId].filter(Boolean).join(' ') || undefined;
  return (
    <FieldContext.Provider value={{ id, describedBy, invalid: !!error, required }}>
      <div className={`min-w-0 ${className}`} data-field={id}>
        <div className="mb-1.5 flex items-baseline justify-between gap-2">
          <label htmlFor={id} className="min-w-0 text-[13px] font-semibold text-text-secondary">
            {label}
          </label>
          {optional && (
            <span className="shrink-0 text-[12px] text-text-muted">{loc('اختياري', 'Optional', 'ئارەزوومەندانە')}</span>
          )}
        </div>
        {children}
        {hint && (
          <p id={hintId} className="mt-1.5 text-[12px] leading-relaxed text-text-muted">
            {hint}
          </p>
        )}
        {error && (
          <p id={errorId} className="lv-field-error flex items-start gap-1.5">
            <AlertCircle aria-hidden="true" className="mt-0.5 h-3.5 w-3.5 shrink-0" />
            <span className="min-w-0">{error}</span>
          </p>
        )}
      </div>
    </FieldContext.Provider>
  );
}

/** Merges the field's wiring into a control's own props; explicit props win. */
function wire<P extends { id?: string; 'aria-describedby'?: string; 'aria-invalid'?: React.AriaAttributes['aria-invalid']; required?: boolean }>(
  field: FieldWiring | null,
  props: P
): P {
  if (!field) return props;
  return {
    ...props,
    id: props.id ?? field.id,
    'aria-describedby': [props['aria-describedby'], field.describedBy].filter(Boolean).join(' ') || undefined,
    'aria-invalid': props['aria-invalid'] ?? (field.invalid || undefined),
    required: props.required ?? (field.required || undefined),
  };
}

export interface InputProps extends React.ComponentPropsWithRef<'input'> {
  /** Left-to-right content in any language: a URL, a SKU, an email, a phone number. */
  ltr?: boolean;
}

export function Input({ ltr = false, className = '', dir, ...props }: InputProps) {
  const field = useFieldControl();
  return <input {...wire(field, props)} dir={dir ?? (ltr ? 'ltr' : undefined)} className={`lv-input ${className}`} />;
}

export type TextareaProps = React.ComponentPropsWithRef<'textarea'>;

export function Textarea({ className = '', rows = 4, ...props }: TextareaProps) {
  const field = useFieldControl();
  return <textarea {...wire(field, props)} rows={rows} className={`lv-input resize-y py-2.5 leading-relaxed ${className}`} />;
}

export type SelectProps = React.ComponentPropsWithRef<'select'>;

/**
 * The platform's own select — on a phone that is the system picker, which no
 * custom listbox beats for a list of options. The chevron sits at the inline
 * end (left in Arabic) and does not take the tap.
 */
export function Select({ className = '', children, ...props }: SelectProps) {
  const field = useFieldControl();
  return (
    <div className="relative min-w-0">
      <select {...wire(field, props)} className={`lv-input appearance-none pe-10 ${className}`}>
        {children}
      </select>
      <ChevronDown
        aria-hidden="true"
        className="pointer-events-none absolute end-3 top-1/2 h-4 w-4 -translate-y-1/2 text-text-muted"
      />
    </div>
  );
}

/**
 * After a failed submit: focus the first control inside `root` that says it
 * is invalid, and bring it into view. Returns whether one was found.
 */
export function focusFirstInvalid(root: HTMLElement | null): boolean {
  const el = root?.querySelector<HTMLElement>('[aria-invalid="true"]');
  if (!el) return false;
  el.focus();
  return true;
}
