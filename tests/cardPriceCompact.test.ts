/**
 * CardPrice, compact density (CATALOG_DISCOVERY §4.1, stream S2): the price is
 * the strongest thing on the card, and under it ONE member line at most.
 *
 * Rendered for real (renderToStaticMarkup) for each viewer the server can
 * describe — regular, PRIME, PRO — because "a PRO viewer sees no member line;
 * a PRIME viewer sees a PRO line only if it is cheaper" is the acceptance
 * rule, and the regular density must not change for its other callers.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { AuthContext } from '../src/AuthContext';
import { WalletProvider } from '../src/WalletContext';
import { CurrencyProvider } from '../src/CurrencyContext';
import { LanguageProvider } from '../src/LanguageContext';
import CardPrice from '../src/components/CardPrice';
import type { ApiProduct } from '../src/lib/api';

function price(over: Partial<ApiProduct>): ApiProduct {
  return {
    price_iqd: 1575000,
    display_price_iqd: 1575000,
    display_regular_iqd: 1575000,
    display_applied_tier: 'regular',
    display_prime_iqd: 1555000,
    display_pro_iqd: 1475000,
    display_from: true,
    ...over,
  } as ApiProduct;
}

function render(p: ApiProduct, density: 'regular' | 'compact' = 'compact'): string {
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
          children: createElement(LanguageProvider, { children: createElement(CardPrice, { p, density }) }),
        }),
      }),
    })
  );
}
const text = (html: string) => html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();

test('regular viewer: «يبدأ من», the amount apart from its unit, and one PRO line', () => {
  const html = render(price({}));
  assert.match(html, /data-card-price="compact"/);
  assert.match(html, />يبدأ من</);
  assert.match(html, /<bdi dir="ltr"[^>]*text-\[15px\] font-extrabold[^>]*text-text-primary">1,575,000<\/bdi>/);
  assert.match(html, /text-\[10\.5px\] font-bold text-text-secondary">د\.ع</);
  assert.match(text(html), /1,475,000 لأعضاء PRO/);
  assert.doesNotMatch(html, /PRIME/, 'compact never shows both rungs');
  assert.equal((html.match(/لأعضاء/g) ?? []).length, 1);
});

test('no «يبدأ من» unless the variants really differ', () => {
  assert.doesNotMatch(render(price({ display_from: false })), /يبدأ من/);
});

test('PRO viewer: the PRO price in PRO red, no member line, the regular price struck', () => {
  const html = render(price({ display_applied_tier: 'pro', display_price_iqd: 1475000 }));
  assert.match(html, /data-pro-price="true"[^>]*text-coral">1,475,000/);
  assert.doesNotMatch(html, /لأعضاء/);
  assert.match(html, /line-through[^>]*>1,575,000</);
});

test('PRIME viewer: gold price, and a PRO line only when PRO is cheaper', () => {
  const cheaper = render(price({ display_applied_tier: 'prime', display_price_iqd: 1555000 }));
  assert.match(cheaper, /text-gold">1,555,000/);
  assert.match(text(cheaper), /1,475,000 لأعضاء PRO/);

  const notCheaper = render(price({ display_applied_tier: 'prime', display_price_iqd: 1555000, display_pro_iqd: 1560000 }));
  assert.doesNotMatch(notCheaper, /لأعضاء/);
  assert.doesNotMatch(notCheaper, />PRIME</, 'a PRIME viewer is never teased their own rung');
});

test('no member prices: the member row is reserved but empty', () => {
  const html = render(price({ display_prime_iqd: null, display_pro_iqd: null }));
  assert.match(html, /mt-px flex h-\[15px\][^"]*"><\/div>/);
});

test('the regular density is unchanged for its other callers (both teasers)', () => {
  const html = render(price({}), 'regular');
  assert.doesNotMatch(html, /data-card-price="compact"/);
  assert.match(html, /PRIME/);
  assert.match(html, /PRO/);
  assert.match(html, /للمشتركين/);
});
