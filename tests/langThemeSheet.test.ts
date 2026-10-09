/**
 * «في اختيار اللغة ادمج بهذه الأيقونة اللغة والمظهر يعني يظهر نافذة منبثقة مثل
 *  الإشعارات من الأسفل …» — and the FX brief adds the display currency to the
 *  same place (FX programme plan §13).
 *
 * The header globe opens ONE bottom sheet, «المظهر واللغة والعملة», with three
 * rows on the home header — the appearance, the language, the display
 * currency — and two on the dashboard (no currency: admin and merchant screens
 * print dinars of record). A choice closes the sheet first and only then
 * changes the theme (a circle from the centre, tests/themeSystem.test.ts), the
 * language (a calm View Transition, src/lib/langSwap.ts — driven below against
 * a stubbed document) or the currency (prices re-render from memory).
 *
 * Run: npx tsx --test tests/langThemeSheet.test.ts
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join, dirname, resolve, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
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

test('every header globe opens the «المظهر واللغة والعملة» sheet; the dashboard keeps two rows', () => {
  for (const f of ['src/components/Header.tsx', 'src/components/DashboardLayout.tsx']) {
    const src = read(f);
    assert.match(src, /import LangThemeButton from '\.\/LangThemeSheet'/, `${f} does not use the sheet`);
    assert.match(src, /<LangThemeButton\b/, `${f} does not render the globe that opens the sheet`);
  }
  // Home: the 44px square, three rows. Dashboard: the quieter icon, two rows.
  assert.match(read('src/components/Header.tsx'), /<LangThemeButton\b(?![^>]*variant="dash")/);
  assert.match(read('src/components/DashboardLayout.tsx'), /<LangThemeButton\b[^>]*variant="dash"/);
  const sheet = read('src/components/LangThemeSheet.tsx');
  assert.match(sheet, /const withCurrency = variant === 'home';/);
  assert.match(sheet, /withCurrency=\{withCurrency\}/);
  // The panel offers the row only on the home header and inside a CurrencyProvider.
  const panel = read('src/components/LangThemePanel.tsx');
  assert.match(panel, /const currencyLabel = withCurrency && money \? loc\('عملة العرض', 'Display currency', 'دراوی پیشاندان'\) : null;/);
  assert.match(panel, /\{currencyLabel !== null && \(/);
  // The first paint carries none of the currency row: the eager trigger never imports the currency context.
  assert.doesNotMatch(sheet.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, ''), /CurrencyContext|useOptionalMoney|setCurrency/);
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

test('the sheet is the notifications sheet: grabber, title, the three rows in the brief\u2019s order, the theme store', () => {
  const src = read('src/components/LangThemeSheet.tsx') + '\n' + read('src/components/LangThemePanel.tsx');
  // The same primitive as the notifications sheet, at every width.
  assert.match(src, /import \{ Sheet \} from '\.\/ui\/Overlay'/);
  assert.match(src, /<Sheet[\s\S]{0,400}docked[\s\S]{0,300}testId="lang-theme-sheet"/);
  assert.match(src, /labelledBy=\{titleId\}/);
  // The title, in all three languages — the Sorani its own (row 183).
  assert.ok(src.includes("loc('المظهر واللغة والعملة', 'Appearance, language & currency', 'ڕووکار و زمان و دراو')"), 'the home title');
  assert.ok(src.includes("loc('المظهر واللغة', 'Appearance & language', 'ڕووکار و زمان')"), 'the dashboard title');
  assert.ok(src.includes("loc('المظهر', 'Appearance', 'ڕووکار')"));
  assert.ok(src.includes("loc('عملة العرض', 'Display currency', 'دراوی پیشاندان')"));
  assert.ok(src.includes("'نەتوانرا لیستەکە بکرێتەوە — دووبارە هەوڵ بدەرەوە'"), 'the chunk-failure toast in Sorani');
  // Row 1 the appearance, row 2 the language, row 3 the currency — in that order.
  const panel = read('src/components/LangThemePanel.tsx');
  const themeRow = panel.indexOf('data-lang-theme-row="appearance"');
  const langRow = panel.indexOf('data-lang-theme-row="language"');
  const currencyRow = panel.indexOf('data-lang-theme-row="currency"');
  assert.ok(themeRow > 0 && langRow > themeRow && currencyRow > langRow, 'appearance → language → currency');
  for (const s of ['العربية', 'English', 'کوردی', "'فاتح', 'Light', 'ڕووناک'", "'داكن', 'Dark', 'تاریک'", "'حسب الجهاز', 'System', 'بەپێی ئامێر'"]) {
    assert.ok(src.includes(s), `${s} is missing`);
  }
  // The currency row: a radiogroup with the probe attribute, the two names in three languages.
  assert.match(panel, /dataAttr="data-currency-choice"/);
  assert.match(panel, /IQD: \{ ar: 'الدينار العراقي', en: 'Iraqi dinar', ckb: 'دیناری عێراقی' \}/);
  assert.match(panel, /USD: \{ ar: 'الدولار الأمريكي', en: 'US dollar', ckb: 'دۆلاری ئەمریکی' \}/);
  assert.match(src, /<Sun\b/);
  assert.match(src, /<Moon\b/);
  assert.match(src, /from '\.\.\/lib\/theme'/);
  assert.match(src, /useTheme\(\)/);
  // Every string is written in all three languages: no hand-off marker left (row 183).
  assert.doesNotMatch(src, /OWNER: Sorani/);
  // The trigger is 44px.
  assert.match(src, /h-11 w-11/);
  assert.match(src, /min-h-11 min-w-11/);
});

test('first paint does not load the unopened settings panel or overlay primitives', () => {
  const seen = new Set<string>();
  function visit(file: string) {
    if (seen.has(file)) return;
    seen.add(file);
    const source = ts.createSourceFile(file, readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true);
    for (const statement of source.statements) {
      if (!ts.isImportDeclaration(statement) && !ts.isExportDeclaration(statement)) continue;
      if (ts.isImportDeclaration(statement)) {
        const clause = statement.importClause;
        if (clause?.isTypeOnly) continue;
        const bindings = clause?.namedBindings;
        if (!clause?.name && bindings && ts.isNamedImports(bindings) && bindings.elements.every((e) => e.isTypeOnly)) continue;
      } else if (statement.isTypeOnly) continue;
      const specifier = statement.moduleSpecifier;
      if (!specifier || !ts.isStringLiteral(specifier) || !specifier.text.startsWith('.')) continue;
      const base = resolve(dirname(file), specifier.text);
      const dependency = [base, `${base}.ts`, `${base}.tsx`, join(base, 'index.ts'), join(base, 'index.tsx')]
        .find((candidate) => existsSync(candidate) && statSync(candidate).isFile() && /\.tsx?$/.test(candidate));
      if (dependency) visit(dependency);
    }
  }
  visit(join(ROOT, 'src/main.tsx'));
  const closure = [...seen].map((file) => relative(ROOT, file));
  assert.ok(closure.includes('src/components/LangThemeSheet.tsx'), 'the header control stays available at first paint');
  for (const deferred of ['LangThemePanel.tsx', 'ui/Overlay.tsx', 'ui/Segmented.tsx']) {
    assert.ok(!closure.includes(`src/components/${deferred}`), `${deferred} re-entered the initial static dependency graph`);
  }
  const trigger = read('src/components/LangThemeSheet.tsx');
  assert.match(trigger, /import\('\.\/LangThemePanel'\)/);
  for (const event of ['onPointerEnter', 'onPointerDown', 'onFocus']) {
    assert.ok(trigger.includes(`${event}={prewarmPanel}`), `${event} should prepare the sheet before the click`);
  }
  assert.match(trigger, /aria-busy=\{open && !Panel\}/);
  assert.match(trigger, /buttonRef\.current\?\.focus\(\{ preventScroll: true \}\)/);
});

test('a choice closes the sheet FIRST, and changes things only once it has gone — the currency too', () => {
  const src = read('src/components/LangThemeSheet.tsx');
  assert.match(src, /onExited=\{flush\}/);
  assert.match(src, /setThemePreference\(next, \{ origin: 'center', duration: CENTER_REVEAL_MS \}\)/);
  assert.match(src, /commit\(next === preference \? null :/);
  // Every row commits through the same door: an arrow key only moves the pick; a choice closes, then changes.
  const commit = src.slice(src.indexOf('const commit = '), src.indexOf('const chooseLang'));
  assert.match(commit, /if \(navigating\.current\) \{\s*navigating\.current = false;\s*return;\s*\}\s*closeThen\(change\);/);
  assert.match(src, /commit\(next === lang \? null : \(\) => setLang\(next\)\)/);
  // The currency rides the same path from the panel: the sheet leaves, then setCurrency — synchronous, no request.
  const panel = read('src/components/LangThemePanel.tsx');
  assert.match(panel, /commit\(next === currency \|\| !money \? null : \(\) => money\.setCurrency\(next\)\)/);
  const choose = panel.slice(panel.indexOf('const chooseCurrency'), panel.indexOf('return ('));
  assert.doesNotMatch(choose, /api\.|fetch\(/, 'choosing a currency asks nothing of the network');
  // Each opening starts from the currency in use.
  assert.match(panel, /if \(open\) setCurrencyPick\(currency\);/);
  // A hidden tab never reports the exit: the change still happens.
  assert.match(src, /EXIT_FALLBACK_MS/);
  const overlay = read('src/components/ui/Overlay.tsx');
  assert.match(overlay, /<AnimatePresence onExitComplete=\{onExited\}>/);
  assert.match(overlay, /dock: 'items-end justify-center p-0'/);
  // Swipe-down and the grabber are Sheet's, under reduced motion too the slide is a fade.
  assert.match(overlay, /travel: number \| string = dock \? \(m\.reduced \? 0 : '100%'\)/);
  // Arrow keys follow the writing direction in every row (the shared radiogroup).
  assert.match(read('src/components/ui/Segmented.tsx'), /dir/);
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

// ------------------------------------------------- the currency row, rendered

/** Render in one language: LanguageProvider reads it from storage, as a returning visitor's browser holds it. */
function inLanguage<T>(lang: 'ar' | 'en' | 'ckb', fn: () => T): T {
  const g = globalThis as Record<string, unknown>;
  const saved = g.localStorage;
  g.localStorage = { getItem: (k: string) => (k === 'levo_lang' ? lang : null), setItem() {}, removeItem() {} };
  try {
    return fn();
  } finally {
    g.localStorage = saved;
  }
}

