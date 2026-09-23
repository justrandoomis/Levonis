/**
 * THE CUSTOMER'S SIDE OF «في المحفظة الاعتماد على السعر المدخل بدون تقريب،
 * وعند الدولار يقرب الى عدد صحيح اقل».
 *
 * tests/walletOps.test.ts covers the engine: what is held, what is debited,
 * what is stored. NOTHING covered the page the customer actually uses, and it
 * was demonstrable: deleting both new guard lines in src/pages/Wallet.tsx AND
 * reverting `fmtOperation`'s withdrawal branch left 93 tests passing across
 * every file that reads that page. With those lines gone a customer at 1,400
 * typing 13 د.ع submits `amount_usd_cents: 0` and reads the raw English
 * «amount_usd_cents must be between 100 and 100000000» inside an RTL Arabic
 * modal, and every withdrawal row prints 50,008 د.ع again.
 *
 * TWO KINDS OF ASSERTION, ON PURPOSE. The arithmetic runs against the REAL
 * `iqdToUsdCents` / `usdCentsToIqd` — those are the rules and they must hold
 * by execution. The wiring is a SOURCE rule, because a deleted guard or a
 * branch quietly reverted to `undefined` is exactly the change that passes
 * every behavioural test ever written for a formatter. That is the same
 * division tests/displayCurrency.test.ts already makes about this page.
 *
 * Run: npm run test:unit
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { iqdToUsdCents, usdCentsToIqd, depositDeclaredIqd } from '../src/lib/api';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (p: string) => readFileSync(join(ROOT, p), 'utf8');

// ------------------------------------------------------------- the rule

test('the dollar rounds DOWN, which is the owner’s own example', () => {
  // «مثلا 35.71 = 50,000» at the shop's default rate.
  assert.equal(iqdToUsdCents(50_000, 1400), 3571);
  assert.equal((3571 / 100).toFixed(2), '35.71');
  // The superseded rule, kept legible: ceil said $35.72.
  assert.equal(Math.ceil((50_000 * 100) / 1400), 3572);
});

/**
 * H1 — THE FLOOR CAN REACH ZERO, AND THE PAGE REFUSES IT IN ARABIC.
 *
 * Under ceil, 1 د.ع became 1 cent and the request left the browser. Under
 * floor anything below one cent's worth becomes 0, which the route answers in
 * English inside an RTL modal. `s.invalidAmount` already exists in ar/en/ckb,
 * so the refusal cost no new string — which is the only safe answer while
 * Sorani may never be machine written.
 */
test('an amount that floors to nothing is refused before it is sent', () => {
  assert.equal(iqdToUsdCents(13, 1400), 0, 'under one cent’s worth floors to nothing');
  assert.equal(iqdToUsdCents(14, 1400), 1, 'one cent’s worth is the smallest representable amount');

  const src = read('src/pages/Wallet.tsx');
  // The zero guard, and the server's own floor read from the server rather
  // than compiled in — both on the step-2 validator.
  assert.match(src, /if \(!amountCents\) return s\.invalidAmount;/);
  assert.match(src, /if \(minAmountCents > 0 && amountCents < minAmountCents\) return s\.invalidAmount;/);
  assert.match(src, /min_amount_usd_cents: number/, 'the policy response is not being read for the minimum');
  assert.match(src, /setMinAmountCents\(Number\(p\.withdrawal\?\.min_amount_usd_cents\) \|\| 0\);/);
  // No new refusal sentence was invented for any of it.
  assert.ok(!/invalidAmountZero|belowMinimum|minimumAmount/.test(src), 'a new refusal string appeared');
});

// --------------------------------------------- what a row and a form print

