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
  const hotendSizes = ['0.2mm', '0.4mm', '0.6mm', '0.8mm', 'A1', 'A1 mini', 'A2L'];
  add('h_a1', 'bambu-hotend-a1-a2', 'Bambu Hotend - A1/A2', 'هوت إند بامبو - A1/A2', 45_000, 'cat_maint_hotend', sizes(hotendSizes));
  // Its sizes as relational option rows too, so the real V2 writer publishes it and the grid
  // prices it («يبدأ من» 45,000): the parity checks below compare figures, never null to null.
  raw.prepare(`INSERT INTO product_option_groups (id,product_id,name_en,sort,active) VALUES ('g_h_a1','h_a1','Size',0,1)`).run();
  hotendSizes.forEach((n, i) =>
    raw
      .prepare(
        `INSERT INTO product_option_values (id,product_id,group_id,name_en,name_ar,sort,active,stock,regular_price_iqd)
         VALUES (?,?,?,?,?,?,1,3,?)`
      )
      .run(`ov_${i}`, 'h_a1', 'g_h_a1', n, n, i, i === 0 ? 45_000 : 50_000)
  );
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
    const grid = await gridPrice(db, user, 'h_a1');
    assert.equal(grid, 45_000, 'the grid prices the hotend: the parity below compares figures, not null to null');
    assert.equal(card.price_iqd, grid, 'the assistant quotes the grid’s own figure');
    assert.equal(card.price_from, true, '«يبدأ من», as the grid');
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

// ═══════════════════════════════════ review rows: what a real conversation types

test('review: an article or preposition glued to a printer name is still that printer', async () => {
  const db = limitD1(await shop());
  for (const text of ['نوزل مال الاي ون', 'نوزل للاي ون', 'نوزل بالاي ون', 'نوزل للA1', 'نوزل حق الاي ون 0.2', 'الهوت اند مال A1']) {
    const reply = await ask(db, null, { text });
    assert.ok(ids(reply).includes('h_a1'), `${text}: ${JSON.stringify(ids(reply))}`);
    assert.ok(!ids(reply).includes('h_x1'), `${text}: another printer’s hotend is never a match`);
    assert.equal(reply.context.printer.model, 'A1', text);
  }
  for (const text of ['نوزل للبي ون اس', 'نوزل مال البي ون اس', 'نوزل بالP1S', 'اكو نوزل 0.4 للبي ون اس']) {
    const reply = await ask(db, null, { text });
    assert.ok(ids(reply).includes('h_x1'), `${text}: ${JSON.stringify(ids(reply))}`);
    assert.ok(!ids(reply).includes('h_a1'), `${text}: the A1 hotend is not a P1S part`);
    assert.equal(reply.context.printer.model, 'P1S', text);
  }
  assert.deepEqual(violations, []);
});

test('review: the A1 is remembered, and a newly named printer replaces it, article or not', async () => {
  const db = limitD1(await shop());
  const first = await ask(db, null, { text: 'نوزل مال اي ون' });
  assert.equal(first.context.printer.model, 'A1');
  const p1s = await ask(db, null, { text: 'نوزل مال البي ون اس', context: first.context });
  assert.ok(ids(p1s).includes('h_x1') && !ids(p1s).includes('h_a1'), JSON.stringify(ids(p1s)));
  assert.match(p1s.text, /P1S/);
  assert.doesNotMatch(p1s.text, /A1/);
  assert.equal(p1s.context.printer.model, 'P1S');
  const x1c = await ask(db, null, { text: 'اريد بليت للاكس ون كاربون', context: first.context });
  assert.ok(!ids(x1c).includes('pl_pei'), 'the A1 plate is not an answer for the X1C');
  assert.match(x1c.text, /X1C/);
});

test('review: a printer named and not read is asked about, never answered for by the remembered one', async () => {
  const db = limitD1(await shop());
  const first = await ask(db, null, { text: 'نوزل مال اي ون' });
  const unread = await ask(db, null, { text: 'نوزل مال زد ون 0.4', context: first.context });
  assert.deepEqual(ids(unread), [], 'no A1 part under an unread printer');
  assert.equal(unread.context.printer, undefined);
  assert.equal(unread.context.part, 'nozzle_hotend');
  const p1sChip = (unread.choices as Rec[]).find((c) => c.params?.model === 'P1S');
  assert.ok(p1sChip, JSON.stringify(unread.choices));
  assert.deepEqual(p1sChip.params, { step: 'part', part: 'nozzle_hotend', model: 'P1S', size: '0.4' });
  const tapped = await ask(db, null, { intent: p1sChip.intent, params: p1sChip.params, context: unread.context });
  assert.ok(ids(tapped).includes('h_x1') && !ids(tapped).includes('h_a1'), JSON.stringify(ids(tapped)));
  const typed = await ask(db, null, { text: 'P1S', context: unread.context });
  assert.ok(ids(typed).includes('h_x1') && !ids(typed).includes('h_a1'), JSON.stringify(ids(typed)));
});

test('review: an HMS code «على البي ون اس» and «طابعتي الاي ون» at the printer question are read', async () => {
  const db = limitD1(await shop());
  const hms = await ask(db, null, { text: 'HMS_0700_2000_0002_0001 على البي ون اس' });
  assert.equal(hms.context.printer.model, 'P1S');
  assert.equal(hms.context.triage.stage, 'steps');
  const clog = await ask(db, null, { text: 'كلوب' });
  const mine = await ask(db, null, { text: 'طابعتي الاي ون', context: clog.context });
  assert.equal(mine.intent, 'printer_problem');
  assert.equal(mine.context.printer.model, 'A1');
  assert.equal(mine.context.triage.stage, 'steps');
});

