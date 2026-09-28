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
 * taxonomy resolution as the compare page (`productTypeOf`). They are priced
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
import { Hono, type Context } from 'hono';
import type { AppContext } from '../lib/types';
import { safeParse } from '../lib/types';
import { rateLimit } from '../lib/ratelimit';
import { FINDER_BUDGETS, encodePairs, finderParamPairs, parseFinderParams } from '@levonis/catalog/discovery';
import type { FinderMeta, FinderResponse } from '@levonis/catalog/discoveryTypes';
import { catalogIndexFor, productTypeOf } from '../lib/catalogPresentation';
import { hasLaserModule, runFinder, techGroup, type FinderCandidate } from '../lib/printerFinder';
import { pricingCtx, resolveProductCards, resolveVariantPricing } from './products';
import { multicolorBadge, multicolorProfile, variantSheet } from '../lib/multicolor';
import { hasAnySpec } from './compare';

export const printerFinderRoutes = new Hono<AppContext>();

/** Every printer the shop could possibly sell is well under this. */
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
  const [idx, ctx, rows] = await Promise.all([
    catalogIndexFor(db),
    pricingCtx(c),
    db
      .prepare(
        `SELECT * FROM products
          WHERE status = 'active' AND composition = '' AND spec_fields <> '{}' AND spec_fields <> ''
          ORDER BY is_featured DESC, display_order ASC, created_at DESC
          LIMIT ?`
      )
      .bind(FINDER_CANDIDATE_CAP)
      .all<Record<string, unknown>>()
      .then((r) => r.results ?? []),
  ]);
  const machines: Array<{ row: Record<string, unknown>; type: 'printer' | 'laser'; specs: Record<string, unknown> }> = [];
  for (const row of rows) {
    const type = productTypeOf(row, idx);
    if (type !== 'printer' && type !== 'laser') continue;
    const specs = safeParse<Record<string, unknown>>(String(row.spec_fields ?? '{}'), {});
    if (!specs || typeof specs !== 'object' || Array.isArray(specs) || !hasAnySpec(specs)) continue;
    machines.push({ row, type, specs });
  }
  const machineRows = machines.map((m) => m.row);
  const [cards, pricing] = await Promise.all([
    resolveProductCards(db, machineRows, ctx, idx),
    resolveVariantPricing(db, machineRows, ctx),
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
    const variants = pricing.get(id)?.options ?? [];
    if (variants.length === 0) {
      const price = Number(card.display_price_iqd ?? m.row.price_iqd) || 0;
      regular.set(id, Number(card.display_regular_iqd ?? m.row.price_iqd) || 0);
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
  const key = new Request(`${canonical.origin}${canonical.pathname}?${encodePairs(finderParamPairs(answers))}`, { method: 'GET' });
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
