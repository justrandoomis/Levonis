/**
 * THE BACKFILL MUST NOT MOVE ONE UNIT. §79/§84.
 *
 * Migration 0098 turns every existing stock identity into an opening inventory
 * lot. That is the single most dangerous statement in the whole inventory
 * feature: it runs once, against a live database holding real products, and if
 * it is wrong in either direction the shop either forgets units it owns or
 * invents units it does not.
 *
 * So this file does not test the SQL by reading it. It builds a database
 * through migration 0097 — the shape the live database is in today — seeds the
 * product shapes that actually exist in Levonis, snapshots every stock counter,
 * applies 0098, and asserts:
 *
 *     SUM(lots.qty_remaining) per identity  ===  that identity's stock column
 *
 * for every one of them, and that the counters themselves are byte-for-byte
 * what they were. `dbThrough('0097')` is what makes that honest: applying every
 * migration and then looking would prove nothing about the transition.
 *
 * THE SHAPES COVERED, because §79 names them and a partial list is how a
 * migration passes its test and loses a colour in production:
 *
 *   - BASE with stock and a known cost
 *   - BASE with stock and NO cost           → must stay unknown, not become 0
 *   - BASE with stock NULL (not tracked)    → no lot at all
 *   - BASE with stock 0                     → no lot at all
 *   - OPTION, several values, one untracked
 *   - OPTION where the value has its own cost, and where it only has an adjust
 *   - COLOR, the same two cost shapes
 *   - VARIANT_COMBINATION
 *   - a product whose mode says OPTION but which also carries base stock
 *     (only the authoritative rung may produce lots)
 *
 * Run: npx tsx --test tests/inventoryBackfill.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { ROOT } from './fixtures/d1';
import { dbThrough } from './fixtures/app';

const MIGRATION = join(ROOT, 'migrations/0098_inventory_lots.sql');

/** The database as it stands the moment before 0098 runs. */
function beforeMigration(): DatabaseSync {
  return dbThrough('0097');
}

function apply0098(raw: DatabaseSync): void {
  raw.exec(readFileSync(MIGRATION, 'utf8'));
}

/**
 * Re-runs ONLY the backfill INSERTs.
 *
 * The whole file cannot be executed twice and is not supposed to be: SQLite has
 * no `ALTER TABLE ... ADD COLUMN IF NOT EXISTS`, and D1 applies each migration
 * exactly once — `scripts/migrate-check.mjs --twice` is what proves that
 * bookkeeping holds. What DOES need to survive a second run is the data
 * backfill, because a repair re-run must not double the shop's inventory. So
 * this slices the file at the backfill marker and replays that part alone.
 */
function replayBackfill(raw: DatabaseSync): void {
  const sql = readFileSync(MIGRATION, 'utf8');
  const at = sql.indexOf('-- ---- BASE: the product');
  assert.ok(at > 0, 'the backfill marker moved — this test is now replaying the wrong thing');
  raw.exec(sql.slice(at));
}

let seq = 0;
const id = (p: string) => `${p}_${String(++seq).padStart(4, '0')}`;

interface ProductSeed {
  mode: 'BASE' | 'OPTION' | 'COLOR' | 'VARIANT_COMBINATION';
  stock: number | null;
  cost: number | null;
}

function product(raw: DatabaseSync, seed: ProductSeed): string {
  const pid = id('prd');
  raw
    .prepare(
      `INSERT INTO products (id, name, slug, price_iqd, product_cost_iqd, stock, inventory_mode, created_at)
       VALUES (?, ?, ?, 100000, ?, ?, ?, '2026-01-01T00:00:00.000Z')`
    )
    .run(pid, `P ${pid}`, pid, seed.cost, seed.stock, seed.mode);
  return pid;
}

function optionValue(
  raw: DatabaseSync,
  productId: string,
  stock: number | null,
  cost: number | null,
  adjust: number | null = null
): string {
  const gid = id('grp');
  raw
    .prepare(`INSERT INTO product_option_groups (id, product_id, name_en) VALUES (?, ?, 'Group')`)
    .run(gid, productId);
  const vid = id('opt');
  raw
    .prepare(
      `INSERT INTO product_option_values (id, product_id, group_id, name_en, stock, cost_iqd, cost_adjust_iqd, created_at)
       VALUES (?, ?, ?, 'V', ?, ?, ?, '2026-02-01T00:00:00.000Z')`
    )
    .run(vid, productId, gid, stock, cost, adjust);
  return vid;
}

