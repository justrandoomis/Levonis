/**
 * PRODUCT DISCOUNT — THE CARD'S PRICE, BADGE AND CLOCK (docs/ux/PRODUCT-DISCOUNT.md §8.2, §8.9, F1, F6).
 *
 * Rendered for real (renderToStaticMarkup), in Arabic, English and Sorani:
 *   - a live offer strikes `display_offer_before_iqd` — never `display_regular_iqd`, which is already
 *     the offer price — on the compact and the regular density, and the member line yields to it;
 *   - the photo badge reads «−17٪» / "−17%" / «−17٪» with its own screen-reader sentence, and is
 *     today's SALE (or nothing) below 1 percent;
 *   - the clock: «يبدأ خلال» for an upcoming window, «ينتهي خلال» for a live one that lowers this card,
 *     none for a priced window that lowers nothing here; an older payload behaves as before;
 *   - the compact card's two member-line words have their own Sorani (F6);
 *   - `OfferSaving` in src/components/ui/OfferBadge.tsx (product page, cart, checkout, order) prints the struck amount and the badge.
 *
 * Run: npx tsx --test tests/productDiscountCardPrice.test.ts
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
import CardPrice from '../src/components/CardPrice';
import ProductCard, { offerClock } from '../src/components/home/ProductCard';
import { OfferSaving, INSTEAD_OF, SALE_PRICE, offerPercentSr, offerPercentText } from '../src/components/ui/OfferBadge';
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
        loginWithGoogle: async () => {},
        register: async () => {},
        refreshUser: async () => {},
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

const sale = (over: Partial<ApiProduct> = {}): ApiProduct =>
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
    display_pro_iqd: 700_000,
    display_from: true,
    offer: { offer_id: 'ofw_p1s', required_tiers: [], starts_at: null, ends_at: '2099-01-01T00:00:00.000Z', schedule_state: 'live', price_source: 'offer', priced: true, locked: false },
    ...over,
  }) as ApiProduct;

const text = (html: string) => html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();

test('compact: the struck before price is the offer’s, and the member line yields to it', () => {
  const html = wrap(createElement(CardPrice, { p: sale(), density: 'compact' }));
  assert.match(html, /line-through[^>]*>900,000</, 'struck: the published price the offer replaced');
  assert.doesNotMatch(html, /line-through[^>]*>750,000</, 'never the regular field, which is already the offer price');
  assert.doesNotMatch(html, /لأعضاء/, 'the member line yields to the sale');
  assert.match(html, /<span class="sr-only">بدل <\/span>/);
  // Without an offer the member line is back, and the strike is today's rule.
  const plain = wrap(createElement(CardPrice, { p: sale({ display_offer_before_iqd: null, display_offer_saving_percent: null, display_regular_iqd: 750_000 }), density: 'compact' }));
  assert.match(text(plain), /700,000 لأعضاء PRO/);
  assert.doesNotMatch(plain, /line-through/);
});

test('regular density: the struck offer before price beside the offer price', () => {
  const html = wrap(createElement(CardPrice, { p: sale() }));
  assert.match(html, />750,000[^<]*</);
  assert.match(html, /line-through[^>]*>900,000/);
});

test('F6: the compact card’s member-line words have their own Sorani', () => {
  const ckbLine = wrap(createElement(CardPrice, { p: sale({ display_offer_before_iqd: null, display_offer_saving_percent: null }), density: 'compact' }), 'ckb');
  assert.match(text(ckbLine), /بۆ ئەندامانی PRO/);
  assert.doesNotMatch(ckbLine, /لأعضاء/, 'the Arabic is never the Sorani');
  const ckbStrike = wrap(createElement(CardPrice, { p: sale(), density: 'compact' }), 'ckb');
  assert.match(ckbStrike, /<span class="sr-only">لە جیاتی <\/span>/);
  const src = readFileSync('src/components/CardPrice.tsx', 'utf8');
  assert.doesNotMatch(src, /OWNER: Sorani to be written by hand/);
});

test('the photo badge: «−17٪», "−17%", «−17٪» with its sentence; SALE or nothing below 1', () => {
  const ar = wrap(createElement(ProductCard, { p: sale(), density: 'compact' }), 'ar');
  assert.match(ar, /<bdi dir="ltr" aria-hidden="true">−17٪<\/bdi><span class="sr-only">تخفيض 17٪<\/span>/);
  const en = wrap(createElement(ProductCard, { p: sale(), density: 'compact' }), 'en');
  assert.match(en, /−17%<\/bdi><span class="sr-only">17% off<\/span>/);
  const ckb = wrap(createElement(ProductCard, { p: sale(), density: 'compact' }), 'ckb');
  assert.match(ckb, /−17٪<\/bdi><span class="sr-only">17٪ داشکاندن<\/span>/);
  assert.doesNotMatch(ar, />SALE</);
  // Below 1 percent the server sends null: the struck price stays, the badge is today's SALE.
  const tiny = wrap(createElement(ProductCard, { p: sale({ display_offer_saving_percent: null, display_offer_before_iqd: 751_000 }), density: 'compact' }));
  assert.match(tiny, />SALE</);
  assert.doesNotMatch(tiny, /−\d+٪/);
  // No sale at all: no badge.
  const none = wrap(createElement(ProductCard, { p: sale({ display_offer_saving_percent: null, display_offer_before_iqd: null, offer: null }), density: 'compact' }));
  assert.doesNotMatch(none, />SALE<|−\d+٪/);
  // The regular card wears the same badge.
  assert.match(wrap(createElement(ProductCard, { p: sale() })), /−17٪<\/bdi>/);
});

test('the clock: upcoming always; live with an end only when the window lowered this card; an older payload as before', () => {
  const live = sale().offer!;
  assert.deepEqual(offerClock({ offer: live }), { target: live.ends_at, kind: 'ends' });
  assert.equal(offerClock({ offer: { ...live, price_source: 'ladder' } }), null, 'a priced window that lowers nothing here gets no clock');
  assert.deepEqual(offerClock({ offer: { ...live, price_source: 'ladder', priced: false } }), { target: live.ends_at, kind: 'ends' }, 'a countdown-only window keeps its clock');
  assert.deepEqual(offerClock({ offer: { ...live, schedule_state: 'upcoming', starts_at: '2099-01-01T00:00:00.000Z', price_source: 'ladder' } }), {
    target: '2099-01-01T00:00:00.000Z',
    kind: 'opens',
  });
  const { priced: _priced, ...older } = live;
  assert.deepEqual(offerClock({ offer: { ...older, price_source: 'ladder' } }), { target: live.ends_at, kind: 'ends' }, 'an older payload without `priced` behaves as today');
  assert.equal(offerClock({ offer: { ...live, ends_at: null } }), null);
  const html = wrap(createElement(ProductCard, { p: sale({ offer: { ...live, price_source: 'ladder' }, display_offer_before_iqd: null, display_offer_saving_percent: null }), density: 'compact' }));
  assert.doesNotMatch(html, /ينتهي خلال/);
});

test('OfferSaving prints the struck amount and the badge in each language', () => {
  for (const [lang, sr, badge] of [
    ['ar', 'بدل', '−17٪'],
    ['en', 'instead of', '−17%'],
    ['ckb', 'لە جیاتی', '−17٪'],
  ] as const) {
    const html = wrap(createElement(OfferSaving, { beforeIqd: 900_000, percent: 17 }), lang);
    assert.match(html, /data-offer-saving/);
    assert.match(html, new RegExp(`<span class="sr-only">${sr} </span>`));
    assert.match(html, /line-through tabular-nums">900,000/);
    assert.ok(html.includes(`>${badge}</bdi>`), `${lang}: ${badge}`);
  }
  assert.doesNotMatch(wrap(createElement(OfferSaving, { beforeIqd: 900_000, percent: null })), /lv-chip/, 'no badge without a percent');
  assert.equal(wrap(createElement(OfferSaving, { beforeIqd: 0, percent: 17 })), '');
  assert.equal(offerPercentText(17, 'en'), '−17%');
  assert.equal(offerPercentSr(17, 'ckb'), '17٪ داشکاندن');
  for (const t of [INSTEAD_OF, SALE_PRICE]) assert.notEqual(t.ckb, t.ar);
  assert.equal(SALE_PRICE.ckb, 'نرخی ئۆفەر');
});

test('the clock on the photograph reads snow on its onyx pill in the light theme too (its spans are zinc)', () => {
  const card = readFileSync('src/components/home/ProductCard.tsx', 'utf8');
  const clocks = card.match(/<Countdown target=\{clock\.target\} kind=\{clock\.kind\} className="([^"]*)" \/>/g) ?? [];
  assert.equal(clocks.length, 2, 'the compact and the regular card');
  for (const c of clocks) {
    assert.match(c, / !text-snow /, 'the label span itself (Countdown names zinc-400 on it)');
    assert.match(c, /\[&_\*\]:text-snow/, 'and the bold days and time inside it (zinc-200)');
  }
});
