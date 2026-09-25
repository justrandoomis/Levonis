/**
 * THE MYSTERY PANEL'S API — docs/BUNDLES_MYSTERY.md §10 and §11.1 (tabs 2 & 3).
 *
 * Pools, entries, weights, the duplicate policy, the reveal milestone, the
 * eligible-stock preview and the offers themselves. Five rules shape it:
 *
 * 1. THE GUARD IS THIS ROUTER'S OWN. `requireMainHost` in worker/index.ts is a
 *    HOST check and never a role check, and `requireAdmin` is attached per
 *    router in this codebase — a mount without its own guard would be an open
 *    admin API exposing pool weights, eligible-stock previews and pool mutation
 *    to any signed-in customer. `tests/adminHostGuard.test.ts` enumerates every
 *    route under `/api/admin/*` and asserts both halves.
 *
 * 2. ODDS AND DISCLOSURE ARE AUDITED INSIDE THEIR OWN BATCH (§10). A pool, an
 *    entry, a weight, `duplicate_policy` and `reveal_stage` decide who gets the
 *    expensive filament and when they learn what they got. Auditing them AFTER
 *    the batch means a crash between the two leaves an unaudited change to
 *    exactly that table, so `auditStatements` rides the mutation's own batch.
 *
 * 3. A WHOLE-SET SAVE NEVER DELETES AND NEVER OVERWRITES ANOTHER ADMIN.
 *    `expected_updated_at` mismatches answer 409 `STALE_EDIT` echoing
 *    `current`; entries that leave the set are deactivated, because an entry
 *    that has ever been drawn is named by `mystery_allocations.pool_entry_id`
 *    for ever and deleting it would lock the admin out of that pool.
 *
 * 4. THE SECRET IS NEVER IN A RESPONSE, AND NEVER EVEN IN A VARIABLE HERE. The
 *    offer's draw secret is readable by `worker/lib/mysteryDraw.ts` alone —
 *    this router only asks it for STATEMENTS that create or rotate one, so no
 *    handler can leak a value it never holds. Duplicating an offer ROTATES the
 *    copy's secret, so the copy does not inherit the original's future draws.
 *
 * 5. NOTHING IS COMPUTED IN THE PANEL. The eligible list, the probabilities,
 *    the distinct-choice count and every warning come from the same candidate
 *    query the checkout draw uses, so the preview and the shop can never
 *    disagree.
 */

import { likePattern, sqlLikeClause } from '../lib/sqlLike';
import { Hono } from 'hono';
import type { Context } from 'hono';
import type { AppContext } from '../lib/types';
import { requireAdmin, badRequest, notFound, int, str, oneOf, HttpError } from '../lib/http';
import { newId } from '../lib/crypto';
import { auditStatements } from '../lib/audit';
import { canViewFinancials, projectForAdmin } from '../lib/adminScope';
import { parseProductRow, projectAdmin, validateProductDoc, type ProductDoc } from '../lib/productModel';
import {
  localizeRespectingAuthored,
  planProductSave,
  preflightProductSave,
  reloadForVerification,
  saveProductAtomic,
  verifyApplied,
  type ProductWriteIntent,
  type ProductSavePlan,
} from '../lib/productPersistence';
import { MAX_PHYSICAL_LINES, type BundleIssue } from '../lib/bundleComposition';
import { loadOffers, offerWindowStatements, parseRequiredTiers, subjectOf, type OfferView } from '../lib/offers';
import {
  activePoolProductIds,
  ensureOfferSecretStatement,
  loadCandidates,
  loadMysteryOffer,
  loadPool,
  poolFromRow,
  rotateOfferSecretStatement,
  type DuplicatePolicy,
  type MysteryPool,
} from '../lib/mysteryDraw';
import {
  eligibleStockPreview,
  generateEntries,
  planEntryReplace,
  poolWarnings,
  readEntryInput,
  type PoolEntryInput,
} from '../lib/mystery/pools';
import { mysteryIssue, staleEdit } from '../lib/mystery/issues';
import { verifyAndNormalizeProductMedia } from '../lib/productMediaWrite';
import { slugToken, uniqueSlugIn } from './adminProducts';

export const adminMysteryRoutes = new Hono<AppContext>();
adminMysteryRoutes.use('*', requireAdmin);

const DUPLICATE_POLICIES: DuplicatePolicy[] = ['allow', 'discourage', 'forbid'];
const REVEAL_STAGES = ['paid', 'confirmed', 'preparing', 'shipped', 'delivered'] as const;

/** Warnings travel twice, for the same reason the bundles panel's do:
 *  `strList` keeps only strings on the success path, `refusalIssues` needs the
 *  record. */
const warningBody = (warnings: BundleIssue[]) => ({
  warnings: warnings.map((w) => w.message),
  warning_details: warnings,
});

/**
 * THE RANDOM FILAMENT IS PUBLIC — AND A TIER SET IS NOW AN EXCEPTION THAT
 * ANNOUNCES ITSELF.
 *
 * The owner: «الباقات والفيلم العشوائي الذي قلنا عليه سابقا انه خاص بالعضوية
 * اجعله الان عام لكل المستخدمين لا تجعله خاصا».
 *
 * WHAT WAS ACTUALLY ENFORCING A GATE, checked rather than assumed. A mystery
 * offer is gated in exactly one way: a non-empty `offer_windows.required_tiers`
 * for its subject, which `offerEligible` (worker/lib/offers.ts) turns into
 * `MEMBERSHIP_REQUIRED` and which the card, the detail page and the checkout
 * door each re-ask independently. There is no blanket gate anywhere: this
 * router already defaults the set to `[]` for every save (`readOffer`), the
 * duplicate handler writes no window at all, and migration 0063's legacy
 * members-only set — the «قلنا عليه سابقا» gate — named only
 * `prd_bnd_*` BUNDLE subjects and never touched a mystery offer.
 *
 * SO WHY NOT SIMPLY CLEAR THE COLUMN. Three reasons, and the third decides it.
 *   1. The owner said make it general. They did NOT say destroy their ability
 *      to run a members-only promotion later, and `required_tiers` is the only
 *      mechanism that can express one.
 *   2. Emptying it from a migration would be a data UPDATE — non-additive, and
 *      it would silently change whatever an admin has configured, which is the
 *      one thing this change is forbidden to do.
 *   3. Ignoring the column in code is worse than clearing it: the panel would
 *      keep offering a switch that no longer does anything, and the first
 *      person to discover it would be a member who was promised an exclusive.
 *
 * SO THE COLUMN STAYS AN OPTIONAL, PER-OFFER RESTRICTION — and the general
 * case becomes the one the API guarantees. What changes is VISIBILITY: a
 * restricted offer can no longer sit quietly in the list. `GET /offers`
 * publishes the set, and this notice rides the existing `warnings` channel on
 * every read and every save of an offer that still carries one, so the owner
 * meets their own exception instead of having to go looking for it.
 *
 * It is a WARNING and never a refusal. A refusal would mean an admin could not
 * save an offer they had deliberately restricted — which is the ability
 * reason 1 exists to protect.
 *
 * All three languages, because this is a real sentence in the panel's
 * trilingual banner and 'ckb' is a language here, not a fallback to English.
 */
