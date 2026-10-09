import React, { createContext, useContext, useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';
import { useWallet } from './WalletContext';
import { formatIqd, formatUsdCents } from './lib/api';
import { iqdToUsdCentsExact, readCachedDisplayRate, rememberDisplayRate, usableRate } from './lib/displayRate';

/**
 * «تغيير العملة وأقصد بها هو أن الدينار مقابل الدولار, في لوحة الإدارة يكون
 *  سعر الدولار يساوي 1400 دينار فيتم التحويل عند تغيير العملة.»
 *
 * WHAT WAS THERE AND WHAT WAS NOT. The rate already existed and was already
 * the administrator's: `exchangeRate` is an `admin_settings` row served to
 * every visitor by GET /api/settings/public, editable in «إعدادات المحفظة»,
 * and defaulting to 1400. The wallet page has converted with it for months.
 * What did not exist was any way for a customer to ask for that conversion on
 * the shop itself — src/pages/Settings.tsx said so in as many words: «لا يوجد
 * إعداد عملة عرض لكل حساب». This is that setting.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * THE DINAR IS THE PRICE. THE DOLLAR IS A READING OF IT.
 *
 * Every price in this shop is stored, charged, refunded and reported in IQD.
 * Nothing here changes that, and nothing here is ever sent to the server: this
 * context converts a number on its way to the screen and stops. A cart line
 * posts the same body, a checkout charges the same total, an order records the
 * same figure, whichever way the switch is set.
 *
 * That is also why the CHECKOUT keeps the dinar on screen even in USD (see
 * `moneyBoth`). A customer about to commit money must be able to read the
 * number their bank will see, and a converted figure — at a rate the shop sets
 * and can change tomorrow — is not that number.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * PER DEVICE, NOT PER ACCOUNT, and deliberately.
 *
 * It is a reading preference with no order and no security consequence, like
 * the language and the theme, and it wants to work for a signed-out visitor —
 * who is most of the shop's traffic and exactly the person browsing to decide
 * whether to sign up. Storing it server-side would gate a display toggle
 * behind an account for no gain. `localStorage` can throw (private mode,
 * blocked site data), so every read and write is wrapped and the fallback is
 * the shop's own currency.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * ROUNDING. Dinars are whole: `formatIqd` rounds, and a fils has not existed
 * in practice for a generation. Dollars are shown to the cent, because $12.34
 * and $12 are different claims and this figure is already an approximation —
 * rounding it again would widen the gap between what is shown and what is
 * charged without telling anyone.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * THE RATE IS THE SHOP'S, NEVER THE WALLET'S (FX programme plan §13, D7, Q5;
 * owner decision 9, 2026-10-09).
 *
 * `money()` divides by `settings.displayUsdRate`: the effective USD/IQD — the
 * Iraqi parallel-market sell plus the owner's fixed adjustment, once approved
 * — as decimal text, converted exactly (src/lib/displayRate.ts). The wallet's
 * `exchangeRate` (1 USD = 1,400 IQD) is a different rate with a different
 * job and is NEVER a fallback here: until the owner approves the first value
 * the server sends null and a dollar reader sees DINARS, with a note that the
 * dollar reading comes once the shop's rate is approved. Before the settings
 * arrive, the last SHOP rate this device showed prices at is used
 * (`levonis.displayRate.v1`); with none, dinars — never «$0.00», never 1,400.
 *
 * WALLET FIGURES KEEP THE WALLET'S RATE ON EVERY SCREEN (critique M2). The
 * wallet's ledger is USD cents converted at `exchangeRate` (1,400), and a
 * balance read at the market rate beside a debit read at 1,400 is one charge
 * in two dollar figures. So:
 *   - a wallet amount (balance, applied, remaining, shortfall, debit) →
 *     `walletMoney(iqd, usdCents)`: the ledger's own cents in USD, or the
 *     dinars when only dinars are known;
 *   - a charge paid from the wallet (a membership price and amount due) →
 *     `walletCharge(iqd)`: dinars, always;
 *   - catalogue prices, cart lines and order totals → `money()`.
 */

export type DisplayCurrency = 'IQD' | 'USD';

/** The shop's own currency, and what an unanswered question means. */
export const DEFAULT_DISPLAY_CURRENCY: DisplayCurrency = 'IQD';

const STORAGE_KEY = 'levonis.displayCurrency.v1';

function isDisplayCurrency(value: unknown): value is DisplayCurrency {
  return value === 'IQD' || value === 'USD';
}

/** The stored choice, or null when there is none and when storage refuses. */
function readStored(): DisplayCurrency | null {
  if (typeof window === 'undefined') return null;
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    return isDisplayCurrency(raw) ? raw : null;
  } catch {
    return null;
  }
}

