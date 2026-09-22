/**
 * «التحدث عبر الدعم الالي ليس chat bot، هو غبي جدا. طور من الدعم الالي لجعله
 *  chatbot قوي ومتطور ويفهم كل شي.»
 *
 * THE SCREENSHOT IS THE SPECIFICATION. Two exchanges in it, both ending in
 * «لم أفهم طلبك تمامًا»:
 *
 *   assistant: «أي منتج تريد تقارنه؟ اكتب اسم الطابعة.»
 *   customer:  «A1 combo»
 *   assistant: «لم أفهم طلبك تمامًا. اختر أحد هذه المواضيع:»
 *
 *   customer:  «ساعدني باختيار طابعه»
 *   assistant: «لم أفهم طلبك تمامًا. اختر أحد هذه المواضيع:»
 *
 * The first is a MEMORY failure — the assistant asked a question and forgot it
 * had. The second is a VOCABULARY failure — the most ordinary sentence in a
 * printer shop had no intent at all. Both are reproduced here first and then
 * asserted fixed, against the real route and a real migrated database.
 *
 * WHAT THIS SUITE IS GUARDING BEYOND THAT. A matcher that understands more is
 * a matcher that can be WRONG more, and this route's standing rule is that an
 * ambiguous message is answered with choices and never with a guess. So the
 * scoring tests are as much about what must NOT fire — `ups` inside `groups`,
 * `vs` inside `vsync`, a short stem inside a long unrelated word — as about
 * what must.
 *
 * Run: npm run test:unit
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { DatabaseSync } from 'node:sqlite';
import { asD1, freshDb, json, post, stubApp, type StubUser } from './fixtures/app';
import { supportRoutes, matchIntents } from '../worker/routes/support';
import { STUDIO_URL } from '../src/translations';
import {
  normalizeText,
  tokenize,
  withinOneEdit,
  compileLexicon,
  scoreIntents,
  decideIntent,
  extractOrderId,
  stripWords,
  isLikelyCatalogueLookup,
} from '../worker/lib/assistantNlu';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (p: string) => readFileSync(join(ROOT, p), 'utf8');

const user: StubUser = { id: 'u_brain', role: 'customer', email: 'c@x.co' };

/** One printer whose name is the one in the screenshot. */
function seed(): DatabaseSync {
  const raw = freshDb();
  const shelf = raw.prepare("SELECT id FROM catalogs WHERE slug = 'fdm-printers'").get() as { id: string };
  const add = (id: string, slug: string, name: string, price: number, specs: Record<string, string>) =>
    raw
      .prepare(
        `INSERT INTO products (id,slug,name,name_ar,name_ku,price_iqd,status,stock,options,colors,
           selling_type,sale_types,preorder_transports,images,inventory_mode,ops_policy,spec_fields,
           template_family,category_id)
         VALUES (?,?,?,?,'',?,'active',5,'[]','[]','direct_sale','["direct_sale"]','[]','[]','BASE','{}',?,'devices',?)`
      )
      .run(id, slug, name, name, price, JSON.stringify(specs), shelf.id);
  add('p_a1c', 'a1-combo', 'A1 Combo', 1_400_000, { print_speed: '500', build_volume: '256 x 256 x 256' });
  add('p_p1s', 'p1s', 'P1S', 1_200_000, { print_speed: '300', build_volume: '256 x 256 x 256' });
  return raw;
}

const app = (db: unknown) => stubApp(db, user, (a) => a.route('/api/support', supportRoutes));
const ask = async (db: unknown, body: Record<string, unknown>) =>
  (await json(await post(app(db), '/api/support/assistant', { locale: 'ar', ...body }))).reply;

// ════════════════════════════════════════════════ the screenshot, exactly

