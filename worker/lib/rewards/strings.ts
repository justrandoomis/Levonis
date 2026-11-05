/**
 * What the rewards programme tells a customer, in the three languages
 * (CLAUDE.md «Languages»: a ckb slot never carries a copy of the Arabic,
 * docs/DECISIONS.md row 183). In-app notifications only: the Arabic and
 * English ride in the row's columns, the Sorani in `meta.title_ckb` /
 * `meta.body_ckb` like every other kind (worker/lib/notifications.ts).
 *
 * The words are the app's own: «كوبون» / «کۆپۆن», «الفلامنت» / «فیلامێنت»,
 * «صفحة المكافآت» / «پەڕەی خەڵاتەکان», «نقطة» / «خاڵ».
 */
import type { RewardCouponKind } from './config';

export interface Trilingual {
  ar: string;
  en: string;
  ckb: string;
}

export interface RewardText {
  title: Trilingual;
  body: Trilingual;
}

type CouponTerms = { percent: number; amount: number; min: number; pieces: number; kinds: readonly RewardCouponKind[] };

type Params =
  | ({ kind: 'printer_coupons'; count: number; until: string } & CouponTerms)
  | ({ kind: 'weekly_coupons'; until: string } & CouponTerms)
  | { kind: 'coupons_expiring'; count: number; until: string }
  | { kind: 'competition_won'; title: Trilingual; place: number; points: number }
  | { kind: 'competition_refund'; title: Trilingual; points: number };

const n = (v: number) => Math.max(0, Math.trunc(v)).toLocaleString('en-US');
const capital = (s: string) => `${s.charAt(0).toUpperCase()}${s.slice(1)}`;
const pick = (t: Trilingual, lang: keyof Trilingual) => t[lang] || t.ar;

/** What a printer's coupons are, in a phrase: the amounts are the owner's settings. */
function couponsPhrase(p: CouponTerms): { what: Trilingual; both: boolean } {
  const both = p.kinds.includes('free_shipping') && p.kinds.includes('filament_discount');
  const shipOnly = !both && p.kinds.includes('free_shipping');
  const hasMin = p.min > 0;
  const ship: Trilingual = {
    ar: `كوبون توصيل مجاني بقيمة ${n(p.amount)} د.ع${hasMin ? ` للطلبات فوق ${n(p.min)} د.ع` : ''}`,
    en: `a free-delivery coupon worth ${n(p.amount)} IQD${hasMin ? ` on orders over ${n(p.min)} IQD` : ''}`,
    ckb: `کۆپۆنێکی گەیاندنی بەخۆڕایی بە بەهای ${n(p.amount)} دینار${hasMin ? ` بۆ داواکارییەکانی سەرووی ${n(p.min)} دینار` : ''}`,
  };
  const k = Math.max(1, Math.trunc(p.pieces));
  const filament: Trilingual = {
    ar: `كوبون خصم ${p.percent}% على ${k === 1 ? 'قطعة واحدة' : k === 2 ? 'قطعتين' : k <= 10 ? `${k} قطع` : `${k} قطعة`} من الفلامنت المختار`,
    en: `a ${p.percent}% coupon on ${k === 1 ? 'one piece' : `${k} pieces`} of the selected filament`,
    ckb: `کۆپۆنێکی ${p.percent}% داشکاندن لەسەر ${k === 1 ? 'یەک' : k} پارچە لە فیلامێنتی هەڵبژێردراو`,
  };
  const what: Trilingual = both
    ? { ar: `${ship.ar} و${filament.ar}`, en: `${ship.en} and ${filament.en}`, ckb: `${ship.ckb} و ${filament.ckb}` }
    : shipOnly
      ? ship
      : filament;
  return { what, both };
}

