import React, { createContext, useContext, useState, useEffect, ReactNode, useCallback } from 'react';
import { useAuth } from './AuthContext';
// THE SAME NORMALIZER THE SERVER CHARGES FROM, not a second guard beside it.
// packages/shipping/src/codTax is a pure leaf with no imports, so nothing of
// the Worker runtime enters the bundle, and it already holds the compiled
// default used ONLY as the fallback when the server has not sent a configured
// rate.
//
// IT IS IMPORTED RATHER THAN RE-IMPLEMENTED because the two sides of the rate
// are guarded differently and a local `> 0` gets one of them wrong. The BLOCK
// is a divisor, so a zero or non-finite block falls back — `Math.floor(x / 0)`
// is Infinity. The PER-BLOCK charge of exactly 0 is a REAL configured rate
// meaning «the charge is switched off», which the admin screen tells the owner
// to type and the server stores verbatim. Coercing that 0 back to the 3,000
// default would show the owner a charge they had just turned off and, on their
// next save of the pair, write 3,000 back to the server.
import { normalizeCodTaxRate } from '../packages/shipping/src/codTax';
import {
  api,
  WalletTx,
  PublicSettings,
  DeliveryMethod,
  CheckoutPaymentMethod,
  CartShippingMethod,
  ManualPaymentMethod,
} from './lib/api';

/**
 * Wallet + storefront settings state. Balances and transactions are
 * server-authoritative: the browser only displays what the API returns and
 * never computes or writes financial state itself.
 */

export type TransactionStatus = 'pending' | 'approved' | 'rejected';
export type TransactionType = 'deposit' | 'withdrawal';
export type Transaction = WalletTx;
export type { DeliveryMethod as CheckoutDeliveryMethod, CheckoutPaymentMethod, CartShippingMethod, ManualPaymentMethod as PaymentMethod };

interface WalletContextType {
  /** USD balance in cents. */
  balanceUsdCents: number;
  /** The same balance in dinars, computed server-side (migration 0108). */
  balanceIqd: number;
  /** Point balance (1 point = 1 IQD at checkout). */
  pointBalance: number;
  transactions: WalletTx[];
  pointTransactions: WalletTx[];
  paymentMethods: ManualPaymentMethod[];
  checkoutDeliveryMethods: DeliveryMethod[];
  checkoutPaymentMethods: CheckoutPaymentMethod[];
  cartShippingMethods: CartShippingMethod[];
  exchangeRate: number;
  /**
   * THE DOOR CHARGE, as two numbers: what one block costs and how big a block
   * is. Read from the same public settings the exchange rate comes from, and
   * falling back to the shipping module's compiled default so a client talking
   * to an older server still prints a real rate rather than «undefined».
   */
  codTaxPerBlockIqd: number;
  codTaxBlockIqd: number;
  currency: 'IQD' | 'USD';
  adVideoUrl: string;
  settings: PublicSettings | null;
  isLoaded: boolean;
  refreshWallet: () => Promise<void>;
  refreshSettings: () => Promise<void>;
  submitDeposit: (input: { amount_usd_cents: number; note?: string; paymentMethod?: string; receiptKey: string }) => Promise<void>;
  submitWithdrawal: (input: { amount_usd_cents: number; note?: string; accountNumber?: string }) => Promise<void>;
  // Admin-only setters (server enforces the role; these just call the API).
  updatePaymentMethods: (methods: ManualPaymentMethod[]) => Promise<void>;
  updateCheckoutDeliveryMethods: (methods: DeliveryMethod[]) => Promise<void>;
  updateCheckoutPaymentMethods: (methods: CheckoutPaymentMethod[]) => Promise<void>;
  updateCartShippingMethods: (methods: CartShippingMethod[]) => Promise<void>;
  setExchangeRate: (rate: number) => Promise<void>;
  setCodTaxRate: (rate: { perBlockIqd: number; blockIqd: number }) => Promise<void>;
  setCurrency: (currency: 'IQD' | 'USD') => Promise<void>;
  setAdVideoUrl: (url: string) => Promise<void>;
}

const WalletContext = createContext<WalletContextType | undefined>(undefined);

