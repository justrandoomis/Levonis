import React, { useCallback, useEffect, useState } from 'react';
import { useLanguage } from '../LanguageContext';
import { api, ApiError, WalletTx, formatIqd, formatUsdCents, formatWalletIqd } from '../lib/api';
import { useWallet } from '../WalletContext';
import {
  Users,
  ShoppingCart,
  Wallet,
  Check,
  X,
  MessageSquare,
  ArrowUpRight,
  ArrowDownRight,
  Clock,
  Zap,
  CheckCircle2,
  Crown,
  TrendingUp,
} from 'lucide-react';

interface OverviewStats {
  orders_total: number;
  orders_pending: number;
  orders_delivered: number;
  revenue_iqd: number;
  users_total: number;
  pro_subscribers: number;
  plus_subscribers: number;
  investors: number;
  incoming_usd_cents: number;
  outgoing_usd_cents: number;
  pending_wallet_requests: number;
  open_community_requests: number;
}

interface RecentOrder {
  id: string;
  status: string;
  total_iqd: number;
  created_at: string;
  user_id?: string;
}

type PendingWalletRequest = WalletTx & { email?: string; username?: string };

const EMPTY_STATS: OverviewStats = {
  orders_total: 0,
  orders_pending: 0,
  orders_delivered: 0,
  revenue_iqd: 0,
  users_total: 0,
  pro_subscribers: 0,
  plus_subscribers: 0,
  investors: 0,
  incoming_usd_cents: 0,
  outgoing_usd_cents: 0,
  pending_wallet_requests: 0,
  open_community_requests: 0,
};

const ORDER_STATUS_COLORS: Record<string, string> = {
  pending: 'bg-yellow-500/20 text-yellow-300',
  confirmed: 'bg-blue-500/20 text-blue-300',
  processing: 'bg-purple-500/20 text-purple-300',
  shipped: 'bg-cyan-500/20 text-cyan-300',
  delivered: 'bg-[#2CE59B]/20 text-[#2CE59B]',
  cancelled: 'bg-red-500/20 text-red-400',
};

