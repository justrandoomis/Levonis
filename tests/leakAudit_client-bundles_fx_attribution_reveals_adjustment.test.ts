/**
 * LEAK AUDIT — client-bundles: the top-bar currency menu and the Settings page
 * print the shop's effective USD/IQD («1 $ ≈ 1,680») AND credit it to IQWealth
 * with a link to IQWealth's own site — so every visitor is told which public
 * figure to subtract, and the subtraction is the owner's PRIVATE market
 * adjustment.
 *
 * The owner's rule: anyone other than the main admin / super admin gets ONLY
 * the final price — no cost and no step of how a price was computed, in no
 * channel (HTML, JavaScript, cache…). `fx_rate_pairs.market_adjustment_iqd` is
 * such a step: the fixed dinars per dollar the owner adds on top of the
 * IQWealth parallel-market sell (DECISIONS row 189 decision 5: «سعر السوق
 * 1,660 + 20 = 1,680»; FINANCIAL_FIELDS; the brief lists «market adjustment»
 * as private). The chain is
 *
 *   pricing_fx_rates.rate_iqd = IQWealth parallel SELL + market_adjustment_iqd
 *   → GET /api/settings/public  { displayUsdRate, displayUsdRateAttributed }
 *       (worker/lib/fx/displayRate.ts getPublicDisplayRate)
 *   → WalletContext (src/WalletContext.tsx:220-221)
 *   → resolveDisplayRate / currencyValue (src/CurrencyContext.tsx)
 *   → CurrencyCaptions in the top-bar menu (src/components/LangThemePanel.tsx)
 *     and the «Preferences» currency row of src/pages/Settings.tsx:
 *       «1 $ ≈ 1,680 IQD — the shop's rate, based on IQWealth data ↗»
 *       <a href="https://iraqsm.com" data-iqwealth-attribution>
 *   → rememberDisplayRate: the EXACT text kept on the device
 *       (localStorage `levonis.displayRate.v1`, src/lib/displayRate.ts)
 *
 * The visitor follows the link, reads IQWealth's published sell, and
 *
 *     rendered rate − IQWealth's sell = market_adjustment_iqd
 *
 * exactly for a whole-dinar adjustment (the owner's own example, +20), to the
 * nearest dinar otherwise — and exactly from the decimal text the bundle keeps
 * in memory and in device storage for every dollar conversion.
 *
 * What the existing guards do: tests/bundlePrivateNames.test.ts keeps the NAME
 * `market_adjustment_iqd` out of customer chunks and even REQUIRES the
 * `https://iraqsm.com` attribution link to ship (lines 104-105);
 * tests/langThemeSheet.test.ts and tests/displayCurrency.test.ts pin the
 * attribution as wanted behaviour; the literal leak scanner
 * (tests/fixtures/costlyProduct.ts `leaks`) only knows literal values and
 * keys. Nothing guards the derivable value; these tests do.
 *
 * LOCAL ONLY: in-memory SQLite with every migration, the real owner routes,
 * the real FX scheduler against a FAKE IQWealth (no network), the real
 * /api/settings/public, and the real client components rendered with
 * react-dom/server. No request to any host.
 *
 * Run: node --import tsx --test tests/leakAudit_client-bundles_fx_attribution_reveals_adjustment.test.ts
 */
/* eslint-disable @typescript-eslint/no-explicit-any */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { DatabaseSync } from 'node:sqlite';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import { APEX, OWNER, asD1, freshDb, get, json, pending, post, put, stubApp, type StubUser } from './fixtures/app';
import { OWNER_ROW_SQL, fxEnv, market, pairOf } from './fixtures/fx';
import { leaks } from './fixtures/costlyProduct';
import { ROLES } from './fixtures/roleMatrix';
import { adminPricingRoutes } from '../worker/routes/adminPricing';
import { miscRoutes } from '../worker/routes/misc';
import { runFxScheduler } from '../worker/lib/fx/scheduler';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const BASE = '/api/admin/pricing';
const LANGS = ['ar', 'en', 'ckb'] as const;
type Lang = (typeof LANGS)[number];

