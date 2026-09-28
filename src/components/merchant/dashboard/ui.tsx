/**
 * Shared primitives of the merchant dashboard.
 *
 * One density scale for every tab — inputs 40px, buttons 36px, one card
 * shape — so the panel reads as one instrument rather than eight screens
 * that happen to share a URL. Everything here is presentation; nothing
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
import { AlertCircle, Loader2 } from 'lucide-react';
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
      <p className="text-zinc-400 text-[13px]">{text}</p>
      {hint && <p className="text-text-muted text-[11.5px] mt-1.5">{hint}</p>}
    </div>
  );
}

export function Notice({ text }: { text: string }) {
  return (
    <div className="flex items-start gap-2 rounded-2xl border border-amber-500/30 bg-amber-500/10 px-3 py-2.5">
      <AlertCircle className="w-4 h-4 text-amber-400 shrink-0 mt-0.5" />
      <p className="text-amber-200/90 text-[11.5px] leading-relaxed">{text}</p>
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
    <div className="rounded-2xl border border-white/10 bg-white/[0.03] p-3.5">
      {(title || action) && (
        <div className="flex items-center justify-between gap-2 mb-2.5">
          {title && <h3 className="text-gold font-bold text-[12.5px]">{title}</h3>}
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
    <div className="rounded-2xl border border-white/10 bg-white/[0.03] px-2.5 py-2">
      <p className="text-text-muted text-[10.5px] mb-0.5 truncate">{label}</p>
      <p
        className={`font-bold truncate ${small ? 'text-[12.5px]' : 'text-[14px]'} ${accent ? 'text-gold' : 'text-white'}`}
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
    <span id={id} className={`text-[11px] tabular-nums ${length >= max ? 'text-amber-400' : 'text-text-muted'}`} dir="ltr">
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
      {label && <label htmlFor={id} className="block text-zinc-400 text-[12px] font-semibold mb-1.5">{label}</label>}
      <input
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
        className={`w-full h-11 rounded-xl bg-black/40 border px-3 text-white text-[13px] outline-none focus:border-gold/40 focus-visible:ring-2 focus-visible:ring-focus transition-colors ${error ? 'border-red-400/60' : 'border-white/10'}`}
      />
      {(hint || maxLength) && (
        <div className="mt-1 flex items-start justify-between gap-2">
          {hint ? <p id={`${id}-hint`} className="text-text-muted text-[11.5px] leading-snug">{hint}</p> : <span />}
          <Counter id={`${id}-count`} length={value.length} max={maxLength} />
        </div>
      )}
      {error && <p id={`${id}-err`} className="text-red-400 text-[11.5px] mt-1" role="alert">{error}</p>}
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
      {label && <label htmlFor={id} className="block text-zinc-400 text-[12px] font-semibold mb-1.5">{label}</label>}
      <textarea
        id={id}
        aria-label={label ? undefined : ariaLabel}
        aria-invalid={error ? true : undefined}
        aria-describedby={described}
        value={value}
        rows={rows}
        maxLength={maxLength}
        onChange={(e) => onChange(e.target.value)}
        className={`w-full rounded-xl bg-black/40 border px-3 py-2.5 text-white text-[13px] outline-none focus:border-gold/40 resize-none ${error ? 'border-red-400/60' : 'border-white/10'}`}
      />
      {(hint || maxLength) && (
        <div className="mt-1 flex items-start justify-between gap-2">
          {hint ? <p id={`${id}-hint`} className="text-text-muted text-[11.5px] leading-snug">{hint}</p> : <span />}
          <Counter id={`${id}-count`} length={value.length} max={maxLength} />
        </div>
      )}
      {error && <p id={`${id}-err`} className="text-red-400 text-[11.5px] mt-1" role="alert">{error}</p>}
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
        <span className="text-zinc-300 text-[12.5px] text-start">{label}</span>
        {/* ON is the accent track plus the thumb at the inline end — the
            design system's Switch (src/components/ui/Switch.tsx). The old ON
            track was --color-olive (#1B2010), next to black on a dark card:
            an open store and a paused one looked the same. */}
        <span
          aria-hidden="true"
          data-toggle={on ? 'on' : 'off'}
          className={`w-11 h-6 rounded-full shrink-0 relative border transition-colors ${on ? 'bg-accent border-transparent' : 'bg-white/10 border-border-subtle'}`}
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
  const style =
    kind === 'primary'
      ? 'bg-olive text-snow border-olive'
      : kind === 'gold'
        ? 'bg-gold/15 text-gold border-gold/30'
        : kind === 'danger'
          ? 'bg-red-500/10 text-red-300 border-red-500/30'
          : 'bg-white/[0.03] text-zinc-300 border-white/10';
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      aria-label={label}
      title={label}
      {...data}
      className={`${full ? 'w-full' : ''} ${label ? 'min-w-9 after:-inset-x-[5px]' : 'after:inset-x-0'} ${small ? "h-8 px-2.5 text-[11.5px] after:-inset-y-2" : "h-9 px-3.5 text-[12.5px] after:-inset-y-[5px]"} relative after:absolute after:content-[''] rounded-xl border font-bold inline-flex items-center justify-center gap-1.5 transition-colors disabled:opacity-40 active:scale-[0.98] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus ${style}`}
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
      className={`relative h-8 px-3 rounded-xl text-[11.5px] font-semibold border transition-colors disabled:opacity-40 after:absolute after:inset-x-0 after:-inset-y-2 after:content-[''] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus ${
        active ? 'bg-olive text-snow border-olive' : 'bg-white/[0.03] text-zinc-400 border-white/10'
      }`}
    >
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
      {label && <label htmlFor={id} className="block text-zinc-400 text-[12px] font-semibold mb-1.5">{label}</label>}
      <div className="flex flex-wrap gap-1.5 mb-2 empty:mb-0">
        {values.map((v) => (
          <span
            key={v}
            className="inline-flex items-center gap-1 h-7 ps-2.5 pe-1 rounded-lg bg-white/[0.05] border border-white/10 text-zinc-200 text-[11.5px]"
          >
            {v}
            <button
              type="button"
              onClick={() => onChange(values.filter((x) => x !== v))}
              className="relative w-5 h-5 rounded-md text-zinc-400 hover:text-red-300 after:absolute after:-inset-3 after:content-[''] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus"
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
          className="w-full h-10 rounded-xl bg-black/40 border border-white/10 px-3 text-white text-[13px] outline-none focus:border-gold/40"
        />
      )}
      {hint && <p className="text-text-muted text-[10.5px] mt-1">{hint}</p>}
    </div>
  );
}
