import React, { useState, useEffect, useCallback } from 'react';
import { useNavigate, useLocation } from 'react-router-dom';
import { useLanguage } from '../LanguageContext';
import { ArrowLeft, ArrowRight, Package } from 'lucide-react';
import { api, ApiOrder, formatIqd } from '../lib/api';
import ReturnsSection from '../components/returns/ReturnsSection';

const STATUS_STYLES: Record<ApiOrder['status'], string> = {
  pending: 'bg-amber-500/10 text-amber-400',
  confirmed: 'bg-blue-500/10 text-blue-400',
  processing: 'bg-sky-500/10 text-sky-400',
  shipped: 'bg-indigo-500/10 text-indigo-400',
  delivered: 'bg-emerald-500/10 text-emerald-400',
  cancelled: 'bg-red-500/10 text-red-400',
};

export default function Orders() {
  const navigate = useNavigate();
  const { t, dir, lang } = useLanguage();
  const location = useLocation();
  const params = new URLSearchParams(location.search);
  const status = params.get('status') || 'All';

  const [orders, setOrders] = useState<ApiOrder[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [cancellingId, setCancellingId] = useState<string | null>(null);

  const loadOrders = useCallback(async () => {
    try {
      const query = status && status !== 'All' && status !== 'null' ? `?status=${encodeURIComponent(status)}` : '';
      const data = await api.get<{ orders: ApiOrder[] }>(`/api/orders${query}`);
      setOrders(data.orders || []);
      setError('');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load orders');
    } finally {
      setLoading(false);
    }
  }, [status]);

  useEffect(() => {
    setLoading(true);
    loadOrders();
  }, [loadOrders]);

  const cancelOrder = async (order: ApiOrder) => {
    const confirmed = window.confirm(
      dir === 'rtl'
        ? `هل أنت متأكد من إلغاء الطلب ${order.id}؟ سيُعاد أي رصيد أو نقاط مدفوعة.`
        : `Cancel order ${order.id}? Any paid balance or points will be refunded.`
    );
    if (!confirmed) return;
    setCancellingId(order.id);
    try {
      await api.post(`/api/orders/${order.id}/cancel`);
      await loadOrders();
    } catch (err) {
      alert(err instanceof Error ? err.message : 'Failed to cancel order');
    } finally {
      setCancellingId(null);
    }
  };

  const formatDate = (iso: string) => {
    try {
      return new Date(iso).toLocaleDateString(lang === 'en' ? 'en-GB' : 'ar-IQ', {
        year: 'numeric',
        month: 'short',
        day: 'numeric',
      });
    } catch {
      return iso;
    }
  };

  return (
    <div className="w-full pb-24 text-zinc-300 min-h-screen">
      <div className="sticky top-0 z-40 bg-black/80 backdrop-blur-xl border-b border-zinc-800/60 px-4 py-3 flex items-center gap-3">
        <button onClick={() => navigate(-1)} className="p-2 bg-zinc-900 rounded-full hover:bg-zinc-800 transition-colors">
          {dir === 'rtl' ? <ArrowRight className="w-5 h-5" /> : <ArrowLeft className="w-5 h-5" />}
        </button>
        <h1 className="text-white font-bold text-lg">
          {t('myOrders' as any) || 'My Orders'} {(status !== 'All' && status !== 'null') ? `- ${t(status as any) || status}` : ''}
        </h1>
      </div>

      <div className="p-4">
        {loading ? (
          <div className="text-center py-12">
            <div className="w-6 h-6 mx-auto border-2 border-olive border-t-transparent rounded-full animate-spin"></div>
          </div>
        ) : error ? (
          <div className="text-center py-12 text-red-400 bg-zinc-900/50 rounded-xl border border-zinc-800/50">
            {error}
          </div>
        ) : orders.length === 0 ? (
          <div className="text-center py-12 text-zinc-500 bg-zinc-900/50 rounded-xl border border-zinc-800/50">
            {dir === 'rtl' ? 'لا توجد طلبات' : 'No orders found.'}
          </div>
        ) : (
          <div className="flex flex-col gap-4">
            {orders.map(order => (
              <div key={order.id} className="bg-zinc-900/50 border border-zinc-800/50 rounded-xl p-4 flex flex-col">
                <div className="flex justify-between items-center mb-3 pb-3 border-b border-zinc-800/50">
                  <span className="text-white font-bold">{order.id}</span>
                  <span className="text-xs text-zinc-500">{formatDate(order.created_at)}</span>
                </div>

                <div className="flex flex-col gap-3 mb-4">
                  {order.items.map(item => (
                    <div key={item.id} className="flex items-center gap-4">
                      <div className="w-12 h-12 bg-black rounded-lg flex items-center justify-center border border-zinc-800 overflow-hidden shrink-0">
                        {item.image ? (
                          <img referrerPolicy="no-referrer" src={item.image} alt={item.name} className="w-full h-full object-cover" />
                        ) : (
                          <Package className="w-6 h-6 text-olive" />
                        )}
                      </div>
                      <div className="min-w-0 flex-1">
                        <div className="text-sm text-zinc-300 line-clamp-1">{item.name}</div>
                        <div className="text-xs text-zinc-500">
                          {item.variant ? `${item.variant} · ` : ''}x{item.qty}
                        </div>
                      </div>
                      <div className="text-sm text-zinc-400 shrink-0">{formatIqd(item.line_total_iqd)}</div>
                    </div>
                  ))}
                </div>

                <div className="flex items-center justify-between pt-3 border-t border-zinc-800/50">
                  <div>
                    <div className="text-xs text-zinc-500 mb-1">{dir === 'rtl' ? 'المجموع' : 'Total'}</div>
                    <div className="text-gold font-bold">{formatIqd(order.total_iqd)}</div>
                  </div>
                  <div className="flex items-center gap-2">
                    {order.status === 'pending' && (
                      <button
                        onClick={() => cancelOrder(order)}
                        disabled={cancellingId === order.id}
                        className="px-3 py-1 rounded text-xs font-bold tracking-wider border border-red-500/30 text-red-400 hover:bg-red-500/10 transition-colors disabled:opacity-50"
                      >
                        {cancellingId === order.id
                          ? (dir === 'rtl' ? 'جارٍ الإلغاء...' : 'Cancelling...')
                          : (dir === 'rtl' ? 'إلغاء الطلب' : 'Cancel')}
                      </button>
                    )}
                    <span className={`px-3 py-1 rounded text-xs font-bold tracking-wider ${STATUS_STYLES[order.status] ?? 'bg-zinc-800 text-zinc-300'}`}>
                      {t(order.status as any) || order.status}
                    </span>
                  </div>
                </div>
                <ReturnsSection order={order} />
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
