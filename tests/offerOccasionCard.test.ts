/**
 * THE SALE'S OCCASION ON THE CARD AND THE PAGE — EACH IN ITS OWN DESIGN (DECISIONS row 294;
 * docs/ux/PRODUCT-DISCOUNT.md §16).
 *
 * Rendered for real (renderToStaticMarkup) in Arabic, English and Sorani:
 *   - the tag is its own chunk: the card holds its place at its height until it lands;
 *   - every preset and a custom name draw their own tag at the photo's top-end, ABOVE the unchanged
 *     «−N٪» chip, in one `top-2 end-2` stack, with the screen-reader sentence and the visible name
 *     hidden from it; a list row's 96 px photograph keeps its chip alone and the row names the occasion
 *     in its design above its price, inside its link;
 *   - no tag when the card's own sale does not lower its «from» (`price_source: 'ladder'`), for a viewer
 *     locked out of a members-only sale, or for a key this build does not know — and the chip alone is
 *     drawn exactly where it always was; the two gates (`occasionOnCard`, `occasionOnPage`) as functions;
 *   - the stack stops short of the compare toggle, and every preset's name FITS the narrowest card with
 *     6 px to spare in all three languages (the measured widths, tests/fixtures/occasionTagWidths.json);
 *   - THE DESIGN SYSTEM'S RULES, computed: only fixed tokens, named tones and palette shades the shop
 *     already uses (inside a dark island, so one design in both themes); the ink 4.5:1 on its fill, every
 *     glyph 3:1 on what is under it, and every tag standing off a dark photo, a white photo and each tray
 *     by its fill or its edge; two designs that share an edge never share a fill's look; no zinc, blur,
 *     shadow or arbitrary radius; sixteen distinct designs;
 *   - the words: every preset in three languages, the Sorani its own and in Sorani letters;
 *   - the product page: the gallery tag and «سعر بلاك فرايدي», lazy, mounted only while the sale lowers
 *     the selection on screen.
 *
 * Run: node --import tsx --test tests/offerOccasionCard.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createElement, type ReactElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import { AuthContext } from '../src/AuthContext';
import { WalletProvider } from '../src/WalletContext';
import { CurrencyProvider } from '../src/CurrencyContext';
import { LanguageProvider } from '../src/LanguageContext';
import ProductCard from '../src/components/home/ProductCard';
import OccasionTag, { OCCASION_TAG_SIZES, OCCASION_THEMES, OccasionPriceLabel } from '../src/components/ui/OccasionTag';
import { occasionOnCard, occasionOnPage } from '../src/components/ui/OfferBadge';
import {
  CUSTOM_OCCASION_FALLBACK,
  OFFER_OCCASION_KEYS,
  OFFER_OCCASION_PRESETS,
  OFFER_OCCASIONS,
  occasionWords,
  type OfferOccasionKey,
} from '../packages/contracts/src/offerOccasions';
import { buildBlock, contrast, parseColor, rgbToOklch, FIXED } from '../scripts/theme-tokens.mjs';
import { scanSource } from '../scripts/clay-census.mjs';
import type { ApiProduct } from '../src/lib/api';

let LANG = 'ar';
(globalThis as { localStorage?: unknown }).localStorage = {
  getItem: (k: string) => (k === 'levo_lang' ? LANG : null),
  setItem: () => {},
  removeItem: () => {},
};

function wrap(child: ReactElement, lang: 'ar' | 'en' | 'ckb' = 'ar'): string {
  LANG = lang;
  return renderToStaticMarkup(
    createElement(AuthContext.Provider, {
      value: {
        isAuthenticated: false,
        user: null,
        login: async () => {},
        loginWithGoogle: async () => 'ok' as const,
        register: async () => {},
        refreshUser: async () => {},
        adoptSession: async () => 'ok' as const,
        logout: async () => {},
        isLoaded: true,
      },
      children: createElement(WalletProvider, {
        children: createElement(CurrencyProvider, {
          children: createElement(LanguageProvider, { children: createElement(MemoryRouter, null, child) }),
        }),
      }),
    })
  );
}

const sale = (offer: Record<string, unknown> = {}, over: Partial<ApiProduct> = {}): ApiProduct =>
  ({
    id: 'p_p1s',
    slug: 'bambu-p1s',
    name: 'Bambu Lab P1S',
    price_status: 'priced',
    price_iqd: 750_000,
    display_price_iqd: 750_000,
    display_regular_iqd: 750_000,
    display_offer_before_iqd: 900_000,
    display_offer_saving_percent: 17,
    display_applied_tier: 'regular',
    display_prime_iqd: null,
    display_pro_iqd: null,
    display_from: true,
    offer: { offer_id: 'ofw_p1s', required_tiers: [], starts_at: null, ends_at: '2099-01-01T00:00:00.000Z', schedule_state: 'live', price_source: 'offer', priced: true, locked: false, ...offer },
    ...over,
  }) as ApiProduct;

const card = (p: ApiProduct, lang: 'ar' | 'en' | 'ckb' = 'ar', extra: Record<string, unknown> = {}) =>
  wrap(createElement(ProductCard, { p, density: 'compact', ...extra }), lang);

/** The chip of a live sale, as it has always been drawn. */
const CHIP = (lang: 'ar' | 'en' | 'ckb') =>
  lang === 'en' ? '−17%</bdi><span class="sr-only">17% off</span>' : lang === 'ckb' ? '−17٪</bdi><span class="sr-only">17٪ داشکاندن</span>' : '−17٪</bdi><span class="sr-only">تخفيض 17٪</span>';

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/* ------------------------------------------------------------ the card -- */