function writeStored(currency: DisplayCurrency): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(STORAGE_KEY, currency);
  } catch {
    /* A device that will not store it still gets the switch for this session. */
  }
}

/**
 * IQD → US cents, at a NUMBER rate — the wallet's own conversion (its rate is
 * the `exchangeRate` setting). Cents, not dollars, so the rounding happens
 * once and in one place.
 *
 * FLOORED — THE ONE DOLLAR-READING RULE THE WALLET ALREADY USES. The owner's
 * «وعند الدولار يقرب الى عدد صحيح اقل — مثلا 35.71 = 50,000» is what
 * `iqdToUsdCents` (src/lib/api.ts) and the wallet header apply. Integer
 * arithmetic, as there: `(iqd / rate) * 100` in floating point can land a hair
 * under a whole cent (1,400 → 99.99…) and floor would then lose it. Dinars
 * that are not whole are floored to the dinar first.
 *
 * The shop's display rate is decimal text and goes through
 * `iqdToUsdCentsExact` (src/lib/displayRate.ts) instead; the two agree on
 * every whole-number rate (tests/displayCurrency.test.ts).
 */
export function iqdToUsdCentsAt(iqd: number, rate: number): number {
  if (!Number.isFinite(iqd) || !Number.isFinite(rate) || rate <= 0) return 0;
  return Math.floor((Math.floor(iqd) * 100) / rate);
}

