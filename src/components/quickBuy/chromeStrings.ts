/**
 * THE QUICK BUY WORDS THE PRODUCT PAGE DRAWS BEFORE ANY QUICK BUY CHUNK
 * LOADS: the ⚡ toggle, the main button in Quick Buy mode, the activation
 * sheet's name while its chunk arrives, and the line said if it cannot.
 *
 * Split from ./strings.ts on purpose: a module is never split between chunks,
 * and the product page statically importing the feature's full table would
 * put every Quick Buy sentence (the sheet, the orders card, the settings
 * section, thirteen refusals) into the product's opening. These few words
 * ride with the page; everything else arrives with the screen that says it.
 * The bottom navigation's one sentence is ./navStrings.ts, for the same
 * reason one level up (the entry chunk).
 *
 * Hand-written in all three languages; the Sorani is the shop's own wording
 * («کڕینی خێرا», «زیادکردن بۆ سەبەتە»).
 */
export type QuickBuyLang = 'ar' | 'en' | 'ckb';

export interface QuickBuyChromeStrings {
  /** The main button while Quick Buy mode is on (the ⚡ is drawn beside it). */
  cta: string;
  /** The main button while an add is on its way. */
  ctaBusy: string;
  /** The toggle's accessible name; its pressed state says on or off. */
  toggle: string;
  /** The toggle's tooltip: what pressing it does. */
  toggleOnHint: string;
  toggleOffHint: string;
  /** The activation sheet's name while its chunk loads. */
  sheetTitle: string;
  /** Quick Buy's own chunk could not be fetched (a dropped connection, a deploy mid-visit). */
  loadFailed: string;
}

export const QUICK_BUY_CHROME: Record<QuickBuyLang, QuickBuyChromeStrings> = {
  ar: {
    cta: 'شراء سريع',
    ctaBusy: 'جارٍ الشراء السريع…',
    toggle: 'وضع الشراء السريع',
    toggleOnHint: 'تفعيل الشراء السريع لهذا المنتج',
    toggleOffHint: 'العودة إلى «أضف إلى السلة»',
    sheetTitle: 'تفعيل الشراء السريع',
    loadFailed: 'تعذّر تحميل الشراء السريع. تحقق من الاتصال وحاول مرة أخرى.',
  },
  en: {
    cta: 'Quick Buy',
    ctaBusy: 'Quick buying…',
    toggle: 'Quick Buy mode',
    toggleOnHint: 'Turn on Quick Buy for this product',
    toggleOffHint: 'Back to “Add to cart”',
    sheetTitle: 'Activate Quick Buy',
    loadFailed: 'Quick Buy could not load. Check your connection and try again.',
  },
  ckb: {
    cta: 'کڕینی خێرا',
    ctaBusy: 'کڕینی خێرا دەکرێت…',
    toggle: 'دۆخی کڕینی خێرا',
    toggleOnHint: 'کڕینی خێرا بۆ ئەم بەرهەمە چالاک بکە',
    toggleOffHint: 'گەڕانەوە بۆ «زیادکردن بۆ سەبەتە»',
    sheetTitle: 'چالاککردنی کڕینی خێرا',
    loadFailed: 'کڕینی خێرا بار نەبوو. پەیوەندییەکەت بپشکنە و دووبارە هەوڵ بدەرەوە.',
  },
};

export function quickBuyChrome(lang: string): QuickBuyChromeStrings {
  return lang === 'en' ? QUICK_BUY_CHROME.en : lang === 'ckb' ? QUICK_BUY_CHROME.ckb : QUICK_BUY_CHROME.ar;
}
