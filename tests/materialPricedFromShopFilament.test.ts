/**
 * «لا يمكن تسعير هذه المادة» — ON PLA.
 *
 * The commonest filament there is, in a shop that sells PLA, and the grams
 * calculator answered that it could not price it. These tests pin down why and
 * keep the answer.
 *
 * WHAT WAS WRONG: two systems looking for the same fact in two places.
 *
 * `resolveMaterialPrice` walks four rungs — merchant spool, merchant default,
 * catalogue, platform-by-type — and the two that a shop with no merchant
 * account could ever reach were both fed by columns NOTHING in this
 * application writes:
 *
 *   * the catalogue rung needs `print_materials.product_id`. Migration 0078
 *     seeds the nine materials without it, no admin screen sets it, and
 *     `productDeletion` only ever clears it.
 *   * the platform rung needs `print_materials.default_iqd_per_kg`, which 0078
 *     deliberately leaves NULL — «a made-up filament price is exactly the kind
 *     of number §53 forbids».
 *
 * Both refusals are right on their own terms. But the shop is not silent about
 * what a kilo of PLA costs: it SELLS PLA, as a `materials`-family product with
 * a real price and a real net weight, and `GET /api/products/print-calculator`
 * has been reading exactly that since before this engine existed. The engine
 * simply could not see it.
 *
 * Run: npx tsx --test tests/materialPricedFromShopFilament.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { DatabaseSync } from 'node:sqlite';
import { approveMerchants, asD1, freshDb, get, json, post, stubApp, type App } from './fixtures/app';
import { printQuoteRoutes } from '../worker/routes/printQuote';
import { loadMaterialPrices, productMaterialType } from '../worker/lib/printQuote/repository';
import { resolveMaterialPrice } from '../worker/lib/printQuote/cost';
import type { Hono } from 'hono';
import type { AppContext } from '../worker/lib/types';
import { publishSeededV2 } from './fixtures/autoPublish';

/** The clean start (A.12.1): the shelf's spools are V2-published (at their seeded price) before the rates read them. */
const pricesOf = async (raw: Parameters<typeof publishSeededV2>[0], merchantId: string | null, ids: string[]) => {
  await publishSeededV2(raw);
  return loadMaterialPrices(asD1(raw), merchantId, ids);
};

const mount = (a: Hono<AppContext>) => a.route('/api/print-quote', printQuoteRoutes);
const bucket = { put: async () => ({}), get: async () => null, head: async () => null, delete: async () => undefined };

/** A filament the shop actually sells: the `materials` family, a price, and a
 *  net weight on its own spec sheet. Nothing else about it is invented. */
function sellFilament(
  raw: DatabaseSync,
  p: { id: string; type: string; priceIqd: number; netWeight: string; status?: string }
) {
  raw
    .prepare(
      `INSERT INTO products (id, slug, status, name, name_ar, price_iqd, stock, stock_reserved,
                             inventory_mode, sale_types, selling_type, preorder_transports, images,
                             template_family, spec_fields)
       VALUES (?,?,?,?,?,?,0,0,'BASE','["direct_sale"]','direct_sale','[]','[]','materials',?)`
    )
    .run(
      p.id,
      p.id,
      p.status ?? 'active',
      `${p.type} filament`,
      `فيلمنت ${p.type}`,
      p.priceIqd,
      JSON.stringify({ material_type: p.type, net_weight: p.netWeight })
    );
}

/** The machine is costed so that machine hours are not silently free; the
 *  MATERIAL is deliberately left unpriced in `print_materials`, because that is
 *  the whole subject of this file. */
function shopThatSellsFilament(): { raw: DatabaseSync; app: App } {
  const raw = freshDb();
  raw
    .prepare(
      `UPDATE printer_models
          SET purchase_iqd = 900000, residual_iqd = 100000, useful_print_hours = 4000,
              maintenance_iqd_per_hour = 150, printing_watts = 110,
              bed_heating_watts = 350, nozzle_heating_watts = 60
        WHERE id = 'bbl-a1m'`
    )
    .run();
  const app = stubApp(asD1(raw), null, mount, { env: { R2_PRIVATE: bucket, R2_PUBLIC: bucket, BUCKET: bucket } });
  return { raw, app };
}

// ------------------------------------------------------------- the report itself

