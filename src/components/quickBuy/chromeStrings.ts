/**
 * THE QUICK BUY WORDS THE PRODUCT PAGE DRAWS BEFORE ANY QUICK BUY CHUNK
 * LOADS: the purchase bar's two capsules (./QuickBuyBar.tsx) and what a
 * screen reader hears from them, the activation sheet's name while its chunk
 * arrives, and the line said if it cannot.
 *
 * Split from ./strings.ts on purpose: a module is never split between chunks,
 * and the product page statically importing the feature's full table would
 * put every Quick Buy sentence (the sheet, the orders card, the settings
 * section, every refusal) into the product's opening. These few words ride
 * with the page; everything else arrives with the screen that says it. The
 * bottom navigation's one sentence is ./navStrings.ts, for the same reason.
 *
 * Hand-written in all three languages; the Sorani is the shop's own wording
 * («کڕینی خێرا», «زیادکردن بۆ سەبەتە»).
 */
export type QuickBuyLang = 'ar' | 'en' | 'ckb';

export interface QuickBuyChromeStrings {
  /** The big ⚡ capsule (the ⚡ is drawn beside it). */
  cta: string;
  /** The big ⚡ capsule while a purchase is on its way. */
  ctaBusy: string;
  /** The compact ⚡ capsule's name: what pressing it does. */
  turnOn: string;
  /** The compact 🛒 capsule's name in Quick Buy mode. */
  backToCart: string;
  /** Said politely once the bar has changed mode. */
  modeQuick: string;
  modeCart: string;
  /** The activation sheet's name while its chunk loads. */
  sheetTitle: string;
  /** Quick Buy's own chunk could not be fetched (a dropped connection, a deploy mid-visit). */
  loadFailed: string;
}

export const QUICK_BUY_CHROME: Record<QuickBuyLang, QuickBuyChromeStrings> = {
  ar: {
    cta: 'شراء سريع',
    ctaBusy: 'جارٍ الشراء السريع…',
    turnOn: 'تفعيل الشراء السريع',
    backToCart: 'العودة إلى الإضافة للسلة',
    modeQuick: 'وضع الشراء السريع: زر «شراء سريع» يشتري فورًا من محفظة Levo.',
    modeCart: 'وضع الإضافة إلى السلة.',
    sheetTitle: 'تفعيل الشراء السريع',
    loadFailed: 'تعذّر تحميل الشراء السريع. تحقق من الاتصال وحاول مرة أخرى.',
  },
  en: {
    cta: 'Quick Buy',
    ctaBusy: 'Quick buying…',
    turnOn: 'Turn on Quick Buy',
    backToCart: 'Back to Add to cart',
    modeQuick: 'Quick Buy mode: the “Quick Buy” button buys at once from your Levo Wallet.',
    modeCart: 'Add to cart mode.',
    sheetTitle: 'Activate Quick Buy',
    loadFailed: 'Quick Buy could not load. Check your connection and try again.',
  },
  ckb: {
    cta: 'کڕینی خێرا',
    ctaBusy: 'کڕینی خێرا دەکرێت…',
    turnOn: 'چالاککردنی کڕینی خێرا',
    backToCart: 'گەڕانەوە بۆ زیادکردن بۆ سەبەتە',
    modeQuick: 'دۆخی کڕینی خێرا: دوگمەی «کڕینی خێرا» دەستبەجێ لە جزدانی Levo دەکڕێت.',
    modeCart: 'دۆخی زیادکردن بۆ سەبەتە.',
    sheetTitle: 'چالاککردنی کڕینی خێرا',
    loadFailed: 'کڕینی خێرا بار نەبوو. پەیوەندییەکەت بپشکنە و دووبارە هەوڵ بدەرەوە.',
  },
};

export function quickBuyChrome(lang: string): QuickBuyChromeStrings {
  return lang === 'en' ? QUICK_BUY_CHROME.en : lang === 'ckb' ? QUICK_BUY_CHROME.ckb : QUICK_BUY_CHROME.ar;
}
