/**
 * PRICING V2 — THE OWNER'S BELL WHEN A PRICE EDITOR PUBLISHES BELOW COST +
 * MINIMUM PROFIT (owner answer Q3, DECISIONS row 222; spec addendum A.1 Q3).
 *
 * A typed dollar price below cost + minimum profit SAVES (it is never blocked
 * and never moved). The owner sees the warning in his own preview and review
 * sheet (`v2_below_min_profit`, owner-only). When a PRICE EDITOR's write
 * produces it, the same batch rings the verified owner's bell once per
 * product and write: the product id and name only, never a figure. The
 * editor's own answer says nothing — it would be a cost oracle.
 *
 * Kind `fx_attention`: the owner-only pricing notices' kind, which every
 * other reader's bell already hides (notifications.ts
 * HIDE_OWNER_FINANCE_NOTICES_SQL).
 */
import type { Env } from '../../types';
import { notifyStatement } from '../../notifications';
import { verifiedOwnerId } from '../../verifiedOwner';
import type { V2Evaluation } from './evaluate';
import type { V2Viewer } from './api';

export const BELOW_MIN_PROFIT_EVENT = 'pricing.v2.below_min_profit';

export const BELOW_MIN_PROFIT_NOTICE = {
  title: {
    ar: 'سعر تحت الحد الأدنى للربح',
    en: 'A price below the minimum profit',
    ckb: 'نرخێک لە خوار کەمترین قازانجەوە',
  },
  body: {
    ar: 'نُشر سعر بالدولار أقل من التكلفة + الحد الأدنى للربح. السعر محفوظ ومعروض للزبائن؛ راجعه في قسم «الأسعار».',
    en: 'A dollar price below cost plus the minimum profit was published. It is saved and on sale; review it in the Prices section.',
    ckb: 'نرخێکی دۆلاری کە لە تێچوو + کەمترین قازانج کەمترە بڵاوکرایەوە. نرخەکە پاشەکەوتکراوە و بۆ کڕیاران دیارە؛ لە بەشی «نرخەکان» پێیدا بچۆرەوە.',
  },
} as const;

/** A product row's name for the bell's meta (Arabic first, as the admin lists show it). */
export const productNameOf = (row: Record<string, unknown>): string | null => {
  for (const k of ['name_ar', 'name', 'name_en']) if (typeof row[k] === 'string' && (row[k] as string).trim()) return (row[k] as string).trim();
  return null;
};

/** Did this evaluation price any SKU below its cost + minimum profit (price-first, Q3)? */
export const belowMinProfit = (ev: Pick<V2Evaluation, 'result' | 'method'>): boolean =>
  ev.method === 'usd' && !!ev.result?.skus.some((s) => s.channels.some((c) => c.below_min_profit));

/**
 * The bell's statement for a COMPLETE write by a price editor that publishes a
 * price below cost + minimum profit — none otherwise (the owner's own write,
 * an incomplete save, no verified owner). Laid in the write's own batch.
 */
export async function belowMinProfitBell(env: Pick<Env, 'DB' | 'INITIAL_ADMIN_EMAIL'>, ev: V2Evaluation, viewer: V2Viewer, name: string | null): Promise<D1PreparedStatement[]> {
  if (viewer !== 'editor' || !ev.complete || !belowMinProfit(ev)) return [];
  const ownerId = await verifiedOwnerId(env);
  if (!ownerId) return [];
  const pid = ev.product_id;
  const { stmt } = notifyStatement(env.DB, {
    userId: ownerId,
    kind: 'fx_attention',
    title_ar: BELOW_MIN_PROFIT_NOTICE.title.ar,
    title_en: BELOW_MIN_PROFIT_NOTICE.title.en,
    body_ar: BELOW_MIN_PROFIT_NOTICE.body.ar,
    body_en: BELOW_MIN_PROFIT_NOTICE.body.en,
    link: `/admin?tab=products&edit=${encodeURIComponent(pid)}&section=3`,
    entity_type: 'product',
    entity_id: pid,
    meta: {
      title_ckb: BELOW_MIN_PROFIT_NOTICE.title.ckb,
      body_ckb: BELOW_MIN_PROFIT_NOTICE.body.ckb,
      reason: BELOW_MIN_PROFIT_EVENT,
      product_id: pid,
      ...(name ? { product_name: name } : {}),
    },
    eventKey: `${BELOW_MIN_PROFIT_EVENT}:${pid}:${ev.hash ?? 'save'}`,
  });
  return [stmt];
}
