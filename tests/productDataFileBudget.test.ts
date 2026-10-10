/**
 * «تحديث البيانات» — THE APPLY'S D1 BUDGET, COUNTED (docs/DECISIONS.md row 207).
 *
 * D1 allows 1,000 queries per Worker invocation, a batch counting each of its
 * statements. The data file's apply sends ONE batch per product and may give
 * it what the invocation's counted queries leave:
 *
 *     allowance = 1000 − 50 (reserve) − 60 (after the batch) − spent
 *
 * where `spent` is every query the handler ran before the batch (worker/lib/
 * d1Count.ts `countingD1`). Past it, the refusal names the two parts — the
 * product part and the owner's pricing part — each with its own token, and the
 * sheet applies them as two fenced, idempotent, audited batches.
 *
 * The real router runs on a census binding that counts every query of the
 * invocation, the completeness hook after the response included
 * (tests/fixtures/dataFileLarge.ts). The edge world: 24 models × 10 colours =
 * 240 SKUs (the engine's most), every SKU scope holding a stored owner row, so
 * the owner's file lists all 275 scopes; file E renames a model and fills the
 * five shipping fields and both rules on every scope.
 *
 *   (a) the arithmetic is pinned to the census;
 *   (b) E at once is refused DATA_FILE_TOO_LARGE with both parts, nothing written;
 *   (c) the largest pricing file the allowance admits applies at its edge,
 *       the whole invocation ≤ 952 queries, the after-phase ≤ 60;
 *   (d) the split end to end: the product part, a fresh comparison of that
 *       product alone, the pricing part — every line of E written, audited;
 *   (e) every token replays as `already`, the whole's token never lands after a part;
 *   (f) a save between the refusal and a part, and an input changed between the
 *       fresh comparison and the pricing part, refuse it (DATA_FILE_CHANGED);
 *   (g) a 400-combination product (the planner's most): the product part alone
 *       is too large — DATA_FILE_PRODUCT_TOO_LARGE, and the pricing part applies on its own;
 *   (h) a non-owner never sees a pricing part or its token.
 *
 * Heavy (≈ minutes): run it on its own. DATAFILE_BUDGET_OUT=<path> writes the measurements.
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import type { DatabaseSync } from 'node:sqlite';
import { asD1, get, post, put } from './fixtures/app';
import { pricingWorld } from './fixtures/procurementPricing';
import type { PreviewProduct } from './fixtures/dataFile';
import {
  RULES2,
  SHIPPING5,
  bigProductText,
  coldApp,
  fillPricing,
  paramCount,
  readInvocation,
  scopePrefixes,
  setLines,
  writeBatchOf,
  type Census,
} from './fixtures/dataFileLarge';
import { DATA_APPLY_AFTER_BATCH, DATA_APPLY_RESERVE, dataApplyAllowance } from '../worker/routes/templateDataFile';
import { D1_INVOCATION_STATEMENT_LIMIT } from '../worker/lib/quarterHourBudget';
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

/** File E: the five shipping fields and both rules on every listed scope (less the last `dropSkus` SKU blocks), and a model renamed. */
function fileE(e: Edge, o: { rename: boolean; dropSkus?: number }) {
  const skuPrefixes = scopePrefixes(e.text).filter((p) => p.startsWith('pricing.skus.'));
  const dropped = new Set(skuPrefixes.slice(skuPrefixes.length - (o.dropSkus ?? 0)));
  const keep = (p: string) => !dropped.has(p);
  const edits = new Map([...fillPricing(e.text, SHIPPING5, keep), ...fillPricing(e.text, RULES2, keep)]);
  if (o.rename) edits.set('options.1.name_en', 'Model 1 (renamed)');
  return { text: setLines(e.text, edits), edits };
}

async function previewOf(raw: DatabaseSync, text: string, id: string, user = undefined as typeof ASSISTANT | undefined): Promise<PreviewProduct & { labels?: { items: Record<string, unknown> } }> {
  const res = await post(coldApp(raw, user).app, '/api/admin/template/data-preview', { text, product_id: id });
  const body = (await res.json()) as { products: PreviewProduct[] };
  assert.equal(res.status, 200, JSON.stringify(body).slice(0, 400));
  return body.products[0];
}

const hashOf = (p: PreviewProduct) => ({
  ...(p.pricing?.preview_hash ? { pricing_hash: p.pricing.preview_hash } : {}),
  ...(p.pricing?.large_change ? { confirm_large_change: true } : {}),
});

