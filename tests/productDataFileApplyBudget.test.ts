/**
 * «تحديث البيانات» — THE APPLY'S INVOCATION, RECOUNTED INDEPENDENTLY
 * (docs/DECISIONS.md row 207; written by the d1-budget verifier of 317e878d).
 *
 * The claim: the batch may hold `1000 − 50 (reserve) − (60 + the picture-detach
 * queue) (after the batch) − spent`, so the whole `POST /data-apply` invocation
 * stays under D1's 1,000 queries, every statement ≤ 100 bound parameters and
 * ≤ 100 KB of SQL.
 *
 * Counted here on the real router (tests/fixtures/dataFileLarge.ts `CensusD1`:
 * each run/first/all/raw is one query, each statement of each batch is one),
 * the completeness hook after the response included. What no harness here
 * runs is the middleware before the handler; its queries are bounded by
 * reading the code: the session JOIN 1 (worker/lib/session.ts), private grants
 * ≤ 1 (non-owner), the deception gate ≤ 3 (snapshot load in waitUntil, tag
 * read, cold warm — worker/lib/deception/*), its observe ≤ 1 (non-owner), the
 * rate limit ≤ 2 (ratelimit.ts, before the handler's count): ≤ 8.
 *
 *   (1) the largest product the planner takes (20 models × 20 colours, 400
 *       combinations, every SKU scope stored) with a model renamed and pricing
 *       filled to the allowance's edge — the invocation, its statements, and
 *       the preview of the same file;
 *   (2) the after-batch phase is NOT constant: removed pictures are queued
 *       after the commit, ⌈K / 18⌉ + 1 queries more (mediaRefs.ts
 *       `detachQueueQueries`). On 317e878d 250 pictures removed at the edge put
 *       the after-phase at 64 (over the 60 set aside) and the invocation at 955;
 *       the allowance now sets the queue aside per batch, so the edge moves in
 *       by it and the invocation stays within the 952 the budget test holds.
 *
 * Heavy (≈ minutes): run it on its own.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { asD1, get, post } from './fixtures/app';
import { pricingWorld } from './fixtures/procurementPricing';
import type { PreviewProduct } from './fixtures/dataFile';
import { RULES2, SHIPPING5, bigProductText, coldApp, fillPricing, paramCount, readInvocation, scopePrefixes, setLines, TOO_LARGE_CODES } from './fixtures/dataFileLarge';
import { DATA_APPLY_AFTER_BATCH, DATA_APPLY_RESERVE, dataApplyAllowance } from '../worker/routes/templateDataFile';
import { detachQueueQueries } from '../worker/lib/mediaRefs';
import { D1_INVOCATION_STATEMENT_LIMIT } from '../worker/lib/quarterHourBudget';
import { loadProducts } from '../worker/lib/pricingEngine/load';
import { formScopeIds } from '../worker/lib/pricingEngine/productInputs';

/** The middleware's queries before the handler, read from the code (see the header): never counted by `countingD1`. */
const UNCOUNTED_BEFORE_HANDLER = 8;

