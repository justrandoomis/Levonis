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
import { pricingCtx, resolveProductCards } from './products';
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
  const cards = await resolveProductCards(db, machines.map((m) => m.row), ctx, idx);
  const regular = new Map<string, number>();
  const candidates = machines.map((m, rank) => {
    const id = String(m.row.id);
    const card = cards.get(id) ?? {};
    const price = Number(card.display_price_iqd ?? m.row.price_iqd) || 0;
    regular.set(id, Number(card.display_regular_iqd ?? m.row.price_iqd) || 0);
    const leaf = String(m.row.sub_category_id || m.row.category_id || '');
    return {
      id,
      card,
      productType: m.type,
      price,
      available: Math.max(0, Number(card.direct_stock_available ?? 0) || 0),
      sectionSlugs: leaf ? idx.branch(leaf).map((n) => n.slug) : [],
      specs: m.specs,
      rank,
    };
  });
  return { candidates, regular };
}

printerFinderRoutes.get('/meta', async (c) => {
  await rateLimit(c, 'finder-read', 120, 60);
  const { candidates, regular } = await loadCandidates(c);
  const printers = candidates.filter((x) => x.productType === 'printer');
  const techs = {
    fdm: printers.filter((x) => techGroup(x) === 'fdm').length,
    resin: printers.filter((x) => techGroup(x) === 'resin').length,
    laser: candidates.filter((x) => x.productType === 'laser' || hasLaserModule(x.specs)).length,
  };
  const budgets = Object.entries(FINDER_BUDGETS).map(([range, r]) => ({
    range,
    count: printers.filter((x) => {
      const p = regular.get(x.id) ?? x.price;
      return p >= r.min && (r.max === null || p <= r.max);
    }).length,
  }));
  const body: FinderMeta = { success: true, techs, budgets, total: printers.length };
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
    if (hit) return hit;
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
