/**
 * PRICING V2-4 — THE FORM'S OWN WIRE AGAINST THE REAL ROUTES.
 *
 * tests/productFormV2.test.ts pins the form's pieces one by one; this file
 * proves they fit the V2-3b server. Each case builds its request with the
 * form's own functions — `draftOf` over the GET answer, `draftWire`,
 * `draftStructure`, `relationsFromWire` / `relationsToWire`, `toEditorDoc`,
 * `previewOf` / `sectionOf` on a refusal, `reviewRowsOf` / `needsTickOf` for
 * the sheet — and sends it through `/api/admin/products-v2` exactly as
 * ProductForm's save does (the document, its relations, `pricing_v2`):
 *   - add-product (owner, price-first): the draft is previewed under the id the
 *     save persists; the save is held for the ONE sheet, whose rows are all
 *     new (no old dinar price); the confirm re-sends the save with the hash and
 *     the cart charges the previewed prices;
 *   - a full admin (Q2) edits a price-first product's dollars: the wire holds
 *     dollars only (never the method or a cost field), the sheet comes first,
 *     the confirm writes;
 *   - the same admin on a COST-first product sends no pricing at all, and the
 *     product's other edits still save.
 *
 * Run: REQUIRE_DIST=1 node --import tsx --test tests/productFormV2Contract.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { count, get, json, post, type StubUser } from './fixtures/app';
import { legacyProductId } from './fixtures/legacyCatalogue';
import { pricingWorld, AMS } from './fixtures/procurementPricing';
import { cartGrid, v2App, writeV2 } from './fixtures/pricingV2';
import {
  FOLLOW_COLOUR,
  FOLLOW_MODEL,
  dollarsOf,
  draftOf,
  draftWire,
  previewOf,
  sectionOf,
  type PriceDraft,
  type V2Answer,
  type V2LiveIds,
} from '../src/components/adminProducts/form/v2/v2Model';
import { draftStructure } from '../src/components/adminProducts/form/v2/useV2Pricing';
import { needsTickOf, reviewRowsOf } from '../src/components/adminProducts/form/v2/ReviewSheetV2';
import { relationsFromWire, relationsToWire, type RelationsResponse } from '../src/components/adminProducts/form/model';
import { toEditorDoc } from '../src/components/adminProducts/types';

const MODEL = `${AMS}_o0`;
const AMS2 = legacyProductId('bambu-lab-ams-2-pro');
const FULL_ADMIN: StubUser = { id: 'usr_full', role: 'admin', email: 'full@x.co', admin_scope: 'full' };
const answer = async (res: Response) => ({ status: res.status, body: await json(res) });
const fixed = (usd: string) => ({ scope: 'product' as const, scope_id: '', kind: 'fixed' as const, usd });
const off = (usd: string) => ({ scope: 'product' as const, scope_id: '', usd });

/** The live ids the form derives from what it holds (here: from the server's table). */
function liveOf(a: V2Answer): V2LiveIds {
  const options = new Set(a.table.flatMap((r) => r.option_value_ids));
  return {
    options,
    models: options,
    colours: new Set(a.table.map((r) => r.color_id).filter((c): c is string => !!c)),
    skus: new Set(a.table.map((r) => r.combo_key)),
  };
}

/** What ProductForm's save posts for a stored product: its document, its relations, and `pricing_v2`. */
async function formSaveBody(app: ReturnType<typeof v2App>, id: string, pricingV2: Record<string, unknown> | null, patch: Record<string, unknown> = {}) {
  const read = await answer(await get(app, `/api/admin/products-v2/${id}`));
  assert.equal(read.status, 200, JSON.stringify(read.body).slice(0, 300));
  const relations = (await answer(await get(app, `/api/admin/products/${id}/relations`))).body as RelationsResponse;
  const doc = { ...toEditorDoc(read.body.product), ...patch } as Record<string, unknown>;
  const { options: _o, colors: _c, media: _m, ...docFields } = doc;
  void _o;
  void _c;
  void _m;
  return {
    ...docFields,
    relations: relationsToWire(relationsFromWire(relations)),
    expected_updated_at: read.body.product.updated_at,
    ...(pricingV2 ? { pricing_v2: pricingV2 } : {}),
  };
}

