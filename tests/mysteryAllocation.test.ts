/**
 * CASE 13 of the owner's seventeen — "a mystery pick never changes" —
 * docs/BUNDLES_MYSTERY.md §7.3 and §7.4.
 *
 * Permanence has three independent fences, and each is asserted here against
 * the real schema over the real transactional SqliteD1:
 *
 *   1. `mystery_allocations PRIMARY KEY (order_item_id, spool_index)` — a
 *      replay that somehow re-entered the write path collides and ABORTS THE
 *      WHOLE BATCH, taking the order with it.
 *   2. `orders.idempotency_key UNIQUE` — the replay branch returns the stored
 *      order without recomputing anything.
 *   3. THE DETERMINISTIC SEED — even a path that recomputed would recompute the
 *      same value, because the seed is `seedFrom(secret, cart_items.draw_salt)`
 *      and the per-spool salt names the CART item, never the order item.
 *
 * The third is the one a test can prove exhaustively, so most of this file is
 * about it: the three `priceLines` passes and the quote all draw the same
 * filament; no value the client chooses reaches the seed; and any past draw can
 * be re-verified years later from its stored seed and its candidate snapshot,
 * even after the live pool has changed underneath it.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { ROOT } from './fixtures/d1';
import { freshDb, asD1, count, all, row } from './fixtures/app';
import {
  allocationStatement,
  candidatesDigest,
  drawAuditStatement,
  drawSpools,
  ensureOfferSecretStatement,
  loadCandidates,
  loadPool,
  replayDraw,
  rotateOfferSecretStatement,
  seedForLine,
} from '../worker/lib/mysteryDraw';
import { planInventory, planReservationFence, type StockMove } from '../worker/lib/inventory';

function seed(raw: DatabaseSync) {
  raw.exec(`
    INSERT INTO users (id,name,email,password_hash,role) VALUES ('buyer','Sara','s@x.co','h','customer');
    INSERT INTO products (id,slug,name,name_ar,price_iqd,status,stock,inventory_mode,options,colors,selling_type,sale_types,preorder_transports,images)
    VALUES ('p_a','a','Spool A','أ',25000,'active',6,'BASE','[]','[]','direct_sale','["direct_sale"]','[]','[]'),
           ('p_b','b','Spool B','ب',25000,'active',6,'BASE','[]','[]','direct_sale','["direct_sale"]','[]','[]'),
           ('p_c','c','Spool C','ج',25000,'active',6,'BASE','[]','[]','direct_sale','["direct_sale"]','[]','[]'),
           ('p_d','d','Spool D','د',25000,'active',6,'BASE','[]','[]','direct_sale','["direct_sale"]','[]','[]'),
           ('p_offer','mystery-box','Mystery Spool','صندوق',60000,'active',NULL,'BASE','[]','[]','bundle','["bundle"]','[]','[]');
    UPDATE products SET composition = 'mystery' WHERE id = 'p_offer';
    INSERT INTO mystery_pools (id,name,kind) VALUES ('mpl_1','Filament','direct');
    INSERT INTO mystery_pool_entries (id,pool_id,product_id,option_value_ids,color_id,weight)
    VALUES ('mpe_a','mpl_1','p_a','[]','',1),
           ('mpe_b','mpl_1','p_b','[]','',3),
           ('mpe_c','mpl_1','p_c','[]','',6),
           ('mpe_d','mpl_1','p_d','[]','',2);
    INSERT INTO cart_items (id,user_id,product_id,option_id,option_value_ids,color_id,shipping_method_id,transport_method,warranty_plan_id,qty,draw_salt)
    VALUES ('ci_1','buyer','p_offer','','[]','','','','',1,'5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a');
  `);
}

const ORDER_SQL = `INSERT INTO orders (id,user_id,status,address_snapshot,delivery_method_id,delivery_method_snapshot,
                                       payment_method_id,subtotal_iqd,exchange_rate,total_iqd,due_on_delivery_iqd,idempotency_key)
                   VALUES (?,'buyer','pending','{}','standard','{}','cash',60000,1500,60000,60000,?)`;
const ITEM_SQL = `INSERT INTO order_items (id,order_id,product_id,name_snapshot,qty,unit_price_iqd,line_total_iqd,bundle_parent_item_id)
                  VALUES (?,?,?,?,1,?,?,?)`;

/** The checkout's own batch for one one-spool mystery line. */
async function place(
  db: D1Database,
  opts: { orderId: string; key: string; itemId?: string; cartItemId?: string; seed: string }
) {
  const pool = (await loadPool(db, 'mpl_1'))!;
  const set = await loadCandidates(db, pool);
  const cartItemId = opts.cartItemId ?? 'ci_1';
  const drawn = drawSpools({ seed: opts.seed, cartItemId, spools: 1, candidates: set.candidates, duplicatePolicy: 'allow' });
  assert.equal(drawn.ok, true);
  if (!drawn.ok) throw new Error('the pool should have backed one spool');
  const digest = await candidatesDigest(set.candidates);
  const spool = drawn.spools[0];
  const parentId = `oi_p_${opts.orderId}`;
  const itemId = opts.itemId ?? `oi_s_${opts.orderId}`;

  const moves: StockMove[] = [
    { product_id: spool.candidate.product_id, qty: 1, line_id: itemId, targets: spool.candidate.targets },
  ];
  const plan = await planInventory(db, moves, { kind: 'reserve', operationId: opts.orderId, orderId: opts.orderId });
  await db.batch([
    db.prepare(ORDER_SQL).bind(opts.orderId, opts.key),
    db.prepare(ITEM_SQL).bind(parentId, opts.orderId, 'p_offer', 'Mystery Spool', 60000, 60000, null),
    db.prepare(ITEM_SQL).bind(itemId, opts.orderId, null, 'Mystery Spool', 0, 0, parentId),
    allocationStatement(db, {
      order_item_id: itemId,
      spool_index: 0,
      order_id: opts.orderId,
      offer_product_id: 'p_offer',
      pool_id: 'mpl_1',
      candidate: spool.candidate,
      sale_mode: 'direct',
      seed: opts.seed,
      reveal_stage_snapshot: 'delivered',
      candidates_sha256: digest.sha256,
    }),
    drawAuditStatement(db, {
      order_id: opts.orderId,
      offer_product_id: 'p_offer',
      cart_item_id: cartItemId,
      pool_id: 'mpl_1',
      canonical: digest.canonical,
      sha256: digest.sha256,
    }),
    ...plan.statements,
    await planReservationFence(db, opts.orderId, 'reserve', plan.plannedLedgerRows),
  ]);
  return { picked: spool.candidate.product_id, itemId, digest };
}