export function rewardText(p: Params): RewardText {
  switch (p.kind) {
    case 'weekly_coupons': {
      const { what, both } = couponsPhrase(p);
      return {
        title: {
          ar: '🎁 كوبونات هذا الأسبوع جاهزة',
          en: "🎁 This week's coupons are ready",
          ckb: '🎁 کۆپۆنەکانی ئەم هەفتەیە ئامادەن',
        },
        body: both
          ? {
              ar: `لكل طابعة عندك: ${what.ar}. صالحة حتى ${p.until}، ويمكنك جمعها كلها في طلب واحد. تجدها في صفحة المكافآت.`,
              en: `For each of your printers: ${what.en}. Valid until ${p.until}, and you can use them all on one order. Find them on the Rewards page.`,
              ckb: `بۆ هەر چاپکەرێکت: ${what.ckb}. تا ${p.until} بەکاردێن، و دەتوانیت هەموویان لە یەک داواکاریدا بەکاربهێنیت. لە پەڕەی خەڵاتەکان دەیاندۆزیتەوە.`,
            }
          : {
              ar: `لكل طابعة عندك: ${what.ar}. صالح حتى ${p.until}. تجده في صفحة المكافآت.`,
              en: `For each of your printers: ${what.en}. Valid until ${p.until}. Find it on the Rewards page.`,
              ckb: `بۆ هەر چاپکەرێکت: ${what.ckb}. تا ${p.until} بەکاردێت. لە پەڕەی خەڵاتەکان دەیدۆزیتەوە.`,
            },
      };
    }
    case 'printer_coupons': {
      const { what, both } = couponsPhrase(p);
      const many = p.count > 1;
      return {
        title: {
          ar: '🎁 كوبونات طابعتك جاهزة',
          en: '🎁 Your printer coupons are ready',
          ckb: '🎁 کۆپۆنەکانی چاپکەرەکەت ئامادەن',
        },
        body: many
          ? {
              ar: `لكل طابعة من طابعاتك (${n(p.count)}): ${what.ar}، صالحة حتى ${p.until}. تجدها في صفحة المكافآت.`,
              en: `For each of your ${n(p.count)} printers: ${what.en}, valid until ${p.until}. Find them on the Rewards page.`,
              ckb: `بۆ هەر یەکێک لە ${n(p.count)} چاپکەرەکەت: ${what.ckb}، تا ${p.until} بەکاردێن. لە پەڕەی خەڵاتەکان دەیاندۆزیتەوە.`,
            }
          : both
            ? {
                ar: `${what.ar}، صالحان حتى ${p.until}. تجدهما في صفحة المكافآت.`,
                en: `${capital(what.en)}, valid until ${p.until}. Find them on the Rewards page.`,
                ckb: `${what.ckb}، تا ${p.until} بەکاردێن. لە پەڕەی خەڵاتەکان دەیاندۆزیتەوە.`,
              }
            : {
                ar: `${what.ar}، صالح حتى ${p.until}. تجده في صفحة المكافآت.`,
                en: `${capital(what.en)}, valid until ${p.until}. Find it on the Rewards page.`,
                ckb: `${what.ckb}، تا ${p.until} بەکاردێت. لە پەڕەی خەڵاتەکان دەیدۆزیتەوە.`,
              },
      };
    }
    case 'coupons_expiring':
      return {
        title: {
          ar: p.count > 1 ? '⏳ كوبونات مكافأتك تنتهي قريبًا' : '⏳ كوبون مكافأتك ينتهي قريبًا',
          en: p.count > 1 ? '⏳ Your reward coupons end soon' : '⏳ Your reward coupon ends soon',
          ckb: p.count > 1 ? '⏳ کۆپۆنەکانی خەڵاتەکەت بەم زووانە کۆتایی دێن' : '⏳ کۆپۆنی خەڵاتەکەت بەم زووانە کۆتایی دێت',
        },
        body:
          p.count > 1
            ? {
                ar: `لديك ${n(p.count)} من كوبونات المكافأة لم تستخدمها بعد، تنتهي في ${p.until}. استخدمها قبل ذلك من صفحة المكافآت.`,
                en: `${n(p.count)} of your reward coupons are still unused and end on ${p.until}. Use them before then from the Rewards page.`,
                ckb: `${n(p.count)} کۆپۆنی خەڵاتت هێشتا بەکارنەهاتوون و لە ${p.until} کۆتایی دێن. پێش ئەوە لە پەڕەی خەڵاتەکان بەکاریان بهێنە.`,
              }
            : {
                ar: `كوبون المكافأة الذي لديك لم تستخدمه بعد، وينتهي في ${p.until}. استخدمه قبل ذلك من صفحة المكافآت.`,
                en: `Your reward coupon is still unused and ends on ${p.until}. Use it before then from the Rewards page.`,
                ckb: `کۆپۆنی خەڵاتەکەت هێشتا بەکارنەهاتووە و لە ${p.until} کۆتایی دێت. پێش ئەوە لە پەڕەی خەڵاتەکان بەکاری بهێنە.`,
              },
      };
    case 'competition_won': {
      const pts = p.points > 0;
      return {
        title: {
          ar: `🏆 فزت في مسابقة «${pick(p.title, 'ar')}»`,
          en: `🏆 You won in «${pick(p.title, 'en')}»`,
          ckb: `🏆 لە پێشبڕکێی «${pick(p.title, 'ckb')}» براوە بوویت`,
        },
        body: {
          ar: `حللت في المركز ${n(p.place)}${pts ? ` وأُضيفت ${n(p.points)} نقطة إلى رصيدك` : ''}. شكرًا لمشاركتك!`,
          en: `You placed ${n(p.place)}${pts ? `, and ${n(p.points)} points were added to your balance` : ''}. Thank you for taking part!`,
          ckb: `پلەی ${n(p.place)}ت بەدەستهێنا${pts ? ` و ${n(p.points)} خاڵ خرایە سەر باڵانسەکەت` : ''}. سوپاس بۆ بەشداریکردنت!`,
        },
      };
    }
    case 'competition_refund':
      return {
        title: {
          ar: `↩️ أُلغيت مسابقة «${pick(p.title, 'ar')}»`,
          en: `↩️ «${pick(p.title, 'en')}» was cancelled`,
          ckb: `↩️ پێشبڕکێی «${pick(p.title, 'ckb')}» هەڵوەشێنرایەوە`,
        },
        body: {
          ar: `أعدنا إلى رصيدك ${n(p.points)} نقطة دفعتها للمشاركة.`,
          en: `The ${n(p.points)} points you paid to enter are back in your balance.`,
          ckb: `ئەو ${n(p.points)} خاڵەی بۆ بەشداریکردن دابووت گەڕێنرایەوە بۆ باڵانسەکەت.`,
        },
      };
  }
}

/** Shorthand for the coupons module's notice on delivery. */
export function rewardNotice(
  kind: 'printer_coupons',
  p: { count: number; until: string; percent: number; amount: number; min: number; pieces: number; kinds?: readonly RewardCouponKind[] }
): RewardText {
  return rewardText({ kind, count: p.count, until: p.until, percent: p.percent, amount: p.amount, min: p.min, pieces: p.pieces, kinds: p.kinds ?? ['free_shipping', 'filament_discount'] });
}
