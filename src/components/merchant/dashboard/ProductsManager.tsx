/**
 * إدارة المنتجات — the merchant's products management screen, matching the
 * owner's reference design: breadcrumb + title + actions, five tinted stat
 * cards with sparklines, a full filter bar, three view modes, a professional
 * table, and offset pagination with an exact total.
 *
 * EVERY NUMBER IS REAL. The stat feed and the sparkline series come from
 * /api/merchant/products/stats (weekly buckets over created_at — the only
 * per-product history that exists), search/filters/sort/pagination run
 * SERVER-SIDE through the extended list endpoint, import/export move real
 * CSV through real endpoints, and the insights modal sums actual order
 * lines. Nothing here is decorative: there is no invented "under review"
 * state and no fabricated month-over-month delta.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import {
  Plus, Search, Pencil, Copy, Trash2, BarChart3, MoreHorizontal, Star,
  Loader2, Check, X, Download, Upload, LayoutGrid, List, AlignJustify,
  SlidersHorizontal, ChevronRight, ChevronLeft, Eye, Package, PackageX,
  FileDown, RefreshCcw, Link2, EyeOff,
} from 'lucide-react';
import { useLanguage } from '../../../LanguageContext';
import { ApiError } from '../../../lib/api';
import {
  merchantApi,
  type MerchantProduct, type MerchantStore, type StoreSection,
  type ProductsStats, type ProductInsights, type ProductsImportReport,
} from '../../../lib/merchant';
import { ImageGallery } from '../../media/ImagePicker';
import { Btn, Chip, Empty, Input, Notice, Spinner, TextArea, Toggle, useMainSiteHref } from './ui';

type Loc = (ar: string, en: string, ckb?: string) => string;
type View = 'list' | 'grid' | 'compact';

const PAGE_SIZES = [10, 25, 50];
const PRICE_BANDS: Record<string, { min?: number; max?: number }> = {
  b1: { max: 25_000 },
  b2: { min: 25_000, max: 100_000 },
  b3: { min: 100_000, max: 500_000 },
  b4: { min: 500_000 },
};

/** «75,001 د.ع» — the reference writes the dinar after the western digits. */
function dinar(n: number): string {
  return `${Number(n).toLocaleString('en-US')} د.ع`;
}

function relTime(iso: string | undefined, loc: Loc): string {
  if (!iso) return '—';
  const ms = Date.now() - new Date(iso).getTime();
  const min = Math.floor(ms / 60_000);
  if (min < 1) return loc('الآن', 'now', 'ئێستا');
  if (min < 60) return loc(`منذ ${min} دقيقة`, `${min}m ago`, `${min} خولەک`);
  const h = Math.floor(min / 60);
  if (h < 24) return loc(`منذ ${h} ساعة`, `${h}h ago`, `${h} کاتژمێر`);
  const d = Math.floor(h / 24);
  if (d < 30) return loc(`منذ ${d} يوم`, `${d}d ago`, `${d} ڕۆژ`);
  const mo = Math.floor(d / 30);
  return loc(`منذ ${mo} شهر`, `${mo}mo ago`, `${mo} مانگ`);
}

function absDate(iso: string | undefined): string {
  if (!iso) return '';
  try {
    return new Date(iso).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' });
  } catch {
    return '';
  }
}

function firstColor(p: MerchantProduct): string {
  const c = (p.colors ?? [])[0] as unknown;
  if (typeof c === 'string') return c;
  if (c && typeof c === 'object') {
    const o = c as Record<string, unknown>;
    return String(o.name ?? o.name_ar ?? o.label ?? '');
  }
  return '';
}

// ------------------------------------------------------------- sparkline

/** A tiny real-data polyline. Fewer than two points draws a flat baseline —
 *  an honest "no history yet", never an invented curve. */
function Spark({ series, className }: { series: number[]; className: string }) {
  const pts = series.length >= 2 ? series : [0, 0];
  const max = Math.max(...pts, 1);
  const step = 100 / (pts.length - 1);
  const path = pts.map((v, i) => `${(i * step).toFixed(1)},${(26 - (v / max) * 22).toFixed(1)}`).join(' ');
  return (
    <svg viewBox="0 0 100 28" preserveAspectRatio="none" className={`w-full h-7 ${className}`} aria-hidden>
      <polyline points={path} fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinejoin="round" strokeLinecap="round" />
    </svg>
  );
}

const TINTS: Record<string, { box: string; icon: string; spark: string }> = {
  purple: { box: 'border-purple-500/20 bg-purple-500/[0.06]', icon: 'bg-purple-500/15 text-purple-300', spark: 'text-purple-400/80' },
  blue: { box: 'border-sky-500/20 bg-sky-500/[0.06]', icon: 'bg-sky-500/15 text-sky-300', spark: 'text-sky-400/80' },
  green: { box: 'border-emerald-500/25 bg-emerald-500/[0.08]', icon: 'bg-emerald-500/15 text-emerald-300', spark: 'text-emerald-400/80' },
  amber: { box: 'border-amber-500/25 bg-amber-500/[0.07]', icon: 'bg-amber-500/15 text-amber-300', spark: 'text-amber-400/80' },
  red: { box: 'border-red-500/25 bg-red-500/[0.07]', icon: 'bg-red-500/15 text-red-300', spark: 'text-red-400/80' },
};

function StatCard({
  tint, icon, label, value, sub, series,
}: {
  tint: keyof typeof TINTS;
  icon: React.ReactNode;
  label: string;
  value: string;
  sub: string;
  series: number[];
}) {
  const t = TINTS[tint];
  return (
    <div className={`rounded-xl border p-2.5 min-w-0 ${t.box}`}>
      <div className="flex items-center gap-1.5 mb-1.5">
        <span className={`w-6 h-6 rounded-lg flex items-center justify-center shrink-0 ${t.icon}`}>{icon}</span>
        <span className="text-zinc-400 text-[10.5px] font-semibold truncate">{label}</span>
      </div>
      <div className="text-white font-bold text-[19px] leading-tight" dir="ltr">{value}</div>
      <div className="text-zinc-500 text-[10px] truncate mb-1">{sub}</div>
      <Spark series={series} className={t.spark} />
    </div>
  );
}

// ------------------------------------------------------------ main screen

