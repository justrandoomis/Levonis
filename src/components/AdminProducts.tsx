/**
 * Admin products (v2) — the owner's reference management screen on
 * /api/admin/products-v2: breadcrumb + title + actions, five tinted stat
 * cards with real sparkline series, a server-side filter bar (search,
 * status, brand, catalog, stock, price band, recency, featured), sortable
 * numbered pagination with an exact total, and three view modes.
 *
 * EVERY NUMBER IS REAL. Stats come from /products-v2/stats (weekly buckets
 * over created_at; sales from actual order lines, gross gated to financial
 * admins); platform products have no view counter, so none is shown. The
 * heavy editor body and the template import tools stay code-split via
 * React.lazy, and the import dialog carries the whole import/EXPORT surface.
 *
 * LOAD-BEARING HOOKS (browser verification scripts depend on these at every
 * width): rows wrapped in [data-product-id] with a [data-action="edit"]
 * control in EVERY view mode; the toolbar keeps
 * [data-testid="admin-import-open"]; the tab itself stays component state.
 *
 * §6.2 density: one consistent scale, min-w-0 columns, CSS logical
 * properties, wide content scrolls in its own overflow-x-auto container.
 */

import React, { Suspense, useCallback, useEffect, useRef, useState } from 'react';
import {
  Plus, Edit2, Trash2, Search, RefreshCw, Upload, Star, LayoutGrid, List,
  AlignJustify, SlidersHorizontal, X, MoreHorizontal, Eye, EyeOff, Link2,
  Copy, ChevronRight, ChevronLeft, Package, PackageX, ShoppingBag, Check, Pencil,
} from 'lucide-react';
import { api, ApiError, formatIqd } from '../lib/api';
import { useLanguage } from '../LanguageContext';
import type { ListingItem, ListingResponse, DeleteResponse } from './adminProducts/types';
import { StatusChip, Modal, ErrorBanner, btnSecondary, fmtDate } from './adminProducts/ui';
import { StatCard } from './ui/statCards';

// The rebuilt eight-section form (product-form mandate §1). The previous
// ProductEditor is gone: it carried the ar/ckb fields §3 removes, the
// compare-at price §4 retires and the URL panel §2 deletes.
const ProductForm = React.lazy(() => import('./adminProducts/ProductForm'));
// The §10 replacement for the single giant template: per-section Devices /
// Materials sheets with preview, idempotent confirm and a round-trip export.
const ImportPanel = React.lazy(() => import('./adminProducts/ImportPanel'));
// The older TXT pipeline. Kept because it is genuinely used, demoted to a
// second tab because §10 forbids it being the only option.
const TemplateTools = React.lazy(() => import('./adminProducts/TemplateImport'));

const PAGE_SIZES = [30, 60, 100];
const PRICE_BANDS: Record<string, { min?: number; max?: number }> = {
  b1: { max: 25_000 },
  b2: { min: 25_000, max: 100_000 },
  b3: { min: 100_000, max: 500_000 },
  b4: { min: 500_000 },
};

type View = 'list' | 'grid' | 'compact';
type Loc = (ar: string, en: string, ckb?: string) => string;

interface AdminProductsStats {
  totals: { total: number; active: number; draft: number; hidden: number; out_of_stock: number; featured: number };
  weekly: Array<{ week: string; added: number; active_added: number; draft_added: number; hidden_added: number }>;
  sales_30d: { units: number; orders: number; gross_iqd?: number };
  sales_daily: Array<{ day: string; orders: number; units: number }>;
}

