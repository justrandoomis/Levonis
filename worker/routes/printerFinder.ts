/**
 * «مرشد الطابعات» — `/api/printer-finder` and `/api/printer-finder/meta`
 * (docs/ux/CATALOG_DISCOVERY.md §8, §9, §11; IMPLEMENTATION_PLAN.md S6a).
 *
 *   GET /api/printer-finder?use&tech&budget&sale&prio&level
 *       → FinderResponse: up to 3 (or 4) printers with reason and caveat CODES,
 *         what was left out and why, and how well the data covers each priority.
 *   GET /api/printer-finder/meta
 *       → FinderMeta: live counts per technology and per budget range, for the
 *         numbers on questions 2 and 3. Regular prices, viewer-independent.
 *
 * THE CANDIDATES ARE THE SUPPORT ASSISTANT'S: active products with a spec sheet
 * whose catalogue branch resolves to a printer (or a laser machine when «Laser»
 * was asked) — the same rule `handleChoosePrinter` uses, through the same
 * taxonomy resolution as the compare page (`productTypeOf`), applied in SQL
 * before the candidate cap (`productTypeSql`). They are priced
 * for THIS viewer through the listing's one pricing path, so a budget answer
 * reads the number on the customer's own cards.
 *
 * Every answer is parsed by the grammar the page writes its URL with
 * (@levonis/catalog/discovery): an unknown value is dropped, never refused —
 * a finder that 400s on a hand-edited link helps nobody choose a printer.
 *
 * PUBLIC and rate-limited like /api/compare; a signed-out answer is cached for
 * 60 s (the key is the URL, so it only helps repeat answers — which a shared
 * results link is).
 */
import { withCacheEpoch } from '../lib/publicApi/cache';
import { listing } from '../lib/listing';
import { sellableNowOf } from '../lib/commercialState';
import { Hono, type Context } from 'hono';
import type { AppContext } from '../lib/types';
import { safeParse } from '../lib/types';
import { rateLimit } from '../lib/ratelimit';
import { FINDER_BUDGETS, encodePairs, finderParamPairs, parseFinderParams } from '@levonis/catalog/discovery';
import type { FinderMeta, FinderResponse } from '@levonis/catalog/discoveryTypes';
import { catalogIndexFor, productTypeOf, productTypeSql } from '../lib/catalogPresentation';
import { hasLaserModule, runFinder, techGroup, type FinderCandidate } from '../lib/printerFinder';
import { pricingCtx, resolveProductCards, resolveVariantPricing } from './products';
import { multicolorBadge, multicolorProfile, variantSheet } from '../lib/multicolor';
import { hasAnySpec } from './compare';
import { isUsdCents } from '@levonis/pricing/usdCents';

export const printerFinderRoutes = new Hono<AppContext>();

/** Every printer and laser machine the shop could possibly sell is well under this (the cap counts machines only). */
export const FINDER_CANDIDATE_CAP = 300;

function edgeCache(): Cache | null {
  return typeof caches !== 'undefined' ? ((caches as unknown as { default?: Cache }).default ?? null) : null;
}

interface Loaded {
  candidates: FinderCandidate<Record<string, unknown>>[];
  regular: Map<string, number>;
}