export function WalletProvider({ children }: { children: ReactNode }) {
  const { user, isLoaded: authLoaded } = useAuth();

  const [balanceUsdCents, setBalanceUsdCents] = useState(0);
  /**
   * THE BALANCE IN DINARS, AS THE SERVER COMPUTED IT (migration 0108).
   *
   * Not `usdCentsToIqd(balanceUsdCents, exchangeRate)`: that conversion is
   * what made a customer who typed 50,000 د.ع read 49,994, and it is also
   * computed here at a rate this context reads ONCE on mount and never
   * repolls — so a long-open tab would price a balance at a rate the shop has
   * since moved. The server owns the rule now; this only carries the answer.
   * 0 until the first load, exactly as `balanceUsdCents` is.
   */
  const [balanceIqd, setBalanceIqd] = useState(0);
  const [pointBalance, setPointBalance] = useState(0);
  const [transactions, setTransactions] = useState<WalletTx[]>([]);
  const [pointTransactions, setPointTransactions] = useState<WalletTx[]>([]);
  const [settings, setSettings] = useState<PublicSettings | null>(null);
  const [isLoaded, setIsLoaded] = useState(false);

  const refreshSettings = useCallback(async () => {
    try {
      const data = await api.get<{ settings: PublicSettings }>('/api/settings/public');
      setSettings(data.settings);
    } catch (e) {
      console.error('Failed to fetch settings', e);
    }
  }, []);

  const refreshWallet = useCallback(async () => {
    if (!user) {
      setBalanceUsdCents(0);
      setBalanceIqd(0);
      setPointBalance(0);
      setTransactions([]);
      setPointTransactions([]);
      return;
    }
    try {
      const data = await api.get<{
        balance_usd_cents: number;
        balance_iqd: number;
        point_balance: number;
        transactions: WalletTx[];
        point_transactions: WalletTx[];
      }>('/api/wallet');
      setBalanceUsdCents(data.balance_usd_cents);
      setBalanceIqd(Number(data.balance_iqd) || 0);
      setPointBalance(data.point_balance);
      setTransactions(data.transactions);
      setPointTransactions(data.point_transactions);
    } catch (e) {
      console.error('Failed to fetch wallet', e);
    }
  }, [user?.id]);

  useEffect(() => {
    if (!authLoaded) return;
    (async () => {
      await Promise.all([refreshSettings(), refreshWallet()]);
      setIsLoaded(true);
    })();
  }, [authLoaded, refreshSettings, refreshWallet]);

  const submitDeposit = useCallback(
    async (input: { amount_usd_cents: number; note?: string; paymentMethod?: string; receiptKey: string }) => {
      await api.post('/api/wallet/deposits', input);
      await refreshWallet();
    },
    [refreshWallet]
  );

  const submitWithdrawal = useCallback(
    async (input: { amount_usd_cents: number; note?: string; accountNumber?: string }) => {
      await api.post('/api/wallet/withdrawals', input);
      await refreshWallet();
    },
    [refreshWallet]
  );

  const saveSetting = useCallback(
    async (key: string, value: unknown) => {
      await api.put(`/api/admin/settings/${key}`, { value });
      await refreshSettings();
    },
    [refreshSettings]
  );

  const codTaxRate = normalizeCodTaxRate({
    perBlockIqd: settings?.codTaxPerBlockIqd,
    blockIqd: settings?.codTaxBlockIqd,
  });

  const value: WalletContextType = {
    balanceUsdCents,
    balanceIqd,
    pointBalance,
    transactions,
    pointTransactions,
    paymentMethods: settings?.paymentMethods ?? [],
    checkoutDeliveryMethods: settings?.checkoutDeliveryMethods ?? [],
    checkoutPaymentMethods: settings?.checkoutPaymentMethods ?? [],
    cartShippingMethods: settings?.cartShippingMethods ?? [],
    exchangeRate: settings?.exchangeRate ?? 1400,
    codTaxPerBlockIqd: codTaxRate.perBlockIqd,
    codTaxBlockIqd: codTaxRate.blockIqd,
    currency: settings?.currency ?? 'IQD',
    adVideoUrl: settings?.adVideoUrl ?? '',
    settings,
    isLoaded,
    refreshWallet,
    refreshSettings,
    submitDeposit,
    submitWithdrawal,
    updatePaymentMethods: (m) => saveSetting('paymentMethods', m),
    updateCheckoutDeliveryMethods: (m) => saveSetting('checkoutDeliveryMethods', m),
    updateCheckoutPaymentMethods: (m) => saveSetting('checkoutPaymentMethods', m),
    updateCartShippingMethods: (m) => saveSetting('cartShippingMethods', m),
    setExchangeRate: (rate) => saveSetting('exchangeRate', rate),
    // TWO WRITES, NOT ONE ROUND TRIP EACH: the pair is a single rate and a
    // half-applied change would charge «3,000 عن كل 1,000,000» until the
    // second save landed. They are awaited in order and the second is not
    // attempted if the first is refused.
    setCodTaxRate: async ({ perBlockIqd, blockIqd }) => {
      await saveSetting('codTaxBlockIqd', blockIqd);
      await saveSetting('codTaxPerBlockIqd', perBlockIqd);
    },
    setCurrency: (c) => saveSetting('currency', c),
    setAdVideoUrl: (url) => saveSetting('adVideoUrl', url),
  };

  return <WalletContext.Provider value={value}>{children}</WalletContext.Provider>;
}

export function useWallet() {
  const context = useContext(WalletContext);
  if (context === undefined) {
    throw new Error('useWallet must be used within a WalletProvider');
  }
  return context;
}
