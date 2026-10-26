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
 *     shell Toaster copies the stamp of the scope root on screen;
 *  d. every text and boundary pair of the scope meets WCAG AA in both
 *     themes, computed from the CSS values themselves;
 *  e. D-2 and D-3 as the owner overrode them: the primary is the sand-gold
 *     gradient with ink text, a selection the solid sand fill with ink text
 *     and a non-colour cue, both inside the scope only;
 *  f. the kit words exist in Arabic, English and Sorani, and no Sorani value
 *     is the Arabic copied (row 183).
 *
 * Run: node --import tsx --test tests/communityScope.test.ts
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { BEGIN, END, buildBlock, contrast, parseColor } from '../scripts/theme-tokens.mjs';
import { KIT_STRINGS } from '../src/components/community/kit/strings';

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
test('c. Overlay and Anchored stamp the scope on their portal roots; the Toaster copies the root on screen', () => {
  const overlay = read('src/components/ui/Overlay.tsx');
  assert.match(overlay, /export const SurfaceContext = createContext<SurfaceStamp \| null>\(null\);/);
  assert.equal((overlay.match(/const surface = useContext\(SurfaceContext\);/g) ?? []).length, 2, 'Overlay and Anchored each read the scope');
  assert.match(overlay, /data-overlay=\{testId \?\? true\}\s*data-overlay-mode=\{mode\}\s*\{\.\.\.surface\}/, 'the window layer is not stamped');
  assert.match(overlay, /data-anchored=\{testId \?\? true\}\s*\{\.\.\.surface\}/, 'the anchored menu is not stamped');
  // Both portal roots render into <body>, so the stamp is what carries the scope.
  assert.equal((overlay.match(/document\.body\s*\)/g) ?? []).length, 2);
  const toast = read('src/components/ui/Toast.tsx');
  assert.match(toast, /document\.querySelector\('\.cm-surface'\)/);
  assert.match(toast, /data-toaster\s*\{\.\.\.surface\}/);
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
    // Text: the three inks on every ground; the gold ink (links, the active tab) on every ground.
    for (const ink of ['color-text-primary', 'color-text-secondary', 'color-text-muted', 'color-gold']) {
      for (const [g, rgb] of grounds) need(`${theme} --${ink} on ${g}`, ratio(c(ink), rgb), 4.5);
    }
    // The danger ink sits on the page, a card or a raised control (the trash key), never on a selected fill.
    for (const [g, rgb] of grounds.slice(0, 5)) need(`${theme} --color-danger on ${g}`, ratio(c('color-danger'), rgb), 4.5);
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
    need(`${theme} like colour on the card`, ratio(c('cm-like'), card), 3);
    need(`${theme} step on vs the canvas`, ratio(c('cm-step-on'), canvas), 3);
    need(`${theme} switch knob on the sand`, ratio(c('cm-sel-ink'), c('cm-sel-bg')), 3);
  }
  assert.deepEqual(failures, [], `contrast under the floor:\n${failures.join('\n')}`);
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
  assert.match(css, /\[aria-checked='true'\] > \.cm-check \{\s*display: inline-flex;/);
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
