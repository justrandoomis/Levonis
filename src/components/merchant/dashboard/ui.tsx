/**
 * Shared primitives of the merchant dashboard.
 *
 * One density scale for every tab — buttons 36px, one card shape — so the
 * panel reads as one instrument rather than eight screens that happen to
 * share a URL. CLAY (build plan §6 Phase 3.4): the card is `lv-surface`, a
 * field the shared well (`lv-input`), a button the house `lv-button`, a chip
 * the filter-chip press, a notice the flat `lv-alert`. Everything here is presentation; nothing
 * decides permissions (the server's `can`/`selling` answers do).
 *
 * NEW SCREENS USE THE SHARED KIT (src/components/ui/**). What is still built
 * on this one got three repairs in W6, with no change to how it looks:
 * a label now names its field (`htmlFor`), the Toggle is a real switch
 * (`role="switch"`, `aria-checked`) and a Chip says whether it is chosen
 * (`aria-pressed`); and the compact buttons and chips keep their drawn size
 * but HIT 44px — a transparent ::after reaches past the pill, the same
 * trick as the shared IconButton.
 */

import { useContext, useId } from 'react';
import { AlertCircle, Check, Loader2 } from 'lucide-react';
import { useStore } from '../../../StoreContext';
import { useLanguage } from '../../../LanguageContext';
import { WorkspaceContext } from '../shell/context';

export type Loc = (ar: string, en: string, ckb?: string) => string;

/**
 * A path on the MAIN site, from wherever the dashboard is rendered.
 * On `/merchant` the path is relative; on a store subdomain's `/admin` the
 * main site is another origin, so the apex carries the link (the shared
 * cookie keeps the session). Inside the workspace the apex is the server's
 * own `root_domain` (the shell's `mainHref`); it used to be a hard-coded
 * `levonis-iq.com`, which sent a staging or preview store's merchant to the
 * live site. Outside it, the apex is the store host minus its first label.
 */
export function useMainSiteHref(): (path: string) => string {
  const { store } = useStore();
  const workspace = useContext(WorkspaceContext);
  if (workspace) return workspace.mainHref;
  return (path: string) => (store ? `${window.location.protocol}//${window.location.host.split('.').slice(1).join('.')}${path}` : path);
}

export function Spinner() {
  return (
    <div className="py-10 flex justify-center">
      <Loader2 className="w-5 h-5 text-gold animate-spin" />
    </div>
  );
}

export function Empty({ text, hint }: { text: string; hint?: string }) {
  return (
    <div className="py-10 text-center">
      <p className="text-text-secondary text-[13px]">{text}</p>
      {hint && <p className="text-text-muted text-[11.5px] mt-1.5">{hint}</p>}
    </div>
  );
}

export function Notice({ text }: { text: string }) {
  return (
    <div className="lv-alert lv-alert-warning flex items-start gap-2">
      <AlertCircle className="w-4 h-4 text-warning shrink-0 mt-0.5" />
      <p className="text-text-primary text-[11.5px] leading-relaxed">{text}</p>
    </div>
  );
}

export function Card({
  title,
  action,
  children,
}: {
  title?: string;
  action?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <div className="lv-surface p-3.5">
      {(title || action) && (
        <div className="flex items-center justify-between gap-2 mb-2.5">
          {title && <h3 className="text-text-primary font-bold text-[13.5px]">{title}</h3>}
          {action}
        </div>
      )}
      {children}
    </div>
  );
}

export function Stat({
  label,
  value,
  accent,
  small,
}: {
  label: string;
  value: string;
  accent?: boolean;
  small?: boolean;
}) {
  return (
    <div className="lv-well rounded-md px-2.5 py-2">
      <p className="text-text-muted text-[10.5px] mb-0.5 truncate">{label}</p>
      <p
        className={`font-bold truncate ${small ? 'text-[12.5px]' : 'text-[14px]'} ${accent ? 'text-gold' : 'text-text-primary'}`}
        dir="ltr"
      >
        {value}
      </p>
    </div>
  );
}

/**
 * A limit the server enforces is drawn HERE too (review of the settings
 * screen): `maxLength` stops the typing at the server's own ceiling, and the
 * counter appears as the text nears it, so «too long» is never a refusal that
 * arrives after a successful-looking save. `error` is drawn under the field
 * and tied to it (`aria-invalid`, `aria-describedby`).
 */
function Counter({ id, length, max }: { id: string; length: number; max?: number }) {
  if (!max || length < Math.floor(max * 0.8)) return null;
  return (
    <span id={id} className={`text-[11px] tabular-nums ${length >= max ? 'text-warning' : 'text-text-muted'}`} dir="ltr">
      {length}/{max}
    </span>
  );
}

