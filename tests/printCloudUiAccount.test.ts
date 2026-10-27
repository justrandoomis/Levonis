/**
 * LEVONIS PRINT CLOUD — THE CUSTOMER'S ACCOUNT SECTION (cloud.<root>/account,
 * src/cloud/pages/account).
 *
 * Fast and build-free. Three things are held here:
 *
 *   1. the pure rules the account screens draw with (logic.ts): a lot's
 *      expiry as the server applies it, the four figures of a balance (free is
 *      ALWAYS the server's own number, never worked out), the reminder amount
 *      (the customer's own, else the default the server states), a ledger
 *      row's movement and the exact cursor of the next page, the conversions
 *      the server allows, the states of a shipment and a sell-back and which
 *      of them may still be cancelled, the address the server would refuse,
 *      where a transaction row leads;
 *   2. the section's words: three languages, the Sorani never the Arabic, and
 *      not one figure written into a sentence;
 *   3. source rules a screen could break later without a behavioural test
 *      noticing: a price or a duration typed into the markup, an invented
 *      badge, a money door sent without its Idempotency-Key, a top-up that
 *      assumes the workshop's amount, a fee or a conversion shown before the
 *      server's own quote, a print offered again that the server says is on a
 *      shipment, a link outside the sections' own routes.
 *
 * The server facts the screens restate (the statuses, which states may be
 * cancelled, the caps of the lists, the phone rule) are read from the
 * server's own source and migration, so a change there fails here first.
 *
 * Run: node --import tsx --test tests/printCloudUiAccount.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import * as L from '../src/cloud/pages/account/logic';
import * as S from '../src/cloud/strings/account';
import { tx } from '../src/cloud/text';
import { IRAQ_GOVERNORATES } from '../packages/shipping/src/iraqGovernorates';
import type { CreditConversionRule, CreditTierBalance, InventoryBalance, StoreCategory, TransactionRow, Tri } from '../src/cloud/types';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const LANGS = ['ar', 'en', 'ckb'] as const;
const read = (rel: string) => readFileSync(join(ROOT, rel), 'utf8');
const ACCOUNT_DIR = 'src/cloud/pages/account';
const ACCOUNT_FILES = readdirSync(join(ROOT, ACCOUNT_DIR))
  .filter((f) => /\.tsx?$/.test(f))
  .map((f) => `${ACCOUNT_DIR}/${f}`)
  .sort();
const MIGRATION = read('migrations/0215_print_cloud.sql');

/** The values of one `<column> … CHECK (<column> IN (…))` of the Print Cloud migration, after `anchor`. */
function checkList(anchor: string, column: string): string[] {
  const from = MIGRATION.indexOf(anchor);
  assert.ok(from >= 0, `no ${anchor} in the migration`);
  const re = new RegExp(`${column}\\s+TEXT[^,]*?CHECK\\s*\\(\\s*${column}\\s+IN\\s*\\(([^)]*)\\)`, 'm');
  const m = re.exec(MIGRATION.slice(from));
  assert.ok(m, `no CHECK on ${column} after ${anchor}`);
  return [...m[1].matchAll(/'([^']+)'/g)].map((x) => x[1]);
}

const at = (iso: string) => Date.parse(iso);
const NOW = at('2026-10-27T12:00:00.000Z');
const DAY = 86_400_000;
const iso = (ms: number) => new Date(ms).toISOString();

// ============================================================ balances

test('a balance is four figures; «free» is always the server’s own number, «yours» the sum of free and held', () => {
  const f = L.inventoryFigures({ available_qty: 490, reserved_qty: 160, consumed_qty: 340 });
  assert.deepEqual(f, { owned: 650, reserved: 160, available: 490, used: 340 });
  // Whatever the server sends, free is never derived: it is exactly its own field.
  for (const [a, r, c] of [[0, 0, 0], [1, 999, 3], [1000, 0, 25], [7, 7, 7]]) {
    const x = L.inventoryFigures({ available_qty: a, reserved_qty: r, consumed_qty: c });
    assert.equal(x.available, a);
    assert.equal(x.reserved, r);
    assert.equal(x.owned, a + r);
    assert.equal((x.owned ?? 0) - (x.reserved ?? 0), x.available, 'available = owned − reserved, as displayed');
  }
  // A figure the server did not send is null — never a zero.
  const broken = L.inventoryFigures({ available_qty: Number.NaN, reserved_qty: 10, consumed_qty: 0 });
  assert.equal(broken.available, null);
  assert.equal(broken.owned, null);
  const tier = { available_seconds: 66240, reserved_seconds: 32040, consumed_seconds: 1800 } as CreditTierBalance;
  assert.deepEqual(L.creditFigures(tier), { owned: 98280, reserved: 32040, available: 66240, used: 1800 });
});

