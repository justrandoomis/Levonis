import React, { useState, useEffect } from 'react';
import { Wallet as WalletIcon, ArrowUpRight, ArrowDownLeft, Plus, History } from 'lucide-react';
import { useLanguage } from '../LanguageContext';
import { api, formatIqd } from '../lib/api';

interface WalletTransaction {
  id: string;
  type: 'credit' | 'debit';
  amount: number;
  title: string;
  created_at: string;
}

export default function Wallet() {
  const { loc } = useLanguage();
  const [balance, setBalance] = useState<number>(0);
  const [transactions, setTransactions] = useState<WalletTransaction[]>([]);
  const [toastMessage, setToastMessage] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    api
      .get<{ balance_usd_cents?: number; transactions?: WalletTransaction[] }>('/api/wallet')
      .then((res) => {
        if (active) {
          const bal = res.balance_usd_cents ? (res.balance_usd_cents / 100) * 1530 : 0;
          setBalance(bal);
          setTransactions(res.transactions || []);
        }
      })
      .catch(() => {});
    return () => {
      active = false;
    };
  }, []);

  return (
    <div className="min-h-screen bg-black text-white pb-24">
      <div className="max-w-xl mx-auto px-4 py-8">
        <div className="flex items-center gap-3 mb-6">
          <div className="p-3 rounded-2xl bg-olive/20 border border-olive/40 text-olive">
            <WalletIcon className="w-6 h-6" />
          </div>
          <div>
            <h1 className="text-2xl font-black text-white">
              {loc('محفظة ليفونيس الرقمية', 'Levonis Wallet', 'جزدانی لێڤۆنیس')}
            </h1>
            <p className="text-xs text-zinc-400 mt-0.5">
              {loc('رصيدك المتاح للشراء والطلبات والاشتراكات', 'Your available balance for instant checkout', 'باڵانسی بەردەستت بۆ کڕین')}
            </p>
          </div>
        </div>

        {/* Balance Card */}
        <div className="p-6 rounded-3xl bg-gradient-to-br from-zinc-900 to-zinc-950 border border-zinc-800 shadow-xl mb-6 relative overflow-hidden">
          <div className="text-xs text-zinc-400 mb-1">{loc('الرصيد المتاح', 'Available Balance', 'باڵانسی بەردەست')}</div>
          <div className="text-3xl font-black text-white font-mono tracking-tight">{formatIqd(balance)}</div>

          <div className="mt-6 flex items-center gap-3">
            <button
              type="button"
              onClick={() => {
                setToastMessage(loc('خدمة الشحن الإلكتروني (ZainCash, FIB, Qi) متاحة عند إتمام الطلبات', 'Top-up services via local gateways active at checkout', 'خزمەتگوزاری پڕکردنەوە چالاکە'));
                setTimeout(() => setToastMessage(null), 4000);
              }}
              className="px-5 py-2.5 rounded-xl bg-gradient-to-r from-olive to-emerald-600 hover:from-emerald-500 hover:to-emerald-600 text-white font-bold text-xs flex items-center gap-2 shadow-lg"
            >
              <Plus className="w-4 h-4" />
              <span>{loc('شحن الرصيد', 'Top Up', 'پڕکردنەوە')}</span>
            </button>
          </div>

          {toastMessage && (
            <div className="mt-4 p-3 rounded-xl bg-olive/20 border border-olive/40 text-xs text-emerald-200">
              {toastMessage}
            </div>
          )}
        </div>

        {/* Transactions List */}
        <div>
          <h2 className="font-bold text-sm text-zinc-300 mb-3 flex items-center gap-2">
            <History className="w-4 h-4 text-zinc-400" />
            <span>{loc('سجل المعاملات', 'Transaction History', 'مێژووی مامەڵەکان')}</span>
          </h2>

          {transactions.length > 0 ? (
            <div className="space-y-2">
              {transactions.map((tx, idx) => (
                <div
                  key={tx.id || idx}
                  className="p-3.5 rounded-2xl bg-zinc-900/60 border border-zinc-800/80 flex items-center justify-between"
                >
                  <div className="flex items-center gap-3">
                    <div className="p-2 rounded-xl bg-zinc-800 text-zinc-300">
                      {tx.type === 'credit' ? (
                        <ArrowDownLeft className="w-4 h-4 text-emerald-400" />
                      ) : (
                        <ArrowUpRight className="w-4 h-4 text-rose-400" />
                      )}
                    </div>
                    <div>
                      <div className="text-xs font-bold text-white">{tx.title || 'Transaction'}</div>
                      <div className="text-[11px] text-zinc-500">{new Date(tx.created_at || Date.now()).toLocaleDateString()}</div>
                    </div>
                  </div>
                  <div className={`font-mono text-sm font-bold ${tx.type === 'credit' ? 'text-emerald-400' : 'text-zinc-200'}`}>
                    {tx.type === 'credit' ? '+' : '-'}{formatIqd(tx.amount || 0)}
                  </div>
                </div>
              ))}
            </div>
          ) : (
            <div className="p-8 rounded-2xl bg-zinc-900/40 border border-zinc-800/60 text-center text-zinc-500 text-xs">
              {loc('لا توجد معاملات سابقة', 'No transactions yet', 'هیچ مامەڵەیەک ئەنجامنەدراوە')}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
