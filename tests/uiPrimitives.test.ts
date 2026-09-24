/**
 * The workspace primitives' CONTRACTS, pinned in source (wave 3, W3-0).
 *
 * In the style of tests/uiSystem.test.ts: this repository has no DOM runner,
 * so the accessibility contract of each primitive — its roles, its ARIA
 * wiring, its keyboard model, its 44px targets — is asserted on the source,
 * with comments stripped wherever a rule is also explained in prose. What a
 * regex cannot see (focus actually trapped and returned, Escape reaching only
 * the top layer, one layout mounted) is driven in a browser by
 * scripts/e2e-ui-kit.mjs, and the pure rules are exercised by
 * tests/uiPrimitivesLogic.test.ts.
 *
 * House rule (serviceSlots.test.ts): when code moves, move the pin — do not
 * delete it.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = new URL('..', import.meta.url).pathname;
const read = (path: string) => readFileSync(join(ROOT, path), 'utf8');
/** Source with comments removed: a rule explained in prose must not satisfy itself. */
const code = (path: string) =>
  read(path)
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, '')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:'"`])\/\/[^\n]*/g, '$1');

const UI = 'src/components/ui';
/** Every primitive this wave added. */
const NEW_PRIMITIVES = [
  'Badge.tsx',
  'Button.tsx',
  'Card.tsx',
  'CommandPalette.tsx',
  'ConfirmDialog.tsx',
  'DashboardSkeletons.tsx',
  'DataList.tsx',
  'Field.tsx',
  'KpiTile.tsx',
  'Menu.tsx',
  'Money.tsx',
  'NumberInput.tsx',
  'Sheet.tsx',
  'Switch.tsx',
  'Toast.tsx',
  'overlayStack.ts',
].map((f) => `${UI}/${f}`);
const NEW_LIB = ['src/lib/useMediaQuery.ts', 'src/lib/localeNumber.ts', 'src/lib/money.ts', 'src/lib/listNav.ts', 'src/lib/listView.ts'];
const TOUCHED = [...NEW_PRIMITIVES, `${UI}/Overlay.tsx`, `${UI}/Tabs.tsx`];

