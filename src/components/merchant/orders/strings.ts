/**
 * THE ORDERS LIST'S WORDS — Arabic, English and Sorani, every key in all three
 * (docs/MERCHANT_PLATFORM_V2.md workspace §7, decision row 168: real Sorani
 * in a feature's own strings, never the Arabic standing in).
 *
 * The status words themselves are NOT here: `orderStatusLabel` (./labels.ts)
 * is the one place they are written, so the chip on this list and the chip
 * on the order screen can never disagree.
 *
 * Counted nouns follow src/components/community/hub/copy.ts (one, two, 3–10,
 * 11–99, hundreds); Sorani counts with the bare noun; numbers stay LTR islands.
 */
import { useLanguage } from '../../../LanguageContext';

const STRINGS = {
  ar: {
    title: 'الطلبات',
    search: 'رقم الطلب أو اسم الزبون',
    searchHint: 'يُبحث في رقم الطلب واسم الزبون ورقم هاتفه (4 أرقام على الأقل).',
    searchTooLong: 'نص البحث طويل — 60 حرفًا على الأكثر.',
    filterLabel: 'تصفية حسب الحالة',
    all: 'الكل',
    listLabel: 'طلبات متجرك',
    loading: 'جارٍ تحميل الطلبات…',
    emptyFilter: 'لا طلبات بهذا الفلتر',
    emptySearch: 'لا نتائج لـ «{q}»',
    emptyAll: 'لا طلبات بعد',
    emptyAllHint: 'حين يشتري أحد من متجرك يظهر طلبه هنا.',
    error: 'تعذّر تحميل الطلبات.',
    refreshFailed: 'تعذّر التحديث',
    loadMore: 'عرض المزيد',
    loadMoreError: 'تعذّر تحميل المزيد — إعادة المحاولة',
    colOrder: 'الطلب',
    colCustomer: 'الزبون',
    colGovernorate: 'المحافظة',
    colAmount: 'المبلغ',
    colStatus: 'الحالة',
    colSince: 'منذ',
    selected: '{orders} محددة',
    bulkDone: 'حُدّثت {orders}',
    bulkPartial: 'حُدّثت {n}، وتعذّر {m} — الطلب تغيّر قبلك',
    bulkNone: 'لم يُحدَّث أي طلب — تحقّق من حالاتها',
    bulkAsk: 'نقل {orders} إلى «{status}»؟',
    bulkConsequence: 'يُبلَّغ كل زبون بالحالة الجديدة لطلبه.',
    moveConfirmed: 'تأكيد',
    moveProcessing: 'بدء التجهيز',
    moveShipped: 'شحن',
    moveDelivered: 'تم التسليم',
    nextStep: 'الخطوة التالية',
    openOrder: 'فتح الطلب',
    trackingTitle: 'شحن الطلب',
    trackingLabel: 'رقم التتبع (اختياري)',
    trackingHint: 'يراه الزبون في صفحة طلبه.',
    trackingPlaceholder: 'مثال: IQ123456789',
    trackingTooLong: 'رقم التتبع طويل — 60 حرفًا على الأكثر.',
    trackingSaved: 'حُفظ رقم التتبع وسيراه الزبون.',
    tracking: 'التتبع',
    shipConfirm: 'شحن',
    cancel: 'إلغاء',
    exportCsv: 'تصدير CSV',
    exportHint: 'حسب الفلتر الحالي — حتى 5000 طلب.',
    printSlips: 'طباعة ملصقات الشحن',
    printSlip: 'طباعة الملصق',
    printPreparing: 'جارٍ تجهيز الملصقات…',
    printFailed: 'تعذّر تجهيز بعض الملصقات.',
    slipItem: 'المنتج',
    slipQty: 'الكمية',
    slipCollect: 'يُحصَّل عند الاستلام',
    slipPaid: 'مدفوع — لا يُحصَّل شيء عند الاستلام',
    moved: 'انتقل الطلب إلى «{status}»',
  },
  en: {
    title: 'Orders',
    search: 'Order number or customer name',
    searchHint: 'Searches the order number, the customer’s name and their phone (4 digits or more).',
    searchTooLong: 'The search is too long — at most 60 characters.',
    filterLabel: 'Filter by status',
    all: 'All',
    listLabel: 'Your store’s orders',
    loading: 'Loading orders…',
    emptyFilter: 'No orders match this filter',
    emptySearch: 'No results for “{q}”',
    emptyAll: 'No orders yet',
    emptyAllHint: 'When someone buys from your store, their order appears here.',
    error: 'Orders could not be loaded.',
    refreshFailed: 'Could not refresh',
    loadMore: 'Load more',
    loadMoreError: 'Failed to load more — retry',
    colOrder: 'Order',
    colCustomer: 'Customer',
    colGovernorate: 'Governorate',
    colAmount: 'Amount',
    colStatus: 'Status',
    colSince: 'Since',
    selected: '{orders} selected',
    bulkDone: '{orders} updated',
    bulkPartial: '{n} updated, {m} refused — the order changed before you',
    bulkNone: 'No order was updated — check their statuses',
    bulkAsk: 'Move {orders} to “{status}”?',
    bulkConsequence: 'Each customer is told the new status of their order.',
    moveConfirmed: 'Confirm',
    moveProcessing: 'Start preparing',
    moveShipped: 'Ship',
    moveDelivered: 'Delivered',
    nextStep: 'Next step',
    openOrder: 'Open order',
    trackingTitle: 'Ship order',
    trackingLabel: 'Tracking number (optional)',
    trackingHint: 'The customer sees it on their order page.',
    trackingPlaceholder: 'e.g. IQ123456789',
    trackingTooLong: 'The tracking number is too long — at most 60 characters.',
    trackingSaved: 'Tracking number saved; the customer will see it.',
    tracking: 'Tracking',
    shipConfirm: 'Ship',
    cancel: 'Cancel',
    exportCsv: 'Export CSV',
    exportHint: 'The current filter — up to 5,000 orders.',
    printSlips: 'Print packing slips',
    printSlip: 'Print slip',
    printPreparing: 'Preparing the slips…',
    printFailed: 'Some slips could not be prepared.',
    slipItem: 'Item',
    slipQty: 'Qty',
    slipCollect: 'Collect on delivery',
    slipPaid: 'Paid — nothing to collect on delivery',
    moved: 'The order is now “{status}”',
  },
  ckb: {
    title: 'داواکارییەکان',
    search: 'ژمارەی داواکاری یان ناوی کڕیار',
    searchHint: 'لە ژمارەی داواکاری و ناوی کڕیار و ژمارەی مۆبایلەکەی دەگەڕێت (لانیکەم ٤ ژمارە).',
    searchTooLong: 'دەقی گەڕان درێژە — زۆرترین ٦٠ پیت.',
    filterLabel: 'پاڵاوتن بەپێی دۆخ',
    all: 'هەموو',
    listLabel: 'داواکارییەکانی فرۆشگاکەت',
    loading: 'داواکارییەکان بار دەکرێن…',
    emptyFilter: 'هیچ داواکارییەک بەم فلتەرە نییە',
    emptySearch: 'هیچ ئەنجامێک بۆ «{q}» نییە',
    emptyAll: 'هێشتا هیچ داواکارییەک نییە',
    emptyAllHint: 'کاتێک کەسێک لە فرۆشگاکەت دەکڕێت، داواکارییەکەی لێرە دەردەکەوێت.',
    error: 'داواکارییەکان بار نەکران.',
    refreshFailed: 'نوێکردنەوە سەرکەوتوو نەبوو',
    loadMore: 'زیاتر پیشان بدە',
    loadMoreError: 'زیاتر بار نەبوو — دووبارە هەوڵ بدەوە',
    colOrder: 'داواکاری',
    colCustomer: 'کڕیار',
    colGovernorate: 'پارێزگا',
    colAmount: 'بڕی پارە',
    colStatus: 'دۆخ',
    colSince: 'لەمەوبەر',
    selected: '{orders} هەڵبژێردراوە',
    bulkDone: '{orders} نوێکرایەوە',
    bulkPartial: '{n} نوێکرایەوە، {m} ڕەتکرایەوە — داواکارییەکە پێش تۆ گۆڕا',
    bulkNone: 'هیچ داواکارییەک نوێنەکرایەوە — دۆخەکانیان بپشکنە',
    bulkAsk: '{orders} بگوازرێتەوە بۆ «{status}»؟',
    bulkConsequence: 'هەر کڕیارێک لە دۆخی نوێی داواکارییەکەی ئاگادار دەکرێتەوە.',
    moveConfirmed: 'پشتڕاستکردنەوە',
    moveProcessing: 'دەستپێکردنی ئامادەکردن',
    moveShipped: 'ناردن',
    moveDelivered: 'گەیشت',
    nextStep: 'هەنگاوی داهاتوو',
    openOrder: 'کردنەوەی داواکاری',
    trackingTitle: 'ناردنی داواکاری',
    trackingLabel: 'ژمارەی بەدواداچوون (ئارەزوومەندانە)',
    trackingHint: 'کڕیار لە پەڕەی داواکارییەکەیدا دەیبینێت.',
    trackingPlaceholder: 'نموونە: IQ123456789',
    trackingTooLong: 'ژمارەی بەدواداچوون درێژە — زۆرترین ٦٠ پیت.',
    trackingSaved: 'ژمارەی بەدواداچوون پاشەکەوت کرا و کڕیار دەیبینێت.',
    tracking: 'بەدواداچوون',
    shipConfirm: 'ناردن',
    cancel: 'پاشگەزبوونەوە',
    exportCsv: 'هەناردەکردنی CSV',
    exportHint: 'بەپێی فلتەری ئێستا — تا ٥٠٠٠ داواکاری.',
    printSlips: 'چاپکردنی ئێتیکێتەکانی ناردن',
    printSlip: 'چاپکردنی ئێتیکێت',
    printPreparing: 'ئێتیکێتەکان ئامادە دەکرێن…',
    printFailed: 'هەندێک ئێتیکێت ئامادە نەکران.',
    slipItem: 'کاڵا',
    slipQty: 'ژمارە',
    slipCollect: 'لە کاتی وەرگرتندا وەردەگیرێت',
    slipPaid: 'پارە دراوە — لە کاتی وەرگرتندا هیچ وەرناگیرێت',
    moved: 'داواکارییەکە ئێستا «{status}»ـە',
  },
} as const;

