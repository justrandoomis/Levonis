/**
 * WHO MAY MOVE MONEY IN THE SERVICES — the one rule (owner decision 3,
 * DECISIONS row 223; worker/lib/moneyAuthority.ts), as a table.
 *
 *   assistant        never: 403 FINANCIAL_SCOPE_REQUIRED, whatever the amount
 *   financial admin  up to the server's ceiling; above it, or an owner-only
 *                    act, 403 OWNER_REQUIRED
 *   owner            above the ceiling with a recorded reason (400
 *                    OWNER_REASON_REQUIRED without one); owner-only acts
 *
 * Pure: no database.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { moneyAuthority, OWNER_ONLY_ACTS, type MoneyAct } from '../worker/lib/moneyAuthority';
import { HttpError } from '../worker/lib/http';
import { MONEY_AUTHORITY_REFUSALS, moneyAuthorityMessage, PRICE_PROTECTION_OWNER_LINE_IQD } from '../packages/contracts/src/moneyAuthority';
import { refusalText } from '../src/lib/refusalStrings';
import type { Env } from '../worker/lib/types';

const env = { INITIAL_ADMIN_EMAIL: 'boss@x.co' } as unknown as Env;
const verified = '2026-01-01T00:00:00.000Z';
const OWNER = { id: 'boss', role: 'admin', email: 'boss@x.co', admin_scope: null, email_verified_at: verified } as const;
const FULL = { id: 'staff', role: 'admin', email: 'staff@x.co', admin_scope: 'full', email_verified_at: verified } as const;
const LEGACY = { id: 'old', role: 'admin', email: 'old@x.co', admin_scope: null, email_verified_at: verified } as const;
const ASSISTANT = { id: 'helper', role: 'admin', email: 'helper@x.co', admin_scope: 'assistant', email_verified_at: verified } as const;
const CUSTOMER = { id: 'cust', role: 'customer', email: 'c@x.co', admin_scope: null, email_verified_at: verified } as const;

const ACTS: MoneyAct[] = [
  'price_protection_decide',
  'return_refund',
  'trade_in_approve',
  'trade_in_value',
  'trade_in_inspect',
  'trade_in_complete',
  'trade_in_rules',
  'warranty_lengthen',
  'warranty_delivery_later',
  'warranty_replace',
  'warranty_claim_decision',
];

function refusal(fn: () => unknown): { status: number; code: string | undefined; message: string } {
  try {
    fn();
  } catch (e) {
    assert.ok(e instanceof HttpError, String(e));
    return { status: e.status, code: e.code, message: e.message };
  }
  assert.fail('expected a refusal');
}

test('an assistant moves no money: every act, every amount, the same 403', () => {
  for (const act of ACTS) {
    for (const amount of [undefined, 0, 1, 250_000, 10_000_000]) {
      const r = refusal(() => moneyAuthority(env, ASSISTANT as never, { act, amountIqd: amount, ceilingIqd: 1_000_000 }));
      assert.deepEqual([r.status, r.code], [403, 'FINANCIAL_SCOPE_REQUIRED'], `${act} ${amount}`);
    }
  }
  // Nor does a customer, or nobody.
  assert.equal(refusal(() => moneyAuthority(env, CUSTOMER as never, { act: 'return_refund' })).code, 'FINANCIAL_SCOPE_REQUIRED');
  assert.equal(refusal(() => moneyAuthority(env, null, { act: 'return_refund' })).code, 'FINANCIAL_SCOPE_REQUIRED');
});

test('a financial admin acts up to the server’s ceiling and in full where the amount is the server’s own', () => {
  for (const who of [FULL, LEGACY]) {
    const at = moneyAuthority(env, who as never, { act: 'trade_in_value', amountIqd: 520_000, ceilingIqd: 520_000 });
    assert.deepEqual([at.tier, at.above_ceiling], ['financial', false]);
    assert.equal(at.audit.owner_reason, undefined);
    const below = moneyAuthority(env, who as never, { act: 'price_protection_decide', amountIqd: 10_000, ceilingIqd: PRICE_PROTECTION_OWNER_LINE_IQD });
    assert.equal(below.tier, 'financial');
    // A refund of what was paid has no ceiling of its own.
    assert.equal(moneyAuthority(env, who as never, { act: 'return_refund', amountIqd: 9_000_000 }).tier, 'financial');
  }
});

test('above the ceiling, an owner-only act, or the author of the figure: OWNER_REQUIRED for everyone but the owner', () => {
  const above = refusal(() => moneyAuthority(env, FULL as never, { act: 'trade_in_value', amountIqd: 520_001, ceilingIqd: 520_000 }));
  assert.deepEqual([above.status, above.code], [403, 'OWNER_REQUIRED']);
  const line = refusal(() =>
    moneyAuthority(env, FULL as never, { act: 'price_protection_decide', amountIqd: PRICE_PROTECTION_OWNER_LINE_IQD + 1, ceilingIqd: PRICE_PROTECTION_OWNER_LINE_IQD })
  );
  assert.equal(line.code, 'OWNER_REQUIRED');
  const author = refusal(() =>
    moneyAuthority(env, FULL as never, { act: 'price_protection_decide', amountIqd: 1_000, ceilingIqd: PRICE_PROTECTION_OWNER_LINE_IQD, conflictOfInterest: true })
  );
  assert.equal(author.code, 'OWNER_REQUIRED');
  for (const act of OWNER_ONLY_ACTS) {
    assert.equal(refusal(() => moneyAuthority(env, FULL as never, { act })).code, 'OWNER_REQUIRED', act);
    assert.equal(refusal(() => moneyAuthority(env, LEGACY as never, { act })).code, 'OWNER_REQUIRED', act);
  }
  // A ceiling the server could not compute counts as zero: nothing above it passes.
  assert.equal(refusal(() => moneyAuthority(env, FULL as never, { act: 'trade_in_value', amountIqd: 1, ceilingIqd: 0 })).code, 'OWNER_REQUIRED');
});

test('the owner goes above a ceiling only with a recorded reason; owner-only acts need none', () => {
  const none = refusal(() => moneyAuthority(env, OWNER as never, { act: 'trade_in_value', amountIqd: 600_000, ceilingIqd: 520_000 }));
  assert.deepEqual([none.status, none.code], [400, 'OWNER_REASON_REQUIRED']);
  const short = refusal(() => moneyAuthority(env, OWNER as never, { act: 'trade_in_value', amountIqd: 600_000, ceilingIqd: 520_000, reason: ' ok ' }));
  assert.equal(short.code, 'OWNER_REASON_REQUIRED');
  const granted = moneyAuthority(env, OWNER as never, { act: 'trade_in_value', amountIqd: 600_000, ceilingIqd: 520_000, reason: '  حالة ممتازة مع الملحقات  ' });
  assert.deepEqual([granted.tier, granted.above_ceiling], ['owner', true]);
  assert.deepEqual(granted.audit, {
    act: 'trade_in_value',
    tier: 'owner',
    amount_iqd: 600_000,
    ceiling_iqd: 520_000,
    above_ceiling: true,
    conflict_of_interest: false,
    owner_reason: 'حالة ممتازة مع الملحقات',
  });
  for (const act of OWNER_ONLY_ACTS) assert.equal(moneyAuthority(env, OWNER as never, { act }).tier, 'owner', act);
  // Within the ceiling the owner needs no reason either.
  assert.equal(moneyAuthority(env, OWNER as never, { act: 'trade_in_value', amountIqd: 100, ceilingIqd: 520_000 }).above_ceiling, false);
});

test('the owner’s address on an unverified row is not yet the owner', () => {
  const r = refusal(() => moneyAuthority(env, { ...OWNER, email_verified_at: null } as never, { act: 'warranty_lengthen' }));
  assert.deepEqual([r.status, r.code], [403, 'OWNER_EMAIL_UNVERIFIED']);
});

test('a refusal names no amount and no ceiling: the same sentence whatever was asked', () => {
  const a = refusal(() => moneyAuthority(env, FULL as never, { act: 'trade_in_value', amountIqd: 1_500_000, ceilingIqd: 520_000 }));
  const b = refusal(() => moneyAuthority(env, FULL as never, { act: 'trade_in_value', amountIqd: 700_000, ceilingIqd: 690_000 }));
  assert.equal(a.message, b.message);
  assert.equal(a.message, moneyAuthorityMessage('OWNER_REQUIRED'));
  for (const m of [a.message, b.message]) assert.doesNotMatch(m, /\d/);
});

test('every money-authority refusal reads in Arabic, English and real Sorani (row 183)', () => {
  for (const [code, t] of Object.entries(MONEY_AUTHORITY_REFUSALS)) {
    assert.ok(t.ar && t.en && t.ckb, code);
    assert.notEqual(t.ckb, t.ar, `${code}: the Sorani slot copies the Arabic`);
    assert.equal(refusalText(code, 'ckb', '\u0000'), t.ckb, `${code} is not in the client table`);
    assert.equal(refusalText(code, 'ar', '\u0000'), t.ar);
  }
});
