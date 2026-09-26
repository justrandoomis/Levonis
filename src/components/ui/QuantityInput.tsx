/**
 * QUANTITYINPUT — − [number] +, where the number is typed.
 *
 * «حتى مثلا إذا أراد ١٠٠٠ قطعة من الميدالية لا يبقى يضغط على زيادة ++++، بل
 *  يضغط على الرقم ويكتب الكمية التي يريدها.» — the owner.
 *
 * THE ONE QUANTITY CONTROL of every buying surface: the product page (panel
 * and phone bar), the cart line, a bundle, a store's product page and the
 * store cart. The rules live in packages/pricing/src/quantity.ts, not here:
 *
 *   · The number is a real text field (`inputMode="numeric"`, so a phone opens
 *     its digit pad). Tapping it selects the whole figure, so typing replaces
 *     it. ١٢٣ / ۱۲۳ / a pasted «1,000» all read as digits; anything else is
 *     dropped as it is typed.
 *   · It COMMITS ONCE — on blur, Enter or the keyboard's «Done» — never per
 *     keystroke, so a cart line sends one request for «250», not three.
 *     Escape puts back what was there.
 *   · Above `max` the figure BECOMES `max` and a quiet line says why
 *     («الحد الأقصى المتوفر: 1,000»), announced politely to a screen reader.
 *     Never a dialog, never a red error: the owner asked for the quantity to be
 *     set, not for the buyer to be told no. Empty goes back; 0 becomes 1.
 *   · `max` is the SERVER's ceiling for the selection (`quantityLimit`), and
 *     `limitKind` says whose it is — the shelf, the pre-order quota, or the
 *     per-line ceiling — so the sentence is true.
 *
 * GEOMETRY. Both steppers are 44×44. The number cell has a FIXED width that
 * holds six digits, so 1 → 100,000 moves nothing around it. The hint is an
 * overlay bubble, not a row: showing it never pushes the price or the button.
 * Holding − or + repeats (after 400 ms), for the buyer who still prefers it.
 */
import React, { useCallback, useEffect, useId, useRef, useState } from 'react';
import { Minus, Plus } from 'lucide-react';
import { useLanguage } from '../../LanguageContext';
import { groupedNumber } from '../../lib/localeNumber';
import {
  clampQuantity,
  resolveQuantityDraft,
  sanitizeQuantityDraft,
  type QuantityLimitKind,
} from '../../../packages/pricing/src/quantity';

export interface QuantityInputProps {
  value: number;
  /**
   * A new quantity. `how` says where it came from: a − / + press (or a held
   * one), a typed figure, or the control lowering itself because `max` fell
   * under it (`autoClamp`).
   */
  onChange: (next: number, how: 'step' | 'type' | 'clamp') => void;
  /** The server's ceiling for this selection. */
  max: number;
  /** Whose ceiling it is — decides the hint's sentence. */
  limitKind?: QuantityLimitKind;
  min?: number;
  disabled?: boolean;
  /** `md`: a panel row. `sm`: a bar or a cart line (a narrower number cell). */
  size?: 'md' | 'sm';
  /**
   * Where the hint bubble opens. A bottom bar wants `above`; a labelled row
   * whose free space is between its label and the control wants `start` (the
   * bubble sits on the control's inline-start side, covering nothing).
   */
  hintPlacement?: 'above' | 'below' | 'start';
  /**
   * Lower the value on its own when `max` drops beneath it (a sale-type or
   * option change on a page holding local state). Off for a saved cart line:
   * that would write to the server without the buyer doing anything.
   */
  autoClamp?: boolean;
  /** Accessible name of the number; defaults to «الكمية». */
  label?: string;
  className?: string;
  /** Test hook on the wrapper. */
  'data-testid'?: string;
}

const HINT_MS = 4500;
const HOLD_DELAY_MS = 400;
const HOLD_EVERY_MS = 90;