test('add-product (owner, price-first): the form’s draft is previewed under its id, held for the one sheet, then written as previewed', async () => {
  const w = pricingWorld();
  const app = v2App(w.raw);
  const id = 'fv2_new';
  const cells = [
    { fulfillment_type: 'direct_sale', enabled: true },
    { fulfillment_type: 'pre_order', enabled: true, transports: [{ method: 'land', enabled: true }] },
  ];
  const structure = {
    doc: { name_ar: 'منتج من النموذج', name_en: 'Form V2 product', status: 'active', selling_type: 'direct_sale', sale_types: ['direct_sale', 'pre_order'], stock: null },
    relations: {
      groups: [
        {
          id: `${id}_g`,
          name_en: 'Model',
          values: [
            { id: `${id}_std`, name_en: 'Standard', stock: 4, fulfillments: cells },
            { id: `${id}_pro`, name_en: 'Pro', stock: 3, fulfillments: cells },
          ],
        },
      ],
      colors: [
        { id: `${id}_blk`, name_en: 'Black', hex: '#000000' },
        { id: `${id}_red`, name_en: 'Red', hex: '#ff0000' },
      ],
      images: [],
    },
  };
  const models = new Set([`${id}_std`, `${id}_pro`]);
  const live: V2LiveIds = { options: models, models, colours: new Set([`${id}_blk`, `${id}_red`]), skus: new Set() };
  // The owner starts a new product from the dollar price here (the method toggle the form offers).
  const base = draftOf(null, 'usd');
  const draft: PriceDraft = {
    ...base,
    product_usd: '100',
    discount_usd: '10',
    models: { [`${id}_pro`]: { ...FOLLOW_MODEL, price: 'fixed', usd: '150' } },
    colours: { [`${id}_red`]: { ...FOLLOW_COLOUR, price: 'delta', usd: '5' } },
  };
  const wire = draftWire(base, draft, { points: [], discounts: [] }, live, { needsMethod: true, cost: true, money: true });
  assert.equal(wire.method, 'usd');
  assert.equal(wire.cost, undefined, 'no cost typed, no cost sent');
  assert.equal(wire.points?.length, 3);

  const shaped = draftStructure(structure, id);
  assert.equal(shaped.doc.id, id);
  assert.equal(shaped.doc.price_iqd, 0, 'no dinar price is typed: the structure carries the server’s neutral 0');
  const pre = await answer(await post(app, '/api/admin/products-v2/pricing/preview', { product_id: null, structure: shaped, pricing: wire }));
  assert.equal(pre.status, 200, JSON.stringify(pre.body).slice(0, 400));
  assert.equal(pre.body.complete, true, JSON.stringify(pre.body.codes));
  const at = (combo: string, channel: string) => (pre.body as V2Answer).table.find((r) => r.combo_key === combo && r.channel === channel)?.price_iqd;
  assert.equal(at(`o:${id}_std|c:${id}_blk`, 'direct_sale'), 160_000);
  assert.equal(at(`o:${id}_pro|c:${id}_red`, 'direct_sale'), 248_000, '150 + 5 dollars × 1,600');
  assert.equal(at(`o:${id}_std|c:${id}_blk`, 'pre_order_land'), 144_000, 'the product’s 10 dollars off a pre-order');

  // The save as ProductForm posts it: the document (with the draft id), its relations, the pricing block.
  const save = (block: Record<string, unknown>) =>
    post(app, '/api/admin/products-v2', { ...shaped.doc, relations: shaped.relations, pricing_v2: block });
  const held = await answer(await save({ pricing: wire }));
  assert.equal(held.status, 409, JSON.stringify(held.body).slice(0, 300));
  assert.equal(held.body.code, 'PRICING_PREVIEW_REQUIRED');
  assert.equal(sectionOf(held.body.details), 3);
  const sheet = previewOf(held.body.details);
  assert.ok(sheet, 'the refusal carries the preview the sheet shows');
  const rows = reviewRowsOf(sheet!);
  assert.equal(rows.length, 8, '2 models × 2 colours × (direct + land)');
  assert.ok(rows.every((r) => r.old_iqd === null && typeof r.new_iqd === 'number'), 'a first publication: every row is new — no old dinar price');
  assert.equal(needsTickOf(sheet!), false, 'nothing to compare: no 15% tick on a first publication');
  assert.equal(count(w.raw, `SELECT COUNT(*) AS n FROM products WHERE id = '${id}'`), 0, 'a held save writes nothing');

  const saved = await answer(await save({ pricing: wire, preview_hash: sheet!.review_hash }));
  assert.equal(saved.status, 200, JSON.stringify(saved.body).slice(0, 400));
  assert.deepEqual(saved.body.pricing_v2, { priced: true });
  const grid = await cartGrid(w.db, id);
  for (const r of (pre.body as V2Answer).table) assert.equal(grid[`${r.combo_key}@${r.channel}`]?.prepaid, r.price_iqd, `${r.combo_key} ${r.channel}`);

  // Read back: the draft the form rebuilds is exactly what was typed.
  const back = await answer(await get(app, `/api/admin/products-v2/${id}/pricing`));
  const again = draftOf(back.body as V2Answer);
  assert.equal(again.method, 'usd');
  assert.equal(again.product_usd, '100');
  assert.equal(again.discount_usd, '10');
  assert.equal(again.models[`${id}_pro`]?.price, 'fixed');
  assert.equal(again.colours[`${id}_red`]?.usd, '5');
});

