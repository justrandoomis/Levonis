/**
 * «سعر تقديري» IN «عدة ألوان» (docs/SMART_PRICING.md §5.3; review finding ui-4).
 *
 * The several-colours panel draws its total into the phone bar and the desktop
 * panel, and a price per colour when the colours' prices differ. An estimate
 * is named there too, with the eager card labels:
 *   - the total's caption reads «سعر تقديري · الإجمالي» while any colour in it
 *     is an estimate (the price card above may be scrolled away);
 *   - a colour's price carries «تقديري» while that colour is an estimate;
 *   - a colour's own quote decides; until one answers, the page's label stands
 *     in (the label fails closed);
 *   - a product that is not an estimate renders exactly as before.
 *
 * Run: node --import tsx --test tests/estimateColourPanel.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import type { ColourQuantityPanelProps, ColourRow } from '../src/components/product/ColourQuantityPanel';

// The total goes into the page's slots through portals, which a server render refuses: here they render in
// place. Patched before anything imports react-dom as a module, so the panel's own import sees it.
const requireCjs = createRequire(import.meta.url);
(requireCjs('react-dom') as { createPortal: (children: unknown) => unknown }).createPortal = (children) => children;

let LANG: 'ar' | 'en' | 'ckb' = 'ar';
(globalThis as { localStorage?: unknown }).localStorage = {
  getItem: (k: string) => (k === 'levo_lang' ? LANG : null),
  setItem: () => {},
  removeItem: () => {},
};

const { createElement } = await import('react');
const { renderToStaticMarkup } = await import('react-dom/server');
const { MemoryRouter } = await import('react-router-dom');
const { AuthContext } = await import('../src/AuthContext');
const { WalletProvider } = await import('../src/WalletContext');
const { CurrencyProvider } = await import('../src/CurrencyContext');
const { LanguageProvider } = await import('../src/LanguageContext');
const { ESTIMATE_SHORT, ESTIMATE_TEXT } = await import('../src/lib/priceStatus');
const { colourStrings } = await import('../src/lib/colourQuantities');
const panel = await import('../src/components/product/ColourQuantityPanel');
// The panel's sheet and dialog render into document.body (closed here). Stubbed only now: a module that
// finds a document at load time listens on it.
(globalThis as { document?: unknown }).document = { body: null };

const LANGS = ['ar', 'en', 'ckb'] as const;
const SLOT = {} as HTMLElement;

const row = (id: string, name: string, unit: number): ColourRow => ({
  id,
  name,
  hex: '#101010',
  image: '',
  offered: true,
  noPrice: false,
  soldOut: false,
  chip: null,
  ownMax: null,
  levelUnit: unit,
  levelRegular: unit,
  levelApplied: unit,
});

/** An estimated multi-colour filament on a phone: Black × 2 chosen, White not yet. */
const props = (over: Partial<ColourQuantityPanelProps> = {}): ColourQuantityPanelProps => ({
  lang: 'ar',
  productId: 'p_pla',
  productSlug: 'bambu-pla-basic',
  rows: [row('c_black', 'Black', 25_000), row('c_white', 'White', 27_000)],
  quantities: { c_black: 2 },
  onQuantities: () => {},
  dimension: { kind: 'color' },
  sharedOptionValueIds: [],
  fulfillmentType: 'pre_order',
  route: 'sea',
  warrantyPlanId: '',
  sharedReady: true,
  cartLines: [],
  cartLinesLoaded: true,
  isAuthenticated: true,
  signInLabel: 'Sign in to buy',
  onSignIn: () => {},
  onCartItems: () => {},
  focusRow: null,
  onFocused: () => {},
  barSlot: SLOT,
  panelSlot: null,
  wide: false,
  money: (iqd: number) => `${iqd.toLocaleString('en-US')} IQD`,
  ...over,
});

function render(p: ColourQuantityPanelProps): string {
  LANG = p.lang as typeof LANG;
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
          children: createElement(LanguageProvider, { children: createElement(MemoryRouter, null, createElement(panel.default, p)) }),
        }),
      }),
    })
  );
}
const text = (html: string) => html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
const count = (haystack: string, needle: string) => haystack.split(needle).length - 1;

// ---------------------------------------------------------------- the panel

