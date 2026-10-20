/**
 * THE OWNER'S SENTENCES, THROUGH THE ROUTE (support assistant v2, push A).
 *
 * Live, on the owner's screenshot:
 *   1. «نوزل مال اي ون اريده 0.2» → «لم أفهم».
 *   2. «بحث عن منتج صيانه خلل بالنوزل» → «لم أجد».
 *   3. «صارت عندي مشكله بالطابعه» → a bare ticket prompt.
 *   4. «كلوب» (Iraqi for a nozzle clog) → the menu.
 *
 * The assistant now reads the sentence (worker/lib/assist/understand) and asks
 * the storefront's own search (`listCatalogProducts`) with the printer as a
 * catalogue link (`product_printer_fits`). This suite runs on a catalogue the
 * search index was built for, through the route, on a D1 stand-in that
 * refuses more than 100 bound parameters, and checks that every price the
 * assistant shows is the price the storefront grid shows the same viewer.
 *
 * Run: node --import tsx --test tests/assistAcceptance.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { DatabaseSync } from 'node:sqlite';
import { APEX, asD1, freshDb, json, post, get, stubApp, type StubUser } from './fixtures/app';
import { limitD1, violations } from './fixtures/d1Limits';
import { backfillSearchIndex } from '../worker/lib/search/store';
import { productRoutes } from '../worker/routes/products';
import { supportRoutes } from '../worker/routes/support';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
type Rec = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

const member: StubUser = { id: 'u_owner', role: 'customer', email: 'owner@x.co' };
const stranger: StubUser = { id: 'u_other', role: 'customer', email: 'other@x.co' };

const PRINTERS = [
  ['p_a1', 'bambu-lab-a1', 'Bambu Lab A1', 'طابعة بامبو لاب A1'],
  ['p_a1c', 'bambu-lab-a1-combo', 'Bambu Lab A1 Combo', 'طابعة بامبو لاب A1 كومبو'],
  ['p_a1m', 'bambu-lab-a1-mini', 'Bambu Lab A1 mini', 'طابعة بامبو لاب A1 ميني'],
  ['p_x1c', 'bambu-lab-x1-carbon', 'Bambu Lab X1 Carbon', 'طابعة بامبو لاب X1 كاربون'],
  ['p_p1s', 'bambu-lab-p1s', 'Bambu Lab P1S', 'طابعة بامبو لاب P1S'],
] as const;

const sizes = (list: string[]) => JSON.stringify(list.map((n, i) => ({ id: `ov_${i}`, name_en: n, active: true })));

async function shop(): Promise<DatabaseSync> {
  const raw = freshDb();
  raw.exec(`
    INSERT INTO users (id,name,email,password_hash,role) VALUES
      ('u_owner','Sara','owner@x.co','h','customer'),
      ('u_other','Omar','other@x.co','h','customer');
  `);
  const add = (id: string, slug: string, name: string, nameAr: string, price: number, category: string, options = '[]') =>
    raw
      .prepare(
        `INSERT INTO products (id,slug,name,name_ar,name_ku,price_iqd,status,stock,options,colors,selling_type,sale_types,
           preorder_transports,images,inventory_mode,ops_policy,category_id)
         VALUES (?,?,?,?,'',?,'active',5,?,'[]','direct_sale','["direct_sale"]','[]','[]','BASE','{}',?)`
      )
      .run(id, slug, name, nameAr, price, options, category);
  PRINTERS.forEach(([id, slug, name, nameAr], position) => {
    add(id, slug, name, nameAr, 1_000_000, 'cat_printers_fdm');
    raw.prepare('INSERT OR IGNORE INTO product_catalogs (product_id, catalog_id, position) VALUES (?, ?, ?)').run(id, 'cat_printers_fdm', 100 + position);
  });
  add('h_a1', 'bambu-hotend-a1-a2', 'Bambu Hotend - A1/A2', 'هوت إند بامبو - A1/A2', 45_000, 'cat_maint_hotend',
    sizes(['0.2mm', '0.4mm', '0.6mm', '0.8mm', 'A1', 'A1 mini', 'A2L']));
  add('h_x1', 'bambu-hotend-x1-p1', 'Bambu Hotend - X1/P1', 'هوت إند بامبو - X1/P1', 60_000, 'cat_maint_hotend', sizes(['0.2mm', '0.4mm']));
  add('n_needle', 'nozzle-cleaning-needle', 'Nozzle Cleaning Needle', 'إبرة تنظيف النوزل', 5_000, 'cat_maint_spare');
  add('pl_pei', 'textured-pei-plate', 'Textured PEI Plate', 'بليت PEI محبب', 30_000, 'cat_maint_plate');
  add('f_pla', 'pla-basic', 'PLA Basic', 'فلامنت PLA', 20_000, 'cat_materials');
  const fit = (part: string, printer: string, position = 0) =>
    raw.prepare('INSERT INTO product_printer_fits (product_id, printer_id, position) VALUES (?, ?, ?)').run(part, printer, position);
  for (const p of ['p_a1', 'p_a1c', 'p_a1m']) fit('h_a1', p);
  for (const p of ['p_x1c', 'p_p1s']) fit('h_x1', p);
  fit('n_needle', 'p_a1');
  fit('n_needle', 'p_x1c', 1);
  fit('pl_pei', 'p_a1');
  fit('pl_pei', 'p_a1c', 1);
  // The owner's own A1, delivered and registered.
  raw.exec(`
    INSERT INTO orders (id,user_id,status,address_snapshot,delivery_method_id,delivery_method_snapshot,payment_method_id,
                        subtotal_iqd,shipping_iqd,exchange_rate,total_iqd,due_on_delivery_iqd)
      VALUES ('ORD-OWN','u_owner','delivered','{}','standard','{}','cash',1000000,0,1400,1000000,0);
    INSERT INTO order_items (id,order_id,product_id,name_snapshot,option_snapshot,qty,unit_price_iqd,line_total_iqd)
      VALUES ('oi_own','ORD-OWN','p_a1','Bambu Lab A1','',1,1000000,1000000);
    INSERT INTO order_item_units (id,order_id,order_item_id,product_id,owner_user_id,unit_index,delivered_at,warranty_end_at)
      VALUES ('unit_own','ORD-OWN','oi_own','p_a1','u_owner',1,'2026-09-18T00:00:00.000Z','2027-09-18T00:00:00.000Z');
    INSERT INTO device_registrations (unit_id, user_id) VALUES ('unit_own', 'u_owner');
  `);
  const run = await backfillSearchIndex(asD1(raw), { limit: 50 });
  assert.deepEqual(run.failed, []);
  return raw;
}

function appFor(db: D1Database, user: StubUser | null) {
  return stubApp(
    db as never,
    user,
    (a) => {
      a.route('/api/products', productRoutes);
      a.route('/api/support', supportRoutes);
    },
    { host: APEX, env: { DB: db } }
  );
}

async function ask(db: D1Database, user: StubUser | null, body: Rec): Promise<Rec> {
  const res = await post(appFor(db, user), '/api/support/assistant', { locale: 'ar', ...body });
  assert.equal(res.status, 200, JSON.stringify(body));
  assert.match(res.headers.get('Cache-Control') ?? '', /no-store/);
  return (await json(res)).reply as Rec;
}

/** The storefront grid's figure for a product, for this viewer (CardPrice: display_price_iqd ?? price_iqd). */
async function gridPrice(db: D1Database, user: StubUser | null, id: string): Promise<number | null> {
  const res = await get(appFor(db, user), '/api/products?limit=50');
  const card = ((await json(res)).products as Rec[]).find((p) => p.id === id);
  assert.ok(card, `${id} is not on the grid`);
  return (card.display_price_iqd ?? card.price_iqd ?? null) as number | null;
}