test('review must-not: a pending triage question never swallows a new question', async () => {
  const db = limitD1(await shop());
  const start = await ask(db, null, { text: 'صارت عندي مشكله بالطابعه' });
  const price = await ask(db, null, { text: 'شكد سعر A1', context: start.context });
  assert.equal(price.intent, 'price_question');
  assert.equal(price.context?.triage, undefined, 'a legacy answer hands the context back without the triage');

  const clog = await ask(db, member, { text: 'كلوب' });
  const order = await ask(db, member, { text: 'وين طلبي', context: clog.context });
  assert.equal(order.intent, 'order_status');
  assert.equal(order.context.triage, undefined);
  const later = await ask(db, member, { text: 'شكد سعر P1S', context: order.context });
  assert.equal(later.intent, 'price_question');
  assert.equal(later.steps, undefined);

  const which = await ask(db, null, { text: 'A1', context: start.context });
  assert.equal(which.context.triage.stage, 'symptom');
  const filament = await ask(db, null, { text: 'اكو خيوط PLA؟', context: which.context });
  assert.equal(filament.intent, 'materials_help', 'filament, not stringing steps');
  const strings = await ask(db, null, { text: 'خيوط', context: which.context });
  assert.equal(strings.context.triage.symptom, 'stringing', '«خيوط» alone still answers «which symptom?»');
});

test('review: a follow-up is read against the last answer, never «لم أفهم»', async () => {
  const raw = await shop();
  const db = limitD1(raw);
  const p1s = await ask(db, null, { text: 'نوزل مال بي ون اس' });
  const size = await ask(db, null, { text: 'اكو 0.4؟', context: p1s.context });
  assert.notEqual(size.text, CLARIFY);
  assert.ok(ids(size).includes('h_x1'), JSON.stringify(size));
  assert.match(size.text, /0\.4/);

  const a1 = await ask(db, null, { text: 'نوزل مال اي ون' });
  const shown = ids(a1);
  assert.ok(shown.length >= 2, JSON.stringify(shown));
  const price = await ask(db, null, { text: 'شكد سعره؟', context: a1.context });
  assert.equal(price.intent, 'price_question');
  assert.deepEqual(ids(price), shown, 'the products just shown, in the same order');
  const card = (price.cards as Rec[]).find((c) => c.product_id === 'h_a1')!;
  assert.equal(card.price_iqd, await gridPrice(db, null, 'h_a1'), 'read again through the card builder: the grid’s figure');
  assert.deepEqual(ids(await ask(db, null, { text: 'الاول بكم', context: a1.context })), [shown[0]]);
  assert.equal((await ask(db, null, { text: 'متوفر؟', context: a1.context })).intent, 'stock_question');
  assert.deepEqual(ids(await ask(db, null, { text: 'بكم؟', context: a1.context })), shown);

  const fixed = await ask(db, null, { text: 'لا قصدي بي ون اس', context: a1.context });
  assert.ok(ids(fixed).includes('h_x1') && !ids(fixed).includes('h_a1'), JSON.stringify(ids(fixed)));
  assert.equal(fixed.context.part, 'nozzle_hotend');
  assert.equal(fixed.context.printer.model, 'P1S');

  // A legacy answer in between is the last answer: «بكم؟» then means what IT showed.
  const combo = await ask(db, null, { text: 'شكد سعر A1 combo', context: a1.context });
  assert.equal(combo.intent, 'price_question');
  assert.deepEqual(combo.context.shown, ids(combo));
  assert.deepEqual(ids(await ask(db, null, { text: 'بكم؟', context: combo.context })), ids(combo));

  // A product no longer listed is not shown again.
  raw.exec(`UPDATE products SET status = 'draft' WHERE id = '${shown[0]}'`);
  assert.ok(!ids(await ask(db, null, { text: 'بكم؟', context: a1.context })).includes(shown[0]));
  assert.deepEqual(violations, []);
});

test('review: typed symptoms, in either word order, cold and at «which symptom?»', async () => {
  const db = limitD1(await shop());
  const atSymptom = { v: 1, printer: { model: 'A1' }, triage: { stage: 'symptom' } };
  for (const text of ['النوزل معلك', 'الفلامنت ما يطلع من النوزل', 'النوزل مسكر', 'النوزل']) {
    const reply = await ask(db, null, { text, context: atSymptom });
    assert.equal(reply.intent, 'printer_problem', text);
    assert.deepEqual(reply.context.triage, { stage: 'steps', symptom: 'clog' }, text);
  }
  for (const [text, symptom, locale] of [
    ['النوزل مسكر', 'clog', 'ar'],
    ['عندي مشكلة بالنوزل', 'clog', 'ar'],
    ['النوزل خربان', 'clog', 'ar'],
    ['الطبعة ترتفع من الزوايا', 'adhesion', 'ar'],
    ['الطبقات دا تزحف', 'layer_shift', 'ar'],
    ['الطبعة بيها خيوط مثل شعر', 'stringing', 'ar'],
    ['الـAMS ما يسحب الفلامنت', 'ams', 'ar'],
    ['مشكلة بالAMS لايت', 'ams', 'ar'],
    ['AMS is not feeding', 'ams', 'en'],
  ] as const) {
    const reply = await ask(db, null, { text, locale });
    assert.equal(reply.intent, 'printer_problem', text);
    assert.deepEqual(reply.context.triage, { stage: 'printer', symptom }, text);
  }
  // A fault the curated steps do not cover asks which printer, then which symptom.
  for (const text of ['الطابعة ما تسخن', 'تسريب من النوزل']) {
    const reply = await ask(db, null, { text });
    assert.equal(reply.intent, 'printer_problem', text);
    assert.deepEqual(reply.context.triage, { stage: 'printer' }, text);
  }
  assert.notEqual((await ask(db, null, { text: 'المحل مسكر' })).intent, 'printer_problem', 'a closed shop is not a clog');
});