async function world(o: { opts: number; cols: number; images?: number }) {
  const w = pricingWorld();
  const cols = Array.from({ length: o.cols }, (_, i) => `c${i}`);
  const res = await post(coldApp(w.raw).app, '/api/admin/template/apply', { text: bigProductText({ opts: o.opts, cols, slug: 'verify-kit' }), mode: 'draft', confirm: true });
  const body = (await res.json()) as { product_id?: string };
  assert.equal(res.status, 200, JSON.stringify(body).slice(0, 300));
  const id = body.product_id!;
  // Every scope holds its rows, so every written input and rule is one version-fenced UPDATE (the most statements a line costs).
  const ids = formScopeIds((await loadProducts(asD1(w.raw), [id])).get(id)!);
  const now = '2026-10-10T08:00:00.000Z';
  const scopes: Array<[string, string]> = [['product', ''], ...[...ids.option].map((x): [string, string] => ['option', x]), ...[...(ids.color ?? [])].map((x): [string, string] => ['color', x]), ...[...(ids.sku ?? [])].map((x): [string, string] => ['sku', x])];
  const ins = w.raw.prepare("INSERT INTO pricing_inputs (product_id, scope, scope_id, origin, shipping_weight_g, unresolved_fields, source_ref, version, updated_by, updated_at) VALUES (?, ?, ?, 'MANUAL_OVERRIDE', 900, '[]', 'seed', 1, 'usr_owner', ?)");
  const rule = w.raw.prepare("INSERT INTO pricing_rules (id, kind, scope, catalog_id, product_id, scope_id, state, amount_usd, amount_iqd, source, version, updated_by, updated_at) VALUES (?, ?, ?, NULL, ?, ?, 'ACTIVE', ?, ?, 'OWNER', 1, 'usr_owner', ?)");
  scopes.forEach(([s, sid], i) => {
    ins.run(id, s === 'product' ? 'base' : s, sid, now);
    rule.run(`prule_vf_t${i}`, 'target_profit', s, id, sid, '5', null, now);
    rule.run(`prule_vf_d${i}`, 'direct_sale_extra', s, id, sid, null, 1000, now);
  });
  if (o.images) {
    const im = w.raw.prepare("INSERT INTO product_images (id, product_id, url, r2_key, content_type, bytes, width, height, sort_order, is_primary, alt_en, alt_ar) VALUES (?, ?, ?, ?, 'image/webp', 1234, 800, 600, ?, ?, ?, ?)");
    for (let i = 0; i < o.images; i++) im.run(`img_vf${i}`, id, `/files/products/vf${i}.webp`, `products/vf${i}.webp`, i, i === 0 ? 1 : 0, `Pic ${i}`, `صورة ${i}`);
  }
  const text = await (await get(coldApp(w.raw).app, `/api/admin/template/data-export/${id}`)).text();
  return { raw: w.raw, id, text };
}

/** The product lines, plus the five shipping fields and both rules on as many scopes as the allowance admits: applied at its edge. */
async function applyAtEdge(e: Awaited<ReturnType<typeof world>>, docEdits: Map<string, string>, detached = 0) {
  const prefixes = scopePrefixes(e.text);
  let drop = 0;
  const tries: unknown[] = [];
  for (let attempt = 0; attempt < 8; attempt++) {
    const keep = new Set(prefixes.slice(0, prefixes.length - drop));
    const edits = new Map([...docEdits, ...fillPricing(e.text, SHIPPING5, (p) => keep.has(p)), ...fillPricing(e.text, RULES2, (p) => keep.has(p))]);
    const text = setLines(e.text, edits);
    const pv = coldApp(e.raw);
    const pres = await post(pv.app, '/api/admin/template/data-preview', { text, product_id: e.id });
    const p = ((await pres.json()) as { products: PreviewProduct[] }).products[0];
    assert.equal(pres.status, 200);
    assert.equal(p.counts.refused, 0, JSON.stringify(p.fields.filter((f) => f.status !== 'change').slice(0, 3)));
    const previewQueries = pv.d1.census.queries.length;
    const ap = coldApp(e.raw);
    const res = await post(ap.app, '/api/admin/template/data-apply', {
      text,
      product_id: e.id,
      token: p.token,
      ...(p.pricing?.preview_hash ? { pricing_hash: p.pricing.preview_hash } : {}),
    });
    const body = (await res.json()) as { code?: string; details?: { needed: number; allowance: number } };
    tries.push({ drop, status: res.status, code: body.code, needed: body.details?.needed, allowance: body.details?.allowance });
    if (res.status === 200) {
      const census = ap.d1.census;
      const inv = readInvocation(census, 200, null, true);
      const write = inv.write!;
      const sentNo = census.batches.findIndex((b) => b.length === write.size);
      const firstWrite = census.queries.findIndex((q) => q.batch === sentNo);
      let lastRate = -1;
      census.queries.forEach((q, i) => {
        if (i < firstWrite && q.rec.frames.includes('rateLimit')) lastRate = i;
      });
      const spent = firstWrite - lastRate - 1;
      const every = census.queries.map((q) => q.rec);
      return {
        tries,
        previewQueries,
        total: inv.totalQueries,
        spent,
        allowance: dataApplyAllowance(spent, detachQueueQueries(detached)),
        batch: write.size,
        after: inv.after,
        afterByPhase: inv.afterByPhase,
        maxParams: Math.max(...every.map(paramCount)),
        maxSqlBytes: Math.max(...every.map((x) => Buffer.byteLength(x.sql))),
      };
    }
    assert.ok(body.code && TOO_LARGE_CODES.has(body.code) && body.code !== 'DATA_FILE_PRODUCT_TOO_LARGE', JSON.stringify(tries));
    drop += Math.max(1, Math.ceil(((body.details!.needed - body.details!.allowance) * 0.9) / 3.375));
  }
  assert.fail(`no attempt landed: ${JSON.stringify(tries)}`);
}