export default function AdminOverview({ onNavigateTab }: { onNavigateTab?: (tab: string) => void }) {
  const { dir } = useLanguage();
  /**
   * THE ADMIN READS DINARS — «اجعله يكون العملة هي العملة العراقية بالافتراضي».
   *
   * `exchangeRate` is the admin's own setting (IQD per 1 USD, default 1400,
   * edited in Wallet settings) and it is already public and already on this
   * context, because the customer's wallet page has been converting with it
   * all along. These cards were the only place left printing the ledger's raw
   * cents.
   */
  const { exchangeRate } = useWallet();

  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [stats, setStats] = useState<OverviewStats>(EMPTY_STATS);
  const [pendingWalletRequests, setPendingWalletRequests] = useState<PendingWalletRequest[]>([]);
  const [recentOrders, setRecentOrders] = useState<RecentOrder[]>([]);
  const [loadingActionId, setLoadingActionId] = useState<string | null>(null);
  const [actionError, setActionError] = useState<{ id: string; message: string } | null>(null);

  const fetchOverviewData = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const data = await api.get<{
        stats: OverviewStats;
        pending_wallet_requests: PendingWalletRequest[];
        recent_orders: RecentOrder[];
      }>('/api/admin/overview');
      setStats(data.stats);
      setPendingWalletRequests(data.pending_wallet_requests);
      setRecentOrders(data.recent_orders);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'Failed to load the overview');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchOverviewData();
  }, [fetchOverviewData]);

  const decideWallet = async (req: PendingWalletRequest, status: 'approved' | 'rejected') => {
    if (loadingActionId) return;
    // A hold-backed withdrawal is decided by its own workflow: the quick
    // button here APPROVES FOR PROCESSING (no money moves); paying it out,
    // with the payout reference, happens in Wallet Requests. A deposit goes
    // through the guarded deposit decision (amount-mismatch refusal, dedup
    // release, Telegram close), whose rejection needs a written reason. The
    // legacy decision stays only for withdrawals filed before the holds
    // engine, which have no workflow row.
    const wd = req.type === 'withdrawal' ? req.withdrawal : null;
    const isDeposit = req.type === 'deposit';
    let adminNote: string | undefined;
    if (status === 'rejected') {
      const required = !!wd || isDeposit;
      const note = window.prompt(
        required
          ? (dir === 'rtl' ? 'سبب الرفض (مطلوب):' : 'Rejection reason (required):')
          : (dir === 'rtl' ? 'سبب الرفض (اختياري):' : 'Rejection reason (optional):')
      );
      if (note === null) return; // cancelled
      if (required && note.trim().length < 3) {
        setActionError({ id: req.id, message: dir === 'rtl' ? 'اكتب سبب الرفض (3 أحرف على الأقل)' : 'Write the rejection reason (at least 3 characters)' });
        return;
      }
      adminNote = note || undefined;
    }
    setLoadingActionId(`${status}-${req.id}`);
    setActionError(null);
    try {
      if (wd) {
        const base = `/api/wallet/admin/withdrawals/${wd.id}`;
        if (status === 'approved') await api.post(`${base}/approve`, {});
        else await api.post(`${base}/reject`, { reason: (adminNote ?? '').trim() });
      } else if (isDeposit) {
        const base = `/api/wallet/admin/deposits/${req.id}`;
        if (status === 'approved') await api.post(`${base}/approve`, {});
        else await api.post(`${base}/reject`, { reason: (adminNote ?? '').trim() });
      } else {
        await api.post(`/api/admin/wallet-requests/${req.id}/decide`, { status, adminNote });
      }
      await fetchOverviewData();
    } catch (e) {
      setActionError({ id: req.id, message: e instanceof ApiError ? e.message : 'Action failed' });
    } finally {
      setLoadingActionId(null);
    }
  };

  const statCard = (
    label: string,
    value: React.ReactNode,
    icon: React.ReactNode,
    accent: string,
    onClick?: () => void
  ) => (
    <div
      onClick={onClick}
      className={`bg-[#18181b]/80 backdrop-blur-xl border border-white/5 rounded-xl p-3 shadow-[0_4px_16px_rgba(0,0,0,0.25)] flex items-center gap-2.5 ${onClick ? 'cursor-pointer hover:border-white/15 transition-colors' : ''}`}
    >
      <div className={`w-8 h-8 rounded-lg flex items-center justify-center shrink-0 ${accent}`}>{icon}</div>
      <div className="min-w-0">
        <div className="text-[9px] font-black uppercase tracking-wider text-zinc-500 mb-0.5">{label}</div>
        <div className="text-[15px] font-black text-white truncate">{loading ? '…' : value}</div>
      </div>
    </div>
  );

  return (
    <div className="space-y-4 text-white pb-10 font-sans" dir={dir}>

      {/* Top Bar */}
      <div className="flex flex-col lg:flex-row items-center justify-between gap-3 bg-zinc-900/90 border border-zinc-800 p-3 rounded-2xl shadow-xl backdrop-blur-xl">
        <div className="flex items-center gap-3 w-full lg:w-auto">
          <div className="w-9 h-9 rounded-xl bg-gradient-to-tr from-[#c5a059] via-[#e6c27a] to-[#708238] flex items-center justify-center shadow-lg shadow-[#c5a059]/30 shrink-0 font-black text-sm text-white">
            L
          </div>
          <div>
            <h1 className="text-base font-black text-white flex items-center gap-2">
              {dir === 'rtl' ? 'لوحة القيادة والإحصائيات' : 'Executive Overview Dashboard'}
            </h1>
            <p className="text-[11px] text-zinc-400 font-medium">
              {dir === 'rtl' ? 'إحصائيات حقيقية من قاعدة البيانات' : 'Live figures straight from the database'}
            </p>
          </div>
        </div>

        <div className="flex items-center gap-3 w-full lg:w-auto justify-end">
          <button
            onClick={fetchOverviewData}
            disabled={loading}
            className="flex items-center gap-1.5 px-3 py-1.5 min-h-9 bg-zinc-800 hover:bg-zinc-700 border border-zinc-700 rounded-lg text-zinc-300 hover:text-white transition-all shadow-sm active:scale-95 disabled:opacity-50 text-[11px] font-bold"
            title={dir === 'rtl' ? 'تحديث البيانات' : 'Refresh Data'}
          >
            <Zap className="w-4 h-4 text-[#708238]" />
            {loading ? (dir === 'rtl' ? 'جارٍ التحديث...' : 'Refreshing...') : dir === 'rtl' ? 'تحديث' : 'Refresh'}
          </button>
        </div>
      </div>

      {error && (
        <div className="bg-red-500/10 border border-red-500/30 text-red-400 rounded-xl p-3 text-[13px] font-medium">
          {error}
        </div>
      )}

      {/* Stat cards — all values come from GET /api/admin/overview.
          iPad portrait (768-1024) gets 3 columns and landscape 4: the old
          2-column xl-gated grid stacked 11 cards into six huge rows there. */}
      <div className="grid grid-cols-2 md:grid-cols-3 xl:grid-cols-4 gap-2.5">
        {statCard(
          dir === 'rtl' ? 'إجمالي الإيرادات' : 'Total Revenue',
          formatIqd(stats.revenue_iqd),
          <TrendingUp className="w-5 h-5 text-[#c5a059]" />,
          'bg-[#c5a059]/10'
        )}
        {statCard(
          dir === 'rtl' ? 'إجمالي الطلبات' : 'Total Orders',
          stats.orders_total.toLocaleString(),
          <ShoppingCart className="w-5 h-5 text-[#708238]" />,
          'bg-[#708238]/10',
          onNavigateTab ? () => onNavigateTab('orders') : undefined
        )}
        {statCard(
          dir === 'rtl' ? 'طلبات قيد الانتظار' : 'Pending Orders',
          stats.orders_pending.toLocaleString(),
          <Clock className="w-5 h-5 text-yellow-400" />,
          'bg-yellow-500/10',
          onNavigateTab ? () => onNavigateTab('orders') : undefined
        )}
        {statCard(
          dir === 'rtl' ? 'طلبات مكتملة' : 'Delivered Orders',
          stats.orders_delivered.toLocaleString(),
          <CheckCircle2 className="w-5 h-5 text-[#2CE59B]" />,
          'bg-[#2CE59B]/10'
        )}
        {statCard(
          dir === 'rtl' ? 'المستخدمون' : 'Total Users',
          stats.users_total.toLocaleString(),
          <Users className="w-5 h-5 text-blue-400" />,
          'bg-blue-500/10',
          onNavigateTab ? () => onNavigateTab('users') : undefined
        )}
        {statCard(
          dir === 'rtl' ? 'مشتركو Pro / Plus' : 'Pro / Plus Subscribers',
          `${stats.pro_subscribers.toLocaleString()} / ${stats.plus_subscribers.toLocaleString()}`,
          <Crown className="w-5 h-5 text-[#e6c27a]" />,
          'bg-[#e6c27a]/10'
        )}
        {statCard(
          dir === 'rtl' ? 'تعبئة المحفظة (الموافق عليها)' : 'Wallet Top-ups (approved)',
          formatWalletIqd(stats.incoming_usd_cents, exchangeRate),
          <ArrowUpRight className="w-5 h-5 text-[#2CE59B]" />,
          'bg-[#2CE59B]/10'
        )}
        {statCard(
          dir === 'rtl' ? 'السحوبات (الموافق عليها)' : 'Wallet Payouts (approved)',
          formatWalletIqd(stats.outgoing_usd_cents, exchangeRate),
          <ArrowDownRight className="w-5 h-5 text-[#FF6B9E]" />,
          'bg-[#FF6B9E]/10'
        )}
        {statCard(
          dir === 'rtl' ? 'طلبات المحفظة المعلقة' : 'Pending Wallet Requests',
          stats.pending_wallet_requests.toLocaleString(),
          <Wallet className="w-5 h-5 text-[#c5a059]" />,
          'bg-[#c5a059]/10',
          onNavigateTab ? () => onNavigateTab('wallet_requests') : undefined
        )}
        {statCard(
          dir === 'rtl' ? 'طلبات المجتمع المفتوحة' : 'Open Community Requests',
          stats.open_community_requests.toLocaleString(),
          <MessageSquare className="w-5 h-5 text-purple-400" />,
          'bg-purple-500/10'
        )}
        {statCard(
          dir === 'rtl' ? 'المستثمرون' : 'Investors',
          stats.investors.toLocaleString(),
          <Users className="w-5 h-5 text-[#708238]" />,
          'bg-[#708238]/10'
        )}
      </div>

      <div className="grid grid-cols-1 xl:grid-cols-2 gap-3">

        {/* Pending wallet requests — real list with working actions */}
        <div className="bg-[#18181b]/80 backdrop-blur-xl border border-white/5 rounded-xl p-4 shadow-[0_4px_16px_rgba(0,0,0,0.25)]">
          <div className="flex items-center justify-between mb-3">
            <h3 className="text-[12px] font-black uppercase tracking-wider text-zinc-300">
              {dir === 'rtl' ? 'طلبات المحفظة المعلقة' : 'Pending Wallet Requests'}
            </h3>
            {onNavigateTab && (
              <button
                onClick={() => onNavigateTab('wallet_requests')}
                className="text-[11px] font-bold text-[#c5a059] hover:text-[#e6c27a] transition-colors"
              >
                {dir === 'rtl' ? 'عرض الكل' : 'View all'}
              </button>
            )}
          </div>

          {loading && pendingWalletRequests.length === 0 ? (
            <div className="text-center text-zinc-500 py-10 text-sm">{dir === 'rtl' ? 'جارٍ التحميل...' : 'Loading...'}</div>
          ) : pendingWalletRequests.length === 0 ? (
            <div className="text-center text-zinc-500 py-10 text-sm border border-dashed border-zinc-800 rounded-2xl">
              {dir === 'rtl' ? 'لا توجد طلبات معلقة' : 'No pending requests'}
            </div>
          ) : (
            <div className="space-y-3">
              {pendingWalletRequests.map((req) => (
                <div key={req.id} className="p-2.5 bg-zinc-900/60 border border-zinc-800 rounded-lg">
                  <div className="flex items-center justify-between gap-3">
                    <div className="min-w-0">
                      <div className="font-bold text-white text-sm truncate flex items-center gap-2">
                        <span className="capitalize">{req.type}</span>
                        <span className="text-[#c5a059]">{formatWalletIqd(req.amount, exchangeRate)}</span>
                        {/* THE LEDGER'S OWN VALUE, kept small and named. The stored unit
                        really is USD cents (migrations/0001_init.sql), so hiding it
                        entirely would make the dinars look like the stored number and
                        a reconciliation against the ledger impossible. This is the
                        shape the Telegram review card already uses. */}
                        <span className="text-[10px] font-normal text-zinc-600" dir="ltr">
                          {formatUsdCents(req.amount)}
                        </span>
                      </div>
                      <div className="text-[11px] text-zinc-500 truncate">
                        {req.email || req.username || '—'}
                        {req.paymentMethod ? ` • ${req.paymentMethod}` : ''}
                      </div>
                    </div>
                    <div className="flex items-center gap-2 shrink-0">
                      {req.type === 'withdrawal' && req.withdrawal && req.withdrawal.state !== 'requested' ? (
                        // Already in the workflow (approved / processing): the
                        // next step needs a payout reference — Wallet Requests.
                        <button
                          onClick={() => onNavigateTab?.('wallet_requests')}
                          className="text-[11px] font-bold text-[#c5a059] hover:text-[#e6c27a] transition-colors capitalize"
                          title={req.withdrawal.state}
                        >
                          {req.withdrawal.state} →
                        </button>
                      ) : (
                      <>
                      <button
                        onClick={() => decideWallet(req, 'approved')}
                        disabled={!!loadingActionId}
                        className="w-9 h-9 rounded-xl bg-gradient-to-br from-[#8a9a49] to-[#708238] text-white flex items-center justify-center shadow-[0_4px_12px_rgba(112,130,56,0.4)] hover:scale-105 active:scale-95 transition-transform disabled:opacity-50"
                        title={req.type === 'withdrawal' && req.withdrawal
                          ? (dir === 'rtl' ? 'موافقة للمعالجة (لا يُدفع هنا)' : 'Approve for processing (no payout here)')
                          : (dir === 'rtl' ? 'موافقة' : 'Approve')}
                      >
                        <Check className="w-4 h-4 stroke-[3]" />
                      </button>
                      <button
                        onClick={() => decideWallet(req, 'rejected')}
                        disabled={!!loadingActionId}
                        className="w-9 h-9 rounded-xl bg-zinc-800 border border-zinc-700 text-zinc-300 hover:text-red-400 flex items-center justify-center hover:scale-105 active:scale-95 transition-transform disabled:opacity-50"
                        title={dir === 'rtl' ? 'رفض' : 'Reject'}
                      >
                        <X className="w-4 h-4 stroke-[3]" />
                      </button>
                      </>
                      )}
                    </div>
                  </div>
                  {actionError?.id === req.id && (
                    <div className="text-[11px] text-red-400 mt-2">{actionError.message}</div>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>

        {/* Recent orders — real list */}
        <div className="bg-[#18181b]/80 backdrop-blur-xl border border-white/5 rounded-xl p-4 shadow-[0_4px_16px_rgba(0,0,0,0.25)]">
          <div className="flex items-center justify-between mb-3">
            <h3 className="text-[12px] font-black uppercase tracking-wider text-zinc-300">
              {dir === 'rtl' ? 'أحدث الطلبات' : 'Recent Orders'}
            </h3>
            {onNavigateTab && (
              <button
                onClick={() => onNavigateTab('orders')}
                className="text-[11px] font-bold text-[#c5a059] hover:text-[#e6c27a] transition-colors"
              >
                {dir === 'rtl' ? 'عرض الكل' : 'View all'}
              </button>
            )}
          </div>

          {loading && recentOrders.length === 0 ? (
            <div className="text-center text-zinc-500 py-10 text-sm">{dir === 'rtl' ? 'جارٍ التحميل...' : 'Loading...'}</div>
          ) : recentOrders.length === 0 ? (
            <div className="text-center text-zinc-500 py-10 text-sm border border-dashed border-zinc-800 rounded-2xl">
              {dir === 'rtl' ? 'لا توجد طلبات بعد' : 'No orders yet'}
            </div>
          ) : (
            <div className="space-y-2">
              {recentOrders.map((o) => (
                <div
                  key={o.id}
                  className="flex items-center justify-between gap-3 p-2.5 bg-zinc-900/60 border border-zinc-800 rounded-lg"
                >
                  <div className="min-w-0">
                    <div className="font-mono text-xs text-zinc-300 truncate">{o.id}</div>
                    <div className="text-[11px] text-zinc-500">{new Date(o.created_at).toLocaleString()}</div>
                  </div>
                  <div className="flex items-center gap-3 shrink-0">
                    <span className="text-sm font-bold text-white whitespace-nowrap">{formatIqd(o.total_iqd)}</span>
                    <span
                      className={`px-2 py-0.5 rounded-full text-[10px] font-bold uppercase tracking-wider ${ORDER_STATUS_COLORS[o.status] || 'bg-zinc-800 text-zinc-400'}`}
                    >
                      {o.status}
                    </span>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