type Widen<T> = { [K in keyof T]: T[K] extends string ? string : Widen<T[K]> };
export type OrdersStrings = Widen<(typeof STRINGS)['ar']>;
export type OrdersLang = keyof typeof STRINGS;

export const ORDERS_STRINGS: Record<OrdersLang, OrdersStrings> = STRINGS;

export function ordersLang(lang: string): OrdersLang {
  return lang === 'en' || lang === 'ckb' ? lang : 'ar';
}

export function useOrdersStrings(): OrdersStrings {
  const { lang } = useLanguage();
  return STRINGS[ordersLang(lang)];
}

/** «3 طلبات» / «3 orders» / «3 داواکاری» — the counted noun the sentences above take. */
export function ordersCount(n: number, lang: OrdersLang): string {
  const count = Math.max(0, Math.floor(n));
  if (lang === 'en') return `${count} ${count === 1 ? 'order' : 'orders'}`;
  if (lang === 'ckb') return `${count} داواکاری`;
  if (count === 1) return 'طلب واحد';
  if (count === 2) return 'طلبان';
  const r = count % 100;
  if (r >= 3 && r <= 10) return `${count} طلبات`;
  if (r >= 11 && r <= 99) return `${count} طلبًا`;
  return `${count} طلب`;
}

/** The action word for a move: «تأكيد» for `confirmed`, «شحن» for `shipped`… */
export function moveLabel(s: OrdersStrings, to: string): string {
  switch (to) {
    case 'confirmed': return s.moveConfirmed;
    case 'processing': return s.moveProcessing;
    case 'shipped': return s.moveShipped;
    case 'delivered': return s.moveDelivered;
    default: return to;
  }
}

/** `fill(s.emptySearch, { q })` — the template's `{name}` holes, filled. */
export function fill(template: string, values: Record<string, string | number>): string {
  return template.replace(/\{(\w+)\}/g, (m, key: string) => (key in values ? String(values[key]) : m));
}
