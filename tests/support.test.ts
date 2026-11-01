/**
 * Unit tests for the deterministic support-assistant intent matcher
 * (worker/routes/support.ts). Pins the §8 semantics: keyword dictionaries
 * only — a single match resolves, ambiguous input yields MULTIPLE matches
 * (the route then answers with clarifying choices, never a guess), and
 * unknown text yields none.
 * Run: npm run test:unit
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  assistantCardFrom,
  contextualChoices,
  matchIntents,
  priceSubtitle,
  RESTRICTABLE_BENEFITS,
  RESTRICTION_CASE_TYPES,
  supportRoutes,
} from '../worker/routes/support';
import { ENTITLEMENT_MINIMUM_TIER } from '../worker/lib/entitlements';
import { asD1, freshDb, json, post, stubApp, type StubUser } from './fixtures/app';
import { ESTIMATE_STRINGS, ESTIMATE_SUPPORT_INTENT, type EstimateLang } from '../packages/contracts/src/priceEstimates';

test('single keyword resolves to exactly one intent (en)', () => {
  assert.deepEqual(matchIntents('what is my warranty?'), ['warranty_status']);
  assert.deepEqual(matchIntents('I forgot my password'), ['password_help']);
});

test('single keyword resolves to exactly one intent (ar)', () => {
  assert.deepEqual(matchIntents('شنو حالة الطلب؟'), ['order_status']);
  assert.deepEqual(matchIntents('اريد استرجاع البضاعة'), ['return_help']);
});

test('ar text touching two topics is ambiguous — clarify, never guess', () => {
  // 'استرجاع' (returns) + 'منتج' (product search) → both dictionaries hit.
  const m = matchIntents('اريد استرجاع المنتج');
  assert.ok(m.includes('return_help'));
  assert.ok(m.includes('product_search'));
});

test('single keyword resolves to exactly one intent (ckb)', () => {
  assert.deepEqual(matchIntents('گەرەنتی چۆنە؟'), ['warranty_status']);
  assert.deepEqual(matchIntents('خاڵەکانم چەندە'), ['points_balance']);
});

test('ambiguous text matches multiple intents — route must clarify, not guess', () => {
  const m = matchIntents('order delivery');
  assert.ok(m.includes('order_status'));
  assert.ok(m.includes('delivery_estimate'));
  assert.ok(m.length >= 2);
});

test('unknown text matches nothing', () => {
  assert.deepEqual(matchIntents('xyzzy blorp'), []);
});

test('matching is deterministic and order-stable', () => {
  const a = matchIntents('warranty and points and ticket');
  const b = matchIntents('warranty and points and ticket');
  assert.deepEqual(a, b);
});

test('restriction allowlists cover the mandated shapes', () => {
  // §10 case taxonomy is exactly the owner's four types.
  assert.deepEqual(
    [...RESTRICTION_CASE_TYPES].sort(),
    ['abuse', 'debt', 'dropshipping_suspected', 'repeated_refusal']
  );
  // Only benefit-computation flags are restrictable (matching the benefit
  // names in worker/lib/entitlements.ts) — never an access-level switch:
  // support/warranty/orders/wallet ACCESS must not be gateable here.
  assert.deepEqual([...RESTRICTABLE_BENEFITS].sort(), Object.keys(ENTITLEMENT_MINIMUM_TIER).sort());
});

test('resolved support answers offer only context-relevant next steps', () => {
  const delivery = contextualChoices('en', 'delivery_estimate').map((choice) => choice.intent);
  assert.deepEqual(delivery, ['order_status', 'human_handoff']);
  assert.ok(!delivery.includes('points_balance'));
  assert.ok(!delivery.includes('warranty_status'));

  const device = contextualChoices('ar', 'my_devices').map((choice) => choice.intent);
  assert.deepEqual(device, ['warranty_status', 'human_handoff']);
  assert.deepEqual(contextualChoices('en', 'clarify'), []);
});

// ═══════════════ «ما معنى السعر التقديري؟» — the `price_estimate` intent
// (docs/SMART_PRICING.md §5.4; DECISIONS row 281). The product page's «تواصل
// معنا لمزيد من المعلومات» opens `/support?ask=price_estimate`.

const LANGS: readonly EstimateLang[] = ['ar', 'en', 'ckb'];
const customer: StubUser = { id: 'u_estimate', role: 'customer', email: 'est@x.co' };
const assistant = async (db: unknown, user: StubUser | null, body: Record<string, unknown>) =>
  (await json(await post(stubApp(db, user, (a) => a.route('/api/support', supportRoutes)), '/api/support/assistant', body))).reply;

test('price_estimate: the contract’s answer for everyone, a guest included, and the team as its one next step', async () => {
  assert.equal(ESTIMATE_SUPPORT_INTENT, 'price_estimate');
  const db = asD1(freshDb());
  for (const locale of LANGS) {
    for (const user of [null, customer]) {
      const reply = await assistant(db, user, { intent: ESTIMATE_SUPPORT_INTENT, locale });
      assert.equal(reply.intent, 'price_estimate');
      assert.equal(reply.text, ESTIMATE_STRINGS.support.answer[locale], `${locale}: the contract's own answer`);
      assert.equal(reply.auth_required, undefined, 'readable without signing in');
      assert.equal(reply.handoff, undefined, 'the answer opens no ticket form by itself');
      assert.deepEqual(reply.choices.map((c: { intent: string }) => c.intent), ['human_handoff']);
      // No figure, source or measure in the answer (invariant I6).
      assert.doesNotMatch(reply.text, /[0-9٠-٩]|IQD|د\.ع|CNY|EUR/);
    }
  }
  assert.deepEqual(contextualChoices('en', 'price_estimate').map((c) => c.intent), ['human_handoff']);
});

test('price_estimate: the team after the answer — a guest is asked to sign in, an account gets the ticket form', async () => {
  const db = asD1(freshDb());
  const guest = await assistant(db, null, { intent: 'human_handoff', locale: 'ar' });
  assert.equal(guest.auth_required, true, 'creating a ticket still needs an account');
  assert.equal(guest.links[0].to, '/auth');
  const signedIn = await assistant(db, customer, { intent: 'human_handoff', locale: 'ar' });
  assert.equal(signedIn.handoff, true);
});

test('price_estimate: typed, the label’s own words ask the question, in three languages — and «سعر» alone still asks a price', async () => {
  for (const [said, locale] of [
    ['شنو يعني سعر تقديري؟', 'ar'],
    ['شنو معنى السعر التقديري', 'ar'],
    ['what does estimated price mean?', 'en'],
    ['نرخی خەمڵێنراو مانای چییە؟', 'ckb'],
  ] as const) {
    assert.equal(matchIntents(said)[0], 'price_estimate', said);
    const db = asD1(freshDb());
    assert.equal((await assistant(db, null, { text: said, locale })).intent, 'price_estimate', said);
  }
  assert.equal(matchIntents('كم سعر A1').includes('price_estimate'), false, 'a price question is not an estimate question');
  assert.equal(matchIntents('متى يوصل طلبي').includes('price_estimate'), false);
});

test('an estimated product’s card in the assistant says so beside the card’s own figure; no other card changes', () => {
  for (const loc of LANGS) {
    const card = { price_status: 'priced', display_price_iqd: 25_000, price_estimate: true, slug: 'pla' };
    const labelled = assistantCardFrom(loc, card, { slug: 'pla' }, 'PLA Basic');
    assert.equal(labelled.subtitle, `${priceSubtitle(loc, 25_000)} · ${ESTIMATE_STRINGS.label[loc]}`);
    assert.equal(labelled.price_iqd, 25_000, 'the figure is the card’s own');
    const plain = assistantCardFrom(loc, { ...card, price_estimate: undefined }, { slug: 'pla' }, 'PLA Basic');
    assert.equal(plain.subtitle, priceSubtitle(loc, 25_000));
  }
  // No price, no label: a catalog-only card and a members-only box say what they always said.
  const unpriced = assistantCardFrom('en', { price_status: 'unpriced', price_iqd: null, price_estimate: true }, { slug: 'x' }, 'X');
  assert.equal(unpriced.subtitle, 'Price not available yet');
  const locked = assistantCardFrom('en', { locked: true, display_price_iqd: 9, price_estimate: true }, { slug: 'b', composition: 'bundle' }, 'Box');
  assert.equal(locked.subtitle, 'Members only');
});
