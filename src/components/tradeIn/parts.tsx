/**
 * The trade-in screens' own small pieces, all on the house clay (docs/DECISIONS.md rows 207–209):
 * a choice is `lv-choice` (pressed when chosen, one gold start bar), a field is `lv-input`, a card
 * is `lv-surface`, a button is `lv-button`, a refusal is a flat `lv-alert`. Every target is 44 px,
 * every focus ring visible; nothing here moves on its own.
 */
import React, { useCallback, useId, useLayoutEffect, useRef } from 'react';
import { Camera, Check, Loader2, X } from 'lucide-react';
import { useLanguage } from '../../LanguageContext';
import { failureText } from '../../lib/api';
import { apiRefusal } from '../../lib/refusalStrings';
import { useT } from './useT';
import type { PhotoView } from './model';

/** A server refusal in the reader's language (src/lib/refusalStrings.ts), else the fallback. */
export function useErrText() {
  const { lang } = useLanguage();
  const { t } = useT();
  return useCallback(
    (e: unknown, fallback?: string) => apiRefusal(e, lang === 'en' ? 'en' : lang === 'ckb' ? 'ckb' : 'ar') || failureText(e, fallback ?? t('genericError')),
    [lang, t]
  );
}

/**
 * Where an arrow key goes in a radio group (review F-31): Down / Right-in-LTR / Left-in-RTL move
 * on, Up and the other side move back, Home and End jump to the ends; it wraps. `current` −1 (focus
 * on no option) starts from the first. Null: not a key this group answers.
 */
export function radioStep(key: string, dir: 'rtl' | 'ltr', current: number, count: number): number | null {
  if (count <= 0) return null;
  if (key === 'Home') return 0;
  if (key === 'End') return count - 1;
  const step =
    key === 'ArrowDown' ? 1 : key === 'ArrowUp' ? -1 : key === 'ArrowRight' ? (dir === 'rtl' ? -1 : 1) : key === 'ArrowLeft' ? (dir === 'rtl' ? 1 : -1) : 0;
  if (!step) return null;
  if (current < 0) return 0;
  return (current + step + count) % count;
}

const radiosIn = (el: HTMLElement | null) => (el ? Array.from(el.querySelectorAll<HTMLButtonElement>('[role="radio"]')) : []);

/**
 * A RADIO GROUP THE KEYBOARD CAN WALK (review F-31): one Tab stop — the checked option, or the
 * first that can be chosen — and the arrow keys move AND choose, skipping disabled options. The
 * options stay the screen's own `role="radio"` buttons.
 */
export function RadioGroup({ children, className, ...rest }: React.HTMLAttributes<HTMLDivElement>) {
  const ref = useRef<HTMLDivElement>(null);
  const { dir } = useLanguage();
  useLayoutEffect(() => {
    const radios = radiosIn(ref.current);
    const stop = radios.find((r) => !r.disabled && r.getAttribute('aria-checked') === 'true') ?? radios.find((r) => !r.disabled);
    for (const r of radios) r.tabIndex = r === stop ? 0 : -1;
  });
  const onKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    const radios = radiosIn(ref.current).filter((r) => !r.disabled);
    const at = radioStep(e.key, dir === 'rtl' ? 'rtl' : 'ltr', radios.indexOf(document.activeElement as HTMLButtonElement), radios.length);
    if (at === null) return;
    e.preventDefault();
    radios[at].focus();
    radios[at].click();
  };
  return (
    <div ref={ref} role="radiogroup" onKeyDown={onKeyDown} className={className} {...rest}>
      {children}
    </div>
  );
}

