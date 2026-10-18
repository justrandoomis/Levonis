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
 * THE DOLLAR IS THE PRICE WHEREVER THE SHOP SET ONE; ONLY DINAR-NATIVE AMOUNTS
 * ARE READ AT THE DISPLAY RATE (DECISIONS row 248, amending row 243).
 *
 * The owner, 2026-10-17: «الدولار هو الاساس كما اتفقنا وليس العكس … الدولار هو
 * الثابت والدينار العراقي هو المتغير بسعر الصرف». Pricing V2 builds every price
 * from dollars and derives the dinar from them at the applied rate, rounded UP
 * (row 245). Dividing that rounded dinar back by a rate turned the round-up
 * into extra cents — the shop's $15.20 → $14.00 read as $15.66 → $14.45. So
 * the server now sends the shop's own dollar price beside every figure that
 * has one (`*_usd_cents`), and in dollars `money(iqd, usdCents)` prints THAT.
 * Only a figure without one — delivery, COD tax, warranty, points, coupons, a
 * member price, a dinar-typed offer, a bundle, a merchant's product, an older
 * order — is converted at the display rate, and a total is the sum of the
 * dollar prices plus ONE conversion of the dinar remainder (`usdTotal`).
 *
 * THE DINAR IS STILL WHAT IS CHARGED. Every price is stored, charged, refunded
 * and reported in IQD; nothing here is ever sent to the server. A cart line
 * posts the same body, a checkout charges the same total, an order records the
 * same figure, whichever way the switch is set.
 *
 * That is also why the CHECKOUT keeps the dinar on screen even in USD (see
 * `moneyBoth`). A customer about to commit money must be able to read the
 * number their bank will see.
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
 * ONE OFFICIAL RATE (owner 2026-10-18, DECISIONS row 252): the server now sends
 * the applied USD/IQD the products are priced at as BOTH `displayUsdRate`
 * (exactly) and the wallet's `exchangeRate` (in whole dinars), so the two
 * paths below read the same rate; they stay separate only so an older server,
 * or a shop with no applied rate yet, never converts prices at the legacy 1,400.
 *
 * THE RATE IS THE SHOP'S, NEVER THE WALLET'S (FX programme plan §13, D7, Q5;
 * owner decision 9, 2026-10-09).
 *
 * `money()` divides by `settings.displayUsdRate`: the shop's display USD/IQD —
 * the Iraqi parallel-market sell the shop's rate was last built from, once
 * approved (never the owner's private adjustment on top of it, DECISIONS row
 * 220), or, while no market figure exists and the shop's rate is on MANUAL,
 * the rate the owner typed (DECISIONS row 246, `displayUsdRateAttributed`
 * false: the shop's own, never credited to IQWealth) — as decimal text,
 * converted exactly (src/lib/displayRate.ts). The wallet's
 * `exchangeRate` (1 USD = 1,400 IQD) is a different rate with a different
 * job and is NEVER a fallback here: with no shop rate (a fresh shop, an older
 * server) the server sends null, prices read in DINARS and the switchers say
 * so and offer dinars only (`usdUnavailable`) — never a USD choice that
 * silently shows dinars. Before the settings
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
  /** The shop's display USD/IQD (`displayUsdRate`). */
  | 'shop'
  /** The last shop rate this device showed prices at, before the settings arrive. */
  | 'cache';

export interface DisplayRate {
  /** IQD per 1 USD, exact decimal text. */
  text: string;
  source: DisplayRateSource;
  /** True: the provider's market figure (credited to IQWealth). False: the rate the owner typed, published while no market figure exists (DECISIONS row 246) — «a rate set by the shop». */
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
  /**
   * DOLLARS CANNOT BE READ (DECISIONS row 246): the settings are in and carry
   * no shop rate (a fresh shop, an older server). The switchers then show
   * dinars, offer dinars only and say why — never a USD choice that silently
   * shows dinars. The stored choice is kept: dollars return with the rate.
   */
  usdUnavailable: boolean;
  /**
   * An IQD amount, formatted in the currency the customer chose. In dollars,
   * the shop's own dollar price (`usdCents`, from the server) when the figure
   * has one, else the dinars read at the display rate.
   */
  money: (iqd: number, usdCents?: number | null) => string;
  /**
   * THE DINAR, ALWAYS, plus the dollar figure when one is being shown. For the
   * few places where money is committed or recorded — the checkout total, an
   * order, a receipt — where the number the bank will see must be on screen
   * whatever the switch says.
   */
  moneyBoth: (iqd: number, usdCents?: number | null) => string;
  /**
   * A TOTAL IN DOLLARS (DECISIONS row 248): the sum of each line's dollar
   * price, plus ONE conversion of the dinar remainder (delivery, fees, points,
   * coupons, member discounts and lines without a dollar price). Null when
   * prices are not being read in dollars. Pass it to `money` / `moneyBoth`
   * beside the dinar total.
   */
  usdTotal: (totalIqd: number, lines: readonly UsdLine[]) => number | null;
  /**
   * ONE FIGURE IN DOLLARS FROM ITS DOLLAR BASE (DECISIONS row 248): the base's
   * own cents plus one conversion of what the figure holds beyond it — a unit
   * with a warranty, a route commission or a direct premium on top of a price
   * the shop set in dollars (`unitUsdBase`). Null without a base, or when
   * prices are not being read in dollars (the figure is then converted whole).
   */
  usdWith: (iqd: number, base: UsdLine | null | undefined) => number | null;
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

/** One line of a total: its dinars, and its dollar price in cents when it has one (null/absent = none). */
export interface UsdLine {
  iqd: number;
  usdCents?: number | null;
}

/** A dollar figure the server sent: whole, non-negative, safe cents. Anything else is no figure. */
export function isUsdCents(v: unknown): v is number {
  return typeof v === 'number' && Number.isSafeInteger(v) && v >= 0;
}

/**
 * THE DOLLAR TOTAL, PURE (see `usdTotal`): Σ the lines' dollar prices + one
 * conversion, at the display rate, of what the dinar total holds beyond the
 * lines that had one. Sign-aware: a remainder below zero (points, a coupon
 * larger than the fees) is subtracted as the conversion of its size. Null with
 * no usable rate.
 */
export function usdTotalCents(totalIqd: number, lines: readonly UsdLine[], rateText: string | null | undefined): number | null {
  if (!Number.isFinite(totalIqd)) return null;
  let baseCents = 0;
  let baseIqd = 0;
  for (const l of lines) {
    if (!isUsdCents(l.usdCents) || !Number.isFinite(l.iqd)) continue;
    baseCents += l.usdCents;
    baseIqd += l.iqd;
  }
  const rest = iqdToUsdCentsExact(totalIqd - baseIqd, rateText);
  return rest === null ? null : baseCents + rest;
}

/** The dinar and dollar figures a unit's dollar base is read from (a quote, a level, a cart or order line). */
export interface UnitUsdFigures {
  unit_subtotal_iqd?: number | null;
  unit_subtotal_usd_cents?: number | null;
  applied_iqd?: number | null;
  applied_usd_cents?: number | null;
}

/**
 * THE DOLLAR BASE OF A UNIT (DECISIONS row 248): the part of the unit the shop
 * priced in dollars, as `{ iqd, usdCents }`. The whole unit when it has its
 * own twin; otherwise its APPLIED price — the product itself — when that has
 * one and a dinar-native fee sits on top of it (the extended warranty, a
 * pre-order route's commission, a direct premium). The fee is then the
 * remainder `usdWith` / `usdTotal` convert, so a warranty never takes the
 * printer's own dollar price away with it. `unitIqd` is the unit actually
 * charged: a line whose unit is not the figures' unit (a gift's 0, a bundle,
 * a locked price) has no base. Null = the unit is converted whole.
 */
export function unitUsdBase(f: UnitUsdFigures | null | undefined, unitIqd?: number | null): UsdLine | null {
  if (!f) return null;
  const unit = typeof unitIqd === 'number' ? unitIqd : f.unit_subtotal_iqd;
  if (typeof unit !== 'number' || !Number.isSafeInteger(unit) || unit <= 0) return null;
  if (typeof f.unit_subtotal_iqd === 'number' && f.unit_subtotal_iqd !== unit) return null;
  if (isUsdCents(f.unit_subtotal_usd_cents)) return { iqd: unit, usdCents: f.unit_subtotal_usd_cents };
  const applied = f.applied_iqd;
  if (isUsdCents(f.applied_usd_cents) && typeof applied === 'number' && Number.isSafeInteger(applied) && applied > 0 && applied <= unit) {
    return { iqd: applied, usdCents: f.applied_usd_cents };
  }
  return null;
}

/** A unit's dollar base for `qty` units: exact integer cents × quantity. */
export function scaleUsdLine(base: UsdLine | null | undefined, qty: number): UsdLine | null {
  if (!base || !isUsdCents(base.usdCents) || !Number.isSafeInteger(qty) || qty < 0) return null;
  return { iqd: base.iqd * qty, usdCents: base.usdCents * qty };
}

/** `usdWith`, pure: the base's cents plus one conversion of the rest; null without a base or a usable rate. */
export function usdWithBaseCents(iqd: number, base: UsdLine | null | undefined, rateText: string | null | undefined): number | null {
  if (!base || !isUsdCents(base.usdCents)) return null;
  return usdTotalCents(iqd, [base], rateText);
}

/**
 * THE «−N٪» BESIDE A STRUCK PAIR: the server's percent of the DOLLAR pair when
 * the pair is read in dollars and it sent one, else its percent of the dinar
 * pair — always the percent of the two numbers on screen (rule D9).
 */
export function shownSavingPercent(
  converted: boolean,
  iqdPercent: number | null | undefined,
  usdPercent: number | null | undefined
): number | null {
  if (converted && typeof usdPercent === 'number' && usdPercent >= 1) return usdPercent;
  return typeof iqdPercent === 'number' && iqdPercent >= 1 ? iqdPercent : null;
}

/**
 * A STRUCK PAIR IS NEVER HALF BASE AND HALF CONVERSION (DECISIONS row 248).
 * With a struck price beside it, the dollar prices are used only when BOTH
 * exist; otherwise both sides are converted. Alone, a price keeps its own.
 */
export function pairedUsd(
  priceUsd: number | null | undefined,
  struckUsd: number | null | undefined,
  struck: boolean
): { price: number | null; struck: number | null } {
  const price = isUsdCents(priceUsd) ? priceUsd : null;
  if (!struck) return { price, struck: null };
  const before = isUsdCents(struckUsd) ? struckUsd : null;
  return price !== null && before !== null && before > price ? { price, struck: before } : { price: null, struck: null };
}

/** Build the context value. Exported for the tests, which render screens in either currency. */
export function currencyValue(
  currency: DisplayCurrency,
  setCurrency: (next: DisplayCurrency) => void,
  rate: DisplayRate | null,
  settingsLoaded = true
): CurrencyContextValue {
  // The shop's own dollar price when the figure has one (DECISIONS row 248), else the dinars read at the rate.
  const usdOf = (iqd: number, usdCents?: number | null): string | null => {
    if (!rate) return null;
    if (isUsdCents(usdCents)) return formatUsdCents(usdCents);
    const cents = iqdToUsdCentsExact(iqd, rate.text);
    return cents === null ? null : formatUsdCents(cents);
  };
  const converted = currency === 'USD' && rate !== null;
  const money = (iqd: number, usdCents?: number | null) => (converted ? usdOf(iqd, usdCents) ?? formatIqd(iqd) : formatIqd(iqd));
  return {
    currency,
    setCurrency,
    rate,
    converted,
    settingsLoaded,
    usdUnavailable: settingsLoaded && rate === null,
    money,
    // «1,750,000 د.ع · ‎$1,250.00» — the charge first, the dollars after it.
    moneyBoth: (iqd: number, usdCents?: number | null) => {
      const usd = converted ? usdOf(iqd, usdCents) : null;
      return usd ? `${formatIqd(iqd)} · ${usd}` : formatIqd(iqd);
    },
    usdTotal: (totalIqd: number, lines: readonly UsdLine[]) => (converted ? usdTotalCents(totalIqd, lines, rate!.text) : null),
    usdWith: (iqd: number, base: UsdLine | null | undefined) => (converted ? usdWithBaseCents(iqd, base, rate!.text) : null),
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

/**
 * THE TWO HALVES OF WHAT `money()` WRITES: «1,575,000 د.ع» → ['1,575,000', 'د.ع'], so a card can draw the
 * amount at 15 px and the unit at 10.5 px — and so an amount can be an LTR island while its unit follows
 * the sentence's direction (an Arabic or Sorani line with Latin digits keeps the unit where the main price
 * has it). Anything else (a USD reading, «$1,050.00») comes back whole with no unit.
 *
 * It lives here, in the module that writes the string and that the first paint already loads, rather than
 * in a file of its own: a module that small becomes a sub-1 KB chunk of its own (tests/motionLazy.test.ts).
 */
export function splitMoney(text: string): [string, string] {
  const m = /^(.*[\d\u0660-\u0669\u06F0-\u06F9])\s+(د\.ع|IQD)$/.exec(text);
  return m ? [m[1], m[2]] : [text, ''];
}

/** The same value, or undefined outside a CurrencyProvider (a control that renders in both). */
export function useOptionalMoney(): CurrencyContextValue | undefined {
  return useContext(CurrencyContext);
}

/** For tests that render a screen in a chosen currency without a WalletProvider. */
export const CurrencyValueProvider = CurrencyContext.Provider;
