/**
 * «تحديث البيانات» — `spent` IS THIS REQUEST'S OWN QUERIES (docs/DECISIONS.md
 * row 212; reproduced by the atomicity verifier of 317e878d).
 *
 * The apply sizes its ONE batch as `1000 − 50 − 60 − spent`. On 317e878d
 * `spent` was read from `countingD1(c.env.DB)` — one counting view per binding
 * per isolate (worker/lib/d1Count.ts), so a concurrent request in the same
 * isolate (a second apply, the quarter-hour tick) inflated it, and whether a
 * product applied, or was refused, depended on unrelated traffic. The apply now
 * counts on `scopedCountingD1`: a view of its own.
 *
 * Two identical applies on one binding, concurrently, against the same apply
 * alone: `details.spent` is the same.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { DatabaseSync } from 'node:sqlite';
import { asD1, get, post, stubApp } from './fixtures/app';
import { loadProducts } from '../worker/lib/pricingEngine/load';
import { formScopeIds } from '../worker/lib/pricingEngine/productInputs';
import { pricingWorld } from './fixtures/procurementPricing';
import type { PreviewProduct } from './fixtures/dataFile';
import { OWNER } from './fixtures/dataFile';
import { SHIPPING5, RULES2, bigProductText, coldApp, fillPricing, setLines, CensusD1 } from './fixtures/dataFileLarge';
import { templateRoutes } from '../worker/routes/template';

async function world(): Promise<{ raw: DatabaseSync; id: string; text: string }> {
  const w = pricingWorld();
  const cols = Array.from({ length: 10 }, (_, i) => `c${i}`);
  const res = await post(coldApp(w.raw).app, '/api/admin/template/apply', { text: bigProductText({ opts: 24, cols, slug: 'edge-kit' }), mode: 'draft', confirm: true });
  const body = (await res.json()) as { product_id?: string };
  assert.equal(res.status, 200, JSON.stringify(body).slice(0, 300));
  const id = body.product_id!;
  // Every SKU scope holds a stored owner row, so the owner's file lists all 275 scopes (the budget test's edge world).
  const loaded = (await loadProducts(asD1(w.raw), [id])).get(id)!;
  const ins = w.raw.prepare(
    "INSERT INTO pricing_inputs (product_id, scope, scope_id, origin, shipping_weight_g, unresolved_fields, source_ref, version, updated_by, updated_at) VALUES (?, 'sku', ?, 'MANUAL_OVERRIDE', 900, '[]', 'seed', 1, 'usr_owner', ?)"
  );
  for (const k of [...(formScopeIds(loaded).sku ?? [])].sort()) ins.run(id, k, '2026-10-10T08:00:00.000Z');
  const text = await (await get(coldApp(w.raw).app, `/api/admin/template/data-export/${id}`)).text();
  return { raw: w.raw, id, text };
}

test('`spent` (and so the one-batch allowance) counts this request\'s queries only — a concurrent request on the same binding changes nothing', async () => {
  const w = await world();
  const edits = new Map([...fillPricing(w.text, SHIPPING5), ...fillPricing(w.text, RULES2), ['options.1.name_en', 'Model 1 (renamed)']]);
  const text = setLines(w.text, edits);
  const pv = await post(coldApp(w.raw).app, '/api/admin/template/data-preview', { text, product_ids: [w.id] });
  const card = ((await pv.json()) as { products: PreviewProduct[] }).products[0];
  const body = { text, product_id: w.id, token: card.token };

  // Alone, on its own binding (a quiet isolate).
  const alone = await post(coldApp(w.raw).app, '/api/admin/template/data-apply', body);
  const a = (await alone.json()) as { code?: string; details?: { spent: number; allowance: number; needed: number } };
  assert.equal(alone.status, 409, JSON.stringify(a).slice(0, 300));
  assert.ok(a.details, 'a size refusal carries the arithmetic');

  // The same apply while another counted request runs in the same isolate (one binding object).
  // (The SQLite fixture runs a batch as BEGIN…COMMIT on one connection: two batches may not interleave there,
  // as they never do on D1 — a test-only queue keeps them apart; every other query still interleaves.)
  class SerialBatches extends CensusD1 {
    private queue: Promise<unknown> = Promise.resolve();
    override batch(statements: Parameters<CensusD1['batch']>[0]) {
      const run = this.queue.then(() => super.batch(statements));
      this.queue = run.catch(() => undefined);
      return run;
    }
  }
  const shared = new SerialBatches(w.raw);
  const app = stubApp(shared, OWNER, (x) => x.route('/api/admin/template', templateRoutes));
  const [r1, r2] = await Promise.all([post(app, '/api/admin/template/data-apply', body), post(app, '/api/admin/template/data-apply', body)]);
  const b1 = (await r1.json()) as { code?: string; details?: { spent: number; allowance: number } };
  const b2 = (await r2.json()) as { code?: string; details?: { spent: number; allowance: number } };
  assert.equal(r1.status, 409, JSON.stringify(b1).slice(0, 600));
  assert.equal(r2.status, 409, JSON.stringify(b2).slice(0, 600));
  const facts = { alone: a.details, concurrent: [b1.details, b2.details] };
  assert.equal(b1.details!.spent, a.details!.spent, `spent is this request's own queries: ${JSON.stringify(facts)}`);
  assert.equal(b2.details!.spent, a.details!.spent, `spent is this request's own queries: ${JSON.stringify(facts)}`);
});