test('review: the outcome of the steps, typed, and a printer the shop does not list', async () => {
  const db = limitD1(await shop());
  const afterSteps = { v: 1, printer: { model: 'A1' }, triage: { stage: 'steps', symptom: 'clog' } };
  for (const [text, locale] of [
    ['جربتها وما انحلّت', 'ar'],
    ['ما انحلت', 'ar'],
    ['still not fixed', 'en'],
    ['هێشتا چارەسەر نەبوو', 'ckb'],
  ] as const) {
    const reply = await ask(db, member, { text, locale, context: afterSteps });
    assert.equal(reply.handoff, true, text);
    assert.match(reply.ticket_draft.subject, /A1/, text);
  }
  const fixed = await ask(db, member, { text: 'انحلت', context: afterSteps });
  assert.equal(fixed.context.triage.stage, 'done');
  assert.equal(fixed.handoff, undefined);

  const clog = await ask(db, null, { text: 'كلوب' });
  const creality = await ask(db, null, { text: 'عندي طابعة كريالتي اندر 3', context: clog.context });
  assert.equal(creality.intent, 'printer_problem');
  assert.equal(creality.context.printer.model, 'other');
  assert.equal(creality.context.triage.stage, 'steps');
});

/** Product names from a real printer-accessory shelf: the words a forgiving search half-matches. */
const SHELF = [
  ['Anti-Vibration Feet', 'أقدام مانعة للاهتزاز'],
  ['WiFi Antenna - H2 Series', 'هوائي واي فاي'],
  ['Printer Cable Pack (4-in-1)', 'حزمة كابلات الطابعة'],
  ['PLA Wood', 'فلمنت خشبي'],
  ['Magnets for Make My Sign', 'مغناطيس'],
  ['TPU 95A HF', 'فلامنت مرن'],
  ['ABS-GF', 'فلامنت ABS'],
  ['PETG Translucent', 'فلامنت شفاف'],
  ['Toolhead to MC Board Cable - H2D', 'كابل رأس الطباعة'],
  ['Riser Base', 'قاعدة رافعة'],
  ['Aluminum Card', 'بطاقة ألمنيوم'],
  ['M3 Aluminum Rod End Ball Joint', 'مفصل كروي'],
  ['Suction Caps with Mushroom Head', 'كؤوس شفط'],
  ['Winter Cottage LED Lamp', 'مصباح كوخ الشتاء'],
  ['Relic Rush Board Game', 'لعبة لوحية'],
  ['Cleaning Wipes (50 pcs)', 'مناديل تنظيف'],
  ['Dartboard Ring', 'حلقة لوحة السهام'],
  ['RC Toy Car', 'سيارة لعبة'],
  ['Cable Chain - X2D', 'سلسلة الكابلات'],
  ['Support for PLA/PETG', 'مادة الدعم'],
] as const;

test('review must-not: small talk on a real shelf gets the menu, a typed product name still its card', async () => {
  const raw = await shop();
  SHELF.forEach(([name, nameAr], i) =>
    raw
      .prepare(
        `INSERT INTO products (id,slug,name,name_ar,name_ku,price_iqd,status,stock,options,colors,selling_type,sale_types,
           preorder_transports,images,inventory_mode,ops_policy,category_id)
         VALUES (?,?,?,?,'',?,'active',5,'[]','[]','direct_sale','["direct_sale"]','[]','[]','BASE','{}','cat_maint_spare')`
      )
      .run(`s_${i}`, `shelf-${i}`, name, nameAr, 10_000 + i * 1000)
  );
  const run = await backfillSearchIndex(asD1(raw), { limit: 50 });
  assert.deepEqual(run.failed, []);
  const db = limitD1(raw);
  for (const [text, locale] of [
    ['كم الساعة هسه', 'ar'],
    ['الجو حار اليوم', 'ar'],
    ['منو انت', 'ar'],
    ['وين أقرب مطعم', 'ar'],
    ['اوكي', 'ar'],
    ['ما ادري', 'ar'],
    ['اريده', 'ar'],
    ['tell me a joke', 'en'],
    ['ئەمڕۆ هەوا چۆنە', 'ckb'],
  ] as const) {
    const reply = await ask(db, null, { text, locale });
    assert.deepEqual(ids(reply), [], `«${text}» → ${JSON.stringify(ids(reply))}`);
    assert.equal(reply.intent, 'clarify', text);
  }
  const typedName = await ask(db, null, { text: 'Riser Base' });
  assert.equal(typedName.cards[0].product_id, 's_9');
  const combo = await ask(db, null, { text: 'A1 combo' });
  assert.equal(combo.cards[0].product_id, 'p_a1c');
});

// ════════════════════════════════════════ review, round 1

