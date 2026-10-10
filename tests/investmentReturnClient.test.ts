/**
 * THE INVESTMENT REMAINDER ON SCREEN (owner request 2026-10-10): the purchase
 * card's footer estimate, the saved purchase's funding block, the confirm guard,
 * «المستثمرون», and the investor's «أرباحي» — every word in Arabic, English and
 * real Sorani (DECISIONS row 183). The server decides the money
 * (tests/purchaseSurplusReturn.test.ts); these screens word it.
 *
 * Run: node --import tsx --test tests/investmentReturnClient.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { INVESTMENT_RETURN_STRINGS, fundingReturnEstimate, investmentReturnStrings, investorReturnView } from '../src/lib/investmentReturn';
import { codeOf } from './fixtures/source';

// The screens import their stylesheets (src/components/financePeople/shared.tsx),
// which node cannot load: the pure helpers they render from are tested here, and
// the source checks below hold the screens to them.
const S = INVESTMENT_RETURN_STRINGS.ar, K = INVESTMENT_RETURN_STRINGS.ckb;

test("the footer estimate is the server's own sums: the owner's 146,178, waiting for the cash or not", () => {
  // 13,000,000 agreed, 12,853,822 landed, nothing received yet: 146,178 returns once the cash is recorded.
  assert.deepEqual(fundingReturnEstimate(13_000_000, 0, 12_853_822), { allocated: 12_853_822, return_total_iqd: 146_178, cash_backed_iqd: 0, awaits_cash: true });
  // Received in the confirm form: withdrawable in the same confirm.
  assert.deepEqual(fundingReturnEstimate(13_000_000, 13_000_000, 12_853_822), { allocated: 12_853_822, return_total_iqd: 146_178, cash_backed_iqd: 146_178, awaits_cash: false });
  // Part of the cash: part of the remainder now, the rest when it arrives.
  assert.deepEqual(fundingReturnEstimate(13_000_000, 12_900_000, 12_853_822), { allocated: 12_853_822, return_total_iqd: 146_178, cash_backed_iqd: 46_178, awaits_cash: true });
  // More cash than agreed: all of it beyond the cost returns.
  assert.equal(fundingReturnEstimate(13_000_000, 13_500_000, 12_853_822).return_total_iqd, 646_178);
  // No remainder: agreed = landed, or below it (the store contributes).
  assert.equal(fundingReturnEstimate(12_853_822, 0, 12_853_822).return_total_iqd, 0);
  assert.equal(fundingReturnEstimate(10_000_000, 10_000_000, 12_853_822).return_total_iqd, 0);
  assert.equal(fundingReturnEstimate(10_000_000, 10_000_000, 12_853_822).awaits_cash, false);
  // A half-typed form never shows a figure that is not a number.
  assert.equal(fundingReturnEstimate(Number(''), Number(''), 12_853_822).return_total_iqd, 0);
  assert.equal(fundingReturnEstimate(Number.NaN, 0, Number.NaN).return_total_iqd, 0);
});

test('every word exists in ar, en and ckb; the Sorani is its own sentence, in Sorani letters', () => {
  const keys = Object.keys(S) as (keyof typeof S)[];
  for (const lang of ['en', 'ckb'] as const) assert.deepEqual(Object.keys(INVESTMENT_RETURN_STRINGS[lang]).sort(), [...keys].sort(), lang);
  for (const key of keys) {
    const ar = S[key], en = INVESTMENT_RETURN_STRINGS.en[key], ckb = K[key];
    assert.ok(ar && en && ckb, key);
    assert.notEqual(ckb, ar, `${key}: the ckb slot copies the Arabic`);
    assert.doesNotMatch(en, /[؀-ۿ]/, `${key}: the English carries Arabic script`);
    assert.doesNotMatch(ckb, /[ةىيك]/, `${key}: the ckb uses an Arabic-only letter`);
  }
  // The money's words: returned capital in «أرباحي», never the customer wallet's «محفظتك».
  for (const key of ['heroCapital', 'sourcesSurplus', 'batchesReturned', 'batchesPending'] as const) assert.doesNotMatch(S[key], /محفظتك/, key);
  assert.match(S.footerRow, /محفظة أرباح المستثمر/, 'the owner’s words: the investor’s profits wallet');
});

test('«أرباحي» shows the returned remainder only where there is one: hero line, sources sub-row, batch notes', () => {
  // Nothing returned, nothing pending, no batches: no line and no «دفعات استثماري».
  assert.deepEqual(investorReturnView({ capital_available_iqd: 0, capital_surplus_iqd: 0 }, { unallocated_iqd: 0, batches: [] }),
    { hero_capital_iqd: 0, sources_surplus_iqd: 0, batches_returned_iqd: 0, batches_pending_iqd: 0, show_batches: false });
  // Confirmed without the cash: pending on «دفعات استثماري» only, nothing withdrawable.
  assert.deepEqual(investorReturnView({ capital_available_iqd: 0, capital_surplus_iqd: 0 }, { returned_surplus_iqd: 0, pending_surplus_iqd: 146_178, batches: [] }),
    { hero_capital_iqd: 0, sources_surplus_iqd: 0, batches_returned_iqd: 0, batches_pending_iqd: 146_178, show_batches: true });
  // Cash recorded: the hero line, the sub-row and the batch note all read 146,178.
  assert.deepEqual(investorReturnView({ capital_available_iqd: 146_178, capital_surplus_iqd: 146_178 }, { returned_surplus_iqd: 146_178, pending_surplus_iqd: 0, batches: [{}] }),
    { hero_capital_iqd: 146_178, sources_surplus_iqd: 146_178, batches_returned_iqd: 146_178, batches_pending_iqd: 0, show_batches: true });
  // An older response (no new fields) reads the received-unallocated figure, and no response reads zero.
  assert.equal(investorReturnView({}, { unallocated_iqd: 200_000 }).batches_returned_iqd, 200_000);
  assert.equal(investorReturnView(undefined, undefined).show_batches, false);
  // The Sorani screen gets the Sorani words.
  assert.equal(investmentReturnStrings('ckb').sourcesSurplus, K.sourcesSurplus);
  assert.equal(investmentReturnStrings('en').heroCapital, INVESTMENT_RETURN_STRINGS.en.heroCapital);
});

test('the screens use the words: the footer row, the saved block, the confirm guard, «أرباحي» and «المستثمرون»', () => {
  const panel = codeOf('src/components/adminOperations/ProcurementPanel.tsx');
  assert.doesNotMatch(panel, /نقد مستلم غير مخصص/, 'the old footer row is gone: that cash is the returned amount');
  assert.match(panel, /fundingReturnEstimate\(/);
  assert.match(panel, /ir\.footerRow/);
  assert.match(panel, /ir\.footerCaption/);
  assert.match(panel, /ir\.surplus/);
  assert.match(panel, /ir\.returned/);
  assert.match(panel, /COST_REFUSALS\.INVESTMENT_NEEDS_FINAL_COST\[lang\]/);
  assert.match(panel, /fundingNeedsFinalCost \|\|/, 'the confirm is disabled before the server has to refuse');
  assert.doesNotMatch(panel, /'غير مخصص', 'Unallocated'/);
  const earnings = codeOf('src/components/financePeople/MyEarnings.tsx');
  assert.doesNotMatch(earnings, /تمويل مستلم غير مخصص/);
  assert.match(earnings, /ir\.heroCapital/);
  assert.match(earnings, /ir\.sourcesSurplus/);
  assert.match(earnings, /investorReturnView\(/);
  assert.match(earnings, /startWithdrawal\('capital'\)/, 'the returned remainder is withdrawn with «سحب رأس المال»');
  assert.match(earnings, /ir\.batchesReturned/);
  assert.match(earnings, /ir\.batchesPending/);
  const profiles = codeOf('src/components/financePeople/InvestorProfiles.tsx');
  assert.doesNotMatch(profiles, /نقد غير مخصص/);
  assert.match(profiles, /profilesReturned/);
});