test('«A1 combo» after «اكتب اسم الطابعة» continues the comparison', async () => {
  const db = asD1(seed());

  // Turn one: the assistant asks, and — this is the fix — SAYS it is waiting.
  const asked = await ask(db, { intent: 'compare_products' });
  assert.equal(asked.text, 'أي منتج تريد تقارنه؟ اكتب اسم الطابعة.');
  assert.deepEqual(
    asked.expects,
    { intent: 'compare_products', slot: 'q' },
    'the question must name what it is waiting for, or the next turn cannot know'
  );

  // Turn two: the answer, handed back with the question it answers.
  const answered = await ask(db, { text: 'A1 combo', expects: asked.expects });
  assert.equal(answered.intent, 'compare_products', 'this used to be «clarify»');
  assert.notEqual(answered.text, 'لم أفهم طلبك تمامًا. اختر أحد هذه المواضيع:');
  // The printer was found and the SECOND slot is what is being offered now.
  assert.match(answered.text, /A1 Combo/);
  assert.ok(answered.choices.length > 0);
  for (const choice of answered.choices) {
    assert.equal(choice.intent, 'compare_products');
    assert.match(String(choice.params.ids), /^p_a1c,/, 'the named machine is kept as the anchor');
  }
});

test('«ساعدني باختيار طابعه» is answered with the printers we actually sell', async () => {
  const db = asD1(seed());
  // Note the spelling: «طابعه», not «طابعة». That is what a phone keyboard
  // produces in a hurry, and a substring matcher treated it as another word.
  const reply = await ask(db, { text: 'ساعدني باختيار طابعه' });

  assert.equal(reply.intent, 'choose_printer');
  assert.equal(reply.text, 'هاي الطابعات المتوفرة حالياً. اختار وحدة تشوف تفاصيلها، أو قارن ثنتين:');
  // REAL products at REAL prices, never an opinion about which to buy.
  const titles = reply.cards.map((c: { title: string }) => c.title).sort();
  assert.deepEqual(titles, ['A1 Combo', 'P1S']);
  assert.ok(reply.cards.every((c: { link: { to: string } }) => c.link.to.startsWith('/product/')));
  assert.ok(reply.cards.some((c: { subtitle: string }) => c.subtitle.includes('1,400,000')));
});

test('a bare product name, typed cold, is looked up rather than shrugged at', async () => {
  const db = asD1(seed());
  // No pending question, no keyword. The catalogue is the only thing that can
  // say whether «A1 combo» means something, so the route asks it before it
  // reaches for the menu.
  const reply = await ask(db, { text: 'A1 combo' });
  assert.equal(reply.intent, 'product_search');
  assert.equal(reply.cards.length, 1);
  assert.equal(reply.cards[0].title, 'A1 Combo');
});

test('and a word the catalogue has never heard of still gets the menu', async () => {
  const db = asD1(seed());
  const reply = await ask(db, { text: 'xyzzy blorp' });
  assert.equal(reply.intent, 'clarify');
  assert.ok(reply.choices.length > 3, 'the full menu, because there is nothing closer to offer');
});

// ═══════════════════════════════════════════════ one turn, and only one

test('a new intent beats the pending question — the subject may change', async () => {
  const db = asD1(seed());
  const asked = await ask(db, { intent: 'compare_products' });
  // "Which printer?" answered with "where is my order" is a change of subject,
  // and a bot that holds somebody to the old question is the infuriating kind.
  const reply = await ask(db, { text: 'وين طلبي', expects: asked.expects });
  assert.equal(reply.intent, 'order_status');
});