function color(
  raw: DatabaseSync,
  productId: string,
  stock: number | null,
  cost: number | null,
  adjust: number | null = null
): string {
  const cid = id('col');
  raw
    .prepare(
      `INSERT INTO product_colors (id, product_id, name_en, hex, stock, cost_iqd, cost_adjust_iqd, created_at)
       VALUES (?, ?, 'Black', '#000000', ?, ?, ?, '2026-03-01T00:00:00.000Z')`
    )
    .run(cid, productId, stock, cost, adjust);
  return cid;
}

function variant(raw: DatabaseSync, productId: string, stock: number | null, cost: number | null): string {
  const vid = id('var');
  raw
    .prepare(
      `INSERT INTO product_variants (id, product_id, combo_key, stock, cost_iqd, created_at)
       VALUES (?, ?, ?, ?, ?, '2026-04-01T00:00:00.000Z')`
    )
    .run(vid, productId, vid, stock, cost);
  return vid;
}

interface LotRow {
  qty_received: number;
  qty_remaining: number;
  unit_cost_iqd: number | null;
  total_cost_iqd: number | null;
  cost_basis: string;
  received_at: string;
  product_id: string | null;
}

const lotsFor = (raw: DatabaseSync, scope: string, scopeId: string): LotRow[] =>
  raw
    .prepare(`SELECT * FROM inventory_lots WHERE scope = ? AND scope_id = ? ORDER BY id`)
    .all(scope, scopeId) as unknown as LotRow[];

/** Every stock counter in the database, as one comparable snapshot. */
function stockSnapshot(raw: DatabaseSync): string {
  const rows = [
    ...(raw.prepare(`SELECT 'base' k, id, stock FROM products ORDER BY id`).all() as unknown[]),
    ...(raw.prepare(`SELECT 'option' k, id, stock FROM product_option_values ORDER BY id`).all() as unknown[]),
    ...(raw.prepare(`SELECT 'color' k, id, stock FROM product_colors ORDER BY id`).all() as unknown[]),
    ...(raw.prepare(`SELECT 'variant' k, id, stock FROM product_variants ORDER BY id`).all() as unknown[]),
  ];
  return JSON.stringify(rows);
}

// =========================================================================
// THE INVARIANT
// =========================================================================

test('NOT ONE UNIT MOVES: every counter is identical after the migration', () => {
  const raw = beforeMigration();
  const base = product(raw, { mode: 'BASE', stock: 10, cost: 450_000 });
  void base;
  const optProduct = product(raw, { mode: 'OPTION', stock: null, cost: 300_000 });
  optionValue(raw, optProduct, 7, 320_000);
  optionValue(raw, optProduct, null, null);
  const colProduct = product(raw, { mode: 'COLOR', stock: null, cost: 200_000 });
  color(raw, colProduct, 4, null, 15_000);
  const varProduct = product(raw, { mode: 'VARIANT_COMBINATION', stock: null, cost: 111_000 });
  variant(raw, varProduct, 3, 125_000);

  const before = stockSnapshot(raw);
  apply0098(raw);
  assert.equal(stockSnapshot(raw), before, 'the migration changed a stock counter');
});

test('every identity that HAD units has exactly that many in lots', () => {
  const raw = beforeMigration();
  const basePid = product(raw, { mode: 'BASE', stock: 10, cost: 450_000 });
  const optPid = product(raw, { mode: 'OPTION', stock: null, cost: 300_000 });
  const optId = optionValue(raw, optPid, 7, 320_000);
  const colPid = product(raw, { mode: 'COLOR', stock: null, cost: 200_000 });
  const colId = color(raw, colPid, 4, 210_000);
  const varPid = product(raw, { mode: 'VARIANT_COMBINATION', stock: null, cost: 111_000 });
  const varId = variant(raw, varPid, 3, 125_000);

  apply0098(raw);

  const sum = (scope: string, scopeId: string) =>
    lotsFor(raw, scope, scopeId).reduce((n, l) => n + l.qty_remaining, 0);

  assert.equal(sum('base', ''), 10);
  assert.equal(sum('option', optId), 7);
  assert.equal(sum('color', colId), 4);
  assert.equal(sum('variant', varId), 3);
  void basePid;
});

// =========================================================================
// WHAT MUST NOT PRODUCE A LOT
// =========================================================================

test('untracked stock (NULL) produces no lot — NULL is not zero and not a shelf', () => {
  const raw = beforeMigration();
  const pid = product(raw, { mode: 'BASE', stock: null, cost: 450_000 });
  apply0098(raw);
  assert.deepEqual(lotsFor(raw, 'base', ''), []);
  void pid;
});

test('a tracked identity holding zero units produces no lot', () => {
  const raw = beforeMigration();
  product(raw, { mode: 'BASE', stock: 0, cost: 450_000 });
  apply0098(raw);
  assert.deepEqual(lotsFor(raw, 'base', ''), []);
});

