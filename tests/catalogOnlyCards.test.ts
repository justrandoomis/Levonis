/**
 * CATALOG-ONLY CARDS (DECISIONS rows 239 (3) and 240, spec §3.9 / §6.1).
 *
 * An unpriced product is SHOWN — name, picture, compare toggle — and its card
 * says «السعر غير متوفر حالياً» where the number would be. Never 0, never
 * «مجاني», never a stock word («غير متوفر» / «نفد») over stock nobody set,
 * never a SALE badge or a member line. The server sends `price_status:
 * 'unpriced'` with `price_iqd: null` and no stock or sale-type keys at all;
 * this suite feeds exactly that shape to the real components
 * (renderToStaticMarkup) and to the pure helpers in src/lib/productCard.ts.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import { AuthContext } from '../src/AuthContext';
import { WalletProvider } from '../src/WalletContext';
import { CurrencyProvider } from '../src/CurrencyContext';
import { LanguageProvider } from '../src/LanguageContext';
import CardPrice from '../src/components/CardPrice';
import ProductCard from '../src/components/home/ProductCard';
import PriceRow from '../src/components/compare/PriceRow';
import { availableFirst, cardAvailability, laterIsPreorder, memberLine, type CardProduct } from '../src/lib/productCard';
import { isUnpriced, UNPRICED_TEXT } from '../src/lib/priceStatus';
import type { CompareProductCard, CompareRow } from '../src/lib/compare';

/** The card the server sends for a catalog-only product: an allow-list, no money keys. */
function unpriced(over: Partial<CardProduct> = {}): CardProduct {
  return {
    id: 'prd_cat',
    slug: 'levo-e2e-catalog-printer',
    name: 'Levo Catalog Printer',
    name_ar: '',
    description: '',
    description_ar: '',
    images: [],
    options: [],
    colors: [],
    compare_type: 'printer',
    price_status: 'unpriced',
    price_iqd: null,
    display_price_iqd: null,
    created_at: '2026-10-15T00:00:00Z',
    ...over,
  } as unknown as CardProduct;
}

function priced(over: Partial<CardProduct> = {}): CardProduct {
  return {
    ...unpriced(),
    id: 'prd_priced',
    slug: 'priced',
    price_status: 'priced',
    price_iqd: 1575000,
    display_price_iqd: 1475000,
    display_regular_iqd: 1575000,
    display_applied_tier: 'regular',
    display_pro_iqd: 1400000,
    direct_stock_available: 3,
    sale_types: ['direct_sale'],
    ...over,
  } as CardProduct;
}

