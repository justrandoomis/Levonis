/**
 * MULTI-SPOOL AND THE DUPLICATE POLICY — docs/BUNDLES_MYSTERY.md §7.5.
 *
 * `spool_qty × qty` spools are drawn sequentially from one wheel, and the three
 * policies have exact, testable meanings rather than intentions:
 *
 *   allow       the wheel is unchanged between draws
 *   discourage  the drawn candidate's weight is HALVED (integer division,
 *               minimum 1) for the remaining draws on this line
 *   forbid      the drawn candidate is removed; if the wheel empties before
 *               every spool is drawn the checkout is REFUSED with
 *               MYSTERY_NOT_ENOUGH_VARIETY — never silently downgraded to
 *               `allow`, and never carrying a count (§7.5, §15.1: a count is a
 *               free oracle over live inventory).
 *
 * And the reservation half, which is the part that costs real money: three
 * spools produce three allocations and three `reserve` ledger rows IN ONE
 * BATCH, or none at all. The last assertion runs a concurrent writer between
 * the plan and the commit, exactly as `failingD1` exists to do, and proves the
 * fence rolls the whole thing back — no order, no allocation, no ledger row and
 * no half-held stock.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { DatabaseSync } from 'node:sqlite';
import { freshDb, asD1, failingD1, count, all } from './fixtures/app';
import {
  allocationStatement,
  candidatesDigest,
  drawAuditStatement,
  drawSpools,
  loadCandidates,
  loadPool,
  type MysteryCandidate,
} from '../worker/lib/mysteryDraw';
import { planInventory, planReservationFence, type StockMove } from '../worker/lib/inventory';

const SEED = 'a1b2c3d4'.repeat(8);

const candidate = (id: string, weight: number, available: number | null = 100): MysteryCandidate => ({
  entry_id: id,
  product_id: `p_${id}`,
  option_value_ids: [],
  color_id: '',
  family_id: '',
  weight,
  available,
  targets: [],
  name_snapshot: id,
  image_snapshot: '',
  variant_snapshot: '',
});

// ------------------------------------------------------- the three policies

test('forbid never repeats, and refuses with MYSTERY_NOT_ENOUGH_VARIETY when the wheel empties', () => {
  const three = [candidate('a', 1), candidate('b', 1), candidate('c', 1)];
  const ok = drawSpools({ seed: SEED, cartItemId: 'ci_1', spools: 3, candidates: three, duplicatePolicy: 'forbid' });
  assert.equal(ok.ok, true);
  if (!ok.ok) return;
  const ids = ok.spools.map((s) => s.candidate.entry_id);
  assert.equal(new Set(ids).size, 3, 'three spools, three distinct choices');

  const tooMany = drawSpools({ seed: SEED, cartItemId: 'ci_1', spools: 4, candidates: three, duplicatePolicy: 'forbid' });
  assert.equal(tooMany.ok, false);
  assert.equal(tooMany.ok === false && tooMany.code, 'MYSTERY_NOT_ENOUGH_VARIETY');
});

test('forbid is never silently downgraded to allow', () => {
  const one = [candidate('only', 1, 50)];
  const res = drawSpools({ seed: SEED, cartItemId: 'ci_1', spools: 2, candidates: one, duplicatePolicy: 'forbid' });
  assert.equal(res.ok, false, 'plenty of stock, but only one distinct choice');
  assert.equal(res.ok === false && res.code, 'MYSTERY_NOT_ENOUGH_VARIETY');
  // The same wheel under `allow` sells both spools, so the refusal above is the
  // policy speaking and not a stock problem in disguise.
  const allowed = drawSpools({ seed: SEED, cartItemId: 'ci_1', spools: 2, candidates: one, duplicatePolicy: 'allow' });
  assert.equal(allowed.ok, true);
});

test('running out of STOCK is a different refusal from running out of VARIETY', () => {
  const res = drawSpools({
    seed: SEED,
    cartItemId: 'ci_1',
    spools: 3,
    candidates: [candidate('a', 1, 1), candidate('b', 1, 1)],
    duplicatePolicy: 'forbid',
  });
  assert.equal(res.ok, false);
  assert.equal(
    res.ok === false && res.code,
    'MYSTERY_NO_ELIGIBLE_STOCK',
    'both choices were used up entirely, so there is nothing left to sell — not a variety problem'
  );
});

test('discourage halves the drawn weight (integer division, minimum 1) and never removes it', () => {
  // A dominant candidate at weight 64 against a field of 1s. Under `allow` it
  // wins nearly every spool; under `discourage` its weight decays 64 → 32 → 16
  // … so the field catches up, and it is still reachable at the end.
  const field = [candidate('big', 64), candidate('a', 1), candidate('b', 1), candidate('c', 1)];
  const spools = 12;
  const allowed = drawSpools({ seed: SEED, cartItemId: 'ci_1', spools, candidates: field, duplicatePolicy: 'allow' });
  const discouraged = drawSpools({ seed: SEED, cartItemId: 'ci_1', spools, candidates: field, duplicatePolicy: 'discourage' });
  assert.equal(allowed.ok && discouraged.ok, true);
  if (!allowed.ok || !discouraged.ok) return;
  const bigIn = (r: typeof allowed) => r.spools.filter((s) => s.candidate.entry_id === 'big').length;
  assert.ok(bigIn(allowed) > bigIn(discouraged), 'discouraging the winner must lower its share');
  assert.ok(bigIn(discouraged) >= 1, 'discourage is not forbid: the candidate stays on the wheel');

  // The rule is arithmetic, not a mood: weight 1 halves to 1 and the candidate
  // can still be drawn every time when it is the only one.
  const single = drawSpools({ seed: SEED, cartItemId: 'ci_2', spools: 3, candidates: [candidate('one', 1, 9)], duplicatePolicy: 'discourage' });
  assert.equal(single.ok, true);
  assert.equal(single.ok && single.spools.length, 3);
});

test('allow leaves the wheel untouched between draws', () => {
  const res = drawSpools({ seed: SEED, cartItemId: 'ci_1', spools: 5, candidates: [candidate('a', 1), candidate('b', 1)], duplicatePolicy: 'allow' });
  assert.equal(res.ok, true);
  if (!res.ok) return;
  assert.equal(res.spools.length, 5);
  // With two equal candidates and five spools, at least one must repeat — which
  // is exactly what `allow` means.
  assert.ok(new Set(res.spools.map((s) => s.candidate.entry_id)).size < 5);
});

// ------------------------------------------- three spools, or none at all

function seed(raw: DatabaseSync) {
  raw.exec(`
    INSERT INTO users (id,name,email,password_hash,role) VALUES ('buyer','Sara','s@x.co','h','customer');
    INSERT INTO products (id,slug,name,name_ar,price_iqd,status,stock,inventory_mode,options,colors,selling_type,sale_types,preorder_transports,images)
    VALUES ('p_a','a','Spool A','أ',25000,'active',1,'BASE','[]','[]','direct_sale','["direct_sale"]','[]','[]'),
           ('p_b','b','Spool B','ب',25000,'active',1,'BASE','[]','[]','direct_sale','["direct_sale"]','[]','[]'),
           ('p_c','c','Spool C','ج',25000,'active',1,'BASE','[]','[]','direct_sale','["direct_sale"]','[]','[]'),
           ('p_offer','mystery-box','Mystery Spool','صندوق',60000,'active',NULL,'BASE','[]','[]','bundle','["bundle"]','[]','[]');
    UPDATE products SET composition = 'mystery' WHERE id = 'p_offer';
    INSERT INTO mystery_pools (id,name,kind) VALUES ('mpl_1','Filament','direct');
    INSERT INTO mystery_pool_entries (id,pool_id,product_id,option_value_ids,color_id,weight)
    VALUES ('mpe_a','mpl_1','p_a','[]','',1),
           ('mpe_b','mpl_1','p_b','[]','',1),
           ('mpe_c','mpl_1','p_c','[]','',1);
  `);
}

const ORDER_SQL = `INSERT INTO orders (id,user_id,status,address_snapshot,delivery_method_id,delivery_method_snapshot,
                                       payment_method_id,subtotal_iqd,exchange_rate,total_iqd,due_on_delivery_iqd,idempotency_key)
                   VALUES (?,'buyer','pending','{}','standard','{}','cash',60000,1500,60000,60000,?)`;
const ITEM_SQL = `INSERT INTO order_items (id,order_id,product_id,name_snapshot,qty,unit_price_iqd,line_total_iqd,
                                           bundle_parent_item_id,bundle_component_id,component_value_iqd,component_alloc_iqd)
                  VALUES (?,?,?,?,1,?,?,?,?,?,?)`;

/**
 * Everything a mystery line writes, as ONE batch — the shape §3.1 requires of
 * the checkout: the order, the parent line, one component line per spool with
 * `product_id = NULL`, the allocations, the reservations and the fence.
 */