/** The shop, plus the products the round-1 sentences are about: a hotend maker, the AMS 2 Pro and its decoy. */
async function shopPlus(): Promise<DatabaseSync> {
  const raw = await shop();
  const add = (id: string, slug: string, name: string, nameAr: string, category: string) =>
    raw
      .prepare(
        `INSERT INTO products (id,slug,name,name_ar,name_ku,price_iqd,status,stock,options,colors,selling_type,sale_types,
           preorder_transports,images,inventory_mode,ops_policy,category_id)
         VALUES (?,?,?,?,'',?,'active',5,'[]','[]','direct_sale','["direct_sale"]','[]','[]','BASE','{}',?)`
      )
      .run(id, slug, name, nameAr, 70_000, category);
  add('h_e3d', 'e3d-high-flow-hotend', 'E3D High Flow ObXidian Hotend', 'هوت إند E3D عالي التدفق', 'cat_maint_hotend');
  add('ams_2pro', 'ams-2-pro', 'AMS 2 Pro', 'نظام AMS 2 Pro', 'cat_maint_spare');
  add('ptfe', 'ptfe-tubes', 'PTFE Tubes', 'أنابيب PTFE للـ AMS', 'cat_maint_spare');
  const run = await backfillSearchIndex(asD1(raw), { limit: 50 });
  assert.deepEqual(run.failed, []);
  return raw;
}

test('round 1: an HMS code typed as the answer to «which printer?» or «which symptom?» is kept, to the ticket', async () => {
  const db = limitD1(await shop());
  const CODE = '0300-0100-0001-0003';
  const start = await ask(db, member, { text: 'صارت عندي مشكله بالطابعه' });
  // At «which printer?»: the printer and the code in one message.
  const both = await ask(db, member, { text: `P1S وطلعلي رمز ${CODE}`, context: start.context });
  assert.deepEqual(both.context.triage, { stage: 'steps', symptom: 'hms', code: CODE });
  assert.equal(both.context.printer.model, 'P1S');
  assert.ok(!(both.steps as Rec[]).some((s) => s.key === 'type_code'), 'the code is not asked for again');
  const talk = await ask(db, member, { intent: 'printer_problem', params: { step: 'talk' }, context: both.context });
  assert.match(String(talk.ticket_draft.body), new RegExp(`رمز الخطأ: ${CODE}`));
  assert.equal(talk.ticket_draft.handoff.code, CODE);
  // At «which symptom?»: «رمز خطأ …», the bare code, and the app's HMS_ form.
  const which = await ask(db, member, { text: 'P1S', context: start.context });
  assert.equal(which.context.triage.stage, 'symptom');
  for (const [text, code] of [
    [`رمز خطأ ${CODE}`, CODE],
    [CODE, CODE],
    ['HMS_0700_2000_0002_0001', '0700-2000-0002-0001'],
  ] as const) {
    const typed = await ask(db, member, { text, context: which.context });
    assert.deepEqual(typed.context.triage, { stage: 'steps', symptom: 'hms', code }, text);
    assert.match(typed.text, new RegExp(code), text);
    const draft = await ask(db, member, { intent: 'printer_problem', params: { step: 'talk' }, context: typed.context });
    assert.match(String(draft.ticket_draft.body), new RegExp(`رمز الخطأ: ${code}`), text);
  }
  // At «which printer?» with a printer the shop does not list: still the code.
  const other = await ask(db, member, { text: `عندي طابعة كريالتي وطلع رمز ${CODE}`, context: start.context });
  assert.equal(other.context.printer.model, 'other');
  assert.equal(other.context.triage.code, CODE);
});

test('round 1: E3D, «ثري دي» and Iraqi «تو» are not printer names; a series is its printers', async () => {
  const db = limitD1(await shopPlus());
  const e3d = await ask(db, null, { text: 'نوزل E3D' });
  assert.doesNotMatch(String(e3d.text), /لأي طابعة/, 'E3D is a hotend maker, not an unread printer');
  assert.equal(ids(e3d)[0], 'h_e3d', JSON.stringify(ids(e3d)));
  for (const text of ['نوزل لطابعة ثري دي', 'نوزل اشتريته تو']) {
    const reply = await ask(db, null, { text });
    assert.doesNotMatch(String(reply.text), /لأي طابعة/, text);
    assert.ok(ids(reply).length > 0, text);
  }
  // «X1» is the X1C or the X1E, «P1» the P1S or the P1P: the parts linked to either, not «which printer?».
  for (const [text, part] of [
    ['نوزل X1', 'h_x1'],
    ['نوزل P1', 'h_x1'],
    ['نوزل اكس ون', 'h_x1'],
  ] as const) {
    const reply = await ask(db, null, { text });
    assert.doesNotMatch(String(reply.text), /لأي طابعة/, text);
    assert.ok(ids(reply).includes(part) && !ids(reply).includes('h_a1'), `${text}: ${JSON.stringify(ids(reply))}`);
  }
  // The A2 series is the A2L alone: «A2» is the A2L, and the A1/A2 hotend names it.
  const a2 = await ask(db, null, { text: 'نوزل A2' });
  assert.equal(a2.context.printer.model, 'A2L');
  assert.ok(ids(a2).includes('h_a1') && !ids(a2).includes('h_x1'), JSON.stringify(ids(a2)));
  // A series named in a fault, where the shop lists ONE printer of it, is that printer
  // (round 2): never a question with a single chip in it.
  const x1 = await ask(db, null, { text: 'طابعة X1 بيها مشكلة' });
  assert.equal(x1.intent, 'printer_problem');
  assert.equal(x1.context.printer.model, 'X1C');
  assert.equal(x1.context.triage.stage, 'symptom');
  const atPrinter = await ask(db, null, { text: 'P1', context: (await ask(db, null, { text: 'كلوب' })).context });
  assert.equal(atPrinter.context.printer.model, 'P1S');
  assert.deepEqual(atPrinter.context.triage, { stage: 'steps', symptom: 'clog' }, 'the clog is still held');
});