test('«running low» at the amount the server applies: the customer’s own, else the default the server states — never a guessed one', () => {
  assert.deepEqual(L.reminderAmount({ low_stock_alert_qty: 50, low_stock_alert_default_qty: 100 }), { source: 'own', qty: 50 });
  assert.deepEqual(L.reminderAmount({ low_stock_alert_qty: null, low_stock_alert_default_qty: 100 }), { source: 'default', qty: 100 });
  assert.deepEqual(L.reminderAmount({ low_stock_alert_qty: null, low_stock_alert_default_qty: null }), { source: 'none', qty: null }, 'pieces: no default applies');
  assert.deepEqual(L.reminderAmount({ low_stock_alert_qty: null }), { source: 'none', qty: null }, 'a row without the stated default is never given one');
  assert.equal(L.isLow({ available_qty: 50, low_stock_alert_qty: null }), false);
  assert.equal(L.isLow({ available_qty: 100, low_stock_alert_qty: 100 }), true);
  assert.equal(L.isLow({ available_qty: 101, low_stock_alert_qty: 100 }), false);
  assert.equal(L.isLow({ available_qty: 90, low_stock_alert_qty: null, low_stock_alert_default_qty: 100 }), true, 'at the workshop’s default');
  assert.equal(L.isLow({ available_qty: 101, low_stock_alert_qty: null, low_stock_alert_default_qty: 100 }), false);
  assert.equal(L.isLow({ available_qty: 90, low_stock_alert_qty: 50, low_stock_alert_default_qty: 100 }), false, 'the customer’s own amount wins');
  // The default is the server's own: the one the low-inventory scan applies, stated per row by GET /me/inventory.
  assert.match(read('worker/lib/printCloud/reports.ts'), /low_stock_alert_default_qty: lowStockDefaultQty\(r\.unit_code, config\)/);
  assert.match(read('worker/lib/printCloud/reports.ts'), /top_up_default_target_qty: TOP_UP_DEFAULT_TARGET_QTY/);
  assert.match(read('worker/lib/printCloud/background.ts'), /CASE WHEN a\.unit_code = \? THEN \? ELSE -1 END[\s\S]*LOW_STOCK_DEFAULT_UNIT,\s*config\.low_inventory_default_g/);
  assert.match(read('worker/routes/printCloud.ts'), /body\.target_qty === undefined \? TOP_UP_DEFAULT_TARGET_QTY/);
  const rows = [
    { category_kind: 'filament', unit_code: 'g' },
    { category_kind: 'filament', unit_code: 'mm' },
    { category_kind: 'accessory', unit_code: 'pc' },
  ] as InventoryBalance[];
  assert.equal(L.filamentGrams(rows).length, 1, 'grams are never added to pieces or millimetres');
});

// ============================================================ lots and expiry

test('a lot’s expiry as the server applies it: none, unreadable, past from the very instant named, soon, later', () => {
  assert.deepEqual(L.lotExpiry(null, NOW), { kind: 'never' });
  assert.deepEqual(L.lotExpiry('', NOW), { kind: 'never' });
  assert.deepEqual(L.lotExpiry('not a date', NOW), { kind: 'unknown' }, 'an unreadable date is never «does not expire»');
  assert.equal(L.lotExpiry(iso(NOW), NOW).kind, 'expired', 'credits.ts goodAt: good only while expires_at > now');
  assert.equal(L.lotExpiry(iso(NOW - 1), NOW).kind, 'expired');
  assert.equal(L.lotExpiry(iso(NOW + 1), NOW).kind, 'soon');
  assert.equal(L.lotExpiry(iso(NOW + L.EXPIRY_WARNING_DAYS * DAY), NOW).kind, 'soon');
  assert.equal(L.lotExpiry(iso(NOW + L.EXPIRY_WARNING_DAYS * DAY + 1), NOW).kind, 'later');
  assert.equal(L.expiryTone({ kind: 'expired', at: iso(NOW) }), 'danger');
  assert.equal(L.expiryTone({ kind: 'soon', at: iso(NOW) }), 'warning');
  assert.equal(L.expiryTone({ kind: 'never' }), 'neutral');
  // The rule restated above is the server's own.
  assert.match(read('worker/lib/printCloud/credits.ts'), /lot\.expiresAt === null \|\| lot\.expiresAt > cutoff/);
});