export function Input({
  label,
  value,
  onChange,
  type = 'text',
  placeholder,
  hint,
  ltr,
  maxLength,
  ariaLabel,
  error,
  inputMode,
}: {
  label?: string;
  value: string;
  onChange: (v: string) => void;
  type?: string;
  placeholder?: string;
  hint?: string;
  ltr?: boolean;
  /** The server's own ceiling for this field. */
  maxLength?: number;
  /** The field's name when no visible label is drawn. */
  ariaLabel?: string;
  /** A problem with THIS field, shown under it. */
  error?: string;
  inputMode?: React.HTMLAttributes<HTMLInputElement>['inputMode'];
}) {
  const id = useId();
  const described = [error ? `${id}-err` : '', hint ? `${id}-hint` : '', maxLength ? `${id}-count` : ''].filter(Boolean).join(' ') || undefined;
  return (
    <div className="min-w-0 flex-1">
      {label && <label htmlFor={id} className="block text-text-secondary text-[12px] font-semibold mb-1.5">{label}</label>}
      <input
        className="lv-input text-[13px]"
        id={id}
        aria-label={label ? undefined : ariaLabel ?? placeholder}
        aria-invalid={error ? true : undefined}
        aria-describedby={described}
        type={type}
        value={value}
        placeholder={placeholder}
        maxLength={maxLength}
        inputMode={inputMode}
        dir={ltr ? 'ltr' : undefined}
        onChange={(e) => onChange(e.target.value)}
      />
      {(hint || maxLength) && (
        <div className="mt-1 flex items-start justify-between gap-2">
          {hint ? <p id={`${id}-hint`} className="text-text-muted text-[11.5px] leading-snug">{hint}</p> : <span />}
          <Counter id={`${id}-count`} length={value.length} max={maxLength} />
        </div>
      )}
      {error && <p id={`${id}-err`} className="lv-field-error" role="alert">{error}</p>}
    </div>
  );
}

export function TextArea({
  label,
  value,
  onChange,
  rows = 3,
  hint,
  ariaLabel,
  maxLength,
  error,
}: {
  label?: string;
  value: string;
  onChange: (v: string) => void;
  rows?: number;
  hint?: string;
  /** The field's name when no visible label is drawn. */
  ariaLabel?: string;
  /** The server's own ceiling for this field. */
  maxLength?: number;
  /** A problem with THIS field, shown under it. */
  error?: string;
}) {
  const id = useId();
  const described = [error ? `${id}-err` : '', hint ? `${id}-hint` : '', maxLength ? `${id}-count` : ''].filter(Boolean).join(' ') || undefined;
  return (
    <div>
      {label && <label htmlFor={id} className="block text-text-secondary text-[12px] font-semibold mb-1.5">{label}</label>}
      <textarea
        className="lv-input py-2.5 text-[13px] leading-relaxed resize-none"
        id={id}
        aria-label={label ? undefined : ariaLabel}
        aria-invalid={error ? true : undefined}
        aria-describedby={described}
        value={value}
        rows={rows}
        maxLength={maxLength}
        onChange={(e) => onChange(e.target.value)}
      />
      {(hint || maxLength) && (
        <div className="mt-1 flex items-start justify-between gap-2">
          {hint ? <p id={`${id}-hint`} className="text-text-muted text-[11.5px] leading-snug">{hint}</p> : <span />}
          <Counter id={`${id}-count`} length={value.length} max={maxLength} />
        </div>
      )}
      {error && <p id={`${id}-err`} className="lv-field-error" role="alert">{error}</p>}
    </div>
  );
}

export function Toggle({
  label,
  on,
  onChange,
  disabled,
  hint,
}: {
  label: string;
  on: boolean;
  onChange: (v: boolean) => void;
  disabled?: boolean;
  hint?: string;
}) {
  return (
    <div>
      <button
        type="button"
        role="switch"
        aria-checked={on}
        onClick={() => !disabled && onChange(!on)}
        disabled={disabled}
        className="w-full flex items-center justify-between gap-3 min-h-11 disabled:opacity-60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus rounded-lg"
      >
        <span className="text-text-primary text-[12.5px] text-start">{label}</span>
        {/* ON is the accent track plus the thumb at the inline end — the
            design system's Switch (src/components/ui/Switch.tsx). The old ON
            track was --color-olive (#1B2010), next to black on a dark card:
            an open store and a paused one looked the same. */}
        <span
          aria-hidden="true"
          data-toggle={on ? 'on' : 'off'}
          className={`w-11 h-6 rounded-full shrink-0 relative border transition-colors ${on ? 'bg-accent border-transparent' : 'lv-well border-[var(--clay-field)]'}`}
        >
          <span
            className={`absolute top-[2px] w-[18px] h-[18px] rounded-full shadow-1 transition-all motion-reduce:transition-none ${on ? 'start-[22px] bg-accent-contrast' : 'start-[2px] bg-text-secondary'}`}
          />
        </span>
      </button>
      {hint && <p className="text-text-muted text-[11.5px] leading-relaxed mt-0.5">{hint}</p>}
    </div>
  );
}

