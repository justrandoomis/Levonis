/**
 * Bundles — admin-composed groups of catalog products, a members-only
 * section (owner's mandate: «اعداد واضافه منفصله حيث يختار مجموعه من منتجات
 * الموقع ويضعها في بندل واحد … وهذه الميزه تظهر لمشتركين فقط البلس
 * والبريميوم والبرو»).
 *
 * Model decisions, deliberate:
 *  - A bundle has NO price of its own. Its storefront total is the LIVE sum
 *    of its members' tier-resolved display prices (the same resolver that
 *    prices checkout), so what the section advertises can never drift from
 *    what the cart actually charges. A stored bundle price would be a second
 *    source of truth that goes stale the day one member's price changes.
 *  - Visibility is enforced HERE, server-side, through the exclusiveSections
 *    entitlement (PLUS + PRIME + PRO, honouring support-restriction gates) —
 *    not by hiding a link in the client. A non-member gets `entitled: false`
 *    and an EMPTY list (200, not 403) so the page can render its lock state
 *    without an error path.
 *  - Admin CRUD replaces the whole item set on every save — the form always
 *    posts what it shows, so there is no partial-update drift.
 */

import { Hono } from 'hono';
import type { Context } from 'hono';
import type { AppContext } from '../lib/types';
import { requireAdmin, badRequest, notFound, str, int } from '../lib/http';
import { newId } from '../lib/crypto';
import { audit } from '../lib/audit';
import { getTierStatus, benefits } from '../lib/entitlements';
import { loadRelationsViews } from '../lib/productOverlay';
import { pricingCtx, publicWithDisplayPrice } from './products';

interface BundleRow {
  id: string;
  name: string;
  description: string;
  image: string;
  active: number;
  sort: number;
  created_at: number;
  updated_at: number;
}

interface BundleItemRow {
  bundle_id: string;
  product_id: string;
  qty: number;
  sort: number;
}

/** The slice of the public card shape the bundle grid actually renders. */
function itemCard(full: Record<string, unknown>) {
  return {
    id: full.id,
    slug: full.slug,
    name: full.name,
    images: full.images,
    price_iqd: full.price_iqd,
    display_price_iqd: full.display_price_iqd,
    display_regular_iqd: full.display_regular_iqd,
    display_applied_tier: full.display_applied_tier,
    display_prime_iqd: full.display_prime_iqd,
    display_pro_iqd: full.display_pro_iqd,
    display_from: full.display_from,
  };
}

// ---------------------------------------------------------------- public

export const bundlesRoutes = new Hono<AppContext>();

