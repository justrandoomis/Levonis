/**
 * THE CART'S «تغيير الخيارات» SHEET LISTED UUIDs (owner's screenshot, 2026-10-17).
 *
 * Tapping a line's option chip opened the sheet with «اللون» over three rows
 * labelled f1cd26fc-…, 1ebca14a-…, 47e60fe2-… and «الخيارات» over 05b08a71-…,
 * where BLACK, COLD WHITE, BEIGE and «With spool — 1 kg» belonged. The rows
 * read `c.name || c.id`, and `name` is the V1 field: the V2 public projection
 * (`publicColor` / `publicOption`) sends `name_en` / `name_ar` / `name_ckb`
 * only, so the fallback printed every id.
 *
 * The rows are RENDERED here from the REAL cart route's answer, in all three
 * languages, and every label must be a name — never anything id-shaped.
 *
 * Run: node --import tsx --test tests/cartVariantSheetNames.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { ROOT } from './fixtures/d1';
import { asD1, freshDb, get, json, post, stubApp } from './fixtures/app';
import { cartRoutes } from '../worker/routes/cart';
import VariantChoices from '../src/components/cart/VariantChoices';
import { choiceName, unnamedChoice } from '../src/lib/choiceNames';
import type { CartItem } from '../src/lib/api';

const BLACK = 'f1cd26fc-b685-4b9e-9d0a-2f6c1e0a7b11';
const WHITE = '1ebca14a-9271-4c3d-8e5f-6a7b8c9d0e12';
const BEIGE = '47e60fe2-3239-4f1a-b2c3-d4e5f6a7b813';
const SPOOL = '05b08a71-c3a4-4d5e-8f60-718293a4b514';
const IDS = [BLACK, WHITE, BEIGE, SPOOL, 'g_spool', 'p_esun'];

/** Anything that looks like an id rather than a name: a UUID head, a long hex run, or one of the seeded ids. */
const idLooking = (label: string): boolean =>
  /[0-9a-f]{8}-[0-9a-f]{4}/i.test(label) || /\b[0-9a-f]{12,}\b/i.test(label) || IDS.includes(label.trim());

async function cartLine(): Promise<CartItem> {
  const raw = freshDb();
  raw.exec(`
    INSERT INTO users (id,name,email,password_hash,role) VALUES ('u1','Sara','s@x.co','h','customer');
    INSERT INTO products (id,slug,name,name_ar,price_iqd,status,stock,options,colors,selling_type,sale_types,preorder_transports,images,inventory_mode)
      VALUES ('p_esun','esun-pla','eSUN PLA+ Filament — 1 kg','eSUN PLA+',24000,'active',0,'[]','[]','direct_sale','["direct_sale"]','[]','[]','COLOR');
    INSERT INTO product_option_groups (id,product_id,name_en,sort,active) VALUES ('g_spool','p_esun','Spool',0,1);
    INSERT INTO product_option_values (id,product_id,group_id,name_en,name_ar,sort,active,stock) VALUES
      ('${SPOOL}','p_esun','g_spool','With spool — 1 kg','With spool — 1 kg',0,1,NULL);
    INSERT INTO product_colors (id,product_id,name_en,name_ar,hex,sort,active,stock) VALUES
      ('${BLACK}','p_esun','BLACK','BLACK','#000000',0,1,99),
      ('${WHITE}','p_esun','COLD WHITE','COLD WHITE','#F4F7FA',1,1,99),
      ('${BEIGE}','p_esun','BEIGE','BEIGE','#E8DCC4',2,1,99);
  `);
  const app = stubApp(asD1(raw), { id: 'u1', role: 'customer', email: 's@x.co' }, (a) => a.route('/api/cart', cartRoutes));
  const res = await post(app, '/api/cart/items', { productId: 'p_esun', optionValueIds: [SPOOL], colorId: BLACK, qty: 50, fulfillmentType: 'direct_sale' });
  assert.equal(res.status, 200, JSON.stringify(await json(res.clone())).slice(0, 400));
  const cart = await json(await get(app, '/api/cart'));
  const line = (cart.items as CartItem[]).find((i) => i.productId === 'p_esun');
  assert.ok(line, 'the line is in the cart');
  return line;
}

