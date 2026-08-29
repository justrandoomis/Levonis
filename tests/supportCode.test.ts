/**
 * Support codes, share links and the filament-gift rule — integrated mandate
 * §3.1 / §3.3 / §3.4, pinning acceptance tests REF-03 … REF-07 (§14.2).
 *
 * These cover the decision logic, not the SQL: the atomicity guarantees
 * (UNIQUE(order_id), the conditional pending → due UPDATE) are enforced by
 * migration 0016 and by single-statement writes in membershipOps.ts.
 * Run: npm run test:unit
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  normalizeSupportRef,
  parseSupportSnapshot,
  inviteRefPath,
  productSupportPath,
} from '../worker/lib/supportCode';
import {
  decideSupportGift,
  supportGiftTransitionAllowed,
  SUPPORT_GIFT_STATES,
  type SupportGiftFacts,
} from '../worker/lib/membershipOps';
import {
  captureSupportRef,
  captureSupportRefFromSearch,
  chooseSupportRef,
  removeSupportRef,
  clearSupportRef,
  readSupportRefState,
  inviteLinkFor,
  productShareLink,
  SUPPORT_REF_TTL_MS,
  type RefStore,
} from '../src/pages/Referrals';

// --------------------------------------------------------------- ref shapes

test('a ref is normalized to one canonical handle before anything uses it', () => {
  assert.equal(normalizeSupportRef('  @Ammar '), 'Ammar');
  assert.equal(normalizeSupportRef('ammar'), 'ammar');
  assert.equal(normalizeSupportRef('A1B2C3D4'), 'A1B2C3D4'); // legacy code shape
  assert.equal(normalizeSupportRef('https://levonis-iq.com/auth?ref=ammar'), 'ammar');
  assert.equal(normalizeSupportRef('https://levonis-iq.com/product/x9?ref=@ammar'), 'ammar');
  // A pasted profile link with no ?ref= falls back to its last segment.
  assert.equal(normalizeSupportRef('https://levonis-iq.com/u/ammar'), 'ammar');
});

test('unusable input is "no support code", never a stored half-value', () => {
  assert.equal(normalizeSupportRef(''), '');
  assert.equal(normalizeSupportRef('   '), '');
  assert.equal(normalizeSupportRef(undefined), '');
  assert.equal(normalizeSupportRef(42), '');
  assert.equal(normalizeSupportRef('ammar hussein'), ''); // spaces cannot be a handle
  assert.equal(normalizeSupportRef('<script>'), '');
  assert.equal(normalizeSupportRef('a'.repeat(61)), '');
  assert.equal(normalizeSupportRef('not a url://'), '');
});

test('a snapshot without a referrer id is no attribution at all', () => {
  assert.equal(parseSupportSnapshot(null), null);
  assert.equal(parseSupportSnapshot(''), null);
  assert.equal(parseSupportSnapshot('{'), null);
  assert.equal(parseSupportSnapshot('{"referrer_username":"ammar"}'), null);
  assert.deepEqual(parseSupportSnapshot('{"referrer_user_id":"u1","referrer_username":"ammar","ref":"ammar"}'), {
    referrer_user_id: 'u1',
    referrer_username: 'ammar',
    ref: 'ammar',
  });
});

// -------------------------------------------------------------- REF-01/link

test('the invite link is a path plus the CURRENT origin — never a hardcoded host', () => {
  assert.equal(inviteRefPath('Ammar'), '/auth?ref=ammar');
  assert.equal(inviteRefPath(''), '');
  assert.equal(inviteLinkFor('Ammar', 'https://levonis-iq.com'), 'https://levonis-iq.com/auth?ref=ammar');
  assert.equal(inviteLinkFor('ammar', 'http://localhost:5173'), 'http://localhost:5173/auth?ref=ammar');
  // A trailing slash on the origin must not produce a double slash.
  assert.equal(inviteLinkFor('ammar', 'https://levonis-iq.com/'), 'https://levonis-iq.com/auth?ref=ammar');
});

test('a product share link keeps the REAL product path and its query/hash', () => {
  assert.equal(productSupportPath('/product/bambu-a1', 'Ammar'), '/product/bambu-a1?ref=ammar');
  assert.equal(productSupportPath('/product/bambu-a1?v=2', 'ammar'), '/product/bambu-a1?v=2&ref=ammar');
  assert.equal(productSupportPath('/product/bambu-a1#specs', 'ammar'), '/product/bambu-a1?ref=ammar#specs');
  // A guest (no handle) shares the plain product link — never an anonymous ref.
  assert.equal(productSupportPath('/product/bambu-a1', ''), '/product/bambu-a1');
  // The path must come from the app; nothing is guessed here.
  assert.equal(productSupportPath('bambu-a1', 'ammar'), '');
  assert.equal(
    productShareLink('/product/bambu-a1', 'Ammar', 'https://levonis-iq.com'),
    'https://levonis-iq.com/product/bambu-a1?ref=ammar'
  );
});

// ------------------------------------------------- REF-03 / REF-05 (browser)

function fakeStore(): RefStore & { data: Map<string, string> } {
  const data = new Map<string, string>();
  return {
    data,
    getItem: (k) => (data.has(k) ? (data.get(k) as string) : null),
    setItem: (k, v) => void data.set(k, v),
    removeItem: (k) => void data.delete(k),
  };
}

test('REF-03: opening a ref link stores the code; a removal survives re-reads and re-visits', () => {
  const store = fakeStore();
  const now = 1_000_000;

  let state = captureSupportRefFromSearch('?ref=ammar', { store, now, product: '/product/bambu-a1' });
  assert.equal(state.current?.ref, 'ammar');
  assert.equal(state.current?.source, 'link');

  // A refresh / remount re-reads the same stored code.
  assert.equal(readSupportRefState(now + 1000, store).current?.ref, 'ammar');

  // The user removes it…
  state = removeSupportRef({ store, now: now + 2000 });
  assert.equal(state.current, null);
  assert.deepEqual(state.dismissed, ['ammar']);

  // …and re-opening the SAME link (a refresh, a back-navigation, another
  // render) must NOT push it back in.
  state = captureSupportRefFromSearch('?ref=ammar', { store, now: now + 3000 });
  assert.equal(state.current, null);
  assert.equal(readSupportRefState(now + 4000, store).current, null);
});

test('REF-03: a removed code can be added again — but only by the user typing it', () => {
  const store = fakeStore();
  const now = 2_000_000;
  captureSupportRef('ammar', { store, now, source: 'link' });
  removeSupportRef({ store, now });
  const state = captureSupportRef('ammar', { store, now, source: 'manual' });
  assert.equal(state.current?.ref, 'ammar');
  assert.equal(state.current?.source, 'manual');
  assert.deepEqual(state.dismissed, []);
});

test('REF-05: a second, different link never replaces the beneficiary silently', () => {
  const store = fakeStore();
  const now = 3_000_000;
  captureSupportRef('ammar', { store, now, source: 'link' });
  const state = captureSupportRef('sara', { store, now: now + 60_000, source: 'link' });

  // Both are kept; the cart must ask which one to support.
  assert.equal(state.current?.ref, 'ammar');
  assert.equal(state.conflict?.ref, 'sara');

  const chosen = chooseSupportRef('sara', { store, now: now + 90_000 });
  assert.equal(chosen.current?.ref, 'sara');
  assert.equal(chosen.conflict, null);
});

test('re-opening the SAME creator link is not a second attribution', () => {
  const store = fakeStore();
  const now = 4_000_000;
  captureSupportRef('ammar', { store, now, source: 'link' });
  const again = captureSupportRef('AMMAR', { store, now: now + 5_000, source: 'link' });
  assert.equal(again.current?.ref, 'ammar');
  assert.equal(again.conflict, null);
});

test('a manual entry wins over a link capture without creating a conflict', () => {
  const store = fakeStore();
  const now = 5_000_000;
  captureSupportRef('ammar', { store, now, source: 'link' });
  const manual = captureSupportRef('@Sara', { store, now: now + 10, source: 'manual' });
  assert.equal(manual.current?.ref, 'Sara');
  assert.equal(manual.conflict, null);
});

test('the carry-over is expiry-bounded — a stale tab cannot attribute tomorrow’s order', () => {
  const store = fakeStore();
  const now = 6_000_000;
  captureSupportRef('ammar', { store, now, source: 'link' });
  assert.equal(readSupportRefState(now + SUPPORT_REF_TTL_MS - 1, store).current?.ref, 'ammar');
  assert.equal(readSupportRefState(now + SUPPORT_REF_TTL_MS + 1, store).current, null);
});

test('storage that is unavailable or corrupt degrades to "no support code"', () => {
  assert.equal(readSupportRefState(Date.now(), null).current, null);
  const store = fakeStore();
  store.data.set('levo_support_ref_v1', 'not json');
  assert.equal(readSupportRefState(Date.now(), store).current, null);
  const blocked: RefStore = {
    getItem: () => {
      throw new Error('blocked');
    },
    setItem: () => {
      throw new Error('blocked');
    },
    removeItem: () => {
      throw new Error('blocked');
    },
  };
  assert.equal(readSupportRefState(Date.now(), blocked).current, null);
  assert.doesNotThrow(() => captureSupportRef('ammar', { store: blocked }));
  assert.doesNotThrow(() => clearSupportRef({ store: blocked }));
});

test('clearing after a placed order wipes the pending code entirely', () => {
  const store = fakeStore();
  captureSupportRef('ammar', { store, now: 7_000_000, source: 'link' });
  clearSupportRef({ store });
  assert.equal(store.data.size, 0);
});

// ---------------------------------------------------------- REF-06 / REF-07

const facts = (over: Partial<SupportGiftFacts> = {}): SupportGiftFacts => ({
  hasSnapshot: true,
  selfSupport: false,
  hasEligibleLine: true,
  orderCancelled: false,
  delivered: true,
  collectedIqd: 500_000,
  totalIqd: 500_000,
  ...over,
});

test('REF-06: an eligible printer, delivered AND paid, qualifies the referrer', () => {
  const d = decideSupportGift(facts());
  assert.equal(d.attributable, true);
  assert.equal(d.qualifies, true);
  assert.equal(d.blocker, null);
});

test('REF-06: unpaid, undelivered or non-eligible orders never qualify', () => {
  assert.deepEqual(decideSupportGift(facts({ delivered: false })), {
    attributable: true,
    qualifies: false,
    blocker: 'not_delivered',
  });
  // Delivery is not collection: a delivered COD with nothing collected waits.
  assert.equal(decideSupportGift(facts({ collectedIqd: 0 })).blocker, 'payment_not_settled');
  // Partial collection is still not settlement.
  assert.equal(decideSupportGift(facts({ collectedIqd: 499_999 })).blocker, 'payment_not_settled');
  assert.equal(decideSupportGift(facts({ hasEligibleLine: false })).blocker, 'no_eligible_line');
  assert.equal(decideSupportGift(facts({ hasSnapshot: false })).blocker, 'no_support_snapshot');
});

test('REF-06: collecting the balance later qualifies it then — no new waiting period', () => {
  const cod = facts({ collectedIqd: 0 });
  assert.equal(decideSupportGift(cod).qualifies, false);
  // Day 9, the courier hands the cash over: the same facts now qualify. No
  // PRO tier and no seven-day clock appear anywhere in this decision.
  assert.equal(decideSupportGift({ ...cod, collectedIqd: cod.totalIqd }).qualifies, true);
});

test('a zero-total order (fully covered by wallet/points) is settled by definition', () => {
  assert.equal(decideSupportGift(facts({ totalIqd: 0, collectedIqd: 0 })).qualifies, true);
});

test('REF-07: self-support and cancelled orders are not attributable at all', () => {
  const self = decideSupportGift(facts({ selfSupport: true }));
  assert.equal(self.attributable, false);
  assert.equal(self.blocker, 'self_support');

  const cancelled = decideSupportGift(facts({ orderCancelled: true }));
  assert.equal(cancelled.attributable, false);
  assert.equal(cancelled.blocker, 'order_cancelled');
});

test('REF-07: the gift state machine is forward-only and a paid gift is final', () => {
  assert.deepEqual([...SUPPORT_GIFT_STATES], ['pending_eligibility', 'due', 'reserved', 'paid', 'cancelled']);

  assert.equal(supportGiftTransitionAllowed('pending_eligibility', 'due'), true);
  assert.equal(supportGiftTransitionAllowed('due', 'reserved'), true);
  assert.equal(supportGiftTransitionAllowed('reserved', 'paid'), true);

  // No skipping a step (no "reserved" without a due claim, no payout without stock).
  assert.equal(supportGiftTransitionAllowed('pending_eligibility', 'reserved'), false);
  assert.equal(supportGiftTransitionAllowed('due', 'paid'), false);
  // No going backwards, no re-paying, no reopening.
  assert.equal(supportGiftTransitionAllowed('paid', 'reserved'), false);
  assert.equal(supportGiftTransitionAllowed('paid', 'cancelled'), false);
  assert.equal(supportGiftTransitionAllowed('cancelled', 'due'), false);
  assert.equal(supportGiftTransitionAllowed('due', 'due'), false);
  // Any LIVE state may be cancelled.
  assert.equal(supportGiftTransitionAllowed('pending_eligibility', 'cancelled'), true);
  assert.equal(supportGiftTransitionAllowed('due', 'cancelled'), true);
  assert.equal(supportGiftTransitionAllowed('reserved', 'cancelled'), true);
});
