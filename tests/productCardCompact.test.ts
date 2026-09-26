/**
 * THE COMPACT PRODUCT CARD (docs/ux/CATALOG_DISCOVERY.md §4, stream S2).
 *
 * The owner: «بطاقتان في الصف في الجوال … السعر بارزًا، حالة التوفر واضحة، اسم
 * المنتج line-clamp ومنسقًا بشكل أنيق … الأولوية بصريًا لمنتجات البيع المباشر
 * والمتوفرة». This suite pins what the card SAYS (src/lib/productCard.ts) and
 * how it is BUILT (the real component, rendered with renderToStaticMarkup):
 *
 *  - the card name is the part before the first « / » (owner default Q2);
 *  - availability is three states in words, with the quantity rule;
 *  - one member line at most, and never for a viewer already on that rung;
 *  - the compare toggle is a SIBLING of the link, only for comparable types;
 *  - the availability is inside the link's text, so it is in its name.
 *
 * The card's 262 px height is measured in the browser harness
 * (scripts/e2e-home-v2-shots.mjs, «every compact card is 6:5 photo + 119 px»).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import { ROOT } from './fixtures/d1';
import { AuthContext } from '../src/AuthContext';
import { WalletProvider } from '../src/WalletContext';
import { CurrencyProvider } from '../src/CurrencyContext';
import { LanguageProvider } from '../src/LanguageContext';
import ProductCard from '../src/components/home/ProductCard';
import {
  availableFirst,
  cardAvailability,
  cardHref,
  cardName,
  compareTypeOf,
  memberLine,
  splitMoney,
  type CardProduct,
} from '../src/lib/productCard';

const read = (rel: string) => readFileSync(join(ROOT, rel), 'utf8');

function product(over: Partial<CardProduct> = {}): CardProduct {
  return {
    id: 'prd_h2d',
    slug: 'bambu-lab-h2d',
    name: 'Bambu Lab H2D / H2D Combo / Laser Full Combo 10W / Laser Full Combo 40W',
    name_ar: '',
    description: '',
    description_ar: '',
    images: [],
    options: [],
    colors: [],
    selling_type: 'direct_sale',
    shipping_methods: [],
    price_iqd: 3375000,
    display_price_iqd: 3375000,
    display_regular_iqd: 3375000,
    display_applied_tier: 'regular',
    display_prime_iqd: 3355000,
    display_pro_iqd: 3275000,
    display_from: true,
    membership_prices: {},
    payment_options: [],
    subcategory_id: '',
    categories: '',
    display_order: 0,
    is_featured: false,
    specifications: [],
    brand: '',
    labels: [],
    hashtags: [],
    features: [],
    description_images: [],
    description_videos: [],
    stores: [],
    warranty_plans: [],
    how_to_use: '',
    stock: null,
    created_at: '2026-09-01T00:00:00Z',
    ...over,
  } as CardProduct;
}

function render(p: CardProduct, props: Record<string, unknown> = {}): string {
  const card = createElement(ProductCard, { p, density: 'compact', ...props });
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
          children: createElement(LanguageProvider, { children: createElement(MemoryRouter, null, card) }),
        }),
      }),
    })
  );
}

/** The `<a …>…</a>` of the card (it contains no nested anchor). */
const linkOf = (html: string) => {
  const m = /<a [^>]*>([\s\S]*?)<\/a>/.exec(html);
  assert.ok(m, 'the card has no link');
  return m[0];
};
const text = (html: string) => html.replace(/<[^>]+>/g, '');

// ---------------------------------------------------------------- the name

test('the card name is the part before the first « / », and an admin card_name wins', () => {
  assert.equal(cardName(product()), 'Bambu Lab H2D');
  assert.equal(cardName({ name: 'Bambu Lab A1 mini / A1 mini Combo 3D Printer' }), 'Bambu Lab A1 mini');
  assert.equal(cardName({ name: 'Snapmaker U1 3D Printer' }), 'Snapmaker U1 3D Printer');
  // Only a SPACED slash is an option separator.
  assert.equal(cardName({ name: 'PLA/PETG Starter Kit' }), 'PLA/PETG Starter Kit');
  assert.equal(cardName({ name: 'Nozzle 0.4/0.6 mm / Hardened' }), 'Nozzle 0.4/0.6 mm');
  // A name that starts with the separator keeps itself rather than go blank.
  assert.equal(cardName({ name: ' / Odd' }), '/ Odd');
  assert.equal(cardName({ name: 'Long / Name', card_name: '  H2D  ' }), 'H2D');
  assert.equal(cardName({ name: 'Long / Name', card_name: '   ' }), 'Long');
});