async function loadCandidates(c: Context<AppContext>): Promise<Loaded> {
  const db = c.env.DB;
  const [L, idx, ctx] = await Promise.all([listing(db), catalogIndexFor(db), pricingCtx(c)]);
  /**
   * ONLY MACHINES REACH THE CAP. The type rule used to run in JS after the
   * LIMIT, so the 300 slots went to whatever visible product with a spec sheet
   * sorted first — filaments and parts too — and live the finder saw 2 of 18
   * printers. `productTypeSql` is the same rule (`productTypeOf`) as a SQL
   * condition on the printer and laser sections, applied before the LIMIT; the
   * JS check below stays the final word.
   */
  const machinesOnly = productTypeSql(idx, ['printer', 'laser']);
  const rows = await db
    .prepare(
      // VISIBLE with each row's SELLABLE flag (DECISIONS row 240): priced machines first (rule R1).
      `SELECT *, ${L.sellableFlag('products')} AS sellable_now FROM products
        WHERE ${L.visible('products')} AND composition = '' AND spec_fields <> '{}' AND spec_fields <> ''
          AND ${machinesOnly.sql}
        ORDER BY sellable_now DESC, is_featured DESC, display_order ASC, created_at DESC
        LIMIT ?`
    )
    .bind(...machinesOnly.binds, FINDER_CANDIDATE_CAP)
    .all<Record<string, unknown>>()
    .then((r) => r.results ?? []);
  const machines: Array<{ row: Record<string, unknown>; type: 'printer' | 'laser'; specs: Record<string, unknown> }> = [];
  for (const row of rows) {
    const type = productTypeOf(row, idx);
    if (type !== 'printer' && type !== 'laser') continue;
    const specs = safeParse<Record<string, unknown>>(String(row.spec_fields ?? '{}'), {});
    if (!specs || typeof specs !== 'object' || Array.isArray(specs) || !hasAnySpec(specs)) continue;
    machines.push({ row, type, specs });
  }
  const machineRows = machines.map((m) => m.row);
  // The resolver never runs over a catalog-only row: its money columns hold the archived ladder.
  const [cards, pricing] = await Promise.all([
    resolveProductCards(db, machineRows, ctx, idx, 'flag'),
    resolveVariantPricing(db, machineRows.filter((r) => sellableNowOf(r)), ctx),
  ]);
  const regular = new Map<string, number>();
  /**
   * EVERY WAY TO BUY A MACHINE IS A CANDIDATE. «A1» (one colour) and «A1
   * Combo» (four, with the AMS lite in the box) are two machines at two
   * prices, and a budget or a colour answer can be met by one and not the
   * other. Each configuration carries its own sheet (`variantSheet`: the
   * product's, then the option's allow-listed differences) and its own price
   * from the product page's resolver; `runFinder` then shows the best one per
   * printer. A product with no options is one candidate, as before.
   */
  const candidates: FinderCandidate<Record<string, unknown>>[] = [];
  machines.forEach((m, rank) => {
    const id = String(m.row.id);
    const card = cards.get(id) ?? {};
    const productAvailable = Math.max(0, Number(card.direct_stock_available ?? 0) || 0);
    const leaf = String(m.row.sub_category_id || m.row.category_id || '');
    const sectionSlugs = leaf ? idx.branch(leaf).map((n) => n.slug) : [];
    if (!sellableNowOf(m.row)) {
      // Catalog-only: shown with no price, never in a budget, ranked after the priced (rule R5).
      const specs = variantSheet(m.specs, null);
      candidates.push({ id, productId: id, card: withMulticolor(card, specs), productType: m.type, price: null, available: 0, sectionSlugs, specs, rank, variant: null });
      return;
    }
    const variants = pricing.get(id)?.options ?? [];
    if (variants.length === 0) {
      // Never the row's own column: a priced card always carries its display price.
      const price = typeof card.display_price_iqd === 'number' ? card.display_price_iqd : null;
      regular.set(id, typeof card.display_regular_iqd === 'number' ? card.display_regular_iqd : 0);
      const specs = variantSheet(m.specs, null);
      candidates.push({ id, productId: id, card: withMulticolor(card, specs), productType: m.type, price, available: productAvailable, sectionSlugs, specs, rank, variant: null });
      return;
    }
    for (const v of variants) {
      const key = `${id}:${v.option.id}`;
      const specs = variantSheet(m.specs, v.option);
      // The viewer-independent figure for /meta: the regular rung plus the
      // same direct-sale premium the applied price carries.
      regular.set(key, v.level.regular_iqd + (v.level.unit_subtotal_iqd - v.level.applied_iqd));
      candidates.push({
        id: key,
        productId: id,
        card: withMulticolor(card, specs),
        productType: m.type,
        price: v.level.unit_subtotal_iqd,
        // The model's own shelf when it is tracked; the product's otherwise.
        available: productAvailable > 0 ? (v.available ?? productAvailable) : 0,
        sectionSlugs,
        specs,
        rank,
        variant: {
          option_id: v.option.id,
          label: {
            ar: v.option.name_ar || v.option.name_en,
            en: v.option.name_en || v.option.name_ar,
            ckb: v.option.name_ckb || v.option.name_ar || v.option.name_en,
          },
          price_iqd: v.level.unit_subtotal_iqd,
          others: variants.length - 1,
          // FX-7: the lowest of the configuration's own SKUs when they differ («يبدأ من»).
          ...(v.from ? { from: true } : {}),
          // The configuration's own dollars (DECISIONS row 248): its applied price's twin, never the card's «from».
          ...(isUsdCents(v.level.applied_usd_cents) && v.level.applied_iqd > 0 && v.level.applied_iqd <= v.level.unit_subtotal_iqd
            ? { applied_iqd: v.level.applied_iqd, applied_usd_cents: v.level.applied_usd_cents }
            : {}),
        },
      });
    }
  });
  return { candidates, regular };
}