test('an estimate: the bar’s total says «سعر تقديري», and each colour’s price «تقديري», in three languages', () => {
  for (const l of LANGS) {
    const html = render(props({ lang: l, estimate: true }));
    const caption = `${ESTIMATE_TEXT[l]} · ${colourStrings(l).totalCaption}`;
    assert.ok(text(html).includes(`${caption} 50,000 IQD`), `${l}: «${text(html)}»`);
    assert.match(html, /data-colour-bar[\s\S]*data-price-estimate="true">[^<]+<\/div>/, `${l}: the bar's caption is marked`);
    // Before their own quotes answer, both colours carry the page's label (fail closed).
    assert.ok(text(html).includes(`Black 25,000 IQD · ${ESTIMATE_SHORT[l]}`), `${l}: «${text(html)}»`);
    assert.ok(text(html).includes(`White 27,000 IQD · ${ESTIMATE_SHORT[l]}`), `${l}: «${text(html)}»`);
    assert.equal(count(html, 'data-price-estimate'), 3, `${l}: the total and two prices`);
  }
});

test('the desktop panel’s total says it too', () => {
  for (const l of LANGS) {
    const html = render(props({ lang: l, estimate: true, panelSlot: SLOT, wide: true }));
    assert.match(html, /data-colour-panel/);
    // The bar (hidden at this width) and the panel each carry the label beside their total.
    assert.equal(count(text(html), `${ESTIMATE_TEXT[l]} · ${colourStrings(l).totalCaption} 50,000 IQD`), 2, `${l}: «${text(html)}»`);
  }
});

test('with nothing chosen yet the total’s dash carries the page’s label; equal prices show no price per colour', () => {
  for (const l of LANGS) {
    const empty = render(props({ lang: l, estimate: true, quantities: {} }));
    assert.ok(text(empty).includes(`${ESTIMATE_TEXT[l]} · ${colourStrings(l).totalCaption} —`), `${l}: «${text(empty)}»`);
    // §3.3: a colour's price is shown only when the colours' prices differ; the total still says it.
    const same = render(props({ lang: l, estimate: true, rows: [row('c_black', 'Black', 25_000), row('c_white', 'White', 25_000)] }));
    assert.equal(count(same, 'data-price-estimate'), 1, `${l}: the total only`);
    assert.doesNotMatch(text(same), new RegExp(`· ${ESTIMATE_SHORT[l]}`));
  }
});

test('a product that is not an estimate renders exactly as before', () => {
  for (const l of LANGS) {
    for (const over of [{}, { panelSlot: SLOT, wide: true }, { quantities: {} }]) {
      const html = render(props({ lang: l, ...over }));
      assert.equal(html, render(props({ lang: l, ...over, estimate: false })));
      assert.doesNotMatch(html, /data-price-estimate/);
      assert.equal(text(html).includes(ESTIMATE_SHORT[l]), false, `${l}: «${text(html)}»`);
      // The caption is the plain one, unchanged.
      assert.match(html, new RegExp(`<div class="text-\\[11px\\] text-text-muted">${colourStrings(l).totalCaption}</div>`));
    }
    assert.ok(text(render(props({ lang: l }))).includes(`Black 25,000 IQD White 27,000 IQD`), 'the prices without a label');
  }
});

// ---------------------------------------------------------------- the rule

test('a quote says «سعر تقديري» only on a priced answer that says so', () => {
  const quote = { unit_subtotal_iqd: 25_000, regular_iqd: 25_000, applied_iqd: 25_000 };
  assert.equal(panel.quoteEstimated({ price_status: 'priced', price_estimate: true, quote }), true);
  assert.equal(panel.quoteEstimated({ price_estimate: true, quote }), true, 'an absent status reads as priced');
  assert.equal(panel.quoteEstimated({ price_status: 'priced', quote: { ...quote, price_estimate: true } }), true, 'the quote’s own flag');
  assert.equal(panel.quoteEstimated({ price_status: 'priced', quote }), false, 'a firm SKU');
  assert.equal(panel.quoteEstimated({ price_status: 'unpriced', price_estimate: true, quote: null }), false, 'no price to qualify');
  assert.equal(panel.quoteEstimated({ price_status: 'unpriced', price_estimate: true, quote }), false);
  assert.equal(panel.quoteEstimated({ price_estimate: true, quote: null }), false);
  for (const v of ['true', 1, {}]) assert.equal(panel.quoteEstimated({ price_estimate: v as never, quote }), false, String(v));
});

/**
 * Two answers of the real quote route for one colour row each (a mixed product sold by pre-order over sea, the
 * panel's body), trimmed to the fields the panel reads. tests/priceEstimateStorefrontRowQuote.test.ts runs the same
 * function on the route's live answers.
 */