interface Parts {
  needed: number;
  allowance: number;
  spent: number;
  parts: { document?: { token: string; statements: number; fits: boolean }; pricing?: { token: string; statements: number; fits: boolean } };
}

/** One apply on a fresh counted binding: the answer, its census, its time. */
async function applyCounted(raw: DatabaseSync, body: Record<string, unknown>, user = undefined as typeof ASSISTANT | undefined) {
  const ap = coldApp(raw, user);
  const t0 = performance.now();
  const res = await post(ap.app, '/api/admin/template/data-apply', body);
  const ms = Math.round(performance.now() - t0);
  const json = (await res.json()) as Record<string, unknown> & { code?: string; details?: Parts; applied?: string[]; not_persisted?: string[]; already?: boolean; part?: string };
  return { status: res.status, body: json, census: ap.d1.census, ms };
}

/** The queries the handler ran after its rate limit and before its batch (or its refusal): what `spent` counts. */
function spentOf(c: Census, firstWrite = c.queries.length): number {
  let lastRate = -1;
  c.queries.forEach((q, i) => {
    if (i < firstWrite && q.rec.frames.includes('rateLimit')) lastRate = i;
  });
  assert.ok(lastRate >= 0, 'the rate limit ran');
  return firstWrite - lastRate - 1;
}

const counts = (raw: DatabaseSync, id: string) => ({
  pricing_audit: (raw.prepare("SELECT COUNT(*) AS n FROM pricing_audit WHERE product_id = ? AND json_extract(summary_json, '$.source') = 'data_file'").get(id) as { n: number }).n,
  inputs: (raw.prepare("SELECT COUNT(*) AS n FROM pricing_inputs WHERE product_id = ? AND origin = 'MANUAL_OVERRIDE'").get(id) as { n: number }).n,
  inputs_sum: (raw.prepare('SELECT COALESCE(SUM(version), 0) AS n FROM pricing_inputs WHERE product_id = ?').get(id) as { n: number }).n,
  rules: (raw.prepare('SELECT COALESCE(SUM(version), 0) AS n FROM pricing_rules WHERE product_id = ?').get(id) as { n: number }).n,
  applied: (raw.prepare("SELECT COUNT(*) AS n FROM audit_log WHERE action = 'product.data_file.applied' AND target = ?").get(id) as { n: number }).n,
  updated_at: (raw.prepare('SELECT updated_at FROM products WHERE id = ?').get(id) as { updated_at: string }).updated_at,
});

const num = (v: string | null | undefined) => (v !== null && v !== undefined && /^-?\d+(\.\d+)?$/.test(v) ? Number(v) : v ?? null);
const lineValue = (text: string, key: string): string | null => new RegExp(`^${key.replace(/\./g, '\\.')}=(.*)$`, 'm').exec(text)?.[1] ?? null;
const unwritten = (text: string, edits: Map<string, string>) => [...edits].filter(([k, v]) => num(lineValue(text, k)) !== num(v)).map(([k, v]) => `${k}: ${lineValue(text, k)} ≠ ${v}`);
const changeRows = (p: PreviewProduct, pricingOnly: boolean) =>
  p.fields
    .filter((f) => f.status === 'change' && (!pricingOnly || f.key.startsWith('pricing.')))
    .map((f) => `${f.key}=${f.after}`)
    .sort();

// ------------------------------------------------------------------ (a) (b)