test('round 1: «which printer is the nozzle for?» keeps «another printer», in three languages, and the size', async () => {
  const db = limitD1(await shop());
  for (const [locale, label, text] of [
    ['ar', 'طابعة أخرى', 'نوزل مال زد ون 0.4'],
    ['en', 'Another printer', 'nozzle for the Z1 0.4'],
    ['ckb', 'پرینتەرێکی تر', 'نۆزڵ بۆ زێد وەن 0.4'],
  ] as const) {
    const asked = await ask(db, null, { text, locale });
    assert.equal(asked.context.size, '0.4', `${locale}: the size waits with the question`);
    const other = (asked.choices as Rec[]).at(-1)!;
    assert.equal(other.label, label, locale);
    assert.deepEqual(other.params, { step: 'part', part: 'nozzle_hotend', model: 'other', size: '0.4' }, locale);
    const tapped = await ask(db, null, { intent: other.intent, params: other.params, context: asked.context, locale });
    assert.ok(ids(tapped).includes('h_a1') && ids(tapped).includes('h_x1'), `${locale}: ${JSON.stringify(ids(tapped))}`);
    assert.match(tapped.text, /0\.4/, locale);
    assert.equal(tapped.context.printer.model, 'other');
  }
  const asked = await ask(db, null, { text: 'نوزل مال زد ون 0.4' });
  // Typed, the answer keeps the size the chip carries.
  const typed = await ask(db, null, { text: 'A1', context: asked.context });
  assert.ok(ids(typed).includes('h_a1') && !ids(typed).includes('h_x1'), JSON.stringify(ids(typed)));
  assert.match(typed.text, /0\.4/, 'the 0.4 asked with the question is still the size');
  assert.equal(typed.context.size, undefined, 'answered, the size is no longer waiting');
  const typedOther = await ask(db, null, { text: 'طابعة أخرى', context: asked.context });
  assert.equal(typedOther.context.printer.model, 'other');
  assert.match(typedOther.text, /0\.4/);
  // A size typed with the answer is that size.
  const sized = await ask(db, null, { text: 'A1 0.6', context: asked.context });
  assert.match(sized.text, /0\.6/);
});

test('round 1: «شكد سعر الطابعة» after the part cards is the printer, never the parts again', async () => {
  const db = limitD1(await shop());
  for (const [locale, first, question] of [
    ['ar', 'نوزل مال اي ون', 'شكد سعر الطابعة'],
    ['ar', 'نوزل مال اي ون', 'بكم الطابعة نفسها'],
    ['en', 'nozzle for A1', 'how much is the printer?'],
    ['ckb', 'نۆزڵ بۆ ئەی وەن', 'نرخی پرینتەرەکە چەندە؟'],
  ] as const) {
    const parts = await ask(db, null, { text: first, locale });
    assert.ok(ids(parts).includes('h_a1'), `${locale}: ${JSON.stringify(ids(parts))}`);
    const printer = await ask(db, null, { text: question, locale, context: parts.context });
    assert.equal(printer.intent, 'price_question', question);
    assert.deepEqual(ids(printer), ['p_a1', 'p_a1c'], `${question}: ${JSON.stringify(ids(printer))}`);
    const card = (printer.cards as Rec[]).find((c) => c.product_id === 'p_a1')!;
    assert.equal(card.price_iqd, await gridPrice(db, null, 'p_a1'), 'the grid’s figure');
    assert.deepEqual(printer.context.shown, ['p_a1', 'p_a1c']);
  }
  // Without the printer word the follow-up is still about the parts just shown.
  const parts = await ask(db, null, { text: 'نوزل مال اي ون' });
  assert.deepEqual(ids(await ask(db, null, { text: 'شكد سعره؟', context: parts.context })), ids(parts));
});

test('round 1: price and stock words are not product words: «بكم PLA؟», «نرخی PLA چەندە؟», «سعر AMS 2 Pro»', async () => {
  const db = limitD1(await shopPlus());
  for (const [text, locale, id] of [
    ['بكم PLA؟', 'ar', 'f_pla'],
    ['نرخی PLA چەندە؟', 'ckb', 'f_pla'],
    ['AMS 2 Pro بكم', 'ar', 'ams_2pro'],
    ['سعر AMS 2 Pro', 'ar', 'ams_2pro'],
    ['how much is AMS 2 Pro', 'en', 'ams_2pro'],
  ] as const) {
    const reply = await ask(db, null, { text, locale });
    assert.equal(ids(reply)[0], id, `«${text}» → ${reply.intent} ${JSON.stringify(ids(reply))}`);
    assert.equal(reply.intent, 'price_question', text);
  }
  // A question word alone names nothing.
  assert.equal((await ask(db, null, { text: 'بكم' })).cards, undefined);
});