/** The card's stack: the photograph's top-end corner, the tag above the chip, short of the compare toggle. */
const STACK = 'absolute top-2 end-2 flex max-w-[calc(100%-2.875rem)] flex-col items-end gap-1';

test('the tag is its own chunk: the card holds its place at its height until it lands, then draws it', async () => {
  const src = readFileSync('src/components/home/ProductCard.tsx', 'utf8');
  assert.match(src, /^import type \{ OccasionTagProps \} from '\.\.\/ui\/OccasionTag';$/m, 'a type, never the module: the card’s chunk carries no tag');
  assert.doesNotMatch(src, /^import OccasionTag\b/m);
  assert.match(src, /React\.lazy<React\.ComponentType<OccasionTagProps>>\(\(\) =>\s*import\('\.\.\/ui\/OccasionTag'\)\.catch\(\(\) => \(\{ default: \(\) => null \}\)\)\s*\)/, 'a chunk that does not arrive draws nothing');
  assert.match(src, /const TAG_PLACE = <span aria-hidden className="block h-5" \/>;/, 'the 20 px of a card tag');
  // The first draw, before the chunk (this file's first card with an occasion): the place at the stack's
  // top, the chip under it where it will stay.
  const first = card(sale({ badge: 'black_friday' }));
  assert.doesNotMatch(first, /data-occasion=/);
  assert.match(first, new RegExp(`<span data-photo-badges="true" class="${escape(STACK)}"><span aria-hidden="true" class="block h-5"></span><span class="inline-flex[^"]*bg-rose-600`));
  // …then the tag, once its chunk has landed (every test below renders it).
  for (let i = 0; i < 100 && !card(sale({ badge: 'black_friday' })).includes('data-occasion="black_friday"'); i++) await new Promise((r) => setTimeout(r, 10));
  assert.match(card(sale({ badge: 'black_friday' })), /data-occasion="black_friday"/);
});

