/**
 * ONE BOX — «كذلك أضف بحث في الطلبات» — AND A CHIP THAT SAYS WHAT IT DID.
 *
 * The server reads what was typed FOUR ways in a fixed order (order number →
 * date → phone → name) and returns the first that hits, plus `search_kind`
 * naming the reading that won. This component's whole job is to type into that
 * box and then say, out loud, which reading the server chose.
 *
 * THAT CHIP IS THE CHEAPEST POSSIBLE ANSWER TO A MISCLASSIFICATION. The
 * alternative to being legible about the guess is guessing harder, and no
 * amount of guessing turns «5-9» into an unambiguous date. So the screen says
 * what it did and, for an ambiguous day, offers the other reading in one tap.
 *
 * ###########################################################################
 * #  THE ROWS THE SERVER RETURNS ARE THE ANSWER. DO NOT FILTER THEM AGAIN.  #
 * ###########################################################################
 * src/components/AdminUsers.tsx lays a `.toLowerCase().includes()` over its
 * own server results. Copying that here would undo the entire feature: the
 * server folds Arabic orthography (hamza, ta marbuta, alef maqsura, tashkeel)
 * on BOTH sides of the comparison, so it correctly answers «أحمد علي» for
 * «احمد» — and a plain `includes` would then hide that row, because it does no
 * folding at all. The bug would be invisible in English and silent in Arabic.
 */
import { useEffect, useRef, useState } from 'react';
import { Search, X, ArrowLeftRight } from 'lucide-react';
import type { AdminOrdersResponse, OrderSearchKind } from '../../lib/api';
import { dayDigits } from './OrderBoardBadges';

/** ~350ms: long enough that a typed phone number is one request, short enough
 *  that the chip answers while the admin is still looking at the box. */
const DEBOUNCE_MS = 350;

const KIND_LABEL: Record<Exclude<OrderSearchKind, 'none'>, { ar: string; en: string; ckb: string }> = {
  order_id: { ar: 'رقم طلب', en: 'Order no.', ckb: 'ژمارەی داواکاری' },
  phone: { ar: 'رقم هاتف', en: 'Phone', ckb: 'ژمارەی مۆبایل' },
  date: { ar: 'تاريخ', en: 'Date', ckb: 'بەروار' },
  name: { ar: 'اسم', en: 'Name', ckb: 'ناو' },
};

export default function OrderSearchField({
  value,
  onCommit,
  kind,
  search,
  lang,
  loc,
}: {
  /** The committed query — what the last request actually asked for. */
  value: string;
  /** Called with the debounced text. The caller sends it AND resets the page. */
  onCommit: (q: string) => void;
  kind: OrderSearchKind;
  search: AdminOrdersResponse['search'];
  lang: string;
  loc: (ar: string, en: string, ckb?: string) => string;
}) {
  const [text, setText] = useState(value);
  const latin = lang === 'en';

  /**
   * THE BOX OWNS ITS TEXT, AND NOTHING SYNCS IT BACK FROM THE PROP.
   *
   * The obvious `useEffect(() => setText(value), [value])` loses keystrokes:
   * the commit for «abc» lands ~350ms after it was typed, by which time the
   * admin has typed «abcd», and the effect then puts «abc» back. The two
   * places that change the query from outside the keyboard — the clear button
   * and the day-flip — set the text themselves, so there is nothing left for a
   * sync to do.
   */
  // DEBOUNCED, AND THE COMMIT IS WHAT RESETS THE PAGE. Without that reset a
  // search run from page 4 asks the server for rows 90-120 of a result set
  // with eleven rows in it, and the admin lands on an empty screen for a
  // search that matched.
  const committed = useRef(value);
  useEffect(() => {
    const trimmed = text.trim();
    if (trimmed === committed.current) return;
    const timer = setTimeout(() => {
      committed.current = trimmed;
      onCommit(trimmed);
    }, DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [text, onCommit]);

  const clear = () => {
    setText('');
    committed.current = '';
    onCommit('');
  };

  /** Send the OTHER reading of an ambiguous day back as the query. The server
   *  hands it over ready to use: a full `'YYYY-MM-DD'` cannot be read two
   *  ways, so the flip lands on exactly one day and never flips back by
   *  accident. */
  const flip = (day: string) => {
    setText(day);
    committed.current = day;
    onCommit(day);
  };

  const label = kind === 'none' ? null : KIND_LABEL[kind];
  const date = search?.date;

  return (
    <div className="space-y-2 min-w-0">
      <div className="relative min-w-0">
        {/* `start-3` / `end-0` are the logical insets: they mirror with the
            language, so the icon does not need a second RTL rule. */}
        <Search className="pointer-events-none absolute start-3 top-1/2 h-4 w-4 -translate-y-1/2 text-text-muted" aria-hidden />
        <input
          type="text"
          data-order-search
          value={text}
          onChange={(e) => setText(e.target.value)}
          aria-label={loc('بحث في الطلبات', 'Search orders', 'گەڕان لە داواکارییەکان')}
          placeholder={loc(
            'رقم طلب، رقم هاتف، اسم أو تاريخ',
            'Order number, phone, name or date',
            'ژمارەی داواکاری، مۆبایل، ناو یان بەروار'
          )}
          className="lv-input w-full ps-10 pe-12"
        />
        {text && (
          <button
            type="button"
            data-order-search-clear
            onClick={clear}
            aria-label={loc('مسح البحث', 'Clear search', 'سڕینەوەی گەڕان')}
            className="absolute end-0 top-1/2 h-11 w-11 -translate-y-1/2 text-text-muted transition-colors hover:text-text-primary focus-visible:text-text-primary active:text-text-primary"
          >
            <X className="mx-auto h-4 w-4" aria-hidden />
          </button>
        )}
      </div>

      {label && (
        <div className="flex flex-wrap items-center gap-2">
          <span
            data-order-search-kind={kind}
            className="inline-flex items-center rounded-md border border-border-subtle bg-surface-raised px-2 py-1 text-[12px] leading-[1.5] font-bold text-text-secondary"
          >
            {loc(label.ar, label.en, label.ckb)}
            {date && <span className="ms-1.5 text-text-primary">{dayDigits(date.day_from, latin)}</span>}
          </span>

          {/* An order number or a phone number is a LOOKUP, not a browse, so
              the server ignores the board's scope for it — most of why an
              admin searches at all is to ask about an order that is already
              delivered or cancelled. Saying so is what stops "why is a
              cancelled order in my open list?" being a bug report. */}
          {search?.pierced && (
            <span data-order-search-pierced className="text-[12px] leading-[1.5] text-text-muted">
              {loc('في كل الطلبات', 'across all orders', 'لە هەموو داواکارییەکان')}
            </span>
          )}

          {/* «5-9» is read day-first, because that is how Iraq writes a date.
              The other reading is one tap away rather than silently OR-ed in:
              returning 5 September and 9 May together shows two unrelated days
              of orders, which does not look helpful — it looks broken. */}
          {date?.flip_day && (
            <button
              type="button"
              data-order-search-flip={date.flip_day}
              onClick={() => flip(date.flip_day as string)}
              className="lv-button lv-button-ghost lv-button-sm press-scale border border-border-subtle text-text-secondary"
            >
              <ArrowLeftRight className="h-3.5 w-3.5" aria-hidden />
              {dayDigits(date.flip_day, latin)}
            </button>
          )}
        </div>
      )}
    </div>
  );
}
