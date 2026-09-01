import React, { useEffect, useRef, useState } from 'react';
import { Package, Plus, Trash2, RefreshCw, Upload, Search, X } from 'lucide-react';
import { api, formatIqd, type ApiProduct } from '../lib/api';
import { L, btnPrimary, btnSecondary, inputCls, uploadProductImage } from './adminProducts/ui';

/**
 * الباقات — the owner's bundles mandate: bundles left the product form (the
 * «باقة» sale-type checkbox is gone) and became their own admin-composed
 * entity: a named group of catalog products, visible on the storefront to
 * active PLUS / PRIME / PRO members only (enforced server-side in
 * worker/routes/bundles.ts).
 *
 * A bundle deliberately has NO price field here: the storefront total is the
 * live sum of the members' tier-resolved prices, so the section can never
 * advertise a number checkout would not charge.
 */

interface BundleItem {
  product_id: string;
  qty: number;
  name?: string;
  status?: string;
  image?: string;
}

interface BundleRow {
  id: string;
  name: string;
  description: string;
  image: string;
  active: number;
  sort: number;
  items: BundleItem[];
}

type Draft = {
  id: string | null;
  name: string;
  description: string;
  image: string;
  active: boolean;
  sort: number;
  items: BundleItem[];
};

const blankDraft = (): Draft => ({ id: null, name: '', description: '', image: '', active: true, sort: 0, items: [] });