export function Btn({
  children,
  onClick,
  kind = 'primary',
  disabled,
  full,
  small,
  label,
  ...data
}: {
  children: React.ReactNode;
  onClick?: () => void;
  kind?: 'primary' | 'ghost' | 'danger' | 'gold';
  disabled?: boolean;
  full?: boolean;
  small?: boolean;
  /** The accessible name of an icon-only button (also its tooltip); its hit area widens to 44px. */
  label?: string;
  /** `data-*` hooks for tests and the browser sweeps. */
  [dataAttribute: `data-${string}`]: string | boolean | undefined;
}) {
  // The house button (lv-button: raised clay, dented on press, the gold
  // focus outline), drawn at this kit's density — 36px (32 small) with the
  // ::after slop still hitting 44. «ghost» kept its outline here, so it is
  // the bordered secondary, not the flat text button.
  const style =
    kind === 'primary'
      ? 'lv-button-primary'
      : kind === 'gold'
        ? 'lv-button-accent'
        : kind === 'danger'
          ? 'lv-button-danger'
          : 'lv-button-secondary';
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      aria-label={label}
      title={label}
      {...data}
      className={`lv-button ${style} ${full ? 'w-full' : ''} ${label ? 'min-w-9 after:-inset-x-[5px]' : 'after:inset-x-0'} ${small ? "h-8 px-2.5 text-[11.5px] rounded-sm after:-inset-y-2" : "h-9 px-3.5 text-[12.5px] after:-inset-y-[5px]"} min-h-0 relative after:absolute after:content-[''] gap-1.5`}
    >
      {children}
    </button>
  );
}

/** A small selectable chip — kind pickers, filters, presets. */
export function Chip({
  label,
  active,
  onClick,
  disabled,
}: {
  label: React.ReactNode;
  active: boolean;
  onClick: () => void;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      aria-pressed={active}
      // The clay filter chip (docs/DECISIONS.md row 209): flush at rest,
      // PRESSED when chosen (the well fill and the press) plus the check —
      // selection is a press, never an inverted fill.
      className={`relative inline-flex h-8 items-center gap-1 px-3 rounded-full text-[11.5px] font-semibold border transition-colors disabled:opacity-40 after:absolute after:inset-x-0 after:-inset-y-2 after:content-[''] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus ${
        active ? 'border-transparent bg-[var(--clay-well-bg)] text-text-primary shadow-press' : 'border-border-subtle bg-surface-raised text-text-secondary shadow-xs hover:text-text-primary'
      }`}
    >
      {active ? <Check aria-hidden="true" className="size-3.5" strokeWidth={2.6} /> : null}
      {label}
    </button>
  );
}

/** Add/remove list of short strings (categories, coverage areas, materials). */
export function ChipListEditor({
  label,
  values,
  onChange,
  placeholder,
  max = 20,
  hint,
}: {
  label?: string;
  values: string[];
  onChange: (v: string[]) => void;
  placeholder?: string;
  max?: number;
  hint?: string;
}) {
  const id = useId();
  const { loc } = useLanguage();
  return (
    <div>
      {label && <label htmlFor={id} className="block text-text-secondary text-[12px] font-semibold mb-1.5">{label}</label>}
      <div className="flex flex-wrap gap-1.5 mb-2 empty:mb-0">
        {values.map((v) => (
          <span
            key={v}
            className="inline-flex items-center gap-1 h-7 ps-2.5 pe-1 rounded-full bg-surface-raised border border-border-subtle text-text-primary text-[11.5px]"
          >
            {v}
            <button
              type="button"
              onClick={() => onChange(values.filter((x) => x !== v))}
              className="relative w-5 h-5 rounded-full text-text-muted hover:text-danger after:absolute after:-inset-3 after:content-[''] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus"
              // It named itself «remove» in every language (W6).
              aria-label={`${loc('إزالة', 'Remove')} ${v}`}
            >
              ×
            </button>
          </span>
        ))}
      </div>
      {values.length < max && (
        <input
          className="lv-input text-[13px]"
          id={id}
          aria-label={label ? undefined : placeholder}
          type="text"
          placeholder={placeholder}
          onKeyDown={(e) => {
            if (e.key !== 'Enter') return;
            e.preventDefault();
            const v = (e.target as HTMLInputElement).value.trim();
            if (v && !values.includes(v)) onChange([...values, v]);
            (e.target as HTMLInputElement).value = '';
          }}
          onBlur={(e) => {
            const v = e.target.value.trim();
            if (v && !values.includes(v)) onChange([...values, v]);
            e.target.value = '';
          }}
        />
      )}
      {hint && <p className="text-text-muted text-[10.5px] mt-1">{hint}</p>}
    </div>
  );
}
