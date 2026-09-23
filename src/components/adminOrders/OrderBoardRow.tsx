/**
 * ONE ORDER, AS THE PERSON PACKING THE BOX READS IT.
 *
 * The row this replaces identified the customer by `o.email || o.username ||
 * o.user_id` — an email address is the least useful thing to put in front of
 * someone packing a parcel, and the delivery NAME and GOVERNORATE were already
 * on the payload at zero extra cost (`orderPublic` returns the parsed address
 * snapshot). So the row leads with the person the parcel is FOR and where it
 * is going.
 *
 * A CARD AT EVERY WIDTH, NOT A TABLE THAT BECOMES ONE. The list above this row
 * has sticky day headers, and a sticky header inside an `overflow-x-auto`
 * table does not stick: the overflow container becomes the scrollport and the
 * header quietly stops sticking on the desktop breakpoint ONLY, which is the
 * breakpoint nobody re-checks after testing on a phone.
 *
 * ONE PRIMARY ACTION, AND ONE NAMED MOVE. The per-row status DROPDOWN that
 * used to sit here moved into the modal's stage panel, which is already the
 * authority for where an order is — the page's own history records the mis-tap
 * it caused («عند تحديث الطلب يظهر خيارين فقط») as a real incident. What the
 * owner then asked for is not that dropdown back: «زر سريع لتغيير الحالة»,
 * one tap to advance. The difference is the whole of why this is safe to put
 * back on the row:
 *
 *   * IT IS ONE DESTINATION, NOT A LIST. There is nothing to pick wrongly.
 *   * IT SAYS THE DESTINATION ON ITS FACE — «مؤكد», «جارٍ التجهيز للشحن
 *     الجوي» — in the customer's own stage wording, so the admin reads what
 *     will happen before tapping rather than after. The dropdown's incident
 *     was precisely that it showed the wrong options with no such label.
 *   * THE SERVER CHOSE IT. `order.quick_next` is the next stage on THIS
 *     order's path, decided in `worker/routes/admin.ts`; this file does not
 *     know what follows what, which is the rule the stage panel already keeps.
 *   * IT DISAPPEARS WHERE IT WOULD LIE. `quick_next` is null at the end of the
 *     path and for a cancelled order, and no button is drawn — never a
 *     disabled one, which reads as "this screen is broken" rather than "there
 *     is nowhere to go".
 *
 * IT IS NOT THE LOUDEST THING ON THE ROW. Thirty cream fills down a dark list
 * is the same mistake as a header of coloured chips — see the note on «تجهيز»
 * below, which this shares.
 */
import { ChevronsRight, Loader2, Trash2 } from 'lucide-react';
import { formatIqd, type AdminOrderRow, type OrderStatus } from '../../lib/api';
import { GOVERNORATE_LABELS } from '../../lib/governorates';
import { DayChip, ProBadge, TypeBadge } from './OrderBoardBadges';

const STATUS_TEXT: Record<OrderStatus, { ar: string; en: string; ckb: string }> = {
  pending: { ar: 'قيد الانتظار', en: 'Pending', ckb: 'چاوەڕوان' },
  confirmed: { ar: 'مؤكد', en: 'Confirmed', ckb: 'پشتڕاستکراو' },
  processing: { ar: 'قيد التجهيز', en: 'Processing', ckb: 'ئامادەکردن' },
  shipped: { ar: 'تم الشحن', en: 'Shipped', ckb: 'نێردرا' },
  delivered: { ar: 'تم التسليم', en: 'Delivered', ckb: 'گەیەنرا' },
  cancelled: { ar: 'ملغى', en: 'Cancelled', ckb: 'هەڵوەشێنرا' },
};

export function statusText(status: OrderStatus, loc: (ar: string, en: string, ckb?: string) => string): string {
  const entry = STATUS_TEXT[status];
  if (!entry) return status;
  return loc(entry.ar, entry.en, entry.ckb);
}

