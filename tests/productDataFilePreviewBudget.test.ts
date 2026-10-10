/**
 * «تحديث البيانات» — ONE COMPARISON CALL STAYS UNDER D1'S 1,000 QUERIES
 * (docs/DECISIONS.md row 212; reproduced by the d1-budget verifier of 317e878d).
 *
 * D1 allows 1,000 queries per Worker invocation. On 317e878d `POST
 * /data-preview` had no budget: it compared every block it was given (≤ 25)
 * in one invocation, ≈ 40 queries a product and ≈ 65 with a product line, and
 * the sheet fell back to the whole file in one call when a chunk was refused
 * (a block whose `product_id=` line names another product, which the server
 * drops): measured 1,016 queries, and 1,055 for 25 `product_ids`.
 *
 * Now every query of a comparison call runs on its own counting view with a
 * hard limit (`scopedCountingD1`, DATA_PREVIEW_BUDGET = 1000 − 50): the query
 * that would cross it is refused before it is sent, its block is dropped whole
 * and comes back in `pending` with every block after it, and the sheet asks
 * for those next (DataFileSheet.tsx `compare`; no client regex, no whole-file
 * fallback). Counted here on the 41-product census catalogue the way D1
 * counts (tests/fixtures/dataFileLarge.ts `CensusD1`).
 *
 *   (1) the whole 25-product file in one call, then its `pending`: every call
 *       within the budget, every block compared once, in the file's order —
 *       and a malformed block is never asked for;
 *   (2) 25 `product_ids` in one call: within the budget, the rest pending;
 *   (3) the 25-product download stays within D1's 1,000;
 *   (4) the loop itself (`compareWithinBudget`) and the counting view
 *       (`scopedCountingD1`): a refused query drops its block, the first block
 *       of a call is always answered, a swallowed refusal still drops it.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { DatabaseSync } from 'node:sqlite';
import { asD1, get, post } from './fixtures/app';
import { pricingWorld } from './fixtures/procurementPricing';
import { coldApp } from './fixtures/dataFileLarge';
import { D1_INVOCATION_STATEMENT_LIMIT } from '../worker/lib/quarterHourBudget';
import { DATA_PREVIEW_BUDGET, compareWithinBudget } from '../worker/routes/templateDataFile';
import { D1BudgetExceeded, d1Base, scopedCountingD1 } from '../worker/lib/d1Count';

/** What the sheet asks for at most in one call (the server's `product_ids` limit). */
const PREVIEW_IDS_MAX = 25;

async function bulkWorld() {
  const w = pricingWorld();
  const ids = (w.raw.prepare("SELECT id FROM products WHERE COALESCE(composition, '') = '' ORDER BY id").all() as Array<{ id: string }>).map((r) => r.id).slice(0, 25);
  assert.equal(ids.length, 25);
  const dl = coldApp(w.raw);
  const res = await get(dl.app, `/api/admin/template/data-export?ids=${ids.join(',')}`);
  assert.equal(res.status, 200);
  let text = await res.text();
  const setIn = (id: string, key: string, value: string) => {
    const s = text.indexOf(`=== product ${id} ===`);
    const e = text.indexOf(`=== end ${id} ===`, s);
    const re = new RegExp(`^${key.replace(/[.[\]]/g, '\\$&')}=.*$`, 'm');
    const body = text.slice(s, e);
    if (!re.test(body)) return false;
    text = text.slice(0, s) + body.replace(re, `${key}=${value}`) + text.slice(e);
    return true;
  };
  // An ordinary bulk edit: three products renamed, one pricing line on every product.
  let renamed = 0;
  for (const [i, id] of ids.entries()) {
    if (i < 3 && setIn(id, 'name_en', `Edited ${i}`)) renamed++;
    setIn(id, 'pricing.base.additional_cost_iqd', String(1000 + i));
  }
  assert.equal(renamed, 3);
  return { w, ids, text, exportQueries: dl.d1.census.queries.length };
}

