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
 * quietly vanishing (§48, §84).
 *
 * THE STORE BUILDER. This panel is where «التاجر يبني متجره بنفسه»: identity
 * (logo, banner, colour, words), the shelves (sections), the services a
 * workshop sells, the showcase (printers, materials, works), coupons, both
 * order books (store products AND funded custom orders), earnings, customers
 * and reviews. Every tab is a working screen backed by its own API — nothing
 * is decorative.
 */

import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { motion } from 'motion/react';
import {
  Store, Package, ShoppingBag, Star, Users, BarChart3, Settings as SettingsIcon,
  Bell, Wallet, Loader2, Plus, Pencil, Copy, Trash2, ExternalLink,
  Check, ArrowRight, LayoutGrid, Hammer, Images, Tag, ClipboardList, MessageCircle,
} from 'lucide-react';
import { useLanguage } from '../LanguageContext';
import { ApiError } from '../lib/api';
import { merchantApi, iqd, type MerchantMe, type MerchantProduct, type StoreSection } from '../lib/merchant';
import { ImageGallery } from '../components/media/ImagePicker';
import {
  Btn, Card, Chip, Empty, Input, Notice, Spinner, Stat, TextArea, Toggle, useMainSiteHref,
} from '../components/merchant/dashboard/ui';
import { SectionsTab, ServicesTab, ShowcaseTab } from '../components/merchant/dashboard/CatalogTabs';
import { OrdersTab, CustomOrdersTab, CouponsTab } from '../components/merchant/dashboard/SalesTabs';
import { StoreSettingsTab } from '../components/merchant/dashboard/StoreSettingsTab';