test('round 1: Sorani spoken printer names, each a printer of the registry', async () => {
  const db = limitD1(await shop());
  const a1 = await ask(db, null, { text: 'نۆزڵ بۆ ئەی وەن 0.2', locale: 'ckb' });
  assert.equal(a1.context.printer.model, 'A1');
  assert.ok(ids(a1).includes('h_a1') && !ids(a1).includes('h_x1'), JSON.stringify(ids(a1)));
  assert.match(a1.text, /0\.2/);
  const p1s = await ask(db, null, { text: 'نۆزڵ بۆ پی وەن ئێس', locale: 'ckb' });
  assert.equal(p1s.context.printer.model, 'P1S');
  assert.ok(ids(p1s).includes('h_x1') && !ids(p1s).includes('h_a1'), JSON.stringify(ids(p1s)));
  const fault = await ask(db, null, { text: 'کێشە لە ئەی وەن هەیە', locale: 'ckb' });
  assert.equal(fault.intent, 'printer_problem');
  assert.equal(fault.context.printer.model, 'A1');
  assert.equal(fault.context.triage.stage, 'symptom');
  assert.deepEqual(violations, []);
});

// ════════════════════════════════════════ review, round 2

/**
 * The round-1 shop, plus what the round-2 sentences are about: a refurbished A1
 * listed with the printers (its name sorts before «Bambu …»), the A1's
 * accessories that a «hotend nozzle» search ranks with the hotend itself, a
 * plate bundle named «Combo», and the decoys of the price and stock words.
 */
async function shopRound2(): Promise<DatabaseSync> {
  const raw = await shopPlus();
  const add = (id: string, slug: string, name: string, nameAr: string, category: string, price = 70_000) =>
    raw
      .prepare(
        `INSERT INTO products (id,slug,name,name_ar,name_ku,price_iqd,status,stock,options,colors,selling_type,sale_types,
           preorder_transports,images,inventory_mode,ops_policy,category_id)
         VALUES (?,?,?,?,'',?,'active',5,'[]','[]','direct_sale','["direct_sale"]','[]','[]','BASE','{}',?)`
      )
      .run(id, slug, name, nameAr, price, category);
  const fit = (part: string, printer: string, position = 0) =>
    raw.prepare('INSERT INTO product_printer_fits (product_id, printer_id, position) VALUES (?, ?, ?)').run(part, printer, position);
  add('p_a1r', 'refurbished-bambu-lab-a1', '[Refurbished] Bambu Lab A1 3D Printer', 'طابعة بامبو لاب A1 مجددة', 'cat_printers_fdm', 800_000);
  raw.prepare('INSERT OR IGNORE INTO product_catalogs (product_id, catalog_id, position) VALUES (?, ?, ?)').run('p_a1r', 'cat_printers_fdm', 99);
  add('glue', 'glue-stick', 'Glue Stick', 'صمغ لاصق', 'cat_maint_spare');
  // A name that carries «رد»: what «ماكو رد؟» ("no reply?") reached once «ماكو» was out.
  add('reply_card', 'reply-card', 'Reply Card', 'بطاقة رد', 'cat_maint_spare');
  add('petg', 'petg-hf', 'PETG HF', 'فلامنت PETG HF', 'cat_materials');
  add('bush', 'oil-impregnated-bronze-bushings', 'Oil Impregnated Bronze Bushings', 'جلب برونز', 'cat_maint_spare');
  add('plate_combo', 'build-plate-combo', 'Build Plate Combo', 'كومبو ألواح الطباعة', 'cat_maint_plate');
  fit('plate_combo', 'p_a1', 2);
  for (const [id, name] of [
    ['a_sponge', 'Nozzle Cleaning Sponge'],
    ['a_wipes', 'Nozzle Cleaning Wipes'],
    ['a_sock', 'Silicone Sock for Hotend - A1'],
    ['a_fan', 'Hotend Cooling Fan - A1 Series'],
    ['a_wiper', 'Heatbed Nozzle Wiper - A1/A2L'],
    ['a_heat', 'Hotend Heating Assembly - A1 Series'],
    ['a_therm', 'Hotend Thermistor - A1 Series'],
    ['a_needle', 'Nozzle Cleaning Needle Kit - A1'],
  ] as const) {
    add(id, id.replace('_', '-'), name, name, 'cat_maint_spare', 15_000);
    fit(id, 'p_a1', 3);
  }
  const run = await backfillSearchIndex(asD1(raw), { limit: 50 });
  assert.deepEqual(run.failed, []);
  return raw;
}

const HOTENDS = new Set(['h_a1', 'h_x1', 'h_e3d']);

test('round 2: «اي تو» is "yes, just now": no A2L in the triage, the parts or the context', async () => {
  const db = limitD1(await shopRound2());
  const fault = await ask(db, null, { text: 'اي تو وصلتني الطابعة وبيها مشكلة' });
  assert.equal(fault.intent, 'printer_problem');
  assert.equal(fault.context.printer, undefined, JSON.stringify(fault.context));
  assert.equal(fault.context.triage.stage, 'printer', 'which printer? is asked');
  assert.doesNotMatch(String(fault.text), /A2L/);
  const parts = await ask(db, null, { text: 'اي تو اشتريت نوزل' });
  assert.doesNotMatch(String(parts.text), /A2L/);
  assert.equal(parts.context.printer, undefined);
});