export function ProductsManager({ canSell, store }: { canSell: boolean; store: MerchantStore }) {
  const { loc } = useLanguage();
  const mainHref = useMainSiteHref();

  // filters — all applied SERVER-side
  const [q, setQ] = useState('');
  const [qLive, setQLive] = useState('');
  const [section, setSection] = useState('');
  const [lifecycle, setLifecycle] = useState('');
  const [stockF, setStockF] = useState('');
  const [priceBand, setPriceBand] = useState('');
  const [priceMin, setPriceMin] = useState('');
  const [priceMax, setPriceMax] = useState('');
  const [days, setDays] = useState('');
  const [category, setCategory] = useState('');
  const [featuredOnly, setFeaturedOnly] = useState(false);
  const [dealsOnly, setDealsOnly] = useState(false);
  const [advanced, setAdvanced] = useState(false);
  const [sort, setSort] = useState('newest');
  const [page, setPage] = useState(1);
  const [limit, setLimit] = useState(10);
  const [view, setView] = useState<View>(() => {
    try {
      const v = localStorage.getItem('levo_pm_view');
      return v === 'grid' || v === 'compact' ? v : 'list';
    } catch {
      return 'list';
    }
  });

  // data
  const [rows, setRows] = useState<MerchantProduct[] | null>(null);
  const [total, setTotal] = useState(0);
  const [stats, setStats] = useState<ProductsStats | null>(null);
  const [sections, setSections] = useState<StoreSection[]>([]);
  const [busy, setBusy] = useState('');
  const [editing, setEditing] = useState<MerchantProduct | 'new' | null>(null);
  const [insightsFor, setInsightsFor] = useState<MerchantProduct | null>(null);
  const [importOpen, setImportOpen] = useState(false);
  const [menuFor, setMenuFor] = useState('');
  const [toolsOpen, setToolsOpen] = useState(false);
  const searchRef = useRef<HTMLInputElement>(null);

  // ⌘K / Ctrl+K puts the cursor in the search box, like the reference.
  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        searchRef.current?.focus();
      }
    };
    window.addEventListener('keydown', h);
    return () => window.removeEventListener('keydown', h);
  }, []);

  // debounced search
  useEffect(() => {
    const t = setTimeout(() => {
      setQ(qLive.trim());
      setPage(1);
    }, 350);
    return () => clearTimeout(t);
  }, [qLive]);

  useEffect(() => {
    try {
      localStorage.setItem('levo_pm_view', view);
    } catch {
      /* per-browser convenience only */
    }
  }, [view]);

  const band = PRICE_BANDS[priceBand];
  const pMin = priceMin !== '' ? Number(priceMin) || 0 : band?.min;
  const pMax = priceMax !== '' ? Number(priceMax) || 0 : band?.max;

  const loadRows = useCallback(() => {
    merchantApi
      .productsPaged({
        page, limit, q, section, lifecycle, stock: stockF,
        price_min: pMin, price_max: pMax,
        days: days || undefined, category,
        featured: featuredOnly ? 1 : undefined,
        deals: dealsOnly ? 1 : undefined,
        sort,
      })
      .then((d) => {
        setRows(d.products);
        setTotal(d.total);
      })
      .catch(() => {
        setRows([]);
        setTotal(0);
      });
  }, [page, limit, q, section, lifecycle, stockF, pMin, pMax, days, category, featuredOnly, dealsOnly, sort]);

  const loadStats = useCallback(() => {
    merchantApi.productsStats().then(setStats).catch(() => {});
    merchantApi.sections().then((d) => setSections(d.sections)).catch(() => {});
  }, []);

  useEffect(loadRows, [loadRows]);
  useEffect(loadStats, [loadStats]);

  const reloadAll = useCallback(() => {
    loadRows();
    loadStats();
  }, [loadRows, loadStats]);

  async function remove(p: MerchantProduct) {
    if (!confirm(loc('حذف المنتج؟', 'Delete this product?', 'بسڕدرێتەوە؟'))) return;
    setBusy(p.id);
    try {
      const r = await merchantApi.deleteProduct(p.id);
      if (r.archived) {
        alert(
          loc(
            'تم أرشفة المنتج لأنه مرتبط بطلبات سابقة. لن يظهر في متجرك، وسجل الطلبات يبقى كما هو.',
            'The product was archived because it belongs to past orders. It is off your storefront and the order history is unchanged.',
            'بەرهەمەکە ئەرشیڤ کرا چونکە پەیوەندی بە داواکاری پێشووەکانەوە هەیە.'
          )
        );
      }
      reloadAll();
    } finally {
      setBusy('');
    }
  }

  async function duplicate(p: MerchantProduct) {
    setBusy(p.id);
    try {
      await merchantApi.duplicateProduct(p.id);
      reloadAll();
    } finally {
      setBusy('');
    }
  }

  async function quickPatch(p: MerchantProduct, body: Record<string, unknown>) {
    setBusy(p.id);
    setMenuFor('');
    try {
      await merchantApi.updateProduct(p.id, body);
      reloadAll();
    } catch (e) {
      if (e instanceof ApiError) alert(e.message);
    } finally {
      setBusy('');
    }
  }

  async function exportCsv() {
    setToolsOpen(false);
    const res = await fetch('/api/merchant/products/export.csv', { credentials: 'same-origin' });
    if (!res.ok) return;
    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'products.csv';
    a.click();
    URL.revokeObjectURL(url);
  }

  const storefrontUrl = (p: MerchantProduct) =>
    /^https?:\/\//.test(store.url) ? `${store.url.replace(/\/$/, '')}/p/${p.slug}` : mainHref(`/community/store/${store.slug}/p/${p.slug}`);

  const from = total === 0 ? 0 : (page - 1) * limit + 1;
  const to = Math.min(page * limit, total);
  const pages = Math.max(1, Math.ceil(total / limit));

  const resetFilters = () => {
    setQLive(''); setQ(''); setSection(''); setLifecycle(''); setStockF('');
    setPriceBand(''); setPriceMin(''); setPriceMax(''); setDays('');
    setCategory(''); setFeaturedOnly(false); setDealsOnly(false); setPage(1);
  };

  const weekly = stats?.weekly ?? [];
  const t = stats?.totals;
  const activePct = t && t.total > 0 ? Math.round((t.active / t.total) * 100) : 0;

  const selectCls =
    'h-9 rounded-lg bg-black/40 border border-white/10 px-2.5 text-zinc-200 text-[12px] outline-none focus:border-indigo-400/50 min-w-0';

  return (
    <div className="space-y-3">
      {/* breadcrumb + title + actions */}
      <div className="text-zinc-500 text-[11.5px]">
        <span className="text-zinc-300 font-semibold">{loc('لوحة التحكم', 'Dashboard', 'داشبۆرد')}</span>
        <span className="mx-1.5">/</span>
        {loc('المنتجات', 'Products', 'بەرهەمەکان')}
      </div>
      <div className="flex items-start justify-between gap-3 flex-wrap">
        <div>
          <h2 className="text-white font-bold text-[21px] leading-tight">{loc('إدارة المنتجات', 'Products management', 'بەڕێوەبردنی بەرهەمەکان')}</h2>
          <p className="text-zinc-500 text-[12px] mt-0.5">{loc('إدارة شاملة لجميع منتجات متجرك', 'Everything about your store products, in one place', 'بەڕێوەبردنی هەموو بەرهەمەکانی فرۆشگاکەت')}</p>
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={() => canSell && setEditing('new')}
            disabled={!canSell}
            className="h-10 px-4 rounded-lg bg-indigo-500 hover:bg-indigo-600 text-white text-[12.5px] font-bold flex items-center gap-1.5 disabled:opacity-50 transition-colors"
          >
            <Plus className="w-4 h-4" strokeWidth={2.25} />
            {loc('منتج جديد', 'New product', 'بەرهەمی نوێ')}
          </button>
          <div className="relative">
            <button
              onClick={() => setToolsOpen((v) => !v)}
              className="h-10 px-3.5 rounded-lg border border-white/10 bg-white/[0.03] text-zinc-200 text-[12.5px] font-semibold flex items-center gap-1.5"
            >
              <Download className="w-4 h-4" strokeWidth={1.75} />
              {loc('استيراد / تصدير', 'Import / export', 'هاوردە / هەناردە')}
            </button>
            {toolsOpen && (
              <>
                <div className="fixed inset-0 z-20" onClick={() => setToolsOpen(false)} />
                <div className="absolute top-11 start-0 z-30 w-52 rounded-xl border border-white/10 bg-[#131417] shadow-2xl overflow-hidden">
                  <button onClick={exportCsv} className="w-full text-start px-3.5 py-2.5 text-[12.5px] text-zinc-200 active:bg-white/10 flex items-center gap-2">
                    <FileDown className="w-3.5 h-3.5 text-zinc-400" />
                    {loc('تصدير المنتجات CSV', 'Export products CSV', 'هەناردەی CSV')}
                  </button>
                  <button
                    onClick={() => { setToolsOpen(false); setImportOpen(true); }}
                    disabled={!canSell}
                    className="w-full text-start px-3.5 py-2.5 text-[12.5px] text-zinc-200 active:bg-white/10 border-t border-white/5 flex items-center gap-2 disabled:opacity-50"
                  >
                    <Upload className="w-3.5 h-3.5 text-zinc-400" />
                    {loc('استيراد من CSV', 'Import from CSV', 'هاوردە لە CSV')}
                  </button>
                </div>
              </>
            )}
          </div>
          <button
            onClick={reloadAll}
            className="h-10 w-10 rounded-lg border border-white/10 bg-white/[0.03] text-zinc-300 flex items-center justify-center"
            aria-label={loc('تحديث البيانات', 'Refresh', 'نوێکردنەوە')}
          >
            <RefreshCcw className="w-4 h-4" strokeWidth={1.75} />
          </button>
        </div>
      </div>

      {!canSell && (
        <Notice
          text={loc(
            'لا يمكن نشر منتجات جديدة الآن. منتجاتك الحالية وسجلها محفوظة.',
            'New products cannot be published right now. Your existing products and their history are kept.',
            'ناتوانیت بەرهەمی نوێ بڵاو بکەیتەوە.'
          )}
        />
      )}

      {/* stat cards — all real aggregates */}
      {t && (
        <div className="grid grid-cols-2 sm:grid-cols-5 gap-2">
          <StatCard
            tint="purple"
            icon={<Eye className="w-3.5 h-3.5" />}
            label={loc('إجمالي المشاهدات', 'Total views', 'کۆی بینینەکان')}
            value={t.views.toLocaleString('en-US')}
            sub={loc(`عبر ${t.total} منتج`, `across ${t.total} products`, `${t.total} بەرهەم`)}
            series={weekly.map((w) => w.views)}
          />
          <StatCard
            tint="blue"
            icon={<Package className="w-3.5 h-3.5" />}
            label={loc('إجمالي المنتجات', 'Total products', 'کۆی بەرهەمەکان')}
            value={String(t.total)}
            sub={loc('منتج في متجرك', 'products in your store', 'بەرهەم لە فرۆشگاکەت')}
            series={weekly.map((w) => w.added)}
          />
          <StatCard
            tint="green"
            icon={<Check className="w-3.5 h-3.5" />}
            label={loc('منتجات نشطة', 'Active products', 'بەرهەمی چالاک')}
            value={String(t.active)}
            sub={loc(`${activePct}% من إجمالي المنتجات`, `${activePct}% of all products`, `${activePct}%`)}
            series={weekly.map((w) => w.active_added)}
          />
          <StatCard
            tint="amber"
            icon={<Pencil className="w-3.5 h-3.5" />}
            label={loc('مسودات', 'Drafts', 'ڕەشنووسەکان')}
            value={String(t.draft)}
            sub={loc('بانتظار الإكمال', 'waiting to be finished', 'چاوەڕوانی تەواوکردن')}
            series={weekly.map((w) => w.draft_added)}
          />
          <StatCard
            tint="red"
            icon={<PackageX className="w-3.5 h-3.5" />}
            label={loc('مخفية', 'Hidden', 'شاراوە')}
            value={String(t.hidden)}
            sub={loc('مخفية من المتجر', 'hidden from the storefront', 'لە فرۆشگا شاراوە')}
            series={weekly.map((w) => w.hidden_added)}
          />
        </div>
      )}

      {/* filter bar */}
      <div className="rounded-xl border border-white/10 bg-white/[0.03] p-2.5 space-y-2">
        <div className="flex items-center gap-2 flex-wrap">
          <div className="relative flex-1 min-w-[160px]">
            <Search className="w-3.5 h-3.5 text-zinc-500 absolute top-1/2 -translate-y-1/2 start-2.5" />
            <input
              ref={searchRef}
              value={qLive}
              onChange={(e) => setQLive(e.target.value)}
              placeholder={loc('بحث في المنتجات...', 'Search products…', 'گەڕان لە بەرهەمەکان...')}
              className="w-full h-9 rounded-lg bg-black/40 border border-white/10 ps-8 pe-8 text-white text-[12.5px] outline-none focus:border-indigo-400/50"
            />
            <kbd className="absolute top-1/2 -translate-y-1/2 end-2 text-[9.5px] text-zinc-600 border border-white/10 rounded px-1 py-0.5 hidden sm:block" dir="ltr">⌘K</kbd>
          </div>
          <select value={section} onChange={(e) => { setSection(e.target.value); setPage(1); }} className={selectCls}>
            <option value="">{loc('كل الأقسام', 'All sections', 'هەموو بەشەکان')}</option>
            <option value="none">{loc('بدون قسم', 'No section', 'بێ بەش')}</option>
            {sections.map((s) => (
              <option key={s.id} value={s.id}>{s.name}</option>
            ))}
          </select>
          <select value={lifecycle} onChange={(e) => { setLifecycle(e.target.value); setPage(1); }} className={selectCls}>
            <option value="">{loc('كل الحالات', 'All statuses', 'هەموو دۆخەکان')}</option>
            <option value="active">{lifecycleLabel('active', loc)}</option>
            <option value="draft">{lifecycleLabel('draft', loc)}</option>
            <option value="hidden">{lifecycleLabel('hidden', loc)}</option>
            <option value="sold_out">{lifecycleLabel('sold_out', loc)}</option>
            <option value="archived">{lifecycleLabel('archived', loc)}</option>
          </select>
          <select value={stockF} onChange={(e) => { setStockF(e.target.value); setPage(1); }} className={selectCls}>
            <option value="">{loc('كل المخزون', 'All stock', 'هەموو کۆگا')}</option>
            <option value="in">{loc('متوفر', 'In stock', 'بەردەست')}</option>
            <option value="low">{loc('منخفض (≤5)', 'Low (≤5)', 'کەم')}</option>
            <option value="out">{loc('نفد المخزون', 'Out of stock', 'تەواو بوو')}</option>
            <option value="untracked">{loc('غير متتبع', 'Untracked', 'بەدوادانەچوو')}</option>
          </select>
          <select
            value={priceBand}
            onChange={(e) => { setPriceBand(e.target.value); setPriceMin(''); setPriceMax(''); setPage(1); }}
            className={selectCls}
          >
            <option value="">{loc('كل الأسعار', 'All prices', 'هەموو نرخەکان')}</option>
            <option value="b1">{loc('أقل من 25,000', 'Under 25,000', '< 25,000')}</option>
            <option value="b2">25,000 - 100,000</option>
            <option value="b3">100,000 - 500,000</option>
            <option value="b4">{loc('أكثر من 500,000', 'Over 500,000', '> 500,000')}</option>
          </select>
          <select value={days} onChange={(e) => { setDays(e.target.value); setPage(1); }} className={selectCls}>
            <option value="">{loc('اختر الفترة', 'Any period', 'هەموو ماوەکان')}</option>
            <option value="7">{loc('آخر 7 أيام', 'Last 7 days', '٧ ڕۆژ')}</option>
            <option value="30">{loc('آخر 30 يومًا', 'Last 30 days', '٣٠ ڕۆژ')}</option>
            <option value="90">{loc('آخر 90 يومًا', 'Last 90 days', '٩٠ ڕۆژ')}</option>
          </select>
          <button
            onClick={() => setAdvanced((v) => !v)}
            className={`h-9 px-3 rounded-lg border text-[12px] font-semibold flex items-center gap-1.5 ${
              advanced ? 'border-indigo-400/50 text-indigo-300 bg-indigo-500/10' : 'border-white/10 text-zinc-300 bg-white/[0.03]'
            }`}
          >
            <SlidersHorizontal className="w-3.5 h-3.5" />
            {loc('تصفية متقدمة', 'Advanced', 'فلتەری پێشکەوتوو')}
          </button>
        </div>

        {advanced && (
          <div className="flex items-center gap-2 flex-wrap pt-1 border-t border-white/5">
            <Chip label={loc('مميز فقط', 'Featured only', 'تەنیا تایبەت')} active={featuredOnly} onClick={() => { setFeaturedOnly((v) => !v); setPage(1); }} />
            <Chip label={loc('عليها خصم', 'On sale', 'داشکاندن')} active={dealsOnly} onClick={() => { setDealsOnly((v) => !v); setPage(1); }} />
            {(stats?.categories.length ?? 0) > 0 && (
              <select value={category} onChange={(e) => { setCategory(e.target.value); setPage(1); }} className={selectCls}>
                <option value="">{loc('كل الفئات', 'All categories', 'هەموو پۆلەکان')}</option>
                {stats!.categories.map((cat) => (
                  <option key={cat} value={cat}>{cat}</option>
                ))}
              </select>
            )}
            <input
              value={priceMin}
              onChange={(e) => { setPriceMin(e.target.value.replace(/[^\d]/g, '')); setPriceBand(''); setPage(1); }}
              placeholder={loc('السعر من', 'Price from', 'نرخ لە')}
              inputMode="numeric"
              className="h-9 w-24 rounded-lg bg-black/40 border border-white/10 px-2.5 text-white text-[12px] outline-none focus:border-indigo-400/50"
              dir="ltr"
            />
            <input
              value={priceMax}
              onChange={(e) => { setPriceMax(e.target.value.replace(/[^\d]/g, '')); setPriceBand(''); setPage(1); }}
              placeholder={loc('إلى', 'to', 'بۆ')}
              inputMode="numeric"
              className="h-9 w-24 rounded-lg bg-black/40 border border-white/10 px-2.5 text-white text-[12px] outline-none focus:border-indigo-400/50"
              dir="ltr"
            />
            <button onClick={resetFilters} className="h-9 px-3 rounded-lg text-[12px] text-zinc-400 border border-white/10 flex items-center gap-1">
              <X className="w-3 h-3" />
              {loc('إعادة التعيين', 'Reset', 'ڕێکخستنەوە')}
            </button>
          </div>
        )}
      </div>

      {/* toolbar */}
      <div className="flex items-center justify-between gap-2 flex-wrap">
        <div className="flex items-center gap-2">
          <span className="text-zinc-400 text-[11.5px]">
            {loc(`عرض ${from} - ${to} من ${total} منتج`, `Showing ${from}-${to} of ${total}`, `${from}-${to} لە ${total}`)}
          </span>
          <select
            value={String(limit)}
            onChange={(e) => { setLimit(Number(e.target.value)); setPage(1); }}
            className="h-8 rounded-lg bg-black/40 border border-white/10 px-2 text-zinc-300 text-[11.5px] outline-none"
          >
            {PAGE_SIZES.map((n) => (
              <option key={n} value={n}>{n}</option>
            ))}
          </select>
        </div>
        <div className="flex items-center gap-2">
          <select value={sort} onChange={(e) => { setSort(e.target.value); setPage(1); }} className={selectCls}>
            <option value="newest">{loc('الأحدث', 'Newest', 'نوێترین')}</option>
            <option value="oldest">{loc('الأقدم', 'Oldest', 'کۆنترین')}</option>
            <option value="updated">{loc('آخر تحديث', 'Last updated', 'دوایین نوێکردنەوە')}</option>
            <option value="price_asc">{loc('السعر: من الأقل', 'Price: low→high', 'نرخ ↑')}</option>
            <option value="price_desc">{loc('السعر: من الأعلى', 'Price: high→low', 'نرخ ↓')}</option>
            <option value="sales">{loc('الأكثر مبيعًا', 'Best selling', 'زۆرترین فرۆش')}</option>
            <option value="views">{loc('الأكثر مشاهدة', 'Most viewed', 'زۆرترین بینین')}</option>
            <option value="stock">{loc('المخزون الأقل', 'Lowest stock', 'کەمترین کۆگا')}</option>
          </select>
          <div className="flex rounded-lg border border-white/10 overflow-hidden">
            {(
              [
                ['grid', <LayoutGrid key="g" className="w-3.5 h-3.5" />],
                ['list', <List key="l" className="w-3.5 h-3.5" />],
                ['compact', <AlignJustify key="c" className="w-3.5 h-3.5" />],
              ] as Array<[View, React.ReactNode]>
            ).map(([v, icon]) => (
              <button
                key={v}
                onClick={() => setView(v)}
                className={`w-8 h-8 flex items-center justify-center ${view === v ? 'bg-white/10 text-white' : 'text-zinc-500'}`}
                aria-label={v}
              >
                {icon}
              </button>
            ))}
          </div>
        </div>
      </div>

      {/* rows */}
      {rows === null ? (
        <Spinner />
      ) : rows.length === 0 ? (
        <Empty
          text={total === 0 && !q && !section && !lifecycle ? loc('لا توجد منتجات بعد', 'No products yet', 'هێشتا بەرهەم نییە') : loc('لا نتائج مطابقة للتصفية', 'Nothing matches these filters', 'هیچ ئەنجامێک نییە')}
        />
      ) : view === 'grid' ? (
        <div className="grid grid-cols-2 sm:grid-cols-3 gap-2.5">
          {rows.map((p) => (
            <div key={p.id} className="rounded-xl border border-white/10 bg-white/[0.03] overflow-hidden">
              <div className="aspect-square bg-black/40 relative">
                {p.images[0] && <img src={p.images[0]} alt="" className="w-full h-full object-cover" />}
                {!!p.featured && (
                  <span className="absolute top-1.5 start-1.5 w-5 h-5 rounded-full bg-black/60 flex items-center justify-center">
                    <Star className="w-3 h-3 text-gold fill-gold" />
                  </span>
                )}
              </div>
              <div className="p-2">
                <p className="text-white text-[12px] font-semibold truncate" dir="auto">{p.name}</p>
                <p className="text-zinc-300 text-[11.5px] mt-0.5" dir="ltr">{dinar(p.price_iqd)}</p>
                <div className="flex items-center justify-between mt-1.5">
                  <LifecycleChip lifecycle={p.lifecycle ?? 'active'} />
                  <div className="flex gap-1">
                    <IconBtn onClick={() => setEditing(p)} disabled={!canSell} label={loc('تعديل', 'Edit', 'دەستکاری')}>
                      <Pencil className="w-3 h-3" />
                    </IconBtn>
                    <IconBtn onClick={() => setInsightsFor(p)} label={loc('تحليلات', 'Insights', 'شیکاری')}>
                      <BarChart3 className="w-3 h-3" />
                    </IconBtn>
                  </div>
                </div>
              </div>
            </div>
          ))}
        </div>
      ) : view === 'compact' ? (
        <div className="rounded-xl border border-white/10 bg-white/[0.03] divide-y divide-white/5">
          {rows.map((p) => (
            <div key={p.id} className="flex items-center gap-2.5 px-2.5 py-2">
              <div className="w-8 h-8 rounded-lg bg-black/40 overflow-hidden shrink-0">
                {p.images[0] && <img src={p.images[0]} alt="" className="w-full h-full object-cover" />}
              </div>
              <span className="text-white text-[12px] font-medium truncate flex-1 min-w-0" dir="auto">{p.name}</span>
              <span className="text-zinc-300 text-[11.5px] shrink-0" dir="ltr">{dinar(p.price_iqd)}</span>
              <StockCell p={p} loc={loc} compact />
              <LifecycleChip lifecycle={p.lifecycle ?? 'active'} />
              <IconBtn onClick={() => setEditing(p)} disabled={!canSell} label={loc('تعديل', 'Edit', 'دەستکاری')}>
                <Pencil className="w-3 h-3" />
              </IconBtn>
            </div>
          ))}
        </div>
      ) : (
        <div className="rounded-xl border border-white/10 bg-white/[0.03] overflow-x-auto">
          <table className="w-full min-w-[680px] text-start border-collapse">
            <thead>
              <tr className="text-zinc-500 text-[11px] border-b border-white/10">
                <th className="text-start font-semibold px-3 py-2.5">{loc('المنتج', 'Product', 'بەرهەم')}</th>
                <th className="text-start font-semibold px-2 py-2.5">{loc('السعر', 'Price', 'نرخ')}</th>
                <th className="text-start font-semibold px-2 py-2.5">{loc('المخزون', 'Stock', 'کۆگا')}</th>
                <th className="text-start font-semibold px-2 py-2.5">{loc('الحالة', 'Status', 'دۆخ')}</th>
                <th className="text-start font-semibold px-2 py-2.5">{loc('المبيعات', 'Sales', 'فرۆش')}</th>
                <th className="text-start font-semibold px-2 py-2.5">{loc('آخر تحديث', 'Last updated', 'نوێکردنەوە')}</th>
                <th className="text-start font-semibold px-2 py-2.5">{loc('إجراءات', 'Actions', 'کردارەکان')}</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-white/5">
              {rows.map((p) => {
                const discounted = p.original_price_iqd && p.original_price_iqd > p.price_iqd;
                return (
                  <tr key={p.id} className="hover:bg-white/[0.02]">
                    <td className="px-3 py-2.5">
                      <div className="flex items-center gap-2.5 min-w-0">
                        <div className="w-11 h-11 rounded-lg bg-black/40 overflow-hidden shrink-0">
                          {p.images[0] && <img src={p.images[0]} alt="" className="w-full h-full object-cover" />}
                        </div>
                        <div className="min-w-0">
                          <p className="text-white text-[12.5px] font-semibold truncate max-w-[150px]" dir="auto">
                            {!!p.featured && <Star className="w-3 h-3 text-gold fill-gold inline me-1 -mt-0.5" />}
                            {p.name}
                          </p>
                          <p className="text-zinc-500 text-[10.5px] truncate max-w-[150px]" dir="auto">
                            {[p.category, firstColor(p)].filter(Boolean).join(' • ') || conditionLabel(p.condition, loc)}
                          </p>
                          <p className="text-zinc-600 text-[10px]" dir="ltr">#{p.id.slice(-6).toUpperCase()}</p>
                        </div>
                      </div>
                    </td>
                    <td className="px-2 py-2.5">
                      <p className="text-white text-[12.5px] font-bold whitespace-nowrap" dir="ltr">{dinar(p.price_iqd)}</p>
                      {discounted && (
                        <p className="flex items-center gap-1.5 whitespace-nowrap" dir="ltr">
                          <span className="text-zinc-500 text-[10.5px] line-through">{Number(p.original_price_iqd).toLocaleString('en-US')}</span>
                          <span className="text-[9.5px] font-bold px-1 py-0.5 rounded bg-red-500/15 text-red-400">
                            -{Math.round((1 - p.price_iqd / (p.original_price_iqd as number)) * 100)}%
                          </span>
                        </p>
                      )}
                    </td>
                    <td className="px-2 py-2.5"><StockCell p={p} loc={loc} /></td>
                    <td className="px-2 py-2.5"><LifecycleChip lifecycle={p.lifecycle ?? 'active'} /></td>
                    <td className="px-2 py-2.5">
                      <p className="text-white text-[12.5px] font-bold" dir="ltr">{p.sold_count ?? 0}</p>
                      <p className="text-zinc-500 text-[10px]">{loc('مبيع', 'sold', 'فرۆشراو')}</p>
                    </td>
                    <td className="px-2 py-2.5">
                      <p className="text-zinc-200 text-[11.5px] whitespace-nowrap">{relTime(p.updated_at || p.created_at, loc)}</p>
                      <p className="text-zinc-500 text-[10px]" dir="ltr">{absDate(p.updated_at || p.created_at)}</p>
                    </td>
                    <td className="px-2 py-2.5">
                      <div className="flex items-center gap-1">
                        <IconBtn danger onClick={() => remove(p)} disabled={busy === p.id} label={loc('حذف', 'Delete', 'سڕینەوە')}>
                          <Trash2 className="w-3.5 h-3.5" />
                        </IconBtn>
                        <IconBtn onClick={() => setEditing(p)} disabled={!canSell} label={loc('تعديل', 'Edit', 'دەستکاری')}>
                          <Pencil className="w-3.5 h-3.5" />
                        </IconBtn>
                        <IconBtn onClick={() => duplicate(p)} disabled={!canSell || busy === p.id} label={loc('نسخ', 'Duplicate', 'لەبەرگرتنەوە')}>
                          <Copy className="w-3.5 h-3.5" />
                        </IconBtn>
                        <IconBtn onClick={() => setInsightsFor(p)} label={loc('تحليلات', 'Insights', 'شیکاری')}>
                          <BarChart3 className="w-3.5 h-3.5" />
                        </IconBtn>
                        <div className="relative">
                          <IconBtn onClick={() => setMenuFor(menuFor === p.id ? '' : p.id)} label={loc('المزيد', 'More', 'زیاتر')}>
                            <MoreHorizontal className="w-3.5 h-3.5" />
                          </IconBtn>
                          {menuFor === p.id && (
                            <>
                              <div className="fixed inset-0 z-20" onClick={() => setMenuFor('')} />
                              <div className="absolute top-9 end-0 z-30 w-48 rounded-xl border border-white/10 bg-[#131417] shadow-2xl overflow-hidden">
                                {(p.lifecycle ?? 'active') === 'active' ? (
                                  <MenuItem
                                    icon={<EyeOff className="w-3.5 h-3.5" />}
                                    label={loc('إخفاء من المتجر', 'Hide from store', 'شاردنەوە')}
                                    onClick={() => quickPatch(p, { lifecycle: 'hidden' })}
                                    disabled={!canSell}
                                  />
                                ) : (
                                  <MenuItem
                                    icon={<Eye className="w-3.5 h-3.5" />}
                                    label={loc('نشر في المتجر', 'Publish to store', 'بڵاوکردنەوە')}
                                    onClick={() => quickPatch(p, { lifecycle: 'active' })}
                                    disabled={!canSell || (p.lifecycle ?? '') === 'archived'}
                                  />
                                )}
                                <MenuItem
                                  icon={<Star className="w-3.5 h-3.5" />}
                                  label={p.featured ? loc('إلغاء التمييز', 'Unfeature', 'لابردنی تایبەت') : loc('تمييز المنتج', 'Feature product', 'تایبەتکردن')}
                                  onClick={() => quickPatch(p, { featured: !p.featured })}
                                  disabled={!canSell}
                                />
                                <MenuItem
                                  icon={<Link2 className="w-3.5 h-3.5" />}
                                  label={loc('فتح في المتجر', 'Open in storefront', 'کردنەوە لە فرۆشگا')}
                                  onClick={() => { setMenuFor(''); window.open(storefrontUrl(p), '_blank', 'noopener,noreferrer'); }}
                                />
                                <MenuItem
                                  icon={<Copy className="w-3.5 h-3.5" />}
                                  label={loc('نسخ رابط المنتج', 'Copy product link', 'کۆپی بەستەر')}
                                  onClick={() => { setMenuFor(''); navigator.clipboard?.writeText(storefrontUrl(p)).catch(() => {}); }}
                                />
                              </div>
                            </>
                          )}
                        </div>
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {/* pagination */}
      {pages > 1 && (
        <div className="flex items-center justify-center gap-1.5">
          <PageBtn onClick={() => setPage((p) => Math.max(1, p - 1))} disabled={page === 1}>
            <ChevronRight className="w-3.5 h-3.5 ltr:rotate-180" />
          </PageBtn>
          {Array.from({ length: pages }, (_, i) => i + 1)
            .filter((n) => n === 1 || n === pages || Math.abs(n - page) <= 1)
            .map((n, i, arr) => (
              <span key={n} className="flex items-center gap-1.5">
                {i > 0 && arr[i - 1] !== n - 1 && <span className="text-zinc-600 text-[11px]">…</span>}
                <PageBtn onClick={() => setPage(n)} active={n === page}>{n}</PageBtn>
              </span>
            ))}
          <PageBtn onClick={() => setPage((p) => Math.min(pages, p + 1))} disabled={page === pages}>
            <ChevronLeft className="w-3.5 h-3.5 ltr:rotate-180" />
          </PageBtn>
        </div>
      )}

      {/* modals */}
      {editing && (
        <Overlay onClose={() => setEditing(null)}>
          <ProductEditor
            product={editing === 'new' ? null : editing}
            sections={sections}
            onDone={() => { setEditing(null); reloadAll(); }}
            onCancel={() => setEditing(null)}
          />
        </Overlay>
      )}
      {insightsFor && (
        <Overlay onClose={() => setInsightsFor(null)}>
          <InsightsPanel product={insightsFor} loc={loc} onClose={() => setInsightsFor(null)} />
        </Overlay>
      )}
      {importOpen && (
        <Overlay onClose={() => setImportOpen(false)}>
          <ImportPanel loc={loc} onDone={() => { setImportOpen(false); reloadAll(); }} onClose={() => setImportOpen(false)} />
        </Overlay>
      )}
    </div>
  );
}

// ---------------------------------------------------------------- pieces

function IconBtn({
  children, onClick, disabled, label, danger,
}: {
  children: React.ReactNode;
  onClick: () => void;
  disabled?: boolean;
  label: string;
  danger?: boolean;
}) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      aria-label={label}
      title={label}
      className={`w-7 h-7 rounded-lg border flex items-center justify-center shrink-0 disabled:opacity-40 transition-colors ${
        danger ? 'border-red-500/25 bg-red-500/10 text-red-400' : 'border-white/10 bg-white/[0.03] text-zinc-400 hover:text-zinc-200'
      }`}
    >
      {children}
    </button>
  );
}

function MenuItem({
  icon, label, onClick, disabled,
}: {
  icon: React.ReactNode;
  label: string;
  onClick: () => void;
  disabled?: boolean;
}) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      className="w-full text-start px-3 py-2.5 text-[12px] text-zinc-200 active:bg-white/10 flex items-center gap-2 border-b border-white/5 last:border-0 disabled:opacity-40"
    >
      <span className="text-zinc-500">{icon}</span>
      {label}
    </button>
  );
}

function PageBtn({
  children, onClick, disabled, active,
}: {
  children: React.ReactNode;
  onClick: () => void;
  disabled?: boolean;
  active?: boolean;
}) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      className={`min-w-8 h-8 px-2 rounded-lg border text-[12px] font-semibold flex items-center justify-center disabled:opacity-30 ${
        active ? 'border-indigo-400/50 bg-indigo-500/15 text-indigo-300' : 'border-white/10 text-zinc-400'
      }`}
    >
      {children}
    </button>
  );
}

