/**
 * «طلب السعر» — THE WORDS OF A PRICE REQUEST (DECISIONS rows 239 (4) and 240;
 * migration 0193).
 *
 * Pure data and pure functions, shared by the Worker (the customer
 * notification, the admin digest, the queue's per-selection labels) and the
 * client (the admin queue and products list). Every `ckb` is its own Sorani,
 * never the Arabic pasted across (DECISIONS row 183).
 */
export interface PriceRequestText {
  ar: string;
  en: string;
  ckb: string;
}

export type PriceRequestLang = keyof PriceRequestText;

/** The states a request moves through (migration 0193's CHECK). Counts read `open` only. */
export const PRICE_REQUEST_STATES = ['open', 'priced', 'notified', 'closed'] as const;
export type PriceRequestState = (typeof PRICE_REQUEST_STATES)[number];

/** Defaults of the owner's brief (spec §10, D12): one constant each. */
export const PRICE_REQUEST_LIMITS = Object.freeze({
  /** Open requests one person may hold across the shop. */
  openPerUser: 50,
  /** Open selections one person may hold on one product. */
  openPerProduct: 20,
});

/**
 * «N أشخاص طلبوا السعر» — the admin's count, never shown to a customer
 * (default D11). Arabic carries the dual and the 3–10 / 11+ forms.
 */
export function requestersText(n: number, lang: PriceRequestLang): string {
  const count = Math.max(0, Math.trunc(Number(n) || 0));
  if (lang === 'en') {
    if (count === 0) return 'No price requests';
    return count === 1 ? '1 person requested the price' : `${count} people requested the price`;
  }
  if (lang === 'ckb') {
    if (count === 0) return 'هیچ داواکارییەکی نرخ نییە';
    if (count === 1) return 'یەک کەس داوای نرخی کردووە';
    return `${count} کەس داوای نرخیان کردووە`;
  }
  if (count === 0) return 'لا طلبات سعر';
  if (count === 1) return 'شخص واحد طلب السعر';
  if (count === 2) return 'شخصان طلبا السعر';
  if (count <= 10) return `${count} أشخاص طلبوا السعر`;
  return `${count} شخصاً طلبوا السعر`;
}

/** The admin's other words (the queue and the products list). */
export const PRICE_REQUEST_ADMIN_TEXT = {
  last_request: { ar: 'آخر طلب', en: 'Last request', ckb: 'دوایین داواکاری' },
  most_requested: { ar: 'الأكثر طلباً', en: 'Most requested', ckb: 'زۆرترین داواکراو' },
  set_price: { ar: 'تحديد السعر', en: 'Set price', ckb: 'دیاریکردنی نرخ' },
  sort_requests: { ar: 'الأكثر طلباً للسعر', en: 'Most price requests', ckb: 'زۆرترین داواکاری نرخ' },
  count_chip: { ar: 'طلبات السعر', en: 'Price requests', ckb: 'داواکارییەکانی نرخ' },
  /** The whole product, when a request names no option or colour. */
  whole_product: { ar: 'المنتج نفسه', en: 'The product itself', ckb: 'خودی بەرهەمەکە' },
} as const satisfies Record<string, PriceRequestText>;

/**
 * THE CUSTOMER'S NOTIFICATION when the product (or the selection) they asked
 * about is priced and can be bought — `{name}` is the product's name, with the
 * selection's label after « — » when the request named one.
 */
export const PRICE_AVAILABLE_TEXT = {
  title: { ar: 'صار السعر متوفراً', en: 'The price is now available', ckb: 'نرخ ئێستا بەردەستە' },
  body: {
    ar: '{name}: يمكنك الآن رؤية السعر والشراء.',
    en: '{name}: you can now see the price and buy.',
    ckb: '{name}: ئێستا دەتوانیت نرخەکە ببینیت و بیکڕیت.',
  },
} as const;

export function priceAvailableMessage(name: PriceRequestText): { title: PriceRequestText; body: PriceRequestText } {
  const fill = (template: string, value: string) => template.split('{name}').join(value);
  return {
    title: { ...PRICE_AVAILABLE_TEXT.title },
    body: {
      ar: fill(PRICE_AVAILABLE_TEXT.body.ar, name.ar || name.en),
      en: fill(PRICE_AVAILABLE_TEXT.body.en, name.en || name.ar),
      ckb: fill(PRICE_AVAILABLE_TEXT.body.ckb, name.ckb || name.ar || name.en),
    },
  };
}

/**
 * THE ADMIN DIGEST'S THRESHOLDS (spec §4.7): a product is announced when its
 * distinct requesters cross one of these since its last announcement — 1, 3,
 * 10, 25, 50, 100, then every further 100 — never once per request.
 */
export const DIGEST_STEPS = [1, 3, 10, 25, 50, 100] as const;

/** The highest threshold at or below `n` (0 below the first). */
export function digestThreshold(n: number): number {
  const count = Math.max(0, Math.trunc(Number(n) || 0));
  if (count >= 100) return Math.floor(count / 100) * 100;
  let t = 0;
  for (const s of DIGEST_STEPS) if (count >= s) t = s;
  return t;
}

/** Did the count cross a threshold since the last announced count? */
export const crossedDigestThreshold = (now: number, announced: number): boolean => digestThreshold(now) > digestThreshold(announced);