test('round 2: «اكو غيرها؟» after an ordinary part search is not «another printer»; the fault after it still asks which printer', async () => {
  const db = limitD1(await shopRound2());
  for (const [locale, part, more, fault] of [
    ['ar', 'نوزل', 'اكو غيرها؟', 'النوزل مسدود'],
    ['en', 'nozzle', 'any other?', 'my nozzle is clogged'],
  ] as const) {
    const first = await ask(db, null, { text: part, locale });
    const second = await ask(db, null, { text: more, locale, context: first.context });
    assert.equal(second.context?.printer, undefined, `${locale}: ${JSON.stringify(second.context)}`);
    assert.doesNotMatch(String(second.text), /تأكد في صفحة كل منتج|check each product page/i, locale);
    const third = await ask(db, null, { text: fault, locale, context: second.context ?? first.context });
    assert.equal(third.intent, 'printer_problem', locale);
    assert.equal(third.context.triage.stage, 'printer', `${locale}: which printer? is asked, not steps for «another printer»`);
  }
  // While «لأي طابعة تريد النوزل؟» waits, the same words ARE its answer.
  const asked = await ask(db, null, { text: 'نوزل مال زد ون' });
  assert.equal(asked.context.asking, 'part_printer');
  const other = await ask(db, null, { text: 'غيرها', context: asked.context });
  assert.equal(other.context.printer.model, 'other');
  assert.equal(other.context.asking, undefined, 'answered, the question is no longer pending');
});

test('round 2: the strong lookup is a price or stock question only when a price or stock word was in it; «ماكو رد؟» is small talk', async () => {
  const db = limitD1(await shopRound2());
  for (const locale of ['ar', 'en'] as const) {
    const glue = await ask(db, null, { text: 'glue stick', locale });
    assert.equal(ids(glue)[0], 'glue', locale);
    assert.equal(glue.intent, 'product_search', `${locale}: «stick» is not «stock»`);
  }
  assert.equal((await ask(db, null, { text: 'glue stick متوفر؟' })).intent, 'stock_question');
  for (const text of ['ماكو رد', 'ماكو رد؟']) {
    const reply = await ask(db, null, { text });
    assert.equal(reply.intent, 'clarify', text);
    assert.equal(reply.cards, undefined, text);
  }
});

test('round 2: the part itself first, the leftover story words never searched, and «كومبو» is the printer name', async () => {
  const db = limitD1(await shopRound2());
  const a1 = await ask(db, null, { text: 'نوزل مال اي ون' });
  assert.equal(ids(a1)[0], 'h_a1', `the A1 hotend before its sponge and its fan: ${JSON.stringify(ids(a1))}`);
  const combo = await ask(db, null, { text: 'نوزل مال اي ون كومبو' });
  assert.equal(ids(combo)[0], 'h_a1', JSON.stringify(ids(combo)));
  assert.ok(!ids(combo).includes('plate_combo'), 'a plate bundle is not a nozzle answer');
  const story = await ask(db, null, { text: 'نوزل اشتريته تو' });
  assert.ok(HOTENDS.has(ids(story)[0]), `a hotend first: ${JSON.stringify(ids(story))}`);
  // The clog steps («استبدل الهوت إند، القطع المناسبة أدناه») show the hotend.
  const clog = await ask(db, null, { text: 'A1', context: (await ask(db, null, { text: 'كلوب' })).context });
  assert.equal(clog.context.triage.stage, 'steps');
  assert.equal(ids(clog)[0], 'h_a1', JSON.stringify(ids(clog)));
  // No catalogue link to the P1P: the P1 Series hotend names it, beyond the first page of a general search.
  const p1p = await ask(db, null, { text: 'نوزل P1P' });
  assert.ok(ids(p1p).includes('h_x1'), `${p1p.text} ${JSON.stringify(ids(p1p))}`);
  assert.match(String(p1p.text), /تذكر P1P/);
});

test('round 2: the printer itself, new before refurbished, and after an ordinary product search too', async () => {
  const db = limitD1(await shopRound2());
  const parts = await ask(db, null, { text: 'نوزل مال اي ون' });
  const printer = await ask(db, null, { text: 'شكد سعر الطابعة', context: parts.context });
  assert.deepEqual(ids(printer), ['p_a1', 'p_a1c', 'p_a1r'], 'the refurbished A1 after the new ones');
  // An ordinary (legacy) product search: «A1 combo», «P1S», «طابعة A1».
  const combo = await ask(db, null, { text: 'A1 combo' });
  assert.equal(combo.context.printer.model, 'A1', JSON.stringify(combo.context));
  const price = await ask(db, null, { text: 'شكد سعر الطابعة؟', context: combo.context });
  assert.deepEqual(ids(price), ['p_a1', 'p_a1c', 'p_a1r'], JSON.stringify(ids(price)));
  const p1s = await ask(db, null, { text: 'P1S' });
  const stock = await ask(db, null, { text: 'الطابعة متوفرة؟', context: p1s.context });
  assert.deepEqual(ids(stock), ['p_p1s'], JSON.stringify(ids(stock)));
  const named = await ask(db, null, { text: 'طابعة A1' });
  const again = await ask(db, null, { text: 'شكد سعرها؟', context: named.context });
  assert.deepEqual(ids(again), ids(named), 'the products just shown, read again');
  assert.equal(again.intent, 'price_question');
});

