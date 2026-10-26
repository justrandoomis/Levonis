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
 *  c. Overlay and Anchored stamp the scope on their portal roots, and the
 *     shell Toaster wears the stamp the scope root publishes to the toast
 *     store (so a toast follows a theme switch and drops the stamp when the
 *     scope leaves);
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
 *     apostrophe in an English comment of the scope sheet.
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
import { publishToastSurface, subscribeToastSurface, toastSurface, type ToastSurface } from '../src/lib/toastStore';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (p: string) => readFileSync(join(ROOT, p), 'utf8');
const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, '');
const SHEET = 'src/styles/community.css';
const css = strip(read(SHEET));
const indexCss = read('src/index.css');

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
const common = rule(css, "[data-surface='community']");
const scoped: Record<Theme, Record<string, string>> = {
  dark: rule(css, "[data-surface='community'][data-theme='dark']"),
  light: rule(css, "[data-surface='community'][data-theme='light']"),
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
    assert.match(css, new RegExp(`(^|\\n)${selector.replace(/[[\]]/g, '\\$&')} \\{`), `${theme}: the scope block is missing`);
    assert.ok(Object.keys(scoped[theme]).length > 10, `${theme}: the scope block is empty`);
  }
  // Every top-level rule of the sheet (the tokens and the re-skins, outside the
  // components layer, whose `cm-` classes exist only in community markup) is under the scope.
  const layer = css.indexOf('@layer components {');
  let depth = 0;
  let end = layer;
  for (let i = css.indexOf('{', layer); i < css.length; i++) {
    if (css[i] === '{') depth++;
    else if (css[i] === '}' && --depth === 0) {
      end = i + 1;
      break;
    }
  }
  const topLevel = css.slice(0, layer) + css.slice(end);
  for (const m of topLevel.matchAll(/(^|\n)([^@\n{}][^{}]*)\{/g)) {
    const selector = m[2].trim();
    if (!selector.startsWith('[')) continue;
    assert.match(selector, /^\[data-surface='community'\]/, `${SHEET}: a rule outside the scope: ${selector}`);
  }
  assert.doesNotMatch(css, /:root\s*\{|(^|\n)html\b|(^|[\s,])\[data-theme(=[^\]]*)?\]\s*\{/, `${SHEET} restyles something outside the scope`);
  // The generated block is untouched by the scope, and index.css carries no scope at all.
  const inside = indexCss.slice(indexCss.indexOf(BEGIN), indexCss.indexOf(END));
  assert.doesNotMatch(inside, /data-surface/, 'the scope leaked into the generated THEME TOKENS block');
  assert.doesNotMatch(strip(indexCss), /data-surface|\.cm-[a-z]/, 'src/index.css carries community scope rules (they belong in the lazy sheet)');
  // The layer order is stated again, so a sheet parsed first never ranks components under the preflight.
  assert.match(css, /@layer theme, base, components, utilities;/);
  // Only CommunitySurface imports the sheet, and only community page modules import CommunitySurface.
  const sources = (readdirSync(join(ROOT, 'src'), { recursive: true }) as string[]).filter((f) => /\.tsx?$/.test(f)).map((f) => `src/${f.split('\\').join('/')}`);
  const importers = (needle: RegExp) => sources.filter((f) => needle.test(read(f))).sort();
  assert.deepEqual(importers(/import '[./]*styles\/community\.css'/), ['src/components/community/CommunitySurface.tsx']);
  const roots = [
    'src/pages/Community.tsx',
    'src/pages/Requests.tsx',
    'src/pages/community/Creator.tsx',
    'src/pages/community/Project.tsx',
    'src/pages/community/ProjectComposer.tsx',
    'src/pages/community/Projects.tsx',
    'src/pages/community/Request.tsx',
    'src/pages/community/Saved.tsx',
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
  assert.match(root, /'data-surface': 'community', 'data-theme': theme/);
  assert.match(root, /const \{ theme \} = useTheme\(\);/);
  assert.match(root, /<SurfaceContext\.Provider value=\{stamp\}>\s*<div \{\.\.\.stamp\} className=\{`cm-surface /);
  assert.match(root, /import '\.\.\/\.\.\/styles\/community\.css';/);
});

// ----------------------------------------------------------------------- c
test('c. Overlay and Anchored stamp the scope on their portal roots; the Toaster wears the stamp the scope root publishes', () => {
  const overlay = read('src/components/ui/Overlay.tsx');
  assert.match(overlay, /export const SurfaceContext = createContext<SurfaceStamp \| null>\(null\);/);
  assert.equal((overlay.match(/const surface = useContext\(SurfaceContext\);/g) ?? []).length, 2, 'Overlay and Anchored each read the scope');
  assert.match(overlay, /data-overlay=\{testId \?\? true\}\s*data-overlay-mode=\{mode\}\s*\{\.\.\.surface\}/, 'the window layer is not stamped');
  assert.match(overlay, /data-anchored=\{testId \?\? true\}\s*\{\.\.\.surface\}/, 'the anchored menu is not stamped');
  // Both portal roots render into <body>, so the stamp is what carries the scope.
  assert.equal((overlay.match(/document\.body\s*\)/g) ?? []).length, 2);
  const toast = read('src/components/ui/Toast.tsx');
  // Read from React state, never from the DOM while rendering: a stamp copied at
  // render time kept the old theme after a switch until the queue changed.
  assert.doesNotMatch(strip(toast), /querySelector\(['"]\.cm-surface/, 'the Toaster copies the scope stamp from the DOM');
  assert.match(toast, /const surface = useSyncExternalStore\(subscribeToastSurface, toastSurface, \(\) => null\);/);
  assert.match(toast, /data-toaster\s*\{\.\.\.surface\}/);
  // The scope root publishes its stamp on mount and on every theme switch, and withdraws it on unmount.
  assert.match(read('src/components/community/CommunitySurface.tsx'), /useLayoutEffect\(\(\) => publishToastSurface\(stamp\), \[stamp\]\);/);
});

test('c2. the toast stamp follows the scope: published on mount, replaced on a theme switch, withdrawn when the scope leaves', () => {
  const seen: Array<string | null> = [];
  const stop = subscribeToastSurface(() => seen.push(toastSurface()?.['data-theme'] ?? null));
  assert.equal(toastSurface(), null, 'a stamp outside every scope');
  const dark: ToastSurface = { 'data-surface': 'community', 'data-theme': 'dark' };
  const light: ToastSurface = { 'data-surface': 'community', 'data-theme': 'light' };
  const withdrawDark = publishToastSurface(dark);
  assert.equal(toastSurface(), dark);
  // A theme switch: React runs the cleanup of the old stamp, then publishes the new one.
  withdrawDark();
  const withdrawLight = publishToastSurface(light);
  assert.equal(toastSurface(), light, 'the toast kept the old theme after a switch');
  // Two scope roots during a route change: the newest wins, and the other leaving keeps it.
  const next: ToastSurface = { 'data-surface': 'community', 'data-theme': 'light' };
  const withdrawNext = publishToastSurface(next);
  withdrawLight();
  assert.equal(toastSurface(), next);
  withdrawNext();
  assert.equal(toastSurface(), null, 'the stamp outlived the scope');
  assert.deepEqual(seen, ['dark', null, 'light', 'light', 'light', null]);
  stop();
});

// ----------------------------------------------------------------------- d
test('d. every scoped text and boundary pair meets WCAG AA in both themes (computed from the CSS values)', () => {
  const failures: string[] = [];
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
    for (const [g, rgb] of grounds) need(`${theme} focus ring on ${g}`, ratio(c('color-focus'), rgb), 3);
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
  }
  assert.deepEqual(failures, [], `contrast under the floor:\n${failures.join('\n')}`);
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
  assert.match(css, /\[aria-checked='true'\] > \.cm-check,\s*\.cm-media\[data-selected\] > \.cm-check \{\s*display: inline-flex;/);
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
  assert.match(css, /\.cm-media\[data-selected\] > \.cm-check \{\s*display: inline-flex;/);
  assert.match(display, /\{selected && \(\s*<>\s*<span className="sr-only">\{s\.cover\}<\/span>\s*<span aria-hidden="true" className="cm-check /);
  for (const lang of ['ar', 'en', 'ckb'] as const) assert.ok(KIT_STRINGS[lang].cover, `${lang}: no cover word`);

  // A11Y-5. The filter options are radio items, the chosen one checked (the word «محدد» stays visible).
  const menu = read('src/components/ui/Menu.tsx');
  assert.match(menu, /\.\.\.\(entry\.checked === undefined \? null : \{ role: 'menuitemradio', 'aria-checked': entry\.checked \}\)/);
  assert.match(controls, /checked: o\.id === value,\s*hint: o\.id === value \? s\.selected : undefined,/);
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
  // A one-line tile: the tile pads 12px (px-3) and 8px (py-2); its body pads the rest of the seat on
  // BOTH inline sides, so every centred line ends before the disc and the label stays centred.
  assert.match(controls, /rounded-md px-3 py-2 [^`]*\$\{it\.subtitle \? 'gap-3 text-start' : 'cm-tile-one'\}/);
  assert.match(controls, /<span className="cm-tile-body flex min-w-0 flex-1 flex-wrap items-center justify-center [^"]*text-center">/);
  const tilePadInline = 12;
  const tilePadBlock = 8;
  const wide = px(decl('.cm-tile-body', 'padding-inline') ?? 'NaN');
  assert.ok(tilePadInline + wide >= seat, `a one-line label may start ${tilePadInline + wide}px in, under the ${seat}px badge seat`);
  // The body wraps (icon above the title, the title over two lines) instead of running under the disc.
  assert.equal(decl('.cm-tile-body', 'align-content'), 'center');
  // A narrow tile measures itself: under the threshold the body takes the whole width and starts
  // under the seat instead, so the words keep room and the first line still clears the disc.
  assert.equal(decl('.cm-tile-one', 'container-type'), 'inline-size');
  const narrow = /@container \(width < (\d+)px\) \{\s*\.cm-tile-body \{([^}]*)\}/.exec(css);
  assert.ok(narrow, 'no narrow-tile rule');
  const threshold = Number(narrow![1]);
  const narrowDecl = (prop: string) => new RegExp(`(?:^|;)\\s*${prop}:\\s*([^;]+);`).exec(narrow![2])?.[1].trim();
  assert.equal(px(narrowDecl('padding-inline') ?? 'NaN'), 0);
  assert.ok(tilePadBlock + px(narrowDecl('padding-block-start') ?? 'NaN') >= seat, 'a narrow tile starts its first line beside the disc');
  // Above the threshold the seat leaves the words at least 44px (a 15/700 word such as «متأكدًا»);
  // a 375px phone (tiles of 100px, a 74px content box) keeps the centred label.
  assert.ok(threshold - 2 * wide >= 44, `a wide tile leaves its words ${threshold - 2 * wide}px`);
  assert.ok(threshold <= 74, 'a 375px phone loses the centred label');

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
  const layerAt = css.indexOf('@layer components {');
  let depth = 0;
  let layerEnd = -1;
  for (let i = css.indexOf('{', layerAt); i < css.length && layerEnd < 0; i++) {
    if (css[i] === '{') depth++;
    else if (css[i] === '}' && --depth === 0) layerEnd = i;
  }
  assert.ok(css.indexOf(`${spin} {`) > layerEnd && layerEnd > layerAt, 'the spinner rule sits inside the components layer, under the utilities');
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
  assert.deepEqual(comments.match(/\p{L}['\u2019]\p{L}/gu) ?? [], [], `${SHEET}: an apostrophe in a comment`);
});
