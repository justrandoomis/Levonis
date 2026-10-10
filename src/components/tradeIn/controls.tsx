/**
 * The trade-in wizard's own controls — each one a question a customer can
 * answer with a thumb, standing at a printer, on a phone.
 *
 *   ScalePicker  1..5 as five equal segments, with the chosen level's sentence
 *                under it: a bare "3" means nothing, «آثار استخدام عادية» does.
 *   Stepper      whole numbers only (hours, repairs), with − / + at 44px and a
 *                field for typing a large figure off the printer's screen.
 *   Checklist    faults and replaced parts as toggle chips (aria-pressed).
 *   Breakdown    the valuation's lines, top to bottom, adding up — «شفاف».
 *
 * OWNER: Sorani to be written by hand (every loc() in this file without a
 * third argument).
 */
import React from 'react';
import { Minus, Plus, Check } from 'lucide-react';
import { useLanguage } from '../../LanguageContext';
import { Money } from '../ui/Money';
import type { ComponentValuation, TradeInSettlement } from './model';

export function Card({ children, className = '', ...rest }: React.HTMLAttributes<HTMLDivElement>) {
  return (
    <div {...rest} className={`lv-surface p-4 ${className}`}>
      {children}
    </div>
  );
}

export function SectionTitle({ title, hint }: { title: string; hint?: string }) {
  return (
    <div className="mb-3">
      <h3 className="text-text-primary text-[15px] font-bold leading-6">{title}</h3>
      {hint ? <p className="text-[12.5px] leading-5 text-text-muted">{hint}</p> : null}
    </div>
  );
}

export function FactRow({ label, value, strong = false }: { label: string; value: React.ReactNode; strong?: boolean }) {
  return (
    <div className="flex items-baseline justify-between gap-3 py-2 border-b border-border-subtle last:border-b-0">
      <dt className="text-[13px] text-text-secondary shrink-0">{label}</dt>
      <dd className={`text-[13.5px] text-end min-w-0 ${strong ? 'text-text-primary font-bold' : 'text-text-primary'}`}>{value}</dd>
    </div>
  );
}

export function ScalePicker({
  label,
  value,
  onChange,
  descriptions,
  name,
}: {
  label: string;
  value: number;
  onChange: (v: 1 | 2 | 3 | 4 | 5) => void;
  /** Index 0 = score 1 (worst) … index 4 = score 5 (like new). */
  descriptions: [string, string, string, string, string];
  name: string;
}) {
  const { loc } = useLanguage();
  return (
    <fieldset className="min-w-0" data-scale={name}>
      <legend className="text-[13.5px] font-semibold text-text-primary mb-2">{label}</legend>
      <div role="radiogroup" aria-label={label} className="grid grid-cols-5 gap-1.5 rounded-lg lv-well p-1 border border-border-subtle">
        {[1, 2, 3, 4, 5].map((n) => {
          const on = value === n;
          return (
            <button
              key={n}
              type="button"
              role="radio"
              aria-checked={on}
              aria-label={`${n} — ${descriptions[n - 1]}`}
              onClick={() => onChange(n as 1 | 2 | 3 | 4 | 5)}
              className={`min-h-[44px] rounded-md border text-[15px] font-bold tabular-nums transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus ${
                on ? 'border-border-subtle bg-surface-raised text-text-primary shadow-1' : 'border-transparent text-text-secondary hover:text-text-primary'
              }`}
            >
              {n}
            </button>
          );
        })}
      </div>
      <div className="mt-1.5 flex items-center justify-between text-[11px] text-text-muted">
        <span>{loc('سيئة', 'Poor')}</span>
        <span className="text-[12.5px] text-text-primary font-semibold text-center px-2" aria-live="polite">
          {descriptions[value - 1]}
        </span>
        <span>{loc('كالجديد', 'Like new')}</span>
      </div>
    </fieldset>
  );
}

