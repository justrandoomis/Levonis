/**
 * PRICING V2 IN THE PRODUCT FORM — THE SMALL PIECES SECTIONS ٣ AND ٥ SHARE
 * (implementation spec §5.2; docs/PRICING-V2.md §2.1–§2.5).
 *
 * The incumbent form's clay, nothing new: a dollar field is the form's own
 * `lv-input` well (dir="ltr", 40px), a read-out is an `lv-well`, a status is
 * an `lv-chip`, a choice is the form's own select. Every figure shown is the
 * server's answer; nothing here computes a price.
 */
import { useId, type ReactNode } from 'react';
import { useOptionalLanguage } from '../../../../LanguageContext';
import { PRICING_CHANNEL_LABELS } from '../../../../../packages/contracts/src/pricingFieldLabels';
import { TextInput } from '../formUi';
import type { V2Channel, V2Lang } from './v2Model';
import { typingUsd } from './usdTyping';
import { v2Strings, type V2Strings } from './v2Strings';

/** The reader's language, narrowed to the three the pricing strings carry. */
export function useV2Lang(): V2Lang {
  const lang = useOptionalLanguage();
  return lang === 'en' ? 'en' : lang === 'ckb' ? 'ckb' : 'ar';
}

/** The strings of the reader's language. */
export function useV2Strings(): V2Strings {
  return v2Strings(useV2Lang());
}

/** A channel's name in the reader's language (the pricing screens' own words). */
export const channelName = (ch: V2Channel, lang: V2Lang): string => PRICING_CHANNEL_LABELS[ch][lang];

/**
 * A dollar amount as typed: digits, one dot, two decimals (and, `signed`, one
 * sign). The «$» sits outside the value, so a screen reader and a copy-paste
 * read the number alone.
 */
export function UsdInput({
  value,
  onChange,
  signed = false,
  id,
  label,
  placeholder,
  disabled,
  data,
}: {
  value: string;
  onChange: (next: string) => void;
  signed?: boolean;
  id?: string;
  /** The accessible name when no visible label points at the input. */
  label?: string;
  placeholder?: string;
  disabled?: boolean;
  /** A `data-v2-field` handle for tests and section jumps. */
  data?: string;
}) {
  return (
    <div className="flex min-w-0 items-center gap-1.5" dir="ltr">
      <span className="shrink-0 text-[13px] font-bold text-text-muted" aria-hidden="true">
        $
      </span>
      <TextInput
        id={id}
        inputMode="decimal"
        autoComplete="off"
        value={value}
        placeholder={placeholder}
        disabled={disabled}
        aria-label={label}
        data-v2-field={data}
        onChange={(e) => onChange(typingUsd(e.target.value, signed))}
      />
    </div>
  );
}

/** A labelled read-out: a sunk well holding a figure the server stated. */
export function Readout({ label, value, sub, tone, data }: { label: string; value: ReactNode; sub?: ReactNode; tone?: 'muted' | 'warn'; data?: string }) {
  return (
    <div className="lv-well min-w-0 rounded-md px-2.5 py-2" data-v2-readout={data}>
      <div className="truncate text-[10px] font-bold text-text-muted">{label}</div>
      <div className={`truncate text-[13px] font-black tabular-nums ${tone === 'warn' ? 'text-amber-300' : tone === 'muted' ? 'text-text-secondary' : 'text-text-primary'}`} dir="ltr">
        {value}
      </div>
      {sub ? <div className="truncate text-[10px] text-text-muted">{sub}</div> : null}
    </div>
  );
}

/** A small status chip (information, flat): `tone` picks the semantic colour. */
export function Chip({ tone, children, data }: { tone: 'success' | 'warning' | 'danger' | 'info' | 'muted'; children: ReactNode; data?: string }) {
  const chip =
    tone === 'success'
      ? '[--chip:var(--color-success)]'
      : tone === 'warning'
        ? '[--chip:var(--color-warning)]'
        : tone === 'danger'
          ? '[--chip:var(--color-danger)]'
          : tone === 'info'
            ? '[--chip:var(--color-info)]'
            : '[--chip:var(--color-text-secondary)]';
  return (
    <span className={`lv-chip ${chip} inline-flex min-w-0 max-w-full items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-bold`} data-v2-chip={data}>
      <span aria-hidden="true">●</span>
      <span className="min-w-0 truncate">{children}</span>
    </span>
  );
}

/** A labelled control whose label is wired to it by id (the form's own label look). */
export function V2Field({ label, children, hint }: { label: string; children: (id: string) => ReactNode; hint?: ReactNode }) {
  const id = useId();
  return (
    <div className="min-w-0">
      <label htmlFor={id} className="mb-1 block truncate text-[12px] font-bold text-text-secondary">
        {label}
      </label>
      {children(id)}
      {hint ? <div className="mt-1 text-[10px] text-text-muted">{hint}</div> : null}
    </div>
  );
}
