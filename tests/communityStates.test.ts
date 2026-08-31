/**
 * The lifecycle rules, and the one race that decides whether the marketplace
 * is trustworthy: two acceptances on one request.
 *
 * The transition tables are declared as data, so these tests assert the
 * SHAPE of the lifecycle rather than re-listing it — that every terminal
 * state is genuinely terminal, that no path leads backwards out of a settled
 * state, and that every state named in the table exists. A test that just
 * repeated the table would pass even if the table were wrong.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ROOT } from './fixtures/d1';
import {
  REQUEST_STATES,
  REQUEST_TRANSITIONS,
  REQUEST_OPEN_STATES,
  canMoveRequest,
  requestStatusFor,
  OFFER_STATES,
  OFFER_TRANSITIONS,
  canMoveOffer,
  offerIsEditable,
  COMMUNITY_ORDER_STATES,
  COMMUNITY_ORDER_TRANSITIONS,
  canMoveCommunityOrder,
  cancellationPolicy,
  orderIsActive,
  orderIsSettled,
  type RequestState,
  type OfferState,
  type CommunityOrderState,
} from '../worker/lib/communityStates';

// ------------------------------------------------------- structural checks

test('every transition target is a real state', () => {
  // Guards against a typo in the table that would silently make a transition
  // impossible — `canMove` would return false and a route would refuse a move
  // that is supposed to be legal.
  for (const [from, tos] of Object.entries(REQUEST_TRANSITIONS)) {
    for (const to of tos) assert.ok(REQUEST_STATES.includes(to), `request ${from} -> unknown ${to}`);
  }
  for (const [from, tos] of Object.entries(OFFER_TRANSITIONS)) {
    for (const to of tos) assert.ok(OFFER_STATES.includes(to), `offer ${from} -> unknown ${to}`);
  }
  for (const [from, tos] of Object.entries(COMMUNITY_ORDER_TRANSITIONS)) {
    for (const to of tos) assert.ok(COMMUNITY_ORDER_STATES.includes(to), `order ${from} -> unknown ${to}`);
  }
});

test('every state has an entry in its transition table', () => {
  for (const s of REQUEST_STATES) assert.ok(REQUEST_TRANSITIONS[s], `request state ${s} has no entry`);
  for (const s of OFFER_STATES) assert.ok(OFFER_TRANSITIONS[s], `offer state ${s} has no entry`);
  for (const s of COMMUNITY_ORDER_STATES) assert.ok(COMMUNITY_ORDER_TRANSITIONS[s], `order state ${s} has no entry`);
});

test('a settled transaction is finished — money cannot move again', () => {
  // completed / cancelled / refunded are terminal by design. Reopening one
  // would mean money that has already settled could move a second time.
  assert.deepEqual(REQUEST_TRANSITIONS.completed, []);
  assert.deepEqual(REQUEST_TRANSITIONS.cancelled, []);
  assert.deepEqual(COMMUNITY_ORDER_TRANSITIONS.completed, []);
  assert.deepEqual(COMMUNITY_ORDER_TRANSITIONS.cancelled, []);
  assert.deepEqual(COMMUNITY_ORDER_TRANSITIONS.refunded, []);
});

test('an accepted offer is frozen in every direction', () => {
  // §26: once accepted, the price and the promise ARE the contract. There is
  // no path back to pending, so a merchant cannot revise what they owe after
  // the customer committed.
  assert.deepEqual(OFFER_TRANSITIONS.accepted, []);
  assert.equal(offerIsEditable('accepted'), false);
  assert.equal(offerIsEditable('pending'), true);
  for (const s of OFFER_STATES) {
    if (s !== 'pending') assert.equal(offerIsEditable(s), false, `${s} offers must not be editable`);
  }
});

test('the coarse status mirrors the real state for pre-lifecycle readers', () => {
  // 0001's `status` column only knows open/closed. It is kept in step so a
  // reader that predates the lifecycle is never lied to.
  for (const s of REQUEST_STATES) {
    const expected = REQUEST_OPEN_STATES.includes(s) ? 'open' : 'closed';
    assert.equal(requestStatusFor(s), expected, `${s} mirrors wrongly`);
  }
  assert.equal(requestStatusFor('open'), 'open');
  assert.equal(requestStatusFor('receiving_offers'), 'open');
  assert.equal(requestStatusFor('in_progress'), 'closed', 'work under way is not still taking offers');
});

test('a request can reach acceptance from either open state', () => {
  assert.equal(canMoveRequest('open', 'receiving_offers'), true);
  assert.equal(canMoveRequest('receiving_offers', 'offer_selected'), true);
  // And cannot jump the queue.
  assert.equal(canMoveRequest('open', 'completed'), false);
  assert.equal(canMoveRequest('completed', 'open'), false);
  assert.equal(canMoveRequest('cancelled', 'open'), false);
});

test('marking work delivered is not the same as being paid', () => {
  // §33. The merchant's own action moves the order to "delivered"; only the
  // customer's confirmation moves it to confirmed. There is no merchant path
  // straight to completed.
  assert.equal(canMoveCommunityOrder('in_progress', 'merchant_marked_delivered'), true);
  assert.equal(canMoveCommunityOrder('merchant_marked_delivered', 'completed'), false);
  assert.equal(canMoveCommunityOrder('merchant_marked_delivered', 'customer_confirmed'), true);
  assert.equal(canMoveCommunityOrder('customer_confirmed', 'completed'), true);
  assert.equal(canMoveCommunityOrder('in_progress', 'completed'), false);
});

test('a delivered order can go back to in-progress if the customer says it is not done', () => {
  // Without this the only way to reject bad work is a formal dispute, which
  // is a heavy answer to "you missed a part".
  assert.equal(canMoveCommunityOrder('merchant_marked_delivered', 'in_progress'), true);
});

test('cancellation follows the work, not the calendar', () => {
  // Before work starts, walking away costs nobody anything.
  for (const s of ['accepted', 'funded'] as CommunityOrderState[]) {
    const p = cancellationPolicy(s);
    assert.equal(p.allowed, true);
    assert.ok(p.by.includes('customer') && p.by.includes('merchant'));
    assert.equal(p.refund, 'full');
  }
  // Once work is under way it imposes a real loss on the other side, so it
  // becomes an admin decision — not a button either party can press.
  for (const s of ['in_progress', 'merchant_marked_delivered', 'disputed'] as CommunityOrderState[]) {
    const p = cancellationPolicy(s);
    assert.deepEqual([...p.by], ['admin'], `${s} should be admin-only`);
    assert.equal(p.refund, 'decided_by_admin');
  }
  // A settled order cannot be cancelled at all.
  for (const s of ['completed', 'cancelled', 'refunded'] as CommunityOrderState[]) {
    assert.equal(cancellationPolicy(s).allowed, false, `${s} was cancellable`);
  }
});

test('active and settled are complementary and cover the real states', () => {
  for (const s of COMMUNITY_ORDER_STATES) {
    assert.ok(!(orderIsActive(s) && orderIsSettled(s)), `${s} is both active and settled`);
  }
  assert.equal(orderIsActive('in_progress'), true);
  assert.equal(orderIsActive('disputed'), true, 'a dispute is live work, not a settled outcome');
  assert.equal(orderIsSettled('refunded'), true);
});

// ---------------------------------------------------- the acceptance race

/**
 * The guard that makes acceptance atomic, exercised as SQL.
 *
 * The route wins the right to accept with a conditional UPDATE requiring the
 * request to still be open. This proves the second attempt changes zero rows
 * — which is what the route branches on — rather than trusting a read-then-
 * write in JavaScript that a concurrent request could interleave with.
 */