test('every preset draws its own tag above the unchanged −N٪ chip, in one top-end stack, with its sentence', () => {
  for (const key of OFFER_OCCASION_PRESETS) {
    for (const lang of ['ar', 'en', 'ckb'] as const) {
      const html = card(sale({ badge: key }), lang);
      const w = OFFER_OCCASIONS[key];
      const stack = /<span data-photo-badges="true" class="([^"]*)">/.exec(html);
      assert.ok(stack, `${key} ${lang}: the stack`);
      assert.equal(stack![1], STACK, `${key}: the top-end corner, the tag above the chip`);
      const tag = new RegExp(`<span data-occasion="${key}" data-occasion-size="card" data-theme="dark" style="--occ-fill:[^"]*" class="([^"]*)">[\\s\\S]*?<span aria-hidden="true" class="min-w-0 truncate text-\\[var\\(--occ-ink\\)\\]">${escape(w.name[lang])}</span><span class="sr-only">${escape(w.sr[lang])}</span></span>`);
      const found = tag.exec(html);
      assert.ok(found, `${key} ${lang}: its name, hidden from a screen reader, and its sentence`);
      // The island's own colour is its theme's text (index.css, outside every layer): a colour utility on
      // the island itself is overridden — the ink must sit on the name (the White Friday name read snow on snow).
      assert.doesNotMatch(found![1], /(^| )text-\[var\(/, `${key}: no ink on the island itself`);
      assert.ok(html.indexOf(`data-occasion="${key}"`) < html.indexOf(CHIP(lang)), `${key} ${lang}: the tag sits ABOVE the chip`);
      assert.ok(html.includes(CHIP(lang)), `${key} ${lang}: the −N٪ chip is still there, unchanged`);
      assert.match(html, /class="inline-flex items-center rounded-md px-2 py-0\.5 text-\[10px\] font-bold[^"]*bg-rose-600 text-snow ?"><bdi/, `${key}: the chip's own classes`);
    }
  }
});

test('a custom name: the owner’s words in each language, the generic words where one is missing — never the Arabic in Sorani', () => {
  const name = { ar: 'عيد الحب', en: 'Valentine' };
  const ar = card(sale({ badge: 'custom', badge_text: name }), 'ar');
  assert.match(ar, /data-occasion="custom"[\s\S]*?>عيد الحب<\/span><span class="sr-only">تخفيض عيد الحب<\/span>/);
  const en = card(sale({ badge: 'custom', badge_text: name }), 'en');
  assert.match(en, />Valentine<\/span><span class="sr-only">Valentine discount<\/span>/);
  const ckb = card(sale({ badge: 'custom', badge_text: name }), 'ckb');
  assert.match(ckb, new RegExp(`>${CUSTOM_OCCASION_FALLBACK.name.ckb}</span><span class="sr-only">${CUSTOM_OCCASION_FALLBACK.sr.ckb}</span>`));
  assert.doesNotMatch(ckb, /عيد الحب/, 'the Arabic name never reaches a Sorani reader');
  // A custom key without its Arabic name, an unknown key: nothing drawn, the chip alone in its corner.
  for (const offer of [{ badge: 'custom' }, { badge: 'custom', badge_text: { en: 'Valentine' } }, { badge: 'a_future_occasion' }]) {
    const html = card(sale(offer));
    assert.doesNotMatch(html, /data-occasion=/, JSON.stringify(offer));
  }
});

