/**
 * «في اختيار اللغة ادمج بهذه الأيقونة اللغة والمظهر يعني يظهر نافذة منبثقة مثل
 *  الإشعارات من الأسفل … بسطرين السطر الأول اللغة والسطر الثاني المظهر».
 *
 * The header globe opens ONE bottom sheet, «اللغة والمظهر», with two rows; a
 * choice closes the sheet first and only then changes the theme (a circle from
 * the centre, tests/themeSystem.test.ts) or the language (a calm View
 * Transition, src/lib/langSwap.ts — driven below against a stubbed document).
 *
 * Run: npx tsx --test tests/langThemeSheet.test.ts
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { languageFlow, languageSwapMode, runLanguageSwap, LANG_SWAP_MS } from '../src/lib/langSwap';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (p: string) => readFileSync(join(ROOT, p), 'utf8');

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(join(ROOT, dir))) {
    const rel = `${dir}/${name}`;
    if (statSync(join(ROOT, rel)).isDirectory()) walk(rel, out);
    else if (/\.tsx$/.test(name)) out.push(rel);
  }
  return out;
}

// ------------------------------------------------------------ the headers

test('every header globe opens the «اللغة والمظهر» sheet', () => {
  for (const f of ['src/components/Header.tsx', 'src/components/DashboardLayout.tsx']) {
    const src = read(f);
    assert.match(src, /import LangThemeButton from '\.\/LangThemeSheet'/, `${f} does not use the sheet`);
    assert.match(src, /<LangThemeButton\b/, `${f} does not render the globe that opens the sheet`);
  }
});

test('the old language dropdown is gone', () => {
  const header = read('src/components/Header.tsx');
  assert.doesNotMatch(header, /header-language-menu|isLangOpen|langButtonRef|<Anchored/);
  const dash = read('src/components/DashboardLayout.tsx');
  assert.doesNotMatch(dash, /showLangMenu|langRef|setLang\(/);
  // No other component draws a globe that switches the language on its own:
  // the globe is the sheet's, everywhere.
  for (const f of walk('src')) {
    // The sheet itself, and Settings' own «اللغة» row (the globe there is the
    // section's icon, not a control).
    if (f === 'src/components/LangThemeSheet.tsx' || f === 'src/pages/Settings.tsx') continue;
    const src = read(f);
    if (/<Globe\b/.test(src) && /\bsetLang\(/.test(src)) {
      assert.fail(`${f} has a globe that switches the language without the sheet`);
    }
  }
});

test('the sheet is the notifications sheet: grabber, title, two rows, the theme store', () => {
  const src = read('src/components/LangThemeSheet.tsx');
  // The same primitive as the notifications sheet, at every width.
  assert.match(src, /import \{ Sheet \} from '\.\/ui\/Overlay'/);
  assert.match(src, /<Sheet[\s\S]{0,400}docked[\s\S]{0,300}testId="lang-theme-sheet"/);
  assert.match(src, /labelledBy=\{titleId\}/);
  assert.ok(src.includes("'اللغة والمظهر'"), 'the title');
  // Row 1, the language; row 2, the appearance — in that order.
  const langRow = src.indexOf('data-lang-theme-row="language"');
  const themeRow = src.indexOf('data-lang-theme-row="appearance"');
  assert.ok(langRow > 0 && themeRow > langRow, 'the language row comes first');
  for (const s of ['العربية', 'English', 'کوردی', "'فاتح'", "'داكن'", "'حسب الجهاز'"]) {
    assert.ok(src.includes(s), `${s} is missing`);
  }
  assert.match(src, /<Sun\b/);
  assert.match(src, /<Moon\b/);
  assert.match(src, /from '\.\.\/lib\/theme'/);
  assert.match(src, /useTheme\(\)/);
  // Sorani is written by hand, never by a machine.
  assert.match(src, /OWNER: Sorani to be written by hand/);
  // The trigger is 44px.
  assert.match(src, /h-11 w-11/);
  assert.match(src, /min-h-11 min-w-11/);
});

test('a choice closes the sheet FIRST, and changes things only once it has gone', () => {
  const src = read('src/components/LangThemeSheet.tsx');
  assert.match(src, /onExited=\{flush\}/);
  assert.match(src, /setThemePreference\(next, \{ origin: 'center', duration: CENTER_REVEAL_MS \}\)/);
  assert.match(src, /closeThen\(next === lang \? null : \(\) => setLang\(next\)\)/);
  assert.match(src, /closeThen\(next === preference \? null :/);
  // A hidden tab never reports the exit: the change still happens.
  assert.match(src, /EXIT_FALLBACK_MS/);
  const overlay = read('src/components/ui/Overlay.tsx');
  assert.match(overlay, /<AnimatePresence onExitComplete=\{onExited\}>/);
  assert.match(overlay, /dock: 'items-end justify-center p-0'/);
  // Swipe-down and the grabber are Sheet's, under reduced motion too the slide is a fade.
  assert.match(overlay, /travel: number \| string = dock \? \(m\.reduced \? 0 : '100%'\)/);
});

test('Settings keeps its own «المظهر» and «اللغة», on the same stores', () => {
  const settings = read('src/pages/Settings.tsx');
  // The tap reveal from the finger: no options, so the store guesses the origin.
  assert.match(settings, /onChange=\{\(id\) => setThemePreference\(id as ThemePreference\)\}/);
  assert.match(settings, /setLang\(next\)/);
});

// ------------------------------------------------------ the language motion

test('the language flow: a direction change travels, Arabic ↔ Sorani only fades', () => {
  assert.equal(languageFlow('rtl', 'ltr'), 'to-ltr');
  assert.equal(languageFlow('ltr', 'rtl'), 'to-rtl');
  assert.equal(languageFlow('rtl', 'rtl'), 'same');
  assert.ok(LANG_SWAP_MS >= 350 && LANG_SWAP_MS <= 450);
});

test('no DOM, reduced motion or a hidden tab: the language changes instantly', () => {
  const g = globalThis as Record<string, unknown>;
  const saved = { window: g.window, document: g.document };
  try {
    g.window = undefined;
    g.document = undefined;
    assert.equal(languageSwapMode(), 'instant');

    let reduce = true;
    let hidden = false;
    let vt = true;
    g.window = { matchMedia: () => ({ matches: reduce }) };
    const doc: Record<string, unknown> = {};
    Object.defineProperty(doc, 'visibilityState', { get: () => (hidden ? 'hidden' : 'visible') });
    Object.defineProperty(doc, 'startViewTransition', { get: () => (vt ? () => {} : undefined) });
    g.document = doc;
    assert.equal(languageSwapMode(), 'instant', 'reduced motion');
    reduce = false;
    hidden = true;
    assert.equal(languageSwapMode(), 'instant', 'hidden tab');
    hidden = false;
    assert.equal(languageSwapMode(), 'vt');
    vt = false;
    assert.equal(languageSwapMode(), 'css', 'no View Transitions: the data-lang-swap fallback');

    // 'instant' and 'css' commit synchronously and touch nothing else.
    let committed = 0;
    runLanguageSwap('instant', 'rtl', 'ltr', () => committed++);
    runLanguageSwap('css', 'rtl', 'ltr', () => committed++);
    assert.equal(committed, 2);
  } finally {
    g.window = saved.window;
    g.document = saved.document;
  }
});

test('with View Transitions the commit runs inside one, marked with its flow, and the marks come off', async () => {
  const g = globalThis as Record<string, unknown>;
  const saved = { window: g.window, document: g.document };
  const classes = new Set<string>();
  const attrs = new Map<string, string>();
  let finish!: () => void;
  const finished = new Promise<void>((r) => (finish = r));
  let update: (() => void | Promise<void>) | null = null;
  const root = {
    dir: 'rtl',
    classList: { add: (c: string) => void classes.add(c), remove: (c: string) => void classes.delete(c) },
    setAttribute: (k: string, v: string) => void attrs.set(k, v),
    removeAttribute: (k: string) => void attrs.delete(k),
  };
  try {
    g.window = { matchMedia: () => ({ matches: false }), setTimeout: (fn: () => void, ms: number) => setTimeout(fn, ms) };
    g.document = {
      documentElement: root,
      visibilityState: 'visible',
      startViewTransition: (fn: () => void | Promise<void>) => {
        update = fn;
        return { ready: Promise.resolve(), finished };
      },
    };
    let committed = 0;
    runLanguageSwap('vt', 'rtl', 'ltr', () => committed++);
    assert.ok(classes.has('lv-lang-vt'));
    assert.equal(attrs.get('data-lang-flow'), 'to-ltr');
    assert.equal(committed, 0, 'the commit waits for the browser to snapshot the old page');
    await update!();
    assert.equal(committed, 1);
    assert.equal(root.dir, 'ltr', 'the new snapshot is taken in the new direction');
    finish();
    await new Promise((r) => setTimeout(r, 0));
    assert.ok(!classes.has('lv-lang-vt') && !attrs.has('data-lang-flow'), 'the marks stayed on');
  } finally {
    g.window = saved.window;
    g.document = saved.document;
  }
});

test('the provider hands every change to the swap, and plays data-lang-swap only as the fallback', () => {
  const ctx = read('src/LanguageContext.tsx');
  assert.match(ctx, /runLanguageSwap\(mode, fromDir, toDir,/);
  assert.match(ctx, /if \(mode !== 'css'\) return;/);
  // The first run (a page load) is never animated.
  assert.match(ctx, /if \(firstLangRun\.current\) \{\s*firstLangRun\.current = false;\s*return;/);
  const swap = read('src/lib/langSwap.ts');
  assert.match(swap, /document\.fonts|fonts\?\.ready/);
  assert.match(swap, /flushSync\(commit\)/);
  assert.doesNotMatch(swap, /createElement\('style'\)|insertRule|setAttribute\('style'|\.style\./, 'no style is written into the document');
});

test('the CSS: a 8–16px drift plus a fade, a crossfade for the same direction, nothing under reduced motion', () => {
  const css = read('src/index.css');
  for (const kf of ['lv-lang-vt-out-right', 'lv-lang-vt-out-left', 'lv-lang-vt-in-from-left', 'lv-lang-vt-in-from-right']) {
    const m = css.match(new RegExp(`@keyframes ${kf}\\s*\\{[^}]*translate3d\\((-?\\d+)px`));
    assert.ok(m, `${kf} is missing`);
    const px = Math.abs(Number(m![1]));
    assert.ok(px >= 8 && px <= 16, `${kf} travels ${px}px`);
  }
  assert.match(css, /html\.lv-lang-vt\[data-lang-flow='to-ltr'\]::view-transition-new\(root\) \{ animation-name: lv-lang-vt-in-from-left; \}/);
  assert.match(css, /html\.lv-lang-vt\[data-lang-flow='to-rtl'\]::view-transition-new\(root\) \{ animation-name: lv-lang-vt-in-from-right; \}/);
  assert.match(css, /@media \(prefers-reduced-motion: reduce\) \{\s*html\.lv-lang-vt::view-transition-group\(root\),/);
  assert.match(css, /html\[data-lang-swap='fade'\] main/);
  assert.match(css, /@media \(prefers-reduced-motion: reduce\) \{\s*html\[data-lang-swap\] main/);
});
