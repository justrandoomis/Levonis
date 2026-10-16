/**
 * THE CARD'S KNOWLEDGE LINE (the Bambu import spec §G.5 «Cards»;
 * src/lib/productCard.ts `cardKnowledgeLine`, src/components/home/ProductCard.tsx).
 *
 * One muted line under the name: the section the product is filed in, in the
 * reader's language, then ≤ 4 key values as LTR islands — a worded fact
 * («هيكل مغلق», «حتى 16 لونًا») in the reader's language. Its ROW is kept on
 * every compact card, drawn or not, and in the compact skeleton: the card's
 * fixed height is one height (280 px at 174 px wide), so a rail never
 * stairsteps when one card has a line and its neighbour has none.
 *
 * Run: node --import tsx --test tests/productCardKeyLine.test.ts
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
import ProductCard from '../src/components/home/ProductCard';
import { cardKnowledgeLine, type CardProduct } from '../src/lib/productCard';
import { ProductCardSkeleton } from '../src/components/ui/Skeleton';

const SECTION = { ar: 'طابعات FDM', en: 'FDM Printers', ckb: 'چاپکەری FDM' };

function card(over: Partial<CardProduct> = {}): CardProduct {
  return {
    id: 'prd_x',
    slug: 'bambu-lab-x2d',
    name: 'Bambu Lab X2D',
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

function render(p: CardProduct, lang: 'ar' | 'en' | 'ckb'): string {
  try {
    localStorage.setItem('levo_lang', lang);
  } catch {
    /* no storage in node: the provider's default (Arabic) is used */
  }
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
          children: createElement(LanguageProvider, {
            children: createElement(MemoryRouter, null, createElement(ProductCard, { p, density: 'compact' })),
          }),
        }),
      }),
    })
  );
}

test('the line: the section in the reader’s language, then ≤ 4 key values; nothing when the server sent neither', () => {
  const p = { section_name: SECTION, key_specs: ['256 × 256 × 260 mm', 'Enclosed', '24 colours', 'a', 'b'] };
  assert.deepEqual(cardKnowledgeLine(p, 'ar'), { section: 'طابعات FDM', specs: ['256 × 256 × 260 mm', 'Enclosed', '24 colours', 'a'] });
  assert.deepEqual(cardKnowledgeLine(p, 'ckb')?.section, 'چاپکەری FDM');
  assert.deepEqual(cardKnowledgeLine({ key_specs: ['PLA'] }, 'en'), { section: '', specs: ['PLA'] });
  assert.equal(cardKnowledgeLine({}, 'en'), null);
  assert.equal(cardKnowledgeLine({ key_specs: [], section_name: null }, 'ar'), null);
});

test('the card draws it under the name, muted, the values as <bdi>; a card without it is unchanged', () => {
  const html = render(card({ section_name: SECTION, key_specs: ['256 × 256 × 260 mm', 'Enclosed'] }), 'ar');
  const line = /<p[^>]*data-card-knowledge[^>]*>(.*?)<\/p>/.exec(html);
  assert.ok(line, html.slice(0, 400));
  assert.match(line![0], /text-text-muted/);
  assert.match(line![1], /طابعات FDM · <bdi>256 × 256 × 260 mm<\/bdi> · <bdi>Enclosed<\/bdi>/);
  assert.ok(html.indexOf('data-card-knowledge') > html.indexOf('</h3>'), 'under the name');
  const plain = render(card(), 'ar');
  assert.doesNotMatch(plain, /data-card-knowledge/);
  // No number of money beside it on an unpriced card.
  assert.doesNotMatch(plain.replace(/<[^>]+>/g, ' '), /د\.ع|IQD/);
});

test('worded key values follow the reader’s language; a string value stays as it is', () => {
  const p = {
    section_name: SECTION,
    key_specs: ['256 × 256 × 256 mm', { ar: 'هيكل مغلق', en: 'Enclosed', ckb: 'لەشی داخراو' }, { ar: 'حتى 16 لونًا', en: 'Up to 16 colours', ckb: 'تا 16 ڕەنگ' }],
  };
  assert.deepEqual(cardKnowledgeLine(p, 'ar')?.specs, ['256 × 256 × 256 mm', 'هيكل مغلق', 'حتى 16 لونًا']);
  assert.deepEqual(cardKnowledgeLine(p, 'en')?.specs, ['256 × 256 × 256 mm', 'Enclosed', 'Up to 16 colours']);
  assert.deepEqual(cardKnowledgeLine(p, 'ckb')?.specs, ['256 × 256 × 256 mm', 'لەشی داخراو', 'تا 16 ڕەنگ']);
  assert.deepEqual(cardKnowledgeLine({ key_specs: [{ ar: '', en: 'Enclosed', ckb: '' }] as never }, 'ckb')?.specs, ['Enclosed'], 'an empty slot reads the English');
});

test('ONE HEIGHT: the line’s row is reserved on every compact card, drawn or not, and in the skeleton', () => {
  const row = /<p class="mt-0\.5 h-4 truncate text-\[11px\] leading-4[^"]*"[^>]*data-card-line="true"[^>]*>/;
  const withLine = render(card({ section_name: SECTION, key_specs: ['256 × 256 × 260 mm'] }), 'ar');
  const without = render(card(), 'ar');
  assert.match(withLine, row);
  assert.match(without, row, 'a card the server sent no line for keeps the row');
  assert.match(without, /data-card-line="true" aria-hidden="true"><\/p>/, 'an empty row, hidden from assistive tech');
  // Name, line row, price block: the same boxes with and without a line.
  const boxes = (html: string) => [...(html.split('</h3>')[1] ?? '').matchAll(/<(p|div) class="([^"]*)"/g)].slice(0, 3).map((m) => `${m[1]}.${m[2]}`);
  assert.deepEqual(boxes(without), boxes(withLine));
  const skeleton = renderToStaticMarkup(createElement(ProductCardSkeleton, { density: 'compact' }));
  assert.match(skeleton, /<div class="mt-0\.5 flex h-4 items-center">/, 'the skeleton reserves the same 2 + 16 px');
});