bundlesRoutes.get('/', async (c) => {
  const user = c.get('user');
  const status = user ? await getTierStatus(c.env.DB, user.id) : null;
  const entitled = !!status && benefits.exclusiveSections(status);
  if (!entitled) {
    // The lock screen needs to know WHY (signed out vs free tier), nothing else.
    return c.json({ entitled: false, signed_in: !!user, bundles: [] });
  }

  const bundles = (
    await c.env.DB.prepare('SELECT * FROM bundles WHERE active = 1 ORDER BY sort, created_at DESC').all<BundleRow>()
  ).results;
  if (bundles.length === 0) return c.json({ entitled: true, signed_in: true, bundles: [] });

  const items = (
    await c.env.DB.prepare(
      `SELECT bi.* FROM bundle_items bi JOIN bundles b ON b.id = bi.bundle_id WHERE b.active = 1`
    ).all<BundleItemRow>()
  ).results;

  const productIds = [...new Set(items.map((i) => i.product_id))];
  const rows = productIds.length
    ? (
        await c.env.DB.prepare(
          `SELECT * FROM products WHERE status = 'active' AND id IN (${productIds.map(() => '?').join(',')})`
        )
          .bind(...productIds)
          .all<Record<string, unknown>>()
      ).results
    : [];
  const ctx = await pricingCtx(c);
  const views = await loadRelationsViews(
    c.env.DB,
    rows.map((r) => ({ id: String(r.id), inventory_mode: r.inventory_mode }))
  );
  const cards = new Map<string, ReturnType<typeof itemCard>>();
  for (const row of rows) {
    cards.set(String(row.id), itemCard(publicWithDisplayPrice(row, ctx, views.get(String(row.id)))));
  }

  const payload = bundles
    .map((b) => {
      const members = items
        .filter((i) => i.bundle_id === b.id)
        .sort((x, y) => x.sort - y.sort)
        .map((i) => ({ qty: i.qty, product: cards.get(i.product_id) ?? null }))
        // A member product that went draft/hidden simply drops out of the
        // display — the bundle never advertises something that can't be bought.
        .filter((m) => m.product !== null) as Array<{ qty: number; product: ReturnType<typeof itemCard> }>;
      let total = 0;
      let regular = 0;
      let from = false;
      for (const m of members) {
        total += Number(m.product.display_price_iqd ?? m.product.price_iqd ?? 0) * m.qty;
        regular += Number(m.product.display_regular_iqd ?? m.product.price_iqd ?? 0) * m.qty;
        if (m.product.display_from) from = true;
      }
      return {
        id: b.id,
        name: b.name,
        description: b.description,
        image: b.image,
        sort: b.sort,
        items: members,
        total_display_iqd: total,
        total_regular_iqd: regular,
        total_from: from,
      };
    })
    // An empty bundle (or one whose members all went inactive) is not shown.
    .filter((b) => b.items.length > 0);

  return c.json({ entitled: true, signed_in: true, bundles: payload });
});

// ---------------------------------------------------------------- admin

export const adminBundlesRoutes = new Hono<AppContext>();
adminBundlesRoutes.use('*', requireAdmin);

async function readItems(body: Record<string, unknown>): Promise<Array<{ product_id: string; qty: number }>> {
  const raw = Array.isArray(body.items) ? body.items : [];
  if (raw.length === 0) throw badRequest('items', 'a bundle needs at least one product');
  if (raw.length > 50) throw badRequest('items', 'at most 50 products per bundle');
  const seen = new Set<string>();
  const out: Array<{ product_id: string; qty: number }> = [];
  for (const it of raw) {
    const o = it as Record<string, unknown>;
    const pid = str(o.product_id, 'items.product_id', { min: 1, max: 80, required: true });
    if (seen.has(pid)) throw badRequest('items', `product ${pid} appears twice`);
    seen.add(pid);
    const qty = int(o.qty, 'items.qty', { min: 1, max: 99, def: 1 });
    out.push({ product_id: pid, qty });
  }
  return out;
}

async function assertProductsExist(db: D1Database, items: Array<{ product_id: string }>) {
  const ids = items.map((i) => i.product_id);
  const rows = (
    await db
      .prepare(`SELECT id FROM products WHERE id IN (${ids.map(() => '?').join(',')})`)
      .bind(...ids)
      .all<{ id: string }>()
  ).results;
  const found = new Set(rows.map((r) => r.id));
  const missing = ids.filter((id) => !found.has(id));
  if (missing.length) throw badRequest('items', `unknown product ids: ${missing.join(', ')}`);
}

async function bundleWithItems(db: D1Database, id: string) {
  const row = await db.prepare('SELECT * FROM bundles WHERE id = ?').bind(id).first<BundleRow>();
  if (!row) return null;
  const items = (
    await db.prepare('SELECT * FROM bundle_items WHERE bundle_id = ? ORDER BY sort').bind(id).all<BundleItemRow>()
  ).results;
  return { ...row, items: items.map((i) => ({ product_id: i.product_id, qty: i.qty })) };
}

