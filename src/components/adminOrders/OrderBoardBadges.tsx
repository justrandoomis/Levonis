/**
 * The small things a board row says about an order, and the digits they
 * are written in.
 *
 * They live together because the header line and the row both need them and
 * neither owns them: the counts across the top are written in the same digits
 * as the day chips under them, and a PRO badge drawn two ways is two badges.
 */
import type { AdminOrderRow, OrderDueBucket, OrderLateReason, OrderShippingType } from '../../lib/api';
import { PREPARE_DAY_STRINGS, dayLine, type Tri } from './prepareDayStrings';
import { doneText } from './archiveSort';

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
      className="inline-flex items-center rounded-md border border-crimson/35 bg-crimson/10 px-1.5 py-0.5 text-[10px] leading-[1.4] font-black text-petal"
    >
      {order.fulfillment_service === 'pro_priority_12h' ? 'PRO · 12H' : 'PRO'}
    </span>
  );
}

/**
 * The customer's day, as the server wrote it, plus the facts a label alone
 * cannot carry.
 *
 * `label` is `due_label` — «اليوم», «غدًا» or «الأربعاء ٢٣ أيلول», already in
 * the reader's language — and it is the CUSTOMER'S day, so the chip says so:
 * «التوصيل: غدًا». The row is FILED by another day (DECISIONS row 322): the
 * day to pack it and hand it to the courier, which `due_bucket` was computed
 * from on the server against the Baghdad day. The screen never re-formats a
 * label and never derives a bucket — a browser that did would file today's
 * work as overdue for the first three hours of every Iraqi day.
 *
 * `prepareLabel` is that day, labelled by the server, sent only when it differs
 * from the delivery day; it is shown away from «اليوم», whose header already
 * says when to pack it — and on every row of a list with no day headers
 * (`flat`: an order- or phone-number lookup), where nothing else says it.
 * `lateReason` (the server's `overdue_reason`) picks which lateness «متأخر»
 * means.
 */
