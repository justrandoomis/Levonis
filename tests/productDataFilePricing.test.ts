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
 *
 * THE CLEAN START (spec addendum A.6, A.12.2; DECISIONS row 222): the block is
 * closed for EVERY product — each changed `pricing.*` line is refused on its
 * own line (INVALID_VALUE, PRICING_V2_MANAGED) and the other lines apply; the
 * adoption, data-only and repricing tests went with the V1 door. What stays:
 * the block still round-trips unedited, and a refusal is per line.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { asD1, stubApp } from './fixtures/app';
import { pricingWorld, AMS } from './fixtures/procurementPricing';
import { templateRoutes } from '../worker/routes/template';
import { download, edit, preview, OWNER } from './fixtures/dataFile';
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

// ------------------------------------------------------------------ more scopes than the form's page (row 212)

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