test('no tag where the sale does not lower this card, or this viewer is locked out — the chip is where it always was', () => {
  const cases: Array<[string, ApiProduct]> = [
    ['a sale above the card’s «from» (price_source ladder)', sale({ badge: 'black_friday', price_source: 'ladder' }, { display_offer_before_iqd: null, display_offer_saving_percent: null })],
    ['a members-only sale this viewer may not take', sale({ badge: 'black_friday', price_source: 'ladder', locked: true }, { display_offer_before_iqd: null, display_offer_saving_percent: null })],
    ['no offer block', sale({}, { offer: null })],
  ];
  for (const [why, p] of cases) {
    const html = card(p);
    assert.doesNotMatch(html, /data-occasion=/, why);
    assert.doesNotMatch(html, /data-photo-badges/, why);
  }
  // The chip alone keeps its own corner classes — the markup of every card without an occasion.
  const plain = card(sale());
  assert.match(plain, /bg-rose-600 text-snow absolute top-2 end-2"><bdi dir="ltr" aria-hidden="true">−17٪/);
  const locked = card(sale({ price_source: 'ladder', locked: true }, { display_offer_before_iqd: null, display_offer_saving_percent: null }));
  assert.match(locked, /lv-chip \[--chip:var\(--color-gold\)\] absolute top-2 end-2 gap-1"><span data-offer-locked/);
});

test('a list row: its photograph keeps the chip alone, and the row names the occasion in its design above its price, inside its link', () => {
  for (const key of OFFER_OCCASION_PRESETS) {
    for (const lang of ['ar', 'en', 'ckb'] as const) {
      const w = OFFER_OCCASIONS[key];
      const list = card(sale({ badge: key }), lang, { layout: 'list' });
      // The 96 px photograph: the «−N٪» chip alone in its corner, as on a row without an occasion — a tag above
      // it would push it down under the offer's clock.
      const photo = /<div data-motion-photo="true"[^>]*>([\s\S]*?)<\/div><a /.exec(list);
      assert.ok(photo, `${key} ${lang}: the photograph`);
      assert.doesNotMatch(photo![1], /data-occasion=|data-photo-badges/, `${key} ${lang}: nothing above the chip`);
      assert.match(photo![1], /bg-rose-600 text-snow absolute top-2 end-2"><bdi/, `${key} ${lang}: the chip where it always was`);
      // The row: the tag in its design, with its words, inside the card's link, above the price.
      const link = /<a [^>]*data-motion-copy="true"[^>]*>([\s\S]*?)<\/a>/.exec(list);
      assert.ok(link, `${key} ${lang}: the card's link`);
      const named = link![1].indexOf(`data-occasion="${key}" data-occasion-size="card"`);
      assert.ok(named > 0, `${key} ${lang}: the row names its occasion`);
      assert.ok(named < link![1].indexOf('data-motion-price'), `${key} ${lang}: above the price`);
      assert.ok(link![1].includes(`>${w.name[lang]}</span><span class="sr-only">${w.sr[lang]}</span>`), `${key} ${lang}: its name, and its sentence in the link's name`);
      assert.equal(list.split(`<span class="sr-only">${w.sr[lang]}</span>`).length, 2, `${key} ${lang}: the sentence is read once`);
    }
  }
  // A grid card names it on the photograph only; a row without an occasion has no line for one.
  assert.doesNotMatch(card(sale({ badge: 'ramadan' })), /data-card-occasion/);
  assert.doesNotMatch(card(sale(), 'ar', { layout: 'list' }), /data-card-occasion|data-occasion=/);
  assert.doesNotMatch(card(sale({ badge: 'ramadan', price_source: 'ladder' }, { display_offer_before_iqd: null, display_offer_saving_percent: null }), 'ar', { layout: 'list' }), /data-occasion=/);
});

test('the stack stops 6 px short of the compare toggle’s disc; the card’s own roots and the toggle’s corner are untouched', () => {
  // A printer card with the compare toggle (top-start): the stack keeps 2.875 rem clear of the photo's start.
  const printer = sale({ badge: 'black_friday' }, { compare_type: 'printer' } as Partial<ApiProduct>);
  const withToggle = card(printer, 'ar', { compareToggle: true });
  assert.match(withToggle, /data-compare-toggle=/, 'the toggle is drawn');
  assert.match(withToggle, new RegExp(`data-photo-badges="true" class="${escape(STACK)}"`));
  const src = readFileSync('src/components/home/ProductCard.tsx', 'utf8');
  assert.match(src, new RegExp(`<span data-photo-badges className="${escape(STACK)}">`));
  assert.match(src, /className="absolute top-1\.5 start-1\.5 z-\[2\]"/, 'the compare toggle keeps its corner');
  assert.match(src, /mx-1 mt-1 aspect-\[6\/5\]/, 'the photograph sits 4 px inside the card');
  assert.match(readFileSync('src/components/compare/CompareToggle.tsx', 'utf8'), /className=\{`lv-hit grid size-\[30px\] place-items-center rounded-full/, 'the 30 px disc');
  // The geometry, in px: the disc ends 6 + 30 − 4 = 32 px into the photograph; the stack, 8 px from its end
  // and at most the photograph less 2.875 rem, starts 46 − 8 = 38 px in — 6 px clear, on every card width.
  assert.equal(2.875 * 16 - 8 - (6 + 30 - 4), 6);
  assert.match(src, /const occasion = layout === 'grid' \? occasionOnCard\(p\.offer\) : null;/, 'the card shows it only while its own sale lowers its price');
  assert.match(src, /const listOccasion = list && priced \? occasionOnCard\(p\.offer\) : null;/, 'the list row by the same rule');
});

test('the two gates: a card draws the occasion only when its own «from» is the sale’s, the page only while the selection on screen is lowered', () => {
  const friday = { badge: 'black_friday', price_source: 'offer' };
  assert.equal(occasionOnCard(friday), friday);
  assert.equal(occasionOnCard({ ...friday, price_source: 'ladder' }), null, 'a sale on a dearer model alone: the card strikes nothing, names nothing');
  assert.equal(occasionOnCard({ price_source: 'offer' }), null, 'a sale with no occasion');
  assert.equal(occasionOnCard(null), null);
  assert.equal(occasionOnCard(undefined), null);
  assert.equal(occasionOnPage(friday, 900_000), friday, 'the selection on screen is lowered (its struck price)');
  assert.equal(occasionOnPage(friday, null), null, 'a selection the sale does not lower: no tag, no «سعر بلاك فرايدي»');
  assert.equal(occasionOnPage({}, 900_000), null);
  assert.equal(occasionOnPage(null, 900_000), null);
  // Both surfaces ask them — the card above, the product page here.
  assert.match(readFileSync('src/pages/Product.tsx', 'utf8'), /const pageOccasion = occasionOnPage\(product\.offer, offerBefore\);/);
});

/**
 * THE NARROWEST CARD: the home rail's 148 px (LatestProducts) with its 1 px border and the photograph 4 px
 * inside it — 138 px — less the stack's reserve for the compare toggle.
 */
const RAIL_TRAY = 148 - 2 * 1 - 2 * 4;
const reserve = (): number => {
  const m = /max-w-\[calc\(100%-([\d.]+)rem\)\]/.exec(STACK);
  assert.ok(m, 'the stack names its reserve in rem');
  return Number(m![1]) * 16;
};

test('every preset’s name fits the narrowest card with 6 px to spare, in all three languages (measured)', () => {
  const measured = JSON.parse(readFileSync('tests/fixtures/occasionTagWidths.json', 'utf8')) as {
    card: string;
    widths: Record<'ar' | 'en' | 'ckb', Record<string, [string, number]>>;
  };
  const sz = OCCASION_TAG_SIZES.card;
  assert.equal(measured.card, `${sz.tag} | ${sz.mark} | ${sz.icon}`, 'the card tag changed since it was measured: measure it again (the file says how)');
  assert.match(readFileSync('src/components/home/v2/LatestProducts.tsx', 'utf8'), /widthClass="w-\[148px\] shrink-0 lg:w-full"/, 'the rail card is still 148 px');
  assert.match(readFileSync('src/components/home/ProductCard.tsx', 'utf8'), /'w-\[148px\] shrink-0'/, 'and so is every rail card by default');
  const cap = RAIL_TRAY - reserve();
  assert.equal(cap, 92);
  for (const lang of ['ar', 'en', 'ckb'] as const) {
    const expected: Array<[string, string]> = OFFER_OCCASION_PRESETS.map((key) => [key, OFFER_OCCASIONS[key].name[lang]]);
    // The custom fallback is what English and Sorani show when the owner typed no name in them; Arabic always shows the owner's own.
    if (lang !== 'ar') expected.push(['custom', CUSTOM_OCCASION_FALLBACK.name[lang]]);
    assert.deepEqual(Object.keys(measured.widths[lang]).sort(), expected.map(([k]) => k).sort(), `${lang}: one measurement per name, none stale`);
    for (const [key, name] of expected) {
      const [said, px] = measured.widths[lang][key];
      assert.equal(said, name, `${lang} ${key}: renamed since it was measured — measure it again`);
      assert.ok(px + 6 <= cap, `${lang} ${key} «${name}»: ${px} px leaves ${(cap - px).toFixed(1)} px in a ${cap} px stack`);
    }
  }
});

/* ------------------------------------------------------ the design rules -- */

const block = buildBlock();
/** Every colour the generator writes for a dark island: the palette shades in use, the tones, the roles. */
const darkVars: Record<string, string> = Object.fromEntries(
  [...block.slice(block.indexOf("[data-theme='dark']")).matchAll(/--color-([a-z0-9-]+):([^;}]+)/g)].map((m) => [m[1], m[2].trim()])
);
/**
 * A token as the tag reads it (`color-violet-950` = `var(--color-violet-950)`): inside its dark island,
 * the generated dark value — or one of the three FIXED colours (snow, onyx, gold-fill: the same in both
 * themes, for text on a photograph or a fill), which other utilities keep in every page's stylesheet.
 * Nothing else: a token only @theme declares is emitted only when a utility uses it, and the tag uses none.
 */
const colour = (value: string | null): string => {
  const m = /^color-([a-z0-9-]+)$/.exec(value ?? '');
  assert.ok(m, `${value} is not a colour token`);
  const v = darkVars[m![1]] ?? (FIXED as Record<string, string>)[m![1]];
  assert.ok(v, `--color-${m![1]} is neither a generated nor a fixed colour`);
  return v;
};
const ratio = (a: string, b: string) => contrast(parseColor(a), parseColor(b));
/** What a tag stands on: the dark photo tray, the light tray in both themes, the product page's surface, a white and a black photograph. */
const GROUNDS = ['#0e1013', '#ddd4c3', '#20242a', '#ebe4d6', '#131519', '#ffffff', '#000000'];

test('one design per occasion, from the system’s own tokens: no zinc, blur, shadow or arbitrary radius', () => {
  const themes = Object.entries(OCCASION_THEMES) as Array<[OfferOccasionKey, (typeof OCCASION_THEMES)[OfferOccasionKey]]>;
  assert.deepEqual(themes.map(([k]) => k).sort(), [...OFFER_OCCASION_KEYS].sort(), 'every key has a design');
  const looks = new Set<string>();
  const icons = new Set<unknown>();
  for (const [key, t] of themes) {
    looks.add(JSON.stringify([t.fill, t.ink, t.edge, t.medal, t.glyph]));
    icons.add(t.icon);
    for (const v of [t.fill, t.ink, t.edge, t.glyph, ...(t.medal ? [t.medal] : [])]) {
      assert.doesNotMatch(v, /zinc/, `${key}: ${v}`);
      colour(v);
    }
  }
  assert.equal(looks.size, themes.length, 'sixteen distinct designs');
  assert.equal(icons.size, themes.length, 'sixteen distinct glyphs');
  // FIVE CLASSES FOR SIXTEEN DESIGNS: the tag reads its custom properties, and names no colour utility of its own.
  const src = readFileSync('src/components/ui/OccasionTag.tsx', 'utf8');
  for (const cls of ['border-[var(--occ-edge)]', 'bg-[var(--occ-fill)]', 'text-[var(--occ-ink)]', 'bg-[var(--occ-medal)]', 'text-[var(--occ-glyph)]']) assert.ok(src.includes(cls), cls);
  assert.deepEqual(src.match(/(?<![\w-])(?:bg|text|border)-(?!\[var\(--occ-)(?:[a-z]+-\d{2,3}|onyx|snow|gold-fill|crimson|flame|petal|cream)\b/g) ?? [], [], 'no colour utility per design');
  assert.match(src, /data-theme="dark"/, 'a dark island: one design in both themes');
  // Written as property names: no `--color-…` in the source, so Tailwind copies none of them into `:root`
  // (the island declares the generated ones); the three fixed ones stay because other utilities use them.
  assert.doesNotMatch(src.replace(/\/\*[\s\S]*?\*\//g, ''), /--color-/);
  const elsewhere = ['src/components/home/ProductCard.tsx', 'src/components/ui/OfferBadge.tsx', 'src/components/Header.tsx'].map((f) => readFileSync(f, 'utf8')).join('\n');
  for (const fixed of ['text-snow', 'bg-onyx', 'gold-fill']) assert.ok(elsewhere.includes(fixed), `${fixed} is a utility of the pages around the tag`);
  // The census finds nothing hand-drawn, and the theme generator still has nothing new to write.
  const found = scanSource(src);
  assert.deepEqual([found.legacy.length, found.btn.length, found.arbR.length, found.arbS.length, found.blur.length, found.zinc], [0, 0, 0, 0, 0, 0]);
  assert.doesNotMatch(src, /backdrop-blur|shadow-\[|rounded-\[|dark:/);
  assert.ok(block === buildBlock(), 'the generated theme block is unchanged by the tags');
  // Rendered: the five properties ride on the tag, the island resolves them.
  const html = wrap(createElement(OccasionTag, { badge: 'cyber_monday', lang: 'en' }), 'en');
  assert.match(html, /data-theme="dark" style="--occ-fill:var\(--color-violet-950\);--occ-ink:var\(--color-cyan-300\);--occ-edge:var\(--color-cyan-500\);--occ-medal:var\(--color-cyan-300\);--occ-glyph:var\(--color-violet-950\)"/);
});

test('contrast, computed: ink 4.5:1 on its fill, every glyph 3:1, every tag off any photo or tray by its fill or edge', () => {
  for (const [key, t] of Object.entries(OCCASION_THEMES)) {
    const fill = colour(t.fill);
    const ink = colour(t.ink);
    const edge = colour(t.edge);
    assert.ok(ratio(ink, fill) >= 4.5, `${key}: ink ${ratio(ink, fill).toFixed(2)}:1 on its fill`);
    const glyph = colour(t.glyph);
    const under = t.medal ? colour(t.medal) : fill;
    assert.ok(ratio(glyph, under) >= 3, `${key}: glyph ${ratio(glyph, under).toFixed(2)}:1`);
    for (const g of GROUNDS) {
      const off = Math.max(ratio(fill, g), ratio(edge, g));
      assert.ok(off >= 3, `${key}: only ${off.toFixed(2)}:1 off ${g}`);
    }
  }
});

test('two designs that share an edge never share a fill’s look (OKLab, ≥ 0.08): Ramadan’s night blue is not Black Friday’s onyx', () => {
  /** A colour in OKLab (L, a, b), from the value the island resolves. */
  const lab = (token: string) => {
    const [L, C, H] = rgbToOklch(parseColor(colour(token)));
    return [L, C * Math.cos((H * Math.PI) / 180), C * Math.sin((H * Math.PI) / 180)];
  };
  const apart = (a: string, b: string) => Math.hypot(...lab(a).map((v, i) => v - lab(b)[i]));
  // The measure itself: the first Ramadan (slate-900 on the same gold edge) sat 0.06 from onyx — too close.
  assert.ok(apart('color-slate-900', 'color-onyx') < 0.08, 'the rule would have caught it');
  const themes = Object.entries(OCCASION_THEMES);
  for (const [i, [a, ta]] of themes.entries()) {
    for (const [b, tb] of themes.slice(i + 1)) {
      if (ta.edge !== tb.edge) continue;
      const d = apart(ta.fill, tb.fill);
      assert.ok(d >= 0.08, `${a} and ${b} share the edge ${ta.edge} and their fills are only ${d.toFixed(3)} apart`);
    }
  }
  // The brief's three: Ramadan night blue, the Eids deep green — each with gold and a crescent or a lantern.
  assert.deepEqual([OCCASION_THEMES.ramadan.fill, OCCASION_THEMES.ramadan.edge], ['color-sky-900', 'color-gold-fill']);
  assert.deepEqual([OCCASION_THEMES.eid_al_fitr.fill, OCCASION_THEMES.eid_al_fitr.edge], ['color-emerald-900', 'color-gold-fill']);
  assert.deepEqual([OCCASION_THEMES.eid_al_adha.fill, OCCASION_THEMES.eid_al_adha.edge, OCCASION_THEMES.eid_al_adha.medal], ['color-teal-950', 'color-gold-fill', 'color-gold-fill']);
  for (const key of ['ramadan', 'eid_al_fitr', 'eid_al_adha'] as const) {
    assert.match(String(OCCASION_THEMES[key].icon.displayName ?? ''), /^(LampCeiling|Moon|MoonStar)$/, `${key}: a crescent or a lantern`);
  }
});

/* ------------------------------------------------------------ the words -- */

test('every preset in three languages: its name, its sentence and its price label; the Sorani its own', () => {
  const ARABIC_ONLY = /[ةىيك]/;
  const SORANI = /[کیەۆێڵڕ]/;
  const SCRIPT = /[؀-ۿ]/;
  for (const key of OFFER_OCCASION_PRESETS) {
    for (const part of ['name', 'sr', 'price'] as const) {
      const w = OFFER_OCCASIONS[key][part];
      for (const lang of ['ar', 'en', 'ckb'] as const) assert.ok(w[lang].trim(), `${key}.${part}.${lang}`);
      assert.notEqual(w.ckb, w.ar, `${key}.${part}: the Sorani is not the Arabic`);
      assert.doesNotMatch(w.ckb, ARABIC_ONLY, `${key}.${part}.ckb uses an Arabic-only letter: ${w.ckb}`);
      assert.match(w.ckb, SORANI, `${key}.${part}.ckb is written in Sorani letters`);
      assert.doesNotMatch(w.ar, SORANI, `${key}.${part}.ar uses a Sorani letter: ${w.ar}`);
      assert.doesNotMatch(w.en, SCRIPT, `${key}.${part}.en is English`);
    }
  }
  assert.equal(OFFER_OCCASIONS.black_friday.name.ar, 'بلاك فرايدي');
  assert.equal(OFFER_OCCASIONS.black_friday.price.ar, 'سعر بلاك فرايدي');
  assert.equal(OFFER_OCCASIONS.black_friday.name.ckb, 'بلاک فرایدەی');
  for (const part of ['name', 'sr', 'price'] as const) assert.notEqual(CUSTOM_OCCASION_FALLBACK[part].ckb, CUSTOM_OCCASION_FALLBACK[part].ar);
  assert.equal(CUSTOM_OCCASION_FALLBACK.name.ar, 'عرض خاص');
  assert.equal(CUSTOM_OCCASION_FALLBACK.name.en, 'Special deal');
  assert.equal(CUSTOM_OCCASION_FALLBACK.name.ckb, 'ئۆفەری تایبەت');
  // A key this build does not know has no words, and so no tag.
  assert.equal(occasionWords('a_future_occasion', null, 'ar'), null);
});

/* ---------------------------------------------------------- the product page -- */

test('the product page: a larger tag at the gallery’s top-end and «سعر بلاك فرايدي», lazy, only while the sale lowers what is on screen', () => {
  const tag = wrap(createElement(OccasionTag, { badge: 'black_friday', lang: 'ar', size: 'page' }));
  assert.match(tag, /data-occasion="black_friday" data-occasion-size="page" data-theme="dark"/);
  assert.match(tag, /text-\[13px\]/);
  const price = (lang: 'ar' | 'en' | 'ckb', badge: string, name?: { ar: string; en?: string; ckb?: string }) =>
    wrap(createElement(OccasionPriceLabel, { badge, name: name ?? null, lang, fallback: 'FALLBACK' }), lang);
  assert.match(price('ar', 'black_friday'), />سعر بلاك فرايدي</);
  assert.match(price('en', 'black_friday'), />Black Friday price</);
  assert.match(price('ckb', 'black_friday'), />نرخی بلاک فرایدەی</);
  assert.match(price('ar', 'custom', { ar: 'عيد الحب' }), />سعر عيد الحب</);
  assert.match(price('ckb', 'custom', { ar: 'عيد الحب' }), />نرخی ئۆفەر</, 'a Sorani reader without a Sorani name reads the page’s own «سعر العرض»');
  assert.match(price('ar', 'a_future_occasion'), />FALLBACK</, 'an unknown key keeps the page’s label');
  const page = readFileSync('src/pages/Product.tsx', 'utf8');
  assert.match(page, /const loadOccasionTag = \(\) => import\('\.\.\/components\/ui\/OccasionTag'\);/, 'a lazy chunk: the opening never carries the tags');
  assert.doesNotMatch(page, /^import [^;]*OccasionTag/m, 'never a static import of the page');
  assert.match(page, /const pageOccasion = occasionOnPage\(product\.offer, offerBefore\);/);
  assert.match(page, /<span data-gallery-occasion className="pointer-events-none absolute top-3 end-3 z-\[1\] flex max-w-\[calc\(100%-1\.5rem\)\]">/);
  assert.match(page, /<OccasionPriceLabel badge=\{pageOccasion\.badge\} name=\{pageOccasion\.badge_text\} lang=\{occasionLang\} fallback=\{SALE_PRICE\[occasionLang\]\} \/>/);
});