test('a shop that sells PLA can price PLA, with no hand-linked product and no invented default', async () => {
  const { raw, app } = shopThatSellsFilament();

  // BEFORE: the seeded database prices nothing. This is not a hypothetical —
  // it is the state a real deployment is in, and it is what the owner met.
  const bare = await pricesOf(raw, null, ['pla']);
  assert.equal(
    resolveMaterialPrice({ materialId: 'pla', materialType: 'PLA' }, bare),
    null,
    'a shop with no filament on sale genuinely cannot price PLA, and must still say so'
  );

  // 1 kg of PLA on the shelf at 25,000 د.ع.
  sellFilament(raw, { id: 'fil_pla', type: 'PLA', priceIqd: 25000, netWeight: '1000' });

  const sources = await pricesOf(raw, null, ['pla']);
  const price = resolveMaterialPrice({ materialId: 'pla', materialType: 'PLA' }, sources);
  assert.ok(price, 'the shop sells PLA, so PLA has a price per kilo');
  assert.equal(price.iqdPerKg, 25000);
  assert.equal(
    price.from,
    'platform',
    'a type match is not this exact material, so it must not claim the stronger provenance'
  );

  // And the customer-facing route now answers instead of refusing.
  const quote = await json(
    await post(app, '/api/print-quote/grams-quote', {
      printer_model_id: 'bbl-a1m',
      rows: [{ material_id: 'pla', grams: 100, color_hex: '#000000' }],
      print_minutes: 120,
    })
  );
  assert.equal(quote.success, true, JSON.stringify(quote));
  assert.notEqual(
    quote.quote.confidence,
    'insufficient',
    'PLA is priced, so «لا يمكن تسعير هذه المادة» must not be what the customer reads'
  );
  assert.ok(quote.quote.price_iqd > 0);
  // A type match is an estimate, and the ±12% band is how the engine says so.
  assert.equal(quote.quote.confidence, 'estimated');
  assert.ok(quote.quote.range_iqd.high > quote.quote.range_iqd.low);
});

test('the cheapest spool on the shelf sets the rate, and an inactive one sets nothing', async () => {
  const { raw } = shopThatSellsFilament();
  sellFilament(raw, { id: 'fil_pla_a', type: 'PLA', priceIqd: 30000, netWeight: '1000' });
  sellFilament(raw, { id: 'fil_pla_b', type: 'PLA', priceIqd: 24000, netWeight: '1000' });
  // Draft and hidden products are not on sale, so they are not evidence of a price.
  sellFilament(raw, { id: 'fil_pla_c', type: 'PLA', priceIqd: 9000, netWeight: '1000', status: 'draft' });

  const sources = await pricesOf(raw, null, ['pla']);
  assert.equal(resolveMaterialPrice({ materialId: 'pla', materialType: 'PLA' }, sources)!.iqdPerKg, 24000);
});

test('a half-kilo spool is priced per kilo, not per package', async () => {
  const { raw } = shopThatSellsFilament();
  sellFilament(raw, { id: 'fil_petg', type: 'PETG', priceIqd: 14000, netWeight: '500 g' });

  const sources = await pricesOf(raw, null, ['petg']);
  assert.equal(resolveMaterialPrice({ materialId: 'petg', materialType: 'PETG' }, sources)!.iqdPerKg, 28000);
});

test('a filament with no net weight or no price is not evidence of anything', async () => {
  const { raw } = shopThatSellsFilament();
  sellFilament(raw, { id: 'fil_no_weight', type: 'PLA', priceIqd: 25000, netWeight: '' });
  sellFilament(raw, { id: 'fil_zero', type: 'PLA', priceIqd: 0, netWeight: '1000' });

  const sources = await pricesOf(raw, null, ['pla']);
  assert.equal(
    resolveMaterialPrice({ materialId: 'pla', materialType: 'PLA' }, sources),
    null,
    'grams per kilo cannot be derived from a package whose weight nobody recorded'
  );
});

/**
 * THE MATCH IS EXACT ON PURPOSE.
 *
 * A prefix match would read «PLA-CF» as PLA and price a carbon-filled,
 * abrasive filament at plain PLA's rate. A real number for the wrong material
 * is worse than no number, which is the rule the rest of the engine is built
 * on, so the comparison is equality of the first word and nothing looser.
 */
