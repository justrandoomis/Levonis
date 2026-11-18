import { Hono } from 'hono';
import type { AppContext } from '../lib/types';
import { str } from '../lib/http';
import { identifierKey, rateLimit } from '../lib/ratelimit';
import { listing } from '../lib/listing';
import { bestSellerIds } from '../lib/homeShelves';

export const searchTrendingRoutes = new Hono<AppContext>();
/** Baghdad's calendar day, matching the shop's reporting timezone. */
export const searchDay = (now = Date.now()) => Math.floor((now + 3 * 3_600_000) / 86_400_000);
const missingMigration = (error: unknown) => /no such table:?\s*search_selection_visitors/i.test(String(error));

searchTrendingRoutes.post('/selection', async (c) => {
  await rateLimit(c, 'search-selection', 30, 3600);
  const body = await c.req.json().catch(() => ({}));
  const id = str(body.product_id, 'product_id', { max: 100 });
  const gate = await listing(c.env.DB);
  const product = await c.env.DB.prepare(`SELECT p.id FROM products p WHERE p.id = ? AND ${gate.visible('p')}`).bind(id).first();
  if (!product) return c.json({ success: true, recorded: false });
  const day = searchDay();
  // Daily salt; no raw query, email, IP or account id enters the trends table.
  const viewer = c.get('user')?.id || c.req.header('CF-Connecting-IP');
  if (!viewer) return c.json({ success: true, recorded: false });
  const hash = await identifierKey(`${day}:${viewer}`);
  try {
    await c.env.DB.prepare('INSERT OR IGNORE INTO search_selection_visitors (day, product_id, visitor_hash) VALUES (?, ?, ?)').bind(day, id, hash).run();
    // Bounded retention; both the ranking and the daily dedupe use this one small table.
    await c.env.DB.prepare('DELETE FROM search_selection_visitors WHERE day < ?').bind(day - 6).run();
    return c.json({ success: true, recorded: true });
  } catch (error) {
    if (missingMigration(error)) return c.json({ success: true, recorded: false });
    throw error;
  }
});

searchTrendingRoutes.get('/trending', async (c) => {
  const day = searchDay();
  const gate = await listing(c.env.DB);
  try {
    const read = (bucket: number) => c.env.DB.prepare(`
      SELECT p.id, p.name AS term, COUNT(*) AS searches
      FROM search_selection_visitors s JOIN products p ON p.id = s.product_id
      WHERE s.day = ? AND ${gate.visible('p')}
      GROUP BY p.id HAVING COUNT(*) >= 3
      ORDER BY searches DESC, p.id ASC LIMIT 10`).bind(bucket).all<{ id: string; term: string; searches: number }>();
    const [today, yesterday] = await Promise.all([read(day), read(day - 1)]);
    const previous = new Map(yesterday.results.map((row, index) => [row.id, index + 1]));
    c.header('Cache-Control', 'public, max-age=60');
    return c.json({ success: true, source: 'search_selections', updated_at: new Date().toISOString(), items: today.results.map((row, index) => ({ id: row.id, term: row.term, rank: index + 1, previous_rank: previous.get(row.id) ?? null })) });
  } catch (error) {
    if (missingMigration(error)) return c.json({ success: true, source: 'search_selections', items: [] });
    throw error;
  }
});

/**
 * WHAT THE SEARCH FIELD'S PLACEHOLDER CYCLES THROUGH (owner, 2026-11-18: «the
 * [search products] show instead animation of popular products»).
 *
 * `/trending` needs three different shoppers choosing the same product TODAY,
 * so on a quiet morning it is empty and the field would have nothing to show.
 * This is the steadier list: the products chosen from search over the kept
 * week, then the best sellers (the home shelf's own `bestSellerIds`), visible
 * only, at most 8, the product's own (English) name. No query text is read or
 * returned: the names are the catalogue's.
 */
searchTrendingRoutes.get('/popular', async (c) => {
  const db = c.env.DB;
  const gate = await listing(db);
  const out: Array<{ id: string; term: string }> = [];
  const add = (rows: Array<{ id: string; term: string }>) => {
    for (const r of rows) if (r.term && out.length < 8 && !out.some((o) => o.id === r.id)) out.push({ id: String(r.id), term: String(r.term) });
  };
  try {
    const week = await db
      .prepare(
        `SELECT p.id, p.name AS term, COUNT(*) AS n FROM search_selection_visitors s JOIN products p ON p.id = s.product_id
          WHERE s.day >= ? AND ${gate.visible('p')} GROUP BY p.id ORDER BY n DESC, p.id ASC LIMIT 8`
      )
      .bind(searchDay() - 6)
      .all<{ id: string; term: string }>();
    add(week.results ?? []);
  } catch (error) {
    if (!missingMigration(error)) throw error;
  }
  if (out.length < 8) {
    const ids = await bestSellerIds(db, { limit: 12 }).catch(() => [] as string[]);
    if (ids.length) {
      const { results } = await db
        .prepare(`SELECT p.id, p.name AS term FROM products p WHERE p.id IN (SELECT value FROM json_each(?)) AND ${gate.visible('p')}`)
        .bind(JSON.stringify(ids))
        .all<{ id: string; term: string }>();
      const byId = new Map((results ?? []).map((r) => [String(r.id), r]));
      add(ids.map((id) => byId.get(id)).filter((r): r is { id: string; term: string } => !!r));
    }
  }
  c.header('Cache-Control', 'public, max-age=300');
  return c.json({ success: true, items: out });
});
