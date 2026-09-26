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
    'src/components/catalog/CategoryBanner.tsx',
    'src/components/catalog/CategoryHero.tsx',
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
  // Tailwind's black shadows take a theme colour; dark keeps Tailwind's own.
  assert.match(css, /\.shadow-2xl \{\s*--tw-shadow-color: var\(--lv-shadow-deep, #00000040\);/);
  const block = buildBlock();
  assert.match(block, /\[data-theme='light'\]\{[^}]*--lv-shadow-soft:rgb\(58 46 28\/\.07\)/);
  assert.match(block, /\[data-theme='dark'\],\[data-store-theme\]\{[^}]*--lv-shadow-soft:#0000001a;--lv-shadow-deep:#00000040/);
  // No page paints its glass black whatever the theme.
  const community = read('src/pages/Community.tsx');
  assert.doesNotMatch(community, /--material-tint:#000/, 'the community bars were a black strip on ivory');
});

test('wide screens use the width; phones get a square printers tile and proportioned banners', () => {
  const home = read('src/pages/Home.tsx');
  assert.match(home, /max-w-\[1920px\] flex-col gap-8 px-4 sm:px-6/, 'the home column runs to 1920 px with small gutters');
  assert.doesNotMatch(home, /max-w-\[1200px\]/);
  const bento = read('src/components/home/v2/CategoryBento.tsx');
  assert.match(bento, /aspect-square sm:aspect-auto sm:h-full/, 'the printers tile is square on a phone');
  assert.match(bento, /square \? 'aspect-square' : 'aspect-\[5\/4\]'/, 'the tile beside it is square too');
  const editorial = read('src/components/home/v2/EditorialBanners.tsx');
  assert.match(editorial, /aspect-\[7\/3\][^']*sm:aspect-\[16\/9\] lg:aspect-\[12\/5\]/, 'banners keep a proportion at every width');
  assert.doesNotMatch(editorial, /h-\[168px\]/);
});