type Tab =
  | 'overview' | 'products' | 'sections' | 'services' | 'showcase'
  | 'orders' | 'custom' | 'coupons'
  | 'reviews' | 'customers' | 'money' | 'settings' | 'notifications';

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
            className="inline-flex items-center gap-2 min-h-[44px] px-6 rounded-2xl bg-olive text-white font-bold text-[13.5px] mt-4"
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
  const open = store.status === 'active';

  const TABS: Array<{ id: Tab; label: string; icon: React.ReactNode; group?: boolean }> = [
    { id: 'overview', label: loc('نظرة عامة', 'Overview', 'گشتی'), icon: <BarChart3 className="w-3.5 h-3.5" /> },
    { id: 'products', label: loc('المنتجات', 'Products', 'بەرهەم'), icon: <Package className="w-3.5 h-3.5" />, group: true },
    { id: 'sections', label: loc('الأقسام', 'Sections', 'بەشەکان'), icon: <LayoutGrid className="w-3.5 h-3.5" /> },
    { id: 'services', label: loc('الخدمات', 'Services', 'خزمەتگوزاری'), icon: <Hammer className="w-3.5 h-3.5" /> },
    { id: 'showcase', label: loc('المعرض', 'Showcase', 'پیشانگا'), icon: <Images className="w-3.5 h-3.5" /> },
    { id: 'orders', label: loc('الطلبات', 'Orders', 'داواکاری'), icon: <ShoppingBag className="w-3.5 h-3.5" />, group: true },
    { id: 'custom', label: loc('طلبات مخصصة', 'Custom orders', 'داواکاری تایبەت'), icon: <ClipboardList className="w-3.5 h-3.5" /> },
    { id: 'coupons', label: loc('الكوبونات', 'Coupons', 'کۆبۆن'), icon: <Tag className="w-3.5 h-3.5" /> },
    { id: 'reviews', label: loc('التقييمات', 'Reviews', 'هەڵسەنگاندن'), icon: <Star className="w-3.5 h-3.5" />, group: true },
    { id: 'customers', label: loc('العملاء', 'Customers', 'کڕیاران'), icon: <Users className="w-3.5 h-3.5" /> },
    { id: 'money', label: loc('الأرباح', 'Earnings', 'قازانج'), icon: <Wallet className="w-3.5 h-3.5" /> },
    { id: 'settings', label: loc('إعداد المتجر', 'Store setup', 'ڕێکخستنی فرۆشگا'), icon: <SettingsIcon className="w-3.5 h-3.5" />, group: true },
    { id: 'notifications', label: loc('الإشعارات', 'Notifications', 'ئاگادارکردنەوە'), icon: <Bell className="w-3.5 h-3.5" /> },
  ];

  return (
    <div className="min-h-screen bg-[#0a0a0a] text-zinc-300 pb-28">
      <div className="fixed top-0 left-1/2 -translate-x-1/2 w-full max-w-2xl h-[360px] bg-olive/15 rounded-full blur-[120px] pointer-events-none z-0" />

      <div className="relative z-10 max-w-3xl mx-auto px-4 sm:px-6 pt-4">
        <div className="flex items-center gap-2.5 mb-3">
          <div className="w-11 h-11 rounded-2xl bg-olive/30 border border-gold/20 overflow-hidden flex items-center justify-center shrink-0">
            {store.logoUrl ? (
              <img src={store.logoUrl} alt="" className="w-full h-full object-cover" />
            ) : (
              <Store className="w-5 h-5 text-gold" />
            )}
          </div>
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2">
              <h1 className="text-white font-bold text-[15px] truncate">{store.name}</h1>
              <span
                className={`text-[9.5px] font-bold px-1.5 py-0.5 rounded-full border shrink-0 ${
                  open
                    ? 'bg-emerald-500/10 text-emerald-400 border-emerald-500/20'
                    : 'bg-amber-500/10 text-amber-400 border-amber-500/20'
                }`}
              >
                {open ? loc('مفتوح', 'Open', 'کراوە') : loc('متوقّف', 'Paused', 'ڕاگیراوە')}
              </span>
            </div>
            <a
              href={store.url}
              target="_blank"
              rel="noopener noreferrer"
              className="text-gold/80 text-[11px] flex items-center gap-1 truncate"
              dir="ltr"
            >
              <span className="truncate">{store.url.replace(/^https?:\/\//, '')}</span>
              <ExternalLink className="w-3 h-3 shrink-0" />
            </a>
          </div>
          <a
            href={store.url}
            target="_blank"
            rel="noopener noreferrer"
            className="h-9 px-3 rounded-xl border border-white/10 bg-white/[0.03] text-zinc-300 text-[11.5px] font-bold inline-flex items-center gap-1.5 shrink-0"
          >
            <Store className="w-3.5 h-3.5" />
            {loc('عرض المتجر', 'View store', 'بینینی فرۆشگا')}
          </a>
        </div>

        {/* Why selling is off, in words. Never a silently missing button. */}
        {!canSell && (
          <div className="mb-3">
            <Notice
              text={loc(
                'البيع متوقّف حاليًا، لكن كل بياناتك وطلباتك وأرباحك محفوظة ويمكنك متابعتها.',
                'Selling is paused, but all your data, orders and earnings are kept and still visible.',
                'فرۆشتن ڕاگیراوە، بەڵام هەموو داتاکانت پارێزراون.'
              )}
            />
          </div>
        )}

        <div className="flex gap-1.5 overflow-x-auto hide-scrollbar -mx-4 px-4 mb-4 pb-1 items-center">
          {TABS.map((tb) => (
            <span key={tb.id} className="shrink-0 flex items-center gap-1.5">
              {tb.group && <span className="w-px h-5 bg-white/10" aria-hidden="true" />}
              <button
                onClick={() => setTab(tb.id)}
                className={`flex items-center gap-1.5 px-3 h-9 rounded-xl text-[12px] font-semibold border transition-colors ${
                  tab === tb.id
                    ? 'bg-olive text-white border-olive'
                    : 'bg-white/[0.03] text-zinc-400 border-white/10'
                }`}
              >
                {tb.icon}
                {tb.label}
              </button>
            </span>
          ))}
        </div>

        <motion.div key={tab} initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.25 }}>
          {tab === 'overview' && <OverviewTab canSell={canSell} go={setTab} />}
          {tab === 'products' && <ProductsTab canSell={canSell} />}
          {tab === 'sections' && <SectionsTab canSell={canSell} />}
          {tab === 'services' && <ServicesTab canSell={canSell} />}
          {tab === 'showcase' && <ShowcaseTab />}
          {tab === 'orders' && <OrdersTab />}
          {tab === 'custom' && <CustomOrdersTab />}
          {tab === 'coupons' && <CouponsTab canSell={canSell} />}
          {tab === 'reviews' && <ReviewsTab />}
          {tab === 'customers' && <CustomersTab />}
          {tab === 'money' && <MoneyTab />}
          {tab === 'settings' && <StoreSettingsTab me={me} onSaved={reload} />}
          {tab === 'notifications' && <NotificationsTab />}
        </motion.div>
      </div>
    </div>
  );
}

