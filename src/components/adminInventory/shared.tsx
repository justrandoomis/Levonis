/**
 * «إدارة المخزون» — the pieces every tab of the inventory workspace shares.
 *
 * ###########################################################################
 * #  A MISSING COST AND A HIDDEN COST ARE NOT THE SAME THING, AND THIS      #
 * #  SCREEN MUST NEVER PRINT THEM THE SAME WAY.                             #
 * ###########################################################################
 *
 *   `undefined`  the SERVER REMOVED IT. An assistant admin is reading, and
 *                mandate §52 puts them outside every cost. The right render is
 *                NOTHING — no dash, no zero, no locked padlock teasing a
 *                number they cannot have. The column disappears.
 *
 *   `null`       NOBODY KNOWS. A lot backfilled from a product that never
 *                carried a cost. The right render is «غير معروفة»: the owner
 *                must be able to see how much of their stock is unpriced,
 *                because it is the part of the valuation that is missing.
 *
 *   `0`          IT WAS FREE. Vanishingly rare and still a fact.
 *
 * `Money` below is the one component that gets this right, and every cost on
 * every tab goes through it.
 *
 * ---------------------------------------------------------------------------
 * DIGITS AND MONEY FOLLOW THE REST OF THE ADMIN.
 *
 * `formatIqd` for money and `countText` for counts, both imported rather than
 * re-written — the same reasoning adminFinance/format.ts sets out: a total on
 * the orders tab and the same total here must be one string.
 */
import React, { useEffect, useState, type ReactNode } from 'react';
import { AlertTriangle, CheckCircle2, Info, X } from 'lucide-react';
import * as T from '../adminProducts/theme';
import { formatIqd, ApiError } from '../../lib/api';
import { countText, isLatin } from '../adminFinance/format';
import { useLanguage } from '../../LanguageContext';

export function useLoc() {
  const { lang, dir, loc } = useLanguage();
  return { lang, dir, loc, latin: isLatin(lang) };
}

/** A count, in the digits of the language being read. */
export const useCount = () => {
  const { latin } = useLoc();
  return (n: number) => countText(n, latin);
};

/**
 * THE THREE STATES OF A COST, rendered as three different things.
 *
 * `hidden` is not an error and not an empty string with a tooltip: the caller
 * is told to render nothing, and the table drops the column entirely so an
 * assistant does not spend the day looking at a wall of dashes wondering what
 * is behind them.
 */
export function Money({ value, unknownLabel }: { value: number | null | undefined; unknownLabel: string }) {
  if (value === undefined) return null;
  if (value === null) {
    return <span className="text-[var(--ap-text-3)] italic">{unknownLabel}</span>;
  }
  return <span className="tabular-nums">{formatIqd(value)}</span>;
}

/** Does this payload still carry costs? One probe, used to drop whole columns
 *  rather than to blank individual cells. */
export const hasCosts = (sample: Record<string, unknown> | undefined, key: string): boolean =>
  sample !== undefined && key in sample;

export type NoticeTone = 'success' | 'error' | 'info';
export interface NoticeState {
  tone: NoticeTone;
  text: string;
}

/**
 * A result banner that dismisses itself after a while, EXCEPT when it is an
 * error: a failure the admin did not read is a failure they will repeat.
 */
export function Notice({ state, onClose }: { state: NoticeState | null; onClose: () => void }) {
  useEffect(() => {
    if (!state || state.tone === 'error') return;
    const t = setTimeout(onClose, 6000);
    return () => clearTimeout(t);
  }, [state, onClose]);
  if (!state) return null;
  const Icon = state.tone === 'error' ? AlertTriangle : state.tone === 'success' ? CheckCircle2 : Info;
  const skin =
    state.tone === 'error'
      ? 'text-[var(--ap-danger)] bg-[var(--ap-danger-bg)] border-[var(--ap-danger-border)]'
      : state.tone === 'success'
        ? 'text-[var(--ap-success)] bg-[var(--ap-success-bg)] border-[var(--ap-success-border)]'
        : 'text-[var(--ap-info)] bg-[var(--ap-info-bg)] border-[var(--ap-info-border)]';
  return (
    <div role="status" className={`flex items-start gap-2.5 rounded-[var(--ap-radius-md)] border p-3 mb-4 text-[13px] leading-[1.6] font-medium ${skin}`}>
      <Icon size={16} className="mt-[2px] shrink-0" aria-hidden />
      <span className="min-w-0 flex-1">{state.text}</span>
      <button type="button" onClick={onClose} className={T.btnIconGhost} aria-label="close">
        <X size={14} />
      </button>
    </div>
  );
}

