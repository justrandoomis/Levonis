/**
 * «اسم الشراء» — A STOCK PURCHASE'S NAME (owner request 2026-10-10: «لا يمكن
 * تسمية المخزون»).
 *
 * The name is `purchase_orders.invoice_no`: every reader already shows it as
 * the purchase's name (the register, receiving, the investor-finance labels,
 * the participant report), so the one field holds a name or an invoice
 * number. It sits above the purchase's four steps, and a saved purchase is
 * renamed at any status through `PATCH /documents/:id/name`.
 *
 * Every word in Arabic, English and Sorani — the Sorani its own, never the
 * Arabic (docs/DECISIONS.md row 183). Pure: no React, no request.
 */
import type { Language } from '../../translations';

export interface PurchaseNameStrings {
  label: string;
  placeholder: string;
  hint: string;
  fallback: string;
  reviewRow: string;
  details: string;
  rename: string;
  save: string;
  saved: string;
  cancel: string;
}

export const PURCHASE_NAME_STRINGS: Readonly<Record<Language, PurchaseNameStrings>> = {
  ar: {
    label: 'اسم الشراء أو رقم الفاتورة',
    placeholder: 'مثل: شحنة ألمانيا — تشرين الأول',
    hint: 'يظهر في قائمة المشتريات والاستلام والتقارير. لا تكتب فيه أسعارًا.',
    fallback: 'شراء بلا اسم',
    reviewRow: 'الاسم',
    details: 'الموقع والوصول المتوقع والتتبع',
    rename: 'تغيير الاسم',
    save: 'حفظ الاسم',
    saved: 'تم حفظ اسم الشراء',
    cancel: 'إلغاء',
  },
  en: {
    label: 'Purchase name or invoice number',
    placeholder: 'e.g. Germany shipment — October',
    hint: 'Shown in the purchase list, receiving and reports. Do not put prices in it.',
    fallback: 'Unnamed purchase',
    reviewRow: 'Name',
    details: 'Location, arrival and tracking',
    rename: 'Rename',
    save: 'Save name',
    saved: 'Purchase name saved',
    cancel: 'Cancel',
  },
  ckb: {
    label: 'ناوی کڕین یان ژمارەی پسوولە',
    placeholder: 'بۆ نموونە: باری ئەڵمانیا — تشرینی یەکەم',
    hint: 'لە لیستی کڕینەکان و وەرگرتن و ڕاپۆرتەکاندا دەردەکەوێت. نرخی تێدا مەنووسە.',
    fallback: 'کڕینی بێ ناو',
    reviewRow: 'ناوی کڕین',
    details: 'شوێن و گەیشتنی چاوەڕوانکراو و بەدواداچوون',
    rename: 'گۆڕینی ناو',
    save: 'پاشەکەوتکردنی ناو',
    saved: 'ناوی کڕینەکە پاشەکەوت کرا',
    cancel: 'هەڵوەشاندنەوە',
  },
};

export const purchaseNameStrings = (lang: Language): PurchaseNameStrings => PURCHASE_NAME_STRINGS[lang] ?? PURCHASE_NAME_STRINGS.ar;

/** The longest name the rename accepts (the server's `PURCHASE_NAME_TOO_LONG`). */
export const PURCHASE_NAME_MAX = 120;

/** A name as the server stores it: whitespace collapsed, trimmed. */
export const purchaseNameText = (typed: string): string => typed.replace(/\s+/g, ' ').trim();

/** The name is short enough to save. */
export const purchaseNameFits = (typed: string): boolean => purchaseNameText(typed).length <= PURCHASE_NAME_MAX;