// -------------------------------------------------------------- overview

function OverviewTab({ canSell, go }: { canSell: boolean; go: (t: Tab) => void }) {
  const { loc } = useLanguage();
  const mainHref = useMainSiteHref();
  const [data, setData] = useState<Record<string, unknown> | null>(null);
  const [custom, setCustom] = useState<{ to_start: number; in_progress: number; awaiting_customer: number } | null>(null);
  const [error, setError] = useState('');

  useEffect(() => {
    merchantApi
      .analytics()
      .then(setData)
      .catch((e) => setError(e instanceof ApiError ? e.message : 'error'));
    merchantApi.customOrdersSummary().then(setCustom).catch(() => {});
  }, []);

  if (error) return <Notice text={error} />;
  if (!data) return <Spinner />;

  const orders = data.orders as Record<string, number | null>;
  const products = data.products as Record<string, number>;
  const offers = data.offers as Record<string, number | null>;
  const actionable = (custom?.to_start ?? 0) + (custom?.in_progress ?? 0);

  return (
    <div className="space-y-3">
      <div className="grid grid-cols-2 gap-2">
        <Stat label={loc('إجمالي المبيعات', 'Gross sales', 'کۆی فرۆشتن')} value={iqd(orders.gross_iqd)} />
        <Stat label={loc('صافي أرباحك', 'Your earnings', 'قازانجی تۆ')} value={iqd(orders.receivable_iqd)} accent />
        <Stat label={loc('الطلبات', 'Orders', 'داواکاری')} value={String(orders.total ?? 0)} />
        <Stat
          label={loc('متوسط الطلب', 'Average order', 'ناوەندی داواکاری')}
          // null means "no orders yet", which is a different answer from 0.
          value={orders.average_order_iqd === null ? loc('لا بيانات', 'No data', 'داتا نییە') : iqd(orders.average_order_iqd)}
        />
      </div>

      <div className="grid grid-cols-3 gap-2">
        <Stat label={loc('منتجات', 'Products', 'بەرهەم')} value={`${products.active ?? 0}/${products.total ?? 0}`} small />
        <Stat label={loc('متابعون', 'Followers', 'شوێنکەوتوو')} value={String(data.followers ?? 0)} small />
        <Stat label={loc('مشاهدات', 'Views', 'بینین')} value={String(products.views ?? 0)} small />
      </div>

      {/* The work waiting for the merchant, one tap from doing it. */}
      {custom && actionable + custom.awaiting_customer > 0 && (
        <button onClick={() => go('custom')} className="w-full text-start">
          <Card title={loc('طلبات مخصصة بانتظارك', 'Custom orders waiting', 'داواکاری تایبەت چاوەڕوانتە')}>
            <div className="flex items-center gap-3 text-[12px]">
              {custom.to_start > 0 && (
                <span className="text-amber-400 font-bold">
                  {custom.to_start} {loc('للبدء', 'to start', 'بۆ دەستپێک')}
                </span>
              )}
              {custom.in_progress > 0 && (
                <span className="text-blue-300 font-bold">
                  {custom.in_progress} {loc('قيد التنفيذ', 'in progress', 'جێبەجێ دەکرێت')}
                </span>
              )}
              {custom.awaiting_customer > 0 && (
                <span className="text-zinc-400">
                  {custom.awaiting_customer} {loc('بانتظار الزبون', 'awaiting customer', 'چاوەڕوانی کڕیار')}
                </span>
              )}
              <ArrowRight className="w-3.5 h-3.5 text-gold ms-auto rtl:rotate-180" />
            </div>
          </Card>
        </button>
      )}

      {Number(offers.sent ?? 0) > 0 && (
        <Card title={loc('عروضك على الطلبات', 'Your offers on requests', 'ئۆفەرەکانت')}>
          <div className="flex items-center justify-between text-[12.5px]">
            <span className="text-zinc-400">
              {loc('مقبولة', 'Accepted', 'پەسەندکراو')}: <span className="text-white font-bold">{offers.accepted ?? 0}</span>
              <span className="text-zinc-600"> / {offers.sent}</span>
            </span>
            {offers.win_rate !== null && <span className="text-gold font-bold">{offers.win_rate}%</span>}
          </div>
        </Card>
      )}

      {canSell && (
        <Card title={loc('إجراءات سريعة', 'Quick actions', 'کردارە خێراکان')}>
          <div className="grid grid-cols-2 gap-2">
            <Btn kind="ghost" onClick={() => go('products')} full>
              <Plus className="w-3.5 h-3.5" />
              {loc('منتج جديد', 'New product', 'بەرهەمی نوێ')}
            </Btn>
            <Btn kind="ghost" onClick={() => go('services')} full>
              <Hammer className="w-3.5 h-3.5" />
              {loc('خدماتك', 'Your services', 'خزمەتگوزاریەکانت')}
            </Btn>
            <a
              href={mainHref('/requests')}
              className="h-9 rounded-xl border border-white/10 bg-white/[0.03] flex items-center justify-center gap-1.5 text-[12.5px] font-bold text-zinc-300"
            >
              <ClipboardList className="w-3.5 h-3.5" />
              {loc('طلبات الزبائن', 'Customer requests', 'داواکاری کڕیاران')}
            </a>
            <a
              href={mainHref('/chats')}
              className="h-9 rounded-xl border border-white/10 bg-white/[0.03] flex items-center justify-center gap-1.5 text-[12.5px] font-bold text-zinc-300"
            >
              <MessageCircle className="w-3.5 h-3.5" />
              {loc('الرسائل', 'Messages', 'نامەکان')}
            </a>
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
  sku: '',
  condition: 'new',
  prep_days: 0,
  images: [] as string[],
  lifecycle: 'active',
  section_id: null as string | null,
  featured: false,
};

function ProductsTab({ canSell }: { canSell: boolean }) {
  const { loc } = useLanguage();
  const [items, setItems] = useState<MerchantProduct[] | null>(null);
  const [sections, setSections] = useState<StoreSection[]>([]);
  const [editing, setEditing] = useState<MerchantProduct | 'new' | null>(null);
  const [busy, setBusy] = useState('');

  const load = useCallback(() => {
    merchantApi.products().then((d) => setItems(d.products)).catch(() => setItems([]));
    merchantApi.sections().then((d) => setSections(d.sections)).catch(() => {});
  }, []);
  useEffect(load, [load]);

  async function remove(p: MerchantProduct) {
    if (!confirm(loc('حذف المنتج؟', 'Delete this product?', 'بسڕدرێتەوە؟'))) return;
    setBusy(p.id);
    try {
      const r = await merchantApi.deleteProduct(p.id);
      // Archived rather than deleted when it has been ordered — worth saying,
      // because disappearing from the shop but staying in history is
      // deliberate, not a bug.
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
        sections={sections}
        onDone={() => {
          setEditing(null);
          load();
        }}
        onCancel={() => setEditing(null)}
      />
    );
  }

  const sectionName = (id: string | null | undefined) =>
    id ? sections.find((s) => s.id === id)?.name ?? '' : '';

  return (
    <div className="space-y-3">
      {canSell ? (
        <Btn onClick={() => setEditing('new')} full>
          <Plus className="w-4 h-4" />
          {loc('منتج جديد', 'New product', 'بەرهەمی نوێ')}
        </Btn>
      ) : (
        <Notice
          text={loc(
            'لا يمكن نشر منتجات جديدة الآن. منتجاتك الحالية وسجلها محفوظة.',
            'New products cannot be published right now. Your existing products and their history are kept.',
            'ناتوانیت بەرهەمی نوێ بڵاو بکەیتەوە.'
          )}
        />
      )}

      {!items.length && <Empty text={loc('لا توجد منتجات بعد', 'No products yet', 'هێشتا بەرهەم نییە')} />}

      {items.map((p) => (
        <div key={p.id} className="rounded-2xl border border-white/10 bg-white/[0.03] p-3">
          <div className="flex gap-3">
            <div className="w-[52px] h-[52px] rounded-xl bg-black/40 overflow-hidden shrink-0">
              {p.images[0] && <img src={p.images[0]} alt="" className="w-full h-full object-cover" />}
            </div>
            <div className="min-w-0 flex-1">
              <p className="text-white text-[12.5px] font-semibold truncate">
                {p.featured && <Star className="w-3 h-3 text-gold fill-gold inline me-1 -mt-0.5" />}
                {p.name}
              </p>
              <p className="text-gold text-[12px] font-bold" dir="ltr">{iqd(p.price_iqd)}</p>
              <div className="flex items-center gap-2 mt-0.5 flex-wrap">
                <LifecycleChip lifecycle={p.lifecycle ?? 'active'} />
                {sectionName(p.section_id) && (
                  <span className="text-zinc-500 text-[10.5px]" dir="ltr">{sectionName(p.section_id)}</span>
                )}
                {p.track_stock && (
                  <span className="text-zinc-500 text-[10.5px]">
                    {loc('المخزون', 'Stock', 'کۆگا')}: {p.stock}
                  </span>
                )}
                {!!p.sold_count && (
                  <span className="text-zinc-500 text-[10.5px]">
                    {loc('مبيعات', 'Sold', 'فرۆشراو')}: {p.sold_count}
                  </span>
                )}
              </div>
            </div>
          </div>

          <div className="flex gap-2 mt-2.5">
            <Btn kind="ghost" small onClick={() => setEditing(p)} disabled={!canSell} full>
              <Pencil className="w-3 h-3" />
              {loc('تعديل', 'Edit', 'دەستکاری')}
            </Btn>
            <Btn
              kind="ghost"
              small
              full
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
            >
              <Copy className="w-3 h-3" />
              {loc('نسخ', 'Duplicate', 'لەبەرگرتنەوە')}
            </Btn>
            <Btn kind="danger" small full disabled={busy === p.id} onClick={() => remove(p)}>
              <Trash2 className="w-3 h-3" />
              {loc('حذف', 'Delete', 'سڕینەوە')}
            </Btn>
          </div>
        </div>
      ))}
    </div>
  );
}

function ProductEditor({
  product,
  sections,
  onDone,
  onCancel,
}: {
  product: MerchantProduct | null;
  sections: StoreSection[];
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
          sku: product.sku ?? '',
          condition: product.condition ?? 'new',
          prep_days: product.prep_days,
          images: product.images,
          lifecycle: product.lifecycle ?? 'active',
          section_id: product.section_id ?? null,
          featured: product.featured ?? false,
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
    <div className="rounded-2xl border border-white/10 bg-white/[0.03] p-3.5 space-y-3.5">
      <h3 className="text-gold font-bold text-[13px]">
        {product ? loc('تعديل المنتج', 'Edit product', 'دەستکاری بەرهەم') : loc('منتج جديد', 'New product', 'بەرهەمی نوێ')}
      </h3>

      <Input label={loc('الاسم', 'Name', 'ناو')} value={f.name} onChange={(v) => setF({ ...f, name: v })} />

      <div className="grid grid-cols-2 gap-2">
        <Input
          label={loc('السعر (د.ع)', 'Price (IQD)', 'نرخ')}
          value={String(f.price_iqd)}
          type="number"
          ltr
          onChange={(v) => setF({ ...f, price_iqd: Number(v) || 0 })}
        />
        <Input
          label={loc('السعر قبل الخصم', 'Original price', 'نرخی پێشوو')}
          value={f.original_price_iqd === null ? '' : String(f.original_price_iqd)}
          type="number"
          ltr
          onChange={(v) => setF({ ...f, original_price_iqd: v === '' ? null : Number(v) || 0 })}
          hint={loc('يظهر مشطوبًا كخصم', 'Shown struck-through as a deal', 'وەک داشکاندن')}
        />
      </div>

      <div className="grid grid-cols-3 gap-2">
        <Input
          label={loc('المخزون', 'Stock', 'کۆگا')}
          value={String(f.stock)}
          type="number"
          ltr
          onChange={(v) => setF({ ...f, stock: Number(v) || 0 })}
        />
        <Input
          label={loc('أيام التحضير', 'Prep days', 'ڕۆژی ئامادەکردن')}
          value={String(f.prep_days)}
          type="number"
          ltr
          onChange={(v) => setF({ ...f, prep_days: Number(v) || 0 })}
        />
        <Input label="SKU" value={f.sku} onChange={(v) => setF({ ...f, sku: v })} ltr />
      </div>

      {sections.length > 0 && (
        <div>
          <label className="block text-zinc-400 text-[12px] font-semibold mb-1.5">
            {loc('القسم في متجرك', 'Section in your shop', 'بەش')}
          </label>
          <select
            value={f.section_id ?? ''}
            onChange={(e) => setF({ ...f, section_id: e.target.value || null })}
            className="w-full h-10 rounded-xl bg-black/40 border border-white/10 px-3 text-white text-[13px] outline-none focus:border-gold/40"
          >
            <option value="">{loc('بدون قسم', 'No section', 'بێ بەش')}</option>
            {sections.map((s) => (
              <option key={s.id} value={s.id}>{s.name}{s.name_ar ? ` — ${s.name_ar}` : ''}</option>
            ))}
          </select>
        </div>
      )}

      <div className="grid grid-cols-2 gap-2">
        <Input label={loc('الفئة', 'Category', 'پۆل')} value={f.category} onChange={(v) => setF({ ...f, category: v })} />
        <div>
          <label className="block text-zinc-400 text-[12px] font-semibold mb-1.5">{loc('الحالة', 'Condition', 'دۆخ')}</label>
          <div className="flex gap-1.5">
            {(['new', 'used', 'refurbished'] as const).map((k) => (
              <Chip
                key={k}
                label={k === 'new' ? loc('جديد', 'New', 'نوێ') : k === 'used' ? loc('مستعمل', 'Used', 'بەکارهاتوو') : loc('مجدّد', 'Refurb', 'نوێکراوە')}
                active={f.condition === k}
                onClick={() => setF({ ...f, condition: k })}
              />
            ))}
          </div>
        </div>
      </div>

      <Toggle
        label={loc('منتج مميّز — يتصدّر واجهة متجرك', 'Featured — pinned to the top of your shop', 'بەرهەمی تایبەت')}
        on={f.featured}
        onChange={(v) => setF({ ...f, featured: v })}
      />

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

      <TextArea
        label={loc('الوصف', 'Description', 'وەسف')}
        value={f.description}
        onChange={(v) => setF({ ...f, description: v })}
        rows={4}
      />

      <div>
        <label className="block text-zinc-400 text-[12px] font-semibold mb-1.5">
          {loc('حالة النشر', 'Publish status', 'دۆخی بڵاوکردنەوە')}
        </label>
        <div className="flex gap-1.5 flex-wrap">
          {(['active', 'draft', 'hidden', 'sold_out'] as const).map((k) => (
            <Chip key={k} label={lifecycleLabel(k, loc)} active={f.lifecycle === k} onClick={() => setF({ ...f, lifecycle: k })} />
          ))}
        </div>
      </div>

      {error && <p className="text-red-400 text-[12px]">{error}</p>}

      <div className="flex gap-2">
        <Btn onClick={save} disabled={saving || f.name.trim().length < 2} full>
          {saving ? <Loader2 className="w-4 h-4 animate-spin" /> : <Check className="w-4 h-4" />}
          {loc('حفظ', 'Save', 'پاشەکەوت')}
        </Btn>
        <Btn kind="ghost" onClick={onCancel}>
          {loc('إلغاء', 'Cancel', 'هەڵوەشاندنەوە')}
        </Btn>
      </div>
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
          <div key={id} className="rounded-2xl border border-white/10 bg-white/[0.03] p-3">
            <div className="flex items-center justify-between mb-1">
              <span className="text-white text-[12.5px] font-semibold">{String(r.customer_name)}</span>
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
                  <Btn
                    small
                    onClick={async () => {
                      if (!text.trim()) return;
                      await merchantApi.replyReview(id, text.trim());
                      setReplying('');
                      setText('');
                      load();
                    }}
                  >
                    {loc('إرسال', 'Send', 'ناردن')}
                  </Btn>
                  <Btn small kind="ghost" onClick={() => setReplying('')}>
                    {loc('إلغاء', 'Cancel', 'هەڵوەشاندنەوە')}
                  </Btn>
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
        <div key={String(c.id)} className="rounded-2xl border border-white/10 bg-white/[0.03] px-3 py-2.5 flex items-center justify-between gap-3">
          <div className="min-w-0">
            <p className="text-white text-[12.5px] font-semibold truncate">{String(c.name)}</p>
            <p className="text-zinc-500 text-[11px]">
              {loc(`${c.order_count} طلب`, `${c.order_count} orders`, `${c.order_count} داواکاری`)}
            </p>
          </div>
          <span className="text-gold text-[12px] font-bold shrink-0" dir="ltr">{iqd(Number(c.lifetime_iqd))}</span>
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
    <div className="space-y-3">
      <div className="grid grid-cols-3 gap-2">
        <Stat label={loc('متاح', 'Available', 'بەردەست')} value={iqd(data.balance.available_iqd)} accent small />
        <Stat label={loc('قيد الانتظار', 'Pending', 'چاوەڕوان')} value={iqd(data.balance.pending_iqd)} small />
        <Stat label={loc('مدفوع', 'Paid out', 'دراوە')} value={iqd(Math.abs(data.balance.paid_iqd))} small />
      </div>

      <Card title={loc('سجل الحركات', 'Ledger', 'تۆمار')}>
        {/* Every row that makes up the balance. The balance is a sum over
            exactly these, so a merchant can add them up and get the same
            number — which is the point of not storing a balance. */}
        {!data.entries.length ? (
          <p className="text-zinc-500 text-[12px]">{loc('لا توجد حركات', 'No entries yet', 'هیچ تۆمارێک نییە')}</p>
        ) : (
          <div className="space-y-2">
            {data.entries.map((e) => (
              <div key={String(e.id)} className="flex items-center justify-between gap-3 text-[12px]">
                <div className="min-w-0">
                  <p className="text-zinc-300 truncate">{ledgerLabel(String(e.kind), loc)}</p>
                  <p className="text-zinc-600 text-[10.5px] truncate" dir="ltr">
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
      <div className="space-y-2.5">
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
                <p className="text-zinc-600 text-[10.5px] mt-0.5">
                  {loc(
                    'لا يمكن إيقافه — يخص أموالك أو حسابك.',
                    'Cannot be turned off — it concerns your money or your account.',
                    'ناتوانرێت بکوژێنرێتەوە.'
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