/**
 * THE SERVER'S SENTENCE, NOT A GENERIC ONE.
 *
 * Every refusal these routes produce is already written for a person —
 * «أدخل تكلفة الشحن والتوصيل للمخزن قبل الاستلام (الصفر قيمة صحيحة)» says what
 * to do next, and «تعذّر تنفيذ العملية» says nothing. So the message is shown
 * verbatim and the fallback is only for a network failure that never reached
 * a handler.
 */
export function errMsg(e: unknown, fallbackAr: string, fallbackEn: string, latin: boolean): string {
  if (e instanceof ApiError && e.message) return e.message;
  if (e instanceof Error && e.message && !/fetch|network/i.test(e.message)) return e.message;
  return latin ? fallbackEn : fallbackAr;
}

/** A labelled figure in the summary strip. */
export function Stat({
  label, value, sub, tint = 'purple', icon,
}: {
  label: string;
  value: ReactNode;
  sub?: ReactNode;
  tint?: 'purple' | 'blue' | 'green' | 'amber' | 'red';
  icon?: ReactNode;
}) {
  return (
    <div className={T.statCard.base}>
      <div className="flex items-start justify-between gap-2">
        <span className={`text-[11.5px] font-semibold ${T.text3}`}>{label}</span>
        {icon && (
          <span className={`flex h-7 w-7 items-center justify-center rounded-[var(--ap-radius-sm)] ${T.statCard.tints[tint].box}`}>
            {icon}
          </span>
        )}
      </div>
      <div className={`mt-2 text-[20px] font-bold leading-tight tabular-nums ${T.text1}`}>{value}</div>
      {sub && <div className={`mt-1 text-[11.5px] leading-[1.5] ${T.text3}`}>{sub}</div>}
    </div>
  );
}

/** A table that scrolls sideways with its last column pinned, like every other
 *  admin list — see `stickyActionsColumn` for why that matters on a tablet. */
export function TableFrame({ children, minWidth = 860 }: { children: ReactNode; minWidth?: number }) {
  return (
    <div className={`${T.surface} overflow-x-auto`}>
      <table
        className={`w-full text-[13px] ${T.stickyActionsColumn}`}
        style={{ minWidth }}
      >
        {children}
      </table>
    </div>
  );
}

export function Empty({ text }: { text: string }) {
  return <div className={`py-14 text-center text-[13px] ${T.text3}`}>{text}</div>;
}

export function Loading({ text }: { text: string }) {
  return <div className={`py-14 text-center text-[13px] ${T.text3}`}>{text}</div>;
}

/**
 * A NUMBER FIELD THAT KEEPS «لم يُدخَل» DISTINCT FROM «صفر».
 *
 * The whole §13 rule in one control. `''` is returned as `null` — the box is
 * empty, nobody has said anything — and a typed `0` is returned as `0`, which
 * is a real answer the shop gives all the time: the owner collected the boxes
 * themselves, so the internal delivery really did cost nothing. A control that
 * coerced with `Number(x) || null` would turn that answer back into silence and
 * the receipt would be refused for a cost that HAD been stated.
 */
export function IqdField({
  label, hint, value, onChange, disabled, required,
}: {
  label: string;
  hint?: string;
  value: number | null;
  onChange: (v: number | null) => void;
  disabled?: boolean;
  required?: boolean;
}) {
  const [text, setText] = useState(value === null ? '' : String(value));
  useEffect(() => {
    setText(value === null ? '' : String(value));
  }, [value]);
  return (
    <label className="flex flex-col gap-1.5 min-w-0">
      <span className={`text-[12px] font-semibold ${T.text2}`}>
        {label}
        {required && <span className="text-[var(--ap-danger)]"> *</span>}
      </span>
      <input
        className={T.input}
        inputMode="numeric"
        disabled={disabled}
        value={text}
        onChange={(e) => {
          const raw = e.target.value.replace(/[^\d]/g, '');
          setText(raw);
          onChange(raw === '' ? null : Number(raw));
        }}
      />
      {hint && <span className={`text-[11px] leading-[1.5] ${T.text3}`}>{hint}</span>}
    </label>
  );
}

/** A short relative age — «منذ ٤٥ يومًا» — for a lot's shelf life. */
export function daysSince(iso: string | null): number | null {
  if (!iso) return null;
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return null;
  return Math.max(0, Math.floor((Date.now() - t) / 86_400_000));
}
