#!/usr/bin/env node
/**
 * THE TWO THEMES, AS DATA — and the one generator that writes them into
 * src/index.css.
 *
 *   node scripts/theme-tokens.mjs            print the block
 *   node scripts/theme-tokens.mjs --write    rewrite it in src/index.css
 *   node scripts/theme-tokens.mjs --report   contrast table for every token
 *
 * WHY GENERATED. The app is written in Tailwind's palette (`text-zinc-400`,
 * `bg-white/5`, `text-red-300` … ~3,500 call sites) and in a few named brand
 * tones. Dark is the palette as designed. Light is the SAME class names with
 * different values behind them: `html[data-theme="light"]` re-points every
 * colour variable a utility reads. That is only safe if the light value of
 * every (hue, shade) actually in use is chosen by a rule and checked for
 * contrast, which is what this file does — by hand it would be 250 numbers
 * nobody could audit. tests/themeSystem.test.ts regenerates the block and
 * fails when src/index.css is stale (a new shade appeared, a value changed).
 *
 * THE RULES (light):
 *   neutral ramps (zinc/gray/slate/neutral/stone) invert onto the warm ivory
 *     system of homepage v2: 900 → paper (a card), 800 → the control fill and
 *     hairline, 400/500 → secondary/muted ink, 50–200 → near-ink.
 *   white ↔ black swap roles: `text-white` is "the foreground", `bg-black` is
 *     "the page", `bg-white/5` is "a lift", in both themes.
 *   chromatic shades used as TEXT on a dark page (100–600) move to the lightest
 *     shade of the same hue that reads at ≥ 4.5:1 on ivory; the dark tints
 *     (800–950) become the light tints (200–50); 700 stays.
 *   named tones (hex brand colours used for text/borders) darken in OKLCH,
 *     hue and chroma kept, until they read at ≥ 4.5:1 on ivory.
 *
 * The DARK block restores the designed values under `[data-theme="dark"]`, so a
 * subtree can stay dark inside a light page (a merchant's storefront, the 3D
 * viewer). Custom properties resolve where they are declared, so an island has
 * to redeclare every one — which is why the dark block exists at all.
 */
