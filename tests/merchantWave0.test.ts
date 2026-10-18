/**
 * WAVE 0 OF THE MERCHANT ADMIN PLAN — the small things a merchant meets every
 * day, each pinned here:
 *
 *   1. a tap anywhere on a list card opens its record (the title link stays
 *      the only way in for a keyboard or a screen reader);
 *   2. the workspace has a language / account / help / sign-out menu;
 *   3. the ledger filters by period, in Baghdad days, with the route's own
 *      parameter names;
 *   4. an action toast stays 10 s, and product bulk actions offer «تراجع»
 *      only where putting things back is exact;
 *   5. the Today dock opens delivery settings and the share window;
 *   6. right-to-left details: arrow keys follow the drawn direction, codes
 *      are typed left to right.
 *
 * The Sorani of the shared pieces is pinned in tests/soraniStorefrontGaps.test.ts.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ROOT } from './fixtures/d1';
import { ROW_TAP_SKIP, rowTapLink } from '../src/lib/listView';
import { addDays, baghdadDayStart, baghdadToday, isDay, ledgerRange } from '../src/components/merchant/finance/ledgerPeriod';
import { bulkInverse, UNDO_MAX_CALLS } from '../src/components/merchant/catalog/bulkUndo';
import { COUNTER_STRINGS } from '../src/components/merchant/counter/strings';
import { ACCOUNT_WORDS } from '../src/components/merchant/shell/accountWords';

const read = (rel: string) => readFileSync(join(ROOT, rel), 'utf8');
/** Source without comments, so a sentence about a pattern never satisfies it. */
const code = (rel: string) =>
  read(rel)
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, '')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:'"`])\/\/[^\n]*/g, '$1');

// ------------------------------------------------------------------ 1. row taps

/** A fake element: its own tag set decides what `closest` finds. */
function el(matches: string[], inside = true) {
  return {
    closest: (selector: string) => (selector.split(',').some((s) => matches.includes(s.trim())) ? {} : null),
    inside,
  };
}
const LINK = { clicked: 0 };
function row() {
  return {
    contains: (node: unknown) => !!(node as { inside?: boolean } | null)?.inside,
    querySelector: (selector: string) => (selector === '[data-row-link]' ? LINK : null),
  };
}
const tap = (target: ReturnType<typeof el> | null, over: Partial<{ button: number; defaultPrevented: boolean; selection: string }> = {}) =>
  rowTapLink({ target, row: row(), button: 0, defaultPrevented: false, selection: '', ...over });

test('a tap on the empty part of a card opens its title link', () => {
  assert.equal(tap(el(['div'])), LINK);
  assert.equal(tap(el(['dd'])), LINK, 'a field value is part of the card');
});

test('a tap that began on a control acts for that control, never opens the row', () => {
  for (const control of ['a', 'button', 'input', 'label', 'select', 'textarea', '[role="checkbox"]', '[role="menuitem"]', '[role="menu"]', '[role="dialog"]', '[data-row-tap-skip]']) {
    assert.ok(ROW_TAP_SKIP.split(',').includes(control), `${control} is not in the skip list`);
    assert.equal(tap(el([control])), null, `a tap on ${control} was passed on`);
  }
  assert.equal(tap(el(['div']), { button: 1 }), null, 'the middle button is the browser’s');
  assert.equal(tap(el(['div']), { defaultPrevented: true }), null, 'handled already');
  assert.equal(tap(el(['div']), { selection: 'PLA Basic' }), null, 'selecting text is not opening');
  assert.equal(tap(el(['div'], false)), null, 'a click that came through a portal from outside the row');
  assert.equal(tap(null), null);
});

