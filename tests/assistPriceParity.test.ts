/**
 * ASSISTANT PRICE AND STOCK PARITY (assistant plan, Phase 1 item 1.1;
 * acceptance rows 14 and 15).
 *
 * Live, the support assistant quoted eSUN PLA+ at 27,000 IQD beside a card
 * saying 24,250, and the X2D at 2,118,750 beside 1,934,000. Its product search
 * called `publicWithDisplayPrice` WITHOUT the live offer or the mystery pool,
 * and «ساعدني باختيار طابعة» printed the base row's `price_iqd`. Its stock
 * badge read the base `stock` counter, so a product whose units sit on its
 * options read «غير متوفر» — the «incomplete selection reads OUT_OF_STOCK» seen
 * live.
 *
 * The assistant now prices nothing: the cards come from the listing's own
 * builders (`resolveListingCards` → `resolveProductCards` with offers and the
 * pool, a bundle through `compositionCard`) and the availability from the
 * card's own rule (`cardAvailability`, packages/catalog). This suite asks the
 * assistant and the storefront grid about the same products, as a guest and as
 * a PRIME member, and requires the same figure, the same «يبدأ من» and the same
 * availability state — on a live offer, a members-only offer, a multi-SKU
 * «from» price whose stock is on its options, a mystery-pool member, a
 * pre-order-only product, a catalog-only product, a bundle and a locked bundle.
 *
 * Run: node --import tsx --test tests/assistPriceParity.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { DatabaseSync } from 'node:sqlite';
import { asD1, get, json, post, stubApp, type StubUser } from './fixtures/app';
import { addBundle, seedCatalogue } from './lib/bundles';
import { productRoutes } from '../worker/routes/products';
import { supportRoutes } from '../worker/routes/support';
import { cardAvailability } from '../src/lib/productCard';
import { availabilityFromComposition } from '../worker/lib/publicApi/common';

const prime: StubUser = { id: 'u_prime', role: 'customer', email: 'n@x.co' };

type Rec = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

/** What each fixture is, and the name the customer types for it. */
const SUBJECTS = [
  { id: 'p_pla', q: 'PLA Basic', slug: 'pla' }, // a live 20% offer
  { id: 'p_gated', q: 'Gated Resin', slug: 'gated-resin' }, // a PRIME-only 10% offer
  { id: 'p_opts', q: 'Hotend Kit', slug: 'hotend-kit' }, // two SKUs at two prices, stock on the options only
  { id: 'p_nozzle', q: 'Nozzle 0.4', slug: 'nozzle' }, // a member of an active mystery pool
  { id: 'p_pre', q: 'PETG Spool', slug: 'petg' }, // pre-order only
  { id: 'p_color', q: 'ABS Spool', slug: 'abs' }, // stock on the colours
  { id: 'p_lamp', q: 'Catalog Lamp', slug: 'catalog-lamp' }, // shown, never priced (catalog-only)
  { id: 'b_starter', q: 'Starter Bundle', slug: 'starter' }, // a fixed-price bundle
  { id: 'b_box', q: 'Members Box', slug: 'members-box' }, // a bundle locked to PRIME
] as const;