export function DayChip({
  label,
  bucket,
  postponed,
  prepareLabel,
  lateReason = 'prepare',
  flat = false,
  loc,
}: {
  label?: string;
  bucket?: OrderDueBucket;
  postponed: boolean;
  prepareLabel?: string;
  lateReason?: OrderLateReason;
  flat?: boolean;
  loc: Loc;
}) {
  const none = !label;
  const showPrepare = !!prepareLabel && (flat || bucket === 'tomorrow' || bucket === 'week' || bucket === 'later');
  return (
    <span className="inline-flex flex-wrap items-center gap-x-1.5 gap-y-0.5">
      <span
        data-order-day={bucket ?? 'unscheduled'}
        className={`inline-flex items-center rounded-md px-1.5 py-0.5 text-[12px] leading-[1.4] font-bold ${
          none ? 'text-text-muted' : 'bg-surface-selected text-text-primary'
        }`}
      >
        {none ? loc('بلا موعد', 'No day', 'بێ ڕۆژ') : dayLine(loc, PREPARE_DAY_STRINGS.delivery, label)}
      </span>
      {showPrepare && (
        <span data-order-prepare-day className="text-[11px] leading-[1.4] font-bold text-text-muted">
          {dayLine(loc, PREPARE_DAY_STRINGS.prepare, prepareLabel)}
        </span>
      )}
      {/* The one red thing on the row, for the same reason it is the one red
          thing in the header: a box that should have gone out on Tuesday is
          today's work, and the most urgent of it. */}
      {bucket === 'overdue' && <LateMark reason={lateReason} loc={loc} />}
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

const LATE_WHY: Record<OrderLateReason, { why: Tri; short: Tri | null }> = {
  prepare: { why: PREPARE_DAY_STRINGS.overduePrepare, short: null },
  courier: { why: PREPARE_DAY_STRINGS.overdueCourier, short: PREPARE_DAY_STRINGS.lateCourier },
};

/**
 * «متأخر», AND WHICH LATENESS IT IS — IN WORDS (the review of row 322). One
 * word covers two causes that send an admin to two different places: a box
 * still on our shelf, and a parcel the courier is late with — with the courier
 * or booked with the delivery company, which the owner counts as handed over
 * (2026-11-12). A `title` alone cannot be opened on a phone (the owner's
 * iPhone), so the one that is not "go and pack it" says so on its face —
 * «متأخر · مع المندوب» — and every reason's full sentence is the title for a
 * mouse and the screen-reader text. Shared by the board's row and the order
 * window.
 */
export function LateMark({ reason, loc }: { reason: OrderLateReason; loc: Loc }) {
  const { why, short } = LATE_WHY[reason] ?? LATE_WHY.prepare;
  const sentence = dayLine(loc, why);
  return (
    <span data-order-overdue={reason} className="text-[11px] leading-[1.4] font-bold text-danger" title={sentence}>
      {dayLine(loc, PREPARE_DAY_STRINGS.late)}
      {short ? `\u00a0· ${dayLine(loc, short)}` : null}
      <span className="sr-only"> — {sentence}</span>
    </span>
  );
}

/**
 * The row's lateness, as the server decided it (`overdue_reason`). An older
 * server sends none: the stage alone then tells the courier's from the shelf's.
 */
export function lateReasonOfRow(order: Pick<AdminOrderRow, 'overdue_reason' | 'stage'>): OrderLateReason {
  return order.overdue_reason ?? (order.stage === 'out_for_delivery' ? 'courier' : 'prepare');
}

/**
 * THE ORDER WINDOW'S TWO DAYS (row 322): «التوصيل: … · التجهيز: …», both
 * labelled by the server, and — when the board files the order on a day
 * already past (`overdue_reason`, the review of row 322) — the same «متأخر» the
 * board shows, so a late order never reads as an ordinary schedule.
 *
 * EACH PART IS ONE BLOCK THAT BREAKS AS A WHOLE (`inline-block`, the «·»
 * riding at the end of the part before it): on a narrow phone the line breaks
 * between the days, never between «ئامادەکردن:» and its day.
 */
export function OrderDaysLine({
  deliveryLabel,
  prepareLabel,
  lateReason,
  loc,
}: {
  deliveryLabel?: string;
  prepareLabel?: string;
  lateReason?: OrderLateReason | null;
  loc: Loc;
}) {
  if (!deliveryLabel) return null;
  const parts = [
    <span key="delivery">{dayLine(loc, PREPARE_DAY_STRINGS.delivery, deliveryLabel)}</span>,
    ...(prepareLabel ? [<span key="prepare">{dayLine(loc, PREPARE_DAY_STRINGS.prepare, prepareLabel)}</span>] : []),
    ...(lateReason ? [<LateMark key="late" reason={lateReason} loc={loc} />] : []),
  ];
  return (
    <p data-order-days className="text-[13px] font-bold text-text-secondary">
      {parts.map((part, i) => (
        <span key={i} className="inline-block">
          {part}
          {i < parts.length - 1 && (
            <span className="mx-1.5 text-text-muted" aria-hidden>
              ·
            </span>
          )}
        </span>
      ))}
    </p>
  );
}

/**
 * A FINISHED ORDER'S DAY (DECISIONS row 323), in the place of the delivery day:
 * «سُلّم الثلاثاء ١٠ تشرين الثاني» / «أُلغي اليوم» — when it was delivered or
 * cancelled, labelled by the server (`done_label`), which is also what the
 * completed orders are sorted by. It is drawn exactly as the day chip is, and
 * never red: a finished order is not late, so «متأخر» stays the one red thing
 * and keeps meaning late — in the archive, and for a finished order an order-
 * or phone-number lookup finds on the live board.
 */
export function DoneChip({ status, label, loc }: { status: 'delivered' | 'cancelled'; label?: string; loc: Loc }) {
  return (
    <span
      data-order-done={status}
      className={`inline-flex items-center rounded-md px-1.5 py-0.5 text-[12px] leading-[1.4] font-bold ${
        label ? 'bg-surface-selected text-text-primary' : 'text-text-muted'
      }`}
    >
      {doneText(loc, status, label)}
    </span>
  );
}

/**
 * A board row since migration 0218 (worker/routes/admin.ts): `price_estimate_open`
 * is present, and true, only while one of its lines sold at an estimated price
 * waits for its final price — and the server then offers the row no one-tap
 * move (`quick_next` is null), because the gate would refuse it.
 */
export type EstimateBoardRow = AdminOrderRow & { price_estimate_open?: boolean };

/**
 * THE ORDER IS HELD ON ITS PRICE — one badge for both holds, so the row needs
 * no second slot:
 *   · «بانتظار موافقة السعر» (migration 0140): frozen until the customer
 *     approves or rejects a new price — no stage moves, no courier shipment;
 *   · otherwise «بانتظار تأكيد السعر» (migration 0218, `EstimateBadge`): lines
 *     sold at an estimated price wait for a financial admin's final price.
 * While an estimate's own proposal waits on the customer the 0140 badge is the
 * true one: the next move is theirs. Amber — pending, not an error — and in
 * words, never colour alone.
 */
export function PriceHoldBadge({ order, loc }: { order: EstimateBoardRow; loc: Loc }) {
  if (!order.price_hold_id) return <EstimateBadge order={order} loc={loc} />;
  return (
    <span
      data-order-price-hold
      className="lv-chip inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[11px] leading-[1.4] font-bold [--chip:var(--color-warning)]"
    >
      <span className="h-1.5 w-1.5 rounded-full bg-warning" aria-hidden />
      {loc('بانتظار موافقة السعر', 'Awaiting price approval', 'چاوەڕێی پەسەندکردنی نرخ')}
    </span>
  );
}

/**
 * «بانتظار تأكيد السعر» (migration 0218; docs/SMART_PRICING.md §7): the order
 * holds lines sold at an estimated pre-order price and stays at «تم استلام
 * الطلب» — no confirm, preparation, shipping or courier — until their final
 * price is settled in the order's «تأكيد السعر النهائي». The board's filter of
 * the same name lists exactly these orders.
 */
export function EstimateBadge({ order, loc }: { order: EstimateBoardRow; loc: Loc }) {
  if (order.price_estimate_open !== true) return null;
  return (
    <span
      data-order-price-estimate
      className="lv-chip inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[11px] leading-[1.4] font-bold [--chip:var(--color-warning)]"
    >
      <span className="h-1.5 w-1.5 rounded-full bg-warning" aria-hidden />
      {loc('بانتظار تأكيد السعر', 'Awaiting price confirmation', 'چاوەڕێی پشتڕاستکردنەوەی نرخ')}
    </span>
  );
}

/**
 * What made the order (0174): «🎁 هدية» for an order of gifts only. The
 * ordinary cart order carries no badge — and neither does an order a Quick
 * Buy session became after its 30 minutes: it is an ordinary order to prepare,
 * confirm and ship exactly like a cart order, and a label on the board only
 * suggested it needed something else (owner, 2026-10-08, DECISIONS row 188).
 * `order_kind = 'quick_buy'` stays on the row for the finance reports. In
 * words, never colour alone.
 */
export function OrderKindBadge({ order, loc }: { order: AdminOrderRow; loc: Loc }) {
  if (order.order_kind !== 'gift') return null;
  return (
    <span
      data-order-kind={order.order_kind}
      className="lv-chip inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[11px] leading-[1.4] font-bold [--chip:var(--color-gold)]"
    >
      {loc('🎁 هدية', '🎁 Gift', '🎁 دیاری')}
    </span>
  );
}
