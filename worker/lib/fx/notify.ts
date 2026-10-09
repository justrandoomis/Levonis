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

/** The verified owner's user id, or null (no owner address, or not verified yet). */
export async function verifiedOwnerId(env: Pick<Env, 'DB' | 'INITIAL_ADMIN_EMAIL'>): Promise<string | null> {
  const owner = (env.INITIAL_ADMIN_EMAIL ?? '').trim().toLowerCase();
  if (!owner) return null;
  const row = await env.DB
    .prepare(
      `SELECT id FROM users
        WHERE lower(trim(email)) = ? AND role = 'admin' AND trim(COALESCE(email_verified_at, '')) <> ''
        ORDER BY id LIMIT 1`
    )
    .bind(owner)
    .first<{ id: string }>();
  return row?.id ?? null;
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

export async function notifyOwnerRepriceBlocked(env: Pick<Env, 'DB' | 'INITIAL_ADMIN_EMAIL'>, items: ReadonlyArray<{ product_id: string; key: string }>): Promise<void> {
  try {
    if (!items.length) return;
    const ownerId = await verifiedOwnerId(env);
    if (!ownerId) return;
    for (const item of items) {
      await notify(env.DB, {
        userId: ownerId,
        kind: 'fx_attention',
        title_ar: REPRICE_BLOCKED_NOTICE.title.ar,
        title_en: REPRICE_BLOCKED_NOTICE.title.en,
        body_ar: REPRICE_BLOCKED_NOTICE.body.ar,
        body_en: REPRICE_BLOCKED_NOTICE.body.en,
        link: '/admin?tab=pricing',
        meta: { title_ckb: REPRICE_BLOCKED_NOTICE.title.ckb, body_ckb: REPRICE_BLOCKED_NOTICE.body.ckb, reason: 'reprice_blocked', product_id: item.product_id },
        eventKey: item.key,
      });
    }
  } catch (e) {
    console.error('fx: reprice notice not written:', e instanceof Error ? e.name : 'unknown');
  }
}