async function buyThreeSpools(db: D1Database, opts: { orderId: string; key: string }) {
  const pool = (await loadPool(db, 'mpl_1'))!;
  const set = await loadCandidates(db, pool);
  const drawn = drawSpools({ seed: SEED, cartItemId: 'ci_1', spools: 3, candidates: set.candidates, duplicatePolicy: 'forbid' });
  assert.equal(drawn.ok, true);
  if (!drawn.ok) throw new Error('the pool should have backed three spools');
  const digest = await candidatesDigest(set.candidates);

  const parentId = 'oi_parent0000000000';
  const stmts: D1PreparedStatement[] = [
    db.prepare(ORDER_SQL).bind(opts.orderId, opts.key),
    db.prepare(ITEM_SQL).bind(parentId, opts.orderId, 'p_offer', 'Mystery Spool', 60000, 60000, null, null, null, null),
  ];
  const moves: StockMove[] = [];
  drawn.spools.forEach((s, i) => {
    const itemId = `oi_spool${i}00000000000`;
    stmts.push(
      // product_id = NULL, deliberately: the pick lives ONLY in
      // mystery_allocations until the reveal milestone (§7.7).
      db.prepare(ITEM_SQL).bind(itemId, opts.orderId, null, 'Mystery Spool', 0, 0, parentId, '', 20000, 20000)
    );
    stmts.push(
      allocationStatement(db, {
        order_item_id: itemId,
        spool_index: s.spool_index,
        order_id: opts.orderId,
        offer_product_id: 'p_offer',
        pool_id: 'mpl_1',
        candidate: s.candidate,
        sale_mode: 'direct',
        seed: SEED,
        reveal_stage_snapshot: 'delivered',
        candidates_sha256: digest.sha256,
      })
    );
    // The reservation is built from the allocation's REAL product and targets.
    moves.push({ product_id: s.candidate.product_id, qty: 1, line_id: itemId, targets: s.candidate.targets });
  });
  stmts.push(
    drawAuditStatement(db, {
      order_id: opts.orderId,
      offer_product_id: 'p_offer',
      cart_item_id: 'ci_1',
      pool_id: 'mpl_1',
      canonical: digest.canonical,
      sha256: digest.sha256,
    })
  );

  const plan = await planInventory(db, moves, { kind: 'reserve', operationId: opts.orderId, orderId: opts.orderId });
  assert.deepEqual(plan.rejected, []);
  stmts.push(...plan.statements, await planReservationFence(db, opts.orderId, 'reserve', plan.plannedLedgerRows));
  await db.batch(stmts);
  return drawn.spools.map((s) => s.candidate.product_id);
}

