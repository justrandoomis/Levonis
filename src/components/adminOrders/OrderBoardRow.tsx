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
 * ONE PRIMARY ACTION. The per-row status dropdown that used to sit here moved
 * into the modal's stage panel, which is already the authority for where an
 * order is — the page's own history records the mis-tap it caused
 * («عند تحديث الطلب يظهر خيارين فقط») as a real incident.
 */
import { Trash2 } from 'lucide-react';
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
  deleting,
}: {
  order: AdminOrderRow;
  loc: (ar: string, en: string, ckb?: string) => string;
  onOpen: (id: string) => void;
  onDelete: (order: AdminOrderRow) => void;
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
      </div>
    </article>
  );
}