const membersOnlyNotice = (tiers: string[]): BundleIssue => {
  const list = tiers.map((t) => t.toUpperCase()).join(' / ');
  const en = `this offer is restricted to members (${list}) — the random filament is public by default; clear the tiers to open it to everyone`;
  return {
    code: 'MYSTERY_MEMBERS_ONLY_RESTRICTION',
    message: en,
    en,
    // «الفلامنت» with the same spelling the services rail and siteMedia.ts use.
    // One product named two ways across the panel and the storefront is how an
    // admin comes to believe they are two products.
    ar: `هذا العرض مقيّد بالأعضاء (${list}) — الفلامنت العشوائي عام لكل المستخدمين افتراضيًا؛ امسح الفئات لفتحه للجميع`,
    // SORANI, NOT A TRANSLITERATION OF IT. «هەژاردەیی» is not a Kurdish word
    // for random; the word is «هەڕەمەکی», which is exactly what
    // src/components/home/ServicesGrid.tsx puts on the storefront card for the
    // same product. And «پۆل» is a school class or a category — a membership
    // TIER is «ئاست». Both were Kurdish-only defects in a hand-written string,
    // which is the same failure the house rule about 'ckb' exists to catch,
    // arriving without the banned ternary anywhere near it.
    ckb: `ئەم ئۆفەرە تەنها بۆ ئەندامانە (${list}) — فیلامێنتی هەڕەمەکی بە بنەڕەت بۆ هەموو بەکارهێنەرانە؛ ئاستەکان بسڕەوە بۆ کردنەوەی بۆ هەمووان`,
  };
};

const body = async (c: Context<AppContext>): Promise<Record<string, unknown>> => {
  const b = (await c.req.json().catch(() => null)) as Record<string, unknown> | null;
  if (!b) throw badRequest('JSON body required', 'VALIDATION');
  return b;
};

const truthy = (v: unknown) => v === true || v === 1 || v === '1';

// =========================================================== the pools

interface PoolListRow {
  id: string;
  name: string;
  kind: string;
  active: number;
  require_catalog_ids: string;
  require_facet_ids: string;
  min_available: number;
  updated_at: string;
  created_at: string;
  entry_count: number;
  active_entry_count: number;
}

adminMysteryRoutes.get('/pools', async (c) => {
  const { results } = await c.env.DB.prepare(
    `SELECT p.*,
            (SELECT COUNT(*) FROM mystery_pool_entries e WHERE e.pool_id = p.id) AS entry_count,
            (SELECT COUNT(*) FROM mystery_pool_entries e WHERE e.pool_id = p.id AND e.active = 1 AND e.weight > 0) AS active_entry_count
       FROM mystery_pools p
      ORDER BY p.created_at DESC
      LIMIT 200`
  ).all<PoolListRow>();
  return c.json({
    success: true,
    pools: results.map((r) => ({
      ...poolFromRow(r),
      created_at: r.created_at,
      entry_count: r.entry_count,
      active_entry_count: r.active_entry_count,
    })),
  });
});

function readPoolBody(b: Record<string, unknown>) {
  const ids = (raw: unknown): string[] =>
    Array.isArray(raw) ? [...new Set(raw.filter((x): x is string => typeof x === 'string' && !!x))] : [];
  return {
    name: str(b.name, 'name', { min: 1, max: 120 }),
    kind: oneOf(b.kind ?? 'direct', 'kind', ['direct', 'preorder'] as const),
    active: b.active === undefined ? true : truthy(b.active),
    require_catalog_ids: ids(b.require_catalog_ids),
    require_facet_ids: ids(b.require_facet_ids),
    min_available: int(b.min_available, 'min_available', { min: 0, max: 1000, def: 1 }),
  };
}

adminMysteryRoutes.post('/pools', async (c) => {
  const admin = c.get('user')!;
  const b = await body(c);
  const p = readPoolBody(b);
  const id = newId('mpl');
  const { statements } = await auditStatements(c.env.DB, admin.id, 'mystery.pool.update', id, {
    created: true,
    ...p,
  });
  await c.env.DB.batch([
    c.env.DB
      .prepare(
        `INSERT INTO mystery_pools (id, name, kind, active, require_catalog_ids, require_facet_ids, min_available)
         VALUES (?, ?, ?, ?, ?, ?, ?)`
      )
      .bind(
        id,
        p.name,
        p.kind,
        p.active ? 1 : 0,
        JSON.stringify(p.require_catalog_ids),
        JSON.stringify(p.require_facet_ids),
        p.min_available
      ),
    ...statements,
  ]);
  const pool = await loadPool(c.env.DB, id);
  return c.json({ success: true, created: true, pool });
});

async function poolOr404(c: Context<AppContext>, id: string): Promise<MysteryPool> {
  const pool = await loadPool(c.env.DB, id);
  if (!pool) throw notFound('pool');
  return pool;
}

adminMysteryRoutes.get('/pools/:id', async (c) => {
  const pool = await poolOr404(c, c.req.param('id'));
  const preview = await eligibleStockPreview(c.env.DB, pool);
  return c.json({ success: true, pool, preview, ...warningBody(preview.warnings) });
});