function labelsOf(line: CartItem, lang: 'ar' | 'en' | 'ckb'): { colours: string[]; options: string[]; html: string } {
  const html = renderToStaticMarkup(
    createElement(VariantChoices, {
      lang,
      colors: line.colors,
      options: line.options,
      pendingColorId: line.color_id,
      pendingOptionId: line.option_id,
      onColor: () => {},
      onOption: () => {},
      money: (n: number) => `${n} IQD`,
    })
  );
  const pick = (kind: string) =>
    [...html.matchAll(new RegExp(`data-variant-choice="${kind}"[^>]*>[\\s\\S]*?<bdi data-variant-choice-name="true">([^<]*)</bdi>`, 'g'))].map((m) => m[1]);
  return { colours: pick('colour'), options: pick('option'), html };
}

test('the server answer carries no V1 `name` on a V2 colour or option — the cause of the ids', async () => {
  const line = await cartLine();
  for (const c of [...line.colors, ...line.options]) {
    assert.equal((c as { name?: string }).name, undefined, 'publicColor / publicOption are an allow-list without `name`');
    assert.ok((c as { name_en?: string }).name_en, 'the name travels as name_en');
  }
});

for (const lang of ['ar', 'en', 'ckb'] as const) {
  test(`the sheet names every colour and option, never an id (${lang})`, async () => {
    const line = await cartLine();
    const { colours, options, html } = labelsOf(line, lang);
    assert.deepEqual(colours, ['BLACK', 'COLD WHITE', 'BEIGE'], 'the product colour order, by name');
    assert.deepEqual(options, ['With spool — 1 kg']);
    for (const label of [...colours, ...options]) assert.ok(!idLooking(label), `an id-looking label: ${label}`);
    for (const id of [BLACK, WHITE, BEIGE, SPOOL]) assert.ok(!html.includes(`>${id}<`), `the id ${id} is printed`);
    // The chosen colour and option are pressed; the swatch dots keep their hex.
    assert.match(html, /aria-pressed="true"[^>]*data-variant-choice="colour"/);
    assert.match(html, /background-color:#000000/);
  });
}

test('choiceName: English in every language (the product page rule), then the reader\'s own slot, then the other; never the id', () => {
  assert.equal(choiceName({ name_en: 'BLACK', name_ar: 'أسود', name_ckb: 'ڕەش' }, 'ar'), 'BLACK');
  assert.equal(choiceName({ name_en: 'BLACK', name_ar: 'أسود', name_ckb: 'ڕەش' }, 'ckb'), 'BLACK');
  assert.equal(choiceName({ name: 'Legacy Red' }, 'ar'), 'Legacy Red', 'a V1 row still names itself');
  assert.equal(choiceName({ name_en: '', name_ar: 'أسود', name_ckb: 'ڕەش' }, 'ar'), 'أسود');
  assert.equal(choiceName({ name_en: '', name_ar: 'أسود', name_ckb: 'ڕەش' }, 'ckb'), 'ڕەش');
  assert.equal(choiceName({ name_en: ' ', name_ar: 'أسود' }, 'ckb'), 'أسود');
  assert.equal(choiceName({ variant_label: 'Standard' }, 'en'), 'Standard');
  assert.equal(choiceName({}, 'en'), '');
  assert.deepEqual(
    (['ar', 'en', 'ckb'] as const).map((l) => unnamedChoice('colour', 3, l)),
    ['اللون 3', 'Colour 3', 'ڕەنگی 3']
  );
  assert.deepEqual(
    (['ar', 'en', 'ckb'] as const).map((l) => unnamedChoice('option', 1, l)),
    ['الخيار 1', 'Option 1', 'هەڵبژاردەی 1']
  );
});

test('a row with no name at all is numbered in the reader\'s language, never printed as its id', () => {
  const html = renderToStaticMarkup(
    createElement(VariantChoices, {
      lang: 'ckb',
      colors: [{ id: BLACK, hex: '#000000' }, { id: WHITE, name_en: 'COLD WHITE' }],
      options: [{ id: SPOOL }],
      pendingColorId: '',
      pendingOptionId: '',
      onColor: () => {},
      onOption: () => {},
      money: String,
    })
  );
  assert.ok(html.includes('>ڕەنگی 1<') && html.includes('>COLD WHITE<') && html.includes('>هەڵبژاردەی 1<'));
  for (const id of [BLACK, WHITE, SPOOL]) assert.ok(!html.includes(id), `the id ${id} is printed`);
});

test('no cart or checkout screen falls back from a V1 `name` to an id any more', () => {
  for (const file of ['src/pages/Cart.tsx', 'src/pages/Checkout.tsx', 'src/components/cart/VariantChoices.tsx']) {
    const src = readFileSync(join(ROOT, file), 'utf8');
    assert.doesNotMatch(src, /\.name \|\| [a-z]+\.id\b/, `${file} prints an id where a name is missing`);
  }
});
