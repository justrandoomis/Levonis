/**
 * "You changed the price — but three options keep their own."
 *
 * This is the panel that closes the gap the owner reported: they edit السعر,
 * save, and a customer with the product already in their cart is still charged
 * the old amount. The cart is not stale; it re-prices on every read. What is
 * old is the option row, because an option that carries its own price replaces
 * the base rather than adding to it (worker/lib/pricing.ts).
 *
 * So the moment the base price changes in the editor, the rows that will
 * ignore it are named — not counted vaguely, named, with the number each one
 * charges today and where it would land. The owner picks. Nothing moves a
 * price they typed on purpose without them saying so, and «تتبع السعر» is
 * offered first because it is the choice that makes the NEXT price change
 * behave the way they expected this one to.
 */
import React, { useMemo, useState } from 'react';
import { AlertTriangle, ArrowLeftRight, Percent, Link2, X } from 'lucide-react';
import * as T from './theme';
import { pinnedRows, repriceRow, type RepriceMode } from '../../../worker/lib/pinnedPrices';

export interface PinnedSource {
  options?: Array<Record<string, unknown>> | null;
  colors?: Array<Record<string, unknown>> | null;
  variants?: Array<Record<string, unknown>> | null;
}

const fmt = (n: number | null): string =>
  n === null ? '—' : new Intl.NumberFormat('en-US').format(n);

export function pinnedCount(src: PinnedSource): number {
  return pinnedRows(src as never).length;
}

