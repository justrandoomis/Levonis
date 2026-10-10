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
import {
  INPUTS7,
  RESULTS,
  RULES2,
  SHIPPING5,
  TOO_LARGE_CODES,
  bigWorld,
  coldApp,
  docChanges,
  fillPricing,
  measure,
  ownerPricing,
  readInvocation,
  scopePrefixes,
  setLines,
  type InvocationCensus,
  type Measured,
  type World,
} from './fixtures/dataFileLarge';

after(() => {
  const out = process.env.DATAFILE_CENSUS_OUT;
  if (out) writeFileSync(out, JSON.stringify(RESULTS, null, 2));
});

// ------------------------------------------------------------------ the method, checked on applies that pass

test('the census method: a reconstructed write batch equals the batch a passing apply really sends', async () => {
  const w = await bigWorld();
  const cases: Array<[string, Map<string, string>]> = [
    ['S1 one pricing line (data)', new Map([['pricing.base.additional_cost_iqd', '1500']])],
    ['S2 one product scalar (name_en)', new Map([['name_en', 'Big Kit Pro']])],
    ['S3 one combination stock (relations)', new Map([['variants.1.stock', '77']])],
  ];
  for (const [name, edits] of cases) {
    // Each case on a fresh copy of the product's file (the earlier cases moved the product on).
    const dl = await get(coldApp(w.raw).app, `/api/admin/template/data-export/${w.id}`);
    const { m, body } = await measure(name, { ...w, text: await dl.text() }, edits);
    assert.equal(m.apply.status, 200, JSON.stringify(body).slice(0, 400));
    assert.deepEqual(body.not_persisted, []);
    assert.equal(m.apply.write?.reconstructed, false);
  }
  // A pricing line and a relations line in one apply (validated by writeBatchOf, as every passing apply is).
  const dl = await get(coldApp(w.raw).app, `/api/admin/template/data-export/${w.id}`);
  const { m, body } = await measure('S5 one pricing line + one combination stock', { ...w, text: await dl.text() }, new Map([['pricing.base.additional_cost_iqd', '2500'], ['variants.2.stock', '55']]));
  assert.equal(m.apply.status, 200, JSON.stringify(body).slice(0, 400));
  assert.deepEqual(body.not_persisted, []);
});

// ------------------------------------------------------------------ the owner's case, and the variants

const num = (v: string | null | undefined) => (v !== null && v !== undefined && /^-?\d+(\.\d+)?$/.test(v) ? Number(v) : v ?? null);
const lineValue = (text: string, key: string): string | null => {
  const m = new RegExp(`^${key.replace(/\./g, '\\.')}=(.*)$`, 'm').exec(text);
  return m ? m[1] : null;
};

/**
 * THE REGRESSION: the apply landed as ONE real batch within D1's limits, every
 * line reads back as the file wrote it, the values sit in pricing_audit (one
 * row per input scope and per rule written, as before) and the trail names
 * keys, never a value.
 */
