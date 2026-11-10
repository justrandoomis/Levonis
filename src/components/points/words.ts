/**
 * /points IN THE READER'S LANGUAGE: a line of the points history, its date, and the counts Arabic
 * has to agree with its noun. Pure, so a test reads every language without a page.
 */
import { formatDate } from '../orders/format';

type Lang = 'ar' | 'en' | 'ckb' | string;
type Row3 = readonly [ar: string, en: string, ckb: string];

const pick = (lang: Lang, row: Row3): string => (lang === 'en' ? row[1] : lang === 'ckb' ? row[2] : row[0]);

/** The server's English record of a movement, and what the customer reads for it. In order: the first that matches. */
const LEDGER: ReadonlyArray<readonly [RegExp, Row3]> = [
  [/^Purchase points/, ['نقاط الشراء', 'Purchase points', 'خاڵی کڕین']],
  [/^Points reversal/, ['نقاط طلب أُلغي أو أُرجع', 'Points of a cancelled or returned order', 'خاڵی داواکارییەکی هەڵوەشاوە یان گەڕێنراوە']],
  [/^Points used on order/, ['نقاط استُخدمت في طلب', 'Points used on an order', 'خاڵ لە داواکارییەکدا بەکارهات']],
  [/^Points refund for cancelled order/, ['نقاط عادت من طلب أُلغي', 'Points back from a cancelled order', 'خاڵ لە داواکارییەکی هەڵوەشاوە گەڕایەوە']],
  [/^Valid manual review/, ['نقاط مراجعة', 'Review points', 'خاڵی هەڵسەنگاندن']],
  [/^Points shop product/, ['منتج من متجر النقاط', 'A product from the points shop', 'بەرهەمێک لە فرۆشگای خاڵ']],
  // A coupon the team withdrew gives its points back (row 303 R2): worker/lib/rewards/coupons.ts SHOP_COUPON_BACK_NOTE.
  [/^Points shop refund: coupon/, ['نقاط كوبون سُحب من متجر النقاط', 'Points of a withdrawn points-shop coupon', 'خاڵی کۆپۆنێکی کشێنراوەی فرۆشگای خاڵ']],
  [/^Points shop refund/, ['نقاط منتج أُلغي من متجر النقاط', 'Points of a cancelled points-shop product', 'خاڵی بەرهەمێکی هەڵوەشاوەی فرۆشگای خاڵ']],
  [/^Points shop/, ['كوبون من متجر النقاط', 'A coupon from the points shop', 'کۆپۆنێک لە فرۆشگای خاڵ']],
  [/^Competition prize/, ['جائزة مسابقة', 'Competition prize', 'خەڵاتی پێشبڕکێ']],
  [/^Competition entry not accepted|^Competition cancelled/, ['استرداد اشتراك مسابقة', 'Competition entry refunded', 'گەڕاندنەوەی بەشداریکردنی پێشبڕکێ']],
  [/^Competition entry/, ['الاشتراك في مسابقة', 'Competition entry', 'بەشداریکردن لە پێشبڕکێ']],
];

/**
 * A LEDGER MOVEMENT IN THE READER'S LANGUAGE. Its note is the server's English record
 * (worker/lib/pointsOps.ts, worker/routes/reviews.ts, worker/routes/orders.ts,
 * worker/lib/orderCancelOps.ts, worker/lib/rewards/*); the movements a customer meets are
 * named here, and anything else keeps the record as written.
 */
export function ledgerLabel(note: string, lang: Lang): string {
  const hit = LEDGER.find(([re]) => re.test(note));
  return hit ? pick(lang, hit[1]) : note;
}

/**
 * When a history line happened, in the one date form of the order screens (`formatDate`: Latin
 * digits, the Sorani months written by hand). A dated mission shows its Baghdad day, which is the
 * period it was earned for; everything else shows the instant the server recorded. `day` is never
 * printed on its own: for the one-time push mission it is the word 'once'. The day is read at
 * local noon, so no device's time zone can move it across midnight.
 */
export function historyDate(h: { day: string; awarded_at: string | null }, lang: Lang): string {
  if (/^\d{4}-\d{2}-\d{2}$/.test(h.day)) return formatDate(`${h.day}T12:00:00`, lang);
  return formatDate(h.awarded_at, lang);
}

/** «ثانية واحدة», «ثانيتان», «3 ثوانٍ», «11 ثانية». English and Sorani keep their own short forms beside it. */
export function secondsText(n: number, _lang: 'ar'): string {
  if (n === 1) return 'ثانية واحدة';
  if (n === 2) return 'ثانيتان';
  const r = n % 100;
  return r >= 3 && r <= 10 ? `${n} ثوانٍ` : `${n} ثانية`;
}

/** «تبقّت ثانية واحدة», «تبقّت 4 ثوانٍ», «تبقّت 12 ثانية»: the ad window's clock in Arabic. */
export function secondsLeftText(n: number): string {
  return `تبقّت ${secondsText(n, 'ar')}`;
}

/** The check-in card's heading: the streak, with its noun agreeing, and a sentence for no streak at all. */
export function streakText(n: number, lang: Lang): string {
  if (lang === 'en') return n === 0 ? 'No check-in streak yet' : `You've checked in for ${n} day${n === 1 ? '' : 's'}`;
  if (lang === 'ckb') return n === 0 ? 'هێشتا ڕۆژی یەک لە دوای یەکت نییە' : `${n} ڕۆژی یەک لە دوای یەک ئامادە بوویت`;
  if (n === 0) return 'لا أيام متتالية بعد';
  if (n === 1) return 'سجّلت دخولك يومًا واحدًا';
  if (n === 2) return 'سجّلت دخولك يومين متتاليين';
  const r = n % 100;
  if (r >= 3 && r <= 10) return `سجّلت دخولك ${n} أيام متتالية`;
  return r >= 11 ? `سجّلت دخولك ${n} يومًا متتاليًا` : `سجّلت دخولك ${n} يوم متتالٍ`;
}