test('DataList passes the tap on with its modifier keys, and the row never becomes a control', () => {
  const d = code('src/components/ui/DataList.tsx');
  assert.match(d, /<Link to=\{href\} data-row-link /);
  assert.match(d, /const tapProps = \(opens: boolean\) => \(opens \? \{ onClick: onRowTap, 'data-row-tap': '' \} : \{\}\);/);
  assert.equal(d.match(/\{\.\.\.tapProps\(opens\)\}/g)?.length, 2, 'both the table row and the card');
  assert.match(d, /ctrlKey: e\.ctrlKey, metaKey: e\.metaKey, shiftKey: e\.shiftKey, altKey: e\.altKey/);
  assert.match(d, /active:bg-\[var\(--clay-well-bg\)\]/, 'a pressed card shows it is pressed');
  assert.doesNotMatch(d, /<(tr|li)\b[^>]*(role=|tabIndex|onKeyDown)/);
});

// ------------------------------------------------------------------ 2. account menu

test('the workspace has a language, account, help and sign-out menu — top bar on a wide screen, «More» on a phone', () => {
  const shell = code('src/components/merchant/shell/MerchantShell.tsx');
  assert.match(shell, /const AccountMenu = lazy\(\(\) => import\('\.\/AccountMenu'\)\);/, 'its own chunk');
  assert.doesNotMatch(shell, /^import[^;]*from '\.\/AccountMenu'/m, 'never a static import of the frame');
  assert.match(
    shell,
    /account=\{\s*isPhone \? null : \(\s*<ChunkBoundary renderFallback=\{\(\) => null\}>\s*<Suspense fallback=\{<span aria-hidden="true" className="inline-block h-11 w-11" \/>\}>\s*<AccountMenu \/>/,
    'lazy, wider screens only, and a chunk that does not arrive leaves the slot empty'
  );
  assert.match(shell, /\{bell\}\s*\{account\}/, 'at the end of the top bar, after the bell');
  const more = code('src/components/merchant/shell/MoreSheet.tsx');
  assert.match(more, /<AccountPanel onDone=\{onClose\} \/>/);

  const menu = code('src/components/merchant/shell/AccountMenu.tsx');
  assert.match(menu, /\['ar', 'العربية'\],\s*\['en', 'English'\],\s*\['ckb', 'کوردی'\],/, 'each language in its own name');
  assert.match(menu, /setLang\(next\);/, 'applied at once');
  assert.match(menu, /api\.patch\('\/api\/profile', \{ locale: next \}\)\.catch\(\(\) => undefined\)/, 'kept on the profile, best effort');
  assert.match(menu, /export const ACCOUNT_PATH = '\/settings';/);
  assert.match(menu, /export const HELP_PATH = '\/support';/);
  assert.match(menu, /await auth\?\.logout\(\);[\s\S]{0,200}go\(SIGNED_OUT_PATH\);/, 'signs out, then lands on sign-in');
  assert.match(menu, /resolveLink\(path\)/, 'a platform page from a store’s own address is another site');
  assert.match(menu, /<Menu\s+label=\{say\(loc, W\.you\)\}/);
  assert.match(menu, /<Segmented\s+group="ws-language"/, 'the phone’s language switch is the shared radiogroup');
  assert.match(menu, /import \{ ACCOUNT_WORDS as W \} from '\.\/accountWords';/, 'its words ride in its own chunk');
  for (const [k, words] of Object.entries(ACCOUNT_WORDS)) {
    const [ar, en, ckb] = words as readonly string[];
    assert.ok(ar && en && ckb && ckb !== ar, `${k} is not three languages`);
  }
});

test('the frame carries only the key that opens the search; the search itself is a lazy chunk', () => {
  const shell = code('src/components/merchant/shell/MerchantShell.tsx');
  assert.match(shell, /const WorkspacePalette = lazy\(\(\) => import\('\.\/WorkspacePalette'\)\);/);
  assert.match(shell, /import \{ isPaletteKey \} from '\.\/paletteModel';/);
  assert.doesNotMatch(shell, /CommandPalette|\/api\/merchant\/search|formatMoney/, 'search code back in the frame');
  const palette = code('src/components/merchant/shell/WorkspacePalette.tsx');
  assert.match(palette, /`\/api\/merchant\/search\?q=\$\{encodeURIComponent\(q\)\}`/);
  assert.match(palette, /\}, SEARCH_DEBOUNCE_MS\);/, 'one request per pause in typing');
});