test('a withdrawal row prints the typed dinars, not the cents converted back', () => {
  // The reader itself: recorded → verbatim at any rate; absent → converted.
  assert.equal(depositDeclaredIqd(50_000, 3571, 1400), 50_000);
  assert.equal(depositDeclaredIqd(50_000, 3571, 1600), 50_000);
  assert.equal(depositDeclaredIqd(null, 3571, 1400), 49_994, 'a pre-0106 row still converts, honestly');
  // What the row used to print for a typed 50,000, on both rounding rules.
  assert.equal(usdCentsToIqd(3572, 1400), 50_008);
  assert.equal(usdCentsToIqd(3571, 1400), 49_994);

  const src = read('src/pages/Wallet.tsx');
  // `fmtOperation` reads the WITHDRAWAL's own column, not just the deposit's.
  assert.match(
    src,
    /op\.kind === 'deposit' \? op\.tx\?\.depositContext\?\.declared_amount_iqd : op\.withdrawal\?\.declared_amount_iqd/,
    'the withdrawal branch of fmtOperation is gone — rows convert again'
  );
  // Presence decides, not truthiness: a recorded 0 is not a reason to convert.
  assert.match(src, /if \(declared === null \|\| declared === undefined\) return fmt\(op\.amount\);/);
  // And the typed figure is actually SENT on the withdrawal branch.
  assert.equal(
    (src.match(/declared_amount_iqd: typedIqd \|\| undefined,/g) ?? []).length,
    2,
    'the declared dinars are posted on only one of the two kinds'
  );
  assert.match(src, /await api\.post\('\/api\/wallet\/withdrawals', \{[\s\S]{0,400}declared_amount_iqd: typedIqd/);
});

/**
 * THE CONFIRMATION SCREEN ADDS UP.
 *
 * «المبلغ» prints what was typed, which is rule (1). While the commission and
 * the net beneath it were the cents converted BACK, the three rows no longer
 * reconciled: a typed 50,000 د.ع at 1,400 with the default 3% read
 * «50,000 / −1,498 / 48,496», and 50,000 − 1,498 is 48,502. Six dinars
 * missing on the screen where a customer confirms money leaving. All three
 * rows are now arithmetic over the typed figure at the same basis points the
 * server applies.
 */
test('the withdrawal summary reconciles: amount − commission = net', () => {
  const RATE = 1400;
  const DEFAULT_FEE_BPS = 300;
  const typed = 50_000;

  // The page's rule, restated here so it is pinned by value, not by shape.
  const feeIqd = Math.floor((typed * DEFAULT_FEE_BPS) / 10_000);
  const netIqd = typed - feeIqd;
  assert.equal(feeIqd, 1_500);
  assert.equal(netIqd, 48_500);
  assert.equal(typed - feeIqd, netIqd, 'the three rows do not add up');

  // The superseded display, and the gap it left on that same screen.
  const amountCents = iqdToUsdCents(typed, RATE);
  const feeCents = Math.floor((amountCents * DEFAULT_FEE_BPS) / 10_000);
  assert.equal(amountCents, 3571);
  assert.equal(feeCents, 107);
  assert.equal(usdCentsToIqd(feeCents, RATE), 1_498);
  assert.equal(usdCentsToIqd(amountCents - feeCents, RATE), 48_496);
  assert.notEqual(typed - usdCentsToIqd(feeCents, RATE), usdCentsToIqd(amountCents - feeCents, RATE));

  // WHAT IT COSTS, NAMED: the dollars that actually move are net_cents, and
  // in dinars that is within one cent (14 د.ع at 1,400) of the net shown.
  assert.ok(Math.abs(netIqd - usdCentsToIqd(amountCents - feeCents, RATE)) <= RATE / 100);

  const src = read('src/pages/Wallet.tsx');
  assert.match(src, /const feeIqd = typedIqd && feeBps > 0 \? Math\.floor\(\(typedIqd \* feeBps\) \/ 10_000\) : 0;/);
  assert.match(src, /const netIqd = typedIqd \? typedIqd - feeIqd : 0;/);
  assert.match(src, /const amountLabel = typedIqd \? iqdLabel\(typedIqd\) : fmt\(amountCents\);/);
  assert.match(src, /const feeLabel = typedIqd \? iqdLabel\(feeIqd\) : fmt\(feeCents\);/);
  assert.match(src, /const netLabel = typedIqd \? iqdLabel\(netIqd\) : fmt\(netCents\);/);
  // Neither the step-2 preview nor the step-3 summary may print the converted
  // cents beside a typed amount again.
  assert.ok(!src.includes('−{fmt(feeCents)}'), 'the commission row converts the cents back again');
  assert.ok(!src.includes('{fmt(netCents)}'), 'the net row converts the cents back again');
  // `amountLabel` is not gated on the kind any more — a withdrawal shows the
  // typed figure too.
  assert.ok(!src.includes("kind === 'deposit' && typedIqd"), 'the typed figure is deposit-only again');
});

// ------------------------------------------------ the admin side of rule (1)

test('both admin surfaces print the typed dinars for both kinds', () => {
  // The dashboard strip carries the approve/reject buttons on the same row,
  // so it must not disagree with the Wallet Requests screen about one
  // transaction. Deposits read wallet_deposit_meta (0105), withdrawals their
  // own row (0106).
  const overview = read('src/components/AdminOverview.tsx');
  assert.match(overview, /req\.withdrawal\?\.declared_amount_iqd/);
  assert.match(overview, /req\.deposit\?\.declared_amount_iqd/);
  assert.match(overview, /formatWalletIqd\(req\.amount, exchangeRate\)/, 'the pre-0105/0106 fallback is gone');

  const requests = read('src/components/AdminWalletRequests.tsx');
  assert.match(requests, /t\.withdrawal\?\.declared_amount_iqd/);
  assert.match(requests, /declaredIqd\[t\.id\]/);

  // And the route actually joins the deposit's testimony into the strip.
  const admin = read('worker/routes/admin.ts');
  assert.match(admin, /LEFT JOIN wallet_deposit_meta m ON m\.tx_id = wt\.id/);
  assert.match(admin, /m\.declared_amount_iqd AS deposit_declared_iqd/);
});
