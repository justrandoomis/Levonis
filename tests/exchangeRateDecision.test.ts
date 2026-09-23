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
 * the question was actually about («سياسة التقريب الحالية (سقف للسنتات)»).
 * The owner has since amended the rounding — the dinar is the source and the
 * dollar floors («الدينار هو الأساس») — and the register says so.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ROOT } from './fixtures/d1';
import { SETTING_DEFAULTS } from '../worker/lib/settings';
import * as escrowOps from '../worker/lib/escrowOps';
import { usdCentsToIqd } from '../worker/lib/escrowOps';
import { corroboratedDeclaredIqd, walletSpendCents } from '../worker/lib/walletOps';
import { iqdToUsdCents } from '../src/lib/api';

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
 * THE ROUNDING, AS THE OWNER LATER AMENDED IT — «الدينار هو الأساس» and
 * «وعند الدولار يقرب الى عدد صحيح اقل». The ceil this row used to ratify
 * (`iqdToUsdCents` in escrowOps, «a hold never under-reserves») asked for
 * 3,572 cents to pay a 50,000 د.ع offer out of the 3,571 that same 50,000 put
 * in. The dollar is now derived from the dinar and FLOORED everywhere, and a
 * wallet spend is floored AND capped at the cents on hand (`walletSpendCents`).
 */
test('the rounding the owner ratified: the dinar is the source, the dollar floors', () => {
  // The typed figure into cents floors: 50,000 د.ع is $35.71, never $35.72.
  assert.equal(iqdToUsdCents(50_000, RATE), 3571);
  assert.equal(iqdToUsdCents(13, RATE), 0);
  assert.equal(iqdToUsdCents(14, RATE), 1);
  // ...and cents back into dinars floors too (a row that recorded no dinars).
  assert.equal(usdCentsToIqd(1, RATE), 14);
  assert.equal(usdCentsToIqd(0, RATE), 0);

  // No ceil survives on the escrow side: the export is gone, so nothing can
  // quietly go back to asking for the extra cent.
  assert.equal((escrowOps as Record<string, unknown>).iqdToUsdCents, undefined);

  // A wallet holding exactly what 50,000 put in can spend 50,000.
  assert.equal(walletSpendCents(50_000, 3571, RATE), 3571);

  // The round trip never grows: a balance converted out and back cannot come
  // back larger than it went in.
  for (const iqd of [1, 13, 14, 15, 999, 1400, 75_000, 499_000]) {
    assert.ok(usdCentsToIqd(iqdToUsdCents(iqd, RATE), RATE) <= iqd, `round trip inflated ${iqd}`);
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
