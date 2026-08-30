/**
 * Admin products (v2) — listing + editor on /api/admin/products-v2.
 * The heavy editor body and the template import tools are code-split via
 * React.lazy. Trilingual component-local STRINGS (ar default, en, ckb),
 * honest states throughout (archive vs delete, stale edits, disabled
 * previews).
 *
 * §6.2 density: one consistent scale — smaller headings/paddings/cards, real
 * min-w-0 / minmax(0,1fr) columns and CSS logical properties, so the list
 * fits an iPad beside the dashboard sidebar WITHOUT a page-wide
 * transform:scale or arbitrary font shrinking. The import dialog renders
 * through the portal in adminProducts/ui.tsx, and unapplied template text
 * warns before the dialog is dismissed.
 */

import React, { Suspense, useCallback, useEffect, useState } from 'react';
import { Plus, Edit2, Trash2, Search, RefreshCw, Upload, Star } from 'lucide-react';
import { api, ApiError, formatIqd } from '../lib/api';
import { useLanguage } from '../LanguageContext';
import type { ListingItem, ListingResponse, DeleteResponse } from './adminProducts/types';
import { StatusChip, Modal, ErrorBanner, btnPrimary, btnSecondary, inputCls, fmtDate } from './adminProducts/ui';

// The rebuilt eight-section form (product-form mandate §1). The previous
// ProductEditor is gone: it carried the ar/ckb fields §3 removes, the
// compare-at price §4 retires and the URL-extraction panel §2 deletes.
const ProductForm = React.lazy(() => import('./adminProducts/ProductForm'));
// The §10 replacement for the single giant template: per-section Devices /
// Materials sheets with preview, idempotent confirm and a round-trip export.
const ImportPanel = React.lazy(() => import('./adminProducts/ImportPanel'));
// The older TXT pipeline. Kept because it is genuinely used, demoted to a
// second tab because §10 forbids it being the only option.
const TemplateTools = React.lazy(() => import('./adminProducts/TemplateImport'));

const PAGE = 30;

const STRINGS = {
  ar: {
    title: 'إدارة المنتجات',
    unit: 'منتج',
    import: 'استيراد المنتجات',
    importTitle: 'استيراد المنتجات',
    tabNew: 'قوالب الأقسام (CSV / ZIP)',
    tabLegacy: 'القالب النصي القديم (TXT)',
    newProduct: 'منتج جديد',
    searchPlaceholder: 'بحث بالاسم أو الرابط…',
    search: 'بحث',
    empty: 'لا منتجات.',
    loading: 'جارٍ التحميل…',
    price: 'السعر',
    stock: 'المخزون',
    untracked: 'غير محدود',
    updated: 'آخر تحديث',
    edit: 'تعديل',
    del: 'حذف / أرشفة',
    featured: 'مميز',
    loadMore: 'تحميل المزيد ({n}/{total})',
    loadFailed: 'تعذّر تحميل المنتجات',
    deleteFailed: 'فشل الحذف: ',
    v1Hint: 'بيانات قديمة تُرقّى عند الحفظ / v1 data, upgraded on save',
  },
  en: {
    title: 'Manage Products',
    unit: 'products',
    import: 'Import products',
    importTitle: 'Import products',
    tabNew: 'Section templates (CSV / ZIP)',
    tabLegacy: 'Legacy TXT template',
    newProduct: 'New product',
    searchPlaceholder: 'Search name or slug…',
    search: 'Search',
    empty: 'No products found.',
    loading: 'Loading…',
    price: 'Price',
    stock: 'Stock',
    untracked: 'untracked',
    updated: 'Updated',
    edit: 'Edit',
    del: 'Delete / archive',
    featured: 'Featured',
    loadMore: 'Load more ({n}/{total})',
    loadFailed: 'Failed to load products',
    deleteFailed: 'Delete failed: ',
    v1Hint: 'v1 data — upgraded on save',
  },
  ckb: {
    title: 'بەڕێوەبردنی بەرهەمەکان',
    unit: 'بەرهەم',
    import: 'هاوردەی بەرهەمەکان',
    importTitle: 'هاوردەی بەرهەمەکان',
    tabNew: 'قاڵبی بەشەکان (CSV / ZIP)',
    tabLegacy: 'قاڵبی کۆنی TXT',
    newProduct: 'بەرهەمی نوێ',
    searchPlaceholder: 'گەڕان بە ناو یان بەستەر…',
    search: 'گەڕان',
    empty: 'هیچ بەرهەمێک نەدۆزرایەوە.',
    loading: 'بارکردن…',
    price: 'نرخ',
    stock: 'کۆگا',
    untracked: 'بێ سنوور',
    updated: 'دوا نوێکردنەوە',
    edit: 'دەستکاری',
    del: 'سڕینەوە / ئەرشیف',
    featured: 'تایبەت',
    loadMore: 'زیاتر ({n}/{total})',
    loadFailed: 'نەتوانرا بەرهەمەکان باربکرێن',
    deleteFailed: 'سڕینەوە شکستی هێنا: ',
    v1Hint: 'داتای کۆن — بەرزدەکرێتەوە لە کاتی پاشەکەوت',
  },
} as const;