import { readFileSync, writeFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

// ---------------------------------------------------------------- colour math
function hexToRgb(h) {
  h = h.replace('#', '');
  if (h.length === 3) h = h.split('').map((c) => c + c).join('');
  return [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16) / 255);
}
const lin = (c) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
const gam = (c) => (c <= 0.0031308 ? 12.92 * c : 1.055 * c ** (1 / 2.4) - 0.055);
const clamp = (v) => Math.min(1, Math.max(0, v));
export function luminance(rgb) {
  const [r, g, b] = rgb.map(lin);
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}
export function contrast(a, b) {
  const A = luminance(a);
  const B = luminance(b);
  return (Math.max(A, B) + 0.05) / (Math.min(A, B) + 0.05);
}
function oklchToRgb(L, C, H) {
  const h = (H * Math.PI) / 180;
  const a = C * Math.cos(h);
  const b = C * Math.sin(h);
  const l = (L + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const m = (L - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const s = (L - 0.0894841775 * a - 1.291485548 * b) ** 3;
  return [
    4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
    -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
    -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s,
  ].map((v) => clamp(gam(clamp(v))));
}
export function rgbToOklch(rgb) {
  const [r, g, b] = rgb.map(lin);
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
  const L = 0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s;
  const A = 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s;
  const B = 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s;
  return [L, Math.hypot(A, B), ((Math.atan2(B, A) * 180) / Math.PI + 360) % 360];
}
export function parseColor(v) {
  v = v.trim();
  if (v.startsWith('#')) return hexToRgb(v);
  const m = v.match(/oklch\(([\d.]+)%\s+([\d.]+)\s+([\d.]+)\)/);
  if (m) return oklchToRgb(+m[1] / 100, +m[2], +m[3]);
  throw new Error(`cannot parse colour ${v}`);
}
const toHex = (rgb) => `#${rgb.map((c) => Math.round(c * 255).toString(16).padStart(2, '0')).join('')}`;

// ------------------------------------------------------------------ the data
/**
 * The two grounds every light value is measured against.
 *
 * CREAM, NOT BRIGHT (owner, 2026-09-26: «اجعل المظهر الفاتح يكون كريمي او off
 * white وليس ابيض بحت وساطع، بحيث يكون الثيم مريح للعين»). The page was
 * #f3f0ea with #fbfaf7 cards and pure #ffffff menus — near-white at 96–100%
 * lightness. The page is now a warm cream at OKLCH L≈0.93 and a card is one
 * step lighter (L≈0.95); nothing large is white. The names stay IVORY/PAPER
 * because every rule below is written against them.
 */
export const IVORY = '#ece6da';
export const PAPER = '#f4efe5';

/**
 * The semantic slots. Dark values are the ones @theme in src/index.css
 * declares (the test holds the two together); light values are the warm
 * ivory system of homepage v2. Contrast on ivory, measured by --report.
 */
export const SEMANTIC = {
  //                         dark        light
  'black':               ['#0b0c0f', IVORY],
  'white':               ['#f2f3f5', '#16181b'],
  'canvas':              ['#0b0c0f', IVORY],
  'surface':             ['#131519', PAPER],
  'surface-raised':      ['#191c21', '#f8f4ec'],
  'surface-selected':    ['#20242a', '#e3dccd'],
  'border-subtle':       ['#2a2e35', '#d9d1c2'],
  'text-primary':        ['#f2f3f5', '#16181b'],
  'text-secondary':      ['#b7bbc3', '#45484e'],
  'text-muted':          ['#858b95', '#595c62'],
  'success':             ['#42b77a', '#1a6a43'],
  'warning':             ['#d79b45', '#87520a'],
  'danger':              ['#dc6363', '#ad3037'],
  'info':                ['#6f9bd1', '#2d5f9a'],
  'focus':               ['#d2c392', '#6f592b'],
  'gold':                ['#BAA369', '#6f592b'],
  'gold-light':          ['#ffe55c', '#735800'],
  'primary-fill':        ['#ece8dc', '#16181b'],
  'primary-fill-hover':  ['#fffaf0', '#2a2c30'],
  'danger-ink':          ['#ffdada', '#8f2328'],
  'error-ink':           ['#f2a4a4', '#ad3037'],
  'accent':              ['#BAA369', '#6f592b'],
  'accent-contrast':     ['#101114', PAPER],
};

/** The light ramp every neutral family maps onto (Tailwind shade → value). */
export const NEUTRAL_LIGHT = {
  50: '#16181b',
  100: '#1f2124',
  200: '#2a2c30',
  300: '#3a3d42',
  400: '#505359',
  500: '#5c5f65',
  // The dim ink of placeholders, captions and quiet glyphs (172 call sites use
  // `text-zinc-600` as TEXT): 4.5:1 on the cream page and 5:1 on a card, where
  // the old #8b8d92 read at 2.9.
  600: '#606268',
  700: '#cdc4b3',
  800: '#e2dbcd',
  900: PAPER,
  950: '#e7e0d3',
};
const NEUTRALS = ['zinc', 'gray', 'slate', 'neutral', 'stone'];
const HUES = ['red', 'orange', 'amber', 'yellow', 'lime', 'green', 'emerald', 'teal', 'cyan', 'sky', 'blue', 'indigo', 'violet', 'purple', 'fuchsia', 'pink', 'rose'];
const SHADES = [50, 100, 200, 300, 400, 500, 600, 700, 800, 900, 950];

/**
 * Brand tones that were written as hex (`text-[#2CE59B]`). Each gets a name so
 * a text or border use can flip; the dark value IS the original hex, so the
 * dark theme does not move by a pixel.
 */
export const TONES = {
  gilt: '#D4AF37',
  iris: '#6B46FF',
  'iris-deep': '#5A38E6',
  mint: '#2CE59B',
  crimson: '#B03142',
  honey: '#E4B363',
  coral: '#E06070',
  leaf: '#59A846',
  moss: '#708238',
  blush: '#E4899A',
  sage: '#A6B283',
  scarlet: '#EF233C',
  apricot: '#E6A84F',
  sprout: '#8FD07C',
  aqua: '#06D6A0',
  flame: '#FF5000',
  petal: '#F3BDC5',
  wheat: '#E6C27A',
};

/** Fixed colours: the same in both themes, for text on photographs and fills. */
export const FIXED = {
  snow: '#f2f3f5',
  onyx: '#0b0c0f',
  'gold-fill': '#BAA369',
};

// ---------------------------------------------------------------- the rules
function tailwindPalette() {
  const css = readFileSync(join(ROOT, 'node_modules/tailwindcss/theme.css'), 'utf8');
  const out = {};
  for (const m of css.matchAll(/--color-([a-z]+)-(\d+):\s*(oklch\([^)]*\))/g)) out[`${m[1]}-${m[2]}`] = m[3];
  return out;
}

/** Darken in OKLCH (hue and chroma kept, chroma eased toward the gamut) until ≥ target on ivory and paper. */
export function darkenToContrast(color, target = 4.6) {
  const [L0, C, H] = rgbToOklch(parseColor(color));
  const ok = (rgb) => contrast(rgb, hexToRgb(IVORY)) >= target && contrast(rgb, hexToRgb(PAPER)) >= target;
  if (ok(parseColor(color))) return toHex(parseColor(color));
  for (let L = L0; L > 0.1; L -= 0.005) {
    const rgb = oklchToRgb(L, Math.min(C, 0.02 + L * 0.28), H);
    if (ok(rgb)) return toHex(rgb);
  }
  return '#16181b';
}

export function chromaticLight(palette, hue, shade) {
  const readable = (s) => contrast(parseColor(palette[`${hue}-${s}`]), hexToRgb(IVORY)) >= 4.6;
  const order = [600, 700, 800, 900];
  const t = order.find(readable) ?? 900;
  const deeper = order[Math.min(order.indexOf(t) + 1, order.length - 1)];
  const map = { 50: 900, 100: deeper, 200: deeper, 300: t, 400: t, 500: t, 600: t, 700: readable(700) ? 700 : t, 800: 200, 900: 100, 950: 50 };
  return palette[`${hue}-${map[shade]}`];
}

// ---------------------------------------------------------------- scanning
function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.(tsx?|css)$/.test(name)) out.push(p);
  }
  return out;
}