interface Answer {
  status: number;
  code: string | null;
  products: string[];
  pending: string[];
  /** Every query of the invocation the harness sees (the rate limit's included). */
  queries: number;
  /** The handler's own: what DATA_PREVIEW_BUDGET bounds (the rate limit runs before it). */
  handler: number;
}
async function previewCounted(raw: DatabaseSync, body: Record<string, unknown>): Promise<Answer> {
  const pv = coldApp(raw);
  const res = await post(pv.app, '/api/admin/template/data-preview', body);
  const json = (await res.json()) as { code?: string; products?: Array<{ product_id: string; error: { code: string } | null }>; pending?: string[] };
  for (const p of json.products ?? []) assert.equal(p.error, null, `${p.product_id}: ${JSON.stringify(p.error)}`);
  const queries = pv.d1.census.queries;
  const handler = queries.filter((q) => !q.rec.frames.includes('rateLimit')).length;
  return { status: res.status, code: json.code ?? null, products: (json.products ?? []).map((p) => p.product_id), pending: json.pending ?? [], queries: queries.length, handler };
}

/** The sheet's loop (DataFileSheet.tsx `compare`): the whole file, then `pending`, 25 at most a call. */
async function compareAsTheSheet(raw: DatabaseSync, text: string) {
  const calls: Answer[] = [];
  const first = await previewCounted(raw, { text });
  calls.push(first);
  const compared = [...first.products];
  let pending = first.pending;
  while (pending.length) {
    const more = await previewCounted(raw, { text, product_ids: pending.slice(0, PREVIEW_IDS_MAX) });
    calls.push(more);
    assert.equal(more.status, 200, JSON.stringify(more));
    assert.ok(more.products.length > 0, 'every call moves the file forward');
    compared.push(...more.products);
    pending = [...more.pending, ...pending.slice(PREVIEW_IDS_MAX)];
  }
  return { calls, compared };
}

test('(1) a 25-product file, whole then its pending: every call within the budget, every block once, in order — a malformed block never asked for', async (t) => {
  const { w, ids, text } = await bulkWorld();
  // The last block names another product on its own product_id line: the server drops it as malformed.
  const bad = ids[ids.length - 1];
  const at = text.indexOf(`=== product ${bad} ===`);
  const nl = text.indexOf('\n', at);
  const broken = text.slice(0, nl + 1) + `product_id=${ids[0]}\n` + text.slice(nl + 1);
  for (const [label, file, want] of [
    ['clean', text, ids],
    ['malformed', broken, ids.slice(0, -1)],
  ] as const) {
    const { calls, compared } = await compareAsTheSheet(w.raw, file);
    assert.ok(calls.length > 1, `${label}: one call cannot hold the whole file (${calls.map((c) => c.queries).join(', ')})`);
    for (const [i, c] of calls.entries()) {
      assert.equal(c.status, 200, `${label} call ${i}: ${JSON.stringify(c)}`);
      assert.ok(c.handler <= DATA_PREVIEW_BUDGET, `${label} call ${i}: ${c.handler} queries (the budget is ${DATA_PREVIEW_BUDGET})`);
      // The rate limit is in `queries`; the session, the private grants and the deception gate (≤ 6) are not.
      assert.ok(c.queries + 6 <= D1_INVOCATION_STATEMENT_LIMIT, `${label} call ${i}: ${c.queries} + the middleware's ≤ 6`);
    }
    assert.deepEqual(compared, [...want], `${label}: every block compared once, in the file's order`);
    t.diagnostic(`${label}: ${calls.length} calls — handler queries ${calls.map((c) => c.handler).join(', ')}; products ${calls.map((c) => c.products.length).join(', ')}`);
    if (label === 'malformed') assert.ok(calls.every((c) => !c.pending.includes(bad) && !c.products.includes(bad)), 'the dropped block is never named');
  }
});

