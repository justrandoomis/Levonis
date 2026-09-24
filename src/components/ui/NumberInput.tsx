/**
 * NUMBERINPUT — money and quantities, typed on any keyboard in Iraq.
 *
 * `<input type="number">` is the wrong tool here, three ways: it rejects the
 * Arabic-Indic digits an Arabic or Kurdish keyboard types (١٢٬٠٠٠ reads as
 * empty), it changes the value under a scrolling wheel or trackpad, and it
 * cannot show a thousands separator, so «1200000» and «120000» look alike.
 *
 * This is a text field with `inputMode` set, so a phone still opens its digit
 * pad, and every keystroke is read by `parseLocaleNumber` (src/lib/
 * localeNumber.ts): ASCII, ٠-٩ and ۰-۹ digits, the separators people type.
 * At rest the figure is grouped («12,000»); while it is being edited it is
 * plain digits, so the caret never has to jump a comma.
 *
 * NOTHING TYPED IS SILENTLY CHANGED. A dinar amount with a fraction, a
 * negative stock count, a figure over `max` — the text stays exactly as typed,
 * the field says what is wrong next to itself (`aria-invalid`), and
 * `onValueChange` reports it as not valid so the caller cannot save it.
 * Rounding «12.5» to 13 would be the input deciding a price.
 *
 * A FIGURE IS AN LTR ISLAND: the digits run left to right in every language,
 * and sit flush with the start of the field in the page's own direction. The
 * unit («د.ع» / «IQD») sits at the inline end, outside the typed text.
 *
 * `kind="quantity"` adds − / + steppers (44px each, the cart's order and
 * labels) for the common one-more / one-fewer change.
 */
import React, { useEffect, useRef, useState } from 'react';
import { Minus, Plus } from 'lucide-react';
import { useLanguage } from '../../LanguageContext';
import { editableNumber, groupedNumber, parseLocaleNumber } from '../../lib/localeNumber';
import { iqdUnit } from '../../lib/money';
import { useFieldControl } from './Field';

export interface NumberInputProps
  extends Omit<React.ComponentPropsWithRef<'input'>, 'value' | 'defaultValue' | 'onChange' | 'type' | 'min' | 'max' | 'step'> {
  value: number | null;
  /** Every edit: the value (null when empty or unreadable) and whether it may be saved. */
  onValueChange: (value: number | null, valid: boolean) => void;
  /** `money`: whole dinars ≥ 0 with the dinar unit. `quantity`: whole units ≥ 0 with steppers. */
  kind?: 'money' | 'quantity' | 'number';
  /** Digits allowed after the decimal point. Money and quantities: 0. */
  decimals?: number;
  min?: number;
  max?: number;
  /** Stepper increment for `quantity`. */
  step?: number;
  /** Shown at the inline end; defaults to the dinar unit for money. */
  unit?: React.ReactNode;
}