/** One option of a small set: pressed when chosen (aria-pressed for a toggle, aria-checked inside a radiogroup). */
export function Choice({
  on,
  onClick,
  children,
  radio = false,
  disabled = false,
  className = '',
  ...data
}: {
  on: boolean;
  onClick: () => void;
  children: React.ReactNode;
  radio?: boolean;
  disabled?: boolean;
  className?: string;
} & Record<`data-${string}`, string | boolean | undefined>) {
  return (
    <button
      type="button"
      {...(radio ? { role: 'radio', 'aria-checked': on } : { 'aria-pressed': on })}
      disabled={disabled}
      onClick={onClick}
      className={`lv-choice inline-flex items-center justify-center gap-1.5 px-3.5 text-[13px] font-semibold disabled:opacity-50 ${className}`}
      {...data}
    >
      {on && !radio ? <Check className="w-3.5 h-3.5 shrink-0" aria-hidden /> : null}
      {children}
    </button>
  );
}

/** A refusal or a failure, flat and in words. */
export function ErrorLine({ children, id }: { children: React.ReactNode; id?: string }) {
  if (!children) return null;
  return (
    <p role="alert" id={id} className="lv-alert lv-alert-danger text-[13px] font-medium text-text-primary" data-trade-in-error>
      {children}
    </p>
  );
}

/**
 * «صوّر» — a photograph from the camera on a phone (`capture`), a file anywhere else. A label
 * around a hidden input: the house secondary button, with its focus ring on the label.
 */
export function PhotoButton({
  onFile,
  label,
  busy = false,
  disabled = false,
  testId,
  small = true,
}: {
  onFile: (file: File) => void;
  label: string;
  busy?: boolean;
  disabled?: boolean;
  testId?: string;
  small?: boolean;
}) {
  const id = useId();
  return (
    <label
      htmlFor={id}
      className={`lv-button lv-button-secondary ${small ? 'lv-button-sm' : ''} shrink-0 cursor-pointer focus-within:ring-2 focus-within:ring-focus ${disabled ? 'pointer-events-none opacity-50' : ''}`}
      aria-disabled={disabled || undefined}
    >
      {busy ? <Loader2 className="w-4 h-4 animate-spin motion-reduce:animate-none" aria-hidden /> : <Camera className="w-4 h-4" aria-hidden />}
      <span>{label}</span>
      <input
        id={id}
        type="file"
        accept="image/jpeg,image/png,image/webp"
        capture="environment"
        className="sr-only"
        disabled={disabled}
        data-upload={testId}
        onChange={(e) => {
          const f = e.target.files?.[0];
          e.target.value = '';
          if (f) onFile(f);
        }}
      />
    </label>
  );
}

/** A photograph already sent, with its remove button (44 px target on the corner). */
export function Thumb({ photo, onRemove, label }: { photo: PhotoView; onRemove?: () => void; label: string }) {
  const { t } = useT();
  return (
    <span className="relative inline-block h-16 w-16 shrink-0 overflow-hidden rounded-md lv-well" data-photo={photo.id}>
      <img src={photo.url} alt={label} className="h-full w-full object-cover" loading="lazy" decoding="async" />
      {onRemove ? (
        <button
          type="button"
          onClick={onRemove}
          aria-label={t('photo.remove')}
          className="lv-hit absolute top-0.5 end-0.5 flex h-7 w-7 items-center justify-center rounded-full bg-onyx/80 text-snow focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus"
        >
          <X className="w-3.5 h-3.5" aria-hidden />
        </button>
      ) : null}
    </span>
  );
}

/** An upload in flight: its share sent. */
export function Uploading({ fraction }: { fraction: number }) {
  const { t } = useT();
  return (
    <span className="inline-flex h-16 w-16 shrink-0 flex-col items-center justify-center gap-1 rounded-md lv-well text-[10.5px] tabular-nums text-text-secondary" role="status">
      <Loader2 className="w-4 h-4 animate-spin motion-reduce:animate-none text-gold" aria-hidden />
      <span aria-hidden>{Math.round(fraction * 100)}%</span>
      <span className="sr-only">{t('photo.uploading', { p: Math.round(fraction * 100) })}</span>
    </span>
  );
}