test('(2) 25 product_ids in one call: within the budget, the rest left pending', async (t) => {
  const { w, ids, text } = await bulkWorld();
  const r = await previewCounted(w.raw, { text, product_ids: ids });
  assert.equal(r.status, 200);
  assert.ok(r.handler <= DATA_PREVIEW_BUDGET, `25 product_ids: ${r.handler} queries`);
  assert.ok(r.queries + 6 <= D1_INVOCATION_STATEMENT_LIMIT, `25 product_ids: ${r.queries} + the middleware's ≤ 6`);
  assert.ok(r.products.length >= 1 && r.pending.length >= 1, JSON.stringify({ products: r.products.length, pending: r.pending.length }));
  assert.deepEqual([...r.products, ...r.pending], ids, 'what was compared, then what is pending: the file, in order');
  t.diagnostic(`25 product_ids: ${r.handler} handler queries, ${r.products.length} compared, ${r.pending.length} pending`);
});

test('(3) the 25-product download: one invocation within D1\'s 1,000', async (t) => {
  const { exportQueries } = await bulkWorld();
  t.diagnostic(`the 25-product export: ${exportQueries} queries`);
  assert.ok(exportQueries + 8 <= D1_INVOCATION_STATEMENT_LIMIT, `the 25-product export ran ${exportQueries} queries`);
});

test('(4) compareWithinBudget and scopedCountingD1: a refused query drops its block whole; the first block of a call is always answered', async () => {
  const w = pricingWorld();
  const base = asD1(w.raw);
  // The view: its own count, a hard limit, refused queries counted and never sent, the binding behind it.
  const v = scopedCountingD1(base, { limit: 3 });
  assert.equal(d1Base(v.db), base);
  await v.db.prepare('SELECT 1 AS x').first();
  await v.db.batch([v.db.prepare('SELECT 1 AS x'), v.db.prepare('SELECT 2 AS x')]);
  assert.equal(v.executed, 3);
  await assert.rejects(v.db.prepare('SELECT 3 AS x').first(), D1BudgetExceeded);
  assert.equal(v.refused, 1);
  assert.equal(v.executed, 3, 'a refused query is never counted as sent');
  const other = scopedCountingD1(base);
  await other.db.prepare('SELECT 1 AS x').first();
  assert.equal(other.executed, 1, 'each view counts its own queries only');
  assert.equal(v.executed, 3);

  // The loop: blocks of 2 queries each against a limit of 5 — two compared, the third dropped whole, the rest pending.
  const cost = (n: number) => async (_b: string, db: D1Database) => {
    for (let i = 0; i < n; i++) await db.prepare('SELECT 1 AS x').first();
    return _b;
  };
  const a = await compareWithinBudget(['a', 'b', 'c', 'd'], scopedCountingD1(base, { limit: 5 }), cost(2), (b) => `too large: ${b}`);
  assert.deepEqual(a, { done: ['a', 'b'], pending: ['c', 'd'] });
  // A refusal something swallowed still drops its block.
  const swallowing = async (b: string, db: D1Database) => {
    for (let i = 0; i < 2; i++) await db.prepare('SELECT 1 AS x').first().catch(() => null);
    return b;
  };
  const s = await compareWithinBudget(['a', 'b', 'c'], scopedCountingD1(base, { limit: 3 }), swallowing, (b) => `too large: ${b}`);
  assert.deepEqual(s, { done: ['a'], pending: ['b', 'c'] });
  // The first block of a call has the whole budget: if that is not enough, it is answered with its own refusal.
  const f = await compareWithinBudget(['big', 'next'], scopedCountingD1(base, { limit: 3 }), cost(4), (b) => `too large: ${b}`);
  assert.deepEqual(f, { done: ['too large: big'], pending: ['next'] });
  // An error that is not the budget's is the request's own.
  await assert.rejects(
    compareWithinBudget(['a'], scopedCountingD1(base, { limit: 10 }), async () => {
      throw new Error('boom');
    }, (b) => b),
    /boom/
  );
});
