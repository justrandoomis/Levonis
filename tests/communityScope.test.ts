/**
 * THE COMMUNITY SCOPE (community UI plan B1; DECISIONS row 270, written in
 * phase D). The reference palette lives under `[data-surface='community']`
 * in a lazy stylesheet, and nowhere else:
 *
 *  a. the token blocks are 0,2,0 (`[data-surface='community'][data-theme=…]`),
 *     written by hand OUTSIDE the generated THEME TOKENS markers, in
 *     src/styles/community.css, which only CommunitySurface imports;
 *  b. `CommunityGate` carries no scope: it also wraps the storefront product
 *     page of `/community/store/:slug/p/:productSlug` (plan R17), so the scope
 *     is stamped on the community page roots only;
 *  c. the portals (windows, menus, the shell toast stack) carry the scope
 *     through src/components/community/scopePortals.ts, from the DOM, and the
 *     house primitives (ui/Overlay, ui/Toast, lib/toastStore) carry nothing of
 *     it, so no storefront visit pays for it (round 4: a React context in
 *     Overlay cost every store page and the first toast about 4 KB);
 *  d. every text and boundary pair of the scope meets WCAG AA in both
 *     themes, computed from the CSS values themselves;
 *  e. D-2 and D-3 as the owner overrode them: the primary is the sand-gold
 *     gradient with ink text, a selection the solid sand fill with ink text
 *     and a non-colour cue, both inside the scope only;
 *  f. the kit words exist in Arabic, English and Sorani, and no Sorani value
 *     is the Arabic copied (row 183);
 *  g. the kit review (round 1): the tile badge stays out of the content box,
 *     the segmented divider and weights, the stepper keys as drawn, the drop
 *     zone row, the photo tile overlays and its chosen cover, and the filter
 *     options as radio items;
 *  h. the kit review (round 2): the one-line tile badge inside the tile with
 *     its seat kept clear, the tile icons in the primary ink, the swatch ringed
 *     and at the inline start, the busy gold spinner in the ink, and no
 *     apostrophe in an English comment of the scope sheet; (round 3) a word
 *     wider than its tile body still 2px clear of the badge;
 *  i. the kit review (round 3): the chosen segmented label never clipped on a
 *     phone, the focus drawn off the sand, the menu row focus line, and the
 *     held button at full ink under reduced motion;
 *  j. the kit review (round 4): the tab underline as wide as the label plus
 *     24px, every held control at full ink in both motion settings, and the
 *     ON knob of the Toggle in Highlight under forced colours;
 *  k. the fix round (B1FIX round 1): the current ListRow and a current or
 *     chosen `.cm-sel` keep the house Highlight cue under forced colours; the
 *     tab label fills its tab, so the underline stays on the baseline
 *     whichever tab is chosen (its kit sheets were folded back in round 2);
 *  l. the fix round 2 (B1FIX round 2): the whole kit draws from ONE sheet,
 *     the layer order stated once, no rule the house controls or a shipped
 *     utility already say; and under forced colours the underline of the
 *     chosen tab is Highlight.
 *
 * scripts/e2e-community-kit.mjs measures the same in Chromium on the kit
 * fixture (tests/browser/community-kit.html).
 *
 * Run: node --import tsx --test tests/communityScope.test.ts
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { BEGIN, END, buildBlock, contrast, parseColor, rgbToOklch } from '../scripts/theme-tokens.mjs';
import { KIT_STRINGS } from '../src/components/community/kit/strings';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (p: string) => readFileSync(join(ROOT, p), 'utf8');
const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, '');
const SHEET = 'src/styles/community.css';
/**
 * The one community sheet: the tokens, the shared recipes and every look of the kit (B1FIX-R2-REG-1:
 * split into sheets beside their modules, the kit only postponed its cost, and cost 338 B more).
 */
const scopeCss = strip(read(SHEET));
const css = scopeCss;
const indexCss = read('src/index.css');

/** A sheet without its `@layer components { … }` blocks. */
function unlayered(source: string): string {
  let kept = '';
  let from = 0;
  for (;;) {
    const at = source.indexOf('@layer components {', from);
    if (at < 0) return kept + source.slice(from);
    kept += source.slice(from, at);
    let depth = 0;
    let i = source.indexOf('{', at);
    for (; i < source.length; i++) {
      if (source[i] === '{') depth++;
      else if (source[i] === '}' && --depth === 0) break;
    }
    from = i + 1;
  }
}
/** The `@layer components { … }` blocks of a sheet, their contents only. */
const layered = (source: string): string[] => {
  const blocks: string[] = [];
  for (let at = source.indexOf('@layer components {'); at >= 0; at = source.indexOf('@layer components {', at + 1)) {
    let depth = 0;
    const open = source.indexOf('{', at);
    let i = open;
    for (; i < source.length; i++) {
      if (source[i] === '{') depth++;
      else if (source[i] === '}' && --depth === 0) break;
    }
    blocks.push(source.slice(open + 1, i));
  }
  return blocks;
};
/** The parts of a selector list, split at the commas outside brackets and parentheses. */
function selectorParts(list: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < list.length; i++) {
    if ('(['.includes(list[i])) depth++;
    else if (')]'.includes(list[i])) depth--;
    else if (list[i] === ',' && depth === 0) {
      parts.push(list.slice(start, i).trim());
      start = i + 1;
    }
  }
  parts.push(list.slice(start).trim());
  return parts.filter(Boolean);
}

type Theme = 'dark' | 'light';
type Rgb = number[];

/** The declarations of the first rule whose selector is exactly `selector`. */
function rule(source: string, selector: string): Record<string, string> {
  const at = source.indexOf(`${selector} {`);
  assert.ok(at >= 0, `${SHEET}: no rule \`${selector}\``);
  const body = source.slice(source.indexOf('{', at) + 1, source.indexOf('}', at));
  return Object.fromEntries(
    body
      .split(';')
      .map((d) => d.trim())
      .filter((d) => d.startsWith('--'))
      .map((d) => [d.slice(2, d.indexOf(':')).trim(), d.slice(d.indexOf(':') + 1).trim()])
  );
}

const generated = buildBlock();
const generatedVars = (theme: Theme): Record<string, string> => {
  const part = theme === 'light' ? generated.slice(generated.indexOf("[data-theme='light']"), generated.indexOf("[data-theme='dark']")) : generated.slice(generated.indexOf("[data-theme='dark']"));
  return Object.fromEntries([...part.matchAll(/--([a-z0-9-]+):([^;}]+)/g)].map((m) => [m[1], m[2].trim()]));
};
const common = rule(scopeCss, "[data-surface='community']");
const scoped: Record<Theme, Record<string, string>> = {
  dark: rule(scopeCss, "[data-surface='community'][data-theme='dark']"),
  light: rule(scopeCss, "[data-surface='community'][data-theme='light']"),
};
/** What a variable resolves to inside the scope: the scope over the generated theme. */
const V = (theme: Theme): Record<string, string> => ({ ...generatedVars(theme), ...common, ...scoped[theme] });

/** A colour value (hex, oklch or rgb(r g b/a) over a ground) as linear-free sRGB 0..1. */
function color(value: string, ground?: Rgb): Rgb {
  const v = value.trim();
  const m = v.match(/^rgb\((\d+) (\d+) (\d+)\/([.\d]+)\)$/);
  if (m) {
    assert.ok(ground, `${v} is translucent and needs a ground`);
    const [r, g, b, a] = m.slice(1).map(Number);
    return [r / 255, g / 255, b / 255].map((c, i) => c * a + ground![i] * (1 - a));
  }
  return parseColor(v);
}
const ratio = (a: Rgb, b: Rgb) => contrast(a, b);

/** An opaque colour at alpha `a` painted over a ground (sRGB compositing, as the browser does). */
const over = (fg: Rgb, a: number, ground: Rgb): Rgb => fg.map((c, i) => c * a + ground[i] * (1 - a));

/** `color-mix(in oklab, a p, b)` for two opaque colours, as the browser paints it. */
function mixOklab(a: Rgb, b: Rgb, p: number): Rgb {
  const lab = (rgb: Rgb) => {
    const [L, C, H] = rgbToOklch(rgb);
    return [L, C * Math.cos((H * Math.PI) / 180), C * Math.sin((H * Math.PI) / 180)];
  };
  const [L, A, B] = lab(a).map((v, i) => v * p + lab(b)[i] * (1 - p));
  const H = ((Math.atan2(B, A) * 180) / Math.PI + 360) % 360;
  return parseColor(`oklch(${(L * 100).toFixed(6)}% ${Math.hypot(A, B).toFixed(6)} ${H.toFixed(6)})`);
}

