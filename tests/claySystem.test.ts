/**
 * «LAYERED CLAY» — the elevation system of both themes (docs/DECISIONS.md
 * row 207).
 *
 * One light source above the screen. A surface is clay at one of a few levels
 * (flush, resting, lifted, slab, dock), or it is sunk (a well, a press), and
 * higher means lighter. The COLOURS of that light are per-theme primitives
 * written by scripts/theme-tokens.mjs (`--clay-rim`, `--clay-ambient` …); the
 * GEOMETRY is one hand-written rule in src/index.css (CLAY ELEVATION) that
 * composes them into `--clay-0 … --clay-dock`; Tailwind's shadow names map
 * onto those in @theme. This file holds the parts that are easy to break and
 * hard to see:
 *
 *  1. the composites are declared on every themed element (a dark island and
 *     every merchant storefront re-resolve their own colours), read only
 *     primitives BOTH themes define, and stay cheap to paint — at most four
 *     layers and two blurred ones, and ONE blurred layer on a resting card,
 *     which is what a list of forty product cards repaints while it scrolls;
 *  2. every shadow name in @theme is a clay composite (no black shadow on
 *     cream can come back through a utility);
 *  3. the Tier-1 surfaces write their shadow into `--tw-shadow`, so a ring
 *     utility on the same element composes with it instead of erasing it;
 *  4. the contrast of the final set (build plan §3.9), recomputed here with
 *     the generator's own contrast(): 4.5:1 for text, 3:1 for boundaries;
 *  5. solid clay, not glass (row 208): nothing blurs what is behind it, no
 *     filter glow, and no shadow colour or shadow token is hand-written into
 *     a class string, where it would bypass the per-theme clay primitives.
 *
 * Run: node --import tsx --test tests/claySystem.test.ts
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildBlock, contrast, parseColor, rgbToOklch, SEMANTIC, FIXED, IVORY, PAPER } from '../scripts/theme-tokens.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (p: string) => readFileSync(join(ROOT, p), 'utf8');
const stripCssComments = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, '');
const css = stripCssComments(read('src/index.css'));

type Theme = 'light' | 'dark';
type Rgb = number[];

// ------------------------------------------------------------------ parsing
const block = buildBlock();
const blockPart: Record<Theme, string> = {
  light: block.slice(block.indexOf("[data-theme='light']"), block.indexOf("[data-theme='dark']")),
  dark: block.slice(block.indexOf("[data-theme='dark']")),
};
/** Every `--name:value` of one theme's generated block. */
function vars(theme: Theme): Record<string, string> {
  return Object.fromEntries([...blockPart[theme].matchAll(/--([a-z0-9-]+):([^;}]+)/g)].map((m) => [m[1], m[2].trim()]));
}
const V: Record<Theme, Record<string, string>> = { light: vars('light'), dark: vars('dark') };
const clayPrimitives = (theme: Theme) => Object.keys(V[theme]).filter((k) => k.startsWith('clay-')).map((k) => k.slice(5));

/** The hand-written composite rule, and its declarations by name. */
const compositeRule = css.match(/(^|\n)\[data-theme\],\s*\[data-store-theme\]\s*\{([^}]*)\}/);
const composites: Record<string, string> = Object.fromEntries(
  (compositeRule?.[2] ?? '')
    .split(';')
    .map((d) => d.trim())
    .filter((d) => d.startsWith('--clay-'))
    .map((d) => {
      const i = d.indexOf(':');
      return [d.slice(7, i).trim(), d.slice(i + 1).replace(/\s+/g, ' ').trim()];
    })
);

/** A composite expanded into its single shadow layers (nested composites inlined). */
function layers(name: string, seen: string[] = []): string[] {
  assert.ok(!seen.includes(name), `--clay-${name} refers to itself`);
  const value = composites[name];
  assert.ok(value, `--clay-${name} is not a composite`);
  return value.split(',').flatMap((part) => {
    const p = part.trim();
    const ref = p.match(/^var\(--clay-([a-z0-9-]+)\)$/);
    return ref && composites[ref[1]] ? layers(ref[1], [...seen, name]) : [p];
  });
}
/** A layer is blurred when its third length (the blur radius) is not zero. */
function isBlurred(layer: string): boolean {
  const lengths = layer
    .replace(/var\([^)]*\)/g, '')
    .replace(/\binset\b/, '')
    .trim()
    .split(/\s+/)
    .filter(Boolean);
  return lengths.length >= 3 && parseFloat(lengths[2]) !== 0;
}

