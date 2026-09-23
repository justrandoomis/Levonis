import React, { createContext, useContext, useCallback, useMemo, useState, type ReactNode } from 'react';
import { useWallet } from './WalletContext';
import { formatIqd } from './lib/api';

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
 * IQD → US cents, at the administrator's rate. Cents, not dollars, so the
 * rounding happens once and in one place.
 *
 * FLOORED — THE ONE DOLLAR-READING RULE THE WALLET ALREADY USES. The owner's
 * «وعند الدولار يقرب الى عدد صحيح اقل — مثلا 35.71 = 50,000» is what
 * `iqdToUsdCents` (src/lib/api.ts) and the wallet header apply; this used
 * `Math.round`, so the same dinar figure read one cent differently on a
 * product page than in the wallet (50,007 د.ع: $35.72 here, $35.71 there).
 * Integer arithmetic, as there: `(iqd / rate) * 100` in floating point can
 * land a hair under a whole cent (1,400 → 99.99…) and floor would then lose
 * it. Dinars that are not whole are floored to the dinar first.
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

interface CurrencyContextValue {
  /** What the customer asked to read prices in. */
  currency: DisplayCurrency;
  setCurrency: (next: DisplayCurrency) => void;
  /** IQD per 1 USD — the administrator's own setting, served to everyone. */
  rate: number;
  /** True while prices on screen are a conversion rather than the stored
   *  figure. Screens that must disclose that read this. */
  converted: boolean;
  /** An IQD amount, formatted in the currency the customer chose. */
  money: (iqd: number) => string;
  /**
   * THE DINAR, ALWAYS, plus the conversion when one is being shown. For the
   * few places where money is committed or recorded — the checkout total, an
   * order, a receipt — where the number the bank will see must be on screen
   * whatever the switch says.
   */
  moneyBoth: (iqd: number) => string;
}

const CurrencyContext = createContext<CurrencyContextValue | undefined>(undefined);

export function CurrencyProvider({ children }: { children: ReactNode }) {
  // Read once, at mount: this is a per-device preference, not shared state,
  // and re-reading it on every render would be a storage hit per paint.
  const [currency, setCurrencyState] = useState<DisplayCurrency>(
    () => readStored() ?? DEFAULT_DISPLAY_CURRENCY
  );
  const { exchangeRate } = useWallet();

  const setCurrency = useCallback((next: DisplayCurrency) => {
    setCurrencyState(next);
    writeStored(next);
  }, []);

  const value = useMemo<CurrencyContextValue>(() => {
    const converted = currency === 'USD';
    const money = (iqd: number) =>
      converted ? formatUsdFromIqd(iqd, exchangeRate) : formatIqd(iqd);
    return {
      currency,
      setCurrency,
      rate: exchangeRate,
      converted,
      money,
      // «1,750,000 د.ع · ‎$1,250.00» — the charge first, the reading after it.
      moneyBoth: (iqd: number) =>
        converted ? `${formatIqd(iqd)} · ${formatUsdFromIqd(iqd, exchangeRate)}` : formatIqd(iqd),
    };
  }, [currency, setCurrency, exchangeRate]);

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
