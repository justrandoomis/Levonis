/**
 * THE SALE'S OCCASION ON THE CARD AND THE PAGE — ONE OBLIQUE CORNER RIBBON (DECISIONS row 294;
 * docs/ux/PRODUCT-DISCOUNT.md §16).
 *
 * The owner, of the first design (a pill stacked over the «−N٪» chip, the sale's clock across the photo):
 * «very bad design . the label on product should be only on top left corner sloping < oblique > . no need
 * for big button or date. the goal is modern and clean design < clay morphism style >».
 *
 * Rendered for real (renderToStaticMarkup) in Arabic, English and Sorani:
 *   - the ribbon is its own chunk: until it lands the photo's corner is bare, and the sale's «−N٪» is in
 *     the price line from the first draw;
 *   - every preset and a custom name draw ONE band at 45° across a grid card's top-left photo corner
 *     (top-right in English, where top-left holds the compare toggle) — and nothing else on the photo: no
 *     pill, no chip, no clock; the «−N٪» stands beside the struck price, and the sentence a screen reader
 *     hears is beside it, inside the card's link (the band itself is decoration);
 *   - a list row's 96 px photograph wears the ribbon's wordless FLAG, and the row names the occasion beside
 *     its «−N٪»;
 *   - no ribbon when the card's own sale does not lower its «from» (`price_source: 'ladder'`), for a viewer
 *     locked out of a members-only sale, or for an occasion this build cannot draw — which is then an
 *     ordinary sale, chip and clock; a sale WITHOUT an occasion is exactly as it was; the two gates;
 *   - the band keeps clear of the compare toggle and of the photograph's middle on the narrowest card, and
 *     every preset's name sits in its band WHOLE in all three languages: its width within the band's room,
 *     5 px of fill from both cut edges, its ink — the Arabic and Sorani marks above and below the line
 *     included — between the band's two edges (measured: tests/fixtures/occasionTagWidths.json);
 *   - THE DESIGN SYSTEM'S RULES, computed: only fixed tokens, named tones and palette shades the shop
 *     already uses (inside a dark island, so one design in both themes); one edge treatment per band (a
 *     trim, or a solid band's own lit rim and pressed base); a small contact shadow in the page's own clay
 *     ink, straight down the screen in both directions; the ink 4.5:1 on its fill; every band standing off a
 *     black or white photograph, each tray and each gallery surface; no two designs alike; no zinc, blur,
 *     arbitrary shadow or radius;
 *   - the words: every preset in three languages, the Sorani its own and in Sorani letters;
 *   - the product page: the ribbon at the gallery's scale and «سعر بلاك فرايدي» as quiet text, lazy, mounted
 *     only while the sale lowers the selection on screen; one small clock line, never a banner;
 *   - the miniature (picker tiles, the /offers chips, the offers tab's rows): the band across a small tray
 *     beside the name.
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
import ProductCard, { DRAWN_OCCASIONS } from '../src/components/home/ProductCard';
import OccasionTag, { BEVEL, OCCASION_RIBBONS, OCCASION_THEMES, OccasionPriceLabel, ribbonGeometry } from '../src/components/ui/OccasionTag';
import { occasionOnCard, occasionOnPage } from '../src/components/ui/OfferBadge';
import {
  CUSTOM_OCCASION_FALLBACK,
  OFFER_OCCASION_KEYS,
  OFFER_OCCASION_PRESETS,
  OFFER_OCCASIONS,
  occasionWords,
  type OfferOccasionKey,
} from '../packages/contracts/src/offerOccasions';
import { buildBlock, contrast, currentBlock, parseColor, rgbToOklch, FIXED } from '../scripts/theme-tokens.mjs';
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

type Lang = 'ar' | 'en' | 'ckb';
const LANGS: readonly Lang[] = ['ar', 'en', 'ckb'];
type Worded = 'card' | 'page';

/** The chip of a live sale, as it has always been drawn (a sale without an occasion). */
const CHIP = (lang: Lang) =>
  lang === 'en' ? '−17%</bdi><span class="sr-only">17% off</span>' : lang === 'ckb' ? '−17٪</bdi><span class="sr-only">17٪ داشکاندن</span>' : '−17٪</bdi><span class="sr-only">تخفيض 17٪</span>';
/** The «−N٪» an occasion card prints beside its struck price, and the sentence a screen reader hears. */
const SAVING = (lang: Lang) =>
  `<bdi dir="ltr" class="text-text-muted line-through tabular-nums">900,000</bdi><bdi dir="ltr" aria-hidden="true" data-card-saving="true" class="shrink-0 font-bold text-success tabular-nums">${lang === 'en' ? '−17%' : '−17٪'}</bdi><span class="sr-only">${lang === 'en' ? '17% off' : lang === 'ckb' ? '17٪ داشکاندن' : 'تخفيض 17٪'}</span>`;
/** The sale's clock, in each language (Countdown). */
const CLOCK = /ينتهي خلال|Ends in|کۆتایی دێت لە/;

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
/** The photograph of a card (everything before its link). */
const photoOf = (html: string) => {
  const m = /<div data-motion-photo="true"[^>]*>([\s\S]*?)<\/div><a /.exec(html);
  assert.ok(m, 'the photograph');
  return m![1];
};
/** The card's link: everything a screen reader hears as the product. */
const linkOf = (html: string) => {
  const m = /<a [^>]*data-motion-copy="true"[^>]*>([\s\S]*?)<\/a>/.exec(html);
  assert.ok(m, 'the card’s link');
  return m![1];
};
const ISLAND = 'flex h-full items-center justify-center border-y border-[var(--occ-edge)] bg-[var(--occ-fill)] font-bold';
/**
 * A worded ribbon's own markup: the band (where it lies, its cast), the island (its colours, its type), its
 * name — and, on the product page, its sentence. On a card the whole band is decoration.
 */
const RIBBON = (key: string, size: Worded, name: string, sr: string) =>
  new RegExp(
    `<span ${size === 'card' ? 'aria-hidden="true" ' : ''}data-occasion="${key}" data-occasion-size="${size}" class="pointer-events-none absolute z-\\[1\\]" style="([^"]*)"><span data-theme="dark" dir="(rtl|ltr)" class="${escape(ISLAND)}" style="([^"]*)"><span aria-hidden="true" class="truncate text-\\[var\\(--occ-ink\\)\\]" style="max-width:${OCCASION_RIBBONS[size].room}px">${escape(name)}</span></span>${size === 'page' ? `<span class="sr-only">${escape(sr)}</span>` : ''}</span>`
  );
