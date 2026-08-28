import React from 'react';
import { useNavigate, useLocation } from 'react-router-dom';
import { useLanguage } from '../LanguageContext';
import { ArrowLeft, ArrowRight, Package } from 'lucide-react';

export default function Orders() {
  const navigate = useNavigate();
  const { t, dir } = useLanguage();
  const location = useLocation();
  const params = new URLSearchParams(location.search);
  const status = params.get('status') || 'All';

  const dummyOrders: any[] = [];

  const filteredOrders = (status === 'All' || status === 'null') ? dummyOrders : dummyOrders.filter(o => o.status === status);

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
        {filteredOrders.length === 0 ? (
          <div className="text-center py-12 text-zinc-500 bg-zinc-900/50 rounded-xl border border-zinc-800/50">
            No orders found.
          </div>
        ) : (
          <div className="flex flex-col gap-4">
            {filteredOrders.map(order => (
              <div key={order.id} className="bg-zinc-900/50 border border-zinc-800/50 rounded-xl p-4 flex flex-col">
                <div className="flex justify-between items-center mb-3 pb-3 border-b border-zinc-800/50">
                  <span className="text-white font-bold">{order.id}</span>
                  <span className="text-xs text-zinc-500">{order.date}</span>
                </div>
                <div className="flex items-center gap-4 mb-4">
                  <div className="w-12 h-12 bg-black rounded-lg flex items-center justify-center border border-zinc-800">
                    <Package className="w-6 h-6 text-olive" />
                  </div>
                  <div>
                    <div className="text-sm text-zinc-300">{order.items} items</div>
                    <div className="text-gold font-bold">{order.total.toLocaleString()} IQD</div>
                  </div>
                </div>
                <div className="mt-auto">
                  <span className="bg-zinc-800 text-zinc-300 px-3 py-1 rounded text-xs font-bold tracking-wider">
                    {t(order.status as any) || order.status}
                  </span>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
