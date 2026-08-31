/**
 * Store administration — `/merchant` on the main site, `/admin` on a storefront.
 *
 * THIS IS NOT THE PLATFORM ADMIN. It talks only to `/api/merchant/*`, every
 * route of which resolves the caller's own store from their session. There is
 * no store id in any request here to swap, and the frontend guard is UX only
 * — the server refuses regardless of what this page renders (§72).
 *
 * READING NEVER STOPS. When PLUS lapses or a store is paused, the merchant
 * keeps every screen: orders, money, reviews, customers. What disappears are
 * the CONTROLS that create new obligations, and each one says why rather than
 * quietly vanishing (§48, §84) — a merchant with an unpaid invoice and an
 * unfinished order must be able to see and finish both.
 *
 * Nothing here is a placeholder. The mandate's §92 named five dead spots in
 * the old dashboard — empty orders, no product editing, no reviews, disabled
 * notification switches, no analytics — and each is a working screen below.
 */

import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { motion } from 'motion/react';
import {
  Store, Package, ShoppingBag, Star, Users, BarChart3, Settings as SettingsIcon,
  Bell, Wallet, Loader2, Plus, Pencil, Copy, Trash2, ExternalLink, AlertCircle,
  Check, ArrowRight,
} from 'lucide-react';
import { useLanguage } from '../LanguageContext';
import { ApiError } from '../lib/api';
import { merchantApi, iqd, type MerchantMe, type MerchantProduct } from '../lib/merchant';
import { ImagePicker, ImageGallery } from '../components/media/ImagePicker';

type Tab = 'overview' | 'products' | 'orders' | 'reviews' | 'customers' | 'money' | 'settings' | 'notifications';

export default function MerchantDashboardPage() {
  const { loc } = useLanguage();
  const [me, setMe] = useState<MerchantMe | null>(null);
  const [loading, setLoading] = useState(true);
  const [tab, setTab] = useState<Tab>('overview');

  const reload = useCallback(() => {
    merchantApi
      .me()
      .then(setMe)
      .catch(() => setMe(null))
      .finally(() => setLoading(false));
  }, []);

  useEffect(reload, [reload]);

  if (loading) {
    return (
      <div className="min-h-screen bg-[#0a0a0a] flex items-center justify-center">
        <Loader2 className="w-6 h-6 text-gold animate-spin" />
      </div>
    );
  }

  // No store yet: point at the one thing that fixes it.
  if (!me?.store) {
    return (
      <div className="min-h-screen bg-[#0a0a0a] flex items-center justify-center px-6">
        <div className="text-center max-w-sm">
          <Store className="w-10 h-10 text-zinc-600 mx-auto mb-4" />
          <h1 className="text-gold font-bold text-lg mb-2">
            {loc('ليس لديك متجر بعد', 'You do not have a store yet', 'هێشتا فرۆشگات نییە')}
          </h1>
          <Link
            to={me?.eligible ? '/merchant/start' : '/subscription'}
            className="inline-flex items-center gap-2 min-h-[48px] px-6 rounded-2xl bg-olive text-white font-bold text-[14px] mt-4"
          >
            {me?.eligible
              ? loc('أنشئ متجرك', 'Create your store', 'فرۆشگاکەت دروست بکە')
              : loc('اشترك في PLUS', 'Subscribe to PLUS', 'بەشداری PLUS بکە')}
            <ArrowRight className="w-4 h-4 rtl:rotate-180" />
          </Link>
        </div>
      </div>
    );
  }

  const store = me.store;
  const canSell = me.selling.canSell;

  const TABS: Array<{ id: Tab; label: string; icon: React.ReactNode }> = [
    { id: 'overview', label: loc('نظرة عامة', 'Overview', 'گشتی'), icon: <BarChart3 className="w-4 h-4" /> },
    { id: 'products', label: loc('المنتجات', 'Products', 'بەرهەم'), icon: <Package className="w-4 h-4" /> },
    { id: 'orders', label: loc('الطلبات', 'Orders', 'داواکاری'), icon: <ShoppingBag className="w-4 h-4" /> },
    { id: 'reviews', label: loc('التقييمات', 'Reviews', 'هەڵسەنگاندن'), icon: <Star className="w-4 h-4" /> },
    { id: 'customers', label: loc('العملاء', 'Customers', 'کڕیاران'), icon: <Users className="w-4 h-4" /> },
    { id: 'money', label: loc('الأرباح', 'Earnings', 'قازانج'), icon: <Wallet className="w-4 h-4" /> },
    { id: 'settings', label: loc('الإعدادات', 'Settings', 'ڕێکخستن'), icon: <SettingsIcon className="w-4 h-4" /> },
    { id: 'notifications', label: loc('الإشعارات', 'Notifications', 'ئاگادارکردنەوە'), icon: <Bell className="w-4 h-4" /> },
  ];

  return (
    <div className="min-h-screen bg-[#0a0a0a] text-zinc-300 pb-28">
      <div className="fixed top-0 left-1/2 -translate-x-1/2 w-full max-w-2xl h-[400px] bg-olive/15 rounded-full blur-[120px] pointer-events-none z-0" />

      <div className="relative z-10 max-w-3xl mx-auto px-4 sm:px-6 pt-6">
        <div className="flex items-center gap-3 mb-4">
          <div className="w-12 h-12 rounded-2xl bg-olive/30 border border-gold/20 overflow-hidden flex items-center justify-center shrink-0">
            {store.logoUrl ? (
              <img src={store.logoUrl} alt="" className="w-full h-full object-cover" />
            ) : (
              <Store className="w-5 h-5 text-gold" />
            )}
          </div>
          <div className="min-w-0 flex-1">
            <h1 className="text-white font-bold text-[16px] truncate">{store.name}</h1>
            <a
              href={store.url}
              target="_blank"
              rel="noopener noreferrer"
              className="text-gold/80 text-[11.5px] flex items-center gap-1 truncate"
              dir="ltr"
            >
              <span className="truncate">{store.url.replace(/^https?:\/\//, '')}</span>
              <ExternalLink className="w-3 h-3 shrink-0" />
            </a>
          </div>
        </div>

        {/* Why selling is off, in words. Never a silently missing button. */}
        {!canSell && (
          <div className="flex items-start gap-2 rounded-2xl border border-amber-500/30 bg-amber-500/10 px-3 py-2.5 mb-4">
            <AlertCircle className="w-4 h-4 text-amber-400 shrink-0 mt-0.5" />
            <p className="text-amber-200/90 text-[11.5px] leading-relaxed">
              {loc(
                'البيع متوقّف حاليًا، لكن كل بياناتك وطلباتك وأرباحك محفوظة ويمكنك متابعتها.',
                'Selling is paused, but all your data, orders and earnings are kept and still visible.',
                'فرۆشتن ڕاگیراوە، بەڵام هەموو داتا و داواکاری و قازانجەکانت پارێزراون.'
              )}
            </p>
          </div>
        )}

        <div className="flex gap-1.5 overflow-x-auto hide-scrollbar -mx-4 px-4 mb-5 pb-1">
          {TABS.map((tb) => (
            <button
              key={tb.id}
              onClick={() => setTab(tb.id)}
              className={`shrink-0 flex items-center gap-1.5 px-3.5 min-h-[40px] rounded-2xl text-[12.5px] font-semibold border transition-colors ${
                tab === tb.id
                  ? 'bg-olive text-white border-olive'
                  : 'bg-white/[0.03] text-zinc-400 border-white/10'
              }`}
            >
              {tb.icon}
              {tb.label}
            </button>
          ))}
        </div>

        <motion.div key={tab} initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.25 }}>
          {tab === 'overview' && <OverviewTab canSell={canSell} />}
          {tab === 'products' && <ProductsTab canSell={canSell} />}
          {tab === 'orders' && <OrdersTab />}
          {tab === 'reviews' && <ReviewsTab />}
          {tab === 'customers' && <CustomersTab />}
          {tab === 'money' && <MoneyTab />}
          {tab === 'settings' && <SettingsTab me={me} onSaved={reload} />}
          {tab === 'notifications' && <NotificationsTab />}
        </motion.div>
      </div>
    </div>
  );
}