export default function PinnedPriceNotice({
  from,
  to,
  source,
  lang,
  onApply,
  onDismiss,
}: {
  /** The base price as the product was loaded. */
  from: number;
  /** The base price now typed in the field. */
  to: number;
  source: PinnedSource;
  lang: string;
  onApply: (mode: RepriceMode) => void;
  onDismiss: () => void;
}) {
  const en = lang === 'en';
  const [mode, setMode] = useState<RepriceMode>('inherit');
  const rows = useMemo(() => pinnedRows(source as never), [source]);
  const preview = useMemo(
    () => rows.map((r) => ({ row: r, next: repriceRow(r, mode, from, to) })),
    [rows, mode, from, to]
  );
  if (!rows.length || from === to) return null;

  const diff = to - from;
  const pct = from > 0 ? Math.round(((to - from) / from) * 100) : 0;
  const kindWord = (k: string) =>
    k === 'color' ? (en ? 'colour' : 'لون') : k === 'variant' ? (en ? 'variant' : 'تركيبة') : en ? 'option' : 'خيار';

  const choices: Array<{ id: RepriceMode; icon: typeof Link2; ar: string; en: string; note_ar: string; note_en: string }> = [
    {
      id: 'inherit',
      icon: Link2,
      ar: 'اجعلها تتبع السعر الأساسي',
      en: 'Make them follow the base price',
      note_ar: 'تُمسح أسعارها الخاصة، فيصبح سعر المنتج واحدًا ويتبع أي تغيير قادم تلقائيًا.',
      note_en: 'Their own prices are cleared, so the product has one price and every future change reaches them.',
    },
    {
      id: 'delta',
      icon: ArrowLeftRight,
      ar: `حرّكها بنفس الفرق (${diff >= 0 ? '+' : '−'}${fmt(Math.abs(diff))})`,
      en: `Move them by the same amount (${diff >= 0 ? '+' : '−'}${fmt(Math.abs(diff))})`,
      note_ar: 'يبقى فرق كل خيار عن الأساسي كما هو.',
      note_en: 'Each option keeps the same distance from the base.',
    },
    {
      id: 'percent',
      icon: Percent,
      ar: `حرّكها بنفس النسبة (${pct >= 0 ? '+' : '−'}${Math.abs(pct)}%)`,
      en: `Move them by the same percentage (${pct >= 0 ? '+' : '−'}${Math.abs(pct)}%)`,
      note_ar: 'تبقى نسبة كل خيار إلى الأساسي كما هي.',
      note_en: 'Each option keeps the same ratio to the base.',
    },
  ];

  return (
    <div
      className={`${T.surface} mt-2 p-3 border-[var(--ap-warning-border)] bg-[var(--ap-warning-bg)]`}
      data-pinned-notice
      role="group"
      aria-label={en ? 'Options that keep their own price' : 'خيارات لها سعر خاص'}
    >
      <div className="flex items-start gap-2">
        <AlertTriangle className="w-4 h-4 mt-0.5 shrink-0 text-[var(--ap-warning)]" aria-hidden />
        <div className="min-w-0 flex-1">
          <p className="text-[13px] font-bold text-[var(--ap-text-1)]">
            {en
              ? `${rows.length} row${rows.length === 1 ? '' : 's'} keep their own price and will NOT follow the new base price.`
              : `${rows.length} من الخيارات/الألوان لها سعر خاص ولن تتبع السعر الجديد.`}
          </p>
          <p className="mt-0.5 text-[12px] text-[var(--ap-text-2)]">
            {en
              ? `A customer who picks one of them is charged its own price, not ${fmt(to)}. That is why a product can show the new price and still sell at the old one.`
              : `الزبون الذي يختار أحدها يُحاسَب بسعره الخاص لا بـ ${fmt(to)} — ولهذا يظهر المنتج بالسعر الجديد ويُباع بالقديم.`}
          </p>
        </div>
        <button
          type="button"
          onClick={onDismiss}
          className={T.btnIcon}
          aria-label={en ? 'Leave them as they are' : 'اتركها كما هي'}
          title={en ? 'Leave them as they are' : 'اتركها كما هي'}
          data-pinned-dismiss
        >
          <X className="w-4 h-4" aria-hidden />
        </button>
      </div>

      <div className="mt-2.5 flex flex-wrap gap-1.5" role="radiogroup" aria-label={en ? 'What to do' : 'ماذا تفعل'}>
        {choices.map(({ id, icon: Icon, ar, en: enLabel }) => (
          <button
            key={id}
            type="button"
            role="radio"
            aria-checked={mode === id}
            onClick={() => setMode(id)}
            data-pinned-mode={id}
            className={`${T.chip} h-9 px-3 aria-checked:text-[var(--ap-accent-text)] aria-checked:bg-[var(--ap-accent-soft)] aria-checked:border-[var(--ap-accent-border)]`}
          >
            <Icon className="w-3.5 h-3.5" aria-hidden />
            <span>{en ? enLabel : ar}</span>
          </button>
        ))}
      </div>
      <p className="mt-1.5 text-[11.5px] text-[var(--ap-text-3)]">
        {en ? choices.find((x) => x.id === mode)?.note_en : choices.find((x) => x.id === mode)?.note_ar}
      </p>

      <ul className="mt-2 space-y-1 max-h-40 overflow-y-auto" data-pinned-rows>
        {preview.map(({ row, next }) => (
          <li
            key={`${row.kind}:${row.id}`}
            className="flex items-center gap-2 text-[12px] border-b border-[var(--ap-hairline)] pb-1 last:border-b-0"
          >
            <span className={`${T.kbd} shrink-0`}>{kindWord(row.kind)}</span>
            <span className="min-w-0 flex-1 truncate text-[var(--ap-text-1)]">{row.label}</span>
            <span className="shrink-0 tabular-nums text-[var(--ap-text-3)]" dir="ltr">
              {fmt(row.regular_price_iqd)}
            </span>
            <span className="shrink-0 text-[var(--ap-text-3)]" aria-hidden>
              →
            </span>
            <span className="shrink-0 tabular-nums font-bold text-[var(--ap-text-1)]" dir="ltr" data-pinned-to={row.id}>
              {next.regular_price_iqd === null ? (en ? 'follows the base' : 'يتبع الأساسي') : fmt(next.regular_price_iqd)}
            </span>
          </li>
        ))}
      </ul>

      <div className="mt-2.5 flex flex-wrap gap-2">
        <button type="button" className={T.btnPrimary} onClick={() => onApply(mode)} data-pinned-apply>
          {en ? 'Apply to all of them' : 'طبّق على الكل'}
        </button>
        <button type="button" className={T.btnSecondary} onClick={onDismiss} data-pinned-leave>
          {en ? 'Leave them as they are' : 'اتركها كما هي'}
        </button>
      </div>
    </div>
  );
}