// ------------------------------------------------------------------ 3. ledger period

test('a Baghdad day begins at 21:00 UTC the day before, spelled as the ledger spells created_at', () => {
  assert.equal(baghdadDayStart('2026-10-01'), '2026-09-30T21:00:00.000Z');
  assert.equal(baghdadDayStart('2026-01-01'), '2025-12-31T21:00:00.000Z');
  assert.equal(baghdadToday(Date.parse('2026-10-31T20:59:59Z')), '2026-10-31');
  assert.equal(baghdadToday(Date.parse('2026-10-31T21:00:00Z')), '2026-11-01', 'midnight in Baghdad is a new day');
  assert.equal(addDays('2026-02-28', 1), '2026-03-01');
  assert.equal(isDay('2026-02-31'), false);
  assert.equal(isDay('2026-02-28'), true);
});

test('the ledger periods: this month, last month, a custom pair of days — from inclusive, to exclusive', () => {
  const now = Date.parse('2026-10-18T09:00:00Z');
  assert.deepEqual(ledgerRange('all', now), { ok: true, range: { from: '', to: '' } });
  assert.deepEqual(ledgerRange('this_month', now), { ok: true, range: { from: '2026-09-30T21:00:00.000Z', to: '' } });
  assert.deepEqual(ledgerRange('last_month', now), { ok: true, range: { from: '2026-08-31T21:00:00.000Z', to: '2026-09-30T21:00:00.000Z' } });
  // January's «last month» is December of the year before.
  assert.deepEqual(ledgerRange('last_month', Date.parse('2026-01-05T09:00:00Z')), {
    ok: true,
    range: { from: '2025-11-30T21:00:00.000Z', to: '2025-12-31T21:00:00.000Z' },
  });
  // The first hours of the 1st in Baghdad are still the last day of the month in UTC.
  assert.deepEqual(ledgerRange('this_month', Date.parse('2026-10-31T22:00:00Z')), { ok: true, range: { from: '2026-10-31T21:00:00.000Z', to: '' } });
  assert.deepEqual(ledgerRange('custom', now, { from: '2026-10-01', to: '2026-10-07' }), {
    ok: true,
    range: { from: '2026-09-30T21:00:00.000Z', to: '2026-10-07T21:00:00.000Z' },
  });
  assert.deepEqual(ledgerRange('custom', now, { from: '2026-10-07', to: '2026-10-01' }), { ok: false, reason: 'order' }, 'never silently swapped');
  assert.deepEqual(ledgerRange('custom', now, { from: '', to: '2026-10-01' }), { ok: false, reason: 'incomplete' });
  // A created_at compares as a string: a sale at 23:30 Baghdad on the 7th is inside, 00:30 on the 8th is not.
  const r = ledgerRange('custom', now, { from: '2026-10-01', to: '2026-10-07' });
  assert.ok(r.ok);
  const inside = (createdAt: string) => createdAt >= r.range.from && createdAt < r.range.to;
  assert.equal(inside('2026-10-07T20:30:00.000Z'), true);
  assert.equal(inside('2026-10-07T21:30:00.000Z'), false);
  assert.equal(inside('2026-09-30T21:30:00.000Z'), true, '00:30 on the 1st in Baghdad');
});