test('ONLY THE AUTHORITATIVE RUNG produces lots', () => {
  /**
   * The failure this catches: a product whose `inventory_mode` is OPTION may
   * still carry a leftover number in `products.stock` from before it grew
   * options. `worker/lib/inventory.ts` ignores it — "a level that is not
   * authoritative is never consulted" — and the backfill must ignore it too.
   * A base lot here would invent units the shop cannot sell and would put the
   * inventory VALUE report permanently above the truth.
   */
  const raw = beforeMigration();
  const pid = product(raw, { mode: 'OPTION', stock: 99, cost: 300_000 });
  const optId = optionValue(raw, pid, 7, 320_000);
  apply0098(raw);

  assert.deepEqual(lotsFor(raw, 'base', ''), [], 'the non-authoritative base counter produced a lot');
  assert.equal(lotsFor(raw, 'option', optId)[0].qty_remaining, 7);
});

// =========================================================================
// COST: RESOLVED WHERE IT CAN BE, UNKNOWN WHERE IT CANNOT
// =========================================================================

test('a known product cost becomes the opening lot cost', () => {
  const raw = beforeMigration();
  product(raw, { mode: 'BASE', stock: 10, cost: 450_000 });
  apply0098(raw);
  const [lot] = lotsFor(raw, 'base', '');
  assert.equal(lot.unit_cost_iqd, 450_000);
  assert.equal(lot.total_cost_iqd, 4_500_000);
  assert.equal(lot.cost_basis, 'opening');
});

test('NO COST STAYS UNKNOWN — it must never be backfilled as zero', () => {
  /**
   * §21 and §84. A lot priced at 0 would report 100% margin on every unit of
   * it, which is not a small error: it is a number the owner would make
   * decisions on. Unknown has to survive the migration as unknown.
   */
  const raw = beforeMigration();
  product(raw, { mode: 'BASE', stock: 10, cost: null });
  apply0098(raw);
  const [lot] = lotsFor(raw, 'base', '');
  assert.equal(lot.unit_cost_iqd, null, 'an unknown cost was invented');
  assert.equal(lot.total_cost_iqd, null);
  assert.equal(lot.cost_basis, 'opening_unpriced');
  assert.equal(lot.qty_remaining, 10, 'but the units are still there');
});

test("an option value's own cost wins over the product's", () => {
  const raw = beforeMigration();
  const pid = product(raw, { mode: 'OPTION', stock: null, cost: 300_000 });
  const optId = optionValue(raw, pid, 5, 320_000);
  apply0098(raw);
  assert.equal(lotsFor(raw, 'option', optId)[0].unit_cost_iqd, 320_000);
});

test('an adjustment applies to the product cost when the rung has no fixed one', () => {
  // The same precedence migration 0096's cost trigger uses: a fixed cost wins,
  // otherwise an adjustment moves rung 0, otherwise rung 0 stands.
  const raw = beforeMigration();
  const pid = product(raw, { mode: 'COLOR', stock: null, cost: 200_000 });
  const colId = color(raw, pid, 4, null, 15_000);
  apply0098(raw);
  assert.equal(lotsFor(raw, 'color', colId)[0].unit_cost_iqd, 215_000);
});

test('an adjustment cannot drive a cost below zero', () => {
  const raw = beforeMigration();
  const pid = product(raw, { mode: 'COLOR', stock: null, cost: 10_000 });
  const colId = color(raw, pid, 2, null, -50_000);
  apply0098(raw);
  assert.equal(lotsFor(raw, 'color', colId)[0].unit_cost_iqd, 0);
});

test('an option with no cost anywhere is unpriced, not free', () => {
  const raw = beforeMigration();
  const pid = product(raw, { mode: 'OPTION', stock: null, cost: null });
  const optId = optionValue(raw, pid, 6, null);
  apply0098(raw);
  const [lot] = lotsFor(raw, 'option', optId);
  assert.equal(lot.unit_cost_iqd, null);
  assert.equal(lot.cost_basis, 'opening_unpriced');
});

// =========================================================================
// SHAPE OF THE OPENING LOT
// =========================================================================

test('the opening lot is dated when the stock existed, not when the migration ran', () => {
  /**
   * §46: the aging report reads `received_at`. Stamping every opening lot with
   * the migration date would open the feature by reporting that a shop with
   * two-year-old dead stock has nothing older than a day — a report that lies
   * on its first screen is a report nobody comes back to.
   */
  const raw = beforeMigration();
  product(raw, { mode: 'BASE', stock: 10, cost: 450_000 });
  apply0098(raw);
  assert.equal(lotsFor(raw, 'base', '')[0].received_at, '2026-01-01T00:00:00.000Z');
});