test('a ledger row reads as the movement it made, for every entry type the server writes', () => {
  const row = (entry_type: string, a: number, r: number, c: number) => ({ entry_type, delta_available: a, delta_reserved: r, delta_consumed: c });
  assert.deepEqual(L.ledgerMovement(row('purchase', 86400, 0, 0)), { kind: 'in', amount: 86400 });
  assert.deepEqual(L.ledgerMovement(row('reserve', -32040, 32040, 0)), { kind: 'held', amount: 32040 });
  assert.deepEqual(L.ledgerMovement(row('release', 1440, -1440, 0)), { kind: 'returned', amount: 1440 });
  assert.deepEqual(L.ledgerMovement(row('consume', -60, -30600, 30660)), { kind: 'used', amount: 30660 }, 'an overage is part of what was used');
  assert.deepEqual(L.ledgerMovement(row('deliver', 0, -500, 500)), { kind: 'used', amount: 500 });
  assert.deepEqual(L.ledgerMovement(row('buyback', 0, -250, 250)), { kind: 'used', amount: 250 });
  for (const out of ['refund', 'adjust_debit', 'conversion_out', 'expire']) assert.equal(L.ledgerMovement(row(out, -600, 0, 0)).kind, 'out', out);
  for (const into of ['adjust_credit', 'conversion_in', 'compensation']) assert.equal(L.ledgerMovement(row(into, 600, 0, 0)).kind, 'in', into);
  assert.equal(L.movementSign('in'), '+');
  assert.equal(L.movementSign('returned'), '+');
  assert.equal(L.movementSign('out'), '−');
  assert.equal(L.movementSign('held'), '−');
  assert.equal(L.movementSign('used'), '');
  // Every entry type the two ledgers may hold has its words.
  const credit = checkList('CREATE TABLE IF NOT EXISTS pc_credit_ledger', 'entry_type');
  const inventory = checkList('CREATE TABLE IF NOT EXISTS pc_inventory_ledger', 'entry_type');
  assert.ok(credit.length >= 11 && inventory.length >= 10);
  assert.deepEqual(Object.keys(S.creditEntry).sort(), [...credit].sort());
  assert.deepEqual(Object.keys(S.inventoryEntry).sort(), [...inventory].sort());
});

// ============================================================ converting hours

