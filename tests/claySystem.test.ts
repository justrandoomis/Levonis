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
 *     a class string, where it would bypass the per-theme clay primitives;
 *  6. the product card (row 209) is resting clay that a scrolling list can
 *     afford — no blur, no animated shadow, no image zoom — and a long
 *     grid's `content-visibility` never sits on a wrapper that would clip the
 *     card's cast;
 *  7. THE RATCHET: the hand-drawn styling the tokens cannot reach (legacy
 *     cards, ad-hoc buttons, raw inputs, arbitrary radii), counted by the
 *     same code as `node scripts/clay-census.mjs`, never rises above the
 *     numbers checked in here. Each family push lowers them;
 *  8. what the foundation's screenshot QA found (row 210): a card dropped
 *     into a card, a dialog or a sheet sits flush; a focused field shows a
 *     solid focus line on cream, where the 3:1 field line and the focus ink
 *     are a near match; photo tiles keep their focus ring off the photo; the
 *     admin tab wrapper is a flat tray; a scroller of clay buttons leaves
 *     room for their cast;
 *  9. the sign-in screen (its own `--lv-*` palette): on the app's cream in
 *     light (D4), every text ink 4.5:1 on its grounds in both themes, fields
 *     are wells with a 3:1 line, and every shadow is a clay composite.
 *
 * Run: node --import tsx --test tests/claySystem.test.ts
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildBlock, contrast, parseColor, rgbToOklch, SEMANTIC, FIXED, IVORY, PAPER } from '../scripts/theme-tokens.mjs';
import { census, RATCHET, sourceFiles, type RatchetKey } from '../scripts/clay-census.mjs';

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
  // The stylesheets a customer downloads carry none either — and, since the
  // admin push (Phase 3.5a), neither do the three operations sheets.
  const sheets = (readdirSync(join(ROOT, 'src'), { recursive: true }) as string[])
    .filter((f) => f.endsWith('.css'))
    .map((f) => `src/${f.split('\\').join('/')}`);
  assert.ok(sheets.includes('src/index.css') && sheets.includes('src/components/storefront/theme.css'), 'the stylesheet walk missed the main sheets');
  assert.ok(sheets.includes('src/components/financeWorkspace/finance-workspace.css'), 'the stylesheet walk missed the operations sheets');
  for (const f of sheets) assert.doesNotMatch(stripCssComments(read(f)), /backdrop-filter/, `${f} still blurs what is behind a surface`);
  // A glow is a radial gradient (a background or a mask), never a filter raster.
  assert.deepEqual(hits(/\bblur-\[[^\]]*\]/g), [], 'a filter glow (blur-[…]) is back');
  // A shadow colour belongs to the theme's clay primitives (warm ink on cream,
  // black in dark), never to a class: a hand-written rgb() is black on cream.
  // `drop-shadow-[…]` is a filter on a glyph, not an elevation, and is not counted.
  // The named keeper is not an elevation either (build plan §6, Funding A):
  // the scanner's viewfinder surround, a 200vmax scrim over a camera feed.
  // (The `.ap` controls' hairline and pressed drop moved onto `--ap-shadow-1`
  // and `shadow-1` in the admin push, Phase 3.5a.) Any new site fails here.
  const keepers = new Set([
    'src/components/scanner/BarcodeScanner.tsx: shadow-[0_0_0_200vmax_rgb(0_0_0_/_0.42)]',
  ]);
  const rgbShadows = hits(/(?<![\w-])shadow-\[[^\]\s'"`]*rgba?\([^\]\s'"`]*\]/g);
  assert.deepEqual(rgbShadows.filter((h) => !keepers.has(h)), [], 'a shadow colour is hard-coded in a class');
  // Every keeper is still where it was named, so the list cannot rot into a blanket pass.
  for (const k of keepers) assert.ok(rgbShadows.includes(k), `the keeper is gone, drop it from the list: ${k}`);
  // A shadow token read inside a class string resolves on the element that names
  // it, skipping the clay composites a dark island re-resolves; use var(--clay-*).
  assert.deepEqual(hits(/\[[^\]\s'"`]*var\(--shadow-[^\]\s'"`]*\]/g), [], 'a class reads var(--shadow-*) instead of a clay composite');
});

// ---------------------------------------------------------------------- 6
/** The opening tag of every `<li>` in a source, read up to the `>` that closes it (not an arrow's). */
function liTags(src: string): string[] {
  const out: string[] = [];
  for (const m of src.matchAll(/<li\b/g)) {
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

test('the product card is clay a scrolling list can afford, and content-visibility never clips its cast', () => {
  const card = read('src/components/home/ProductCard.tsx');
  // The two roots: the compact card (a div under a stretched link) and the regular one (the link itself).
  const compact = /data-product-card="compact"\s*className=\{`([^`]*)`\}/.exec(card)?.[1];
  const regular = /<Link\s+to=\{cardHref\(p\)\}\s+className=\{`(\$\{widthClass\} relative shrink-0[^`]*)`\}/.exec(card)?.[1];
  assert.ok(compact, 'the compact card root is not where it was');
  assert.ok(regular, 'the regular card root is not where it was');
  for (const [name, root] of [['compact', compact!], ['regular', regular!]] as const) {
    assert.match(root, /(^|\s)rounded-xl(\s|$)/, `${name}: a card takes the card radius (22px)`);
    assert.match(root, /(^|\s)shadow-sm(\s|$)/, `${name}: a card is resting clay (--clay-1, one blurred layer)`);
    assert.match(root, /(^|\s)(has-\[a:active\]:|active:)shadow-press(\s|$)/, `${name}: a card dents while it is pressed`);
  }
  // A repeated item never animates its shadow or its photograph, and nothing
  // on it blurs what is behind it: forty of these scroll on a mid-range phone.
  assert.doesNotMatch(card, /backdrop-blur|backdropFilter/, 'the product card blurs what is behind it');
  assert.doesNotMatch(card, /transition-all|transition-shadow|transition-\[[^\]]*shadow/, 'the product card animates its shadow');
  assert.doesNotMatch(card, /group-hover:scale|hover:scale/, 'the product card zooms its photograph');
  // `content-visibility: auto` turns on paint containment, which clips a
  // DESCENDANT's ink at the container's edge: on an <li> around a shadowed
  // card it cut the cast of every card from the 9th on. It belongs on the
  // card itself — or on a wrapper padded wide enough for the cast.
  const offenders: string[] = [];
  for (const file of sourceFiles()) {
    for (const tag of liTags(read(file))) {
      if (/\blv-cv(-row)?\b/.test(tag) && !/(^|[\s"'`{])p[xy]?-\d/.test(tag)) offenders.push(`${file}: ${tag.slice(0, 160)}`);
    }
  }
  assert.deepEqual(offenders, [], 'an unpadded <li> carries content-visibility and clips its card');
  // And the listing grid still skips the far cards (the containment moved, it did not go).
  assert.match(read('src/components/listing/ProductGrid.tsx'), /<ProductCard\b[^>]*className=\{i >= 8 \? 'lv-cv' : undefined\}/);
  assert.match(read('src/components/listing/ProductList.tsx'), /data-product-row\s*className=\{`[^`]*\$\{i >= 10 \? 'lv-cv-row' : ''\}`\}/);
  assert.match(read('src/styles/catalog.css'), /\.lv-cv \{\s*content-visibility: auto;/);
});

// ---------------------------------------------------------------------- 7
/**
 * THE CEILING, today's census (node scripts/clay-census.mjs). A family push
 * that converts hand-drawn styling LOWERS these numbers in the same commit;
 * nothing may raise them. Heuristic counts (a quoted string with a radius, a
 * border and a ground but no semantic class is a "legacy card"), so a rewrite
 * that moves a quote can shift one by one — lower the ceiling, never raise it.
 */
const CEILING: Record<RatchetKey, number> = {
  // Phase 3 (docs/DECISIONS.md row 211): the nine page families swept —
  // 422 / 159 / 461 / 100 at the foundation, these after.
  legacy: 0,
  btn: 14,
  rawIn: 172,
  arbR: 2,
};

test('the ratchet: hand-drawn styling the clay tokens cannot reach never grows', () => {
  assert.deepEqual(Object.keys(CEILING).sort(), Object.keys(RATCHET).sort(), 'the ceiling and the census disagree on what is counted');
  const files = sourceFiles();
  assert.ok(files.length > 500, 'the census walked too few sources to prove anything');
  const { totals, rows } = census();
  const over = (Object.keys(CEILING) as RatchetKey[])
    .filter((k) => totals[k] > CEILING[k])
    .map((k) => {
      const worst = rows
        .filter((r) => r.counts[k] > 0)
        .sort((a, b) => b.counts[k] - a.counts[k])
        .slice(0, 5)
        .map((r) => `${r.file} (${r.counts[k]})`)
        .join(', ');
      return `${RATCHET[k]}: ${totals[k]}, over the ceiling of ${CEILING[k]} — most in ${worst}. Use the house primitive (node scripts/clay-census.mjs --suggest <file>).`;
    });
  assert.deepEqual(over, [], over.join('\n'));
  // The census only reads: it is a suggestion generator, never a codemod.
  assert.doesNotMatch(read('scripts/clay-census.mjs'), /writeFile|appendFile|rmSync|unlink|renameSync|copyFile/, 'the census writes to the tree');
});

// ---------------------------------------------------------------------- 8
test('the foundation QA: one raised container per stack, focus that shows on cream, rings off the photo, casts not cut', () => {
  const layerStart = css.indexOf('@layer components {');
  // AsyncStates (an lv-surface) inside a card, or any card inside a card, a
  // dialog or a sheet, sits flush — in the components layer, so a utility
  // (a link card's hover:shadow-lg) still wins.
  const nested = /:is\(\.lv-surface, \.lv-surface-raised, \[data-overlay-panel\]\) \.lv-surface \{\s*--tw-shadow:\s*var\(--clay-0\);\s*\}/.exec(css);
  assert.ok(nested, 'a card nested in a card, a dialog or a sheet is no longer demoted to flush clay');
  assert.ok(nested.index > layerStart, 'the nested-card rule must sit in the components layer');
  // On cream the field line (#7c715c) and the focus ink (#6f592b) are a near
  // match: focus adds a solid 1px ring, not only a colour swap and a halo.
  assert.match(css, /\.lv-input:focus-visible \{[^}]*box-shadow:\s*var\(--clay-well\),\s*0 0 0 1px var\(--color-focus\),/);
  // The stepper's bare figure shows its own keyboard focus (QuantityInput's recipe).
  assert.match(
    read('src/components/ui/NumberInput.tsx'),
    /'-my-1 h-11 w-full[^']*focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-focus'/
  );
  // A resting ring-inset makes the focus ring inset too, painted under the
  // photo the tile is filled with: a ring nobody sees.
  for (const f of [
    'src/components/home/v2/CategoryBento.tsx',
    'src/components/home/v2/EditorialBanners.tsx',
    'src/components/catalog/CategoryRowBanners.tsx',
    'src/components/catalog/RelatedCategories.tsx',
  ]) {
    const src = read(f);
    assert.match(src, /focus-visible:ring-2/, `${f} lost its focus ring`);
    assert.doesNotMatch(src.replace(/focus-visible:ring-inset/g, ''), /(^|[\s'"`])ring-inset\b/, `${f}: a resting ring-inset hides the focus ring under the photo`);
  }
  // The admin tab wrapper is a flat tray: the cards inside it are the raised things.
  assert.doesNotMatch(read('src/pages/Admin.tsx'), /rounded-2xl p-4 md:p-5 shadow-/);
  // A horizontal scroller of clay buttons leaves room for their cast (overflow-x clips y too).
  assert.match(read('src/components/merchant/counter/QuickDock.tsx'), /data-quick-dock className="[^"]*-my-2[^"]*overflow-x-auto[^"]*py-2/);
});

// ---------------------------------------------------------------------- 9
/**
 * THE SIGN-IN SCREEN (build plan §3.8, §6 Phase 3.6; D4). /auth draws itself
 * from its own palette (src/components/auth/auth.css, `--lv-*`) and the app's
 * clay geometry. In light its page and card are the app's cream IVORY and
 * PAPER («كريمي، ليس أبيض»), not the near-white they were — so every text ink
 * of that palette is re-measured on the grounds it now sits on, in both
 * themes; a text-entry field is a well with a 3:1 line; and no hand-written
 * (black) shadow is left to land on cream.
 */
test('the sign-in screen is clay on the app cream (D4): every auth text ink reads on its grounds, fields are wells', () => {
  const sheets = ['src/components/auth/auth.css', 'src/components/auth/authLeave.css'].map((f) => [f, stripCssComments(read(f))] as const);
  const auth = sheets[0][1];
  const tokens = (re: RegExp, label: string): Record<string, string> => {
    const m = re.exec(auth);
    assert.ok(m, `auth.css: the ${label} token block is missing`);
    return Object.fromEntries([...m![1].matchAll(/--(lv-[a-z0-9-]+):\s*([^;]+);/g)].map((d) => [d[1], d[2].trim()]));
  };
  const base = tokens(/(?:^|\n)\.lv-auth \{([^}]*)\}/, 'dark (.lv-auth)');
  const palette: Record<Theme, Record<string, string>> = {
    dark: base,
    light: { ...base, ...tokens(/\[data-theme='light'\] \.lv-auth \{([^}]*)\}/, 'light') },
  };
  // D4: the light page and card are the app's own grounds, the field the app's well.
  assert.equal(palette.light['lv-ground'].toLowerCase(), IVORY, 'the light /auth page is not IVORY');
  assert.equal(palette.light['lv-panel'].toLowerCase(), PAPER, 'the light /auth card is not PAPER');
  assert.equal(palette.light['lv-ground-2'].toLowerCase(), V.light['clay-well-bg'].toLowerCase(), 'a light /auth field is not the app well');

  const failures: string[] = [];
  const need = (label: string, value: number, min: number) => {
    if (!(value >= min)) failures.push(`${label}: ${value.toFixed(2)}:1, under ${min}`);
  };
  for (const theme of ['light', 'dark'] as const) {
    const p = palette[theme];
    const inks = Object.keys(p).filter((k) => /^lv-text-\d+$/.test(k));
    assert.ok(inks.length >= 3, `${theme}: the auth text inks were not found`);
    // Every text ink (and the placeholder and the toned inks) on the page, a
    // well, the card and a raised button.
    const grounds = ['lv-ground', 'lv-ground-2', 'lv-panel', 'lv-raised'];
    for (const ink of [...inks, 'lv-placeholder', 'lv-gold-text', 'lv-olive-text', 'lv-red-text']) {
      assert.ok(p[ink], `${theme}: --${ink} is missing`);
      for (const g of grounds) need(`${theme} --${ink} on --${g}`, ratio(p[ink], p[g]), 4.5);
    }
    // A notice's ink on its own tint.
    need(`${theme} --lv-red-text on --lv-red-soft`, ratio(p['lv-red-text'], p['lv-red-soft']), 4.5);
    need(`${theme} --lv-olive-text on --lv-olive-soft`, ratio(p['lv-olive-text'], p['lv-olive-soft']), 4.5);
    // A field's line (the app's --clay-field), a valid field's line and the focus ink: 3:1 on the well and the card.
    for (const g of ['lv-ground-2', 'lv-panel']) {
      need(`${theme} --clay-field on --${g}`, ratio(V[theme]['clay-field'], p[g]), 3);
      need(`${theme} --lv-olive (a valid field) on --${g}`, ratio(p['lv-olive'], p[g]), 3);
      need(`${theme} --lv-focus-ring on --${g}`, ratio(p['lv-focus-ring'], p[g]), 3);
    }
    // Higher means lighter: the card above the page, a raised button above the card, a well below it.
    assert.ok(lightness(p['lv-panel']) > lightness(p['lv-ground']), `${theme}: the /auth card is not lighter than its page`);
    assert.ok(lightness(p['lv-raised']) > lightness(p['lv-panel']), `${theme}: a raised /auth button is not lighter than the card`);
    assert.ok(lightness(p['lv-ground-2']) < lightness(p['lv-panel']), `${theme}: an /auth well is not darker than the card`);
  }
  assert.deepEqual(failures, [], `/auth contrast under the floor:\n${failures.join('\n')}`);

  // Clay, not hand-drawn: every shadow on the screen is a clay composite (or none),
  // so no black cast lands on the cream; the card lifts, the sheet docks, the wells sink.
  for (const [f, src] of sheets) {
    for (const m of src.matchAll(/(?:^|[;{\s])box-shadow:\s*([^;}]+)/g)) {
      const v = m[1].trim();
      assert.ok(v === 'none' || /var\(--clay-[a-z0-9-]+\)/.test(v), `${f}: a box-shadow is not clay: ${v}`);
    }
    assert.doesNotMatch(src, /border-radius:\s*(6|8|12|16)px/, `${f}: a radius off the role scale (controls 14, cards 22, popovers 18, notes and small keys 10)`);
  }
  const rule = (sel: string) => new RegExp(`(?:^|\\n)${sel.replace(/[.[\]()*+?^$|\\]/g, '\\$&')} \\{([^}]*)\\}`).exec(auth)?.[1] ?? '';
  assert.match(rule('.lv-card'), /border-radius:\s*22px;[^}]*box-shadow:\s*var\(--clay-2\);/, 'the /auth card is not lifted clay at the card radius');
  for (const field of ['.lv-field__input', '.lv-otp__box', '.lv-cpick__button', '.lv-cpick__search']) {
    const body = rule(field);
    assert.match(body, /border:\s*1px solid var\(--clay-field\);/, `${field}: a field's line is not the 3:1 --clay-field`);
    assert.match(body, /box-shadow:\s*var\(--clay-well\);/, `${field}: a field is not a well`);
  }
  for (const focus of ['.lv-field__input:focus', '.lv-otp__box:focus']) {
    assert.match(rule(focus), /box-shadow:\s*var\(--clay-well\),\s*var\(--lv-halo\);/, `${focus}: focus must keep the well and add the ring and halo`);
  }
  assert.match(auth, /@media \(pointer: coarse\) \{[\s\S]*?\.lv-cpick__panel[^{]*\{[^}]*border-radius:\s*32px 32px 0 0;[^}]*box-shadow:\s*var\(--clay-dock\);/, 'the country sheet is not a docked sheet');
  // A bare .lv-alert in this sheet restyled every app alert (index.css) once /auth had loaded.
  for (const [f, src] of sheets) assert.doesNotMatch(src, /\.lv-alert\b/, `${f} styles the app's .lv-alert`);
});
