/**
 * PRICE PROTECTION «حماية السعر» — WHAT THE CUSTOMER READS ABOUT A DECISION.
 *
 * Services V2 S-P0a (price-protection design B.4, B.10; PP-B6): a decision is
 * told to the customer, and a declined claim carries its reason. Staff pick a
 * reason from this short list (and may add a note the customer also reads);
 * the customer reads the sentence in their own language from the code, never
 * the staff's internal material.
 *
 * Shared by the server (the notification it writes in the decision batch) and
 * the client (the claim card and the admin queue), so the two cannot word the
 * same reason differently. Every `ckb` is its own Sorani, never the Arabic
 * pasted across (docs/DECISIONS.md row 183). Pure data: no imports.
 */
export interface PriceProtectionText {
  ar: string;
  en: string;
  ckb: string;
}

export const PRICE_PROTECTION_REASON_CODES = ['no_drop', 'other_item', 'manifest', 'fx', 'returned', 'other'] as const;
export type PriceProtectionReasonCode = (typeof PRICE_PROTECTION_REASON_CODES)[number];

export const isPriceProtectionReasonCode = (v: unknown): v is PriceProtectionReasonCode =>
  typeof v === 'string' && (PRICE_PROTECTION_REASON_CODES as readonly string[]).includes(v);

/** Why a claim was declined, in the customer's words. */
export const PRICE_PROTECTION_REASONS: Record<PriceProtectionReasonCode, PriceProtectionText> = {
  no_drop: {
    ar: 'لم ينخفض سعر القطعة نفسها (نفس الموديل وطريقة الشراء وفئة السعر) خلال مدة الحماية.',
    en: 'The price of this exact item (same model, way of buying and price class) did not fall within the protection period.',
    ckb: 'نرخی هەمان ئەم کاڵایە (هەمان مۆدێل و شێوازی کڕین و پۆلی نرخ) لە ماوەی پاراستندا دانەبەزی.',
  },
  other_item: {
    ar: 'السعر الأقل كان لموديل أو خيار غير الذي اشتريته.',
    en: 'The lower price was for a different model or option than the one you bought.',
    ckb: 'نرخە کەمترەکە بۆ مۆدێل یان هەڵبژاردنێکی تر بوو، نەک ئەوەی تۆ کڕیوتە.',
  },
  manifest: {
    ar: 'كان السعر خطأً ظاهراً صُحّح سريعاً.',
    en: 'The price was a manifest error, corrected quickly.',
    ckb: 'نرخەکە هەڵەیەکی ئاشکرا بوو و خێرا ڕاستکرایەوە.',
  },
  fx: {
    ar: 'الانخفاض ناتج عن سعر الصرف وحده.',
    en: 'The fall came from the exchange rate alone.',
    ckb: 'دابەزینەکە تەنها لە نرخی ئاڵوگۆڕەوە بوو.',
  },
  returned: {
    ar: 'أُرجعت الوحدة واستُرد ثمنها.',
    en: 'The unit was returned and refunded.',
    ckb: 'یەکەکە گەڕێندرایەوە و پارەکەی دراوەتەوە.',
  },
  other: {
    ar: 'لم يُقبل الطلب بعد المراجعة.',
    en: 'The claim was not accepted after review.',
    ckb: 'داواکارییەکە دوای پێداچوونەوە پەسەند نەکرا.',
  },
};

type Lang = keyof PriceProtectionText;

/**
 * The bell row the decision batch writes (event keys `pp:<claim>:credited` /
 * `pp:<claim>:rejected`). `amount` and `item` arrive already formatted; the
 * reason is the template above, then the staff note when there is one.
 */
export const PRICE_PROTECTION_NOTICES = {
  credited: {
    title: (amount: string): PriceProtectionText => ({
      ar: `أُضيف ${amount} إلى محفظتك — حماية السعر`,
      en: `${amount} added to your wallet — price protection`,
      ckb: `${amount} خرایە سەر جزدانەکەت — پاراستنی نرخ`,
    }),
    body: (item: string): PriceProtectionText => ({
      ar: `قبلنا طلب حماية السعر لـ${item}.`,
      en: `Your price-protection claim for ${item} was approved.`,
      ckb: `داواکاریی پاراستنی نرخت بۆ ${item} پەسەند کرا.`,
    }),
  },
  rejected: {
    title: (): PriceProtectionText => ({
      ar: 'لم نقبل طلب حماية السعر',
      en: 'Your price-protection claim was declined',
      ckb: 'داواکاریی پاراستنی نرخت ڕەتکرایەوە',
    }),
    body: (item: string, reason: PriceProtectionText): PriceProtectionText => ({
      ar: `طلبك لـ${item}: ${reason.ar}`,
      en: `Your claim for ${item}: ${reason.en}`,
      ckb: `داواکارییەکەت بۆ ${item}: ${reason.ckb}`,
    }),
  },
  /**
   * WhatsApp, Telegram and email carry the event and where to read it — never
   * the amount or the reason (third-party carriers; the in-app row has both).
   */
  outbound: {
    subject: { ar: 'حماية السعر: بُتّ في طلبك', en: 'Price protection: your claim was decided', ckb: 'پاراستنی نرخ: بڕیار لەسەر داواکارییەکەت درا' } as PriceProtectionText,
    body: (item: string): PriceProtectionText => ({
      ar: `بُتّ في طلب حماية السعر لـ${item}. التفاصيل في صفحة الطلب.`,
      en: `Your price-protection claim for ${item} was decided. The details are on the order page.`,
      ckb: `بڕیار لەسەر داواکاریی پاراستنی نرخت بۆ ${item} درا. وردەکارییەکان لە پەڕەی داواکارییەکەدان.`,
    }),
  },
} as const;

/** The reason a customer reads: the template, then the staff note. Never empty. */
export function priceProtectionReasonText(code: unknown, note: unknown, lang: Lang): string {
  const template = PRICE_PROTECTION_REASONS[isPriceProtectionReasonCode(code) ? code : 'other'][lang];
  const extra = typeof note === 'string' ? note.trim() : '';
  if (!extra) return template;
  // An old claim (before the reason list) has only its note: the note IS the reason.
  if (!isPriceProtectionReasonCode(code)) return extra;
  return `${template} ${extra}`;
}

export function priceProtectionReasonAll(code: unknown, note: unknown): PriceProtectionText {
  return {
    ar: priceProtectionReasonText(code, note, 'ar'),
    en: priceProtectionReasonText(code, note, 'en'),
    ckb: priceProtectionReasonText(code, note, 'ckb'),
  };
}