/** Every (family, shade) a utility in src/ names — the block covers exactly these. */
export function usedPaletteKeys(srcDir = join(ROOT, 'src')) {
  const fams = [...NEUTRALS, ...HUES].join('|');
  const re = new RegExp(`(?:^|[^a-z0-9-])[a-z-]*?-(${fams})-(\\d{2,3})(?![0-9])`, 'g');
  const keys = new Set();
  for (const f of walk(srcDir)) {
    const src = readFileSync(f, 'utf8');
    for (const m of src.matchAll(re)) if (SHADES.includes(+m[2])) keys.add(`${m[1]}-${m[2]}`);
  }
  const order = (k) => {
    const [f, s] = k.split('-');
    return [...NEUTRALS, ...HUES].indexOf(f) * 1000 + +s;
  };
  return [...keys].sort((a, b) => order(a) - order(b));
}

// ---------------------------------------------------------------- the block
export const BEGIN = '/* THEME TOKENS:BEGIN — generated by scripts/theme-tokens.mjs --write; do not edit by hand */';
export const END = '/* THEME TOKENS:END */';

export function buildBlock() {
  const palette = tailwindPalette();
  const keys = usedPaletteKeys();
  const light = [];
  const dark = [];
  for (const [name, [d, l]] of Object.entries(SEMANTIC)) {
    dark.push(`--color-${name}:${d}`);
    light.push(`--color-${name}:${l}`);
  }
  for (const [name, hex] of Object.entries(TONES)) {
    dark.push(`--color-${name}:${hex}`);
    light.push(`--color-${name}:${darkenToContrast(hex)}`);
  }
  for (const k of keys) {
    const [fam, shade] = k.split('-');
    dark.push(`--color-${k}:${palette[k]}`);
    light.push(`--color-${k}:${NEUTRALS.includes(fam) ? NEUTRAL_LIGHT[shade] : chromaticLight(palette, fam, +shade)}`);
  }
  // Light shadows are a WARM ink at low strength: a black shadow on cream is
  // the grey smudge the owner saw under the bars («غواش»). `--lv-shadow-soft`
  // and `--lv-shadow-deep` are the colours Tailwind's own `shadow-sm…2xl`
  // draw with (src/index.css, THE SHADOW UTILITIES FOLLOW THE THEME); their
  // dark values are Tailwind's own, so the dark theme does not move.
  const lightShadows = [
    '--shadow-1:0 1px 2px rgb(58 46 28/.07)',
    '--shadow-2:0 12px 32px -16px rgb(58 46 28/.2)',
    '--shadow-3:0 28px 70px -28px rgb(58 46 28/.26)',
    '--lv-shadow-ink:58 46 28',
    '--lv-shadow-strength:.12',
    '--lv-shadow-soft:rgb(58 46 28/.07)',
    '--lv-shadow-deep:rgb(58 46 28/.14)',
  ];
  const darkShadows = [
    '--shadow-1:0 1px 2px rgb(0 0 0/.35)',
    '--shadow-2:0 12px 32px -16px rgb(0 0 0/.8)',
    '--shadow-3:0 28px 70px -28px rgb(0 0 0/.9)',
    '--lv-shadow-ink:0 0 0',
    '--lv-shadow-strength:.9',
    '--lv-shadow-soft:#0000001a',
    '--lv-shadow-deep:#00000040',
  ];
  return [
    BEGIN,
    `[data-theme='light']{color-scheme:light;${[...light, ...lightShadows].join(';')}}`,
    `[data-theme='dark'],[data-store-theme]{color-scheme:dark;${[...dark, ...darkShadows].join(';')}}`,
    END,
  ].join('\n');
}

export function report() {
  const iv = hexToRgb(IVORY);
  const rows = [];
  for (const [name, [, l]] of Object.entries(SEMANTIC)) rows.push([name, l, contrast(parseColor(l), iv).toFixed(2)]);
  for (const [name, hex] of Object.entries(TONES)) {
    const l = darkenToContrast(hex);
    rows.push([name, `${hex} → ${l}`, contrast(parseColor(l), iv).toFixed(2)]);
  }
  return rows.map((r) => r.join('\t')).join('\n');
}

const INDEX_CSS = join(ROOT, 'src/index.css');
export function currentBlock() {
  const css = readFileSync(INDEX_CSS, 'utf8');
  const a = css.indexOf(BEGIN);
  const b = css.indexOf(END);
  return a < 0 || b < 0 ? null : css.slice(a, b + END.length);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv.includes('--report')) console.log(report());
  else if (process.argv.includes('--write')) {
    const css = readFileSync(INDEX_CSS, 'utf8');
    const cur = currentBlock();
    if (!cur) throw new Error(`markers not found in src/index.css — add\n${BEGIN}\n${END}`);
    writeFileSync(INDEX_CSS, css.replace(cur, buildBlock()));
    console.log('src/index.css theme block rewritten');
  } else console.log(buildBlock());
}