/** «$1,234.56» — a real figure to the cent, in LTR digits. */
export function formatUsdFromIqd(iqd: number, rate: number): string {
  const cents = iqdToUsdCentsAt(iqd, rate);
  return `$${(cents / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

/** Where the rate on screen came from. Never the wallet: its `exchangeRate` is not a market rate (owner decision 9). */
export type DisplayRateSource =
  /** The shop's effective USD/IQD (`displayUsdRate`). */
  | 'shop'
  /** The last shop rate this device showed prices at, before the settings arrive. */
  | 'cache';

export interface DisplayRate {
  /** IQD per 1 USD, exact decimal text. */
  text: string;
  source: DisplayRateSource;
  /** The shop's rate is the provider's figure (credited to IQWealth); false when the owner typed it. */
  attributed?: boolean;
}

/**
 * THE RATE A DOLLAR PRICE IS READ AT, decided in one place (plan §13, owner
 * decision 9):
 *   1. the settings are in and carry a usable `displayUsdRate` → the shop's rate;
 *   2. the settings are in without one (null: not approved yet; absent: an
 *      older server) → null: prices read in DINARS. The wallet's
 *      `exchangeRate` is the wallet's own rate, never a market reading;
 *   3. the settings are not in yet → the last shop rate this device used;
 *   4. nothing usable → null, and every price reads in dinars.
 */
export function resolveDisplayRate(input: {
  settingsLoaded: boolean;
  displayUsdRate: unknown;
  cached: string | null;
  attributed?: boolean;
}): DisplayRate | null {
  if (input.settingsLoaded) {
    const shop = usableRate(input.displayUsdRate);
    return shop ? { text: shop, source: 'shop', attributed: input.attributed !== false } : null;
  }
  const cached = usableRate(input.cached);
  return cached ? { text: cached, source: 'cache' } : null;
}

interface CurrencyContextValue {
  /** What the customer asked to read prices in. */
  currency: DisplayCurrency;
  setCurrency: (next: DisplayCurrency) => void;
  /**
   * The rate prices are read at — the shop's effective USD/IQD as decimal
   * text, its source, or null when no rate is usable (prices then read in
   * dinars, whatever the switch says).
   */
  rate: DisplayRate | null;
  /** True while prices on screen are a conversion rather than the stored
   *  figure. Screens that must disclose that read this. */
  converted: boolean;
  /**
   * The public settings have arrived. Until then a null `rate` means only
   * "not known yet", not "the shop has no rate": a note that says the shop's
   * rate is not approved waits for this (FX-1A review #5).
   */
  settingsLoaded: boolean;
  /** An IQD amount, formatted in the currency the customer chose. */
  money: (iqd: number) => string;
  /**
   * THE DINAR, ALWAYS, plus the conversion when one is being shown. For the
   * few places where money is committed or recorded — the checkout total, an
   * order, a receipt — where the number the bank will see must be on screen
   * whatever the switch says.
   */
  moneyBoth: (iqd: number) => string;
  /**
   * A WALLET AMOUNT — a balance, an amount applied, a remainder, a shortfall,
   * a wallet debit. In dollars it is the LEDGER'S OWN CENTS (the wallet's rate,
   * never the market's); when only dinars are known, it is the dinars.
   */
  walletMoney: (iqd: number, usdCents?: number | null) => string;
  /** A CHARGE PAID FROM THE WALLET (a membership price, an amount due): dinars, always. */
  walletCharge: (iqd: number) => string;
}

const CurrencyContext = createContext<CurrencyContextValue | undefined>(undefined);

/** Build the context value. Exported for the tests, which render screens in either currency. */
export function currencyValue(
  currency: DisplayCurrency,
  setCurrency: (next: DisplayCurrency) => void,
  rate: DisplayRate | null,
  settingsLoaded = true
): CurrencyContextValue {
  const usdOf = (iqd: number): string | null => {
    if (!rate) return null;
    const cents = iqdToUsdCentsExact(iqd, rate.text);
    return cents === null ? null : formatUsdCents(cents);
  };
  const converted = currency === 'USD' && rate !== null;
  const money = (iqd: number) => (converted ? usdOf(iqd) ?? formatIqd(iqd) : formatIqd(iqd));
  return {
    currency,
    setCurrency,
    rate,
    converted,
    settingsLoaded,
    money,
    // «1,750,000 د.ع · ‎$1,250.00» — the charge first, the reading after it.
    moneyBoth: (iqd: number) => {
      const usd = converted ? usdOf(iqd) : null;
      return usd ? `${formatIqd(iqd)} · ${usd}` : formatIqd(iqd);
    },
    walletMoney: (iqd: number, usdCents?: number | null) =>
      currency === 'USD' && typeof usdCents === 'number' && Number.isFinite(usdCents) ? formatUsdCents(usdCents) : formatIqd(iqd),
    walletCharge: (iqd: number) => formatIqd(iqd),
  };
}

export function CurrencyProvider({ children }: { children: ReactNode }) {
  // Read once, at mount: this is a per-device preference, not shared state,
  // and re-reading it on every render would be a storage hit per paint.
  const [currency, setCurrencyState] = useState<DisplayCurrency>(
    () => readStored() ?? DEFAULT_DISPLAY_CURRENCY
  );
  const [cached] = useState<string | null>(() => readCachedDisplayRate());
  const { displayUsdRate, displayUsdRateAttributed: attributed } = useWallet();

  const setCurrency = useCallback((next: DisplayCurrency) => {
    setCurrencyState(next);
    writeStored(next);
  }, []);

  // Another tab changed it: follow, so two open tabs never disagree (the
  // theme does the same, src/lib/theme.ts).
  useEffect(() => {
    const onStorage = (e: StorageEvent) => {
      if (e.key !== STORAGE_KEY) return;
      setCurrencyState(readStored() ?? DEFAULT_DISPLAY_CURRENCY);
    };
    window.addEventListener('storage', onStorage);
    return () => window.removeEventListener('storage', onStorage);
  }, []);

  // `undefined` until the settings arrive; null when the server sends none.
  const settingsLoaded = displayUsdRate !== undefined;
  const rate = useMemo(
    () => resolveDisplayRate({ settingsLoaded, displayUsdRate, cached, attributed }),
    [settingsLoaded, displayUsdRate, cached, attributed]
  );

  // The next first paint starts from the SHOP rate prices were just shown at
  // (written only when it differs from what this device already holds). Only
  // the shop's own rate is ever remembered: a first paint never reads dollars
  // at a rate that was not the shop's.
  useEffect(() => {
    if (rate && rate.source === 'shop' && rate.text !== cached) rememberDisplayRate(rate.text);
  }, [rate, cached]);

  const value = useMemo<CurrencyContextValue>(
    () => currencyValue(currency, setCurrency, rate, settingsLoaded),
    [currency, setCurrency, rate, settingsLoaded]
  );

  return <CurrencyContext.Provider value={value}>{children}</CurrencyContext.Provider>;
}

/**
 * THE ONE WAY A PRICE REACHES THE SCREEN.
 *
 * Callers write `money(product.price_iqd)` where they used to write
 * `formatIqd(product.price_iqd)`. `formatIqd` itself is untouched and is still
 * correct — it is what the admin screens, the ledger and every server-side
 * string use, and none of those follow a customer's reading preference.
 */
export function useMoney(): CurrencyContextValue {
  const context = useContext(CurrencyContext);
  if (context === undefined) {
    throw new Error('useMoney must be used within a CurrencyProvider');
  }
  return context;
}

/** The same value, or undefined outside a CurrencyProvider (a control that renders in both). */
export function useOptionalMoney(): CurrencyContextValue | undefined {
  return useContext(CurrencyContext);
}

/** For tests that render a screen in a chosen currency without a WalletProvider. */
export const CurrencyValueProvider = CurrencyContext.Provider;