export function Stepper({
  label,
  value,
  onChange,
  step = 1,
  max,
  hint,
  unit,
  name,
}: {
  label: string;
  value: number;
  onChange: (v: number) => void;
  step?: number;
  max: number;
  hint?: string;
  unit?: string;
  name: string;
}) {
  const { loc } = useLanguage();
  const set = (v: number) => onChange(Math.max(0, Math.min(max, Math.round(v))));
  const btn =
    'lv-button lv-button-secondary h-11 w-11 shrink-0 px-0';
  return (
    <div className="min-w-0" data-stepper={name}>
      <label htmlFor={`st-${name}`} className="block text-[13.5px] font-semibold text-text-primary mb-2">
        {label}
      </label>
      <div className="flex items-center gap-2">
        <button type="button" className={btn} onClick={() => set(value - step)} disabled={value <= 0} aria-label={loc('إنقاص', 'Decrease')}>
          <Minus className="w-4 h-4" aria-hidden />
        </button>
        <div className="relative flex-1 min-w-0">
          <input
            className="lv-input min-h-11 h-11 text-center text-lg font-bold tabular-nums"
            id={`st-${name}`}
            inputMode="numeric"
            pattern="[0-9]*"
            value={String(value)}
            onChange={(e) => {
              const digits = e.target.value.replace(/[^0-9٠-٩]/g, '').replace(/[٠-٩]/g, (d) => String('٠١٢٣٤٥٦٧٨٩'.indexOf(d)));
              set(digits ? Number(digits) : 0);
            }}
            dir="ltr"
          />
          {unit ? <span className="pointer-events-none absolute inset-y-0 end-3 flex items-center text-[12px] text-text-muted">{unit}</span> : null}
        </div>
        <button type="button" className={btn} onClick={() => set(value + step)} disabled={value >= max} aria-label={loc('زيادة', 'Increase')}>
          <Plus className="w-4 h-4" aria-hidden />
        </button>
      </div>
      {hint ? <p className="mt-1.5 text-[12px] leading-5 text-text-muted">{hint}</p> : null}
    </div>
  );
}

export function Checklist({
  label,
  items,
  selected,
  onToggle,
  name,
  emptyLabel,
}: {
  label: string;
  items: Array<{ id: string; label: string }>;
  selected: string[];
  onToggle: (id: string) => void;
  name: string;
  /** The positive answer, drawn as the first chip — «لا توجد مشاكل». */
  emptyLabel: string;
}) {
  const none = selected.length === 0;
  const chip = (on: boolean) =>
    `inline-flex items-center gap-1.5 min-h-[40px] px-3.5 rounded-full border border-border-subtle text-[13px] font-semibold transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus ${
      on ? 'bg-[var(--clay-well-bg)] shadow-press text-text-primary' : 'bg-surface-raised shadow-xs text-text-secondary hover:text-text-primary'
    }`;
  return (
    <fieldset className="min-w-0" data-checklist={name}>
      <legend className="text-[13.5px] font-semibold text-text-primary mb-2">{label}</legend>
      <div className="flex flex-wrap gap-2">
        <button type="button" aria-pressed={none} className={chip(none)} onClick={() => selected.forEach(onToggle)}>
          {none ? <Check className="w-3.5 h-3.5" aria-hidden /> : null}
          {emptyLabel}
        </button>
        {items.map((it) => {
          const on = selected.includes(it.id);
          return (
            <button key={it.id} type="button" aria-pressed={on} className={chip(on)} onClick={() => onToggle(it.id)} data-item={it.id}>
              {on ? <Check className="w-3.5 h-3.5" aria-hidden /> : null}
              {it.label}
            </button>
          );
        })}
      </div>
    </fieldset>
  );
}

