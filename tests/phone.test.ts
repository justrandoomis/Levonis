import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizePhone, phonesMatch, maskPhone } from '../worker/lib/phone';

test('Iraqi mobile forms normalize to +9647XXXXXXXXX', () => {
  assert.equal(normalizePhone('07701234567'), '+9647701234567');
  assert.equal(normalizePhone('7701234567'), '+9647701234567');
  assert.equal(normalizePhone('+9647701234567'), '+9647701234567');
  assert.equal(normalizePhone('009647701234567'), '+9647701234567');
  assert.equal(normalizePhone('9647701234567'), '+9647701234567');
  assert.equal(normalizePhone('0770 123 45-67'), '+9647701234567');
});

test('Telegram contact form (no plus) matches site-entered Iraqi form', () => {
  assert.ok(phonesMatch('9647701234567', '07701234567'));
  assert.ok(!phonesMatch('9647701234567', '07701234568'));
});

test('no loose suffix matching — full E.164 equality only', () => {
  assert.ok(!phonesMatch('+15551234567', '+9647551234567'));
});

test('invalid inputs rejected', () => {
  assert.equal(normalizePhone(''), null);
  assert.equal(normalizePhone('abc'), null);
  assert.equal(normalizePhone('+964123'), null); // not an Iraqi mobile shape
  assert.equal(normalizePhone('12345'), null);
});

test('masking keeps prefix and last 3 digits', () => {
  assert.equal(maskPhone('+9647701234567'), '+9647******567');
});
