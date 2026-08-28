import React, { useState, useEffect, useCallback } from 'react';
import { api, ApiError, WalletTx, formatUsdCents } from '../lib/api';
import { Check, X, Wallet, FileImage, RefreshCw } from 'lucide-react';

type AdminWalletTx = WalletTx & { email?: string; username?: string; userId?: string };

export default function AdminWalletRequests() {
  const [transactions, setTransactions] = useState<AdminWalletTx[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [filter, setFilter] = useState<'all' | 'pending' | 'approved' | 'rejected'>('pending');
  const [loadingAction, setLoadingAction] = useState<string | null>(null);
  // Inline decision panel: which request is being decided, in which direction, with what note.
  const [decision, setDecision] = useState<{ id: string; action: 'approved' | 'rejected'; note: string } | null>(null);
  const [actionError, setActionError] = useState<{ id: string; message: string } | null>(null);

  const fetchTransactions = useCallback(async () => {
    setLoading(true);
    setLoadError(null);
    try {
      const data = await api.get<{ requests: AdminWalletTx[] }>('/api/admin/wallet-requests');
      setTransactions(data.requests);
    } catch (err) {
      setLoadError(err instanceof ApiError ? err.message : 'Failed to load wallet requests');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchTransactions();
  }, [fetchTransactions]);

  const confirmDecision = async () => {
    if (!decision || loadingAction) return;
    setLoadingAction(`${decision.action}-${decision.id}`);
    setActionError(null);
    try {
      await api.post(`/api/admin/wallet-requests/${decision.id}/decide`, {
        status: decision.action,
        adminNote: decision.note || undefined,
      });
      setDecision(null);
      await fetchTransactions();
    } catch (err) {
      // Surfaces e.g. INSUFFICIENT_BALANCE on withdrawal approvals honestly.
      setActionError({ id: decision.id, message: err instanceof ApiError ? err.message : 'Action failed' });
    } finally {
      setLoadingAction(null);
    }
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
          <button
            onClick={fetchTransactions}
            className="p-2 bg-zinc-900 border border-zinc-800 hover:bg-zinc-800 rounded-xl text-zinc-400 hover:text-white transition-colors"
            title="Refresh"
          >
            <RefreshCw className={`w-4 h-4 ${loading ? 'animate-spin' : ''}`} />
          </button>
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

      {loadError && (
        <div className="bg-red-500/10 border border-red-500/30 text-red-400 rounded-2xl p-4 text-sm font-medium">
          {loadError}
        </div>
      )}

      <div className="space-y-4">
        {filtered.map(t => (
          <div key={t.id} className="bg-zinc-900 border border-zinc-800 rounded-3xl p-5 shadow-sm hover:shadow-md transition-shadow">
            <div className="flex flex-col md:flex-row md:items-center justify-between gap-4">
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
                  <div className="text-sm text-zinc-400 font-medium flex flex-wrap items-center gap-2">
                    <span className="text-zinc-200">{t.email || t.username || t.userId || 'Unknown user'}</span>
                    {t.paymentMethod && (
                      <>
                        <span className="text-zinc-600">•</span>
                        <span className="uppercase">{t.paymentMethod}</span>
                      </>
                    )}
                    {t.accountNumber && (
                      <>
                        <span className="text-zinc-600">•</span>
                        <span dir="ltr">{t.accountNumber}</span>
                      </>
                    )}
                    <span className="text-zinc-600">•</span>
                    <span>{t.date ? new Date(t.date).toLocaleDateString() : '—'}</span>
                  </div>
                  {t.hasReceipt && t.receiptUrl && (
                    <a
                      href={t.receiptUrl}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="inline-flex items-center gap-1.5 mt-2 text-xs font-bold text-[#6B46FF] hover:text-[#8B6BFF] transition-colors"
                    >
                      <FileImage className="w-3.5 h-3.5" /> View receipt
                    </a>
                  )}
                  {t.note && (
                    <div className="text-xs text-zinc-500 mt-1 max-w-md" title={t.note}>User note: {t.note}</div>
                  )}
                </div>
              </div>

              <div className="flex flex-col md:items-end gap-2 border-t md:border-t-0 md:border-l border-zinc-800 pt-4 md:pt-0 md:pl-6">
                <div className="text-xl font-black text-white">
                  {formatUsdCents(t.amount)}
                </div>
                {t.status === 'pending' && decision?.id !== t.id && (
                  <div className="flex gap-2">
                    <button
                      onClick={() => { setActionError(null); setDecision({ id: t.id, action: 'approved', note: '' }); }}
                      disabled={!!loadingAction}
                      className="flex items-center gap-1 bg-[#2CE59B] hover:bg-[#06D6A0] text-white px-3 py-1.5 rounded-xl text-xs font-bold transition-all shadow-[0_4px_10px_rgba(44,229,155,0.4)] hover:scale-105 disabled:opacity-50"
                    >
                      <Check className="w-3 h-3" /> Approve
                    </button>
                    <button
                      onClick={() => { setActionError(null); setDecision({ id: t.id, action: 'rejected', note: '' }); }}
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

            {/* Inline decision panel with an admin-note input */}
            {decision?.id === t.id && (
              <div className="mt-4 pt-4 border-t border-zinc-800">
                <div className="flex flex-col sm:flex-row items-stretch sm:items-end gap-3">
                  <div className="flex-1">
                    <label className="block text-xs font-bold text-zinc-500 uppercase tracking-wider mb-1.5">
                      {decision.action === 'approved' ? 'Admin note (optional)' : 'Rejection reason (optional)'}
                    </label>
                    <input
                      type="text"
                      value={decision.note}
                      onChange={e => setDecision({ ...decision, note: e.target.value })}
                      placeholder={decision.action === 'approved' ? 'e.g. Verified against the receipt' : 'e.g. Receipt does not match the amount'}
                      className="w-full bg-zinc-800 border border-zinc-700 text-white px-3 py-2 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-[#6B46FF]/50"
                      autoFocus
                    />
                  </div>
                  <div className="flex gap-2 shrink-0">
                    <button
                      onClick={confirmDecision}
                      disabled={!!loadingAction}
                      className={`px-4 py-2 rounded-xl text-sm font-bold transition-all disabled:opacity-50 ${
                        decision.action === 'approved'
                          ? 'bg-[#2CE59B] hover:bg-[#06D6A0] text-black'
                          : 'bg-red-500/90 hover:bg-red-500 text-white'
                      }`}
                    >
                      {loadingAction ? 'Working...' : decision.action === 'approved' ? 'Confirm Approve' : 'Confirm Reject'}
                    </button>
                    <button
                      onClick={() => setDecision(null)}
                      disabled={!!loadingAction}
                      className="px-4 py-2 rounded-xl text-sm font-bold bg-zinc-800 hover:bg-zinc-700 text-zinc-300 transition-colors disabled:opacity-50"
                    >
                      Cancel
                    </button>
                  </div>
                </div>
              </div>
            )}

            {actionError?.id === t.id && (
              <div className="mt-3 bg-red-500/10 border border-red-500/30 text-red-400 rounded-xl p-3 text-sm font-medium">
                {actionError.message}
              </div>
            )}
          </div>
        ))}
        {!loading && filtered.length === 0 && (
          <div className="text-center text-zinc-500 py-16 bg-zinc-900/50 border border-zinc-800/50 rounded-3xl border-dashed">
            No {filter !== 'all' ? filter : ''} requests found
          </div>
        )}
        {loading && transactions.length === 0 && (
          <div className="text-center text-zinc-500 py-16 bg-zinc-900/50 border border-zinc-800/50 rounded-3xl border-dashed">
            Loading...
          </div>
        )}
      </div>
    </div>
  );
}