test('re-running the backfill adds nothing — a repair must not double the shop', () => {
  // The guarded INSERTs are what let scripts/migrate-check.mjs prove this, and
  // what makes a repair re-run safe rather than a doubling of the inventory.
  const raw = beforeMigration();
  const pid = product(raw, { mode: 'BASE', stock: 10, cost: 450_000 });
  const optPid = product(raw, { mode: 'OPTION', stock: null, cost: 300_000 });
  const optId = optionValue(raw, optPid, 7, 320_000);
  apply0098(raw);
  replayBackfill(raw);
  replayBackfill(raw);

  const base = lotsFor(raw, 'base', '');
  assert.equal(base.length, 1, 'the base identity was backfilled more than once');
  assert.equal(base[0].qty_remaining, 10);
  const opt = lotsFor(raw, 'option', optId);
  assert.equal(opt.length, 1, 'the option identity was backfilled more than once');
  assert.equal(opt[0].qty_remaining, 7);
  void pid;
});

test('the backfill skips an identity that already has a lot, whatever its source', () => {
  /**
   * The case a re-run really has to survive: the migration ran, the shop then
   * RECEIVED a real purchase, and someone re-runs the repair. The guard is on
   * the identity having ANY lot — not on the opening lot's id — so the received
   * lot stops the backfill from inventing a second opening layer over units it
   * already accounts for.
   */
  const raw = beforeMigration();
  const pid = product(raw, { mode: 'BASE', stock: 10, cost: 450_000 });
  apply0098(raw);
  raw.exec(`DELETE FROM inventory_lots`);
  raw
    .prepare(
      `INSERT INTO inventory_lots (id, product_id, scope, scope_id, qty_received, qty_remaining,
                                   unit_cost_iqd, cost_basis, received_at)
       VALUES ('ilot_real', ?, 'base', '', 10, 10, 560000, 'received', '2026-09-01T00:00:00.000Z')`
    )
    .run(pid);

  replayBackfill(raw);

  const lots = lotsFor(raw, 'base', '');
  assert.equal(lots.length, 1, 'the backfill layered an opening lot over real received stock');
  assert.equal(lots[0].cost_basis, 'received');
});

test('the lot carries its product, so inventory can be read per product', () => {
  const raw = beforeMigration();
  const pid = product(raw, { mode: 'OPTION', stock: null, cost: 300_000 });
  const optId = optionValue(raw, pid, 5, 320_000);
  apply0098(raw);
  assert.equal(lotsFor(raw, 'option', optId)[0].product_id, pid);
});

// =========================================================================
// THE PHYSICAL COLUMNS
// =========================================================================

test('product and package dimensions are separate, nullable, integer columns', () => {
  /**
   * §29: a printer is 385x410x430 and its carton is 500x550x600. Two datasets.
   * Nullable because almost no existing product has been measured, and a
   * default of 0 would be a measurement nobody took.
   */
  const raw = beforeMigration();
  apply0098(raw);
  const cols = new Map(
    (raw.prepare(`PRAGMA table_info(products)`).all() as Array<{ name: string; type: string; notnull: number }>).map(
      (c) => [c.name, c]
    )
  );
  for (const name of [
    'net_weight_g',
    'width_mm',
    'depth_mm',
    'height_mm',
    'package_weight_g',
    'package_width_mm',
    'package_depth_mm',
    'package_height_mm',
  ]) {
    const col = cols.get(name);
    assert.ok(col, `${name} is missing`);
    assert.equal(col!.type, 'INTEGER', `${name} must be a canonical integer, not a display string`);
    assert.equal(col!.notnull, 0, `${name} must be nullable — an unmeasured product is not zero-sized`);
  }
  // And no stored volume: it is l x w x h and a third copy can disagree (§30).
  assert.equal(cols.has('package_volume_mm3'), false);
});

test('the serial chain gains exactly one link and no second serial system', () => {
  const raw = beforeMigration();
  apply0098(raw);
  const cols = (raw.prepare(`PRAGMA table_info(order_item_units)`).all() as Array<{ name: string }>).map((c) => c.name);
  assert.ok(cols.includes('inventory_lot_id'), 'the lot link is missing');
  // device_serials is untouched — §41 forbids a conflicting serial system.
  const serials = raw.prepare(`SELECT COUNT(*) AS n FROM sqlite_master WHERE type='table' AND name='device_serials'`).get() as { n: number };
  assert.equal(serials.n, 1);
});