export function QuantityInput({
  value,
  onChange,
  max,
  limitKind = 'stock',
  min = 1,
  disabled = false,
  size = 'md',
  hintPlacement = 'below',
  autoClamp = false,
  label,
  className = '',
  'data-testid': testId,
}: QuantityInputProps) {
  const { loc } = useLanguage();
  const id = useId();
  const hintId = `${id}-hint`;
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState('');
  const [hint, setHint] = useState<string | null>(null);
  const hintTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);
  /** A keystroke landed since focus — the deferred select-all must not eat it. */
  const typedRef = useRef(false);
  // The held-button repeat reads the value through a ref: the interval was
  // created with the value of the first press.
  const valueRef = useRef(value);
  valueRef.current = value;
  const ceiling = Math.max(min, Math.trunc(max) || min);

  const hintText = useCallback(
    (n: number): string => {
      const shown = groupedNumber(n);
      if (limitKind === 'per_order') {
        return loc(`الحد الأقصى للطلب الواحد: ${shown}`, `Maximum per order: ${shown}`, `زۆرترین ${shown} بۆ هەر داواکارییەک`);
      }
      if (limitKind === 'preorder_quota') {
        // OWNER: Sorani to be written by hand.
        return loc(`المتبقي من حصة الطلب المسبق: ${shown}`, `Pre-order quota left: ${shown}`);
      }
      // OWNER: Sorani to be written by hand.
      return loc(`الحد الأقصى المتوفر: ${shown}`, `Maximum available: ${shown}`);
    },
    [limitKind, loc]
  );

  const showHint = useCallback(
    (n: number) => {
      setHint(hintText(n));
      if (hintTimer.current) clearTimeout(hintTimer.current);
      hintTimer.current = setTimeout(() => setHint(null), HINT_MS);
    },
    [hintText]
  );
  useEffect(() => () => {
    if (hintTimer.current) clearTimeout(hintTimer.current);
  }, []);

  // A ceiling that fell under the value (a sale type switched, an option with
  // a smaller shelf was picked) re-applies the rule — only where the caller
  // holds the value locally.
  useEffect(() => {
    if (!autoClamp || disabled || value <= ceiling || ceiling < min) return;
    onChange(ceiling, 'clamp');
    showHint(ceiling);
  }, [autoClamp, disabled, value, ceiling, min, onChange, showHint]);

  const step = useCallback(
    (delta: number) => {
      const next = clampQuantity(valueRef.current + delta, ceiling, min);
      if (next.value === valueRef.current) return false;
      valueRef.current = next.value;
      setHint(null);
      onChange(next.value, 'step');
      return true;
    },
    [ceiling, min, onChange]
  );

  const commit = (text: string) => {
    const r = resolveQuantityDraft(text, { max: ceiling, min, previous: value });
    setEditing(false);
    if (r.capped) showHint(r.value);
    else setHint(null);
    if (r.value !== value) onChange(r.value, 'type');
  };

  // ---- hold to repeat
  const hold = useRef<{ delay: ReturnType<typeof setTimeout> | null; every: ReturnType<typeof setInterval> | null; fired: boolean }>({
    delay: null,
    every: null,
    fired: false,
  });
  const stopHold = useCallback(() => {
    if (hold.current.delay) clearTimeout(hold.current.delay);
    if (hold.current.every) clearInterval(hold.current.every);
    hold.current.delay = null;
    hold.current.every = null;
  }, []);
  useEffect(() => stopHold, [stopHold]);
  const startHold = (delta: number) => (e: React.PointerEvent<HTMLButtonElement>) => {
    if (e.button !== 0) return;
    stopHold();
    hold.current.fired = false;
    hold.current.delay = setTimeout(() => {
      hold.current.every = setInterval(() => {
        hold.current.fired = true;
        if (!step(delta)) stopHold();
      }, HOLD_EVERY_MS);
    }, HOLD_DELAY_MS);
  };
  const clickStep = (delta: number) => () => {
    // The click that ends a hold is not one more step.
    if (hold.current.fired) {
      hold.current.fired = false;
      return;
    }
    step(delta);
  };

  const atMin = value <= min;
  const atMax = value >= ceiling;
  const name = label ?? loc('الكمية', 'Quantity', 'بڕ');
  const numberWidth = size === 'sm' ? 'w-14 text-[15px]' : 'w-[4.5rem] text-[16px]';
  const btn =
    'flex h-11 w-11 shrink-0 items-center justify-center text-text-secondary transition-colors [touch-action:manipulation] ' +
    'hover:bg-surface-raised active:bg-surface-selected disabled:opacity-35 disabled:hover:bg-transparent ' +
    'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-focus';

  return (
    <div className={`relative inline-flex ${className}`} data-testid={testId} data-quantity-input>
      <div
        className={`inline-flex items-stretch overflow-hidden rounded-xl border border-border-subtle bg-surface ${
          disabled ? 'opacity-60' : ''
        }`}
      >
        <button
          type="button"
          aria-label={loc('إنقاص الكمية', 'Decrease quantity', 'کەمکردنەوەی بڕ')}
          data-mascot="qty-dec"
          disabled={disabled || atMin}
          onClick={clickStep(-1)}
          onPointerDown={startHold(-1)}
          onPointerUp={stopHold}
          onPointerLeave={stopHold}
          onPointerCancel={stopHold}
          onContextMenu={(e) => e.preventDefault()}
          className={btn}
        >
          <Minus aria-hidden="true" className="h-4 w-4" />
        </button>
        <input
          ref={inputRef}
          type="text"
          inputMode="numeric"
          pattern="[0-9]*"
          enterKeyHint="done"
          autoComplete="off"
          autoCorrect="off"
          spellCheck={false}
          dir="ltr"
          role="spinbutton"
          aria-label={name}
          aria-valuenow={value}
          aria-valuemin={min}
          aria-valuemax={ceiling}
          aria-describedby={hint ? hintId : undefined}
          data-mascot="quantity"
          disabled={disabled}
          value={editing ? draft : groupedNumber(value)}
          onFocus={(e) => {
            setEditing(true);
            setDraft(String(value));
            const el = e.currentTarget;
            typedRef.current = false;
            // After the browser has placed its own caret (Safari moves it on
            // mouseup), select the whole figure so typing replaces it — unless
            // typing already began in that frame (it would be selected away).
            requestAnimationFrame(() => {
              if (document.activeElement === el && !typedRef.current) el.select();
            });
          }}
          onChange={(e) => {
            typedRef.current = true;
            setDraft(sanitizeQuantityDraft(e.currentTarget.value));
          }}
          onBlur={(e) => commit(e.currentTarget.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              e.currentTarget.blur();
            } else if (e.key === 'Escape') {
              e.preventDefault();
              setDraft(String(value));
              setEditing(false);
              requestAnimationFrame(() => inputRef.current?.blur());
            } else if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
              e.preventDefault();
              const r = resolveQuantityDraft(draft, { max: ceiling, min, previous: value });
              const next = clampQuantity(r.value + (e.key === 'ArrowUp' ? 1 : -1), ceiling, min).value;
              setDraft(String(next));
              if (next !== value) onChange(next, 'step');
            }
          }}
          className={`${numberWidth} h-11 min-w-0 cursor-text border-x border-border-subtle bg-transparent px-0.5 text-center font-bold tabular-nums text-text-primary outline-none transition-colors hover:bg-surface-raised focus:bg-surface-raised focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-focus`}
        />
        <button
          type="button"
          aria-label={loc('زيادة الكمية', 'Increase quantity', 'زیادکردنی بڕ')}
          data-mascot="qty-inc"
          disabled={disabled || atMax}
          onClick={clickStep(1)}
          onPointerDown={startHold(1)}
          onPointerUp={stopHold}
          onPointerLeave={stopHold}
          onPointerCancel={stopHold}
          onContextMenu={(e) => e.preventDefault()}
          className={btn}
        >
          <Plus aria-hidden="true" className="h-4 w-4" />
        </button>
      </div>
      {/* The announcement is always in the tree (a live region added at the
          moment it speaks is often not heard); the bubble is what is seen. */}
      <span id={hintId} className="sr-only" aria-live="polite">
        {hint ?? ''}
      </span>
      {hint ? (
        <span
          aria-hidden="true"
          data-quantity-hint
          className={`pointer-events-none absolute z-10 whitespace-nowrap rounded-lg border border-border-subtle bg-surface-raised px-2.5 py-1.5 text-[12px] font-medium text-text-secondary shadow-[0_8px_24px_-12px_rgb(0_0_0/.45)] tabular-nums ${
            hintPlacement === 'start'
              ? 'end-full top-1/2 me-2 -translate-y-1/2'
              : hintPlacement === 'above'
                ? 'start-0 bottom-full mb-1.5'
                : 'start-0 top-full mt-1.5'
          }`}
        >
          {hint}
        </span>
      ) : null}
    </div>
  );
}