/** A list row's flag: the same band, no words. */
const FLAG = (key: string) =>
  new RegExp(
    `<span aria-hidden="true" data-occasion="${key}" data-occasion-size="list" class="pointer-events-none absolute z-\\[1\\]" style="([^"]*)"><span data-theme="dark" dir="(rtl|ltr)" class="${escape(ISLAND)}" style="([^"]*)"></span></span>`
  );
/** The band's own style: where it lies, which way it turns, and its cast. */
const placed = (size: keyof typeof OCCASION_RIBBONS, lang: Lang) => {
  const g = ribbonGeometry(size, lang !== 'en') as Record<string, number | string>;
  const side = lang === 'en' ? 'right' : 'left';
  return `top:${g.top}px;${side}:${g[side]}px;width:${g.width}px;height:${g.height}px;transform:rotate(${lang === 'en' ? 45 : -45}deg);box-shadow:${lang === 'en' ? 1 : -1}px 1px 2px var(--clay-ambient)`;
};
/** The end of a worded island's style: the name's type and the lift under it. */
const typed = (size: Worded, lang: Lang) =>
  `font-size:${OCCASION_RIBBONS[size].type}px;line-height:2${lang === 'en' ? '' : `;padding-bottom:${OCCASION_RIBBONS[size].lift}px`}`;
/** The words inside a card's link: the sentence alone (a grid card), or the name and its sentence (a list row). */
const SR = (key: string, sr: string) => `<span data-occasion="${key}" data-occasion-size="sr" class="sr-only">${sr}</span>`;
const NAME = (key: string, name: string, sr: string) =>
  `<span data-occasion="${key}" data-occasion-size="name" class="min-w-0 truncate font-bold"><span aria-hidden="true">· ${name}</span><span class="sr-only">${sr}</span></span>`;

/* ------------------------------------------------------------ the card -- */

test('the ribbon is its own chunk: the corner is bare until it lands — the «−N٪» is in the price line from the first draw', async () => {
  const src = readFileSync('src/components/home/ProductCard.tsx', 'utf8');
  assert.match(src, /^import type \{ OccasionTagProps \} from '\.\.\/ui\/OccasionTag';$/m, 'a type, never the module: the card’s chunk carries no ribbon');
  assert.doesNotMatch(src, /^import OccasionTag\b/m);
  assert.match(src, /React\.lazy<React\.ComponentType<OccasionTagProps>>\(\(\) =>\s*import\('\.\.\/ui\/OccasionTag'\)\.catch\(\(\) => \(\{ default: \(\) => null \}\)\)\s*\)/, 'a chunk that does not arrive draws nothing');
  assert.equal((src.match(/<React\.Suspense fallback=\{null\}>\s*<OccasionTag badge=\{occasion\.badge\}/g) ?? []).length, 2, 'the ribbon lies over the photo and the words are an extra: nothing to hold a place for');
  assert.doesNotMatch(src, /TAG_PLACE|data-photo-badges|data-card-occasion/, 'the stacked pill and the row’s tag are gone');
  // The first draw, before the chunk (this file's first card with an occasion): no ribbon, no chip, no clock — the sale's «−N٪» by its price.
  const first = card(sale({ badge: 'black_friday' }));
  assert.doesNotMatch(first, /data-occasion=/);
  assert.doesNotMatch(first, /bg-rose-600/);
  assert.doesNotMatch(first, CLOCK);
  assert.ok(first.includes(SAVING('ar')), 'the «−N٪» beside the struck price at once');
  // …then the ribbon, once its chunk has landed (every test below renders it).
  for (let i = 0; i < 100 && !card(sale({ badge: 'black_friday' })).includes('data-occasion="black_friday"'); i++) await new Promise((r) => setTimeout(r, 10));
  assert.match(card(sale({ badge: 'black_friday' })), /data-occasion="black_friday"/);
});

test('every preset: ONE oblique ribbon across the photo’s top corner and nothing else on it; its «−N٪» and its sentence beside the struck price, inside the link', () => {
  for (const key of OFFER_OCCASION_PRESETS) {
    for (const lang of LANGS) {
      const html = card(sale({ badge: key }), lang);
      const w = OFFER_OCCASIONS[key];
      const photo = photoOf(html);
      const found = RIBBON(key, 'card', w.name[lang], w.sr[lang]).exec(photo);
      assert.ok(found, `${key} ${lang}: its ribbon on the photograph, decoration only`);
      const [, style, dir, island] = found!;
      // Top-left in Arabic and Sorani (up to the right), top-right in English (down to the right).
      assert.equal(style, placed('card', lang), `${key} ${lang}: where the band lies`);
      assert.equal(dir, lang === 'en' ? 'ltr' : 'rtl');
      assert.ok(island.endsWith(typed('card', lang)), `${key} ${lang}: ${island}`);
      // Nothing else on the photograph: no pill, no «−N٪» chip, no clock.
      assert.equal((photo.match(/data-occasion=/g) ?? []).length, 1, `${key} ${lang}: one ribbon`);
      assert.doesNotMatch(html, /bg-rose-600|data-photo-badges/, `${key} ${lang}: no chip, no stack`);
      assert.doesNotMatch(html, CLOCK, `${key} ${lang}: no clock`);
      // The sale's «−N٪» stands in the price line, beside the price it was taken from — and the occasion's
      // sentence right after it, inside the card's link, read once.
      assert.ok(linkOf(html).includes(SAVING(lang) + SR(key, w.sr[lang])), `${key} ${lang}: the «−N٪» and the sentence by the struck price`);
      assert.equal(html.split(`>${w.sr[lang]}<`).length, 2, `${key} ${lang}: the sentence is read once`);
    }
  }
});

