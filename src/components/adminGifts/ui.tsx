/** Small shared pieces of the admin gifts screens. */
import type React from 'react';
import SafeImage from '../ui/SafeImage';
import { StatusChip, type Tone } from '../ui/Badge';
import { formatIqd } from '../../lib/api';
import { adminText, statusKey, whyText, type AdminLang } from './strings';
import type { GiftStatus, ItemView, Tri } from './types';

export const triOf = (lang: AdminLang, t: Tri | null | undefined): string => (t ? (t[lang] || t.ar || t.en || '').trim() : '');

const STATUS_TONE: Record<GiftStatus, Tone> = {
  GRANTED: 'accent',
  READY_TO_REDEEM: 'accent',
  REDEEMED: 'success',
  ADDED_TO_ORDER: 'info',
  ORDERED: 'info',
  FULFILLED: 'success',
  CANCELLED: 'neutral',
  LEGACY: 'neutral',
};

export function GiftStatusChip({ lang, status }: { lang: AdminLang; status: GiftStatus }) {
  return <StatusChip tone={STATUS_TONE[status] ?? 'neutral'}>{adminText(lang, statusKey(status))}</StatusChip>;
}

export function saleText(lang: AdminLang, item: Pick<ItemView, 'sale_type' | 'transport_method'>): string {
  if (item.sale_type !== 'pre_order') return adminText(lang, 'saleDirect');
  const route = item.transport_method === 'air' ? 'routeAir' : item.transport_method === 'sea' ? 'routeSea' : item.transport_method === 'land' ? 'routeLand' : null;
  return route ? `${adminText(lang, 'salePreorder')} · ${adminText(lang, route)}` : adminText(lang, 'salePreorder');
}

/** One product a gift grants: picture, name, model · colour, sale type × qty, value, availability. */
export function ItemRow({ lang, item, trailing }: { lang: AdminLang; item: ItemView; trailing?: React.ReactNode }) {
  const name = (item.name.en || item.name.ar || '').trim();
  const variant = triOf(lang, item.variant);
  const color = item.color ? triOf(lang, item.color) : '';
  return (
    <div className="flex items-start gap-3 min-w-0">
      <div className="w-12 h-12 shrink-0 overflow-hidden rounded-lg bg-zinc-900">
        <SafeImage src={item.image} alt={name} aspect="auto" className="w-full h-full" bgClassName="bg-zinc-900" fallbackClassName="text-zinc-600" />
      </div>
      <div className="min-w-0 flex-1">
        <p className="text-[13px] font-semibold leading-snug text-[var(--ap-text-1)] line-clamp-2">
          <bdi>{name}</bdi>
        </p>
        <p className="mt-0.5 flex flex-wrap items-center gap-x-1.5 text-[12px] leading-relaxed text-[var(--ap-text-2)]">
          {variant && <span>{variant}</span>}
          {variant && color && <span aria-hidden="true">·</span>}
          {color && (
            <span className="inline-flex items-center gap-1">
              {item.color?.hex && (
                <span aria-hidden="true" className="inline-block w-3 h-3 shrink-0 rounded-full border border-white/30" style={{ backgroundColor: item.color.hex }} />
              )}
              {color}
            </span>
          )}
        </p>
        <p className="mt-0.5 text-[12px] leading-relaxed text-[var(--ap-text-3)]">
          {saleText(lang, item)} · {adminText(lang, 'qty')} {item.qty}
          {item.value_iqd > 0 ? ` · ${adminText(lang, 'value')} ${formatIqd(item.value_iqd)}` : ''}
        </p>
        {item.available === false && (
          <p className="mt-1 text-[12px] text-warning">
            {adminText(lang, 'unavailable')}
            {item.reason ? (
              <>
                {' — '}
                <bdi>{whyText(lang, item.reason)}</bdi>
              </>
            ) : null}
          </p>
        )}
      </div>
      {trailing}
    </div>
  );
}