export function ChoicePills<T extends string>({
  label,
  options,
  value,
  onChange,
  name,
}: {
  label: string;
  options: Array<{ id: T; label: string }>;
  value: T;
  onChange: (v: T) => void;
  name: string;
}) {
  return (
    <fieldset className="min-w-0" data-choice={name}>
      <legend className="text-[13.5px] font-semibold text-text-primary mb-2">{label}</legend>
      <div role="radiogroup" aria-label={label} className="grid grid-cols-3 gap-1.5 rounded-lg lv-well p-1 border border-border-subtle">
        {options.map((o) => {
          const on = o.id === value;
          return (
            <button
              key={o.id}
              type="button"
              role="radio"
              aria-checked={on}
              onClick={() => onChange(o.id)}
              className={`min-h-[44px] rounded-md border px-2 text-[12.5px] font-bold leading-4 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus ${
                on ? 'border-border-subtle bg-surface-raised text-text-primary shadow-1' : 'border-transparent text-text-secondary hover:text-text-primary'
              }`}
            >
              {o.label}
            </button>
          );
        })}
      </div>
    </fieldset>
  );
}

export function TextArea({ label, value, onChange, name, placeholder }: { label: string; value: string; onChange: (v: string) => void; name: string; placeholder?: string }) {
  return (
    <div className="min-w-0">
      <label htmlFor={`ta-${name}`} className="block text-[13.5px] font-semibold text-text-primary mb-2">
        {label}
      </label>
      <textarea
        className="lv-input px-3 py-2.5 text-[14px] leading-6 resize-y"
        id={`ta-${name}`}
        value={value}
        maxLength={1000}
        rows={3}
        placeholder={placeholder}
        onChange={(e) => onChange(e.target.value)}
      />
    </div>
  );
}

/** Signed basis points as a percent: −1,500 → «−15%». */
export function bpText(bp: number): string {
  const v = Math.abs(bp) / 100;
  const s = Number.isInteger(v) ? String(v) : v.toFixed(1);
  return `${bp > 0 ? '+' : bp < 0 ? '−' : ''}${s}%`;
}

export function Breakdown({ valuation, title }: { valuation: ComponentValuation; title?: string }) {
  const { loc } = useLanguage();
  return (
    <div data-breakdown>
      {title ? <p className="text-[13px] font-bold text-text-primary mb-1">{title}</p> : null}
      <dl>
        {valuation.lines.map((l, i) => (
          <div key={`${l.factor}-${i}`} className={`flex items-baseline justify-between gap-3 py-1.5 ${i === 0 ? '' : 'border-t border-border-subtle'}`}>
            <dt className={`text-[12.5px] min-w-0 ${i === 0 ? 'text-text-primary font-semibold' : 'text-text-secondary'}`}>
              {loc(l.label_ar, l.label_en)}
              {l.effect_bp !== 0 ? <span className="ms-1.5 text-[11px] text-text-muted tabular-nums" dir="ltr">{bpText(l.effect_bp)}</span> : null}
            </dt>
            <dd className={`text-[12.5px] shrink-0 ${i === 0 ? 'text-text-primary font-semibold' : l.amount_iqd < 0 ? 'text-rose-300' : 'text-emerald-300'}`}>
              <Money iqd={l.amount_iqd} signed={i !== 0} />
            </dd>
          </div>
        ))}
        <div className="flex items-baseline justify-between gap-3 pt-2 mt-1 border-t border-border-subtle">
          <dt className="text-[13px] text-text-primary font-bold">{loc('القيمة', 'Value')}</dt>
          <dd className="text-[14px] text-text-primary font-black">
            <Money iqd={valuation.value_iqd} />
          </dd>
        </div>
      </dl>
    </div>
  );
}

export function SettlementRows({ s }: { s: TradeInSettlement }) {
  const { loc } = useLanguage();
  return (
    <dl data-settlement>
      <FactRow label={loc('سعر الجهاز الجديد (بيع مباشر)', 'New device (direct sale)')} value={<Money iqd={s.target_price_iqd} />} />
      <FactRow label={loc('قيمة جهازك', 'Your device')} value={<Money iqd={-s.credit_iqd} signed />} />
      <FactRow label={loc('المطلوب دفعه', 'You pay')} value={<Money iqd={s.difference_iqd} />} strong />
    </dl>
  );
}