test('(a)(b) E at once: DATA_FILE_TOO_LARGE with both parts, the product part fits, nothing written — and `spent` is the census', async () => {
  const e = await edgeWorld({ seedRules: false });
  assert.equal(e.skus.length, 240);
  assert.equal(scopePrefixes(e.text).length, 275, 'the owner file lists every scope');
  const { text } = fileE(e, { rename: true });
  const p = await previewOf(e.raw, text, e.id);
  assert.equal(p.counts.refused, 0, JSON.stringify(p.fields.filter((f) => f.status !== 'change').slice(0, 3)));
  assert.equal(p.counts.changes, 1 + 275 * 7);
  assert.equal(p.pricing?.kind, 'data');
  const before = counts(e.raw, e.id);
  const r = await applyCounted(e.raw, { text, product_id: e.id, token: p.token, ...hashOf(p) });
  assert.equal(r.status, 409, JSON.stringify(r.body).slice(0, 300));
  assert.equal(r.body.code, 'DATA_FILE_TOO_LARGE');
  const d = r.body.details!;
  // (a) the arithmetic, pinned to what the census counted.
  assert.equal(d.spent, spentOf(r.census), 'spent = every query after the rate limit, before the refusal');
  assert.equal(d.allowance, D1_INVOCATION_STATEMENT_LIMIT - DATA_APPLY_RESERVE - DATA_APPLY_AFTER_BATCH - d.spent);
  assert.equal(d.allowance, 1000 - 50 - 60 - d.spent);
  assert.equal(d.allowance, dataApplyAllowance(d.spent));
  const built = writeBatchOf(r.census);
  assert.equal(built.sent, false);
  assert.equal(built.recs.length, d.needed, 'needed = the statements the refused batch held');
  assert.ok(d.needed > d.allowance);
  // (b) both parts, each with its own token; the product part fits on its own.
  assert.ok(d.parts.document?.fits, JSON.stringify(d));
  assert.ok(d.parts.pricing, JSON.stringify(d));
  assert.match(d.parts.document!.token, /^[0-9a-f]{32}$/);
  assert.match(d.parts.pricing!.token, /^[0-9a-f]{32}$/);
  assert.notEqual(d.parts.document!.token, p.token);
  assert.notEqual(d.parts.pricing!.token, p.token);
  assert.equal(d.parts.document!.statements + d.parts.pricing!.statements, d.needed + 3, 'the fence and the trail ride in both parts');
  // Counts and hashes only: no value travels in the refusal.
  assert.doesNotMatch(JSON.stringify(r.body), /CHINA_SEA|0\.006|Model 1 \(renamed\)/);
  assert.deepEqual(counts(e.raw, e.id), before, 'nothing written');
  MEASURED.E_all = { needed: d.needed, allowance: d.allowance, spent: d.spent, document: d.parts.document!.statements, pricing: d.parts.pricing!.statements, preview_changes: p.counts.changes, ms: r.ms };
});

// ------------------------------------------------------------------ (c)

test('(c) the largest pricing file the allowance admits: one batch at its edge, ≤ 952 queries in the invocation, ≤ 60 after the batch', async () => {
  // Every scope already holds its rows (inputs on the SKUs, both rules everywhere): each written row is an UPDATE.
  const e = await edgeWorld({ seedRules: true });
  const tries: Array<{ drop: number; needed?: number; allowance?: number; status: number }> = [];
  let drop = 0;
  let landed: Awaited<ReturnType<typeof applyCounted>> | null = null;
  let edits = new Map<string, string>();
  for (let attempt = 0; attempt < 6 && !landed; attempt++) {
    const f = fileE(e, { rename: false, dropSkus: drop });
    edits = f.edits;
    const p = await previewOf(e.raw, f.text, e.id);
    assert.equal(p.counts.refused, 0);
    const before = counts(e.raw, e.id);
    const r = await applyCounted(e.raw, { text: f.text, product_id: e.id, token: p.token, ...hashOf(p) });
    tries.push({ drop, needed: r.body.details?.needed, allowance: r.body.details?.allowance, status: r.status });
    if (r.status === 200) {
      landed = r;
      break;
    }
    assert.equal(r.body.code, 'DATA_FILE_PRICING_TOO_LARGE', JSON.stringify(r.body).slice(0, 300));
    assert.equal(r.body.details!.parts.document, undefined, 'a pricing-only file has no product part');
    assert.deepEqual(counts(e.raw, e.id), before, 'a refused apply writes nothing');
    // One SKU block is 1 input + 2 rules + 3/8 of an audit statement: drop a little less than the excess.
    const excess = r.body.details!.needed - r.body.details!.allowance;
    drop += Math.max(1, Math.ceil((excess * 0.9) / 3.375));
  }
  assert.ok(landed, `no attempt landed: ${JSON.stringify(tries)}`);
  assert.ok(tries.length > 1, 'the full file was over the allowance');
  assert.deepEqual(landed.body.not_persisted, []);
  const census = landed.census;
  const inv = readInvocation(census, 200, null, true);
  const write = inv.write!;
  assert.equal(write.reconstructed, false, 'one real batch');
  const sentNo = census.batches.findIndex((b) => b.length === write.size && b.some((x) => x.sql.includes('pricing_audit')));
  const firstWrite = census.queries.findIndex((q) => q.batch === sentNo);
  const spent = spentOf(census, firstWrite);
  const allowance = dataApplyAllowance(spent);
  assert.ok(write.size <= allowance, `batch ${write.size} ≤ allowance ${allowance}`);
  assert.ok(allowance - write.size <= 12, `at the edge: allowance ${allowance} − batch ${write.size}`);
  assert.ok(inv.totalQueries <= D1_INVOCATION_STATEMENT_LIMIT - DATA_APPLY_RESERVE + 2, `the invocation: ${inv.totalQueries} queries`);
  assert.ok(inv.after <= DATA_APPLY_AFTER_BATCH, `after the batch: ${inv.after} (${JSON.stringify(inv.afterByPhase)})`);
  const recs = census.batches[sentNo];
  const maxParams = Math.max(...recs.map(paramCount));
  const maxSql = Math.max(...recs.map((x) => Buffer.byteLength(x.sql)));
  const boundBytes = recs.reduce((s, x) => s + x.params.reduce<number>((t, v) => t + (typeof v === 'string' ? Buffer.byteLength(v) : 8), 0), 0);
  assert.ok(maxParams <= 100, `${maxParams} parameters`);
  assert.ok(maxSql <= 100_000, `${maxSql} bytes of SQL`);
  assert.ok(boundBytes < 1_000_000, `${boundBytes} bound bytes`);
  // Every line written.
  const text = await (await get(coldApp(e.raw).app, `/api/admin/template/data-export/${e.id}`)).text();
  assert.deepEqual(unwritten(text, edits), []);
  MEASURED.edge = { tries, batch: write.size, spent, allowance, slack: allowance - write.size, total: inv.totalQueries, after: inv.after, afterByPhase: inv.afterByPhase, beforeByPhase: inv.readsBeforeByPhase, byCategory: write.byCategory, maxParams, maxSql, boundBytes, ms: landed.ms, lines: edits.size };
});

