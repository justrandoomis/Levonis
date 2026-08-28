import React, { useState } from 'react';
import { Eye, EyeOff } from 'lucide-react';

/**
 * Labeled input for the /auth screen: a REAL <label> above the input,
 * inline error wired via aria-describedby, and an optional show/hide
 * toggle for passwords (44px touch target). Paste is never blocked and
 * nothing here interferes with password managers.
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
  /** Accessible labels for the password reveal toggle. */
  revealLabels?: { show: string; hide: string };
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
  revealLabels,
}: AuthTextFieldProps) {
  const [revealed, setRevealed] = useState(false);
  const isPassword = type === 'password';
  const inputType = isPassword ? (revealed ? 'text' : 'password') : type;
  const errorId = `${id}-error`;
  // Passwords render LTR by default so the toggle, padding and caret agree.
  const dirValue = valueDir ?? (isPassword ? 'ltr' : undefined);

  return (
    <div>
      <label htmlFor={id} className="mb-1.5 block text-[13px] font-semibold text-zinc-300">
        {label}
      </label>
      {/* The wrapper takes the VALUE's direction so the logical end-* /pe-*
          utilities of the input and the toggle resolve to the same side. */}
      <div className="relative" dir={dirValue}>
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
          aria-describedby={error ? errorId : undefined}
          className={`w-full min-h-[48px] rounded-xl border bg-zinc-950/70 px-4 py-3 text-[15px] text-white placeholder-zinc-600 outline-none transition-colors focus:border-gold/70 focus:ring-1 focus:ring-gold/40 disabled:opacity-60 ${
            error ? 'border-red-500/70' : 'border-zinc-800'
          } ${isPassword ? 'pe-13' : ''}`}
        />
        {isPassword && (
          <button
            type="button"
            onClick={() => setRevealed((v) => !v)}
            aria-label={revealed ? revealLabels?.hide : revealLabels?.show}
            aria-pressed={revealed}
            className="absolute end-1 top-1/2 flex h-11 w-11 -translate-y-1/2 items-center justify-center rounded-lg text-zinc-400 transition-colors hover:text-white focus-visible:ring-1 focus-visible:ring-gold/60"
          >
            {revealed ? <EyeOff className="h-5 w-5" /> : <Eye className="h-5 w-5" />}
          </button>
        )}
      </div>
      {error && (
        <p id={errorId} className="mt-1.5 text-xs font-medium text-red-400">
          {error}
        </p>
      )}
    </div>
  );
}
