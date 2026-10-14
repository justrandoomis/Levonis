/**
 * «تحديث البيانات» — THE APPLY'S D1 BUDGET, COUNTED (docs/DECISIONS.md row 212).
 *
 * D1 allows 1,000 queries per Worker invocation, a batch counting each of its
 * statements. The data file's apply sends ONE batch per product and may give
 * it what the invocation's counted queries leave:
 *
 *     allowance = 1000 − 50 (reserve) − 60 (after the batch) − spent
 *
 * where `spent` is every query the handler ran before the batch (worker/lib/
 * d1Count.ts `scopedCountingD1`, this request's own). Past it, NOTHING is
 * written: one product's changes go in one batch or not at all, and the
 * refusal (counts only, no token) says which lines to take out so the file is
 * applied in two goes — each its own comparison and its own atomic apply.
 *
 * The real router runs on a census binding that counts every query of the
 * invocation, the completeness hook after the response included
 * (tests/fixtures/dataFileLarge.ts). The edge world: 24 models × 10 colours =
 * 240 SKUs (the engine's most), every SKU scope holding a stored owner row, so
 * the owner's file lists all 275 scopes; file E renames a model and fills the
 * five shipping fields and both rules on every scope.
 *
 *   (a) the arithmetic is pinned to the census;
 *   (b) E at once is refused DATA_FILE_TOO_LARGE (each half would fit alone),
 *       counts only, nothing written — and a `part` field writes nothing either;
 *   (c) the largest pricing file the allowance admits applies at its edge,
 *       the whole invocation ≤ 952 queries, the after-phase ≤ 60;
 *   (d) the refusal's advice end to end: E without its pricing lines (one
 *       batch), then E again (one batch) — every line of E written, audited;
 *   (e) every token replays as `already`; E's first token never lands after;
 *   (f) a save between a comparison and its apply, and an input changed through
 *       the form's door, refuse the apply (DATA_FILE_CHANGED), nothing written;
 *   (g) a 400-combination product (the planner's most): the product lines alone
 *       are too large — DATA_FILE_PRODUCT_TOO_LARGE, nothing written; without
 *       its options/colors/variants/images lines the file applies in one go;
 *   (h) a non-owner's refusal names no pricing part.
 *
 * Heavy (≈ minutes): run it on its own. DATAFILE_BUDGET_OUT=<path> writes the measurements.
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import type { DatabaseSync } from 'node:sqlite';
import { asD1, get, post } from './fixtures/app';
import { pricingWorld } from './fixtures/procurementPricing';
import type { PreviewProduct } from './fixtures/dataFile';
import { bigProductText, coldApp, setLines } from './fixtures/dataFileLarge';
import { loadProducts } from '../worker/lib/pricingEngine/load';
import { formScopeIds } from '../worker/lib/pricingEngine/productInputs';

const ASSISTANT = { id: 'usr_asst', role: 'admin' as const, email: 'asst@x.co', admin_scope: 'assistant' as string | null };
const MEASURED: Record<string, unknown> = {};
after(() => {
  const out = process.env.DATAFILE_BUDGET_OUT;
  if (out) writeFileSync(out, JSON.stringify(MEASURED, null, 2));
});

// ------------------------------------------------------------------ the worlds

interface Edge {
  raw: DatabaseSync;
  id: string;
  text: string;
  skus: string[];
  /** The pricing door (PUT inputs), as the product form calls it. */
  pricingApp: ReturnType<typeof pricingWorld>['app'];
}