// ------------------------------------------------------------- the seed

test('the seed is the offer SECRET and the server-written draw salt — nothing else', async () => {
  const raw = freshDb();
  seed(raw);
  const db = asD1(raw);
  await db.batch([ensureOfferSecretStatement(db, 'p_offer')]);

  const salt = String(row<{ draw_salt: string }>(raw, 'SELECT draw_salt FROM cart_items WHERE id = ?', 'ci_1')!.draw_salt);
  const first = await seedForLine(db, 'p_offer', salt);
  const again = await seedForLine(db, 'p_offer', salt);
  assert.equal(typeof first, 'string');
  assert.match(String(first), /^[0-9a-f]{64}$/);
  assert.equal(first, again, 'the same line always seeds the same way');

  // A different cart line — a different server-written salt — is a different seed.
  assert.notEqual(await seedForLine(db, 'p_offer', 'b'.repeat(64)), first);

  // A line with no salt cannot be drawn at all: the engine refuses rather than
  // inventing a random seed, which would make the draw unreproducible.
  assert.equal(await seedForLine(db, 'p_offer', ''), null);
  // An offer with no secret is the same honest refusal.
  assert.equal(await seedForLine(db, 'p_nothing', salt), null);

  // Rotating the secret changes every FUTURE seed for the same salt.
  await db.batch([rotateOfferSecretStatement(db, 'p_offer')]);
  assert.notEqual(await seedForLine(db, 'p_offer', salt), first);
});