test('PLA-CF is not PLA, and a marketing suffix does not turn one into the other', () => {
  const known = new Set(['PLA', 'PLA-CF', 'PETG']);
  const spec = (type: string) => JSON.stringify({ material_type: type, net_weight: '1000' });

  assert.equal(productMaterialType(spec('PLA'), known), 'PLA');
  assert.equal(productMaterialType(spec('pla'), known), 'PLA', 'the field is free text, so case is not a decision');
  assert.equal(productMaterialType(spec('PLA Basic'), known), 'PLA');
  assert.equal(productMaterialType(spec('PLA-CF'), known), 'PLA-CF');
  assert.equal(
    productMaterialType(spec('PLA-CF Basic'), known),
    'PLA-CF',
    'the first word decides, so a carbon-filled filament stays carbon-filled'
  );
  // «لا يمكن تسعير هذه المادة» on PLA (owner, 2026-11-18): the shop's priced
  // spool says «PLA+», which is PLA toughened — the same polymer.
  assert.equal(productMaterialType(spec('PLA+'), known), 'PLA');
  assert.equal(productMaterialType(spec('PLA Plus'), known), 'PLA');
  assert.equal(productMaterialType(spec('PLA-CF+'), known), 'PLA-CF', 'the suffix never strips the carbon');
  assert.equal(productMaterialType(spec('PLA, carbon fiber'), known), 'PLA-CF', 'spelled out, carbon is still carbon');
  assert.equal(productMaterialType(spec('Glow PLA+'), known), '', 'a different first word is not read as PLA');
  assert.equal(productMaterialType(spec(''), known), '');
  assert.equal(productMaterialType('not json at all', known), '');
  assert.equal(productMaterialType(spec('ABS'), known), '', 'a type the engine does not hold is not matched');
});

test('the polymer names product pages use are the same material as the code', () => {
  const known = new Set(['PLA', 'TPU', 'PC', 'ASA', 'PETG']);
  const spec = (type: string) => JSON.stringify({ material_type: type, net_weight: '1000' });
  assert.equal(productMaterialType(spec('Thermoplastic polyurethane'), known), 'TPU');
  assert.equal(productMaterialType(spec('Polycarbonate'), known), 'PC');
  assert.equal(productMaterialType(spec('Polylactic acid'), known), 'PLA');
  // ASA-CF is not held here, and carbon-filled ASA is not ASA.
  assert.equal(productMaterialType(spec('ASA, carbon fiber'), known), '');
  assert.equal(productMaterialType(spec('ASA-CF'), known), '');
  assert.equal(productMaterialType(spec('PETG, PET'), known), 'PETG');
});

test('the live shelf: one «PLA+» spool prices PLA, and only PLA', async () => {
  // levonis-iq.com on 2026-11-18: eSUN PLA+ 1 kg at 27,250 is the one filament
  // with a confirmed price and a net weight, and the calculator said «لا يمكن
  // تسعير هذه المادة» for PLA, its own default.
  const { raw } = shopThatSellsFilament();
  sellFilament(raw, { id: 'fil_esun', type: 'PLA+', priceIqd: 27250, netWeight: '1,000 g' });

  const sources = await pricesOf(raw, null, ['pla', 'pla-cf', 'petg']);
  const pla = resolveMaterialPrice({ materialId: 'pla', materialType: 'PLA' }, sources);
  // The fixture re-publishes the shelf through the dollar base, which rounds the
  // dinar figure; the point is that PLA now HAS a rung, read off that spool.
  assert.ok(pla && pla.iqdPerKg >= 27000 && pla.iqdPerKg <= 28000, `PLA priced from the PLA+ spool (got ${pla?.iqdPerKg})`);
  assert.equal(pla?.from, 'platform', 'a type match is an estimate, never «exact»');
  assert.equal(resolveMaterialPrice({ materialId: 'pla-cf', materialType: 'PLA-CF' }, sources), null);
  assert.equal(resolveMaterialPrice({ materialId: 'petg', materialType: 'PETG' }, sources), null);
});

test('a PLA on the shelf does not put a price on PLA-CF', async () => {
  const { raw } = shopThatSellsFilament();
  sellFilament(raw, { id: 'fil_pla', type: 'PLA', priceIqd: 25000, netWeight: '1000' });

  const sources = await pricesOf(raw, null, ['pla', 'pla-cf']);
  assert.ok(resolveMaterialPrice({ materialId: 'pla', materialType: 'PLA' }, sources));
  assert.equal(
    resolveMaterialPrice({ materialId: 'pla-cf', materialType: 'PLA-CF' }, sources),
    null,
    'an abrasive filament costs what it costs, and the shop has not said'
  );
});

