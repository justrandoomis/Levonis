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

import { lazy, Suspense, useCallback, useEffect, useState } from 'react';
import { Link, useLocation } from 'react-router-dom';
import { motion } from 'motion/react';
import {
  Store, Package, ShoppingBag, Star, Users, BarChart3, Settings as SettingsIcon,
  Bell, Wallet, Loader2, Plus, ExternalLink,
  ArrowRight, LayoutGrid, Hammer, Images, Tag, ClipboardList, MessageCircle, Printer, Calculator, Palette,
} from 'lucide-react';
import { useLanguage } from '../LanguageContext';
import { ApiError } from '../lib/api';
import { merchantApi, iqd, type MerchantMe } from '../lib/merchant';
import { useCommunityAccess } from './community/access';
import { useStore } from '../StoreContext';
import {
  Btn, Card, Empty, Notice, Spinner, Stat, Toggle, useMainSiteHref,
} from '../components/merchant/dashboard/ui';
import { SectionsTab, ServicesTab, ShowcaseTab } from '../components/merchant/dashboard/CatalogTabs';
import { ProductsManager } from '../components/merchant/dashboard/ProductsManager';
import { OrdersTab, CustomOrdersTab, CouponsTab } from '../components/merchant/dashboard/SalesTabs';
import { StoreSettingsTab } from '../components/merchant/dashboard/StoreSettingsTab';
import { PrintersTab } from '../components/merchant/dashboard/PrintersTab';
import { CostingTab } from '../components/merchant/dashboard/CostingTab';
// The shared toast stack (src/components/ui/Toast.tsx), mounted once for the workspace.
import { Toaster } from '../components/ui/Toast';
// The store page's theme, preview, publish and history (merchant platform
// W2-C) — its own chunk, fetched when the tab is opened.
const StoreDesignPanel = lazy(() => import('../components/merchant/storeDesign/StoreDesignPanel'));

type Tab =
  | 'overview' | 'products' | 'sections' | 'services' | 'showcase'
  | 'orders' | 'custom' | 'coupons'
  | 'reviews' | 'customers' | 'money' | 'settings' | 'design' | 'notifications' | 'printers' | 'costing';

/**
 * Is this page being shown on the viewer's OWN store host (or on the main
 * site)? `/admin` on a store's subdomain is that store's dashboard; opened on
 * somebody else's shop it used to show the VIEWER's own store under the other
 * shop's address (audit 01 B16). Nothing leaked — every call is scoped to the
 * session — but a dashboard that is not the host's is the wrong page there.
 */
function onOwnHost(
  own: { id: string; url: string },
  host: { storeId: string | null; storeHost: boolean }
): boolean {
  if (!host.storeHost) return true;
  if (host.storeId) return host.storeId === own.id;
  // The host resolved to no servable store (a suspended one): compare the
  // address the SERVER gave the viewer's own store with the one in the bar.
  try {
    return new URL(own.url).host === window.location.host;
  } catch {
    return false;
  }
}

