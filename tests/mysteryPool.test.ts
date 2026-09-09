/**
 * CASE 14 of the owner's seventeen — "no eligible stock ⇒ a genuine
 * out-of-stock state" — docs/BUNDLES_MYSTERY.md §7.2, §7.6.
 *
 * The candidate query is the whole safety of a random offer. Everything it
 * lets through will be SOLD, reserved against a real stock row and shipped, so
 * every one of its exclusions is asserted here against the real schema over the
 * real transactional SqliteD1: zero stock, weight 0, an inactive entry, a draft
 * product, an inactive colour, an untracked row in a direct pool, a pool-kind
 * disagreement, a failed catalog requirement and a failed facet requirement.
 *
 * And two things it must NEVER do:
 *
 *   ELIGIBILITY IS NEVER DECIDED BY A PRODUCT NAME. A product called
 *   "Premium PLA Filament" with no structured catalog membership is excluded
 *   from a filament pool, and a product called "Widget 7" that IS in the
 *   catalogue is included. `packages/pricing/src/availability.ts` documents name
 *   parsing as a last resort; it is not used here at all.
 *
 *   A DIRECT SALE IS NEVER SILENTLY CONVERTED INTO A PRE-ORDER. The two pools
 *   are separate rows with their own `kind`; an empty direct pool answers
 *   `MYSTERY_NO_ELIGIBLE_STOCK`, never "we'll order it for you".
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { ROOT } from './fixtures/d1';
import { freshDb, asD1, count } from './fixtures/app';
import {
  drawSpools,
  loadCandidates,
  loadPool,
  mysteryAvailability,
  resolveMysteryMode,
  type MysteryOffer,
} from '../worker/lib/mysteryDraw';
import { HttpError } from '../worker/lib/http';

const OK_OFFER = { ok: true, reason: null, required_tiers: [] as never[], locked_preview: true };
const WINDOW = { starts_at: null, ends_at: null, nowMs: Date.parse('2026-06-01T00:00:00Z') };

function seed(raw: DatabaseSync) {
  raw.exec(`
    INSERT INTO catalogs (id, slug, name_ar, name_en) VALUES ('cat_filament','mystery-test-filament','فتائل','Filament');
    INSERT INTO facets (id, slug, name_en, kind) VALUES ('fct_pla','mystery-test-pla','PLA','material');

    INSERT INTO products (id,slug,name,name_ar,price_iqd,status,stock,inventory_mode,options,colors,selling_type,sale_types,preorder_transports,images)
    VALUES
      ('p_red','red','Widget 7','ريد',25000,'active',10,'BASE','[]','[]','direct_sale','["direct_sale"]','[]','[]'),
      ('p_empty','empty','Empty Spool','فارغ',25000,'active',0,'BASE','[]','[]','direct_sale','["direct_sale"]','[]','[]'),
      ('p_draft','draft','Draft Spool','مسودة',25000,'draft',9,'BASE','[]','[]','direct_sale','["direct_sale"]','[]','[]'),
      ('p_untracked','untracked','Untracked Spool','بلا تتبع',25000,'active',NULL,'BASE','[]','[]','direct_sale','["direct_sale"]','[]','[]'),
      ('p_pre','pre','Pre-order Spool','مسبق',25000,'active',NULL,'BASE','[]','[]','pre_order','["pre_order"]','["air"]','[]'),
      ('p_named','named','Premium PLA Filament','فتيل',25000,'active',7,'BASE','[]','[]','direct_sale','["direct_sale"]','[]','[]'),
      ('p_colors','colors','Colour Spool','ألوان',25000,'active',NULL,'COLOR','[]','[]','direct_sale','["direct_sale"]','[]','[]'),
      ('p_bundle','bundlerow','A Bundle','حزمة',90000,'active',NULL,'BASE','[]','[]','bundle','["bundle"]','[]','[]');
    UPDATE products SET composition='bundle' WHERE id='p_bundle';

    INSERT INTO product_colors (id,product_id,name_en,hex,stock,reserved,active)
    VALUES ('clr_black','p_colors','Black','#000000',4,0,1),
           ('clr_white','p_colors','White','#ffffff',4,0,0);

    -- Structured taxonomy. p_named is deliberately NOT a member, though its
    -- NAME says filament; p_red is a member, though its name says nothing.
    INSERT INTO product_catalogs (product_id, catalog_id, position)
      VALUES ('p_red','cat_filament',1), ('p_colors','cat_filament',2), ('p_empty','cat_filament',3);
    INSERT INTO product_facets (product_id, facet_id) VALUES ('p_red','fct_pla');
  `);
}

const pool = (raw: DatabaseSync, id: string, kind: 'direct' | 'preorder', over: Record<string, unknown> = {}) => {
  raw
    .prepare(
      `INSERT INTO mystery_pools (id,name,kind,active,require_catalog_ids,require_facet_ids,min_available)
       VALUES (?,?,?,?,?,?,?)`
    )
    .run(
      id,
      String(over.name ?? id),
      kind,
      over.active === 0 ? 0 : 1,
      JSON.stringify(over.require_catalog_ids ?? []),
      JSON.stringify(over.require_facet_ids ?? []),
      Number(over.min_available ?? 1)
    );
  return id;
};

const entry = (
  raw: DatabaseSync,
  id: string,
  poolId: string,
  productId: string,
  over: { colorId?: string; values?: string[]; weight?: number; active?: number; family?: string } = {}
) => {
  raw
    .prepare(
      `INSERT INTO mystery_pool_entries (id,pool_id,product_id,option_value_ids,color_id,family_id,weight,active)
       VALUES (?,?,?,?,?,?,?,?)`
    )
    .run(
      id,
      poolId,
      productId,
      JSON.stringify(over.values ?? []),
      over.colorId ?? '',
      over.family ?? '',
      over.weight ?? 1,
      over.active ?? 1
    );
  return id;
};

const offerOf = (over: Partial<MysteryOffer> = {}): MysteryOffer => ({
  product_id: 'p_offer',
  direct_pool_id: null,
  preorder_pool_id: null,
  spool_qty: 1,
  allow_direct: true,
  allow_preorder: false,
  customer_picks_family: false,
  ...over,
});

// ------------------------------------------------------------- exclusions

test('every unsellable entry is excluded, and the admin is told exactly why', async () => {
  const raw = freshDb();
  seed(raw);
  const db = asD1(raw);
  const id = pool(raw, 'mpl_1', 'direct');
  entry(raw, 'mpe_ok', id, 'p_red');
  entry(raw, 'mpe_empty', id, 'p_empty');
  entry(raw, 'mpe_draft', id, 'p_draft');
  entry(raw, 'mpe_untracked', id, 'p_untracked');
  entry(raw, 'mpe_pre', id, 'p_pre');
  entry(raw, 'mpe_zero', id, 'p_named', { weight: 0 });
  entry(raw, 'mpe_off', id, 'p_named', { active: 0, colorId: '' , values: []});
  entry(raw, 'mpe_white', id, 'p_colors', { colorId: 'clr_white' });
  entry(raw, 'mpe_black', id, 'p_colors', { colorId: 'clr_black' });
  entry(raw, 'mpe_nested', id, 'p_bundle');

  const set = await loadCandidates(db, (await loadPool(db, id))!, { preview: true });
  const reasons = new Map(set.excluded.map((e) => [e.entry_id, e.reason]));
  assert.equal(reasons.get('mpe_empty'), 'BELOW_MIN_AVAILABLE', 'zero stock cannot back a direct sale');
  assert.equal(reasons.get('mpe_draft'), 'PRODUCT_INACTIVE');
  assert.equal(reasons.get('mpe_untracked'), 'UNTRACKED_DIRECT');
  assert.equal(reasons.get('mpe_pre'), 'MODE_MISMATCH', 'a pre-order product is not direct-sale inventory');
  assert.equal(reasons.get('mpe_zero'), 'ZERO_WEIGHT');
  assert.equal(reasons.get('mpe_off'), 'ENTRY_INACTIVE');
  assert.equal(reasons.get('mpe_white'), 'SELECTION_INACTIVE', 'a deactivated colour is not sellable');
  assert.equal(reasons.get('mpe_nested'), 'COMPOSITION_NESTED', 'never a bundle inside a mystery pool');

  assert.deepEqual(
    set.candidates.map((c) => c.entry_id).sort(),
    ['mpe_black', 'mpe_ok'],
    'only the two genuinely sellable entries survive'
  );
  // The survivors carry the REAL stock answer and the frozen display.
  const black = set.candidates.find((c) => c.entry_id === 'mpe_black')!;
  assert.equal(black.available, 4);
  assert.equal(black.variant_snapshot, 'Black');
  assert.equal(black.targets[0].scope, 'color');
  assert.equal(black.targets[0].scope_id, 'clr_black');
});

test('the DRAW query never even sees the excluded rows the preview explains', async () => {
  const raw = freshDb();
  seed(raw);
  const db = asD1(raw);
  const id = pool(raw, 'mpl_1', 'direct');
  entry(raw, 'mpe_ok', id, 'p_red');
  entry(raw, 'mpe_zero', id, 'p_named', { weight: 0 });
  entry(raw, 'mpe_draft', id, 'p_draft');

  const set = await loadCandidates(db, (await loadPool(db, id))!);
  assert.deepEqual(set.candidates.map((c) => c.entry_id), ['mpe_ok']);
  assert.deepEqual(set.excluded, [], 'a customer path never computes a reason it must not disclose');
});

test('two entries naming ONE stock row are not two slots on the wheel', async () => {
  // Same product, same (empty) selection, two rows: double weight for one
  // filament and a supply figure that counts its units twice. The primary key
  // cannot forbid it — the ids differ — so the loader does, and says so.
  const raw = freshDb();
  seed(raw);
  const db = asD1(raw);
  const id = pool(raw, 'mpl_1', 'direct');
  entry(raw, 'mpe_first', id, 'p_red');
  entry(raw, 'mpe_twin', id, 'p_red');
  const set = await loadCandidates(db, (await loadPool(db, id))!, { preview: true });
  assert.deepEqual(set.candidates.map((c) => c.entry_id), ['mpe_first']);
  assert.equal(set.excluded[0].reason, 'DUPLICATE_ENTRY');
});

test('min_available is a floor, not a suggestion', async () => {
  const raw = freshDb();
  seed(raw);
  raw.exec("UPDATE products SET stock = 2 WHERE id = 'p_red'");
  const db = asD1(raw);
  const id = pool(raw, 'mpl_1', 'direct', { min_available: 3 });
  entry(raw, 'mpe_ok', id, 'p_red');
  const set = await loadCandidates(db, (await loadPool(db, id))!, { preview: true });
  assert.deepEqual(set.candidates, []);
  assert.equal(set.excluded[0].reason, 'BELOW_MIN_AVAILABLE');
  assert.equal(set.excluded[0].available, 2);
});

// -------------------------------------------- eligibility is never a NAME

test('a catalog requirement is structural: a matching NAME is not membership', async () => {
  const raw = freshDb();
  seed(raw);
  const db = asD1(raw);
  const id = pool(raw, 'mpl_1', 'direct', { require_catalog_ids: ['cat_filament'] });
  entry(raw, 'mpe_named', id, 'p_named'); // "Premium PLA Filament", no membership
  entry(raw, 'mpe_red', id, 'p_red'); // "Widget 7", a real member

  const set = await loadCandidates(db, (await loadPool(db, id))!, { preview: true });
  assert.deepEqual(set.candidates.map((c) => c.product_id), ['p_red']);
  assert.equal(set.excluded.find((e) => e.entry_id === 'mpe_named')!.reason, 'CATALOG_REQUIRED');
});

test('a facet requirement is structural too', async () => {
  const raw = freshDb();
  seed(raw);
  const db = asD1(raw);
  const id = pool(raw, 'mpl_1', 'direct', { require_facet_ids: ['fct_pla'] });
  entry(raw, 'mpe_red', id, 'p_red');
  entry(raw, 'mpe_named', id, 'p_named');
  const set = await loadCandidates(db, (await loadPool(db, id))!, { preview: true });
  assert.deepEqual(set.candidates.map((c) => c.product_id), ['p_red']);
  assert.equal(set.excluded.find((e) => e.entry_id === 'mpe_named')!.reason, 'FACET_REQUIRED');
});

test('the engine contains no product-name matching at all', () => {
  const src = readFileSync(join(ROOT, 'worker/lib/mysteryDraw.ts'), 'utf8');
  // The candidate SQL may SELECT p.name for the frozen display snapshot, but it
  // must never FILTER on it.
  assert.doesNotMatch(src, /WHERE[\s\S]{0,400}p\.name\s+LIKE/i);
  assert.doesNotMatch(src, /availabilityFromName|nameLooksLike/i);
});

// --------------------------------------------- the honest out-of-stock state

test('a pool whose every entry is unsellable is SOLD OUT, and refuses with 503', async () => {
  const raw = freshDb();
  seed(raw);
  const db = asD1(raw);
  const id = pool(raw, 'mpl_1', 'direct');
  entry(raw, 'mpe_empty', id, 'p_empty');
  entry(raw, 'mpe_draft', id, 'p_draft');
  entry(raw, 'mpe_zero', id, 'p_named', { weight: 0 });
  entry(raw, 'mpe_white', id, 'p_colors', { colorId: 'clr_white' });

  const set = await loadCandidates(db, (await loadPool(db, id))!);
  assert.deepEqual(set.candidates, []);

  const availability = mysteryAvailability({
    offerProductId: 'p_offer',
    spoolQty: 1,
    mode: 'direct',
    candidates: set.candidates,
    window: WINDOW,
    active: true,
    offer: OK_OFFER,
  });
  assert.equal(availability.state, 'sold_out');
  assert.equal(availability.max_bundles, 0);
  assert.ok(availability.errors.includes('MYSTERY_NO_ELIGIBLE_STOCK'));

  const drawn = drawSpools({ seed: 'a'.repeat(64), cartItemId: 'ci_1', spools: 1, candidates: set.candidates, duplicatePolicy: 'allow' });
  assert.equal(drawn.ok, false);
  assert.equal(drawn.ok === false && drawn.code, 'MYSTERY_NO_ELIGIBLE_STOCK');

  // Nothing was written by asking.
  assert.equal(count(raw, 'SELECT COUNT(*) AS n FROM mystery_allocations'), 0);
  assert.equal(count(raw, 'SELECT COUNT(*) AS n FROM mystery_draw_audits'), 0);
  assert.equal(count(raw, 'SELECT COUNT(*) AS n FROM inventory_ledger'), 0);
});

test('availability is floor(Σ eligible available / spool_qty), through the SAME function a bundle uses', async () => {
  const raw = freshDb();
  seed(raw);
  const db = asD1(raw);
  const id = pool(raw, 'mpl_1', 'direct');
  entry(raw, 'mpe_red', id, 'p_red'); // 10
  entry(raw, 'mpe_black', id, 'p_colors', { colorId: 'clr_black' }); // 4
  const set = await loadCandidates(db, (await loadPool(db, id))!);

  const one = mysteryAvailability({ offerProductId: 'p_offer', spoolQty: 1, mode: 'direct', candidates: set.candidates, window: WINDOW, active: true, offer: OK_OFFER });
  assert.equal(one.max_bundles, 14);
  assert.equal(one.state, 'in_stock');

  const four = mysteryAvailability({ offerProductId: 'p_offer', spoolQty: 4, mode: 'direct', candidates: set.candidates, window: WINDOW, active: true, offer: OK_OFFER });
  assert.equal(four.max_bundles, 3, '14 units, four spools per offer');
  assert.equal(four.state, 'low', 'three left or fewer is low, by the composition rule');
});

// ------------------------------------------------- direct is never converted

test('a direct purchase is never converted into a pre-order', async () => {
  const raw = freshDb();
  seed(raw);
  const db = asD1(raw);
  const direct = pool(raw, 'mpl_direct', 'direct');
  const pre = pool(raw, 'mpl_pre', 'preorder');
  entry(raw, 'mpe_empty', direct, 'p_empty'); // the direct pool has nothing
  entry(raw, 'mpe_pre', pre, 'p_pre'); // the pre-order pool is healthy

  const offer = offerOf({ direct_pool_id: direct, preorder_pool_id: pre, allow_direct: true, allow_preorder: true });
  const chosen = resolveMysteryMode(offer, 'direct');
  assert.deepEqual(chosen, { mode: 'direct', pool_id: 'mpl_direct' }, 'the direct request keeps the direct pool');

  const set = await loadCandidates(db, (await loadPool(db, chosen.pool_id))!);
  assert.deepEqual(set.candidates, [], 'and it is empty, so the answer is sold out');

  // The pre-order pool would have answered — and is deliberately not consulted.
  const preSet = await loadCandidates(db, (await loadPool(db, pre))!);
  assert.equal(preSet.candidates.length, 1);
});

test('a mode that is disabled, or has no pool, refuses with MYSTERY_MODE_NOT_AVAILABLE', () => {
  const direct = offerOf({ direct_pool_id: 'mpl_direct', allow_direct: true, allow_preorder: false });
  assert.throws(
    () => resolveMysteryMode(direct, 'preorder'),
    (e: unknown) => {
      assert.ok(e instanceof HttpError);
      assert.equal(e.code, 'MYSTERY_MODE_NOT_AVAILABLE');
      assert.equal(e.status, 400);
      return true;
    }
  );
  // Enabled but unconfigured is the same refusal: a customer must never meet a
  // half-built offer as a 500.
  const unpooled = offerOf({ direct_pool_id: null, allow_direct: true });
  const code = (fn: () => unknown) => {
    try {
      fn();
    } catch (e) {
      return (e as HttpError).code;
    }
    return 'no refusal';
  };
  assert.equal(code(() => resolveMysteryMode(unpooled, 'direct')), 'MYSTERY_MODE_NOT_AVAILABLE');
  assert.equal(code(() => resolveMysteryMode(unpooled, null)), 'MYSTERY_MODE_NOT_AVAILABLE');
  // One enabled mode needs no request.
  assert.deepEqual(resolveMysteryMode(direct, null), { mode: 'direct', pool_id: 'mpl_direct' });
});

test('a pre-order pool does not test stock, and a direct pool always does', async () => {
  const raw = freshDb();
  seed(raw);
  const db = asD1(raw);
  const pre = pool(raw, 'mpl_pre', 'preorder');
  entry(raw, 'mpe_pre', pre, 'p_pre'); // stock NULL, pre-order
  const set = await loadCandidates(db, (await loadPool(db, pre))!, { preview: true });
  assert.deepEqual(set.candidates.map((c) => c.entry_id), ['mpe_pre']);
  assert.equal(set.candidates[0].available, null);

  const availability = mysteryAvailability({
    offerProductId: 'p_offer',
    spoolQty: 1,
    mode: 'preorder',
    candidates: set.candidates,
    transportMethod: 'air',
    window: WINDOW,
    active: true,
    offer: OK_OFFER,
  });
  assert.equal(availability.state, 'preorder');
  assert.equal(availability.max_bundles, null, 'untracked pre-order stock bounds nothing');
  assert.equal(availability.shipping_type, 'preorder_air');

  // The same entry in a DIRECT pool is refused rather than sold from nothing.
  const direct = pool(raw, 'mpl_direct', 'direct');
  entry(raw, 'mpe_pre2', direct, 'p_pre');
  const directSet = await loadCandidates(db, (await loadPool(db, direct))!, { preview: true });
  assert.deepEqual(directSet.candidates, []);
  assert.equal(directSet.excluded[0].reason, 'MODE_MISMATCH');
});

test('the family narrowing filters by a taxonomy id, and only that', async () => {
  const raw = freshDb();
  seed(raw);
  const db = asD1(raw);
  const id = pool(raw, 'mpl_1', 'direct');
  entry(raw, 'mpe_red', id, 'p_red', { family: 'fct_pla' });
  entry(raw, 'mpe_black', id, 'p_colors', { colorId: 'clr_black', family: 'fct_petg' });
  const p = (await loadPool(db, id))!;
  assert.deepEqual((await loadCandidates(db, p, { familyId: 'fct_pla' })).candidates.map((c) => c.entry_id), ['mpe_red']);
  assert.deepEqual((await loadCandidates(db, p, { familyId: '' })).candidates.map((c) => c.entry_id).sort(), ['mpe_black', 'mpe_red']);
  assert.deepEqual((await loadCandidates(db, p, { familyId: 'fct_nothing' })).candidates, []);
});