// ------------------------------------------------------------------ (d) (e)

test('(d)(e) the split end to end on E: the product part, a fresh comparison, the pricing part — every line written, audited, each token replayable once', async () => {
  const e = await edgeWorld({ seedRules: false });
  const { text, edits } = fileE(e, { rename: true });
  const p = await previewOf(e.raw, text, e.id);
  const refused = await applyCounted(e.raw, { text, product_id: e.id, token: p.token, ...hashOf(p) });
  assert.equal(refused.body.code, 'DATA_FILE_TOO_LARGE');
  const d = refused.body.details!;
  const start = counts(e.raw, e.id);

  // 1. The product part, its own batch.
  const r1 = await applyCounted(e.raw, { text, product_id: e.id, token: d.parts.document!.token, part: 'document' });
  assert.equal(r1.status, 200, JSON.stringify(r1.body).slice(0, 300));
  assert.equal(r1.body.part, 'document');
  assert.deepEqual(r1.body.applied, ['options.1.name_en'], 'only the product lines');
  assert.deepEqual(r1.body.not_persisted, []);
  const afterDoc = counts(e.raw, e.id);
  assert.equal(afterDoc.pricing_audit, start.pricing_audit, 'no pricing row in the product part');
  assert.equal(afterDoc.inputs_sum, start.inputs_sum);
  assert.equal(afterDoc.applied, start.applied + 1);

  // (e) the product part's token replays as already; the whole's token never lands after a part.
  const replay1 = await applyCounted(e.raw, { text, product_id: e.id, token: d.parts.document!.token, part: 'document' });
  assert.equal(replay1.status, 200);
  assert.equal(replay1.body.already, true);
  const stale = await applyCounted(e.raw, { text, product_id: e.id, token: p.token, ...hashOf(p) });
  assert.equal(stale.status, 409);
  assert.equal(stale.body.code, 'DATA_FILE_CHANGED');
  // A part token is never the other part's.
  const crossed = await applyCounted(e.raw, { text, product_id: e.id, token: d.parts.document!.token, part: 'pricing' });
  assert.equal(crossed.status, 200, 'the document token replays as already whatever part it names');
  assert.equal(crossed.body.already, true);
  assert.deepEqual(counts(e.raw, e.id), afterDoc, 'replays write nothing');

  // 2. A fresh comparison of this product alone (the sheet's `product_ids`): exactly the pricing lines the owner read.
  const pv = await post(coldApp(e.raw).app, '/api/admin/template/data-preview', { text, product_ids: [e.id] });
  const fresh = ((await pv.json()) as { products: PreviewProduct[] }).products[0];
  assert.deepEqual(changeRows(fresh, false), changeRows(p, true), 'the second step writes exactly the pricing lines the owner read');
  assert.equal(fresh.pricing?.kind, 'data');
  assert.equal(fresh.pricing?.large_change, false);

  // 3. The pricing part: one batch.
  const r2 = await applyCounted(e.raw, { text, product_id: e.id, token: fresh.token, ...hashOf(fresh) });
  assert.equal(r2.status, 200, JSON.stringify(r2.body).slice(0, 300));
  assert.equal(r2.body.applied!.length, 275 * 7);
  const inv2 = readInvocation(r2.census, 200, null, true);
  assert.equal(inv2.write!.reconstructed, false);
  assert.ok(inv2.totalQueries <= 952, `${inv2.totalQueries}`);
  const replay2 = await applyCounted(e.raw, { text, product_id: e.id, token: fresh.token, ...hashOf(fresh) });
  assert.equal(replay2.body.already, true);

  // Every line of E reads as written.
  const now = await (await get(coldApp(e.raw).app, `/api/admin/template/data-export/${e.id}`)).text();
  assert.deepEqual(unwritten(now, edits), []);
  // pricing_audit: one row per input scope and one per rule written — with their before and after images.
  const end = counts(e.raw, e.id);
  assert.equal(end.pricing_audit - start.pricing_audit, 275 + 275 * 2);
  const sku = e.raw
    .prepare("SELECT pricing_before_json AS b, pricing_after_json AS a FROM pricing_audit WHERE product_id = ? AND entity = 'input' AND entity_key = ?")
    .get(e.id, `sku:${e.skus[0]}`) as { b: string; a: string };
  assert.equal(JSON.parse(sku.b).shipping_weight_g, 900, 'the stored row before');
  assert.equal(JSON.parse(sku.a).manual_cbm, '0.006', 'the row after');
  // audit_log: two applies, the first the product part; never a value.
  const trail = e.raw.prepare("SELECT detail FROM audit_log WHERE action = 'product.data_file.applied' AND target = ? ORDER BY rowid").all(e.id) as Array<{ detail: string }>;
  assert.equal(trail.length, 2);
  assert.equal(JSON.parse(trail[0].detail).part, 'document');
  assert.equal(JSON.parse(trail[1].detail).part, undefined);
  for (const t of trail) assert.doesNotMatch(t.detail.replace(/"token":"[0-9a-f]+"/, ''), /CHINA_SEA|0\.006|"value"|1010|5000/);
  MEASURED.split = { document_batch: readInvocation(r1.census, 200, null, true).write?.size, pricing_batch: inv2.write!.size, pricing_total: inv2.totalQueries, ms: [r1.ms, r2.ms] };
});