adminMysteryRoutes.put('/pools/:id', async (c) => {
  const admin = c.get('user')!;
  const id = c.req.param('id');
  const before = await poolOr404(c, id);
  const b = await body(c);
  const p = readPoolBody(b);
  // A pool's KIND decides which sale mode may draw from it. Changing it under a
  // live offer would convert a direct sale into a pre-order silently, which
  // §7.6 forbids by construction — so it is refused while an offer names it.
  if (p.kind !== before.kind) {
    const used = await c.env.DB
      .prepare('SELECT COUNT(*) AS n FROM mystery_offers WHERE direct_pool_id = ?1 OR preorder_pool_id = ?1')
      .bind(id)
      .first<{ n: number }>();
    if ((used?.n ?? 0) > 0) {
      throw new HttpError(400, 'this pool is attached to an offer and its kind cannot change', 'BUNDLE_VALIDATION', {
        errors: [mysteryIssue('MYSTERY_POOL_KIND_MISMATCH', { kind: before.kind })] as unknown as Record<string, unknown>[],
      });
    }
  }
  const { statements } = await auditStatements(c.env.DB, admin.id, 'mystery.pool.update', id, { before, after: p });
  await c.env.DB.batch([
    c.env.DB
      .prepare(
        `UPDATE mystery_pools
            SET name = ?, kind = ?, active = ?, require_catalog_ids = ?, require_facet_ids = ?, min_available = ?,
                updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
          WHERE id = ?`
      )
      .bind(
        p.name,
        p.kind,
        p.active ? 1 : 0,
        JSON.stringify(p.require_catalog_ids),
        JSON.stringify(p.require_facet_ids),
        p.min_available,
        id
      ),
    ...statements,
  ]);
  return c.json({ success: true, pool: await loadPool(c.env.DB, id) });
});

/**
 * DEACTIVATE-WHEN-IN-USE, the `adminTaxonomy` idiom. A pool an offer names or a
 * pool that has ever been drawn from is never deleted: `mystery_allocations`
 * points at its entries for ever, and an audit trail that can vanish is not one.
 */
adminMysteryRoutes.delete('/pools/:id', async (c) => {
  const admin = c.get('user')!;
  const id = c.req.param('id');
  await poolOr404(c, id);
  const offers = await c.env.DB
    .prepare('SELECT COUNT(*) AS n FROM mystery_offers WHERE direct_pool_id = ?1 OR preorder_pool_id = ?1')
    .bind(id)
    .first<{ n: number }>();
  const allocations = await c.env.DB
    .prepare('SELECT COUNT(*) AS n FROM mystery_allocations WHERE pool_id = ?')
    .bind(id)
    .first<{ n: number }>();
  const inUse = (offers?.n ?? 0) > 0 || (allocations?.n ?? 0) > 0;
  if (inUse) {
    const { statements } = await auditStatements(c.env.DB, admin.id, 'mystery.pool.update', id, { deactivated: true });
    await c.env.DB.batch([
      c.env.DB.prepare("UPDATE mystery_pools SET active = 0, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?").bind(id),
      ...statements,
    ]);
    const issue = mysteryIssue('POOL_IN_USE', { offers: offers?.n ?? 0, allocations: allocations?.n ?? 0 });
    return c.json({ success: true, deleted: false, deactivated: true, ...warningBody([issue]) });
  }
  const { statements } = await auditStatements(c.env.DB, admin.id, 'mystery.pool.update', id, { deleted: true });
  await c.env.DB.batch([
    c.env.DB.prepare('DELETE FROM mystery_pool_entries WHERE pool_id = ?').bind(id),
    c.env.DB.prepare('DELETE FROM mystery_pools WHERE id = ?').bind(id),
    ...statements,
  ]);
  return c.json({ success: true, deleted: true, deactivated: false });
});

// ========================================================= the entries

interface EntryRow {
  id: string;
  product_id: string;
  option_value_ids: string;
  color_id: string;
  family_id: string;
  weight: number;
  active: number;
  created_at: string;
  product_name: string;
  product_status: string;
}

/** PAGINATED AND FILTERABLE, because a filament pool is product × option values
 *  × colour and an unpaginated list is unusable (§10). */
adminMysteryRoutes.get('/pools/:id/entries', async (c) => {
  const pool = await poolOr404(c, c.req.param('id'));
  const q = c.req.query();
  const limit = int(q.limit ?? 50, 'limit', { min: 1, max: 200, def: 50 });
  const page = int(q.page ?? 1, 'page', { min: 1, max: 10_000, def: 1 });
  const search = String(q.search ?? '').trim().toLowerCase();
  const activeFilter = q.active === '1' ? 1 : q.active === '0' ? 0 : null;

  const where = ['e.pool_id = ?'];
  const args: unknown[] = [pool.id];
  if (activeFilter !== null) {
    where.push('e.active = ?');
    args.push(activeFilter);
  }
  if (search) {
    where.push(`(${sqlLikeClause(['lower(p.name)', 'lower(p.slug)'])})`);
    const like = likePattern(search);
    args.push(like, like);
  }
  const total = await c.env.DB
    .prepare(`SELECT COUNT(*) AS n FROM mystery_pool_entries e JOIN products p ON p.id = e.product_id WHERE ${where.join(' AND ')}`)
    .bind(...args)
    .first<{ n: number }>();
  const { results } = await c.env.DB
    .prepare(
      `SELECT e.*, p.name AS product_name, p.status AS product_status
         FROM mystery_pool_entries e JOIN products p ON p.id = e.product_id
        WHERE ${where.join(' AND ')}
        ORDER BY p.name, e.id
        LIMIT ? OFFSET ?`
    )
    .bind(...args, limit, (page - 1) * limit)
    .all<EntryRow>();

  return c.json({
    success: true,
    pool_id: pool.id,
    page,
    limit,
    total: total?.n ?? 0,
    entries: results.map((r) => ({
      id: r.id,
      product_id: r.product_id,
      product_name: r.product_name,
      product_status: r.product_status,
      option_value_ids: JSON.parse(r.option_value_ids || '[]') as string[],
      color_id: r.color_id,
      family_id: r.family_id,
      weight: r.weight,
      active: r.active === 1,
      created_at: r.created_at,
    })),
  });
});

/**
 * THE BULK GENERATOR — product ids plus a weight, expanded on the SERVER into
 * one entry per real stock row. Additive: it never removes an entry, so running
 * it twice over the same products updates them instead of duplicating them.
 */
