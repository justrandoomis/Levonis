import React, { useCallback, useEffect, useState } from 'react';
import { useLanguage } from '../LanguageContext';
import { api, ApiError, WalletTx, formatIqd, formatUsdCents, formatWalletIqd } from '../lib/api';
import { useWallet } from '../WalletContext';
import { useAuth } from '../AuthContext';
import { KpiTile } from './ui/KpiTile';
import { StatusChip, type Tone } from './ui/Badge';
import { statusLabel } from './orders/format';
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
  LifeBuoy,
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
  /** Tickets whose ball is on THIS side of the desk: `open` + `waiting_staff`
   *  (worker/routes/admin.ts). `waiting_customer` is not a queue. */
  support_tickets_waiting: number;
  /** Order threads with a customer line no staff member has seen, and
   *  complaints still `submitted`/`under_review` (worker/routes/adminChats.ts).
   *  Absent from an older Worker, hence optional. */
  support_chats_unread?: number;
  support_complaints_open?: number;
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
  support_tickets_waiting: 0,
};

/**
 * The owner's exchange rates at a glance (FX programme plan §12). Its own
 * chunk, mounted for `can_write_cost === true` only — the same fail-closed
 * hint as «التسعير والشحن»; the server refuses everyone else regardless.
 */
const OwnerRatesCard = React.lazy(() => import('./admin/OwnerRatesCard'));

/** A status is information: a flat chip in its semantic tone (build plan §5). */
const ORDER_STATUS_TONES: Record<string, Tone> = {
  pending: 'warning',
  confirmed: 'info',
  processing: 'info',
  shipped: 'info',
  delivered: 'success',
  cancelled: 'danger',
};

