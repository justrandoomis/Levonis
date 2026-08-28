import React, { useState, useEffect, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import { useLanguage } from '../LanguageContext';
import { ArrowLeft, ArrowRight, ShieldCheck, X, Clock, CheckCircle, XCircle, Search } from 'lucide-react';
import { api, ApiOrder } from '../lib/api';

interface WarrantyClaim {
  id: string;
  order_item_id: string | null;
  product_name: string;
  description: string;
  status: 'submitted' | 'in_review' | 'approved' | 'rejected';
  created_at: string;
}

const STATUS_STYLES: Record<string, { label: string; labelAr: string; cls: string; icon: React.ElementType }> = {
  submitted: { label: 'Submitted', labelAr: 'مُقدَّم', cls: 'bg-zinc-500/10 text-zinc-300 border-zinc-500/30', icon: Clock },
  in_review: { label: 'In Review', labelAr: 'قيد المراجعة', cls: 'bg-yellow-500/10 text-yellow-400 border-yellow-500/30', icon: Search },
  approved: { label: 'Approved', labelAr: 'مقبول', cls: 'bg-green-500/10 text-green-400 border-green-500/30', icon: CheckCircle },
  rejected: { label: 'Rejected', labelAr: 'مرفوض', cls: 'bg-red-500/10 text-red-400 border-red-500/30', icon: XCircle },
};

export default function Warranty() {
  const navigate = useNavigate();
  const { dir } = useLanguage();

  const [claims, setClaims] = useState<WarrantyClaim[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [listError, setListError] = useState('');
  const [showForm, setShowForm] = useState(false);

  // Form state
  const [productName, setProductName] = useState('');
  const [description, setDescription] = useState('');
  const [orderItemId, setOrderItemId] = useState('');
  const [orders, setOrders] = useState<ApiOrder[]>([]);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [formError, setFormError] = useState('');

  const loadClaims = useCallback(async () => {
    try {
      const res = await api.get<{ claims: WarrantyClaim[] }>('/api/profile/warranty-claims');
      setClaims(res.claims);
      setListError('');
    } catch (err: any) {
      setListError(err?.message || 'Failed to load warranty claims');
    } finally {
      setIsLoading(false);
    }
  }, []);

  useEffect(() => {
    loadClaims();
  }, [loadClaims]);

  const openForm = async () => {
    setProductName('');
    setDescription('');
    setOrderItemId('');
    setFormError('');
    setShowForm(true);
    try {
      const res = await api.get<{ orders: ApiOrder[] }>('/api/orders');
      setOrders(res.orders);
    } catch {
      setOrders([]);
    }
  };

  const handleOrderItemSelect = (value: string) => {
    setOrderItemId(value);
    if (value) {
      for (const o of orders) {
        const item = o.items.find((it) => it.id === value);
        if (item) {
          setProductName(item.name);
          break;
        }
      }
    }
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (isSubmitting) return;
    setFormError('');
    setIsSubmitting(true);
    try {
      await api.post('/api/profile/warranty-claims', {
        productName,
        description,
        orderItemId: orderItemId || undefined,
      });
      setShowForm(false);
      await loadClaims();
    } catch (err: any) {
      setFormError(err?.message || 'Failed to submit the claim');
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <div className="w-full pb-24 text-zinc-300 min-h-screen">
      <div className="sticky top-0 z-40 bg-black/80 backdrop-blur-xl border-b border-zinc-800/60 px-4 py-3 flex items-center gap-3">
        <button onClick={() => navigate(-1)} className="p-2 bg-zinc-900 rounded-full hover:bg-zinc-800 transition-colors">
          {dir === 'rtl' ? <ArrowRight className="w-5 h-5" /> : <ArrowLeft className="w-5 h-5" />}
        </button>
        <h1 className="text-white font-bold text-lg">
          مركز الضمان (Warranty Center)
        </h1>
      </div>

      <div className="p-4 space-y-4">
        {listError && (
          <div className="bg-red-500/10 border border-red-500/30 text-red-400 text-[13px] font-medium rounded-xl p-3 text-center">
            {listError}
          </div>
        )}

        {isLoading ? (
          <div className="flex justify-center py-16">
            <div className="w-8 h-8 border-2 border-olive/30 border-t-olive rounded-full animate-spin" />
          </div>
        ) : claims.length === 0 && !listError ? (
          <div className="bg-zinc-900/50 border border-zinc-800/50 rounded-xl p-6 text-center">
            <ShieldCheck className="w-12 h-12 text-olive mx-auto mb-4" />
            <h2 className="text-white font-bold mb-2">No Active Claims</h2>
            <p className="text-zinc-400 text-sm mb-4">{dir === 'rtl' ? 'ليس لديك أي مطالبات ضمان.' : 'You do not have any warranty claims.'}</p>
            <button onClick={openForm} className="bg-olive/20 text-olive px-4 py-2 rounded-lg font-bold border border-olive/30 hover:bg-olive/30 transition-colors">
              Submit New Claim
            </button>
          </div>
        ) : (
          <>
            <button onClick={openForm} className="w-full bg-olive/20 text-olive px-4 py-3 rounded-xl font-bold border border-olive/30 hover:bg-olive/30 transition-colors">
              Submit New Claim
            </button>
            {claims.map((claim) => {
              const st = STATUS_STYLES[claim.status] || STATUS_STYLES.submitted;
              const StatusIcon = st.icon;
              return (
                <div key={claim.id} className="bg-zinc-900/50 border border-zinc-800/50 rounded-xl p-5">
                  <div className="flex items-start justify-between gap-3 mb-2">
                    <div className="flex items-center gap-3 min-w-0">
                      <ShieldCheck className="w-6 h-6 text-olive shrink-0" />
                      <h3 className="text-white font-bold truncate">{claim.product_name}</h3>
                    </div>
                    <span className={`inline-flex items-center gap-1 px-2.5 py-1 rounded-full border text-[11px] font-bold shrink-0 ${st.cls}`}>
                      <StatusIcon className="w-3 h-3" />
                      {dir === 'rtl' ? st.labelAr : st.label}
                    </span>
                  </div>
                  <p className="text-zinc-400 text-sm leading-relaxed mb-3 whitespace-pre-wrap">{claim.description}</p>
                  <p className="text-zinc-500 text-[11px]">
                    {dir === 'rtl' ? 'تاريخ التقديم: ' : 'Submitted: '}
                    {new Date(claim.created_at).toLocaleDateString()}
                  </p>
                </div>
              );
            })}
          </>
        )}
      </div>

      {/* Submit Claim Modal */}
      {showForm && (
        <div className="fixed inset-0 z-[60] bg-black/70 backdrop-blur-sm flex items-center justify-center p-4">
          <div className="bg-[#0a0a0a] border border-zinc-800 rounded-[24px] p-6 w-full max-w-md shadow-2xl relative max-h-[90vh] overflow-y-auto">
            <button onClick={() => setShowForm(false)} className="absolute top-4 right-4 p-2 text-zinc-500 hover:text-white bg-zinc-900 rounded-full transition-colors">
              <X className="w-4 h-4" />
            </button>
            <h2 className="text-white text-lg font-bold mb-1">{dir === 'rtl' ? 'مطالبة ضمان جديدة' : 'New Warranty Claim'}</h2>
            <p className="text-zinc-500 text-sm mb-5">{dir === 'rtl' ? 'صف المشكلة وسيراجعها فريقنا.' : 'Describe the problem and our team will review it.'}</p>

            <form onSubmit={handleSubmit} className="space-y-4">
              {formError && (
                <div className="bg-red-500/10 border border-red-500/30 text-red-400 text-[13px] font-medium rounded-xl p-3 text-center">
                  {formError}
                </div>
              )}

              {orders.some((o) => o.items.length > 0) && (
                <div>
                  <label className="text-[12px] text-zinc-400 mb-1.5 block font-medium">{dir === 'rtl' ? 'اربطها بمنتج اشتريته (اختياري)' : 'Link to an ordered item (optional)'}</label>
                  <select
                    value={orderItemId}
                    onChange={(e) => handleOrderItemSelect(e.target.value)}
                    className="w-full bg-zinc-900 border border-zinc-800 rounded-xl px-3 py-2.5 text-white text-sm outline-none focus:border-olive/50 transition-colors"
                  >
                    <option value="">{dir === 'rtl' ? 'بدون ربط' : 'No linked order item'}</option>
                    {orders.flatMap((o) =>
                      o.items.map((it) => (
                        <option key={it.id} value={it.id}>
                          {it.name} — {new Date(o.created_at).toLocaleDateString()}
                        </option>
                      ))
                    )}
                  </select>
                </div>
              )}

              <div>
                <label className="text-[12px] text-zinc-400 mb-1.5 block font-medium">{dir === 'rtl' ? 'اسم المنتج' : 'Product name'}<span className="text-red-500">*</span></label>
                <input
                  type="text"
                  value={productName}
                  onChange={(e) => setProductName(e.target.value)}
                  minLength={2}
                  maxLength={200}
                  required
                  className="w-full bg-zinc-900 border border-zinc-800 rounded-xl px-3 py-2.5 text-white text-sm outline-none focus:border-olive/50 transition-colors"
                  placeholder={dir === 'rtl' ? 'مثال: طابعة Ender 3' : 'e.g. Ender 3 Printer'}
                />
              </div>

              <div>
                <label className="text-[12px] text-zinc-400 mb-1.5 block font-medium">{dir === 'rtl' ? 'وصف المشكلة' : 'Problem description'}<span className="text-red-500">*</span></label>
                <textarea
                  value={description}
                  onChange={(e) => setDescription(e.target.value)}
                  minLength={10}
                  maxLength={3000}
                  required
                  rows={4}
                  className="w-full bg-zinc-900 border border-zinc-800 rounded-xl px-3 py-2.5 text-white text-sm outline-none focus:border-olive/50 transition-colors resize-none"
                  placeholder={dir === 'rtl' ? 'صف المشكلة بالتفصيل (10 أحرف على الأقل)…' : 'Describe the issue in detail (at least 10 characters)…'}
                />
              </div>

              <button
                type="submit"
                disabled={isSubmitting}
                className="w-full bg-olive hover:bg-[#3b5927] text-white py-3 rounded-xl font-bold transition-colors disabled:opacity-50"
              >
                {isSubmitting ? (dir === 'rtl' ? 'جارٍ الإرسال…' : 'Submitting…') : (dir === 'rtl' ? 'إرسال المطالبة' : 'Submit Claim')}
              </button>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}