const ids = (reply: Rec): string[] => ((reply.cards ?? []) as Rec[]).map((c) => String(c.product_id));
const CLARIFY = 'لم أفهم طلبك تمامًا. اختر أحد هذه المواضيع:';

// ════════════════════════════════════════ 1. «نوزل مال اي ون اريده 0.2»

test('1. «نوزل مال اي ون اريده 0.2»: the A1 hotend with a 0.2, at the grid price, never the X1 one', async () => {
  const raw = await shop();
  const db = limitD1(raw);
  for (const user of [null, member]) {
    const reply = await ask(db, user, { text: 'نوزل مال اي ون اريده 0.2' });
    assert.equal(reply.intent, 'product_search');
    assert.notEqual(reply.text, CLARIFY);
    assert.ok(ids(reply).includes('h_a1'), `the A1/A2 hotend: ${JSON.stringify(reply)}`);
    assert.ok(!ids(reply).includes('h_x1'), 'another printer’s hotend is never a match');
    assert.ok(!ids(reply).includes('n_needle'), 'a part without the 0.2 size is not an answer to «0.2»');
    assert.match(reply.text, /A1/);
    assert.match(reply.text, /0\.2/);
    assert.equal(reply.context.printer.model, 'A1');
    const card = (reply.cards as Rec[]).find((c) => c.product_id === 'h_a1')!;
    assert.equal(card.price_iqd, await gridPrice(db, user, 'h_a1'), 'the assistant quotes the grid’s own figure');
  }
  assert.deepEqual(violations, []);
});