// -------------------------------------------------------------- overview

function OverviewTab({ canSell }: { canSell: boolean }) {
  const { loc } = useLanguage();
  const [data, setData] = useState<Record<string, unknown> | null>(null);
  const [error, setError] = useState('');

  useEffect(() => {
    merchantApi
      .analytics()
      .then(setData)
      .catch((e) => setError(e instanceof ApiError ? e.message : 'error'));
  }, []);

  if (error) return <Notice text={error} />;
  if (!data) return <Spinner />;

  const orders = data.orders as Record<string, number | null>;
  const products = data.products as Record<string, number>;
  const offers = data.offers as Record<string, number | null>;

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-3">
        <Stat label={loc('إجمالي المبيعات', 'Gross sales', 'کۆی فرۆشتن')} value={iqd(orders.gross_iqd)} />
        <Stat label={loc('صافي أرباحك', 'Your earnings', 'قازانجی تۆ')} value={iqd(orders.receivable_iqd)} accent />
        <Stat label={loc('الطلبات', 'Orders', 'داواکاری')} value={String(orders.total ?? 0)} />
        <Stat label={loc('مكتملة', 'Completed', 'تەواوکراو')} value={String(orders.completed ?? 0)} />
        <Stat
          label={loc('متوسط الطلب', 'Average order', 'ناوەندی داواکاری')}
          // null means "no orders yet", which is a different answer from 0.
          value={orders.average_order_iqd === null ? loc('لا بيانات', 'No data', 'داتا نییە') : iqd(orders.average_order_iqd)}
        />
        <Stat label={loc('عمولة المنصة', 'Platform fees', 'کۆمیشن')} value={iqd(orders.platform_fees_iqd)} />
      </div>

      <div className="grid grid-cols-3 gap-3">
        <Stat label={loc('منتجات', 'Products', 'بەرهەم')} value={`${products.active ?? 0}/${products.total ?? 0}`} small />
        <Stat label={loc('متابعون', 'Followers', 'شوێنکەوتوو')} value={String(data.followers ?? 0)} small />
        <Stat label={loc('مشاهدات', 'Views', 'بینین')} value={String(products.views ?? 0)} small />
      </div>

      {Number(offers.sent ?? 0) > 0 && (
        <Card title={loc('العروض على الطلبات', 'Offers on requests', 'ئۆفەرەکان')}>
          <div className="flex items-center justify-between text-[13px]">
            <span className="text-zinc-400">
              {loc('مقبولة', 'Accepted', 'پەسەندکراو')}: <span className="text-white font-bold">{offers.accepted ?? 0}</span>
              <span className="text-zinc-600"> / {offers.sent}</span>
            </span>
            {offers.win_rate !== null && (
              <span className="text-gold font-bold">{offers.win_rate}%</span>
            )}
          </div>
        </Card>
      )}

      {canSell && (
        <Card title={loc('إجراءات سريعة', 'Quick actions', 'کردارە خێراکان')}>
          <div className="grid grid-cols-2 gap-2">
            <Link
              to="/community"
              className="min-h-[44px] rounded-2xl border border-white/10 bg-white/[0.03] flex items-center justify-center gap-2 text-[12.5px] font-semibold text-zinc-200"
            >
              {loc('طلبات العملاء', 'Customer requests', 'داواکاری کڕیاران')}
            </Link>
            <Link
              to="/chats"
              className="min-h-[44px] rounded-2xl border border-white/10 bg-white/[0.03] flex items-center justify-center gap-2 text-[12.5px] font-semibold text-zinc-200"
            >
              {loc('الرسائل', 'Messages', 'نامەکان')}
            </Link>
          </div>
        </Card>
      )}
    </div>
  );
}

// -------------------------------------------------------------- products

const EMPTY_PRODUCT = {
  name: '',
  description: '',
  price_iqd: 0,
  original_price_iqd: null as number | null,
  stock: 0,
  track_stock: true,
  category: '',
  prep_days: 0,
  images: [] as string[],
  lifecycle: 'active',
};

