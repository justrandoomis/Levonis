/**
 * «الأشخاص» ON SCREEN (owner request 2026-11-09; DECISIONS row 304).
 *
 *   - every string of src/lib/personFinanceStrings.ts exists in ar, en and ckb
 *     with the same keys, and the ckb is real Sorani: at least one Sorani-only
 *     letter, none of the Arabic-only ones (ة ى ي ك) — DECISIONS row 183;
 *   - the Sorani added inline on the rebuilt screens passes the same check;
 *   - percentages read as the owner writes them (45%, 7.0%);
 *   - the Investors tab, the Staff tab and «أرباحي» all draw the one-person
 *     card, and the thirteen-card capital grid with its «رأس المال المتبقي في
 *     الحساب» (13,000,000 beside a modal that said otherwise) is gone.
 *
 * Run: node --import tsx --test tests/personFinanceView.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PERSON_FINANCE_STRINGS, percentText, type PersonFinanceStrings } from '../src/lib/personFinanceStrings';
import { codeOf } from './fixtures/source';

const SORANI_ONLY = /[ڕڵێۆەڤگچپژ]/;
const ARABIC_ONLY = /[ةىيك]/;
const ARABIC_SCRIPT = /[؀-ۿ]/;

/** Every leaf text of a strings object, functions called with sample numbers. */
function texts(value: unknown, path = ''): Array<[string, string]> {
  if (typeof value === 'string') return [[path, value]];
  if (typeof value === 'function') {
    const fn = value as (...args: unknown[]) => string;
    return fn.length === 3 ? [[path, fn(5, 4, 1)]] : fn.length === 2 ? [[path, fn('45%', 4)]] : [[`${path}(1)`, fn(1)], [`${path}(4)`, fn(4)]];
  }
  if (value && typeof value === 'object') return Object.entries(value).flatMap(([k, v]) => texts(v, path ? `${path}.${k}` : k));
  return [];
}
const keys = (s: PersonFinanceStrings) => texts(s).map(([k]) => k).sort();

test('the person picture is worded in Arabic, English and real Sorani, key for key', () => {
  assert.deepEqual(keys(PERSON_FINANCE_STRINGS.en), keys(PERSON_FINANCE_STRINGS.ar));
  assert.deepEqual(keys(PERSON_FINANCE_STRINGS.ckb), keys(PERSON_FINANCE_STRINGS.ar));
  for (const [key, text] of texts(PERSON_FINANCE_STRINGS.ar)) assert.match(text, ARABIC_SCRIPT, `ar ${key}`);
  for (const [key, text] of texts(PERSON_FINANCE_STRINGS.en)) assert.doesNotMatch(text, ARABIC_SCRIPT, `en ${key}`);
  const ar = new Map(texts(PERSON_FINANCE_STRINGS.ar));
  for (const [key, text] of texts(PERSON_FINANCE_STRINGS.ckb)) {
    assert.doesNotMatch(text, ARABIC_ONLY, `ckb ${key} carries an Arabic-only letter: ${text}`);
    assert.notEqual(text, ar.get(key), `ckb ${key} is the Arabic`);
    if (text.replace(/[\d\s%·.,:()«»←÷-]/g, '').length > 3) assert.match(text, SORANI_ONLY, `ckb ${key} has no Sorani-only letter: ${text}`);
  }
});