adminMysteryRoutes.post('/pools/:id/entries/generate', async (c) => {
  const admin = c.get('user')!;
  const pool = await poolOr404(c, c.req.param('id'));
  const b = await body(c);
  const productIds = Array.isArray(b.product_ids)
    ? (b.product_ids as unknown[]).filter((x): x is string => typeof x === 'string')
    : [];
  const weight = int(b.weight ?? 1, 'weight', { min: 0, max: 1000, def: 1 });
  const familyId = typeof b.family_id === 'string' ? b.family_id.trim() : '';
  const { entries, skipped } = await generateEntries(c.env.DB, { product_ids: productIds, weight, family_id: familyId });

  // Existing entries are kept: the generator merges into the set rather than
  // replacing it, so a pool that has been drawn from stays intact.
  const { results: stored } = await c.env.DB
    .prepare('SELECT id, product_id, option_value_ids, color_id, family_id, weight, active FROM mystery_pool_entries WHERE pool_id = ?')
    .bind(pool.id)
    .all<{ id: string; product_id: string; option_value_ids: string; color_id: string; family_id: string; weight: number; active: number }>();
  const existing: PoolEntryInput[] = stored.map((r) => ({
    id: r.id,
    product_id: r.product_id,
    option_value_ids: JSON.parse(r.option_value_ids || '[]') as string[],
    color_id: r.color_id,
    family_id: r.family_id,
    weight: r.weight,
    active: r.active === 1,
  }));
  const plan = await planEntryReplace(c.env.DB, pool.id, [...existing, ...entries]);
  const { statements } = await auditStatements(c.env.DB, admin.id, 'mystery.pool.update', pool.id, {
    generated: entries.length,
    inserted: plan.inserted,
    weight,
  });
  await c.env.DB.batch([...plan.statements, ...statements]);

  const preview = await eligibleStockPreview(c.env.DB, pool);
  return c.json({
    success: true,
    generated: entries.length,
    inserted: plan.inserted,
    updated: plan.updated,
    preview,
    ...warningBody([...skipped, ...preview.warnings]),
  });
});

/**
 * THE WHOLE-SET REPLACE. `expected_updated_at` is required: without it the
 * second of two admins editing one pool silently destroys the first's work.
 */
adminMysteryRoutes.put('/pools/:id/entries', async (c) => {
  const admin = c.get('user')!;
  const pool = await poolOr404(c, c.req.param('id'));
  const b = await body(c);
  const expected = typeof b.expected_updated_at === 'string' ? b.expected_updated_at : '';
  if (!expected) throw badRequest('expected_updated_at is required', 'VALIDATION');
  if (expected !== pool.updated_at) {
    const err = staleEdit();
    return c.json({ success: false, code: err.code, error: err.message, current: pool.updated_at }, 409);
  }
  const raw = Array.isArray(b.entries) ? (b.entries as unknown[]) : null;
  if (!raw) throw badRequest('entries must be an array', 'VALIDATION');
  if (raw.length > 2000) throw badRequest('at most 2000 entries per save', 'VALIDATION');
  const entries = raw.map(readEntryInput);

  // Every product named must exist and must not itself be a composition row.
  const ids = [...new Set(entries.map((e) => e.product_id))];
  if (ids.length > 0) {
    const { results } = await c.env.DB
      .prepare(`SELECT id, composition, name FROM products WHERE id IN (SELECT value FROM json_each(?))`)
      .bind(JSON.stringify(ids))
      .all<{ id: string; composition: string; name: string }>();
    const found = new Map(results.map((r) => [r.id, r]));
    const bad = ids
      .filter((id) => !found.has(id) || found.get(id)!.composition !== '')
      .map((id) => mysteryIssue('POOL_ENTRY_INVALID', { what: found.get(id)?.name ?? id }, { entry_id: id }));
    if (bad.length > 0) {
      throw new HttpError(400, 'this pool cannot be saved as configured', 'BUNDLE_VALIDATION', {
        errors: bad as unknown as Record<string, unknown>[],
      });
    }
  }

  const plan = await planEntryReplace(c.env.DB, pool.id, entries);
  const { statements } = await auditStatements(c.env.DB, admin.id, 'mystery.pool.update', pool.id, {
    inserted: plan.inserted,
    updated: plan.updated,
    deactivated: plan.deactivated,
    weights: entries.map((e) => ({ product_id: e.product_id, weight: e.weight })).slice(0, 50),
  });
  await c.env.DB.batch([...plan.statements, ...statements]);

  const after = await poolOr404(c, pool.id);
  const preview = await eligibleStockPreview(c.env.DB, after);
  return c.json({
    success: true,
    inserted: plan.inserted,
    updated: plan.updated,
    deactivated: plan.deactivated,
    updated_at: after.updated_at,
    preview,
    ...warningBody([...plan.warnings, ...preview.warnings]),
  });
});

/**
 * THE LIVE ELIGIBLE-STOCK PREVIEW — per-entry availability, weight, computed
 * probability, exclusion reason, and the distinct-choice count that §7.5 keeps
 * out of every customer refusal.
 */
adminMysteryRoutes.get('/pools/:id/eligible', async (c) => {
  const pool = await poolOr404(c, c.req.param('id'));
  const q = c.req.query();
  const spools = int(q.spools ?? 1, 'spools', { min: 1, max: 20, def: 1 });
  const policy = DUPLICATE_POLICIES.includes(q.duplicate_policy as DuplicatePolicy)
    ? (q.duplicate_policy as DuplicatePolicy)
    : 'allow';
  const preview = await eligibleStockPreview(c.env.DB, pool, {
    spools,
    duplicatePolicy: policy,
    familyId: String(q.family ?? ''),
  });
  return c.json({ success: true, ...preview, ...warningBody(preview.warnings) });
});

// ========================================================== the offers

interface ConfigRow {
  product_id: string;
  duplicate_policy: string;
  reveal_stage: string;
  show_odds: number;
  max_qty_per_order: number;
}

interface MysteryInput {
  direct_pool_id: string | null;
  preorder_pool_id: string | null;
  spool_qty: number;
  allow_direct: boolean;
  allow_preorder: boolean;
  customer_picks_family: boolean;
  duplicate_policy: DuplicatePolicy;
  reveal_stage: string;
  show_odds: boolean;
  max_qty_per_order: number;
}