test('a tapped chip ignores the pending question entirely', () => {
  const route = read('worker/routes/support.ts');
  const client = read('src/pages/Support.tsx');
  assert.match(route, /if \(typeof body\.intent === 'string' && \(INTENTS as readonly string\[\]\)\.includes\(body\.intent\)\) \{/);
  // The client does not even send it: an explicit answer cannot be overridden
  // by a slot left over from the turn before.
  assert.match(client, /const expects = payload\.intent \? undefined : pendingRef\.current;/);
});

test('an answer that asks nothing CLEARS the question', () => {
  const client = read('src/pages/Support.tsx');
  // Unconditional assignment, including with undefined. Without that, a stale
  // «اكتب اسم الطابعة» would capture a message three turns later.
  assert.match(client, /pendingRef\.current = d\.reply\.expects;/);
  assert.ok(
    !/if \(d\.reply\.expects\) pendingRef\.current/.test(client),
    'a conditional assignment would make the memory permanent'
  );
});

test('a malformed pending bag is ignored, not trusted', async () => {
  const db = asD1(seed());
  const bad = [
    { intent: 'not_an_intent', slot: 'q' },
    { intent: 'compare_products', slot: 'evil' },
    { intent: 'compare_products', slot: 'q', params: { a: 'x'.repeat(200) } },
    { intent: 'compare_products', slot: 'q', params: { a: 1 } },
    'a string',
    null,
  ];
  for (const expects of bad) {
    const reply = await ask(db, { text: 'zzzz qqqq', expects });
    assert.equal(reply.intent, 'clarify', `${JSON.stringify(expects)} must not route anywhere`);
  }
});

test('the pending slot carries no authority — the session decides whose data', () => {
  const route = read('worker/routes/support.ts');
  // An account intent reached through a pending slot is still gated on the
  // SESSION, exactly as one reached by tapping a chip is.
  assert.match(route, /if \(ACCOUNT_INTENTS\.has\(intent\) && !user\) \{/);
  const routeIndex = route.indexOf('supportRoutes.post(\'/assistant\'');
  const gate = route.indexOf('ACCOUNT_INTENTS.has(intent) && !user', routeIndex);
  const dispatch = route.indexOf('switch (intent)', routeIndex);
  assert.ok(gate > 0 && gate < dispatch, 'the sign-in gate must come before the dispatch');
});

// ═══════════════════════════════════════════════════════ reading Arabic

test('one word, however it was typed', () => {
  // The definite article, the possessive, a ة for a ه, and the harakat.
  assert.equal(normalizeText('أَجْهِزَتي'), 'اجهزتي');
  assert.equal(normalizeText('اجهزتي'), 'اجهزتي');
  assert.equal(normalizeText('طابعة'), normalizeText('طابعه'));
  // Arabic-Indic digits are digits.
  assert.equal(normalizeText('٥٠٠ واط'), '500 واط');
  // A Kurdish keyboard and an Arabic one produce the same token.
  assert.equal(normalizeText('کارمەند'), normalizeText('كارمهند'));
});

test('Arabic punctuation is a gap, not a letter', () => {
  // «؟» U+061F lives INSIDE the Arabic block, so a range check admitted it and
  // glued it to the last word — «حالة الطلب» then could not match «حالة
  // الطلب؟», which is how the commonest question in the shop went unanswered.
  assert.equal(normalizeText('شنو حالة الطلب؟'), 'شنو حاله الطلب');
  assert.equal(normalizeText('نعم، شكرًا؛ تمام'), 'نعم شكرا تمام');
  assert.deepEqual(tokenize(normalizeText('وين طلبي؟')), ['وين', 'طلبي']);
});

test('the definite article is not a near miss — the route ACTS on it', async () => {
  /**
   * This is the single most important number in the scorer, and it has to be
   * asserted on the DECISION rather than on the scoring. `matchIntents`
   * reports every intent with any evidence at all, so it goes on naming
   * `warranty_status` even when the score has dropped below the floor and the
   * route has quietly gone back to answering «لم أفهم طلبك تمامًا» — which is
   * precisely the regression this test exists to catch.
   */
  const db = asD1(seed());
  for (const [message, intent] of [
    ['شنو حالة الضمان', 'warranty_status'],
    ['ما هو ضماني', 'warranty_status'],
    ['اجهزتي المسجلة', 'my_devices'],
    ['شلون استخدم السلايسر', 'studio_help'],
  ] as const) {
    const reply = await ask(db, { text: message });
    assert.equal(reply.intent, intent, `«${message}» must be answered, not clarified`);
  }
});

test('but a stem may not ride inside a long unrelated word', () => {
  const lex = compileLexicon({ mine: { stems: ['جهاز'] } });
  // Four characters of growth is ال + a suffix; beyond that it is a different
  // word that merely contains the letters.
  assert.equal(scoreIntents('جهازي', lex).length, 1);
  assert.equal(scoreIntents('بالجهاز', lex).length, 1);
  assert.equal(scoreIntents('استجهازاتهمونها', lex).length, 0);
});

test('a BROKEN PLURAL is not an inflection, and the lexicon has to say so', () => {
  /**
   * «أجهزة» is the plural of «جهاز» and does not contain it — Arabic builds
   * that plural by reshaping the root, not by adding to the end of the word.
   * No amount of prefix/suffix tolerance reaches it, and pretending otherwise
   * by loosening the containment rule would only let short stems fire inside
   * unrelated words.
   *
   * The honest answer is that a broken plural is its OWN lexicon entry, which
   * is why `my_devices` lists «اجهزتي» beside «جهاز». This test exists so that
   * if somebody ever deletes the second one as "redundant", it fails here
   * rather than on a customer's screen.
   */
  const stemOnly = compileLexicon({ mine: { stems: ['جهاز'] } });
  assert.equal(scoreIntents('اجهزتي', stemOnly).length, 0, 'containment cannot reach a broken plural');
  assert.deepEqual(matchIntents('اجهزتي'), ['my_devices'], 'so the plural is listed in its own right');
});

test('a Latin stem is a whole token or its prefix, never a substring', () => {
  // The old dictionary wrote `' vs '` with spaces to dodge exactly this, and
  // a comment apologising for it. Tokenisation is the real cure.
  assert.deepEqual(matchIntents('the vsync setting'), []);
  assert.deepEqual(matchIntents('these groups of users'), []);
  assert.deepEqual(matchIntents('ups'), ['power_usage']);
  assert.deepEqual(matchIntents('A1 vs P1S'), ['compare_products']);
});

test('a typo is a near miss, and a near miss is a question — not an answer', () => {
  assert.ok(withinOneEdit('warranty', 'waranty'));
  assert.ok(!withinOneEdit('ups', 'groups'));
  assert.ok(!withinOneEdit('order', 'odder2'));
  const lex = compileLexicon({ warranty_status: { stems: ['warranty'] } });
  const decision = decideIntent(scoreIntents('waranty check', lex));
  assert.equal(decision.intent, null, 'a fuzzy hit alone is never acted on');
  assert.deepEqual(decision.shortlist, ['warranty_status'], 'but it IS offered');
});

test('a near miss offers the near miss, not the whole menu', async () => {
  const db = asD1(seed());
  const reply = await ask(db, { text: 'waranty' });
  assert.equal(reply.intent, 'clarify');
  assert.deepEqual(reply.choices.map((c: { intent: string }) => c.intent), ['warranty_status']);
});

test('two topics in one sentence are still asked about, never guessed', () => {
  const lex = compileLexicon({
    a: { stems: ['warranty'] },
    b: { stems: ['points'] },
  });
  const decision = decideIntent(scoreIntents('warranty and points', lex));
  assert.equal(decision.intent, null);
  assert.deepEqual(decision.shortlist.sort(), ['a', 'b']);
});

test('a phrase outweighs a lone word, because it is a whole question', () => {
  const lex = compileLexicon({ price: { phrases: ['كم سعر'] }, other: { stems: ['سعر'] } });
  const scores = scoreIntents('كم سعر الطابعة', lex);
  assert.equal(scores[0].intent, 'price');
  assert.ok(scores[0].score > (scores[1]?.score ?? 0) * 1.5, 'and decisively enough to act on');
});

test('a one-word phrase becomes a stem instead of vanishing', () => {
  // Normalisation strips the spaces from `' vs '`. Filtering "phrases must
  // contain a space" would have discarded it silently — a lexicon entry that
  // does nothing is worse than one that is wrong, because nothing ever fails.
  const lex = compileLexicon({ cmp: { phrases: [' vs '] } });
  assert.deepEqual(lex[0].phrases, []);
  assert.deepEqual(lex[0].stems, [{ text: 'vs', arabic: false }]);
  assert.equal(scoreIntents('a1 vs p1s', lex).length, 1);
});

// ═════════════════════════════════════════════════════════════ entities

test('an order id in the sentence answers about THAT order', async () => {
  const raw = seed();
  raw.prepare("INSERT INTO users (id,name,email,password_hash,role) VALUES ('u_brain','C','c@x.co','h','customer')").run();
  raw
    .prepare(
      `INSERT INTO orders (id,user_id,status,address_snapshot,delivery_method_id,delivery_method_snapshot,
         payment_method_id,subtotal_iqd,exchange_rate,total_iqd,due_on_delivery_iqd,created_at)
       VALUES ('ORD-8F21','u_brain','processing','{}','home','{}','cod',1400000,1400,1400000,0,'2026-01-05T00:00:00Z')`
    )
    .run();
  const db = asD1(raw);
  // «وين طلبي ORD-8F21» used to answer with a picker listing every order on
  // the account, because the id was sitting in the free text unread.
  const reply = await ask(db, { text: 'وين طلبي ORD-8F21' });
  assert.equal(reply.intent, 'order_status');
  assert.match(reply.text, /ORD-8F21/);
  assert.equal(reply.choices?.some((c: { intent: string }) => c.intent === 'order_status'), false, 'not a picker');
});

test('an order id belonging to somebody else is still refused', async () => {
  const raw = seed();
  raw.prepare("INSERT INTO users (id,name,email,password_hash,role) VALUES ('u_someone_else','E','e@x.co','h','customer')").run();
  raw
    .prepare(
      `INSERT INTO orders (id,user_id,status,address_snapshot,delivery_method_id,delivery_method_snapshot,
         payment_method_id,subtotal_iqd,exchange_rate,total_iqd,due_on_delivery_iqd,created_at)
       VALUES ('ORD-9Z99','u_someone_else','processing','{}','home','{}','cod',50000,1400,50000,0,'2026-01-05T00:00:00Z')`
    )
    .run();
  const reply = await ask(asD1(raw), { text: 'وين طلبي ORD-9Z99' });
  // Reading an id out of a sentence grants nothing: ownOrder is still
  // `WHERE id = ? AND user_id = ?`.
  assert.equal(reply.text, 'لم أجد هذا الطلب في حسابك. اختر أحد طلباتك أو تواصل مع الدعم.');
});

test('an order id is read whole, and a bare model number is not one', () => {
  assert.equal(extractOrderId('وين طلبي ORD-8F21 لو سمحت'), 'ORD-8F21');
  assert.equal(extractOrderId('ord 8f21'), 'ORD-8F21');
  assert.equal(extractOrderId('8F21'), null, 'far more likely to be a printer');
});

test('the question comes out and the model name survives it', () => {
  assert.equal(stripWords('شكد سعر A1 combo', ['شكد', 'سعر', 'كم']), 'a1 combo');
  // Whole tokens only: a substring removal would eat the middle of a name.
  assert.equal(stripWords('كم سعر Procombo', ['pro', 'كم', 'سعر']), 'procombo');
});

test('a paragraph is not a product name', () => {
  assert.ok(isLikelyCatalogueLookup('A1 combo'));
  assert.ok(!isLikelyCatalogueLookup(''));
  assert.ok(!isLikelyCatalogueLookup('اريد ان اعرف ماذا يحدث لو ان الطابعة توقفت فجأة اثناء الطباعة'));
});

// ══════════════════════════════════════════════ the fifteen new answers

test('a greeting is met with a greeting, not a fourteen-item menu’s worth of nothing', async () => {
  const db = asD1(seed());
  for (const hello of ['هلو', 'السلام عليكم', 'hi', 'سڵاو']) {
    const reply = await ask(db, { text: hello });
    assert.equal(reply.intent, 'greeting', hello);
    assert.equal(reply.text, 'هلا بيك في ليفونيس. شنو تحتاج؟');
  }
});

test('"are you a robot" is answered honestly and points at a person', async () => {
  const db = asD1(seed());
  const reply = await ask(db, { text: 'هل انت روبوت' });
  assert.equal(reply.intent, 'bot_identity');
  assert.match(reply.text, /برنامج، مو شخص/, 'it says what it is');
  assert.ok(
    reply.choices.some((c: { intent: string }) => c.intent === 'human_handoff'),
    'and how to reach somebody who is not'
  );
});

test('a price question with no product asks which, and remembers asking', async () => {
  const db = asD1(seed());
  const asked = await ask(db, { text: 'كم السعر' });
  assert.equal(asked.intent, 'price_question');
  assert.deepEqual(asked.expects, { intent: 'price_question', slot: 'q' });
  const answered = await ask(db, { text: 'P1S', expects: asked.expects });
  assert.equal(answered.cards[0].title, 'P1S');
  assert.match(answered.cards[0].subtitle, /1,200,000/);
});

test('a price question naming its product answers in one turn', async () => {
  const db = asD1(seed());
  const reply = await ask(db, { text: 'شكد سعر A1 combo' });
  assert.equal(reply.intent, 'price_question');
  assert.equal(reply.cards[0].title, 'A1 Combo');
});

test('the Worker’s Studio origin and the SPA’s cannot drift apart', () => {
  /**
   * TWO CONSTANTS, PINNED EQUAL.
   *
   * check:boundaries forbids worker/ importing from src/ — they are separate
   * programs and either must be deployable without the other — so the Worker
   * cannot read `STUDIO_URL`. tests/store-isolation.test.ts allows exactly
   * that ("the server side cannot import an SPA constant") and keeps the
   * literal out of src/ entirely.
   *
   * What neither rule covers is the two copies disagreeing. If the Studio
   * ever moves, one of them gets edited and the other keeps sending people
   * to an origin that no longer answers — and it would be the support
   * assistant's copy, because nobody visits it while testing the home page.
   * So they are asserted equal here.
   */
  const route = read('worker/routes/support.ts');
  const declared = /^const STUDIO_ORIGIN = '([^']+)';$/m.exec(route)?.[1];
  assert.equal(declared, STUDIO_URL, 'the Worker and the SPA must name the same Studio origin');
  assert.ok(STUDIO_URL.startsWith('https://'));
});