async function assertApplied(name: string, w: World, edits: Map<string, string>, m: Measured, body: Record<string, unknown>, maxBatch: number) {
  assert.equal(m.apply.status, 200, `${name}: ${JSON.stringify(body).slice(0, 400)}`);
  assert.deepEqual(body.not_persisted, [], `${name}: read-back`);
  const write = m.apply.write!;
  assert.equal(write.reconstructed, false, `${name}: the batch was really sent`);
  assert.ok(write.size <= maxBatch, `${name}: batch ${write.size} > ${maxBatch} (${JSON.stringify(write.byCategory)})`);
  assert.ok(write.maxParams <= 100, `${name}: ${write.maxParams} bound parameters in one statement`);
  assert.ok(write.maxSqlBytes < 100_000, `${name}: ${write.maxSqlBytes} bytes of SQL`);
  assert.ok(m.apply.totalQueries <= 952, `${name}: ${m.apply.totalQueries} queries in the invocation`);
  assert.equal(m.apply.otherBatches.filter((n) => n > 60).length, 0, `${name}: no second large batch (${m.apply.otherBatches})`);
  // Every line reads back as written (a fresh export).
  const text = await (await get(coldApp(w.raw).app, `/api/admin/template/data-export/${w.id}`)).text();
  const misses = [...edits].filter(([k, v]) => num(lineValue(text, k)) !== num(v)).map(([k, v]) => `${k}: ${lineValue(text, k)} ≠ ${v}`);
  assert.deepEqual(misses, [], `${name}: every line persisted`);
  // pricing_audit: one row per input scope written and one per rule written (the values live here).
  const pricingEdits = [...edits].filter(([k]) => k.startsWith('pricing.'));
  if (pricingEdits.length) {
    const scopeOf = (k: string) => k.split('.').slice(0, -1).join('.');
    const isRule = (k: string) => /\.(minimum_target_profit_usd|direct_sale_extra_iqd)$/.test(k);
    const inputScopes = new Set(pricingEdits.filter(([k]) => !isRule(k)).map(([k]) => scopeOf(k))).size;
    const rules = pricingEdits.filter(([k]) => isRule(k)).length;
    const rows = w.raw.prepare("SELECT entity, COUNT(*) AS n FROM pricing_audit WHERE product_id = ? AND json_extract(summary_json, '$.source') = 'data_file' AND entity IN ('input', 'rule') GROUP BY entity").all(w.id) as Array<{ entity: string; n: number }>;
    const got = Object.fromEntries(rows.map((r) => [r.entity, r.n]));
    assert.deepEqual(got, { ...(inputScopes ? { input: inputScopes } : {}), ...(rules ? { rule: rules } : {}) }, `${name}: pricing_audit rows`);
  }
  // audit_log: keys and counts, never a value.
  const trail = w.raw.prepare("SELECT detail FROM audit_log WHERE action = 'product.data_file.applied' AND target = ? ORDER BY rowid DESC LIMIT 1").get(w.id) as { detail: string };
  const detail = JSON.parse(trail.detail) as { token: string; keys: string[]; changed: number };
  assert.equal(detail.changed, (body.applied as string[]).length);
  const { token: _token, ...rest } = detail;
  const said = JSON.stringify(rest);
  for (const v of ['CHINA_SEA', '0.006', ...[...edits.values()].filter((v) => /^\d{4,}$/.test(v))]) assert.ok(!said.includes(v), `${name}: the trail holds no value (${v})`);
}

test('V1 — the owner-sized pricing file (400 lines, kind data): ONE batch of 41 statements, every line persisted', async () => {
  const w = await bigWorld();
  const edits = ownerPricing(w.text);
  const { m, body } = await measure('V1 data: 7 input fields x 50 scopes + 2 rules x 25 scopes (400 lines)', w, edits);
  assert.equal(m.lines.pricingKind, 'data');
  assert.equal(m.lines.refused, 0);
  assert.equal(m.lines.pricingLines, 400);
  await assertApplied('V1', w, edits, m, body, 43);
  // The same apply on a warm binding (the preview's memos filled), on a fresh world: what a warm isolate spends.
  const w2 = await bigWorld();
  const warm = await measure('V1 (warm binding)', w2, ownerPricing(w2.text), { warm: true });
  assert.equal(warm.m.apply.status, 200);
});

test('V1b — the five shipping fields alone on every scope (250 lines, kind data)', async () => {
  const w = await bigWorld();
  const edits = fillPricing(w.text, SHIPPING5);
  const { m, body } = await measure('V1b data: 5 shipping fields x 50 scopes (250 lines)', w, edits);
  assert.equal(m.lines.pricingKind, 'data');
  assert.equal(m.lines.refused, 0);
  await assertApplied('V1b', w, edits, m, body, 29);
});

test('V1c — the same 250 shipping lines plus ONE combination stock: the relations rewrite and the pricing in one batch', async () => {
  const w = await bigWorld();
  const edits = new Map([...fillPricing(w.text, SHIPPING5), ['variants.1.stock', '77']]);
  const { m, body } = await measure('V1c data: 250 shipping lines + 1 combination stock', w, edits);
  assert.equal(m.lines.pricingKind, 'data');
  assert.equal(m.lines.refused, 0);
  await assertApplied('V1c', w, edits, m, body, 144);
});