test('three spools produce three allocations and three reserve ledger rows, in one batch', async () => {
  const raw = freshDb();
  seed(raw);
  const db = asD1(raw);
  const picked = await buyThreeSpools(db, { orderId: 'ORD-1', key: 'k1' });

  assert.deepEqual([...picked].sort(), ['p_a', 'p_b', 'p_c'], 'forbid drew each spool from a different product');
  assert.equal(count(raw, 'SELECT COUNT(*) AS n FROM mystery_allocations WHERE order_id = ?', 'ORD-1'), 3);
  assert.equal(count(raw, "SELECT COUNT(*) AS n FROM inventory_ledger WHERE order_id = ? AND kind='reserve'", 'ORD-1'), 3);
  assert.deepEqual(
    all(raw, 'SELECT expected, actual FROM order_reservation_fence WHERE order_id = ?', 'ORD-1'),
    [{ expected: 3, actual: 3 }]
  );
  // The real stock rows moved — and nothing else did.
  assert.deepEqual(all(raw, 'SELECT id, stock, stock_reserved FROM products WHERE id IN (?,?,?) ORDER BY id', 'p_a', 'p_b', 'p_c'), [
    { id: 'p_a', stock: 1, stock_reserved: 1 },
    { id: 'p_b', stock: 1, stock_reserved: 1 },
    { id: 'p_c', stock: 1, stock_reserved: 1 },
  ]);
  // One audit row per LINE, not per spool, and every allocation cites it.
  assert.equal(count(raw, 'SELECT COUNT(*) AS n FROM mystery_draw_audits WHERE order_id = ?', 'ORD-1'), 1);
  const shas = all<{ candidates_sha256: string }>(raw, 'SELECT candidates_sha256 FROM mystery_allocations WHERE order_id = ?', 'ORD-1');
  assert.equal(new Set(shas.map((r) => r.candidates_sha256)).size, 1);
});

test('a spool whose stock is taken between the plan and the commit rolls the WHOLE line back', async () => {
  const raw = freshDb();
  seed(raw);
  const { failing, db } = failingD1(raw);
  // The concurrent writer: somebody else reserves the last unit of p_b after
  // the plan was built and before this batch runs.
  failing.beforeBatch = () => {
    raw.exec("UPDATE products SET stock_reserved = 1 WHERE id = 'p_b'");
    failing.beforeBatch = null;
  };

  await assert.rejects(() => buyThreeSpools(db, { orderId: 'ORD-2', key: 'k2' }));

  assert.equal(count(raw, 'SELECT COUNT(*) AS n FROM orders'), 0, 'no order');
  assert.equal(count(raw, 'SELECT COUNT(*) AS n FROM order_items'), 0, 'no lines');
  assert.equal(count(raw, 'SELECT COUNT(*) AS n FROM mystery_allocations'), 0, 'no allocation');
  assert.equal(count(raw, 'SELECT COUNT(*) AS n FROM mystery_draw_audits'), 0, 'no audit row');
  assert.equal(count(raw, 'SELECT COUNT(*) AS n FROM inventory_ledger'), 0, 'no ledger row');
  assert.equal(count(raw, 'SELECT COUNT(*) AS n FROM order_reservation_fence'), 0, 'no fence row');
  // p_a and p_c were NOT left holding a partial reservation.
  assert.deepEqual(all(raw, 'SELECT id, stock_reserved FROM products WHERE id IN (?,?) ORDER BY id', 'p_a', 'p_c'), [
    { id: 'p_a', stock_reserved: 0 },
    { id: 'p_c', stock_reserved: 0 },
  ]);
});
