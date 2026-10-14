/**
 * «تحديث البيانات» ON A LARGE PRODUCT — THE OWNER'S REFUSED FILE, NOW THE
 * REGRESSION (owner report 2026-10-10: the preview read «سيُطبّق 409 · رُفض
 * 0», mostly `pricing.options.N.shipping_*` / `manual_cbm` filled from empty,
 * pricing kind 'data'; «تطبيق التغييرات» answered DATA_FILE_TOO_LARGE —
 * docs/DECISIONS.md row 212).
 *
 * The product: 24 models, one colour, the 24 exact combinations (variant
 * stock), a spec group — 50 pricing scopes (the product, 24 models, 1 colour,
 * 24 SKUs), every one listed in the owner's file. The files:
 *
 *   V1  'data'  — every scope's shipping weight, box, CBM, extra cost, route
 *                 and the two owner rules on the product and its models (400 lines);
 *   V1b 'data'  — the five shipping fields alone on every scope (250 lines);
 *   V1c 'data'  — V1b plus ONE combination stock (the planner rewrites every relation row);
 *   V2  'data'  — V1 plus 56 product lines (names, every combination's stock,
 *                 every model's name, the spec values): planSave contributes;
 *   V3  'price' — V1 plus the product's supplier cost: the save completes the
 *                 inputs and ADOPTS, so engineWriteStatements contributes;
 *   V0          — the two rules on all 50 scopes (100 rule lines, more than the
 *                 form's 60): once a whole-preview 400, now a comparison.
 *
 * Each applies — 200, `not_persisted` empty — as ONE atomic batch, really
 * sent, within D1's limits (≤ 100 bound parameters per statement, ≤ 100 KB of
 * SQL per statement, ≤ 1,000 queries per invocation counting every read and
 * every statement of every batch, the after-write hooks included). Before the
 * fix the route refused at a fixed 200 statements; now the batch may hold what
 * the invocation's counted queries leave of D1's 1,000, and the pricing rows
 * go eight (audits), seven (rules) or five (inputs) to a statement.
 *
 * THE CENSUS (tests/fixtures/dataFileLarge.ts): the D1 binding is wrapped,
 * never the product code; every statement is tagged with the frames of its
 * stack, so the write batch is broken down by who built each statement. With
 * DATAFILE_CENSUS_OUT=<path>, the numbers are written there as JSON (and the
 * 41-shape catalogue census runs: ≈ 4.5 minutes).
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import type { DatabaseSync } from 'node:sqlite';
import { post, get } from './fixtures/app';
import { pricingWorld } from './fixtures/procurementPricing';
import { LEGACY_CENSUS, legacyProductId } from './fixtures/legacyCatalogue';
import type { PreviewProduct } from './fixtures/dataFile';
import { RESULTS, SHIPPING5, TOO_LARGE_CODES, coldApp, fillPricing, readInvocation, scopePrefixes, setLines, type InvocationCensus } from './fixtures/dataFileLarge';

after(() => {
  const out = process.env.DATAFILE_CENSUS_OUT;
  if (out) writeFileSync(out, JSON.stringify(RESULTS, null, 2));
});

// ------------------------------------------------------------------ the method, checked on applies that pass

// ------------------------------------------------------------------ the owner's case, and the variants

// ------------------------------------------------------------------ the live catalogue's largest product

// ------------------------------------------------------------------ the live catalogue's own shapes

interface CatalogueRow {
  slug: string;
  scopes: number;
  structuralLine: string | null;
  /** One stock line of a model or a combination: the write batch, and whether today's cap passes it. */
  structural: { status: number; code: string | null; write: number; planSave: number } | null;
  /** The five shipping fields on every listed scope, plus that one stock line. */
  shippingPlusOne: { lines: number; status: number; code: string | null; write: number; total: number } | null;
}
const CATALOGUE: CatalogueRow[] = [];

async function applyOnce(raw: DatabaseSync, id: string, text: string) {
  const [p] = ((await (await post(coldApp(raw).app, '/api/admin/template/data-preview', { text, product_id: id })).json()) as { products: PreviewProduct[] }).products;
  if (!p.token) return { p, status: 0, code: 'NOTHING', census: null as InvocationCensus | null };
  const ap = coldApp(raw);
  const res = await post(ap.app, '/api/admin/template/data-apply', {
    text, product_id: id, token: p.token,
    ...(p.pricing?.preview_hash ? { pricing_hash: p.pricing.preview_hash } : {}),
    ...(p.pricing?.large_change ? { confirm_large_change: true } : {}),
  });
  const body = (await res.json()) as { code?: string };
  const code = body.code ?? null;
  return { p, status: res.status, code, census: readInvocation(ap.d1.census, res.status, code, res.status === 200 || (code !== null && TOO_LARGE_CODES.has(code))) };
}

// Four minutes (82 worlds): run with DATAFILE_CENSUS_OUT set.
test('R — the 41 live shapes: one stock line, and the shipping fill plus that line', { skip: process.env.DATAFILE_CENSUS_OUT ? false : 'census run only (DATAFILE_CENSUS_OUT)' }, async () => {
  for (const row of LEGACY_CENSUS) {
    const w = pricingWorld();
    const id = legacyProductId(row.slug);
    const text = await (await get(coldApp(w.raw).app, `/api/admin/template/data-export/${id}`)).text();
    const scopes = scopePrefixes(text).length;
    const stockKey = /^(variants\.1\.stock)=/m.exec(text)?.[1] ?? /^(options\.1\.stock)=/m.exec(text)?.[1] ?? null;
    const out: CatalogueRow = { slug: row.slug, scopes, structuralLine: stockKey, structural: null, shippingPlusOne: null };
    if (stockKey) {
      const now = new RegExp(`^${stockKey.replace(/\./g, '\\.')}=(.*)$`, 'm').exec(text)![1];
      const next = String((Number(now) || 0) + 1);
      const one = await applyOnce(w.raw, id, setLines(text, new Map([[stockKey, next]])));
      if (one.census?.write) out.structural = { status: one.status, code: one.code, write: one.census.write.size, planSave: one.census.write.byCategory['planSave doc+relations'] ?? 0 };
      // A fresh world for the second file (the first may have moved the product on).
      const w2 = pricingWorld();
      const text2 = await (await get(coldApp(w2.raw).app, `/api/admin/template/data-export/${id}`)).text();
      const edits = new Map([...fillPricing(text2, SHIPPING5), [stockKey, next]]);
      const both = await applyOnce(w2.raw, id, setLines(text2, edits));
      if (both.census?.write) out.shippingPlusOne = { lines: both.p.counts.changes, status: both.status, code: both.code, write: both.census.write.size, total: both.census.totalQueries };
    }
    CATALOGUE.push(out);
  }
  assert.equal(CATALOGUE.length, 41);
  // Every live shape applies — one stock line, and the shipping fill plus it — as one batch (row 212).
  const refused = CATALOGUE.filter((r) => (r.structural && r.structural.status !== 200) || (r.shippingPlusOne && r.shippingPlusOne.status !== 200));
  assert.deepEqual(refused.map((r) => r.slug), []);
  const out = process.env.DATAFILE_CENSUS_OUT;
  if (out) writeFileSync(out.replace(/\.json$/, '') + '.catalogue.json', JSON.stringify(CATALOGUE, null, 2));
});
