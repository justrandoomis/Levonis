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
import { ASSIST_T as ASSIST_STRINGS } from '../worker/lib/assist/strings';
import { symptomDef } from '../worker/lib/assist/triage/symptoms';
import { handoffForStaff } from '../worker/lib/assist/handoff';
import { PART_LABELS, PART_SYMPTOM } from '../worker/lib/assist/understand/lexicon';

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

/**
 * The live catalogue's Multi-Size Hotends Kit, linked to the A1: its sizes
 * are sets that each carry a 0.2 nozzle. The owner's case 1 asks for «the
 * A1/A2 0.2 hotend»; decided by the lead (review round 4): the exact 0.2
 * hotend first, and the kit after it, because the kit carries a 0.2 nozzle.
 */
async function withKit(raw: DatabaseSync): Promise<DatabaseSync> {
  raw
    .prepare(
      `INSERT INTO products (id,slug,name,name_ar,name_ku,price_iqd,status,stock,options,colors,selling_type,sale_types,
         preorder_transports,images,inventory_mode,ops_policy,category_id)
       VALUES ('h_kit','multi-size-hotends-kit','Multi-Size Hotends Kit','Multi-Size Hotends Kit','',90000,'active',5,?,'[]',
               'direct_sale','["direct_sale"]','[]','[]','BASE','{}','cat_maint_hotend')`
    )
    .run(sizes(['A1 Series', 'X1/P1 Series', '0.2mm + 0.4mm + 0.6mm + 0.8mm', '0.2mm + 0.6mm']));
  raw.prepare('INSERT INTO product_printer_fits (product_id, printer_id, position) VALUES (?, ?, ?)').run('h_kit', 'p_a1', 1);
  const run = await backfillSearchIndex(asD1(raw), { limit: 50 });
  assert.deepEqual(run.failed, []);
  return raw;
}