// ---------------------------------------------------------------- exact decimal-text arithmetic (≤ 8 places)
const SCALE = 8;
const toFixedInt = (s: string): bigint => {
  const m = /^(-?)(\d+)(?:\.(\d+))?$/.exec(s.trim().replace(/,/g, ''));
  if (!m) throw new Error(`not decimal text: ${s}`);
  const v = BigInt(m[2]! + (m[3] ?? '').padEnd(SCALE, '0').slice(0, SCALE));
  return m[1] === '-' ? -v : v;
};
const fromFixedInt = (v: bigint): string => {
  const neg = v < 0n;
  const s = (neg ? -v : v).toString().padStart(SCALE + 1, '0');
  const frac = s.slice(s.length - SCALE).replace(/0+$/, '');
  return `${neg ? '-' : ''}${s.slice(0, s.length - SCALE)}${frac ? `.${frac}` : ''}`;
};
const sub = (a: string, b: string) => fromFixedInt(toFixedInt(a) - toFixedInt(b));
const same = (a: string, b: string) => toFixedInt(a) === toFixedInt(b);
/** |a − b| < half a dinar: the figure, to the nearest dinar. */
const nearest = (a: string, b: string) => {
  const d = toFixedInt(a) - toFixedInt(b);
  return (d < 0n ? -d : d) * 2n < 10n ** BigInt(SCALE);
};

// ---------------------------------------------------------------- the browser's storage, as a device holds it
function deviceStorage(lang: Lang) {
  const store = new Map<string, string>([['levo_lang', lang]]);
  return {
    store,
    getItem: (k: string) => (store.has(k) ? store.get(k)! : null),
    setItem: (k: string, v: string) => void store.set(k, String(v)),
    removeItem: (k: string) => void store.delete(k),
  };
}
function onDevice<T>(lang: Lang, fn: (storage: ReturnType<typeof deviceStorage>) => T): T {
  const g = globalThis as Record<string, unknown>;
  const saved = g.localStorage;
  const storage = deviceStorage(lang);
  g.localStorage = storage;
  try {
    return fn(storage);
  } finally {
    if (saved === undefined) delete g.localStorage;
    else g.localStorage = saved;
  }
}

// ---------------------------------------------------------------- the owner's side (real routes, real scheduler, fake provider)
const settle = () => Promise.all(pending.splice(0));
const ownerApp = (raw: DatabaseSync) => stubApp(asD1(raw), OWNER, (a) => a.route(BASE, adminPricingRoutes));
const ownerVersion = (raw: DatabaseSync) => Number(pairOf(raw, 'USD_IQD').owner_version);

/** The owner saves a PRIVATE adjustment, the FAKE IQWealth publishes `sell`, the owner approves the first value. */
async function shopWithPrivateAdjustment(adjustment: string, sell: number): Promise<{ raw: DatabaseSync; iqwealthSell: string }> {
  const raw = freshDb();
  raw.exec(OWNER_ROW_SQL);
  const saved = await put(ownerApp(raw), `${BASE}/rates/fx/USD_IQD/settings`, { owner_version: ownerVersion(raw), market_adjustment_iqd: adjustment }, { Host: APEX });
  assert.equal(saved.status, 200, `the owner could not save the adjustment: ${JSON.stringify(await json(saved)).slice(0, 300)}`);
  await settle();

  const m = market({ sell });
  m.state.at = new Date();
  await runFxScheduler(fxEnv(raw), { now: new Date() }, { trigger: 'refresh', pairs: ['USD_IQD'], fetchImpl: m.f.fetch, actorId: 'usr_owner' });
  assert.ok(m.f.calls.length > 0, 'the scheduler read the fake provider');
  assert.ok(m.f.calls.every((c) => new URL(c.url).hostname === 'iraqsm.com'), 'only the fake provider was called');
  await settle();
  assert.equal(pairOf(raw, 'USD_IQD').pending_reason, 'FIRST_VALUE');

  const approved = await post(ownerApp(raw), `${BASE}/rates/fx/USD_IQD/review`, { owner_version: ownerVersion(raw), decision: 'approve' }, { Host: APEX });
  assert.equal(approved.status, 200, `the owner could not approve: ${JSON.stringify(await json(approved)).slice(0, 300)}`);
  await settle();

  const usd = pairOf(raw, 'USD_IQD');
  assert.equal(usd.market_adjustment_iqd, adjustment, 'the private adjustment is in force');
  assert.ok(same(String(usd.market_rate), String(sell)), `the market figure is IQWealth's published sell (${usd.market_rate})`);
  return { raw, iqwealthSell: String(sell) };
}

/** What a non-owner's browser receives from the public settings (the real route, the role's own session). */
async function publicSettingsFor(raw: DatabaseSync, user: StubUser | null): Promise<Record<string, any>> {
  const app = stubApp(asD1(raw), user, (a) => a.route('/api', miscRoutes));
  const res = await get(app, '/api/settings/public', { Host: APEX });
  assert.equal(res.status, 200);
  const body = await json(res);
  return body.settings as Record<string, any>;
}

// ---------------------------------------------------------------- the client side (the real components)
/**
 * The settings as the bundle reads them: src/WalletContext.tsx:220-221 maps
 * them, src/CurrencyContext.tsx `resolveDisplayRate` decides the rate, and
 * `currencyValue` is what every price and caption is drawn from.
 */
