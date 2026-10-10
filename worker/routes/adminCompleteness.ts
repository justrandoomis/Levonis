/**
 * PRODUCT COMPLETENESS AND THE OWNER'S «إخفاء المنتجات الناقصة عن الزبائن»
 * (owner brief 2026-10-10; worker/lib/productCompleteness.ts, migration 0184).
 * Registered on the admin products router (/api/admin/products-v2):
 *
 *   GET  /:id/completeness        any admin: the saved product's missing fields
 *                                 as codes — the verified owner reads the
 *                                 private ones (cost, USD pricing data) by
 *                                 name, every other admin one OWNER_DATA item
 *   GET  /completeness/summary    the owner: how many products the switch
 *                                 hides (and how many bundles that stops)
 *   POST /completeness/refresh    the owner: re-evaluate the next 25 products
 *                                 whose verdict is missing or stale
 *   PUT  /completeness/hide       the owner: the switch, with the count the
 *                                 owner read; one fenced batch moves the
 *                                 switch and every product's `held`, audited
 *
 * Nothing here reads or writes an order, a wallet, a gift or a lot, changes a
 * product's status or deletes a row: hiding is the `held` flag alone, and every
 * customer surface reads it through worker/lib/listing.ts.
 */
import type { Context, Hono } from 'hono';
import type { AppContext } from '../lib/types';
import { HttpError, jsonObject } from '../lib/http';
import { canViewCost, requireOwner } from '../lib/costAccess';
import { auditStatements } from '../lib/audit';
import { fence, isFenceMiss } from '../lib/operations';
import { completenessInstalled } from '../lib/listing';
import { getSetting } from '../lib/settings';
import {
  COMPLETENESS_CHUNK,
  HIDE_SETTING_KEY,
  hideSummary,
  projectItems,
  recomputeCompleteness,
  scanStale,
  storedVerdict,
  factsKeyOf,
  globalRulesSig,
  loadFacts,
} from '../lib/productCompleteness';
import { afterProductsChanged, purgeVisibility } from '../lib/completenessHooks';
import { COMPLETENESS_ENTRIES, completenessMessage, type CompletenessItem } from '@levonis/contracts/productCompleteness';

const notInstalled = () => new HttpError(503, completenessMessage('COMPLETENESS_NOT_INSTALLED'), 'COMPLETENESS_NOT_INSTALLED');

async function requireInstalled(c: Context<AppContext>): Promise<void> {
  if (!(await completenessInstalled(c.env.DB))) throw notInstalled();
}

/** One item as it travels: the code, the model, the form section, and whether it is private. */
const itemDto = (i: CompletenessItem) => ({
  code: i.code,
  option_id: i.option_id,
  section: COMPLETENESS_ENTRIES[i.code].section,
  private: COMPLETENESS_ENTRIES[i.code].private,
});

/** The products a visibility change touches, by slug: active ordinary products whose `held` the switch moves. */
async function slugsMovedBy(db: D1Database, enabled: boolean): Promise<string[]> {
  const { results } = await db
    .prepare(
      `SELECT p.slug AS slug FROM product_completeness pc JOIN products p ON p.id = pc.product_id
        WHERE p.status = 'active' AND pc.held <> (CASE WHEN ? = 1 AND pc.complete = 0 THEN 1 ELSE 0 END)`
    )
    .bind(enabled ? 1 : 0)
    .all<{ slug: string }>();
  return (results ?? []).map((r) => String(r.slug ?? '')).filter(Boolean);
}

