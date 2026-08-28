import React, { useState, useEffect } from 'react';
import { useWallet } from '../WalletContext';
import { queryDb } from '../lib/db';
import { Check, X, Wallet, Search, Filter } from 'lucide-react';

export default function AdminWalletRequests() {
  const { updateTransactionStatus } = useWallet();
  const [transactions, setTransactions] = useState<any[]>([]);
  const [filter, setFilter] = useState<'all' | 'pending' | 'approved' | 'rejected'>('pending');
  const [loadingAction, setLoadingAction] = useState<string | null>(null);

  useEffect(() => {
    fetchTransactions();
  }, []);

  const fetchTransactions = async () => {
    try {
      const res = await queryDb("SELECT wallet_transactions.*, users.email FROM wallet_transactions LEFT JOIN users ON wallet_transactions.userId = users.id WHERE wallet_transactions.currency = 'USD' ORDER BY wallet_transactions.date DESC");
      setTransactions(res);
    } catch (err) {
      console.error(err);
    }
  };

  const handleApprove = async (id: string) => {
    if (loadingAction) return;
    const note = prompt('Add optional admin note (or leave blank):') || undefined;
    setLoadingAction(`approve-${id}`);
    await updateTransactionStatus(id, 'approved', note);
    await fetchTransactions();
    setLoadingAction(null);
  };

  const handleReject = async (id: string) => {
    if (loadingAction) return;
    const note = prompt('Add rejection reason (or leave blank):') || undefined;
    setLoadingAction(`reject-${id}`);
    await updateTransactionStatus(id, 'rejected', note);
    await fetchTransactions();
    setLoadingAction(null);
  };

  const filtered = transactions.filter(t => filter === 'all' ? true : t.status === filter);
  const pendingCount = transactions.filter(t => t.status === 'pending').length;

  return (
    <div className="space-y-6">
      <div className="flex flex-col md:flex-row justify-between items-start md:items-center gap-4">
        <div className="flex items-center gap-3">
          <h2 className="text-2xl font-black text-white">Wallet Requests</h2>
          {pendingCount > 0 && (
            <span className="bg-[#FF6B6B] text-white px-3 py-1 rounded-full text-xs font-bold shadow-sm">{pendingCount} Pending</span>
          )}
        </div>
        
        <div className="flex bg-zinc-900 border border-zinc-800 p-1 rounded-xl">
          {(['all', 'pending', 'approved', 'rejected'] as const).map(f => (
            <button
              key={f}
              onClick={() => setFilter(f)}
              className={`px-4 py-2 rounded-lg text-sm font-bold capitalize transition-colors ${filter === f ? 'bg-zinc-800 text-white' : 'text-zinc-500 hover:text-zinc-300'}`}
            >
              {f}
            </button>
          ))}
        </div>
      </div>

      <div className="space-y-4">
        {filtered.map(t => (
          <div key={t.id} className="bg-zinc-900 border border-zinc-800 rounded-3xl p-5 flex flex-col md:flex-row md:items-center justify-between gap-4 shadow-sm hover:shadow-md transition-shadow">
            <div className="flex items-center gap-4">
              <div className={`w-12 h-12 rounded-2xl flex items-center justify-center border shadow-inner shrink-0 ${
                t.type === 'deposit' ? 'bg-[#2CE59B]/10 border-[#2CE59B]/20' : 'bg-[#FF6B9E]/10 border-[#FF6B9E]/20'
              }`}>
                <Wallet className={`w-5 h-5 ${t.type === 'deposit' ? 'text-[#2CE59B]' : 'text-[#FF6B9E]'}`} />
              </div>
              <div>
                <div className="flex items-center gap-2 mb-1">
                  <h3 className="font-bold text-white capitalize text-lg">{t.type}</h3>
                  <span className={`px-2 py-0.5 rounded-lg text-[10px] font-bold uppercase tracking-wider ${
                    t.status === 'pending' ? 'bg-[#FFD166]/20 text-[#FFB703]' :
                    t.status === 'approved' ? 'bg-[#2CE59B]/20 text-[#06D6A0]' : 'bg-[#FF6B6B]/20 text-[#EF476F]'
                  }`}>
                    {t.status}
                  </span>
                </div>
                <div className="text-sm text-zinc-400 font-medium flex items-center gap-2">
                  <span className="text-zinc-200">{t.email}</span> 
                  <span className="text-zinc-600">•</span>
                  <span className="uppercase">{t.paymentMethod}</span>
                  <span className="text-zinc-600">•</span>
                  <span>{new Date(t.date).toLocaleDateString()}</span>
                </div>
              </div>
            </div>
            
            <div className="flex flex-col md:items-end gap-2 border-t md:border-t-0 md:border-l border-zinc-800 pt-4 md:pt-0 md:pl-6">
              <div className="text-xl font-black text-white">
                ${t.amount.toFixed(2)}
              </div>
              {t.status === 'pending' && (
                <div className="flex gap-2">
                  <button 
                    onClick={() => handleApprove(t.id)}
                    disabled={!!loadingAction}
                    className="flex items-center gap-1 bg-[#2CE59B] hover:bg-[#06D6A0] text-white px-3 py-1.5 rounded-xl text-xs font-bold transition-all shadow-[0_4px_10px_rgba(44,229,155,0.4)] hover:scale-105 disabled:opacity-50"
                  >
                    <Check className="w-3 h-3" /> Approve
                  </button>
                  <button 
                    onClick={() => handleReject(t.id)}
                    disabled={!!loadingAction}
                    className="flex items-center gap-1 bg-zinc-900 border border-zinc-700 hover:bg-zinc-800/50 text-zinc-300 px-3 py-1.5 rounded-xl text-xs font-bold transition-all shadow-sm hover:scale-105 disabled:opacity-50"
                  >
                    <X className="w-3 h-3" /> Reject
                  </button>
                </div>
              )}
              {t.adminNote && (
                <div className="text-xs text-zinc-500 max-w-[200px] text-right truncate" title={t.adminNote}>
                  Note: {t.adminNote}
                </div>
              )}
            </div>
          </div>
        ))}
        {filtered.length === 0 && (
          <div className="text-center text-zinc-500 py-16 bg-zinc-900/50 border border-zinc-800/50 rounded-3xl border-dashed">
            No {filter !== 'all' ? filter : ''} requests found
          </div>
        )}
      </div>
    </div>
  );
}