test('a custom name: the owner’s words in each language, the generic words where one is missing — never the Arabic in Sorani', () => {
  const name = { ar: 'عيد الحب', en: 'Valentine' };
  assert.match(card(sale({ badge: 'custom', badge_text: name }), 'ar'), RIBBON('custom', 'card', 'عيد الحب', 'تخفيض عيد الحب'));
  assert.ok(card(sale({ badge: 'custom', badge_text: name }), 'ar').includes(SR('custom', 'تخفيض عيد الحب')));
  assert.match(card(sale({ badge: 'custom', badge_text: name }), 'en'), RIBBON('custom', 'card', 'Valentine', 'Valentine discount'));
  const ckb = card(sale({ badge: 'custom', badge_text: name }), 'ckb');
  assert.match(ckb, RIBBON('custom', 'card', CUSTOM_OCCASION_FALLBACK.name.ckb, CUSTOM_OCCASION_FALLBACK.sr.ckb));
  assert.doesNotMatch(ckb, /عيد الحب/, 'the Arabic name never reaches a Sorani reader');
  // A name longer than the band holds ends in an ellipsis (`truncate` within the ribbon's room), never runs off the photo.
  const long = card(sale({ badge: 'custom', badge_text: { ar: 'تخفيضات نهاية الموسم الكبرى' } }));
  assert.match(long, new RegExp(`class="truncate text-\\[var\\(--occ-ink\\)\\]" style="max-width:${OCCASION_RIBBONS.card.room}px">تخفيضات نهاية الموسم الكبرى<`));
});