function seed(): DatabaseSync {
  const raw = seedCatalogue();
  raw.exec(`
    INSERT INTO offer_windows (subject_type,subject_id,id,starts_at,ends_at,required_tiers,offer_price_mode,
                               offer_price_iqd,discount_percent,discount_iqd,plus_price_iqd,locked_preview,active)
    VALUES ('product','p_pla','ofw_pla',NULL,NULL,'[]','discount_percent',NULL,20,NULL,NULL,1,1);

    INSERT INTO products (id,slug,name,name_ar,name_ku,price_iqd,status,stock,options,colors,
                          selling_type,sale_types,preorder_transports,images,inventory_mode,ops_policy)
    VALUES
      ('p_gated','gated-resin','Gated Resin','ريزن','ڕێزن',50000,'active',3,'[]','[]',
       'direct_sale','["direct_sale"]','[]','["https://cdn/resin.png"]','BASE','{}'),
      ('p_opts','hotend-kit','Hotend Kit','طقم هوت إند','کیتی هۆت ئێند',30000,'active',0,'[]','[]',
       'direct_sale','["direct_sale"]','[]','["https://cdn/hotend.png"]','OPTION','{}'),
      ('p_lamp','catalog-lamp','Catalog Lamp','مصباح','چرا',0,'active',4,'[]','[]',
       'direct_sale','["direct_sale"]','[]','["https://cdn/lamp.png"]','BASE','{}');
    INSERT INTO offer_windows (subject_type,subject_id,id,starts_at,ends_at,required_tiers,offer_price_mode,
                               offer_price_iqd,discount_percent,discount_iqd,plus_price_iqd,locked_preview,active)
    VALUES ('product','p_gated','ofw_gated',NULL,NULL,'["prime"]','discount_percent',NULL,10,NULL,NULL,1,1);

    INSERT INTO product_option_groups (id,product_id,name_en,sort,active) VALUES ('g_kit','p_opts','Kit',0,1);
    INSERT INTO product_option_values (id,product_id,group_id,name_en,name_ar,sort,active,stock,regular_price_iqd) VALUES
      ('ov_std','p_opts','g_kit','Standard','قياسي',0,1,3,30000),
      ('ov_pro','p_opts','g_kit','Pro','احترافي',1,1,0,45000);

    INSERT INTO mystery_pools (id,name,kind) VALUES ('pool_nz','Nozzle pool','direct');
    INSERT INTO mystery_pool_entries (id,pool_id,product_id,option_value_ids,color_id,family_id,weight,active)
    VALUES ('mpe_nz','pool_nz','p_nozzle','[]','','',1,1);
  `);
  addBundle(raw, { id: 'b_starter', slug: 'starter', name: 'Starter Bundle', priceIqd: 400_000 });
  addBundle(raw, {
    id: 'b_box',
    slug: 'members-box',
    name: 'Members Box',
    priceIqd: 300_000,
    window: { required_tiers: '["prime"]', locked_preview: 0 },
    components: [{ id: 'bc_box_pla', product: 'p_pla', qty: 3 }],
  });
  return raw;
}

const appFor = (db: unknown, user: StubUser | null) =>
  stubApp(db, user, (a) => {
    a.route('/api/products', productRoutes);
    a.route('/api/support', supportRoutes);
  });

/** The storefront grid's cards for this viewer: the ordinary listing and the bundle shelf, by id. */
async function storefront(db: unknown, user: StubUser | null): Promise<Map<string, Rec>> {
  const app = appFor(db, user);
  const out = new Map<string, Rec>();
  for (const path of ['/api/products?limit=50', '/api/products?type=bundle&limit=50']) {
    const res = await get(app, path);
    assert.equal(res.status, 200, path);
    for (const card of (await json(res)).products as Rec[]) out.set(String(card.id), card);
  }
  return out;
}

async function assistantCard(db: unknown, user: StubUser | null, q: string, slug: string, locale = 'en'): Promise<Rec> {
  const res = await post(appFor(db, user), '/api/support/assistant', { locale, intent: 'product_search', params: { q } });
  assert.equal(res.status, 200);
  const reply = (await json(res)).reply as Rec;
  assert.equal(reply.intent, 'product_search', `${q}: ${JSON.stringify(reply).slice(0, 200)}`);
  const card = (reply.cards as Rec[]).find((c) => c.link.to.endsWith(`/${slug}`));
  assert.ok(card, `${q}: the assistant found no card for /${slug} in ${JSON.stringify(reply.cards)}`);
  return card;
}

/** What the grid prints: the card's figure (CardPrice: `display_price_iqd ?? price_iqd`), none when unpriced or locked. */
const shownPrice = (card: Rec): number | null =>
  card.locked === true || card.price_status === 'unpriced' ? null : ((card.display_price_iqd ?? card.price_iqd ?? null) as number | null);
const shownState = (id: string, card: Rec) =>
  id.startsWith('b_') ? availabilityFromComposition(card.availability_state).state : cardAvailability(card).state;

async function parity(db: unknown, user: StubUser | null) {
  const grid = await storefront(db, user);
  const seen = new Map<string, Rec>();
  for (const s of SUBJECTS) {
    const card = grid.get(s.id);
    assert.ok(card, `${s.id} is on the storefront grid`);
    const a = await assistantCard(db, user, s.q, s.slug);
    const who = `${s.id} for ${user ? user.id : 'a guest'}`;
    assert.equal(a.price_iqd, shownPrice(card), `${who}: the assistant's price is the card's`);
    assert.equal(a.price_from, shownPrice(card) !== null && card.display_from === true, `${who}: «يبدأ من» as the card`);
    assert.equal(a.availability, shownState(s.id, card), `${who}: the availability is the card's`);
    seen.set(s.id, a);
  }
  return { grid, seen };
}