function readMysteryInput(b: Record<string, unknown>): MysteryInput {
  const poolId = (raw: unknown): string | null => (typeof raw === 'string' && raw.trim() ? raw.trim() : null);
  return {
    direct_pool_id: poolId(b.direct_pool_id),
    preorder_pool_id: poolId(b.preorder_pool_id),
    spool_qty: int(b.spool_qty ?? 1, 'spool_qty', { min: 1, max: 20, def: 1 }),
    allow_direct: b.allow_direct === undefined ? true : truthy(b.allow_direct),
    allow_preorder: truthy(b.allow_preorder),
    customer_picks_family: truthy(b.customer_picks_family),
    duplicate_policy: oneOf(b.duplicate_policy ?? 'allow', 'duplicate_policy', DUPLICATE_POLICIES),
    reveal_stage: oneOf(b.reveal_stage ?? 'delivered', 'reveal_stage', REVEAL_STAGES),
    show_odds: truthy(b.show_odds),
    max_qty_per_order: int(b.max_qty_per_order ?? 5, 'max_qty_per_order', { min: 1, max: 99, def: 5 }),
  };
}

function readOffer(b: Record<string, unknown>) {
  const o = b.offer as Record<string, unknown> | undefined;
  if (!o || typeof o !== 'object') return null;
  const nullableInt = (v: unknown): number | null =>
    v === null || v === undefined || v === '' ? null : int(v, 'offer price', { min: 0, max: 1_000_000_000 });
  return {
    starts_at: typeof o.starts_at === 'string' && o.starts_at ? o.starts_at : null,
    ends_at: typeof o.ends_at === 'string' && o.ends_at ? o.ends_at : null,
    required_tiers: Array.isArray(o.required_tiers)
      ? (o.required_tiers as unknown[]).filter((x): x is string => typeof x === 'string')
      : [],
    offer_price_mode: typeof o.offer_price_mode === 'string' ? o.offer_price_mode : '',
    offer_price_iqd: nullableInt(o.offer_price_iqd),
    discount_percent: nullableInt(o.discount_percent),
    discount_iqd: nullableInt(o.discount_iqd),
    plus_price_iqd: nullableInt(o.plus_price_iqd),
    locked_preview: o.locked_preview === undefined ? true : truthy(o.locked_preview),
    active: o.active === undefined ? true : truthy(o.active),
    max_per_user: o.max_per_user === null || o.max_per_user === undefined || o.max_per_user === '' ? null : int(o.max_per_user, 'max_per_user', { min: 1, max: 10_000 }),
    max_global: o.max_global === null || o.max_global === undefined || o.max_global === '' ? null : int(o.max_global, 'max_global', { min: 1, max: 1_000_000 }),
  };
}

const offerFromView = (view: OfferView | undefined) => {
  if (!view || !view.window) return null;
  const w = view.window;
  return {
    starts_at: w.starts_at,
    ends_at: w.ends_at,
    required_tiers: w.required_tiers,
    offer_price_mode: w.offer_price_mode,
    offer_price_iqd: w.offer_price_iqd,
    discount_percent: w.discount_percent,
    discount_iqd: w.discount_iqd,
    plus_price_iqd: w.plus_price_iqd,
    locked_preview: w.locked_preview,
    active: w.active,
    max_per_user: view.limits?.max_per_user ?? null,
    max_global: view.limits?.max_global ?? null,
  };
};

/** A mystery offer's own document, with §1.2's pins stated. `planProductSave`
 *  enforces them again — a pin that lives in a caller is a pin the next caller
 *  forgets. */
function mysteryDocFrom(b: Record<string, unknown>, id: string): ProductDoc {
  const doc = validateProductDoc({
    ...b,
    id,
    composition: 'mystery',
    options: [],
    colors: [],
    stock: null,
    inventory_mode: 'BASE',
    selling_type: 'bundle',
    sale_types: truthy((b as { allow_preorder?: unknown }).allow_preorder) ? ['bundle', 'pre_order'] : ['bundle'],
  });
  doc.id = id;
  return doc;
}

/**
 * The configuration refusals and warnings, all of them said rather than
 * repaired. A missing pool is a WARNING on a draft and a REFUSAL on publish:
 * an offer that reached the storefront with no pool would meet the customer as
 * `MYSTERY_MODE_NOT_AVAILABLE` on the buy button.
 */
async function validateMystery(
  db: D1Database,
  input: MysteryInput,
  publishing: boolean
): Promise<{ errors: BundleIssue[]; warnings: BundleIssue[] }> {
  const errors: BundleIssue[] = [];
  const warnings: BundleIssue[] = [];

  if (!input.allow_direct && !input.allow_preorder) errors.push(mysteryIssue('MYSTERY_NO_MODE_ENABLED'));

  // spool_qty × max_qty_per_order is refused AT SAVE, so the customer never
  // meets the checkout door's MAX_PHYSICAL_LINES limit on a legal
  // configuration (§3.1).
  const lines = input.spool_qty * input.max_qty_per_order;
  if (lines > MAX_PHYSICAL_LINES) {
    errors.push(
      mysteryIssue('MYSTERY_SPOOLS_TOO_LARGE', {
        spools: input.spool_qty,
        qty: input.max_qty_per_order,
        lines,
        max: MAX_PHYSICAL_LINES,
      })
    );
  }

  for (const [mode, poolId, allowed, wantKind] of [
    ['direct', input.direct_pool_id, input.allow_direct, 'direct'],
    ['preorder', input.preorder_pool_id, input.allow_preorder, 'preorder'],
  ] as const) {
    if (!allowed) continue;
    if (!poolId) {
      const issue = mysteryIssue('MYSTERY_POOL_MISSING', { mode });
      if (publishing) errors.push(issue);
      else warnings.push(issue);
      continue;
    }
    const pool = await loadPool(db, poolId);
    if (!pool) {
      errors.push(mysteryIssue('POOL_ENTRY_INVALID', { what: poolId }));
      continue;
    }
    // The two pools are SEPARATE, so a direct purchase can never silently
    // become a pre-order (§7.6).
    if (pool.kind !== wantKind) {
      errors.push(mysteryIssue('MYSTERY_POOL_KIND_MISMATCH', { kind: wantKind }));
      continue;
    }
    const set = await loadCandidates(db, pool, { preview: true });
    warnings.push(...poolWarnings(pool, set, { spools: input.spool_qty, duplicatePolicy: input.duplicate_policy }));
  }
  return { errors, warnings };
}

