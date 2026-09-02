/**
 * Admin products (v2) — the owner's reference management screen on
 * /api/admin/products-v2: a compact top strip (breadcrumb + ⌘K quick-find),
 * title + actions, five stat cards with real sparkline series, a
 * server-side filter card (search, section, status, stock, price band,
 * recency, advanced: brand / manual price range / featured), a toolbar
 * (range, page size, sort, view switch), three view modes and numbered
 * pagination with an exact total.
 *
 * EVERY NUMBER IS REAL. Stats come from /products-v2/stats (weekly buckets
 * over created_at; sales from actual order lines, gross gated to financial
 * admins); platform products have no view counter, so none is shown. The
 * heavy editor body and the template import tools stay code-split via
 * React.lazy, and the import dialog carries the whole import/EXPORT surface.
 *
 * Visual system: adminProducts/theme.css (.ap tokens) + adminProducts/theme.ts
 * (class recipes). Text buttons are 36px, icon buttons 32px; selects keep
 * the 40px floor the §12 suites assert.
 *
 * LOAD-BEARING HOOKS (browser verification scripts depend on these at every
 * width): rows wrapped in [data-product-id] with a [data-action="edit"]
 * control in EVERY view mode; the header keeps
 * [data-testid="admin-import-open"]; the tab itself stays component state.
 */

import React, { Suspense, useCallback, useEffect, useRef, useState } from 'react';
import {
  Plus, Edit2, Trash2, Search, RefreshCw, Upload, Download, Star, LayoutGrid, List,
  AlignJustify, SlidersHorizontal, X, MoreHorizontal, Eye, EyeOff, Link2,
  Copy, ChevronRight, ChevronLeft, Package, PackageX, ShoppingBag, Check, Pencil,
  CalendarDays, Loader2, CornerDownLeft, ImageOff,
} from 'lucide-react';
import { api, ApiError, formatIqd } from '../lib/api';
import { useLanguage } from '../LanguageContext';
import type { ListingItem, ListingResponse, DeleteResponse } from './adminProducts/types';
import { Modal, ErrorBanner, fmtDate } from './adminProducts/ui';
import { Spark } from './ui/statCards';
import * as T from './adminProducts/theme';
import './adminProducts/theme.css';

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
    quickFind: 'ابحث عن منتج...',
    quickFindLabel: 'انتقال سريع إلى منتج',
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
    quickFind: 'Find a product…',
    quickFindLabel: 'Jump to a product',
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
    quickFind: 'بەرهەمێک بدۆزەرەوە...',
    quickFindLabel: 'چوونە سەر بەرهەم',
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
    <div className="flex items-center justify-center gap-2 text-[var(--ap-text-2)] py-12" role="status">
      <Loader2 className="w-4 h-4 animate-spin" /> {label}
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