test('the card shows the short name and keeps the full one in its title', () => {
  const html = render(product());
  assert.match(html, />Bambu Lab H2D<\/h3>/);
  assert.match(html, /title="Bambu Lab H2D \/ H2D Combo \/ Laser Full Combo 10W \/ Laser Full Combo 40W"/);
  // Nothing shortened, nothing to explain.
  assert.doesNotMatch(render(product({ name: 'Snapmaker U1 3D Printer' })), /<h3[^>]*title=/);
});

// ------------------------------------------------------------ availability

test('availability: three states in words, and unknown says nothing', () => {
  assert.deepEqual(cardAvailability({ direct_stock_available: 5 }), { state: 'available', qty: 5, low: false });
  assert.deepEqual(cardAvailability({ direct_stock_available: 2 }), { state: 'available', qty: 2, low: true });
  assert.deepEqual(cardAvailability({ direct_stock_available: 1 }), { state: 'available', qty: 1, low: true });
  // The shop's own threshold replaces 2.
  assert.equal(cardAvailability({ direct_stock_available: 4, low_stock_threshold: 5 }).low, true);
  assert.equal(cardAvailability({ direct_stock_available: 2, low_stock_threshold: 1 }).low, false);
  assert.equal(cardAvailability({ direct_stock_available: 0, sale_types: ['direct_sale', 'pre_order'] }).state, 'preorder');
  assert.equal(cardAvailability({ sale_types: ['pre_order'] }).state, 'preorder');
  assert.equal(cardAvailability({ direct_stock_available: 0, sale_types: ['direct_sale'] }).state, 'unavailable');
  // Not told the sale types: never a guessed «طلب مسبق».
  assert.equal(cardAvailability({ direct_stock_available: 0 }).state, 'unknown');
  assert.equal(cardAvailability({}).state, 'unknown');
  assert.equal(cardAvailability({ direct_stock_available: 1.5 as number }).state, 'unknown');
});

test('the availability words are inside the link, so the link is named with them', () => {
  const inStock = linkOf(render(product({ direct_stock_available: 5 })));
  assert.match(text(inStock), /متوفر الآن/);
  assert.match(text(inStock), /5 قطع/);
  assert.match(inStock, /data-availability="available"/);

  const low = linkOf(render(product({ direct_stock_available: 2 })));
  assert.match(text(low), /بقي 2/);
  assert.match(low, /text-warning/, 'the low quantity is drawn in warning');

  assert.match(text(render(product({ direct_stock_available: 11 }))), /11 قطعة/, 'Arabic counts from 11 take the singular');
  assert.match(render(product({ direct_stock_available: 120 })), /<bdi dir="ltr">99\+<\/bdi>/);

  const pre = linkOf(render(product({ direct_stock_available: 0, sale_types: ['pre_order'] })));
  assert.match(text(pre), /طلب مسبق/);
  assert.match(pre, /data-availability="preorder"/);

  const off = linkOf(render(product({ direct_stock_available: 0, sale_types: ['direct_sale'] })));
  assert.match(text(off), /غير متوفر/);

  // Colour is never the only cue: every state has a dot AND a word.
  assert.match(inStock, /rounded-full bg-success/);
  assert.match(pre, /border-warning/);
});

// ------------------------------------------------------------- member line

test('one member line: the cheapest rung below what the viewer pays', () => {
  // A regular viewer: PRO is the cheaper of the two.
  assert.deepEqual(memberLine(product()), { tier: 'PRO', price: 3275000 });
  // PRIME is shown when it is the cheaper rung.
  assert.deepEqual(memberLine(product({ display_prime_iqd: 3200000 })), { tier: 'PRIME', price: 3200000 });
  // A PRO viewer sees none.
  assert.equal(memberLine(product({ display_applied_tier: 'pro', display_price_iqd: 3275000 })), null);
  // A PRIME viewer sees PRO only if it is cheaper than what they pay…
  assert.deepEqual(
    memberLine(product({ display_applied_tier: 'prime', display_price_iqd: 3355000 })),
    { tier: 'PRO', price: 3275000 }
  );
  // …and never PRIME, their own rung.
  assert.equal(
    memberLine(product({ display_applied_tier: 'prime', display_price_iqd: 3355000, display_pro_iqd: 3400000 })),
    null
  );
  // No member prices, no line.
  assert.equal(memberLine(product({ display_prime_iqd: null, display_pro_iqd: null })), null);
  // A member price that is not cheaper is not a teaser.
  assert.equal(memberLine(product({ display_prime_iqd: 3375000, display_pro_iqd: 3375000 })), null);
});

// ----------------------------------------------------------------- compare