function StockCell({ p, loc, compact }: { p: MerchantProduct; loc: Loc; compact?: boolean }) {
  if (!p.track_stock) {
    return compact ? (
      <span className="text-zinc-500 text-[10.5px] shrink-0">—</span>
    ) : (
      <div>
        <p className="text-zinc-300 text-[12.5px] font-bold">—</p>
        <p className="text-zinc-500 text-[10px]">{loc('غير متتبع', 'untracked', 'بەدوادانەچوو')}</p>
      </div>
    );
  }
  const out = (p.stock ?? 0) <= 0;
  if (compact) {
    return (
      <span className={`text-[10.5px] shrink-0 ${out ? 'text-red-400' : 'text-zinc-400'}`} dir="ltr">
        {p.stock ?? 0}
      </span>
    );
  }
  return (
    <div>
      <p className={`text-[12.5px] font-bold ${out ? 'text-red-400' : 'text-white'}`} dir="ltr">{p.stock ?? 0}</p>
      <p className={`text-[10px] ${out ? 'text-red-400/80' : 'text-zinc-500'}`}>
        {out ? loc('نفد المخزون', 'out of stock', 'تەواو بوو') : loc('متوفر', 'in stock', 'بەردەست')}
      </p>
    </div>
  );
}

function Overlay({ children, onClose }: { children: React.ReactNode; onClose: () => void }) {
  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto p-4 pt-10 pb-16">
      <div className="fixed inset-0 bg-black/70 backdrop-blur-sm" onClick={onClose} />
      <div className="relative z-10 w-full max-w-lg">{children}</div>
    </div>
  );
}

