/**
 * Small formatting shared by Quick Buy's three lazy screens (the activation
 * sheet, the orders card, the settings section), so an address and a policy
 * link read the same way in all of them.
 */
import { GOVERNORATES } from '../../lib/governorates';
import type { QuickBuyFreeDelivery, QuickBuyItemView, QuickBuyPolicyKey } from '../../lib/quickBuy';

/** A line's name in the reader's language: Arabic, Sorani (or the Arabic where none was written), English. */
export function quickBuyItemName(item: Pick<QuickBuyItemView, 'name' | 'name_ar' | 'name_ku'>, lang: string): string {
  const ar = item.name_ar || item.name;
  if (lang === 'en') return item.name || ar;
  if (lang === 'ckb') return item.name_ku || ar;
  return ar;
}

/** The selection as checkout resolved it (option values and colour in one label). */
export function quickBuyItemVariant(item: Pick<QuickBuyItemView, 'variant' | 'option_label' | 'color_label'>): string {
  const label = item.option_label || item.variant || '';
  return [label, item.color_label && !label.includes(item.color_label) ? item.color_label : ''].filter(Boolean).join(' · ');
}

/**
 * The wallet waiver's label in the reader's language: the server's own words
 * (all three languages travel with the view), or `fallback` when it sent none.
 */
export function freeDeliveryLabel(fd: QuickBuyFreeDelivery | null | undefined, lang: string, fallback: string): string {
  const key = lang === 'en' || lang === 'ckb' ? lang : 'ar';
  const all = fd?.labels ?? (fd?.label && typeof fd.label === 'object' ? fd.label : undefined);
  return all?.[key] || (typeof fd?.label === 'string' && key === 'ar' ? fd.label : '') || fallback;
}

/** A governorate id («baghdad») in the reader's language; an unknown id is shown as stored. */
export function governorateName(id: string, lang: string): string {
  const g = GOVERNORATES.find((x) => x.id === id);
  if (!g) return id;
  return lang === 'en' ? g.en : lang === 'ckb' ? g.ckb : g.ar;
}

/** «بغداد، الكرادة، شارع 62 — قرب الجسر»: governorate, area, street, then the landmark. */
export function addressLine(a: { governorate?: string; area?: string; address?: string; landmark?: string }, lang: string): string {
  const sep = lang === 'en' ? ', ' : '، ';
  const place = [a.governorate ? governorateName(a.governorate, lang) : '', a.area, a.address]
    .map((x) => (x ?? '').trim())
    .filter(Boolean)
    .join(sep);
  const landmark = (a.landmark ?? '').trim();
  return landmark ? `${place} — ${landmark}` : place;
}

/** The exact version accepted, opened in a new tab so the sheet behind it keeps its ticks. */
export function policyHref(key: QuickBuyPolicyKey, version: number | null, lang: string): string {
  const docLang = lang === 'en' || lang === 'ckb' ? lang : 'ar';
  return `/policies/${encodeURIComponent(key)}?${version ? `version=${version}&` : ''}lang=${docLang}`;
}
