/**
 * THE CART WITH NOTHING TO BUY (C7, review of feat/pricing-v2-core 2026-10-14).
 *
 * At the clean start every old cart holds lines of products still «يحتاج تسعيرًا»: they show as unavailable
 * lines, and the cart has no buyable item. «سلتك فارغة» directly under them contradicts what the shopper sees;
 * the empty block then says nothing in the cart can be bought right now. Every string in Arabic, English and
 * real Sorani (DECISIONS row 183).
 */
export interface CartEmptyText {
  ar: string;
  en: string;
  ckb: string;
}

export function cartEmptyText(unavailableLines: number): CartEmptyText {
  if (unavailableLines > 0) {
    return {
      ar: 'لا يوجد في سلتك منتج متاح للشراء الآن',
      en: 'Nothing in your cart can be bought right now.',
      ckb: 'لە سەبەتەکەتدا هیچ بەرهەمێک نییە کە ئێستا بکڕدرێت.',
    };
  }
  return { ar: 'سلتك فارغة', en: 'Your cart is empty.', ckb: 'سەبەتەکەت بەتاڵە.' };
}