const answer = (unit: number, usd: number, estimate: boolean) => ({
  success: true,
  price_status: 'priced' as const,
  ...(estimate ? { price_estimate: true } : {}),
  quote: {
    regular_iqd: unit,
    applied_iqd: unit,
    applied_tier: 'regular',
    unit_subtotal_iqd: unit,
    errors: [],
    regular_usd_cents: usd,
    applied_usd_cents: usd,
    unit_subtotal_usd_cents: usd,
    ...(estimate ? { price_estimate: true } : {}),
    qty: 1,
    line_total_iqd: unit,
  },
  availability: {
    mode: 'preorder',
    reason: null,
    stock: { tracked: true, scope: 'base', on_hand: 5, reserved: 0, available: 5, max_qty: 9999, low: false },
    selection: { complete: true, errors: [] },
    preorder: { enabled: true, usable: true, capacity: { tracked: false, scope: null, scope_id: '', available: null, max_qty: 9999 } },
    qty_ok: true,
  },
});

test('a colour’s answered quote becomes its row: its figures, its ceiling and its own label', () => {
  const row = (unit: number, usd: number, estimate: boolean) => ({
    unit,
    regular: unit,
    applied: unit,
    unitBase: { iqd: unit, usdCents: usd },
    appliedUsd: usd,
    regularUsd: usd,
    maxQty: 9999,
    tracked: true,
    scope: 'base',
    preorder: true,
    quotaTracked: false,
    errors: [],
    unpriced: false,
    estimate,
  });
  assert.deepEqual(panel.rowQuoteOf(answer(35_250, 2200, true)), row(35_250, 2200, true), 'the estimated colour');
  assert.deepEqual(panel.rowQuoteOf(answer(32_000, 2000, false)), row(32_000, 2000, false), 'the firm colour');
  // The rows feed the total's label: a firm colour alone is not an estimate, beside an estimated one it is.
  const firm = panel.rowQuoteOf(answer(32_000, 2000, false));
  const est = panel.rowQuoteOf(answer(35_250, 2200, true));
  assert.equal(panel.totalEstimated([firm], true), false);
  assert.equal(panel.totalEstimated([firm, est], false), true);
});

test('a colour’s own quote decides; until one answers the page’s label stands in; the total follows its colours', () => {
  const firm = { estimate: false };
  const est = { estimate: true };
  assert.equal(panel.rowEstimated(null, true), true, 'no answer yet: the product’s label stands in');
  assert.equal(panel.rowEstimated(null, false), false);
  assert.equal(panel.rowEstimated(firm, true), false, 'a firm SKU of a mixed product carries none');
  assert.equal(panel.rowEstimated(est, false), true, 'its own answer, whatever the page holds');
  assert.equal(panel.totalEstimated([], true), true, 'no colour chosen: the page’s label');
  assert.equal(panel.totalEstimated([], false), false);
  assert.equal(panel.totalEstimated([firm, firm], true), false, 'only firm colours of a mixed product');
  assert.equal(panel.totalEstimated([firm, null], true), true, 'a colour still waiting for its quote');
  assert.equal(panel.totalEstimated([firm, est], false), true, 'one estimated colour makes the total an estimate');
  assert.equal(panel.totalEstimated([firm, null], false), false);
});

// ---------------------------------------------------------------- a colour it does not sell (review r3-unoffered-page)

test('a colour the product does not sell with the shared selection: the chooser’s words, no figure, no quantity', async () => {
  const { NOT_OFFERED } = await import('../src/lib/productChooser');
  for (const l of LANGS) {
    // The row as the page builds it (`rowUnoffered`): not offered, no level figure, the chooser's words as its chip.
    const leftOut: ColourRow = {
      ...row('c_red', 'Red', 0),
      offered: false,
      chip: { text: NOT_OFFERED[l], cls: 'text-text-muted' },
      levelUnit: null,
      levelRegular: null,
      levelApplied: null,
    };
    // Between the two colours it sells, so the row's markup ends where the next row begins.
    const html = render(props({ lang: l, quantities: {}, rows: [row('c_black', 'Black', 25_000), leftOut, row('c_white', 'White', 27_000)] }));
    const at = html.indexOf('data-colour-row="c_red"');
    assert.ok(at > 0, `${l}: the row is listed`);
    const red = html.slice(at, html.indexOf('<div role="listitem"', at));
    assert.match(red, /data-row-offered="false"/);
    assert.ok(text(red).includes(NOT_OFFERED[l]), `${l}: «${text(red)}»`);
    assert.doesNotMatch(text(red), /IQD|[0-9]/, `${l}: no figure for it`);
    assert.match(red, /disabled=""/, `${l}: no quantity can be typed`);
    // The colours it sells keep their prices.
    assert.ok(text(html).includes('Black 25,000 IQD') && text(html).includes('White 27,000 IQD'), `${l}: «${text(html)}»`);
  }
});