/** The card plus what its configuration does with colour, as codes (the page writes the words). */
function withMulticolor(card: Record<string, unknown>, specs: Record<string, unknown>): Record<string, unknown> {
  return { ...card, multicolor: multicolorBadge(multicolorProfile(specs)) };
}

printerFinderRoutes.get('/meta', async (c) => {
  await rateLimit(c, 'finder-read', 120, 60);
  const { candidates, regular } = await loadCandidates(c);
  const printers = candidates.filter((x) => x.productType === 'printer');
  // Counted per PRINTER: a product counts once when any configuration of it matches.
  const products = (list: typeof candidates) => new Set(list.map((x) => x.productId ?? x.id)).size;
  const techs = {
    fdm: products(printers.filter((x) => techGroup(x) === 'fdm')),
    resin: products(printers.filter((x) => techGroup(x) === 'resin')),
    laser: products(candidates.filter((x) => x.productType === 'laser' || hasLaserModule(x.specs))),
  };
  const budgets = Object.entries(FINDER_BUDGETS).map(([range, r]) => ({
    range,
    count: products(printers.filter((x) => {
      if (x.price === null) return false;
      const p = regular.get(x.id) ?? x.price;
      return p >= r.min && (r.max === null || p <= r.max);
    })),
  }));
  const body: FinderMeta = { success: true, techs, budgets, total: products(printers) };
  const res = c.json(body);
  // Regular prices only, so every viewer sees the same numbers.
  res.headers.set('Cache-Control', 'public, max-age=60, s-maxage=300');
  return res;
});

printerFinderRoutes.get('/', async (c) => {
  await rateLimit(c, 'finder-read', 120, 60);
  const answers = parseFinderParams((k) => c.req.query(k));
  const signedOut = !c.get('user');
  const cache = signedOut ? edgeCache() : null;
  // Keyed by the CANONICAL answers, not the raw URL: junk parameters and key
  // order must not mint new cache entries, and two equal answer sets share one.
  const canonical = new URL(c.req.url);
  // The clean start (A.4): the catalogue epoch, so no answer cached before it is ever served.
  const key = new Request(withCacheEpoch(`${canonical.origin}${canonical.pathname}?${encodePairs(finderParamPairs(answers))}`), { method: 'GET' });
  if (cache) {
    const hit = await cache.match(key).catch(() => undefined);
    // With this route's own lifetime, not the zone's four-hour Browser Cache
    // TTL that Cloudflare puts on a hit (worker/routes/catalog.ts `cached`).
    if (hit) {
      const res = new Response(hit.body, hit);
      res.headers.set('Cache-Control', 'public, max-age=60');
      return res;
    }
  }
  const { candidates } = await loadCandidates(c);
  const outcome = runFinder(candidates, answers);
  const body: FinderResponse<Record<string, unknown>> = { success: true, answers, ...outcome };
  const res = c.json(body);
  res.headers.set('Cache-Control', signedOut ? 'public, max-age=60' : 'private, no-store');
  if (cache) {
    const put = cache.put(key, res.clone()).catch(() => undefined);
    try {
      c.executionCtx.waitUntil(put);
    } catch {
      await put;
    }
  }
  return res;
});
