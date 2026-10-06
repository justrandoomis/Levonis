/**
 * THE GIFT LINE IN THE CART AND THE CHECKOUT SUMMARY (docs/REVIEWS_GIFTS.md §6.3, §8 C3).
 *
 * `GET /api/cart` sends a gift line as `{kind:'gift', locked:true,
 * unit_price_iqd:0, gift:{entitlement_id, level, value_iqd}, availability}`.
 * The SERVER alone decides that a line is a gift and that it costs 0: this
 * module only reads what was sent, so a screen can draw the line as a gift —
 * the «هدية» chip, 0 IQD with the gift's value beside it, no quantity stepper,
 * no option or warranty editors, a remove button — and nothing here prices,
 * unlocks or edits anything.
 *
 * Kept apart from ./giftStrings.ts on purpose: the cart and the checkout load
 * these few words, never the whole /gifts table.
 */

/** The `gift` block of a cart line (or of a quote line that carries one). */
export interface CartGiftBlock {
  entitlement_id: string;
  level: number;
  /** The product's regular price — the gift's value, shown and never charged. */
  value_iqd: number;
}

/**
 * The gift block of a line, or null for an ordinary line. A line is a gift
 * when the server said `kind: 'gift'` or attached a `gift` block naming an
 * entitlement; either fact alone is the server's.
 */
export function giftLineOf(line: unknown): CartGiftBlock | null {
  if (!line || typeof line !== 'object') return null;
  const l = line as { kind?: unknown; gift?: unknown; is_gift?: unknown };
  const block = l.gift && typeof l.gift === 'object' ? (l.gift as Record<string, unknown>) : null;
  const named = !!block && typeof block.entitlement_id === 'string' && block.entitlement_id !== '';
  if (l.kind !== 'gift' && !named && l.is_gift !== true) return null;
  const level = Number(block?.level);
  const value = Number(block?.value_iqd);
  return {
    entitlement_id: named ? String(block?.entitlement_id) : '',
    level: Number.isFinite(level) && level > 0 ? Math.trunc(level) : 0,
    value_iqd: Number.isFinite(value) && value > 0 ? Math.round(value) : 0,
  };
}

const ar = {
  badge: 'هدية',
  levelBadge: 'هدية المستوى {level}',
  worth: 'قيمتها {value}',
  fixed: 'سطر هدية ثابت: لا تتغير كميته ولا خياراته.',
  removeHint: 'إن حذفتها من السلة تعود إلى صفحة هداياي جاهزة للطلب.',
};

export type GiftLineKey = keyof typeof ar;

const en: Record<GiftLineKey, string> = {
  badge: 'Gift',
  levelBadge: 'Level {level} gift',
  worth: 'Worth {value}',
  fixed: 'A gift line is fixed: its quantity and options cannot change.',
  removeHint: 'If you remove it from the cart, it goes back to My gifts, ready to order.',
};

const ckb: Record<GiftLineKey, string> = {
  badge: 'دیاری',
  levelBadge: 'دیاریی ئاستی {level}',
  worth: 'بەهاکەی {value}',
  fixed: 'هێڵی دیاری جێگیرە: بڕ و هەڵبژاردنەکانی ناگۆڕدرێن.',
  removeHint: 'ئەگەر لە سەبەتەکە لای ببەیت، دەگەڕێتەوە بۆ دیارییەکانم و ئامادە دەبێت بۆ داواکردن.',
};

export const GIFT_LINE_STRINGS: Readonly<Record<'ar' | 'en' | 'ckb', Readonly<Record<GiftLineKey, string>>>> = { ar, en, ckb };

/** One gift-line sentence in the reader's language, `{hole}`s filled. */
export function giftLineText(lang: string, key: GiftLineKey, vars?: Record<string, string | number>): string {
  const table = GIFT_LINE_STRINGS[lang === 'en' || lang === 'ckb' ? lang : 'ar'];
  const raw = table[key];
  if (!vars) return raw;
  return raw.replace(/\{(\w+)\}/g, (whole, name: string) => (name in vars ? String(vars[name]) : whole));
}
