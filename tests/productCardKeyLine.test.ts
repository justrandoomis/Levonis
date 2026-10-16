/**
 * THE CARD'S KNOWLEDGE LINE (the Bambu import spec §G.5 «Cards»;
 * src/lib/productCard.ts `cardKnowledgeLine`, src/components/home/ProductCard.tsx).
 *
 * One muted line under the name: the section the product is filed in, in the
 * reader's language, then ≤ 4 key values as LTR islands. A card the server
 * sent neither for is drawn exactly as before — no empty line.
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