test('the Sorani written inline on the rebuilt screens is Sorani too', () => {
  const calls = ['src/components/financePeople/InvestorProfiles.tsx', 'src/components/financePeople/PeoplePanel.tsx', 'src/components/financePeople/PersonFinanceView.tsx', 'src/components/financePeople/MyEarnings.tsx']
    .flatMap((file) => [...codeOf(file).matchAll(/loc\('([^']*)', '([^']*)', '([^']*)'\)/g)].map((m) => [file, m[1], m[3]] as const));
  assert.ok(calls.length >= 10);
  for (const [file, ar, ckb] of calls) {
    assert.doesNotMatch(ckb, ARABIC_ONLY, `${file}: «${ckb}»`);
    assert.notEqual(ckb, ar, `${file}: the Sorani is the Arabic`);
  }
});

test('percentages read as the owner writes them', () => {
  assert.equal(percentText(4500), '45%');
  assert.equal(percentText(5000), '50%');
  assert.equal(percentText(702, 1), '7.0%');
  assert.equal(percentText(4153, 1), '41.5%');
  assert.equal(percentText(null), '—');
});

test('the three screens draw the one-person card, and the old capital grid is gone', () => {
  const investors = codeOf('src/components/financePeople/InvestorProfiles.tsx');
  assert.match(investors, /<PersonCard /);
  assert.match(investors, /<PersonSheet /);
  assert.match(investors, /`\$\{PEOPLE\}\/people\?\$\{query\}`/);
  for (const gone of [/رأس المال المتبقي في الحساب/, /موّل مخزونًا مستلمًا/, /حصة رأس المال المخصصة للمخزون المتبقي/, /المتاح التراكمي/]) assert.doesNotMatch(investors, gone);
  const staff = codeOf('src/components/financePeople/PeoplePanel.tsx');
  assert.match(staff, /<WorkStatus /);
  assert.match(staff, /<WorkHolds /);
  // One «waiting» figure for wages everywhere: a paid wage whose order is redone is not waiting (second review 7).
  assert.match(staff, /wagesWaiting\(person\.balance\)/);
  assert.doesNotMatch(staff, /staff_pending_settlement_reserve_iqd/);
  assert.match(codeOf('src/components/financePeople/StaffBalanceBreakdown.tsx'), /wagesWaiting\(balance\)/);
  assert.match(staff, /<PersonSheet /);
  const own = codeOf('src/components/financePeople/MyEarnings.tsx');
  assert.match(own, /<PersonCard person=\{person\} own /);
  assert.match(own, /<PersonSheet person=\{person\} own /);
  // What can be withdrawn now sits right under the card; the older figures are details.
  assert.ok(own.indexOf('<PersonCard ') < own.indexOf('fp-hero') && own.indexOf('fp-hero') < own.indexOf('<EarningsSources '));
  const view = codeOf('src/components/financePeople/PersonFinanceView.tsx');
  // Any debt the server reports is drawn (profit, wages, capital) — the old grid showed them (final review).
  for (const debt of [/s\.profitDebt/, /s\.wageDebt/, /s\.capitalDebt/]) assert.match(view, debt);
  // The person's own page never offers the owner's actions or order links.
  assert.match(view, /owner=\{!own\}/);
  assert.match(view, /owner \? s\.holdAction\[h\.reason\] : undefined/);
});

test('held investment money says why in plain words, and the owner can release each sale from its row (owner 2026-11-10)', () => {
  // «بيع وينتظر الإفراج what he mean ? … make it easy and solved it»
  assert.equal(PERSON_FINANCE_STRINGS.ar.soldHeld, 'بيعت، والمبلغ بانتظار تسجيله');
  const view = codeOf('src/components/financePeople/PersonFinanceView.tsx');
  // Under the sold amount: why it waits, in the hold reasons' own words.
  assert.match(view, /<CapitalBar capital=\{inv\.capital\} holds=\{inv\.holds\} s=\{s\} \/>/);
  assert.match(view, /p\.key === 'sold' && soldWhy/);
  // Each held sale, with one button per missing step: the purchase price, then the cash.
  assert.match(view, /openOrder\(h\.order_id, 'cost'\)/);
  assert.match(view, /openOrder\(h\.order_id, 'collection'\)/);
  assert.match(view, /s\.enterCost/);
  assert.match(view, /s\.recordCash/);
  // Only the owner: the person's own page never gets order ids or buttons (DECISIONS row 220).
  assert.match(view, /openOrder=\{own \? undefined : openOrder\}/);
  assert.match(view, /for \(const h of owner && openOrder \?/);
  // One row per order, with the count beyond the server's cap.
  assert.match(view, /byOrder\.set\(h\.order_id/);
  assert.match(view, /s\.moreSales\(more\)/);
  assert.match(codeOf('src/components/financePeople/InvestorProfiles.tsx'), /<PersonCard key=\{p\.user_id\}[^\n]*openOrder=\{openOrder\} \/>/);
  assert.doesNotMatch(codeOf('src/components/financePeople/MyEarnings.tsx'), /openOrder/);
  // The order opens at that step; the cash form starts at what the order still owes and saves nothing by itself.
  const workspace = codeOf('src/components/financeWorkspace/FinanceWorkspace.tsx');
  assert.match(workspace, /<InvestorPanel [^>]*openOrder=\{openOrderAt\}/);
  assert.match(workspace, /focus=\{orderFocus\.step\} focusLine=\{orderFocus\.line\}/);
  // The people screens re-read in place after a SAVE in the order sheet (not after its background refresh), keeping scroll and open lists.
  assert.match(workspace, /onSaved=\{\(\) => \{ orderChanged\.current = true; \}\}/);
  assert.match(workspace, /<InvestorPanel [^>]*revision=\{peopleRevision\}/);
  assert.doesNotMatch(workspace, /key=\{`(staff|investors):\$\{peopleRevision\}`\}/);
  assert.match(codeOf('src/components/financePeople/InvestorProfiles.tsx'), /useReloadOn\(revision, people\.load\)/);
  assert.match(codeOf('src/components/financePeople/PeoplePanel.tsx'), /useReloadOn\(revision, people\.load\)/);
  const sheet = codeOf('src/components/financeWorkspace/OrderProfitSheet.tsx');
  assert.match(sheet, /focus === 'collection' \? 'collections' : null/);
  assert.match(sheet, /beginEdit\('cogs_iqd'/);
  assert.match(sheet, /data\.lines\.find\(\(l\) => l\.id === focusLine\)/);
  assert.match(sheet, /onChanged\(\); onSaved\?\.\(\);/);
  const panel = codeOf('src/components/adminOperations/FinanceOperationsPanel.tsx');
  const prefill = panel.slice(panel.indexOf('const prefilled = useRef(false);'), panel.indexOf('const touch = () =>'));
  // The door part from the courier, else the Gini part from the bank; for that order only; never a write.
  assert.match(prefill, /receivables\?order_id=/);
  assert.match(prefill, /door_balance_iqd > 0\) \{ setPayer\('courier'\)/);
  assert.match(prefill, /bank_balance_iqd > 0\) \{ setPayer\('bank'\)/);
  assert.doesNotMatch(prefill, /api\.(post|patch|put)/);
  // A table button the owner pressed is never overwritten by a late pre-fill.
  assert.equal((panel.match(/touch\(\);\s*setOrder\(r\.id\);/g) ?? []).length, 2);
  // The Staff tab keeps the step; a cancelled sale gets no step buttons.
  assert.match(codeOf('src/components/financePeople/PeoplePanel.tsx'), /\(id, focus\) => \{ setSheet\(null\); openOrder\(id, focus\); \}/);
  assert.match(view, /!h\.reasons\.includes\('cancelled'\)/);
});

test('the missing-costs sheet groups by product and size, no-price groups first, and writes only after the owner confirms (owner 2026-11-10)', async () => {
  const { groupMissing } = await import('../src/components/financeWorkspace/MissingCostsSheet');
  const line = (order: string, product: string, option: string | null, qty: number, cogs: number | null, estimate: number | null, extra: { restocked_qty?: number; cost_qty?: number; stock_qty?: number } = {}) => ({ order_id: order, version: 1, delivered_at: '2026-11-05T10:00:00Z', customer_name: null, line_id: `${order}:${product}:${option}`, product_id: product, name: product, option, color: null, qty, confidence: cogs == null ? 'unknown' : 'estimated', estimate_unit_iqd: estimate, cogs_iqd: cogs, ...extra });
  const groups = groupMissing([line('a', 'esun', 'BLACK', 1, 15271, 15271), line('b', 'esun', 'BLACK', 2, 30542, 15271), line('a', 'magnet', 'D8', 30, null, null), line('c', 'magnet', 'D6', 30, null, null)]);
  assert.deepEqual(groups.map((g) => [g.name, g.variant, g.qty, g.orders]), [['magnet', 'D8', 30, 1], ['magnet', 'D6', 30, 1], ['esun', 'BLACK', 3, 2]]);
  assert.deepEqual(groups[2].estimates, [15271]);
  // Pieces put back in stock are not sold; a line with stock-batch pieces is priced in its order, not here (review 2026-11-11).
  const [returned] = groupMissing([line('r', 'magnet', 'D8', 3, null, null, { restocked_qty: 1, cost_qty: 2 }), line('s', 'magnet', 'D8', 4, null, null, { cost_qty: 4, stock_qty: 2 })]);
  assert.deepEqual([returned.qty, returned.returned, returned.ready.map((l) => l.order_id), returned.stock.map((l) => l.order_id)], [6, 1, ['r'], ['s']]);
  const sheet = codeOf('src/components/financeWorkspace/MissingCostsSheet.tsx');
  // The only write is the server's per-line pricing, behind the confirm step; the server multiplies by the kept pieces.
  assert.match(sheet, /api\.post<[^>]*>\(`\$\{WORKSPACE_API\}\/missing-costs\/lines`/);
  assert.match(sheet, /unit_iqd: unit, cost_qty: costQty\(l\)/);
  assert.doesNotMatch(sheet, /value_iqd/);
  assert.equal((sheet.match(/api\.post/g) ?? []).length, 1);
  assert.match(sheet, /for \(const l of g\.ready\)/);
  assert.match(sheet, /onClick=\{\(\) => void apply\(\)\}/);
  assert.match(sheet, /setConfirming\(true\)/);
  // While one group writes, and until the list is read again, the others wait (two groups can share an order).
  assert.match(sheet, /locked=\{stale \|\| \(running !== null && running !== g\.key\)\}/);
  assert.match(sheet, /openOrder\(l\.order_id, 'cost', l\.line_id\)/);
  const workspace = codeOf('src/components/financeWorkspace/FinanceWorkspace.tsx');
  // No bare dash for an incomplete total: what complete orders say, and what is missing.
  assert.match(workspace, /fullNet \?\? \(netFromKnown \? known!\.owner_net_iqd : null\)/);
  assert.match(workspace, /missing && missing\.lines > 0/);
  assert.match(workspace, /onMissing=\{\(\) => setMissingOpen\(true\)\}/);
  // In dollars the complete orders' figures are the server's cents, never dinars among dollars.
  assert.match(workspace, /netFromKnown \? uk\?\.owner_net_cents \?\? null/);
  assert.match(workspace, /costFromKnown \? uk\?\.cost_cents \?\? null/);
});
