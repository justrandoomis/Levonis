/**
 * The four small things a board row says about an order, and the digits they
 * are written in.
 *
 * They live together because the header line and the row both need them and
 * neither owns them: the counts across the top are written in the same digits
 * as the day chips under them, and a PRO badge drawn two ways is two badges.
 */
import type { AdminOrderRow, OrderDueBucket, OrderShippingType } from '../../lib/api';

/** The context's own `loc`, passed down rather than re-derived per badge. */
type Loc = (ar: string, en: string, ckb?: string) => string;

/**
 * ASCII digits → ٠-٩, the same fold `worker/lib/deliveryDay.ts` applies when
 * it writes a day label. The board renders the server's label as a string and
 * formats only its OWN numbers (counts, and the day behind a date search), so
 * this exists to keep those from arriving in Latin beside Arabic ones.
 */
export function arabicDigits(value: string | number): string {
  return String(value).replace(/[0-9]/g, (d) => String.fromCharCode(0x0660 + Number(d)));
}

/** A count, in the digits of the language being read. */
export const countText = (n: number, latin: boolean): string => (latin ? String(n) : arabicDigits(n));

/**
 * A `'YYYY-MM-DD'` day → «١٨/٩/٢٠٢٦», day-first as Iraq writes it.
 *
 * ###########################################################################
 * #  THIS SPLITS A STRING. IT DOES NOT CONSTRUCT A Date, AND MUST NOT.      #
 * ###########################################################################
 * `new Date('2026-09-23')` parses as UTC midnight, so a browser on a negative
 * offset renders the 22nd — the customer picks Wednesday and the screen says
 * Tuesday. Every day a row shows comes pre-localised from the server
 * (`due_label`); the only day the SCREEN formats is the one echoed back by a
 * date search, and three integers out of a fixed-width string is the whole of
 * what that needs.
 */
export function dayDigits(day: string, latin: boolean): string {
  const [y, m, d] = String(day).split('-');
  if (!y || !m || !d) return String(day);
  const text = `${Number(d)}/${Number(m)}/${y}`;
  return latin ? text : arabicDigits(text);
}

const TYPE_LABELS: Record<OrderShippingType, { ar: string; en: string; ckb: string }> = {
  direct: { ar: 'مباشر', en: 'Direct', ckb: 'ڕاستەوخۆ' },
  preorder_air: { ar: 'جوي', en: 'Air', ckb: 'ئاسمانی' },
  preorder_sea: { ar: 'بحري', en: 'Sea', ckb: 'دەریایی' },
  preorder_land: { ar: 'بري', en: 'Land', ckb: 'وشکانی' },
};

/** Which journey the box is on. Four words, one neutral pill. */
export function TypeBadge({ type, loc }: { type?: string; loc: Loc }) {
  const entry = TYPE_LABELS[(type ?? 'direct') as OrderShippingType];
  if (!entry) return null;
  return (
    <span
      data-order-kind={type ?? 'direct'}
      className="inline-flex items-center rounded-md border border-border-subtle bg-surface-raised px-1.5 py-0.5 text-[11px] leading-[1.4] font-bold text-text-secondary"
    >
      {loc(entry.ar, entry.en, entry.ckb)}
    </span>
  );
}

/**
 * «والأشخاص الذين لديهم اشتراك برو يكون طلباتهم مثبتة في الأعلى دائما»
 *
 * IT SURVIVES THE COMPACT ROW ON PURPOSE. Inside one day the ordering is
 * entirely tie-breaks — correct, but it looks arbitrary unless the badge is on
 * every row it applies to. Drop it for space and the owner loses the only
 * visible evidence that the pin they asked for is working, and will
 * reasonably report the feature as broken.
 */
export function ProBadge({ order }: { order: AdminOrderRow }) {
  if (order.priority !== 1) return null;
  return (
    <span
      data-order-pro={order.fulfillment_service === 'pro_priority_12h' ? '12h' : 'priority'}
      className="inline-flex items-center rounded-md border border-[#B03142]/35 bg-[#B03142]/10 px-1.5 py-0.5 text-[10px] leading-[1.4] font-black text-[#f3bdc5]"
    >
      {order.fulfillment_service === 'pro_priority_12h' ? 'PRO · 12H' : 'PRO'}
    </span>
  );
}

/**
 * The day the box goes out, as the server wrote it, plus the two facts a
 * label alone cannot carry.
 *
 * `label` is `due_label` — «اليوم», «غدًا» or «الأربعاء ٢٣ أيلول», already in
 * the reader's language. The screen never re-formats it and never derives the
 * bucket from it: `due_bucket` is computed on the server against the Baghdad
 * day, and a browser that recomputed it would file today's work as overdue for
 * the first three hours of every Iraqi day.
 */
export function DayChip({
  label,
  bucket,
  postponed,
  loc,
}: {
  label?: string;
  bucket?: OrderDueBucket;
  postponed: boolean;
  loc: Loc;
}) {
  const none = !label;
  return (
    <span className="inline-flex items-center gap-1.5">
      <span
        data-order-day={bucket ?? 'unscheduled'}
        className={`inline-flex items-center rounded-md px-1.5 py-0.5 text-[12px] leading-[1.4] font-bold ${
          none ? 'text-text-muted' : 'bg-surface-selected text-text-primary'
        }`}
      >
        {none ? loc('بلا موعد', 'No day', 'بێ ڕۆژ') : label}
      </span>
      {/* The one red thing on the row, for the same reason it is the one red
          thing in the header: a box that should have gone out on Tuesday is
          today's work, and the most urgent of it. */}
      {bucket === 'overdue' && (
        <span data-order-overdue className="text-[11px] leading-[1.4] font-bold text-danger">
          {loc('متأخر', 'Overdue', 'دواکەوتوو')}
        </span>
      )}
      {/* NOT DECORATION. The day moved after checkout, so this order sank down
          a list the admin already read this morning — without this marker it
          looks to them like an order that vanished. */}
      {postponed && (
        <span
          data-order-postponed
          className="text-[11px] leading-[1.4] font-bold text-warning"
          title={loc('تغيّر يوم التوصيل بعد الطلب', 'The delivery day moved after checkout', 'ڕۆژی گەیاندن گۆڕا')}
        >
          {loc('مؤجل', 'Moved', 'دواخرا')}
        </span>
      )}
    </span>
  );
}
