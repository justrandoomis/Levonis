/**
 * THE STORE CHECKOUT'S DELIVERY ANSWER — what the server said this address, or
 * this pickup, costs and when it is ready (merchant platform W2-A).
 *
 * Presentation only. Every figure is the quote's (`StoreQuote.delivery`) or
 * the refusal's (`DeliveryRefusal`), both computed by the Worker from the
 * customer's SAVED address and the merchant's own rules; nothing here prices
 * anything. The page owns the choices (address, fulfilment) and passes the
 * actions in.
 *
 * States, one at a time:
 *   · a fee — «التوصيل إلى بغداد · 3,000», preparation, the ETA line, and how
 *     much more reaches free delivery when the store has a threshold;
 *   · free — by the governorate, the store default, or the threshold (said);
 *   · pickup — where, the store's instructions, preparation;
 *   · unavailable — the store does not deliver there: where it DOES deliver,
 *     and pickup instead when offered;
 *   · an address without a governorate — add it (the page opens the form);
 *   · no address at all — the page shows the form under this.
 */
import { AlertTriangle, Clock, MapPin, Store, Truck } from 'lucide-react';
import { useLanguage } from '../../../LanguageContext';
import { GOVERNORATE_LABELS } from '../../../lib/governorates';
import { iqd, type DeliveryRefusal, type StoreQuoteDelivery } from '../../../lib/merchant';

export function governorateText(id: string | undefined | null, lang: string): string {
  if (!id) return '';
  const g = GOVERNORATE_LABELS[id];
  if (!g) return id;
  return lang === 'en' ? g.en : lang === 'ckb' ? g.ckb : g.ar;
}

export function prepText(days: number, loc: (ar: string, en: string, ckb?: string) => string): string {
  if (!days || days <= 0) return '';
  // OWNER: Sorani to be written by hand.
  if (days === 1) return loc('يُجهَّز خلال يوم واحد', 'Ready to send in 1 day');
  if (days === 2) return loc('يُجهَّز خلال يومين', 'Ready to send in 2 days');
  return loc(`يُجهَّز خلال ${days} أيام`, `Ready to send in ${days} days`);
}

export interface CheckoutDeliveryPanelProps {
  delivery: StoreQuoteDelivery | null;
  blocked: DeliveryRefusal | null;
  /** The goods after the coupon — how far the free-delivery threshold is. */
  merchandiseIqd: number;
  onChoosePickup?: () => void;
  onFixAddress?: () => void;
}