export default function OrderBoardRow({
  order,
  loc,
  onOpen,
  onDelete,
  onAdvance,
  advancing,
  deleting,
}: {
  order: AdminOrderRow;
  loc: (ar: string, en: string, ckb?: string) => string;
  onOpen: (id: string) => void;
  onDelete: (order: AdminOrderRow) => void;
  onAdvance: (order: AdminOrderRow) => void;
  advancing: boolean;
  deleting: boolean;
}) {
  const gov = order.address?.governorate ? GOVERNORATE_LABELS[order.address.governorate] : undefined;
  const govLabel = gov ? loc(gov.ar, gov.en, gov.ckb) : '';
  // The parcel's name, then the account holder's, then nothing — never the
  // email, which is what this row used to lead with.
  const name = order.address?.name || order.customer_name || '';

  return (
    <article
      data-order-card={order.id}
      className="lv-surface flex items-start gap-3 p-3 min-w-0"
    >
      <div className="min-w-0 flex-1 space-y-1">
        <div className="flex flex-wrap items-center gap-1.5">
          <DayChip
            label={order.due_label}
            bucket={order.due_bucket}
            postponed={!!order.delivery_day_changed_at}
            loc={loc}
          />
          <ProBadge order={order} />
        </div>

        <p className="truncate text-[14px] leading-[1.45] font-bold text-text-primary" dir="auto">
          {name || loc('بلا اسم', 'No name', 'بێ ناو')}
        </p>

        <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-[12px] leading-[1.5] text-text-secondary">
          {govLabel && <span>{govLabel}</span>}
          <TypeBadge type={order.shipping_type} loc={loc} />
          {/* The status is INFORMATION here, not a control, and it is not a
              seventh colour: if everything on the row is coloured, the one
              red thing on it stops meaning "late". */}
          <span className="text-text-muted">{statusText(order.status, loc)}</span>
        </div>

        <p className="truncate font-mono text-[11px] leading-[1.5] text-text-muted" dir="ltr">
          {order.id}
        </p>
      </div>

      <div className="flex shrink-0 flex-col items-end gap-2">
        <p className="whitespace-nowrap text-[14px] leading-[1.45] font-bold tabular-nums text-text-primary" dir="ltr">
          {formatIqd(order.total_iqd)}
        </p>
        <div className="flex items-center gap-1.5">
          {/* Cancelled orders are kept for thirty days; this is the owner's
              deliberate override, and it only exists where it can apply. */}
          {order.status === 'cancelled' && (
            <button
              type="button"
              data-action="delete-order-permanently"
              data-order-id={order.id}
              disabled={deleting}
              onClick={() => onDelete(order)}
              className="lv-button lv-button-danger lv-button-sm press-scale w-11 px-0"
              title={loc('حذف نهائي من قاعدة البيانات', 'Delete permanently from the database', 'سڕینەوەی هەمیشەیی')}
              aria-label={loc('حذف الطلب نهائياً', 'Permanently delete order', 'سڕینەوەی هەمیشەیی')}
            >
              <Trash2 className="h-4 w-4" aria-hidden />
            </button>
          )}
          {/*
            EXACTLY «تجهيز», and the label is load-bearing beyond this screen:
            scripts/e2e-order-stages.mjs matches this button by EXACT text
            because the status «قيد التجهيز» contains «تجهيز», and a loose
            match there picks a control that is not this one.

            SECONDARY, THOUGH IT IS THE ONLY ACTION. It repeats on every row,
            and thirty cream fills down a dark list is the same mistake as a
            header of coloured chips: weight that marks everything marks
            nothing. The earlier note about a tinted button reading as disabled
            was about a 15%-opacity ghost sitting next to a full-width
            dropdown — both of which are gone.
          */}
          <button
            type="button"
            data-action="prepare"
            data-order-id={order.id}
            onClick={() => onOpen(order.id)}
            className="lv-button lv-button-secondary lv-button-sm press-scale"
          >
            {loc('تجهيز', 'Prepare', 'ئامادەکردن')}
          </button>
        </div>

        {/*
          «زر سريع لتغيير الحالة» — ONE TAP, AND IT NAMES WHERE IT GOES.

          ON ITS OWN LINE, not beside «تجهيز». The label is the customer's own
          stage wording and the longest of them is «جارٍ التجهيز للشحن الجوي»;
          squeezed into the action row it would either clip without saying so
          or push this whole column past the width of a 390px screen. Capped
          and truncated here, with the full sentence in `title` for the few
          that reach the cap.

          THE ICON IS DIRECTIONAL AND THE STYLESHEET TURNS IT. `ChevronsRight`
          inside an RTL row points the way the list reads; it is marked
          aria-hidden because the label already says everything.

          DASHED WHERE THE MOVE IS NOT NORMALLY OURS — the same mark the stage
          panel puts on a courier-owned or clock-owned move, so an admin can
          see that they are doing by hand what Al-Waseet or the sweep would
          otherwise do, and the title says so in words.
        */}
        {order.quick_next && (
          <button
            type="button"
            data-action="quick-advance"
            data-order-id={order.id}
            data-quick-stage={order.quick_next.stage}
            disabled={advancing}
            onClick={() => onAdvance(order)}
            title={
              order.quick_next.source === 'manual'
                ? order.quick_next.label
                : /* OWNER: NO SORANI IS WRITTEN HERE. `loc(ar, en)` with the
                     third argument omitted hands a Kurdish reader the ARABIC
                     sentence, which is the house fallback; an invented Kurdish
                     one on the button that MOVES a live order would be worse
                     than an Arabic one the reader can follow. Both strings
                     below are yours to write by hand. */
                  loc(
                    `${order.quick_next.label} — عادةً تحدّدها شركة التوصيل أو النظام`,
                    `${order.quick_next.label} — normally set by the courier or the system`
                  )
            }
            aria-label={loc(
              `نقل الطلب إلى: ${order.quick_next.label}`,
              `Move order to: ${order.quick_next.label}`
            )}
            className={`lv-button lv-button-secondary lv-button-sm press-scale max-w-[11rem] justify-start gap-1 ${
              order.quick_next.source === 'manual' ? '' : 'border-dashed'
            }`}
          >
            {advancing ? (
              <Loader2 className="h-4 w-4 shrink-0 animate-spin" aria-hidden />
            ) : (
              <ChevronsRight className="h-4 w-4 shrink-0 rtl:-scale-x-100" aria-hidden />
            )}
            <span className="truncate">{order.quick_next.label}</span>
          </button>
        )}
      </div>
    </article>
  );
}