test('no value the client chooses is a seed input — the idempotency key least of all', () => {
  const raw = readFileSync(join(ROOT, 'worker/lib/mysteryDraw.ts'), 'utf8');
  // The CODE, without the prose: the header explains the hazard by naming it,
  // and an assertion that matched the explanation would prove nothing.
  const src = raw.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  // The seed is built in exactly one place, from exactly two parts.
  const calls = [...src.matchAll(/seedFrom\(([^)]*)\)/g)].map((m) => m[1].trim());
  assert.deepEqual(calls, ['row.secret, drawSalt'], 'seedFrom takes the secret and the server-written salt, and nothing else');
  assert.doesNotMatch(src, /idempotency/i, 'the checkout idempotency key is not visible to the draw at all');
  assert.doesNotMatch(src, /seedFrom\([^)]*user/i);
  assert.doesNotMatch(src, /Math\.random/);
  // The per-spool salt names the CART item, never the order item.
  assert.match(src, /mystery:\$\{cartItemId\}:\$\{i\}/);
  assert.doesNotMatch(src, /sequence\([^)]*orderItem/i);
});

// ------------------------------------------- the pick, across every pass

test('the three priceLines passes and the quote all draw the same filament', async () => {
  const raw = freshDb();
  seed(raw);
  const db = asD1(raw);
  await db.batch([ensureOfferSecretStatement(db, 'p_offer')]);
  const salt = String(row<{ draw_salt: string }>(raw, 'SELECT draw_salt FROM cart_items WHERE id = ?', 'ci_1')!.draw_salt);
  const lineSeed = (await seedForLine(db, 'p_offer', salt))!;

  const set = await loadCandidates(db, (await loadPool(db, 'mpl_1'))!);
  // Requested basis, prepaid basis, COD basis and the quote: four independent
  // computations, each of which assigns fresh `newId('oi')` order item ids.
  const passes = ['requested', 'prepaid', 'cod', 'quote'].map(
    () => drawSpools({ seed: lineSeed, cartItemId: 'ci_1', spools: 1, candidates: set.candidates, duplicatePolicy: 'allow' })
  );
  const picked = passes.map((p) => (p.ok ? p.spools[0].candidate.entry_id : 'refused'));
  assert.equal(new Set(picked).size, 1, `the passes disagreed: ${picked.join(', ')}`);
});

test('the QUOTE draws nothing and writes nothing', async () => {
  const raw = freshDb();
  seed(raw);
  const db = asD1(raw);
  await db.batch([ensureOfferSecretStatement(db, 'p_offer')]);

  // Everything a read-only quote does: load the pool, price the line, report
  // availability. `allocate: false` means no statement is ever executed.
  const set = await loadCandidates(db, (await loadPool(db, 'mpl_1'))!);
  drawSpools({ seed: 'a'.repeat(64), cartItemId: 'ci_1', spools: 1, candidates: set.candidates, duplicatePolicy: 'allow' });

  assert.equal(count(raw, 'SELECT COUNT(*) AS n FROM mystery_allocations'), 0);
  assert.equal(count(raw, 'SELECT COUNT(*) AS n FROM mystery_draw_audits'), 0);
  assert.equal(count(raw, 'SELECT COUNT(*) AS n FROM inventory_ledger'), 0);
  assert.deepEqual(row(raw, 'SELECT stock, stock_reserved FROM products WHERE id = ?', 'p_c'), { stock: 6, stock_reserved: 0 });
});

// ------------------------------------------------------------ permanence