const STRINGS = {
  ar: {
    title: 'إدارة المنتجات',
    subtitle: 'إدارة شاملة لجميع منتجات متجرك',
    breadcrumbA: 'لوحة التحكم',
    breadcrumbB: 'المنتجات',
    unit: 'منتج',
    import: 'استيراد / تصدير',
    importTitle: 'استيراد / تصدير المنتجات',
    tabNew: 'قوالب الأقسام (CSV / ZIP)',
    tabLegacy: 'القالب النصي القديم (TXT)',
    newProduct: 'منتج جديد',
    searchPlaceholder: 'بحث في المنتجات...',
    search: 'بحث',
    empty: 'لا منتجات بعد.',
    noMatch: 'لا نتائج مطابقة للتصفية.',
    loading: 'جارٍ التحميل…',
    price: 'السعر',
    stock: 'المخزون',
    untracked: 'غير محدود',
    updated: 'آخر تحديث',
    edit: 'تعديل',
    del: 'حذف / أرشفة',
    featured: 'مميز',
    loadFailed: 'تعذّر تحميل المنتجات',
    deleteFailed: 'فشل الحذف: ',
    v1Hint: 'بيانات قديمة تُرقّى عند الحفظ / v1 data, upgraded on save',
  },
  en: {
    title: 'Manage Products',
    subtitle: 'Everything about your store products, in one place',
    breadcrumbA: 'Dashboard',
    breadcrumbB: 'Products',
    unit: 'products',
    import: 'Import / export',
    importTitle: 'Import / export products',
    tabNew: 'Section templates (CSV / ZIP)',
    tabLegacy: 'Legacy TXT template',
    newProduct: 'New product',
    searchPlaceholder: 'Search products…',
    search: 'Search',
    empty: 'No products yet.',
    noMatch: 'Nothing matches these filters.',
    loading: 'Loading…',
    price: 'Price',
    stock: 'Stock',
    untracked: 'untracked',
    updated: 'Updated',
    edit: 'Edit',
    del: 'Delete / archive',
    featured: 'Featured',
    loadFailed: 'Failed to load products',
    deleteFailed: 'Delete failed: ',
    v1Hint: 'v1 data — upgraded on save',
  },
  ckb: {
    title: 'بەڕێوەبردنی بەرهەمەکان',
    subtitle: 'بەڕێوەبردنی هەموو بەرهەمەکانی فرۆشگاکەت',
    breadcrumbA: 'داشبۆرد',
    breadcrumbB: 'بەرهەمەکان',
    unit: 'بەرهەم',
    import: 'هاوردە / هەناردە',
    importTitle: 'هاوردە / هەناردەی بەرهەمەکان',
    tabNew: 'قاڵبی بەشەکان (CSV / ZIP)',
    tabLegacy: 'قاڵبی کۆنی TXT',
    newProduct: 'بەرهەمی نوێ',
    searchPlaceholder: 'گەڕان لە بەرهەمەکان...',
    search: 'گەڕان',
    empty: 'هێشتا بەرهەم نییە.',
    noMatch: 'هیچ ئەنجامێک نییە.',
    loading: 'بارکردن…',
    price: 'نرخ',
    stock: 'کۆگا',
    untracked: 'بێ سنوور',
    updated: 'دوا نوێکردنەوە',
    edit: 'دەستکاری',
    del: 'سڕینەوە / ئەرشیف',
    featured: 'تایبەت',
    loadFailed: 'نەتوانرا بەرهەمەکان باربکرێن',
    deleteFailed: 'سڕینەوە شکستی هێنا: ',
    v1Hint: 'داتای کۆن — بەرزدەکرێتەوە لە کاتی پاشەکەوت',
  },
} as const;

function LazyFallback({ label }: { label: string }) {
  return (
    <div className="flex items-center justify-center gap-2 text-zinc-400 py-12" role="status">
      <RefreshCw className="w-5 h-5 animate-spin" /> {label}
    </div>
  );
}

function relTime(iso: string | null | undefined, loc: Loc): string {
  if (!iso) return '—';
  const ms = Date.now() - new Date(iso).getTime();
  const min = Math.floor(ms / 60_000);
  if (min < 1) return loc('الآن', 'now', 'ئێستا');
  if (min < 60) return loc(`منذ ${min} دقيقة`, `${min}m ago`, `${min} خولەک`);
  const h = Math.floor(min / 60);
  if (h < 24) return loc(`منذ ${h} ساعة`, `${h}h ago`, `${h} کاتژمێر`);
  const d = Math.floor(h / 24);
  if (d < 30) return loc(`منذ ${d} يوم`, `${d}d ago`, `${d} ڕۆژ`);
  return loc(`منذ ${Math.floor(d / 30)} شهر`, `${Math.floor(d / 30)}mo ago`, `${Math.floor(d / 30)} مانگ`);
}

