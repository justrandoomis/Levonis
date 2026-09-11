/**
 * Allowlist lookups keyed by user input must answer only with what the map
 * declares. `ORDERS[sort]` on a plain object answers ?sort=constructor with a
 * builtin function, and when the values are ORDER BY fragments that function's
 * source text lands inside the SQL.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pickFrom } from '../worker/lib/http';

const ORDERS: Record<string, string> = { newest: 'created_at DESC', price_asc: 'price_iqd ASC' };

test('a declared key answers with its value', () => {
  assert.equal(pickFrom(ORDERS, 'price_asc', ORDERS.newest), 'price_iqd ASC');
});

test('a prototype name is not a declared key', () => {
  for (const probe of ['constructor', '__proto__', 'toString', 'hasOwnProperty', 'valueOf', '__defineGetter__']) {
    assert.equal(pickFrom(ORDERS, probe, ORDERS.newest), 'created_at DESC', probe);
  }
});

test('anything that is not a string, or is unknown, is the fallback', () => {
  assert.equal(pickFrom(ORDERS, undefined, 'x'), 'x');
  assert.equal(pickFrom(ORDERS, null, 'x'), 'x');
  assert.equal(pickFrom(ORDERS, ['newest'], 'x'), 'x');
  assert.equal(pickFrom(ORDERS, 'nope', 'x'), 'x');
});