async function clientMoney(settings: Record<string, any>) {
  const { resolveDisplayRate, currencyValue } = await import('../src/CurrencyContext');
  const displayUsdRate = settings ? (settings.displayUsdRate ?? null) : undefined;
  const attributed = settings?.displayUsdRateAttributed !== false;
  const rate = resolveDisplayRate({ settingsLoaded: displayUsdRate !== undefined, displayUsdRate, cached: null, attributed });
  return { rate, value: currencyValue('USD', () => {}, rate, displayUsdRate !== undefined) };
}

/** The top-bar menu's currency captions, with dollars picked, in one language. */
async function renderMenu(lang: Lang, settings: Record<string, any>): Promise<string> {
  const { LanguageProvider } = await import('../src/LanguageContext');
  const { CurrencyValueProvider } = await import('../src/CurrencyContext');
  const { CurrencyCaptions } = await import('../src/components/LangThemePanel');
  const { value } = await clientMoney(settings);
  return onDevice(lang, () =>
    renderToStaticMarkup(
      createElement(LanguageProvider, {
        children: createElement(CurrencyValueProvider, { value, children: createElement(CurrencyCaptions, { pick: 'USD' }) }),
      })
    )
  );
}

/** The Settings page, signed in as `user`, with dollars picked, in one language. */
async function renderSettings(lang: Lang, settings: Record<string, any>, user: StubUser): Promise<string> {
  const { LanguageProvider } = await import('../src/LanguageContext');
  const { CurrencyValueProvider } = await import('../src/CurrencyContext');
  const { AuthContext } = await import('../src/AuthContext');
  const Settings = (await import('../src/pages/Settings')).default;
  const { value } = await clientMoney(settings);
  const auth = {
    isAuthenticated: true,
    user: { id: user.id, username: user.username ?? user.id, name: user.id, email: user.email, role: user.role },
    login: async () => {},
    loginWithGoogle: async () => {},
    register: async () => {},
    refreshUser: async () => {},
    logout: async () => {},
    isLoaded: true,
  };
  return onDevice(lang, () =>
    renderToStaticMarkup(
      createElement(LanguageProvider, {
        children: createElement(AuthContext.Provider, {
          value: auth as never,
          children: createElement(CurrencyValueProvider, { value, children: createElement(MemoryRouter, null, createElement(Settings)) }),
        }),
      })
    )
  );
}

/**
 * What the visitor reads off the rendered page: the rate after «≈» and
 * whether the page credits IQWealth with a link to its site.
 */