export function registerCompletenessRoutes(router: Hono<AppContext>): void {
  // A read answers on a database without 0184 as the product's own read does
  // (200, `installed: false`): the owner's card simply stays away. Only the
  // acts below refuse there (CLAUDE.md rule 2; tests/fixtures/deployAhead.ts).
  router.get('/completeness/summary', requireOwner, async (c) => {
    if (!(await completenessInstalled(c.env.DB))) return c.json({ success: true, installed: false, summary: null });
    const setting = await getSetting(c.env.DB, 'catalogHideIncomplete');
    return c.json({ success: true, installed: true, summary: await hideSummary(c.env.DB, setting) });
  });

  router.post('/completeness/refresh', requireOwner, async (c) => {
    await requireInstalled(c);
    const db = c.env.DB;
    const scan = await scanStale(db);
    const batch = scan.stale.slice(0, COMPLETENESS_CHUNK);
    const r = batch.length ? await recomputeCompleteness(db, batch.map((f) => f.id), { facts: batch, globalSig: scan.globalSig }) : null;
    if (r?.flipped.length) await purgeVisibility(c, r.flipped);
    const setting = await getSetting(db, 'catalogHideIncomplete');
    return c.json({
      success: true,
      recomputed: r?.verdicts.length ?? 0,
      stale_left: Math.max(0, scan.stale.length - batch.length),
      summary: await hideSummary(db, setting),
    });
  });

  router.put('/completeness/hide', requireOwner, async (c) => {
    await requireInstalled(c);
    const db = c.env.DB;
    const user = c.get('user')!;
    const body = await jsonObject(c);
    if (typeof body.enabled !== 'boolean') throw new HttpError(400, 'enabled: true or false / enabled يجب أن يكون true أو false', 'INVALID_INPUT');
    const enabled = body.enabled;
    const current = await getSetting(db, 'catalogHideIncomplete');
    if (current.enabled === enabled) {
      return c.json({ success: true, already: true, summary: await hideSummary(db, current) });
    }
    const before = await hideSummary(db, current);
    if (enabled) {
      // The owner turns it on having READ the count: every product evaluated
      // against the list as it stands, and the number unchanged since.
      if (before.stale > 0) throw new HttpError(409, completenessMessage('COMPLETENESS_NOT_READY'), 'COMPLETENESS_NOT_READY', { summary: before });
      const expected = body.expected_count;
      if (typeof expected !== 'number' || !Number.isSafeInteger(expected) || expected !== before.would_hide) {
        throw new HttpError(409, completenessMessage('HIDE_COUNT_CHANGED'), 'HIDE_COUNT_CHANGED', { summary: before });
      }
    }
    const now = new Date().toISOString();
    const next = { enabled, since: enabled ? now : current.since, by: user.id };
    const moved = await slugsMovedBy(db, enabled);
    const flag = enabled ? 1 : 0;
    const statements: D1PreparedStatement[] = [
      // Fenced on the count the owner confirmed (a product completed or broken
      // between the read and this batch refuses it: HIDE_COUNT_CHANGED).
      ...(enabled
        ? fence(
            db,
            `(SELECT COUNT(*) FROM product_completeness pc JOIN products p ON p.id = pc.product_id
               WHERE pc.complete = 0 AND p.status = 'active' AND COALESCE(p.composition, '') = '') = ?`,
            [before.would_hide]
          )
        : []),
      db
        .prepare('INSERT INTO admin_settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
        .bind(HIDE_SETTING_KEY, JSON.stringify(next)),
      db
        .prepare('UPDATE product_completeness SET held = (CASE WHEN ? = 1 AND complete = 0 THEN 1 ELSE 0 END) WHERE held <> (CASE WHEN ? = 1 AND complete = 0 THEN 1 ELSE 0 END)')
        .bind(flag, flag),
      ...(
        await auditStatements(db, user.id, enabled ? 'catalog.hide_incomplete.enabled' : 'catalog.hide_incomplete.disabled', HIDE_SETTING_KEY, {
          would_hide: before.would_hide,
          bundles_affected: before.bundles_affected,
          products_moved: moved.length,
        })
      ).statements,
    ];
    try {
      await db.batch(statements);
    } catch (e) {
      if (isFenceMiss(e)) {
        throw new HttpError(409, completenessMessage('HIDE_COUNT_CHANGED'), 'HIDE_COUNT_CHANGED', { summary: await hideSummary(db, current) });
      }
      throw e;
    }
    await purgeVisibility(c, moved);
    return c.json({ success: true, summary: await hideSummary(db, next) });
  });

  router.get('/:id/completeness', async (c) => {
    const db = c.env.DB;
    const id = c.req.param('id');
    if (!(await completenessInstalled(db))) return c.json({ success: true, installed: false });
    const product = await db.prepare('SELECT id, composition FROM products WHERE id = ?').bind(id).first<{ id: string; composition: string | null }>();
    if (!product) throw new HttpError(404, 'Product not found / المنتج غير موجود', 'NOT_FOUND');
    if (product.composition) return c.json({ success: true, installed: true, applicable: false });
    // A verdict computed from other facts than the product has now is brought
    // up to date first (and the product purged if that moved it).
    let stored = await storedVerdict(db, id);
    const [facts] = await loadFacts(db, [id]);
    const stale = !stored || !facts || facts.stored_key !== (await factsKeyOf(facts, await globalRulesSig(db)));
    if (stale) {
      await afterProductsChanged(c, [id]);
      stored = await storedVerdict(db, id);
    }
    const setting = await getSetting(db, 'catalogHideIncomplete');
    const items = projectItems(stored?.items ?? [], canViewCost(c.env, c.get('user')));
    return c.json({
      success: true,
      installed: true,
      applicable: true,
      evaluated: !!stored,
      complete: stored ? items.length === 0 : null,
      held: stored?.held ?? false,
      switch_on: setting.enabled,
      missing_count: items.length,
      items: items.map(itemDto),
      computed_at: stored?.computed_at ?? null,
    });
  });
}
