/**
 * «تحديث البيانات» — ONE PRODUCT, ONE BATCH: ALL OF ITS CHANGES OR NONE
 * (docs/DECISIONS.md row 207; reproduced by the atomicity verifier of 317e878d).
 *
 * 317e878d applied a product too large for one batch in two: the product part,
 * a fresh comparison, then the pricing part. Between the two the product was
 * half-written, and it stayed so when the second part could not land — the
 * server even offered the split when it already knew the pricing part did not
 * fit (`parts.pricing.fits: false`), and the sheet's second step converted
 * typed dinars at a rate the owner had not read (it sent the FRESH preview
 * hash). The split is gone: past what D1's 1,000 leave, the apply is refused
 * with nothing written, the refusal carries counts only (no part, no token),
 * and the sheet makes one apply call per product.
 *
 *   (1) the verifier's edge world: a model renamed and both rules plus the
 *       shipping fields on 275 stored scopes — refused, nothing written, and no
 *       request (a `part` field included) writes half of it;
 *   (2) typed dinars apply only at the rate the owner read: after the rate
 *       moves, the owner's token is refused and nothing is written;
 *   (3) the sheet applies each product with ONE call, holding the card's own
 *       token and preview hash.
 *
 * Heavy (the edge world): run it on its own.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { asD1, get, post, row, stubApp } from './fixtures/app';
import { pricingWorld, AMS } from './fixtures/procurementPricing';
import { applyRate } from './fixtures/fx';
import { templateRoutes } from '../worker/routes/template';
import { download, edit, preview, OWNER, type PreviewProduct } from './fixtures/dataFile';
import { RULES2, SHIPPING5, bigProductText, coldApp, fillPricing, scopePrefixes, setLines } from './fixtures/dataFileLarge';
import { loadProducts } from '../worker/lib/pricingEngine/load';
import { formScopeIds } from '../worker/lib/pricingEngine/productInputs';

/** The budget test's edge world (24 × 10, stored SKU inputs and both rules on every scope). */
async function edgeWorld(): Promise<{ raw: DatabaseSync; id: string; text: string }> {
  const w = pricingWorld();
  const cols = Array.from({ length: 10 }, (_, i) => `c${i}`);
  const res = await post(coldApp(w.raw).app, '/api/admin/template/apply', { text: bigProductText({ opts: 24, cols, slug: 'edge-kit' }), mode: 'draft', confirm: true });
  const body = (await res.json()) as { product_id?: string };
  assert.equal(res.status, 200, JSON.stringify(body).slice(0, 400));
  const id = body.product_id!;
  const loaded = (await loadProducts(asD1(w.raw), [id])).get(id)!;
  const ids = formScopeIds(loaded);
  const skus = [...(ids.sku ?? [])].sort();
  const now = '2026-10-10T08:00:00.000Z';
  const ins = w.raw.prepare(
    "INSERT INTO pricing_inputs (product_id, scope, scope_id, origin, shipping_weight_g, unresolved_fields, source_ref, version, updated_by, updated_at) VALUES (?, 'sku', ?, 'MANUAL_OVERRIDE', 900, '[]', 'seed', 1, 'usr_owner', ?)"
  );
  for (const k of skus) ins.run(id, k, now);
  const scopes: Array<[string, string]> = [['product', ''], ...[...ids.option].map((x): [string, string] => ['option', x]), ...[...(ids.color ?? [])].map((x): [string, string] => ['color', x]), ...skus.map((x): [string, string] => ['sku', x])];
  const r = w.raw.prepare(
    "INSERT INTO pricing_rules (id, kind, scope, catalog_id, product_id, scope_id, state, amount_usd, amount_iqd, source, version, updated_by, updated_at) VALUES (?, ?, ?, NULL, ?, ?, 'ACTIVE', ?, ?, 'OWNER', 1, 'usr_owner', ?)"
  );
  scopes.forEach(([s, sid], i) => {
    r.run(`prule_seed_t${i}`, 'target_profit', s, id, sid, '5', null, now);
    r.run(`prule_seed_d${i}`, 'direct_sale_extra', s, id, sid, null, 1000, now);
  });
  const text = await (await get(coldApp(w.raw).app, `/api/admin/template/data-export/${id}`)).text();
  return { raw: w.raw, id, text };
}

const state = (raw: DatabaseSync, id: string) => ({
  model1: (raw.prepare("SELECT name_en FROM product_option_values WHERE product_id = ? AND id = 'opt_m1'").get(id) as { name_en: string } | undefined)?.name_en ?? null,
  updated_at: (raw.prepare('SELECT updated_at FROM products WHERE id = ?').get(id) as { updated_at: string }).updated_at,
  inputs_versions: (raw.prepare('SELECT COALESCE(SUM(version), 0) AS n FROM pricing_inputs WHERE product_id = ?').get(id) as { n: number }).n,
  rules_versions: (raw.prepare('SELECT COALESCE(SUM(version), 0) AS n FROM pricing_rules WHERE product_id = ?').get(id) as { n: number }).n,
  pricing_audit: (raw.prepare('SELECT COUNT(*) AS n FROM pricing_audit WHERE product_id = ?').get(id) as { n: number }).n,
  applies: (raw.prepare("SELECT COUNT(*) AS n FROM audit_log WHERE action = 'product.data_file.applied' AND target = ?").get(id) as { n: number }).n,
});

interface SizeRefusal {
  code?: string;
  details?: { needed: number; allowance: number; spent: number; parts: Record<string, { statements: number; fits: boolean; token?: string } | undefined> };
}