export default function AdminBundles() {
  const [bundles, setBundles] = useState<BundleRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadErr, setLoadErr] = useState('');
  const [draft, setDraft] = useState<Draft | null>(null);
  const [saving, setSaving] = useState(false);
  const [saveErr, setSaveErr] = useState('');

  const load = async () => {
    setLoading(true);
    setLoadErr('');
    try {
      const res = await api.get<{ bundles: BundleRow[] }>('/api/admin/bundles');
      setBundles(res.bundles ?? []);
    } catch (err) {
      setLoadErr(err instanceof Error ? err.message : 'فشل التحميل');
    } finally {
      setLoading(false);
    }
  };
  useEffect(() => {
    void load();
  }, []);

  const save = async () => {
    if (!draft) return;
    setSaving(true);
    setSaveErr('');
    try {
      const body = {
        name: draft.name.trim(),
        description: draft.description.trim(),
        image: draft.image.trim(),
        active: draft.active,
        sort: draft.sort,
        items: draft.items.map((i) => ({ product_id: i.product_id, qty: i.qty })),
      };
      if (draft.id) await api.put(`/api/admin/bundles/${draft.id}`, body);
      else await api.post('/api/admin/bundles', body);
      setDraft(null);
      await load();
    } catch (err) {
      setSaveErr(err instanceof Error ? err.message : 'فشل الحفظ');
    } finally {
      setSaving(false);
    }
  };

  const remove = async (b: BundleRow) => {
    if (!window.confirm(`حذف الباقة «${b.name}»؟`)) return;
    try {
      await api.delete(`/api/admin/bundles/${b.id}`);
      await load();
    } catch (err) {
      setLoadErr(err instanceof Error ? err.message : 'فشل الحذف');
    }
  };

  return (
    <div className="text-white min-w-0">
      <div className="flex items-center justify-between gap-3 mb-3">
        <h2 className="text-lg font-black flex items-center gap-2">
          <Package className="w-5 h-5 text-[#c5a059]" />
          الباقات <span className="text-[11px] font-medium text-zinc-500">Bundles — للمشتركين PLUS / PRIME / PRO</span>
        </h2>
        <button type="button" className={btnPrimary} onClick={() => setDraft(blankDraft())}>
          <Plus className="w-4 h-4" /> باقة جديدة
        </button>
      </div>
      <p className="text-[11px] text-zinc-500 mb-3">
        الباقة مجموعة منتجات من الكتالوج تُعرض معًا لمشتركي PLUS وPRIME وPRO فقط (يفرضه الخادم). سعرها المعروض هو
        مجموع أسعار منتجاتها الحية حسب عضوية المشاهد — لا يوجد سعر مخزّن يمكن أن يتقادم.
      </p>

      {draft && (
        <BundleEditor
          draft={draft}
          setDraft={setDraft}
          onSave={save}
          onCancel={() => setDraft(null)}
          saving={saving}
          error={saveErr}
        />
      )}

      {loading ? (
        <div className="text-center text-zinc-500 py-10 text-sm">جارٍ التحميل…</div>
      ) : loadErr ? (
        <div className="bg-red-500/10 border border-red-500/30 text-red-300 rounded-lg p-3 text-[13px]">{loadErr}</div>
      ) : bundles.length === 0 ? (
        <div className="text-center text-zinc-500 py-10 text-sm border border-dashed border-zinc-800 rounded-xl">
          لا توجد باقات بعد — أنشئ الأولى.
        </div>
      ) : (
        <div className="space-y-2">
          {bundles.map((b) => (
            <div key={b.id} className="rounded-xl border border-zinc-800 bg-zinc-900/50 p-3 min-w-0">
              <div className="flex items-center gap-3 min-w-0">
                {b.image ? (
                  <img
                    src={b.image}
                    alt=""
                    referrerPolicy="no-referrer"
                    className="w-10 h-10 rounded-lg object-cover border border-zinc-700 shrink-0"
                  />
                ) : (
                  <span className="w-10 h-10 rounded-lg bg-zinc-800 grid place-items-center shrink-0">
                    <Package className="w-4 h-4 text-zinc-500" />
                  </span>
                )}
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2 min-w-0">
                    <span dir="ltr" className="font-bold text-[13px] truncate">{b.name}</span>
                    <span
                      className={`text-[10px] font-bold px-1.5 py-0.5 rounded ${
                        b.active ? 'bg-emerald-500/15 text-emerald-300' : 'bg-zinc-800 text-zinc-500'
                      }`}
                    >
                      {b.active ? 'معروضة' : 'مخفية'}
                    </span>
                  </div>
                  <div className="text-[11px] text-zinc-500 truncate">
                    {b.items.length} منتج ·{' '}
                    {b.items
                      .map((i) => `${i.name}${i.qty > 1 ? ` ×${i.qty}` : ''}`)
                      .join('، ')}
                  </div>
                </div>
                <button
                  type="button"
                  className={btnSecondary}
                  onClick={() =>
                    setDraft({
                      id: b.id,
                      name: b.name,
                      description: b.description,
                      image: b.image,
                      active: !!b.active,
                      sort: b.sort,
                      items: b.items,
                    })
                  }
                >
                  تعديل
                </button>
                <button
                  type="button"
                  className="p-2 min-h-9 rounded-lg text-zinc-500 hover:text-red-400 hover:bg-red-400/10 transition-colors"
                  onClick={() => void remove(b)}
                  aria-label="حذف"
                >
                  <Trash2 className="w-4 h-4" />
                </button>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function BundleEditor({
  draft,
  setDraft,
  onSave,
  onCancel,
  saving,
  error,
}: {
  draft: Draft;
  setDraft: React.Dispatch<React.SetStateAction<Draft | null>>;
  onSave: () => void;
  onCancel: () => void;
  saving: boolean;
  error: string;
}) {
  const [search, setSearch] = useState('');
  const [results, setResults] = useState<ApiProduct[]>([]);
  const [searching, setSearching] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);
  const [uploading, setUploading] = useState(false);
  const reqId = useRef(0);

  useEffect(() => {
    const q = search.trim();
    if (!q) {
      setResults([]);
      return;
    }
    const id = ++reqId.current;
    setSearching(true);
    const t = setTimeout(async () => {
      try {
        const res = await api.get<{ products: ApiProduct[] }>(
          `/api/products?search=${encodeURIComponent(q)}&limit=10`
        );
        if (reqId.current === id) setResults(res.products ?? []);
      } catch {
        if (reqId.current === id) setResults([]);
      } finally {
        if (reqId.current === id) setSearching(false);
      }
    }, 250);
    return () => clearTimeout(t);
  }, [search]);

  const addItem = (p: ApiProduct) =>
    setDraft((d) =>
      !d || d.items.some((i) => i.product_id === p.id)
        ? d
        : { ...d, items: [...d.items, { product_id: p.id, qty: 1, name: p.name, image: p.images?.[0] ?? '' }] }
    );

  const patchQty = (pid: string, qty: number) =>
    setDraft((d) =>
      d ? { ...d, items: d.items.map((i) => (i.product_id === pid ? { ...i, qty: Math.max(1, Math.min(99, qty)) } : i)) } : d
    );

  const removeItem = (pid: string) =>
    setDraft((d) => (d ? { ...d, items: d.items.filter((i) => i.product_id !== pid) } : d));

  const canSave = draft.name.trim().length > 0 && draft.items.length > 0 && !saving;

  return (
    <div className="rounded-xl border border-[#6B46FF]/40 bg-zinc-900/70 p-3 mb-4 min-w-0">
      <div className="flex items-center justify-between gap-2 mb-3">
        <h3 className="text-[13px] font-black">{draft.id ? 'تعديل الباقة' : 'باقة جديدة'}</h3>
        <button type="button" onClick={onCancel} className="p-2 min-h-9 rounded-lg text-zinc-400 hover:text-white" aria-label="إغلاق">
          <X className="w-4 h-4" />
        </button>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-3 mb-3">
        <div>
          <L ar="الاسم" en="Name (English)" />
          <input
            dir="ltr"
            className={inputCls}
            value={draft.name}
            onChange={(e) => setDraft((d) => (d ? { ...d, name: e.target.value } : d))}
            placeholder="Starter FDM Kit"
          />
        </div>
        <div>
          <L ar="الترتيب" en="Sort" hint="الأصغر أولًا" />
          <input
            dir="ltr"
            inputMode="numeric"
            className={inputCls}
            value={String(draft.sort)}
            onChange={(e) =>
              setDraft((d) => (d ? { ...d, sort: Number(e.target.value.replace(/[^\d]/g, '') || 0) } : d))
            }
          />
        </div>
        <div className="md:col-span-2">
          <L ar="الوصف" en="Description" />
          <textarea
            dir="ltr"
            rows={2}
            className={inputCls}
            value={draft.description}
            onChange={(e) => setDraft((d) => (d ? { ...d, description: e.target.value } : d))}
          />
        </div>
        <div className="md:col-span-2">
          <L ar="صورة الباقة" en="Cover image" hint="رابط مباشر أو رفع ملف" />
          <div className="flex gap-2 min-w-0">
            <input
              dir="ltr"
              className={inputCls}
              value={draft.image}
              onChange={(e) => setDraft((d) => (d ? { ...d, image: e.target.value } : d))}
              placeholder="https://…/cover.jpg"
            />
            <input
              ref={fileRef}
              type="file"
              dir="ltr"
              accept="image/jpeg,image/png,image/webp,image/gif"
              className="hidden"
              aria-hidden="true"
              tabIndex={-1}
              onChange={async (e) => {
                const f = e.target.files?.[0];
                if (!f) return;
                setUploading(true);
                try {
                  const res = await uploadProductImage(f);
                  setDraft((d) => (d ? { ...d, image: res.url } : d));
                } catch {
                  /* the URL field stays editable; the admin sees no new value */
                } finally {
                  setUploading(false);
                  if (fileRef.current) fileRef.current.value = '';
                }
              }}
            />
            <button type="button" className={btnSecondary} disabled={uploading} onClick={() => fileRef.current?.click()}>
              {uploading ? <RefreshCw className="w-4 h-4 animate-spin" /> : <Upload className="w-4 h-4" />} رفع
            </button>
          </div>
        </div>
      </div>

      <div className="mb-3">
        <L ar="منتجات الباقة" en="Products" hint="ابحث ثم اضغط لإضافة المنتج" />
        <div className="relative min-w-0">
          <Search className="absolute start-2.5 top-1/2 -translate-y-1/2 w-4 h-4 text-zinc-500 pointer-events-none" />
          <input
            dir="ltr"
            className={`${inputCls} ps-8`}
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search products…"
          />
        </div>
        {search.trim() && (
          <div className="mt-1.5 rounded-lg border border-zinc-800 bg-zinc-950/80 max-h-56 overflow-y-auto">
            {searching ? (
              <div className="p-2.5 text-[12px] text-zinc-500">جارٍ البحث…</div>
            ) : results.length === 0 ? (
              <div className="p-2.5 text-[12px] text-zinc-500">لا نتائج.</div>
            ) : (
              results.map((p) => {
                const added = draft.items.some((i) => i.product_id === p.id);
                return (
                  <button
                    key={p.id}
                    type="button"
                    disabled={added}
                    onClick={() => addItem(p)}
                    className="w-full flex items-center gap-2 p-2 text-start hover:bg-zinc-900 disabled:opacity-40 min-w-0"
                  >
                    {p.images?.[0] ? (
                      <img src={p.images[0]} alt="" referrerPolicy="no-referrer" className="w-8 h-8 rounded object-cover shrink-0" />
                    ) : (
                      <span className="w-8 h-8 rounded bg-zinc-800 shrink-0" />
                    )}
                    <span dir="ltr" className="text-[12px] text-zinc-200 truncate flex-1">{p.name}</span>
                    <span className="text-[11px] text-zinc-500 tabular-nums shrink-0">{formatIqd(p.price_iqd)}</span>
                  </button>
                );
              })
            )}
          </div>
        )}

        {draft.items.length > 0 && (
          <div className="mt-2 space-y-1.5">
            {draft.items.map((i) => (
              <div key={i.product_id} className="flex items-center gap-2 rounded-lg border border-zinc-800 bg-zinc-900/60 p-2 min-w-0">
                {i.image ? (
                  <img src={i.image} alt="" referrerPolicy="no-referrer" className="w-8 h-8 rounded object-cover shrink-0" />
                ) : (
                  <span className="w-8 h-8 rounded bg-zinc-800 shrink-0" />
                )}
                <span dir="ltr" className="text-[12px] text-zinc-200 truncate flex-1 min-w-0">{i.name ?? i.product_id}</span>
                <label className="flex items-center gap-1 text-[11px] text-zinc-500 shrink-0">
                  الكمية
                  <input
                    dir="ltr"
                    inputMode="numeric"
                    className="w-14 min-h-10 bg-zinc-800/40 border border-zinc-700 rounded-lg px-2 text-[13px] text-white text-center"
                    value={String(i.qty)}
                    onChange={(e) => patchQty(i.product_id, Number(e.target.value.replace(/[^\d]/g, '') || 1))}
                  />
                </label>
                <button
                  type="button"
                  className="p-1.5 rounded text-zinc-500 hover:text-red-400"
                  onClick={() => removeItem(i.product_id)}
                  aria-label="إزالة المنتج"
                >
                  <Trash2 className="w-4 h-4" />
                </button>
              </div>
            ))}
          </div>
        )}
      </div>

      <div className="flex items-center gap-2 flex-wrap">
        <button type="button" className={btnPrimary} disabled={!canSave} onClick={onSave}>
          {saving ? <RefreshCw className="w-4 h-4 animate-spin" /> : null} حفظ الباقة
        </button>
        <button
          type="button"
          className={btnSecondary}
          onClick={() => setDraft((d) => (d ? { ...d, active: !d.active } : d))}
        >
          {draft.active ? 'معروضة للمشتركين ✓' : 'مخفية — اضغط للعرض'}
        </button>
        {error && <span className="text-[12px] text-red-400">{error}</span>}
      </div>
    </div>
  );
}
