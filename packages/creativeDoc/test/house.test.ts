/**
 * The house look (`levonis_gold`), the multi-product grid, the white
 * knockout and the chat contract.
 *
 *  - The house post binds the product's brand, model and price to the
 *    snapshot; the site address, tagline, «بسعر» and «اطلب الآن على» are
 *    brand elements (`source: brand`) that the checks accept and nobody can
 *    retype; it fits every format without a layout conflict and survives a
 *    normalize round trip (gradients, knockout).
 *  - A grid binds 2–4 products, each with its own picture, name and price.
 *  - The knockout clears a border-connected white backdrop and an island,
 *    keeps a white part inside the product, and returns the product's box.
 *  - A chat answer with a price or a link is refused; a bad idea is dropped.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateChat } from '../src/aiContracts';
import { defaultBrandKit } from '../src/brand';
import { knockoutWhite } from '../src/knockout';
import { modelName, rebuild } from '../src/layout';
import { normalizeDocument } from '../src/normalize';
import { applyOps } from '../src/ops';
import { qualityReport } from '../src/quality';
import { BRAND_TEXT, FORMATS, type TextLayer } from '../src/schema';
import { approximateMeasurer } from '../src/text';
import { allowedFor, built, snapshot } from './fixtures';

const kit = defaultBrandKit();
const live = (over = {}) => snapshot({ variant_key: null, variant_label: null, name: { ar: 'Bambu Lab X2D Combo', en: 'Bambu Lab X2D Combo', ckb: 'Bambu Lab X2D Combo' }, price: { status: 'priced', amount_iqd: 2027000, regular_iqd: null, from: false, offer: null, member_price_iqd: null }, ...over }, 'live');
const house = (format = FORMATS.square, snap = live()) =>
  built({
    template: 'levonis_gold', variant: 'product_first', format, objective: 'sell', locale: 'ar',
    products: [{ slot: 'main', snapshot: snap, image: { url: snap.data.images[0].url, width: 1200, height: 800, bounds: { x: 100, y: 120, width: 900, height: 600 } } }],
    copy: { headline: '' },
  });

test('the house post binds brand, model and price to the snapshot and draws the brand elements from the app', () => {
  const r = house();
  const text = (id: string) => r.doc.layers.find((l): l is TextLayer => l.id === id && l.type === 'text')!;
  assert.deepEqual(text('product_brand').source, { kind: 'product', slot: 'main', field: 'brand' });
  assert.equal(text('product_name').text, 'X2D Combo');
  assert.deepEqual(text('product_name').source, { kind: 'product', slot: 'main', field: 'model' });
  assert.ok(text('product_name').gradient, 'the model is gold');
  assert.match(text('price').text, /2,027,000/);
  assert.equal(text('site').text, BRAND_TEXT.site.ar);
  assert.deepEqual(text('site').source, { kind: 'brand', field: 'site' });
  assert.equal(text('cta').text, 'اطلب الآن على');
  const img = r.doc.layers.find((l) => l.id === 'product');
  assert.ok(img && img.type === 'image' && img.knockout === 'white' && img.crop?.width === 900, 'the picture is cut to its content box');
  for (const f of [FORMATS.square, FORMATS.portrait, FORMATS.story]) assert.deepEqual(house(f).conflicts, [], `${f.id} lays out cleanly`);
});

test('the checks accept the site address as a brand element, and nobody can retype it', () => {
  const r = house();
  const q = qualityReport(r.doc, { brand: kit, snapshots: { main: live() }, claims: {}, now: '2026-10-27T00:00:00Z', final: false, measure: approximateMeasurer });
  const codes = q.issues.map((i) => i.code);
  for (const bad of ['bound_text_missing', 'unbound_price_text', 'off_palette', 'dense', 'headline_missing', 'product_detail_crop', 'overlap', 'outside_safe_area']) assert.ok(!codes.includes(bad as never), `${bad}: ${JSON.stringify(q.issues)}`);
  const edit = applyOps(r.doc, [{ op: 'set_text', layer_id: 'site', value: 'example.com' }], { actor: 'human', brand: kit, allowed: allowedFor(live()) });
  assert.equal(edit.ok, false);
  // A changed brand word is reported, never drawn as the brand's.
  const forged = { ...r.doc, layers: r.doc.layers.map((l) => (l.id === 'site' && l.type === 'text' ? { ...l, text: 'evil.example' } : l)) };
  const q2 = qualityReport(forged, { brand: kit, snapshots: { main: live() }, claims: {}, now: '2026-10-27T00:00:00Z', final: false });
  assert.ok(q2.issues.some((i) => i.code === 'bound_text_missing' && i.layer_ids.includes('site')));
});

test('gradients and the knockout survive a normalize round trip and a rebuild', () => {
  const r = house();
  const n = normalizeDocument(JSON.parse(JSON.stringify(r.doc)));
  assert.ok(n.doc, JSON.stringify(n.issues));
  assert.deepEqual(n.issues.filter((i) => i.code === 'unknown_key' || i.code === 'invalid_value'), []);
  assert.deepEqual(n.doc!.layers, r.doc.layers);
  const again = rebuild(r.doc, { format: FORMATS.portrait }, { snapshots: { main: live() }, claims: {}, brand: kit, brandVersion: null, evidence: { arrival: false, back_in_stock: false, offer: false }, family: null, logo: null, backgroundNatural: null, measure: approximateMeasurer } as never);
  assert.ok(again);
  assert.equal(again!.doc.layers.filter((l) => l.id === 'gold_glow').length, 1, 'house layers are made again, not carried twice');
  const img = again!.doc.layers.find((l) => l.id === 'product');
  assert.ok(img && img.type === 'image' && img.crop?.width === 900);
});

test('the model is the variant label, or the name without its brand', () => {
  assert.equal(modelName(snapshot().data, 'en'), 'Combo (test)');
  assert.equal(modelName(live().data, 'ar'), 'X2D Combo');
  // A name that does not start with the brand has no model part: the house draws the whole name instead.
  const arabic = live({ name: { ar: 'طابعة Bambu Lab A1 ثلاثية الأبعاد', en: 'Bambu Lab A1', ckb: '' } });
  assert.equal(modelName(arabic.data, 'ar'), null);
  assert.equal(modelName(arabic.data, 'en'), 'A1');
  const r = house(FORMATS.square, arabic);
  const name = r.doc.layers.find((l): l is TextLayer => l.id === 'product_name' && l.type === 'text')!;
  assert.deepEqual(name.source, { kind: 'product', slot: 'main', field: 'name' });
  assert.ok(!r.doc.layers.some((l) => l.id === 'product_brand'));
});

test('a grid post binds 2–4 products, each with its own picture, name and price', () => {
  for (const n of [2, 3, 4]) {
    const slots = ['main', 'p2', 'p3', 'p4'].slice(0, n);
    const r = built({
      template: 'product_grid', variant: 'product_first', format: FORMATS.square, objective: 'sell', locale: 'ar', copy: { headline: 'تشكيلة الطابعات' },
      products: slots.map((slot, i) => {
        const s = { ...live({ product_id: `p_${i}`, price: { status: 'priced', amount_iqd: 100000 * (i + 1), regular_iqd: null, from: false, offer: null, member_price_iqd: null } }), id: `snap_${i}` };
        return { slot, snapshot: s, image: { url: `/files/products/test/p${i}.webp`, width: 1000, height: 1000 } };
      }),
    });
    assert.equal(r.doc.products.length, n);
    for (const [i, slot] of slots.entries()) {
      const sfx = slot === 'main' ? '' : `_${slot}`;
      const price = r.doc.layers.find((l) => l.id === `price${sfx}`);
      assert.ok(price && price.type === 'text' && price.source.kind === 'product' && price.source.slot === slot, `${n}/${slot}`);
      assert.match((price as TextLayer).text, new RegExp(`${i + 1}00,000`));
      assert.ok(r.doc.layers.some((l) => l.id === `product${sfx}` && l.type === 'image' && l.asset.slot === slot));
    }
    assert.ok(!r.conflicts.some((c) => c.code === 'overlap'), `${n}: ${JSON.stringify(r.conflicts)}`);
  }
});

test('the knockout clears the white backdrop and an island, keeps white inside the product, and boxes the product', () => {
  const W = 200, H = 120;
  const px = new Uint8ClampedArray(W * H * 4).fill(255);
  const paint = (x1: number, y1: number, x2: number, y2: number, v: number) => {
    for (let y = y1; y < y2; y++) for (let x = x1; x < x2; x++) { const i = (y * W + x) * 4; px[i] = v; px[i + 1] = v; px[i + 2] = v; }
  };
  paint(30, 30, 140, 100, 40); // the product
  paint(60, 50, 64, 54, 255); // a small white label inside it
  paint(80, 40, 130, 90, 255); // a large white pocket seen through an open frame
  paint(180, 4, 184, 8, 30); // a tiny island (a badge)
  const r = knockoutWhite(px, W, H);
  assert.deepEqual(r.bounds, { x: 30, y: 30, width: 110, height: 70 });
  assert.equal(px[(0 * W + 0) * 4 + 3], 0, 'backdrop cleared');
  assert.equal(px[(5 * W + 181) * 4 + 3], 0, 'island cleared');
  assert.equal(px[(60 * W + 100) * 4 + 3], 0, 'a large enclosed white pocket is backdrop');
  assert.equal(px[(52 * W + 62) * 4 + 3], 255, 'a small white part of the product stays');
  assert.equal(px[(35 * W + 35) * 4 + 3], 255);
});

test('a chat answer with a price or a link is refused; an idea that fails or names an unknown product is dropped', () => {
  const ctx = { products: new Set(['p_1']), evidence: { offer: false, serviceClaim: false, arrival: false, backInStock: false } };
  assert.deepEqual(validateChat({ reply: 'السعر 900,000 د.ع فقط', suggested_ideas: [] }, ctx), { ok: false, reason: 'price_like_text' });
  assert.deepEqual(validateChat({ reply: 'زوروا https://example.com', suggested_ideas: [] }, ctx), { ok: false, reason: 'invented_link' });
  const ok = validateChat({
    reply: 'فكرة جميلة: منشور يبرز دقة الطباعة.',
    suggested_ideas: [
      { objective: 'sell', product_ref: 'p_1', headline: 'دقة في كل طبقة', subhead: '', note: '' },
      { objective: 'sell', product_ref: 'p_unknown', headline: 'عنوان', subhead: '', note: '' },
      { objective: 'sell', product_ref: '', headline: 'خصم 20%', subhead: '', note: '' },
    ],
  }, ctx);
  assert.ok(ok.ok);
  if (ok.ok) {
    assert.equal(ok.ideas.length, 1);
    assert.equal(ok.ideas[0].product_ref, 'p_1');
    assert.equal(ok.dropped, 2);
  }
});

test('the house picture is adjusted by default (colour and light only), and a person changes it with one operation', () => {
  const r = house();
  const img = r.doc.layers.find((l) => l.id === 'product');
  assert.ok(img && img.type === 'image' && img.adjust && img.adjust.warmth > 0 && img.adjust.glow > 0);
  const before = img && img.type === 'image' ? { scale: img.scale, crop: img.crop, natural: img.natural } : null;
  const ctx = { actor: 'human' as const, brand: kit, allowed: allowedFor(live()) };
  const out = applyOps(r.doc, [{ op: 'set_picture_adjust', layer_id: 'product', adjust: { brightness: 0.1, contrast: -0.1, warmth: 0.6, glow: 0 }, knockout: null }], ctx);
  assert.ok(out.ok);
  if (out.ok) {
    const after = out.doc.layers.find((l) => l.id === 'product');
    assert.ok(after && after.type === 'image');
    if (after && after.type === 'image') {
      assert.deepEqual(after.adjust, { brightness: 0.1, contrast: -0.1, warmth: 0.6, glow: 0 });
      assert.equal(after.knockout, null);
      assert.deepEqual({ scale: after.scale, crop: after.crop, natural: after.natural }, before, 'shape, size and ratio untouched');
    }
  }
  assert.equal(applyOps(r.doc, [{ op: 'set_picture_adjust', layer_id: 'logo', adjust: null, knockout: null }], ctx).ok, false);
  assert.equal(applyOps(r.doc, [{ op: 'set_picture_adjust', layer_id: 'product', adjust: { brightness: 3, contrast: 0, warmth: 0, glow: 0 }, knockout: null }], ctx).ok, false);
  assert.equal(applyOps(r.doc, [{ op: 'set_picture_adjust', layer_id: 'product', adjust: null, knockout: null }], { ...ctx, actor: 'ai' }).ok, false, 'people only');
});
