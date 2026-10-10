/**
 * «ملف بيانات المنتج» — THE OWNER'S `pricing.*` BLOCK (worker/lib/productDataFilePricing.ts).
 *
 * The file carries the USD pricing inputs and the owner's two rules per scope,
 * and a change to them goes through the product form's own door with its own
 * gates:
 *   - an incomplete manual product stores the data only (no price moves);
 *   - the save that completes it ADOPTS the engine: the apply needs the hash of
 *     the preview the owner read (PRICING_PREVIEW_REQUIRED without it), a large
 *     change the tick; then the engine writes the prices in the same batch;
 *   - pricing that would reprice, in the same file as other product changes, is
 *     refused per line (STRUCTURE_WITH_ADOPTION) and applies on the next attach;
 *   - values live in pricing_audit; audit_log names keys only.
 *
 * The brief's world (tests/fixtures/procurementPricing.ts): 1 USD = 1,600 IQD,
 * EUR/USD 1.1, Germany land 3,200 IQD/kg — the AMS HT at EUR 450, 2.5 kg.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { all, asD1, count, put, row, stubApp } from './fixtures/app';
import { pricingWorld, AMS } from './fixtures/procurementPricing';
import { templateRoutes } from '../worker/routes/template';
import { apply, download, edit, preview, OWNER } from './fixtures/dataFile';
import { SHIPPING5, bigWorld, fillPricing, scopePrefixes, setLines } from './fixtures/dataFileLarge';
import { judgePricing, loadPricingLive } from '../worker/lib/productDataFilePricing';
import { normalizeEntries, splitDataFile } from '../worker/lib/productDataFile';

function world() {
  const w = pricingWorld();
  const app = stubApp(asD1(w.raw), OWNER, (a) => a.route('/api/admin/template', templateRoutes));
  return { raw: w.raw, app };
}

const COMPLETE: Array<[string, string]> = [
  ['pricing.base.supplier_cost_amount', '450'],
  ['pricing.base.supplier_cost_currency', 'EUR'],
  ['pricing.base.shipping_profile', 'GERMANY_LAND'],
  ['pricing.base.shipping_weight_g', '2500'],
  ['pricing.base.minimum_target_profit_usd', '120'],
  ['pricing.base.direct_sale_extra_iqd', '25000'],
];

test('the owner\'s file carries the pricing block; unedited it is zero changes', async () => {
  const { app } = world();
  const text = await download(app, AMS);
  for (const [key] of COMPLETE) assert.match(text, new RegExp(`^${key.replace(/\./g, '\\.')}=`, 'm'), key);
  assert.match(text, /^pricing\.options\.1\.id=/m, 'one block per model');
  const [p] = await preview(app, text, AMS);
  assert.equal(p.error, null);
  assert.deepEqual(p.fields.filter((f) => f.status !== 'STALE_IN_FILE'), []);
});

test('incomplete data is stored as data only: no price moves, the values sit in pricing_audit, audit_log names keys', async () => {
  const { raw, app } = world();
  const prices = () => all(raw, 'SELECT price_iqd FROM products WHERE id = ?', AMS);
  const before = prices();
  const text = edit(edit(await download(app, AMS), 'pricing.base.supplier_cost_amount', '450'), 'pricing.base.supplier_cost_currency', 'EUR');
  const [p] = await preview(app, text, AMS);
  assert.deepEqual(p.fields.map((f) => [f.key, f.status]), [
    ['pricing.base.supplier_cost_amount', 'change'],
    ['pricing.base.supplier_cost_currency', 'change'],
  ]);
  assert.equal(p.pricing?.kind, 'data');
  const res = await apply(app, text, p);
  assert.equal(res.status, 200, await res.clone().text());
  const stored = row<Record<string, unknown>>(raw, "SELECT * FROM pricing_inputs WHERE product_id = ? AND scope = 'base' AND origin = 'MANUAL_OVERRIDE'", AMS)!;
  assert.equal(stored.supplier_cost_amount, '450');
  assert.equal(stored.supplier_cost_currency, 'EUR');
  assert.deepEqual(prices(), before, 'no price moves');
  assert.ok(count(raw, "SELECT COUNT(*) AS n FROM pricing_audit WHERE product_id = ? AND entity = 'input'", AMS) >= 1);
  const audit = row<{ detail: string }>(raw, "SELECT detail FROM audit_log WHERE action = 'product.data_file.applied' AND target = ?", AMS)!;
  assert.ok(!audit.detail.includes('450'), 'audit_log never carries the value');
  assert.match(audit.detail, /pricing\.base\.supplier_cost_amount/);
});

test('the completing save adopts: the preview hash is required, then the engine prices in the same batch', async () => {
  const { raw, app } = world();
  let text = await download(app, AMS);
  for (const [k, v] of COMPLETE) text = edit(text, k, v);
  const [p] = await preview(app, text, AMS);
  assert.ok(p.fields.every((f) => f.status === 'change'), JSON.stringify(p.fields));
  assert.equal(p.pricing?.kind, 'price');
  assert.match(p.pricing!.preview_hash ?? '', /^[0-9a-f]{64}$/);
  const blind = await apply(app, text, p);
  assert.equal(blind.status, 409);
  assert.equal(((await blind.json()) as { code: string }).code, 'PRICING_PREVIEW_REQUIRED');
  assert.equal(row(raw, "SELECT mode FROM product_pricing_state WHERE product_id = ? AND mode = 'engine'", AMS), undefined, 'nothing written');
  const res = await apply(app, text, p, { pricing_hash: p.pricing!.preview_hash, confirm_large_change: true });
  assert.equal(res.status, 200, await res.clone().text());
  assert.equal(((await res.json()) as { priced: boolean }).priced, true);
  assert.equal(row<{ mode: string }>(raw, 'SELECT mode FROM product_pricing_state WHERE product_id = ?', AMS)!.mode, 'engine');
  // The file now reads the engine's mode, and the same file attached again is zero changes.
  const after = await download(app, AMS);
  assert.match(after, /^pricing_mode=engine$/m);
  const [q] = await preview(app, after, AMS);
  assert.deepEqual(q.fields.filter((f) => f.status !== 'STALE_IN_FILE'), []);
});

test('pricing that would reprice, beside other product changes, is refused per line and applies on the next attach', async () => {
  const { raw, app } = world();
  let text = await download(app, AMS);
  for (const [k, v] of COMPLETE) text = edit(text, k, v);
  text = edit(text, 'sku', 'AMS-HT-1');
  const [p] = await preview(app, text, AMS);
  const st = Object.fromEntries(p.fields.map((f) => [f.key, f.status]));
  assert.equal(st.sku, 'change');
  for (const [k] of COMPLETE) assert.equal(st[k], 'STRUCTURE_WITH_ADOPTION', k);
  assert.equal((await apply(app, text, p)).status, 200);
  assert.equal(row<{ sku: string }>(raw, 'SELECT sku FROM products WHERE id = ?', AMS)!.sku, 'AMS-HT-1');
  // The same file again: the sku now matches, the pricing lines are what is left.
  const [q] = await preview(app, text, AMS);
  assert.ok(q.fields.filter((f) => f.status !== 'STALE_IN_FILE').every((f) => f.key.startsWith('pricing.') && f.status === 'change'), JSON.stringify(q.fields));
  assert.equal(q.pricing?.kind, 'price');
  const res = await apply(app, text, q, { pricing_hash: q.pricing!.preview_hash, confirm_large_change: true });
  assert.equal(res.status, 200, await res.clone().text());
});

test('an invalid pricing value is refused on its own line; a scope the product does not have is refused by name', async () => {
  const { app } = world();
  let text = await download(app, AMS);
  text = edit(text, 'pricing.base.shipping_profile', 'MOON_BASE');
  text = edit(text, 'pricing.base.additional_cost_iqd', '1500');
  text = text.replace(`=== end ${AMS} ===`, `pricing.options.9.id=opt_nope\npricing.options.9.supplier_cost_amount=10\n=== end ${AMS} ===`);
  const [p] = await preview(app, text, AMS);
  const st = Object.fromEntries(p.fields.map((f) => [f.key, f.status]));
  assert.equal(st['pricing.base.shipping_profile'], 'INVALID_VALUE');
  assert.equal(st['pricing.base.additional_cost_iqd'], 'change');
  assert.equal(st['pricing.options.9.supplier_cost_amount'], 'PRICING_SCOPE_UNKNOWN');
});

// ------------------------------------------------------------------ more scopes than the form's page (row 212)

test('an 80-model product with the shipping fill on every scope: the comparison renders and the apply passes as one batch', async () => {
  // Before row 212 the whole-save parse refused more than 61 scopes and the WHOLE preview answered 400.
  const w = await bigWorld({ opts: 80, slug: 'eighty' });
  const scopes = scopePrefixes(w.text);
  assert.ok(scopes.length > 61, `${scopes.length} scopes listed`);
  const edits = fillPricing(w.text, SHIPPING5);
  const text = setLines(w.text, edits);
  const app = stubApp(asD1(w.raw), OWNER, (a) => a.route('/api/admin/template', templateRoutes));
  const [p] = await preview(app, text, w.id);
  assert.equal(p.counts.refused, 0, JSON.stringify(p.fields.filter((f) => f.status !== 'change').slice(0, 3)));
  assert.equal(p.counts.changes, scopes.length * 5);
  assert.equal(p.pricing?.kind, 'data');
  const res = await apply(app, text, p, p.pricing?.preview_hash ? { pricing_hash: p.pricing.preview_hash } : {});
  assert.equal(res.status, 200, await res.clone().text());
  assert.equal(count(w.raw, "SELECT COUNT(*) AS n FROM pricing_inputs WHERE product_id = ? AND origin = 'MANUAL_OVERRIDE'", w.id), scopes.length);
});

test('a refusal of the whole pricing save is a verdict on every pricing line, never a whole-preview 400', async () => {
  const { raw } = world();
  const db = asD1(raw);
  const live = (await loadPricingLive(db, AMS))!;
  const text = edit(edit(await download(stubApp(db, OWNER, (a) => a.route('/api/admin/template', templateRoutes)), AMS), 'pricing.base.shipping_weight_g', '2500'), 'pricing.options.1.shipping_weight_g', '2600');
  const block = splitDataFile(text).blocks[0];
  const file = normalizeEntries(block.entries).list;
  const changes = file.filter((n) => n.head === 'pricing' && !n.meta && (n.key === 'pricing.base.shipping_weight_g' || n.key === 'pricing.options.1.shipping_weight_g'));
  assert.equal(changes.length, 2);
  // A product whose scope sets read empty: each line passes alone, the whole save (2 scopes > 1) is refused.
  const shrunk = { ...live, scopes: { option: new Set<string>(), color: new Set<string>(), sku: new Set<string>() } };
  const j = await judgePricing(db, shrunk, changes, file, normalizeEntries(live.entries).list, { otherChanges: false, now: new Date().toISOString() });
  assert.deepEqual(j.accepted, []);
  assert.deepEqual([...j.refusals.values()].map((r) => r.status), ['INVALID_VALUE', 'INVALID_VALUE']);
  assert.equal(j.kind, 'none');
});

test('the form\'s own save still takes at most 61 scopes: the data file\'s limits are its own', async () => {
  const w = pricingWorld();
  const inputs = Array.from({ length: 62 }, (_, i) => ({ scope: 'option', scope_id: `x${i}`, shipping_weight_g: 100 }));
  const res = await put(w.app, `/api/admin/pricing/products/${AMS}/inputs`, { inputs_seq: 0, inputs });
  assert.equal(res.status, 400);
  const body = (await res.json()) as { code: string; details?: { field?: string } };
  assert.equal(body.code, 'PRICING_INPUT_INVALID');
  assert.equal(body.details?.field, 'inputs');
});
