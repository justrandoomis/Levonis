import React, { createContext, useContext, useState, useEffect, ReactNode, useCallback } from 'react';
import { queryDb, initDb } from './lib/db';
import { useAuth } from './AuthContext';

export type TransactionStatus = 'pending' | 'approved' | 'rejected';
export type TransactionType = 'deposit' | 'withdrawal';

export interface Transaction {
  id: string;
  type: TransactionType;
  amount: number;
  status: TransactionStatus;
  date: string;
  receiptUrl?: string; // Base64 string for this client-side demo
  note?: string;
  adminNote?: string;
  accountNumber?: string;
  currency?: string;
}

export interface PaymentMethod {
  id: string;
  name: string;
  details: string;
}

export interface CheckoutDeliveryMethod {
  id: string;
  titleAr: string;
  titleEn: string;
  descAr: string;
  descEn: string;
  price: number;
  icon: string;
}

export interface CheckoutPaymentMethod {
  id: string;
  titleAr: string;
  titleEn: string;
  icon: string;
}

export interface CartShippingMethod {
  id: string;
  titleAr: string;
  titleEn: string;
  descAr: string;
  descEn: string;
}

interface WalletContextType {
  balance: number;
  pointBalance: number;
  pointTransactions: Transaction[];
  transactions: Transaction[];
  paymentMethods: PaymentMethod[];
  checkoutDeliveryMethods: CheckoutDeliveryMethod[];
  checkoutPaymentMethods: CheckoutPaymentMethod[];
  cartShippingMethods: CartShippingMethod[];
  addTransaction: (transaction: Omit<Transaction, 'id' | 'status' | 'date'>) => Promise<void>;
  addReward: (amount: number, note: string) => Promise<void>;
  chargeWallet: (amount: number, note: string) => Promise<void>;
  updateTransactionStatus: (id: string, status: TransactionStatus, adminNote?: string) => Promise<void>;
  updatePaymentMethods: (methods: PaymentMethod[]) => Promise<void>;
  updateCheckoutDeliveryMethods: (methods: CheckoutDeliveryMethod[]) => Promise<void>;
  updateCheckoutPaymentMethods: (methods: CheckoutPaymentMethod[]) => Promise<void>;
  updateCartShippingMethods: (methods: CartShippingMethod[]) => Promise<void>;
  clearNotifications: () => void;
  unreadNotifications: number;
  exchangeRate: number;
  setExchangeRate: (rate: number) => Promise<void>;
  currency: 'IQD' | 'USD';
  setCurrency: (currency: 'IQD' | 'USD') => Promise<void>;
  isLoaded: boolean;
  adVideoUrl: string;
  setAdVideoUrl: (url: string) => Promise<void>;
}

const WalletContext = createContext<WalletContextType | undefined>(undefined);