test('V2 — the owner-sized pricing file plus 56 product lines (planSave contributes): one batch', async () => {
  const w = await bigWorld();
  const edits = new Map([...ownerPricing(w.text), ...docChanges(w.text)]);
  const { m, body } = await measure('V2 data: V1 + 56 doc lines (names, 24 stocks, 24 model names, 6 specs)', w, edits);
  assert.equal(m.lines.pricingKind, 'data');
  assert.equal(m.lines.refused, 0);
  assert.equal(m.lines.docLines, 56, JSON.stringify(m.lines));
  await assertApplied('V2', w, edits, m, body, 166);
});

test('V3 — the owner-sized pricing file completes the inputs and adopts (kind price): one batch, the engine prices', async () => {
  const w = await bigWorld();
  const edits = ownerPricing(w.text);
  edits.set('pricing.base.supplier_cost_amount', '45');
  edits.set('pricing.base.supplier_cost_currency', 'USD');
  const { m, body } = await measure('V3 price (adopt): V1 + base supplier cost (402 lines)', w, edits);
  assert.equal(m.lines.pricingKind, 'price');
  assert.equal(m.lines.refused, 0);
  assert.equal(body.priced, true);
  await assertApplied('V3', w, edits, m, body, 65);
  const state = w.raw.prepare('SELECT mode FROM product_pricing_state WHERE product_id = ?').get(w.id) as { mode: string };
  assert.equal(state.mode, 'engine');
});

test('S4 — the smallest adopting file on the same product (six base lines): the engine write alone fits', async () => {
  const w = await bigWorld();
  const edits = new Map<string, string>([
    ['pricing.base.supplier_cost_amount', '45'],
    ['pricing.base.supplier_cost_currency', 'USD'],
    ['pricing.base.shipping_profile', 'CHINA_AIR'],
    ['pricing.base.shipping_weight_g', '2500'],
    ['pricing.base.minimum_target_profit_usd', '10'],
    ['pricing.base.direct_sale_extra_iqd', '5000'],
  ]);
  const { m, body } = await measure('S4 price (adopt): 6 base lines', w, edits);
  assert.equal(m.lines.pricingKind, 'price');
  assert.equal(m.apply.status, 200, JSON.stringify(body).slice(0, 300));
});

test('V0 — the two rules on all 50 scopes (100 rule lines, more than the form\'s 60): a comparison, then one batch', async () => {
  const w = await bigWorld();
  const edits = new Map([...fillPricing(w.text, INPUTS7), ...fillPricing(w.text, RULES2)]);
  // Before the fix: a whole-preview 400 PRICING_INPUT_INVALID «rules». Now the data file takes every scope the product has.
  const { m, body, p } = await measure('V0 data: 7 input fields + 2 rules x 50 scopes (450 lines)', w, edits);
  assert.equal(p.counts.refused, 0);
  assert.equal(m.lines.pricingLines, 450);
  await assertApplied('V0', w, edits, m, body, 60);
});

// ------------------------------------------------------------------ the live catalogue's largest product

test('R1 — bambu-lab-pla-basic-filament (2 models, 30 colours, 60 SKUs): the shipping fill plus one stock line applies as one batch', async () => {
  const w = pricingWorld();
  const id = legacyProductId('bambu-lab-pla-basic-filament');
  const text = await (await get(coldApp(w.raw).app, `/api/admin/template/data-export/${id}`)).text();
  const world: World = { raw: w.raw, id, text };
  // One combination's stock alone: the planner rewrites every relation row of the product.
  const { m: one } = await measure('R1a pla-basic-filament: one variant stock', world, new Map([['variants.1.stock', '9']]));
  assert.equal(one.apply.status, 200);
  const w2 = pricingWorld();
  const text2 = await (await get(coldApp(w2.raw).app, `/api/admin/template/data-export/${id}`)).text();
  const edits = new Map([...fillPricing(text2, SHIPPING5), ['variants.1.stock', '9']]);
  const world2: World = { raw: w2.raw, id, text: text2 };
  const { m, body } = await measure('R1b pla-basic-filament: 5 shipping fields x 33 scopes + one variant stock', world2, edits);
  assert.equal(m.lines.pricingKind, 'data');
  await assertApplied('R1b', world2, edits, m, body, 182);
});

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