function mysteryStatements(db: D1Database, productId: string, input: MysteryInput): D1PreparedStatement[] {
  return [
    db
      .prepare(
        `INSERT INTO mystery_offers
           (product_id, direct_pool_id, preorder_pool_id, spool_qty, allow_direct, allow_preorder, customer_picks_family)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(product_id) DO UPDATE SET
           direct_pool_id = excluded.direct_pool_id,
           preorder_pool_id = excluded.preorder_pool_id,
           spool_qty = excluded.spool_qty,
           allow_direct = excluded.allow_direct,
           allow_preorder = excluded.allow_preorder,
           customer_picks_family = excluded.customer_picks_family`
      )
      .bind(
        productId,
        input.direct_pool_id,
        input.preorder_pool_id,
        input.spool_qty,
        input.allow_direct ? 1 : 0,
        input.allow_preorder ? 1 : 0,
        input.customer_picks_family ? 1 : 0
      ),
    // ONLY the mystery half of bundle_config. The price columns belong to the
    // bundles panel's own upsert, which deliberately never touches these four —
    // so the two editors cannot overwrite each other.
    db
      .prepare(
        `INSERT INTO bundle_config (product_id, duplicate_policy, reveal_stage, show_odds, max_qty_per_order)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(product_id) DO UPDATE SET
           duplicate_policy = excluded.duplicate_policy,
           reveal_stage = excluded.reveal_stage,
           show_odds = excluded.show_odds,
           max_qty_per_order = excluded.max_qty_per_order,
           updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')`
      )
      .bind(productId, input.duplicate_policy, input.reveal_stage, input.show_odds ? 1 : 0, input.max_qty_per_order),
  ];
}

async function writeOffer(c: Context<AppContext>, mode: 'create' | 'update', productId: string | null) {
  const admin = c.get('user')!;
  const b = await body(c);

  let prev: ProductDoc | null = null;
  let prevRow: Record<string, unknown> | null = null;
  if (mode === 'update') {
    prevRow =
      (await c.env.DB.prepare('SELECT * FROM products WHERE id = ?').bind(productId).first<Record<string, unknown>>()) ?? null;
    if (!prevRow) throw notFound('mystery offer');
    prev = parseProductRow(prevRow);
    if (prev.composition !== 'mystery') throw badRequest('this product is not a mystery offer', 'VALIDATION');
    if (typeof b.expected_updated_at === 'string' && b.expected_updated_at) {
      const current = String(prevRow.updated_at ?? '');
      if (b.expected_updated_at !== current) {
        return c.json({ success: false, code: 'STALE_EDIT', error: 'This offer was modified by someone else since you opened it.', current }, 409);
      }
    }
  }

  const id = prev ? prev.id : newId('prd');
  const doc = mysteryDocFrom(b, id);
  if (prev) {
    doc.slug = prev.slug;
  } else {
    const base = slugToken(doc.name_en) || slugToken(doc.name_ar) || `mystery-${id.slice(-8)}`;
    doc.slug = await uniqueSlugIn(c.env.DB, 'products', base, null);
  }

  const input = readMysteryInput(b);
  const offer = readOffer(b);
  const { errors, warnings } = await validateMystery(c.env.DB, input, doc.status === 'active');
  // A SAVE THAT KEEPS A TIER GATE SAYS SO IN THE RESPONSE. `readOffer` already
  // defaults the set to `[]`, so the only way to reach this is an admin who
  // deliberately ticked a tier — which is still allowed (see
  // `membersOnlyNotice`) and is no longer silent.
  if (offer && offer.required_tiers.length > 0) warnings.push(membersOnlyNotice(offer.required_tiers));
  if (errors.length) {
    throw new HttpError(400, 'this mystery offer cannot be saved as configured', 'BUNDLE_VALIDATION', {
      errors: errors as unknown as Record<string, unknown>[],
    });
  }

  const localized = localizeRespectingAuthored(doc, prev);
  const saveIntent: ProductWriteIntent = {
    mode,
    doc,
    prev,
    relations: null,
    actor: { adminId: admin.id, money: canViewFinancials(c.env, admin) },
    translations: localized.fields,
    // The bundles panel and this one are the only writers allowed to create a
    // composition row, and both supply the composition in the same plan.
    allowComposition: true,
  };
  await preflightProductSave(c.env.DB, saveIntent);

  // Mystery offers use the ordinary product gallery. Resolve every claimed
  // `/files` object only after both the mystery configuration and the product
  // structure have passed read-only validation, then rebuild the product plan
  // with the byte-authoritative metadata.
  await verifyAndNormalizeProductMedia(c.env, doc);
  const plan: ProductSavePlan = await planProductSave(c.env.DB, saveIntent);
  plan.statements.push(
    ...mysteryStatements(c.env.DB, id, input),
    // The secret is created once and never rotated by an ordinary save: a
    // rotation changes every future draw and is its own deliberate action.
    ensureOfferSecretStatement(c.env.DB, id),
    ...offerWindowStatements(c.env.DB, subjectOf(id), offer)
  );
  // AN ODDS- OR DISCLOSURE-CHANGING WRITE IS AUDITED INSIDE ITS OWN BATCH —
  // WITH BOTH SIDES OF THE CHANGE (§10).
  //
  // The after values alone cannot answer "what was the reveal milestone, the
  // spool count, the duplicate policy or the tier gate before this admin
  // changed it", because the rows they would be compared against have been
  // overwritten by the same batch. On a randomised money mechanism that is the
  // one question an audit trail exists for. Read before the write, in the same
  // handler; `mystery.ts`'s pool update already carries `{before, after}` and
  // this is the same shape.
  const beforeOffer = await c.env.DB
    .prepare(
      `SELECT o.direct_pool_id, o.preorder_pool_id, o.spool_qty, o.allow_direct, o.allow_preorder,
              o.customer_picks_family, cfg.duplicate_policy, cfg.reveal_stage, cfg.show_odds,
              cfg.max_qty_per_order,
              w.required_tiers, w.starts_at, w.ends_at, w.offer_price_mode, w.offer_price_iqd,
              w.discount_percent, w.discount_iqd, w.plus_price_iqd, w.active,
              l.max_per_user, l.max_global
         FROM products p
         LEFT JOIN mystery_offers o ON o.product_id = p.id
         LEFT JOIN bundle_config cfg ON cfg.product_id = p.id
         LEFT JOIN offer_windows w ON w.subject_type = 'product' AND w.subject_id = p.id
         LEFT JOIN offer_limits l ON l.subject_type = 'product' AND l.subject_id = p.id
        WHERE p.id = ?`
    )
    .bind(id)
    .first<Record<string, unknown>>();
  const { statements: auditRows } = await auditStatements(c.env.DB, admin.id, 'mystery.offer.update', id, {
    created: mode === 'create',
    before: mode === 'create' ? null : (beforeOffer ?? null),
    after: {
      spool_qty: input.spool_qty,
      duplicate_policy: input.duplicate_policy,
      reveal_stage: input.reveal_stage,
      show_odds: input.show_odds,
      direct_pool_id: input.direct_pool_id,
      preorder_pool_id: input.preorder_pool_id,
      allow_direct: input.allow_direct,
      allow_preorder: input.allow_preorder,
      ...(offer ? { required_tiers: offer.required_tiers, max_per_user: offer.max_per_user, max_global: offer.max_global } : {}),
    },
  });
  plan.statements.push(...auditRows);

  await saveProductAtomic(c.env.DB, plan);
  const stored = await reloadForVerification(c.env.DB, id);
  const mismatches = stored ? verifyApplied(plan, stored, { documentKeys: null }) : [];
  return c.json({
    success: true,
    created: mode === 'create',
    product: projectForAdmin(c.env, admin, stored ? projectAdmin(stored.document) : projectAdmin(doc)),
    mystery: input,
    ...warningBody(warnings),
    ...(mismatches.length ? { mismatches } : {}),
  });
}

