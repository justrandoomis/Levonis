/**
 * THE OWNER'S BELL FOR EXCHANGE RATES (FX programme plan §12, critique F15).
 *
 * To the VERIFIED OWNER only — the admin row holding INITIAL_ADMIN_EMAIL with
 * a non-blank verification stamp, the same predicate `adminScope.ts` uses for
 * cost — never by address alone, and never to an admin Telegram topic, which
 * assistants read. It rings when a pair enters review and again every 24
 * hours while it waits, when a source has been failing for 24 hours, and when
 * the safety settings change. IT CARRIES NO FIGURE: no rate, no percentage,
 * no digit at all (tests/fxNotify.test.ts). Each ring has an event key, so a
 * retried run never rings twice. Never throws.
 */
import type { Env } from '../types';
import { notify } from '../notifications';
import type { FxAttention } from './decide';
import type { FxPairId } from './pairs';
import { verifiedOwnerId } from '../verifiedOwner';

export { verifiedOwnerId };

const PAIR_NAME: Readonly<Record<FxPairId, { ar: string; en: string; ckb: string }>> = {
  USD_IQD: { ar: 'الدولار ← الدينار', en: 'USD → IQD', ckb: 'دۆلار ← دینار' },
  EUR_USD: { ar: 'اليورو ← الدولار', en: 'EUR → USD', ckb: 'یۆرۆ ← دۆلار' },
  CNY_USD: { ar: 'اليوان ← الدولار', en: 'CNY → USD', ckb: 'یوان ← دۆلار' },
};

export const FX_NOTICE_TITLE = {
  ar: 'سعر صرف يحتاج انتباهك',
  en: 'An exchange rate needs your attention',
  ckb: 'نرخێکی ئاڵوگۆڕ پێویستی بە سەرنجی تۆیە',
} as const;

export const FX_NOTICE_BODY: Readonly<Record<FxAttention['kind'], { ar: string; en: string; ckb: string }>> = {
  review: {
    ar: 'سعر جديد بانتظار اعتمادك — لم يتغير أي سعر حتى تقرر.',
    en: 'A new rate is waiting for your approval — no price changes until you decide.',
    ckb: 'نرخێکی نوێ چاوەڕێی پەسەندکردنی تۆیە — هیچ نرخێک ناگۆڕێت تا تۆ بڕیار دەدەیت.',
  },
  failing: {
    ar: 'تعذّر جلب السعر منذ يوم كامل — يُستخدم آخر سعر موثوق.',
    en: 'The rate could not be fetched for a whole day — the last known good rate is in use.',
    ckb: 'ماوەی ڕۆژێکی تەواوە نرخەکە وەرنەگیراوە — دوایین نرخی متمانەپێکراو بەکاردێت.',
  },
  guard_change: {
    ar: 'تغيّرت إعدادات حماية أسعار الصرف.',
    en: 'The exchange-rate safety settings were changed.',
    ckb: 'ڕێکخستنەکانی پاراستنی نرخی ئاڵوگۆڕ گۆڕدران.',
  },
};

/** The text of one ring — exported for the no-figure test. */
export function fxNoticeText(a: Pick<FxAttention, 'pair' | 'kind'>) {
  const name = PAIR_NAME[a.pair];
  const body = FX_NOTICE_BODY[a.kind];
  return {
    title_ar: FX_NOTICE_TITLE.ar,
    title_en: FX_NOTICE_TITLE.en,
    title_ckb: FX_NOTICE_TITLE.ckb,
    body_ar: `${name.ar}: ${body.ar}`,
    body_en: `${name.en}: ${body.en}`,
    body_ckb: `${name.ckb}: ${body.ckb}`,
  };
}

export async function notifyOwnerFx(env: Pick<Env, 'DB' | 'INITIAL_ADMIN_EMAIL'>, attentions: readonly FxAttention[]): Promise<void> {
  try {
    if (!attentions.length) return;
    const ownerId = await verifiedOwnerId(env);
    if (!ownerId) return;
    for (const a of attentions) {
      const t = fxNoticeText(a);
      await notify(env.DB, {
        userId: ownerId,
        kind: 'fx_attention',
        title_ar: t.title_ar,
        title_en: t.title_en,
        body_ar: t.body_ar,
        body_en: t.body_en,
        link: '/admin?tab=pricing',
        meta: { title_ckb: t.title_ckb, body_ckb: t.body_ckb, pair: a.pair, reason: a.kind },
        eventKey: a.key,
      });
    }
  } catch (e) {
    console.error('fx: owner notice not written:', e instanceof Error ? e.name : 'unknown');
  }
}

/**
 * FX-5: a product the automatic repricing could not reach (FX programme plan
 * §7.4: the owner's bell rings once per product). The same verified-owner
 * door; no figure and no name (a product name may carry digits) — the pricing
 * tab lists the product with its code.
 */