test('1. «نوزل مال اي ون اريده 0.2»: the A1 0.2 hotend first, then the Multi-Size Hotends Kit (it carries a 0.2 nozzle), at the grid price, never the X1 one', async () => {
  const raw = await withKit(await shop());
  const db = limitD1(raw);
  for (const user of [null, member]) {
    const reply = await ask(db, user, { text: 'نوزل مال اي ون اريده 0.2' });
    assert.equal(reply.intent, 'product_search');
    assert.notEqual(reply.text, CLARIFY);
    // Exactly these two, in this order: the hotend that is the 0.2 nozzle, then the kit that carries one.
    assert.deepEqual(ids(reply), ['h_a1', 'h_kit'], `the A1/A2 hotend, then the kit: ${JSON.stringify(ids(reply))}`);
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

test('1. the same question in English, Sorani and Arabic digits: the 0.2 hotend first, the kit after it', async () => {
  const db = limitD1(await withKit(await shop()));
  for (const [text, locale] of [
    ['nozzle for A1 0.2mm', 'en'],
    ['I want a 0.2 nozzle for the A1', 'en'],
    ['نۆزڵ بۆ A1 0.2', 'ckb'],
    ['نۆزڵ بۆ ئەی وەن 0.2', 'ckb'],
    ['نوزل ٠.٢ مال ايه ون', 'ar'],
  ] as const) {
    const reply = await ask(db, null, { text, locale });
    assert.equal(reply.intent, 'product_search', text);
    assert.deepEqual(ids(reply), ['h_a1', 'h_kit'], `${text}: ${JSON.stringify(ids(reply))}`);
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
  // Every shown step is listed as tried; the ticket drops what only the chat has («(القطع المناسبة أدناه)»).
  for (const step of steps.steps as Rec[]) {
    const tried = String(step.text).replace(/\s*\([^)]*\)(?=\.?$)/, '');
    assert.ok(handoff.ticket_draft.body.includes(tried), `every shown step is listed as tried: ${tried}`);
  }
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
  // Review round 4.2: «النوزل» alone takes the clog steps, and the triage keeps that the customer named the nozzle, not a clog.
  for (const [text, faultIn] of [
    ['النوزل معلك', undefined],
    ['الفلامنت ما يطلع من النوزل', undefined],
    ['النوزل مسكر', undefined],
    ['النوزل', 'nozzle_hotend'],
  ] as const) {
    const reply = await ask(db, null, { text, context: atSymptom });
    assert.equal(reply.intent, 'printer_problem', text);
    assert.deepEqual(reply.context.triage, { stage: 'steps', symptom: 'clog', ...(faultIn ? { faultIn } : {}) }, text);
  }
  for (const [text, symptom, locale, faultIn] of [
    ['عندي مشكلة بالنوزل', 'clog', 'ar', 'nozzle_hotend'],
    ['النوزل خربان', 'clog', 'ar', 'nozzle_hotend'],
  ] as const) {
    const reply = await ask(db, null, { text, locale });
    assert.equal(reply.intent, 'printer_problem', text);
    assert.deepEqual(reply.context.triage, { stage: 'printer', symptom, faultIn }, text);
  }
  for (const [text, symptom, locale] of [
    ['النوزل مسكر', 'clog', 'ar'],
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

// ════════════════════════════════════════ review, round 3

/**
 * The round-2 shop, plus what the live catalogue holds that the round-3
 * findings were about: more than eight accessories named after the hotend
 * (a search for «hotend» ranks them above every hotend), the words a
 * customer adds that some unrelated product carries («جديد», «ستيل»,
 * «اصلي»), parts that only NAME the P1S, a 3D-effect plate, and the
 * filaments a material qualifier picks between.
 */
async function shopRound3(): Promise<DatabaseSync> {
  const raw = await shopRound2();
  const add = (id: string, name: string, nameAr: string, category: string) =>
    raw
      .prepare(
        `INSERT INTO products (id,slug,name,name_ar,name_ku,price_iqd,status,stock,options,colors,selling_type,sale_types,
           preorder_transports,images,inventory_mode,ops_policy,category_id)
         VALUES (?,?,?,?,'',?,'active',5,'[]','[]','direct_sale','["direct_sale"]','[]','[]','BASE','{}',?)`
      )
      .run(id, id.replace(/_/g, '-'), name, nameAr, 25_000, category);
  for (const [id, name] of [
    ['d_fan_a2l', 'Cooling Fan for Hotend - A2L'],
    ['d_dock', 'Induction Hotend Dock Assembly'],
    ['d_wipe_x2d', 'Nozzle Wiping Plate - X2D'],
    ['d_heat_h2', 'Hotend Heating Assembly - H2D and H2C'],
    ['d_rack', 'Induction Hotend Rack Frame'],
    ['d_latch', 'Induction Hotend Latch Actuator'],
    ['d_board', 'Induction Hotend Rack Control Board'],
    ['d_rack_asm', 'Induction Hotend Rack Assembly'],
    ['d_motor', 'Induction Hotend Rack Motor'],
    ['d_blocker', 'Nozzle Blocker Magnet Bracket - H2D'],
    ['d_fan_h2', 'Cooling Fan for Hotend - H2 Series'],
  ] as const) {
    add(id, name, name, 'cat_maint_spare');
  }
  add('x2d_open', 'X2D Open Box, Like New', 'طابعة X2D بحالة جديد', 'cat_maint_spare');
  add('snap_steel', 'Snapmaker U1 Hot End Nozzle - Hardened Steel', 'هوت إند Snapmaker U1 ستيل مقسى', 'cat_maint_hotend');
  add('maglev', 'Magnetic Levitation DIY Kit', 'عدة رفع مغناطيسي اصلي', 'cat_maint_spare');
  add('p1s_heatsink', 'P1S Heatsink for MC Board', 'مشتت حرارة P1S', 'cat_maint_spare');
  add('p1_panel', 'Right Plastic Panel - P1 Series', 'لوح بلاستيك P1', 'cat_maint_spare');
  add('plate_3d', 'Bambu 3D Effect Plate', 'بليت ثري دي', 'cat_maint_plate');
  add('silk_plus', 'PLA Silk+ Filament', 'فلامنت PLA Silk+', 'cat_materials');
  add('silk_multi', 'PLA Silk Multi-Color Filament', 'فلامنت PLA Silk متعدد', 'cat_materials');
  add('pla_metal', 'PLA Metal', 'فلامنت PLA ميتال', 'cat_materials');
  add('pla_support', 'Support for PLA/PETG', 'دعامات PLA/PETG', 'cat_materials');
  add('tpu_95a', 'TPU 95A HF', 'فلامنت TPU 95A HF', 'cat_materials');
  add('tpu_85a', 'TPU 85A / TPU 90A', 'فلامنت TPU 85A', 'cat_materials');
  add('tpu_kit', 'H2D TPU High-Flow Kit', 'عدة TPU للـ H2D', 'cat_maint_spare');
  const run = await backfillSearchIndex(asD1(raw), { limit: 50 });
  assert.deepEqual(run.failed, []);
  return raw;
}

/** The round-3 asks run on one shop each: the rate limit is reset between them, as a fresh minute would. */
async function round3(): Promise<{ db: D1Database; say: (user: StubUser | null, body: Rec) => Promise<Rec> }> {
  const raw = await shopRound3();
  const db = limitD1(raw);
  return {
    db,
    say: (user, body) => {
      raw.exec('DELETE FROM rate_limits');
      return ask(db, user, body);
    },
  };
}

/** The parts linked to the A1 in the shop. */
const A1_LINKED = new Set(['h_a1', 'n_needle', 'pl_pei', 'plate_combo', 'a_sponge', 'a_wipes', 'a_sock', 'a_fan', 'a_wiper', 'a_heat', 'a_therm', 'a_needle']);
const IS_HOTEND = new Set(['h_a1', 'h_x1', 'h_e3d', 'snap_steel']);

test('round 3: the stringing steps show no part that only names the printer (no dryer is linked)', async () => {
  const { say } = await round3();
  const start = await say(null, { text: 'صارت عندي مشكله بالطابعه' });
  const p1s = await say(null, { intent: 'printer_problem', params: { step: 'printer', model: 'P1S' }, context: start.context });
  const steps = await say(null, { intent: 'printer_problem', params: { step: 'symptom', symptom: 'stringing' }, context: p1s.context });
  assert.equal(steps.context.triage.stage, 'steps');
  assert.deepEqual(ids(steps), [], `a P1S heatsink or panel is not a stringing fix: ${JSON.stringify(ids(steps))}`);
  assert.equal(steps.context.shown, undefined, 'nothing is «products shown» to the team');
  const mini = await say(null, { text: 'A1 mini', context: start.context });
  const typed = await say(null, { text: 'خيوط', context: mini.context });
  assert.equal(typed.context.triage.symptom, 'stringing');
  assert.deepEqual(ids(typed), [], JSON.stringify(ids(typed)));
  // A part question still finds the hotend that names the printer when nothing is linked, and puts it first.
  const p1p = await say(null, { text: 'نوزل P1P' });
  assert.equal(ids(p1p)[0], 'h_x1', JSON.stringify(ids(p1p)));
});

test('round 3: a describing word after the A1 parts keeps the A1; only a product line outranks it', async () => {
  const { say } = await round3();
  const a1 = await say(null, { text: 'نوزل مال اي ون' });
  for (const [text, locale] of [
    ['اريد نوزل جديد', 'ar'],
    ['نوزل ستيل', 'ar'],
    ['اكو نوزل اصلي؟', 'ar'],
    ['واكو بليت ناعم؟', 'ar'],
    ['any high flow nozzle?', 'en'],
  ] as const) {
    const reply = await say(null, { text, locale, context: a1.context });
    assert.ok(ids(reply).length > 0, text);
    assert.deepEqual(ids(reply).filter((id) => !A1_LINKED.has(id)), [], `«${text}» showed parts not linked to the A1: ${JSON.stringify(ids(reply))}`);
    assert.match(String(reply.text), /A1/, text);
    assert.equal(reply.context.printer.model, 'A1', text);
  }
  // «جديد» and «اصلي» name nothing: the part itself comes first, as for «نوزل مال اي ون».
  assert.equal(ids(await say(null, { text: 'اريد نوزل جديد', context: a1.context }))[0], 'h_a1');
  // A line: its own hotend, said to be not linked to the A1, and the A1 is still remembered.
  for (const [text, locale, said] of [
    ['اكو نوزل E3D؟', 'ar', /غير مربوطة|لم أجد منتجات E3D مربوطة بطابعة A1/],
    ['any E3D nozzle?', 'en', /no E3D products linked to the A1/],
  ] as const) {
    const e3d = await say(null, { text, locale, context: a1.context });
    assert.deepEqual(ids(e3d), ['h_e3d'], `${text}: ${JSON.stringify(ids(e3d))}`);
    assert.match(String(e3d.text), said, text);
    assert.equal(e3d.context.printer.model, 'A1');
  }
});

test('round 3: a printer shown by a shopping answer is not the printer the customer has', async () => {
  const { say } = await round3();
  // «refurbished» names no printer; it shows the refurbished A1 alone among the printers.
  const shopping = await say(null, { text: 'refurbished', locale: 'en' });
  assert.ok(ids(shopping).includes('p_a1r'), JSON.stringify(ids(shopping)));
  assert.equal(shopping.context?.printer, undefined, `a sentence that named no printer sets none: ${JSON.stringify(shopping.context)}`);
  const fault = await say(null, { text: 'صارت عندي مشكله بالطابعه', context: shopping.context });
  assert.equal(fault.context.triage.stage, 'printer', 'which printer? is asked');
  // Asked about by name, the one printer those cards showed is still answered, and still not remembered.
  const price = await say(null, { text: 'how much is the printer?', locale: 'en', context: shopping.context });
  assert.deepEqual(ids(price), ['p_a1', 'p_a1c', 'p_a1r'], `${price.intent}: ${JSON.stringify(ids(price))}`);
  assert.equal(price.context.printer, undefined);
  // «A1 combo» named the A1: «شكد سعر الطابعة؟» is the A1, and a fault still asks which printer.
  const combo = await say(null, { text: 'A1 combo' });
  assert.equal(combo.context.printer.model, 'A1');
  assert.deepEqual(ids(await say(null, { text: 'شكد سعر الطابعة؟', context: combo.context })), ['p_a1', 'p_a1c', 'p_a1r']);
  for (const [text, locale] of [
    ['صارت عندي مشكله بالطابعه', 'ar'],
    ['my nozzle is clogged', 'en'],
    ['کلۆگ', 'ckb'],
  ] as const) {
    const asked = await say(null, { text, locale, context: combo.context });
    assert.equal(asked.intent, 'printer_problem', text);
    assert.equal(asked.context.triage.stage, 'printer', `${text}: ${asked.text}`);
  }
  // A printer the customer chose in the triage is kept, as before.
  const chosen = await say(null, { text: 'كلوب', context: { v: 1, printer: { model: 'A1' } } });
  assert.equal(chosen.context.triage.stage, 'steps');
});

test('round 3: «اكو غيرها؟» after the part cards is more of the part, never the menu and never «another printer»', async () => {
  const { say } = await round3();
  for (const [first, more, locale] of [
    ['نوزل', 'اكو غيرها؟', 'ar'],
    ['نوزل', 'اريد غيرها', 'ar'],
    ['nozzle', 'any other?', 'en'],
  ] as const) {
    const a = await say(null, { text: first, locale });
    const b = await say(null, { text: more, locale, context: a.context });
    assert.notEqual(b.intent, 'clarify', `${more}: ${b.text}`);
    assert.ok(ids(b).length > 0, `${more}: ${b.text}`);
    assert.deepEqual(ids(b).filter((id) => ids(a).includes(id)), [], `${more}: the same cards again`);
    assert.equal(b.context.printer, undefined, more);
    assert.equal(b.context.part, 'nozzle_hotend');
  }
  // After the A1 parts: more A1 parts, or plainly none.
  const a1 = await say(null, { text: 'نوزل مال اي ون' });
  const more = await say(null, { text: 'اكو غيرها؟', context: a1.context });
  assert.equal(more.context.printer.model, 'A1');
  assert.deepEqual(ids(more).filter((id) => !A1_LINKED.has(id)), []);
  if (!ids(more).length) assert.equal(more.text, 'لا توجد نتائج أخرى من هذا النوع في الكتالوج.');
});

test('round 3: a nozzle question with no printer shows a hotend first, past the accessories named after it', async () => {
  const { say } = await round3();
  for (const [text, locale] of [
    ['نوزل', 'ar'],
    ['اريد نوزل', 'ar'],
    ['I want a nozzle', 'en'],
    ['نۆزڵم دەوێت', 'ckb'],
    ['عندكم هوت اند؟', 'ar'],
    ['النوزل اشتريته تو', 'ar'],
    ['نوزل طابعة ثري دي', 'ar'],
  ] as const) {
    const reply = await say(null, { text, locale });
    assert.ok(IS_HOTEND.has(ids(reply)[0]), `«${text}» → ${JSON.stringify(ids(reply))}`);
    assert.ok(!ids(reply).includes('plate_3d'), `«${text}»: «ثري دي» is the kind of printer, not a word to search`);
  }
  const asked = await say(null, { text: 'نوزل مال زد ون' });
  const other = await say(null, { text: 'طابعة أخرى', context: asked.context });
  assert.ok(IS_HOTEND.has(ids(other)[0]), JSON.stringify(ids(other)));
});

test('round 3: a nozzle for another maker after the A1 is any printer part, with the check-the-page caveat', async () => {
  const { say } = await round3();
  const a1 = await say(null, { text: 'nozzle for A1', locale: 'en' });
  for (const [text, locale, caveat] of [
    ['نوزل مال نبتون فور', 'ar', /تأكد في صفحة كل منتج أنه يناسب طابعتك/],
    ['وعندي هم كوبرا تو، اريد نوزل الها', 'ar', /تأكد في صفحة كل منتج أنه يناسب طابعتك/],
    ['and a nozzle for my CR-10', 'en', /Check on each product page that it fits your printer/],
  ] as const) {
    const reply = await say(null, { text, locale, context: a1.context });
    assert.match(String(reply.text), caveat, `${text}: ${reply.text}`);
    assert.doesNotMatch(String(reply.text), /A1/, text);
  }
});

test('round 3: a material and its kind is that kind alone; a bare material keeps the ordinary search', async () => {
  const { say } = await round3();
  for (const [text, want] of [
    ['silk PLA', ['silk_multi', 'silk_plus']],
    ['PLA silk', ['silk_multi', 'silk_plus']],
    ['TPU 95A', ['tpu_95a']],
  ] as const) {
    const reply = await say(null, { text, locale: 'en' });
    assert.deepEqual([...ids(reply)].sort(), [...want].sort(), `${text}: ${JSON.stringify(ids(reply))}`);
  }
  const bare = await say(null, { text: 'PLA', locale: 'en' });
  assert.ok(ids(bare).length > 2, 'a bare «PLA» is every PLA');
});

test('round 3: a lowercase «x1» is the X1, at «which printer?» and beside a part', async () => {
  const { say } = await round3();
  const clog = await say(null, { text: 'كلوب' });
  const x1 = await say(null, { text: 'x1', context: clog.context });
  assert.equal(x1.context.printer.model, 'X1C', JSON.stringify(x1.context));
  assert.equal(x1.context.triage.stage, 'steps');
  for (const [text, locale] of [['x1 nozzle', 'en'], ['نوزل x1', 'ar']] as const) {
    const reply = await say(null, { text, locale });
    assert.doesNotMatch(String(reply.text), /Which printer|لأي طابعة/, text);
    assert.ok(ids(reply).includes('h_x1') && !ids(reply).includes('h_a1'), `${text}: ${JSON.stringify(ids(reply))}`);
  }
});

test('round 3: English follow-ups read the cards just shown again', async () => {
  const { say } = await round3();
  const a = await say(null, { text: 'nozzle for the A1', locale: 'en' });
  const shown = ids(a);
  for (const [text, intent] of [
    ['how much is it?', 'price_question'],
    ['is it in stock?', 'stock_question'],
    ['how much?', 'price_question'],
    ['how much are they?', 'price_question'],
  ] as const) {
    const r = await say(null, { text, locale: 'en', context: a.context });
    assert.deepEqual(ids(r), shown, `${text}: ${r.intent} ${JSON.stringify(ids(r))}`);
    assert.equal(r.intent, intent, text);
  }
  const first = await say(null, { text: 'how much is the first one?', locale: 'en', context: a.context });
  assert.deepEqual(ids(first), [shown[0]]);
});

test('round 3: «ما تطبع», «وكفت», the Iraqi «دا» and "stopped working" are printer problems', async () => {
  const { say } = await round3();
  for (const [text, locale] of [
    ['الطابعة ما تطبع', 'ar'],
    ['الطابعة ما دا تشتغل', 'ar'],
    ['الطابعه وكفت', 'ar'],
    ['my printer is not printing', 'en'],
    ['printer stopped working', 'en'],
    ['پرینتەرەکەم چاپ ناکات', 'ckb'],
  ] as const) {
    const reply = await say(null, { text, locale });
    assert.equal(reply.intent, 'printer_problem', `${text}: ${reply.intent} ${reply.text}`);
    assert.equal(reply.context.triage.stage, 'printer', text);
  }
  const clog = await say(null, { text: 'ما دا يطلع فلامنت من النوزل' });
  assert.equal(clog.intent, 'printer_problem');
  assert.equal(clog.context.triage.symptom, 'clog');
});

test('round 3: «طابعتي» at «which printer?» is the printer of the account; a guest is asked again', async () => {
  const { say } = await round3();
  for (const [first, answer, locale] of [
    ['صارت عندي مشكله بالطابعه', 'طابعتي', 'ar'],
    ['I have a problem with my printer', 'my own printer', 'en'],
    ['کێشەم هەیە لە پرینتەرەکەم', 'پرینتەرەکەی خۆم', 'ckb'],
  ] as const) {
    const a = await say(member, { text: first, locale });
    assert.equal(a.context.triage.stage, 'printer', first);
    const b = await say(member, { text: answer, locale, context: a.context });
    assert.equal(b.intent, 'printer_problem', `${answer}: ${b.text}`);
    assert.deepEqual(b.context.printer, { model: 'A1', unit_id: 'unit_own' }, answer);
    assert.equal(b.context.triage.stage, 'symptom', answer);
  }
  const guest = await say(null, { text: 'صارت عندي مشكله بالطابعه' });
  const again = await say(null, { text: 'طابعتي', context: guest.context });
  assert.equal(again.intent, 'printer_problem');
  assert.equal(again.context.triage.stage, 'printer', 'the question stays open');
  // A sentence nothing reads («لم أفهم») does not close the question either.
  const lost = await say(null, { text: 'tell me a joke', locale: 'en', context: guest.context });
  assert.equal(lost.intent, 'clarify');
  assert.equal(lost.context?.triage?.stage ?? guest.context.triage.stage, 'printer');
  const answered = await say(null, { text: 'A1', context: lost.context ?? guest.context });
  assert.equal(answered.context.triage.stage, 'symptom', `«A1» still answers «which printer?»: ${answered.text}`);
});

test('round 3: an HMS code typed after the clog steps joins the clog in the ticket', async () => {
  const { say } = await round3();
  const CODE = '0300-0100-0001-0003';
  const a = await say(member, { text: 'كلوب' });
  const b = await say(member, { intent: 'printer_problem', params: { step: 'printer', model: 'A1', unit_id: 'unit_own' }, context: a.context });
  assert.ok(ids(b).length > 0);
  const c = await say(member, { text: `وطلعلي رمز ${CODE}`, context: b.context });
  assert.deepEqual(c.context.triage, { stage: 'steps', symptom: 'clog', code: CODE });
  assert.deepEqual(c.context.shown, b.context.shown, 'the parts shown stay');
  assert.match(String(c.text), new RegExp(CODE));
  assert.match(String(c.text), /انسداد النوزل/);
  const d = await say(member, { intent: 'printer_problem', params: { step: 'talk' }, context: c.context });
  const body = String(d.ticket_draft.body);
  assert.match(body, /المشكلة: انسداد النوزل/);
  assert.match(body, new RegExp(`رمز الخطأ: ${CODE}`));
  assert.deepEqual(d.ticket_draft.handoff.shown, b.context.shown);
});

test('round 3: a verb, «product» and «3D» are not words to search', async () => {
  const { say } = await round3();
  const change = await say(null, { text: 'اريد اغير النوزل مال الاي ون' });
  assert.equal(ids(change)[0], 'h_a1', JSON.stringify(ids(change)));
  const products = await say(null, { text: 'I need maintenance products for a faulty nozzle', locale: 'en' });
  assert.equal(products.intent, 'product_search', `${products.intent}: ${products.text}`);
  assert.ok(ids(products).includes('h_a1') || ids(products).includes('n_needle'), JSON.stringify(ids(products)));
});

test('round 3: the code note comes before the steps, the guest handoff is one sentence each, the ticket says no «below»', async () => {
  const { say } = await round3();
  const CODE = '0300-0100-0001-0003';
  for (const [locale, intro] of [
    ['ar', /^سجّلت رمز الخطأ 0300-0100-0001-0003، وسيصل إلى الفريق مع التذكرة\. رمز خطأ HMS في طابعة P1S\. جرّب هذه الخطوات بالترتيب:$/],
    ['en', /^I noted the error code 0300-0100-0001-0003; it goes to the team with the ticket\. HMS error code on the P1S\. Try these steps in order:$/],
    ['ckb', /^کۆدی هەڵەی 0300-0100-0001-0003 تۆمار کرا، و لەگەڵ تیکێتەکە دەگاتە تیمەکە\. /],
  ] as const) {
    const reply = await say(null, { text: `P1S رمز ${CODE}`, locale });
    assert.match(String(reply.text), intro, `${locale}: ${reply.text}`);
  }
  const clog = await say(null, { text: 'A1', context: (await say(null, { text: 'كلوب' })).context });
  for (const locale of ['ar', 'en', 'ckb'] as const) {
    const talk = await say(null, { intent: 'printer_problem', params: { step: 'talk' }, context: clog.context, locale });
    assert.doesNotMatch(String(talk.text), /:\s*\S/, `${locale}: no colon introduces the sign-in: ${talk.text}`);
    assert.doesNotMatch(String(talk.ticket_draft.body), /أدناه|below|خوارەوە/, `${locale}: the ticket points at nothing`);
  }
});

// ════════════════════════════════════════ review, round 4

/**
 * The round-3 shop, plus what the round-4 findings were about: filaments
 * whose colour and weight are option names in English only, and the H2D Pro.
 */
async function round4(): Promise<{ raw: DatabaseSync; db: D1Database; say: (user: StubUser | null, body: Rec) => Promise<Rec> }> {
  const raw = await shopRound3();
  const add = (id: string, name: string, nameAr: string, category: string, colors: Array<Record<string, string>> = []) =>
    raw
      .prepare(
        `INSERT INTO products (id,slug,name,name_ar,name_ku,price_iqd,status,stock,options,colors,selling_type,sale_types,
           preorder_transports,images,inventory_mode,ops_policy,category_id)
         VALUES (?,?,?,?,'',?,'active',5,'[]',?,'direct_sale','["direct_sale"]','[]','[]','BASE','{}',?)`
      )
      .run(id, id.replace(/_/g, '-'), name, nameAr, 25_000, JSON.stringify(colors.map((c, i) => ({ id: `c_${id}_${i}`, active: true, ...c }))), category);
  add('petg_basic', 'PETG Basic', 'فلمنت PETG Basic', 'cat_materials', [{ name_en: 'Black', name_ar: 'اسود' }]);
  add('petg_matte', 'PETG Matte', 'فلامنت PETG مطفي', 'cat_materials', [{ name_en: 'Black (11101)' }]);
  add('petg_cf', 'PETG-CF', 'فلامنت PETG-CF', 'cat_materials', [{ name_en: 'Black' }]);
  add('pla_1kg', 'PLA Basic 1kg', 'فلامنت PLA Basic 1kg', 'cat_materials');
  add('esun_pla', 'eSUN PLA+ 1 كغم', 'فلامنت eSUN PLA+ 1 كغم', 'cat_materials');
  add('p_h2dpro', 'Bambu Lab H2D Pro', 'طابعة Bambu Lab H2D Pro', 'cat_printers_fdm');
  const run = await backfillSearchIndex(asD1(raw), { limit: 50 });
  assert.deepEqual(run.failed, []);
  const db = limitD1(raw);
  return {
    raw,
    db,
    say: (user, body) => {
      raw.exec('DELETE FROM rate_limits');
      return ask(db, user, body);
    },
  };
}

test('round 4: «تحدث مع الفريق» before the steps: the ticket names only what was given, never a printer only browsed', async () => {
  const { say } = await round4();
  const TRIED = { ar: 'الخطوات التي جربتها', en: 'Steps I tried', ckb: 'ئەو هەنگاوانەی تاقیم کردنەوە' } as const;
  const OTHER = { ar: 'طابعة أخرى', en: 'Another printer', ckb: 'پرینتەرێکی تر' } as const;
  for (const [user, locale, shopping, fault, talk] of [
    [null, 'ar', 'طابعة P1S', 'كلوب', 'تحدث مع الفريق'],
    [member, 'ar', 'طابعة P1S', 'كلوب', 'اريد احجي ويا الفريق'],
    [null, 'en', 'A1 combo', 'my nozzle is clogged', 'talk to the team'],
    [member, 'en', 'P1S', 'my nozzle is clogged', 'talk to the team'],
    [null, 'ckb', 'P1S', 'کلۆگ', 'قسە لەگەڵ تیمەکە بکە'],
    [member, 'ckb', 'A1 combo', 'کلۆگ', 'قسە لەگەڵ تیمەکە بکە'],
  ] as const) {
    const label = `${user ? 'member' : 'guest'} ${locale} «${talk}»`;
    const shown = await say(user, { text: shopping, locale });
    assert.equal(shown.context.printer.browsed, true, `${label}: the shopping answer only showed the printer`);
    const asked = await say(user, { text: fault, locale, context: shown.context });
    assert.equal(asked.context.triage.stage, 'printer', label);
    const reply = await say(user, { text: talk, locale, context: asked.context });
    const draft = reply.ticket_draft as Rec;
    assert.equal(reply.handoff, true, label);
    assert.equal(draft.handoff.model, null, `${label}: no printer was chosen`);
    assert.equal(draft.handoff.symptom, 'clog', label);
    assert.deepEqual(draft.handoff.tried, [], `${label}: no step was shown`);
    assert.equal(draft.unit_id, undefined, label);
    for (const said of [...['A1', 'P1S'], OTHER[locale], TRIED[locale]]) {
      assert.ok(!String(draft.subject).includes(said) && !String(draft.body).includes(said), `${label}: «${said}» in ${JSON.stringify(draft)}`);
    }
    assert.ok(!String(reply.text).includes(ASSIST_STRINGS[locale].handoff_reply.split('.')[0]), `${label}: the reply claims no steps tried: ${reply.text}`);
  }
});

test('round 4: the menu chip and «which symptom?»: nothing given is nothing written, a printer chosen is', async () => {
  const { say } = await round4();
  // «صارت عندي مشكله بالطابعه» then the greeting menu's «التحدث مع فريق Levonis»: no printer, no fault, no step.
  for (const [user, locale] of [[member, 'ar'], [null, 'en'], [member, 'ckb']] as const) {
    const start = await say(user, { text: 'صارت عندي مشكله بالطابعه', locale });
    const chip = await say(user, { intent: 'human_handoff', locale, context: start.context });
    const draft = chip.ticket_draft as Rec;
    assert.equal(chip.handoff, true, locale);
    assert.equal(draft.handoff, undefined, `${locale}: a summary naming neither a printer nor a fault is none`);
    assert.equal(draft.body, '', `${locale}: ${draft.body}`);
    assert.equal(draft.subject, ASSIST_STRINGS[locale].ticket_subject_plain, locale);
  }
  // The member's own A1 chosen, then «تحدث مع الفريق» at «which symptom?»: the printer and its unit, no fault, no step.
  const start = await say(member, { text: 'صارت عندي مشكله بالطابعه' });
  const which = await say(member, { intent: 'printer_problem', params: start.choices[0].params, context: start.context });
  assert.equal(which.context.triage.stage, 'symptom');
  const talk = await say(member, { text: 'تحدث مع الفريق', context: which.context });
  assert.deepEqual(talk.ticket_draft.handoff, { v: 1, model: 'A1', symptom: null, tried: [], shown: [], attachments: 0 });
  assert.equal(talk.ticket_draft.body, 'الطابعة: A1');
  assert.equal(talk.ticket_draft.unit_id, 'unit_own');
  // After the steps the same words list every step shown, as shown: nobody said they tried them (review round 4.2).
  const steps = await say(member, { intent: 'printer_problem', params: { step: 'symptom', symptom: 'clog' }, context: which.context });
  const full = await say(member, { text: 'تحدث مع الفريق', context: steps.context });
  assert.equal(full.text, ASSIST_STRINGS.ar.handoff_reply_said);
  assert.deepEqual(full.ticket_draft.handoff.tried, []);
  assert.ok(String(full.ticket_draft.body).includes(ASSIST_STRINGS.ar.ticket_shown), full.ticket_draft.body);
});

test('round 4: «اكو غيرها؟» pages on from where it stopped: no card twice, no listing row skipped, then plainly none', async () => {
  const { db, say } = await round4();
  for (const [first, more, locale] of [
    ['نوزل مال اي ون', 'اكو غيرها؟', 'ar'],
    ['nozzle for the A1', 'any other?', 'en'],
    ['نۆزڵ بۆ A1', 'شتی تر هەیە؟', 'ckb'],
  ] as const) {
    let reply = await say(null, { text: first, locale });
    const seen = [...ids(reply)];
    for (let i = 0; i < 4 && ids(reply).length; i++) {
      reply = await say(null, { text: more, locale, context: reply.context });
      assert.notEqual(reply.intent, 'clarify', `${locale} «${more}»: ${reply.text}`);
      seen.push(...ids(reply));
    }
    assert.equal(reply.text, ASSIST_STRINGS[locale].more_none, `${locale}: it ends plainly`);
    assert.equal(new Set(seen).size, seen.length, `${locale}: a card shown twice: ${JSON.stringify(seen)}`);
    // Every part linked to the A1 that the part's own listing holds is on some page.
    for (const id of ['h_a1', 'n_needle', 'a_sponge', 'a_wipes', 'a_sock', 'a_fan', 'a_wiper', 'a_heat', 'a_therm', 'a_needle']) {
      assert.ok(seen.includes(id), `${locale}: ${id} is on no page: ${JSON.stringify(seen)}`);
    }
    assert.deepEqual(seen.filter((id) => !A1_LINKED.has(id)), [], locale);
  }
  // With no printer: the rows a hotend put first pushed off the first page are on the next one.
  let reply = await say(null, { text: 'نوزل' });
  const pages = [ids(reply)];
  for (let i = 0; i < 2; i++) {
    reply = await say(null, { text: 'اكو غيرها؟', context: reply.context });
    pages.push(ids(reply));
  }
  const all = pages.flat();
  assert.equal(new Set(all).size, all.length, JSON.stringify(pages));
  // The part's own listing, as the storefront search box has it: its first two pages of rows are all on some page.
  const res = await get(appFor(db, null), `/api/products?limit=12&search=${encodeURIComponent('hotend nozzle ')}`);
  const rows = ((await json(res)).products as Rec[]).map((p) => String(p.id));
  assert.ok(rows.length >= 10, JSON.stringify(rows));
  for (const id of rows) assert.ok(all.includes(id), `${id}, a row of the listing, is on no page: ${JSON.stringify(pages)}`);
});

test('round 4: a maker the shop sells parts of is searched: the Snapmaker nozzle first, with the check-the-page caveat', async () => {
  const { say } = await round4();
  const a1 = await say(null, { text: 'نوزل مال اي ون' });
  for (const [text, locale, context] of [
    ['اكو نوزل سنابميكر؟', 'ar', undefined],
    ['do you have a snapmaker nozzle?', 'en', undefined],
    ['snapmaker hotend', 'en', undefined],
    ['اكو نوزل Snapmaker؟', 'ar', a1.context],
  ] as const) {
    const reply = await say(null, { text, locale, ...(context ? { context } : {}) });
    assert.equal(ids(reply)[0], 'snap_steel', `${text}: ${JSON.stringify(ids(reply))}`);
    assert.match(String(reply.text), locale === 'en' ? /Check on each product page that it fits your printer/ : /تأكد في صفحة كل منتج أنه يناسب طابعتك/, text);
  }
  // A maker the shop has nothing of is still not searched: the caveat, no card of its own.
  const neptune = await say(null, { text: 'نوزل مال نبتون فور' });
  assert.ok(!ids(neptune).includes('snap_steel'), JSON.stringify(ids(neptune)));
});

test('round 4: a colour or a weight beside a material keeps the ordinary search; a line or a grade still narrows it', async () => {
  const { say } = await round4();
  const black = await say(null, { text: 'PETG اسود متوفر؟' });
  for (const id of ['petg_basic', 'petg_matte', 'petg_cf']) assert.ok(ids(black).includes(id), `«PETG اسود»: ${id} has a black too: ${JSON.stringify(ids(black))}`);
  const kg = await say(null, { text: 'PLA 1kg' });
  assert.ok(ids(kg).includes('esun_pla') && ids(kg).includes('pla_1kg'), `«PLA 1kg»: ${JSON.stringify(ids(kg))}`);
  const ckb = await say(null, { text: 'فیلامێنتی PLA', locale: 'ckb' });
  assert.ok(ids(ckb).length > 2, `«فیلامێنتی PLA» is every PLA: ${JSON.stringify(ids(ckb))}`);
  for (const [text, want] of [
    ['silk PLA', ['silk_multi', 'silk_plus']],
    ['TPU 95A', ['tpu_95a']],
  ] as const) {
    assert.deepEqual([...ids(await say(null, { text, locale: 'en' }))].sort(), [...want].sort(), text);
  }
});

test('round 4: a part question typed at «أي طابعة عندك؟» shows the parts, after «لم أفهم» too', async () => {
  const { say } = await round4();
  const start = await say(null, { text: 'صارت عندي مشكله بالطابعه' });
  const lost = await say(null, { text: 'ققق ممم', context: start.context });
  assert.equal(lost.intent, 'clarify');
  const nozzle = await say(null, { text: 'نوزل مال اي ون', context: lost.context ?? start.context });
  assert.equal(nozzle.intent, 'product_search', nozzle.text);
  assert.equal(ids(nozzle)[0], 'h_a1', JSON.stringify(ids(nozzle)));
  const plate = await say(null, { text: 'اريد بليت للاي ون', context: start.context });
  assert.ok(ids(plate).includes('pl_pei'), `${plate.text} ${JSON.stringify(ids(plate))}`);
  // The printer itself is still the answer, and a fault in a part still the triage.
  assert.equal((await say(null, { text: 'A1', context: start.context })).context.triage.stage, 'symptom');
  const fault = await say(null, { text: 'A1 النوزل مسدود', context: start.context });
  assert.equal(fault.context.triage.stage, 'steps');
});

test('round 4: «تنظيف النوزل», "nozzle cleaning", «پاککردنەوەی نۆزڵ» are the cleaning tools, not the hotends', async () => {
  const { say } = await round4();
  const CLEANING = new Set(['a_sponge', 'a_wipes', 'n_needle', 'a_needle']);
  for (const [text, locale] of [
    ['nozzle cleaning', 'en'],
    ['تنظيف النوزل', 'ar'],
    ['پاککردنەوەی نۆزڵ', 'ckb'],
    ['شي ينظف النوزل', 'ar'],
    ['اريد شي انظف بيه النوزل', 'ar'],
    ['اسفنجة تنظيف النوزل', 'ar'],
    ['شتێک بۆ پاککردنەوەی نۆزڵ', 'ckb'],
  ] as const) {
    const reply = await say(null, { text, locale });
    assert.ok(CLEANING.has(ids(reply)[0]), `«${text}» → ${JSON.stringify(ids(reply))}`);
    assert.ok(!IS_HOTEND.has(ids(reply)[0]), text);
  }
  assert.equal(ids(await say(null, { text: 'اسفنجة تنظيف النوزل' }))[0], 'a_sponge');
  assert.ok(['n_needle', 'a_needle'].includes(ids(await say(null, { text: 'ابرة تنظيف' }))[0]));
});

test('round 4: "price of AMS 2 Pro", «H2D Pro»: a product called Pro is not the Pro membership', async () => {
  const { say } = await round4();
  for (const [text, locale, want] of [
    ['price of AMS 2 Pro', 'en', 'ams_2pro'],
    ['AMS 2 Pro price', 'en', 'ams_2pro'],
    ['price of the H2D Pro', 'en', 'p_h2dpro'],
    ['H2D Pro', 'en', 'p_h2dpro'],
    ['سعر H2D Pro', 'ar', 'p_h2dpro'],
  ] as const) {
    const reply = await say(null, { text, locale });
    assert.notEqual(reply.intent, 'membership_status', `${text}: ${reply.text}`);
    assert.ok(ids(reply).includes(want), `${text}: ${JSON.stringify(ids(reply))}`);
  }
  // The membership is still the membership.
  for (const text of ['my pro membership', 'am I pro?']) {
    assert.equal((await say(null, { text, locale: 'en' })).intent, 'membership_status', text);
  }
});

test('round 4: "something is wrong with my printer" and "my printer stopped" start the triage', async () => {
  const { say } = await round4();
  for (const text of ['something is wrong with my printer', 'help, my printer stopped', 'my printer has stopped', 'my printer is acting up']) {
    const guest = await say(null, { text, locale: 'en' });
    assert.equal(guest.intent, 'printer_problem', `${text}: ${guest.intent} ${guest.text}`);
    assert.equal(guest.context.triage.stage, 'printer', text);
  }
  const mine = await say(member, { text: 'something is wrong with my printer', locale: 'en' });
  assert.equal(mine.intent, 'printer_problem', mine.text);
  assert.equal(mine.choices[0].params.unit_id, 'unit_own', 'the member’s own A1 first');
  // An order that "stopped" is not a printer fault.
  assert.notEqual((await say(null, { text: 'my order stopped moving', locale: 'en' })).intent, 'printer_problem');
});

test('round 4: the Sorani line sentence glues no clitic onto the line name', async () => {
  const { say } = await round4();
  const a1 = await say(null, { text: 'نۆزڵ بۆ A1', locale: 'ckb' });
  const e3d = await say(null, { text: 'نۆزڵی E3D هەیە؟', locale: 'ckb', context: a1.context });
  assert.deepEqual(ids(e3d), ['h_e3d']);
  assert.match(String(e3d.text), /E3D/);
  assert.doesNotMatch(String(e3d.text), /E3D[ء-يٱ-ۓە]/, String(e3d.text));
});

// ════════════════════════════════════════ review, round 4.2

test('round 4.2: a fault word about an order, a delivery, a return or a warranty is the account question, never the printer triage', async () => {
  const { say } = await round4();
  for (const [text, intent] of [
    ['something is wrong with my A1 order', 'order_status'],
    ['my A1 order has stopped', 'order_status'],
    ['the delivery of my P1S has stopped', 'delivery_estimate'],
    ['I want to return my A1, something is wrong with it', 'return_help'],
    ['something is wrong with the warranty of my A1', 'warranty_status'],
    ['my A1 order is not right', 'order_status'],
    ['I have a problem with my A1 order', 'order_status'],
    ['problem with the delivery of my P1S', 'delivery_estimate'],
  ] as const) {
    const reply = await say(member, { text, locale: 'en' });
    assert.equal(reply.intent, intent, `${text}: ${reply.intent} ${reply.text}`);
    assert.equal(reply.context?.triage, undefined, `${text}: no triage was started`);
  }
  // The guest is asked to sign in for the order, as before the triage existed.
  assert.equal((await say(null, { text: 'something is wrong with my A1 order', locale: 'en' })).intent, 'order_status');
  for (const text of ['عندي مشكلة بطلبية الاي ون', 'مشكلة بتوصيل البي ون اس', 'اريد ارجع الاي ون بيه مشكلة']) {
    assert.notEqual((await say(member, { text })).intent, 'printer_problem', text);
  }
  // A choice about a printer is not a fault in it.
  assert.equal((await say(null, { text: 'is the P1S not right for beginners?', locale: 'en' })).intent, 'choose_printer');
  for (const text of ['the A1 is not right for me, what else?', 'nothing wrong with the A1, I just want a faster printer', 'what is wrong with buying the A1 mini?']) {
    assert.notEqual((await say(null, { text, locale: 'en' })).intent, 'printer_problem', text);
  }
  // The printer as the subject, or a purchase in the past, is still the triage.
  for (const [text, locale] of [
    ['something is wrong with my printer', 'en'],
    ['my printer has stopped', 'en'],
    ['I bought an A1 and it stopped working', 'en'],
    ['اي تو وصلتني الطابعة وبيها مشكلة', 'ar'],
  ] as const) {
    assert.equal((await say(null, { text, locale })).intent, 'printer_problem', text);
  }
});

test('round 4.2: a question about a printer the shop sells shows the printer first, new before refurbished, then what names it', async () => {
  const { say } = await round4();
  const A1 = ['p_a1', 'p_a1c', 'p_a1r'];
  for (const [text, locale] of [
    ['شكد سعر A1', 'ar'],
    ['how much is the A1?', 'en'],
    ['price of the A1', 'en'],
    ['A1', 'ar'],
    ['بكم الاي ون', 'ar'],
    ['نرخی A1 چەندە؟', 'ckb'],
  ] as const) {
    const reply = await say(null, { text, locale });
    assert.deepEqual(ids(reply).slice(0, 3), A1, `«${text}»: ${reply.intent} ${JSON.stringify(ids(reply))}`);
    assert.ok(ids(reply).length > A1.length, `«${text}»: what names the A1 follows the printer`);
    assert.deepEqual(reply.context.printer, { model: 'A1', browsed: true }, `${text}: shown, not the printer the customer has`);
  }
  assert.equal((await say(null, { text: 'شكد سعر A1' })).intent, 'price_question');
  // At «أي طابعة عندك؟» it is a new question: the printer first, and the question no longer pending.
  const asked = await say(null, { text: 'النوزل مسدود' });
  assert.equal(asked.context.triage.stage, 'printer');
  const price = await say(null, { text: 'شكد سعر A1', context: asked.context });
  assert.equal(price.intent, 'price_question');
  assert.deepEqual(ids(price).slice(0, 3), A1, JSON.stringify(ids(price)));
  assert.equal(price.context.triage, undefined);
  // After the steps, another printer asked about is a shopping answer: it ends the triage as the legacy answers do,
  // so the browsed P1S never stands in a ticket for the A1 the customer chose.
  const clog = await say(null, { text: 'A1', context: (await say(null, { text: 'كلوب' })).context });
  assert.equal(clog.context.triage.stage, 'steps');
  const p1s = await say(null, { text: 'شكد سعر P1S', context: clog.context });
  assert.equal(ids(p1s)[0], 'p_p1s', JSON.stringify(ids(p1s)));
  assert.equal(p1s.context.triage, undefined);
  assert.deepEqual(p1s.context.printer, { model: 'P1S', browsed: true });
  // The bare printer word: one of each printer the shop lists, new first.
  const PRINTER_IDS = new Set(['p_a1', 'p_a1c', 'p_a1m', 'p_a1r', 'p_x1c', 'p_p1s', 'p_h2dpro']);
  for (const [text, locale] of [
    ['طابعة', 'ar'],
    ['printers', 'en'],
    ['پرینتەر', 'ckb'],
  ] as const) {
    const reply = await say(null, { text, locale });
    assert.equal(ids(reply)[0], 'p_a1', `${text}: ${JSON.stringify(ids(reply))}`);
    assert.ok(ids(reply).length >= 3 && ids(reply).every((id) => PRINTER_IDS.has(id)), `${text}: printers only: ${JSON.stringify(ids(reply))}`);
    assert.equal(new Set(ids(reply)).size, ids(reply).length, text);
  }
  // A bundle named is still its own card first.
  assert.equal(ids(await say(null, { text: 'A1 combo' }))[0], 'p_a1c');
});

test('round 4.2: «تحدث مع الفريق» after the steps lists them as shown, never as tried; «جربتها وما انحلّت» lists them as tried', async () => {
  const { say } = await round4();
  const clogKeys = symptomDef('clog').steps.map((st) => st.key);
  for (const [locale, start, talk, notFixed] of [
    ['ar', 'صارت عندي مشكله بالطابعه', 'تحدث مع الفريق', 'جربتها وما انحلّت'],
    ['en', 'my printer has a problem', 'talk to the team', 'tried them, still not fixed'],
    ['ckb', 'کێشەم هەیە لە پرینتەرەکەم', 'قسە لەگەڵ تیمەکە بکە', 'تاقیم کردەوە، هێشتا چارەسەر نەبووە'],
  ] as const) {
    const T = ASSIST_STRINGS[locale];
    const first = await say(member, { text: start, locale });
    assert.equal(first.choices[0].params.unit_id, 'unit_own', locale);
    const which = await say(member, { intent: 'printer_problem', params: first.choices[0].params, context: first.context, locale });
    const steps = await say(member, { intent: 'printer_problem', params: { step: 'symptom', symptom: 'clog' }, context: which.context, locale });
    assert.equal(steps.context.triage.stage, 'steps', locale);
    for (const turn of [{ text: talk }, { intent: 'printer_problem', params: { step: 'talk' } }, { intent: 'human_handoff' }]) {
      const label = `${locale} ${JSON.stringify(turn)}`;
      const reply = await say(member, { ...turn, locale, context: steps.context });
      const draft = reply.ticket_draft as Rec;
      assert.equal(reply.handoff, true, label);
      assert.deepEqual(draft.handoff.tried, [], `${label}: nobody said they tried them`);
      assert.ok(!String(draft.body).includes(T.ticket_tried), `${label}: ${draft.body}`);
      assert.ok(String(draft.body).includes(T.ticket_shown), `${label}: the steps are listed as shown: ${draft.body}`);
      for (const st of symptomDef('clog').steps) assert.ok(String(draft.body).includes((st.tried ?? st.text)[locale]), `${label}: ${st.key}`);
      assert.equal(reply.text, T.handoff_reply_said, `${label}: the reply claims no steps tried`);
    }
    for (const turn of [{ text: notFixed }, { intent: 'printer_problem', params: { step: 'outcome', outcome: 'not_fixed' } }]) {
      const label = `${locale} ${JSON.stringify(turn)}`;
      const reply = await say(member, { ...turn, locale, context: steps.context });
      assert.deepEqual(reply.ticket_draft.handoff.tried, clogKeys, label);
      assert.ok(String(reply.ticket_draft.body).includes(T.ticket_tried), label);
      assert.ok(!String(reply.ticket_draft.body).includes(T.ticket_shown), label);
      assert.equal(reply.text, T.handoff_reply, label);
      // Said once, it stays said: the same ticket after the sign-in trip.
      const later = await say(member, { intent: 'printer_problem', params: { step: 'talk' }, locale, context: reply.context });
      assert.deepEqual(later.ticket_draft.handoff.tried, clogKeys, `${label}: kept`);
    }
  }
  // An HMS code typed, then the team: no photo was taken, and nothing was described for «أخرى».
  const hms = await say(null, { text: 'P1S طلعلي رمز 0300-0100-0001-0003' });
  assert.equal(hms.context.triage.stage, 'steps');
  const hmsTalk = await say(null, { text: 'تحدث مع الفريق', context: hms.context });
  assert.deepEqual(hmsTalk.ticket_draft.handoff.tried, []);
  assert.ok(!String(hmsTalk.ticket_draft.body).includes(ASSIST_STRINGS.ar.ticket_tried), hmsTalk.ticket_draft.body);
  const other = await say(null, { intent: 'printer_problem', params: { step: 'symptom', symptom: 'other' }, context: { v: 1, printer: { model: 'A1' }, triage: { stage: 'symptom' } } });
  const otherTalk = await say(null, { intent: 'printer_problem', params: { step: 'talk' }, context: other.context });
  assert.deepEqual(otherTalk.ticket_draft.handoff.tried, []);
  assert.ok(!String(otherTalk.ticket_draft.body).includes(ASSIST_STRINGS.ar.ticket_tried), otherTalk.ticket_draft.body);
});

test('round 4.2: a fault in a part goes to the team as that part, never as the symptom its steps are for', async () => {
  const { say } = await round4();
  for (const [text, locale, part, talk] of [
    ['عندي مشكلة بالنوزل', 'ar', 'nozzle_hotend', 'تحدث مع الفريق'],
    ['صار خلل بالنوزل', 'ar', 'nozzle_hotend', 'تحدث مع الفريق'],
    ['النوزل خربان', 'ar', 'nozzle_hotend', 'تحدث مع الفريق'],
    ['النوزل مال طابعتي بيه مشكلة', 'ar', 'nozzle_hotend', 'تحدث مع الفريق'],
    ['I have a problem with the nozzle', 'en', 'nozzle_hotend', 'talk to the team'],
    ['my nozzle is broken', 'en', 'nozzle_hotend', 'talk to the team'],
    ['کێشەم هەیە لە نۆزڵەکە', 'ckb', 'nozzle_hotend', 'قسە لەگەڵ تیمەکە بکە'],
    ['مشكلة بالبليت', 'ar', 'plate', 'تحدث مع الفريق'],
  ] as const) {
    const label = `«${text}»`;
    const guessed = symptomDef(PART_SYMPTOM[part]).label[locale];
    const asked = await say(null, { text, locale });
    assert.equal(asked.intent, 'printer_problem', label);
    assert.equal(asked.context.triage.stage, 'printer', label);
    assert.ok(!String(asked.text).includes(guessed), `${label}: the echo names a symptom nobody named: ${asked.text}`);
    assert.ok(String(asked.text).includes(PART_LABELS[part][locale]), `${label}: ${asked.text}`);
    const reply = await say(null, { text: talk, locale, context: asked.context });
    const draft = reply.ticket_draft as Rec;
    assert.equal(draft.handoff.symptom, null, label);
    assert.equal(draft.handoff.part, part, label);
    assert.ok(!String(draft.subject).includes(guessed) && !String(draft.body).includes(guessed), `${label}: ${JSON.stringify(draft)}`);
    assert.ok(String(draft.body).includes(PART_LABELS[part][locale]), `${label}: ${draft.body}`);
  }
  // Through the steps: the clog steps are still the path, and the ticket still says the nozzle.
  const asked = await say(null, { text: 'عندي مشكلة بالنوزل' });
  const steps = await say(null, { text: 'A1', context: asked.context });
  assert.equal(steps.context.triage.stage, 'steps');
  assert.deepEqual((steps.steps as Rec[]).map((st) => st.key), symptomDef('clog').steps.map((st) => st.key));
  assert.ok(!String(steps.text).includes('انسداد النوزل'), String(steps.text));
  const notFixed = await say(member, { intent: 'printer_problem', params: { step: 'outcome', outcome: 'not_fixed' }, context: steps.context });
  const summary = notFixed.ticket_draft.handoff as Rec;
  assert.equal(summary.symptom, null);
  assert.equal(summary.part, 'nozzle_hotend');
  assert.deepEqual(summary.tried, symptomDef('clog').steps.map((st) => st.key));
  assert.ok(!String(notFixed.ticket_draft.body).includes('انسداد النوزل'), notFixed.ticket_draft.body);
  // A clog word keeps the clog: «مسدود», «كلوب», "clogged", «گیراوە».
  for (const [text, locale] of [
    ['النوزل مسدود', 'ar'],
    ['كلوب', 'ar'],
    ['my nozzle is clogged', 'en'],
    ['نۆزڵەکەم گیراوە', 'ckb'],
  ] as const) {
    const named = await say(null, { text, locale });
    const reply = await say(null, { intent: 'printer_problem', params: { step: 'talk' }, locale, context: named.context });
    assert.equal(reply.ticket_draft.handoff.symptom, 'clog', text);
    assert.equal(reply.ticket_draft.handoff.part, undefined, text);
    assert.ok(String(reply.ticket_draft.body).includes(symptomDef('clog').label[locale]), text);
  }
});

test('round 4.3: «بعدني ما جربتها», "still have not tried them", «هێشتا تاقیم نەکردۆتەوە» after the steps: no ticket says they were tried', async () => {
  const { say } = await round4();
  for (const [locale, start, notTried, talk] of [
    ['ar', 'النوزل مسدود', 'بعدني ما جربتها', 'تحدث مع الفريق'],
    ['ar', 'النوزل مسدود', 'ما جربتها', 'تحدث مع الفريق'],
    ['en', 'my nozzle is clogged', "I still haven't tried them", 'talk to the team'],
    ['en', 'my nozzle is clogged', "still haven't tried", 'talk to the team'],
    ['ckb', 'نۆزڵەکە گیراوە', 'هێشتا تاقیم نەکردۆتەوە', 'قسە لەگەڵ تیمەکە بکە'],
  ] as const) {
    const T = ASSIST_STRINGS[locale];
    for (const user of [member, null]) {
      const label = `${locale} ${user ? 'member' : 'guest'} «${notTried}»`;
      const asked = await say(user, { text: start, locale });
      const steps = await say(user, { text: 'A1', locale, context: asked.context });
      assert.equal(steps.context.triage.stage, 'steps', label);
      const reply = await say(user, { text: notTried, locale, context: steps.context });
      assert.notEqual(reply.text, T.handoff_reply, `${label}: the reply says the steps were tried: ${reply.text}`);
      assert.notEqual(reply.context?.triage?.tried, true, label);
      if (reply.ticket_draft) {
        assert.deepEqual(reply.ticket_draft.handoff.tried, [], label);
        assert.ok(!String(reply.ticket_draft.body).includes(T.ticket_tried), `${label}: ${reply.ticket_draft.body}`);
      }
      // The team asked for next: the steps as shown, never as tried.
      const team = await say(user, { text: talk, locale, context: reply.context ?? steps.context });
      const draft = team.ticket_draft as Rec;
      assert.equal(team.handoff, true, `${label}: ${team.intent} ${team.text}`);
      assert.deepEqual(draft.handoff.tried, [], label);
      assert.ok(!String(draft.body).includes(T.ticket_tried), `${label}: ${draft.body}`);
      assert.ok(String(draft.body).includes(T.ticket_shown), `${label}: ${draft.body}`);
    }
  }
  // The whole phrases are still «not fixed»: the ticket. The steps are tried on it only when the reply says
  // so (review round 5): "still clogged" alone lists them as shown.
  for (const [locale, start, notFixed, tried] of [
    ['en', 'my nozzle is clogged', 'still clogged', false],
    ['en', 'my nozzle is clogged', "it still didn't work", false],
    ['ckb', 'نۆزڵەکە گیراوە', 'هێشتا کار ناکات', false],
    ['en', 'my nozzle is clogged', 'tried them, still clogged', true],
    ['ckb', 'نۆزڵەکە گیراوە', 'تاقیم کردەوە، هێشتا کار ناکات', true],
  ] as const) {
    const asked = await say(member, { text: start, locale });
    const steps = await say(member, { text: 'A1', locale, context: asked.context });
    const reply = await say(member, { text: notFixed, locale, context: steps.context });
    assert.equal(reply.handoff, true, `«${notFixed}»: ${reply.text}`);
    assert.deepEqual(reply.ticket_draft?.handoff.tried, tried ? symptomDef('clog').steps.map((st) => st.key) : [], `«${notFixed}»: ${reply.text}`);
  }
});

test('round 4.3: a question about a printer the shop sells shows it first, in Arabic, English and Sorani', async () => {
  const { say } = await round4();
  for (const [text, locale] of [
    ['do you have the A1?', 'en'],
    ['عندكم اي ون؟', 'ar'],
    ['A1 هەیە؟', 'ckb'],
    ['نرخی A1 چەندە؟', 'ckb'],
  ] as const) {
    const reply = await say(null, { text, locale });
    assert.equal(ids(reply)[0], 'p_a1', `«${text}»: ${reply.intent} ${JSON.stringify(ids(reply))}`);
  }
});

// ════════════════════════════════════════ review, round 5

test('round 5: «پرینتەرێکم دەوێ», «پرینتەرێکم پێویستە» are the printer lineup; «پرینتەرم نییە» never starts the triage', async () => {
  const { say } = await round4();
  const PRINTER_IDS = new Set(['p_a1', 'p_a1c', 'p_a1m', 'p_a1r', 'p_x1c', 'p_p1s', 'p_h2dpro']);
  for (const user of [member, null]) {
    for (const text of ['پرینتەرێکم دەوێ', 'پرینتەرێکم پێویستە', 'پرینتەرم دەوێ', 'پرینتەرێکم دەوێت', 'چاپکەرێکم دەوێ']) {
      const label = `${user ? 'member' : 'guest'} «${text}»`;
      const reply = await say(user, { text, locale: 'ckb' });
      assert.notEqual(reply.intent, 'printer_problem', `${label}: ${reply.text}`);
      assert.equal(reply.context?.triage, undefined, label);
      assert.equal(ids(reply)[0], 'p_a1', `${label}: ${JSON.stringify(ids(reply))}`);
      assert.ok(ids(reply).length >= 3 && ids(reply).every((id) => PRINTER_IDS.has(id)), `${label}: the lineup: ${JSON.stringify(ids(reply))}`);
    }
    for (const text of ['پرینتەرم نییە', 'پرینتەرێکم نیە']) {
      const label = `${user ? 'member' : 'guest'} «${text}»`;
      const reply = await say(user, { text, locale: 'ckb' });
      assert.notEqual(reply.intent, 'printer_problem', `${label}: ${reply.text}`);
      assert.equal(reply.context?.triage, undefined, label);
      const team = await say(user, { text: 'قسە لەگەڵ تیمەکە بکە', locale: 'ckb', context: reply.context });
      assert.equal(team.ticket_draft, undefined, `${label}: ${JSON.stringify(team.ticket_draft)}`);
    }
  }
});

test('round 5: a price or stock question with «my» is about the printer: the A1 first, at the grid price, never the fault question', async () => {
  const { db, say } = await round4();
  // The storefront grid's figure for the A1, page by page (this shelf is longer than one page).
  let grid: number | null | undefined;
  for (let offset = 0; grid === undefined && offset < 500; offset += 50) {
    const page = (await json(await get(appFor(db, null), `/api/products?limit=50&offset=${offset}`))).products as Rec[];
    const card = page.find((p) => p.id === 'p_a1');
    if (card) grid = (card.display_price_iqd ?? card.price_iqd ?? null) as number | null;
    if (!page.length) break;
  }
  assert.equal(typeof grid, 'number', 'the A1 is on the grid, priced');
  for (const text of ['how much is my A1', 'price of my A1', 'my A1 price', 'is my A1 available', 'is my A1 in stock']) {
    const reply = await say(null, { text, locale: 'en' });
    assert.notEqual(reply.intent, 'printer_problem', `«${text}»: ${reply.text}`);
    assert.equal(reply.context?.triage, undefined, text);
    assert.deepEqual(ids(reply).slice(0, 3), ['p_a1', 'p_a1c', 'p_a1r'], `«${text}»: ${reply.intent} ${JSON.stringify(ids(reply))}`);
    assert.equal(reply.cards[0].price_iqd, grid, `«${text}»: the grid's figure`);
  }
});

test('round 5: a not-fixed reply says the steps were tried only with a verb of trying: never «ما سويتها», "have not done them", «نەمکردووە»', async () => {
  const { say } = await round4();
  const clogKeys = symptomDef('clog').steps.map((st) => st.key);
  for (const [locale, start, said, talk] of [
    ['ar', 'النوزل مسدود', 'ما سويتها بس نفس المشكله', 'تحدث مع الفريق'],
    ['ar', 'النوزل مسدود', 'ما سويت الخطوات، نفس المشكله', 'تحدث مع الفريق'],
    ['ar', 'النوزل مسدود', 'نفس المشكله', 'تحدث مع الفريق'],
    ['en', 'my nozzle is clogged', "haven't done them, still clogged", 'talk to the team'],
    ['en', 'my nozzle is clogged', "I didn't do them, still clogged", 'talk to the team'],
    ['en', 'my nozzle is clogged', 'not yet, same problem', 'talk to the team'],
    ['ckb', 'نۆزڵەکە گیراوە', 'نەمکردووە، هێشتا گیراوە', 'قسە لەگەڵ تیمەکە بکە'],
    ['ckb', 'نۆزڵەکە گیراوە', 'هێشتا نەمکردووە، هەمان کێشەیە', 'قسە لەگەڵ تیمەکە بکە'],
  ] as const) {
    const T = ASSIST_STRINGS[locale];
    for (const user of [member, null]) {
      const label = `${locale} ${user ? 'member' : 'guest'} «${said}»`;
      const asked = await say(user, { text: start, locale });
      const steps = await say(user, { text: 'A1', locale, context: asked.context });
      assert.equal(steps.context.triage.stage, 'steps', label);
      const reply = await say(user, { text: said, locale, context: steps.context });
      assert.notEqual(reply.text, T.handoff_reply, `${label}: the reply says the steps were tried`);
      assert.notEqual(reply.context?.triage?.tried, true, label);
      for (const draft of [reply.ticket_draft, (await say(user, { text: talk, locale, context: reply.context ?? steps.context })).ticket_draft]) {
        if (!draft) continue;
        assert.deepEqual(draft.handoff.tried, [], `${label}: ${draft.body}`);
        assert.deepEqual(handoffForStaff(draft.handoff)?.tried, [], `${label}: the staff summary`);
        assert.ok(!String(draft.body).includes(T.ticket_tried), `${label}: ${draft.body}`);
        assert.ok(String(draft.body).includes(T.ticket_shown), `${label}: ${draft.body}`);
      }
    }
  }
  // A verb of trying, and the chip, still say it.
  for (const [locale, start, said] of [
    ['ar', 'النوزل مسدود', 'جربتها بس نفس المشكله'],
    ['en', 'my nozzle is clogged', 'tried them, still clogged'],
    ['ckb', 'نۆزڵەکە گیراوە', 'تاقیم کردەوە، هێشتا گیراوە'],
  ] as const) {
    const asked = await say(member, { text: start, locale });
    const steps = await say(member, { text: 'A1', locale, context: asked.context });
    for (const turn of [{ text: said }, { intent: 'printer_problem', params: { step: 'outcome', outcome: 'not_fixed' } }]) {
      const reply = await say(member, { ...turn, locale, context: steps.context });
      assert.deepEqual(reply.ticket_draft.handoff.tried, clogKeys, `${locale} ${JSON.stringify(turn)}`);
      assert.equal(handoffForStaff(reply.ticket_draft.handoff)?.tried.length, clogKeys.length);
      assert.equal(reply.text, ASSIST_STRINGS[locale].handoff_reply, `${locale} ${JSON.stringify(turn)}`);
    }
  }
});

test('round 5: the common whole «still» replies after the steps reach the team, never the menu or the same steps', async () => {
  const { say } = await round4();
  for (const [locale, start, said] of [
    ['ckb', 'نۆزڵەکە گیراوە', 'هێشتا کێشەکە هەیە'],
    ['ckb', 'نۆزڵەکە گیراوە', 'هێشتا چاک نەبووە'],
    ['ckb', 'نۆزڵەکە گیراوە', 'هێشتا کارناکات'],
    ['ckb', 'نۆزڵەکە گیراوە', 'هێشتا ئیش ناکات'],
    ['ckb', 'نۆزڵەکە گیراوە', 'تاقیم کردەوە بەڵام هێشتا'],
    ['en', 'my nozzle is clogged', 'it still happens'],
    ['en', 'my nozzle is clogged', 'still clogs'],
    ['en', 'my nozzle is clogged', 'still bad'],
    ['en', 'my nozzle is clogged', 'still getting the same error'],
    ['en', 'my nozzle is clogged', 'tried all of them but still'],
    ['en', 'my nozzle is clogged', 'still'],
  ] as const) {
    const asked = await say(member, { text: start, locale });
    const steps = await say(member, { text: 'A1', locale, context: asked.context });
    const reply = await say(member, { text: said, locale, context: steps.context });
    assert.equal(reply.handoff, true, `«${said}»: ${reply.intent} ${reply.text}`);
    assert.equal(reply.ticket_draft.handoff.symptom, 'clog', said);
    assert.equal(reply.context.triage.stage, 'done', said);
  }
});

// ════════════════════════════════════════ review, round 5.2

test('round 5.2: in Arabic and English, wanting a printer «مالتي» or "of my own", or having none, is the printer for sale, never the fault question', async () => {
  const { say } = await round4();
  const PRINTER_IDS = new Set(['p_a1', 'p_a1c', 'p_a1m', 'p_a1r', 'p_x1c', 'p_p1s', 'p_h2dpro']);
  for (const user of [member, null]) {
    for (const [text, locale, lineup] of [
      ['اريد اي ون مالتي', 'ar', false],
      ['اريد A1 مالي', 'ar', false],
      ['ماكو عندي اي ون', 'ar', false],
      ['عندي ولا اي ون', 'ar', false],
      ['اريد طابعة مالتي', 'ar', true],
      ['ابي طابعة مالتي', 'ar', true],
      ['ودي طابعة مالتي', 'ar', true],
      ['اريد طابعة مالي', 'ar', true],
      ['ماكو عندي طابعة', 'ar', true],
      ['ماكو عدي طابعة', 'ar', true],
      ['ماكو طابعة عندي', 'ar', true],
      ['عندي ولا طابعة', 'ar', true],
      ['I want my own A1', 'en', false],
      ['I need my own A1', 'en', false],
      ['my own A1 please', 'en', false],
      ['I want an A1 of my own', 'en', false],
      ['I want my own printer', 'en', true],
      ['I need my own printer', 'en', true],
    ] as const) {
      const label = `${user ? 'member' : 'guest'} «${text}»`;
      const reply = await say(user, { text, locale });
      assert.notEqual(reply.intent, 'printer_problem', `${label}: ${reply.text}`);
      assert.equal(reply.context?.triage, undefined, label);
      assert.equal(ids(reply)[0], 'p_a1', `${label}: ${reply.intent} ${JSON.stringify(ids(reply))}`);
      if (lineup) {
        assert.ok(ids(reply).length >= 3 && ids(reply).every((id) => PRINTER_IDS.has(id)), `${label}: the lineup: ${JSON.stringify(ids(reply))}`);
      }
    }
  }
});

test('round 5.2: a stock ask with an ownership word is about the printer, whatever the scorer makes of it: the A1 first, or the lineup', async () => {
  const { say } = await round4();
  const PRINTER_IDS = new Set(['p_a1', 'p_a1c', 'p_a1m', 'p_a1r', 'p_x1c', 'p_p1s', 'p_h2dpro']);
  for (const [text, locale, lineup] of [
    ['is my printer in stock', 'en', true],
    ['my printer in stock?', 'en', true],
    ['do you have my A1 in stock', 'en', false],
    ['do you have my A1', 'en', false],
    ['اكو A1 مالتي', 'ar', false],
    ['اكو طابعتي؟', 'ar', true],
    ['طابعتي موجودة عندكم؟', 'ar', true],
    ['عندي A1 موجودة عندكم؟', 'ar', false],
  ] as const) {
    const reply = await say(null, { text, locale });
    assert.notEqual(reply.intent, 'printer_problem', `«${text}»: ${reply.text}`);
    assert.equal(reply.context?.triage, undefined, text);
    assert.equal(ids(reply)[0], 'p_a1', `«${text}»: ${reply.intent} ${JSON.stringify(ids(reply))}`);
    if (lineup) assert.ok(ids(reply).every((id) => PRINTER_IDS.has(id)), `«${text}»: the lineup: ${JSON.stringify(ids(reply))}`);
  }
});

test('round 5.2: a not-fixed reply that says nothing was done, negates further off, or names only some steps lists the steps as shown; «ـهن», Sorani and "did that" say tried', async () => {
  const { say } = await round4();
  const clogKeys = symptomDef('clog').steps.map((st) => st.key);
  for (const [locale, start, said, talk] of [
    ['en', 'clog', 'I did nothing, still clogged', 'talk to the team'],
    ['en', 'clog', 'I did none of them, still clogged', 'talk to the team'],
    ['en', 'clog', "I haven't really tried them, still clogged", 'talk to the team'],
    ['en', 'clog', "I've tried nothing yet, still clogged", 'talk to the team'],
    ['en', 'clog', 'nothing done, still clogged', 'talk to the team'],
    ['en', 'clog', 'I did the first one only, still clogged', 'talk to the team'],
    ['ar', 'النوزل مسدود', 'ولا سويت شي وبعده نفس المشكله', 'تحدث مع الفريق'],
    ['ar', 'النوزل مسدود', 'ولا خطوة جربتها، نفس المشكله', 'تحدث مع الفريق'],
    ['ar', 'النوزل مسدود', 'جربت الاولى بس، نفس المشكله', 'تحدث مع الفريق'],
    ['ckb', 'نۆزڵەکە گیراوە', 'تەنها یەکەمیانم کرد، هێشتا گیراوە', 'قسە لەگەڵ تیمەکە بکە'],
  ] as const) {
    const T = ASSIST_STRINGS[locale];
    for (const user of [member, null]) {
      const label = `${locale} ${user ? 'member' : 'guest'} «${said}»`;
      const asked = await say(user, { text: start, locale });
      const steps = await say(user, { text: 'A1', locale, context: asked.context });
      assert.equal(steps.context.triage.stage, 'steps', label);
      const reply = await say(user, { text: said, locale, context: steps.context });
      assert.notEqual(reply.text, T.handoff_reply, `${label}: the reply says the steps were tried`);
      assert.notEqual(reply.context?.triage?.tried, true, label);
      if (user) assert.ok(reply.ticket_draft, `${label}: ${reply.intent} ${reply.text}`);
      for (const draft of [reply.ticket_draft, (await say(user, { text: talk, locale, context: reply.context ?? steps.context })).ticket_draft]) {
        if (!draft) continue;
        assert.deepEqual(draft.handoff.tried, [], `${label}: ${draft.body}`);
        assert.deepEqual(handoffForStaff(draft.handoff)?.tried, [], `${label}: the staff summary`);
        assert.ok(!String(draft.body).includes(T.ticket_tried), `${label}: ${draft.body}`);
        assert.ok(String(draft.body).includes(T.ticket_shown), `${label}: ${draft.body}`);
      }
    }
  }
  for (const [locale, start, said] of [
    ['ar', 'كلوب', 'جربتهن وما زبطت'],
    ['ar', 'كلوب', 'سويتهن بس نفس المشكله'],
    ['ckb', 'نۆزڵەکە گیراوە', 'هەموویم تاقی کردەوە، هێشتا چارەسەر نەبووە'],
    ['ckb', 'نۆزڵەکە گیراوە', 'جێبەجێم کردن، هێشتا گیراوە'],
    ['en', 'clog', 'did that, still clogged'],
    ['en', 'clog', 'gave it a try, still clogged'],
  ] as const) {
    const label = `${locale} «${said}»`;
    const asked = await say(member, { text: start, locale });
    const steps = await say(member, { text: 'A1', locale, context: asked.context });
    const reply = await say(member, { text: said, locale, context: steps.context });
    assert.equal(reply.text, ASSIST_STRINGS[locale].handoff_reply, `${label}: ${reply.text}`);
    assert.deepEqual(reply.ticket_draft.handoff.tried, clogKeys, label);
    assert.equal(handoffForStaff(reply.ticket_draft.handoff)?.tried.length, clogKeys.length, label);
    assert.ok(String(reply.ticket_draft.body).includes(ASSIST_STRINGS[locale].ticket_tried), `${label}: ${reply.ticket_draft.body}`);
  }
});