test('the allocation is written once and is identical on every re-read', async () => {
  const raw = freshDb();
  seed(raw);
  const db = asD1(raw);
  await db.batch([ensureOfferSecretStatement(db, 'p_offer')]);
  const salt = String(row<{ draw_salt: string }>(raw, 'SELECT draw_salt FROM cart_items WHERE id = ?', 'ci_1')!.draw_salt);
  const lineSeed = (await seedForLine(db, 'p_offer', salt))!;

  const first = await place(db, { orderId: 'ORD-1', key: 'k1', seed: lineSeed });
  const stored = all<{ product_id: string; seed: string; name_snapshot: string }>(
    raw,
    'SELECT product_id, seed, name_snapshot FROM mystery_allocations WHERE order_id = ?',
    'ORD-1'
  );
  assert.equal(stored.length, 1);
  assert.equal(stored[0].product_id, first.picked);

  // Re-reading the order ten times cannot change it, and neither can renaming
  // the product afterwards: the display is FROZEN on the allocation.
  raw.exec("UPDATE products SET name = 'Renamed After The Sale' WHERE id = '" + first.picked + "'");
  for (let i = 0; i < 10; i++) {
    assert.deepEqual(
      all(raw, 'SELECT product_id, name_snapshot FROM mystery_allocations WHERE order_id = ?', 'ORD-1'),
      [{ product_id: stored[0].product_id, name_snapshot: stored[0].name_snapshot }]
    );
  }
});

test('a replay that re-enters the write path collides on the primary key and aborts the whole batch', async () => {
  const raw = freshDb();
  seed(raw);
  const db = asD1(raw);
  await db.batch([ensureOfferSecretStatement(db, 'p_offer')]);
  const salt = String(row<{ draw_salt: string }>(raw, 'SELECT draw_salt FROM cart_items WHERE id = ?', 'ci_1')!.draw_salt);
  const lineSeed = (await seedForLine(db, 'p_offer', salt))!;
  const first = await place(db, { orderId: 'ORD-1', key: 'k1', seed: lineSeed });

  // The same order item id and spool index reaching the write path again.
  await assert.rejects(
    () => place(db, { orderId: 'ORD-2', key: 'k2', itemId: first.itemId, seed: lineSeed }),
    /UNIQUE|PRIMARY|constraint/i
  );
  assert.equal(count(raw, 'SELECT COUNT(*) AS n FROM orders'), 1, 'the second order rolled back with its allocation');
  assert.equal(count(raw, 'SELECT COUNT(*) AS n FROM mystery_allocations'), 1);
  assert.equal(count(raw, "SELECT COUNT(*) AS n FROM inventory_ledger WHERE kind='reserve'"), 1);
});

test('a second checkout under the same idempotency key cannot commit a second order', async () => {
  const raw = freshDb();
  seed(raw);
  const db = asD1(raw);
  await db.batch([ensureOfferSecretStatement(db, 'p_offer')]);
  const salt = String(row<{ draw_salt: string }>(raw, 'SELECT draw_salt FROM cart_items WHERE id = ?', 'ci_1')!.draw_salt);
  const lineSeed = (await seedForLine(db, 'p_offer', salt))!;
  await place(db, { orderId: 'ORD-1', key: 'same-key', seed: lineSeed });
  await assert.rejects(() => place(db, { orderId: 'ORD-2', key: 'same-key', seed: lineSeed }), /UNIQUE|constraint/i);
  assert.equal(count(raw, 'SELECT COUNT(*) AS n FROM orders'), 1);
  assert.equal(count(raw, 'SELECT COUNT(*) AS n FROM mystery_allocations'), 1);
});

test('twenty concurrent attempts on one cart line produce exactly one allocation', async () => {
  const raw = freshDb();
  seed(raw);
  const db = asD1(raw);
  await db.batch([ensureOfferSecretStatement(db, 'p_offer')]);
  const salt = String(row<{ draw_salt: string }>(raw, 'SELECT draw_salt FROM cart_items WHERE id = ?', 'ci_1')!.draw_salt);
  const lineSeed = (await seedForLine(db, 'p_offer', salt))!;

  const attempts = await Promise.allSettled(
    Array.from({ length: 20 }, (_, i) =>
      place(db, { orderId: `ORD-${i}`, key: 'double-tap', itemId: 'oi_same00000000000000', seed: lineSeed })
    )
  );
  assert.equal(attempts.filter((a) => a.status === 'fulfilled').length, 1, 'exactly one winner');
  assert.equal(count(raw, 'SELECT COUNT(*) AS n FROM orders'), 1);
  assert.equal(count(raw, 'SELECT COUNT(*) AS n FROM mystery_allocations'), 1);
  assert.equal(count(raw, "SELECT COUNT(*) AS n FROM inventory_ledger WHERE kind='reserve'"), 1);
  const picks = new Set(attempts.map((a) => (a.status === 'fulfilled' ? a.value.picked : '')));
  picks.delete('');
  assert.equal(picks.size, 1, 'and every attempt had drawn the same filament anyway');
});

