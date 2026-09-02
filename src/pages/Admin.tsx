import React, { useState, useEffect, useCallback } from 'react';
import { useLanguage } from '../LanguageContext';

import { Settings, Package, Boxes, LayoutList, Users, Wallet, Bell, LayoutDashboard, ClipboardList, Megaphone, RefreshCw, Barcode, Star, ShieldCheck, Crown, Ticket, Tag, Truck, Store } from 'lucide-react';
import OrderDetailModal from '../components/adminOrders/OrderDetailModal';
import AdminCoupons from '../components/adminCoupons/AdminCoupons';
import AdminDelivery from '../components/adminDelivery/AdminDelivery';
import AdminCommunity from '../components/adminCommunity/AdminCommunity';
import { api, ApiError, ApiOrder, formatIqd } from '../lib/api';
import AdminProducts from '../components/AdminProducts';
import AdminBundles from '../components/AdminBundles';
import AdminTaxonomy from '../components/adminTaxonomy/AdminTaxonomy';
import AdminWarranties from '../components/adminWarranty/AdminWarranties';
import AdminAds from '../components/AdminAds';
import AdminHomeSettings from '../components/AdminHomeSettings';
import AdminOverview from '../components/AdminOverview';
import AdminUsers from '../components/AdminUsers';
import AdminWalletRequests from '../components/AdminWalletRequests';
import AdminWalletSettings from '../components/AdminWalletSettings';
import AdminStoreSettings from '../components/AdminStoreSettings';
import AdminSerials from '../components/AdminSerials';
import AdminReviews from '../components/AdminReviews';
import AdminKyc from '../components/AdminKyc';
import AdminMemberships from '../components/AdminMemberships';
import DashboardLayout from '../components/DashboardLayout';

type AdminTab =
  | 'overview'
  | 'orders'
  | 'products'
  | 'bundles'
  | 'taxonomy'
  | 'warranties'
  | 'home_settings'
  | 'users'
  | 'wallet_requests'
  | 'wallet_settings'
  | 'store_settings'
  | 'ads'
  | 'serials'
  | 'reviews'
  | 'kyc'
  | 'memberships'
  | 'coupons'
  | 'delivery'
  | 'community';

/**
 * Mirrors ORDER_TRANSITIONS in worker/routes/admin.ts, which is the authority
 * — this list only decides what the dropdown OFFERS; the server decides what
 * it accepts. It used to be a one-way ratchet that gave `shipped` a single
 * option and `delivered` none, so a mis-tap could not be corrected at all.
 */
const ORDER_TRANSITIONS: Record<ApiOrder['status'], ApiOrder['status'][]> = {
  pending: ['confirmed', 'processing', 'shipped', 'delivered', 'cancelled'],
  confirmed: ['pending', 'processing', 'shipped', 'delivered', 'cancelled'],
  processing: ['pending', 'confirmed', 'shipped', 'delivered', 'cancelled'],
  shipped: ['pending', 'confirmed', 'processing', 'delivered', 'cancelled'],
  delivered: ['shipped'],
  cancelled: ['pending', 'confirmed', 'processing'],
};

const STATUS_AR: Record<ApiOrder['status'], string> = {
  pending: 'قيد الانتظار',
  confirmed: 'مؤكد',
  processing: 'قيد التجهيز',
  shipped: 'تم الشحن',
  delivered: 'تم التسليم',
  cancelled: 'ملغى',
};

const STATUS_COLORS: Record<ApiOrder['status'], string> = {
  pending: 'bg-yellow-500/20 text-yellow-300',
  confirmed: 'bg-blue-500/20 text-blue-300',
  processing: 'bg-purple-500/20 text-purple-300',
  shipped: 'bg-cyan-500/20 text-cyan-300',
  delivered: 'bg-[#2CE59B]/20 text-[#2CE59B]',
  cancelled: 'bg-red-500/20 text-red-400',
};

const PAGE_SIZE = 30;