async function captions(lang: 'ar' | 'en' | 'ckb', pick: 'IQD' | 'USD', rate: { text: string; source: 'shop' | 'cache'; attributed?: boolean } | null) {
  const { createElement } = await import('react');
  const { renderToStaticMarkup } = await import('react-dom/server');
  const { LanguageProvider } = await import('../src/LanguageContext');
  const { CurrencyValueProvider, currencyValue } = await import('../src/CurrencyContext');
  const { CurrencyCaptions } = await import('../src/components/LangThemePanel');
  return inLanguage(lang, () =>
    renderToStaticMarkup(
      createElement(LanguageProvider, {
        children: createElement(CurrencyValueProvider, { value: currencyValue(pick, () => {}, rate), children: createElement(CurrencyCaptions, { pick }) }),
      })
    )
  );
}

test('the currency captions: display only, then the SHOP’s rate with the IQWealth attribution — in all three languages (§13, critique L8)', async () => {
  const shop = { text: '1703.9167', source: 'shop' as const };
  const want = {
    ar: ['للعرض فقط — الدفع والفواتير بالدينار', 'سعر المتجر، بناءً على بيانات', 'د.ع'],
    en: ['Display only — you pay and are billed in dinars', 'the shop&#x27;s rate, based on', 'IQWealth data'],
    ckb: ['تەنها بۆ پیشاندانە — پارەدان و پسوولە بە دینارە', 'نرخی فرۆشگا، لەسەر بنەمای زانیاریی', 'دینار'],
  } as const;
  for (const lang of ['ar', 'en', 'ckb'] as const) {
    const html = await captions(lang, 'USD', shop);
    for (const w of want[lang]) assert.ok(html.includes(w), `${lang}: «${w}» missing in ${html}`);
    // Whole dinars after «≈»: four decimals there were false precision (FX-1 UX review #15).
    assert.ok(html.includes('1 $ ≈ 1,704'), `${lang}: the shop's rate in whole dinars`);
    assert.ok(!html.includes('1,703.9167'), `${lang}: no false precision`);
    // The link: IQWealth's own site, a new tab, no opener, no referrer.
    assert.match(html, /<a href="https:\/\/iraqsm\.com" target="_blank" rel="noopener noreferrer" data-iqwealth-attribution="true"/);
    assert.match(html, /data-currency-rate="shop"/);
  }
  // The Sorani is its own, never the Arabic.
  assert.notEqual(want.ckb[0], want.ar[0]);
});