test('the compare toggle: comparable types only, and a sibling of the link — never inside it', () => {
  assert.equal(compareTypeOf({ compare_type: 'printer' }), 'printer');
  assert.equal(compareTypeOf({ compare_type: 'filament' }), 'filament');
  assert.equal(compareTypeOf({ compare_type: 'laser' }), 'laser');
  assert.equal(compareTypeOf({ compare_type: 'accessory' }), null);
  assert.equal(compareTypeOf({}), null, 'not told the type: no toggle, rather than a guess');
  assert.equal(compareTypeOf({ compare_type: 'printer', product_slug: 'starter-bundle' }), null, 'a bundle is never a column');

  const html = render(product({ compare_type: 'printer' }), { compareToggle: true });
  assert.match(html, /<button[^>]*data-compare-toggle="prd_h2d"/);
  assert.match(html, /aria-pressed="false"/);
  assert.match(html, /aria-label="أضف Bambu Lab H2D إلى المقارنة"/);
  assert.match(html, /lv-hit/, 'drawn 30 px, hit 44 px');
  const link = linkOf(html);
  assert.doesNotMatch(link, /<button/, 'a button nested in the anchor');
  assert.doesNotMatch(html, /<a [^>]*>(?:(?!<\/a>)[\s\S])*<button/, 'a button nested in the anchor');

  // Where the caller did not ask for it, or the type is not comparable: none.
  assert.doesNotMatch(render(product({ compare_type: 'printer' })), /data-compare-toggle/);
  assert.doesNotMatch(render(product({ compare_type: 'accessory' }), { compareToggle: true }), /data-compare-toggle/);
});

// ------------------------------------------------------------------ layout

test('the compact card: 6:5 top-anchored photo, fixed name box, theme roles only', () => {
  const html = render(product({ direct_stock_available: 5, images: ['/files/h2d.webp'] }));
  assert.match(html, /data-product-card="compact"/);
  assert.match(html, /<img[^>]*alt=""/, 'the photo is decorative inside a named link');
  assert.match(html, /aspect-\[6\/5\]/);
  assert.match(html, /object-\[50%_4%\]/);
  assert.match(html, /line-clamp-2 min-h-\[34px\] text-\[12\.5px\][^"]*leading-\[17px\]/);
  assert.match(html, /bg-surface/);
  assert.match(html, /border-border-subtle/);
  assert.doesNotMatch(html, /data-direct-stock-edge/, 'the 8 px edge strip is replaced by the availability line');
  // The price block reserves both its rows.
  assert.match(html, /data-card-price="compact"/);
  assert.match(html, /h-5 min-w-0/);
  assert.match(html, /h-\[15px\]/);
  // A composition row links to where it can be bought.
  assert.match(render(product({ product_slug: 'starter-kit' })), /href="\/bundles\/starter-kit"/);
  assert.equal(cardHref({ id: 'x', slug: '', product_slug: undefined }), '/product/x');
});

test('the direct-sale-first partition is stable and names where the second group starts', () => {
  const list = [
    { id: 'a', direct_stock_available: 0 },
    { id: 'b', direct_stock_available: 3 },
    { id: 'c' },
    { id: 'd', direct_stock_available: 1 },
  ];
  const { items, splitAt } = availableFirst(list);
  assert.deepEqual(items.map((p) => p.id), ['b', 'd', 'a', 'c']);
  assert.equal(splitAt, 2);
  assert.equal(availableFirst([{ direct_stock_available: 2 }]).splitAt, -1, 'one group: no divider');
});

test('splitMoney separates the amount from the unit, in either digit set', () => {
  assert.deepEqual(splitMoney('1,575,000 د.ع'), ['1,575,000', 'د.ع']);
  assert.deepEqual(splitMoney('١٬٥٧٥٬٠٠٠ د.ع'), ['١٬٥٧٥٬٠٠٠', 'د.ع']);
  assert.deepEqual(splitMoney('$1,050.00'), ['$1,050.00', '']);
});

// ------------------------------------------------------------- the callers

test('the home rail and the listing grid render the one compact card', () => {
  const latest = read('src/components/home/v2/LatestProducts.tsx');
  assert.match(latest, /<ProductCard p=\{p\} density="compact" compareToggle widthClass="w-\[148px\]/);
  assert.match(latest, /<ProductCardSkeleton key=\{i\} density="compact"/);

  const products = read('src/pages/Products.tsx');
  assert.match(products, /<ProductCard p=\{p\} density="compact" compareToggle/);
  assert.match(products, /grid grid-cols-2 gap-2\.5/, 'two to a row on a phone, 10 px apart');
  assert.doesNotMatch(products, /<CardPrice\b/, 'Products.tsx no longer draws a second copy of the card');
  assert.match(products, /availableFirst\(products\)/, 'direct sale first outside search');
});