export default function CheckoutDeliveryPanel({ delivery, blocked, merchandiseIqd, onChoosePickup, onFixAddress }: CheckoutDeliveryPanelProps) {
  const { loc, lang } = useLanguage();

  if (blocked) {
    if (blocked.code === 'ADDRESS_REQUIRED') {
      return (
        <p data-delivery-state="address-required" className="text-text-muted text-[12.5px] leading-relaxed">
          {loc('أضف عنوانك الأول لإتمام الطلب.', 'Add your first address to finish the order.', 'ناونیشانێک زیاد بکە.')}
        </p>
      );
    }
    if (blocked.code === 'ADDRESS_GOVERNORATE_REQUIRED') {
      return (
        <div data-delivery-state="governorate-required" role="status" className="lv-alert lv-alert-warning">
          <p className="text-text-primary text-[12.5px] leading-relaxed">
            {/* OWNER: Sorani to be written by hand. */}
            {loc(
              'هذا العنوان بلا محافظة، فلا نعرف أجرة توصيله. أضف المحافظة ثم أكمل.',
              'This address has no governorate, so its delivery cannot be priced. Add the governorate, then continue.'
            )}
          </p>
          {onFixAddress && (
            <button type="button" onClick={onFixAddress} className="lv-button lv-button-secondary lv-button-sm mt-2">
              {/* OWNER: Sorani to be written by hand. */}
              {loc('إضافة المحافظة', 'Add the governorate')}
            </button>
          )}
        </div>
      );
    }
    const pickupOff = blocked.reason === 'pickup_disabled';
    const served = blocked.served ?? [];
    const shown = served.slice(0, 6).map((g) => governorateText(g, lang));
    const more = served.length - shown.length;
    return (
      <div data-delivery-state="unavailable" role="status" className="lv-alert lv-alert-warning space-y-1.5">
        <p className="flex items-start gap-1.5 text-text-primary text-[12.5px] font-semibold leading-relaxed">
          <AlertTriangle aria-hidden="true" className="w-4 h-4 mt-0.5 shrink-0 text-warning" />
          <span>
            {pickupOff
              ? // OWNER: Sorani to be written by hand.
                loc('هذا المتجر لا يوفّر الاستلام من المتجر حاليًا.', 'This store does not offer pickup right now.')
              : // OWNER: Sorani to be written by hand.
                loc(
                  `هذا المتجر لا يوصل إلى ${governorateText(blocked.governorate, lang)}.`,
                  `This store does not deliver to ${governorateText(blocked.governorate, lang)}.`
                )}
          </span>
        </p>
        {!pickupOff && served.length > 0 && (
          <p className="text-text-secondary text-[12px] leading-relaxed">
            {/* OWNER: Sorani to be written by hand. */}
            {loc('يوصل إلى: ', 'Delivers to: ')}
            {shown.join(lang === 'en' ? ', ' : '، ')}
            {more > 0 && loc(` و${more} غيرها`, ` and ${more} more`)}
            {'. '}
            {/* OWNER: Sorani to be written by hand. */}
            {loc('اختر عنوانًا في إحداها.', 'Choose an address in one of them.')}
          </p>
        )}
        {!pickupOff && blocked.pickup && onChoosePickup && (
          <button type="button" onClick={onChoosePickup} className="lv-button lv-button-secondary lv-button-sm">
            <Store aria-hidden="true" className="w-4 h-4" />
            {/* OWNER: Sorani to be written by hand. */}
            {loc(`استلمه من المتجر في ${governorateText(blocked.pickup.governorate, lang)}`, `Collect it from the store in ${governorateText(blocked.pickup.governorate, lang)}`)}
          </button>
        )}
      </div>
    );
  }

  if (!delivery) return null;
  const pickup = delivery.fulfilment === 'pickup';
  const free = delivery.fee_iqd === 0;
  const toFree =
    !pickup && delivery.fee_iqd > 0 && delivery.free_over_iqd ? Math.max(0, delivery.free_over_iqd - merchandiseIqd) : 0;
  const prep = prepText(delivery.prep_days, loc);
  const place = governorateText(delivery.governorate, lang);

  return (
    <div data-delivery-state={pickup ? 'pickup' : free ? 'free' : 'fee'} className="rounded-[var(--radius-md)] bg-white/[0.03] px-3 py-2.5 space-y-1">
      <div className="flex items-start justify-between gap-3">
        <p className="min-w-0 flex items-start gap-1.5 text-text-primary text-[13px] font-semibold leading-snug">
          {pickup ? (
            <Store aria-hidden="true" className="w-4 h-4 mt-0.5 shrink-0 text-text-muted" />
          ) : (
            <Truck aria-hidden="true" className="w-4 h-4 mt-0.5 shrink-0 text-text-muted" />
          )}
          <span className="min-w-0">
            {pickup
              ? // OWNER: Sorani to be written by hand.
                loc(`الاستلام من المتجر في ${place}`, `Pickup from the store in ${place}`)
              : // OWNER: Sorani to be written by hand.
                loc(`التوصيل إلى ${place}`, `Delivery to ${place}`)}
          </span>
        </p>
        <span className={`shrink-0 text-[13px] font-bold tabular-nums ${free ? 'text-success' : 'text-text-primary'}`} dir={free ? undefined : 'ltr'}>
          {free ? loc('مجاني', 'Free', 'بەخۆڕایی') : iqd(delivery.fee_iqd)}
        </span>
      </div>
      {delivery.rule === 'free_over' && delivery.free_over_iqd !== null && (
        <p className="text-success text-[11.5px] ps-[22px]">
          {/* OWNER: Sorani to be written by hand. */}
          {loc('توصيل مجاني لأن طلبك تجاوز ', 'Free because your order is over ')}
          <bdi className="tabular-nums">{iqd(delivery.free_over_iqd)}</bdi>
        </p>
      )}
      {toFree > 0 && (
        <p data-free-over-hint className="text-text-secondary text-[11.5px] ps-[22px]">
          {/* OWNER: Sorani to be written by hand. */}
          {loc('أضف ', 'Add ')}
          <bdi className="tabular-nums font-semibold">{iqd(toFree)}</bdi>
          {loc(' ليصبح التوصيل مجانيًا', ' more for free delivery')}
        </p>
      )}
      {(prep || delivery.eta_note) && (
        <p className="flex items-center gap-1.5 text-text-muted text-[11.5px] ps-[22px]">
          <Clock aria-hidden="true" className="w-3.5 h-3.5 shrink-0" />
          <span dir="auto">{[prep, delivery.eta_note].filter(Boolean).join(' · ')}</span>
        </p>
      )}
      {delivery.note && (
        <p className="flex items-start gap-1.5 text-text-muted text-[11.5px] leading-relaxed ps-[22px]">
          {pickup && <MapPin aria-hidden="true" className="w-3.5 h-3.5 mt-0.5 shrink-0" />}
          <span dir="auto" className="min-w-0 break-words">{delivery.note}</span>
        </p>
      )}
    </div>
  );
}