export const REPRICE_BLOCKED_NOTICE = {
  title: {
    ar: 'منتج يحتاج انتباهك في التسعير',
    en: 'A product needs your attention in pricing',
    ckb: 'بەرهەمێک لە نرخداناندا پێویستی بە سەرنجی تۆیە',
  },
  body: {
    ar: 'تعذّرت إعادة تسعيره تلقائيًا بعد تغيّر سعر معتمد — بقي سعره كما هو. راجعه في «التسعير والشحن».',
    en: 'It could not be repriced automatically after an approved rate changed — its price is unchanged. Review it in Pricing & shipping.',
    ckb: 'دوای گۆڕانی نرخێکی پەسەندکراو نەتوانرا بە خۆکاری نرخەکەی نوێ بکرێتەوە — نرخەکەی وەک خۆی ماوە. لە «نرخدانان و ناردنی بەرهەم» پێیدا بچۆرەوە.',
  },
} as const;

/**
 * The shelf (DECISIONS row 244): a model's shelf sold out and it has no supplier price — it is not sold
 * («يحتاج تسعيرًا») until the owner prices it or stock arrives. No figure, no name.
 */
export const STOCK_SOLD_OUT_NOTICE = {
  title: {
    ar: 'نفد مخزون موديل ولا يوجد سعر مورّد',
    en: 'A model sold out and has no supplier price',
    ckb: 'کۆگای مۆدێلێک نەماوە و نرخی دابینکەری نییە',
  },
  body: {
    ar: 'كان يُسعَّر من المخزون، ونفد مخزونه، ولا يوجد سعر مورّد يُحسب منه سعره — لا يُباع حتى تُسعّره. افتح المنتج في قسم «الأسعار».',
    en: 'It was priced from stock, its shelf is sold out and there is no supplier price to price it from — it is not sold until you price it. Open the product in its Prices section.',
    ckb: 'لە کۆگاوە نرخی بۆ دادەنرا، کۆگاکەی نەماوە و نرخی دابینکەر نییە بۆ ژماردنی نرخەکەی — تا نرخی بۆ دانەنێیت نافرۆشرێت. بەرهەمەکە لە بەشی «نرخەکان» بکەرەوە.',
  },
} as const;

/** The shelf (row 244): the shelf lowered a product's price more than the automatic repricing may publish alone. */
export const STOCK_REVIEW_NOTICE = {
  title: {
    ar: 'تغيّرت تكلفة المخزون لمنتج',
    en: "A product's stock cost changed",
    ckb: 'تێچووی کۆگای بەرهەمێک گۆڕا',
  },
  body: {
    ar: 'انخفضت أعلى تكلفة على الرف كثيرًا، والسعر الأقل يحتاج مراجعتك قبل نشره — بقي سعره كما هو. افتح المنتج في قسم «الأسعار».',
    en: 'The highest cost on the shelf fell a lot and the lower price needs your review before it is published — its price is unchanged. Open the product in its Prices section.',
    ckb: 'بەرزترین تێچوو لەسەر ڕەفەکە زۆر دابەزی و نرخە کەمترەکە پێش بڵاوکردنەوە پێویستی بە پێداچوونەوەی تۆیە — نرخەکەی وەک خۆی ماوە. بەرهەمەکە لە بەشی «نرخەکان» بکەرەوە.',
  },
} as const;

export async function notifyOwnerRepriceBlocked(
  env: Pick<Env, 'DB' | 'INITIAL_ADMIN_EMAIL'>,
  items: ReadonlyArray<{ product_id: string; key: string; reason?: 'stock_sold_out' | 'stock_review' }>
): Promise<void> {
  try {
    if (!items.length) return;
    const ownerId = await verifiedOwnerId(env);
    if (!ownerId) return;
    for (const item of items) {
      const text = item.reason === 'stock_sold_out' ? STOCK_SOLD_OUT_NOTICE : item.reason === 'stock_review' ? STOCK_REVIEW_NOTICE : REPRICE_BLOCKED_NOTICE;
      await notify(env.DB, {
        userId: ownerId,
        kind: 'fx_attention',
        title_ar: text.title.ar,
        title_en: text.title.en,
        body_ar: text.body.ar,
        body_en: text.body.en,
        link: item.reason ? `/admin?tab=products&edit=${encodeURIComponent(item.product_id)}&section=3` : '/admin?tab=pricing',
        meta: { title_ckb: text.title.ckb, body_ckb: text.body.ckb, reason: item.reason ?? 'reprice_blocked', product_id: item.product_id },
        eventKey: item.key,
      });
    }
  } catch (e) {
    console.error('fx: reprice notice not written:', e instanceof Error ? e.name : 'unknown');
  }
}