test('typed hours and minutes become the server’s seconds; nothing else is accepted', () => {
  assert.equal(L.typedSeconds(2, 30), 9000);
  assert.equal(L.typedSeconds(null, 45), 2700);
  assert.equal(L.typedSeconds(3, null), 10800);
  assert.equal(L.typedSeconds(null, null), 0);
  assert.equal(L.typedSeconds(0, 60), null, 'minutes stay under the hour');
  assert.equal(L.typedSeconds(-1, 0), null);
  assert.equal(L.typedSeconds(1.5, 0), null);
  // The server's own floor for a conversion.
  assert.match(read('worker/routes/printCloud.ts'), /reqInt\(body\.seconds, 'seconds', \{ min: 60,/);
  assert.equal(L.MIN_CONVERT_SECONDS, 60);
});

test('only the conversions the server allows are offered: a class with free hours and a rule out of it, and that rule’s targets', () => {
  const tier = (tier_id: string, available_seconds: number) => ({ tier_id, code: tier_id, available_seconds }) as CreditTierBalance;
  const rule = (from_tier_id: string, to_tier_id: string, ratio_num = 1, ratio_den = 1) => ({ rule_id: `${from_tier_id}>${to_tier_id}`, from_tier_id, to_tier_id, ratio_num, ratio_den }) as CreditConversionRule;
  const tiers = [tier('t1', 7200), tier('t2', 0), tier('t3', 3600)];
  const rules = [rule('t1', 't2'), rule('t1', 't4'), rule('t2', 't1')];
  assert.deepEqual(L.conversionSources(tiers, rules).map((t) => t.tier_id), ['t1'], 't2 has no free hours, t3 no rule out of it');
  assert.deepEqual(L.conversionTargets(rules, 't1').map((r) => r.to_tier_id), ['t2', 't4']);
  assert.deepEqual(L.conversionTargets(rules, 't3'), [], 'a pair the workshop does not allow is never shown');
  // A rule restated in whole hours is exact: den hours become num hours under the server's own floor.
  for (const [num, den] of [[1, 1], [3, 2], [2, 3], [1, 1000], [7, 4]]) {
    const r = L.ratioInHours({ ratio_num: num, ratio_den: den });
    assert.equal(Math.floor((r.given * num) / den), r.received, `${num}:${den}`);
  }
  assert.match(read('worker/lib/printCloud/credits.ts'), /const received = mulDivFloor\(p\.seconds, p\.rule\.ratio_num, p\.rule\.ratio_den\);/);
});

test('what a conversion gives is the server’s, before and after: the rules it lists, its quote before the confirmation, its answer after', () => {
  const api = read('src/cloud/api.ts');
  assert.match(api, /get<T\.CreditConversionRule\[\]>\('\/me\/credits\/conversions'/);
  assert.match(api, /post<T\.ConvertQuote>\('\/me\/credits\/convert\/quote'/);
  const hours = read(`${ACCOUNT_DIR}/AccountHours.tsx`);
  assert.match(hours, /listCreditConversions\(\{ signal \}\)/, 'the pairs offered are the server’s rules');
  assert.match(hours, /setQuote\(await quoteCreditConversion\(body\)\)/, 'the review asks the server first');
  assert.match(hours, /open=\{confirming && !!body && !!shown\}/, 'no confirmation without the quote of this very body');
  assert.match(hours, /shown\.received_seconds/, 'what would arrive is the quote’s own figure');
  assert.match(hours, /result\.received_seconds/, 'what arrived is the conversion’s own answer');
  assert.doesNotMatch(hours, /ratio_num|ratio_den/, 'no ratio arithmetic on the screen (logic.ts ratioInHours restates the rule)');
  // The quote and the conversion are one plan on the server.
  const routes = read('worker/routes/printCloud.ts');
  assert.match(routes, /const plan = await planConversion\(/);
  assert.match(read('worker/lib/printCloud/credits.ts'), /export async function convertCredits[\s\S]*?const plan = await planConversion\(db, p\);/);
});

// ============================================================ shipments

test('every shipment status the server stores has its words and its tone; only the server’s own two may be cancelled', () => {
  const statuses = checkList('CREATE TABLE IF NOT EXISTS pc_shipments', 'status');
  assert.deepEqual([...L.SHIPMENT_STATUSES].sort(), [...statuses].sort());
  assert.deepEqual(Object.keys(S.shipmentStatus).sort(), [...statuses].sort());
  for (const s of statuses) assert.ok(L.shipmentTone(s), s);
  assert.deepEqual(statuses.filter(L.shipmentCancellable).sort(), ['awaiting_payment', 'preparing']);
  assert.match(read('worker/lib/printCloud/fulfillment.ts'), /sh\.status !== 'awaiting_payment' && sh\.status !== 'preparing'/);
  assert.deepEqual(Object.keys(S.shipmentKind).sort(), ['delivery', 'pickup']);
});

test('a shipment’s road: pickup is free, a delivery waits for its fee only when it has one, a cancelled one has none', () => {
  const states = (k: string, s: string, fee: number) => L.shipmentSteps(k, s, fee)?.map((x) => `${x.status}:${x.state}`);
  assert.deepEqual(states('pickup', 'preparing', 0), ['preparing:current', 'ready_for_pickup:upcoming', 'picked_up:upcoming']);
  assert.deepEqual(states('pickup', 'picked_up', 0), ['preparing:done', 'ready_for_pickup:done', 'picked_up:done']);
  assert.deepEqual(states('delivery', 'awaiting_payment', 5000), ['awaiting_payment:current', 'preparing:upcoming', 'shipped:upcoming', 'delivered:upcoming']);
  assert.deepEqual(states('delivery', 'shipped', 5000), ['awaiting_payment:done', 'preparing:done', 'shipped:current', 'delivered:upcoming']);
  assert.deepEqual(states('delivery', 'preparing', 0), ['preparing:current', 'shipped:upcoming', 'delivered:upcoming']);
  assert.equal(L.shipmentSteps('delivery', 'cancelled', 5000), null);
  assert.equal(L.shipmentSteps('pickup', 'shipped', 0), null, 'a state off its road draws no road');
});

test('a print the server names a shipment for is not offered again — nothing reads the shipments to find out; the fee is the server’s quote', () => {
  const page = read(`${ACCOUNT_DIR}/AccountShipmentNew.tsx`);
  assert.match(page, /jobPick\.has\(j\.id\) && !j\.shipment_id/, 'a print on a live shipment is never put in a request');
  assert.match(page, /const on = job\.shipment_id \?\? null;/);
  assert.doesNotMatch(page, /listShipments\(|getShipment\(/, 'the old workaround (reading the latest shipments) is gone: the server is the guard');
  assert.match(page, /const answer = await quoteShipment\(body\);/, 'the review asks the request’s own assessment');
  assert.match(page, /open=\{confirming && !!body && !!shown\}/, 'no confirmation without the quote of this very body');
  assert.match(page, /<MoneyLine text=\{shipText\.feeLine\} iqd=\{shown\.fee_iqd\} \/>/, 'the fee shown is the quote’s');
  // The server facts the screen leans on: GET /jobs names the live shipment, and POST /shipments refuses a second.
  assert.match(read('worker/lib/printCloud/reports.ts'), /\$\{LIVE_SHIPMENT_OF_JOB_SQL\} AS shipment_id/);
  assert.match(read('worker/lib/printCloud/fulfillment.ts'), /if \(j\.on_shipment\) throw pcError\('ALREADY_IN_SHIPMENT'/);
  assert.match(read('worker/routes/printCloud.ts'), /auth\.post\('\/shipments\/quote'[\s\S]*?quoteShipmentRequest\(/);
  assert.deepEqual(
    [...L.deliverableVariants([{ id: 'v1', fulfillment_modes: ['inventory', 'delivery'] }, { id: 'v2', fulfillment_modes: ['inventory'] }])],
    ['v1'],
    'only what the catalogue lets leave the workshop is offered (the server refuses the rest)'
  );
});

test('a delivery address is held to the server’s own rules before it is sent', () => {
  const ids = new Set(IRAQ_GOVERNORATES.map((g) => g.id));
  assert.equal(ids.size, 18);
  const good = { recipient_name: 'Ali', phone: '+964 770 000 0000', governorate: 'baghdad', city: 'Karrada', address_line: 'Street 1', notes: '' };
  assert.deepEqual(L.addressProblems(good, ids), {});
  assert.deepEqual(L.addressProblems({ ...good, recipient_name: '  ', city: '' }, ids), { recipient_name: 'required', city: 'required' });
  assert.deepEqual(L.addressProblems({ ...good, phone: '07x' }, ids), { phone: 'format' });
  assert.deepEqual(L.addressProblems({ ...good, phone: '' }, ids), { phone: 'required' });
  assert.deepEqual(L.addressProblems({ ...good, governorate: 'Baghdad' }, ids), { governorate: 'required' }, 'the id, never a name typed in');
  assert.deepEqual(L.addressProblems({ ...good, notes: 'x'.repeat(301) }, ids), { notes: 'too_long' });
  // The rules restated are the server's (shipments.ts parseAddress).
  const server = read('worker/lib/printCloud/shipments.ts');
  assert.ok(server.includes(String(L.PHONE_RE)), 'the phone rule is the server’s own');
  for (const [key, max] of Object.entries(L.ADDRESS_MAX)) {
    if (key === 'phone') assert.match(server, new RegExp(`s\\('phone', ${max}\\)`));
    else assert.match(server, new RegExp(`s\\('${key}', ${max}`), key);
  }
});

// ============================================================ buybacks

test('sell-backs: every status and payout has its words; only a waiting request may be cancelled', () => {
  const statuses = checkList('CREATE TABLE IF NOT EXISTS pc_buyback_requests', 'status');
  const payouts = checkList('CREATE TABLE IF NOT EXISTS pc_buyback_requests', 'payout_status');
  assert.deepEqual([...L.BUYBACK_STATUSES].sort(), [...statuses].sort());
  assert.deepEqual([...L.PAYOUT_STATUSES].sort(), [...payouts].sort());
  assert.deepEqual(Object.keys(S.buybackStatus).sort(), [...statuses].sort());
  assert.deepEqual(Object.keys(S.payoutStatus).sort(), [...payouts].sort());
  assert.deepEqual(statuses.filter(L.buybackCancellable), ['requested']);
  assert.match(read('worker/lib/printCloud/buyback.ts'), /if \(b\.status !== 'requested'\) throw pcError\('INVALID_TRANSITION', \{ from: b\.status, to: 'cancelled' \}\)/);
});

test('the workshop buys back per category, at its own rate; only free material of such a category can be offered', () => {
  const categories = [
    { code: 'filament', buyback_enabled: 1, buyback_rate_bps: 5000 },
    { code: 'magnets', buyback_enabled: 0, buyback_rate_bps: 5000 },
    { code: 'nfc', buyback_enabled: 1, buyback_rate_bps: 0 },
  ] as StoreCategory[];
  const rates = L.buybackRates(categories);
  assert.deepEqual([...rates], [['filament', 5000]], 'accessories never inherit the filament rule');
  const rows = [
    { variant_id: 'a', available_qty: 500, category_code: 'filament' },
    { variant_id: 'b', available_qty: 0, category_code: 'filament' },
    { variant_id: 'c', available_qty: 20, category_code: 'magnets' },
  ] as InventoryBalance[];
  assert.deepEqual(L.sellableRows(rows, rates).map((r) => r.variant_id), ['a']);
  assert.equal(L.bpsPercent(5000), 50);
  assert.equal(L.bpsPercent(3750), 37.5);
});

// ============================================================ transactions

test('the six histories of GET /me/transactions are named, and a row leads only where the server says what its id is', () => {
  const sources = [...read('worker/lib/printCloud/reports.ts').matchAll(/source\(\s*'(\w+)'/g)].map((m) => m[1]);
  assert.deepEqual([...L.TX_LEDGERS].sort(), [...sources].sort());
  assert.deepEqual(Object.keys(S.txLedger).sort(), [...sources].sort());
  const orders = checkList('CREATE TABLE IF NOT EXISTS pc_orders', 'status');
  assert.deepEqual(Object.keys(S.orderStatusWord).sort(), [...orders].sort());

  const row = (ledger: TransactionRow['ledger'], entry_type: string, subject_id: string | null, ref_id: string | null) =>
    ({ ledger, entry_type, subject_id, ref_id }) as TransactionRow;
  assert.equal(L.txStatus(row('orders', 'order_awaiting_payment', 'o1', 'o1')), 'awaiting_payment');
  assert.equal(L.txStatus(row('buybacks', 'buyback_approved', 'v1', 'b1')), 'approved');
  assert.equal(L.txStatus(row('shipments', 'shipment_ready_for_pickup', 'pickup', 's1')), 'ready_for_pickup');
  assert.equal(L.txStatus(row('credits', 'consume', 't1', 'j1')), null);
  assert.equal(L.txHref(row('credits', 'consume', 't1', 'j 1')), '/jobs/j%201');
  assert.equal(L.txHref(row('credits', 'purchase', 't1', null)), null);
  assert.equal(L.txHref(row('inventory', 'purchase', 'v1', 'x')), '/account/materials/v1');
  assert.equal(L.txHref(row('orders', 'order_fulfilled', 'o1', 'o1')), '/orders/o1');
  assert.equal(L.txHref(row('refunds', 'refund', 'line1', 'o2')), '/orders/o2');
  assert.equal(L.txHref(row('buybacks', 'buyback_requested', 'v1', 'b1')), '/account/buyback');
  assert.equal(L.txHref(row('shipments', 'shipment_preparing', 'delivery', 's1')), '/account/shipments/s1');
  // A credit row's ref_id IS the job's: the server selects it so.
  assert.match(read('worker/lib/printCloud/reports.ts'), /value_iqd, job_id AS ref_id'/);
});

test('the ledgers page on the server’s exact cursor: the last row’s time AND id, and only after a full page', () => {
  const rows = [
    { id: 'pccl_b', created_at: '2026-10-27T10:00:00.000Z' },
    { id: 'pccl_a', created_at: '2026-10-27T10:00:00.000Z' },
  ];
  assert.deepEqual(L.nextLedgerCursor(rows, 2), { before: '2026-10-27T10:00:00.000Z', before_id: 'pccl_a' });
  assert.equal(L.nextLedgerCursor(rows, 3), null, 'a page that was not full is the last');
  assert.equal(L.nextLedgerCursor([], 2), null);
  // Both ledgers are read through it, never capped at their first page.
  for (const [file, door] of [['AccountHours.tsx', 'listCreditLedger'], ['AccountMaterial.tsx', 'listInventoryLedger']]) {
    const src = read(`${ACCOUNT_DIR}/${file}`);
    assert.match(src, new RegExp(`useLedgerPages\\(\\s*\\(cursor, signal\\) => ${door}\\(\\{[^}]*\\.\\.\\.cursor \\}`), `${file} pages ${door} on the cursor`);
    assert.match(src, /<LoadMore onMore=\{ledger\.loadMore\}/, file);
  }
  const shared = read(`${ACCOUNT_DIR}/shared.tsx`);
  assert.match(shared, /next: nextLedgerCursor\(page, limit\)/);
  // The server reads (created_at, id) as one strict order — the same the page is sorted in.
  const reports = read('worker/lib/printCloud/reports.ts');
  assert.match(reports, /' AND \(created_at < \? OR \(created_at = \? AND id < \?\)\)'/);
  assert.match(reports, /ORDER BY created_at DESC, id DESC LIMIT \?/);
});

test('hand-offs: the top-up carries the server’s stored quote into the store’s cart; the picture is the platform’s file', () => {
  assert.equal(L.storeCheckoutLink('pcq_1'), '/store/checkout/pcq_1');
  assert.equal(L.storeCheckoutLink('a b&c'), '/store/checkout/a%20b%26c');
  assert.equal(L.avatarPath('avatars/u1.webp'), '/files/avatars/u1.webp');
  assert.equal(L.avatarPath(null), null);
});

// ============================================================ words

function trisOf(value: unknown, path: string, out: Array<{ path: string; tri: Tri }>) {
  if (!value || typeof value !== 'object') return out;
  const o = value as Record<string, unknown>;
  if ('ar' in o && 'en' in o && 'ckb' in o) out.push({ path, tri: o as unknown as Tri });
  else for (const [k, v] of Object.entries(o)) trisOf(v, `${path}.${k}`, out);
  return out;
}
const placeholders = (s: string) => [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort().join(',');

test('every word of the section is in three languages, the Sorani its own, the slots the same', () => {
  const tris = trisOf(S, 'account', []);
  assert.ok(tris.length > 200, `only ${tris.length} strings`);
  for (const { path, tri } of tris) {
    for (const lang of LANGS) assert.ok(typeof tri[lang] === 'string' && tri[lang].trim(), `${path}: empty ${lang}`);
    assert.notEqual(tri.ckb, tri.ar, `${path}: the Sorani is a copy of the Arabic`);
    assert.notEqual(tri.en, tri.ar, `${path}: the English is a copy of the Arabic`);
    assert.equal(placeholders(tri.ar), placeholders(tri.en), `${path}: the Arabic fills other {names}`);
    assert.equal(placeholders(tri.ckb), placeholders(tri.en), `${path}: the Sorani fills other {names}`);
  }
  // Read through the house accessor, a slot fills in each language.
  assert.equal(tx(S.hoursText.lotLeft, 'en', { left: 'L', total: 'T' }), 'L left of T');
  assert.equal(tx(S.hoursText.lotLeft, 'ckb', { left: 'L', total: 'T' }), 'L ماوە لە T');
});

test('no sentence carries a figure, a forbidden word or the brand in another script', () => {
  const DIGIT = /[0-9٠-٩۰-۹]/;
  for (const { path, tri } of trisOf(S, 'account', [])) {
    for (const lang of LANGS) {
      const text = tri[lang];
      assert.doesNotMatch(text, DIGIT, `${path}.${lang}: «${text}» — every figure arrives through a {placeholder}`);
      assert.doesNotMatch(text, /علاوة/, `${path}.${lang}`);
      assert.doesNotMatch(text, /ليفونيس|لیڤۆنیس|ليڤونيس|لیفۆنیس/, `${path}.${lang}: «Levonis» is written in Latin letters`);
    }
  }
});

// ============================================================ the markup

const parse = (rel: string) => ts.createSourceFile(rel, read(rel), ts.ScriptTarget.Latest, true, rel.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
/** A figure with a money unit / a duration unit (tests/printCloudUiShell.test.ts uses the same two). */
const MONEY = /\d[\d,.٫٬]*\s*(?:IQD|د\.ع|دينار|دینار|USD|\$)|(?:IQD|د\.ع|\$)\s*\d/u;
const DURATION = /\d+(?:[.,]\d+)?\s*(?:h|hr|hrs|hours?|m|mins?|minutes?|s|secs?|seconds?|ساعة|ساعات|دقيقة|دقائق|س|د|کاتژمێر|خولەک|چرکە)(?![\p{L}\p{N}])/u;

test('no price, duration or quantity is typed into an account screen: every figure is the server’s, through format.ts', () => {
  for (const rel of ACCOUNT_FILES) {
    const source = parse(rel);
    const visit = (n: ts.Node) => {
      const text = ts.isJsxText(n) ? n.text : ts.isStringLiteralLike(n) ? n.text : null;
      if (text !== null) {
        const where = `${rel}:${source.getLineAndCharacterOfPosition(n.getStart(source)).line + 1}`;
        assert.doesNotMatch(text, MONEY, `${where}: a price written in («${text.trim()}»)`);
        if (ts.isJsxText(n)) assert.doesNotMatch(text, DURATION, `${where}: a duration written in («${text.trim()}»)`);
      }
      ts.forEachChild(n, visit);
    };
    visit(source);
  }
  // The top-up never assumes the workshop's usual amount: no figure is sent as a target or a quantity.
  for (const rel of ACCOUNT_FILES) {
    for (const m of read(rel).matchAll(/inventoryTopUpQuote\(([^;]*?)\)\s*\)/g)) assert.doesNotMatch(m[1], /(?:target_qty|quantity):\s*\d/, `${rel}: ${m[0]}`);
  }
});

test('no invented badge, reward or membership is drawn on the customer’s page', () => {
  const words = /\b(?:premium|vip|rewards?|points|loyalty|gold member)\b|بريميوم|مميز|نقاط|مكافآت|خاڵ/i;
  for (const rel of [...ACCOUNT_FILES, 'src/cloud/strings/account.ts']) {
    const src = read(rel);
    assert.doesNotMatch(src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, ''), words, `${rel}: an invented badge or reward`);
    assert.doesNotMatch(src, /membership_tier|subscription_plan|is_investor/, `${rel}: the platform's membership is not a Print Cloud badge`);
    assert.doesNotMatch(src, /placehold\.co|placeholder\.com|picsum\.photos|unsplash\.com/i, `${rel}: no demo photo`);
    assert.doesNotMatch(src, /localStorage|sessionStorage/, `${rel}: nothing of the customer's is kept on the device`);
    assert.doesNotMatch(src, /devPayOrder|dev-pay/, `${rel}: the development payment door is never offered`);
    assert.doesNotMatch(src, /from 'lucide-react'/, `${rel}: icons come from src/cloud/ui/icons.ts`);
  }
});

test('the three money doors of the section send their Idempotency-Key, one per intent', () => {
  const hours = read(`${ACCOUNT_DIR}/AccountHours.tsx`);
  const ship = read(`${ACCOUNT_DIR}/AccountShipmentNew.tsx`);
  const sell = read(`${ACCOUNT_DIR}/AccountBuyback.tsx`);
  assert.match(hours, /const intent = useIntentKey\('convert', body\);/);
  assert.match(hours, /convertCredits\(body, intent\.key\)/);
  assert.match(ship, /const intent = useIntentKey\('shipment', body\);/);
  assert.match(ship, /createShipment\(body, intent\.key\)/);
  // A sell-back reserves the grams: the server requires its key (POST /buybacks), made once per quoted intent.
  assert.match(sell, /const intent = useIntentKey\('buyback', body\);/);
  assert.match(sell, /requestBuyback\(body\.variant_id, body\.qty, intent\.key\)/);
  assert.match(read('src/cloud/api.ts'), /export const requestBuyback = \(variantId: string, qty: number, idempotencyKey: string, opts\?: RequestOptions\) =>\s*post<T\.BuybackRequested>\('\/buybacks', \{ variant_id: variantId, qty \}, keyed\(idempotencyKey, opts\)\)/);
  for (const src of [hours, ship, sell]) assert.match(src, /intent\.renew\(\);/, 'a new intent only after a success');
  // Nothing else in the section moves money.
  for (const rel of ACCOUNT_FILES.filter((f) => !/AccountHours|AccountShipmentNew|AccountBuyback/.test(f))) {
    assert.doesNotMatch(read(rel), /convertCredits\(|createShipment\(|createOrder\(|payOrderFromWallet\(|confirmJob\(|requestBuyback\(/, rel);
  }
  // The key is kept while the body is the same — closing the confirmation does not make a new one.
  const shared = read(`${ACCOUNT_DIR}/shared.tsx`);
  assert.match(shared, /const signature = JSON\.stringify\(body \?\? null\);/);
  assert.match(shared, /if \(seen\.current === signature\) return;/);
});

test('the router: full paths, lazy screens, the 404 last; links go to the sections’ own routes and the main site’s pages', () => {
  const router = read(`${ACCOUNT_DIR}/AccountRoutes.tsx`);
  assert.match(router, /^export default function AccountRoutes\(\)/m);
  const paths = [...router.matchAll(/<Route path="([^"]+)"/g)].map((m) => m[1]);
  assert.equal(paths[paths.length - 1], '*', 'the 404 is the last route');
  for (const p of paths.slice(0, -1)) assert.ok(p === '/account' || p.startsWith('/account/'), p);
  assert.match(router, /<Route path="\*" element=\{<CloudNotFound \/>\} \/>/);
  for (const m of router.matchAll(/const (\w+) = prefetchable\(\(\) => import\('\.\/(\w+)'\)\);/g)) assert.equal(m[1], m[2]);
  assert.doesNotMatch(router, /^import \w+ from '\.\/Account/m, 'no screen is imported statically');

  const home = read(`${ACCOUNT_DIR}/AccountHome.tsx`);
  for (const to of ['/jobs', '/orders', '/library', '/account/hours', '/account/materials', '/account/shipments', '/account/buyback', '/account/transactions', '/account/settings']) {
    assert.ok(home.includes(`to="${to}"`), `the account page leads to ${to}`);
  }
  assert.match(home, /\$\{mainSite\}\/wallet/);
  assert.match(home, /\$\{mainSite\}\/support/);
  // Every in-app link of the section stays inside the address space the ownership table names.
  for (const rel of ACCOUNT_FILES) {
    for (const m of read(rel).matchAll(/\bto=\{?[`"]\/?([a-z-]*)/g)) {
      if (!m[1]) continue;
      assert.ok(['account', 'jobs', 'orders', 'library', 'store'].includes(m[1]), `${rel}: a link to /${m[1]}`);
    }
  }
});