function ProductsTab({ canSell }: { canSell: boolean }) {
  const { loc } = useLanguage();
  const [items, setItems] = useState<MerchantProduct[] | null>(null);
  const [editing, setEditing] = useState<MerchantProduct | 'new' | null>(null);
  const [busy, setBusy] = useState('');

  const load = useCallback(() => {
    merchantApi.products().then((d) => setItems(d.products)).catch(() => setItems([]));
  }, []);
  useEffect(load, [load]);

  async function remove(p: MerchantProduct) {
    setBusy(p.id);
    try {
      const r = await merchantApi.deleteProduct(p.id);
      // Archived rather than deleted when it has been ordered — worth saying,
      // because the product disappearing from the shop but staying in history
      // is deliberate, not a bug.
      if (r.archived) {
        alert(
          loc(
            'تم أرشفة المنتج لأنه مرتبط بطلبات سابقة. لن يظهر في متجرك، وسجل الطلبات يبقى كما هو.',
            'The product was archived because it belongs to past orders. It is off your storefront and the order history is unchanged.',
            'بەرهەمەکە ئەرشیڤ کرا چونکە پەیوەندی بە داواکاری پێشووەکانەوە هەیە.'
          )
        );
      }
      load();
    } finally {
      setBusy('');
    }
  }

  if (items === null) return <Spinner />;

  if (editing) {
    return (
      <ProductEditor
        product={editing === 'new' ? null : editing}
        onDone={() => {
          setEditing(null);
          load();
        }}
        onCancel={() => setEditing(null)}
      />
    );
  }

  return (
    <div className="space-y-3">
      {canSell ? (
        <button
          onClick={() => setEditing('new')}
          className="w-full min-h-[48px] rounded-2xl bg-olive text-white font-bold text-[14px] flex items-center justify-center gap-2 active:scale-[0.98] transition-transform"
        >
          <Plus className="w-4 h-4" />
          {loc('منتج جديد', 'New product', 'بەرهەمی نوێ')}
        </button>
      ) : (
        <Notice
          text={loc(
            'لا يمكن نشر منتجات جديدة الآن. منتجاتك الحالية وسجلها محفوظة.',
            'New products cannot be published right now. Your existing products and their history are kept.',
            'ناتوانیت بەرهەمی نوێ بڵاو بکەیتەوە. بەرهەمە ئێستاکانت پارێزراون.'
          )}
        />
      )}

      {!items.length && (
        <Empty text={loc('لا توجد منتجات بعد', 'No products yet', 'هێشتا بەرهەم نییە')} />
      )}

      {items.map((p) => (
        <div key={p.id} className="rounded-2xl border border-white/10 bg-white/[0.03] p-3">
          <div className="flex gap-3">
            <div className="w-14 h-14 rounded-xl bg-black/40 overflow-hidden shrink-0">
              {p.images[0] && <img src={p.images[0]} alt="" className="w-full h-full object-cover" />}
            </div>
            <div className="min-w-0 flex-1">
              <p className="text-white text-[13px] font-semibold truncate">{p.name}</p>
              <p className="text-gold text-[12.5px] font-bold" dir="ltr">{iqd(p.price_iqd)}</p>
              <div className="flex items-center gap-2 mt-1">
                <LifecycleChip lifecycle={p.lifecycle ?? 'active'} />
                {p.track_stock && (
                  <span className="text-zinc-500 text-[11px]">
                    {loc('المخزون', 'Stock', 'کۆگا')}: {p.stock}
                  </span>
                )}
                {!!p.sold_count && (
                  <span className="text-zinc-500 text-[11px]">
                    {loc('مبيعات', 'Sold', 'فرۆشراو')}: {p.sold_count}
                  </span>
                )}
              </div>
            </div>
          </div>

          <div className="flex gap-2 mt-3">
            {/* Real editing. The old dashboard could only create and delete,
                so fixing a mistyped price meant losing the product. */}
            <IconAction icon={<Pencil className="w-3.5 h-3.5" />} label={loc('تعديل', 'Edit', 'دەستکاری')} onClick={() => setEditing(p)} disabled={!canSell} />
            <IconAction
              icon={<Copy className="w-3.5 h-3.5" />}
              label={loc('نسخ', 'Duplicate', 'لەبەرگرتنەوە')}
              disabled={!canSell || busy === p.id}
              onClick={async () => {
                setBusy(p.id);
                try {
                  await merchantApi.duplicateProduct(p.id);
                  load();
                } finally {
                  setBusy('');
                }
              }}
            />
            <IconAction
              icon={<Trash2 className="w-3.5 h-3.5" />}
              label={loc('حذف', 'Delete', 'سڕینەوە')}
              danger
              disabled={busy === p.id}
              onClick={() => remove(p)}
            />
          </div>
        </div>
      ))}
    </div>
  );
}