/**
 * THE OFFER LIST, AND IT NOW SAYS WHICH OFFERS ARE NOT PUBLIC.
 *
 * The window join is the whole point of the change. Until now the only place
 * `required_tiers` appeared was inside ONE offer's edit form, so an offer that
 * had been restricted looked exactly like a public one on the list the owner
 * actually opens — which is how a members-only offer survives an instruction
 * to make the feature general. It is one LEFT JOIN on the same
 * `(subject_type, subject_id)` primary key `loadOffers` uses, and no extra
 * round trip.
 *
 * `parseRequiredTiers` rather than `JSON.parse`: it keeps only real tier names
 * and sorts them, so a hand-edited row cannot put an arbitrary string on an
 * admin screen and two equal sets always read the same.
 */
adminMysteryRoutes.get('/offers', async (c) => {
  const { results } = await c.env.DB.prepare(
    `SELECT p.id, p.slug, p.name, p.name_ar, p.name_ku, p.status, p.price_iqd, p.display_order,
            o.direct_pool_id, o.preorder_pool_id, o.spool_qty, o.allow_direct, o.allow_preorder, o.customer_picks_family,
            cfg.duplicate_policy, cfg.reveal_stage, cfg.show_odds, cfg.max_qty_per_order,
            w.required_tiers
       FROM products p
       LEFT JOIN mystery_offers o ON o.product_id = p.id
       LEFT JOIN bundle_config cfg ON cfg.product_id = p.id
       LEFT JOIN offer_windows w ON w.subject_type = 'product' AND w.subject_id = p.id
      WHERE p.composition = 'mystery'
      ORDER BY p.display_order, p.created_at DESC
      LIMIT 200`
  ).all<Record<string, unknown>>();
  return c.json({
    success: true,
    offers: results.map((r) => {
      // Parsed ONCE per row and read twice: the tier list and the boolean must
      // never be able to disagree about one offer.
      const tiers = parseRequiredTiers(r.required_tiers);
      return {
        id: r.id,
        slug: r.slug,
        name: r.name,
        name_ar: r.name_ar,
        name_ku: r.name_ku,
        status: r.status,
        price_iqd: r.price_iqd,
        spool_qty: r.spool_qty ?? 1,
        direct_pool_id: r.direct_pool_id ?? null,
        preorder_pool_id: r.preorder_pool_id ?? null,
        allow_direct: r.allow_direct === 1,
        allow_preorder: r.allow_preorder === 1,
        customer_picks_family: r.customer_picks_family === 1,
        duplicate_policy: r.duplicate_policy ?? '',
        reveal_stage: r.reveal_stage ?? '',
        show_odds: r.show_odds === 1,
        max_qty_per_order: r.max_qty_per_order ?? 5,
        // Both, deliberately: the SET so the panel can name the tiers, and the
        // boolean so a client that only wants to badge the row cannot get the
        // test wrong. An offer with no window at all reads `[]` / false, which
        // is what "public" is.
        required_tiers: tiers,
        members_only: tiers.length > 0,
      };
    }),
  });
});

adminMysteryRoutes.post('/offers', async (c) => writeOffer(c, 'create', null));

adminMysteryRoutes.get('/offers/:productId', async (c) => {
  const admin = c.get('user')!;
  const id = c.req.param('productId');
  const row = await c.env.DB.prepare('SELECT * FROM products WHERE id = ?').bind(id).first<Record<string, unknown>>();
  if (!row) throw notFound('mystery offer');
  const doc = parseProductRow(row);
  if (doc.composition !== 'mystery') throw badRequest('this product is not a mystery offer', 'VALIDATION');

  const offerRow = await loadMysteryOffer(c.env.DB, id);
  const cfg = await c.env.DB
    .prepare('SELECT product_id, duplicate_policy, reveal_stage, show_odds, max_qty_per_order FROM bundle_config WHERE product_id = ?')
    .bind(id)
    .first<ConfigRow>();
  const offers = await loadOffers(c.env.DB, [subjectOf(id)]);

  const previews: Record<string, unknown> = {};
  const warnings: BundleIssue[] = [];
  for (const [key, poolId] of [
    ['direct', offerRow?.direct_pool_id ?? null],
    ['preorder', offerRow?.preorder_pool_id ?? null],
  ] as const) {
    if (!poolId) continue;
    const pool = await loadPool(c.env.DB, poolId);
    if (!pool) continue;
    const preview = await eligibleStockPreview(c.env.DB, pool, {
      spools: offerRow?.spool_qty ?? 1,
      duplicatePolicy: (cfg?.duplicate_policy as DuplicatePolicy) || 'allow',
    });
    previews[key] = preview;
    warnings.push(...preview.warnings);
  }

  // THE EXCEPTION ANNOUNCES ITSELF ON EVERY READ, not only on save. An admin
  // who opens an offer to change its pool must see that it is still
  // members-only even if they never touch the eligibility tab.
  const offerView = offerFromView(offers.get(`product:${id}`));
  if (offerView && offerView.required_tiers.length > 0) {
    warnings.push(membersOnlyNotice(offerView.required_tiers));
  }

  return c.json({
    success: true,
    product: projectForAdmin(c.env, admin, projectAdmin(doc)),
    updated_at: String(row.updated_at ?? ''),
    mystery: {
      ...(offerRow ?? { product_id: id, direct_pool_id: null, preorder_pool_id: null, spool_qty: 1, allow_direct: true, allow_preorder: false, customer_picks_family: false }),
      duplicate_policy: cfg?.duplicate_policy ?? '',
      reveal_stage: cfg?.reveal_stage ?? '',
      show_odds: cfg?.show_odds === 1,
      max_qty_per_order: cfg?.max_qty_per_order ?? 5,
    },
    offer: offerView,
    members_only: !!offerView && offerView.required_tiers.length > 0,
    previews,
    ...warningBody(warnings),
  });
});