// ---------------------------------------------------------- insights modal

function InsightsPanel({ product, loc, onClose }: { product: MerchantProduct; loc: Loc; onClose: () => void }) {
  const [data, setData] = useState<ProductInsights | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let alive = true;
    merchantApi
      .productInsights(product.id)
      .then((d) => alive && setData(d.insights))
      .catch(() => alive && setFailed(true));
    return () => {
      alive = false;
    };
  }, [product.id]);

  return (
    <div className="rounded-2xl border border-white/10 bg-[#101114] p-4 space-y-3">
      <div className="flex items-center justify-between gap-2">
        <h3 className="text-white font-bold text-[14px] truncate" dir="auto">{product.name}</h3>
        <button onClick={onClose} className="w-8 h-8 rounded-lg border border-white/10 flex items-center justify-center text-zinc-400">
          <X className="w-4 h-4" />
        </button>
      </div>
      {failed ? (
        <p className="text-red-400 text-[12px]">{loc('تعذّر التحميل', 'Could not load', 'بارنەبوو')}</p>
      ) : !data ? (
        <Spinner />
      ) : (
        <div className="grid grid-cols-2 gap-2">
          <InsightRow label={loc('المشاهدات', 'Views', 'بینین')} value={data.views.toLocaleString('en-US')} />
          <InsightRow label={loc('القطع المبيعة', 'Units sold', 'فرۆشراو')} value={String(data.sold)} />
          <InsightRow label={loc('الإيراد (بدون الملغاة)', 'Revenue (non-cancelled)', 'داهات')} value={dinar(data.revenue_iqd)} />
          <InsightRow label={loc('عدد الطلبات', 'Orders', 'داواکاری')} value={String(data.orders)} />
          <InsightRow label={loc('السعر الحالي', 'Current price', 'نرخ')} value={dinar(product.price_iqd)} />
          <InsightRow
            label={loc('المخزون', 'Stock', 'کۆگا')}
            value={product.track_stock ? String(product.stock ?? 0) : loc('غير متتبع', 'untracked', '—')}
          />
          <InsightRow label={loc('أضيف في', 'Created', 'دروستکراوە')} value={absDate(data.created_at)} />
          <InsightRow label={loc('آخر تحديث', 'Updated', 'نوێکراوەتەوە')} value={absDate(data.updated_at)} />
        </div>
      )}
    </div>
  );
}

function InsightRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-xl border border-white/10 bg-white/[0.03] px-3 py-2.5">
      <p className="text-zinc-500 text-[10.5px] mb-0.5">{label}</p>
      <p className="text-white text-[13px] font-bold" dir="ltr">{value}</p>
    </div>
  );
}

// ------------------------------------------------------------ import modal

const TEMPLATE_HEADER = 'name,name_ar,price_iqd,original_price_iqd,sku,stock,track_stock,category,condition,prep_days,section,description';

function ImportPanel({ loc, onDone, onClose }: { loc: Loc; onDone: () => void; onClose: () => void }) {
  const [csv, setCsv] = useState('');
  const [report, setReport] = useState<ProductsImportReport | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  async function run(confirm: boolean) {
    setBusy(true);
    setError('');
    try {
      const r = await merchantApi.importProducts(csv, confirm);
      setReport(r);
      if (confirm && r.created > 0) onDone();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : loc('تعذّر التنفيذ', 'Import failed', 'سەرنەکەوت'));
    } finally {
      setBusy(false);
    }
  }

  function downloadTemplate() {
    const blob = new Blob(['\uFEFF' + TEMPLATE_HEADER + '\n'], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'products-template.csv';
    a.click();
    URL.revokeObjectURL(url);
  }

  return (
    <div className="rounded-2xl border border-white/10 bg-[#101114] p-4 space-y-3">
      <div className="flex items-center justify-between gap-2">
        <h3 className="text-white font-bold text-[14px]">{loc('استيراد منتجات من CSV', 'Import products from CSV', 'هاوردەکردن لە CSV')}</h3>
        <button onClick={onClose} className="w-8 h-8 rounded-lg border border-white/10 flex items-center justify-center text-zinc-400">
          <X className="w-4 h-4" />
        </button>
      </div>
      <p className="text-zinc-500 text-[11.5px] leading-relaxed">
        {loc(
          'الأعمدة المطلوبة: name و price_iqd. كل المنتجات المستوردة تُنشأ كمسودات — راجعها ثم انشرها بنفسك.',
          'Required columns: name and price_iqd. Imported products are created as drafts — review, then publish yourself.',
          'ستوونە پێویستەکان: name و price_iqd.'
        )}
      </p>
      <div className="flex items-center gap-2">
        <label className="h-9 px-3 rounded-lg border border-white/10 bg-white/[0.03] text-zinc-200 text-[12px] font-semibold flex items-center gap-1.5 cursor-pointer">
          <Upload className="w-3.5 h-3.5" />
          {loc('اختر ملف CSV', 'Choose CSV file', 'فایل هەڵبژێرە')}
          <input
            type="file"
            accept=".csv,text/csv"
            className="hidden"
            onChange={async (e) => {
              const file = e.target.files?.[0];
              if (!file) return;
              setCsv(await file.text());
              setReport(null);
            }}
          />
        </label>
        <button onClick={downloadTemplate} className="h-9 px-3 rounded-lg text-[12px] text-zinc-400 border border-white/10 flex items-center gap-1.5">
          <FileDown className="w-3.5 h-3.5" />
          {loc('تنزيل القالب', 'Download template', 'داگرتنی قاڵب')}
        </button>
      </div>
      <textarea
        value={csv}
        onChange={(e) => { setCsv(e.target.value); setReport(null); }}
        rows={5}
        placeholder={TEMPLATE_HEADER}
        dir="ltr"
        className="w-full rounded-xl bg-black/40 border border-white/10 p-3 text-zinc-200 text-[11px] font-mono outline-none focus:border-indigo-400/50"
      />
      {report && (
        <div className="rounded-xl border border-white/10 bg-white/[0.02] p-3 space-y-1.5 max-h-48 overflow-y-auto">
          <p className="text-zinc-300 text-[12px] font-semibold">
            {report.confirmed
              ? loc(`تم إنشاء ${report.created} منتجًا كمسودات.`, `${report.created} products created as drafts.`, `${report.created} دروستکرا`)
              : loc(`${report.valid} صف صالح، ${report.invalid} به أخطاء.`, `${report.valid} valid rows, ${report.invalid} with errors.`, `${report.valid} دروست`)}
          </p>
          {report.report.filter((r) => !r.ok).map((r) => (
            <p key={r.row} className="text-red-400 text-[11px]" dir="auto">
              {loc(`صف ${r.row}`, `Row ${r.row}`, `${r.row}`)} — {r.name}: {r.error}
            </p>
          ))}
        </div>
      )}
      {error && <p className="text-red-400 text-[12px]">{error}</p>}
      <div className="flex gap-2">
        <Btn onClick={() => run(false)} kind="ghost" disabled={busy || !csv.trim()} full>
          {busy && !report?.confirmed ? <Loader2 className="w-4 h-4 animate-spin" /> : null}
          {loc('معاينة', 'Preview', 'پێشبینین')}
        </Btn>
        <Btn onClick={() => run(true)} disabled={busy || !report || report.valid === 0 || report.confirmed} full>
          <Check className="w-4 h-4" />
          {loc(`استيراد ${report?.valid ?? 0} صفًا`, `Import ${report?.valid ?? 0} rows`, 'هاوردەکردن')}
        </Btn>
      </div>
    </div>
  );
}