type StockState = { key: 'untracked' | 'out' | 'low' | 'in'; available: number | null };
function stockState(p: ListingItem): StockState {
  if (p.stock === null) return { key: 'untracked', available: null };
  const available = p.stock - (p.stock_reserved ?? 0);
  if (available <= 0) return { key: 'out', available };
  if (available <= (p.low_stock_threshold ?? 5)) return { key: 'low', available };
  return { key: 'in', available };
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
  const [priceMinQ, setPriceMinQ] = useState('');
  const [priceMaxQ, setPriceMaxQ] = useState('');
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
  const [headerMenu, setHeaderMenu] = useState(false);
  const quickRef = useRef<HTMLInputElement>(null);
  const menuTriggerRef = useRef<HTMLElement | null>(null);
  const headerBtnRef = useRef<HTMLButtonElement>(null);
  const seqRef = useRef(0);

  // ⌘K / Ctrl+K opens the quick-find, like the reference top bar. Matched on
  // the physical key so an Arabic or Kurdish layout (where e.key is 'ن')
  // still works; ignored while a dialog owns the page, and a no-op (without
  // swallowing the browser's own Ctrl+K) while the editor has the strip
  // unmounted.
  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      if (!(e.metaKey || e.ctrlKey) || e.altKey || e.shiftKey) return;
      if (e.code !== 'KeyK' && e.key.toLowerCase() !== 'k') return;
      const input = quickRef.current;
      if (!input || document.querySelector('[aria-modal="true"]')) return;
      e.preventDefault();
      input.focus();
      input.select();
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

  // The manual price range commits on the same debounce as the search, so
  // typing "500000" does not fetch six intermediate result sets.
  useEffect(() => {
    const timer = setTimeout(() => {
      setPriceMinQ(priceMin);
      setPriceMaxQ(priceMax);
      setPage(1);
    }, 350);
    return () => clearTimeout(timer);
  }, [priceMin, priceMax]);

  const band = PRICE_BANDS[priceBand];
  const pMin = priceMinQ !== '' ? Number(priceMinQ) || 0 : band?.min;
  const pMax = priceMaxQ !== '' ? Number(priceMaxQ) || 0 : band?.max;

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

  // A status-only endpoint: the full-document save would demand (and the
  // legacy upsert would clobber) every other field of the product.
  const quickStatus = async (p: ListingItem, next: 'active' | 'hidden') => {
    setBusyId(p.id);
    setMenuFor('');
    try {
      await api.patch(`/api/admin/products-v2/${p.id}/status`, { status: next });
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
    setStockF(''); setPriceBand(''); setPriceMin(''); setPriceMax(''); setPriceMinQ(''); setPriceMaxQ('');
    setDays(''); setFeaturedOnly(false); setPage(1);
  };

  const anyFilter = !!(query || status || brand || catalog || stockF || days || featuredOnly || pMin !== undefined || pMax !== undefined);
  const from = total === 0 ? 0 : (page - 1) * limit + 1;
  const to = Math.min(page * limit, total);
  const pages = Math.max(1, Math.ceil(total / limit));
  const weekly = stats?.weekly ?? [];
  const activePct = stats && stats.totals.total > 0 ? Math.round((stats.totals.active / stats.totals.total) * 100) : 0;

  const brandName = (b: { name_ar?: string; name?: string }) => b.name_ar || b.name || '';
  const filterSel = `${T.select} max-w-[10.5rem]`;
  const brandById = new Map(brands.map((b) => [b.id, brandName(b)] as const));

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

  const stockLabel = (s: StockState) =>
    s.key === 'untracked' ? t.untracked
    : s.key === 'out' ? loc('نفد المخزون', 'out of stock', 'تەواو بوو')
    : s.key === 'low' ? loc('منخفض', 'low stock', 'کەم')
    : loc('متوفر', 'in stock', 'بەردەست');

  const rowActions = (p: ListingItem, compact = false) => (
    <div className="flex items-center gap-1.5">
      {!compact && (
        <button
          onClick={() => handleDelete(p)}
          disabled={deletingId === p.id}
          className={T.btnIconDanger}
          title={t.del}
          aria-label={t.del}
        >
          <Trash2 className="w-3.5 h-3.5" />
        </button>
      )}
      <button
        data-action="edit"
        onClick={() => setEditing({ open: true, id: p.id })}
        className={T.btnIcon}
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
            // Clamped on BOTH sides: in RTL the actions cluster sits at the
            // far left, and a panel anchored only by its right edge would
            // hang off-screen.
            setMenuPos({
              top: Math.min(r.bottom + 6, Math.max(60, window.innerHeight - 220)),
              right: Math.min(Math.max(8, window.innerWidth - r.right), Math.max(8, window.innerWidth - 232)),
            });
            menuTriggerRef.current = e.currentTarget;
            setMenuFor(p.id);
          }}
          className={T.btnIcon}
          aria-label={loc('المزيد', 'More', 'زیاتر')}
          aria-expanded={menuFor === p.id}
        >
          <MoreHorizontal className="w-3.5 h-3.5" />
        </button>
        {menuFor === p.id && menuPos && (
          <MenuPanel
            style={{ top: menuPos.top, right: menuPos.right }}
            className={T.menu}
            onClose={() => setMenuFor('')}
            returnTo={menuTriggerRef}
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
              {compact && (
                <MenuItem
                  icon={<Trash2 className="w-3.5 h-3.5" />}
                  label={t.del}
                  danger
                  onClick={() => {
                    setMenuFor('');
                    handleDelete(p);
                  }}
                />
              )}
          </MenuPanel>
        )}
      </div>
    </div>
  );

  const nameOf = (p: ListingItem) => p.name_ar || p.name_en || p.slug;
  const metaOf = (p: ListingItem) => {
    const parts: string[] = [];
    const b = p.brand_id ? brandById.get(p.brand_id) : '';
    if (b) parts.push(b);
    if (p.name_en && p.name_ar) parts.push(p.name_en);
    return parts.join(' • ');
  };

  return (
    <div className={T.AP} dir={dir}>
      {/* ---------------------------------------------------------- top strip */}
      <div className="flex items-center gap-3 flex-wrap mb-4">
        <nav className="text-[12px] text-[var(--ap-text-3)] flex items-center gap-1.5 shrink-0" aria-label="breadcrumb">
          <span className="text-[var(--ap-text-1)] font-semibold">{t.breadcrumbA}</span>
          <span className="text-[var(--ap-text-3)]">/</span>
          <span>{t.breadcrumbB}</span>
        </nav>
        <QuickFind
          inputRef={quickRef}
          placeholder={t.quickFind}
          label={t.quickFindLabel}
          onPick={(p) => setEditing({ open: true, id: p.id })}
          loc={loc}
          nameOf={nameOf}
        />
      </div>

      {/* ------------------------------------------------- title + actions */}
      <div className="flex items-start justify-between gap-3 flex-wrap mb-5">
        <div className="min-w-0">
          <h2 className="text-[21px] font-bold leading-7 tracking-tight text-[var(--ap-text-1)]">{t.title}</h2>
          <p className="text-[12.5px] text-[var(--ap-text-3)] mt-1">{t.subtitle}</p>
        </div>
        <div className="flex items-center gap-2 flex-wrap">
          <button onClick={() => setEditing({ open: true, id: null })} className={T.btnPrimary}>
            <Plus className="w-4 h-4" strokeWidth={2.25} /> {t.newProduct}
          </button>
          <button data-testid="admin-import-open" onClick={() => setImportOpen(true)} className={T.btnSecondary}>
            <Upload className="w-4 h-4" strokeWidth={1.9} /> {t.import}
          </button>
          <div className="relative">
            <button
              ref={headerBtnRef}
              onClick={() => setHeaderMenu((v) => !v)}
              className={T.btnIconLg}
              aria-label={loc('إجراءات إضافية', 'More actions', 'زیاتر')}
              aria-expanded={headerMenu}
              aria-haspopup="menu"
            >
              <MoreHorizontal className="w-4 h-4" />
            </button>
            {headerMenu && (
              <MenuPanel className={T.menuAnchored} onClose={() => setHeaderMenu(false)} returnTo={headerBtnRef}>
                  <MenuItem
                    icon={<RefreshCw className="w-3.5 h-3.5" />}
                    label={loc('تحديث البيانات', 'Refresh data', 'نوێکردنەوە')}
                    onClick={() => { setHeaderMenu(false); reloadAll(); }}
                  />
                  <MenuItem
                    icon={<Download className="w-3.5 h-3.5" />}
                    label={loc('تصدير المنتجات (CSV)', 'Export products (CSV)', 'هەناردە (CSV)')}
                    onClick={() => { setHeaderMenu(false); setImportTab('new'); setImportOpen(true); }}
                  />
                  <MenuItem
                    icon={<X className="w-3.5 h-3.5" />}
                    label={loc('إعادة تعيين التصفية', 'Reset filters', 'ڕێکخستنەوەی فلتەر')}
                    onClick={() => { setHeaderMenu(false); resetFilters(); }}
                    disabled={!anyFilter}
                  />
              </MenuPanel>
            )}
          </div>
        </div>
      </div>

      {/* ------------------------------------------------------- stat cards */}
      {stats && (
        <div className="grid grid-cols-2 lg:grid-cols-5 gap-3 mb-5 [&>:nth-child(5)]:col-span-2 lg:[&>:nth-child(5)]:col-span-1">
          <StatTile
            tint="purple"
            icon={<ShoppingBag className="w-4 h-4" />}
            label={loc('المبيعات (30 يومًا)', 'Sales (30 days)', 'فرۆش (٣٠ ڕۆژ)')}
            value={stats.sales_30d.units.toLocaleString('en-US')}
            sub={loc(`عبر ${stats.sales_30d.orders} طلب`, `across ${stats.sales_30d.orders} orders`, `${stats.sales_30d.orders} داواکاری`)}
            series={stats.sales_daily.map((d) => d.units)}
          />
          <StatTile
            tint="blue"
            icon={<Package className="w-4 h-4" />}
            label={loc('إجمالي المنتجات', 'Total products', 'کۆی بەرهەمەکان')}
            value={stats.totals.total.toLocaleString('en-US')}
            sub={loc('منتج في متجرك', 'products in your store', 'بەرهەم')}
            series={weekly.map((w) => w.added)}
          />
          <StatTile
            tint="green"
            icon={<Check className="w-4 h-4" />}
            label={loc('منتجات نشطة', 'Active products', 'چالاک')}
            value={stats.totals.active.toLocaleString('en-US')}
            sub={loc(`${activePct}% من إجمالي المنتجات`, `${activePct}% of all products`, `${activePct}%`)}
            series={weekly.map((w) => w.active_added)}
          />
          <StatTile
            tint="amber"
            icon={<Pencil className="w-4 h-4" />}
            label={loc('مسودات', 'Drafts', 'ڕەشنووس')}
            value={stats.totals.draft.toLocaleString('en-US')}
            sub={loc('بانتظار الإكمال', 'waiting to be finished', 'چاوەڕوانی تەواوکردن')}
            series={weekly.map((w) => w.draft_added)}
          />
          <StatTile
            tint="red"
            icon={<PackageX className="w-4 h-4" />}
            label={loc('مخفية', 'Hidden', 'شاراوە')}
            value={stats.totals.hidden.toLocaleString('en-US')}
            sub={loc(`ونفد المخزون: ${stats.totals.out_of_stock}`, `out of stock: ${stats.totals.out_of_stock}`, `تەواو بوو: ${stats.totals.out_of_stock}`)}
            series={weekly.map((w) => w.hidden_added)}
          />
        </div>
      )}

      {/* ------------------------------------------------------ filter card */}
      <div className={`${T.surface} p-3 mb-3`}>
        <div className="flex items-center gap-2 flex-wrap">
          <div className="relative flex-1 basis-[240px] min-w-[200px]">
            <Search className="w-4 h-4 text-[var(--ap-text-3)] absolute top-1/2 -translate-y-1/2 start-3 pointer-events-none" />
            <input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder={t.searchPlaceholder}
              aria-label={t.search}
              className={`${T.input} w-full ps-9 pe-3`}
            />
          </div>
          {catalogs.length > 0 && (
            <select value={catalog} onChange={(e) => { setCatalog(e.target.value); setPage(1); }} className={filterSel}>
              <option value="">{loc('كل الأقسام', 'All sections', 'هەموو بەشەکان')}</option>
              {catalogs.map((cat) => (
                <option key={cat.id} value={cat.id}>{brandName(cat)}</option>
              ))}
            </select>
          )}
          <select value={status} onChange={(e) => { setStatus(e.target.value); setPage(1); }} className={filterSel}>
            <option value="">{loc('كل الحالات', 'All statuses', 'هەموو دۆخەکان')}</option>
            <option value="active">{loc('نشط', 'Active', 'چالاک')}</option>
            <option value="draft">{loc('مسودة', 'Draft', 'ڕەشنووس')}</option>
            <option value="hidden">{loc('مخفي', 'Hidden', 'شاراوە')}</option>
          </select>
          <select value={stockF} onChange={(e) => { setStockF(e.target.value); setPage(1); }} className={filterSel}>
            <option value="">{loc('كل المخزون', 'All stock', 'هەموو کۆگا')}</option>
            <option value="in">{loc('متوفر', 'In stock', 'بەردەست')}</option>
            <option value="low">{loc('منخفض', 'Low', 'کەم')}</option>
            <option value="out">{loc('نفد المخزون', 'Out of stock', 'تەواو بوو')}</option>
            <option value="untracked">{loc('غير محدود', 'Untracked', 'بێ سنوور')}</option>
          </select>
          <select
            value={priceBand}
            onChange={(e) => { setPriceBand(e.target.value); setPriceMin(''); setPriceMax(''); setPage(1); }}
            className={filterSel}
          >
            <option value="">{loc('كل الأسعار', 'All prices', 'هەموو نرخەکان')}</option>
            <option value="b1">{loc('أقل من 25,000', 'Under 25,000', '< 25,000')}</option>
            <option value="b2">25,000 - 100,000</option>
            <option value="b3">100,000 - 500,000</option>
            <option value="b4">{loc('أكثر من 500,000', 'Over 500,000', '> 500,000')}</option>
          </select>
          <div className="relative">
            <CalendarDays className="w-3.5 h-3.5 text-[var(--ap-text-3)] absolute top-1/2 -translate-y-1/2 end-8 pointer-events-none" />
            <select value={days} onChange={(e) => { setDays(e.target.value); setPage(1); }} className={`${filterSel} ap-select--icon`}>
              <option value="">{loc('اختر الفترة', 'Any period', 'هەموو ماوەکان')}</option>
              <option value="7">{loc('آخر 7 أيام', 'Last 7 days', '٧ ڕۆژ')}</option>
              <option value="30">{loc('آخر 30 يومًا', 'Last 30 days', '٣٠ ڕۆژ')}</option>
              <option value="90">{loc('آخر 90 يومًا', 'Last 90 days', '٩٠ ڕۆژ')}</option>
            </select>
          </div>
          <button
            onClick={() => setAdvanced((v) => !v)}
            className={`${T.btnFilter} ms-auto`}
            aria-pressed={advanced}
          >
            <SlidersHorizontal className="w-3.5 h-3.5" />
            {loc('تصفية متقدمة', 'Advanced', 'فلتەری پێشکەوتوو')}
          </button>
        </div>
        {advanced && (
          <div className="flex items-center gap-2 flex-wrap pt-3 mt-3 border-t border-[var(--ap-hairline)]">
            <button
              onClick={() => { setFeaturedOnly((v) => !v); setPage(1); }}
              className={T.chip}
              aria-pressed={featuredOnly}
            >
              <Star className={`w-3 h-3 ${featuredOnly ? 'fill-current' : ''}`} />
              {loc('مميز فقط', 'Featured only', 'تەنیا تایبەت')}
            </button>
            {brands.length > 0 && (
              <select value={brand} onChange={(e) => { setBrand(e.target.value); setPage(1); }} className={T.select}>
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
              className={`${T.input} w-28`}
              dir="ltr"
            />
            <input
              value={priceMax}
              onChange={(e) => { setPriceMax(e.target.value.replace(/[^\d]/g, '')); setPriceBand(''); setPage(1); }}
              placeholder={loc('إلى', 'to', 'بۆ')}
              inputMode="numeric"
              className={`${T.input} w-28`}
              dir="ltr"
            />
            <button onClick={resetFilters} className={T.btnGhostSm}>
              <X className="w-3 h-3" />
              {loc('إعادة التعيين', 'Reset', 'ڕێکخستنەوە')}
            </button>
          </div>
        )}
      </div>

      {/* ---------------------------------------------------------- toolbar */}
      <div className="flex items-center justify-between gap-2 flex-wrap mb-3">
        <div className="flex items-center gap-2">
          <span className="text-[12px] text-[var(--ap-text-2)]">
            {loc(`عرض ${from} - ${to} من ${total} ${t.unit}`, `Showing ${from}-${to} of ${total}`, `${from}-${to} لە ${total}`)}
          </span>
          <select
            value={String(limit)}
            onChange={(e) => { setLimit(Number(e.target.value)); setPage(1); }}
            className={T.selectSm}
            aria-label={loc('حجم الصفحة', 'Page size', 'قەبارەی پەڕە')}
          >
            {PAGE_SIZES.map((n) => (
              <option key={n} value={n}>{n}</option>
            ))}
          </select>
        </div>
        <div className="flex items-center gap-2">
          <select value={sort} onChange={(e) => { setSort(e.target.value); setPage(1); }} className={T.selectSm} aria-label={loc('الترتيب', 'Sort', 'ڕیزکردن')}>
            <option value="updated">{loc('آخر تحديث', 'Last updated', 'دوایین نوێکردنەوە')}</option>
            <option value="newest">{loc('الأحدث', 'Newest', 'نوێترین')}</option>
            <option value="oldest">{loc('الأقدم', 'Oldest', 'کۆنترین')}</option>
            <option value="price_asc">{loc('السعر: من الأقل', 'Price: low→high', 'نرخ ↑')}</option>
            <option value="price_desc">{loc('السعر: من الأعلى', 'Price: high→low', 'نرخ ↓')}</option>
            <option value="sales">{loc('الأكثر مبيعًا', 'Best selling', 'زۆرترین فرۆش')}</option>
            <option value="stock">{loc('المخزون الأقل', 'Lowest stock', 'کەمترین کۆگا')}</option>
          </select>
          <div className={T.segmented.base} role="group" aria-label={loc('طريقة العرض', 'View', 'شێوازی پیشاندان')}>
            {(
              [
                ['grid', <LayoutGrid key="g" className="w-3.5 h-3.5" />, loc('شبكة', 'Grid', 'تۆڕ')],
                ['list', <List key="l" className="w-3.5 h-3.5" />, loc('جدول', 'Table', 'خشتە')],
                ['compact', <AlignJustify key="c" className="w-3.5 h-3.5" />, loc('مضغوط', 'Compact', 'چڕ')],
              ] as Array<[View, React.ReactNode, string]>
            ).map(([v, icon, name]) => (
              <button
                key={v}
                onClick={() => setView(v)}
                className={T.segmented.item}
                aria-label={name}
                title={name}
                aria-pressed={view === v}
              >
                {icon}
              </button>
            ))}
          </div>
        </div>
      </div>

      <ErrorBanner text={loadErr} />
      {notice && (
        <div className="rounded-[var(--ap-radius-md)] border border-[var(--ap-info-border)] bg-[var(--ap-info-bg)] text-[var(--ap-info)] ps-3 pe-1.5 py-1.5 mb-3 text-[13px] flex items-center justify-between gap-3" role="status">
          <span className="py-1">{notice}</span>
          <button onClick={() => setNotice(null)} className={T.btnIconGhost} aria-label={loc('إغلاق', 'Close', 'داخستن')}>
            <X className="w-3.5 h-3.5" />
          </button>
        </div>
      )}

      {/* ------------------------------------------------------------- rows */}
      {loading && items.length === 0 ? (
        <LazyFallback label={t.loading} />
      ) : items.length === 0 && !loadErr ? (
        <div className={`${T.surface} text-center py-14 px-4`}>
          <div className="w-11 h-11 rounded-[12px] bg-[var(--ap-surface-3)] border border-[var(--ap-border)] flex items-center justify-center mx-auto mb-3">
            <Package className="w-5 h-5 text-[var(--ap-text-3)]" />
          </div>
          <p className="text-[13.5px] font-semibold text-[var(--ap-text-1)]">{anyFilter || total > 0 ? t.noMatch : t.empty}</p>
          {anyFilter ? (
            <button onClick={resetFilters} className={`${T.btnGhost} mt-3`}>
              <X className="w-3.5 h-3.5" />
              {loc('إعادة تعيين التصفية', 'Reset filters', 'ڕێکخستنەوە')}
            </button>
          ) : total === 0 ? (
            <button onClick={() => setEditing({ open: true, id: null })} className={`${T.btnPrimary} mt-3`}>
              <Plus className="w-4 h-4" /> {t.newProduct}
            </button>
          ) : null}
        </div>
      ) : view === 'grid' ? (
        <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-3">
          {items.map((p) => {
            const s = stockState(p);
            return (
              <div key={p.id} data-product-id={p.id} className={`${T.surface} overflow-hidden group`}>
                <div className="aspect-square bg-[var(--ap-surface-3)] relative flex items-center justify-center">
                  {p.image ? (
                    <img referrerPolicy="no-referrer" src={p.image} alt="" className="w-full h-full object-cover" />
                  ) : (
                    <ImageOff className="w-6 h-6 text-[var(--ap-text-3)]" />
                  )}
                  {p.is_featured && (
                    <span className="absolute top-2 start-2 w-6 h-6 rounded-full bg-[rgba(10,11,15,0.7)] backdrop-blur flex items-center justify-center">
                      <Star className="w-3 h-3 text-[var(--ap-accent-text)] fill-current" />
                    </span>
                  )}
                  <span className={`absolute top-2 end-2 ${T.badgeBed}`}><Badge status={p.status} /></span>
                </div>
                <div className="p-3">
                  <p className="text-[13px] font-semibold truncate text-[var(--ap-text-1)]" dir="auto">{nameOf(p)}</p>
                  <div className="flex items-center justify-between gap-2 mt-1">
                    <span className="text-[13px] font-bold text-[var(--ap-text-1)]"><span dir="ltr">{formatIqd(p.price_iqd || 0)}</span></span>
                    <span className={`text-[11px] ${s.key === 'out' ? 'text-[var(--ap-danger)]' : s.key === 'low' ? 'text-[var(--ap-warning)]' : 'text-[var(--ap-text-3)]'}`}>
                      {s.available === null ? t.untracked : <><span dir="ltr">{s.available}</span> {stockLabel(s)}</>}
                    </span>
                  </div>
                  <div className="flex items-center justify-between gap-2 mt-2.5 pt-2.5 border-t border-[var(--ap-hairline)]">
                    <span className="text-[11px] text-[var(--ap-text-3)]"><span dir="ltr">{p.sold ?? 0}</span> {loc('مبيع', 'sold', 'فرۆشراو')}</span>
                    {rowActions(p, true)}
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      ) : view === 'compact' ? (
        <div className={`${T.surface} divide-y divide-[var(--ap-hairline)]`}>
          {items.map((p) => {
            const s = stockState(p);
            return (
              <div key={p.id} data-product-id={p.id} className={`flex items-center gap-3 px-3 h-12 ${T.tableRow}`}>
                <Thumb p={p} size="w-8 h-8" />
                <span className="text-[13px] font-medium truncate flex-1 min-w-0 text-[var(--ap-text-1)]" dir="auto">{nameOf(p)}</span>
                <span className="hidden sm:inline text-[12px] text-[var(--ap-text-3)] shrink-0" dir="ltr">{p.sku || `#${p.id.slice(-6).toUpperCase()}`}</span>
                <span
                  className={`hidden md:inline text-[12px] shrink-0 ${s.key === 'out' ? 'text-[var(--ap-danger)] font-semibold' : s.key === 'low' ? 'text-[var(--ap-warning)] font-semibold' : 'text-[var(--ap-text-2)]'}`}
                  title={`${t.stock}: ${stockLabel(s)}`}
                  aria-label={`${t.stock}: ${s.available === null ? t.untracked : `${s.available} — ${stockLabel(s)}`}`}
                >
                  {s.available === null ? '—' : <span dir="ltr">{s.available}</span>}
                </span>
                <span className="text-[13px] font-semibold text-[var(--ap-text-1)] shrink-0" dir="ltr">{formatIqd(p.price_iqd || 0)}</span>
                <Badge status={p.status} />
                {rowActions(p, true)}
              </div>
            );
          })}
        </div>
      ) : (
        <div className={`${T.surface} overflow-x-auto`}>
          <table className="w-full min-w-[760px] border-collapse">
            <thead>
              <tr className={T.tableHead}>
                <th className="text-start font-semibold px-4 py-2.5">{loc('المنتج', 'Product', 'بەرهەم')}</th>
                <th className="text-start font-semibold px-3 py-2.5">{t.price}</th>
                <th className="text-start font-semibold px-3 py-2.5">{t.stock}</th>
                <th className="text-start font-semibold px-3 py-2.5">{loc('الحالة', 'Status', 'دۆخ')}</th>
                <th className="text-start font-semibold px-3 py-2.5">{loc('المبيعات', 'Sales', 'فرۆش')}</th>
                <th className="text-start font-semibold px-3 py-2.5">{t.updated}</th>
                <th className="text-end font-semibold px-4 py-2.5">{loc('إجراءات', 'Actions', 'کردارەکان')}</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-[var(--ap-hairline)]">
              {items.map((p) => {
                const s = stockState(p);
                const meta = metaOf(p);
                return (
                  <tr key={p.id} data-product-id={p.id} className={T.tableRow}>
                    <td className="px-4 py-3">
                      <div className="flex items-center gap-3 min-w-0">
                        <Thumb p={p} size="w-12 h-12" />
                        <div className="min-w-0">
                          <p className="text-[13.5px] font-semibold truncate max-w-[220px] text-[var(--ap-text-1)]" dir="auto">
                            {p.is_featured && <Star className="w-3 h-3 text-[var(--ap-accent-text)] fill-current inline me-1 -mt-0.5" />}
                            {nameOf(p)}
                          </p>
                          {meta && (
                            <p className="text-[12px] text-[var(--ap-text-2)] truncate max-w-[220px] mt-0.5" dir="auto">{meta}</p>
                          )}
                          <p className="text-[11px] text-[var(--ap-text-3)] mt-0.5">
                            <span dir="ltr">{p.sku ? p.sku : `#${p.id.slice(-6).toUpperCase()}`}</span>
                            {p.doc_version < 2 && (
                              <span className={`${T.kbdTiny} ms-1.5`} title={t.v1Hint}>v1</span>
                            )}
                          </p>
                        </div>
                      </div>
                    </td>
                    <td className="px-3 py-3">
                      <p className="text-[13.5px] font-bold whitespace-nowrap text-[var(--ap-text-1)]"><span dir="ltr">{formatIqd(p.price_iqd || 0)}</span></p>
                      {p.pro_price_iqd !== null && (
                        <p className="text-[11px] text-[var(--ap-text-3)] whitespace-nowrap mt-0.5">
                          PRO <span dir="ltr">{formatIqd(p.pro_price_iqd)}</span>
                        </p>
                      )}
                    </td>
                    <td className="px-3 py-3">
                      <p className={`text-[13.5px] font-bold ${s.key === 'out' ? 'text-[var(--ap-danger)]' : s.key === 'low' ? 'text-[var(--ap-warning)]' : 'text-[var(--ap-text-1)]'}`}>
                        {s.available === null ? '—' : <span dir="ltr">{s.available}</span>}
                      </p>
                      <p className={`text-[11px] mt-0.5 ${s.key === 'out' ? 'text-[var(--ap-danger)]' : s.key === 'low' ? 'text-[var(--ap-warning)]' : 'text-[var(--ap-text-3)]'}`}>
                        {stockLabel(s)}
                      </p>
                    </td>
                    <td className="px-3 py-3"><Badge status={p.status} /></td>
                    <td className="px-3 py-3">
                      <p className="text-[13.5px] font-bold text-[var(--ap-text-1)]"><span dir="ltr">{p.sold ?? 0}</span></p>
                      <p className="text-[11px] text-[var(--ap-text-3)] mt-0.5">{loc('مبيع', 'sold', 'فرۆشراو')}</p>
                    </td>
                    <td className="px-3 py-3">
                      <p className="text-[12.5px] text-[var(--ap-text-1)] whitespace-nowrap">{relTime(p.updated_at, loc)}</p>
                      <p className="text-[11px] text-[var(--ap-text-3)] mt-0.5"><span dir="ltr">{fmtDate(p.updated_at)}</span></p>
                    </td>
                    <td className="px-4 py-3">
                      <div className="flex justify-end">{rowActions(p)}</div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {/* ------------------------------------------------------- pagination */}
      {pages > 1 && (
        <div className="flex items-center justify-between gap-2 flex-wrap mt-4">
          <span className="text-[12px] text-[var(--ap-text-3)]">
            {loc(`صفحة ${page} من ${pages}`, `Page ${page} of ${pages}`, `پەڕە ${page} لە ${pages}`)}
          </span>
          <div className="flex items-center gap-1.5">
            <PageBtn onClick={() => setPage((p) => Math.max(1, p - 1))} disabled={page === 1}>
              <ChevronRight className="w-3.5 h-3.5 ltr:rotate-180" />
            </PageBtn>
            {Array.from({ length: pages }, (_, i) => i + 1)
              .filter((n) => n === 1 || n === pages || Math.abs(n - page) <= 1)
              .map((n, i, arr) => (
                <span key={n} className="flex items-center gap-1.5">
                  {i > 0 && arr[i - 1] !== n - 1 && <span className="text-[var(--ap-text-3)] text-[11px] px-0.5">…</span>}
                  <PageBtn onClick={() => setPage(n)} active={n === page}>{n}</PageBtn>
                </span>
              ))}
            <PageBtn onClick={() => setPage((p) => Math.min(pages, p + 1))} disabled={page === pages}>
              <ChevronLeft className="w-3.5 h-3.5 ltr:rotate-180" />
            </PageBtn>
          </div>
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


// ----------------------------------------------------------------- pieces

function Thumb({ p, size }: { p: ListingItem; size: string }) {
  return (
    <div className={`${T.thumb} ${size} flex items-center justify-center`}>
      {p.image ? (
        <img referrerPolicy="no-referrer" src={p.image} alt="" className="w-full h-full object-cover" />
      ) : (
        <ImageOff className="w-4 h-4 text-[var(--ap-text-3)]" />
      )}
    </div>
  );
}

function Badge({ status }: { status: string }) {
  const { loc } = useLanguage();
  const key = status === 'active' ? 'active' : status === 'hidden' ? 'hidden' : 'draft';
  const label = key === 'active' ? loc('نشط', 'Active', 'چالاک') : key === 'hidden' ? loc('مخفي', 'Hidden', 'شاراوە') : loc('مسودة', 'Draft', 'ڕەشنووس');
  return (
    <span className={`${T.badgeBase} ${T.badge[key]}`}>
      <span className="w-1.5 h-1.5 rounded-full bg-current" aria-hidden />
      {label}
    </span>
  );
}

function StatTile({
  tint, icon, label, value, sub, series,
}: {
  tint: 'purple' | 'blue' | 'green' | 'amber' | 'red';
  icon: React.ReactNode;
  label: string;
  value: string;
  sub: string;
  series: number[];
}) {
  const c = T.statCard.tints[tint];
  return (
    <div className={T.statCard.base}>
      <div className="flex items-center justify-between gap-2">
        <span className="text-[12px] font-medium text-[var(--ap-text-2)] leading-snug line-clamp-2">{label}</span>
        <span className={`w-8 h-8 rounded-[9px] flex items-center justify-center shrink-0 ${c.box}`}>{icon}</span>
      </div>
      <div className="mt-2.5 text-[22px] font-bold leading-7 tracking-tight text-[var(--ap-text-1)]">
        <span dir="ltr">{value}</span>
      </div>
      <div className="mt-1.5 text-[11.5px] leading-snug text-[var(--ap-text-3)] line-clamp-2">{sub}</div>
      <div className="mt-auto pt-3 -mb-1 opacity-90">
        <Spark series={series} className={c.spark} />
      </div>
    </div>
  );
}

/**
 * The top-strip quick-find: a ⌘K palette over the same listing endpoint.
 * Typing shows the closest matches (name / SKU / slug); ↑↓ + Enter opens the
 * product in the editor. It never filters the table — that is the filter
 * card's search — so the two never fight over one piece of state.
 */
function QuickFind({
  inputRef, placeholder, label, onPick, loc, nameOf,
}: {
  inputRef: React.RefObject<HTMLInputElement | null>;
  placeholder: string;
  label: string;
  onPick: (p: ListingItem) => void;
  loc: Loc;
  nameOf: (p: ListingItem) => string;
}) {
  const [q, setQ] = useState('');
  const [open, setOpen] = useState(false);
  const [rows, setRows] = useState<ListingItem[]>([]);
  const [idx, setIdx] = useState(0);
  const [busy, setBusy] = useState(false);
  // The term the current rows answer, and whether that answer was an error —
  // so "no matches" is only ever said about a search that actually ran.
  const [settled, setSettled] = useState<{ term: string; failed: boolean } | null>(null);
  const seq = useRef(0);

  useEffect(() => {
    const term = q.trim();
    const s = ++seq.current;
    if (!term) {
      setRows([]);
      setSettled(null);
      setBusy(false);
      return;
    }
    setBusy(true);
    const timer = setTimeout(() => {
      api.get<ListingResponse>(`/api/admin/products-v2?search=${encodeURIComponent(term)}&limit=8`)
        .then((d) => {
          if (s !== seq.current) return;
          setRows(d.products);
          setIdx(0);
          setSettled({ term, failed: false });
        })
        .catch(() => {
          if (s !== seq.current) return;
          setRows([]);
          setSettled({ term, failed: true });
        })
        .finally(() => {
          if (s === seq.current) setBusy(false);
        });
    }, 250);
    return () => clearTimeout(timer);
  }, [q]);

  const pick = (p: ListingItem | undefined) => {
    if (!p) return;
    setOpen(false);
    setQ('');
    inputRef.current?.blur();
    onPick(p);
  };

  const term = q.trim();
  const showList = open && term.length > 0;
  const hasRows = showList && rows.length > 0;
  const optionId = (i: number) => `ap-quickfind-opt-${i}`;

  return (
    <div className="relative flex-1 min-w-[220px] max-w-xl">
      <Search className="w-4 h-4 text-[var(--ap-text-3)] absolute top-1/2 -translate-y-1/2 start-3 pointer-events-none" />
      <input
        ref={inputRef}
        value={q}
        onChange={(e) => {
          const v = e.target.value;
          setQ(v);
          setOpen(true);
          // Flagged in the same batch as the keystroke, so the first paint
          // after typing never shows "no matches" for a search not yet run.
          if (v.trim()) setBusy(true);
        }}
        onFocus={() => setOpen(true)}
        onBlur={() => setTimeout(() => setOpen(false), 120)}
        onKeyDown={(e) => {
          if (e.key === 'ArrowDown') { e.preventDefault(); setIdx((i) => Math.min(rows.length - 1, i + 1)); }
          else if (e.key === 'ArrowUp') { e.preventDefault(); setIdx((i) => Math.max(0, i - 1)); }
          else if (e.key === 'Enter') { e.preventDefault(); pick(rows[idx]); }
          else if (e.key === 'Escape') { setOpen(false); inputRef.current?.blur(); }
        }}
        placeholder={placeholder}
        aria-label={label}
        role="combobox"
        aria-autocomplete="list"
        aria-haspopup="listbox"
        aria-expanded={showList}
        aria-controls={hasRows ? 'ap-quickfind-list' : undefined}
        aria-activedescendant={hasRows ? optionId(idx) : undefined}
        className={`${T.input.replace('h-10 ', '')} h-9 w-full ps-9 pe-12`}
      />
      <span className="absolute top-1/2 -translate-y-1/2 end-2 hidden sm:inline-flex pointer-events-none">
        {busy ? <Loader2 className="w-3.5 h-3.5 animate-spin text-[var(--ap-text-3)]" /> : <kbd className={T.kbd} dir="ltr">⌘K</kbd>}
      </span>
      {showList && (
        <div className={`${T.surfaceRaised} absolute top-full mt-1.5 inset-x-0 z-[130] overflow-hidden py-1`}>
          {rows.length === 0 ? (
            <div className="px-3 py-3 text-[12.5px] text-[var(--ap-text-3)]" role="status">
              {settled?.term === term && settled.failed
                ? loc('تعذّر البحث، حاول مجددًا', 'Search failed, try again', 'گەڕان شکستی هێنا')
                : settled?.term === term && !busy
                  ? loc('لا نتائج', 'No matches', 'هیچ ئەنجامێک')
                  : loc('جارٍ البحث…', 'Searching…', 'گەڕان…')}
            </div>
          ) : (
            <div id="ap-quickfind-list" role="listbox" aria-label={label}>
              {rows.map((p, i) => (
                <button
                  key={p.id}
                  id={optionId(i)}
                  type="button"
                  role="option"
                  tabIndex={-1}
                  aria-selected={i === idx}
                  onMouseDown={(e) => e.preventDefault()}
                  onMouseEnter={() => setIdx(i)}
                  onClick={() => pick(p)}
                  className={`w-full flex items-center gap-3 px-3 h-11 text-start ${i === idx ? 'bg-[var(--ap-surface-3)]' : ''}`}
                >
                  <span className={`${T.thumb} w-7 h-7 flex items-center justify-center`}>
                    {p.image ? <img referrerPolicy="no-referrer" src={p.image} alt="" className="w-full h-full object-cover" /> : <ImageOff className="w-3 h-3 text-[var(--ap-text-3)]" />}
                  </span>
                  <span className="flex-1 min-w-0">
                    <span className="block text-[13px] font-medium truncate text-[var(--ap-text-1)]" dir="auto">{nameOf(p)}</span>
                    <span className="block text-[11px] text-[var(--ap-text-3)] truncate">
                      <span dir="ltr">{p.sku || p.slug} · {formatIqd(p.price_iqd || 0)}</span>
                    </span>
                  </span>
                  <Badge status={p.status} />
                  {i === idx && <CornerDownLeft className="w-3.5 h-3.5 text-[var(--ap-text-3)] shrink-0" />}
                </button>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

const menuItemsOf = (root: HTMLElement | null) =>
  Array.from(root?.querySelectorAll<HTMLButtonElement>('[role="menuitem"]:not(:disabled)') ?? []);

/**
 * A role="menu" panel that keeps the promise the role makes to assistive
 * tech: focus lands on the first item as it opens, ↑↓ / Home / End walk the
 * enabled items, Escape closes and returns focus to the trigger, Tab closes
 * and lets focus continue from the trigger. Clicking the backdrop closes.
 */
function MenuPanel({
  className, style, onClose, returnTo, children,
}: {
  className: string;
  style?: React.CSSProperties;
  onClose: () => void;
  returnTo: React.RefObject<HTMLElement | null>;
  children: React.ReactNode;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    menuItemsOf(ref.current)[0]?.focus();
  }, []);
  return (
    <>
      <div className="fixed inset-0 z-[135]" onClick={onClose} />
      <div
        ref={ref}
        style={style}
        className={className}
        role="menu"
        onKeyDown={(e) => {
          const list = menuItemsOf(ref.current);
          const at = list.indexOf(document.activeElement as HTMLButtonElement);
          if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
            e.preventDefault();
            if (list.length === 0) return;
            const step = e.key === 'ArrowDown' ? 1 : -1;
            list[(at + step + list.length) % list.length].focus();
          } else if (e.key === 'Home' || e.key === 'End') {
            e.preventDefault();
            (e.key === 'Home' ? list[0] : list[list.length - 1])?.focus();
          } else if (e.key === 'Escape') {
            e.preventDefault();
            e.stopPropagation();
            onClose();
            returnTo.current?.focus();
          } else if (e.key === 'Tab') {
            onClose();
            returnTo.current?.focus();
          }
        }}
      >
        {children}
      </div>
    </>
  );
}

function MenuItem({
  icon, label, onClick, disabled, danger,
}: {
  icon: React.ReactNode;
  label: string;
  onClick: () => void;
  disabled?: boolean;
  danger?: boolean;
}) {
  return (
    <button onClick={onClick} disabled={disabled} className={danger ? T.menuItemDanger : T.menuItem} role="menuitem">
      <span className={danger ? 'text-[var(--ap-danger)]' : 'text-[var(--ap-text-3)]'}>{icon}</span>
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
    <button onClick={onClick} disabled={disabled} className={T.pageBtn} aria-current={active ? 'page' : undefined}>
      {children}
    </button>
  );
}