function wrap(child: ReturnType<typeof createElement>): string {
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
const text = (html: string) => html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
/** No figure of any kind: Latin or Arabic-Indic digits, a currency unit, or «مجاني». */
function assertNoNumber(html: string, where: string) {
  const t = text(html);
  assert.equal(/[0-9٠-٩۰-۹]/.test(t), false, `${where} printed a digit: ${t}`);
  assert.equal(/د\.ع|IQD|\$|مجاني|Free/.test(t), false, `${where} printed a unit or «مجاني»: ${t}`);
}

test('the three labels exist and the Sorani is its own sentence, never the Arabic copied (row 183)', () => {
  assert.equal(UNPRICED_TEXT.ar, 'السعر غير متوفر حالياً');
  assert.equal(UNPRICED_TEXT.en, 'Price not available yet');
  assert.notEqual(UNPRICED_TEXT.ckb as string, UNPRICED_TEXT.ar);
  assert.match(UNPRICED_TEXT.ckb, /[ێۆڕڵە]/, 'the ckb label is written in Sorani letters');
  assert.equal(isUnpriced({ price_status: 'unpriced' }), true);
  // An older server never served an unpriced product: an absent status reads as priced.
  assert.equal(isUnpriced({}), false);
  assert.equal(isUnpriced(null), false);
  assert.equal(isUnpriced({ price_status: 'priced' }), false);
});

test('CardPrice: the label, muted, and no number in either density; the compact rows keep their height', () => {
  for (const density of ['compact', 'regular'] as const) {
    const html = wrap(createElement(CardPrice, { p: unpriced(), density }));
    assert.match(html, /data-price-status="unpriced"/);
    assert.match(text(html), new RegExp(UNPRICED_TEXT.ar));
    assert.match(html, /text-text-muted/);
    assertNoNumber(html, `CardPrice ${density}`);
  }
  // 20 + 1 + 15 px — the two fixed rows of a priced compact card.
  assert.match(wrap(createElement(CardPrice, { p: unpriced(), density: 'compact' })), /\bh-9\b/);
  // A priced card is untouched.
  assert.match(text(wrap(createElement(CardPrice, { p: priced(), density: 'compact' }))), /1,475,000/);
});

test('the compact card: label, no SALE badge, no stock word, the compare toggle kept', () => {
  // Even if a stray stock or sale field reached the card, the status wins.
  const html = wrap(
    createElement(ProductCard, {
      p: unpriced({ direct_stock_available: 4, sale_types: ['pre_order'], display_regular_iqd: 9_000_000 } as Partial<CardProduct>),
      density: 'compact',
      compareToggle: true,
    })
  );
  const t = text(html);
  assert.match(t, new RegExp(UNPRICED_TEXT.ar));
  assert.doesNotMatch(html, /SALE/);
  assert.doesNotMatch(t.replace(UNPRICED_TEXT.ar, ''), /متوفر الآن|غير متوفر|نفد|طلب مسبق/);
  assert.match(html, /data-availability="unknown"/);
  assert.match(html, /data-compare-toggle|aria-pressed/, 'compare stays: it is a catalogue read');
  assertNoNumber(html.replace(/data-[a-z-]+="[^"]*"/g, ''), 'the compact card');
});

test('cardAvailability says nothing and memberLine is null for an unpriced card', () => {
  assert.deepEqual(cardAvailability(unpriced({ direct_stock_available: 7, sale_types: ['direct_sale'] } as Partial<CardProduct>)), {
    state: 'unknown',
    qty: null,
    low: false,
  });
  assert.equal(memberLine(unpriced({ display_pro_iqd: 100 } as Partial<CardProduct>)), null);
  assert.deepEqual(memberLine(priced()), { tier: 'PRO', price: 1400000 });
});

test('availableFirst (rule R1): direct stock, then the rest, then catalog-only — each in its own order', () => {
  const a = priced({ id: 'a', direct_stock_available: 2 });
  const b = priced({ id: 'b', direct_stock_available: 0 });
  const u1 = unpriced({ id: 'u1' });
  const c = priced({ id: 'c', direct_stock_available: 5 });
  const u2 = unpriced({ id: 'u2' });
  const r = availableFirst([u1, a, b, u2, c]);
  assert.deepEqual(r.items.map((p) => p.id), ['a', 'c', 'b', 'u1', 'u2']);
  assert.equal(r.splitAt, 2);
  assert.equal(r.unpricedAt, 3);
  // Only now + unpriced: no «بطلب مسبق» divider, but the unpriced group still gets its own.
  const r2 = availableFirst([u1, a]);
  assert.deepEqual([r2.splitAt, r2.unpricedAt], [-1, 1]);
  // Nothing but unpriced: no divider at all.
  assert.deepEqual([availableFirst([u1, u2]).splitAt, availableFirst([u1, u2]).unpricedAt], [-1, -1]);
});

test('the «بطلب مسبق» divider reads its own group, never the catalog-only tail after it', () => {
  const now = priced({ id: 'now', direct_stock_available: 3 });
  const pre = priced({ id: 'pre', direct_stock_available: 0, sale_types: ['pre_order'] });
  const u = unpriced({ id: 'u' });
  assert.equal(cardAvailability(pre).state, 'preorder');
  assert.equal(cardAvailability(u).state, 'unknown', 'an unpriced card names no stock state');
  const ordered = availableFirst([now, pre, u]);
  assert.deepEqual([ordered.splitAt, ordered.unpricedAt], [1, 2]);
  assert.equal(laterIsPreorder(ordered), true, 'pre-order, not «ليست في المخزون الآن», with catalog-only products after it');
  assert.equal(laterIsPreorder(availableFirst([now, pre])), true);
  // A later group that is not all pre-order keeps the stock wording.
  const out = priced({ id: 'out', direct_stock_available: 0, sale_types: ['direct_sale'] });
  assert.equal(laterIsPreorder(availableFirst([now, pre, out, u])), false);
  // No second group: no divider to label.
  assert.equal(laterIsPreorder(availableFirst([now, u])), false);
});

test('compare: a catalog-only column says why it has no figure, and is never «الأرخص»', () => {
  const products = [
    { id: 'p1', slug: 'p1', name: { ar: 'A', en: 'A', ckb: 'A' }, image: null, price_iqd: 1000000, price_status: 'priced' },
    { id: 'p2', slug: 'p2', name: { ar: 'B', en: 'B', ckb: 'B' }, image: null, price_iqd: null, price_status: 'unpriced' },
  ] as unknown as CompareProductCard[];
  const row = {
    field_id: 'price_iqd',
    label: { ar: 'السعر', en: 'Price', ckb: 'نرخ' },
    weight: 0,
    values: [
      { raw: '1000000', num: 1000000, text: '1,000,000 IQD', missing: false },
      { raw: '', num: null, text: '', missing: true },
    ],
    winners: [],
  } as unknown as CompareRow;
  const html = wrap(createElement(PriceRow, { products, row }));
  assert.match(html, /data-price-status="unpriced"/);
  assert.match(text(html), new RegExp(UNPRICED_TEXT.ar));
  assert.doesNotMatch(text(html), /غير مذكور/);
});