test('(1) a product too large for one batch: refused whole, nothing written — and no request writes half of it', async () => {
  const e = await edgeWorld();
  const edits = new Map([...fillPricing(e.text, SHIPPING5), ...fillPricing(e.text, RULES2), ['options.1.name_en', 'Model 1 (renamed)']]);
  const text = setLines(e.text, edits);
  assert.equal(scopePrefixes(e.text).length, 275);
  const pres = await post(coldApp(e.raw).app, '/api/admin/template/data-preview', { text, product_id: e.id });
  const card = ((await pres.json()) as { products: PreviewProduct[] }).products[0];
  assert.equal(card.counts.refused, 0, JSON.stringify(card.fields.filter((f) => f.status !== 'change').slice(0, 3)));
  assert.equal(card.pricing?.kind, 'data');
  const start = state(e.raw, e.id);

  // «تطبيق التغييرات»: the whole product, one batch — too large, so nothing.
  const res = await post(coldApp(e.raw).app, '/api/admin/template/data-apply', { text, product_id: e.id, token: card.token });
  const body = (await res.json()) as SizeRefusal;
  assert.equal(res.status, 409, JSON.stringify(body).slice(0, 300));
  const d = body.details!;
  assert.ok(d.needed > d.allowance, JSON.stringify(d));
  // The pricing lines alone are past the allowance: the advice is the pricing one (never «two steps»).
  assert.equal(d.parts.pricing?.fits, false, JSON.stringify(d));
  assert.equal(body.code, 'DATA_FILE_PRICING_TOO_LARGE');
  // Counts only: no part carries a token any more.
  for (const part of Object.values(d.parts)) if (part) assert.deepEqual(Object.keys(part).sort(), ['fits', 'statements']);
  assert.doesNotMatch(JSON.stringify(body), /"token"/);
  assert.deepEqual(state(e.raw, e.id), start, 'nothing written');

  // No request writes half of it: a `part` field is no longer read, so the same token asks for the whole again.
  for (const part of ['document', 'pricing']) {
    const r = await post(coldApp(e.raw).app, '/api/admin/template/data-apply', { text, product_id: e.id, token: card.token, part });
    const b = (await r.json()) as SizeRefusal;
    assert.equal(r.status, 409, JSON.stringify(b).slice(0, 300));
    assert.equal(b.code, 'DATA_FILE_PRICING_TOO_LARGE');
    assert.deepEqual(state(e.raw, e.id), start, `part=${part}: nothing written`);
  }
  assert.equal(state(e.raw, e.id).model1 === 'Model 1 (renamed)', false, 'the rename did not land on its own');
});

test('(2) typed dinars apply only at the rate the owner read: the rate moves, the owner\'s token is refused, nothing written', async () => {
  const w = pricingWorld();
  const app = stubApp(asD1(w.raw), OWNER, (a) => a.route('/api/admin/template', templateRoutes));
  // The owner types the supplier cost in dinars (the IQD convenience input): a data-only save with a preview hash.
  const text = edit(await download(app, AMS), 'pricing.base.supplier_cost_iqd', '720000');
  const [card] = await preview(app, text, AMS);
  assert.equal(card.counts.refused, 0, JSON.stringify(card.fields));
  assert.equal(card.pricing?.kind, 'data');
  const readHash = card.pricing!.preview_hash;
  assert.match(readHash ?? '', /^[0-9a-f]{64}$/, 'typed dinars carry the preview hash of the rate the owner read');
  const inputs = () => row<{ n: number }>(w.raw, 'SELECT COUNT(*) AS n FROM pricing_audit WHERE product_id = ?', AMS)!.n;
  const before = inputs();

  applyRate(w.raw, 'USD_IQD', '1500', '2026-10-02T00:00:00.000Z');
  // The token and the hash the owner read: refused (the rate is inside the token), nothing written.
  const stale = await post(app, '/api/admin/template/data-apply', { text, product_id: AMS, token: card.token, pricing_hash: readHash });
  assert.equal(stale.status, 409);
  const refused = (await stale.json()) as { code: string; details?: { preview?: PreviewProduct } };
  assert.equal(refused.code, 'DATA_FILE_CHANGED');
  assert.equal(inputs(), before, 'nothing written at a rate the owner did not read');
  // The refusal hands back the fresh comparison (the new hash) for the owner to read before applying again.
  assert.notEqual(refused.details?.preview?.pricing?.preview_hash, readHash);

  // Only an apply of the comparison the owner then reads lands, at that comparison's rate.
  const [fresh] = await preview(app, text, AMS);
  const landed = await post(app, '/api/admin/template/data-apply', { text, product_id: AMS, token: fresh.token, pricing_hash: fresh.pricing!.preview_hash });
  assert.equal(landed.status, 200, await landed.clone().text());
  const stored = row<{ conversion_rate_snapshot: string }>(
    w.raw,
    "SELECT conversion_rate_snapshot FROM pricing_inputs WHERE product_id = ? AND scope = 'base' AND origin = 'MANUAL_OVERRIDE'",
    AMS
  )!;
  assert.equal(stored.conversion_rate_snapshot, '1500', 'converted at the rate of the comparison the owner applied');
});

test('(3) the sheet applies each product with ONE call: the card\'s own token and preview hash, no second step', () => {
  const src = readFileSync(join(process.cwd(), 'src/components/adminProducts/form/DataFileSheet.tsx'), 'utf8');
  const calls = [...src.matchAll(/'\/api\/admin\/template\/data-apply'/g)];
  assert.equal(calls.length, 1, 'one apply call site');
  assert.doesNotMatch(src, /\bpart:\s*'(document|pricing|all)'/, 'no part of a product is ever applied on its own');
  const at = src.indexOf("'/api/admin/template/data-apply'");
  const call = src.slice(at, src.indexOf('});', at));
  assert.match(call, /token: card\.token/);
  assert.match(call, /pricing_hash: card\.pricing\.preview_hash/);
});
