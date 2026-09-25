/**
 * «صفحة المحفظة ضخمة: «إيداعات قيد المراجعة» و«سحوبات مفتوحة» و«الرصيد
 *  المسوى» و«النقاط» بسطرين بدل سطر، والأزرار (الكل/إيداع/سحب/الحالات)
 *  كبيرة.» — and the same page printing the customer's dinars, not the cents
 *  converted back.
 *
 * THE CLIENT HALF OF tests/walletDinarFigures.test.ts. The server now sends
 * every figure in dinars and every withdrawal channel by name; a screen that
 * kept reading the old field is exactly the change that passes every route
 * test. These are SOURCE RULES for the wiring (a rendering defect no formatter
 * test can see), plus the two pure helpers run for real.
 *
 * Run: node --import tsx --test tests/walletPageCompact.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ROOT } from './fixtures/d1';

const read = (p: string) => readFileSync(join(ROOT, p), 'utf8');
const wallet = read('src/pages/Wallet.tsx');

test('Segmented gains a compact size and keeps its default untouched', () => {
  const seg = read('src/components/ui/Segmented.tsx');
  assert.match(seg, /size = 'md'/, 'the default stays md');
  // W6: the sm option still DRAWS 30px; a transparent ::after 7px above and below makes it HIT 44px.
  assert.match(seg, /size === 'sm' \? "h-full rounded-\[10px\] text-\[12px\] font-bold after:absolute after:inset-x-0 after:-inset-y-\[7px\] after:content-\[''\]" : 'min-h-11 rounded-xl text-\[13px\] font-black'/);
  // The sm TRACK is 36px with its padding and border — the same h-9 as the
  // select and the search button beside it. A 36px option inside them drew 42px.
  assert.match(seg, /size === 'sm' \? 'h-9 box-border gap-0\.5 p-0\.5 rounded-xl'/);
  assert.doesNotMatch(seg, /size === 'sm' \? 'min-h-9/);
});

test('the filter row is ONE compact row: small segmented, chip-sized status select, search behind an icon', () => {
  assert.match(wallet, /group="wallet-type"[\s\S]{0,400}size="sm"/, 'the type filter uses the compact size');
  assert.match(wallet, /<div className="flex flex-wrap items-center gap-1\.5 mb-3">/, 'one row at every width');
  assert.doesNotMatch(wallet, /flex flex-col sm:flex-row sm:items-center gap-2 mb-3/, 'the stacked phone layout is gone');
  const select = wallet.slice(wallet.indexOf('value={statusFilter}') - 200, wallet.indexOf('value={statusFilter}') + 400);
  assert.match(select, /h-9 /, 'the status select is a 36px chip');
  assert.doesNotMatch(select, /min-h-11 w-full/, 'not a full-width 44px row');
  assert.match(wallet, /aria-controls="wallet-search"/, 'search opens from an icon on a phone');
  // The type filter asks for its labels' width per language and wraps rather
  // than truncating "Withdrawals" / «کێشانەوە» at 360px.
  assert.match(wallet, /className=\{`grow min-w-0 sm:grow-0 \$\{TYPE_FILTER_BASIS\[/);
  assert.match(wallet, /const TYPE_FILTER_BASIS: Record<Lang, string> = \{\s*ar: 'basis-36 sm:basis-60',\s*ckb: 'basis-56',\s*en: 'basis-\[17rem\]',/);
  assert.doesNotMatch(wallet, /className="flex-1 min-w-0 sm:flex-none sm:w-\[240px\]"/);
  assert.match(wallet, /\$\{searchOpen \|\| search \? 'flex' : 'hidden'\} sm:flex/, 'an active query keeps the field visible');
});

test('the four figures are one-line tiles in a 2-up grid, each printing the server’s dinars', () => {
  assert.match(wallet, /<dl className="grid grid-cols-2 sm:grid-cols-4/);
  for (const [field, cents] of [
    ['iqd_held', 'usd_cents_held'],
    ['iqd_pending_deposits', 'usd_cents_pending_deposits'],
    ['iqd_pending_withdrawals', 'usd_cents_pending_withdrawals'],
    ['iqd_settled', 'usd_cents_settled'],
  ]) {
    assert.ok(
      wallet.includes(`fmtDinars(balances.${field}, balances.${cents})`),
      `${field} must be printed from the server's dinars`
    );
  }
  assert.doesNotMatch(wallet, /fmt\(card\.value\)/, 'no tile converts its cents any more');
  assert.doesNotMatch(wallet, /fmt\(balances\.usd_cents_settled\)/, '«الرصيد المسوّى» is no longer the cents converted');
  // One line per label: nowrap on the label, no hint row under the tile.
  assert.match(wallet, /<span className="truncate whitespace-nowrap">\{card\.label\}<\/span>/);
  assert.match(wallet, /data-wallet-figure="points"[^>]*>/);
  assert.match(wallet, /className="mt-2 text-zinc-400 text-\[11px\] font-bold whitespace-nowrap" data-wallet-figure="points"/);
});

test('every operation prints the dinars its row recorded before converting cents', () => {
  const body = wallet.slice(wallet.indexOf('const fmtOperation = useCallback('), wallet.indexOf('const fmtOperation = useCallback(') + 900);
  assert.ok(body.indexOf('op.tx?.amount_iqd') > 0, 'the row’s own amount_iqd is read');
  assert.ok(body.indexOf('op.tx?.amount_iqd') < body.indexOf('declared_amount_iqd'), 'and read FIRST');
});

test('the withdrawal form compares and prints in the customer’s dinars', () => {
  assert.match(wallet, /availableIqd=\{Number\(balances\.iqd_available\) \|\| 0\}/);
  assert.match(wallet, /availableLabel=\{fmtAvailable\(\)\}/);
  // Over-balance is asked against the balance DISPLAYED, in both currencies
  // (src/lib/walletWithdrawClaim.ts, behaviour in tests/walletDinarFigures.test.ts),
  // and a withdrawal sends the claim's dinars — in USD, the dinars a figure
  // above the ledger cents stands for.
  assert.match(wallet, /const claim = withdrawalClaim\(\{[\s\S]{0,160}availableCents: available,[\s\S]{0,40}availableIqd,/, 'over-balance in the displayed unit');
  assert.match(wallet, /const overBalance = kind === 'withdrawal' && claim\.overBalance;/);
  assert.match(wallet, /const declaredIqd = kind === 'withdrawal' \? claim\.declaredIqd : typedIqd;/);
  const wdPost = wallet.slice(wallet.indexOf("api.post('/api/wallet/withdrawals'"), wallet.indexOf("api.post('/api/wallet/withdrawals'") + 400);
  assert.match(wdPost, /declared_amount_iqd: declaredIqd \|\| undefined/, 'the withdrawal sends the claim');
  assert.doesNotMatch(wallet, /\{fmt\(available\)\}/, '«الرصيد المتاح» is not the cents converted');
  assert.doesNotMatch(wallet, /fmt\(Math\.max\(available - amountCents, 0\)\)\}/);
});

test('the payout channels are the owner’s payoutMethods, and cash pickup asks for no account', () => {
  assert.match(wallet, /settings\?\.payoutMethods/);
  assert.match(wallet, /payoutChannelsFrom\(payoutMethods, paymentMethods, lang\)/);
  assert.match(wallet, /if \(!requiresAccount\) return '';/, 'step 1 does not demand an account for cash pickup');
  assert.match(wallet, /destinationAccount: requiresAccount \? destinationAccount\.trim\(\) : undefined/);
  assert.match(wallet, /\{requiresAccount && \(\s*<Field label=\{`\$\{s\.accountForChannel\} \*`\}/);
  // The customer's row names the channel; it never prints the raw id again.
  assert.doesNotMatch(wallet, /\{w\.destination\.kind\} · \{w\.destination\.account\}/);
  assert.match(wallet, /payoutName\(w\.destination\.kind, w\.destination\.label, lang, payoutMethods, paymentMethods\)/);
});

test('the admin payout card names the channel and prints the quoted dinars', () => {
  const card = read('src/components/AdminWalletRequests.tsx');
  assert.match(card, /data-withdrawal-channel/);
  assert.match(card, /if \(w\.destination_label\) return w\.destination_label;/);
  assert.match(card, /formatIqd\(t\.withdrawal\.net_iqd\)/);
});

test('the admin member card prints the member’s dinars from the server', () => {
  const modal = read('src/components/adminUsers/MemberDetailModal.tsx');
  assert.match(modal, /typeof f\.wallet_iqd === 'number'/);
  assert.doesNotMatch(modal, /value=\{formatWalletIqd\(view\.financial\.wallet_usd_cents, exchangeRate\)\}/);
});

test('the admin types the withdrawal commission as a percent', async () => {
  const settings = read('src/components/AdminWalletSettings.tsx');
  assert.match(settings, /id="withdrawal-fee-percent"/);
  assert.doesNotMatch(settings, /Rate in basis points/);
  assert.match(settings, /data-admin="payout-methods"/, 'and edits the payout channels');
  assert.match(settings, /api\.put\('\/api\/admin\/settings\/payoutMethods'/);
  const { feePercentToBps, feeBpsToPercent } = await import('../src/components/AdminWalletSettings');
  assert.equal(feePercentToBps('3'), 300);
  assert.equal(feePercentToBps('2.5'), 250);
  assert.equal(feePercentToBps('3%'), 300);
  assert.equal(feePercentToBps('0'), 0);
  assert.equal(feePercentToBps('50'), 5000);
  assert.equal(feePercentToBps('51'), null);
  assert.equal(feePercentToBps('300'), null, 'a basis-point habit typed into the percent box is refused, not stored as 300%');
  assert.equal(feePercentToBps('1.234'), null);
  assert.equal(feePercentToBps('abc'), null);
  assert.equal(feeBpsToPercent(300), '3');
  assert.equal(feeBpsToPercent(250), '2.5');
});