function readPage(html: string): { shownRate: string | null; creditsIqwealth: boolean; line: string } {
  const credits = /<a href="https:\/\/iraqsm\.com"[^>]*data-iqwealth-attribution/.test(html);
  const text = html.replace(/<[^>]+>/g, '').replace(/&#x27;/g, "'").replace(/&amp;/g, '&');
  const m = /≈\s*([\d,]+(?:\.\d+)?)/.exec(text);
  const at = m ? text.indexOf(m[0]) : -1;
  return { shownRate: m ? m[1]!.replace(/,/g, '') : null, creditsIqwealth: credits, line: at >= 0 ? text.slice(Math.max(0, at - 40), at + 110) : '' };
}

const NON_OWNERS = Object.entries(ROLES) as Array<[string, StubUser | null]>;

// ------------------------------------------------------------------ 1 — the owner's own example: 1,660 + 20 = 1,680

test('top-bar menu + Settings, every non-owner: «1 $ ≈ rate — based on IQWealth data ↗» minus IQWealth\'s published sell must not be the private market_adjustment_iqd', async () => {
  // DECISIONS row 189 decision 5: «سعر السوق 1,660 + 20 = 1,680».
  const PRIVATE_ADJUSTMENT = '20';
  const IQWEALTH_SELL = 1660;
  const { raw, iqwealthSell } = await shopWithPrivateAdjustment(PRIVATE_ADJUSTMENT, IQWEALTH_SELL);

  const found: string[] = [];
  let surfaces = 0;
  for (const [role, user] of NON_OWNERS) {
    const settings = await publicSettingsFor(raw, user);
    // The existing literal scanner passes: no private key, no literal adjustment field.
    assert.deepEqual(leaks({ settings }, { decimals: [] }), [], `${role}: the literal scan passes on /api/settings/public`);
    assert.equal('market_adjustment_iqd' in settings, false, `${role}: the adjustment is not named`);

    const pages: Array<[string, string]> = [];
    for (const lang of LANGS) {
      pages.push([`top-bar menu (${lang})`, await renderMenu(lang, settings)]);
      if (user) pages.push([`Settings page (${lang})`, await renderSettings(lang, settings, user)]);
    }
    for (const [where, html] of pages) {
      const page = readPage(html);
      assert.ok(page.shownRate, `${role} ${where}: the page prints the shop's rate (rendered: ${html.slice(0, 300)})`);
      surfaces++;
      if (!page.creditsIqwealth) continue;
      // The visitor follows the link to https://iraqsm.com, reads IQWealth's sell, subtracts.
      const derived = sub(page.shownRate!, iqwealthSell);
      if (same(derived, PRIVATE_ADJUSTMENT)) {
        found.push(`${role} — ${where}: «${page.line.trim()}» → ${page.shownRate} − IQWealth's sell ${iqwealthSell} (linked at https://iraqsm.com) = ${derived} = private market_adjustment_iqd`);
      }
    }
  }
  assert.ok(surfaces >= NON_OWNERS.length * LANGS.length, 'every non-owner surface was rendered');
  const roles = [...new Set(found.map((f) => f.split(' — ')[0]))];
  assert.ok(
    found.length === 0,
    `LEAK — the client bundle prints the effective rate and links the provider it is based on, so ${found.length}/${surfaces} non-owner surfaces ` +
      `(roles: ${roles.join(', ')}; top-bar menu + Settings, ar/en/ckb) hand out the owner's private market_adjustment_iqd ${PRIVATE_ADJUSTMENT}, e.g.:\n  ${found.slice(0, 3).join('\n  ')}`
  );
});

// ------------------------------------------------------------------ 2 — a fractional adjustment: to the nearest dinar on screen, exactly in the bundle's own storage

test('anonymous visitor: a fractional private adjustment is read to the nearest dinar from the menu, and exactly from the rate the bundle keeps on the device', async () => {
  const PRIVATE_ADJUSTMENT = '37.2501';
  const IQWEALTH_SELL = 1666;
  const { raw, iqwealthSell } = await shopWithPrivateAdjustment(PRIVATE_ADJUSTMENT, IQWEALTH_SELL);
  const settings = await publicSettingsFor(raw, ROLES.guest);
  assert.equal(JSON.stringify(settings).includes(PRIVATE_ADJUSTMENT), false, 'the adjustment is not spelled out');

  const problems: string[] = [];

  // (a) On screen: whole dinars after «≈», credited to IQWealth.
  for (const lang of LANGS) {
    const page = readPage(await renderMenu(lang, settings));
    assert.ok(page.shownRate, `${lang}: the menu prints the shop's rate`);
    if (page.creditsIqwealth && nearest(sub(page.shownRate!, iqwealthSell), PRIVATE_ADJUSTMENT)) {
      problems.push(`top-bar menu (${lang}) «${page.line.trim()}»: ${page.shownRate} − IQWealth ${iqwealthSell} = ${sub(page.shownRate!, iqwealthSell)} = the private ${PRIVATE_ADJUSTMENT} to the nearest dinar`);
    }
  }

  // (b) In the bundle: the exact text every dollar conversion divides by, and
  // what CurrencyProvider's effect (src/CurrencyContext.tsx) writes to the
  // device for the next first paint.
  const provider = readFileSync(join(ROOT, 'src/CurrencyContext.tsx'), 'utf8');
  assert.match(provider, /if \(rate && rate\.source === 'shop' && rate\.text !== cached\) rememberDisplayRate\(rate\.text\);/, 'the provider persists the shop rate');
  const { rememberDisplayRate, DISPLAY_RATE_CACHE_KEY } = await import('../src/lib/displayRate');
  const { rate, value } = await clientMoney(settings);
  assert.ok(rate && rate.source === 'shop' && rate.attributed === true, 'the bundle holds the shop rate, attributed to IQWealth');
  const stored = onDevice('en', (storage) => {
    rememberDisplayRate(rate!.text);
    return storage.getItem(DISPLAY_RATE_CACHE_KEY);
  });
  assert.ok(stored, 'the rate is kept on the device');
  const deviceRate = String((JSON.parse(stored!) as { rate: unknown }).rate);
  if (same(sub(deviceRate, iqwealthSell), PRIVATE_ADJUSTMENT)) {
    problems.push(`device storage ${DISPLAY_RATE_CACHE_KEY} = ${stored} (also the divisor of every dollar price, e.g. money(1,000,000) = ${value.money(1_000_000)}): ${deviceRate} − IQWealth ${iqwealthSell} = ${sub(deviceRate, iqwealthSell)} = the private ${PRIVATE_ADJUSTMENT} exactly`);
  }

  assert.ok(problems.length === 0, `LEAK — anonymous client surfaces give the owner's private market_adjustment_iqd ${PRIVATE_ADJUSTMENT}:\n  ${problems.join('\n  ')}`);
});