test('1. the same question in English, Sorani and Arabic digits', async () => {
  const db = limitD1(await shop());
  for (const [text, locale] of [
    ['nozzle for A1 0.2mm', 'en'],
    ['نۆزڵ بۆ A1 0.2', 'ckb'],
    ['نوزل ٠.٢ مال ايه ون', 'ar'],
  ] as const) {
    const reply = await ask(db, null, { text, locale });
    assert.equal(reply.intent, 'product_search', text);
    assert.ok(ids(reply).includes('h_a1'), `${text}: ${JSON.stringify(ids(reply))}`);
    assert.ok(!ids(reply).includes('h_x1'), text);
    assert.equal(reply.context.printer.model, 'A1', text);
  }
});

test('1. the printer stays for the next question: «واكو بليت؟» is the A1 plate', async () => {
  const db = limitD1(await shop());
  const first = await ask(db, null, { text: 'نوزل مال اي ون اريده 0.2' });
  const next = await ask(db, null, { text: 'واكو بليت؟', context: first.context });
  assert.deepEqual(ids(next), ['pl_pei']);
  assert.match(next.text, /A1/);
  assert.equal(next.context.part, 'plate');
  assert.equal(next.context.printer.model, 'A1');
});

test('1. without a catalogue link the reply says the product MENTIONS the A1, and still never shows the X1 part', async () => {
  const raw = await shop();
  raw.exec('DELETE FROM product_printer_fits');
  const db = limitD1(raw);
  const reply = await ask(db, null, { text: 'نوزل مال اي ون اريده 0.2' });
  assert.ok(ids(reply).includes('h_a1'));
  assert.ok(!ids(reply).includes('h_x1'));
  assert.match(reply.text, /تأكد من التوافق في صفحة المنتج/);
});

// ════════════════════════════════ 2. «بحث عن منتج صيانه خلل بالنوزل»

test('2. «بحث عن منتج صيانه خلل بالنوزل»: maintenance products for a nozzle fault', async () => {
  const db = limitD1(await shop());
  const reply = await ask(db, null, { text: 'بحث عن منتج صيانه خلل بالنوزل' });
  assert.equal(reply.intent, 'product_search');
  assert.notEqual(reply.text, 'لم أجد منتجات مطابقة في الكتالوج العام.');
  for (const id of ['h_a1', 'h_x1', 'n_needle']) assert.ok(ids(reply).includes(id), `${id} in ${JSON.stringify(ids(reply))}`);
  for (const id of ['f_pla', 'pl_pei', 'p_a1']) assert.ok(!ids(reply).includes(id), `${id} is not a nozzle fix`);
  assert.match(reply.text, /الصيانة/);
  assert.deepEqual(violations, []);
});

// ═══════════════════════════════════════════════ 4. «كلوب» — the clog path

test('4. «كلوب» asks which printer, from the printers the shop lists, holding the clog', async () => {
  const db = limitD1(await shop());
  const reply = await ask(db, null, { text: 'كلوب' });
  assert.equal(reply.intent, 'printer_problem');
  assert.match(reply.text, /انسداد النوزل/);
  const models = (reply.choices as Rec[]).map((c) => c.params.model);
  assert.deepEqual(models, ['A1', 'A1 mini', 'P1S', 'X1C', 'other'], 'catalogue models only, plus «another printer»');
  assert.deepEqual(reply.context.triage, { stage: 'printer', symptom: 'clog' });

  const steps = await ask(db, null, { intent: 'printer_problem', params: { step: 'printer', model: 'A1' }, context: reply.context });
  assert.equal(steps.intent, 'printer_problem');
  assert.ok(steps.steps.length >= 2 && steps.steps.length <= 4);
  assert.equal(steps.steps[0].safety, 'hot', 'the first step is the burn warning');
  assert.ok(ids(steps).includes('h_a1') && ids(steps).includes('n_needle'), JSON.stringify(ids(steps)));
  assert.ok(!ids(steps).includes('h_x1'));
  assert.equal(steps.links[0].to, 'https://wiki.bambulab.com/en/filament-acc/acc/nozzles');
  assert.equal(steps.links[0].external, true);
  assert.deepEqual(
    (steps.choices as Rec[]).map((c) => c.params.step),
    ['outcome', 'outcome', 'talk', 'change_printer']
  );
});

test('4. the other ways of saying it take the same path, and a known printer goes straight to the steps', async () => {
  const db = limitD1(await shop());
  for (const [text, locale] of [
    ['النوزل مسدود', 'ar'],
    ['nozzle clogged', 'en'],
    ['نۆزڵ گیراوە', 'ckb'],
  ] as const) {
    const reply = await ask(db, null, { text, locale });
    assert.equal(reply.intent, 'printer_problem', text);
    assert.equal(reply.context.triage.symptom, 'clog', text);
  }
  const known = await ask(db, null, { text: 'كلوب', context: { v: 1, printer: { model: 'A1' } } });
  assert.equal(known.context.triage.stage, 'steps');
  assert.ok(known.steps.length > 0);
  assert.match(known.text, /A1/);
});