// ------------------------------------------------------------------ (f)

test('(f) the fences: a save after the refusal refuses the part; an input changed after the fresh comparison refuses the pricing part', async () => {
  const e = await edgeWorld({ seedRules: false });
  const { text } = fileE(e, { rename: true });
  const p = await previewOf(e.raw, text, e.id);
  const d = (await applyCounted(e.raw, { text, product_id: e.id, token: p.token, ...hashOf(p) })).body.details!;

  // A save of the product in between (a small file through the same door).
  const small = setLines(e.text, new Map([['name_ar', 'طقم الحافة']]));
  const ps = await previewOf(e.raw, small, e.id);
  assert.equal((await applyCounted(e.raw, { text: small, product_id: e.id, token: ps.token })).status, 200);
  const saved = counts(e.raw, e.id);
  const late = await applyCounted(e.raw, { text, product_id: e.id, token: d.parts.document!.token, part: 'document' });
  assert.equal(late.status, 409);
  assert.equal(late.body.code, 'DATA_FILE_CHANGED');
  assert.deepEqual(counts(e.raw, e.id), saved, 'nothing written');

  // From the start again: the product part, a fresh comparison — then an input changes through the form's door.
  const p2 = await previewOf(e.raw, text, e.id);
  const d2 = (await applyCounted(e.raw, { text, product_id: e.id, token: p2.token, ...hashOf(p2) })).body.details!;
  assert.equal((await applyCounted(e.raw, { text, product_id: e.id, token: d2.parts.document!.token, part: 'document' })).status, 200);
  const pv = await post(coldApp(e.raw).app, '/api/admin/template/data-preview', { text, product_ids: [e.id] });
  const fresh = ((await pv.json()) as { products: PreviewProduct[] }).products[0];
  const seq = (e.raw.prepare('SELECT inputs_seq FROM product_pricing_state WHERE product_id = ?').get(e.id) as { inputs_seq: number } | undefined)?.inputs_seq ?? 0;
  const form = await put(e.pricingApp, `/api/admin/pricing/products/${e.id}/inputs`, { inputs_seq: seq, inputs: [{ scope: 'sku', scope_id: e.skus[0], shipping_weight_g: 777 }] });
  assert.equal(form.status, 200, await form.clone().text());
  const between = counts(e.raw, e.id);
  const r2 = await applyCounted(e.raw, { text, product_id: e.id, token: fresh.token, ...hashOf(fresh) });
  assert.equal(r2.status, 409);
  assert.equal(r2.body.code, 'DATA_FILE_CHANGED');
  assert.deepEqual(counts(e.raw, e.id), between, 'nothing written');
});

