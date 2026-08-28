/**
 * Admin products (v2) — listing + editor on /api/admin/products-v2.
 * The heavy editor body and the template import tools are code-split via
 * React.lazy. Arabic-first labels with small English secondaries, honest
 * states throughout (archive vs delete, stale edits, disabled previews).
 */

import React, { Suspense, useEffect, useState } from 'react';
import { Plus, Edit2, Trash2, Search, RefreshCw, Upload, Star } from 'lucide-react';
import { api, ApiError, formatIqd } from '../lib/api';
import { useLanguage } from '../LanguageContext';
import type { ListingItem, ListingResponse, DeleteResponse } from './adminProducts/types';
import { StatusChip, Modal, ErrorBanner, btnPrimary, btnSecondary, inputCls, fmtDate } from './adminProducts/ui';

const ProductEditor = React.lazy(() => import('./adminProducts/ProductEditor'));
const TemplateTools = React.lazy(() => import('./adminProducts/TemplateImport'));

const PAGE = 30;

function LazyFallback() {
  return (
    <div className="flex items-center justify-center gap-2 text-zinc-400 py-16">
      <RefreshCw className="w-5 h-5 animate-spin" /> جارٍ التحميل… / loading…
    </div>
  );
}

export default function AdminProducts() {
  const { dir } = useLanguage();

  const [items, setItems] = useState<ListingItem[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [loadErr, setLoadErr] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  const [query, setQuery] = useState('');

  const [editing, setEditing] = useState<{ open: boolean; id: string | null }>({ open: false, id: null });
  const [importOpen, setImportOpen] = useState(false);
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
      setLoadErr(e instanceof ApiError ? e.message : 'تعذّر تحميل المنتجات / failed to load products');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    load({ q: query, offset: 0 });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [query]);

  const runSearch = () => setQuery(search.trim());

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
      setNotice((dir === 'rtl' ? 'فشل الحذف: ' : 'Delete failed: ') + (e instanceof ApiError ? e.message : 'unknown error'));
    } finally {
      setDeletingId(null);
    }
  };

  // ------------------------------------------------------------ editor mode

  if (editing.open) {
    return (
      <Suspense fallback={<LazyFallback />}>
        <ProductEditor
          productId={editing.id}
          onBack={() => setEditing({ open: false, id: null })}
          onListChanged={() => load({ q: query, offset: 0 })}
        />
      </Suspense>
    );
  }

  // ------------------------------------------------------------ list mode

  return (
    <div>
      <div className="flex flex-wrap items-center justify-between gap-3 mb-6">
        <h2 className="text-xl font-bold text-white">
          {dir === 'rtl' ? 'إدارة المنتجات' : 'Manage Products'}
          <span className="text-xs font-medium text-zinc-500 mx-2">
            {total} {dir === 'rtl' ? 'منتج' : 'products'}
          </span>
        </h2>
        <div className="flex items-center gap-2 flex-wrap">
          <button onClick={() => setImportOpen(true)} className={btnSecondary}>
            <Upload className="w-4 h-4" /> {dir === 'rtl' ? 'استيراد (قالب / ZIP)' : 'Import (template / ZIP)'}
          </button>
          <button onClick={() => setEditing({ open: true, id: null })} className={btnPrimary}>
            <Plus className="w-4 h-4" /> {dir === 'rtl' ? 'منتج جديد' : 'New product'}
          </button>
        </div>
      </div>

      <div className="flex gap-2 mb-5">
        <div className="relative flex-1 max-w-md">
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') runSearch(); }}
            placeholder={dir === 'rtl' ? 'بحث بالاسم أو الرابط…' : 'Search name or slug…'}
            className={inputCls}
          />
        </div>
        <button onClick={runSearch} className={btnSecondary}>
          <Search className="w-4 h-4" /> {dir === 'rtl' ? 'بحث' : 'Search'}
        </button>
      </div>

      <ErrorBanner text={loadErr} />
      {notice && (
        <div className="bg-sky-500/10 border border-sky-500/30 text-sky-300 rounded-2xl p-3 mb-4 text-sm">
          {notice}
        </div>
      )}

      <div className="grid gap-3">
        {items.length === 0 && !loading && !loadErr && (
          <div className="text-center py-12 text-zinc-500 bg-zinc-800/20 rounded-xl border border-zinc-800/50">
            {dir === 'rtl' ? 'لا منتجات.' : 'No products found.'}
          </div>
        )}

        {items.map((p) => (
          <div
            key={p.id}
            className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 p-4 bg-zinc-900/30 hover:bg-zinc-800/40 rounded-xl border border-zinc-800/40 transition-colors"
          >
            <div className="flex items-center gap-4 flex-1 min-w-0">
              {p.image ? (
                <img
                  referrerPolicy="no-referrer"
                  src={p.image}
                  className="w-16 h-16 rounded-lg object-cover border border-zinc-700 bg-zinc-900 shrink-0"
                  alt=""
                />
              ) : (
                <div className="w-16 h-16 rounded-lg border border-zinc-800 bg-zinc-900 shrink-0" />
              )}
              <div className="flex flex-col min-w-0">
                <span className="font-bold text-white text-base truncate" dir="auto">
                  {p.name_ar || p.name_en || p.slug}
                </span>
                {p.name_ar && p.name_en && (
                  <span className="text-xs text-zinc-500 truncate" dir="ltr">{p.name_en}</span>
                )}
                <div className="flex items-center gap-2 mt-1 flex-wrap">
                  <StatusChip status={p.status} />
                  {p.is_featured && (
                    <span className="inline-flex items-center gap-1 text-[10px] font-bold uppercase text-[#6B46FF] bg-[#6B46FF]/10 px-1.5 py-0.5 rounded border border-[#6B46FF]/20">
                      <Star className="w-3 h-3" /> {dir === 'rtl' ? 'مميز' : 'Featured'}
                    </span>
                  )}
                  {p.doc_version < 2 && (
                    <span className="text-[10px] font-bold text-zinc-500 bg-zinc-800 px-1.5 py-0.5 rounded border border-zinc-700" title="v1 data — upgraded on save / بيانات قديمة تُرقّى عند الحفظ">
                      v1
                    </span>
                  )}
                </div>
              </div>
            </div>

            <div className="flex items-center gap-5 sm:gap-7 flex-wrap">
              <div className="flex flex-col">
                <span className="text-[10px] font-bold text-zinc-500 uppercase tracking-wider mb-0.5">
                  {dir === 'rtl' ? 'السعر' : 'Price'}
                </span>
                <span className="text-white font-bold whitespace-nowrap" dir="ltr">{formatIqd(p.price_iqd || 0)}</span>
              </div>
              <div className="flex flex-col">
                <span className="text-[10px] font-bold text-zinc-500 uppercase tracking-wider mb-0.5">
                  {dir === 'rtl' ? 'المخزون' : 'Stock'}
                </span>
                <span className="text-zinc-200 text-sm whitespace-nowrap">
                  {p.stock === null ? (dir === 'rtl' ? 'غير محدود' : 'untracked') : p.stock}
                </span>
              </div>
              <div className="flex flex-col">
                <span className="text-[10px] font-bold text-zinc-500 uppercase tracking-wider mb-0.5">
                  {dir === 'rtl' ? 'آخر تحديث' : 'Updated'}
                </span>
                <span className="text-zinc-400 text-sm whitespace-nowrap" dir="ltr">{fmtDate(p.updated_at)}</span>
              </div>
              <div className="flex items-center gap-2">
                <button
                  onClick={() => setEditing({ open: true, id: p.id })}
                  className="p-2.5 text-zinc-400 hover:text-white hover:bg-zinc-800 rounded-lg transition-colors border border-transparent hover:border-zinc-600"
                  title={dir === 'rtl' ? 'تعديل' : 'Edit'}
                >
                  <Edit2 className="w-4 h-4" />
                </button>
                <button
                  onClick={() => handleDelete(p)}
                  disabled={deletingId === p.id}
                  className="p-2.5 text-zinc-400 hover:text-red-400 hover:bg-red-400/10 rounded-lg transition-colors border border-transparent hover:border-red-500/20 disabled:opacity-50"
                  title={dir === 'rtl' ? 'حذف / أرشفة' : 'Delete / archive'}
                >
                  <Trash2 className="w-4 h-4" />
                </button>
              </div>
            </div>
          </div>
        ))}
      </div>

      {loading && <LazyFallback />}

      {!loading && items.length < total && (
        <div className="flex justify-center mt-5">
          <button onClick={() => load({ append: true, offset: items.length })} className={btnSecondary}>
            {dir === 'rtl' ? `تحميل المزيد (${items.length}/${total})` : `Load more (${items.length}/${total})`}
          </button>
        </div>
      )}

      {importOpen && (
        <Modal
          wide
          titleAr="استيراد المنتجات (قالب TXT / ZIP)"
          titleEn="Import products (TXT template / ZIP)"
          onClose={() => setImportOpen(false)}
        >
          <Suspense fallback={<LazyFallback />}>
            <TemplateTools
              insideSection={false}
              onApplied={() => load({ q: query, offset: 0 })}
            />
          </Suspense>
        </Modal>
      )}
    </div>
  );
}