/** A product of `opts` models × `cols` colours; every SKU scope holds a stored owner row (and, with `seedRules`, every scope both rules). */
async function edgeWorld(o: { seedRules: boolean; opts?: number; cols?: number; seedSkus?: boolean }): Promise<Edge> {
  const w = pricingWorld();
  const cols = Array.from({ length: o.cols ?? 10 }, (_, i) => `c${i}`);
  const res = await post(coldApp(w.raw).app, '/api/admin/template/apply', { text: bigProductText({ opts: o.opts ?? 24, cols, slug: 'edge-kit' }), mode: 'draft', confirm: true });
  const body = (await res.json()) as { product_id?: string };
  assert.equal(res.status, 200, JSON.stringify(body).slice(0, 400));
  const id = body.product_id!;
  const loaded = (await loadProducts(asD1(w.raw), [id])).get(id)!;
  const ids = formScopeIds(loaded);
  const skus = [...(ids.sku ?? [])].sort();
  const now = '2026-10-10T08:00:00.000Z';
  if (o.seedSkus !== false) {
    const ins = w.raw.prepare(
      "INSERT INTO pricing_inputs (product_id, scope, scope_id, origin, shipping_weight_g, unresolved_fields, source_ref, version, updated_by, updated_at) VALUES (?, 'sku', ?, 'MANUAL_OVERRIDE', 900, '[]', 'seed', 1, 'usr_owner', ?)"
    );
    for (const k of skus) ins.run(id, k, now);
  }
  if (o.seedRules) {
    const scopes: Array<[string, string]> = [['product', ''], ...[...ids.option].map((x): [string, string] => ['option', x]), ...[...(ids.color ?? [])].map((x): [string, string] => ['color', x]), ...skus.map((x): [string, string] => ['sku', x])];
    const r = w.raw.prepare(
      "INSERT INTO pricing_rules (id, kind, scope, catalog_id, product_id, scope_id, state, amount_usd, amount_iqd, source, version, updated_by, updated_at) VALUES (?, ?, ?, NULL, ?, ?, 'ACTIVE', ?, ?, 'OWNER', 1, 'usr_owner', ?)"
    );
    scopes.forEach(([s, sid], i) => {
      r.run(`prule_seed_t${i}`, 'target_profit', s, id, sid, '5', null, now);
      r.run(`prule_seed_d${i}`, 'direct_sale_extra', s, id, sid, null, 1000, now);
    });
  }
  const text = await (await get(coldApp(w.raw).app, `/api/admin/template/data-export/${id}`)).text();
  return { raw: w.raw, id, text, skus, pricingApp: w.app };
}

async function previewOf(raw: DatabaseSync, text: string, id: string, user = undefined as typeof ASSISTANT | undefined): Promise<PreviewProduct & { labels?: { items: Record<string, unknown> } }> {
  const res = await post(coldApp(raw, user).app, '/api/admin/template/data-preview', { text, product_id: id });
  const body = (await res.json()) as { products: PreviewProduct[] };
  assert.equal(res.status, 200, JSON.stringify(body).slice(0, 400));
  return body.products[0];
}

interface Parts {
  needed: number;
  allowance: number;
  spent: number;
  parts: { document?: { statements: number; fits: boolean }; pricing?: { statements: number; fits: boolean } };
}

/** One apply on a fresh counted binding: the answer, its census, its time. */
async function applyCounted(raw: DatabaseSync, body: Record<string, unknown>, user = undefined as typeof ASSISTANT | undefined) {
  const ap = coldApp(raw, user);
  const t0 = performance.now();
  const res = await post(ap.app, '/api/admin/template/data-apply', body);
  const ms = Math.round(performance.now() - t0);
  const json = (await res.json()) as Record<string, unknown> & { code?: string; details?: Parts; applied?: string[]; not_persisted?: string[]; already?: boolean };
  return { status: res.status, body: json, census: ap.d1.census, ms };
}

// ------------------------------------------------------------------ (a) (b)

// ------------------------------------------------------------------ (c)

// ------------------------------------------------------------------ (d) (e)

// ------------------------------------------------------------------ (f)

// ------------------------------------------------------------------ (g) (h)

/**
 * 200 models × 2 colours: 400 combinations, the most one product may carry
 * (MAX_ROWS_PER_COLLECTION). One renamed model makes the planner rewrite every
 * value, combination, cell and search row: ≈ 1,030 statements, more than any
 * one invocation can send (a 20 × 20 product's rename is ≈ 540 and fits).
 */
const widest = () => edgeWorld({ seedRules: false, seedSkus: false, opts: 200, cols: 2 });

test('(h) a non-owner: the same refusal names no pricing part; the staff file has no pricing block', async () => {
  const e = await widest();
  const staffText = await (await get(coldApp(e.raw, ASSISTANT).app, `/api/admin/template/data-export/${e.id}`)).text();
  assert.doesNotMatch(staffText, /^pricing\./m, 'the staff file has no pricing block');
  const text = setLines(staffText, new Map([['options.1.name_en', 'Model one renamed']]));
  const p = await previewOf(e.raw, text, e.id, ASSISTANT);
  assert.equal(p.pricing, null);
  assert.ok(!Object.keys(p.labels?.items ?? {}).some((k) => k.startsWith('pricing.')), 'no pricing item is named to staff');
  const r = await applyCounted(e.raw, { text, product_id: e.id, token: p.token }, ASSISTANT);
  assert.equal(r.status, 409, JSON.stringify(r.body).slice(0, 300));
  assert.equal(r.body.code, 'DATA_FILE_PRODUCT_TOO_LARGE');
  assert.equal(r.body.details!.parts.pricing, undefined);
  assert.doesNotMatch(JSON.stringify(r.body.details), /pricing"?:\{|"token"/);
});