export default function MerchantDashboardPage() {
  const { loc } = useLanguage();
  const { store: hostStore, unknownStore: hostUnknown, unavailableStore: hostUnavailable } = useStore();
  const [me, setMe] = useState<MerchantMe | null>(null);
  const [loading, setLoading] = useState(true);
  /**
   * A BRAND-NEW STORE LANDS ON ITS PRINTERS, NOT ON AN EMPTY OVERVIEW.
   *
   * Onboarding is deliberately one short step and says so, so the printer and
   * notification preferences do not belong inside it. But they are what decides
   * whether Levonis can ever match a print request to this shop — a merchant
   * with no printer here is invisible to the matcher forever. Handing them
   * straight to that screen is the honest continuation of the sign-up, and
   * `MerchantStart` already sends the `created` flag that says this is the
   * first time anyone has seen this dashboard.
   */
  const created = !!(useLocation().state as { created?: string } | null)?.created;
  const [tab, setTab] = useState<Tab>(created ? 'printers' : 'overview');

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

  if (!onOwnHost(me.store, { storeId: hostStore?.id ?? null, storeHost: !!hostStore || hostUnknown || hostUnavailable })) {
    const ownAdmin = /^https?:\/\//.test(me.store.url) ? `${me.store.url}/admin` : '/merchant';
    return (
      <div className="min-h-screen bg-[#0a0a0a] flex items-center justify-center px-6" data-not-your-store>
        <div className="text-center max-w-sm">
          <Store className="w-10 h-10 text-zinc-600 mx-auto mb-4" aria-hidden="true" />
          <h1 className="text-white font-bold text-[17px] mb-2 [text-wrap:balance]">
            {loc('هذه لوحة إدارة متجر آخر', 'This is another store\'s dashboard')}
            {/* OWNER: Sorani to be written by hand. */}
          </h1>
          <p className="text-zinc-500 text-[13px] leading-relaxed">
            {loc('لوحة متجرك على عنوان متجرك.', 'Your store\'s dashboard is on your store\'s own address.')}
            {/* OWNER: Sorani to be written by hand. */}
          </p>
          <a href={ownAdmin} className="lv-button lv-button-primary mt-6 w-full">
            {loc('افتح لوحة متجري', 'Open my store dashboard')}
            {/* OWNER: Sorani to be written by hand. */}
          </a>
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
    // OWNER: Sorani to be written by hand.
    { id: 'design', label: loc('تصميم المتجر', 'Store design'), icon: <Palette className="w-3.5 h-3.5" /> },
    /* The printers are what Levonis matches a print request against, so they
       belong beside the store setup rather than in the catalogue: a shop with
       no printer here is a shop the matcher can never notify. */
    { id: 'printers', label: loc('الطابعات', 'Printers', 'چاپکەرەکان'), icon: <Printer className="w-3.5 h-3.5" /> },
    /* Beside the printers, because the answer it gives is WHICH printer: it
       prices one model on every machine the shop owns, with the breakdown a
       customer must never see (§22). */
    { id: 'costing', label: loc('تسعير الطباعة', 'Print costing', 'نرخی چاپ'), icon: <Calculator className="w-3.5 h-3.5" /> },
    { id: 'notifications', label: loc('الإشعارات', 'Notifications', 'ئاگادارکردنەوە'), icon: <Bell className="w-3.5 h-3.5" /> },
  ];

  return (
    <div className="min-h-screen bg-[#0a0a0a] text-zinc-300 pb-28">
      <Toaster />
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

        {/* A RESTRICTION IS NOT A PAUSE (audit 03 V, audit 04 #23). The store
            stays up and editable, so nothing on this screen is disabled — but
            it takes no new orders and the merchant makes no offers until
            Levonis lifts it. Said here, in words, rather than discovered as
            orders that stopped arriving. Anything but `active` reads this way,
            like the server's allow-list. */}
        {canSell && store.merchant.status && store.merchant.status !== 'active' && (
          <div className="mb-3">
            <Notice
              text={loc(
                'قيّدت Levonis حسابك: متجرك ظاهر ويمكنك تعديله، لكنه لا يستقبل طلبات جديدة ولا يمكنك تقديم عروض حتى يُرفع التقييد. طلباتك الحالية وأرباحك كما هي — تواصل مع الدعم.',
                'Levonis has restricted your account: your store stays visible and editable, but it takes no new orders and you cannot make offers until the restriction is lifted. Your current orders and earnings are unaffected — contact support.'
              )}
            />
            {/* OWNER: Sorani to be written by hand. */}
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
          {tab === 'products' && <ProductsManager canSell={canSell} store={store} />}
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
          {tab === 'design' && (
            <Suspense fallback={<Spinner />}>
              <StoreDesignPanel />
            </Suspense>
          )}
          {tab === 'notifications' && <NotificationsTab />}
          {tab === 'printers' && <PrintersTab canSell={canSell} />}
          {tab === 'costing' && <CostingTab />}
        </motion.div>
      </div>
    </div>
  );
}

// -------------------------------------------------------------- overview

function OverviewTab({ canSell, go }: { canSell: boolean; go: (t: Tab) => void }) {
  const { loc } = useLanguage();
  const mainHref = useMainSiteHref();
  // The request board is Levo Community (DECISIONS 110): while it is shut to
  // this merchant the link would land on the maintenance card, so it hides.
  const { access: communityAccess } = useCommunityAccess();
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
      {/* What the four figures count, said once (audit 04 #12): a cancelled
          store order is refunded in full, so it is not a sale, an earning or
          part of the average — and the count of them is shown, not hidden. */}
      <p className="text-zinc-500 text-[11px] leading-relaxed px-0.5" data-analytics-basis>
        {loc(
          'المبيعات والأرباح والمتوسط من الطلبات غير الملغاة فقط.',
          'Sales, earnings and the average count only orders that were not cancelled.'
        ) /* OWNER: Sorani to be written by hand. */}
        {Number(orders.cancelled ?? 0) > 0 && (
          <>
            {' '}
            <span className="tabular-nums">
              {loc(`(${orders.cancelled} ملغاة لم تُحتسب)`, `(${orders.cancelled} cancelled, not counted)`)}
            </span>
          </>
        )}
      </p>
      {Number((data.custom_orders as Record<string, number> | undefined)?.completed ?? 0) > 0 && (
        <Stat
          label={loc('طلبات مخصصة مكتملة — صافيها', 'Completed custom orders — your share')}
          value={`${(data.custom_orders as Record<string, number>).completed} · ${iqd((data.custom_orders as Record<string, number>).receivable_iqd)}`}
          small
        />
      )}

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
            {communityAccess?.may_enter !== false && (
              <a
                href={mainHref('/requests')}
                className="h-9 rounded-xl border border-white/10 bg-white/[0.03] flex items-center justify-center gap-1.5 text-[12.5px] font-bold text-zinc-300"
              >
                <ClipboardList className="w-3.5 h-3.5" />
                {loc('طلبات الزبائن', 'Customer requests', 'داواکاری کڕیاران')}
              </a>
            )}
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
      {/* What the three figures mean, once (audit 02 B3/B20 and the owner's
          completion rule): a store sale waits for the customer, a payout
          leaves «available», and the platform's commission is never money
          that was paid to the merchant. */}
      <div className="rounded-2xl border border-white/10 bg-white/[0.03] px-3 py-2.5 space-y-1 text-[11px] leading-relaxed text-zinc-500">
        {/* OWNER: Sorani to be written by hand. */}
        <p>
          {loc(
            'قيد الانتظار: مبيعات تصبح متاحة حين يؤكد الزبون الاستلام، أو تلقائيًا بعد 3 أيام من التسليم ما لم تُفتح شكوى.',
            'Pending: sales that become available when the customer confirms receipt — or automatically 3 days after delivery unless a complaint is open.'
          )}
        </p>
        <p>
          {loc(
            'مدفوع: ما حُوِّل إليك فعلًا، ويُخصم من المتاح. عمولة المنصة لا تدخل فيه.',
            'Paid out: what was actually transferred to you; it comes off «Available». The platform commission is not part of it.'
          )}
        </p>
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
                  <p className="text-zinc-600 text-[10.5px] truncate">
                    {/* Which of the three figures this row sits in — or none. */}
                    <span data-ledger-state={String(e.state)}>{ledgerStateLabel(String(e.kind), String(e.state), loc)}</span>
                    {(e.order_id || e.community_order_id) && (
                      <>
                        {' · '}
                        <bdi dir="ltr">{String(e.order_id || e.community_order_id)}</bdi>
                      </>
                    )}
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
  // The switches a sender actually reads (audit 04 #19). Null from a server
  // that predates the field: every switch is drawn as before.
  const [wired, setWired] = useState<string[] | null>(null);
  const [saving, setSaving] = useState('');
  const [failed, setFailed] = useState('');

  useEffect(() => {
    merchantApi
      .notifications()
      .then((d) => {
        setPrefs(d.preferences);
        setForced(d.forced);
        setWired(d.wired ?? null);
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
          // «قريبًا», not a switch that controls nothing: nothing sends this
          // notification yet, so the control says so (DECISIONS: no fake UI).
          const soon = wired !== null && !wired.includes(k);
          return (
            <div key={k} data-notification-key={k} data-soon={soon || undefined}>
              <Toggle
                label={label}
                on={!soon && !!prefs[k]}
                disabled={soon || isForced || saving === k}
                onChange={async (v) => {
                  const before = !!prefs[k];
                  setSaving(k);
                  setFailed('');
                  setPrefs({ ...prefs, [k]: v });
                  try {
                    const d = await merchantApi.setNotifications({ [k]: v });
                    setPrefs(d.preferences);
                  } catch {
                    // The switch goes back to what is actually stored.
                    setPrefs((p) => (p ? { ...p, [k]: before } : p));
                    setFailed(k);
                  } finally {
                    setSaving('');
                  }
                }}
              />
              {soon ? (
                <p className="text-zinc-600 text-[10.5px] mt-0.5">
                  {loc('قريبًا — هذا الإشعار لم يُطلق بعد.', 'Coming soon — this notification is not live yet.')}
                  {/* OWNER: Sorani to be written by hand. */}
                </p>
              ) : isForced ? (
                /* Forced-on, with the reason. Better than a switch that
                   silently snaps back, and better than hiding it (§61). */
                <p className="text-zinc-600 text-[10.5px] mt-0.5">
                  {loc(
                    'لا يمكن إيقافه — يخص أموالك أو حسابك.',
                    'Cannot be turned off — it concerns your money or your account.',
                    'ناتوانرێت بکوژێنرێتەوە.'
                  )}
                </p>
              ) : null}
              {failed === k && (
                <p role="alert" className="text-red-300 text-[10.5px] mt-0.5">
                  {loc('تعذّر الحفظ — حاول مجددًا.', 'Could not save — try again.')}
                  {/* OWNER: Sorani to be written by hand. */}
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

type Loc = (ar: string, en: string, ckb?: string) => string;

/**
 * Where a ledger row counts. `available` is the sum of available rows AND
 * payouts; `pending` waits for the customer; `paid out` is payouts alone. A
 * commission row is the platform's share, already taken off the sale credit
 * beside it, and a reversed credit counts nowhere (worker/lib/escrowOps.ts).
 */
function ledgerStateLabel(kind: string, state: string, loc: Loc): string {
  if (kind === 'payout') return loc('مدفوع', 'Paid out', 'دراوە');
  // OWNER: Sorani to be written by hand (the new strings below).
  if (kind === 'commission') return loc('مخصومة من البيع', 'Taken off the sale');
  if (state === 'pending') return loc('قيد الانتظار', 'Pending', 'چاوەڕوان');
  if (state === 'available') return loc('متاح', 'Available', 'بەردەست');
  if (state === 'reversed') return loc('أُلغي — لا يُحتسب', 'Reversed — not counted');
  if (state === 'reserved') return loc('محجوز', 'Reserved');
  if (state === 'paid') return loc('مسدَّد', 'Settled');
  return '';
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