function AdminOrders() {
  const { dir, loc } = useLanguage();
  const [orders, setOrders] = useState<ApiOrder[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(0);
  const [openOrderId, setOpenOrderId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [statusFilter, setStatusFilter] = useState<'all' | ApiOrder['status']>('all');
  const [updatingId, setUpdatingId] = useState<string | null>(null);
  const [rowError, setRowError] = useState<{ id: string; message: string } | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  // The filter and the page go to the SERVER. Filtering a page client-side
  // hid every matching order that happened to fall on another page, and
  // fetching 200 orders to show 30 of them is what made this tab slow.
  const loadOrders = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const params = new URLSearchParams({ limit: String(PAGE_SIZE), offset: String(page * PAGE_SIZE) });
      if (statusFilter !== 'all') params.set('status', statusFilter);
      const data = await api.get<{ orders: ApiOrder[]; total?: number }>(`/api/admin/orders?${params}`);
      setOrders(data.orders);
      setTotal(data.total ?? data.orders.length);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'Failed to load orders');
    } finally {
      setLoading(false);
    }
  }, [statusFilter, page]);

  useEffect(() => {
    loadOrders();
  }, [loadOrders]);

  const handleStatusChange = async (order: ApiOrder, next: ApiOrder['status']) => {
    if (updatingId) return;
    if (next === 'cancelled') {
      const ok = window.confirm(
        dir === 'rtl'
          ? `هل أنت متأكد من إلغاء الطلب ${order.id}؟ سيتم إرجاع المبالغ المدفوعة تلقائياً.`
          : `Cancel order ${order.id}? Any wallet/points applied will be refunded automatically.`
      );
      if (!ok) return;
    }
    // Backing out of a delivered order does not un-grant what delivery
    // granted. The server says so in its response; asking first is fairer.
    if (order.status === 'delivered') {
      const ok = window.confirm(
        loc(
          `إرجاع الطلب ${order.id} من «تم التسليم»؟ النقاط الممنوحة وسجلات الأجهزة وتواريخ بدء الضمان لا تُلغى.`,
          `Move order ${order.id} back from delivered? Points already awarded, device records and warranty start dates are NOT reversed.`,
          `داواکاری ${order.id} لە «گەیەنراوە» بگەڕێنیتەوە؟ خاڵە بەخشراوەکان و تۆمارەکانی ئامێر هەڵناوەشێنرێنەوە.`
        )
      );
      if (!ok) return;
    }
    setUpdatingId(order.id);
    setRowError(null);
    setNotice(null);
    try {
      const res = await api.patch<{ stock_note?: string; reversal_note?: string }>(
        `/api/admin/orders/${order.id}`,
        { status: next }
      );
      if (res.stock_note || res.reversal_note) {
        setNotice([res.stock_note, res.reversal_note].filter(Boolean).join(' · '));
      }
      await loadOrders();
    } catch (e) {
      setRowError({ id: order.id, message: e instanceof ApiError ? e.message : 'Failed to update order' });
    } finally {
      setUpdatingId(null);
    }
  };

  const statusLabel = (st: ApiOrder['status']) => (dir === 'rtl' ? STATUS_AR[st] : st);

  /** The status control, shared by the card and the table row. */
  const StatusSelect = ({ o }: { o: ApiOrder }) => {
    const nextStates = ORDER_TRANSITIONS[o.status] ?? [];
    if (nextStates.length === 0) return <span className="text-xs text-zinc-600">—</span>;
    return (
      <select
        value=""
        disabled={updatingId === o.id}
        data-order-status-select={o.id}
        onChange={(e) => {
          const next = e.target.value as ApiOrder['status'];
          if (next) handleStatusChange(o, next);
        }}
        className="bg-zinc-800 border border-zinc-700 text-white text-xs rounded-lg px-2 min-h-10 focus:outline-none focus:ring-1 focus:ring-olive disabled:opacity-50 w-full sm:w-auto"
      >
        <option value="" disabled>
          {updatingId === o.id
            ? loc('جارٍ الحفظ...', 'Saving...', 'پاشەکەوت دەکرێت...')
            : loc('تغيير إلى...', 'Move to...', 'بیگۆڕە بۆ...')}
        </option>
        {nextStates.map((st) => (
          <option key={st} value={st} className="capitalize">
            {statusLabel(st)}
          </option>
        ))}
      </select>
    );
  };

  const PrepareButton = ({ o }: { o: ApiOrder }) => (
    <button
      type="button"
      data-action="prepare"
      data-order-id={o.id}
      onClick={() => setOpenOrderId(o.id)}
      // Solid, not a 15%-opacity tint. This is the one control the owner comes
      // to this screen for, and on a dark card the tinted version read as
      // disabled next to a full-width status dropdown.
      className="min-h-9 px-3.5 rounded-lg bg-olive text-white text-xs font-bold hover:bg-olive-light transition-colors whitespace-nowrap shadow-sm"
    >
      {loc('تجهيز', 'Prepare', 'ئامادەکردن')}
    </button>
  );

  const pages = Math.max(1, Math.ceil(total / PAGE_SIZE));

  return (
    <div className="space-y-6 min-w-0">
      <div className="flex flex-col gap-4 min-w-0">
        <div className="flex items-center justify-between gap-3">
          <h2 className="text-lg font-black text-white">{loc('الطلبات', 'Orders', 'داواکارییەکان')}</h2>
          <div className="flex items-center gap-2 shrink-0">
            {/* Stickers for the orders not yet dispatched. "New" is decided
                on the SERVER (stage received or confirmed) — printing a
                sticker for a parcel already on a motorbike is how the same
                order goes out twice, and a panel-side guess at "new" would
                drift from the list the moment the definition changed. */}
            <a
              href="/api/admin/labels?print=1"
              target="_blank"
              rel="noopener noreferrer"
              data-print-new-labels
              className="inline-flex items-center gap-1.5 min-h-9 px-3 bg-zinc-800 hover:bg-zinc-700 border border-zinc-700 rounded-xl text-zinc-200 hover:text-white text-[13px] font-bold transition-colors whitespace-nowrap"
              title={loc('طباعة ستيكرات الطلبات الجديدة', 'Print labels for new orders', 'چاپکردنی ستیکەری داواکارییە نوێیەکان')}
            >
              <Tag className="w-4 h-4" aria-hidden />
              <span className="hidden sm:inline">{loc('ستيكرات الجديدة', 'New labels', 'ستیکەرە نوێیەکان')}</span>
            </a>
            <button
              onClick={loadOrders}
              className="w-11 h-11 shrink-0 bg-zinc-800 hover:bg-zinc-700 border border-zinc-700 rounded-xl text-zinc-300 hover:text-white transition-colors flex items-center justify-center"
              title={loc('تحديث', 'Refresh', 'نوێکردنەوە')}
            >
              <RefreshCw className={`w-4 h-4 ${loading ? 'animate-spin' : ''}`} />
            </button>
          </div>
        </div>

        {/* The filter bar scrolls on its own. It used to sit in a flex row
            beside the refresh button with no min-w-0, so on a phone the row
            refused to shrink and the last filters were simply unreachable —
            the strip could not be scrolled to them. */}
        <div className="-mx-3 px-3 sm:mx-0 sm:px-0 min-w-0">
          <div
            data-order-filters
            className="flex bg-zinc-900 border border-zinc-800 p-1 rounded-xl overflow-x-auto hide-scrollbar gap-1"
          >
            {(['all', 'pending', 'confirmed', 'processing', 'shipped', 'delivered', 'cancelled'] as const).map((f) => (
              <button
                key={f}
                data-order-filter={f}
                onClick={() => {
                  setStatusFilter(f);
                  setPage(0);
                }}
                className={`px-2.5 min-h-9 rounded-lg text-xs font-bold capitalize transition-colors whitespace-nowrap shrink-0 ${
                  statusFilter === f ? 'bg-zinc-800 text-white' : 'text-zinc-500 hover:text-zinc-300'
                }`}
              >
                {f === 'all' ? loc('الكل', 'All', 'هەموو') : statusLabel(f)}
              </button>
            ))}
          </div>
        </div>
      </div>

      {error && (
        <div className="bg-red-500/10 border border-red-500/30 text-red-400 rounded-2xl p-4 text-sm font-medium">
          {error}
        </div>
      )}
      {notice && (
        <div className="bg-amber-500/10 border border-amber-500/30 text-amber-300 rounded-2xl p-4 text-sm font-medium">
          {notice}
        </div>
      )}

      {/* ------------------------------------------------- phone: CARDS.
          A seven-column table on a 390px screen is a horizontal scroll with
          the Open button off the right edge — the owner had to drag sideways
          on every row to reach the one control they came for. */}
      <div className="grid gap-3 sm:hidden">
        {orders.map((o) => (
          <div key={o.id} data-order-card={o.id} className="rounded-2xl border border-zinc-800 bg-zinc-900/60 p-3.5 min-w-0">
            <div className="flex items-start justify-between gap-3 min-w-0">
              <div className="min-w-0">
                <p className="font-mono text-[12px] text-zinc-400 truncate" dir="ltr">{o.id}</p>
                <p className="text-white font-bold text-[15px] mt-1 tabular-nums" dir="ltr">{formatIqd(o.total_iqd)}</p>
              </div>
              <span className={`shrink-0 px-2.5 py-1 rounded-full text-[11px] font-bold ${STATUS_COLORS[o.status]}`}>
                {statusLabel(o.status)}
              </span>
            </div>
            <p className="text-[12px] text-zinc-400 mt-2 truncate">{o.email || o.username || o.user_id || '—'}</p>
            <p className="text-[11px] text-zinc-500 mt-0.5">
              {new Date(o.created_at).toLocaleDateString()} · {o.items?.length ?? 0}{' '}
              {loc('صنف', 'items', 'شت')}
            </p>
            <div className="flex items-center gap-2 mt-3 min-w-0">
              <div className="shrink-0">
                <PrepareButton o={o} />
              </div>
              <div className="flex-1 min-w-0">
                <StatusSelect o={o} />
              </div>
            </div>
            {rowError?.id === o.id && <div className="text-[11px] text-red-400 mt-2">{rowError.message}</div>}
          </div>
        ))}
        {!loading && orders.length === 0 && (
          <p className="py-12 text-center text-zinc-500 font-medium">
            {loc('لا توجد طلبات', 'No orders found', 'هیچ داواکارییەک نییە')}
          </p>
        )}
        {loading && orders.length === 0 && (
          <p className="py-12 text-center text-zinc-500 font-medium">
            {loc('جارٍ التحميل...', 'Loading...', 'بار دەبێت...')}
          </p>
        )}
      </div>

      {/* -------------------------------------------- tablet and up: TABLE */}
      <div className="hidden sm:block bg-zinc-900 border border-zinc-800 rounded-xl overflow-hidden min-w-0">
        <div className="overflow-x-auto">
          <table className="w-full text-left border-collapse min-w-[820px]">
            <thead>
              <tr className="bg-zinc-800/50 border-b border-zinc-700">
                {[
                  loc('الطلب', 'Order', 'داواکاری'),
                  loc('العميل', 'Customer', 'کڕیار'),
                  loc('الأصناف', 'Items', 'شتەکان'),
                  loc('الإجمالي', 'Total', 'کۆ'),
                  loc('التاريخ', 'Date', 'بەروار'),
                  loc('الحالة', 'Status', 'دۆخ'),
                  loc('تغيير', 'Change', 'گۆڕین'),
                  loc('تجهيز', 'Prepare', 'ئامادەکردن'),
                ].map((h) => (
                  <th key={h} className="py-2.5 px-3 text-[11px] font-bold text-zinc-400 uppercase tracking-wider whitespace-nowrap">
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {orders.map((o) => (
                <tr key={o.id} className="border-b border-zinc-800 hover:bg-zinc-800/30 transition-colors">
                  <td className="py-2.5 px-3 font-mono text-[11px] text-zinc-300" dir="ltr">{o.id}</td>
                  <td className="py-2.5 px-3 text-[13px] text-zinc-300">{o.email || o.username || o.user_id || '—'}</td>
                  <td className="py-2.5 px-3 text-[13px] text-zinc-400">{o.items?.length ?? 0}</td>
                  <td className="py-2.5 px-3 text-[13px] font-bold text-white whitespace-nowrap" dir="ltr">
                    {formatIqd(o.total_iqd)}
                  </td>
                  <td className="py-2.5 px-3 text-[11px] text-zinc-500 whitespace-nowrap">
                    {new Date(o.created_at).toLocaleDateString()}
                  </td>
                  <td className="py-2.5 px-3">
                    <span className={`px-2.5 py-1 rounded-full text-xs font-bold whitespace-nowrap ${STATUS_COLORS[o.status]}`}>
                      {statusLabel(o.status)}
                    </span>
                  </td>
                  <td className="py-2.5 px-3">
                    <StatusSelect o={o} />
                    {rowError?.id === o.id && (
                      <div className="text-[11px] text-red-400 mt-1 max-w-[220px]">{rowError.message}</div>
                    )}
                  </td>
                  <td className="py-2.5 px-3">
                    <PrepareButton o={o} />
                  </td>
                </tr>
              ))}
              {!loading && orders.length === 0 && (
                <tr>
                  <td colSpan={8} className="py-12 text-center text-zinc-500 font-medium">
                    {loc('لا توجد طلبات', 'No orders found', 'هیچ داواکارییەک نییە')}
                  </td>
                </tr>
              )}
              {loading && orders.length === 0 && (
                <tr>
                  <td colSpan={8} className="py-12 text-center text-zinc-500 font-medium">
                    {loc('جارٍ التحميل...', 'Loading...', 'بار دەبێت...')}
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>

      {/* Paging, because the server now returns a page rather than 200 rows. */}
      {pages > 1 && (
        <div className="flex items-center justify-between gap-3">
          <button
            type="button"
            data-orders-prev
            disabled={page === 0 || loading}
            onClick={() => setPage((p) => Math.max(0, p - 1))}
            className="min-h-9 px-3 rounded-lg bg-zinc-900 border border-zinc-800 text-[13px] font-bold text-zinc-300 disabled:opacity-40 hover:text-white transition-colors"
          >
            {loc('السابق', 'Previous', 'پێشوو')}
          </button>
          <span className="text-xs text-zinc-500 tabular-nums">
            {page + 1} / {pages} · {total} {loc('طلب', 'orders', 'داواکاری')}
          </span>
          <button
            type="button"
            data-orders-next
            disabled={page + 1 >= pages || loading}
            onClick={() => setPage((p) => p + 1)}
            className="min-h-9 px-3 rounded-lg bg-zinc-900 border border-zinc-800 text-[13px] font-bold text-zinc-300 disabled:opacity-40 hover:text-white transition-colors"
          >
            {loc('التالي', 'Next', 'دواتر')}
          </button>
        </div>
      )}

      {openOrderId && (
        <OrderDetailModal
          orderId={openOrderId}
          onClose={() => {
            setOpenOrderId(null);
            // A status may have changed inside the modal, and a stale row is
            // worse than a second of loading.
            loadOrders();
          }}
        />
      )}
    </div>
  );
}

export default function Admin() {
  const { t, dir } = useLanguage();
  const [activeTab, setActiveTab] = useState<AdminTab>('overview');

  const sidebarItems = [
    { id: 'overview', icon: LayoutDashboard, label: dir === 'rtl' ? 'نظرة عامة' : 'Overview' },
    { id: 'orders', icon: ClipboardList, label: dir === 'rtl' ? 'الطلبات' : 'Orders' },
    { id: 'wallet_requests', icon: Bell, label: 'Wallet Requests' },
    { id: 'products', icon: Package, label: t('adminProducts') },
    { id: 'bundles', icon: Boxes, label: dir === 'rtl' ? 'الباقات' : 'Bundles' },
    { id: 'taxonomy', icon: Tag, label: dir === 'rtl' ? 'التصنيفات' : 'Taxonomy' },
    { id: 'warranties', icon: ShieldCheck, label: dir === 'rtl' ? 'الضمانات' : 'Warranties' },
    { id: 'home_settings', icon: LayoutList, label: dir === 'rtl' ? 'اعدادات الرئيسية' : 'Home Settings' },
    { id: 'users', icon: Users, label: t('adminUsers') },
    { id: 'wallet_settings', icon: Wallet, label: 'Wallet Settings' },
    { id: 'store_settings', icon: Settings, label: 'Store Settings' },
    { id: 'ads', icon: Megaphone, label: 'Ads & Texts' },
    { id: 'serials', icon: Barcode, label: dir === 'rtl' ? 'الأجهزة والتسلسلات' : 'Serials & Devices' },
    { id: 'reviews', icon: Star, label: dir === 'rtl' ? 'المراجعات والهدايا' : 'Reviews & Gifts' },
    { id: 'kyc', icon: ShieldCheck, label: dir === 'rtl' ? 'التحقق والعناوين' : 'KYC & Addresses' },
    { id: 'memberships', icon: Crown, label: dir === 'rtl' ? 'الأعضاء والدعم' : 'Members & Support' },
    { id: 'coupons', icon: Ticket, label: dir === 'rtl' ? 'أكواد الخصم' : 'Promo codes' },
    { id: 'delivery', icon: Truck, label: dir === 'rtl' ? 'التوصيل المحلي' : 'Local delivery' },
    { id: 'community', icon: Store, label: dir === 'rtl' ? 'مجتمع ليفو' : 'Levo Community' },
  ];

  return (
    <DashboardLayout
      title="ADMIN"
      topbarSlot
      sidebarItems={sidebarItems}
      activeTab={activeTab}
      onTabChange={(id) => setActiveTab(id as AdminTab)}
    >
      <div className={`max-w-[1280px] mx-auto text-white ${activeTab === 'products' || activeTab === 'overview' || activeTab === 'taxonomy' || activeTab === 'warranties' ? '' : 'bg-zinc-900/50 backdrop-blur-xl border border-zinc-800/50 rounded-2xl p-4 md:p-5 shadow-lg'}`}>

        {activeTab === 'overview' && (
          <AdminOverview onNavigateTab={(tab) => setActiveTab(tab as AdminTab)} />
        )}

        {activeTab === 'orders' && (
          <AdminOrders />
        )}

        {activeTab === 'products' && (
          <AdminProducts />
        )}

        {activeTab === 'bundles' && <AdminBundles />}
        {activeTab === 'taxonomy' && <AdminTaxonomy />}
        {activeTab === 'warranties' && <AdminWarranties />}
        {activeTab === 'ads' && (
          <AdminAds />
        )}

        {activeTab === 'home_settings' && (
          <AdminHomeSettings />
        )}

        {activeTab === 'users' && (
          <AdminUsers />
        )}

        {activeTab === 'wallet_requests' && (
           <AdminWalletRequests />
        )}

        {activeTab === 'wallet_settings' && (
           <AdminWalletSettings />
        )}

        {activeTab === 'store_settings' && (
           <AdminStoreSettings />
        )}

        {activeTab === 'serials' && (
           <AdminSerials />
        )}

        {activeTab === 'reviews' && (
           <AdminReviews />
        )}

        {activeTab === 'kyc' && (
           <AdminKyc />
        )}

        {activeTab === 'memberships' && (
           <AdminMemberships />
        )}

        {activeTab === 'coupons' && <AdminCoupons dir={dir} />}

        {activeTab === 'delivery' && <AdminDelivery dir={dir} />}

        {activeTab === 'community' && <AdminCommunity dir={dir} />}
      </div>
    </DashboardLayout>
  );
}
