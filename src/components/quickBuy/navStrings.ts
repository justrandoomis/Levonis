/**
 * THE ACCOUNT TAB'S NAME WHILE A SESSION IS COLLECTING, so a screen reader
 * hears the time the «⚡ mm:ss» chip shows (./QuickBuyNavChip.tsx).
 *
 * Its own module because a module is never split between chunks: the chip's
 * lazy chunk carries this one sentence, while the product page's toggle words
 * (./chromeStrings.ts) and the feature's sentences (./strings.ts) stay with
 * the screens that say them. Hand-written in all three languages.
 */
export function quickBuyNavLabel(lang: string, time: string): string {
  if (lang === 'en') return `Quick Buy: ${time} left`;
  if (lang === 'ckb') return `کڕینی خێرا: کاتی ماوە ${time}`;
  return `الشراء السريع: الوقت المتبقي ${time}`;
}
