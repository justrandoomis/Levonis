import React, { useState, useEffect, useCallback } from 'react';
import { useLanguage } from '../LanguageContext';

import { Settings, Package, LayoutList, Users, Wallet, Bell, LayoutDashboard, ClipboardList, Megaphone, RefreshCw, Barcode, Star, ShieldCheck, Crown } from 'lucide-react';
import { api, ApiError, ApiOrder, formatIqd } from '../lib/api';
import AdminProducts from '../components/AdminProducts';
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
  | 'home_settings'
  | 'users'
  | 'wallet_requests'
  | 'wallet_settings'
  | 'store_settings'
  | 'ads'
  | 'serials'
  | 'reviews'
  | 'kyc'
  | 'memberships';

const ORDER_TRANSITIONS: Record<ApiOrder['status'], ApiOrder['status'][]> = {
  pending: ['confirmed', 'cancelled'],
  confirmed: ['processing', 'cancelled'],
  processing: ['shipped', 'cancelled'],
  shipped: ['delivered'],
  delivered: [],
  cancelled: [],
};

const STATUS_COLORS: Record<ApiOrder['status'], string> = {
  pending: 'bg-yellow-500/20 text-yellow-300',
  confirmed: 'bg-blue-500/20 text-blue-300',
  processing: 'bg-purple-500/20 text-purple-300',
  shipped: 'bg-cyan-500/20 text-cyan-300',
  delivered: 'bg-[#2CE59B]/20 text-[#2CE59B]',
  cancelled: 'bg-red-500/20 text-red-400',
};