test('a guest: every assistant price and availability is the storefront card’s', async () => {
  const db = asD1(seed());
  const { grid, seen } = await parity(db, null);

  // The live defect, pinned: the offer price, never the ladder.
  assert.equal(seen.get('p_pla')!.price_iqd, 20_000, 'PLA Basic on a live 20% offer');
  assert.notEqual(seen.get('p_pla')!.price_iqd, 25_000);
  assert.match(seen.get('p_pla')!.subtitle, /20,000 IQD/);
  assert.equal(seen.get('p_pla')!.badge, 'In stock');

  // A members-only offer does not price a guest's card, so it does not price the guest's answer.
  assert.equal(seen.get('p_gated')!.price_iqd, grid.get('p_gated')!.display_price_iqd);

  // Two SKUs at two prices: «from» the cheaper, and the units on the options are IN STOCK (row 15).
  const kit = seen.get('p_opts')!;
  assert.equal(kit.price_from, true);
  assert.equal(kit.price_iqd, grid.get('p_opts')!.display_price_iqd);
  assert.match(kit.subtitle, /^Price: from /);
  assert.equal(kit.availability, 'available', 'stock on the options is stock — never «Out of stock»');
  assert.equal(kit.badge, 'In stock');

  // Pre-order only: said as the card says it.
  assert.equal(seen.get('p_pre')!.availability, 'preorder');
  assert.equal(seen.get('p_pre')!.badge, 'Pre-order');

  // A mystery-pool member: the card publishes no exact count, and neither does the answer.
  assert.equal('direct_stock_available' in grid.get('p_nozzle')!, false);

  // Catalog-only: no price, no stock word.
  const lamp = seen.get('p_lamp')!;
  assert.equal(lamp.price_iqd, null);
  assert.equal(lamp.price_status, 'unpriced');
  assert.equal(lamp.subtitle, 'Price not available yet');
  assert.equal(lamp.badge, undefined);
  assert.equal(lamp.availability, 'unknown');

  // A bundle is priced by its own builder and opens the bundle page; a locked one carries no price.
  assert.equal(seen.get('b_starter')!.price_iqd, grid.get('b_starter')!.display_price_iqd);
  assert.equal(seen.get('b_starter')!.link.to, '/bundles/starter');
  assert.equal(grid.get('b_box')!.locked, true);
  assert.equal(seen.get('b_box')!.price_iqd, null);
  assert.equal(seen.get('b_box')!.subtitle, 'Members only');
});

test('a PRIME member: the same parity, at the member’s own prices', async () => {
  const db = asD1(seed());
  const guest = await parity(db, null);
  const member = await parity(db, prime);

  // The members-only offer prices the member's card and the member's answer, and only theirs.
  const g = guest.seen.get('p_gated')!.price_iqd as number;
  const m = member.seen.get('p_gated')!.price_iqd as number;
  assert.ok(m < g, `PRIME pays the gated offer (${m}) and a guest does not (${g})`);
  assert.equal(m, member.grid.get('p_gated')!.display_price_iqd);

  // The locked bundle opens for PRIME, at the bundle builder's price.
  assert.equal(member.grid.get('b_box')!.locked, false);
  assert.equal(typeof member.seen.get('b_box')!.price_iqd, 'number');
  assert.equal(member.seen.get('b_box')!.price_iqd, member.grid.get('b_box')!.display_price_iqd);
});

test('the words are the card’s, in Arabic and in real Sorani', async () => {
  const db = asD1(seed());
  const ar = await assistantCard(db, null, 'Hotend Kit', 'hotend-kit', 'ar');
  const ckb = await assistantCard(db, null, 'Hotend Kit', 'hotend-kit', 'ckb');
  assert.equal(ar.badge, 'متوفر الآن');
  assert.equal(ckb.badge, 'بەردەستە');
  assert.match(ar.subtitle, /يبدأ من/);
  assert.match(ckb.subtitle, /^نرخ: لە /);
  assert.notEqual(ckb.subtitle, ar.subtitle, 'a Sorani slot never carries the Arabic');
  const pre = await assistantCard(db, null, 'PETG Spool', 'petg', 'ckb');
  assert.equal(pre.badge, 'پێش-داواکاری');
  const box = await assistantCard(db, null, 'Members Box', 'members-box', 'ckb');
  assert.equal(box.subtitle, 'تەنها بۆ ئەندامان');
});