// ---------------------------------------------------------------- colour math
const T = (name: string, theme: Theme): string => {
  const pair = SEMANTIC[name];
  assert.ok(pair, `no semantic slot ${name}`);
  return pair[theme === 'dark' ? 0 : 1];
};
const P = (c: string | Rgb): Rgb => (typeof c === 'string' ? parseColor(c) : c);
const ratio = (a: string | Rgb, b: string | Rgb) => contrast(P(a), P(b));
const lightness = (c: string | Rgb) => rgbToOklch(P(c))[0];
/** rgb(r g b/a) painted over an opaque ground, as the browser composites it. */
function over(rgba: string, ground: string | Rgb): Rgb {
  const m = rgba.match(/^rgb\((\d+) (\d+) (\d+)\/([.\d]+)\)$/);
  assert.ok(m, `${rgba} is not rgb(r g b/a)`);
  const [r, g, b, a] = m!.slice(1).map(Number);
  const base = P(ground);
  return [r / 255, g / 255, b / 255].map((c, i) => c * a + base[i] * (1 - a));
}
// color-mix(in oklab, a p, b) for opaque colours.
const toLin = (v: number) => (v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);
const toGamma = (v: number) => (v <= 0.0031308 ? 12.92 * v : 1.055 * v ** (1 / 2.4) - 0.055);
function oklab(c: string | Rgb): number[] {
  const [r, g, b] = P(c).map(toLin);
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
  return [0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s, 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s, 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s];
}
function fromOklab([L, a, b]: number[]): Rgb {
  const l = (L + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const m = (L - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const s = (L - 0.0894841775 * a - 1.291485548 * b) ** 3;
  return [
    4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
    -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
    -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s,
  ].map((v) => Math.min(1, Math.max(0, toGamma(Math.max(0, v)))));
}
const mix = (a: string, p: number, b: string): Rgb => {
  const A = oklab(a);
  const B = oklab(b);
  return fromOklab(A.map((v, i) => v * p + B[i] * (1 - p)));
};

// ---------------------------------------------------------------------- 1
test('the composites are declared on every themed element, read primitives both themes define, and stay cheap to paint', () => {
  assert.ok(compositeRule, 'the CLAY ELEVATION rule `[data-theme],[data-store-theme]{…}` is missing from src/index.css');
  // Not on :root, and not in @theme (whose variables Tailwind emits on :root):
  // a composite resolves where it is declared, so on :root a dark island or a
  // merchant storefront would draw the page theme's colours.
  assert.doesNotMatch(css, /:root\s*\{[^}]*--clay-[a-z0-9-]+\s*:/, 'a clay composite is declared on :root');
  for (const m of css.matchAll(/@theme\s*\{([^}]*)\}/g)) {
    assert.doesNotMatch(m[1], /--clay-[a-z0-9-]+\s*:/, 'a clay variable is declared in @theme');
  }
  const expected = ['0', 'lift', '1', '2', '3', 'dock', 'press', 'well'];
  assert.deepEqual(Object.keys(composites).sort(), [...expected].sort(), 'the composite set changed');
  // The primitives: the same names in both generated blocks.
  const lightNames = clayPrimitives('light').sort();
  const darkNames = clayPrimitives('dark').sort();
  assert.deepEqual(lightNames, darkNames, 'the light and dark blocks define different clay primitives');
  for (const name of ['rim', 'base', 'contact', 'ambient', 'deep', 'sink', 'well-bg', 'field', 'wash']) {
    assert.ok(lightNames.includes(name), `--clay-${name} is missing from the generated block`);
  }
  // Every reference in a composite is another composite or a primitive of BOTH themes.
  for (const [name, value] of Object.entries(composites)) {
    for (const ref of value.matchAll(/var\(--clay-([a-z0-9-]+)\)/g)) {
      const r = ref[1];
      assert.ok(
        composites[r] !== undefined || (lightNames.includes(r) && darkNames.includes(r)),
        `--clay-${name} reads --clay-${r}, which is neither a composite nor a primitive of both themes`
      );
    }
    // Geometry only: the colour lives in the primitives.
    assert.doesNotMatch(value, /#[0-9a-f]{3,8}\b|rgba?\(|oklch\(|color-mix\(/i, `--clay-${name} hard-codes a colour`);
    // Light from above: no composite casts sideways (RTL and LTR identical).
    for (const layer of layers(name)) {
      const x = layer.replace(/var\([^)]*\)/g, '').replace(/\binset\b/, '').trim().split(/\s+/)[0];
      assert.equal(parseFloat(x), 0, `--clay-${name} has a sideways offset (${layer}), which flips meaning in RTL`);
    }
    const all = layers(name);
    const blurred = all.filter(isBlurred).length;
    assert.ok(all.length <= 4, `--clay-${name} has ${all.length} layers (max 4)`);
    assert.ok(blurred <= 2, `--clay-${name} has ${blurred} blurred layers (max 2)`);
  }
  // A resting card is the thing a long list repaints: one blurred layer.
  assert.equal(layers('1').filter(isBlurred).length, 1, 'a resting card (--clay-1) paints more than one blurred layer');
  // The generator writes no geometry and none of the retired shadow tokens.
  for (const theme of ['light', 'dark'] as const) {
    for (const gone of ['shadow-1', 'shadow-2', 'shadow-3', 'lv-shadow-strength', 'lv-shadow-soft', 'lv-shadow-deep']) {
      assert.equal(V[theme][gone], undefined, `the ${theme} block still writes --${gone}`);
    }
  }
});

// ---------------------------------------------------------------------- 2
test('every shadow name in @theme is a clay composite', () => {
  const keys: Record<string, string> = {};
  for (const m of css.matchAll(/@theme\s*\{([^}]*)\}/g)) {
    for (const d of m[1].matchAll(/--shadow-([a-z0-9-]+)\s*:\s*([^;]+);/g)) keys[d[1]] = d[2].trim();
  }
  for (const name of ['1', '2', '3', '2xs', 'xs', 'sm', 'md', 'lg', 'xl', '2xl', 'inner', 'press', 'well', 'dock']) {
    assert.ok(keys[name], `@theme has no --shadow-${name}`);
  }
  for (const [name, value] of Object.entries(keys)) {
    const ref = value.match(/^var\(--clay-([a-z0-9-]+)\)$/);
    assert.ok(ref, `@theme --shadow-${name} is ${value}, not a bare var(--clay-*)`);
    assert.ok(composites[ref![1]] !== undefined, `@theme --shadow-${name} points at --clay-${ref![1]}, which is not a composite`);
  }
  // The retired black-shadow colour override is gone with its tokens.
  assert.doesNotMatch(css, /--tw-shadow-color:\s*var\(--lv-shadow-(soft|deep)/);
});

// ---------------------------------------------------------------------- 3
test('the Tier-1 surfaces write their shadow into --tw-shadow, so a ring composes with it', () => {
  const layerStart = css.indexOf('@layer components {');
  assert.ok(layerStart >= 0, 'no components layer in src/index.css');
  for (const [cls, level] of [['lv-surface', '1'], ['lv-surface-raised', '2'], ['lv-button', '1'], ['lv-well', 'well']] as const) {
    const m = new RegExp(`\\n\\s*\\.${cls} \\{([^}]*)\\}`).exec(css);
    assert.ok(m, `.${cls} is missing`);
    assert.ok(m!.index > layerStart, `.${cls} is not in the components layer (a utility must be able to win)`);
    assert.match(m![1], new RegExp(`--tw-shadow:\\s*var\\(--clay-${level}\\);`), `.${cls} does not set --tw-shadow to --clay-${level}`);
    assert.match(m![1], /box-shadow:\s*var\(--tw-shadow\);/, `.${cls} does not draw box-shadow from --tw-shadow`);
  }
  // Busy holds the press at full opacity, and it comes after the disabled rule.
  const disabled = css.search(/\.lv-button\[aria-disabled='true'\] \{/);
  const busy = css.search(/\.lv-button\[data-busy\] \{[^}]*--tw-shadow:\s*var\(--clay-press\)/);
  assert.ok(disabled > 0 && busy > disabled, 'the busy press must follow the disabled rule (equal specificity)');
  assert.match(css, /\.lv-button:not\(:disabled\):not\(\[aria-disabled='true'\]\):active \{[^}]*--tw-shadow:\s*var\(--clay-press\)/);
  // A field is a well with a 3:1 line, and focus keeps the well.
  assert.match(css, /\n\s*\.lv-input \{[^}]*background-color:\s*var\(--clay-well-bg\);[^}]*border:\s*1px solid var\(--clay-field\);[^}]*box-shadow:\s*var\(--clay-well\);/);
  assert.match(css, /\.lv-input:focus-visible \{[^}]*box-shadow:\s*var\(--clay-well\),/);
  // No glass left in the stylesheet (performance on mid-range Android).
  assert.doesNotMatch(css, /backdrop-filter/, 'src/index.css still blurs what is behind a surface');
  // The workbench light is painted on the two non-scrolling shells, under a transparent scroller.
  const app = read('src/App.tsx');
  assert.match(app, /h-\[100dvh\] min-h-0 flex flex-col font-sans overflow-hidden lv-canvas/);
  assert.match(app, /h-\[100dvh\] flex flex-col lv-canvas[^"]*overflow-hidden/);
  assert.match(app, /id="main-scroll-container" className="flex-1 flex flex-col overflow-y-auto"/, 'the main scroller is painted again and hides the light');
  assert.match(css, /\.lv-canvas \{[^}]*var\(--clay-wash\)[^}]*var\(--color-canvas\)/);
  // Forced colours drop every box-shadow: the pressed selection gets an outline.
  assert.match(css, /@media \(forced-colors: active\) \{[^@]*\.lv-choice:is\(\[aria-pressed='true'\]/);
});

// ---------------------------------------------------------------------- 4
test('the contrast of the final set (plan §3.9): 4.5:1 for text, 3:1 for boundaries, in both themes', () => {
  const failures: string[] = [];
  const need = (label: string, value: number, min: number) => {
    if (!(value >= min)) failures.push(`${label}: ${value.toFixed(2)}:1, under ${min}`);
  };
  for (const theme of ['light', 'dark'] as const) {
    const v = V[theme];
    const canvas = T('canvas', theme);
    const surface = T('surface', theme);
    const raised = T('surface-raised', theme);
    const selected = T('surface-selected', theme);
    const well = v['clay-well-bg'];
    const field = v['clay-field'];
    const peak = over(v['clay-wash'], canvas);
    // The light stays under a card in both themes: higher means lighter.
    assert.ok(lightness(peak) < lightness(surface), `${theme}: the wash peak is lighter than a card`);
    assert.ok(lightness(peak) >= lightness(canvas), `${theme}: the wash darkens the page`);
    const grounds: [string, string | Rgb][] = [['canvas', canvas], ['the wash peak', peak], ['surface', surface], ['raised', raised], ['the well', well], ['surface-selected', selected]];
    // Text on the well, on the wash peak, on the selected fill (and every other ground).
    for (const ink of ['text-primary', 'text-secondary', 'text-muted']) {
      for (const [g, c] of grounds) need(`${theme} ${ink} on ${g}`, ratio(T(ink, theme), c), 4.5);
    }
    // The text-entry line and the focus ring against every ground.
    for (const [g, c] of grounds) {
      need(`${theme} --clay-field on ${g}`, ratio(field, c), 3);
      need(`${theme} focus ring on ${g}`, ratio(T('focus', theme), c), 3);
    }
    need(`${theme} gold start bar on surface-selected`, ratio(T('gold', theme), selected), 3);
    // Buttons.
    need(`${theme} primary label on its fill`, ratio(canvas, T('primary-fill', theme)), 4.5);
    need(`${theme} primary label on its hover fill`, ratio(canvas, T('primary-fill-hover', theme)), 4.5);
    need(`${theme} accent label on gold 10% into raised`, ratio(T('gold', theme), mix(T('gold', theme), 0.1, raised)), 4.5);
    const dangerFill = (ground: string) => mix(T('danger', theme), 0.14, ground);
    need(`${theme} danger label on the danger button`, ratio(T('danger-ink', theme), dangerFill(surface)), 4.5);
    need(`${theme} danger label on the danger button, pressed`, ratio(T('danger-ink', theme), dangerFill(well)), 4.5);
    need(`${theme} ghost label on its press fill (the well)`, ratio(T('text-secondary', theme), well), 4.5);
    // .lv-chip: a 12% tone mixed into the raised fill, flat and opaque.
    for (const [tone, ink] of [['success', 'success'], ['warning', 'warning'], ['danger', 'error-ink'], ['info', 'info'], ['gold', 'gold']]) {
      need(`${theme} .lv-chip ${tone}`, ratio(T(ink, theme), mix(T(tone, theme), 0.12, raised)), 4.5);
    }
    // The count badge on crimson (the theme's own crimson).
    need(`${theme} count badge: snow on crimson`, ratio(FIXED.snow, v['color-crimson']), 4.5);
    // Switch: the on track against the card, the knob on the track, the off knob in its well.
    need(`${theme} Switch on track vs surface`, ratio(T('accent', theme), surface), 3);
    need(`${theme} Switch knob vs on track`, ratio(T('accent-contrast', theme), T('accent', theme)), 3);
    need(`${theme} Switch off knob vs the well`, ratio(T('text-muted', theme), well), 3);
    // A photo chip: snow on onyx/80, over the brightest photograph.
    need(`${theme} photo chip: snow on onyx/80 over white`, ratio(FIXED.snow, over('rgb(11 12 15/.8)', '#ffffff')), 4.5);
  }
  // D5: the light selected fill moved so muted text reads on it (it measured 4.34).
  assert.equal(T('surface-selected', 'light').toLowerCase(), '#ddd4c3');
  assert.ok(ratio('#595c62', '#d8cfbd') < 4.5, 'the old fill is the reason for the move');
  // The light field line reads on both grounds the generator is built around.
  need('light --clay-field on IVORY', ratio(V.light['clay-field'], IVORY), 3);
  need('light --clay-field on PAPER', ratio(V.light['clay-field'], PAPER), 3);
  assert.deepEqual(failures, [], `contrast under the floor:\n${failures.join('\n')}`);
});

// ---------------------------------------------------------------------- 5
/** Every TypeScript source under src/, with its text — comments included: Tailwind
 *  reads class candidates out of comments too, so a utility named in one is shipped. */
const sources: [string, string][] = (readdirSync(join(ROOT, 'src'), { recursive: true }) as string[])
  .filter((f) => /\.tsx?$/.test(f))
  .map((f) => [`src/${f.split('\\').join('/')}`, read(`src/${f}`)]);

test('solid clay, not glass: no backdrop blur, no filter glow, no hand-written shadow colour or shadow token in a class', () => {
  assert.ok(sources.length > 500, 'the walk over src/ found too few sources to prove anything');
  const hits = (re: RegExp) => sources.flatMap(([f, c]) => [...c.matchAll(re)].map((m) => `${f}: ${m[0]}`));
  // A backdrop filter re-filters every frame anything beneath it moves — on the
  // mid-range Android phones most customers use, the most expensive pixel on screen.
  assert.deepEqual(hits(/backdrop-blur[\w[\]/.-]*|backdropFilter/g), [], 'a surface still blurs what is behind it');
  // The stylesheets a customer downloads carry none either. The three operations
  // sheets (admin-only, outside the public budget) are their own phase.
  const operations = ['src/components/financeWorkspace/finance-workspace.css', 'src/components/financePeople/people.css', 'src/components/adminInventory/inventory-workspace.css'];
  const sheets = (readdirSync(join(ROOT, 'src'), { recursive: true }) as string[])
    .filter((f) => f.endsWith('.css'))
    .map((f) => `src/${f.split('\\').join('/')}`)
    .filter((f) => !operations.includes(f));
  assert.ok(sheets.includes('src/index.css') && sheets.includes('src/components/storefront/theme.css'), 'the stylesheet walk missed the main sheets');
  for (const f of sheets) assert.doesNotMatch(stripCssComments(read(f)), /backdrop-filter/, `${f} still blurs what is behind a surface`);
  // A glow is a radial gradient (a background or a mask), never a filter raster.
  assert.deepEqual(hits(/\bblur-\[[^\]]*\]/g), [], 'a filter glow (blur-[…]) is back');
  // A shadow colour belongs to the theme's clay primitives (warm ink on cream,
  // black in dark), never to a class: a hand-written rgb() is black on cream.
  // `drop-shadow-[…]` is a filter on a glyph, not an elevation, and is not counted.
  // The named keepers are not elevations either (build plan §6, Funding A):
  //  - the scanner's viewfinder surround, a 200vmax scrim over a camera feed;
  //  - the `.ap` controls' hairline and pressed drop, which the admin push
  //    (Phase 3.5) moves onto `--ap-shadow-*`. Any new site fails here.
  const keepers = new Set([
    'src/components/scanner/BarcodeScanner.tsx: shadow-[0_0_0_200vmax_rgb(0_0_0_/_0.42)]',
    'src/components/adminProducts/theme.ts: shadow-[inset_0_1px_0_rgb(255_255_255_/_0.14),0_1px_2px_rgb(0_0_0_/_0.35)]',
    'src/components/adminProducts/theme.ts: shadow-[0_1px_2px_rgb(0_0_0_/_0.35)]',
  ]);
  const rgbShadows = hits(/(?<![\w-])shadow-\[[^\]\s'"`]*rgba?\([^\]\s'"`]*\]/g);
  assert.deepEqual(rgbShadows.filter((h) => !keepers.has(h)), [], 'a shadow colour is hard-coded in a class');
  // Every keeper is still where it was named, so the list cannot rot into a blanket pass.
  for (const k of keepers) assert.ok(rgbShadows.includes(k), `the keeper is gone, drop it from the list: ${k}`);
  // A shadow token read inside a class string resolves on the element that names
  // it, skipping the clay composites a dark island re-resolves; use var(--clay-*).
  assert.deepEqual(hits(/\[[^\]\s'"`]*var\(--shadow-[^\]\s'"`]*\]/g), [], 'a class reads var(--shadow-*) instead of a clay composite');
});