test('the ledger request carries the route’s own `from` / `to`, and the route accepts the instant', () => {
  const api = code('src/components/merchant/finance/financeApi.ts');
  assert.match(api, /if \(q\.from\) p\.set\('from', q\.from\);/);
  assert.match(api, /if \(q\.to\) p\.set\('to', q\.to\);/);
  const route = code('worker/routes/merchantFinance.ts');
  assert.match(route, /const from = c\.req\.query\('from'\) \?\? '';/);
  assert.match(route, /const to = c\.req\.query\('to'\) \?\? '';/);
  const isoDay = /const ISO_DAY = \/(.*)\/;/.exec(route)?.[1];
  assert.ok(isoDay, 'the route’s date pattern moved');
  const re = new RegExp(isoDay);
  assert.ok(re.test(baghdadDayStart('2026-10-01')), 'the route refuses the bound this screen sends');
  assert.ok(Number.isFinite(Date.parse(baghdadDayStart('2026-10-01'))));
  const ledger = code('src/components/merchant/finance/FinanceLedger.tsx');
  assert.match(ledger, /\.ledger\(\{ kind, from, to \}\)/);
  assert.match(ledger, /\.ledger\(\{ kind, from, to, cursor \}\)/, 'the next page keeps the period');
  assert.match(ledger, /\}, \[kind, from, to\]\);/, 'a new period reloads from the top');
  assert.match(ledger, /<Input ltr type="date"/);
});

// ------------------------------------------------------------------ 4. undo

test('an action toast stays at least 10 s', () => {
  assert.match(code('src/lib/toastStore.ts'), /const ACTION_MIN_MS = 10_000;/);
});

test('bulk «تراجع» only where the way back is exact', () => {
  const p = (id: string, over: Partial<{ featured: boolean; price_iqd: number; state: 'draft' | 'published' | 'hidden' | 'archived' }> = {}) => ({
    id,
    featured: false,
    price_iqd: 10_000,
    state: 'published' as const,
    ...over,
  });
  // Feature: only the ones that were not featured go back.
  assert.deepEqual(bulkInverse('feature', {}, [p('a'), p('b', { featured: true })], ['a', 'b'], true), [{ action: 'unfeature', ids: ['a'], extra: {} }]);
  assert.equal(bulkInverse('feature', {}, [p('b', { featured: true })], ['b'], true), null, 'nothing changed, nothing to undo');
  assert.deepEqual(bulkInverse('unfeature', {}, [p('a', { featured: true }), p('b')], ['a', 'b'], true), [{ action: 'feature', ids: ['a'], extra: {} }]);
  assert.equal(bulkInverse('unfeature', {}, [p('a', { featured: true })], ['a'], false), null, 'featuring again needs selling rights');
  // Price: each product back to its own price, one call per price.
  assert.deepEqual(bulkInverse('set_price', { price_iqd: 5000 }, [p('a'), p('b', { price_iqd: 12_000 }), p('c')], ['a', 'b', 'c'], true), [
    { action: 'set_price', ids: ['a', 'c'], extra: { price_iqd: 10_000 } },
    { action: 'set_price', ids: ['b'], extra: { price_iqd: 12_000 } },
  ]);
  assert.equal(
    bulkInverse('set_price', { price_iqd: 5000 }, Array.from({ length: UNDO_MAX_CALLS + 1 }, (_, i) => p(`p${i}`, { price_iqd: 1000 * (i + 1) })), Array.from({ length: UNDO_MAX_CALLS + 1 }, (_, i) => `p${i}`), true),
    null,
    'more distinct prices than calls allowed'
  );
  assert.equal(bulkInverse('set_price', { price_iqd: 5000 }, [p('a', { price_iqd: 0 })], ['a'], true), null, 'a published product is never set back to 0');
  assert.deepEqual(bulkInverse('set_price', { price_iqd: 5000 }, [p('a', { price_iqd: 0, state: 'draft' })], ['a'], true), [{ action: 'set_price', ids: ['a'], extra: { price_iqd: 0 } }]);
  assert.equal(bulkInverse('set_price', { price_iqd: 5000 }, [p('a')], ['a', 'unseen'], true), null, 'a product the list never showed cannot be put back');
  // No exact inverse: no undo.
  for (const action of ['publish', 'hide', 'archive', 'draft', 'delete', 'set_stock', 'add_to_collection', 'remove_from_collection'] as const) {
    assert.equal(bulkInverse(action, { stock: 3, collection_id: 'c1' }, [p('a')], ['a'], true), null, `${action} offered an undo`);
  }
  const manager = code('src/components/merchant/catalog/CatalogManager.tsx');
  assert.match(manager, /const before = \(rows \?\? \[\]\)\.filter\(\(p\) => ids\.includes\(p\.id\)\);/, 'the earlier values are read before the call');
  assert.match(manager, /toast\.success\(s\.bulkDone\(r\.done, ids\.length\), undo\)/);
  assert.match(manager, /if \(r\.results\.some\(\(x\) => !x\.ok\)\) throw new Error\('partial'\);/, 'a partial undo is never reported as done');
});