adminMysteryRoutes.put('/offers/:productId', async (c) => writeOffer(c, 'update', c.req.param('productId')));

/**
 * DUPLICATE — a new DRAFT with a new slug and, above all, A NEW SECRET. A copy
 * that inherited the original's secret would draw the same filament for the
 * same salt, and anyone who learned one offer's secret would own both.
 */
adminMysteryRoutes.post('/offers/:productId/duplicate', async (c) => {
  const admin = c.get('user')!;
  const id = c.req.param('productId');
  const row = await c.env.DB.prepare('SELECT * FROM products WHERE id = ?').bind(id).first<Record<string, unknown>>();
  if (!row) throw notFound('mystery offer');
  const prev = parseProductRow(row);
  if (prev.composition !== 'mystery') throw badRequest('this product is not a mystery offer', 'VALIDATION');

  const source = await loadMysteryOffer(c.env.DB, id);
  const cfg = await c.env.DB
    .prepare('SELECT product_id, duplicate_policy, reveal_stage, show_odds, max_qty_per_order FROM bundle_config WHERE product_id = ?')
    .bind(id)
    .first<ConfigRow>();

  const newProductId = newId('prd');
  const doc: ProductDoc = { ...prev, id: newProductId, status: 'draft' };
  doc.name_en = prev.name_en ? `${prev.name_en} (copy)` : prev.name_en;
  doc.slug = await uniqueSlugIn(c.env.DB, 'products', `${slugToken(prev.slug) || 'mystery'}-copy`, null);

  const input: MysteryInput = {
    direct_pool_id: source?.direct_pool_id ?? null,
    preorder_pool_id: source?.preorder_pool_id ?? null,
    spool_qty: source?.spool_qty ?? 1,
    allow_direct: source?.allow_direct ?? true,
    allow_preorder: source?.allow_preorder ?? false,
    customer_picks_family: source?.customer_picks_family ?? false,
    duplicate_policy: (cfg?.duplicate_policy as DuplicatePolicy) || 'allow',
    reveal_stage: cfg?.reveal_stage || 'delivered',
    show_odds: cfg?.show_odds === 1,
    max_qty_per_order: cfg?.max_qty_per_order ?? 5,
  };

  const saveIntent: ProductWriteIntent = {
    mode: 'create',
    doc,
    prev: null,
    relations: null,
    actor: { adminId: admin.id, money: canViewFinancials(c.env, admin) },
    allowComposition: true,
  };
  await preflightProductSave(c.env.DB, saveIntent);

  // A duplicate is a new catalogue write, not permission to carry a missing
  // or replaced source object into another product document. The structural
  // plan has already succeeded, so normalize and rebuild only now.
  await verifyAndNormalizeProductMedia(c.env, doc);
  const plan = await planProductSave(c.env.DB, saveIntent);
  plan.statements.push(
    ...mysteryStatements(c.env.DB, newProductId, input),
    rotateOfferSecretStatement(c.env.DB, newProductId)
  );
  const { statements } = await auditStatements(c.env.DB, admin.id, 'mystery.offer.update', newProductId, {
    duplicated_from: id,
    secret_rotated: true,
  });
  plan.statements.push(...statements);
  await saveProductAtomic(c.env.DB, plan);

  const stored = await reloadForVerification(c.env.DB, newProductId);
  return c.json({
    success: true,
    created: true,
    product: projectForAdmin(c.env, admin, stored ? projectAdmin(stored.document) : projectAdmin(doc)),
  });
});

/** A deliberate rotation: every FUTURE draw of this offer changes, and every
 *  past allocation keeps the seed it was drawn with, so history stays
 *  reproducible. */
adminMysteryRoutes.post('/offers/:productId/rotate-secret', async (c) => {
  const admin = c.get('user')!;
  const id = c.req.param('productId');
  const row = await c.env.DB
    .prepare("SELECT id FROM products WHERE id = ? AND composition = 'mystery'")
    .bind(id)
    .first<{ id: string }>();
  if (!row) throw notFound('mystery offer');
  const { statements } = await auditStatements(c.env.DB, admin.id, 'mystery.offer.update', id, { secret_rotated: true });
  await c.env.DB.batch([rotateOfferSecretStatement(c.env.DB, id), ...statements]);
  // The secret itself is NEVER in a response.
  return c.json({ success: true, rotated: true });
});

/** Which catalogue products an active pool draws from — the publication rule of
 *  §8.2 row 18, exposed for the admin so the effect of adding a product to a
 *  pool (its public counts go coarse) is visible before it is done. */
adminMysteryRoutes.post('/pool-membership', async (c) => {
  const b = await body(c);
  const ids = Array.isArray(b.product_ids) ? (b.product_ids as unknown[]).filter((x): x is string => typeof x === 'string') : [];
  const members = await activePoolProductIds(c.env.DB, ids);
  return c.json({ success: true, in_active_pool: [...members] });
});

/**
 * THE DRAW AUDIT TRAIL: which candidate list each past draw of this offer ran
 * against. With the allocation's own `seed` it reproduces any past winner years
 * later, which is the only thing an audit trail for a randomised money
 * mechanism exists to provide.
 */
adminMysteryRoutes.get('/offers/:productId/audits', async (c) => {
  const id = c.req.param('productId');
  const { results } = await c.env.DB
    .prepare(
      `SELECT order_id, cart_item_id, pool_id, candidates_sha256, created_at
         FROM mystery_draw_audits WHERE offer_product_id = ? ORDER BY created_at DESC LIMIT 100`
    )
    .bind(id)
    .all<Record<string, unknown>>();
  return c.json({ success: true, audits: results });
});
