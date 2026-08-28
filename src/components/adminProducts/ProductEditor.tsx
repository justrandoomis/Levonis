/**
 * v2 product editor — works on the canonical ProductDoc via
 * /api/admin/products-v2 (mandate §4). Arabic-first, grouped collapsible
 * sections, single full-document save with stale-edit protection
 * (expected_updated_at → 409 STALE_EDIT → reload dialog), honest states
 * everywhere. NO auto-translate anywhere: translations arrive via the TXT
 * template workflow only.
 */

import React, { useEffect, useMemo, useRef, useState } from 'react';
import { ArrowRight, ArrowLeft, Save, RefreshCw, AlertTriangle, Plus } from 'lucide-react';
import { api, ApiError } from '../../lib/api';
import { useLanguage } from '../../LanguageContext';
import { useWallet } from '../../WalletContext';
import type { BrandV2, CatalogV2, TransportOfferV2 } from '../../lib/productTypes';
import {
  blankDoc, toEditorDoc, transStatusOf,
  type EditorDoc, type ProductResponse, type SaveResponse, type BrandsResponse, type BrandResponse, type CatalogsResponse,
} from './types';
import {
  L, Section, NullableIqd, RequiredIqd, TriText, TransChip, StatusChip, Modal, ErrorBanner,
  inputCls, btnPrimary, btnSecondary,
} from './ui';
import {
  OptionsSection, ColorsSection, MediaSection, SpecsSection, LabelsSection, WarrantySection, ContentBlocksSection,
} from './editorSections';
import PricePreview from './PricePreview';
import ExtractPanel from './ExtractPanel';
import TemplateTools from './TemplateImport';

const METHODS: Array<{ m: TransportOfferV2['method']; ar: string; en: string }> = [
  { m: 'air', ar: 'جوي', en: 'air' },
  { m: 'sea', ar: 'بحري', en: 'sea' },
  { m: 'land', ar: 'بري', en: 'land' },
];