export function WalletProvider({ children }: { children: ReactNode }) {
  const { user, isLoaded: authLoaded } = useAuth();
  
  const [balance, setBalance] = useState<number>(0);
  const [pointBalance, setPointBalance] = useState<number>(0);
  const [pointTransactions, setPointTransactions] = useState<Transaction[]>([]);
  const [transactions, setTransactions] = useState<Transaction[]>([]);
  const [paymentMethods, setPaymentMethods] = useState<PaymentMethod[]>([
    { id: '1', name: 'ZainCash', details: '07838455220' },
    { id: '2', name: 'Master Card', details: '7110172799' }
  ]);
  const [checkoutDeliveryMethods, setCheckoutDeliveryMethods] = useState<CheckoutDeliveryMethod[]>([
    { id: 'standard', titleAr: 'توصيل عادي', titleEn: 'Standard Delivery', descAr: '2-3 أيام عمل', descEn: '2-3 business days', price: 5000, icon: 'Truck' },
    { id: 'personal', titleAr: 'توصيل شخصي', titleEn: 'Personal Delivery', descAr: 'نفس اليوم', descEn: 'Same day delivery', price: 10000, icon: 'User' },
    { id: 'pickup', titleAr: 'استلام من المخزن', titleEn: 'Store Pickup', descAr: 'جاهز خلال ساعتين', descEn: 'Ready in 2 hours', price: 0, icon: 'Store' }
  ]);
  const [checkoutPaymentMethods, setCheckoutPaymentMethods] = useState<CheckoutPaymentMethod[]>([
    { id: 'card', titleAr: 'البطاقة الائتمانية', titleEn: 'Credit Card', icon: 'CreditCard' },
    { id: 'wallet', titleAr: 'محفظة ليفو', titleEn: 'Levo Wallet', icon: 'Wallet' },
    { id: 'cash', titleAr: 'الدفع عند الاستلام', titleEn: 'Cash on Delivery', icon: 'Banknote' },
    { id: 'full_advance', titleAr: 'الدفع مقدما بالكامل', titleEn: 'Full Payment in Advance', icon: 'CreditCard' },
    { id: 'half_advance', titleAr: 'دفع نصف المبلغ مقدما', titleEn: '50% Payment in Advance', icon: 'CreditCard' }
  ]);
  const [cartShippingMethods, setCartShippingMethods] = useState<CartShippingMethod[]>([
    { id: 'direct', titleAr: 'شحن مباشر', titleEn: 'Direct Shipping', descAr: 'يصل خلال 3-5 أيام عمل', descEn: 'Arrives in 3-5 business days' },
    { id: 'preorder_air', titleAr: 'طلب مسبق (شحن جوي)', titleEn: 'Pre-order (Air Freight)', descAr: 'يصل خلال 10-14 يوم عمل', descEn: 'Arrives in 10-14 business days' },
    { id: 'preorder_sea', titleAr: 'طلب مسبق (شحن بحري)', titleEn: 'Pre-order (Sea Freight)', descAr: 'يصل خلال 30-45 يوم عمل', descEn: 'Arrives in 30-45 business days' },
    { id: 'preorder_land', titleAr: 'طلب مسبق (شحن بري)', titleEn: 'Pre-order (Land Freight)', descAr: 'يصل خلال 20-30 يوم عمل', descEn: 'Arrives in 20-30 business days' }
  ]);
  const [unreadNotifications, setUnreadNotifications] = useState(0);
  const [exchangeRate, setExchangeRate] = useState<number>(1400);
  const [currency, setCurrency] = useState<'IQD' | 'USD'>('IQD');
  const [isLoaded, setIsLoaded] = useState(false);
  const [adVideoUrl, setAdVideoUrl] = useState<string>('');

  const fetchSettings = useCallback(async () => {
    try {
      const settings = await queryDb<{key: string, value: string}>(`SELECT * FROM admin_settings`);
      settings.forEach(s => {
        if (s.key === 'exchangeRate') setExchangeRate(Number(s.value));
        if (s.key === 'currency') setCurrency(s.value as 'IQD' | 'USD');
        if (s.key === 'paymentMethods') setPaymentMethods(JSON.parse(s.value));
        if (s.key === 'checkoutDeliveryMethods') setCheckoutDeliveryMethods(JSON.parse(s.value));
        if (s.key === 'checkoutPaymentMethods') setCheckoutPaymentMethods(JSON.parse(s.value));
        if (s.key === 'cartShippingMethods') setCartShippingMethods(JSON.parse(s.value));
        if (s.key === 'adVideoUrl') setAdVideoUrl(s.value);
      });
    } catch (e) {
      console.error("Failed to fetch settings", e);
    }
  }, []);

  const fetchTransactions = useCallback(async () => {
    try {
      // In a real app, you would filter by user ID.
      // Here we just fetch all for the demo.
      if (!user) return;
      const txs = await queryDb<Transaction>(`SELECT * FROM wallet_transactions WHERE userId = ? ORDER BY date DESC`, [user.id]);
      
      const usdTransactions = txs.filter(t => !t.currency || t.currency === 'USD');
      const ptsTransactions = txs.filter(t => t.currency === 'POINT');
      
      setTransactions(usdTransactions);
      setPointTransactions(ptsTransactions);
      
      let bal = 0;
      usdTransactions.forEach(t => {
        if (t.status === 'approved') {
          bal += (t.type === 'deposit' ? t.amount : -t.amount);
        }
      });
      setBalance(bal);
      
      let ptsBal = 0;
      ptsTransactions.forEach(t => {
        if (t.status === 'approved') {
          ptsBal += (t.type === 'deposit' ? t.amount : -t.amount);
        }
      });
      setPointBalance(ptsBal);
    } catch (e) {
      console.error("Failed to fetch transactions", e);
    }
  }, [user?.id]);

  useEffect(() => {
    if (!authLoaded) return;
    
    const loadAll = async () => {
      try {
        await initDb();
        await fetchSettings();
        if (user) {
          await fetchTransactions();
        } else {
          setTransactions([]);
          setBalance(0);
          setPointTransactions([]);
          setPointBalance(0);
        }
      } catch (e) {
        console.error("Failed to init DB", e);
      } finally {
        setIsLoaded(true);
      }
    };
    
    loadAll();
  }, [authLoaded, user, fetchSettings, fetchTransactions]);

  const addTransaction = async (transactionData: Omit<Transaction, 'id' | 'status' | 'date'>) => {
    const id = Math.random().toString(36).substr(2, 9);
    const date = new Date().toISOString();
    const status = 'pending';
    
    const newTx: Transaction = { ...transactionData, id, status, date };
    
    try {
      await queryDb(`
        INSERT INTO wallet_transactions (id, userId, type, amount, status, date, receiptUrl, note, accountNumber, currency)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'USD')
      `, [id, user?.id || null, newTx.type, newTx.amount, status, date, newTx.receiptUrl || null, newTx.note || null, newTx.accountNumber || null]);
      
      setTransactions(prev => [newTx, ...prev]);
    } catch (e) {
      console.error("Add transaction failed", e);
      throw e;
    }
  };

  
  const chargeWallet = async (amount: number, note: string) => {
    const id = Math.random().toString(36).substr(2, 9);
    const date = new Date().toISOString();
    const status = 'approved';
    const type = 'withdrawal';
    
    const newTx: Transaction = { id, type, amount, status, date, note };
    
    try {
      await queryDb(`
        INSERT INTO wallet_transactions (id, userId, type, amount, status, date, note, currency)
        VALUES (?, ?, ?, ?, ?, ?, ?, 'USD')
      `, [id, user?.id || null, type, amount, status, date, note]);
      
      setTransactions(prev => [newTx, ...prev]);
      setBalance(b => b - amount);
    } catch (e) {
      console.error("Charge wallet failed", e);
      throw e;
    }
  };

  const addReward = async (amount: number, note: string) => {
    const id = Math.random().toString(36).substr(2, 9);
    const date = new Date().toISOString();
    const status = 'approved';
    const type = 'deposit';
    
    const newTx: Transaction = { id, type, amount, status, date, note };
    
    try {
      await queryDb(`
        INSERT INTO wallet_transactions (id, userId, type, amount, status, date, note, currency)
        VALUES (?, ?, ?, ?, ?, ?, ?, 'POINT')
      `, [id, user?.id || null, type, amount, status, date, note]);
      
      setPointTransactions(prev => [newTx, ...prev]);
      setPointBalance(b => b + amount);
    } catch (e) {
      console.error("Add reward failed", e);
      throw e;
    }
  };

  const updateTransactionStatus = async (id: string, status: TransactionStatus, adminNote?: string) => {
    try {
      await queryDb(`UPDATE wallet_transactions SET status = ?, adminNote = ? WHERE id = ?`, [status, adminNote || null, id]);
      
      setTransactions(prev => prev.map(t => t.id === id ? { ...t, status, adminNote } : t));
      
      const targetTx = transactions.find(t => t.id === id);
      if (targetTx && targetTx.status === 'pending' && status === 'approved') {
        const amountChange = targetTx.type === 'deposit' ? targetTx.amount : -targetTx.amount;
        setBalance(b => b + amountChange);
      }
      
      setUnreadNotifications(prev => prev + 1);
    } catch (e) {
      console.error("Update transaction failed", e);
    }
  };

  const updatePaymentMethods = async (methods: PaymentMethod[]) => {
    try {
      await queryDb(`INSERT INTO admin_settings (key, value) VALUES ('paymentMethods', ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value`, [JSON.stringify(methods)]);
      setPaymentMethods(methods);
    } catch (e) {
      console.error("Failed to update payment methods", e);
    }
  };

  const updateCheckoutDeliveryMethods = async (methods: CheckoutDeliveryMethod[]) => {
    try {
      await queryDb(`INSERT INTO admin_settings (key, value) VALUES ('checkoutDeliveryMethods', ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value`, [JSON.stringify(methods)]);
      setCheckoutDeliveryMethods(methods);
    } catch (e) {
      console.error("Failed to update checkout delivery methods", e);
    }
  };

  const updateCheckoutPaymentMethods = async (methods: CheckoutPaymentMethod[]) => {
    try {
      await queryDb(`INSERT INTO admin_settings (key, value) VALUES ('checkoutPaymentMethods', ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value`, [JSON.stringify(methods)]);
      setCheckoutPaymentMethods(methods);
    } catch (e) {
      console.error("Failed to update checkout payment methods", e);
    }
  };

  const updateCartShippingMethods = async (methods: CartShippingMethod[]) => {
    try {
      await queryDb(`INSERT INTO admin_settings (key, value) VALUES ('cartShippingMethods', ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value`, [JSON.stringify(methods)]);
      setCartShippingMethods(methods);
    } catch (e) {
      console.error("Failed to update cart shipping methods", e);
    }
  };

  const clearNotifications = () => {
    setUnreadNotifications(0);
  };

  const setAdVideoUrlDb = async (url: string) => {
    try {
      await queryDb(`INSERT INTO admin_settings (key, value) VALUES ('adVideoUrl', ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value`, [url]);
      setAdVideoUrl(url);
    } catch (e) {
      console.error(e);
    }
  };

  const setCurrencyDb = async (curr: 'IQD' | 'USD') => {
    try {
      await queryDb(`INSERT INTO admin_settings (key, value) VALUES ('currency', ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value`, [curr]);
      setCurrency(curr);
    } catch (e) {
      console.error("Failed to set currency", e);
    }
  };

  const setExchangeRateDb = async (rate: number) => {
    try {
      await queryDb(`INSERT INTO admin_settings (key, value) VALUES ('exchangeRate', ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value`, [rate.toString()]);
      setExchangeRate(rate);
    } catch (e) {
      console.error("Failed to set exchange rate", e);
    }
  };

  return (
    <WalletContext.Provider value={{
      balance,
      transactions,
      pointBalance,
      pointTransactions,
      paymentMethods,
      checkoutDeliveryMethods,
      checkoutPaymentMethods,
      cartShippingMethods,
      addTransaction,
      addReward,
      chargeWallet,
      updateTransactionStatus,
      updatePaymentMethods,
      updateCheckoutDeliveryMethods,
      updateCheckoutPaymentMethods,
      updateCartShippingMethods,
      clearNotifications,
      unreadNotifications,
      exchangeRate,
      setExchangeRate: setExchangeRateDb,
      currency,
      setCurrency: setCurrencyDb,
      isLoaded,
      adVideoUrl,
      setAdVideoUrl: setAdVideoUrlDb
    }}>
      {children}
    </WalletContext.Provider>
  );
}

export function useWallet() {
  const context = useContext(WalletContext);
  if (context === undefined) {
    throw new Error('useWallet must be used within a WalletProvider');
  }
  return context;
}