function ProductEditor({
  product,
  onDone,
  onCancel,
}: {
  product: MerchantProduct | null;
  onDone: () => void;
  onCancel: () => void;
}) {
  const { loc } = useLanguage();
  const [f, setF] = useState(() => ({
    ...EMPTY_PRODUCT,
    ...(product
      ? {
          name: product.name,
          description: product.description,
          price_iqd: product.price_iqd,
          original_price_iqd: product.original_price_iqd,
          stock: product.stock ?? 0,
          track_stock: product.track_stock ?? true,
          category: product.category,
          prep_days: product.prep_days,
          images: product.images,
          lifecycle: product.lifecycle ?? 'active',
        }
      : {}),
  }));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  async function save() {
    setSaving(true);
    setError('');
    try {
      if (product) await merchantApi.updateProduct(product.id, f);
      else await merchantApi.createProduct(f);
      onDone();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : loc('تعذّر الحفظ', 'Could not save', 'نەتوانرا پاشەکەوت بکرێت'));
      setSaving(false);
    }
  }

  return (
    <div className="rounded-2xl border border-white/10 bg-white/[0.03] p-4 space-y-4">
      <h3 className="text-gold font-bold text-[14px]">
        {product ? loc('تعديل المنتج', 'Edit product', 'دەستکاری بەرهەم') : loc('منتج جديد', 'New product', 'بەرهەمی نوێ')}
      </h3>

      <Input label={loc('الاسم', 'Name', 'ناو')} value={f.name} onChange={(v) => setF({ ...f, name: v })} />
      <Input
        label={loc('السعر (د.ع)', 'Price (IQD)', 'نرخ')}
        value={String(f.price_iqd)}
        type="number"
        onChange={(v) => setF({ ...f, price_iqd: Number(v) || 0 })}
      />
      <Input
        label={loc('السعر قبل الخصم (اختياري)', 'Original price (optional)', 'نرخی پێشوو')}
        value={f.original_price_iqd === null ? '' : String(f.original_price_iqd)}
        type="number"
        onChange={(v) => setF({ ...f, original_price_iqd: v === '' ? null : Number(v) || 0 })}
      />
      <Input
        label={loc('المخزون', 'Stock', 'کۆگا')}
        value={String(f.stock)}
        type="number"
        onChange={(v) => setF({ ...f, stock: Number(v) || 0 })}
      />
      <Input
        label={loc('أيام التحضير', 'Preparation days', 'ڕۆژانی ئامادەکردن')}
        value={String(f.prep_days)}
        type="number"
        onChange={(v) => setF({ ...f, prep_days: Number(v) || 0 })}
      />
      <Input label={loc('الفئة', 'Category', 'پۆل')} value={f.category} onChange={(v) => setF({ ...f, category: v })} />

      {/* The first image is what the storefront grid shows, so "make this the
          cover" is part of the control rather than a reordering trick the
          merchant has to work out. */}
      <ImageGallery
        label={loc('صور المنتج', 'Product images', 'وێنەکانی بەرهەم')}
        hint={loc(
          'أول صورة هي الغلاف في المتجر. حتى 8 صور.',
          'The first image is the cover in your shop. Up to 8 images.',
          'یەکەم وێنە بەرگی فرۆشگایە. تا ٨ وێنە.'
        )}
        value={f.images}
        max={8}
        onChange={(images) => setF({ ...f, images })}
      />

      <div>
        <label className="block text-zinc-400 text-[12.5px] font-semibold mb-2">
          {loc('الوصف', 'Description', 'وەسف')}
        </label>
        <textarea
          value={f.description}
          onChange={(e) => setF({ ...f, description: e.target.value })}
          rows={4}
          className="w-full rounded-2xl bg-black/40 border border-white/10 px-4 py-3 text-white text-[14px] outline-none focus:border-gold/40 resize-none"
        />
      </div>

      <div>
        <label className="block text-zinc-400 text-[12.5px] font-semibold mb-2">
          {loc('الحالة', 'Status', 'دۆخ')}
        </label>
        <div className="flex gap-2 flex-wrap">
          {(['active', 'draft', 'hidden', 'sold_out'] as const).map((k) => (
            <button
              key={k}
              onClick={() => setF({ ...f, lifecycle: k })}
              className={`px-3 min-h-[38px] rounded-xl text-[12px] font-semibold border transition-colors ${
                f.lifecycle === k ? 'bg-olive text-white border-olive' : 'bg-white/[0.03] text-zinc-400 border-white/10'
              }`}
            >
              {lifecycleLabel(k, loc)}
            </button>
          ))}
        </div>
      </div>

      {error && <p className="text-red-400 text-[12.5px]">{error}</p>}

      <div className="flex gap-2">
        <button
          onClick={save}
          disabled={saving || f.name.trim().length < 2}
          className="flex-1 min-h-[48px] rounded-2xl bg-olive text-white font-bold text-[14px] flex items-center justify-center gap-2 disabled:opacity-40"
        >
          {saving ? <Loader2 className="w-4 h-4 animate-spin" /> : <Check className="w-4 h-4" />}
          {loc('حفظ', 'Save', 'پاشەکەوت')}
        </button>
        <button
          onClick={onCancel}
          className="min-h-[48px] px-5 rounded-2xl border border-white/10 bg-white/[0.03] text-zinc-300 font-semibold text-[13px]"
        >
          {loc('إلغاء', 'Cancel', 'هەڵوەشاندنەوە')}
        </button>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- orders

const ORDER_FLOW: Record<string, string[]> = {
  pending: ['confirmed', 'cancelled'],
  confirmed: ['processing', 'cancelled'],
  processing: ['shipped', 'cancelled'],
  shipped: ['delivered'],
  delivered: [],
  cancelled: [],
};

function OrdersTab() {
  const { loc } = useLanguage();
  const [orders, setOrders] = useState<Record<string, unknown>[] | null>(null);
  const [busy, setBusy] = useState('');

  const load = useCallback(() => {
    merchantApi.orders().then((d) => setOrders(d.orders)).catch(() => setOrders([]));
  }, []);
  useEffect(load, [load]);

  if (orders === null) return <Spinner />;
  if (!orders.length) {
    return <Empty text={loc('لا توجد طلبات بعد', 'No orders yet', 'هێشتا داواکاری نییە')} />;
  }

  return (
    <div className="space-y-3">
      {orders.map((o) => {
        const id = String(o.id);
        const status = String(o.status);
        const next = ORDER_FLOW[status] ?? [];
        return (
          <div key={id} className="rounded-2xl border border-white/10 bg-white/[0.03] p-3.5">
            <div className="flex items-start justify-between gap-3 mb-2">
              <div className="min-w-0">
                <p className="text-white text-[13px] font-semibold truncate" dir="ltr">{id}</p>
                <p className="text-zinc-500 text-[11.5px]">{String(o.customer_name)}</p>
              </div>
              <StatusChip status={status} />
            </div>

            <div className="flex items-center justify-between text-[12px] mb-3">
              <span className="text-zinc-500">
                {loc('الإجمالي', 'Total', 'کۆ')}: <span className="text-white font-semibold" dir="ltr">{iqd(Number(o.total_iqd))}</span>
              </span>
              <span className="text-zinc-500">
                {loc('لك', 'You get', 'بۆ تۆ')}: <span className="text-gold font-semibold" dir="ltr">{iqd(Number(o.merchant_receivable_iqd))}</span>
              </span>
            </div>

            {next.length > 0 && (
              <div className="flex gap-2 flex-wrap">
                {next.map((s) => (
                  <button
                    key={s}
                    disabled={busy === id}
                    onClick={async () => {
                      setBusy(id);
                      try {
                        await merchantApi.setOrderStatus(id, s);
                        load();
                      } catch (e) {
                        if (e instanceof ApiError) alert(e.message);
                      } finally {
                        setBusy('');
                      }
                    }}
                    className={`px-3 min-h-[38px] rounded-xl text-[12px] font-semibold border transition-colors disabled:opacity-40 ${
                      s === 'cancelled'
                        ? 'border-red-500/30 bg-red-500/10 text-red-300'
                        : 'border-olive bg-olive text-white'
                    }`}
                  >
                    {statusLabel(s, loc)}
                  </button>
                ))}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

// --------------------------------------------------------------- reviews

function ReviewsTab() {
  const { loc } = useLanguage();
  const [reviews, setReviews] = useState<Record<string, unknown>[] | null>(null);
  const [replying, setReplying] = useState('');
  const [text, setText] = useState('');

  const load = useCallback(() => {
    merchantApi.reviews().then((d) => setReviews(d.reviews)).catch(() => setReviews([]));
  }, []);
  useEffect(load, [load]);

  if (reviews === null) return <Spinner />;
  if (!reviews.length) {
    return (
      <Empty
        text={loc('لا توجد تقييمات بعد', 'No reviews yet', 'هێشتا هەڵسەنگاندن نییە')}
        hint={loc(
          'التقييمات تصل من طلبات مكتملة فقط.',
          'Reviews arrive only from completed orders.',
          'هەڵسەنگاندن تەنها لە داواکاریە تەواوکراوەکانەوە دێت.'
        )}
      />
    );
  }

  return (
    <div className="space-y-3">
      {reviews.map((r) => {
        const id = String(r.id);
        return (
          <div key={id} className="rounded-2xl border border-white/10 bg-white/[0.03] p-3.5">
            <div className="flex items-center justify-between mb-1.5">
              <span className="text-white text-[13px] font-semibold">{String(r.customer_name)}</span>
              <div className="flex gap-0.5">
                {[1, 2, 3, 4, 5].map((n) => (
                  <Star key={n} className={`w-3.5 h-3.5 ${n <= Number(r.rating) ? 'text-gold fill-gold' : 'text-zinc-700'}`} />
                ))}
              </div>
            </div>
            {!!r.body && <p className="text-zinc-300 text-[12.5px] leading-relaxed mb-2">{String(r.body)}</p>}

            {r.merchant_reply ? (
              <div className="ps-3 border-s-2 border-gold/30">
                <p className="text-gold/80 text-[11px] font-semibold mb-0.5">{loc('ردك', 'Your reply', 'وەڵامەکەت')}</p>
                <p className="text-zinc-400 text-[12px]">{String(r.merchant_reply)}</p>
              </div>
            ) : replying === id ? (
              <div className="space-y-2">
                <textarea
                  value={text}
                  onChange={(e) => setText(e.target.value)}
                  rows={3}
                  maxLength={1500}
                  className="w-full rounded-xl bg-black/40 border border-white/10 px-3 py-2 text-white text-[13px] outline-none focus:border-gold/40 resize-none"
                />
                <div className="flex gap-2">
                  <button
                    onClick={async () => {
                      if (!text.trim()) return;
                      await merchantApi.replyReview(id, text.trim());
                      setReplying('');
                      setText('');
                      load();
                    }}
                    className="px-4 min-h-[38px] rounded-xl bg-olive text-white text-[12px] font-semibold"
                  >
                    {loc('إرسال', 'Send', 'ناردن')}
                  </button>
                  <button
                    onClick={() => setReplying('')}
                    className="px-4 min-h-[38px] rounded-xl border border-white/10 text-zinc-400 text-[12px]"
                  >
                    {loc('إلغاء', 'Cancel', 'هەڵوەشاندنەوە')}
                  </button>
                </div>
              </div>
            ) : (
              <button
                onClick={() => {
                  setReplying(id);
                  setText('');
                }}
                className="text-gold text-[12px] font-semibold"
              >
                {loc('رد', 'Reply', 'وەڵام')}
              </button>
            )}
          </div>
        );
      })}
    </div>
  );
}

// ------------------------------------------------------------- customers

function CustomersTab() {
  const { loc } = useLanguage();
  const [rows, setRows] = useState<Record<string, unknown>[] | null>(null);
  useEffect(() => {
    merchantApi.customers().then((d) => setRows(d.customers)).catch(() => setRows([]));
  }, []);

  if (rows === null) return <Spinner />;
  if (!rows.length) return <Empty text={loc('لا يوجد عملاء بعد', 'No customers yet', 'هێشتا کڕیار نییە')} />;

  return (
    <div className="space-y-2">
      {/* Only people who have actually bought from this store. Not a
          directory — a merchant has no way to browse Levonis users here. */}
      {rows.map((c) => (
        <div key={String(c.id)} className="rounded-2xl border border-white/10 bg-white/[0.03] p-3.5 flex items-center justify-between gap-3">
          <div className="min-w-0">
            <p className="text-white text-[13px] font-semibold truncate">{String(c.name)}</p>
            <p className="text-zinc-500 text-[11.5px]">
              {loc(`${c.order_count} طلب`, `${c.order_count} orders`, `${c.order_count} داواکاری`)}
            </p>
          </div>
          <span className="text-gold text-[12.5px] font-bold shrink-0" dir="ltr">{iqd(Number(c.lifetime_iqd))}</span>
        </div>
      ))}
    </div>
  );
}

// ----------------------------------------------------------------- money

function MoneyTab() {
  const { loc } = useLanguage();
  const [data, setData] = useState<Awaited<ReturnType<typeof merchantApi.payouts>> | null>(null);
  useEffect(() => {
    merchantApi.payouts().then(setData).catch(() => {});
  }, []);

  if (!data) return <Spinner />;

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-3 gap-3">
        <Stat label={loc('متاح', 'Available', 'بەردەست')} value={iqd(data.balance.available_iqd)} accent small />
        <Stat label={loc('قيد الانتظار', 'Pending', 'چاوەڕوان')} value={iqd(data.balance.pending_iqd)} small />
        <Stat label={loc('مدفوع', 'Paid out', 'دراوە')} value={iqd(Math.abs(data.balance.paid_iqd))} small />
      </div>

      <Card title={loc('سجل الحركات', 'Ledger', 'تۆمار')}>
        {/* Every row that makes up the balance. The balance is a sum over
            exactly these, so a merchant can add them up and get the same
            number — which is the point of not storing a balance. */}
        {!data.entries.length ? (
          <p className="text-zinc-500 text-[12.5px]">{loc('لا توجد حركات', 'No entries yet', 'هیچ تۆمارێک نییە')}</p>
        ) : (
          <div className="space-y-2">
            {data.entries.map((e) => (
              <div key={String(e.id)} className="flex items-center justify-between gap-3 text-[12.5px]">
                <div className="min-w-0">
                  <p className="text-zinc-300 truncate">{ledgerLabel(String(e.kind), loc)}</p>
                  <p className="text-zinc-600 text-[11px] truncate" dir="ltr">
                    {String(e.order_id || e.community_order_id || '')}
                  </p>
                </div>
                <span
                  className={`font-bold shrink-0 ${Number(e.amount_iqd) < 0 ? 'text-zinc-500' : 'text-gold'}`}
                  dir="ltr"
                >
                  {Number(e.amount_iqd) < 0 ? '−' : '+'}
                  {iqd(Math.abs(Number(e.amount_iqd)))}
                </span>
              </div>
            ))}
          </div>
        )}
      </Card>
    </div>
  );
}

// -------------------------------------------------------------- settings

function SettingsTab({ me, onSaved }: { me: MerchantMe; onSaved: () => void }) {
  const { loc } = useLanguage();
  const store = me.store!;
  const [f, setF] = useState({
    name: store.name,
    tagline: store.tagline,
    description: store.description,
    // The server holds a key; the shape hands back a /files/ path. Either is
    // accepted on the way in, so the form keeps whichever it was given.
    logo_key: store.logoUrl,
    banner_key: store.bannerUrl,
    contact_phone: store.contact_phone ?? '',
    contact_phone_public: !!store.contact_phone_public,
    accepts_custom_requests: store.accepts_custom_requests,
    sells_direct_products: store.sells_direct_products,
    accent: store.accent,
    open: store.status === 'active',
  });
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState('');

  const suspended = store.status === 'suspended';

  async function save() {
    setSaving(true);
    setError('');
    setSaved(false);
    try {
      // `null` means "remove it", and the server clears the column on an
      // empty string. Sending null would be `undefined` after JSON and the
      // field would simply not be updated — the logo would come back.
      await merchantApi.updateStore({
        ...f,
        logo_key: f.logo_key ?? '',
        banner_key: f.banner_key ?? '',
      });
      setSaved(true);
      onSaved();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : loc('تعذّر الحفظ', 'Could not save', 'نەتوانرا پاشەکەوت بکرێت'));
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="space-y-4">
      <Card title={loc('هوية المتجر', 'Store identity', 'ناسنامەی فرۆشگا')}>
        <div className="space-y-5">
          <ImagePicker
            label={loc('شعار المتجر', 'Store logo', 'لۆگۆی فرۆشگا')}
            hint={loc(
              'مربّع. يظهر بجانب اسم متجرك في كل مكان.',
              'Square. It appears beside your shop name everywhere.',
              'چوارگۆشە. لەتەنیشت ناوی فرۆشگاکەت دەردەکەوێت.'
            )}
            shape="square"
            value={f.logo_key}
            onChange={(v) => setF({ ...f, logo_key: v })}
          />
          <ImagePicker
            label={loc('غلاف المتجر', 'Store banner', 'بەرگی فرۆشگا')}
            hint={loc(
              'عريض. أعلى صفحة متجرك.',
              'Wide. It runs across the top of your shop page.',
              'پان. لەسەرەوەی لاپەڕەی فرۆشگاکەت.'
            )}
            shape="wide"
            value={f.banner_key}
            onChange={(v) => setF({ ...f, banner_key: v })}
          />
        </div>
      </Card>

      <Card title={loc('معلومات المتجر', 'Store information', 'زانیاری فرۆشگا')}>
        <div className="space-y-4">
          <Input label={loc('الاسم', 'Name', 'ناو')} value={f.name} onChange={(v) => setF({ ...f, name: v })} />
          <Input label={loc('وصف مختصر', 'Tagline', 'وەسفی کورت')} value={f.tagline} onChange={(v) => setF({ ...f, tagline: v })} />
          <div>
            <label className="block text-zinc-400 text-[12.5px] font-semibold mb-2">
              {loc('عن المتجر', 'About', 'دەربارە')}
            </label>
            <textarea
              value={f.description}
              onChange={(e) => setF({ ...f, description: e.target.value })}
              rows={4}
              className="w-full rounded-2xl bg-black/40 border border-white/10 px-4 py-3 text-white text-[14px] outline-none focus:border-gold/40 resize-none"
            />
          </div>
          <Input
            label={loc('رقم التواصل', 'Contact phone', 'ژمارەی پەیوەندی')}
            value={f.contact_phone}
            onChange={(v) => setF({ ...f, contact_phone: v })}
          />
          <Toggle
            label={loc('إظهار الرقم للعملاء', 'Show the number publicly', 'ژمارە بە گشتی پیشان بدە')}
            on={f.contact_phone_public}
            onChange={(v) => setF({ ...f, contact_phone_public: v })}
          />
        </div>
      </Card>

      <Card title={loc('المظهر', 'Appearance', 'ڕووکار')}>
        {/* A preset name, never a colour. Nothing a merchant types can become
            a style rule on their page (§12). */}
        <div className="flex gap-2 flex-wrap">
          {(['default', 'olive', 'gold', 'slate', 'plum', 'teal'] as const).map((a) => (
            <button
              key={a}
              onClick={() => setF({ ...f, accent: a })}
              className={`px-3 min-h-[38px] rounded-xl text-[12px] font-semibold border capitalize transition-colors ${
                f.accent === a ? 'bg-olive text-white border-olive' : 'bg-white/[0.03] text-zinc-400 border-white/10'
              }`}
            >
              {a}
            </button>
          ))}
        </div>
      </Card>

      <Card title={loc('ما تبيعه', 'What you sell', 'ئەوەی دەیفرۆشیت')}>
        <div className="space-y-3">
          <Toggle
            label={loc('منتجات جاهزة في المتجر', 'Ready-made products', 'بەرهەمی ئامادە')}
            on={f.sells_direct_products}
            onChange={(v) => setF({ ...f, sells_direct_products: v })}
          />
          <Toggle
            label={loc('طلبات مخصصة من العملاء', 'Custom customer requests', 'داواکاری تایبەت')}
            on={f.accepts_custom_requests}
            onChange={(v) => setF({ ...f, accepts_custom_requests: v })}
          />
        </div>
      </Card>

      <Card title={loc('حالة المتجر', 'Store status', 'دۆخی فرۆشگا')}>
        {suspended ? (
          // An admin suspension is not reachable from here at all — the
          // control is absent and the reason is given instead.
          <Notice
            text={loc(
              'المتجر موقوف من إدارة ليفونيس ولا يمكن إعادة فتحه من هنا. تواصل مع الدعم.',
              'This store is suspended by Levonis and cannot be re-opened from here. Contact support.',
              'فرۆشگاکە لەلایەن LEVONIS ڕاگیراوە. پەیوەندی بە پشتیوانییەوە بکە.'
            )}
          />
        ) : (
          <Toggle
            label={
              f.open
                ? loc('المتجر مفتوح ويستقبل الطلبات', 'Open and taking orders', 'کراوەیە و داواکاری وەردەگرێت')
                : loc('المتجر متوقّف مؤقتًا', 'Temporarily paused', 'کاتی ڕاگیراوە')
            }
            on={f.open}
            onChange={(v) => setF({ ...f, open: v })}
          />
        )}
      </Card>

      {error && <p className="text-red-400 text-[12.5px]">{error}</p>}

      <button
        onClick={save}
        disabled={saving}
        className="w-full min-h-[48px] rounded-2xl bg-olive text-white font-bold text-[14px] flex items-center justify-center gap-2 disabled:opacity-40"
      >
        {saving ? <Loader2 className="w-4 h-4 animate-spin" /> : saved ? <Check className="w-4 h-4" /> : null}
        {saved ? loc('تم الحفظ', 'Saved', 'پاشەکەوت کرا') : loc('حفظ التغييرات', 'Save changes', 'پاشەکەوتکردن')}
      </button>
    </div>
  );
}

// --------------------------------------------------------- notifications

function NotificationsTab() {
  const { loc } = useLanguage();
  const [prefs, setPrefs] = useState<Record<string, boolean> | null>(null);
  const [forced, setForced] = useState<string[]>([]);
  const [saving, setSaving] = useState('');

  useEffect(() => {
    merchantApi
      .notifications()
      .then((d) => {
        setPrefs(d.preferences);
        setForced(d.forced);
      })
      .catch(() => setPrefs({}));
  }, []);

  if (!prefs) return <Spinner />;

  const KEYS: Array<[string, string]> = [
    ['new_orders', loc('طلبات جديدة', 'New orders', 'داواکاری نوێ')],
    ['request_opportunities', loc('فرص طلبات العملاء', 'Customer request opportunities', 'دەرفەتی داواکاری')],
    ['new_messages', loc('رسائل جديدة', 'New messages', 'نامەی نوێ')],
    ['new_reviews', loc('تقييمات جديدة', 'New reviews', 'هەڵسەنگاندنی نوێ')],
    ['new_followers', loc('متابعون جدد', 'New followers', 'شوێنکەوتووی نوێ')],
    ['complaints', loc('الشكاوى والنزاعات', 'Complaints and disputes', 'سکاڵا و ناکۆکی')],
    ['subscription_expiry', loc('انتهاء الاشتراك', 'Subscription expiry', 'کۆتایی ئەندامێتی')],
    ['system_alerts', loc('تنبيهات النظام', 'System alerts', 'ئاگادارکردنەوەی سیستەم')],
    ['marketing', loc('عروض وتسويق', 'Offers and marketing', 'ئۆفەر و بازاڕکردن')],
  ];

  return (
    <Card title={loc('ما الذي تريد أن تُشعَر به', 'What you want to hear about', 'چی دەتەوێت ئاگادار بکرێیت')}>
      <div className="space-y-3">
        {KEYS.map(([k, label]) => {
          const isForced = forced.includes(k);
          return (
            <div key={k}>
              <Toggle
                label={label}
                on={!!prefs[k]}
                disabled={isForced || saving === k}
                onChange={async (v) => {
                  setSaving(k);
                  setPrefs({ ...prefs, [k]: v });
                  try {
                    const d = await merchantApi.setNotifications({ [k]: v });
                    setPrefs(d.preferences);
                  } finally {
                    setSaving('');
                  }
                }}
              />
              {/* Forced-on, with the reason. Better than a switch that
                  silently snaps back, and better than hiding it (§61). */}
              {isForced && (
                <p className="text-zinc-600 text-[11px] mt-1">
                  {loc(
                    'لا يمكن إيقافه — يخص أموالك أو حسابك.',
                    'Cannot be turned off — it concerns your money or your account.',
                    'ناتوانرێت بکوژێنرێتەوە — پەیوەندی بە پارە یان هەژمارەکەتەوە هەیە.'
                  )}
                </p>
              )}
            </div>
          );
        })}
      </div>
    </Card>
  );
}

// ------------------------------------------------------------------ bits

function Spinner() {
  return (
    <div className="py-12 flex justify-center">
      <Loader2 className="w-5 h-5 text-gold animate-spin" />
    </div>
  );
}

function Empty({ text, hint }: { text: string; hint?: string }) {
  return (
    <div className="py-12 text-center">
      <p className="text-zinc-400 text-[13px]">{text}</p>
      {hint && <p className="text-zinc-600 text-[11.5px] mt-1.5">{hint}</p>}
    </div>
  );
}

function Notice({ text }: { text: string }) {
  return (
    <div className="flex items-start gap-2 rounded-2xl border border-amber-500/30 bg-amber-500/10 px-3 py-2.5">
      <AlertCircle className="w-4 h-4 text-amber-400 shrink-0 mt-0.5" />
      <p className="text-amber-200/90 text-[11.5px] leading-relaxed">{text}</p>
    </div>
  );
}

function Card({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="rounded-2xl border border-white/10 bg-white/[0.03] p-4">
      <h3 className="text-gold font-bold text-[13px] mb-3">{title}</h3>
      {children}
    </div>
  );
}

function Stat({ label, value, accent, small }: { label: string; value: string; accent?: boolean; small?: boolean }) {
  return (
    <div className="rounded-2xl border border-white/10 bg-white/[0.03] p-3">
      <p className="text-zinc-500 text-[11px] mb-1">{label}</p>
      <p className={`font-bold ${small ? 'text-[13px]' : 'text-[15px]'} ${accent ? 'text-gold' : 'text-white'}`} dir="ltr">
        {value}
      </p>
    </div>
  );
}

function Input({
  label,
  value,
  onChange,
  type = 'text',
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  type?: string;
}) {
  return (
    <div>
      <label className="block text-zinc-400 text-[12.5px] font-semibold mb-2">{label}</label>
      <input
        type={type}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="w-full min-h-[48px] rounded-2xl bg-black/40 border border-white/10 px-4 text-white text-[14px] outline-none focus:border-gold/40 transition-colors"
      />
    </div>
  );
}

function Toggle({
  label,
  on,
  onChange,
  disabled,
}: {
  label: string;
  on: boolean;
  onChange: (v: boolean) => void;
  disabled?: boolean;
}) {
  return (
    <button
      onClick={() => !disabled && onChange(!on)}
      disabled={disabled}
      className="w-full flex items-center justify-between gap-3 min-h-[44px] disabled:opacity-60"
    >
      <span className="text-zinc-300 text-[13px] text-start">{label}</span>
      <span
        className={`w-11 h-6 rounded-full shrink-0 relative transition-colors ${on ? 'bg-olive' : 'bg-white/10'}`}
      >
        <span
          className={`absolute top-0.5 w-5 h-5 rounded-full bg-white transition-all ${on ? 'start-[22px]' : 'start-0.5'}`}
        />
      </span>
    </button>
  );
}

function IconAction({
  icon,
  label,
  onClick,
  danger,
  disabled,
}: {
  icon: React.ReactNode;
  label: string;
  onClick: () => void;
  danger?: boolean;
  disabled?: boolean;
}) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      className={`flex-1 min-h-[38px] rounded-xl border text-[12px] font-semibold flex items-center justify-center gap-1.5 transition-colors disabled:opacity-40 ${
        danger ? 'border-red-500/30 bg-red-500/10 text-red-300' : 'border-white/10 bg-white/[0.03] text-zinc-300'
      }`}
    >
      {icon}
      {label}
    </button>
  );
}

function LifecycleChip({ lifecycle }: { lifecycle: string }) {
  const { loc } = useLanguage();
  const map: Record<string, string> = {
    active: 'bg-emerald-500/10 text-emerald-400 border-emerald-500/20',
    draft: 'bg-zinc-500/10 text-zinc-400 border-zinc-500/20',
    hidden: 'bg-amber-500/10 text-amber-400 border-amber-500/20',
    sold_out: 'bg-red-500/10 text-red-300 border-red-500/20',
    archived: 'bg-zinc-700/20 text-zinc-500 border-zinc-600/20',
  };
  return (
    <span className={`text-[10px] font-bold px-2 py-0.5 rounded-full border ${map[lifecycle] ?? map.draft}`}>
      {lifecycleLabel(lifecycle, loc)}
    </span>
  );
}

function StatusChip({ status }: { status: string }) {
  const { loc } = useLanguage();
  const map: Record<string, string> = {
    pending: 'bg-amber-500/10 text-amber-400 border-amber-500/20',
    confirmed: 'bg-blue-500/10 text-blue-300 border-blue-500/20',
    processing: 'bg-blue-500/10 text-blue-300 border-blue-500/20',
    shipped: 'bg-purple-500/10 text-purple-300 border-purple-500/20',
    delivered: 'bg-emerald-500/10 text-emerald-400 border-emerald-500/20',
    cancelled: 'bg-red-500/10 text-red-300 border-red-500/20',
  };
  return (
    <span className={`text-[10px] font-bold px-2 py-0.5 rounded-full border shrink-0 ${map[status] ?? map.pending}`}>
      {statusLabel(status, loc)}
    </span>
  );
}

type Loc = (ar: string, en: string, ckb?: string) => string;

function lifecycleLabel(k: string, loc: Loc): string {
  switch (k) {
    case 'active': return loc('منشور', 'Live', 'بڵاوکراوە');
    case 'draft': return loc('مسودة', 'Draft', 'ڕەشنووس');
    case 'hidden': return loc('مخفي', 'Hidden', 'شاراوە');
    case 'sold_out': return loc('نفد', 'Sold out', 'تەواو بوو');
    case 'archived': return loc('مؤرشف', 'Archived', 'ئەرشیڤ');
    default: return k;
  }
}

function statusLabel(k: string, loc: Loc): string {
  switch (k) {
    case 'pending': return loc('جديد', 'New', 'نوێ');
    case 'confirmed': return loc('مؤكد', 'Confirmed', 'پشتڕاستکراو');
    case 'processing': return loc('قيد التجهيز', 'Preparing', 'ئامادەکردن');
    case 'shipped': return loc('تم الشحن', 'Shipped', 'نێردرا');
    case 'delivered': return loc('تم التسليم', 'Delivered', 'گەیشت');
    case 'cancelled': return loc('ملغي', 'Cancelled', 'هەڵوەشێنراوە');
    default: return k;
  }
}

function ledgerLabel(k: string, loc: Loc): string {
  switch (k) {
    case 'sale_credit': return loc('بيع من المتجر', 'Store sale', 'فرۆشتن');
    case 'community_order_credit': return loc('طلب مخصص', 'Custom order', 'داواکاری تایبەت');
    case 'commission': return loc('عمولة المنصة', 'Platform commission', 'کۆمیشن');
    case 'refund_debit': return loc('استرجاع', 'Refund', 'گەڕاندنەوە');
    case 'payout': return loc('تحويل لك', 'Paid out to you', 'دراوە بە تۆ');
    case 'reversal': return loc('عكس عملية', 'Reversal', 'پووچەڵکردنەوە');
    default: return loc('تعديل', 'Adjustment', 'گۆڕانکاری');
  }
}