export default function AdminOverview({ onNavigateTab }: { onNavigateTab?: (tab: string) => void }) {
  // `loc(ar, en, ckb)`, never `dir === 'rtl' ? ar : en`: Kurdish is right-to-left too,
  // and the direction test served it Arabic.
  const { dir, lang, loc } = useLanguage();
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
  const { user } = useAuth();
  const canSeeRates = user?.can_write_cost === true;

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
      // '' = failed without a server sentence; the words are chosen at render, in the reader's language.
      setError(e instanceof ApiError ? e.message : '');
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
          ? loc('سبب الرفض (مطلوب):', 'Rejection reason (required):', 'هۆکاری ڕەتکردنەوە (پێویستە):')
          : loc('سبب الرفض (اختياري):', 'Rejection reason (optional):', 'هۆکاری ڕەتکردنەوە (ئارەزوومەندانە):')
      );
      if (note === null) return; // cancelled
      if (required && note.trim().length < 3) {
        setActionError({ id: req.id, message: loc('اكتب سبب الرفض (3 أحرف على الأقل)', 'Write the rejection reason (at least 3 characters)', 'هۆکاری ڕەتکردنەوە بنووسە (لانیکەم 3 پیت)') });
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
      setActionError({ id: req.id, message: e instanceof ApiError ? e.message : loc('تعذّر تنفيذ الإجراء', 'Action failed', 'کردارەکە سەرنەکەوت') });
    } finally {
      setLoadingActionId(null);
    }
  };

  // KPI TILES (build plan §5): a neutral surface on the canvas, a quiet
  // label, the figure as the one loud thing — no per-tile tint.
  // RAISED MEANS PRESSABLE (clay): only a tile that opens a queue is resting
  // clay, and it is a real <button> — reachable by keyboard, announced as a
  // control, dented while pressed. A tile that only informs sits flush (the
  // rim alone), so the four doors are the raised things on the screen.
  const statCard = (
    label: string,
    value: React.ReactNode,
    icon: React.ReactNode,
    onClick?: () => void
  ) => {
    const tile = (
      <KpiTile
        // The tile truncates its label; an Arabic label here is a sentence
        // («تعبئة المحفظة (الموافق عليها)»), so it wraps instead of losing words.
        label={<span className="whitespace-normal">{label}</span>}
        value={value}
        icon={icon}
        loading={loading}
        className={onClick ? 'h-full transition-colors hover:bg-surface-raised active:shadow-press' : 'h-full shadow-xs'}
      />
    );
    return onClick ? (
      <button
        type="button"
        onClick={onClick}
        className="min-w-0 text-start rounded-xl no-press focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus"
      >
        {tile}
      </button>
    ) : (
      <div className="min-w-0">{tile}</div>
    );
  };

  return (
    <div className="space-y-4 text-text-primary pb-10 font-sans" dir={dir}>

      {/* Top Bar */}
      <div className="flex flex-col lg:flex-row items-center justify-between gap-3">
        <div className="flex items-center gap-3 w-full lg:w-auto">
          <div className="w-9 h-9 rounded-lg bg-surface-raised border border-border-subtle flex items-center justify-center shrink-0 font-black text-sm text-text-primary">
            L
          </div>
          <div>
            <h1 className="text-base font-black text-text-primary flex items-center gap-2">
              {loc('لوحة القيادة والإحصائيات', 'Executive Overview Dashboard', 'داشبۆرد و ئامارەکان')}
            </h1>
            <p className="text-[11px] text-text-secondary font-medium">
              {loc('إحصائيات حقيقية من قاعدة البيانات', 'Live figures straight from the database', 'ئاماری ڕاستەقینە ڕاستەوخۆ لە بنکەدراوەوە')}
            </p>
          </div>
        </div>

        <div className="flex items-center gap-3 w-full lg:w-auto justify-end">
          <button
            onClick={fetchOverviewData}
            disabled={loading}
            className="lv-button lv-button-secondary lv-button-sm"
            title={loc('تحديث البيانات', 'Refresh data', 'نوێکردنەوەی داتاکان')}
          >
            <Zap className="w-4 h-4" />
            {loading ? loc('جارٍ التحديث...', 'Refreshing...', 'نوێ دەکرێتەوە...') : loc('تحديث', 'Refresh', 'نوێکردنەوە')}
          </button>
        </div>
      </div>

      {error !== null && (
        <div className="lv-alert lv-alert-danger text-[13px] font-medium text-text-primary">
          {error || loc('تعذّر تحميل النظرة العامة', 'Failed to load the overview', 'نەتوانرا پوختەکە بار بکرێت')}
        </div>
      )}

      {/* Stat cards — all values come from GET /api/admin/overview.
          iPad portrait (768-1024) gets 3 columns and landscape 4: the old
          2-column xl-gated grid stacked 11 cards into six huge rows there. */}
      <div className="grid grid-cols-2 md:grid-cols-3 xl:grid-cols-4 gap-3">
        {statCard(
          loc('إجمالي الإيرادات', 'Total revenue', 'کۆی داهات'),
          formatIqd(stats.revenue_iqd),
          <TrendingUp className="w-4 h-4" />
        )}
        {statCard(
          loc('إجمالي الطلبات', 'Total orders', 'کۆی داواکارییەکان'),
          stats.orders_total.toLocaleString(),
          <ShoppingCart className="w-4 h-4" />,
          onNavigateTab ? () => onNavigateTab('orders') : undefined
        )}
        {statCard(
          loc('طلبات قيد الانتظار', 'Pending orders', 'داواکارییە چاوەڕوانەکان'),
          stats.orders_pending.toLocaleString(),
          <Clock className="w-4 h-4" />,
          onNavigateTab ? () => onNavigateTab('orders') : undefined
        )}
        {statCard(
          loc('طلبات مكتملة', 'Delivered orders', 'داواکارییە گەیەندراوەکان'),
          stats.orders_delivered.toLocaleString(),
          <CheckCircle2 className="w-4 h-4" />
        )}
        {statCard(
          loc('المستخدمون', 'Users', 'بەکارهێنەران'),
          stats.users_total.toLocaleString(),
          <Users className="w-4 h-4" />,
          onNavigateTab ? () => onNavigateTab('users') : undefined
        )}
        {statCard(
          loc('مشتركو Pro / Plus', 'Pro / Plus subscribers', 'بەشداربووانی Pro / Plus'),
          `${stats.pro_subscribers.toLocaleString()} / ${stats.plus_subscribers.toLocaleString()}`,
          <Crown className="w-4 h-4" />
        )}
        {statCard(
          loc('تعبئة المحفظة (الموافق عليها)', 'Wallet top-ups (approved)', 'پڕکردنەوەی جزدان (پەسەندکراو)'),
          formatWalletIqd(stats.incoming_usd_cents, exchangeRate),
          <ArrowUpRight className="w-4 h-4" />
        )}
        {statCard(
          loc('السحوبات (الموافق عليها)', 'Wallet payouts (approved)', 'کێشانەوەکان (پەسەندکراو)'),
          formatWalletIqd(stats.outgoing_usd_cents, exchangeRate),
          <ArrowDownRight className="w-4 h-4" />
        )}
        {statCard(
          loc('طلبات المحفظة المعلقة', 'Pending wallet requests', 'داواکارییە هەڵپەسێردراوەکانی جزدان'),
          stats.pending_wallet_requests.toLocaleString(),
          <Wallet className="w-4 h-4" />,
          onNavigateTab ? () => onNavigateTab('wallet_requests') : undefined
        )}
        {/* THE SUPPORT QUEUE, on the first screen. «الدعم والتذاكر» shipped as a
            tab with no count anywhere on the dashboard, so a waiting customer
            was invisible until somebody thought to open the tab. It is also a
            DOOR: the card navigates straight into the queue it counts. */}
        {/* Tickets, order-chat messages and complaints — the console has
            three queues now, and a tile counting one of them would call a
            waiting customer "nothing waiting". The number is the SUM of the
            same three counts the sidebar badge shows. */}
        {statCard(
          loc('بانتظار رد الدعم', 'Awaiting a support reply', 'چاوەڕێی وەڵامی پشتگیری'),
          (
            (stats.support_tickets_waiting || 0) +
            (stats.support_chats_unread || 0) +
            (stats.support_complaints_open || 0)
          ).toLocaleString(),
          <LifeBuoy className="w-4 h-4" />,
          onNavigateTab ? () => onNavigateTab('support') : undefined
        )}
        {statCard(
          loc('طلبات المجتمع المفتوحة', 'Open community requests', 'داواکارییە کراوەکانی کۆمەڵگە'),
          stats.open_community_requests.toLocaleString(),
          <MessageSquare className="w-4 h-4" />
        )}
        {statCard(
          loc('المستثمرون', 'Investors', 'وەبەرهێنەران'),
          stats.investors.toLocaleString(),
          <Users className="w-4 h-4" />
        )}
      </div>

      {/* The owner's exchange rates (FX-1): owner only, its own chunk. */}
      {canSeeRates && (
        <React.Suspense fallback={null}>
          <OwnerRatesCard onOpen={onNavigateTab ? () => onNavigateTab('pricing') : undefined} />
        </React.Suspense>
      )}

      <div className="grid grid-cols-1 xl:grid-cols-2 gap-3">

        {/* Pending wallet requests — real list with working actions */}
        <div className="lv-surface p-4">
          <div className="flex items-center justify-between mb-3">
            <h3 className="text-[13px] font-bold text-text-secondary">
              {loc('طلبات المحفظة المعلقة', 'Pending wallet requests', 'داواکارییە هەڵپەسێردراوەکانی جزدان')}
            </h3>
            {onNavigateTab && (
              <button
                onClick={() => onNavigateTab('wallet_requests')}
                className="text-[11px] font-bold text-gold hover:text-wheat transition-colors"
              >
                {loc('عرض الكل', 'View all', 'هەموو ببینە')}
              </button>
            )}
          </div>

          {loading && pendingWalletRequests.length === 0 ? (
            <div className="text-center text-text-muted py-10 text-sm">{loc('جارٍ التحميل...', 'Loading...', 'بارکردن...')}</div>
          ) : pendingWalletRequests.length === 0 ? (
            <div className="text-center text-text-muted py-10 text-sm border border-dashed border-border-subtle rounded-lg">
              {loc('لا توجد طلبات معلقة', 'No pending requests', 'هیچ داواکارییەکی هەڵپەسێردراو نییە')}
            </div>
          ) : (
            <div className="divide-y divide-border-subtle">
              {pendingWalletRequests.map((req) => (
                <div key={req.id} className="py-2.5">
                  <div className="flex items-center justify-between gap-3">
                    <div className="min-w-0">
                      <div className="font-bold text-text-primary text-sm truncate flex items-center gap-2">
                        {/* The wallet's own words (Wallet.tsx filters), not the API's type code. */}
                        <span>{req.type === 'deposit' ? loc('إيداع', 'Deposit', 'دانان') : req.type === 'withdrawal' ? loc('سحب', 'Withdrawal', 'کێشانەوە') : req.type}</span>
                        {/* EITHER KIND PRINTS WHAT THE CUSTOMER TYPED — a
                        withdrawal from its own row (migration 0106), a deposit
                        from `wallet_deposit_meta` (0105), both joined by this
                        route. The owner's rule is «في المحفظة», not «in
                        withdrawals», and the approve/reject buttons for this
                        request are on this same row: a reviewer must not read
                        50,008 د.ع here and 50,000 د.ع on the Wallet Requests
                        screen for one transaction.

                        THE TWO STAT CARDS ABOVE KEEP CONVERTING, on purpose.
                        They are aggregates, and a sum of many deposits has no
                        typed figure — none may be invented for it. */}
                        <span className="text-gold">
                          {req.withdrawal?.declared_amount_iqd
                            ? formatIqd(req.withdrawal.declared_amount_iqd)
                            : req.deposit?.declared_amount_iqd
                              ? formatIqd(req.deposit.declared_amount_iqd)
                              : formatWalletIqd(req.amount, exchangeRate)}
                        </span>
                        {/* THE LEDGER'S OWN VALUE, kept small and named. The stored unit
                        really is USD cents (migrations/0001_init.sql), so hiding it
                        entirely would make the dinars look like the stored number and
                        a reconciliation against the ledger impossible. This is the
                        shape the Telegram review card already uses. */}
                        <span className="text-[10px] font-normal text-text-muted" dir="ltr">
                          {formatUsdCents(req.amount)}
                        </span>
                      </div>
                      <div className="text-[11px] text-text-muted truncate">
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
                          className="text-[11px] font-bold text-gold hover:text-wheat transition-colors"
                          title={req.withdrawal.state}
                        >
                          {/* The customer wallet's own state words (Wallet.tsx `stateLabel`). */}
                          {req.withdrawal.state === 'approved'
                            ? loc('موافق على المعالجة', 'Approved for processing', 'پەسەندکراو بۆ پرۆسە')
                            : req.withdrawal.state === 'processing'
                              ? loc('قيد المعالجة', 'Processing', 'لە پرۆسەدا')
                              : req.withdrawal.state}{' '}
                          →
                        </button>
                      ) : (
                      <>
                      <button
                        onClick={() => decideWallet(req, 'approved')}
                        disabled={!!loadingActionId}
                        className="lv-button lv-button-primary w-11 px-0"
                        title={req.type === 'withdrawal' && req.withdrawal
                          ? loc('موافقة للمعالجة (لا يُدفع هنا)', 'Approve for processing (no payout here)', 'پەسەندکردن بۆ پرۆسە (لێرە پارە نادرێت)')
                          : loc('موافقة', 'Approve', 'پەسەندکردن')}
                      >
                        <Check className="w-4 h-4 stroke-[3]" />
                      </button>
                      <button
                        onClick={() => decideWallet(req, 'rejected')}
                        disabled={!!loadingActionId}
                        className="lv-button lv-button-secondary w-11 px-0 hover:text-danger"
                        title={loc('رفض', 'Reject', 'ڕەتکردنەوە')}
                      >
                        <X className="w-4 h-4 stroke-[3]" />
                      </button>
                      </>
                      )}
                    </div>
                  </div>
                  {actionError?.id === req.id && (
                    <div className="text-[11px] text-danger mt-2">{actionError.message}</div>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>

        {/* Recent orders — real list */}
        <div className="lv-surface p-4">
          <div className="flex items-center justify-between mb-3">
            <h3 className="text-[13px] font-bold text-text-secondary">
              {loc('أحدث الطلبات', 'Recent orders', 'دوایین داواکارییەکان')}
            </h3>
            {onNavigateTab && (
              <button
                onClick={() => onNavigateTab('orders')}
                className="text-[11px] font-bold text-gold hover:text-wheat transition-colors"
              >
                {loc('عرض الكل', 'View all', 'هەموو ببینە')}
              </button>
            )}
          </div>

          {loading && recentOrders.length === 0 ? (
            <div className="text-center text-text-muted py-10 text-sm">{loc('جارٍ التحميل...', 'Loading...', 'بارکردن...')}</div>
          ) : recentOrders.length === 0 ? (
            <div className="text-center text-text-muted py-10 text-sm border border-dashed border-border-subtle rounded-lg">
              {loc('لا توجد طلبات بعد', 'No orders yet', 'هێشتا هیچ داواکارییەک نییە')}
            </div>
          ) : (
            <div className="divide-y divide-border-subtle">
              {recentOrders.map((o) => (
                <div
                  key={o.id}
                  className="flex items-center justify-between gap-3 py-2.5"
                >
                  <div className="min-w-0">
                    <div className="font-mono text-xs text-text-secondary truncate">{o.id}</div>
                    <div className="text-[11px] text-text-muted">{new Date(o.created_at).toLocaleString()}</div>
                  </div>
                  <div className="flex items-center gap-3 shrink-0">
                    <span className="text-sm font-bold text-text-primary whitespace-nowrap tabular-nums">{formatIqd(o.total_iqd)}</span>
                    <StatusChip tone={ORDER_STATUS_TONES[o.status] ?? 'neutral'}>{statusLabel(lang, o.status)}</StatusChip>
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
