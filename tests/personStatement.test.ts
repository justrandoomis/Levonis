/**
 * «الحساب باختصار» — THE PERSON STATEMENT (owner request 2026-11-17; DECISIONS row 342).
 *
 *   - its words exist in Arabic, English and real Sorani, key for key (row 183);
 *   - each column of the money flow closes: earned − paid − in a withdrawal
 *     request − waiting (+ any debt line) = left to withdraw, and with the
 *     returned capital = can withdraw now, which is the server's combined total;
 *   - the three screens draw it: the person card (Investors, «أرباحي»), the
 *     staff cards, and a one-line-per-person summary on Staff and Investors.
 *
 * Run: node --import tsx --test tests/personStatement.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PERSON_STATEMENT_STRINGS } from '../src/lib/personStatementStrings';
import { flowColumns } from '../src/components/financePeople/personFlow';
import type { PersonFinance } from '../src/components/financePeople/PersonFinanceView';
import { codeOf } from './fixtures/source';

const SORANI_ONLY = /[ڕڵێۆەڤگچپژ]/;
const ARABIC_ONLY = /[ةىيك]/;
const ARABIC_SCRIPT = /[؀-ۿ]/;
const texts = (o: object) => Object.entries(o).map(([k, v]) => [k, typeof v === 'function' ? (v.length === 2 ? v(3, 7) : v(2)) : v] as [string, string]);

test('the statement is worded in Arabic, English and real Sorani, key for key', () => {
  const ar = new Map(texts(PERSON_STATEMENT_STRINGS.ar));
  assert.deepEqual(texts(PERSON_STATEMENT_STRINGS.en).map(([k]) => k), [...ar.keys()]);
  assert.deepEqual(texts(PERSON_STATEMENT_STRINGS.ckb).map(([k]) => k), [...ar.keys()]);
  for (const [k, v] of ar) assert.match(v, ARABIC_SCRIPT, `ar ${k}`);
  for (const [k, v] of texts(PERSON_STATEMENT_STRINGS.en)) assert.doesNotMatch(v, ARABIC_SCRIPT, `en ${k}`);
  for (const [k, v] of texts(PERSON_STATEMENT_STRINGS.ckb)) {
    assert.doesNotMatch(v, ARABIC_ONLY, `ckb ${k}: ${v}`);
    assert.notEqual(v, ar.get(k), `ckb ${k} is the Arabic`);
    if (v.replace(/[\d\s%·.,:()«»=−-]/g, '').length > 3) assert.match(v, SORANI_ONLY, `ckb ${k}: ${v}`);
  }
});

const person = (over: Partial<PersonFinance> = {}): PersonFinance => ({
  user_id: 'u', name: 'x',
  work: { roles: [], earned_iqd: 1240000, paid_iqd: 900000, available_iqd: 275000, reserved_iqd: 0, held_iqd: 65000, debt_iqd: 0, balance_iqd: 340000, pending_costs: 0, holds: [] },
  investor: { profit: { earned_iqd: 1385000, available_iqd: 225000, reserved_iqd: 150000, paid_iqd: 600000, held_iqd: 410000, debt_iqd: 0 }, capital: { available_iqd: 1200000 } } as unknown as PersonFinance['investor'],
  combined: { earned_iqd: 2625000, paid_iqd: 1500000, reserved_iqd: 150000, held_iqd: 475000, available_earnings_iqd: 500000, available_capital_iqd: 1200000, available_iqd: 1700000 },
  ...over,
});

test('every column closes, and «can withdraw now» is the server total', () => {
  const cols = flowColumns(person(), PERSON_STATEMENT_STRINGS.en);
  assert.deepEqual(cols.map((c) => c.key), ['work', 'invest', 'total']);
  for (const c of cols) assert.equal(c.earned - c.paid - c.reserved - c.held, c.available, c.key);
  assert.equal(cols[2].withdraw, 1700000);
  assert.equal(cols[0].withdraw + cols[1].withdraw, cols[2].withdraw);
  // One source alone: no «total» column.
  assert.deepEqual(flowColumns(person({ investor: null }), PERSON_STATEMENT_STRINGS.en).map((c) => c.key), ['work']);
});

test('a ledger paid beyond its earnings shows the difference on its own line', () => {
  const view = codeOf('src/components/financePeople/PersonStatement.tsx');
  assert.match(codeOf('src/components/financePeople/personFlow.ts'), /export const debtOf = /);
  assert.match(view, /any\(debtOf\) && row\('debt'/);
});

test('the three screens draw the statement and the summaries', () => {
  const card = codeOf('src/components/financePeople/PersonFinanceView.tsx');
  assert.match(card, /<MoneyFlow person=\{person\} \/>/);
  assert.match(card, /<InvestmentsTable person=\{person\} \/>/);
  const staff = codeOf('src/components/financePeople/PeoplePanel.tsx');
  assert.match(staff, /<MoneyFlow person=\{pf\} \/>/);
  assert.match(staff, /t\.staffSummary/);
  assert.match(codeOf('src/components/financePeople/InvestorProfiles.tsx'), /<PeopleSummary title=\{t\.investorSummary\}/);
});
