import React, { useState } from 'react';
import { Eye, EyeOff } from 'lucide-react';

/**
 * Labeled input for the /auth screen: a REAL <label> above the input,
 * inline error wired via aria-describedby, an optional leading icon, an
 * optional trailing status glyph with a reserved help line (username
 * availability), and an optional show/hide toggle for passwords (40px
 * target inside a 46px field). Paste is never blocked and nothing here
 * interferes with password managers.
 *
 * 16px value text is deliberate: anything smaller makes iOS Safari zoom the
 * whole page when the field is focused.
 */

export interface AuthTextFieldProps {
  id: string;
  label: string;
  value: string;
  onChange: (value: string) => void;
  type?: 'text' | 'email' | 'password';
  autoComplete?: string;
  inputMode?: 'text' | 'email' | 'numeric' | 'tel' | 'search' | 'url' | 'decimal' | 'none';
  placeholder?: string;
  error?: string;
  minLength?: number;
  maxLength?: number;
  /**
   * Direction of the VALUE. Emails, usernames and passwords are LTR even on
   * RTL pages; free text (a person's name) should use "auto".
   */
  valueDir?: 'ltr' | 'rtl' | 'auto';
  autoCapitalize?: 'none' | 'sentences' | 'words' | 'characters';
  spellCheck?: boolean;
  disabled?: boolean;
  /** Leading icon, rendered at the field's inline start. Decorative. */
  icon?: React.ReactNode;
  /** Accessible labels for the password reveal toggle. */
  revealLabels?: { show: string; hide: string };
  /** A reserved one-line message under the field (never shifts layout). */
  help?: string;
  /** Tone of the help line and of the trailing glyph. */
  helpTone?: 'neutral' | 'ok' | 'bad';
  /** Trailing status glyph at the inline end (decorative). */
  trail?: React.ReactNode;
  /** Whether the value is announced as valid (green hairline). */
  ok?: boolean;
}

export default function AuthTextField({
  id,
  label,
  value,
  onChange,
  type = 'text',
  autoComplete,
  inputMode,
  placeholder,
  error,
  minLength,
  maxLength,
  valueDir,
  autoCapitalize,
  spellCheck,
  disabled,
  icon,
  revealLabels,
  help,
  helpTone = 'neutral',
  trail,
  ok,
}: AuthTextFieldProps) {
  const [revealed, setRevealed] = useState(false);
  const isPassword = type === 'password';
  const inputType = isPassword ? (revealed ? 'text' : 'password') : type;
  const errorId = `${id}-error`;
  const helpId = `${id}-help`;
  // Passwords render LTR by default so the toggle, padding and caret agree.
  const dirValue = valueDir ?? (isPassword ? 'ltr' : undefined);
  const describedBy = error ? errorId : help !== undefined ? helpId : undefined;
  const tone = helpTone === 'ok' ? ' is-ok' : helpTone === 'bad' ? ' is-bad' : '';

  return (
    <div>
      <label htmlFor={id} className="lv-field__label">
        {label}
      </label>
      {/* The wrapper takes the VALUE's direction so the logical start/end
          of the input, the icon and the toggle all resolve to the same side. */}
      <div className="lv-field__frame" dir={dirValue}>
        {icon && (
          <span aria-hidden className="lv-field__icon">
            {icon}
          </span>
        )}
        <input
          id={id}
          name={id}
          type={inputType}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          autoComplete={autoComplete}
          inputMode={inputMode}
          placeholder={placeholder}
          minLength={minLength}
          maxLength={maxLength}
          autoCapitalize={autoCapitalize}
          spellCheck={spellCheck}
          disabled={disabled}
          aria-invalid={error ? true : undefined}
          aria-describedby={describedBy}
          className={`lv-field__input${icon ? ' has-icon' : ''}${isPassword ? ' has-reveal' : ''}${
            trail ? ' has-trail' : ''
          }${error ? ' is-error' : ''}${ok && !error ? ' is-ok' : ''}`}
        />
        {isPassword && (
          <button
            type="button"
            onClick={() => setRevealed((v) => !v)}
            aria-label={revealed ? revealLabels?.hide : revealLabels?.show}
            aria-pressed={revealed}
            className="lv-field__reveal"
          >
            {revealed ? <EyeOff /> : <Eye />}
          </button>
        )}
        {!isPassword && trail && (
          <span aria-hidden className={`lv-field__trail${tone}`}>
            {trail}
          </span>
        )}
      </div>
      {error ? (
        <p id={errorId} className="lv-field__error">
          {error}
        </p>
      ) : help !== undefined ? (
        <p id={helpId} className={`lv-field__help${tone}`} aria-live="polite">
          {help}
        </p>
      ) : null}
    </div>
  );
}