// ═════════════════════ 3. «صارت عندي مشكله بالطابعه» — the triage, end to end

test('3. «صارت عندي مشكله بالطابعه»: the owner’s own A1 first, the eight symptoms, steps, then a prefilled ticket', async () => {
  const db = limitD1(await shop());
  const start = await ask(db, member, { text: 'صارت عندي مشكله بالطابعه' });
  assert.equal(start.intent, 'printer_problem');
  const mine = start.choices[0];
  assert.equal(mine.params.unit_id, 'unit_own');
  assert.equal(mine.params.model, 'A1');

  const which = await ask(db, member, { intent: 'printer_problem', params: mine.params, context: start.context });
  assert.deepEqual(
    (which.choices as Rec[]).slice(0, 8).map((c) => c.label),
    ['انسداد النوزل', 'عدم الالتصاق', 'إزاحة الطبقات', 'خيوط stringing', 'مشكلة AMS', 'رمز خطأ HMS', 'صوت غريب', 'أخرى']
  );
  assert.equal(which.context.printer.unit_id, 'unit_own');

  const steps = await ask(db, member, { intent: 'printer_problem', params: { step: 'symptom', symptom: 'clog' }, context: which.context });
  const handoff = await ask(db, member, { intent: 'printer_problem', params: { step: 'outcome', outcome: 'not_fixed' }, context: steps.context });
  assert.equal(handoff.handoff, true);
  assert.match(handoff.ticket_draft.subject, /A1/);
  assert.match(handoff.ticket_draft.body, /انسداد النوزل/);
  for (const step of steps.steps as Rec[]) assert.ok(handoff.ticket_draft.body.includes(step.text), 'every shown step is listed as tried');
  assert.equal(handoff.ticket_draft.unit_id, 'unit_own');

  // A guest reaches the same draft and is asked to sign in.
  const guest = await ask(db, null, { intent: 'printer_problem', params: { step: 'talk' }, context: { v: 1, printer: { model: 'A1' }, triage: { stage: 'steps', symptom: 'clog' } } });
  assert.equal(guest.auth_required, true);
  assert.ok(guest.ticket_draft.body.length > 0);
});

test('3. a device id is a hint: another customer’s unit is never carried', async () => {
  const db = limitD1(await shop());
  const forged = { step: 'printer', model: 'A1', unit_id: 'unit_own' };
  const r = await ask(db, stranger, { intent: 'printer_problem', params: forged, context: { v: 1 } });
  assert.equal(r.context.printer.unit_id, undefined);
  const carried = await ask(db, stranger, {
    intent: 'printer_problem',
    params: { step: 'talk' },
    context: { v: 1, printer: { model: 'A1', unit_id: 'unit_own' }, triage: { stage: 'steps', symptom: 'clog' } },
  });
  assert.equal(carried.ticket_draft.unit_id, undefined, 'a forged context cannot attach someone else’s printer');
});

test('the menu chip starts the triage, and «الطابعة خربانة» does too', async () => {
  const db = limitD1(await shop());
  const chip = await ask(db, null, { intent: 'printer_problem' });
  assert.equal(chip.context.triage.stage, 'printer');
  const typed = await ask(db, null, { text: 'الطابعة خربانة' });
  assert.equal(typed.intent, 'printer_problem');
});

// ═══════════════════════════════════════════════ what must NOT change

test('must-not: account questions, a bare model, two topics and filament stay with their handlers', async () => {
  const db = limitD1(await shop());
  assert.equal((await ask(db, member, { text: 'وين طلبي ORD-OWN' })).intent, 'order_status');
  const cold = await ask(db, null, { text: 'A1 combo' });
  assert.equal(cold.intent, 'product_search');
  assert.equal(cold.cards[0].product_id, 'p_a1c', 'a typed name is still found first');
  assert.equal((await ask(db, null, { text: 'اريد ارجع المنتج' })).intent, 'clarify');
  assert.equal((await ask(db, null, { text: 'اي طابعة تنصحني' })).intent, 'choose_printer');
  assert.equal((await ask(db, null, { text: 'خيوط PLA' })).intent, 'materials_help');
  assert.equal((await ask(db, null, { text: 'شكد سعر A1 combo' })).intent, 'price_question');
  // A printer said out loud reaches the legacy readers as its token.
  assert.equal((await ask(db, null, { text: 'كم تستهلك بي ون اس' })).intent, 'power_usage');
});

test('the assistant no longer runs a LIKE over the whole sentence', () => {
  const route = readFileSync(join(ROOT, 'worker/routes/support.ts'), 'utf8');
  assert.ok(!route.includes('name LIKE ?1'), 'product search goes through the storefront search engine');
  assert.ok(!/from '\.\/products'/.test(route), 'support.ts reads the card builders through worker/lib/catalog/cardsRead.ts');
});