test('the currency captions: a rate the shop sets by hand is never credited to IQWealth; dinars show no rate line', async () => {
  // The shop rate this device remembered from its last visit, shown before the settings arrive: the shop's, not credited.
  const cached = await captions('en', 'USD', { text: '1703.9167', source: 'cache' });
  assert.match(cached, /data-currency-rate="fixed"/);
  assert.match(cached, /a rate set by the shop/);
  assert.doesNotMatch(cached, /iraqsm|IQWealth/);
  // A rate the OWNER typed (a manual USD rate) is the shop's — never credited to IQWealth (FX-1 review #10).
  for (const lang of ['ar', 'en', 'ckb'] as const) {
    const typed = await captions(lang, 'USD', { text: '1650', source: 'shop', attributed: false });
    assert.match(typed, /data-currency-rate="fixed"/, lang);
    assert.doesNotMatch(typed, /iraqsm|IQWealth/, lang);
  }
  const dinars = await captions('en', 'IQD', { text: '1703.9167', source: 'shop' });
  assert.match(dinars, /Display only/);
  assert.doesNotMatch(dinars, /data-currency-rate=/);
  // No usable rate at all: the caption only, never «1 $ ≈ 0» — and never the wallet's 1,400 (owner decision 9).
  const none = await captions('ar', 'USD', null);
  assert.doesNotMatch(none, /≈|1,400|1400/);
});