test('(1) 20 × 20 (400 combinations), a model renamed, pricing at the allowance edge: under 1,000 queries, ≤ 100 parameters, ≤ 100 KB per statement — and its preview', async () => {
  const e = await world({ opts: 20, cols: 20 });
  const m = await applyAtEdge(e, new Map([['options.1.name_en', 'Model one renamed']]));
  assert.ok(m.allowance - m.batch <= 12, `at the edge: ${JSON.stringify(m)}`);
  assert.ok(m.total + UNCOUNTED_BEFORE_HANDLER <= D1_INVOCATION_STATEMENT_LIMIT, `the invocation: ${JSON.stringify(m)}`);
  assert.ok(m.maxParams <= 100, `${m.maxParams} bound parameters`);
  assert.ok(m.maxSqlBytes <= 100_000, `${m.maxSqlBytes} bytes of SQL`);
  assert.ok(m.previewQueries + 1 <= D1_INVOCATION_STATEMENT_LIMIT, `the preview: ${m.previewQueries}`);
});

test('(2) 250 pictures removed at the allowance edge: the detach queue after the batch is set aside, the invocation stays within 952', async () => {
  const e = await world({ opts: 24, cols: 10, images: 300 });
  const removals = [...e.text.matchAll(/^images\.(\d+)\.remove=false$/gm)].map((x) => Number(x[1])).sort((a, b) => b - a).slice(0, 250);
  assert.equal(removals.length, 250);
  const m = await applyAtEdge(e, new Map(removals.map((n) => [`images.${n}.remove`, 'true'])), removals.length);
  assert.ok(m.allowance - m.batch <= 12, `at the edge: ${JSON.stringify(m)}`);
  // The hard limit holds, with the middleware's queries added …
  assert.ok(m.total + UNCOUNTED_BEFORE_HANDLER <= D1_INVOCATION_STATEMENT_LIMIT, `the invocation: ${JSON.stringify(m)}`);
  // … and the after-phase stays within what the allowance set aside: the constant part and this batch's detach queue.
  const setAside = DATA_APPLY_AFTER_BATCH + detachQueueQueries(removals.length);
  assert.ok(detachQueueQueries(removals.length) >= 15, 'the queue of 250 pictures is ⌈250 / 18⌉ + 1');
  assert.ok(m.after <= setAside, `after the batch: ${m.after} > ${setAside} (${JSON.stringify(m.afterByPhase)})`);
  assert.ok(m.total <= D1_INVOCATION_STATEMENT_LIMIT - DATA_APPLY_RESERVE + 2, `the invocation: ${m.total} queries (the budget test's own bound is 952)`);
});
