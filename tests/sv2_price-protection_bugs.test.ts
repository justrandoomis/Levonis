/**
 * Services V2 survey — price protection: bugs found on 3b0f6f4f, ported onto
 * the default branch for stage S-P0. Every test states the CORRECT behaviour.
 * Local only (fresh in-memory database).
 *
 * Ported here: PP-B1 (owner decision 3: an assistant moves no money) and PP-B8
 * (one money process per unit, plan §1.3). The rule fixes PP-B2, B3, B4, B6,
 * B7 and B10 belong to the S-P0a protection-rule stage; PP-B5 (per-unit
 * claims) and PP-B9 (refund net of a credit) land with S-P8.
 *
 * Run: node --import tsx --test tests/sv2_price-protection_bugs.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ppWorld } from './sv2_price-protection_fixture';

/** A plain product, one price, no options. */
function plain(w: ReturnType<typeof ppWorld>, id = 'p', price = 40_000) {
  w.raw.prepare(`INSERT INTO products (id, slug, name, status, price_iqd, stock) VALUES (?, ?, 'Plain', 'active', ?, 5)`).run(id, id, price);
}

// ---------------------------------------------------------------- PP-B1
test('PP-B1 an assistant-scope admin cannot approve a claim and credit the wallet (money needs the financial scope)', async () => {
  const w = ppWorld();
  plain(w);
  const { itemId } = w.deliveredLine({ productId: 'p', unit: 50_000 });
  const c = await w.claim(itemId);
  assert.equal(c.status, 200, JSON.stringify(c.body));
  const r = await w.decide(w.assistant, c.body.claim.id);
  assert.equal(
    r.status,
    403,
    `assistant credited the wallet: status ${r.status}, wallet rows ${w.n("SELECT COUNT(*) n FROM wallet_transactions WHERE id LIKE 'wtx_pp_%'")} — ${JSON.stringify(r.body).slice(0, 160)}`
  );
  assert.equal(r.body.code, 'FINANCIAL_SCOPE_REQUIRED');
});

// ---------------------------------------------------------------- PP-B8
test('PP-B8 a unit already handed in for trade-in is not price-protected (it was valued on the price paid)', async () => {
  const w = ppWorld();
  plain(w);
  const { orderId, itemId } = w.deliveredLine({ productId: 'p', unit: 50_000 });
  const now = new Date().toISOString();
  w.raw
    .prepare(`INSERT INTO trade_in_requests (id, user_id, status, order_id, order_item_id, unit_index, family, created_at, updated_at)
              VALUES ('ti1', 'buyer', 'completed', ?, ?, 1, 'fdm', ?, ?)`)
    .run(orderId, itemId, now, now);
  w.raw.prepare(`INSERT INTO trade_in_claims (order_item_id, unit_index, part, request_id, created_at) VALUES (?, 1, 'device', 'ti1', ?)`).run(itemId, now);
  const c = await w.claim(itemId);
  assert.equal(c.status, 400, `a traded-in unit was offered ${(c.body.claim?.original_unit_iqd ?? 0) - (c.body.claim?.observed_unit_iqd ?? 0)} IQD of protection on top of its trade-in value`);
});