function fill(template: string, vars: Record<string, string | number>): string {
  return template.replace(/\{(\w+)\}/g, (m, k) => String(vars[k] ?? m));
}

function LazyFallback({ label }: { label: string }) {
  return (
    <div className="flex items-center justify-center gap-2 text-zinc-400 py-12" role="status">
      <RefreshCw className="w-5 h-5 animate-spin" /> {label}
    </div>
  );
}

export default function AdminProducts() {
  const { dir, lang } = useLanguage();
  const t = STRINGS[lang] ?? STRINGS.ar;

  const [items, setItems] = useState<ListingItem[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [loadErr, setLoadErr] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  const [query, setQuery] = useState('');

  const [editing, setEditing] = useState<{ open: boolean; id: string | null }>({ open: false, id: null });
  const [importOpen, setImportOpen] = useState(false);
  const [importDirty, setImportDirty] = useState(false);
  // The §10 flow is the default tab; the TXT tools are one click away.
  const [importTab, setImportTab] = useState<'new' | 'legacy'>('new');
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const load = async (opts: { append?: boolean; offset?: number; q?: string } = {}) => {
    const q = opts.q ?? query;
    const offset = opts.offset ?? 0;
    setLoading(true);
    setLoadErr(null);
    try {
      const params = new URLSearchParams();
      params.set('limit', String(PAGE));
      params.set('offset', String(offset));
      if (q) params.set('search', q);
      const data = await api.get<ListingResponse>(`/api/admin/products-v2?${params.toString()}`);
      setTotal(data.total);
      setItems((prev) => (opts.append ? [...prev, ...data.products] : data.products));
    } catch (e) {
      setLoadErr(e instanceof ApiError ? e.message : t.loadFailed);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    load({ q: query, offset: 0 });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [query]);

  const runSearch = () => setQuery(search.trim());

  // Stable identity: TemplateTools reports dirtiness from an effect, so a new
  // function every render would loop.
  const handleImportDirty = useCallback((d: boolean) => setImportDirty(d), []);
  const handleImportApplied = useCallback(() => {
    load({ q: query, offset: 0 });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [query]);

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
      load({ q: query, offset: 0 });
    } catch (e) {
      setNotice(t.deleteFailed + (e instanceof ApiError ? e.message : 'unknown error'));
    } finally {
      setDeletingId(null);
    }
  };

  // ------------------------------------------------------------ editor mode

  if (editing.open) {
    return (
      <Suspense fallback={<LazyFallback label={t.loading} />}>
        <ProductForm
          productId={editing.id}
          onBack={() => setEditing({ open: false, id: null })}
          onListChanged={() => load({ q: query, offset: 0 })}
        />
      </Suspense>
    );
  }

  // ------------------------------------------------------------ list mode

  return (
    <div className="min-w-0">
      <div className="flex flex-wrap items-center justify-between gap-3 mb-4">
        <h2 className="text-lg font-bold text-white min-w-0">
          {t.title}
          <span className="text-xs font-medium text-zinc-500 mx-2">{total} {t.unit}</span>
        </h2>
        <div className="flex items-center gap-2 flex-wrap">
          <button data-testid="admin-import-open" onClick={() => setImportOpen(true)} className={btnSecondary}>
            <Upload className="w-4 h-4" /> {t.import}
          </button>
          <button onClick={() => setEditing({ open: true, id: null })} className={btnPrimary}>
            <Plus className="w-4 h-4" /> {t.newProduct}
          </button>
        </div>
      </div>

      <div className="flex gap-2 mb-4">
        <input
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') runSearch(); }}
          placeholder={t.searchPlaceholder}
          aria-label={t.search}
          className={inputCls + ' flex-1 min-w-0 max-w-md !py-2.5'}
        />
        <button onClick={runSearch} className={btnSecondary}>
          <Search className="w-4 h-4" /> <span className="hidden sm:inline">{t.search}</span>
        </button>
      </div>

      <ErrorBanner text={loadErr} />
      {notice && (
        <div className="bg-sky-500/10 border border-sky-500/30 text-sky-300 rounded-xl p-3 mb-3 text-sm">
          {notice}
        </div>
      )}

      <div className="grid gap-2">
        {items.length === 0 && !loading && !loadErr && (
          <div className="text-center py-10 text-zinc-500 bg-zinc-800/20 rounded-xl border border-zinc-800/50">
            {t.empty}
          </div>
        )}

        {items.map((p) => (
          <div
            key={p.id}
            // Stable hooks so the browser verification can open a KNOWN
            // product's form rather than guessing at a row.
            data-product-id={p.id}
            // minmax(0,1fr) for the identity column: a long Arabic name must
            // wrap/truncate instead of pushing the price column off-screen.
            className="grid grid-cols-1 sm:grid-cols-[minmax(0,1fr)_auto] items-center gap-3 p-3 bg-zinc-900/30 hover:bg-zinc-800/40 rounded-xl border border-zinc-800/40 transition-colors"
          >
            <div className="flex items-center gap-3 min-w-0">
              {p.image ? (
                <img
                  referrerPolicy="no-referrer"
                  src={p.image}
                  className="w-12 h-12 rounded-lg object-cover border border-zinc-700 bg-zinc-900 shrink-0"
                  alt=""
                />
              ) : (
                <div className="w-12 h-12 rounded-lg border border-zinc-800 bg-zinc-900 shrink-0" />
              )}
              <div className="flex flex-col min-w-0">
                <span className="font-bold text-white text-sm truncate" dir="auto">
                  {p.name_ar || p.name_en || p.slug}
                </span>
                {p.name_ar && p.name_en && (
                  <span className="text-[11px] text-zinc-500 truncate" dir="ltr">{p.name_en}</span>
                )}
                <div className="flex items-center gap-2 mt-1 flex-wrap">
                  <StatusChip status={p.status} />
                  {p.is_featured && (
                    <span className="inline-flex items-center gap-1 text-[10px] font-bold uppercase text-[#6B46FF] bg-[#6B46FF]/10 px-1.5 py-0.5 rounded border border-[#6B46FF]/20">
                      <Star className="w-3 h-3" /> {t.featured}
                    </span>
                  )}
                  {p.doc_version < 2 && (
                    <span className="text-[10px] font-bold text-zinc-500 bg-zinc-800 px-1.5 py-0.5 rounded border border-zinc-700" title={t.v1Hint}>
                      v1
                    </span>
                  )}
                </div>
              </div>
            </div>

            <div className="flex items-center gap-4 sm:gap-5 flex-wrap justify-end">
              <div className="flex flex-col">
                <span className="text-[10px] font-bold text-zinc-500 uppercase tracking-wider">{t.price}</span>
                <span className="text-white text-sm font-bold whitespace-nowrap" dir="ltr">{formatIqd(p.price_iqd || 0)}</span>
              </div>
              <div className="flex flex-col">
                <span className="text-[10px] font-bold text-zinc-500 uppercase tracking-wider">{t.stock}</span>
                <span className="text-zinc-200 text-sm whitespace-nowrap">
                  {p.stock === null ? t.untracked : p.stock}
                </span>
              </div>
              <div className="hidden sm:flex flex-col">
                <span className="text-[10px] font-bold text-zinc-500 uppercase tracking-wider">{t.updated}</span>
                <span className="text-zinc-400 text-sm whitespace-nowrap" dir="ltr">{fmtDate(p.updated_at)}</span>
              </div>
              <div className="flex items-center gap-1">
                <button
                  data-action="edit"
                  onClick={() => setEditing({ open: true, id: p.id })}
                  className="p-2 min-h-11 min-w-11 flex items-center justify-center text-zinc-400 hover:text-white hover:bg-zinc-800 rounded-lg transition-colors border border-transparent hover:border-zinc-600"
                  title={t.edit}
                  aria-label={t.edit}
                >
                  <Edit2 className="w-4 h-4" />
                </button>
                <button
                  onClick={() => handleDelete(p)}
                  disabled={deletingId === p.id}
                  className="p-2 min-h-11 min-w-11 flex items-center justify-center text-zinc-400 hover:text-red-400 hover:bg-red-400/10 rounded-lg transition-colors border border-transparent hover:border-red-500/20 disabled:opacity-50"
                  title={t.del}
                  aria-label={t.del}
                >
                  <Trash2 className="w-4 h-4" />
                </button>
              </div>
            </div>
          </div>
        ))}
      </div>

      {loading && <LazyFallback label={t.loading} />}

      {!loading && items.length < total && (
        <div className="flex justify-center mt-4">
          <button onClick={() => load({ append: true, offset: items.length })} className={btnSecondary}>
            {fill(t.loadMore, { n: items.length, total })}
          </button>
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