/**
 * THE LADDER IS UNCHANGED ABOVE THIS RUNG. A merchant who bought cheaper is
 * still charged what they paid, and a deliberately linked product still
 * outranks a guess made from the type — this rung only fills the hole at the
 * bottom, it does not move anything above it.
 */
test('a merchant spool still outranks the shelf price', async () => {
  const { raw } = shopThatSellsFilament();
  sellFilament(raw, { id: 'fil_pla', type: 'PLA', priceIqd: 25000, netWeight: '1000' });
  raw.exec(`
    INSERT INTO users (id,name,email,password_hash,role) VALUES ('u1','تاجر','m@x.co','h','customer');
    INSERT INTO community_merchants (id,user_id,name) VALUES ('m1','u1','متجر');
  `);
  approveMerchants(raw);
  raw
    .prepare(
      `INSERT INTO merchant_spools (id, merchant_id, material_id, purchase_iqd, original_grams, active)
       VALUES ('sp1','m1','pla',18000,1000,1)`
    )
    .run();

  const sources = await pricesOf(raw, 'm1', ['pla']);
  const price = resolveMaterialPrice({ materialId: 'pla', materialType: 'PLA' }, sources)!;
  assert.equal(price.iqdPerKg, 18000, 'what the merchant paid, not what the shelf asks');
  assert.equal(price.from, 'merchant');
});

test('a hand-linked product still outranks the type match', async () => {
  const { raw } = shopThatSellsFilament();
  sellFilament(raw, { id: 'fil_pla_cheap', type: 'PLA', priceIqd: 20000, netWeight: '1000' });
  sellFilament(raw, { id: 'fil_pla_exact', type: 'PLA', priceIqd: 31000, netWeight: '1000' });
  raw.prepare(`UPDATE print_materials SET product_id = 'fil_pla_exact' WHERE id = 'pla'`).run();

  const sources = await pricesOf(raw, null, ['pla']);
  const price = resolveMaterialPrice({ materialId: 'pla', materialType: 'PLA' }, sources)!;
  assert.equal(price.iqdPerKg, 31000, 'the link is a decision, and a decision outranks a match');
  assert.equal(price.from, 'profile');
});

test('the public material list says which materials the shop can price, and never the figure', async () => {
  // The picker used to offer PETG and only then answer «no price». The list now
  // carries a yes/no from the same ladder the quote runs, so the page can lead
  // with what prices and mark the rest.
  const { raw, app } = shopThatSellsFilament();
  sellFilament(raw, { id: 'fil_esun', type: 'PLA+', priceIqd: 27250, netWeight: '1,000 g' });
  await publishSeededV2(raw);

  const body = await json(await get(app, '/api/print-quote/materials'));
  const byId = Object.fromEntries((body.materials as Array<Record<string, unknown>>).map((m) => [m.id, m]));
  assert.equal(byId.pla?.priced, true, 'PLA prices from the PLA+ spool');
  assert.equal(byId.petg?.priced, false, 'no PETG on the shelf, so no price');
  assert.equal(byId['pla-cf']?.priced, false, 'a PLA spool is not a PLA-CF price');
  const text = JSON.stringify(body);
  assert.ok(!/iqd|per_kg|27250|27,250/i.test(text), 'a flag only: no price or rate in the public list');
});

test('the picker leads with priced materials and defaults to a priced PLA', async () => {
  const { pricedFirst, defaultMaterial } = await import('../src/lib/printQuote');
  const list = [
    { id: 'abs', material_type: 'ABS', priced: false },
    { id: 'petg', material_type: 'PETG', priced: true },
    { id: 'pla', material_type: 'PLA', priced: false },
    { id: 'asa', material_type: 'ASA' },
  ];
  assert.deepEqual(pricedFirst(list).map((m) => m.id), ['petg', 'asa', 'abs', 'pla']);
  assert.equal(defaultMaterial(list)?.id, 'petg', 'an unpriced PLA is not the default when something prices');
  assert.equal(defaultMaterial([{ id: 'pla', material_type: 'PLA', priced: true }, ...list])?.id, 'pla');
  assert.equal(defaultMaterial([{ id: 'x', material_type: 'ABS', priced: false }])?.id, 'x', 'nothing priced: still a choice');
});