test('only one acceptance can win a request, even when two arrive', () => {
  const db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys = ON;');
  for (const f of readdirSync(join(ROOT, 'migrations')).filter((x) => x.endsWith('.sql')).sort()) {
    db.exec(readFileSync(join(ROOT, 'migrations', f), 'utf8'));
  }
  db.exec(`
    INSERT INTO users (id,name,email,password_hash) VALUES
      ('buyer','S','s@x.co','h'),('a','A','a@x.co','h'),('b','B','b@x.co','h');
    INSERT INTO community_merchants (id,user_id,name) VALUES ('m1','a','Ali'),('m2','b','Zain');
    INSERT INTO community_requests (id,customer_id,title,state,status)
      VALUES ('r1','buyer','Print','receiving_offers','open');
    INSERT INTO community_offers (id,request_id,merchant_id,price_iqd) VALUES
      ('o1','r1','m1',50000), ('o2','r1','m2',40000);
  `);

  const accept = (offerId: string) =>
    db
      .prepare(
        `UPDATE community_requests
            SET state='offer_selected', status='closed', accepted_offer_id=?
          WHERE id='r1' AND customer_id='buyer' AND state IN ('open','receiving_offers')`
      )
      .run(offerId).changes;

  assert.equal(accept('o1'), 1, 'the first acceptance should win');
  assert.equal(accept('o2'), 0, 'a second acceptance created a competing contract');

  const r = db.prepare('SELECT accepted_offer_id, state FROM community_requests WHERE id=?').get('r1') as {
    accepted_offer_id: string;
    state: string;
  };
  assert.equal(r.accepted_offer_id, 'o1', 'the loser overwrote the winner');
  assert.equal(r.state, 'offer_selected');

  // And the database itself allows only one community order per offer, so
  // even a route that skipped the guard could not produce two contracts.
  db.exec(
    `INSERT INTO community_orders
       (id,request_id,offer_id,customer_id,merchant_id,price_iqd,platform_fee_iqd,merchant_receivable_iqd)
     VALUES ('co1','r1','o1','buyer','m1',50000,5000,45000)`
  );
  assert.throws(
    () =>
      db.exec(
        `INSERT INTO community_orders
           (id,request_id,offer_id,customer_id,merchant_id,price_iqd,platform_fee_iqd,merchant_receivable_iqd)
         VALUES ('co2','r1','o1','buyer','m1',50000,5000,45000)`
      ),
    /.*/,
    'two community orders were created for one offer'
  );
});