test('the Studio link leaves the app, and says so', async () => {
  const db = asD1(seed());
  const reply = await ask(db, { text: 'شلون استخدم السلايسر' });
  assert.equal(reply.intent, 'studio_help');
  assert.equal(reply.links[0].to, 'https://studio.levonis-iq.com');
  assert.equal(reply.links[0].external, true);
  // A SPA navigate() to another origin is a blank screen, so the client must
  // render an anchor for it.
  assert.match(read('src/pages/Support.tsx'), /l\.external \? \(\s*<a/);
});

test('cancelling is explained and handed over, never performed here', async () => {
  const db = asD1(seed());
  const reply = await ask(db, { text: 'اريد الغاء الطلب' });
  assert.equal(reply.intent, 'cancel_order');
  assert.ok(reply.choices.some((c: { intent: string }) => c.intent === 'open_ticket'));
  // Whether an order can still be cancelled depends on shipping, a wallet hold
  // and a pre-order slot — all decided elsewhere, by code written for it.
  const route = read('worker/routes/support.ts');
  const handler = route.slice(route.indexOf('function handleCancelOrder'), route.indexOf('function handleIdentity'));
  assert.ok(!/UPDATE|DELETE|INSERT/i.test(handler), 'the assistant must not write to an order');
});

test('every intent can be offered as a chip', () => {
  // A shortlist may name anything the scorer knows. Before CHOICE_LABELS the
  // menu was filtered from a 14-row array, so a shortlist naming one of the
  // new intents rendered a clarifying question with NO answers on it.
  const route = read('worker/routes/support.ts');
  const block = route.slice(route.indexOf('const INTENTS = ['), route.indexOf('] as const;\ntype Intent'));
  const intents = [...block.matchAll(/^ {2}'(\w+)',$/gm)].map((m) => m[1]);
  assert.ok(intents.length >= 29, `expected the widened intent list, saw ${intents.length}`);
  const labels = route.slice(route.indexOf('const CHOICE_LABELS'), route.indexOf('const UNCHIPPABLE'));
  for (const intent of intents) {
    assert.match(labels, new RegExp(`^ {2}${intent}: '`, 'm'), `${intent} has no chip label`);
  }
});

test('all three dictionaries carry every new string', () => {
  const route = read('worker/routes/support.ts');
  for (const key of [
    'greeting_reply', 'thanks_reply', 'bot_identity_reply', 'choose_printer_intro', 'choose_printer_none',
    'price_which', 'stock_which', 'materials_which', 'wallet_reply', 'wallet_open', 'studio_reply',
    'studio_open', 'account_reply', 'account_open', 'account_profile', 'cancel_order_reply', 'orders_open',
    'c_choose_printer', 'c_price', 'c_stock', 'c_materials', 'c_shipping_cost', 'c_payment', 'c_offers',
    'c_wallet', 'c_studio', 'c_account', 'c_cancel_order', 'c_contact', 'c_greeting',
  ]) {
    assert.equal(
      (route.match(new RegExp(`^ {4}${key}:`, 'gm')) ?? []).length,
      3,
      `${key} is missing from one of ar / en / ckb`
    );
  }
});

// ═══════════════════════════════════════════════════ still not a model

test('nothing here calls out of the process, and nothing generates text', () => {
  const nlu = read('worker/lib/assistantNlu.ts').replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
  for (const forbidden of ['fetch(', 'openai', 'gemini', 'anthropic', 'http://', 'https://']) {
    assert.ok(!nlu.toLowerCase().includes(forbidden), `the matcher reaches for ${forbidden}`);
  }
  // Deterministic: the same sentence, the same answer, every time.
  const once = matchIntents('warranty and points and ticket');
  for (let i = 0; i < 5; i += 1) assert.deepEqual(matchIntents('warranty and points and ticket'), once);
});

test('the reply is assembled from dictionary literals, never composed', () => {
  const route = read('worker/routes/support.ts');
  // Every new handler's text comes from tr(loc, key). A template literal
  // building a sentence out of fragments is how a translation engine sneaks
  // into a support answer.
  const handlers = route.slice(route.indexOf('const STUDIO_ORIGIN'), route.indexOf('function handleHandoff'));
  const texts = [...handlers.matchAll(/text: ([^,\n]+)/g)].map((m) => m[1].trim());
  for (const expr of texts) {
    assert.ok(
      expr.startsWith('tr(loc') || expr.startsWith('found.text') || expr.startsWith('reply.text'),
      `a reply text that is not a dictionary lookup: ${expr}`
    );
  }
});

// ════════════════════════════════════ «شريط واحد» — one bar, not two

test('the support screen owns its character slot, so the shell stops adding a bar', () => {
  /**
   * «وفي الشريط العلوي اجعل انميشن bloub بجانب كلمه المساعده والدعم بدل من
   *  خلق شريطين يصير شريط واحد.»
   *
   * The shell reserves `lv-character-fallback-header` — a whole 60-72px strip
   * — for any route that registers NO character anchor, and /support
   * registered none. So the character arrived in a bar above the page's own
   * one and the conversation started a header lower on a phone, which is what
   * the owner photographed.
   *
   * `hasPageAnchor()` is the switch, and it counts any anchor whose kind is
   * not `top-fallback`. Claiming the slot inside the existing header is
   * therefore what removes the second bar — the same fix, and the same
   * comment, that src/pages/Settings.tsx already carries.
   */
  const page = read('src/pages/Support.tsx');
  assert.match(page, /<MotionCharacterHome kind="top-header" compact busy=\{busy\} \/>/);
  assert.match(page, /import \{ MotionCharacterHome \} from '\.\.\/components\/bloub\/MotionCharacterAnchor';/);

  // BESIDE THE WORDS, not across the bar from them. The title no longer takes
  // the free space; a spacer after the character does, so the two sit together
  // at the start of the bar.
  const title = page.indexOf('{s.title}</h1>');
  const character = page.indexOf('<MotionCharacterHome');
  assert.ok(title > 0 && character > title, 'the character must follow the title');
  assert.ok(
    !/<h1 className="text-text-primary font-bold text-lg flex-1">/.test(page),
    'a flex-1 title would push the character to the far edge of the bar'
  );
  assert.match(page, /<span className="flex-1" aria-hidden="true" \/>/);

  // And exactly ONE bar: the page must not have grown a second header row.
  assert.equal((page.match(/border-b border-border-subtle bg-canvas\/96/g) ?? []).length, 1);
});

test('the shell’s fallback strip is still what yields — the rule is not copied', () => {
  // If this ever stopped being true, every page that solved the double bar
  // this way would grow its second bar back at once.
  const anchors = read('src/components/bloub/anchors.ts');
  assert.match(anchors, /hasPageAnchor: \(\) => \[\.\.\.anchors\.values\(\)\]\.some\(\(a\) => a\.kind !== 'top-fallback'\)/);
  const shell = read('src/components/bloub/MotionCharacterAnchor.tsx');
  assert.match(shell, /if \(characterLayout\.hasPageAnchor\(\)\) return null;/);
});