test('an occasion this build cannot draw is an ordinary sale: its chip, its clock — never a bare photograph', () => {
  // A newer Worker's key read by an older copy of the app, a custom occasion without its Arabic name.
  for (const offer of [{ badge: 'a_future_occasion' }, { badge: 'custom' }, { badge: 'custom', badge_text: { en: 'Valentine' } }, { badge: 'custom', badge_text: { ar: '  ' } }]) {
    for (const layout of ['grid', 'list'] as const) {
      const html = card(sale(offer), 'ar', { layout });
      const why = `${JSON.stringify(offer)} ${layout}`;
      assert.doesNotMatch(html, /data-occasion=/, `${why}: no ribbon, no words`);
      assert.match(photoOf(html), /bg-rose-600 text-snow absolute top-2 end-2"><bdi dir="ltr" aria-hidden="true">−17٪/, `${why}: the chip`);
      assert.match(photoOf(html), CLOCK, `${why}: the clock`);
      assert.doesNotMatch(html, /data-card-saving/, `${why}: the price line as on any sale`);
    }
  }
});

test('no ribbon where the sale does not lower this card, or this viewer is locked out; a sale WITHOUT an occasion is exactly as it was', () => {
  const cases: Array<[string, ApiProduct]> = [
    ['a sale above the card’s «from» (price_source ladder)', sale({ badge: 'black_friday', price_source: 'ladder' }, { display_offer_before_iqd: null, display_offer_saving_percent: null })],
    ['a members-only sale this viewer may not take', sale({ badge: 'black_friday', price_source: 'ladder', locked: true }, { display_offer_before_iqd: null, display_offer_saving_percent: null })],
    ['no offer block', sale({}, { offer: null })],
  ];
  for (const [why, p] of cases) {
    const html = card(p);
    assert.doesNotMatch(html, /data-occasion=/, why);
    assert.doesNotMatch(html, /data-card-saving/, why);
  }
  // A sale with no occasion: the chip alone in its corner and the sale's clock, as before — in every language and both layouts.
  for (const lang of LANGS) {
    const plain = card(sale(), lang);
    assert.match(photoOf(plain), new RegExp(`bg-rose-600 text-snow absolute top-2 end-2"><bdi dir="ltr" aria-hidden="true">${escape(CHIP(lang))}`), `${lang}: the chip`);
    assert.match(photoOf(plain), /<span class="absolute bottom-1\.5 start-1\.5 rounded-sm bg-onyx\/80 px-1\.5 py-0\.5">/, `${lang}: the clock's pill`);
    assert.match(photoOf(plain), CLOCK, `${lang}: its words`);
    assert.doesNotMatch(plain, /data-card-saving|data-occasion=/, `${lang}: the price line is as it was`);
    const row = card(sale(), lang, { layout: 'list' });
    assert.match(photoOf(row), /bg-rose-600 text-snow absolute top-2 end-2"><bdi/, `${lang}: the row's chip`);
    assert.match(photoOf(row), CLOCK, `${lang}: the row's clock`);
  }
  const locked = card(sale({ price_source: 'ladder', locked: true }, { display_offer_before_iqd: null, display_offer_saving_percent: null }));
  assert.match(locked, /lv-chip \[--chip:var\(--color-gold\)\] absolute top-2 end-2 gap-1"><span data-offer-locked/);
  // The source: the occasion takes the clock off its own card only.
  const src = readFileSync('src/components/home/ProductCard.tsx', 'utf8');
  assert.equal((src.match(/const occasion = priced \? drawnOccasion\(p\.offer\) : null;/g) ?? []).length, 2, 'both cards ask the same gate');
  assert.equal((src.match(/const clock = priced && !occasion \? offerClock\(p\) : null;/g) ?? []).length, 2, 'no clock beside a ribbon, on either card');
  assert.match(src, /if \(!occasion\) return <SaleChip p=\{p\} hasSale=\{hasSale\} className="absolute top-2 end-2" \/>;/, 'no occasion: the chip, where it always was');
});

test('a list row: its 96 px photograph wears the wordless flag and nothing else; the row names the occasion beside its «−N٪», inside the link', () => {
  for (const key of OFFER_OCCASION_PRESETS) {
    for (const lang of LANGS) {
      const w = OFFER_OCCASIONS[key];
      const list = card(sale({ badge: key }), lang, { layout: 'list' });
      const photo = photoOf(list);
      const found = FLAG(key).exec(photo);
      assert.ok(found, `${key} ${lang}: the flag`);
      assert.equal(found![1], placed('list', lang), `${key} ${lang}: where the flag lies`);
      assert.doesNotMatch(found![3], /font-size/, `${key} ${lang}: no words on the flag`);
      assert.equal((photo.match(/data-occasion=/g) ?? []).length, 1, `${key} ${lang}: one flag`);
      assert.doesNotMatch(photo, /bg-rose-600/, `${key} ${lang}: no chip`);
      assert.doesNotMatch(list, CLOCK, `${key} ${lang}: no clock`);
      assert.ok(linkOf(list).includes(SAVING(lang) + NAME(key, w.name[lang], w.sr[lang])), `${key} ${lang}: «−17٪ · ${w.name[lang]}» by the struck price`);
      assert.equal(list.split(`>${w.sr[lang]}<`).length, 2, `${key} ${lang}: the sentence is read once`);
    }
  }
});

test('the band keeps clear of the compare toggle and of the photograph’s middle, on the narrowest card and on a row', () => {
  const src = readFileSync('src/components/home/ProductCard.tsx', 'utf8');
  assert.match(src, /className="absolute top-1\.5 start-1\.5 z-\[2\]"/, 'the compare toggle keeps its corner (the card’s top-START)');
  assert.match(src, /\$\{list \? 'size-24 shrink-0' : 'mx-1 mt-1 aspect-\[6\/5\]'\}/, 'the photographs: 4 px inside a grid card, 96 px in a row');
  assert.match(src, /\$\{list \? 'flex-row p-2\.5 gap-3' : 'flex-col'\}/, 'a row is padded 10 px');
  assert.match(readFileSync('src/components/compare/CompareToggle.tsx', 'utf8'), /className=\{`lv-hit grid size-\[30px\] place-items-center rounded-full/, 'the 30 px disc');
  // The ribbon takes the photo's top-END corner (left in Arabic and Sorani, right in English): the toggle's opposite.
  const printer = sale({ badge: 'black_friday' }, { compare_type: 'printer' } as Partial<ApiProduct>);
  for (const lang of LANGS) {
    for (const layout of ['grid', 'list'] as const) {
      const html = card(printer, lang, { compareToggle: true, layout });
      assert.match(html, /data-compare-toggle=/, 'the toggle is drawn');
      assert.ok(photoOf(html).includes(placed(layout === 'list' ? 'list' : 'card', lang)), `${lang} ${layout}: the end corner`);
    }
  }
  /**
   * The geometry, in px, measured from the photograph's END corner along its top and side edges: the band's
   * far edge is the line x + y = reach + band/√2. The toggle's 30 px disc sits 6 px into the card's padding
   * box at its start, the photograph 4 px (a grid card) or 10 px (a row) into it — so the disc's centre is
   * as far from the photo's top as from its start edge, and lies on x + y = the photo's width.
   */
  const far = (size: keyof typeof OCCASION_RIBBONS) => OCCASION_RIBBONS[size].reach + OCCASION_RIBBONS[size].band / Math.SQRT2;
  const clearance = (size: keyof typeof OCCASION_RIBBONS, width: number) => (width - far(size)) / Math.SQRT2 - 15;
  /** From the band to the photograph's centre, along the diagonal. */
  const toCentre = (size: keyof typeof OCCASION_RIBBONS, width: number, height: number) => ((width + height) / 2 - far(size)) / Math.SQRT2;
  // THE NARROWEST PHOTOGRAPH: a grid card two across a 320 px phone — (320 − 42) / 2 = 139 px, its photo
  // 139 − 2 − 8 = 129 px wide and 6:5 (the home rail's 148 px card has a 138 px one).
  assert.match(src, /calc\(\(100vw - 42px\) \/ 2\)';/, 'two across a phone, 42 px of gutters and gap');
  assert.match(readFileSync('src/components/home/v2/LatestProducts.tsx', 'utf8'), /widthClass="w-\[148px\] shrink-0 lg:w-full"/, 'the rail card is still 148 px');
  const PHONE = (320 - 42) / 2 - 2 * 1 - 2 * 4;
  const RAIL = 148 - 2 * 1 - 2 * 4;
  for (const [what, w] of [['a 320 px phone’s grid card', PHONE], ['the rail card', RAIL]] as const) {
    assert.ok(clearance('card', w) >= 20, `${what}: ${clearance('card', w).toFixed(1)} px from the toggle`);
    assert.ok(toCentre('card', w, (w * 5) / 6) >= 30, `${what}: ${toCentre('card', w, (w * 5) / 6).toFixed(1)} px short of the photograph's centre`);
  }
  assert.ok(clearance('list', 96) >= 20, `a list row: ${clearance('list', 96).toFixed(1)} px`);
  assert.ok(toCentre('list', 96, 96) >= 30, 'the flag stays in its corner');
  // Slim: the band is at most an eighth of the narrowest photograph across; the flag lies within the row photo's first ~40 %.
  assert.ok(OCCASION_RIBBONS.card.band <= PHONE / 8);
  assert.ok(far('list') <= 96 * 0.45, `the flag reaches ${far('list').toFixed(1)} px into the row's photograph`);
});

test('the two gates: a card draws the occasion only when its own «from» is the sale’s, the page only while the selection on screen is lowered — and only an occasion this build draws', () => {
  const friday = { badge: 'black_friday', price_source: 'offer' };
  assert.equal(occasionOnCard(friday), friday);
  assert.equal(occasionOnCard({ ...friday, price_source: 'ladder' }), null, 'a sale on a dearer model alone: the card strikes nothing, names nothing');
  assert.equal(occasionOnCard({ price_source: 'offer' }), null, 'a sale with no occasion');
  assert.equal(occasionOnCard(null), null);
  assert.equal(occasionOnCard(undefined), null);
  assert.equal(occasionOnPage(friday, 900_000), friday, 'the selection on screen is lowered (its struck price)');
  assert.equal(occasionOnPage(friday, null), null, 'a selection the sale does not lower: no ribbon, no «سعر بلاك فرايدي»');
  assert.equal(occasionOnPage({}, 900_000), null);
  assert.equal(occasionOnPage(null, 900_000), null);
  // THE CARD ALSO ASKS WHETHER THIS BUILD DRAWS IT (`drawnOccasion`, rendered above: an occasion it cannot
  // draw is an ordinary sale). Its own list of keys, kept out of the contract's words — the contract's list,
  // every one drawn. The page needs no such check: its ribbon is lazy, and its label falls back (below).
  assert.deepEqual([...DRAWN_OCCASIONS].sort(), [...OFFER_OCCASION_KEYS].sort(), 'DRAWN_OCCASIONS is OFFER_OCCASION_KEYS');
  for (const key of OFFER_OCCASION_PRESETS) assert.ok(occasionWords(key, null, 'ar'), key);
  const src = readFileSync('src/components/home/ProductCard.tsx', 'utf8');
  assert.match(src, /const o = occasionOnCard\(offer\);/, 'the card’s gate builds on the shared one');
  // The list stays in the card's chunk: OfferBadge rides in the product page's opening (tests/bundleBudget.test.ts).
  assert.doesNotMatch(readFileSync('src/components/ui/OfferBadge.tsx', 'utf8'), /black_friday|DRAWN_OCCASIONS/);
  // Both surfaces ask them — the card above, the product page here.
  assert.match(readFileSync('src/pages/Product.tsx', 'utf8'), /const pageOccasion = occasionOnPage\(product\.offer, offerBefore\);/);
});

test('every preset’s name sits in its band whole, in all three languages: within its room, 5 px from both cut edges, its ink between the two edges (measured)', () => {
  const measured = JSON.parse(readFileSync('tests/fixtures/occasionTagWidths.json', 'utf8')) as {
    ribbons: Record<Worded, { type: number; band: number; lift: number; measuredBand: number; baseline: Record<Lang, number> }>;
    widths: Record<Worded, Record<Lang, Record<string, [string, number]>>>;
    ink: Record<Lang, Record<string, [string, number, number]>>;
  };
  const worded = (Object.keys(OCCASION_RIBBONS) as Array<keyof typeof OCCASION_RIBBONS>).filter((s) => OCCASION_RIBBONS[s].room > 0);
  assert.deepEqual(worded.sort(), ['card', 'page'], 'the card and the gallery carry words; the list row’s flag none');
  assert.deepEqual(Object.keys(measured.ribbons).sort(), ['card', 'page'], 'one measurement per worded ribbon');
  for (const size of ['card', 'page'] as const) {
    const r = OCCASION_RIBBONS[size];
    const m = measured.ribbons[size];
    assert.deepEqual([m.type, m.band, m.lift], [r.type, r.band, r.lift], `the ${size} ribbon changed since it was measured: measure it again (the file says how)`);
    assert.equal(m.measuredBand, r.band, `${size}: the band drew ${m.measuredBand} px`);
    const centre = r.band / 2;
    for (const lang of LANGS) {
      // The name's baseline: an Arabic or Sorani one lifted to just under the band's centre (0.15–0.23 em), where
      // every preset's ink — the marks above and below the line — is centred; an English one where Cairo puts it
      // (0.33–0.40 em), which centres its capitals.
      const baseline = m.baseline[lang];
      const below = (baseline - centre) / r.type;
      const [lo, hi] = lang === 'en' ? [0.33, 0.4] : [0.15, 0.23];
      assert.ok(below >= lo && below <= hi, `${size} ${lang}: the baseline sits ${below.toFixed(3)} em under the centre`);
      const expected: Array<[string, string]> = OFFER_OCCASION_PRESETS.map((key) => [key, OFFER_OCCASIONS[key].name[lang]]);
      // The custom fallback is what English and Sorani show when the owner typed no name in them; Arabic always shows the owner's own.
      if (lang !== 'ar') expected.push(['custom', CUSTOM_OCCASION_FALLBACK.name[lang]]);
      assert.deepEqual(Object.keys(measured.widths[size][lang]).sort(), expected.map(([k]) => k).sort(), `${size} ${lang}: one measurement per name, none stale`);
      for (const [key, name] of expected) {
        const [said, px] = measured.widths[size][lang][key];
        const [inked, asc, desc] = measured.ink[lang][key];
        assert.equal(said, name, `${size} ${lang} ${key}: renamed since it was measured — measure it again`);
        assert.equal(inked, name, `${lang} ${key}: its ink was measured for another name`);
        const what = `${size} ${lang} ${key} «${name}»`;
        // Whole: never cut by the name's own room.
        assert.ok(px <= r.room, `${what}: ${px} px in a ${r.room} px room`);
        // Inside the band, top to bottom: the marks above and below the line — the hamza, the dots of ي, the v under ڕ — clear of both 1 px edges.
        const top = baseline - asc * r.type;
        const bottom = baseline + desc * r.type;
        assert.ok(top >= 1 + 0.5, `${what}: its ink reaches ${top.toFixed(2)} px from the band's top edge`);
        assert.ok(bottom <= r.band - 1 - 0.5, `${what}: its ink reaches ${(r.band - bottom).toFixed(2)} px from the band's bottom edge`);
        // Along the band: at the ink's top corner, where the band is shortest (√2·reach − 2·its reach toward the corner), 5 px of fill at each end.
        const toward = centre - top;
        const end = (r.reach * Math.SQRT2 - 2 * toward - px) / 2;
        assert.ok(end >= 5, `${what}: ${end.toFixed(1)} px from the photograph's cut edge`);
      }
    }
    // A name longer than the room ends in its ellipsis with at least 4.5 px to spare, even under the tallest preset mark (the hamza of «الأضحى»).
    const tallest = Math.max(...Object.values(measured.ink).flatMap((l) => Object.values(l).map(([, asc]) => asc)));
    const highest = Math.min(...LANGS.map((l) => m.baseline[l])) - tallest * r.type;
    assert.ok((r.reach * Math.SQRT2 - 2 * (centre - highest) - r.room) / 2 >= 4.5, `${size}: the room leaves the cut edges too close`);
  }
});

/* ------------------------------------------------------ the design rules -- */

const block = buildBlock();
/** Every colour the generator writes for a dark island: the palette shades in use, the tones, the roles. */
const darkVars: Record<string, string> = Object.fromEntries(
  [...block.slice(block.indexOf("[data-theme='dark']")).matchAll(/--color-([a-z0-9-]+):([^;}]+)/g)].map((m) => [m[1], m[2].trim()])
);
/**
 * A token as the ribbon reads it (`color-violet-950` = `var(--color-violet-950)`): inside its dark island,
 * the generated dark value — or one of the three FIXED colours (snow, onyx, gold-fill: the same in both
 * themes, for text on a photograph or a fill), which other utilities keep in every page's stylesheet.
 */
const colour = (value: string | null): string => {
  const m = /^color-([a-z0-9-]+)$/.exec(value ?? '');
  assert.ok(m, `${value} is not a colour token`);
  const v = darkVars[m![1]] ?? (FIXED as Record<string, string>)[m![1]];
  assert.ok(v, `--color-${m![1]} is neither a generated nor a fixed colour`);
  return v;
};
type Rgb = number[];
const ratio = (a: string | Rgb, b: string | Rgb) => contrast(typeof a === 'string' ? parseColor(a) : a, typeof b === 'string' ? parseColor(b) : b);
/** A translucent edge over the band's own fill, composited as a browser does (in sRGB): the solid band's lit rim and pressed base. */
const over = (fill: string, rgba: string): Rgb => {
  const m = /^rgb\((\d+) (\d+) (\d+) \/ ([\d.]+)\)$/.exec(rgba);
  assert.ok(m, rgba);
  const a = Number(m![4]);
  return parseColor(fill).map((v, i) => v * (1 - a) + (Number(m![i + 1]) / 255) * a);
};
/** What a ribbon lies on: the dark photo tray, the light tray, a black and a white photograph, the gallery's surface in both themes, the dark selected fill. */
const GROUNDS = ['#0e1013', '#ddd4c3', '#000000', '#ffffff', '#ebe4d6', '#131519', '#20242a'];
/** A colour in OKLab (L, a, b), from the value the island resolves. */
const lab = (token: string) => {
  const [L, C, H] = rgbToOklch(parseColor(colour(token)));
  return [L, C * Math.cos((H * Math.PI) / 180), C * Math.sin((H * Math.PI) / 180)];
};
const apart = (a: string, b: string) => Math.hypot(...lab(a).map((v, i) => v - lab(b)[i]));

test('one design per occasion, from the system’s own tokens, flat clay at rest: one edge treatment, a contact shadow in the page’s ink, no zinc, blur, arbitrary shadow or radius', () => {
  const themes = Object.entries(OCCASION_THEMES) as Array<[OfferOccasionKey, (typeof OCCASION_THEMES)[OfferOccasionKey]]>;
  assert.deepEqual(themes.map(([k]) => k).sort(), [...OFFER_OCCASION_KEYS].sort(), 'every key has a design');
  const looks = new Set<string>();
  for (const [key, t] of themes) {
    looks.add(JSON.stringify([t.fill, t.ink, t.trim]));
    for (const v of [t.fill, t.ink, ...(t.trim ? [t.trim] : [])]) {
      assert.doesNotMatch(v, /zinc/, `${key}: ${v}`);
      colour(v);
    }
  }
  assert.equal(looks.size, themes.length, 'sixteen distinct designs');
  // The brief's identities: Black Friday onyx and gold, White Friday snow and gold, Cyber Monday indigo and cyan,
  // Christmas red and green, Ramadan night blue and gold, both Eids green and gold, back to school yellow, winter ice blue.
  assert.deepEqual(Object.values(OCCASION_THEMES.black_friday), ['color-onyx', 'color-gold-fill', 'color-gold-fill']);
  assert.deepEqual([OCCASION_THEMES.white_friday.fill, OCCASION_THEMES.cyber_monday.trim], ['color-snow', 'color-cyan-500']);
  assert.deepEqual([OCCASION_THEMES.christmas.fill, OCCASION_THEMES.christmas.trim], ['color-red-900', 'color-emerald-500']);
  assert.deepEqual([OCCASION_THEMES.ramadan.fill, OCCASION_THEMES.ramadan.trim], ['color-sky-900', 'color-gold-fill']);
  for (const key of ['eid_al_fitr', 'eid_al_adha'] as const) {
    assert.match(OCCASION_THEMES[key].fill, /emerald|teal/);
    assert.equal(OCCASION_THEMES[key].trim, 'color-gold-fill');
  }
  assert.deepEqual([OCCASION_THEMES.back_to_school.fill, OCCASION_THEMES.winter.fill], ['color-yellow-300', 'color-sky-200']);
  // THREE CLASSES FOR SIXTEEN DESIGNS: the band reads its custom properties, and names no colour utility of its own.
  const src = readFileSync('src/components/ui/OccasionTag.tsx', 'utf8');
  const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\{\/\*[\s\S]*?\*\/\}/g, '');
  for (const cls of ['border-[var(--occ-edge)]', 'bg-[var(--occ-fill)]', 'text-[var(--occ-ink)]']) assert.ok(src.includes(cls), cls);
  assert.deepEqual(src.match(/(?<![\w-])(?:bg|text|border)-(?!\[var\(--occ-)(?:[a-z]+-\d{2,3}|onyx|snow|gold-fill|crimson|flame|petal|cream)\b/g) ?? [], [], 'no colour utility per design');
  assert.match(src, /data-theme="dark"/, 'a dark island: one design in both themes');
  // Written as property names: no `--color-…` in the source, so Tailwind copies none of them into `:root` (the
  // island declares the generated ones) — and the three FIXED ones are there because other utilities use them.
  assert.doesNotMatch(code, /--color-/, 'tokens written as property names: Tailwind copies none into :root');
  const elsewhere = ['src/components/home/ProductCard.tsx', 'src/components/ui/OfferBadge.tsx', 'src/components/Header.tsx'].map((f) => readFileSync(f, 'utf8')).join('\n');
  for (const fixed of ['text-snow', 'bg-onyx', 'bg-gold-fill']) assert.ok(elsewhere.includes(fixed), `${fixed} is a utility of the pages around the ribbon: --color-${fixed.replace(/^(?:text|bg)-/, '')} stays in every stylesheet`);
  // The theme generator has nothing new to write: every shade a ribbon reads is in the committed block already.
  const committed = currentBlock();
  assert.ok(committed, 'the generated block in src/index.css');
  assert.equal(committed, buildBlock(), 'src/index.css is current');
  const committedDark = committed!.slice(committed!.indexOf("[data-theme='dark']"));
  for (const [key, t] of themes) {
    for (const token of [t.fill, t.ink, t.trim]) {
      if (!token || /^color-(snow|onyx|gold-fill)$/.test(token)) continue;
      assert.ok(committedDark.includes(`--${token}:`), `${key}: ${token} is not in the island's block — the stylesheet would grow`);
    }
  }
  // INFORMATION RESTS ON THE PHOTOGRAPH (DECISIONS rows 207, 209): no raised clay on the band — no shadow
  // utility at all — but ONE edge treatment each: a trimmed band's edges are its trims; a solid band's are its
  // own lit rim and pressed base (`BEVEL`, translucent over its fill: the same in both themes).
  assert.doesNotMatch(code, /\bshadow-(?:xs|sm|md|lg|xl|2xl|1|2|3|press|well|dock|inner)\b/, 'no clay level on a label');
  assert.deepEqual(BEVEL, { rim: 'rgb(255 255 255 / 0.28)', base: 'rgb(0 0 0 / 0.3)' });
  assert.match(code, /\.\.\.\(theme\.trim \? null : \{ borderTopColor: BEVEL\.rim, borderBottomColor: BEVEL\.base \}\)/, 'the bevel only where there is no trim');
  // ITS ONE SHADOW: a small contact shadow, on the band OUTSIDE its dark island — so it reads the PAGE's clay
  // ink (warm on cream, black in dark), never the island's black — offset straight down the screen in both
  // directions (row 207: no sideways cast that flips with the language).
  for (const rtl of [true, false]) {
    const g = ribbonGeometry('card', rtl) as { boxShadow: string; transform: string };
    const m = /^(-?\d+)px (-?\d+)px (\d+)px var\(--clay-ambient\)$/.exec(g.boxShadow);
    assert.ok(m, g.boxShadow);
    const [x, y] = [Number(m![1]), Number(m![2])];
    const turn = (Number(/rotate\((-?\d+)deg\)/.exec(g.transform)![1]) * Math.PI) / 180;
    const screen = [x * Math.cos(turn) - y * Math.sin(turn), x * Math.sin(turn) + y * Math.cos(turn)];
    assert.ok(Math.abs(screen[0]) < 1e-9 && screen[1] > 0, `${rtl ? 'rtl' : 'ltr'}: the cast falls (${screen.map((v) => v.toFixed(2)).join(', ')}) on the screen`);
    assert.ok(Number(m![3]) <= 2, 'a contact shadow, not a second card cast');
  }
  const rendered = wrap(createElement(OccasionTag, { badge: 'cyber_monday', lang: 'en' }), 'en');
  assert.match(rendered, /<span aria-hidden="true" data-occasion="cyber_monday" data-occasion-size="card" class="pointer-events-none absolute z-\[1\]" style="[^"]*box-shadow:1px 1px 2px var\(--clay-ambient\)"><span data-theme="dark"/, 'the cast on the band, the island inside it');
  assert.match(rendered, /data-theme="dark" dir="ltr" class="[^"]*" style="--occ-fill:var\(--color-violet-950\);--occ-ink:var\(--color-cyan-300\);--occ-edge:var\(--color-cyan-500\);font-size:/, 'a trimmed band: its trim, no bevel');
  assert.match(wrap(createElement(OccasionTag, { badge: 'singles_day', lang: 'ar' })), /--occ-fill:var\(--color-crimson\);--occ-ink:var\(--color-snow\);--occ-edge:var\(--color-crimson\);border-top-color:rgb\(255 255 255 \/ 0\.28\);border-bottom-color:rgb\(0 0 0 \/ 0\.3\);/, 'a solid band: its own rim and base');
  // The census finds nothing hand-drawn.
  const found = scanSource(src);
  assert.deepEqual([found.legacy.length, found.btn.length, found.arbR.length, found.arbS.length, found.blur.length, found.zinc], [0, 0, 0, 0, 0, 0]);
  assert.doesNotMatch(code, /backdrop-blur|shadow-\[|rounded-\[|dark:|drop-shadow|blur-/);
});

test('contrast, computed: the ink 4.5:1 on its fill; every band stands off every photo, tray and gallery by its fill, its trim or its clay edges (3:1)', () => {
  for (const [key, t] of Object.entries(OCCASION_THEMES)) {
    const fill = colour(t.fill);
    const ink = colour(t.ink);
    assert.ok(ratio(ink, fill) >= 4.5, `${key}: ink ${ratio(ink, fill).toFixed(2)}:1 on its fill`);
    // A trimmed band's edges are its trims; a solid band's its own rim and base.
    const edges: Array<string | Rgb> = t.trim ? [colour(t.trim)] : [over(fill, BEVEL.rim), over(fill, BEVEL.base)];
    for (const g of GROUNDS) {
      const off = Math.max(ratio(fill, g), ...edges.map((e) => ratio(e, g)));
      assert.ok(off >= 3, `${key}: only ${off.toFixed(2)}:1 off ${g}`);
    }
  }
});

test('two designs that share a trim never share a fill’s look (OKLab, ≥ 0.08): Ramadan’s night blue is not Black Friday’s onyx', () => {
  // The measure itself: the first Ramadan (slate-900 on the same gold edge) sat 0.06 from onyx — too close.
  assert.ok(apart('color-slate-900', 'color-onyx') < 0.08, 'the rule would have caught it');
  const themes = Object.entries(OCCASION_THEMES);
  let pairs = 0;
  for (const [i, [a, ta]] of themes.entries()) {
    for (const [b, tb] of themes.slice(i + 1)) {
      if (!ta.trim || ta.trim !== tb.trim) continue;
      pairs++;
      const d = apart(ta.fill, tb.fill);
      assert.ok(d >= 0.08, `${a} and ${b} share the trim ${ta.trim} and their fills are only ${d.toFixed(3)} apart`);
    }
  }
  assert.ok(pairs >= 6, 'the gold-trimmed four are held apart');
});

test('no two designs alike: fills at least 0.08 apart (OKLab), and two near fills (< 0.12) told apart by their edges or their ink (≥ 0.18)', () => {
  // What the rule catches: the first ribbon's 12.12 and summer (flame and orange-500, both with onyx ink, a
  // hairline the only difference), its two Eids (emerald-900 and teal-950 with the same cream and gold), and
  // its Christmas beside Eid al-Adha (emerald-950 and teal-950).
  assert.ok(apart('color-flame', 'color-orange-500') < 0.08);
  assert.ok(apart('color-emerald-900', 'color-teal-950') < 0.12 && apart('color-emerald-950', 'color-teal-950') < 0.08);
  const themes = Object.entries(OCCASION_THEMES);
  for (const [i, [a, ta]] of themes.entries()) {
    for (const [b, tb] of themes.slice(i + 1)) {
      const fill = apart(ta.fill, tb.fill);
      assert.ok(fill >= 0.08, `${a} and ${b}: fills ${fill.toFixed(3)} apart`);
      if (fill >= 0.12) continue;
      const edge = apart(ta.trim ?? ta.fill, tb.trim ?? tb.fill);
      const ink = apart(ta.ink, tb.ink);
      assert.ok(Math.max(edge, ink) >= 0.18, `${a} and ${b}: near fills (${fill.toFixed(3)}) and edges ${edge.toFixed(3)}, inks ${ink.toFixed(3)} apart`);
    }
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
      for (const lang of LANGS) assert.ok(w[lang].trim(), `${key}.${part}.${lang}`);
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
  // A key this build does not know has no words, and so no ribbon.
  assert.equal(occasionWords('a_future_occasion', null, 'ar'), null);
});

/* ---------------------------------------------------------- the product page -- */

test('the product page: the ribbon at the gallery’s scale and «سعر بلاك فرايدي» as quiet text, lazy, only while the sale lowers what is on screen; one small clock line', () => {
  for (const lang of LANGS) {
    const w = OFFER_OCCASIONS.black_friday;
    const tag = wrap(createElement(OccasionTag, { badge: 'black_friday', lang, size: 'page' }), lang);
    const found = RIBBON('black_friday', 'page', w.name[lang], w.sr[lang]).exec(tag);
    assert.ok(found, `${lang}: the gallery's ribbon, with its own sentence`);
    assert.equal(found![1], placed('page', lang));
    assert.ok(found![3].endsWith(typed('page', lang)), found![3]);
  }
  const price = (lang: Lang, badge: string, name?: { ar: string; en?: string; ckb?: string }) =>
    wrap(createElement(OccasionPriceLabel, { badge, name: name ?? null, lang, fallback: 'FALLBACK' }), lang);
  assert.match(price('ar', 'black_friday'), />سعر بلاك فرايدي</);
  assert.match(price('en', 'black_friday'), />Black Friday price</);
  assert.match(price('ckb', 'black_friday'), />نرخی بلاک فرایدەی</);
  assert.match(price('ar', 'custom', { ar: 'عيد الحب' }), />سعر عيد الحب</);
  assert.match(price('ckb', 'custom', { ar: 'عيد الحب' }), />نرخی ئۆفەر</, 'a Sorani reader without a Sorani name reads the page’s own «سعر العرض»');
  assert.match(price('ar', 'a_future_occasion'), />FALLBACK</, 'an unknown key keeps the page’s label');
  const page = readFileSync('src/pages/Product.tsx', 'utf8');
  assert.match(page, /const loadOccasionTag = \(\) => import\('\.\.\/components\/ui\/OccasionTag'\);/, 'a lazy chunk: the opening never carries the ribbons');
  assert.doesNotMatch(page, /^import [^;]*OccasionTag/m, 'never a static import of the page');
  assert.match(page, /const pageOccasion = occasionOnPage\(product\.offer, offerBefore\);/);
  // The ribbon lies in the gallery itself (`relative … overflow-hidden`: its rounded edge cuts the band) — no pill, no wrapper.
  assert.match(page, /className="lv-surface relative w-full h-\[min\(78vw,340px\)\] sm:h-\[420px\] lg:h-\[520px\] xl:h-\[560px\] overflow-hidden" data-gallery-hero>/);
  assert.match(page, /<React\.Suspense fallback=\{null\}>\s*<OccasionTag badge=\{pageOccasion\.badge\} name=\{pageOccasion\.badge_text\} lang=\{occasionLang\} size="page" \/>/);
  assert.doesNotMatch(page, /data-gallery-occasion/, 'the old wrapper is gone');
  // «سعر بلاك فرايدي»: the page's quiet label type, never a pill.
  assert.match(page, /<span data-testid="product-sale-label" className="text-text-secondary text-\[12px\] font-bold">/);
  assert.match(page, /<OccasionPriceLabel badge=\{pageOccasion\.badge\} name=\{pageOccasion\.badge_text\} lang=\{occasionLang\} fallback=\{SALE_PRICE\[occasionLang\]\} \/>/);
  // The sale's end: one small line beside the struck price, never a banner (the page's only two clocks, both 11.5 px text).
  assert.deepEqual(page.match(/<Countdown [^>]*\/>/g), [
    '<Countdown target={product.offer.ends_at} kind="ends" className="text-[11.5px] text-text-secondary" />',
    '<Countdown target={product.offer.starts_at} kind="opens" className="text-[11.5px] text-text-secondary" />',
  ]);
});

/* -------------------------------------------------------- the miniature -- */

test('the miniature beside a name (picker tiles, the /offers chips, the offers tab): the same band across a small tray’s top-end corner', () => {
  for (const lang of LANGS) {
    const html = wrap(createElement(OccasionTag, { badge: 'christmas', lang, size: 'picker' }), lang);
    const m = /^<span data-occasion="christmas" data-occasion-size="picker" class="inline-flex min-w-0 items-center gap-1\.5"><span aria-hidden="true" class="relative h-4 w-5 shrink-0 overflow-hidden rounded bg-border-subtle"><span data-theme="dark" class="absolute inset-0" style="([^"]*)"><\/span><\/span><span class="min-w-0 truncate">([^<]*)<\/span><\/span>$/.exec(html);
    assert.ok(m, `${lang}: ${html}`);
    assert.match(m![1], /^--occ-fill:var\(--color-red-900\);--occ-ink:var\(--color-snow\);--occ-edge:var\(--color-emerald-500\);background-image:linear-gradient\(\d+deg, transparent 0 14%, var\(--occ-edge\) 14% 19%, var\(--occ-fill\) 19% 50%, var\(--occ-edge\) 50% 55%, transparent 55%\)$/);
    assert.match(m![1], new RegExp(`linear-gradient\\(${lang === 'en' ? 225 : 135}deg`), `${lang}: the corner the card's ribbon takes`);
    assert.equal(m![2], OFFER_OCCASIONS.christmas.name[lang], `${lang}: the name, in the chip's own type`);
  }
  // The picker's tiles, the /offers chips and the offers tab's rows all draw it.
  assert.match(readFileSync('src/components/adminProducts/form/OccasionPicker.tsx', 'utf8'), /<OccasionTag badge=\{key\} lang=\{lang\} size="picker" \/>/);
  assert.match(readFileSync('src/pages/Offers.tsx', 'utf8'), /<OccasionTag badge=\{o\.key\} name=\{o\.badge_text\} lang=\{l\} size="picker" \/>/);
  assert.match(readFileSync('src/components/adminOffers/AdminOffers.tsx', 'utf8'), /<OccasionTag badge=\{row\.badge\} name=\{row\.badge_text\} lang=\{lang\} size="picker" \/>/);
});