// ------------------------------------------------------------------ (g) (h)

/**
 * 200 models × 2 colours: 400 combinations, the most one product may carry
 * (MAX_ROWS_PER_COLLECTION). One renamed model makes the planner rewrite every
 * value, combination, cell and search row: ≈ 1,030 statements, more than any
 * one invocation can send (a 20 × 20 product's rename is ≈ 540 and fits).
 */
const widest = () => edgeWorld({ seedRules: false, seedSkus: false, opts: 200, cols: 2 });

test('(g) a 400-combination product: a model renamed with shipping lines — the product part alone is too large, the pricing part applies on its own', async () => {
  const e = await widest();
  const edits = new Map([...fillPricing(e.text, SHIPPING5), ['options.1.name_en', 'Model one renamed']]);
  const text = setLines(e.text, edits);
  const p = await previewOf(e.raw, text, e.id);
  assert.equal(p.counts.refused, 0, JSON.stringify(p.fields.filter((f) => f.status !== 'change').slice(0, 3)));
  const before = counts(e.raw, e.id);
  const r = await applyCounted(e.raw, { text, product_id: e.id, token: p.token, ...hashOf(p) });
  assert.equal(r.status, 409, JSON.stringify(r.body).slice(0, 300));
  assert.equal(r.body.code, 'DATA_FILE_PRODUCT_TOO_LARGE');
  const d = r.body.details!;
  assert.ok(d.parts.document && !d.parts.document.fits, JSON.stringify(d));
  assert.ok(d.parts.pricing?.fits, JSON.stringify(d));
  assert.deepEqual(counts(e.raw, e.id), before, 'nothing written');
  // «طبّق أسطر التسعير وحدها»: the pricing part, its own batch; the product row untouched; no product line reported.
  const r2 = await applyCounted(e.raw, { text, product_id: e.id, token: d.parts.pricing!.token, part: 'pricing', ...hashOf(p) });
  assert.equal(r2.status, 200, JSON.stringify(r2.body).slice(0, 300));
  assert.equal(r2.body.part, 'pricing');
  assert.deepEqual(r2.body.not_persisted, []);
  assert.ok(r2.body.applied!.every((k) => k.startsWith('pricing.')));
  const after = counts(e.raw, e.id);
  assert.equal(after.updated_at, before.updated_at, 'the product row is unchanged');
  assert.ok(after.pricing_audit > before.pricing_audit);
  const now = await (await get(coldApp(e.raw).app, `/api/admin/template/data-export/${e.id}`)).text();
  assert.equal(lineValue(now, 'options.1.name_en'), 'Model 1', 'the model stays as stored');
  assert.deepEqual(unwritten(now, new Map([...edits].filter(([k]) => k.startsWith('pricing.')))), [], 'every pricing line written');
  MEASURED.widest = { needed: d.needed, allowance: d.allowance, spent: d.spent, document: d.parts.document!.statements, pricing: d.parts.pricing!.statements, pricing_part_batch: readInvocation(r2.census, 200, null, true).write?.size };
});

test('(h) a non-owner: the same refusal carries no pricing part and no pricing token; the staff file has no pricing block', async () => {
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
  assert.doesNotMatch(JSON.stringify(r.body.details), /pricing"?:\{/);
});
