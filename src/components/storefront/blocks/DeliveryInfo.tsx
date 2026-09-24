/** DELIVERY — where the store ships and what it says about delivery, from its settings. Prices are checkout's. */
import { MapPin, Truck } from 'lucide-react';
import { useLanguage } from '../../../LanguageContext';
import { BlockHeading, Column, deliveryNote, governorateLabel, useText } from '../parts';
import type { BlockProps } from '../types';

export default function DeliveryInfoBlock({ block, store }: BlockProps<'delivery_info'>) {
  const s = block.settings;
  const { loc, lang } = useLanguage();
  const text = useText();
  const note = s.show_note ? deliveryNote(store) : '';
  const areas = s.show_areas ? (store.service_areas ?? []) : [];
  const from = store.governorate ? governorateLabel(store.governorate, lang) : '';
  if (!note && !areas.length) return null;
  return (
    <Column>
      <BlockHeading title={text(s.title) || loc('التوصيل', 'Delivery', 'گەیاندن')} />
      <div className="sf-card sf-card-pad space-y-3">
        {note && (
          <p className="flex items-start gap-2 text-zinc-300 text-[13px] leading-relaxed">
            <Truck className="w-4 h-4 text-zinc-500 shrink-0 mt-0.5" aria-hidden="true" />
            <span dir="auto">{note}</span>
          </p>
        )}
        {areas.length > 0 && (
          <div className="flex flex-wrap gap-1.5">
            {areas.map((a) => (
              <span key={a} className="text-[11px] px-2.5 py-1 rounded-full border border-white/10 bg-white/[0.03] text-zinc-300 inline-flex items-center gap-1">
                <MapPin className="w-3 h-3 text-zinc-500" aria-hidden="true" />
                {a}
              </span>
            ))}
          </div>
        )}
        {from && <p className="text-zinc-500 text-[11.5px]">{loc(`يشحن من ${from}`, `Ships from ${from}`)}</p>}
      </div>
      {/* OWNER: Sorani to be written by hand. */}
    </Column>
  );
}