/** Block comments blanked but their newlines kept, so line numbers still match the file. */
const blankComments = (src: string) =>
  src.replace(/\/\*[\s\S]*?\*\//g, (c) => c.replace(/[^\n]/g, ' ')).replace(/\{\s*\}/g, (c) => c);

/** The opening tags of the named JSX elements, read up to the `>` that closes the tag (not an arrow's). */
function openingTags(src: string, names: string[]): string[] {
  const out: string[] = [];
  const re = new RegExp(`<(${names.join('|')})\\b`, 'g');
  for (const m of src.matchAll(re)) {
    let depth = 0;
    let i = m.index! + m[0].length;
    for (; i < src.length; i++) {
      const ch = src[i];
      if (ch === '{') depth++;
      else if (ch === '}') depth--;
      else if (ch === '>' && depth === 0 && src[i - 1] !== '=') break;
    }
    out.push(src.slice(m.index!, i + 1));
  }
  return out;
}

// ------------------------------------------------------------------ Overlay

test('Overlay keeps every hook and literal the app and the e2e scripts depend on', () => {
  const overlay = read(`${UI}/Overlay.tsx`);
  for (const hook of ['data-overlay-panel', 'data-overlay-scrim', 'data-sheet-grabber', 'data-overlay-mode', 'data-overlay={testId ?? true}']) {
    assert.ok(overlay.includes(hook), `${hook} is gone`);
  }
  assert.match(overlay, /export const UI_LAYERS[\s\S]*?overlay: 200/);
  assert.match(overlay, /pb-\[env\(safe-area-inset-bottom\)\]/);
  assert.match(overlay, /role="dialog"/);
  assert.match(overlay, /aria-modal=\{mode === 'modal'\}/);
});

test('Overlay: one keyboard owner — Escape and the focus trap go through the overlay stack', () => {
  const overlay = code(`${UI}/Overlay.tsx`);
  const stack = code(`${UI}/overlayStack.ts`);
  // No private Escape listener per window: that is what closed two windows at once.
  assert.doesNotMatch(overlay, /addEventListener\('keydown'/, 'an Overlay listens for keys itself again');
  assert.match(overlay, /pushLayer\(\{[\s\S]{0,160}trap: traps \? \(\) => panelRef\.current : null/);
  assert.match(overlay, /const traps = trapFocus \?\? mode === 'modal';/, 'a modal traps focus by default');
  // Only the top layer hears the key, and a key a control already used is not the window's.
  assert.match(stack, /const top = stack\[stack\.length - 1\];\s*if \(!top \|\| e\.defaultPrevented\) return;/);
  assert.match(stack, /if \(e\.isComposing\) return;/, 'Escape ending an IME composition must not close the window');
  assert.match(stack, /e\.key === 'Tab' && top\.trap/);
  // The trap never pulls focus out of a window it does not own.
  assert.match(stack, /if \(!inside && active && active !== document\.body\) return;/);
  // Anchored (menus, popovers) is on the same stack.
  assert.match(overlay, /export function Anchored[\s\S]*pushLayer\(\{[\s\S]{0,80}trap: null/);
});

test('Overlay: the opener gets focus back, the keyboard never covers the window, and dirty work is asked about', () => {
  const overlay = code(`${UI}/Overlay.tsx`);
  // The opener is read in RENDER, before a child's autoFocus can move focus in.
  assert.match(overlay, /if \(open && openerRef\.current === undefined\) \{[\s\S]{0,200}document\.activeElement/);
  assert.match(overlay, /target\.focus\(\{ preventScroll: true \}\)/);
  assert.match(overlay, /if \(!restoreRef\.current\) return;/, 'restoreFocus={false} is honoured');
  // visualViewport pins the layer while the on-screen keyboard is up.
  assert.match(overlay, /window\.visualViewport/);
  assert.match(overlay, /vv\.addEventListener\('resize', schedule\)/);
  assert.match(overlay, /layer\.style\.height = keyboard \? `\$\{vv\.height\}px` : ''/);
  // Dirty: Escape, the scrim and a drag-dismiss all go through requestClose.
  assert.match(overlay, /if \(dirty\) \{[\s\S]{0,160}setAsking\(true\);/);
  assert.match(overlay, /onClose=\{dismissOnScrim \? requestClose : undefined\}/);
  assert.match(overlay, /role="alertdialog"/, 'the discard question is announced as one');
  // Render-function children are called only while open.
  assert.match(overlay, /typeof children === 'function' \? children\(\{ close: requestClose \}\) : children/);
});

test('Overlay: the scrim is named «إغلاق» in the reader\'s own language, not a hard-coded Arabic fallback', () => {
  const overlay = code(`${UI}/Overlay.tsx`);
  assert.doesNotMatch(overlay, /label=\{label \?\? 'إغلاق'\}/);
  assert.match(overlay, /<Scrim visible=\{open\} label=\{strings\.close\}/);
  assert.match(overlay, /const strings = STRINGS\[lang\] \?\? STRINGS\.ar;/);
});

test('Overlay stays small: the lazy-only primitives are never imported by the eager Overlay module', () => {
  const overlay = code(`${UI}/Overlay.tsx`);
  for (const lazy of ['./Sheet', './Menu', './DataList', './CommandPalette', './Toast', './ConfirmDialog', 'useMediaQuery']) {
    assert.ok(!overlay.includes(`'${lazy}'`) && !overlay.includes(lazy === 'useMediaQuery' ? 'useMediaQuery' : `from '${lazy}'`), `Overlay.tsx imports ${lazy}`);
  }
});

// -------------------------------------------------------------------- Sheet

test('Sheet v2 drags from its handle only, rests at detents, and its body scrolls contained', () => {
  const sheet = code(`${UI}/Sheet.tsx`);
  assert.match(sheet, /data-sheet-handle[\s\S]{0,80}onPointerDown=\{onPointerDown\}/);
  assert.doesNotMatch(sheet, /\bdrag: 'y'/, 'v2 must not make the whole panel draggable');
  assert.match(sheet, /data-sheet-body[\s\S]{0,40}className="min-h-0 flex-1 overflow-y-auto overscroll-contain"/);
  assert.match(sheet, /Math\.abs\(dy\) < DRAG_THRESHOLD_PX/, 'the 10px hysteresis keeps header buttons tappable');
  assert.match(sheet, /setPointerCapture/);
  assert.match(sheet, /nearestSnap\(extent - project\(velocity\)/, 'the resting detent comes from the PROJECTED extent');
  assert.match(sheet, /rubberband\(/, 'past the largest detent it resists instead of stopping');
  assert.match(sheet, /velocity: fingerVelocity/, 'the settle spring starts at the finger\'s velocity');
  // A keyboard / switch path to the detents.
  assert.match(sheet, /data-sheet-grabber\s*onClick=\{toggle\}\s*aria-label=/);
  assert.match(sheet, /aria-expanded=\{detent === 'large'\}/);
  // Reduced motion: no drag.
  assert.match(sheet, /const draggable = phone && !m\.reduced;/);
  // Without v2 props it is exactly the old sheet.
  assert.match(sheet, /return <WholePanelSheet \{\.\.\.legacy\} \/>;/);
});

// ----------------------------------------------------- ConfirmDialog, Toast

test('ConfirmDialog is an alertdialog that names the action, says the consequence and starts on Cancel', () => {
  const dialog = code(`${UI}/ConfirmDialog.tsx`);
  assert.match(dialog, /<Overlay[\s\S]{0,200}\balert\b[\s\S]{0,60}labelledBy=\{titleId\}/);
  assert.match(dialog, /describedBy=\{consequence \|\| error \? bodyId : undefined\}/);
  assert.match(dialog, /initialFocus=\{destructive \? cancelRef : confirmRef\}/, 'Enter out of habit never deletes');
  assert.match(dialog, /variant=\{destructive \? 'danger' : 'primary'\}/);
  assert.match(dialog, /dismissOnEscape=\{!locked\}/, 'a running action cannot be escaped half way');
  assert.match(dialog, /export function useConfirm\(\): \[\(options: ConfirmOptions\) => Promise<boolean>, React\.ReactElement\]/);
  assert.match(dialog, /useEffect\(\(\) => \(\) => resolver\.current\?\.\(false\), \[\]\);/, 'an unmounted asker is answered "no"');
});

test('Toasts are heard (persistent live regions), carry icon + words, pause, and sit above the shell bar', () => {
  const t = code(`${UI}/Toast.tsx`);
  assert.match(t, /role="status" aria-live="polite" aria-atomic="true"/);
  assert.match(t, /role="alert" aria-live="assertive" aria-atomic="true"/);
  assert.match(t, /t\.tone === 'error' \? \{ \.\.\.prev, assertive: text \}/, 'errors are assertive');
  for (const icon of ['CheckCircle2', 'AlertCircle', 'Info']) assert.ok(t.includes(`<${icon} aria-hidden="true"`), `${icon} is decorative`);
  assert.match(t, /const paused = hovered \|\| focusedIn \|\| hidden;/, 'pointing, focus and a hidden tab pause the timers');
  assert.match(t, /zIndex: UI_LAYERS\.toast/);
  assert.match(t, /var\(--shell-bottom-inset, 0px\) \+ max\(0\.75rem, env\(safe-area-inset-bottom\)\)/);
  assert.doesNotMatch(t, /bottom-0/);
  assert.match(t, /aria-label=\{closeLabel\}/);
});

// ------------------------------------------------------------ the form kit

test('Field binds its label, hint and error to the control; the error is words and an icon, not red alone', () => {
  const f = code(`${UI}/Field.tsx`);
  assert.match(f, /<label htmlFor=\{id\}/);
  assert.match(f, /const describedBy = \[hintId, errorId\]\.filter\(Boolean\)\.join\(' '\) \|\| undefined;/);
  assert.match(f, /'aria-invalid': props\['aria-invalid'\] \?\? \(field\.invalid \|\| undefined\)/);
  assert.match(f, /<p id=\{errorId\} className="lv-field-error[^"]*">\s*<AlertCircle aria-hidden="true"/);
  assert.match(f, /className=\{`lv-input /, 'inputs are .lv-input (46px, focus ring, 16px coarse floor)');
  assert.match(f, /export function focusFirstInvalid/);
});

test('Switch is a real role="switch" with aria-checked in a 44px row; Checkbox is native and shares one hit target', () => {
  const s = code(`${UI}/Switch.tsx`);
  assert.match(s, /role="switch"\s*aria-checked=\{checked\}/);
  assert.match(s, /<label htmlFor=\{id\}/);
  assert.match(s, /min-h-11/);
  assert.match(s, /inline-flex h-11 w-14/, 'the switch itself is a 44px target');
  assert.match(s, /focus-visible:ring-2 focus-visible:ring-focus/);
  assert.match(s, /type="checkbox"/);
  assert.match(s, /ref\.current\.indeterminate = indeterminate && !checked/);
  assert.match(s, /aria-checked=\{indeterminate && !checked \? 'mixed' : undefined\}/);
  assert.match(s, /<label\s+className=\{`inline-flex min-h-11 min-w-11/, 'the box and its words are one 44px label');
});

test('Button is lv-button with a busy state that refuses a second press; IconButton hits 44px and must be named', () => {
  const b = code(`${UI}/Button.tsx`);
  assert.match(b, /className=\{`lv-button lv-button-\$\{variant\}/);
  assert.match(b, /if \(blocked \|\| inFlight\.current\) \{\s*\/?\/?[^\n]*\n?\s*event\.preventDefault\(\);/, 'a busy submit button does not submit the form either');
  assert.match(b, /aria-busy=\{busy \|\| undefined\}\s*aria-disabled=\{busy \|\| undefined\}/);
  assert.match(b, /inFlight\.current = true;/, 'the guard is synchronous (a ref), not a state update');
  assert.match(b, /label: string;/, 'IconButton requires an accessible name');
  assert.match(b, /aria-label=\{label\}/);
  assert.match(b, /inline-flex h-11 w-11 shrink-0/, 'the target is 44px');
  assert.match(b, /data-icon-disc\s*className=\{`flex h-9 w-9/, 'the drawn disc is 36px');
});

test('NumberInput reads Arabic-Indic digits, is an LTR island, and never silently rounds a figure', () => {
  const n = code(`${UI}/NumberInput.tsx`);
  assert.match(n, /inputMode=\{decimals > 0 \? 'decimal' : 'numeric'\}/);
  assert.match(n, /parseLocaleNumber\(raw, decimals\)/);
  assert.match(n, /dir="ltr"/);
  assert.match(n, /aria-invalid=\{invalid \|\| undefined\}/);
  assert.doesNotMatch(n, /type="number"/, 'a number input rejects ١٢٣ and changes under a scroll wheel');
  assert.doesNotMatch(n, /Math\.round\(/, 'no typed amount is rounded into a different price');
});

// ------------------------------------------------------------------ DataList

test('DataList mounts ONE layout, a real table when wide, and a failure is never the empty state', () => {
  const d = code(`${UI}/DataList.tsx`);
  assert.match(d, /wide \? \(\s*table\(\)\s*\) : \(\s*cards\(\)\s*\)/, 'exactly one of table / cards is rendered');
  assert.match(d, /<caption className="sr-only">\{label\}<\/caption>/);
  assert.match(d, /scope="col"/);
  assert.match(d, /sticky end-0/, 'the actions column is sticky at the inline end');
  assert.match(d, /const view = listView\(rows, loading, error\);/);
  assert.match(d, /if \(view === 'error'\) return <ErrorState error=\{error\} onRetry=\{onRetry\}/);
  assert.match(d, /view === 'stale' && <ErrorState/);
  assert.match(d, /new ResizeObserver\(measure\)/, 'the CONTAINER decides, not the viewport');
  assert.doesNotMatch(d, /<tr[^>]*onClick/, 'rows open by a link, never by a clickable <tr>');
  assert.match(d, /indeterminate=\{chosen\.length > 0 && !allChosen\}/);
  assert.match(d, /className="sr-only" aria-live="polite"/, 'the selection count is announced');
});

// --------------------------------------------------------------- Menu, Tabs

test('Menu: a real menu-button keyboard — arrows, Home/End, typeahead, focus back to the trigger', () => {
  const m = code(`${UI}/Menu.tsx`);
  assert.match(m, /role="menu"/);
  assert.match(m, /role: 'menuitem'/);
  assert.match(m, /tabIndex: -1/, 'roving focus: items are focused programmatically');
  assert.match(m, /'aria-haspopup': 'menu'/);
  assert.match(m, /'aria-expanded': open/);
  assert.match(m, /'aria-controls': open \? menuId : undefined/);
  for (const k of ["'ArrowDown'", "'ArrowUp'", "'Home'", "'End'", "'Tab'"]) assert.ok(m.includes(k), `${k} is handled`);
  assert.match(m, /typeaheadIndex\(labels, at, typed\.current\.text, skip\)/);
  assert.match(m, /setOpen\(false\);\s*anchor\.current\?\.focus\(\{ preventScroll: true \}\);/);
  assert.match(m, /const asSheet = presentation === 'sheet' \|\| \(presentation === 'auto' && phone && !fine\);/);
  assert.match(m, /'aria-disabled': entry\.disabled \|\| undefined/, 'a disabled item stays reachable and says why');
});

test('Tabs: one Tab stop, arrows in the writing direction, tabpanel wiring, and a link mode', () => {
  const t = code(`${UI}/Tabs.tsx`);
  assert.match(t, /tabIndex=\{active \? 0 : -1\}/);
  assert.match(t, /const forward = dir === 'rtl' \? 'ArrowLeft' : 'ArrowRight';/);
  assert.match(t, /aria-controls=\{panels && active \? panelId\(group, t\.id\) : undefined\}/);
  assert.match(t, /role: 'tabpanel', id: panelId\(group, value\), 'aria-labelledby': tabId\(group, value\)/);
  assert.match(t, /aria-current=\{active \? 'page' : undefined\}/);
  assert.match(t, /<nav aria-label=\{label\}/);
  // The e2e motion hooks survive.
  assert.match(t, /data-tab-indicator/);
  assert.match(t, /data-tab-panel=\{value\}/);
});

test('CommandPalette: ⌘K by e.code, a real combobox, groups, and an IME-safe keyboard', () => {
  const c = code(`${UI}/CommandPalette.tsx`);
  assert.match(c, /e\.code === 'KeyK'/);
  assert.doesNotMatch(c, /e\.key === 'k'|e\.key === 'K'/, 'e.key dies on Arabic and Kurdish layouts');
  assert.match(c, /role="combobox"/);
  assert.match(c, /focus-within:border-focus" data-command-field/, 'the search field shows focus on its row');
  assert.match(c, /aria-activedescendant=\{current >= 0 \? optionId\(current\) : undefined\}/);
  assert.match(c, /role="listbox"/);
  assert.match(c, /role="group" aria-labelledby=\{headingId\}/);
  assert.match(c, /role="option"\s*aria-selected=\{selected\}/);
  assert.match(c, /if \(e\.nativeEvent\.isComposing\) return;/);
  assert.match(c, /try \{[\s\S]{0,200}localStorage\.getItem/, 'recents never break the palette when storage is blocked');
});

test('KpiTile and Money: tabular figures, one accent, and no invented numbers', () => {
  const k = code(`${UI}/KpiTile.tsx`);
  const money = code(`${UI}/Money.tsx`);
  assert.match(k, /\{value \?\? '—'\}/, 'no figure is «—», not 0');
  assert.match(k, /if \(points\.length < 2\) return null;/, 'no sparkline without two real points');
  assert.match(k, /tabular-nums/);
  assert.doesNotMatch(k, /purple|sky-|emerald-|amber-|TINTS/, 'one accent, not five tints');
  assert.match(money, /<bdi dir="ltr">/, 'the figure is an LTR island');
  assert.match(money, /tabular-nums/);
  assert.match(money, /iqdUnit\(lang\)/);
});

// ------------------------------------------------------------------ tokens

test('the app-chrome tokens exist, and compact density shrinks visuals on a precise pointer only', () => {
  const css = read('src/index.css');
  for (const t of ['--color-accent:', '--color-accent-contrast:', '--shadow-1:', '--shadow-2:', '--shadow-3:', '--duration-ui:', '--shell-bottom-inset:']) {
    assert.ok(css.includes(t), `${t} is missing`);
  }
  for (const size of ['2xs', 'xs', 'sm', 'base', 'lg', 'xl']) {
    assert.match(css, new RegExp(`--text-ui-${size}:\\s*[0-9.]+rem;\\s*--text-ui-${size}--line-height:`));
  }
  // Tailwind's own text-sm/text-base are NOT redefined: 3,440 call sites use them.
  assert.doesNotMatch(css, /--text-sm:|--text-base:/);
  const density = /@media \(pointer: fine\) \{\s*\[data-density='compact'\][\s\S]*?\n\}/.exec(css)?.[0] ?? '';
  assert.ok(density, 'the compact scope lives inside @media (pointer: fine)');
  assert.match(density, /\[data-density='compact'\] \.lv-button::after,[\s\S]{0,120}inset-block: -6px;/, '32px drawn + 2×6px slop = 44px hit');
  assert.match(density, /\[data-density='compact'\] \.lv-choice::after \{[\s\S]{0,80}inset-block: -4px;/);
  assert.doesNotMatch(css.replace(density, ''), /\[data-density='compact'\]/, 'nothing compact outside the pointer-fine query');
});

// ------------------------------------------------------ rules for every file

test('every new primitive: logical properties, no dark:, no native dialogs, no fixed bottom-0, no hex colours', () => {
  const physical = /(?:^|[\s"'`])-?(?:ml|mr|pl|pr|left|right|rounded-l|rounded-r|border-l|border-r|text-left|text-right)-[\w[\]./-]+/;
  for (const f of [...TOUCHED, ...NEW_LIB]) {
    const src = code(f);
    assert.doesNotMatch(src, physical, `${f} uses a physical left/right utility`);
    assert.doesNotMatch(src, /(?:^|[\s"'`{])(?:[a-z-]+:)*dark:[a-z-]/, `${f} uses the dark: variant`);
    assert.doesNotMatch(src, /window\.(confirm|alert|prompt)\(|(?:^|[^.\w])alert\(/, `${f} uses a native dialog`);
    assert.doesNotMatch(src, /fixed bottom-0/, `${f} has a fixed bottom-0 bar`);
    assert.doesNotMatch(src, /#[0-9a-fA-F]{3,8}\b(?![\w-])/, `${f} hard-codes a hex colour instead of a token`);
  }
});

test('every interactive element in the new primitives shows where the keyboard is', () => {
  for (const f of NEW_PRIMITIVES.filter((p) => p.endsWith('.tsx'))) {
    const src = code(f);
    const tags = openingTags(src, ['button', 'a', 'Link', 'input', 'select', 'textarea']);
    for (const tag of tags) {
      const ok =
        /focus-visible:|focus:bg|lv-button|lv-input|type="checkbox"|\{\.\.\.common\}|\{\.\.\.rest\}|\{\.\.\.wire|outline-none"/.test(tag) ||
        /role="(option|combobox)"/.test(tag);
      assert.ok(ok, `${f}: an interactive element without a focus style:\n${tag.slice(0, 200)}`);
    }
  }
});

test('NO SORANI WAS INVENTED: every ckb string already existed, or the Arabic stands in with the OWNER marker', () => {
  const walk = (dir: string, out: string[] = []): string[] => {
    for (const name of readdirSync(join(ROOT, dir))) {
      const rel = `${dir}/${name}`;
      if (statSync(join(ROOT, rel)).isDirectory()) walk(rel, out);
      else if (/\.(tsx?|ts)$/.test(name)) out.push(rel);
    }
    return out;
  };
  const mine = new Set([...TOUCHED, ...NEW_LIB]);
  const corpus = walk('src')
    .filter((f) => !mine.has(f))
    .map((f) => read(f))
    .join('\n');
  const q = `(['\`])((?:\\\\.|(?!\\1).)*)\\1`;
  for (const f of [...TOUCHED, ...NEW_LIB]) {
    const raw = read(f);
    const src = blankComments(raw);
    // loc(ar, en, ckb): the Sorani must exist, hand-written, somewhere else.
    for (const m of src.matchAll(new RegExp(`loc\\(\\s*${q}\\s*,\\s*${q}\\s*,\\s*${q}\\s*\\)`, 'g'))) {
      const ckb = m[6];
      assert.ok(corpus.includes(ckb), `${f}: «${ckb}» is Sorani nobody wrote before`);
    }
    // loc(ar, en): the Arabic stands in, and the file says so right there.
    const lines = src.split('\n');
    const rawLines = raw.split('\n');
    lines.forEach((line, i) => {
      if (/^\s*\/\//.test(line)) return;
      if (!new RegExp(`loc\\(\\s*${q}\\s*,\\s*${q}\\s*\\)`).test(line)) return;
      const above = rawLines.slice(Math.max(0, i - 3), i + 1).join('\n');
      assert.match(above, /OWNER: Sorani to be written by hand\./, `${f}:${i + 1} passes no Sorani without the OWNER marker`);
    });
    // STRINGS tables: a ckb block's values must exist elsewhere or equal the Arabic under the marker.
    const ckbBlock = /\bckb:\s*\{([\s\S]*?)\n?\s*\},?/.exec(src)?.[1];
    if (ckbBlock) {
      for (const m of ckbBlock.matchAll(/(\w+):\s*'((?:[^'\\]|\\.)*)'/g)) {
        const [, k, v] = m;
        const arabic = new RegExp(`\\bar:\\s*\\{[\\s\\S]*?\\b${k}:\\s*'((?:[^'\\\\]|\\\\.)*)'`).exec(src)?.[1];
        if (v === arabic) {
          assert.match(raw, /OWNER: Sorani to be written by hand\./, `${f}: ckb.${k} carries the Arabic without the marker`);
        } else {
          assert.ok(corpus.includes(v), `${f}: ckb.${k} «${v}» is Sorani nobody wrote before`);
        }
      }
    }
  }
});
