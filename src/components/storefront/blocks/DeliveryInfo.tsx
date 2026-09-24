/**
 * DELIVERY — where the store delivers and for how much, from the merchant's
 * delivery rules (W2-A: the public store payload's `delivery`, and the
 * visitor's own «التوصيل إلى …» when they are signed in with a saved address).
 * Display only: the checkout prices again from the customer's saved address.
 * A store served by an older API (no `delivery`) keeps showing its note and
 * free-text service areas, as before.
 */
import { Clock, MapPin, Store as StoreIcon, Truck } from 'lucide-react';
import { useLanguage } from '../../../LanguageContext';
import { BlockHeading, Column, deliveryNote, deliveryToYou, governorateLabel, useText } from '../parts';
import type { BlockProps } from '../types';

const money = (n: number, lang: string) => `${Number(n).toLocaleString('en-US')} ${lang === 'en' ? 'IQD' : 'د.ع'}`;

export default function DeliveryInfoBlock({ block, store }: BlockProps<'delivery_info'>) {
  const s = block.settings;
  const { loc, lang } = useLanguage();
  const text = useText();
  const d = store.delivery;
  const note = s.show_note ? deliveryNote(store) : '';
  const toYou = deliveryToYou(store, loc, lang);
  const areas = s.show_areas ? (d ? d.areas : []) : [];
  const legacyAreas = s.show_areas && !d ? (store.service_areas ?? []) : [];
  const from = store.governorate ? governorateLabel(store.governorate, lang) : '';
  if (!note && !areas.length && !legacyAreas.length && !toYou && !d?.pickup) return null;
  return (
    <Column>
      <BlockHeading title={text(s.title) || loc('التوصيل', 'Delivery', 'گەیاندن')} />
      <div className="sf-card sf-card-pad space-y-3">
        {toYou && (
          <p className="flex items-center justify-between gap-3 text-[13.5px]" data-delivery-to-you>
            <span className="flex items-center gap-2 text-zinc-200 font-semibold min-w-0">
              <Truck className="w-4 h-4 text-zinc-500 shrink-0" aria-hidden="true" />
              <span className="truncate">{toYou.title}</span>
            </span>
            <span className={`shrink-0 font-bold tabular-nums ${toYou.available ? 'text-zinc-100' : 'text-zinc-500'}`}>{toYou.subtitle}</span>
          </p>
        )}
        {note && (
          <p className="flex items-start gap-2 text-zinc-300 text-[13px] leading-relaxed">
            <Truck className="w-4 h-4 text-zinc-500 shrink-0 mt-0.5" aria-hidden="true" />
            <span dir="auto">{note}</span>
          </p>
        )}
        {areas.length > 0 && (
          <ul className="flex flex-wrap gap-1.5" aria-label={loc('يوصل إلى', 'Delivers to')}>
            {areas.map((a) => (
              <li key={a.governorate} className="text-[11px] px-2.5 py-1 rounded-full border border-white/10 bg-white/[0.03] text-zinc-300 inline-flex items-center gap-1">
                <MapPin className="w-3 h-3 text-zinc-500" aria-hidden="true" />
                {governorateLabel(a.governorate, lang)}
                <span className="text-zinc-500">·</span>
                <span className={a.free ? 'text-emerald-400' : 'tabular-nums'}>{a.free ? loc('مجاني', 'Free', 'بەخۆڕایی') : money(a.fee_iqd, lang)}</span>
              </li>
            ))}
          </ul>
        )}
        {legacyAreas.length > 0 && (
          <div className="flex flex-wrap gap-1.5">
            {legacyAreas.map((a) => (
              <span key={a} className="text-[11px] px-2.5 py-1 rounded-full border border-white/10 bg-white/[0.03] text-zinc-300 inline-flex items-center gap-1">
                <MapPin className="w-3 h-3 text-zinc-500" aria-hidden="true" />
                {a}
              </span>
            ))}
          </div>
        )}
        {d?.free_over_iqd ? (
          <p className="text-emerald-400/90 text-[12px]">
            {/* OWNER: Sorani to be written by hand. */}
            {loc(`توصيل مجاني للطلبات فوق ${money(d.free_over_iqd, lang)}`, `Free delivery on orders over ${money(d.free_over_iqd, lang)}`)}
          </p>
        ) : null}
        {d?.pickup && (
          <p className="flex items-start gap-2 text-zinc-300 text-[12.5px] leading-relaxed">
            <StoreIcon className="w-4 h-4 text-zinc-500 shrink-0 mt-0.5" aria-hidden="true" />
            <span>
              {/* OWNER: Sorani to be written by hand. */}
              {loc(`الاستلام من المتجر في ${governorateLabel(d.pickup.governorate, lang)}`, `Pickup from the store in ${governorateLabel(d.pickup.governorate, lang)}`)}
              {d.pickup.note && <span className="block text-zinc-500 text-[11.5px]" dir="auto">{d.pickup.note}</span>}
            </span>
          </p>
        )}
        {d && d.prep_days > 0 && (
          <p className="flex items-center gap-2 text-zinc-500 text-[11.5px]">
            <Clock className="w-3.5 h-3.5 shrink-0" aria-hidden="true" />
            {/* OWNER: Sorani to be written by hand. */}
            {loc(`يُجهَّز الطلب خلال ${d.prep_days} يوم`, `Orders are prepared within ${d.prep_days} day${d.prep_days === 1 ? '' : 's'}`)}
          </p>
        )}
        {from && <p className="text-zinc-500 text-[11.5px]">{loc(`يشحن من ${from}`, `Ships from ${from}`)}</p>}
      </div>
      {/* OWNER: Sorani to be written by hand. */}
    </Column>
  );
}