export default function AdminProducts() {
  const { dir, lang, loc } = useLanguage();
  const t = STRINGS[lang] ?? STRINGS.ar;

  const [items, setItems] = useState<ListingItem[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [loadErr, setLoadErr] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  const [query, setQuery] = useState('');

  // server-side filters
  const [status, setStatus] = useState('');
  const [brand, setBrand] = useState('');
  const [catalog, setCatalog] = useState('');
  const [stockF, setStockF] = useState('');
  const [priceBand, setPriceBand] = useState('');
  const [priceMin, setPriceMin] = useState('');
  const [priceMax, setPriceMax] = useState('');
  const [days, setDays] = useState('');
  const [featuredOnly, setFeaturedOnly] = useState(false);
  const [advanced, setAdvanced] = useState(false);
  const [sort, setSort] = useState('updated');
  const [page, setPage] = useState(1);
  const [limit, setLimit] = useState(30);
  const [view, setView] = useState<View>(() => {
    try {
      const v = localStorage.getItem('levo_ap_view');
      return v === 'grid' || v === 'compact' ? v : 'list';
    } catch {
      return 'list';
    }
  });

  const [stats, setStats] = useState<AdminProductsStats | null>(null);
  const [brands, setBrands] = useState<Array<{ id: string; name_ar?: string; name?: string }>>([]);
  const [catalogs, setCatalogs] = useState<Array<{ id: string; name_ar?: string; name?: string }>>([]);

  const [editing, setEditing] = useState<{ open: boolean; id: string | null }>({ open: false, id: null });
  const [importOpen, setImportOpen] = useState(false);
  const [importDirty, setImportDirty] = useState(false);
  // The §10 flow is the default tab; the TXT tools are one click away.
  const [importTab, setImportTab] = useState<'new' | 'legacy'>('new');
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [menuFor, setMenuFor] = useState('');
  const [menuPos, setMenuPos] = useState<{ top: number; right: number } | null>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const seqRef = useRef(0);

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
    const timer = setTimeout(() => {
      setQuery(search.trim());
      setPage(1);
    }, 350);
    return () => clearTimeout(timer);
  }, [search]);

  useEffect(() => {
    try {
      localStorage.setItem('levo_ap_view', view);
    } catch {
      /* per-browser convenience only */
    }
  }, [view]);

  const band = PRICE_BANDS[priceBand];
  const pMin = priceMin !== '' ? Number(priceMin) || 0 : band?.min;
  const pMax = priceMax !== '' ? Number(priceMax) || 0 : band?.max;

  const load = useCallback(async () => {
    const seq = ++seqRef.current;
    setLoading(true);
    setLoadErr(null);
    try {
      const params = new URLSearchParams();
      params.set('limit', String(limit));
      params.set('offset', String((page - 1) * limit));
      if (query) params.set('search', query);
      if (status) params.set('status', status);
      if (brand) params.set('brand', brand);
      if (catalog) params.set('catalog', catalog);
      if (stockF) params.set('stock', stockF);
      if (pMin !== undefined) params.set('price_min', String(pMin));
      if (pMax !== undefined) params.set('price_max', String(pMax));
      if (days) params.set('days', days);
      if (featuredOnly) params.set('featured', '1');
      if (sort !== 'updated') params.set('sort', sort);
      const data = await api.get<ListingResponse>(`/api/admin/products-v2?${params.toString()}`);
      if (seq !== seqRef.current) return;
      // Deleting the last row of the last page must not strand the admin.
      const maxPage = Math.max(1, Math.ceil(data.total / limit));
      if (page > maxPage) {
        setPage(maxPage);
        return;
      }
      setTotal(data.total);
      setItems(data.products);
    } catch (e) {
      if (seq !== seqRef.current) return;
      setLoadErr(e instanceof ApiError ? e.message : t.loadFailed);
    } finally {
      if (seq === seqRef.current) setLoading(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [query, status, brand, catalog, stockF, pMin, pMax, days, featuredOnly, sort, page, limit]);

  useEffect(() => {
    load();
  }, [load]);

  const loadAux = useCallback(() => {
    api.get<AdminProductsStats>('/api/admin/products-v2/stats').then(setStats).catch(() => {});
    api.get<{ brands: Array<{ id: string; name_ar?: string; name?: string }> }>('/api/admin/products-v2/brands')
      .then((d) => setBrands(d.brands ?? []))
      .catch(() => {});
    api.get<{ catalogs: Array<{ id: string; name_ar?: string; name?: string }> }>('/api/admin/taxonomy/catalogs')
      .then((d) => setCatalogs(d.catalogs ?? []))
      .catch(() => {});
  }, []);
  useEffect(loadAux, [loadAux]);

  const reloadAll = useCallback(() => {
    load();
    loadAux();
  }, [load, loadAux]);

  // Stable identity: TemplateTools reports dirtiness from an effect, so a new
  // function every render would loop.
  const handleImportDirty = useCallback((d: boolean) => setImportDirty(d), []);
  const handleImportApplied = useCallback(() => {
    reloadAll();
  }, [reloadAll]);

  const closeImport = useCallback(() => {
    setImportOpen(false);
    setImportDirty(false);
  }, []);

  const handleDelete = async (p: ListingItem) => {
    const name = p.name_ar || p.name_en || p.id;
    const msg = dir === 'rtl'
      ? `حذف/أرشفة المنتج «${name}»؟ المنتجات المرتبطة بطلبات سابقة تُخفى بدل الحذف.`
      : `Delete/archive "${name}"? Products referenced by past orders are hidden, not deleted.`;
    if (!window.confirm(msg)) return;
    setDeletingId(p.id);
    setNotice(null);
    try {
      const res = await api.delete<DeleteResponse>(`/api/admin/products-v2/${p.id}`);
      setNotice(
        res.deleted
          ? (dir === 'rtl' ? `حُذف «${name}» نهائياً.` : `"${name}" was permanently deleted.`)
          : (dir === 'rtl'
              ? `أُخفي «${name}» بدل حذفه — ${res.reason ?? 'مرتبط بطلبات سابقة.'}`
              : `"${name}" was hidden instead of deleted — ${res.reason ?? 'referenced by past orders.'}`)
      );
      reloadAll();
    } catch (e) {
      setNotice(t.deleteFailed + (e instanceof ApiError ? e.message : 'unknown error'));
    } finally {
      setDeletingId(null);
    }
  };

  // The pinned legacy upsert accepts {id, status} — the safe quick toggle
  // (POST /products-v2 would demand the whole document).
  const quickStatus = async (p: ListingItem, next: 'active' | 'hidden') => {
    setBusyId(p.id);
    setMenuFor('');
    try {
      await api.post('/api/admin/products', { id: p.id, status: next });
      reloadAll();
    } catch (e) {
      setNotice(e instanceof ApiError ? e.message : 'error');
    } finally {
      setBusyId(null);
    }
  };

  const productUrl = (p: ListingItem) => `${window.location.origin}/product/${p.slug}`;

  const resetFilters = () => {
    setSearch(''); setQuery(''); setStatus(''); setBrand(''); setCatalog('');
    setStockF(''); setPriceBand(''); setPriceMin(''); setPriceMax('');
    setDays(''); setFeaturedOnly(false); setPage(1);
  };

  const anyFilter = !!(query || status || brand || catalog || stockF || days || featuredOnly || pMin !== undefined || pMax !== undefined);
  const from = total === 0 ? 0 : (page - 1) * limit + 1;
  const to = Math.min(page * limit, total);
  const pages = Math.max(1, Math.ceil(total / limit));
  const weekly = stats?.weekly ?? [];
  const activePct = stats && stats.totals.total > 0 ? Math.round((stats.totals.active / stats.totals.total) * 100) : 0;

  const selectCls =
    'h-10 rounded-lg bg-black/40 border border-zinc-700/60 px-2.5 text-zinc-200 text-[12px] outline-none focus:border-[#6B46FF]/60 min-w-0';

  const brandName = (b: { name_ar?: string; name?: string }) => b.name_ar || b.name || '';

  // ------------------------------------------------------------ editor mode

  if (editing.open) {
    return (
      <Suspense fallback={<LazyFallback label={t.loading} />}>
        <ProductForm
          productId={editing.id}
          onBack={() => setEditing({ open: false, id: null })}
          onListChanged={() => reloadAll()}
        />
      </Suspense>
    );
  }

  // ------------------------------------------------------------ list mode

  const rowActions = (p: ListingItem, compact = false) => (
    <div className="flex items-center gap-1">
      {!compact && (
        <button
          onClick={() => handleDelete(p)}
          disabled={deletingId === p.id}
          className="w-8 h-8 rounded-lg border border-red-500/25 bg-red-500/10 text-red-400 flex items-center justify-center disabled:opacity-50"
          title={t.del}
          aria-label={t.del}
        >
          <Trash2 className="w-3.5 h-3.5" />
        </button>
      )}
      <button
        data-action="edit"
        onClick={() => setEditing({ open: true, id: p.id })}
        className="w-8 h-8 rounded-lg border border-zinc-700/60 bg-white/[0.03] text-zinc-400 hover:text-white flex items-center justify-center"
        title={t.edit}
        aria-label={t.edit}
      >
        <Edit2 className="w-3.5 h-3.5" />
      </button>
      <div>
        <button
          onClick={(e) => {
            if (menuFor === p.id) {
              setMenuFor('');
              return;
            }
            const r = e.currentTarget.getBoundingClientRect();
            setMenuPos({
              top: Math.min(r.bottom + 4, Math.max(60, window.innerHeight - 220)),
              right: Math.max(8, window.innerWidth - r.right),
            });
            setMenuFor(p.id);
          }}
          className="w-8 h-8 rounded-lg border border-zinc-700/60 bg-white/[0.03] text-zinc-400 hover:text-white flex items-center justify-center"
          aria-label={loc('المزيد', 'More', 'زیاتر')}
        >
          <MoreHorizontal className="w-3.5 h-3.5" />
        </button>
        {menuFor === p.id && menuPos && (
          <>
            <div className="fixed inset-0 z-[135]" onClick={() => setMenuFor('')} />
            <div
              style={{ top: menuPos.top, right: menuPos.right }}
              className="fixed z-[140] w-52 rounded-xl border border-zinc-700/60 bg-[#131417] shadow-2xl overflow-hidden"
            >
              {p.status === 'active' ? (
                <MenuItem
                  icon={<EyeOff className="w-3.5 h-3.5" />}
                  label={loc('إخفاء من الموقع', 'Hide from the site', 'شاردنەوە')}
                  onClick={() => quickStatus(p, 'hidden')}
                  disabled={busyId === p.id}
                />
              ) : (
                <MenuItem
                  icon={<Eye className="w-3.5 h-3.5" />}
                  label={loc('نشر في الموقع', 'Publish to the site', 'بڵاوکردنەوە')}
                  onClick={() => quickStatus(p, 'active')}
                  disabled={busyId === p.id}
                />
              )}
              <MenuItem
                icon={<Link2 className="w-3.5 h-3.5" />}
                label={loc('فتح في الموقع', 'Open on the site', 'کردنەوە')}
                onClick={() => {
                  setMenuFor('');
                  window.open(productUrl(p), '_blank', 'noopener,noreferrer');
                }}
              />
              <MenuItem
                icon={<Copy className="w-3.5 h-3.5" />}
                label={loc('نسخ رابط المنتج', 'Copy product link', 'کۆپی بەستەر')}
                onClick={() => {
                  setMenuFor('');
                  navigator.clipboard?.writeText(productUrl(p)).catch(() => {});
                }}
              />
            </div>
          </>
        )}
      </div>
    </div>
  );

  return (
    <div className="min-w-0">
      {/* breadcrumb + title + actions */}
      <div className="text-zinc-500 text-[11.5px] mb-1">
        <span className="text-zinc-300 font-semibold">{t.breadcrumbA}</span>
        <span className="mx-1.5">/</span>
        {t.breadcrumbB}
      </div>
      <div className="flex items-start justify-between gap-3 flex-wrap mb-4">
        <div>
          <h2 className="text-white font-bold text-[21px] leading-tight">{t.title}</h2>
          <p className="text-zinc-500 text-[12px] mt-0.5">{t.subtitle}</p>
        </div>
        <div className="flex items-center gap-2 flex-wrap">
          <button
            onClick={() => setEditing({ open: true, id: null })}
            className="h-10 px-4 rounded-lg bg-indigo-500 hover:bg-indigo-600 text-white text-[12.5px] font-bold flex items-center gap-1.5 transition-colors"
          >
            <Plus className="w-4 h-4" strokeWidth={2.25} /> {t.newProduct}
          </button>
          <button data-testid="admin-import-open" onClick={() => setImportOpen(true)} className={btnSecondary}>
            <Upload className="w-4 h-4" /> {t.import}
          </button>
          <button
            onClick={reloadAll}
            className="h-10 w-10 rounded-lg border border-zinc-700/60 bg-white/[0.03] text-zinc-300 flex items-center justify-center"
            aria-label={loc('تحديث البيانات', 'Refresh', 'نوێکردنەوە')}
          >
            <RefreshCw className="w-4 h-4" strokeWidth={1.75} />
          </button>
        </div>
      </div>

      {/* stat cards — real aggregates; platform products have no view counter */}
      {stats && (
        <div className="grid grid-cols-2 sm:grid-cols-5 gap-2 mb-4">
          <StatCard
            tint="purple"
            icon={<ShoppingBag className="w-3.5 h-3.5" />}
            label={loc('المبيعات (30 يومًا)', 'Sales (30 days)', 'فرۆش (٣٠ ڕۆژ)')}
            value={stats.sales_30d.units.toLocaleString('en-US')}
            sub={loc(`عبر ${stats.sales_30d.orders} طلب`, `across ${stats.sales_30d.orders} orders`, `${stats.sales_30d.orders} داواکاری`)}
            series={stats.sales_daily.map((d) => d.units)}
          />
          <StatCard
            tint="blue"
            icon={<Package className="w-3.5 h-3.5" />}
            label={loc('إجمالي المنتجات', 'Total products', 'کۆی بەرهەمەکان')}
            value={String(stats.totals.total)}
            sub={loc('منتج في متجرك', 'products in your store', 'بەرهەم')}
            series={weekly.map((w) => w.added)}
          />
          <StatCard
            tint="green"
            icon={<Check className="w-3.5 h-3.5" />}
            label={loc('منتجات نشطة', 'Active products', 'چالاک')}
            value={String(stats.totals.active)}
            sub={loc(`${activePct}% من إجمالي المنتجات`, `${activePct}% of all products`, `${activePct}%`)}
            series={weekly.map((w) => w.active_added)}
          />
          <StatCard
            tint="amber"
            icon={<Pencil className="w-3.5 h-3.5" />}
            label={loc('مسودات', 'Drafts', 'ڕەشنووس')}
            value={String(stats.totals.draft)}
            sub={loc('بانتظار الإكمال', 'waiting to be finished', 'چاوەڕوانی تەواوکردن')}
            series={weekly.map((w) => w.draft_added)}
          />
          <StatCard
            tint="red"
            icon={<PackageX className="w-3.5 h-3.5" />}
            label={loc('مخفية', 'Hidden', 'شاراوە')}
            value={String(stats.totals.hidden)}
            sub={loc(`ونفد المخزون: ${stats.totals.out_of_stock}`, `out of stock: ${stats.totals.out_of_stock}`, `تەواو بوو: ${stats.totals.out_of_stock}`)}
            series={weekly.map((w) => w.hidden_added)}
          />
        </div>
      )}

      {/* filter bar */}
      <div className="rounded-xl border border-zinc-800/60 bg-zinc-900/30 p-2.5 space-y-2 mb-3">
        <div className="flex items-center gap-2 flex-wrap">
          <div className="relative flex-1 min-w-[170px]">
            <Search className="w-3.5 h-3.5 text-zinc-500 absolute top-1/2 -translate-y-1/2 start-2.5" />
            <input
              ref={searchRef}
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder={t.searchPlaceholder}
              aria-label={t.search}
              className="w-full h-10 rounded-lg bg-black/40 border border-zinc-700/60 ps-8 pe-8 text-white text-[12.5px] outline-none focus:border-[#6B46FF]/60"
            />
            <kbd className="absolute top-1/2 -translate-y-1/2 end-2 text-[9.5px] text-zinc-600 border border-zinc-700/60 rounded px-1 py-0.5 hidden sm:block" dir="ltr">⌘K</kbd>
          </div>
          {catalogs.length > 0 && (
            <select value={catalog} onChange={(e) => { setCatalog(e.target.value); setPage(1); }} className={selectCls}>
              <option value="">{loc('كل الأقسام', 'All sections', 'هەموو بەشەکان')}</option>
              {catalogs.map((cat) => (
                <option key={cat.id} value={cat.id}>{brandName(cat)}</option>
              ))}
            </select>
          )}
          <select value={status} onChange={(e) => { setStatus(e.target.value); setPage(1); }} className={selectCls}>
            <option value="">{loc('كل الحالات', 'All statuses', 'هەموو دۆخەکان')}</option>
            <option value="active">{loc('نشط', 'Active', 'چالاک')}</option>
            <option value="draft">{loc('مسودة', 'Draft', 'ڕەشنووس')}</option>
            <option value="hidden">{loc('مخفي', 'Hidden', 'شاراوە')}</option>
          </select>
          <select value={stockF} onChange={(e) => { setStockF(e.target.value); setPage(1); }} className={selectCls}>
            <option value="">{loc('كل المخزون', 'All stock', 'هەموو کۆگا')}</option>
            <option value="in">{loc('متوفر', 'In stock', 'بەردەست')}</option>
            <option value="low">{loc('منخفض', 'Low', 'کەم')}</option>
            <option value="out">{loc('نفد المخزون', 'Out of stock', 'تەواو بوو')}</option>
            <option value="untracked">{loc('غير محدود', 'Untracked', 'بێ سنوور')}</option>
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
            className={`h-10 px-3 rounded-lg border text-[12px] font-semibold flex items-center gap-1.5 ${
              advanced ? 'border-[#6B46FF]/60 text-[#a78bfa] bg-[#6B46FF]/10' : 'border-zinc-700/60 text-zinc-300 bg-white/[0.03]'
            }`}
          >
            <SlidersHorizontal className="w-3.5 h-3.5" />
            {loc('تصفية متقدمة', 'Advanced', 'فلتەری پێشکەوتوو')}
          </button>
        </div>
        {advanced && (
          <div className="flex items-center gap-2 flex-wrap pt-1 border-t border-zinc-800/60">
            <button
              onClick={() => { setFeaturedOnly((v) => !v); setPage(1); }}
              className={`h-8 px-3 rounded-full border text-[11.5px] font-semibold ${
                featuredOnly ? 'border-[#6B46FF]/60 text-[#a78bfa] bg-[#6B46FF]/10' : 'border-zinc-700/60 text-zinc-400'
              }`}
            >
              {loc('مميز فقط', 'Featured only', 'تەنیا تایبەت')}
            </button>
            {brands.length > 0 && (
              <select value={brand} onChange={(e) => { setBrand(e.target.value); setPage(1); }} className={selectCls}>
                <option value="">{loc('كل العلامات', 'All brands', 'هەموو براندەکان')}</option>
                {brands.map((b) => (
                  <option key={b.id} value={b.id}>{brandName(b)}</option>
                ))}
              </select>
            )}
            <input
              value={priceMin}
              onChange={(e) => { setPriceMin(e.target.value.replace(/[^\d]/g, '')); setPriceBand(''); setPage(1); }}
              placeholder={loc('السعر من', 'Price from', 'نرخ لە')}
              inputMode="numeric"
              className="h-10 w-24 rounded-lg bg-black/40 border border-zinc-700/60 px-2.5 text-white text-[12px] outline-none"
              dir="ltr"
            />
            <input
              value={priceMax}
              onChange={(e) => { setPriceMax(e.target.value.replace(/[^\d]/g, '')); setPriceBand(''); setPage(1); }}
              placeholder={loc('إلى', 'to', 'بۆ')}
              inputMode="numeric"
              className="h-10 w-24 rounded-lg bg-black/40 border border-zinc-700/60 px-2.5 text-white text-[12px] outline-none"
              dir="ltr"
            />
            <button onClick={resetFilters} className="h-8 px-3 rounded-lg text-[12px] text-zinc-400 border border-zinc-700/60 flex items-center gap-1">
              <X className="w-3 h-3" />
              {loc('إعادة التعيين', 'Reset', 'ڕێکخستنەوە')}
            </button>
          </div>
        )}
      </div>

      {/* toolbar */}
      <div className="flex items-center justify-between gap-2 flex-wrap mb-3">
        <div className="flex items-center gap-2">
          <span className="text-zinc-400 text-[11.5px]">
            {loc(`عرض ${from} - ${to} من ${total} ${t.unit}`, `Showing ${from}-${to} of ${total}`, `${from}-${to} لە ${total}`)}
          </span>
          <select
            value={String(limit)}
            onChange={(e) => { setLimit(Number(e.target.value)); setPage(1); }}
            className="h-10 rounded-lg bg-black/40 border border-zinc-700/60 px-2 text-zinc-300 text-[11.5px] outline-none"
          >
            {PAGE_SIZES.map((n) => (
              <option key={n} value={n}>{n}</option>
            ))}
          </select>
        </div>
        <div className="flex items-center gap-2">
          <select value={sort} onChange={(e) => { setSort(e.target.value); setPage(1); }} className={selectCls}>
            <option value="updated">{loc('آخر تحديث', 'Last updated', 'دوایین نوێکردنەوە')}</option>
            <option value="newest">{loc('الأحدث', 'Newest', 'نوێترین')}</option>
            <option value="oldest">{loc('الأقدم', 'Oldest', 'کۆنترین')}</option>
            <option value="price_asc">{loc('السعر: من الأقل', 'Price: low→high', 'نرخ ↑')}</option>
            <option value="price_desc">{loc('السعر: من الأعلى', 'Price: high→low', 'نرخ ↓')}</option>
            <option value="sales">{loc('الأكثر مبيعًا', 'Best selling', 'زۆرترین فرۆش')}</option>
            <option value="stock">{loc('المخزون الأقل', 'Lowest stock', 'کەمترین کۆگا')}</option>
          </select>
          <div className="flex rounded-lg border border-zinc-700/60 overflow-hidden">
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

      <ErrorBanner text={loadErr} />
      {notice && (
        <div className="bg-sky-500/10 border border-sky-500/30 text-sky-300 rounded-xl p-3 mb-3 text-sm">
          {notice}
        </div>
      )}

      {/* rows */}
      {loading && items.length === 0 ? (
        <LazyFallback label={t.loading} />
      ) : items.length === 0 && !loadErr ? (
        <div className="text-center py-10 text-zinc-500 bg-zinc-800/20 rounded-xl border border-zinc-800/50">
          {anyFilter || total > 0 ? t.noMatch : t.empty}
        </div>
      ) : view === 'grid' ? (
        <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-2.5">
          {items.map((p) => (
            <div key={p.id} data-product-id={p.id} className="rounded-xl border border-zinc-800/60 bg-zinc-900/30 overflow-hidden">
              <div className="aspect-square bg-zinc-900 relative">
                {p.image && <img referrerPolicy="no-referrer" src={p.image} alt="" className="w-full h-full object-cover" />}
                {p.is_featured && (
                  <span className="absolute top-1.5 start-1.5 w-5 h-5 rounded-full bg-black/60 flex items-center justify-center">
                    <Star className="w-3 h-3 text-[#a78bfa] fill-[#a78bfa]" />
                  </span>
                )}
              </div>
              <div className="p-2">
                <p className="text-white text-[12px] font-semibold truncate" dir="auto">{p.name_ar || p.name_en || p.slug}</p>
                <p className="text-zinc-300 text-[11.5px] mt-0.5"><span dir="ltr">{formatIqd(p.price_iqd || 0)}</span></p>
                <div className="flex items-center justify-between mt-1.5">
                  <StatusChip status={p.status} />
                  {rowActions(p, true)}
                </div>
              </div>
            </div>
          ))}
        </div>
      ) : view === 'compact' ? (
        <div className="rounded-xl border border-zinc-800/60 bg-zinc-900/30 divide-y divide-zinc-800/50">
          {items.map((p) => (
            <div key={p.id} data-product-id={p.id} className="flex items-center gap-2.5 px-2.5 py-2">
              <div className="w-8 h-8 rounded-lg bg-zinc-900 overflow-hidden shrink-0">
                {p.image && <img referrerPolicy="no-referrer" src={p.image} alt="" className="w-full h-full object-cover" />}
              </div>
              <span className="text-white text-[12px] font-medium truncate flex-1 min-w-0" dir="auto">
                {p.name_ar || p.name_en || p.slug}
              </span>
              <span className="text-zinc-300 text-[11.5px] shrink-0" dir="ltr">{formatIqd(p.price_iqd || 0)}</span>
              <StatusChip status={p.status} />
              {rowActions(p, true)}
            </div>
          ))}
        </div>
      ) : (
        <div className="rounded-xl border border-zinc-800/60 bg-zinc-900/30 overflow-x-auto">
          <table className="w-full min-w-[720px] border-collapse">
            <thead>
              <tr className="text-zinc-500 text-[11px] border-b border-zinc-800/60">
                <th className="text-start font-semibold px-3 py-2.5">{loc('المنتج', 'Product', 'بەرهەم')}</th>
                <th className="text-start font-semibold px-2 py-2.5">{t.price}</th>
                <th className="text-start font-semibold px-2 py-2.5">{t.stock}</th>
                <th className="text-start font-semibold px-2 py-2.5">{loc('الحالة', 'Status', 'دۆخ')}</th>
                <th className="text-start font-semibold px-2 py-2.5">{loc('المبيعات', 'Sales', 'فرۆش')}</th>
                <th className="text-start font-semibold px-2 py-2.5">{t.updated}</th>
                <th className="text-start font-semibold px-2 py-2.5">{loc('إجراءات', 'Actions', 'کردارەکان')}</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-zinc-800/50">
              {items.map((p) => {
                const available = p.stock === null ? null : p.stock - (p.stock_reserved ?? 0);
                return (
                  <tr key={p.id} data-product-id={p.id} className="hover:bg-white/[0.02]">
                    <td className="px-3 py-2.5">
                      <div className="flex items-center gap-2.5 min-w-0">
                        <div className="w-11 h-11 rounded-lg bg-zinc-900 overflow-hidden shrink-0 border border-zinc-800">
                          {p.image && <img referrerPolicy="no-referrer" src={p.image} alt="" className="w-full h-full object-cover" />}
                        </div>
                        <div className="min-w-0">
                          <p className="text-white text-[12.5px] font-semibold truncate max-w-[190px]" dir="auto">
                            {p.is_featured && <Star className="w-3 h-3 text-[#a78bfa] fill-[#a78bfa] inline me-1 -mt-0.5" />}
                            {p.name_ar || p.name_en || p.slug}
                          </p>
                          {p.name_en && p.name_ar && (
                            <p className="text-zinc-500 text-[10.5px] truncate max-w-[190px]" dir="ltr">{p.name_en}</p>
                          )}
                          <p className="text-zinc-600 text-[10px]">
                            <span dir="ltr">{p.sku ? p.sku : `#${p.id.slice(-6).toUpperCase()}`}</span>
                            {p.doc_version < 2 && (
                              <span className="ms-1.5 text-[9px] font-bold text-zinc-500 bg-zinc-800 px-1 py-0.5 rounded border border-zinc-700" title={t.v1Hint}>v1</span>
                            )}
                          </p>
                        </div>
                      </div>
                    </td>
                    <td className="px-2 py-2.5">
                      <p className="text-white text-[12.5px] font-bold whitespace-nowrap"><span dir="ltr">{formatIqd(p.price_iqd || 0)}</span></p>
                      {p.pro_price_iqd !== null && (
                        <p className="text-zinc-500 text-[10px] whitespace-nowrap">
                          PRO: <span dir="ltr">{formatIqd(p.pro_price_iqd)}</span>
                        </p>
                      )}
                    </td>
                    <td className="px-2 py-2.5">
                      {available === null ? (
                        <div>
                          <p className="text-zinc-300 text-[12.5px] font-bold">—</p>
                          <p className="text-zinc-500 text-[10px]">{t.untracked}</p>
                        </div>
                      ) : (
                        <div>
                          <p className={`text-[12.5px] font-bold ${available <= 0 ? 'text-red-400' : 'text-white'}`}><span dir="ltr">{available}</span></p>
                          <p className={`text-[10px] ${available <= 0 ? 'text-red-400/80' : 'text-zinc-500'}`}>
                            {available <= 0 ? loc('نفد المخزون', 'out of stock', 'تەواو بوو') : loc('متوفر', 'in stock', 'بەردەست')}
                          </p>
                        </div>
                      )}
                    </td>
                    <td className="px-2 py-2.5"><StatusChip status={p.status} /></td>
                    <td className="px-2 py-2.5">
                      <p className="text-white text-[12.5px] font-bold"><span dir="ltr">{p.sold ?? 0}</span></p>
                      <p className="text-zinc-500 text-[10px]">{loc('مبيع', 'sold', 'فرۆشراو')}</p>
                    </td>
                    <td className="px-2 py-2.5">
                      <p className="text-zinc-200 text-[11.5px] whitespace-nowrap">{relTime(p.updated_at, loc)}</p>
                      <p className="text-zinc-500 text-[10px]"><span dir="ltr">{fmtDate(p.updated_at)}</span></p>
                    </td>
                    <td className="px-2 py-2.5">{rowActions(p)}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {/* pagination */}
      {pages > 1 && (
        <div className="flex items-center justify-center gap-1.5 mt-4">
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

      {importOpen && (
        <Modal
          wide
          titleAr={STRINGS.ar.importTitle}
          titleEn={STRINGS.en.importTitle}
          onClose={closeImport}
          dirty={importTab === 'legacy' && importDirty}
        >
          <div className="flex gap-2 mb-4 border-b border-zinc-800 pb-2">
            {(['new', 'legacy'] as const).map((tab) => (
              <button
                key={tab}
                type="button"
                data-import-tab={tab}
                onClick={() => setImportTab(tab)}
                className={
                  'px-3 min-h-11 rounded-lg text-xs font-bold transition-colors ' +
                  (importTab === tab
                    ? 'bg-zinc-800 text-white border border-zinc-700'
                    : 'text-zinc-400 hover:text-white border border-transparent')
                }
              >
                {tab === 'new' ? t.tabNew : t.tabLegacy}
              </button>
            ))}
          </div>
          <Suspense fallback={<LazyFallback label={t.loading} />}>
            {importTab === 'new' ? (
              <ImportPanel onApplied={handleImportApplied} />
            ) : (
              <TemplateTools
                insideSection={false}
                onApplied={handleImportApplied}
                onDirtyChange={handleImportDirty}
              />
            )}
          </Suspense>
        </Modal>
      )}
    </div>
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
        active ? 'border-[#6B46FF]/60 bg-[#6B46FF]/15 text-[#a78bfa]' : 'border-zinc-700/60 text-zinc-400'
      }`}
    >
      {children}
    </button>
  );
}