adminBundlesRoutes.get('/', async (c) => {
  const bundles = (
    await c.env.DB.prepare('SELECT * FROM bundles ORDER BY sort, created_at DESC').all<BundleRow>()
  ).results;
  const items = (
    await c.env.DB.prepare('SELECT * FROM bundle_items ORDER BY sort').all<BundleItemRow>()
  ).results;
  // Names for the admin list — drafts included: the admin composes ahead of
  // publishing, and the storefront route filters to active on its own.
  const ids = [...new Set(items.map((i) => i.product_id))];
  const names = ids.length
    ? (
        await c.env.DB.prepare(`SELECT id, name, status, images FROM products WHERE id IN (${ids.map(() => '?').join(',')})`)
          .bind(...ids)
          .all<{ id: string; name: string; status: string; images: string }>()
      ).results
    : [];
  const nameMap = new Map(names.map((n) => [n.id, n]));
  return c.json({
    bundles: bundles.map((b) => ({
      ...b,
      items: items
        .filter((i) => i.bundle_id === b.id)
        .map((i) => {
          const p = nameMap.get(i.product_id);
          let image = '';
          if (p) {
            try {
              const arr = JSON.parse(p.images || '[]');
              const first = Array.isArray(arr) ? arr[0] : null;
              image = typeof first === 'string' ? first : (first && typeof first.url === 'string' ? first.url : '');
            } catch { /* legacy images JSON is display-only here */ }
          }
          return { product_id: i.product_id, qty: i.qty, name: p?.name ?? i.product_id, status: p?.status ?? 'missing', image };
        }),
    })),
  });
});

async function writeBundle(c: Context<AppContext>, id: string, isNew: boolean) {
  const body = (await c.req.json().catch(() => null)) as Record<string, unknown> | null;
  if (!body) throw badRequest('body', 'invalid JSON');
  const name = str(body.name, 'name', { min: 1, max: 200, required: true });
  const description = str(body.description ?? '', 'description', { max: 2000 });
  const image = str(body.image ?? '', 'image', { max: 1000 });
  const active = body.active === false ? 0 : 1;
  const sort = int(body.sort, 'sort', { min: 0, max: 100000, def: 0 });
  const items = await readItems(body);
  await assertProductsExist(c.env.DB, items);
  const now = Date.now();

  const statements = [
    isNew
      ? c.env.DB.prepare(
          'INSERT INTO bundles (id, name, description, image, active, sort, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
        ).bind(id, name, description, image, active, sort, now, now)
      : c.env.DB.prepare(
          'UPDATE bundles SET name = ?, description = ?, image = ?, active = ?, sort = ?, updated_at = ? WHERE id = ?'
        ).bind(name, description, image, active, sort, now, id),
    c.env.DB.prepare('DELETE FROM bundle_items WHERE bundle_id = ?').bind(id),
    ...items.map((it, i) =>
      c.env.DB.prepare('INSERT INTO bundle_items (bundle_id, product_id, qty, sort) VALUES (?, ?, ?, ?)').bind(
        id,
        it.product_id,
        it.qty,
        i
      )
    ),
  ];
  await c.env.DB.batch(statements);

  const admin = c.get('user')!;
  await audit(c.env.DB, admin.id, isNew ? 'bundle.create' : 'bundle.update', id, {
    name,
    items: items.length,
    active: !!active,
  });
  return c.json({ ok: true, bundle: await bundleWithItems(c.env.DB, id) });
}

adminBundlesRoutes.post('/', async (c) => writeBundle(c, newId('bnd'), true));

adminBundlesRoutes.put('/:id', async (c) => {
  const id = c.req.param('id');
  const exists = await c.env.DB.prepare('SELECT id FROM bundles WHERE id = ?').bind(id).first();
  if (!exists) throw notFound('bundle');
  return writeBundle(c, id, false);
});

adminBundlesRoutes.delete('/:id', async (c) => {
  const id = c.req.param('id');
  const row = await c.env.DB.prepare('SELECT * FROM bundles WHERE id = ?').bind(id).first<BundleRow>();
  if (!row) throw notFound('bundle');
  await c.env.DB.batch([
    c.env.DB.prepare('DELETE FROM bundle_items WHERE bundle_id = ?').bind(id),
    c.env.DB.prepare('DELETE FROM bundles WHERE id = ?').bind(id),
  ]);
  const admin = c.get('user')!;
  await audit(c.env.DB, admin.id, 'bundle.delete', id, { name: row.name });
  return c.json({ ok: true });
});
