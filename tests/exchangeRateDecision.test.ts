/**
 * THE OWNER ANSWERED, AND THE ANSWER HAS TO SURVIVE THE ANSWERING.
 *
 * «نعم في سعر الصرف أكمل وأطبق القرار» — 2026-09-23. Row 6 of the decision
 * register had stood at 🟡 «(1400 افتراضيًا)» for months, and a 🟡 on a money
 * path is an invitation to ask the same question a fourth time: the next
 * reader finds a bare `1400` beside a register that still presents the rate
 * as unanswered and cannot tell a decision from a guess.
 *
 * So the answer is recorded in THREE places that must agree, and this file is
 * what makes them agree: the register row, the constant, and the rounding
 * pair the question was actually about («سياسة التقريب الحالية (سقف
 * للسنتات)»). The owner confirmed the policy AS IT STANDS, which means the
 * conservative lean is now a ratified rule rather than an implementation
 * detail somebody could "simplify" to a single Math.round.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ROOT } from './fixtures/d1';
import { SETTING_DEFAULTS } from '../worker/lib/settings';
import { iqdToUsdCents, usdCentsToIqd } from '../worker/lib/escrowOps';
import { corroboratedDeclaredIqd } from '../worker/lib/walletOps';

const RATE = 1400;

test('the confirmed rate is 1,400 IQD to the dollar', () => {
  assert.equal(SETTING_DEFAULTS.exchangeRate, RATE);
});

test('the decision register records row 6 as answered, not as a default', () => {
  const doc = readFileSync(join(ROOT, 'docs/DECISIONS.md'), 'utf8');
  const row = doc.split('\n').find((l) => l.startsWith('| 6 |'));
  assert.ok(row, 'row 6 should still be row 6');
  assert.ok(row.includes('✅'), 'row 6 must read as confirmed');
  assert.ok(
    !row.includes('🟡'),
    'a 🟡 beside an answered question is how the owner gets asked a fourth time'
  );
  assert.ok(row.includes('1,400'), 'the register has to name the figure it confirmed');
  assert.ok(row.includes('لا يُسأل مجددًا'), 'and say plainly that it is closed');
});

/**
 * THE PAIR LEANS ONE WAY. Not a style choice: `iqdToUsdCents` rounding UP is
 * what stops a hold under-reserving, and `usdCentsToIqd` rounding DOWN is what
 * stops a wallet balance being advertised as covering a cart the hold would
 * then refuse. Both rounding up, or both rounding to nearest, reintroduces
 * exactly that last-dinar promise.
 */
test('the rounding the owner ratified: up into cents, down into dinars', () => {
  // 1 IQD is a fraction of a cent: it must not vanish on the reserving side.
  assert.equal(iqdToUsdCents(1, RATE), 1);
  assert.equal(iqdToUsdCents(14, RATE), 1);
  assert.equal(iqdToUsdCents(15, RATE), 2);
  // ...and must not be invented on the spendable side.
  assert.equal(usdCentsToIqd(1, RATE), 14);
  assert.equal(usdCentsToIqd(0, RATE), 0);

  // The round trip never grows: a balance converted out and back cannot come
  // back larger than it went in.
  for (const iqd of [1, 13, 14, 15, 999, 1400, 75_000, 499_000]) {
    assert.ok(
      usdCentsToIqd(iqdToUsdCents(iqd, RATE), RATE) <= iqd + RATE / 100,
      `round trip inflated ${iqd}`
    );
  }
});

/**
 * And the declared-amount corroboration keeps accepting BOTH sides of the
 * fraction, because the client that computed the cents may not have reloaded
 * since the owner last moved the rate. Refusing `floor + 1` would turn a rate
 * change into a wall of failed top-ups.
 */
test('a declared amount is corroborated against floor AND floor + 1', () => {
  const declared = 140_000;
  const floor = Math.floor((declared * 100) / RATE);
  assert.equal(corroboratedDeclaredIqd(declared, floor, RATE).declared_amount_iqd, declared);
  assert.equal(corroboratedDeclaredIqd(declared, floor + 1, RATE).declared_amount_iqd, declared);
  assert.equal(corroboratedDeclaredIqd(declared, floor + 2, RATE).declared_amount_iqd, null);
  assert.equal(corroboratedDeclaredIqd(declared, floor, 0).exchange_rate_snapshot, null);
});
