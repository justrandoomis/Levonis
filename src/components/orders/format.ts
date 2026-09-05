/**
 * Shared formatting for the customer's order screens — one place for the
 * date locale, the legacy status labels and the item-count wording, so the
 * list card and the detail header cannot disagree about any of them.
 *
 * Numerals stay Latin in every language ("8 items", "8 منتجات"): the order
 * id, the tracking number and the amounts beside them are Latin already, and
 * a card mixing two digit systems reads as two documents.
 */
import type { OrderStatus } from '../../lib/api';

export type Lang = 'ar' | 'en' | 'ckb';

export function asLang(lang: string): Lang {
  return lang === 'en' || lang === 'ckb' ? lang : 'ar';
}

export function dateLocale(lang: string): string {
  return lang === 'en' ? 'en-GB' : 'ar-IQ-u-nu-latn';
}

export function formatDate(iso: string | null | undefined, lang: string): string {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return new Intl.DateTimeFormat(dateLocale(lang), { year: 'numeric', month: 'short', day: 'numeric' }).format(d);
}

export function formatDateTime(iso: string | null | undefined, lang: string): string {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return new Intl.DateTimeFormat(dateLocale(lang), {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  }).format(d);
}

/** The six legacy statuses, as the card's pill names them. */
export const STATUS_LABELS: Record<Lang, Record<OrderStatus, string>> = {
  ar: {
    pending: 'بانتظار الدفع',
    confirmed: 'بانتظار الشحن',
    processing: 'قيد التجهيز',
    shipped: 'مشحونة',
    delivered: 'تم التوصيل',
    cancelled: 'ملغية',
  },
  en: {
    pending: 'Pending payment',
    confirmed: 'To ship',
    processing: 'Processing',
    shipped: 'Shipped',
    delivered: 'Delivered',
    cancelled: 'Cancelled',
  },
  ckb: {
    pending: 'چاوەڕێی پارەدان',
    confirmed: 'چاوەڕێی ناردن',
    processing: 'لە جێبەجێکردندایە',
    shipped: 'نێردراوە',
    delivered: 'گەیەنراوە',
    cancelled: 'هەڵوەشێنراوەتەوە',
  },
};

export const STATUS_STYLES: Record<OrderStatus, string> = {
  pending: 'bg-amber-500/10 text-amber-300 border-amber-500/20',
  confirmed: 'bg-sky-500/10 text-sky-300 border-sky-500/20',
  processing: 'bg-sky-500/10 text-sky-300 border-sky-500/20',
  shipped: 'bg-indigo-500/10 text-indigo-300 border-indigo-500/20',
  delivered: 'bg-emerald-500/10 text-emerald-300 border-emerald-500/20',
  cancelled: 'bg-red-500/10 text-red-300 border-red-500/20',
};

export function statusLabel(lang: string, status: OrderStatus | string): string {
  const table = STATUS_LABELS[asLang(lang)];
  return (table as Record<string, string>)[status] ?? String(status);
}

export function statusStyle(status: OrderStatus | string): string {
  return (STATUS_STYLES as Record<string, string>)[status] ?? 'bg-zinc-800 text-zinc-300 border-zinc-700';
}

/** "8 items" — Arabic takes its dual and its two plurals honestly. */
export function itemCountLabel(n: number, lang: string): string {
  const l = asLang(lang);
  if (l === 'en') return n === 1 ? '1 item' : `${n} items`;
  if (l === 'ckb') return `${n} کاڵا`;
  if (n === 1) return 'منتج واحد';
  if (n === 2) return 'منتجان';
  if (n >= 3 && n <= 10) return `${n} منتجات`;
  return `${n} منتجًا`;
}

/** "3 days left" — used by warranty and the return window alike. */
export function daysLeftLabel(n: number, lang: string): string {
  const l = asLang(lang);
  if (l === 'en') return n === 1 ? '1 day left' : `${n} days left`;
  if (l === 'ckb') return `${n} ڕۆژ ماوە`;
  if (n === 1) return 'يوم واحد متبقٍ';
  if (n === 2) return 'يومان متبقيان';
  if (n >= 3 && n <= 10) return `${n} أيام متبقية`;
  return `${n} يومًا متبقيًا`;
}

/**
 * "24 months" — Arabic takes its dual and its two plurals honestly (شهر واحد /
 * شهران / N أشهر / N شهرًا); the digits stay Latin like every other number on
 * the order and warranty screens.
 */
export function monthsLabel(n: number, lang: string): string {
  const l = asLang(lang);
  if (l === 'en') return n === 1 ? '1 month' : `${n} months`;
  if (l === 'ckb') return `${n} مانگ`;
  if (n === 1) return 'شهر واحد';
  if (n === 2) return 'شهران';
  if (n >= 3 && n <= 10) return `${n} أشهر`;
  return `${n} شهرًا`;
}

/** Sum of quantities when the server did not send `item_count`. */
export function countItems(items: Array<{ qty: number }>, fallback?: number): number {
  if (typeof fallback === 'number') return fallback;
  return items.reduce((n, it) => n + (Number(it.qty) || 0), 0);
}