// ------------------------------------------------------------------ 5. dock

test('the Today dock opens delivery settings and the share window', () => {
  const dock = code('src/components/merchant/counter/QuickDock.tsx');
  assert.match(dock, /\{ id: 'delivery', to: merchantHref\.storeDelivery\(\), icon: Truck, label: s\.dock\.delivery \}/);
  assert.match(dock, /\{ id: 'share', open: \(\) => setSharing\(true\), icon: Share2, label: s\.dock\.share \}/);
  assert.match(dock, /const ShareStoreSheet = lazy\(\(\) => import\('\.\.\/share\/ShareStoreSheet'\)\);/, 'the QR encoder stays out of Today');
  assert.match(dock, /<ShareStoreSheet open onClose=\{\(\) => setSharing\(false\)\} kit=\{null\} \/>/);
  for (const lang of ['ar', 'en', 'ckb'] as const) {
    assert.ok(COUNTER_STRINGS[lang].dock.delivery && COUNTER_STRINGS[lang].dock.share, lang);
  }
  assert.notEqual(COUNTER_STRINGS.ckb.dock.share, COUNTER_STRINGS.ar.dock.share);
  assert.notEqual(COUNTER_STRINGS.ckb.dock.delivery, COUNTER_STRINGS.ar.dock.delivery);
});

// ------------------------------------------------------------------ 6. RTL

test('arrow keys follow the reading direction; codes are typed left to right', () => {
  // Both already flip by direction: Segmented by the reading language (it is
  // part of every store page's fixed weight, which has no byte to spare), Tabs
  // by the strip's own drawn direction.
  assert.match(code('src/components/ui/Segmented.tsx'), /const forward = dir === 'rtl' \? 'ArrowLeft' : 'ArrowRight';/);
  const tabs = code('src/components/ui/Tabs.tsx');
  assert.match(tabs, /const rtl = \(getComputedStyle\(e\.currentTarget\)\.direction \|\| dir\) === 'rtl';/);
  assert.match(tabs, /const forward = rtl \? 'ArrowLeft' : 'ArrowRight';/);
  const prompt = code('src/components/ui/PromptDialog.tsx');
  assert.match(prompt, /dir=\{numeric \|\| ltr \? 'ltr' : 'auto'\}/);
  assert.match(prompt, /spellCheck=\{ltr \? false : undefined\}/);
  assert.match(prompt, /ltr=\{asking\?\.ltr\}/);
  assert.match(code('src/components/merchant/orders/OrdersList.tsx'), /inputMode: 'text',\s*ltr: true,/, 'the tracking number');
  for (const f of ['src/components/merchant/catalog/ProductEditorSheet.tsx', 'src/components/merchant/catalog/VariantEditor.tsx']) {
    assert.match(code(f), /<Input ltr value=\{(form|v)\.sku\} maxLength=\{64\} spellCheck=\{false\} autoCapitalize="off" autoCorrect="off"/, `${f}: the SKU`);
  }
  assert.match(code('src/components/merchant/dashboard/StoreSettingsTab.tsx'), /ltr\s*type="tel"\s*inputMode="tel"/, 'the contact phone');
});