test('round 2: «p1-s», «x1-c», «E3D» after the A1, Sorani «پلێت» and «ئەی وەنەکەم», two series at once', async () => {
  const db = limitD1(await shopRound2());
  const hyphen = await ask(db, null, { text: 'nozzle for p1-s', locale: 'en' });
  assert.equal(hyphen.context.printer.model, 'P1S');
  assert.ok(ids(hyphen).includes('h_x1') && !ids(hyphen).includes('h_a1'), JSON.stringify(ids(hyphen)));
  assert.equal((await ask(db, null, { text: 'nozzle for x1-c', locale: 'en' })).context.printer.model, 'X1C');
  // «اكو نوزل E3D؟» right after the A1 parts: the E3D hotend, and the A1 is still remembered.
  const a1 = await ask(db, null, { text: 'نوزل مال اي ون' });
  const e3d = await ask(db, null, { text: 'اكو نوزل E3D؟', context: a1.context });
  assert.equal(ids(e3d)[0], 'h_e3d', JSON.stringify(ids(e3d)));
  assert.equal(e3d.context.printer.model, 'A1');
  const plate = await ask(db, null, { text: 'واكو بليت؟', context: e3d.context });
  assert.ok(ids(plate).includes('pl_pei'), 'the next part question is the A1 again');
  // Sorani.
  const ckbPlate = await ask(db, null, { text: 'پلێت بۆ ئێکس وەن کاربۆن', locale: 'ckb' });
  assert.equal(ckbPlate.context.part, 'plate');
  assert.equal(ckbPlate.context.printer.model, 'X1C');
  const mine = await ask(db, null, { text: 'ئەی وەنەکەم کێشەی هەیە', locale: 'ckb' });
  assert.equal(mine.intent, 'printer_problem');
  assert.equal(mine.context.printer.model, 'A1');
  const myNozzle = await ask(db, null, { text: 'نۆزڵ بۆ ئەی وەنەکەم', locale: 'ckb' });
  assert.equal(ids(myNozzle)[0], 'h_a1');
  // Two series named: their parts, never «which printer is the nozzle for?».
  for (const [text, locale] of [['نوزل X1 او P1', 'ar'], ['hotend for X1 and P1', 'en']] as const) {
    const both = await ask(db, null, { text, locale });
    assert.ok(ids(both).includes('h_x1'), `${text}: ${both.text} ${JSON.stringify(ids(both))}`);
    assert.ok(!((both.choices ?? []) as Rec[]).some((c) => c.params?.step === 'part'), `${text}: no printer chips`);
  }
});

test('round 2: «نبتون فور» is a printer the shop does not list, never the remembered A1', async () => {
  const db = limitD1(await shopRound2());
  const a1 = await ask(db, null, { text: 'نوزل مال اي ون' });
  for (const text of ['نوزل مال نبتون فور', 'وعندي هم كوبرا تو، اريد نوزل الها']) {
    const other = await ask(db, null, { text, context: a1.context });
    assert.doesNotMatch(String(other.text), /A1/, text);
    assert.ok(!ids(other).includes('pl_pei'), text);
  }
  const start = await ask(db, null, { text: 'صارت عندي مشكله بالطابعه' });
  const answer = await ask(db, null, { text: 'نبتون فور', context: start.context });
  assert.equal(answer.intent, 'printer_problem');
  assert.equal(answer.context.printer.model, 'other');
});

test('round 2: «اشتريت …» opens a fault story, not a shopping list', async () => {
  const db = limitD1(await shopRound2());
  const clog = await ask(db, null, { text: 'اشتريت طابعة تو وصار بيها انسداد بالنوزل' });
  assert.equal(clog.intent, 'printer_problem');
  assert.deepEqual(clog.context.triage, { stage: 'printer', symptom: 'clog' });
  const problem = await ask(db, null, { text: 'اشتريت طابعة من عندكم وصارت بيها مشكلة' });
  assert.equal(problem.intent, 'printer_problem');
  assert.equal(problem.context.triage.stage, 'printer');
  const mine = await ask(db, member, { text: 'اشتريت A1 من عدكم والنوزل مسدود' });
  assert.equal(mine.intent, 'printer_problem');
  assert.deepEqual(mine.context.triage, { stage: 'steps', symptom: 'clog' });
  assert.ok((mine.steps as Rec[]).length > 0);
});

test('round 2: an HMS code in Arabic-Indic digits, Sorani «کلۆگ», and «PETG بيش», «PLA شكد»', async () => {
  const db = limitD1(await shopRound2());
  const start = await ask(db, null, { text: 'صارت عندي مشكله بالطابعه' });
  const which = await ask(db, null, { text: 'P1S', context: start.context });
  const typed = await ask(db, null, { text: 'رمز خطأ ٠٣٠٠-٠١٠٠-٠٠٠١-٠٠٠٣', context: which.context });
  assert.deepEqual(typed.context.triage, { stage: 'steps', symptom: 'hms', code: '0300-0100-0001-0003' });
  assert.ok(!(typed.steps as Rec[]).some((st) => st.key === 'type_code'), 'the code is not asked for again');
  for (const text of ['کلۆگ', 'نۆزڵەکەم کلۆگ بووە']) {
    const reply = await ask(db, null, { text, locale: 'ckb' });
    assert.equal(reply.intent, 'printer_problem', text);
    assert.equal(reply.context.triage.symptom, 'clog', text);
  }
  const petg = await ask(db, null, { text: 'PETG بيش' });
  assert.ok(ids(petg).includes('petg') && !ids(petg).includes('bush'), JSON.stringify(ids(petg)));
  const pla = await ask(db, null, { text: 'PLA شكد' });
  assert.ok(ids(pla).includes('f_pla'), `${pla.text} ${JSON.stringify(ids(pla))}`);
  assert.deepEqual(violations, []);
});
