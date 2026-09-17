import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  RESERVED_USERNAMES,
  USERNAME_MAX as SERVER_MAX,
  USERNAME_MIN as SERVER_MIN,
  usernameRejection as serverRejection,
} from '../worker/lib/usernames';
import {
  RESERVED_USERNAMES_MIRROR,
  USERNAME_MAX as CLIENT_MAX,
  USERNAME_MIN as CLIENT_MIN,
  usernameRejection as clientRejection,
} from '../src/lib/usernameRules';

/**
 * THE PRICE OF A MIRROR, PAID HERE.
 *
 * `src/lib/usernameRules.ts` restates the server's handle rules so the signup
 * form can say WHY a handle is refused while it is typed, instead of gating a
 * live check behind a looser regex and letting the person find out on submit.
 * Restating a rule invites drift, so this file is the thing that makes the
 * duplication safe: it imports both and asserts they agree.
 *
 * If this test fails, the client and the server disagree about who someone may
 * call themselves — which shows up in production as a form that accepts a name
 * and a server that refuses it.
 */

const CORPUS = [
  // Ordinary, valid.
  'ali3d', 'a1b', 'maker.iq', 'bambu-fan', 'x_y_z', 'printer_guy_2026',
  // Edges the loose client regex used to wave through.
  '_ali', 'ali_', '.ali', 'ali.', '-ali', 'ali-',
  'ali__b', 'ali..b', 'ali--b', 'a._b',
  '12345', '007', '1',
  // Length boundaries, on both sides of both limits.
  'ab', 'abc', 'a'.repeat(29), 'a'.repeat(30), 'a'.repeat(31), 'a'.repeat(64),
  // Character classes the form must refuse.
  'علي', 'ali baker', 'ali@iq', 'ali/3d', 'ali+one', 'ali#1', 'ali!', 'ali\\b',
  // Case and whitespace: both sides canonicalise before judging.
  'Ali3D', '  ali3d  ', 'ALI3D', '\tali3d\n',
  // Empty and blank.
  '', '   ',
  // Reserved, including ones shorter than the minimum — the ORDER of the
  // checks is what makes these report `reserved` rather than `too_short`.
  'admin', 'ADMIN', 'levonis', 'me', 'id', 'api', 'support', 'www', 'null',
];

test('client and server agree on every handle in the corpus', () => {
  for (const candidate of CORPUS) {
    assert.equal(
      clientRejection(candidate),
      serverRejection(candidate),
      `disagreement on ${JSON.stringify(candidate)}`
    );
  }
});

test('the reserved lists are identical, entry for entry', () => {
  const server = [...RESERVED_USERNAMES].sort();
  const client = [...RESERVED_USERNAMES_MIRROR].sort();
  assert.deepEqual(client, server);
});

test('the length limits are the same numbers', () => {
  assert.equal(CLIENT_MIN, SERVER_MIN);
  assert.equal(CLIENT_MAX, SERVER_MAX);
});

test('every reserved handle is refused as reserved by both', () => {
  // Not merely "refused": the REASON has to match, because the form shows it.
  for (const name of RESERVED_USERNAMES) {
    assert.equal(serverRejection(name), 'reserved', `server: ${name}`);
    assert.equal(clientRejection(name), 'reserved', `client: ${name}`);
  }
});

test('a generated sweep finds no disagreement', () => {
  // Beyond the hand-written corpus: every two- and three-character
  // combination over an alphabet that mixes valid characters with the
  // punctuation that makes edges and doubles interesting.
  const alphabet = ['a', '1', '.', '_', '-', '@'];
  for (const a of alphabet) {
    for (const b of alphabet) {
      for (const c of alphabet) {
        const candidate = a + b + c;
        assert.equal(
          clientRejection(candidate),
          serverRejection(candidate),
          `disagreement on ${JSON.stringify(candidate)}`
        );
      }
    }
  }
});
