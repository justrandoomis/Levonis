/**
 * Shared primitives of the merchant dashboard.
 *
 * One density scale for every tab — inputs 40px, buttons 36px, one card
 * shape — so the panel reads as one instrument rather than eight screens
 * that happen to share a URL. Everything here is presentation; nothing
 * decides permissions (the server's `can`/`selling` answers do).
 */

import { AlertCircle, Loader2 } from 'lucide-react';
import { useStore } from '../../../StoreContext';

export type Loc = (ar: string, en: string, ckb?: string) => string;

/**
 * A path on the MAIN site, from wherever the dashboard is rendered.
 * On `/merchant` the path is relative; on a store subdomain's `/admin` the
 * main site is another origin, so the canonical apex carries the link (the
 * shared cookie keeps the session).
 */
export function useMainSiteHref(): (path: string) => string {
  const { store } = useStore();
  return (path: string) => (store ? `https://levonis-iq.com${path}` : path);
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
      {hint && <p className="text-zinc-600 text-[11.5px] mt-1.5">{hint}</p>}
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
      <p className="text-zinc-500 text-[10.5px] mb-0.5 truncate">{label}</p>
      <p
        className={`font-bold truncate ${small ? 'text-[12.5px]' : 'text-[14px]'} ${accent ? 'text-gold' : 'text-white'}`}
        dir="ltr"
      >
        {value}
      </p>
    </div>
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
}: {
  label?: string;
  value: string;
  onChange: (v: string) => void;
  type?: string;
  placeholder?: string;
  hint?: string;
  ltr?: boolean;
}) {
  return (
    <div className="min-w-0">
      {label && <label className="block text-zinc-400 text-[12px] font-semibold mb-1.5">{label}</label>}
      <input
        type={type}
        value={value}
        placeholder={placeholder}
        dir={ltr ? 'ltr' : undefined}
        onChange={(e) => onChange(e.target.value)}
        className="w-full h-10 rounded-xl bg-black/40 border border-white/10 px-3 text-white text-[13px] outline-none focus:border-gold/40 transition-colors"
      />
      {hint && <p className="text-zinc-600 text-[10.5px] mt-1">{hint}</p>}
    </div>
  );
}

export function TextArea({
  label,
  value,
  onChange,
  rows = 3,
  hint,
}: {
  label?: string;
  value: string;
  onChange: (v: string) => void;
  rows?: number;
  hint?: string;
}) {
  return (
    <div>
      {label && <label className="block text-zinc-400 text-[12px] font-semibold mb-1.5">{label}</label>}
      <textarea
        value={value}
        rows={rows}
        onChange={(e) => onChange(e.target.value)}
        className="w-full rounded-xl bg-black/40 border border-white/10 px-3 py-2.5 text-white text-[13px] outline-none focus:border-gold/40 resize-none"
      />
      {hint && <p className="text-zinc-600 text-[10.5px] mt-1">{hint}</p>}
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
        onClick={() => !disabled && onChange(!on)}
        disabled={disabled}
        className="w-full flex items-center justify-between gap-3 min-h-9 disabled:opacity-60"
      >
        <span className="text-zinc-300 text-[12.5px] text-start">{label}</span>
        <span className={`w-10 h-[22px] rounded-full shrink-0 relative transition-colors ${on ? 'bg-olive' : 'bg-white/10'}`}>
          <span
            className={`absolute top-[2px] w-[18px] h-[18px] rounded-full bg-white transition-all ${on ? 'start-[20px]' : 'start-[2px]'}`}
          />
        </span>
      </button>
      {hint && <p className="text-zinc-600 text-[10.5px] mt-0.5">{hint}</p>}
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
}: {
  children: React.ReactNode;
  onClick?: () => void;
  kind?: 'primary' | 'ghost' | 'danger' | 'gold';
  disabled?: boolean;
  full?: boolean;
  small?: boolean;
}) {
  const style =
    kind === 'primary'
      ? 'bg-olive text-white border-olive'
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
      className={`${full ? 'w-full' : ''} ${small ? 'h-8 px-2.5 text-[11.5px]' : 'h-9 px-3.5 text-[12.5px]'} rounded-xl border font-bold inline-flex items-center justify-center gap-1.5 transition-colors disabled:opacity-40 active:scale-[0.98] ${style}`}
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
      className={`h-8 px-3 rounded-xl text-[11.5px] font-semibold border transition-colors disabled:opacity-40 ${
        active ? 'bg-olive text-white border-olive' : 'bg-white/[0.03] text-zinc-400 border-white/10'
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
  return (
    <div>
      {label && <label className="block text-zinc-400 text-[12px] font-semibold mb-1.5">{label}</label>}
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
              className="w-5 h-5 rounded-md text-zinc-500 hover:text-red-300"
              aria-label="remove"
            >
              ×
            </button>
          </span>
        ))}
      </div>
      {values.length < max && (
        <input
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
      {hint && <p className="text-zinc-600 text-[10.5px] mt-1">{hint}</p>}
    </div>
  );
}
