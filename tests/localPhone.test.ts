/**
 * THE ORDER SHEET COPIES THE NUMBER A COURIER TYPES (owner, 2026-09-27: «اجعله
 * ينسخ الرقم بدون 964+ فقط الرقم مثل 07872863792»).
 * src/components/adminOrders/localPhone.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { localIraqiPhone } from '../src/components/adminOrders/localPhone';

test('every spelling of an Iraqi mobile number copies as 07…', () => {
  for (const raw of [
    '+9647872863792',
    '009647872863792',
    '9647872863792',
    '7872863792',
    '07872863792',
    '+964 787 286 3792',
    '+964-787-286-3792',
    '+٩٦٤٧٨٧٢٨٦٣٧٩٢',
    '٠٧٨٧٢٨٦٣٧٩٢',
    '\u200e+9647872863792\u200f',
  ]) {
    assert.equal(localIraqiPhone(raw), '07872863792', raw);
  }
});

test('a number from another country keeps its code; nothing is invented from nothing', () => {
  assert.equal(localIraqiPhone('+971501234567'), '+971501234567');
  assert.equal(localIraqiPhone('+447700900123'), '+447700900123');
  assert.equal(localIraqiPhone(''), '');
  assert.equal(localIraqiPhone(null), '');
  assert.equal(localIraqiPhone('not a phone'), 'not a phone');
});

test('the preparation sheet shows and copies both phones in the local form', () => {
  const src = readFileSync('src/components/adminOrders/OrderDetailModal.tsx', 'utf8');
  assert.match(src, /label=\{loc\('الرقم', 'Phone', 'ژمارە'\)\} value=\{localIraqiPhone\(/);
  assert.match(src, /value=\{localIraqiPhone\(detail\.customer\.account_phone\)\}/);
});