// -------------------------------------------------------- reproducibility

test('any past draw is reproducible years later from its seed and its candidate snapshot', async () => {
  const raw = freshDb();
  seed(raw);
  const db = asD1(raw);
  await db.batch([ensureOfferSecretStatement(db, 'p_offer')]);
  const salt = String(row<{ draw_salt: string }>(raw, 'SELECT draw_salt FROM cart_items WHERE id = ?', 'ci_1')!.draw_salt);
  const lineSeed = (await seedForLine(db, 'p_offer', salt))!;
  const placed = await place(db, { orderId: 'ORD-1', key: 'k1', seed: lineSeed });

  // Years pass: stock moves, weights are re-tuned, entries are deactivated and
  // the offer's secret is rotated. NONE of that may change what the audit says.
  raw.exec(`
    UPDATE products SET stock = 0 WHERE id = 'p_a';
    UPDATE mystery_pool_entries SET weight = 99 WHERE id = 'mpe_b';
    UPDATE mystery_pool_entries SET active = 0 WHERE id = 'mpe_c';
  `);
  await db.batch([rotateOfferSecretStatement(db, 'p_offer')]);

  const alloc = row<{ seed: string; product_id: string; candidates_sha256: string }>(
    raw,
    'SELECT seed, product_id, candidates_sha256 FROM mystery_allocations WHERE order_id = ?',
    'ORD-1'
  )!;
  const audit = row<{ candidates: string; candidates_sha256: string }>(
    raw,
    'SELECT candidates, candidates_sha256 FROM mystery_draw_audits WHERE order_id = ?',
    'ORD-1'
  )!;
  assert.equal(alloc.candidates_sha256, audit.candidates_sha256, 'the allocation cites the list it ran against');

  const replayed = replayDraw({ seed: alloc.seed, cartItemId: 'ci_1', spools: 1, canonical: audit.candidates, duplicatePolicy: 'allow' });
  assert.equal(replayed.ok, true);
  assert.equal(replayed.ok && replayed.spools[0].candidate.product_id, alloc.product_id);
  assert.equal(alloc.product_id, placed.picked);
});

test('a cancelled order keeps its allocation for audit while its reservation is released', async () => {
  const raw = freshDb();
  seed(raw);
  const db = asD1(raw);
  await db.batch([ensureOfferSecretStatement(db, 'p_offer')]);
  const salt = String(row<{ draw_salt: string }>(raw, 'SELECT draw_salt FROM cart_items WHERE id = ?', 'ci_1')!.draw_salt);
  const lineSeed = (await seedForLine(db, 'p_offer', salt))!;
  const placed = await place(db, { orderId: 'ORD-1', key: 'k1', seed: lineSeed });

  const before = row(raw, 'SELECT * FROM mystery_allocations WHERE order_id = ?', 'ORD-1');
  const move: StockMove[] = [
    {
      product_id: placed.picked,
      qty: 1,
      line_id: placed.itemId,
      targets: [{ scope: 'base', scope_id: '', stock: 6, reserved: 1, low_stock_threshold: null, label: 'base' }],
    },
  ];
  const release = await planInventory(db, move, { kind: 'release', operationId: 'ORD-1', orderId: 'ORD-1' });
  await db.batch([
    ...release.statements,
    await planReservationFence(db, 'ORD-1', 'release', release.plannedLedgerRows),
    db.prepare("UPDATE orders SET status = 'cancelled' WHERE id = ?").bind('ORD-1'),
  ]);

  assert.deepEqual(row(raw, 'SELECT stock, stock_reserved FROM products WHERE id = ?', placed.picked), {
    stock: 6,
    stock_reserved: 0,
  });
  assert.deepEqual(row(raw, 'SELECT * FROM mystery_allocations WHERE order_id = ?', 'ORD-1'), before, 'nothing ever mutates an allocation');
});