// ----------------------------------------------------------------------- a
test('a. the scope token blocks are 0,2,0, hand-written outside the generated markers, in a sheet only CommunitySurface imports', () => {
  for (const theme of ['dark', 'light'] as const) {
    const selector = `[data-surface='community'][data-theme='${theme}']`;
    // Two attribute selectors and nothing else: 0,2,0, which beats the generated 0,1,0 block on the same element.
    assert.equal((selector.match(/\[/g) ?? []).length, 2);
    assert.match(scopeCss, new RegExp(`(^|\\n)${selector.replace(/[[\]]/g, '\\$&')} \\{`), `${theme}: the scope block is missing`);
    assert.ok(Object.keys(scoped[theme]).length > 10, `${theme}: the scope block is empty`);
  }
  // Every top-level rule of each community sheet (the tokens and the re-skins, outside the
  // components layer) is under the scope; every rule in the components layer is keyed to a `cm-`
  // class, which exists only in community markup.
  for (const [file, source] of [[SHEET, scopeCss]]) {
    for (const m of unlayered(source).matchAll(/(^|\n)([^@\n{}][^{}]*)\{/g)) {
      const selector = m[2].trim();
      if (!selector.startsWith('[')) continue;
      assert.match(selector, /^\[data-surface='community'\]/, `${file}: a rule outside the scope: ${selector}`);
    }
    for (const block of layered(source)) {
      for (const m of block.matchAll(/([^{}]+)\{/g)) {
        if (m[1].trim().startsWith('@')) continue;
        for (const part of selectorParts(m[1])) assert.match(part, /\.cm-[a-z]|\[data-surface='community'\]/, `${file}: a layered rule not keyed to the community: ${part}`);
      }
    }
    assert.doesNotMatch(source, /:root\s*\{|(^|\n)html\b|(^|[\s,])\[data-theme(=[^\]]*)?\]\s*\{/, `${file} restyles something outside the scope`);
    // The layer order is stated again, so a sheet parsed first never ranks components under the preflight.
    assert.match(source, /@layer theme, base, components, utilities;/, `${file}: the layer order is not stated`);
  }
  // The generated block is untouched by the scope, and index.css carries no scope at all.
  const inside = indexCss.slice(indexCss.indexOf(BEGIN), indexCss.indexOf(END));
  assert.doesNotMatch(inside, /data-surface/, 'the scope leaked into the generated THEME TOKENS block');
  assert.doesNotMatch(strip(indexCss), /data-surface|\.cm-[a-z]/, 'src/index.css carries community scope rules (they belong in the lazy sheet)');
  // Only CommunitySurface imports the sheet, and only community page modules import CommunitySurface.
  const sources = (readdirSync(join(ROOT, 'src'), { recursive: true }) as string[]).filter((f) => /\.tsx?$/.test(f)).map((f) => `src/${f.split('\\').join('/')}`);
  const importers = (needle: RegExp) => sources.filter((f) => needle.test(read(f))).sort();
  assert.deepEqual(importers(/import '[./]*styles\/community\.css'/), ['src/components/community/CommunitySurface.tsx']);
  // No other community module brings a sheet of its own (B1FIX-R2-REG-1): one sheet, counted whole.
  const community = sources.filter((f) => (f.startsWith('src/components/community/') || f.startsWith('src/pages/community/')) && f !== 'src/components/community/CommunitySurface.tsx');
  for (const f of community) assert.doesNotMatch(read(f), /import '[^']*\.css'/, `${f} imports a stylesheet of its own`);
  assert.deepEqual(read('src/components/community/CommunitySurface.tsx').match(/import '[^']*\.css'/g), ["import '../../styles/community.css'"]);
  const roots = [
    'src/pages/Community.tsx',
    'src/pages/Requests.tsx',
    'src/pages/community/Creator.tsx',
    'src/pages/community/Following.tsx',
    'src/pages/community/Makers.tsx',
    'src/pages/community/Project.tsx',
    'src/pages/community/ProjectComposer.tsx',
    'src/pages/community/Projects.tsx',
    'src/pages/community/Request.tsx',
    'src/pages/community/RequestNew.tsx',
    'src/pages/community/Saved.tsx',
    'src/pages/community/Stores.tsx',
  ];
  assert.deepEqual(importers(/from '[./]*components\/community\/CommunitySurface'/), roots);
  for (const f of roots) assert.match(read(f), /<CommunitySurface\b[^>]*>[\s\S]*<\/CommunitySurface>/, `${f}: the page root is not stamped`);
  // No storefront, shell or entry module reaches the scope (it would download the sheet with every store visit).
  for (const f of ['src/App.tsx', 'src/main.tsx', 'src/pages/Storefront.tsx', 'src/pages/StorefrontProduct.tsx', 'src/pages/CommunityStorePage.tsx', 'src/components/Header.tsx', 'src/components/BottomNav.tsx']) {
    assert.doesNotMatch(read(f), /CommunitySurface|community\.css|community\/kit\//, `${f} imports the community scope`);
  }
});

// ----------------------------------------------------------------------- b
test('b. CommunityGate carries no scope; the scope root stamps the surface and the current theme', () => {
  const gate = read('src/pages/community/access.tsx');
  assert.doesNotMatch(gate, /data-surface|CommunitySurface/, 'CommunityGate is stamped: the storefront product page inside it would turn community');
  assert.doesNotMatch(read('src/App.tsx'), /data-surface/);
  const root = read('src/components/community/CommunitySurface.tsx');
  assert.match(root, /const \{ theme \} = useTheme\(\);/);
  assert.match(root, /<div ref=\{root\} data-surface="community" data-theme=\{theme\} className=\{`cm-surface /);
  assert.match(root, /import '\.\.\/\.\.\/styles\/community\.css';/);
});

// ----------------------------------------------------------------------- c
test('c. the portals carry the scope from community code alone; the house primitives carry nothing of it', () => {
  // B1R4-REG-1/2. A context declared in Overlay made the module impure (a top-level call), so the
  // shell Toaster and every store page loaded the whole window primitive (+4.2 KB), and the scope root
  // imported it on every community page (+38.6 KB with the animation core). Byte for byte the three
  // house modules are what the storefront ships without the community (tests/bundleBudget.test.ts).
  const house = ['src/components/ui/Overlay.tsx', 'src/components/ui/Toast.tsx', 'src/lib/toastStore.ts'];
  for (const f of house) {
    assert.doesNotMatch(strip(read(f)), /data-surface|SurfaceContext|SurfaceStamp|ToastSurface|createContext/, `${f} carries the community scope again`);
  }
  const root = read('src/components/community/CommunitySurface.tsx');
  assert.doesNotMatch(strip(root), /from '\.\.\/ui\/|lib\/toastStore|motion\/react/, 'the scope root imports a house primitive: every community page downloads it');
  assert.match(root, /import \{ carryScope \} from '\.\/scopePortals';/);
  assert.match(root, /useLayoutEffect\(\(\) => \(root\.current \? carryScope\(root\.current\) : undefined\), \[\]\);/);
  // The seam: only the scope root imports it, it imports nothing, and it reads the portal roots the
  // house primitives already render into <body>.
  const seam = read('src/components/community/scopePortals.ts');
  assert.doesNotMatch(strip(seam), /^import /m, 'the portal seam imports a module');
  const sources = (readdirSync(join(ROOT, 'src'), { recursive: true }) as string[]).filter((f) => /\.tsx?$/.test(f)).map((f) => `src/${f.split('\\').join('/')}`);
  assert.deepEqual(sources.filter((f) => /from '[./]*scopePortals'/.test(read(f))), ['src/components/community/CommunitySurface.tsx']);
  assert.match(seam, /const PORTAL = '\[data-overlay\], \[data-anchored\]';/);
  assert.match(seam, /const TOASTER = '\[data-toaster\]';/);
  const overlay = read('src/components/ui/Overlay.tsx');
  assert.match(overlay, /data-overlay=\{testId \?\? true\}/);
  assert.match(overlay, /data-anchored=\{testId \?\? true\}/);
  assert.equal((overlay.match(/document\.body\s*\)/g) ?? []).length, 2, 'a window or a menu no longer portals into <body>');
  assert.match(read('src/components/ui/Toast.tsx'), /<section[^>]*\s+data-toaster\b[\s\S]*?document\.body/);
  // A theme switch re-stamps from the attribute of the root, and only stamps this module wrote are removed.
  assert.match(seam, /attributeFilter: \['data-theme'\]/);
  assert.match(seam, /\} else if \(owner\.has\(el\)\) \{/);
});

// ----------------------------------------------------------------------- d
test('d. every scoped text and boundary pair meets WCAG AA in both themes (computed from the CSS values)', () => {
  const failures: string[] = [];
  const flushOnSand: string[] = [];
  const need = (label: string, value: number, min: number) => {
    if (!(value >= min)) failures.push(`${label}: ${value.toFixed(2)}:1, under ${min}`);
  };
  for (const theme of ['dark', 'light'] as const) {
    const v = V(theme);
    const c = (name: string, ground?: Rgb) => color(v[name] ?? assert.fail(`${theme}: --${name} is not defined`), ground);
    const canvas = c('color-canvas');
    const grounds: [string, Rgb][] = [
      ['canvas', canvas],
      ['surface', c('color-surface')],
      ['card top', c('cm-card-1')],
      ['card foot', c('cm-card-2')],
      ['raised', c('color-surface-raised')],
      ['selected', c('color-surface-selected')],
      ['track', c('cm-track')],
      ['well', c('clay-well-bg')],
    ];
    // The menu row highlight (ui/Menu: `focus:bg-white/[0.07]`, the hover follows the focus):
    // 7% of --color-white over the raised menu. A hint («محدد») and a destructive row sit on it.
    const highlight = over(c('color-white'), 0.07, c('color-surface-raised'));
    // Text: the three inks on every ground and on the menu highlight; the gold ink (links, the active tab) too.
    for (const ink of ['color-text-primary', 'color-text-secondary', 'color-text-muted', 'color-gold']) {
      for (const [g, rgb] of [...grounds, ['menu highlight', highlight] as [string, Rgb]]) need(`${theme} --${ink} on ${g}`, ratio(c(ink), rgb), 4.5);
    }
    // The danger ink: the page, a card, a raised control (the trash key), a selected fill, and a
    // destructive menu row under the highlight («حظر الناشر»).
    for (const [g, rgb] of [...grounds, ['menu highlight', highlight] as [string, Rgb]]) need(`${theme} --color-danger on ${g}`, ratio(c('color-danger'), rgb), 4.5);
    need(`${theme} error ink on raised`, ratio(c('color-error-ink'), c('color-surface-raised')), 4.5);
    // D-2: the gold primary, ink on both stops of the gradient.
    for (const stop of ['cm-gold-1', 'cm-gold-2']) need(`${theme} gold label on --${stop}`, ratio(c('cm-gold-ink'), c(stop)), 4.5);
    // D-3: the selection, ink on the sand; the badge check on its disc.
    need(`${theme} selection ink on the sand`, ratio(c('cm-sel-ink'), c('cm-sel-bg')), 4.5);
    need(`${theme} badge check on its disc`, ratio(c('cm-sel-bg'), c('cm-sel-badge')), 3);
    need(`${theme} outline label on its fill`, ratio(c('color-gold'), c('cm-outline-bg')), 4.5);
    // The status pills: the word on its fill.
    for (const [fill, ink] of [['cm-open-bg', 'cm-open-ink'], ['cm-wait-bg', 'cm-wait-ink'], ['cm-prog-bg', 'cm-prog-ink'], ['color-surface-selected', 'color-text-secondary'], ['cm-stop-bg', 'cm-stop-ink']]) {
      need(`${theme} pill --${ink} on --${fill}`, ratio(c(ink), c(fill)), 4.5);
    }
    // Boundaries (WCAG 1.4.11): the field line, the focus ring, the selected cue, the gold edge in light.
    // A field sits on the page, a card or a raised control, and is itself the well.
    for (const [g, rgb] of grounds.filter(([g]) => g !== 'selected' && g !== 'track')) need(`${theme} --clay-field on ${g}`, ratio(c('clay-field'), rgb), 3);
    // The focus line on every ground, and inset on the menu row it marks (the row also takes the highlight).
    for (const [g, rgb] of [...grounds, ['menu highlight', highlight] as [string, Rgb]]) need(`${theme} focus ring on ${g}`, ratio(c('color-focus'), rgb), 3);
    // On the sand (round 3): a ring flush on a chosen thumb, tile or chip has to read 3:1 against the
    // fill and its edge, or stand off it with the ground showing between (the rule asserted below).
    const flush = Math.min(ratio(c('color-focus'), c('cm-sel-bg')), ratio(c('color-focus'), c('cm-sel-edge')));
    if (flush < 3) flushOnSand.push(`${theme} ${flush.toFixed(2)}:1`);
    const card = c('color-surface');
    if (theme === 'dark') {
      // The sand reads by itself on the dark grounds.
      for (const [g, rgb] of grounds.slice(0, 6)) need(`dark sand selection vs ${g}`, ratio(c('cm-sel-bg'), rgb), 3);
      need('dark gold primary vs the card', ratio(c('cm-gold-2'), card), 3);
    } else {
      // On cream the sand is 1.3-1.9:1, so the 1px edge carries the boundary.
      for (const [g, rgb] of grounds.slice(0, 6)) {
        need(`light selection edge vs ${g}`, ratio(c('cm-sel-edge'), rgb), 3);
        need(`light gold edge vs ${g}`, ratio(c('cm-gold-edge'), rgb), 3);
      }
      need('light selection edge vs the sand', ratio(c('cm-sel-edge'), c('cm-sel-bg')), 3);
    }
    // The status inks (an lv-chip, an alert, a state word) on every ground, and the lv-chip
    // under its own ink: 12% of the tone mixed into the raised fill in OKLab (src/index.css).
    for (const tone of ['color-success', 'color-warning', 'color-info']) {
      for (const [g, rgb] of grounds) need(`${theme} --${tone} on ${g}`, ratio(c(tone), rgb), 4.5);
      need(`${theme} lv-chip --${tone} on its 12% mix over raised`, ratio(c(tone), mixOklab(c(tone), c('color-surface-raised'), 0.12)), 4.5);
    }
    // The chosen cover line is drawn outside the photo, on the card or the page (1.4.11).
    for (const [g, rgb] of grounds.slice(0, 5)) need(`${theme} cover line vs ${g}`, ratio(c('cm-gold-line'), rgb), 3);
    need(`${theme} like colour on the card`, ratio(c('cm-like'), card), 3);
    need(`${theme} step on vs the canvas`, ratio(c('cm-step-on'), canvas), 3);
    need(`${theme} switch knob on the sand`, ratio(c('cm-sel-ink'), c('cm-sel-bg')), 3);
    // A HELD kit button keeps its full ink under reduced motion too (the rule asserted below), so
    // the label on its pressed fill: the gold under the 0.93 brightness of the press, the outline on
    // its fill, the ghost on the well it dents into, the danger on its fill at rest (touch) and
    // hovered (pointer), the secondary hovered.
    const pressed = (name: string) => c(name).map((ch) => ch * 0.93);
    for (const stop of ['cm-gold-1', 'cm-gold-2']) need(`${theme} held gold label on --${stop}`, ratio(pressed('cm-gold-ink'), pressed(stop)), 4.5);
    need(`${theme} held outline label`, ratio(c('color-gold'), c('cm-outline-bg')), 4.5);
    need(`${theme} held ghost label on the well`, ratio(c('color-text-secondary'), c('clay-well-bg')), 4.5);
    for (const p of [0.14, 0.22]) need(`${theme} held danger label on its ${Math.round(p * 100)}% fill`, ratio(c('color-danger-ink'), mixOklab(c('color-danger'), c('color-surface'), p)), 4.5);
    need(`${theme} held secondary label`, ratio(c('color-text-primary'), mixOklab(c('color-text-primary'), c('color-surface-raised'), 0.08)), 4.5);
  }
  assert.deepEqual(failures, [], `contrast under the floor:\n${failures.join('\n')}`);
  // The focus off the sand (WCAG 2.4.7, 1.4.11): where a flush ring would not read (dark), the thumb,
  // the tile and the chip draw a 2px focus line 2px off the control, the utility ring dropped.
  const offFocus = /\[data-surface='community'\] \.cm-seg > \[role='radio'\]:focus-visible,\s*\[data-surface='community'\] \.cm-sel:focus-visible,\s*\[data-surface='community'\] :focus-visible > \.cm-sel \{([^}]*)\}/.exec(css);
  assert.ok(offFocus, `a flush ring on the sand reads ${flushOnSand.join(', ') || 'enough'}, and the focus is not drawn off it`);
  assert.match(offFocus![1], /outline: 2px solid var\(--color-focus\);/);
  assert.ok(parseFloat(/outline-offset: ([\d.]+)px/.exec(offFocus![1])?.[1] ?? '0') >= 2, 'the focus line touches the sand');
  assert.match(offFocus![1], /box-shadow: var\(--tw-shadow\);/, 'the utility ring still hugs the sand');
  assert.ok(flushOnSand.some((f) => f.startsWith('dark')), 'the dark sand reads 3:1 against a flush ring after all: revisit the offset');
  // The menu row under the keyboard wears the focus line, inset; the tint stays for the pointer.
  assert.match(css, /\[data-surface='community'\] \[data-menu-item\]:focus-visible \{\s*outline: 2px solid var\(--color-focus\);\s*outline-offset: -2px;\s*\}/);
  // The held button: the house dims every pressed button to 0.72 under reduced motion (an outline
  // label fell to 3.2:1 on cream); in the scope the clay dent answers the touch at full ink (test j
  // holds every other control to the same).
  assert.match(strip(indexCss), /@media \(prefers-reduced-motion: reduce\) \{[\s\S]*?button:active,[\s\S]*?opacity: 0\.72 !important;/);
  assert.match(indexCss, /\.lv-button:not\(:disabled\):not\(\[aria-disabled='true'\]\):active \{\s*opacity: 1;\s*--tw-shadow: var\(--clay-press\);/);
  // The menu highlight the grounds above model.
  assert.match(read('src/components/ui/Menu.tsx'), /focus:bg-white\/\[0\.07\]/);
  // The chip recipe the mix above models.
  assert.match(indexCss, /\.lv-chip \{\s*background-color: color-mix\(in oklab, var\(--chip\) 12%, var\(--color-surface-raised\)\);/);
});

// ----------------------------------------------------------------------- e
test('e. D-2 and D-3 as the owner overrode them: a gold gradient primary and a solid sand selection with a non-colour cue, in the scope only', () => {
  // D-2: the gradient, dark #E7CCA1 to #C8A777 (the reference), a light counterpart with the 1px edge.
  assert.equal(scoped.dark['cm-gold-1'], '#e7cca1');
  assert.equal(scoped.dark['cm-gold-2'], '#c8a777');
  assert.ok(scoped.light['cm-gold-1'] && scoped.light['cm-gold-2'], 'no light gold stops');
  assert.match(css, /\.lv-button\.cm-btn-gold \{[^}]*background: linear-gradient\(180deg, var\(--cm-gold-1\), var\(--cm-gold-2\)\);/);
  assert.match(css, /\.lv-button\.cm-btn-gold \{[^}]*color: var\(--cm-gold-ink\);/);
  // D-3: the five variables, a solid fill (no gradient), on `.cm-sel` keyed to the aria state.
  for (const theme of ['dark', 'light'] as const) {
    const v = V(theme);
    for (const name of ['cm-sel-bg', 'cm-sel-ink', 'cm-sel-edge', 'cm-sel-shadow', 'cm-sel-badge']) assert.ok(v[name], `${theme}: --${name} is missing`);
    assert.match(v['cm-sel-bg'], /^#[0-9a-f]{6}$/, `${theme}: the selection is not a solid fill`);
  }
  const sel = /\.cm-sel:is\(\[aria-pressed='true'\], \[aria-checked='true'\], \[aria-selected='true'\], \[aria-current='page'\], \[data-selected='true'\]\)[^{]*\{([^}]*)\}/.exec(css);
  assert.ok(sel, '.cm-sel is not keyed to the aria state');
  for (const decl of ['color: var(--cm-sel-ink)', 'background: var(--cm-sel-bg)', 'border-color: var(--cm-sel-edge)', '--tw-shadow: var(--cm-sel-shadow)']) {
    assert.ok(sel![1].includes(decl), `.cm-sel lost ${decl}`);
  }
  // The non-colour cues: the tiles say aria-checked and draw the check badge; the chip says
  // data-selected; the thumb and the knob keep their shape and place.
  const controls = read('src/components/community/kit/controls.tsx');
  assert.match(controls, /role=\{props\.multiple \? 'checkbox' : 'radio'\}\s*aria-checked=\{on\}/);
  assert.match(controls, /className="cm-check /);
  assert.match(scopeCss, /\.cm-media\[data-selected\] > \.cm-check,\s*\[aria-checked='true'\] > \.cm-check \{\s*display: inline-flex;/);
  assert.match(read('src/components/community/FilterChip.tsx'), /data-selected=\{on \|\| undefined\} className="cm-raised cm-chip cm-sel /);
  assert.match(css, /\[data-surface='community'\] \.cm-seg \[data-segmented-indicator\] \{[^}]*background: var\(--cm-sel-bg\);/);
  assert.match(css, /\[data-surface='community'\] \.cm-switch \[data-switch='on'\] > span \{[^}]*background: var\(--cm-sel-bg\);/);
  // The pill FilterChip (the catalogue facet) is unchanged: still a press, never the sand.
  assert.match(read('src/components/community/FilterChip.tsx'), /'border border-transparent bg-\[var\(--clay-well-bg\)\] text-text-primary shadow-press'/);
});

// ----------------------------------------------------------------------- f
test('f. the kit words: every key in Arabic, English and Sorani, the Sorani its own', () => {
  const keys = (o: object) => Object.keys(o).sort();
  assert.deepEqual(keys(KIT_STRINGS.en), keys(KIT_STRINGS.ar));
  assert.deepEqual(keys(KIT_STRINGS.ckb), keys(KIT_STRINGS.ar));
  // Written in Sorani: the set as a whole uses the letters Arabic does not have.
  const allSorani = Object.values(KIT_STRINGS.ckb).map((v) => (typeof v === 'function' ? v(3, 4) : v)).join(' ');
  assert.ok((allSorani.match(/[ەێۆڵڕڤگپچژکی]/g) ?? []).length > 30, 'the Sorani words are not Sorani');
  const say = (v: unknown) => (typeof v === 'function' ? (v as (a: number, b: number) => string)(3, 4) : String(v));
  for (const key of keys(KIT_STRINGS.ar)) {
    const ar = say((KIT_STRINGS.ar as unknown as Record<string, unknown>)[key]);
    const en = say((KIT_STRINGS.en as unknown as Record<string, unknown>)[key]);
    const ckb = say((KIT_STRINGS.ckb as unknown as Record<string, unknown>)[key]);
    assert.ok(ar && en && ckb, `${key}: a language is empty`);
    assert.notEqual(ckb, ar, `${key}: the Sorani is a copy of the Arabic (row 183)`);
    assert.doesNotMatch(en, /[\u0600-\u06ff]/, `${key}: the English carries Arabic script`);
    // Counters and steps keep Latin digits in every language (plan R13).
    if (/\d/.test(ar)) for (const s of [ar, en, ckb]) assert.match(s, /3.*4/, `${key}: a count lost its Latin digits`);
  }
});

// ----------------------------------------------------------------------- g
test('g. the kit review: badge, segmented, stepper, drop zone, photo tile and filter options', () => {
  const controls = read('src/components/community/kit/controls.tsx');
  const display = read('src/components/community/kit/display.tsx');
  const fields = read('src/components/community/kit/fields.tsx');
  const px = (v: string) => parseFloat(v) * (v.endsWith('rem') ? 16 : 1);
  const decl = (selector: string, prop: string) => {
    const at = css.indexOf(`${selector} {`);
    assert.ok(at >= 0, `${SHEET}: no rule \`${selector}\``);
    const body = css.slice(css.indexOf('{', at) + 1, css.indexOf('}', at));
    return new RegExp(`(?:^|;)\\s*${prop}:\\s*([^;]+);`).exec(body)?.[1].trim();
  };

  // B1-F1, as round 2 moved it: the badge sits INSIDE the tile (test h).
  assert.match(controls, /className="cm-check absolute size-5 /);
  assert.match(controls, /className=\{`cm-raised cm-sel relative flex min-h-14 w-full items-center rounded-md px-3 py-2 /);
  // A two-line tile keeps it over the corner of its 40px icon well (IMG_8474).
  assert.equal(decl('.cm-check', 'inset-inline-start'), '6px');

  // B1-F2. The unchosen options 14/600, the chosen 14/700, and a 1px divider between two unchosen neighbours.
  assert.equal(decl("[data-surface='community'] .cm-seg > [role='radio']", 'font-weight'), '600');
  assert.equal(decl("[data-surface='community'] .cm-seg > [aria-checked='true']", 'font-weight'), '700');
  const divider = "[data-surface='community'] .cm-seg > [aria-checked='false'] + [aria-checked='false']::before";
  assert.equal(decl(divider, 'inline-size'), '1px');
  assert.equal(decl(divider, 'background'), 'var(--color-border-subtle)');

  // B1-F3. The stepper row is an LTR island like its figure: minus on the left, plus on the right,
  // as IMG_8482 draws it in Arabic, with the Tab order running the way it is drawn.
  assert.equal(decl("[data-surface='community'] .cm-stepper .lv-well", 'direction'), 'ltr');

  // B1-F4. The drop zone is one row (the two lines, then the cloud at the inline end) that wraps,
  // cloud above, only when the title cannot sit beside the cloud.
  assert.match(fields, /className="cm-drop cm-drop-zone flex [^"]*"\s*>\s*<span className="flex min-w-0 flex-col gap-1">[\s\S]*?<\/span>\s*<UploadCloud /);
  assert.equal(decl('.cm-drop-zone', 'flex-wrap'), 'wrap-reverse');
  assert.equal(decl('.cm-drop-zone > span > span + span', 'contain'), 'inline-size');

  // A11Y-2. The 24px remove disc sits at least 10px in: its 44px hit ends inside the clipped tile.
  assert.match(display, /className="cm-media-x lv-hit absolute inline-flex size-6 /);
  for (const side of ['inset-block-start', 'inset-inline-start']) assert.ok(px(decl('.cm-media-x', side) ?? '0') >= (44 - 24) / 2, `the remove hit is clipped at ${side}`);
  assert.match(display, /className="cm-media-grip absolute /);
  assert.doesNotMatch(display, /lv-hit absolute top-2 start-2/);
  // A11Y-3. Its focus ring has a canvas halo under the gold, so it shows over a light photo too.
  assert.match(display, /cm-media-x[^"]*focus-visible:ring-2 focus-visible:ring-focus focus-visible:ring-offset-2 focus-visible:ring-offset-canvas/);
  // A11Y-4. The chosen cover: the line outside the photo, the check badge, and the word said aloud.
  assert.ok(px(decl('.cm-media[data-selected]', 'outline-offset') ?? '0') > 0, 'the cover line is drawn on the photo');
  assert.match(css, /\.cm-media\[data-selected\] > \.cm-check,[^{]*\{\s*display: inline-flex;/);
  assert.match(display, /\{selected && \(\s*<>\s*<span className="sr-only">\{s\.cover\}<\/span>\s*<span aria-hidden="true" className="cm-check /);
  for (const lang of ['ar', 'en', 'ckb'] as const) assert.ok(KIT_STRINGS[lang].cover, `${lang}: no cover word`);

  // A11Y-5, as B1FIX-R3-REG-2 leaves it. The chosen filter option wears the check and says «محدد» in its
  // name. Its radio role needs a field in ui/Menu.tsx, and that menu is in the frame every merchant
  // screen loads (+13 B of its 21 B of headroom, for no page that shipped one), so B1 leaves the menu as
  // it was. The day a page renders a FilterSelect, that same push gives the options the radio role.
  const menu = read('src/components/ui/Menu.tsx');
  assert.match(controls, /icon: o\.id === value \? <Check className="h-4 w-4" \/> : <span className="block h-4 w-4" \/>,\s*hint: o\.id === value \? s\.selected : undefined,/);
  for (const lang of ['ar', 'en', 'ckb'] as const) assert.ok(KIT_STRINGS[lang].selected, `${lang}: no «selected» word`);
  assert.notEqual(KIT_STRINGS.ckb.selected, KIT_STRINGS.ar.selected);
  const pages = (['src/pages', 'src/components'] as const)
    .flatMap((dir) => (readdirSync(join(ROOT, dir), { recursive: true }) as string[]).map((f) => `${dir}/${f.split('\\').join('/')}`))
    .filter((f) => /\.tsx?$/.test(f) && !f.startsWith('src/components/community/kit/'))
    .filter((f) => /from '[^']*kit\/controls'/.test(read(f)) && /<FilterSelect\b/.test(read(f)));
  if (pages.length === 0) assert.doesNotMatch(menu, /menuitemradio/, 'B1 grows the menu of every merchant screen for a control no page renders');
  else assert.match(menu, /menuitemradio/, `${pages.join(', ')} render a FilterSelect: its options must be radio items (menuitemradio, aria-checked) in the same push`);
});

// ----------------------------------------------------------------------- h
test('h. the kit review, round 2: badge seat, tile icon ink, swatch, busy spinner, comments', () => {
  const controls = read('src/components/community/kit/controls.tsx');
  const fields = read('src/components/community/kit/fields.tsx');
  const raw = read(SHEET);
  const px = (v: string) => parseFloat(v) * (v.endsWith('rem') ? 16 : 1);
  const body = (source: string, selector: string) => {
    const at = source.indexOf(`${selector} {`);
    assert.ok(at >= 0, `${SHEET}: no rule \`${selector}\``);
    return source.slice(source.indexOf('{', at) + 1, source.indexOf('}', at));
  };
  const decl = (selector: string, prop: string, source = css) =>
    new RegExp(`(?:^|;)\\s*${prop}:\\s*([^;]+);`).exec(body(source, selector))?.[1].trim();

  // B1R2-FID-1. The badge is INSIDE the inline-start top corner of every tile (IMG_8482), 6px in
  // (inset from the padding edge, so never above or beside the tile), the same as a subtitle tile.
  assert.doesNotMatch(controls, /data-corner/);
  assert.doesNotMatch(css, /\.cm-check\[data-corner\]/, 'the badge is seated outside the tile again');
  const inset = px(decl('.cm-check', 'inset-inline-start') ?? 'NaN');
  assert.equal(px(decl('.cm-check', 'inset-block-start') ?? 'NaN'), inset);
  assert.ok(inset >= 0 && inset <= 8, `the badge sits ${inset}px from the tile corner`);
  const disc = 20; // size-5
  assert.match(controls, /className="cm-check absolute size-5 items-center justify-center rounded-full"/);
  const seat = inset + disc;
  // A one-line tile: the tile pads 12px (px-3) and 8px (py-2); its body pads the rest of the seat and
  // 2px more on BOTH inline sides, so every centred line ends 2px before the disc and the label stays
  // centred (B1R3-FID-2: at 14px a full line met the disc, 0px apart).
  assert.match(controls, /rounded-md px-3 py-2 [^`]*\$\{it\.subtitle \? 'gap-3 text-start' : '@container'\}/);
  assert.match(controls, /<span className="cm-tile-body flex min-w-0 flex-1 flex-wrap items-center gap-x-2 gap-y-1 text-center">/);
  const tilePadInline = 12;
  const tilePadBlock = 8;
  const clear = 2;
  const wide = px(decl('.cm-tile-body', 'padding-inline') ?? 'NaN');
  assert.ok(tilePadInline + wide >= seat + clear, `a one-line label may start ${tilePadInline + wide}px in, within ${clear}px of the ${seat}px badge seat`);
  // B1R3-FID-2. A word wider than the body (FDM «filament», 60.4px at 15/700, in a 47px body) keeps its
  // width (the title does not shrink under its longest word) and is centred SAFELY: it starts at the
  // body edge beside the seat and runs out at the inline end, where there is no badge. The
  // alignment is the component layer alone (a `justify-center` utility would outrank it), with plain
  // centring first for a browser without `safe`.
  const tileBody = body(css, '.cm-tile-body');
  assert.match(tileBody, /justify-content: center;\s*justify-content: safe center;/, 'a word wider than the body is centred into the badge');
  assert.match(controls, /<span className="text-\[15px\] font-bold leading-tight">\{it\.title\}<\/span>/, 'the title shrinks under its longest word again');
  // The body wraps (icon above the title, the title over two lines) instead of running under the disc.
  assert.equal(decl('.cm-tile-body', 'align-content'), 'center');
  // A narrow tile measures itself: under the threshold the body takes the whole width and starts
  // under the seat instead, so the words keep room and the first line still clears the disc by 2px
  // (the glyphs of a 15px line at leading-tight rise 1px above its box).
  // The one-line tile is the size container (`@container`, a utility the app already ships).
  assert.match(indexCss, /@import "tailwindcss"/, 'the app no longer ships the Tailwind utilities the tile relies on');
  const narrow = /@container \(width < (\d+)px\) \{\s*\.cm-tile-body \{([^}]*)\}/.exec(css);
  assert.ok(narrow, 'no narrow-tile rule');
  const threshold = Number(narrow![1]);
  const narrowDecl = (prop: string) => new RegExp(`(?:^|;)\\s*${prop}:\\s*([^;]+);`).exec(narrow![2])?.[1].trim();
  assert.equal(px(narrowDecl('padding-inline') ?? 'NaN'), 0);
  const glyphRise = 1;
  assert.ok(tilePadBlock + px(narrowDecl('padding-block-start') ?? 'NaN') - glyphRise >= seat + clear, 'a narrow tile starts its first line within 2px of the disc');
  // Above the threshold the seat leaves the words at least 40px (a longer word is centred safely);
  // a 375px phone (tiles of 100px, a 74px content box) keeps the centred label.
  assert.ok(threshold - 2 * wide >= 40, `a wide tile leaves its words ${threshold - 2 * wide}px`);
  assert.ok(threshold <= 74, 'a 375px phone loses the centred label');
  // Measured: the line that met the disc, as the fixture draws it (content box of the tile, width of
  // the word at 15/700 in Chromium): «دەزووی» at ckb 375, «filament» at en 390 and en 375. Where the
  // line starts, from the padding edge on the badge side, against the end of the badge (6 + 20).
  const cases: [string, number, number][] = [
    ['ckb 375 «دەزووی»', 74.3, 47.5],
    ['en 390 «filament»', 79.3, 60.4],
    ['en 375 «filament»', 74.3, 60.4],
  ];
  for (const [name, box, word] of cases) {
    assert.ok(box >= threshold, `${name}: the tile is narrow here, the case moved`);
    const room = box - 2 * wide;
    const start = tilePadInline + wide + Math.max(0, (room - word) / 2); // safe: never before the body edge
    assert.ok(start - seat >= clear, `${name}: the line starts ${(start - seat).toFixed(1)}px from the badge`);
  }

  // B1R2-FID-2. The glyph in a tile icon well is the primary ink (IMG_8474, IMG_8477); gold line
  // icons are the menu ListRow (IMG_8478). A chosen well takes the ink of the sand.
  assert.equal(decl('.cm-tile-icon', 'color'), 'var(--color-text-primary)');
  assert.match(css, /\[aria-checked='true'\] \.cm-sub,\s*\[aria-checked='true'\] > \.cm-tile-icon \{\s*color: inherit;/);
  assert.match(read('src/components/community/kit/display.tsx'), /text-gold/, 'the ListRow lost its gold icon');

  // B1R2-FID-3. The swatch: ringed in the field line (a black filament keeps an edge on the raised
  // row), and at the inline start, before the value (IMG_8482).
  assert.equal(decl('.cm-swatch', 'border'), '1.5px solid var(--clay-field)');
  assert.match(fields, /\{swatch && <span aria-hidden="true" className="cm-swatch size-6 shrink-0 rounded-full" style=\{\{ background: swatch \}\} \/>\}\s*<span className="min-w-0 flex-1 text-start">/);
  assert.doesNotMatch(fields, /cm-line size-6/);
  for (const theme of ['dark', 'light'] as const) {
    const v = V(theme);
    const ring = color(v['clay-field']);
    const row = color(v['color-surface-raised']);
    assert.ok(ratio(ring, row) >= 3, `${theme}: the swatch ring is ${ratio(ring, row).toFixed(2)}:1 on the row`);
    assert.ok(ratio(ring, color('#111111')) >= 3, `${theme}: the ring does not part a black filament from its edge`);
  }

  // B1R2-FID-4. The busy gold button: the spinner is drawn in the ink, its track a quarter of it.
  // The rule is UNLAYERED (outside @layer components), so it beats the spinner utilities.
  const spin = "[data-surface='community'] .cm-btn-gold .lv-spin";
  assert.equal(decl(spin, 'border-top-color'), 'var(--cm-gold-ink)');
  assert.equal(decl(spin, 'border-color'), 'color-mix(in oklab, var(--cm-gold-ink) 25%, transparent)');
  assert.ok(unlayered(scopeCss).includes(`${spin} {`), 'the spinner rule sits inside the components layer, under the utilities');
  const spinner = read('src/components/ui/Spinner.tsx');
  assert.match(spinner, /className=\{`lv-spin rounded-full border-gold\/25 border-t-gold /, 'the spinner no longer draws with lv-spin and the gold border utilities');
  assert.match(read('src/components/community/kit/buttons.tsx'), /\{busy \? <Spinner /);
  for (const theme of ['dark', 'light'] as const) {
    const v = V(theme);
    for (const stop of ['cm-gold-1', 'cm-gold-2']) {
      // A state indicator: 3:1 on both stops, also under the 0.93 brightness of the busy press.
      const fill = color(v[stop]).map((ch) => ch * 0.93);
      assert.ok(ratio(color(v['cm-gold-ink']), fill) >= 3, `${theme}: the busy spinner is ${ratio(color(v['cm-gold-ink']), fill).toFixed(2)}:1 on --${stop}`);
    }
  }

  // B1R2-REG-1. No word-internal apostrophe in an English comment of the scope sheet.
  const comments = (raw.match(/\/\*[\s\S]*?\*\//g) ?? []).join('\n');
  assert.deepEqual(comments.match(/\p{L}['\u2019]\p{L}/gu) ?? [], [], 'a community sheet has an apostrophe in a comment');
});

// ----------------------------------------------------------------------- i
test('i. the kit review, round 3: the chosen segmented label is never clipped on a phone', () => {
  const px = (v: string) => parseFloat(v) * (v.endsWith('rem') ? 16 : 1);
  const decls = (body: string) =>
    Object.fromEntries(
      body
        .split(';')
        .map((d) => d.trim())
        .filter(Boolean)
        .map((d) => [d.slice(0, d.indexOf(':')).trim(), d.slice(d.indexOf(':') + 1).trim()])
    );
  const ruleOf = (selector: string) => {
    const at = css.indexOf(`${selector} {`);
    assert.ok(at >= 0, `${SHEET}: no rule \`${selector}\``);
    return decls(css.slice(css.indexOf('{', at) + 1, css.indexOf('}', at)));
  };
  const option = "[data-surface='community'] .cm-seg > [role='radio']";
  const label = `${option} > span:last-child`;
  // B1R3-FID-1. Each option measures itself and the label wrapper holds the inline room, so the
  // room and the type can follow the width of ONE option (four across or two across alike).
  const base = ruleOf(option);
  assert.equal(base['container-type'], 'inline-size');
  assert.equal(px(base['padding-inline']), 0, 'the option pads its label itself again (px-2 left 54px of a 70px option)');
  assert.equal(px(ruleOf(label)['padding-inline']), 4);
  // The house control draws the label in its LAST span, truncated: the guard this keeps from firing.
  assert.match(read('src/components/ui/Segmented.tsx'), /<span className="truncate">\{it\.label\}<\/span>\s*\{it\.badge\}\s*<\/span>\s*<\/button>/);
  const steps = [...css.matchAll(/@container \(width < (\d+)px\) \{\s*([^{]+?)\s*\{([^}]*)\}\s*\}/g)]
    .filter((m) => m[2].trim() === label)
    .map((m) => ({ below: Number(m[1]), set: decls(m[3]) }));
  assert.ok(steps.length >= 2, 'the narrow-option steps are missing');
  const drawn = (width: number) => {
    let pad = px(ruleOf(label)['padding-inline']);
    let size = px(base['font-size']);
    for (const s of steps) {
      if (width >= s.below) continue;
      if (s.set['padding-inline']) pad = px(s.set['padding-inline']);
      if (s.set['font-size']) size = px(s.set['font-size']);
    }
    return { pad, size };
  };
  // Measured in the fixture (tests/browser/community-kit.html, Chromium): the width of one of the four
  // quality options, and the CHOSEN label at 14/700 (a width scales with the type size).
  const cases: [string, number, string, number][] = [
    ['en 390', 78, 'Standard', 62.3],
    ['en 375', 74.3, 'Standard', 62.3],
    ['en 360', 70.5, 'Standard', 62.3],
    ['en 320', 60.5, 'Standard', 62.3],
    ['ckb 320', 60.5, 'ستاندارد', 48.4],
    ['ar 320', 60.5, 'قياسية', 38.6],
  ];
  for (const [name, width, word, at14] of cases) {
    const { pad, size } = drawn(width);
    const need = (at14 * size) / 14;
    assert.ok(need <= width - 2 * pad - 0.5, `${name}: «${word}» needs ${need.toFixed(1)}px of ${(width - 2 * pad).toFixed(1)} (${size}px type, ${pad}px each side): clipped`);
    assert.ok(pad >= 2, `${name}: the label touches the thumb edge`);
  }
  // The reference phone and the common ones keep the 14px type; only a 320px phone steps down.
  for (const width of [78, 74.3, 70.5]) assert.equal(drawn(width).size, 14, `a ${width}px option lost its 14px label`);
  assert.ok(drawn(60.5).size >= 12, 'the label steps under 12px');
});

// ----------------------------------------------------------------------- j
test('j. the kit review, round 4: the tab underline (the tab less 16px), every held control at full ink, the forced-colours knob', () => {
  const ruleOf = (selector: string) => {
    const at = css.indexOf(`${selector} {`);
    assert.ok(at >= 0, `${SHEET}: no rule \`${selector}\``);
    return Object.fromEntries(
      css
        .slice(css.indexOf('{', at) + 1, css.indexOf('}', at))
        .split(';')
        .map((d) => d.trim())
        .filter(Boolean)
        .map((d) => [d.slice(0, d.indexOf(':')).trim(), d.slice(d.indexOf(':') + 1).trim()])
    );
  };

  // B1FIX-R3-FID-1 (was B1R4-FID-1). The underline is the chosen tab less 16px on each side
  // (tokens.md §6 #7): IMG_8468, IMG_8475 and IMG_8483 draw 146.5px under a 71px label in a tab of
  // about 178px at 390, neither the whole tab (the house indicator, `start-0 end-0`) nor the label plus
  // 24px. The kit draws its own line on the tab, still one travelling element per strip, and the house
  // one is not drawn.
  const controls = read('src/components/community/kit/controls.tsx');
  const tabs = read('src/components/ui/Tabs.tsx');
  assert.match(tabs, /className=\{`absolute bottom-0 start-0 end-0 h-0\.5 rounded-t-full \$\{indicatorClassName\}`\}/);
  assert.match(controls, /indicatorClassName="hidden"/, 'the house indicator (the whole tab) is drawn too');
  assert.match(controls, /\{t\.label\}\s*\{t\.badge\}\s*\{t\.id === value && \(\s*<motion\.span\s+layoutId=\{`cm-tab-line-\$\{group\}`\}/);
  assert.match(controls, /transition=\{m\.reduced \? \{ duration: 0 \} : m\.spring\('move'\)\}/, 'the line no longer travels, or no longer jumps under reduced motion');
  // On the tab: 16px in from each edge (`inset-x-4`, a utility the app already ships), on its bottom
  // edge, 3px, round ends, gold. The house span around the label is not positioned and the tab is, so
  // the tab is the box the line is placed in; nothing measures the words any more.
  assert.match(controls, /className="cm-tab-line absolute inset-x-4 bottom-0 h-\[3px\] rounded-full bg-gold"/);
  assert.match(tabs, /const classes = `relative \$\{fill \? 'flex-1 px-2'/, 'the house tab is no longer the positioned box of the line');
  assert.match(tabs, /<span className="inline-flex items-center gap-1\.5">\s*\{t\.label\}/, 'the house span changed: re-check that the tab places the line');
  assert.doesNotMatch(controls, /UnderlineLabel|--cm-tab-left|--cm-tab-right|useLayoutEffect/, 'the tabs still measure their words');
  assert.doesNotMatch(controls, /\bfill=\{/, 'a strip is drawn at natural width: the line would no longer be its tab less 16px');
  assert.match(controls, /export type UnderlineTabsProps = Omit<TabStripProps, 'indicatorClassName' \| 'activeClassName' \| 'idleClassName' \| 'fill'>;/, 'the strip may be drawn at natural width');
  assert.doesNotMatch(css, /\.cm-tab-line \{/, 'the sheet restates what the utilities of the line say');
  assert.doesNotMatch(css, /\.cm-tab-label\b/, 'the label box of the measured line is back');
  // The tab keeps the house block padding (`py-3`), so its bottom edge is the baseline of the strip, and
  // its 12px of inline room, so a label wraps where it did. It centres its words; when the other label
  // wraps, both tabs grow (a flex row stretches them), and the line sits on the bottom edge of each, so
  // it stays on the baseline and does not hop as it travels.
  const tab = ruleOf("[data-surface='community'] .cm-tabs [data-tab]");
  assert.equal(tab['padding-block'], undefined, 'the tab drops the house block padding');
  assert.equal(tab['padding-inline'], '12px');
  assert.equal(tab['display'], 'flex');
  assert.equal(tab['align-items'], 'center');
  assert.equal(tab['justify-content'], 'center');
  assert.doesNotMatch(css, /\[data-tab\] > span/, 'the scope restyles the house span again');
  assert.doesNotMatch(css, /\[data-tab-indicator\]\s*\{/, 'the scope still restyles the house indicator');

  // B1R4-A11Y-1. Nothing in the scope dims on press: the house rule (0.72 in the base layer, and
  // !important under reduced motion) took a held link, tab, thumb, select, tile, row and drop zone
  // line under 4.5:1. Both rules cover every control the house dims, in both motion settings.
  const pressables = ['button', '[role="button"]', '[role="tab"]', 'a[href]'];
  const houseBase = /@layer base \{[\s\S]*?button:not\(:disabled\):not\(\[aria-disabled="true"\]\):active,\s*summary:active,\s*\[role="button"\]:not\(\[aria-disabled="true"\]\):active,\s*\[role="tab"\]:not\(\[aria-disabled="true"\]\):active,\s*a\[href\]:active,\s*label\[for\]:active \{\s*opacity: 0\.72;/;
  assert.match(indexCss, houseBase, 'the house press dim moved: re-check the scope rule against it');
  const held = /@layer components \{\s*\[data-surface='community'\] :is\(([^)]*)\):not\(:disabled, \[aria-disabled='true'\]\):active \{\s*opacity: 1;\s*\}\s*\}/.exec(css);
  assert.ok(held, 'a held control in the scope is dimmed to 0.72 (no full-ink rule over the base layer)');
  const heldReduced = /@media \(prefers-reduced-motion: reduce\) \{\s*\[data-surface='community'\] :is\(([^)]*)\):not\(:disabled, \[aria-disabled='true'\], \[class\^='opacity-'\], \[class\*=' opacity-'\]\):active \{\s*opacity: 1 !important;\s*\}\s*\}/.exec(css);
  assert.ok(heldReduced, 'a held control in the scope is dimmed to 0.72 under reduced motion');
  for (const list of [held![1], heldReduced![1]]) {
    const covered = list.split(',').map((x) => x.trim().replace(/'/g, '"'));
    for (const p of [...pressables, 'summary', 'label[for]']) assert.ok(covered.includes(p), `${p} still dims when held in the scope`);
  }
  // The pairs a held label keeps at full ink (test d holds every ink on every ground): the link and
  // the chosen tab in gold, the idle tab, a select value or a subtitle on the hover fill, a row line,
  // a thumb label on the track, the drop zone line in the well. Dimmed to 0.72 over the same ground,
  // some of them fall under 4.5:1 in each theme, which is what the rules above prevent.
  for (const theme of ['dark', 'light'] as const) {
    const v = V(theme);
    const c = (name: string) => color(v[name]);
    const dimmedUnder: string[] = [];
    for (const [ink, ground] of [
      ['color-gold', 'color-canvas'],
      ['color-gold', 'color-surface'],
      ['color-text-secondary', 'color-canvas'],
      ['color-text-muted', 'color-surface-selected'],
      ['color-text-muted', 'color-surface-raised'],
      ['color-text-secondary', 'cm-track'],
      ['color-text-muted', 'clay-well-bg'],
    ]) {
      const r = ratio(c(ink), c(ground));
      assert.ok(r >= 4.5, `${theme}: a held --${ink} on --${ground} reads ${r.toFixed(2)}:1`);
      const dimmed = ratio(over(c(ink), 0.72, c(ground)), c(ground));
      if (dimmed < 4.5) dimmedUnder.push(`--${ink} on --${ground} ${dimmed.toFixed(2)}:1`);
    }
    assert.ok(dimmedUnder.length > 0, `${theme}: no pair falls under 4.5:1 when dimmed; the full-ink rule is no longer load-bearing`);
  }

  // B1R4-A11Y-2. Forced colours turn the scoped knob ink into Canvas: the ON knob vanished. The house
  // knob there is Highlight when ON, and the scope says so again, at the specificity that hid it.
  assert.match(indexCss, /\[role='switch'\]\[aria-checked='true'\] span:not\(:has\(span\)\) \{\s*background: Highlight;/);
  const forcedBars = /@media \(forced-colors: active\) \{[^@]*?\s([^{}]*)\{\s*background: Highlight;\s*\}/.exec(scopeCss);
  assert.ok(forcedBars, 'nothing comes back in Highlight under forced colours');
  assert.ok(selectorParts(forcedBars![1]).includes("[data-surface='community'] .cm-switch [data-switch='on'] > span > span"), 'the ON knob is not Highlight under forced colours');
  assert.ok(scopeCss.indexOf('@media (forced-colors: active)') > scopeCss.indexOf("[data-surface='community'] .cm-switch [data-switch='on'] > span > span {"), 'the forced-colours knob comes before the rule it overrides');
});

// ----------------------------------------------------------------------- k
test('k. the fix round: the forced-colours selection cue, the tab label filling its tab', () => {
  // B1FIX-R1-REG-1 moved the looks of the kit controls into sheets beside their modules; round 2 folded
  // them back into the one sheet (test l), because the split only postponed their cost.
  // Nothing the scope root imports pulls the kit modules onto every page.
  for (const f of ['src/components/community/CommunitySurface.tsx', 'src/components/community/scopePortals.ts', 'src/components/community/FilterChip.tsx']) {
    assert.doesNotMatch(read(f), /from '\.\/kit\//, `${f} pulls the kit onto every community page`);
  }

  // B1FIX-R1-A11Y-1. Forced colours drop every background and shadow: the well, the dimple and the
  // gold bar of the current ListRow, and the sand of a current or chosen `.cm-sel` (the section chip
  // of plan R3), so the current one read like every other. The house cue (src/index.css): the line
  // and a 1px outline in Highlight, then the focus line in CanvasText after it.
  assert.match(indexCss, /\.lv-choice:is\(\[aria-pressed='true'\], \[aria-checked='true'\], \[data-selected='true'\]\),\s*\[aria-current='page'\]\[data-clay-dimple\] \{\s*border-color: Highlight;\s*outline: 1px solid Highlight;/);
  const forced = /@media \(forced-colors: active\) \{\s*\[data-surface='community'\] :is\(([^{]*)\) \{\s*border-color: Highlight;\s*outline: 1px solid Highlight;\s*\}\s*\[data-surface='community'\] \.cm-row\[aria-current='page'\]::before,[^{]*\{\s*background: Highlight;\s*\}\s*\[data-surface='community'\] :is\(\.cm-row, \.cm-sel\):focus-visible,\s*\[data-surface='community'\] :focus-visible > \.cm-sel \{\s*outline: 2px solid CanvasText;\s*\}\s*\}/.exec(scopeCss);
  assert.ok(forced, 'the current row and the selection lose their cue under forced colours');
  const cued = selectorParts(forced![1]);
  assert.ok(cued.includes(".cm-row[aria-current='page']"), 'the current ListRow has no forced-colours cue');
  // Every state the D-3 recipe paints, on the control and through its parent.
  const d3 = /\.cm-sel:is\(([^)]*)\),\s*:is\(([^)]*)\) > \.cm-sel \{\s*color: var\(--cm-sel-ink\);/.exec(scopeCss);
  assert.ok(d3, 'the D-3 selection rule moved: re-check the forced-colours cue against it');
  assert.ok(cued.includes(`.cm-sel:is(${d3![1]})`), 'a state the sand paints has no forced-colours cue on the control');
  assert.ok(cued.includes(`:is(${d3![2]}) > .cm-sel`), 'a state the sand paints has no forced-colours cue through its parent');
  // After the scope focus line, so the CanvasText focus (as in the house) wins over it and over the cue.
  assert.ok(scopeCss.indexOf(forced![0]) > scopeCss.indexOf("[data-surface='community'] :focus-visible > .cm-sel {"), 'the forced-colours block comes before the focus line it restates');
});

// ----------------------------------------------------------------------- l
test('l. the fix round 2: the whole kit draws from one sheet, and the chosen tab keeps its line under forced colours', () => {
  // B1FIX-R2-REG-1. The kit sheets beside their modules only postponed the cost: once a page used the
  // kit, the scope sheet and the kit sheets gzipped 338 B more than one sheet (each restated the layer
  // order and compressed alone), and public CSS read 61,383 of 61,440 B. Every look of the kit is in
  // the one sheet; no community module brings a sheet of its own (test a); the layer order is stated
  // once; tests/bundleBudget.test.ts counts the sheet, and any community sheet a build does not carry.
  const kitDir = join(ROOT, 'src/components/community');
  const sheets = (readdirSync(kitDir, { recursive: true }) as string[]).filter((f) => f.endsWith('.css'));
  assert.deepEqual(sheets, [], `a community stylesheet beside its module: ${sheets.join(', ')}`);
  for (const m of ['controls', 'display', 'fields', 'buttons']) assert.doesNotMatch(read(`src/components/community/kit/${m}.tsx`), /import '[^']*\.css'/, `kit/${m}.tsx imports a stylesheet`);
  for (const looks of [
    /\[data-surface='community'\] \.cm-tabs \[data-tab\] \{/,
    /\[data-surface='community'\] \.cm-switch \[data-switch='on'\] > span \{/,
    /\[data-surface='community'\] \.cm-stepper \.lv-well > button \{/,
    /\[data-surface='community'\] \.cm-seg \[data-segmented-indicator\] \{/,
    /\.cm-tile-body \{/,
    /\[aria-checked='true'\] > \.cm-tile-icon \{/,
    /\.cm-dock \{/,
    /\.cm-drop\[data-over\] \{/,
    /\.cm-drop-zone \{/,
  ]) assert.match(scopeCss, looks, `${SHEET} lost a look of the kit: ${looks}`);
  assert.equal((scopeCss.match(/@layer theme, base, components, utilities;/g) ?? []).length, 1, 'the layer order is stated more than once');
  assert.equal((scopeCss.match(/@media \(forced-colors: active\)/g) ?? []).length, 1, 'the forced-colours cues are split over several blocks');
  // No rule restates what the house control or a shipped utility already says. The track keeps the
  // 4px gap of the house (`gap-1`); the baseline of the strip and the line are utilities
  // (`border-b border-border-subtle`; `absolute inset-x-4 bottom-0 h-[3px] rounded-full bg-gold`, on
  // the tab since B1FIX-R3-FID-1, test j); a one-line tile is `@container`; the icon well takes its
  // 12px from the shared radius rule.
  const controls = read('src/components/community/kit/controls.tsx');
  assert.match(read('src/components/ui/Segmented.tsx'), /\? 'h-9 box-border gap-0\.5 p-0\.5' : 'gap-1 p-1'/, 'the house track gap changed: re-check the scope track');
  const track = /\[data-surface='community'\] \.cm-seg \{([^}]*)\}/.exec(scopeCss);
  assert.ok(track, 'the sand track is gone');
  assert.doesNotMatch(track![1], /(?:^|;)\s*gap:/, 'the track restates the house gap');
  assert.doesNotMatch(scopeCss, /\.cm-tabs \{|\.cm-tile-one\b/, 'a rule restates a shipped utility');
  assert.match(controls, /className=\{`cm-tabs border-b border-border-subtle \$\{className\}`\}/);
  assert.match(scopeCss, /\.lv-button\.cm-btn-compact,\s*\.cm-chip,\s*\.cm-tile-icon,\s*\.cm-media \{\s*border-radius: 12px;/);

  // B1FIX-R2-A11Y-1. Forced colours drew the underline of the chosen tab in Canvas: it vanished and the
  // weight of the label was the only cue left. It comes back in Highlight, with the row bar and the ON
  // knob; the line is gold through a utility, so the unlayered forced rule always wins over it.
  const forced = /@media \(forced-colors: active\) \{[^@]*?\s([^{}]*)\{\s*background: Highlight;\s*\}/.exec(scopeCss);
  assert.ok(forced, 'nothing comes back in Highlight under forced colours');
  const back = selectorParts(forced![1]);
  assert.ok(back.includes("[data-surface='community'] .cm-tab-line"), 'the chosen tab line is Canvas under forced colours');
  assert.ok(back.includes("[data-surface='community'] .cm-row[aria-current='page']::before"), 'the current row bar lost its Highlight');
  assert.match(controls, /className="cm-tab-line [^"]*\bbg-gold\b/);
  assert.doesNotMatch(unlayered(scopeCss).slice(0, unlayered(scopeCss).indexOf('@media (forced-colors: active)')), /\.cm-tab-line \{[^}]*background/, 'a scope rule paints the line after all, and may outrank the forced one');
});
