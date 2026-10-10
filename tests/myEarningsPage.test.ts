/**
 * «أرباحي» WITHOUT «سجل الحركات» (owner request 2026-10-10: «في ارباحي سجل
 * الحركات اخفيها واحذفها لا حاجه للموظف لتتبع الحركات السجل بدقه»).
 *
 * The section is gone from the page AND from the server: the employee's and the
 * investor's page no longer computes or receives a movements list. Nothing in
 * the ledger is touched — wage costs, adjustments, payments and withdrawals stay
 * where they are, and the owner's own views (the staff history sheet, the
 * account earnings read) keep reading them. The API side is pinned in
 * tests/financeEmployment.test.ts (the response has no `movements`).
 *
 * Run: node --import tsx --test tests/myEarningsPage.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { ROOT } from './fixtures/d1';
import { codeOf, sourceOf } from './fixtures/source';

const sources = (dir: string) => (readdirSync(join(ROOT, dir), { recursive: true }) as string[])
  .filter((f) => /\.(ts|tsx|mjs|js)$/.test(f)).map((f) => join(dir, f));

test('the page has no movements log: no title, no list, no running balance, no review note', () => {
  const page = codeOf('src/components/financePeople/MyEarnings.tsx');
  assert.doesNotMatch(page, /سجل الحركات/);
  assert.doesNotMatch(page, /Account activity/);
  assert.doesNotMatch(page, /\bmovements\b/);
  assert.doesNotMatch(page, /history_review_count/);
  assert.doesNotMatch(page, /fp-movement-balance/);
  assert.doesNotMatch(page, /تحتاج مراجعة توزيعها/);
  assert.doesNotMatch(sourceOf('src/components/financePeople/people.css'), /fp-movement-balance/);
});

test('everything else on «أرباحي» stays: balance, sources, batches, withdrawals, the old USD register', () => {
  const page = codeOf('src/components/financePeople/MyEarnings.tsx');
  for (const kept of [/'أرباحي'/, /'متاح للسحب'/, /<EarningsSources /, /'دفعات استثماري'/, /'طلبات السحب'/, /<LegacyInvestmentHistory \/>/, /startWithdrawal\('capital'\)/]) assert.match(page, kept);
});

test('the server no longer builds the log: the module is gone and nothing imports it', () => {
  assert.equal(existsSync(join(ROOT, 'worker/lib/financeAccountHistory.ts')), false);
  const importers = [...sources('worker'), ...sources('src'), ...sources('packages')]
    .filter((f) => !f.includes('node_modules') && /financeAccountHistory|accountMovements/.test(codeOf(f)));
  assert.deepEqual(importers, []);
  const overview = codeOf('worker/lib/financeParticipants.ts');
  assert.doesNotMatch(overview, /\.\.\.history\b/);
});

test("the owner's views of the same account are unchanged", () => {
  // The staff history sheet reads the account summary; the payout screen reads
  // the account earnings. Both are served by participantOverview, as before.
  const routes = codeOf('worker/routes/adminFinancePeople.ts');
  assert.match(routes, /\/staff\/:id\/history'[\s\S]*?participantOverview\(db,person\.user_id\)/);
  assert.match(routes, /\/accounts\/:id\/earnings'[\s\S]*?participantOverview\(c\.env\.DB,c\.req\.param\('id'\)\)/);
  assert.match(codeOf('src/components/financePeople/StaffHistorySheet.tsx'), /data\.account\.summary\.staff_net_iqd/);
});