test('Q2 through the form: a full admin edits a price-first product’s dollars — dollars only on the wire, the sheet first, then the write', async () => {
  const w = pricingWorld();
  await writeV2(w.db, AMS, { method: 'usd', points: [fixed('1000')], discounts: [off('50')] });
  const app = v2App(w.raw, FULL_ADMIN);
  const read = await answer(await get(app, `/api/admin/products-v2/${AMS}/pricing`));
  assert.equal(read.status, 200);
  const stored = read.body as V2Answer;
  assert.deepEqual(stored.can_edit, { money: true, cost: false, method: false, structure: true });
  const base = draftOf(stored);
  assert.equal(base.method, 'usd');
  assert.equal(base.product_usd, '1000');
  assert.equal(base.discount_usd, '50');
  assert.equal(base.cost.supplier_amount, '', 'an editor’s draft carries no cost');

  const draft: PriceDraft = { ...base, product_usd: '1100' };
  const wire = draftWire(base, draft, dollarsOf(stored), liveOf(stored), { needsMethod: false, cost: stored.can_edit.cost, money: stored.can_edit.money });
  assert.deepEqual(Object.keys(wire).sort(), ['points'], 'dollars only: never the method, never a cost field');
  assert.deepEqual(wire.points, [{ scope: 'product', id: '', kind: 'fixed', usd: '1100' }]);

  const pre = await answer(await post(app, '/api/admin/products-v2/pricing/preview', { product_id: AMS, pricing: wire }));
  assert.equal(pre.status, 200, JSON.stringify(pre.body).slice(0, 300));
  const direct = (pre.body as V2Answer).table.find((r) => r.combo_key === `o:${MODEL}` && r.channel === 'direct_sale');
  assert.equal(direct?.price_iqd, 1_760_000);

  const held = await answer(await post(app, '/api/admin/products-v2', await formSaveBody(app, AMS, { pricing: wire })));
  assert.equal(held.status, 409, JSON.stringify(held.body).slice(0, 300));
  assert.equal(held.body.code, 'PRICING_PREVIEW_REQUIRED');
  const sheet = previewOf(held.body.details)!;
  const rows = reviewRowsOf(sheet);
  assert.ok(rows.length >= 1 && rows.every((r) => r.old_iqd !== null), 'a re-price lists old → new');
  assert.equal(needsTickOf(sheet), false, '10% needs no tick');

  const saved = await answer(await post(app, '/api/admin/products-v2', await formSaveBody(app, AMS, { pricing: wire, preview_hash: sheet.review_hash })));
  assert.equal(saved.status, 200, JSON.stringify(saved.body).slice(0, 400));
  assert.deepEqual(saved.body.pricing_v2, { priced: true });
  assert.equal((await cartGrid(w.db, AMS))[`o:${MODEL}@direct_sale`]!.prepaid, 1_760_000);
});

test('Q2 through the form: on a cost-first product a full admin sends no pricing, and the product’s other edits still save', async () => {
  const w = pricingWorld();
  await writeV2(w.db, AMS2, {
    method: 'cost',
    inputs: { supplier_cost_amount: '450', supplier_cost_currency: 'EUR', shipping_profile: 'GERMANY_LAND', shipping_weight_g: 2500 },
    minimumProfitUsd: '120',
    discounts: [off('50')],
  });
  const before = await cartGrid(w.db, AMS2);
  const app = v2App(w.raw, FULL_ADMIN);
  const stored = (await answer(await get(app, `/api/admin/products-v2/${AMS2}/pricing`))).body as V2Answer;
  assert.equal(stored.can_edit.money, false, 'a cost-first product’s prices are the owner’s');
  const base = draftOf(stored);
  const wire = draftWire(base, { ...base, product_usd: '999', discount_usd: '1' }, dollarsOf(stored), liveOf(stored), {
    needsMethod: false,
    cost: stored.can_edit.cost,
    money: stored.can_edit.money,
  });
  assert.deepEqual(wire, {}, 'nothing typed can reach the wire');
  // ProductForm then sends no `pricing` (only the hash on screen, when there is one).
  const block = stored.review_hash ? { preview_hash: stored.review_hash } : null;
  const saved = await answer(await post(app, '/api/admin/products-v2', await formSaveBody(app, AMS2, block, { name_en: 'AMS 2 Pro (renamed)' })));
  assert.equal(saved.status, 200, JSON.stringify(saved.body).slice(0, 400));
  assert.equal(saved.body.product.name_en, 'AMS 2 Pro (renamed)');
  assert.deepEqual(await cartGrid(w.db, AMS2), before, 'no price moved');
});