export function NumberInput({
  value,
  onValueChange,
  kind = 'number',
  decimals: decimalsProp,
  min: minProp,
  max,
  step = 1,
  unit: unitProp,
  className = '',
  onFocus,
  onBlur,
  disabled,
  id: idProp,
  ...rest
}: NumberInputProps) {
  const { lang, loc, dir } = useLanguage();
  const field = useFieldControl();
  const decimals = decimalsProp ?? (kind === 'number' ? 2 : 0);
  const min = minProp ?? (kind === 'number' ? undefined : 0);
  const unit = unitProp ?? (kind === 'money' ? iqdUnit(lang) : undefined);
  const [focused, setFocused] = useState(false);
  const [text, setText] = useState(() => groupedNumber(value, decimals));
  const [problem, setProblem] = useState<string | null>(null);
  const lastReported = useRef<number | null>(value);

  // A value set from outside (a reset, a server answer) replaces what is shown
  // — but never under the fingers of someone typing.
  useEffect(() => {
    if (focused || value === lastReported.current) return;
    lastReported.current = value;
    setText(groupedNumber(value, decimals));
    setProblem(null);
  }, [value, focused, decimals]);

  const explain = (raw: string): { value: number | null; problem: string | null } => {
    const parsed = parseLocaleNumber(raw, decimals);
    if (!parsed.valid) {
      return {
        value: null,
        problem:
          kind === 'money'
            ? loc('المبلغ بالدينار العراقي عدد صحيح — لا كسور.', 'An amount in Iraqi dinars is a whole number — no fractions.', 'بڕ بە دیناری عێراقی ژمارەیەکی تەواوە — بەبێ بەش.')
            : decimals === 0
              ? // OWNER: Sorani to be written by hand.
                loc('اكتب عددًا صحيحًا.', 'Enter a whole number.')
              : // OWNER: Sorani to be written by hand.
                loc('اكتب رقمًا.', 'Enter a number.'),
      };
    }
    const n = parsed.value;
    if (n !== null && ((min !== undefined && n < min) || (max !== undefined && n > max))) {
      const lo = min !== undefined ? groupedNumber(min, decimals) : null;
      const hi = max !== undefined ? groupedNumber(max, decimals) : null;
      return {
        value: n,
        problem:
          lo !== null && hi !== null
            ? // OWNER: Sorani to be written by hand.
              loc(`بين ${lo} و${hi}.`, `Between ${lo} and ${hi}.`)
            : lo !== null
              ? // OWNER: Sorani to be written by hand.
                loc(`لا يقل عن ${lo}.`, `At least ${lo}.`)
              : // OWNER: Sorani to be written by hand.
                loc(`لا يزيد على ${hi}.`, `At most ${hi}.`),
      };
    }
    return { value: n, problem: null };
  };

  const commit = (raw: string) => {
    const next = explain(raw);
    setProblem(next.problem);
    const valid = next.problem === null;
    lastReported.current = valid ? next.value : null;
    onValueChange(valid ? next.value : null, valid);
  };

  const stepBy = (delta: number) => {
    const base = value ?? min ?? 0;
    let next = base + delta * step;
    if (min !== undefined) next = Math.max(min, next);
    if (max !== undefined) next = Math.min(max, next);
    setText(focused ? editableNumber(next) : groupedNumber(next, decimals));
    commit(String(next));
  };

  const auto = React.useId();
  const id = idProp ?? field?.id ?? `number-${auto}`;
  const ownErrorId = problem && !field?.invalid ? `${id}-problem` : undefined;
  const describedBy = [rest['aria-describedby'], field?.describedBy, ownErrorId].filter(Boolean).join(' ') || undefined;
  const invalid = !!problem || !!field?.invalid;

  const input = (
    <div className="relative min-w-0 flex-1">
      <input
        {...rest}
        id={id}
        type="text"
        inputMode={decimals > 0 ? 'decimal' : 'numeric'}
        autoComplete="off"
        spellCheck={false}
        dir="ltr"
        disabled={disabled}
        required={rest.required ?? (field?.required || undefined)}
        aria-invalid={invalid || undefined}
        aria-describedby={describedBy}
        value={text}
        onChange={(e) => {
          setText(e.currentTarget.value);
          commit(e.currentTarget.value);
        }}
        onFocus={(e) => {
          setFocused(true);
          if (!problem) setText(editableNumber(value));
          onFocus?.(e);
        }}
        onBlur={(e) => {
          setFocused(false);
          if (!problem) setText(groupedNumber(value, decimals));
          onBlur?.(e);
        }}
        style={{ textAlign: dir === 'rtl' ? 'right' : 'left' }}
        className={`lv-input tabular-nums ${unit ? 'pe-14' : ''} ${className}`}
      />
      {unit && (
        <span
          aria-hidden="true"
          className="pointer-events-none absolute end-3 top-1/2 -translate-y-1/2 text-[13px] text-text-muted"
        >
          {unit}
        </span>
      )}
    </div>
  );

  return (
    <div className="min-w-0">
      {kind === 'quantity' ? (
        <div className="flex items-stretch gap-2">
          <button
            type="button"
            onClick={() => stepBy(-1)}
            disabled={disabled || (min !== undefined && value !== null && value <= min)}
            aria-label={loc('إنقاص الكمية', 'Decrease quantity', 'کەمکردنەوەی بڕ')}
            aria-controls={id}
            className="lv-button lv-button-secondary w-11 shrink-0 px-0"
          >
            <Minus aria-hidden="true" className="h-4 w-4" />
          </button>
          {input}
          <button
            type="button"
            onClick={() => stepBy(1)}
            disabled={disabled || (max !== undefined && value !== null && value >= max)}
            aria-label={loc('زيادة الكمية', 'Increase quantity', 'زیادکردنی بڕ')}
            aria-controls={id}
            className="lv-button lv-button-secondary w-11 shrink-0 px-0"
          >
            <Plus aria-hidden="true" className="h-4 w-4" />
          </button>
        </div>
      ) : (
        input
      )}
      {ownErrorId && (
        <p id={ownErrorId} className="lv-field-error">
          {problem}
        </p>
      )}
    </div>
  );
}
