/**
 * The workspace primitives' BEHAVIOUR, tested where it is pure (wave 3, W3-0).
 *
 * The repository has no DOM runner, so the rules that decide what a primitive
 * DOES live in plain functions and are exercised here directly: how a list
 * moves under the arrow keys and finds a row by typing, how a figure typed on
 * an Arabic or Kurdish keyboard is read, how a dinar amount is written, what a
 * list shows when its request failed, which layer hears Escape, where a
 * thrown sheet comes to rest, and what the toast queue keeps. The DOM half
 * (focus trap, focus return, the keyboard reaching the real components) is
 * driven in a browser by scripts/e2e-ui-kit.mjs.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { edgeIndex, filterByQuery, matchScore, normalizeSearchText, stepIndex, typeaheadIndex } from '../src/lib/listNav';
import { editableNumber, formatFigure, formatPercent, groupedNumber, parseLocaleNumber, toAsciiDigits } from '../src/lib/localeNumber';
import { formatMoney, formatSignedMoney, iqdNumber, iqdUnit } from '../src/lib/money';
import { formatIqd } from '../src/lib/api';
import { isWideLayout, listView } from '../src/lib/listView';
import { handleOverlayKey, layerAbove, openLayerCount, pushLayer } from '../src/components/ui/overlayStack';
import { UI_LAYERS, overlayLayer } from '../src/components/ui/Overlay';
import { detentSizes, restingExtent } from '../src/components/ui/Sheet';
import { isPaletteShortcut } from '../src/components/ui/CommandPalette';
import { toast, toastQueue } from '../src/components/ui/Toast';
import { CROSS_FADE, PRESS_MS } from '../src/lib/motion';

// ---------------------------------------------------------------- listNav

test('arrow keys step over separators and disabled rows, and wrap at both ends', () => {
  const off = (i: number) => i === 1 || i === 3;
  assert.equal(stepIndex(0, 1, 5, off), 2, 'row 1 is skipped');
  assert.equal(stepIndex(4, 1, 5, off), 0, 'past the end wraps to the first');
  assert.equal(stepIndex(0, -1, 5, off), 4, 'before the start wraps to the last');
  assert.equal(stepIndex(-1, 1, 5, off), 0, 'nothing active: forward lands on the first enabled row');
  assert.equal(stepIndex(-1, -1, 5, off), 4, 'nothing active: back lands on the last enabled row');
  assert.equal(stepIndex(2, 1, 0), -1, 'an empty list has nowhere to go');
  assert.equal(stepIndex(2, 1, 3, () => true), 2, 'all disabled: stay put');
  assert.equal(edgeIndex('first', 4, (i) => i === 0), 1);
  assert.equal(edgeIndex('last', 4, (i) => i === 3), 2);
});

test('typeahead jumps to the next row starting with the letter, and the same letter again cycles', () => {
  const labels = ['تعديل', 'طباعة الفاتورة', 'طلب الشحن', 'حذف', 'Duplicate', 'Delete'];
  assert.equal(typeaheadIndex(labels, -1, 'ط'), 1);
  assert.equal(typeaheadIndex(labels, 1, 'ط'), 2, 'a second «ط» moves on');
  assert.equal(typeaheadIndex(labels, 2, 'ط'), 1, 'and wraps');
  assert.equal(typeaheadIndex(labels, 1, 'طط'), 2, '«طط» is two presses of «ط», not a search for «طط»');
  assert.equal(typeaheadIndex(labels, 4, 'de'), 5, 'a longer prefix searches from the active row');
  assert.equal(typeaheadIndex(labels, -1, 'd'), 4, 'case-folded');
  assert.equal(typeaheadIndex(labels, -1, 'x'), -1);
  assert.equal(typeaheadIndex(labels, -1, 'ح', (i) => i === 3), -1, 'a disabled row is not a typeahead target');
});

test('search folds the letters Arabic and Kurdish keyboards type differently, never the display', () => {
  assert.equal(normalizeSearchText('أسعار'), normalizeSearchText('اسعار'));
  assert.equal(normalizeSearchText('كتاب'), normalizeSearchText('کتاب'), 'Arabic kaf = Kurdish keheh');
  assert.equal(normalizeSearchText('علي'), normalizeSearchText('علی'), 'Arabic yeh = Farsi/Kurdish yeh');
  assert.equal(normalizeSearchText('مُنتَج'), 'منتج', 'diacritics do not hide a word');
  assert.equal(normalizeSearchText('طلب ١٢'), 'طلب 12', 'Arabic-Indic digits find Latin digits');
  assert.equal(normalizeSearchText('  Orders  '), 'orders');
});

test('filtering keeps every word, and a label that STARTS with the query ranks first', () => {
  const items = [
    { label: 'Pending orders', keywords: ['الطلبات'] },
    { label: 'Orders', keywords: [] },
    { label: 'Reorder settings' },
    { label: 'Coupons', hint: 'orders discount' },
  ];
  assert.deepEqual(filterByQuery(items, 'order').map((x) => x.label), ['Orders', 'Pending orders', 'Reorder settings', 'Coupons']);
  assert.deepEqual(filterByQuery(items, 'الطلبات').map((x) => x.label), ['Pending orders'], 'a keyword in the other language finds it');
  assert.deepEqual(filterByQuery(items, 'orders pend').map((x) => x.label), ['Pending orders'], 'every word must match');
  assert.equal(filterByQuery(items, '   ').length, items.length, 'an empty query shows everything, in order');
  assert.equal(matchScore({ label: 'Coupons' }, 'zzz'), 0);
});

// ---------------------------------------------------------- localeNumber

test('a figure typed in Arabic-Indic or Extended Arabic-Indic digits is read, separators and all', () => {
  assert.equal(toAsciiDigits('١٢٣٤٥٦٧٨٩٠'), '1234567890');
  assert.equal(toAsciiDigits('۱۲۳۴۵۶۷۸۹۰'), '1234567890');
  assert.deepEqual(parseLocaleNumber('١٢٬٠٠٠'), { value: 12000, valid: true }, 'Arabic thousands separator');
  assert.deepEqual(parseLocaleNumber('۱۲۰۰۰'), { value: 12000, valid: true });
  assert.deepEqual(parseLocaleNumber('12,000'), { value: 12000, valid: true });
  assert.deepEqual(parseLocaleNumber(' 12 000 '), { value: 12000, valid: true });
  assert.deepEqual(parseLocaleNumber(''), { value: null, valid: true }, 'empty is not an error — it is empty');
  assert.deepEqual(parseLocaleNumber('−250'), { value: -250, valid: true }, 'a real minus sign');
  assert.deepEqual(parseLocaleNumber('-0'), { value: 0, valid: true });
});

test('whole dinars are never rounded into existence: a fraction or junk is INVALID, not 13', () => {
  assert.deepEqual(parseLocaleNumber('12.5'), { value: null, valid: false });
  assert.deepEqual(parseLocaleNumber('١٢٫٥'), { value: null, valid: false }, 'the Arabic decimal point too');
  assert.deepEqual(parseLocaleNumber('12abc'), { value: null, valid: false });
  assert.deepEqual(parseLocaleNumber('1e5'), { value: null, valid: false });
  assert.deepEqual(parseLocaleNumber('9999999999999999'), { value: null, valid: false }, 'past safe integers');
  assert.deepEqual(parseLocaleNumber('12.5', 2), { value: 12.5, valid: true }, 'where decimals are allowed');
  assert.deepEqual(parseLocaleNumber('١٢٫٥', 1), { value: 12.5, valid: true });
  assert.deepEqual(parseLocaleNumber('12.555', 2), { value: null, valid: false });
  assert.equal(editableNumber(12000), '12000');
  assert.equal(editableNumber(null), '');
  assert.equal(groupedNumber(1234567), '1,234,567');
  assert.equal(groupedNumber(undefined), '');
});

test('a figure for reading uses the same digits as the money beside it', () => {
  assert.equal(formatFigure(12000, 'en'), '12,000');
  assert.equal(formatPercent(12.5, 'en'), '12.5%');
  assert.equal(formatPercent(-3, 'en'), '-3%');
  assert.equal(formatPercent(12.5, 'en', 1, true), '+12.5%', 'a rise says so');
  assert.equal(formatPercent(0, 'en', 1, true), '0%', 'no change has no sign');
  assert.equal(formatFigure(-2, 'en', 0, true), '-2');
  // Arabic and Sorani follow formatIqd's locale digits, whatever this machine's locale is.
  assert.equal(formatFigure(12000, 'ar'), (12000).toLocaleString());
  assert.equal(formatFigure(12000, 'ckb'), formatIqd(12000).replace(/\s*د\.ع$/, ''));
});

// ------------------------------------------------------------------ money

test('one dinar format: د.ع for Arabic and Sorani, IQD for English — and Arabic is formatIqd exactly', () => {
  for (const n of [0, 12000, 1234567, 999.6]) {
    assert.equal(formatMoney(n, 'ar'), formatIqd(n), 'the workspace and the order page print one string');
    assert.equal(formatMoney(n, 'ckb'), formatIqd(n));
  }
  assert.equal(formatMoney(12000, 'en'), '12,000 IQD');
  assert.equal(iqdUnit('ar'), 'د.ع');
  assert.equal(iqdUnit('ckb'), 'د.ع');
  assert.equal(iqdUnit('en'), 'IQD');
  assert.equal(iqdNumber(1234.4, 'en'), '1,234');
  assert.equal(formatMoney(null, 'ar'), '—', 'no figure is «—», never «0 د.ع»');
  assert.equal(formatMoney(Number.NaN, 'en'), '—');
  assert.equal(formatSignedMoney(3000, 'en'), '+3,000 IQD');
  assert.equal(formatSignedMoney(-3000, 'en'), '−3,000 IQD', 'a real minus sign that does not break from its digits');
  assert.equal(formatSignedMoney(0, 'en'), '0 IQD', 'zero carries no sign');
});

// --------------------------------------------------------------- listView

test('a failed request is NEVER an empty list, and "not loaded" is never empty either', () => {
  const failure = new Error('network');
  assert.equal(listView([], false, failure), 'error', 'the [] a failed load leaves behind is not "you have none"');
  assert.equal(listView(undefined, false, failure), 'error');
  assert.equal(listView(null, true, undefined), 'skeleton');
  assert.equal(listView(undefined, false, undefined), 'skeleton', 'no answer yet');
  assert.equal(listView([], true, undefined), 'skeleton');
  assert.equal(listView([], false, undefined), 'empty', 'only a successful, empty answer is empty');
  assert.equal(listView([1], false, undefined), 'rows');
  assert.equal(listView([1], true, undefined), 'refreshing');
  assert.equal(listView([1, 2], false, failure), 'stale', 'a failed refresh keeps the rows it had');
  assert.equal(listView([], false, null), 'empty');
});

test('the table/cards switch has hysteresis, so a scrollbar cannot make it flicker', () => {
  assert.equal(isWideLayout(700, 640, null), true);
  assert.equal(isWideLayout(630, 640, null), false);
  assert.equal(isWideLayout(630, 640, true), true, 'a table stays a table a few px under the line');
  assert.equal(isWideLayout(620, 640, true), false);
  assert.equal(isWideLayout(639, 640, false), false, 'cards need the full width to become a table');
});

// ------------------------------------------------------------ overlay stack

function key(k: string, extra: Partial<{ defaultPrevented: boolean; isComposing: boolean; shiftKey: boolean }> = {}) {
  const e = {
    key: k,
    defaultPrevented: extra.defaultPrevented ?? false,
    isComposing: extra.isComposing ?? false,
    shiftKey: extra.shiftKey ?? false,
    prevented: false,
    stopped: false,
    preventDefault() {
      this.prevented = true;
    },
    stopPropagation() {
      this.stopped = true;
    },
  };
  return e;
}

test('Escape goes to the TOP layer only: a dialog over a sheet backs out one step, not two', () => {
  const closed: string[] = [];
  const offSheet = pushLayer({ z: 220, trap: null, onEscape: () => closed.push('sheet') });
  const offDialog = pushLayer({ z: 221, trap: null, onEscape: () => closed.push('dialog') });
  assert.equal(openLayerCount(), 2);
  const first = key('Escape');
  handleOverlayKey(first as unknown as KeyboardEvent);
  assert.deepEqual(closed, ['dialog'], 'one Escape, one layer');
  assert.ok(first.prevented && first.stopped, 'and the key is marked handled for everyone else');
  offDialog();
  handleOverlayKey(key('Escape') as unknown as KeyboardEvent);
  assert.deepEqual(closed, ['dialog', 'sheet']);
  offSheet();
  assert.equal(openLayerCount(), 0);
  handleOverlayKey(key('Escape') as unknown as KeyboardEvent);
  assert.deepEqual(closed, ['dialog', 'sheet'], 'no layer, no action');
});

test('Escape a control already used, or one that ends an IME composition, is not the window\'s', () => {
  const closed: string[] = [];
  const off = pushLayer({ z: 200, trap: null, onEscape: () => closed.push('x') });
  handleOverlayKey(key('Escape', { defaultPrevented: true }) as unknown as KeyboardEvent);
  handleOverlayKey(key('Escape', { isComposing: true }) as unknown as KeyboardEvent);
  handleOverlayKey(key('Enter') as unknown as KeyboardEvent);
  assert.deepEqual(closed, []);
  off();
});

test('what opens last paints on top: a window from inside a sheet is never under it', () => {
  assert.equal(layerAbove(200), 200, 'nothing open: the floor');
  const off = pushLayer({ z: 260, trap: null, onEscape: () => {} });
  assert.equal(layerAbove(200), 261, 'above the open sheet at 260');
  assert.equal(layerAbove(300), 300, 'a higher floor stands');
  off();
  assert.equal(overlayLayer(50), 250, 'legacy local z-values are still lifted above the chrome');
  assert.equal(overlayLayer(260), 260);
});

test('the CSS stacking and timing tokens mirror UI_LAYERS and the motion constants', () => {
  const css = readFileSync(new URL('../src/index.css', import.meta.url), 'utf8');
  const token = (name: string) => {
    const m = new RegExp(`--${name}:\\s*([0-9.]+)(ms)?;`).exec(css);
    assert.ok(m, `--${name} is declared`);
    return Number(m![1]);
  };
  assert.equal(token('z-header'), UI_LAYERS.header);
  assert.equal(token('z-bottom-nav'), UI_LAYERS.bottomNav);
  assert.equal(token('z-popover'), UI_LAYERS.popover);
  assert.equal(token('z-overlay'), UI_LAYERS.overlay);
  assert.equal(token('z-toast'), UI_LAYERS.toast);
  assert.equal(token('z-busy'), UI_LAYERS.overlay + 100, 'AppBusy paints at overlay + 100');
  assert.ok(UI_LAYERS.toast > overlayLayer(60) && UI_LAYERS.toast < UI_LAYERS.overlay + 100, 'toasts: over every window, under the busy layer');
  assert.equal(token('duration-press'), PRESS_MS);
  assert.equal(token('duration-quick'), CROSS_FADE.duration * 1000);
});

// ------------------------------------------------------------------- sheet

test('a released sheet rests where its momentum PROJECTS, not where the finger stopped', () => {
  const { medium, large } = detentSizes(800);
  assert.equal(medium, 400);
  assert.equal(large, 736, 'all of the screen but the top edge');
  const heights = [medium, large];
  assert.equal(restingExtent(520, 0, heights), medium, 'a slow release settles to the nearest');
  assert.equal(restingExtent(600, 0, heights), large, 'past the midpoint (568) it settles open');
  assert.equal(restingExtent(430, -1500, heights), large, 'a flick UP from near medium opens it fully');
  assert.equal(restingExtent(700, 2500, heights), 0, 'a hard flick DOWN from large can dismiss outright');
  assert.equal(restingExtent(250, 0, heights), medium, 'a slow drag below medium springs back');
  assert.equal(restingExtent(120, 0, heights), 0, 'pulled most of the way down: dismiss');
});

// ------------------------------------------------------------ the palette

test('⌘K / Ctrl+K is matched by key POSITION, so it works on an Arabic or Kurdish layout', () => {
  const base = { metaKey: false, ctrlKey: true, altKey: false, shiftKey: false };
  assert.equal(isPaletteShortcut({ ...base, code: 'KeyK' }), true);
  assert.equal(isPaletteShortcut({ ...base, ctrlKey: false, metaKey: true, code: 'KeyK' }), true);
  assert.equal(isPaletteShortcut({ ...base, ctrlKey: false, code: 'KeyK' }), false, 'a bare K types');
  assert.equal(isPaletteShortcut({ ...base, shiftKey: true, code: 'KeyK' }), false);
  assert.equal(isPaletteShortcut({ ...base, code: 'KeyN' }), false);
});

// ------------------------------------------------------------------ toasts

test('the toast queue: errors stay longer, an undo gets time to be pressed, one id is one toast', () => {
  toast.dismiss();
  toast.success('Saved');
  toast.error('Could not save');
  toast.info('Deleted', { action: { label: 'Undo', onClick: () => {} } });
  const [ok, err, undo] = toastQueue();
  assert.equal(ok.duration, 4000);
  assert.equal(err.duration, 8000);
  assert.ok(undo.duration >= 6000, 'an action keeps the toast at least 6s');
  toast.show('info', 'Saving…', { id: 'op' });
  toast.show('success', 'Saved', { id: 'op' });
  const ops = toastQueue().filter((t) => t.id === 'op');
  assert.equal(ops.length, 1, 'the same id replaces instead of stacking');
  assert.equal(ops[0].tone, 'success');
  toast.dismiss(ok.id);
  assert.equal(toastQueue().some((t) => t.id === ok.id), false);
  toast.dismiss();
  assert.equal(toastQueue().length, 0);
});
