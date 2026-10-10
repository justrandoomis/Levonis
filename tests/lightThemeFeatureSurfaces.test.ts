/**
 * THE LIGHT THEME, AS THE OWNER ASKED FOR IT (2026-09-26).
 *
 *  «في المظهر الفاتح هنالك بعض الأزرار والأيقونات التي لا يمكن رؤيتها بسهولة
 *   مثل صفحة المجتمع» — the community page's bars were painted black by a
 *   hard-coded `--material-tint:#000`.
 *  «في hero banner وايقونات وصور حسب الفئة تكون بلون أسود وبأزرار سوداء او
 *   ذهبيه بالرغم هو الثيم فاتح» — the hero, the bento, the finder band, the
 *   editorial banners and the category banners were dark islands.
 *  «يظهر غواش في خلف الشريط العلوي والشريط السفلي» — black scrims and black
 *   shadows under the bars read as a grey haze on ivory.
 *  «اجعل المظهر الفاتح يكون كريمي او off white وليس ابيض بحت وساطع».
 *  «في الشاشات الكبيرة يظهر هنالك فراغ كبير» / «بطاقة فئة الطابعات … يجب أن
 *   تكون مربعة».
 *
 * Each rule below is one of those sentences, held in the source so it cannot
 * quietly come back. Pictures: scripts/e2e-home-v2-shots.mjs and
 * scripts/e2e-theme-shots.mjs (both themes, 320–1920 px).
 *
 * Run: npm run test:unit
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildBlock, contrast, parseColor, rgbToOklch, IVORY, PAPER } from '../scripts/theme-tokens.mjs';
import { THEME_COLOR } from '../src/lib/theme';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (p: string) => readFileSync(join(ROOT, p), 'utf8');
const css = read('src/index.css');

function lightValue(name: string): string {
  const block = buildBlock();
  const light = block.slice(block.indexOf("[data-theme='light']"), block.indexOf("[data-theme='dark']"));
  const v = light.match(new RegExp(`--color-${name}:([^;}]+)`))?.[1];
  assert.ok(v, `--color-${name} has no light value`);
  return v!;
}
const L = (c: string) => rgbToOklch(parseColor(c))[0];

test('cream, not bright: no large light surface is near-white, and the page is warmer and lower than before', () => {
  for (const name of ['canvas', 'surface', 'surface-raised', 'black', 'zinc-900']) {
    const v = lightValue(name);
    assert.ok(L(v) < 0.97, `${name} (${v}) is near-white (OKLCH L ${L(v).toFixed(3)})`);
    assert.notEqual(v.toLowerCase(), '#ffffff');
  }
  assert.ok(L(IVORY) < L('#f3f0ea'), 'the page is lower in lightness than the old ivory');
  assert.ok(L(PAPER) > L(IVORY), 'a card is a step lighter than the page');
  // The browser chrome, the manifest splash and the pre-CSS ground are the page.
  assert.equal(THEME_COLOR.light, IVORY);
  assert.ok(read('index.html').includes(`<meta name="theme-color" content="${IVORY}"`));
});

test('every light ink still reads at 4.5:1 on the page, a card and a control fill', () => {
  const grounds = [IVORY, PAPER];
  for (const name of ['text-primary', 'text-secondary', 'text-muted', 'gold', 'accent', 'success', 'warning', 'danger', 'info', 'zinc-400', 'zinc-500', 'zinc-600']) {
    const v = lightValue(name);
    for (const g of grounds) {
      const c = contrast(parseColor(v), parseColor(g));
      assert.ok(c >= 4.5, `${name} ${v} on ${g}: ${c.toFixed(2)}:1`);
    }
  }
  // A glyph's floor on the deepest control fill (zinc-800).
  const fill = lightValue('zinc-800');
  assert.ok(contrast(parseColor(lightValue('zinc-600')), parseColor(fill)) >= 3, 'a dim glyph on a control fill');
});

test('feature surfaces follow the theme: no dark island left on the home page or the category pages', () => {
  const FEATURES = [
    'src/components/home/Hero.tsx',
    'src/components/home/v2/CategoryBento.tsx',
    'src/components/home/v2/PrinterFinder.tsx',
    'src/components/home/v2/EditorialBanners.tsx',
    'src/components/catalog/CategoryRowBanners.tsx',
    'src/components/catalog/RelatedCategories.tsx',
    'src/components/catalog/FinderBand.tsx',
    'src/components/finder/HumanHelpBand.tsx',
  ];
  for (const f of FEATURES) {
    const src = read(f);
    assert.match(src, /data-feature=""/, `${f} is not a feature surface`);
  }
  // The hero keeps ONE island: an owner's photograph carousel under a dark scrim.
  const hero = read('src/components/home/Hero.tsx');
  assert.equal((hero.match(/data-theme="dark"/g) ?? []).length, 1, 'only the photo carousel stays dark');
  for (const f of FEATURES.slice(1)) assert.doesNotMatch(read(f), /data-theme="dark"/, `${f} is still a dark island`);
  // The category hero is no surface at all (owner, 2026-09-26: «مدموجه في
  // الصفحه»): page ink on the page's canvas, and never a dark island.
  const categoryHero = read('src/components/catalog/CategoryHero.tsx');
  assert.doesNotMatch(categoryHero, /data-theme="dark"|bg-charcoal|ring-inset/, 'the category hero is part of the page');
  assert.match(categoryHero, /text-text-primary/);
});

test('inside a feature surface the light theme re-points the four fixed colours, at readable contrast', () => {
  const rule = css.match(/\[data-theme='light'\] \[data-feature\],\s*\[data-theme='light'\]\[data-feature\] \{([^}]*)\}/);
  assert.ok(rule, 'the FEATURE SURFACES rule is missing from src/index.css');
  const v = (n: string) => rule![1].match(new RegExp(`--color-${n}:\\s*(#[0-9a-f]{6})`, 'i'))?.[1] ?? '';
  const tile = v('charcoal');
  const ink = v('ivory');
  const cta = v('gold-muted');
  const ctaInk = v('gold-ink');
  assert.ok(L(tile) > 0.9 && L(tile) < 0.97, `the tile is cream (${tile})`);
  assert.ok(contrast(parseColor(ink), parseColor(tile)) >= 7, 'ink on the tile');
  assert.ok(contrast(parseColor(ink), parseColor(IVORY)) >= 7, 'ink on the page');
  assert.ok(contrast(parseColor(ctaInk), parseColor(cta)) >= 4.5, 'the primary button label');
  assert.ok(contrast(parseColor(cta), parseColor(tile)) >= 3, 'the primary button against its tile');
  // Muted ink written as `text-ivory/[0.6x]` on a cream tile still reads.
  const mix = (a: number) => {
    const [r1, g1, b1] = parseColor(ink);
    const [r2, g2, b2] = parseColor(tile);
    return [r1 * a + r2 * (1 - a), g1 * a + g2 * (1 - a), b1 * a + b2 * (1 - a)] as [number, number, number];
  };
  for (const a of [0.68, 0.72, 0.74, 0.82]) {
    const c = contrast(mix(a), parseColor(tile));
    assert.ok(c >= 4.5, `ink at ${a * 100}% on the tile reads ${c.toFixed(2)}:1`);
  }
  // A dark photograph with no light twin is framed, not smudged into the cream.
  assert.match(css, /\[data-theme='light'\] \.lv-promo-zone\[data-ground='dark'\] \{[^}]*mask-image: none/);
});

test('the bars are clean on the light theme: no black scrim, no black shadow, no black glass', () => {
  assert.match(css, /\[data-theme='light'\] \.lv-topbar-scrim \{\s*background-image: none;/);
  assert.match(css, /\[data-theme='light'\] \.lv-topbar-solid \{[^}]*--material-tint: var\(--color-canvas\)/);
  assert.match(css, /\[data-theme='light'\] \[data-bottom-nav-group\] \{/);
  assert.match(css, /\[data-theme='light'\] \[data-nav-scrim\] \{/);
  assert.match(css, /\[data-theme='light'\] \.scroll-edge::after,/);
  assert.match(read('src/components/Header.tsx'), /lv-topbar-solid/);
  // NO BLACK SHADOW ON CREAM, for every shadow utility at once (clay,
  // docs/DECISIONS.md row 207). It used to be pinned by giving Tailwind's
  // black `--tw-shadow-color` a warm value on five utilities; now each shadow
  // name IS a clay composite whose colours are per-theme primitives.
  // (a) The shadow scale is clay: Tailwind's names map onto the composites.
  assert.match(css, /--shadow-sm:\s*var\(--clay-1\);/, '@theme --shadow-sm is clay level 1');
  assert.match(css, /--shadow-2xl:\s*var\(--clay-3\);/, '@theme --shadow-2xl is the clay slab');
  // (b) Every light clay colour is the warm ink or a cream white, never black.
  const block = buildBlock();
  const light = block.slice(block.indexOf("[data-theme='light']"), block.indexOf("[data-theme='dark']"));
  const dark = block.slice(block.indexOf("[data-theme='dark']"));
  const clay = (part: string) => Object.fromEntries([...part.matchAll(/--clay-([a-z-]+):([^;}]+)/g)].map((m) => [m[1], m[2]]));
  const lightClay = clay(light);
  const darkClay = clay(dark);
  assert.ok(Object.keys(lightClay).length >= 9, 'the light clay primitives are missing from the generated block');
  for (const [name, v] of Object.entries(lightClay)) {
    assert.doesNotMatch(v, /\b0 0 0\b|#000\b|#000000/i, `light --clay-${name} (${v}) is black on cream`);
    const rgb = v.match(/^rgb\((\d+) (\d+) (\d+)\//);
    if (rgb) {
      const [r, g, b] = rgb.slice(1).map(Number);
      const warmInk = r === 58 && g === 46 && b === 28;
      const creamWhite = r === 255 && g >= 245 && b >= 230 && g >= b;
      assert.ok(warmInk || creamWhite, `light --clay-${name} (${v}) is neither the warm ink nor a cream white`);
    } else {
      // A fill or a line written as hex: warm (red ≥ green ≥ blue), never grey-black.
      const [r, g, b] = parseColor(v);
      assert.ok(r >= g && g >= b && r > 0.3, `light --clay-${name} (${v}) is not a warm cream tone`);
    }
  }
  // (c) The dark casts are black: the dark theme keeps a black page's shadows.
  for (const name of ['base', 'contact', 'ambient', 'deep', 'sink']) {
    assert.match(darkClay[name] ?? '', /^rgb\(0 0 0\/[.\d]+\)$/, `dark --clay-${name} is not a black cast`);
  }
  // (d) The text-entry line reads at 3:1 on every light ground it meets.
  const field = parseColor(lightClay.field);
  for (const [ground, hex] of [['IVORY', IVORY], ['PAPER', PAPER], ['the well', lightClay['well-bg']], ['surface-selected', lightValue('surface-selected')]]) {
    const c = contrast(field, parseColor(hex));
    assert.ok(c >= 3, `light --clay-field on ${ground} (${hex}) reads ${c.toFixed(2)}:1, under 3`);
  }
  // (e) The workbench light stays cream, and under a card: its peak (the wash
  // composited on the page) is lower than PAPER and nowhere near white.
  const wash = lightClay.wash.match(/^rgb\((\d+) (\d+) (\d+)\/([.\d]+)\)$/);
  assert.ok(wash, `light --clay-wash (${lightClay.wash}) is not rgb(r g b/a)`);
  const [wr, wg, wb, wa] = wash!.slice(1).map(Number);
  const page = parseColor(IVORY);
  const peak = [wr / 255, wg / 255, wb / 255].map((c, i) => c * wa + page[i] * (1 - wa)) as [number, number, number];
  const peakL = rgbToOklch(peak)[0];
  assert.ok(peakL < L(PAPER), `the wash peak (L ${peakL.toFixed(3)}) is not under a card (PAPER L ${L(PAPER).toFixed(3)})`);
  assert.ok(peakL < 0.97, `the wash peak (L ${peakL.toFixed(3)}) is near-white`);
  // No page paints its glass black whatever the theme.
  const community = read('src/pages/Community.tsx');
  assert.doesNotMatch(community, /--material-tint:#000/, 'the community bars were a black strip on ivory');
});

test('wide screens use the width; phones keep the desktop bento and the banners share one row', () => {
  const home = read('src/pages/Home.tsx');
  assert.match(home, /max-w-\[1920px\] flex-col gap-8 px-4 sm:px-6/, 'the home column runs to 1920 px with small gutters');
  assert.doesNotMatch(home, /max-w-\[1200px\]/);
  // Owner, 2026-09-26: printers the large tile on the LEFT at every width, two
  // wide tiles above and the compact ones below beside it — no phone flow.
  const bento = read('src/components/home/v2/CategoryBento.tsx');
  assert.doesNotMatch(bento, /contents/, 'the phone two-column flow is gone');
  assert.match(bento, /\{side\}\s*\{large \?/, 'the side column comes first, so printers land on the left in Arabic');
  assert.match(bento, /grid-cols-\[58fr_42fr\] sm:grid-cols-\[56fr_44fr\] lg:grid-cols-\[7fr_5fr\]/);
  assert.match(bento, /h-\[200px\]/, 'the phone bento has a fixed, short height');
  // The two editorial banners share ONE row on a phone, each a landscape rectangle.
  const editorial = read('src/components/home/v2/EditorialBanners.tsx');
  assert.match(editorial, /cards\.length > 1 \? 'grid-cols-2' : 'grid-cols-1'/);
  assert.match(editorial, /aspect-\[16\/10\][^']*sm:aspect-\[16\/9\] lg:aspect-\[12\/5\]/, 'banners keep a proportion at every width');
  assert.doesNotMatch(editorial, /h-\[168px\]/);
});