function AdminOrders() {
  const { dir } = useLanguage();
  const [orders, setOrders] = useState<ApiOrder[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [statusFilter, setStatusFilter] = useState<'all' | ApiOrder['status']>('all');
  const [updatingId, setUpdatingId] = useState<string | null>(null);
  const [rowError, setRowError] = useState<{ id: string; message: string } | null>(null);

  const loadOrders = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const data = await api.get<{ orders: ApiOrder[] }>('/api/admin/orders');
      setOrders(data.orders);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'Failed to load orders');
    } finally {
      setLoading(false);
    }
  }, []);

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
    setUpdatingId(order.id);
    setRowError(null);
    try {
      await api.patch(`/api/admin/orders/${order.id}`, { status: next });
      await loadOrders();
    } catch (e) {
      setRowError({ id: order.id, message: e instanceof ApiError ? e.message : 'Failed to update order' });
    } finally {
      setUpdatingId(null);
    }
  };

  const filtered = statusFilter === 'all' ? orders : orders.filter((o) => o.status === statusFilter);

  return (
    <div className="space-y-6">
      <div className="flex flex-col md:flex-row justify-between items-start md:items-center gap-4">
        <h2 className="text-2xl font-black text-white">{dir === 'rtl' ? 'الطلبات' : 'Orders'}</h2>
        <div className="flex items-center gap-3">
          <div className="flex bg-zinc-900 border border-zinc-800 p-1 rounded-xl overflow-x-auto">
            {(['all', 'pending', 'confirmed', 'processing', 'shipped', 'delivered', 'cancelled'] as const).map((f) => (
              <button
                key={f}
                onClick={() => setStatusFilter(f)}
                className={`px-3 py-1.5 rounded-lg text-xs font-bold capitalize transition-colors whitespace-nowrap ${
                  statusFilter === f ? 'bg-zinc-800 text-white' : 'text-zinc-500 hover:text-zinc-300'
                }`}
              >
                {f}
              </button>
            ))}
          </div>
          <button
            onClick={loadOrders}
            className="p-2 bg-zinc-800 hover:bg-zinc-700 border border-zinc-700 rounded-xl text-zinc-300 hover:text-white transition-colors"
            title={dir === 'rtl' ? 'تحديث' : 'Refresh'}
          >
            <RefreshCw className={`w-4 h-4 ${loading ? 'animate-spin' : ''}`} />
          </button>
        </div>
      </div>

      {error && (
        <div className="bg-red-500/10 border border-red-500/30 text-red-400 rounded-2xl p-4 text-sm font-medium">
          {error}
        </div>
      )}

      <div className="bg-zinc-900 border border-zinc-800 rounded-3xl overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-left border-collapse min-w-[900px]">
            <thead>
              <tr className="bg-zinc-800/50 border-b border-zinc-700">
                <th className="py-4 px-5 text-xs font-bold text-zinc-400 uppercase tracking-wider">Order</th>
                <th className="py-4 px-5 text-xs font-bold text-zinc-400 uppercase tracking-wider">Customer</th>
                <th className="py-4 px-5 text-xs font-bold text-zinc-400 uppercase tracking-wider">Items</th>
                <th className="py-4 px-5 text-xs font-bold text-zinc-400 uppercase tracking-wider">Total</th>
                <th className="py-4 px-5 text-xs font-bold text-zinc-400 uppercase tracking-wider">Date</th>
                <th className="py-4 px-5 text-xs font-bold text-zinc-400 uppercase tracking-wider">Status</th>
                <th className="py-4 px-5 text-xs font-bold text-zinc-400 uppercase tracking-wider">Change</th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((o) => {
                const nextStates = ORDER_TRANSITIONS[o.status] ?? [];
                return (
                  <tr key={o.id} className="border-b border-zinc-800 hover:bg-zinc-800/30 transition-colors">
                    <td className="py-4 px-5 font-mono text-xs text-zinc-300">{o.id}</td>
                    <td className="py-4 px-5 text-sm text-zinc-300">{o.email || o.username || o.user_id || '—'}</td>
                    <td className="py-4 px-5 text-sm text-zinc-400">{o.items?.length ?? 0}</td>
                    <td className="py-4 px-5 text-sm font-bold text-white whitespace-nowrap">{formatIqd(o.total_iqd)}</td>
                    <td className="py-4 px-5 text-xs text-zinc-500 whitespace-nowrap">
                      {new Date(o.created_at).toLocaleDateString()}
                    </td>
                    <td className="py-4 px-5">
                      <span className={`px-2.5 py-1 rounded-full text-xs font-bold capitalize ${STATUS_COLORS[o.status]}`}>
                        {o.status}
                      </span>
                    </td>
                    <td className="py-4 px-5">
                      {nextStates.length === 0 ? (
                        <span className="text-xs text-zinc-600">—</span>
                      ) : (
                        <select
                          value=""
                          disabled={updatingId === o.id}
                          onChange={(e) => {
                            const next = e.target.value as ApiOrder['status'];
                            if (next) handleStatusChange(o, next);
                          }}
                          className="bg-zinc-800 border border-zinc-700 text-white text-xs rounded-lg px-2 py-1.5 focus:outline-none focus:ring-1 focus:ring-[#6B46FF] disabled:opacity-50"
                        >
                          <option value="" disabled>
                            {updatingId === o.id ? (dir === 'rtl' ? 'جارٍ الحفظ...' : 'Saving...') : dir === 'rtl' ? 'تغيير إلى...' : 'Move to...'}
                          </option>
                          {nextStates.map((s) => (
                            <option key={s} value={s} className="capitalize">
                              {s}
                            </option>
                          ))}
                        </select>
                      )}
                      {rowError?.id === o.id && (
                        <div className="text-[11px] text-red-400 mt-1 max-w-[220px]">{rowError.message}</div>
                      )}
                    </td>
                  </tr>
                );
              })}
              {!loading && filtered.length === 0 && (
                <tr>
                  <td colSpan={7} className="py-12 text-center text-zinc-500 font-medium">
                    {dir === 'rtl' ? 'لا توجد طلبات' : 'No orders found'}
                  </td>
                </tr>
              )}
              {loading && orders.length === 0 && (
                <tr>
                  <td colSpan={7} className="py-12 text-center text-zinc-500 font-medium">
                    {dir === 'rtl' ? 'جارٍ التحميل...' : 'Loading...'}
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>
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
    { id: 'home_settings', icon: LayoutList, label: dir === 'rtl' ? 'اعدادات الرئيسية' : 'Home Settings' },
    { id: 'users', icon: Users, label: t('adminUsers') },
    { id: 'wallet_settings', icon: Wallet, label: 'Wallet Settings' },
    { id: 'store_settings', icon: Settings, label: 'Store Settings' },
    { id: 'ads', icon: Megaphone, label: 'Ads & Texts' },
    { id: 'serials', icon: Barcode, label: dir === 'rtl' ? 'الأجهزة والتسلسلات' : 'Serials & Devices' },
    { id: 'reviews', icon: Star, label: dir === 'rtl' ? 'المراجعات والهدايا' : 'Reviews & Gifts' },
    { id: 'kyc', icon: ShieldCheck, label: dir === 'rtl' ? 'التحقق والعناوين' : 'KYC & Addresses' },
    { id: 'memberships', icon: Crown, label: dir === 'rtl' ? 'الأعضاء والدعم' : 'Members & Support' },
  ];

  return (
    <DashboardLayout
      title="ADMIN"
      sidebarItems={sidebarItems}
      activeTab={activeTab}
      onTabChange={(id) => setActiveTab(id as AdminTab)}
    >
      <div className={`max-w-[1280px] mx-auto text-white ${activeTab === 'products' || activeTab === 'overview' ? '' : 'bg-zinc-900/50 backdrop-blur-xl border border-zinc-800/50 rounded-3xl p-6 md:p-8 shadow-lg'}`}>

        {activeTab === 'overview' && (
          <AdminOverview onNavigateTab={(tab) => setActiveTab(tab as AdminTab)} />
        )}

        {activeTab === 'orders' && (
          <AdminOrders />
        )}

        {activeTab === 'products' && (
          <AdminProducts />
        )}
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
      </div>
    </DashboardLayout>
  );
}