// ------------------------------------------------------- lifecycle helpers

export function LifecycleChip({ lifecycle }: { lifecycle: string }) {
  const { loc } = useLanguage();

  const map: Record<string, string> = {
    active: 'bg-emerald-500/10 text-emerald-400 border-emerald-500/20',
    draft: 'bg-amber-500/10 text-amber-400 border-amber-500/20',
    hidden: 'bg-zinc-500/10 text-zinc-400 border-zinc-500/20',
    sold_out: 'bg-red-500/10 text-red-300 border-red-500/20',
    archived: 'bg-zinc-700/20 text-zinc-500 border-zinc-600/20',
  };
  return (
    <span className={`inline-flex items-center gap-1 text-[10px] font-bold px-2 py-0.5 rounded-full border whitespace-nowrap ${map[lifecycle] ?? map.draft}`}>
      <span className="w-1 h-1 rounded-full bg-current" />
      {lifecycleLabel(lifecycle, loc)}
    </span>
  );
}

export function lifecycleLabel(k: string, loc: Loc): string {
  switch (k) {
    case 'active': return loc('نشط', 'Live', 'چالاک');
    case 'draft': return loc('مسودة', 'Draft', 'ڕەشنووس');
    case 'hidden': return loc('مخفي', 'Hidden', 'شاراوە');
    case 'sold_out': return loc('نفد', 'Sold out', 'تەواو بوو');
    case 'archived': return loc('مؤرشف', 'Archived', 'ئەرشیڤ');
    default: return k;
  }
}

function conditionLabel(k: string | undefined, loc: Loc): string {
  switch (k) {
    case 'used': return loc('مستعمل', 'Used', 'بەکارهاتوو');
    case 'refurbished': return loc('مجدّد', 'Refurbished', 'نوێکراوە');
    default: return loc('جديد', 'New', 'نوێ');
  }
}

// ------------------------------------------------------------ the editor
// Moved verbatim from MerchantDashboardPage so the manager can host it in a
// modal; the fields and behaviour are unchanged.

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

export function ProductEditor({
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
    <div className="rounded-2xl border border-white/10 bg-[#101114] p-3.5 space-y-3.5">
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
