import { useEffect, useRef, useState } from 'react';
import { Check, Loader2, X } from 'lucide-react';
import { api } from '../../lib/api';
import { onboardingStrings, usernameReasonLabel } from './strings';

/**
 * A username input that says whether the name is free WHILE it is typed.
 *
 * WHY IT ASKS THE SERVER RATHER THAN GUESSING. Availability is not something
 * a browser can know, and the shape rules (reserved handles, look-alike
 * punctuation) live in one place on the server so signup, the account page
 * and this field can never disagree. The endpoint returns a REASON, not a
 * boolean, so "unavailable" never sends somebody hunting through variations
 * of a name that will never be accepted.
 *
 * It is debounced and the response is discarded if a newer keystroke has
 * already been sent — otherwise a slow answer for `ali` lands after a fast
 * answer for `ali3d` and marks a free name as taken.
 */
export type UsernameState = 'idle' | 'checking' | 'free' | 'unavailable';

export interface UsernameFieldProps {
  id?: string;
  value: string;
  onChange: (v: string) => void;
  onStateChange?: (state: UsernameState) => void;
  lang: string;
  label?: string;
  disabled?: boolean;
  autoFocus?: boolean;
}

export default function UsernameField({
  id = 'onboarding-username',
  value,
  onChange,
  onStateChange,
  lang,
  label,
  disabled,
  autoFocus,
}: UsernameFieldProps) {
  const s = onboardingStrings(lang);
  const [state, setState] = useState<UsernameState>('idle');
  const [reason, setReason] = useState<string | null>(null);
  const latest = useRef(0);

  useEffect(() => {
    const trimmed = value.trim().toLowerCase();
    if (!trimmed) {
      setState('idle');
      setReason(null);
      onStateChange?.('idle');
      return;
    }
    setState('checking');
    onStateChange?.('checking');
    const ticket = ++latest.current;
    const timer = setTimeout(() => {
      api
        .get<{ available: boolean; reason: string | null }>(
          `/api/auth/username-available?u=${encodeURIComponent(trimmed)}`
        )
        .then((r) => {
          if (ticket !== latest.current) return; // a newer keystroke won
          const next: UsernameState = r.available ? 'free' : 'unavailable';
          setState(next);
          setReason(r.reason);
          onStateChange?.(next);
        })
        .catch(() => {
          if (ticket !== latest.current) return;
          // The name may well be fine — we simply do not know. Saying
          // "unavailable" here would block a valid name over a dropped
          // request, so the field goes quiet and the server decides on save.
          setState('idle');
          setReason(null);
          onStateChange?.('idle');
        });
    }, 350);
    return () => clearTimeout(timer);
    // onStateChange is a callback prop; re-running on its identity would
    // re-issue the request on every parent render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value]);

  const message =
    state === 'checking'
      ? s.usernameChecking
      : state === 'free'
        ? s.usernameFree
        : state === 'unavailable'
          ? usernameReasonLabel(s, reason)
          : s.usernameHint;

  const tone =
    state === 'free' ? 'text-success' : state === 'unavailable' ? 'text-danger' : 'text-text-muted';

  return (
    <div>
      <label htmlFor={id} className="mb-1.5 block text-[13px] font-semibold text-text-secondary">
        {label ?? s.username}
      </label>
      <div className="relative" dir="ltr">
        <input
          className={`lv-input min-h-12 py-3 pe-11 text-[15px] disabled:opacity-60 ${state === 'free' ? 'border-success' : ''}`}
          id={id}
          name="username"
          value={value}
          onChange={(e) => onChange(e.target.value.toLowerCase())}
          autoComplete="username"
          autoCapitalize="none"
          autoCorrect="off"
          spellCheck={false}
          dir="ltr"
          disabled={disabled}
          autoFocus={autoFocus}
          aria-describedby={`${id}-msg`}
          aria-invalid={state === 'unavailable' ? true : undefined}
          placeholder="username123"
        />
        <span className="pointer-events-none absolute inset-y-0 end-3 flex items-center">
          {state === 'checking' ? (
            <Loader2 className="h-4 w-4 animate-spin text-text-muted" aria-hidden />
          ) : state === 'free' ? (
            <Check className="h-4 w-4 text-success" aria-hidden />
          ) : state === 'unavailable' ? (
            <X className="h-4 w-4 text-danger" aria-hidden />
          ) : null}
        </span>
      </div>
      {/* One reserved line: the message changes, the layout does not. */}
      <p id={`${id}-msg`} className={`mt-1.5 min-h-[16px] text-xs leading-relaxed ${tone}`} aria-live="polite">
        {message}
      </p>
    </div>
  );
}