export default function ProductEditor({
  productId,
  onBack,
  onListChanged,
}: {
  productId: string | null;
  onBack: () => void;
  onListChanged: () => void;
}) {
  const { dir } = useLanguage();
  const { exchangeRate } = useWallet();

  const [doc, setDoc] = useState<EditorDoc | null>(null);
  const [savedDoc, setSavedDoc] = useState<EditorDoc | null>(null);
  const [loadedUpdatedAt, setLoadedUpdatedAt] = useState('');
  const [loadErr, setLoadErr] = useState<string | null>(null);
  const [loading, setLoading] = useState(!!productId);

  const [saving, setSaving] = useState(false);
  const [saveErr, setSaveErr] = useState<string | null>(null);
  const [savedAt, setSavedAt] = useState<number | null>(null);
  const [staleOpen, setStaleOpen] = useState(false);
  const [importNote, setImportNote] = useState<string | null>(null);

  const [brands, setBrands] = useState<BrandV2[]>([]);
  const [catalogs, setCatalogs] = useState<CatalogV2[]>([]);
  const [taxErr, setTaxErr] = useState<string | null>(null);
  const [brandModal, setBrandModal] = useState(false);

  // ------------------------------------------------------------ loading

  const load = async (id: string) => {
    setLoading(true); setLoadErr(null);
    try {
      const data = await api.get<ProductResponse>(`/api/admin/products-v2/${id}`);
      const d = toEditorDoc(data.product);
      setDoc(d);
      setSavedDoc(d);
      setLoadedUpdatedAt(data.product.updated_at ?? '');
    } catch (e) {
      setLoadErr(e instanceof ApiError ? e.message : 'تعذّر تحميل المنتج / failed to load');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (productId) {
      load(productId);
    } else {
      const b = blankDoc();
      setDoc(b);
      setSavedDoc(null);
      setLoadedUpdatedAt('');
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [productId]);

  useEffect(() => {
    (async () => {
      try {
        const [b, cats] = await Promise.all([
          api.get<BrandsResponse>('/api/admin/products-v2/brands'),
          api.get<CatalogsResponse>('/api/admin/products-v2/catalogs'),
        ]);
        setBrands(b.brands);
        setCatalogs(cats.catalogs);
      } catch (e) {
        setTaxErr(e instanceof ApiError ? e.message : 'تعذّر تحميل العلامات/التصنيفات');
      }
    })();
  }, []);

  // ------------------------------------------------------------ dirty guard

  const dirty = useMemo(() => {
    if (!doc) return false;
    const base = savedDoc ?? blankDoc();
    return JSON.stringify(doc) !== JSON.stringify(base);
  }, [doc, savedDoc]);

  const dirtyRef = useRef(dirty);
  dirtyRef.current = dirty;

  useEffect(() => {
    const handler = (e: BeforeUnloadEvent) => {
      if (dirtyRef.current) {
        e.preventDefault();
        e.returnValue = '';
      }
    };
    window.addEventListener('beforeunload', handler);
    return () => window.removeEventListener('beforeunload', handler);
  }, []);

  const back = () => {
    if (dirty && !window.confirm(dir === 'rtl'
      ? 'لديك تغييرات غير محفوظة — الخروج بدون حفظ؟'
      : 'You have unsaved changes — leave without saving?')) return;
    onBack();
  };

  // ------------------------------------------------------------ save

  const save = async (asDraft: boolean) => {
    if (!doc || saving) return;
    setSaving(true); setSaveErr(null);
    try {
      const { images: _legacyImages, ...rest } = doc;
      const body: Record<string, unknown> = {
        ...rest,
        id: savedDoc?.id || doc.id || undefined,
        status: asDraft ? 'draft' : doc.status,
        expected_updated_at: loadedUpdatedAt || undefined,
      };
      const res = await api.post<SaveResponse>('/api/admin/products-v2', body);
      const nd = toEditorDoc(res.product);
      setDoc(nd);
      setSavedDoc(nd);
      setLoadedUpdatedAt(res.product.updated_at ?? '');
      setSavedAt(Date.now());
      onListChanged();
    } catch (e) {
      if (e instanceof ApiError && e.status === 409 && e.code === 'STALE_EDIT') {
        setStaleOpen(true);
      } else {
        setSaveErr(e instanceof ApiError ? e.message : 'فشل الحفظ / save failed');
      }
    } finally {
      setSaving(false);
    }
  };

  // ------------------------------------------------------------ render

  if (loading) {
    return (
      <div className="flex items-center gap-2 text-zinc-400 py-12 justify-center">
        <RefreshCw className="w-5 h-5 animate-spin" /> جارٍ التحميل… / loading…
      </div>
    );
  }
  if (loadErr || !doc) {
    return (
      <div>
        <ErrorBanner text={loadErr ?? 'تعذّر التحميل'} />
        <div className="flex gap-2">
          {productId && <button onClick={() => load(productId)} className={btnSecondary}>إعادة المحاولة / retry</button>}
          <button onClick={onBack} className={btnSecondary}>رجوع / back</button>
        </div>
      </div>
    );
  }

  const usd = (v: number | null) =>
    v === null || !exchangeRate ? null : `≈ $${(v / exchangeRate).toFixed(2)}`;

  const BackIcon = dir === 'rtl' ? ArrowRight : ArrowLeft;
  const savedId = savedDoc?.id ?? '';

  return (
    <div className="pb-28">
      {/* header */}
      <div className="flex items-center justify-between mb-5 gap-3 flex-wrap">
        <button onClick={back} className="flex items-center gap-2 text-zinc-400 hover:text-white transition-colors font-bold">
          <BackIcon className="w-4 h-4" /> {dir === 'rtl' ? 'رجوع إلى القائمة' : 'Back to list'}
        </button>
        <div className="flex items-center gap-2 flex-wrap">
          <StatusChip status={doc.status} />
          {savedId && <span className="text-[11px] text-zinc-600 font-mono" dir="ltr">{savedId}</span>}
          {doc.slug && <span className="text-[11px] text-zinc-600 font-mono" dir="ltr">/{doc.slug}</span>}
        </div>
      </div>

      {importNote && (
        <div className="bg-sky-500/10 border border-sky-500/30 text-sky-300 rounded-2xl p-3 mb-4 text-sm">
          {importNote}
        </div>
      )}

      {/* 1. الأساسيات */}
      <Section ar="الأساسيات" en="Basics" defaultOpen>
        <div className="flex flex-col gap-5">
          <TriText
            labelAr="الاسم" labelEn="Name"
            ar={doc.name_ar} en={doc.name_en} ckb={doc.name_ckb}
            onAr={(v) => setDoc((d) => d && { ...d, name_ar: v })}
            onEn={(v) => setDoc((d) => d && { ...d, name_en: v })}
            onCkb={(v) => setDoc((d) => d && { ...d, name_ckb: v })}
            chips={{
              en: <TransChip status={transStatusOf(doc.translation_meta, 'name', 'en')} />,
              ckb: <TransChip status={transStatusOf(doc.translation_meta, 'name', 'ckb')} />,
            }}
          />
          <TriText
            textarea
            labelAr="الوصف" labelEn="Description"
            ar={doc.description_ar} en={doc.description_en} ckb={doc.description_ckb}
            onAr={(v) => setDoc((d) => d && { ...d, description_ar: v })}
            onEn={(v) => setDoc((d) => d && { ...d, description_en: v })}
            onCkb={(v) => setDoc((d) => d && { ...d, description_ckb: v })}
            chips={{
              en: <TransChip status={transStatusOf(doc.translation_meta, 'description', 'en')} />,
              ckb: <TransChip status={transStatusOf(doc.translation_meta, 'description', 'ckb')} />,
            }}
          />
          <div className="text-[11px] text-zinc-500 bg-zinc-800/40 border border-zinc-800 rounded-xl p-3">
            العربية هي لغة المصدر. لا توجد ترجمة آلية في المحرر — تُستورد الترجمات وتُعتمد عبر قالب TXT في قسم «استيراد وتصدير» أدناه.
            <span className="mx-1">Arabic is the source; translations come only through the TXT template workflow below (no runtime AI).</span>
          </div>

          <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
            <div>
              <L ar="الحالة" en="Status" />
              <select
                value={doc.status}
                onChange={(e) => setDoc((d) => d && { ...d, status: e.target.value as EditorDoc['status'] })}
                className={inputCls}
              >
                <option value="active">نشط / active</option>
                <option value="hidden">مخفي / hidden</option>
                <option value="draft">مسودة / draft</option>
              </select>
            </div>
            <div>
              <L ar="ترتيب العرض" en="Display order" />
              <input
                type="number" dir="ltr"
                value={doc.display_order}
                onChange={(e) => {
                  const n = Math.floor(Number(e.target.value));
                  setDoc((d) => d && { ...d, display_order: Number.isFinite(n) ? n : 0 });
                }}
                className={inputCls}
              />
            </div>
            <div className="flex items-end pb-1">
              <label className="flex items-center gap-2 cursor-pointer min-h-[44px]">
                <input
                  type="checkbox"
                  checked={doc.is_featured}
                  onChange={(e) => setDoc((d) => d && { ...d, is_featured: e.target.checked })}
                  className="w-5 h-5 accent-[#6B46FF]"
                />
                <span className="text-white font-medium text-sm">مميز <span className="text-zinc-500 text-xs">featured</span></span>
              </label>
            </div>
            <div>
              <L ar="الوسوم" en="Hashtags (comma)" />
              <input
                value={doc.hashtags.join(', ')}
                onChange={(e) => setDoc((d) => d && { ...d, hashtags: e.target.value.split(',').map((s) => s.trim()).filter(Boolean) })}
                className={inputCls}
              />
            </div>
          </div>

          <div>
            <L ar="طريقة الاستخدام / داخل العلبة" en="How to use / in the box" />
            <textarea
              value={doc.how_to_use}
              onChange={(e) => setDoc((d) => d && { ...d, how_to_use: e.target.value })}
              className={inputCls + ' h-24'}
            />
          </div>
        </div>
      </Section>

      {/* 2. الأسعار */}
      <Section ar="الأسعار" en="Pricing" defaultOpen>
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
          <div>
            <L ar="السعر الأساسي (د.ع)" en="Base regular (IQD) — required" />
            <RequiredIqd value={doc.price_iqd} onChange={(v) => setDoc((d) => d && { ...d, price_iqd: v })} />
            {usd(doc.price_iqd) && <div className="text-[11px] text-zinc-500 mt-1" dir="ltr">{usd(doc.price_iqd)}</div>}
          </div>
          <div>
            <L ar="سعر PRO الصريح" en="Explicit PRO (IQD)" />
            <NullableIqd
              value={doc.pro_price_iqd}
              onChange={(v) => setDoc((d) => d && { ...d, pro_price_iqd: v })}
              placeholder="بدون — تُطبق سياسة المتجر"
            />
            {usd(doc.pro_price_iqd) && <div className="text-[11px] text-zinc-500 mt-1" dir="ltr">{usd(doc.pro_price_iqd)}</div>}
          </div>
          <div>
            <L ar="سعر المقارنة" en="Compare-at (IQD)" />
            <NullableIqd
              value={doc.original_price_iqd}
              onChange={(v) => setDoc((d) => d && { ...d, original_price_iqd: v })}
              placeholder="بدون / none"
            />
            {usd(doc.original_price_iqd) && <div className="text-[11px] text-zinc-500 mt-1" dir="ltr">{usd(doc.original_price_iqd)}</div>}
          </div>
          <div>
            <L ar="الكلفة (إداري فقط)" en="Cost (IQD, admin-only)" />
            <NullableIqd
              value={doc.product_cost_iqd}
              onChange={(v) => setDoc((d) => d && { ...d, product_cost_iqd: v })}
              placeholder="بدون / none"
            />
            {usd(doc.product_cost_iqd) && <div className="text-[11px] text-zinc-500 mt-1" dir="ltr">{usd(doc.product_cost_iqd)}</div>}
          </div>
        </div>
        <div className="text-[11px] text-zinc-500 mt-3 bg-zinc-800/40 border border-zinc-800 rounded-xl p-3">
          الحقل الفارغ = لا قيمة (وليست صفراً)، والصفر قيمة صريحة. بدون سعر PRO صريح تسري سياسة المتجر — والافتراضي «صريح فقط»: لا خصم مُختلق.
          الكلفة لا تظهر أبداً في الواجهة العامة.
          <span className="mx-1">Empty = null, 0 explicit. No explicit PRO price → store policy (default explicit-only: no discount). Cost never appears publicly.</span>
        </div>
      </Section>

      {/* 3. التوفر والشحن المسبق */}
      <Section ar="التوفر والشحن المسبق" en="Availability & pre-order" defaultOpen>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4 mb-4">
          <div>
            <L ar="نوع البيع" en="Selling type" />
            <div className="flex flex-wrap gap-3">
              {([
                { v: 'direct_sale', ar: 'بيع مباشر', en: 'direct' },
                { v: 'pre_order', ar: 'طلب مسبق', en: 'pre-order' },
                { v: 'bundle', ar: 'باقة', en: 'bundle' },
              ] as const).map((t) => (
                <label key={t.v} className="flex items-center gap-2 cursor-pointer bg-zinc-900 border border-zinc-700 rounded-xl px-4 py-3">
                  <input
                    type="radio" name="selling_type"
                    checked={doc.selling_type === t.v}
                    onChange={() => setDoc((d) => d && { ...d, selling_type: t.v })}
                    className="w-4 h-4 accent-[#6B46FF]"
                  />
                  <span className="text-white text-sm font-medium">{t.ar} <span className="text-zinc-500 text-xs">{t.en}</span></span>
                </label>
              ))}
            </div>
          </div>
          <div>
            <L ar="المخزون" en="Stock" hint="فارغ = غير محدود / empty = untracked" />
            <input
              type="number" min={0} dir="ltr"
              value={doc.stock === null ? '' : doc.stock}
              placeholder="غير محدود / unlimited"
              onChange={(e) => {
                const raw = e.target.value;
                if (raw === '') { setDoc((d) => d && { ...d, stock: null }); return; }
                const n = Math.floor(Number(raw));
                if (Number.isFinite(n) && n >= 0) setDoc((d) => d && { ...d, stock: n });
              }}
              className={inputCls}
            />
          </div>
        </div>

        {doc.selling_type === 'pre_order' && (
          <div>
            <L
              ar="وسائل شحن الطلب المسبق" en="Pre-order transports"
              hint="العمولة تُضاف فوق السعر وتُعفى لعضو PRO الفعّال فقط — رسم الضمان لا يُعفى أبداً"
            />
            <div className="flex flex-col gap-2">
              {METHODS.map(({ m, ar, en }) => {
                const offer = doc.preorder_transports.find((t) => t.method === m);
                const active = !!offer && offer.active;
                return (
                  <div key={m} className="flex flex-wrap items-center gap-3 bg-zinc-900 border border-zinc-700 rounded-xl p-3">
                    <label className="flex items-center gap-2 cursor-pointer min-w-[120px]">
                      <input
                        type="checkbox"
                        checked={active}
                        onChange={(e) => {
                          const on = e.target.checked;
                          setDoc((d) => {
                            if (!d) return d;
                            const rest = d.preorder_transports.filter((t) => t.method !== m);
                            const cur = d.preorder_transports.find((t) => t.method === m);
                            return {
                              ...d,
                              preorder_transports: [
                                ...rest,
                                { method: m, commission_iqd: cur?.commission_iqd ?? null, active: on },
                              ].sort((a, b) => METHODS.findIndex((x) => x.m === a.method) - METHODS.findIndex((x) => x.m === b.method)),
                            };
                          });
                        }}
                        className="w-5 h-5 accent-[#6B46FF]"
                      />
                      <span className="text-white text-sm font-bold">{ar} <span className="text-zinc-500 text-xs">{en}</span></span>
                    </label>
                    <div className="flex-1 min-w-[180px]">
                      <NullableIqd
                        disabled={!active}
                        value={offer?.commission_iqd ?? null}
                        placeholder="افتراضي الإدارة / admin default"
                        onChange={(v) => setDoc((d) => {
                          if (!d) return d;
                          return {
                            ...d,
                            preorder_transports: d.preorder_transports.map((t) =>
                              t.method === m ? { ...t, commission_iqd: v } : t
                            ),
                          };
                        })}
                      />
                    </div>
                    <span className="text-[10px] text-zinc-500">عمولة (د.ع) تُضاف / commission added</span>
                  </div>
                );
              })}
            </div>
          </div>
        )}
        <div className="text-[11px] text-zinc-500 mt-3">
          عضو PRO الفعّال: عمولة الشحن المسبق مُعفاة والتوصيل الأخير مجاني — رسم الضمان يبقى دائماً.
          <span className="mx-1">Active PRO: transport commission waived + free last-mile delivery; warranty fee never waived.</span>
        </div>
      </Section>

      {/* 4. العلامة والتصنيف */}
      <Section ar="العلامة والتصنيف" en="Brand & catalogs" defaultOpen>
        {taxErr && <ErrorBanner text={taxErr} />}
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <div>
            <L ar="العلامة التجارية" en="Brand" />
            <div className="flex gap-2">
              <select
                value={doc.brand_id ?? ''}
                onChange={(e) => setDoc((d) => d && { ...d, brand_id: e.target.value || null })}
                className={inputCls}
              >
                <option value="">بدون علامة / no brand</option>
                {brands.map((b) => (
                  <option key={b.id} value={b.id}>
                    {(b.name_ar || b.name_en || b.slug) + (b.active ? '' : ' (معطّلة)')}
                  </option>
                ))}
              </select>
              <button type="button" onClick={() => setBrandModal(true)} className={btnSecondary + ' shrink-0'}>
                <Plus className="w-4 h-4" /> علامة
              </button>
            </div>
          </div>
          <div>
            <L ar="التصنيفات" en="Catalogs" hint="يُحفظ الاختيار مع المنتج / saved with the product" />
            {catalogs.length === 0 ? (
              <div className="text-zinc-500 text-sm">لا تصنيفات بعد — أنشئها من إدارة التصنيفات. / no catalogs yet</div>
            ) : (
              <div className="flex flex-col gap-1 max-h-52 overflow-y-auto border border-zinc-800 rounded-xl p-2">
                {orderCatalogs(catalogs).map(({ cat, depth }) => (
                  <label key={cat.id} className="flex items-center gap-2 cursor-pointer py-1.5 px-1 rounded-lg hover:bg-zinc-800/50" style={{ paddingInlineStart: `${depth * 18 + 4}px` }}>
                    <input
                      type="checkbox"
                      checked={doc.catalog_ids.includes(cat.id)}
                      onChange={(e) => setDoc((d) => {
                        if (!d) return d;
                        const on = e.target.checked;
                        return {
                          ...d,
                          catalog_ids: on
                            ? [...d.catalog_ids, cat.id]
                            : d.catalog_ids.filter((x) => x !== cat.id),
                        };
                      })}
                      className="w-4 h-4 accent-[#6B46FF]"
                    />
                    <span className="text-sm text-zinc-200">
                      {cat.name_ar || cat.name_en || cat.slug}
                      {!cat.active && <span className="text-amber-400 text-[10px] mx-1">(معطّل)</span>}
                      {cat.is_printer_catalog && <span className="text-sky-400 text-[10px] mx-1">(طابعات)</span>}
                    </span>
                  </label>
                ))}
              </div>
            )}
          </div>
        </div>
      </Section>

      {/* 5-11 repeatable groups */}
      <OptionsSection doc={doc} setDoc={setDoc as React.Dispatch<React.SetStateAction<EditorDoc>>} />
      <ColorsSection doc={doc} setDoc={setDoc as React.Dispatch<React.SetStateAction<EditorDoc>>} />
      <MediaSection doc={doc} setDoc={setDoc as React.Dispatch<React.SetStateAction<EditorDoc>>} />
      <SpecsSection doc={doc} setDoc={setDoc as React.Dispatch<React.SetStateAction<EditorDoc>>} />
      <LabelsSection doc={doc} setDoc={setDoc as React.Dispatch<React.SetStateAction<EditorDoc>>} />
      <WarrantySection doc={doc} setDoc={setDoc as React.Dispatch<React.SetStateAction<EditorDoc>>} />
      <ContentBlocksSection doc={doc} setDoc={setDoc as React.Dispatch<React.SetStateAction<EditorDoc>>} />

      {/* live price preview */}
      {savedId ? (
        <PricePreview productId={savedId} savedDoc={savedDoc!} dirty={dirty} />
      ) : (
        <Section ar="معاينة السعر الحية" en="Live price preview">
          <div className="text-zinc-500 text-sm">
            احفظ المنتج أولاً — المعاينة تُحسب على الخادم من النسخة المحفوظة.
            <span className="mx-1">Save the product first; the quote is computed server-side from the saved version.</span>
          </div>
        </Section>
      )}

      {/* 12. استيراد وتصدير */}
      <TemplateTools
        productId={savedId || undefined}
        onApplied={(id) => {
          onListChanged();
          if (savedId && id === savedId) {
            load(savedId);
            setImportNote('تم تطبيق القالب على هذا المنتج وأُعيد تحميله. / Template applied; product reloaded.');
          } else {
            setImportNote(`تم تطبيق القالب على منتج آخر (${id}) — تجده في القائمة. / Applied to another product; see the list.`);
          }
        }}
      />

      {/* 13. استخراج من رابط */}
      <ExtractPanel setDoc={setDoc as React.Dispatch<React.SetStateAction<EditorDoc>>} />

      {/* sticky save bar */}
      <div className="fixed bottom-0 inset-x-0 z-40 bg-zinc-950/95 backdrop-blur border-t border-zinc-800">
        <div className="max-w-[1280px] mx-auto px-4 py-3 flex items-center justify-between gap-3 flex-wrap">
          <div className="flex items-center gap-3 text-xs min-w-0">
            {saveErr ? (
              <span className="text-red-400 font-medium truncate">{saveErr}</span>
            ) : saving ? (
              <span className="text-zinc-400 flex items-center gap-1"><RefreshCw className="w-3.5 h-3.5 animate-spin" /> جارٍ الحفظ…</span>
            ) : dirty ? (
              <span className="text-amber-400 font-bold">تغييرات غير محفوظة / unsaved changes</span>
            ) : savedAt ? (
              <span className="text-emerald-400">تم الحفظ / saved</span>
            ) : (
              <span className="text-zinc-600">لا تغييرات / no changes</span>
            )}
          </div>
          <div className="flex items-center gap-2">
            <button type="button" onClick={() => save(true)} disabled={saving} className={btnSecondary}>
              حفظ كمسودة / save draft
            </button>
            <button type="button" onClick={() => save(false)} disabled={saving} className={btnPrimary}>
              <Save className="w-4 h-4" /> حفظ / save
            </button>
          </div>
        </div>
      </div>

      {/* stale-edit dialog */}
      {staleOpen && (
        <Modal titleAr="تعارض في الحفظ" titleEn="Save conflict (409)" onClose={() => setStaleOpen(false)}>
          <div className="flex items-start gap-3 mb-4">
            <AlertTriangle className="w-5 h-5 text-amber-400 shrink-0 mt-0.5" />
            <p className="text-sm text-zinc-300">
              عدّل شخص آخر هذا المنتج منذ فتحته — لم يُحفظ شيء. أعد التحميل لرؤية النسخة الحالية (ستفقد تغييراتك غير المحفوظة هنا)، أو أغلق وانسخ تعديلاتك يدوياً أولاً.
              <span className="block text-xs text-zinc-500 mt-1">
                Someone else modified this product since you opened it. Nothing was saved. Reload to see the current version (your unsaved edits here will be lost), or close and copy your changes first.
              </span>
            </p>
          </div>
          <div className="flex gap-2">
            <button
              type="button"
              className={btnPrimary}
              onClick={() => { setStaleOpen(false); if (savedId) load(savedId); }}
            >
              <RefreshCw className="w-4 h-4" /> إعادة تحميل النسخة الحالية / reload
            </button>
            <button type="button" className={btnSecondary} onClick={() => setStaleOpen(false)}>
              إغلاق / close
            </button>
          </div>
        </Modal>
      )}

      {/* add-brand modal */}
      {brandModal && (
        <AddBrandModal
          onClose={() => setBrandModal(false)}
          onCreated={(b) => {
            setBrands((list) => [...list, b]);
            setDoc((d) => d && { ...d, brand_id: b.id });
            setBrandModal(false);
          }}
        />
      )}
    </div>
  );
}

// ---------------------------------------------------------------- helpers

function orderCatalogs(catalogs: CatalogV2[]): Array<{ cat: CatalogV2; depth: number }> {
  const byParent = new Map<string | null, CatalogV2[]>();
  for (const c of catalogs) {
    const k = c.parent_id ?? null;
    byParent.set(k, [...(byParent.get(k) ?? []), c]);
  }
  const out: Array<{ cat: CatalogV2; depth: number }> = [];
  const seen = new Set<string>();
  const walk = (parent: string | null, depth: number) => {
    for (const c of byParent.get(parent) ?? []) {
      if (seen.has(c.id)) continue;
      seen.add(c.id);
      out.push({ cat: c, depth });
      if (depth < 6) walk(c.id, depth + 1);
    }
  };
  walk(null, 0);
  // Orphans (parent not in the list) still shown, never silently dropped.
  for (const c of catalogs) if (!seen.has(c.id)) out.push({ cat: c, depth: 0 });
  return out;
}

function AddBrandModal({ onClose, onCreated }: { onClose: () => void; onCreated: (b: BrandV2) => void }) {
  const [nameAr, setNameAr] = useState('');
  const [nameEn, setNameEn] = useState('');
  const [nameCkb, setNameCkb] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const create = async () => {
    if (!nameAr.trim() || busy) return;
    setBusy(true); setErr(null);
    try {
      const res = await api.post<BrandResponse>('/api/admin/products-v2/brands', {
        name_ar: nameAr.trim(), name_en: nameEn.trim(), name_ckb: nameCkb.trim(),
      });
      onCreated(res.brand);
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : 'فشل إنشاء العلامة / failed');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal titleAr="علامة تجارية جديدة" titleEn="New brand" onClose={onClose}>
      <div className="flex flex-col gap-3">
        <div>
          <L ar="الاسم بالعربية (مطلوب)" en="Arabic name (required)" />
          <input value={nameAr} dir="rtl" onChange={(e) => setNameAr(e.target.value)} className={inputCls} />
        </div>
        <div>
          <L ar="الاسم بالإنجليزية" en="English name" />
          <input value={nameEn} dir="ltr" onChange={(e) => setNameEn(e.target.value)} className={inputCls} />
        </div>
        <div>
          <L ar="الاسم بالكوردية" en="Kurdish name" />
          <input value={nameCkb} dir="rtl" onChange={(e) => setNameCkb(e.target.value)} className={inputCls} />
        </div>
        {err && <div className="text-red-400 text-sm">{err}</div>}
        <div className="flex gap-2">
          <button type="button" onClick={create} disabled={busy || !nameAr.trim()} className={btnPrimary}>
            {busy ? 'جارٍ الإنشاء…' : 'إنشاء / create'}
          </button>
          <button type="button" onClick={onClose} className={btnSecondary}>إلغاء / cancel</button>
        </div>
      </div>
    </Modal>
  );
}
