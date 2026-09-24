/**
 * SWITCH and CHECKBOX — the two ways to say yes or no.
 *
 * A SWITCH is a setting that takes effect the moment it flips («المتجر
 * مفتوح»). It is a real `role="switch"` with `aria-checked`, not a styled div:
 * the merchant dashboard's Toggle had neither, so a screen reader announced a
 * nameless button with no state, and a keyboard user could not tell whether
 * the store was open. The whole row is 44px tall and the label is bound to the
 * control, so tapping the words flips it too.
 *
 * The thumb is carried by a spring through a layout animation, so it travels
 * toward the inline END in either direction of writing — no physical
 * left/right to get backwards in Arabic — and a second tap mid-flight
 * reverses it from where it is. The ON state is the one accent (the track
 * fills) plus the thumb's position: never colour alone.
 *
 * A CHECKBOX is a choice that is submitted later, or one of many (selection
 * in a list). It is the platform's own input — the one control every screen
 * reader and keyboard already understands — tinted with the accent, and it
 * shares one 44px hit target with its label. `indeterminate` draws "some
 * selected", for a select-all box over a partly selected list.
 */
import React, { useEffect, useId, useRef } from 'react';
import { motion } from 'motion/react';
import { useMotion } from '../../lib/motion';

export interface SwitchProps {
  checked: boolean;
  onChange: (next: boolean) => void;
  /** The visible name. Required: a switch with no name is a guess. */
  label: React.ReactNode;
  /** One line under the label: what ON means. */
  description?: React.ReactNode;
  disabled?: boolean;
  /** Busy while the server confirms: the switch shows the requested state and refuses presses. */
  busy?: boolean;
  id?: string;
  className?: string;
}

export function Switch({ checked, onChange, label, description, disabled = false, busy = false, id: idProp, className = '' }: SwitchProps) {
  const m = useMotion();
  const auto = useId();
  const id = idProp ?? `switch-${auto}`;
  const descId = description ? `${id}-desc` : undefined;
  return (
    <div className={`flex min-h-11 items-center justify-between gap-3 ${className}`}>
      <div className="min-w-0">
        <label htmlFor={id} className="block cursor-pointer text-sm font-medium text-text-primary">
          {label}
        </label>
        {description && (
          <p id={descId} className="mt-0.5 text-[12px] leading-relaxed text-text-muted">
            {description}
          </p>
        )}
      </div>
      <button
        id={id}
        type="button"
        role="switch"
        aria-checked={checked}
        aria-describedby={descId}
        aria-busy={busy || undefined}
        aria-disabled={busy || undefined}
        disabled={disabled}
        onClick={() => {
          if (!busy) onChange(!checked);
        }}
        data-switch={checked ? 'on' : 'off'}
        className="group relative inline-flex h-11 w-14 shrink-0 items-center justify-center rounded-full focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus disabled:opacity-40"
      >
        <span
          aria-hidden="true"
          className={`flex h-7 w-12 items-center rounded-full border p-0.5 transition-colors ${
            checked ? 'justify-end border-transparent bg-accent' : 'justify-start border-border-subtle bg-white/10'
          }`}
        >
          <motion.span
            layout
            transition={m.reduced ? { duration: 0 } : m.spring('quick')}
            className={`block h-[22px] w-[22px] rounded-full shadow-1 ${checked ? 'bg-accent-contrast' : 'bg-text-secondary'}`}
          />
        </span>
      </button>
    </div>
  );
}

export interface CheckboxProps extends Omit<React.ComponentPropsWithRef<'input'>, 'type' | 'onChange' | 'checked'> {
  checked: boolean;
  onChange: (next: boolean) => void;
  /** Visible label; omit only when `aria-label` names it (a row's select box). */
  label?: React.ReactNode;
  /** "Some, not all" — a select-all box over a partly selected list. */
  indeterminate?: boolean;
}

export function Checkbox({ checked, onChange, label, indeterminate = false, className = '', disabled, ref: callerRef, ...rest }: CheckboxProps) {
  const ref = useRef<HTMLInputElement | null>(null);
  useEffect(() => {
    if (ref.current) ref.current.indeterminate = indeterminate && !checked;
  }, [indeterminate, checked]);
  const setRef = (el: HTMLInputElement | null) => {
    ref.current = el;
    if (typeof callerRef === 'function') callerRef(el);
    else if (callerRef) callerRef.current = el;
  };
  const input = (
    <input
      {...rest}
      ref={setRef}
      type="checkbox"
      checked={checked}
      disabled={disabled}
      aria-checked={indeterminate && !checked ? 'mixed' : undefined}
      onChange={(e) => onChange(e.currentTarget.checked)}
      className="h-[18px] w-[18px] shrink-0 cursor-pointer accent-gold disabled:cursor-not-allowed"
    />
  );
  return (
    <label
      className={`inline-flex min-h-11 min-w-11 cursor-pointer items-center gap-3 ${label ? '' : 'justify-center'} ${
        disabled ? 'cursor-not-allowed opacity-50' : ''
      } ${className}`}
    >
      {input}
      {label && <span className="min-w-0 text-sm text-text-primary">{label}</span>}
    </label>
  );
}
