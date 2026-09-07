import { test } from 'node:test';
import assert from 'node:assert/strict';
import { obj, str, int, nonNegInt, bool, nullable, oneOf, arr, isoDate, uuidV7, hex64, ContractViolation, validator, record } from '../src/schema';
import { canonicalJson, canonicalHash, b64url, b64urlDecode, b64urlJson, parseB64urlJson } from '../src/canonical';

test('objects are allowlists: a missing field, an unknown key or a wrong type names the exact path', () => {
  const check = obj({ id: str, qty: int, tags: arr(str, { max: 2 }), meta: obj({ ok: bool }), when: nullable(isoDate), kind: oneOf('a', 'b') });
  const v = validator(check);
  const good = { id: 'x', qty: 1, tags: ['t'], meta: { ok: true }, when: null, kind: 'a' };
  assert.deepEqual(v.parse(good), good);
  assert.ok(v.is(good));
  const err = (value: unknown) => {
    try {
      v.parse(value);
    } catch (e) {
      assert.ok(e instanceof ContractViolation);
      return (e as ContractViolation).message;
    }
    assert.fail('expected a violation');
  };
  assert.match(err({ ...good, extra: 1 }), /^\$\.extra: is not part of the contract/);
  assert.match(err({ ...good, qty: 1.5 }), /^\$\.qty: must be an integer/);
  assert.match(err({ ...good, meta: { ok: 'yes' } }), /^\$\.meta\.ok: must be a boolean/);
  assert.match(err({ ...good, tags: ['a', 'b', 'c'] }), /^\$\.tags: must have at most 2 items/);
  assert.match(err({ ...good, tags: ['a', 2] }), /^\$\.tags\[1\]: must be a string/);
  assert.match(err({ ...good, kind: 'z' }), /^\$\.kind: must be one of a, b/);
  const { when: _w, ...missing } = good;
  assert.match(err(missing), /^\$\.when: is required/);
  assert.match(err(null), /must be an object/);
  assert.match(err([]), /must be an object/);
  assert.ok(!v.is({ ...good, when: 'yesterday' }));
});

test('primitive checks: ids, amounts, dates, uuid v7, hex digests; optional keys', () => {
  assert.equal(nonNegInt(0, '$'), 0);
  assert.throws(() => nonNegInt(-1, '$'), /must be >= 0/);
  assert.equal(isoDate('2026-09-07T10:00:00.000Z', '$'), '2026-09-07T10:00:00.000Z');
  assert.throws(() => isoDate('2026-09-07', '$'), /ISO 8601/);
  assert.equal(uuidV7('01a07b4f-9828-7a89-bc46-ff21490718e3', '$'), '01a07b4f-9828-7a89-bc46-ff21490718e3');
  assert.throws(() => uuidV7('123e4567-e89b-12d3-a456-426614174000', '$'), /UUIDv7/);
  assert.throws(() => hex64('abc', '$'), /64-char/);
  const withOptional = obj({ a: str }, { b: int });
  assert.deepEqual(withOptional({ a: 'x' }, '$'), { a: 'x' });
  assert.deepEqual(withOptional({ a: 'x', b: 2 }, '$'), { a: 'x', b: 2 });
  assert.throws(() => withOptional({ a: 'x', b: 'no' }, '$'), /\$\.b: must be an integer/);
  assert.deepEqual(record(int)({ x: 1 }, '$'), { x: 1 });
  assert.throws(() => record(int, { max: 1 })({ x: 1, y: 2 }, '$'), /at most 1 keys/);
});

test('canonical JSON sorts keys recursively, drops undefined, refuses NaN; base64url round-trips', async () => {
  assert.equal(canonicalJson({ b: 1, a: { d: [3, { z: 1, y: 2 }], c: undefined } }), '{"a":{"d":[3,{"y":2,"z":1}]},"b":1}');
  assert.throws(() => canonicalJson({ n: Number.NaN }), TypeError);
  assert.equal(await canonicalHash({ a: 1, b: 2 }), await canonicalHash({ b: 2, a: 1 }));
  assert.notEqual(await canonicalHash({ a: 1 }), await canonicalHash({ a: 2 }));
  const bytes = new Uint8Array([0, 251, 255, 1, 2]);
  assert.deepEqual([...b64urlDecode(b64url(bytes))], [...bytes]);
  assert.ok(!b64url(bytes).includes('=') && !b64url(bytes).includes('+'));
  assert.deepEqual(parseB64urlJson(b64urlJson({ k: 'v' })), { k: 'v' });
});