test('dollars chosen before the shop has a rate: prices read in dinars and the menu says why, in all three languages (owner decision 9)', async () => {
  const want = {
    ar: 'القراءة بالدولار متاحة بعد اعتماد سعر المتجر؛ الأسعار تُعرض بالدينار الآن.',
    en: 'The dollar reading is available once the shop&#x27;s rate is approved; prices show in dinars for now.',
    ckb: 'خوێندنەوە بە دۆلار دوای پەسەندکردنی نرخی فرۆشگاکە بەردەست دەبێت؛ ئێستا نرخەکان بە دینار پیشان دەدرێن.',
  } as const;
  for (const lang of ['ar', 'en', 'ckb'] as const) {
    const pending = await captions(lang, 'USD', null);
    assert.match(pending, /data-currency-usd-pending/, lang);
    assert.ok(pending.includes(want[lang]), `${lang}: «${want[lang]}» missing in ${pending}`);
    assert.doesNotMatch(pending, /data-currency-rate=/, lang);
    // With a shop rate, or with dinars chosen, the note is not shown.
    assert.doesNotMatch(await captions(lang, 'USD', { text: '1680', source: 'shop' }), /data-currency-usd-pending/, lang);
    assert.doesNotMatch(await captions(lang, 'IQD', null), /data-currency-usd-pending/, lang);
  }
  assert.notEqual(want.ckb, want.ar);
});
