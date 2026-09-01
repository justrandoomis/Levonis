/**
 * The rebuilt admin product form — mandate §1–§8.
 *
 * EIGHT SECTIONS, in the order the mandate lists them, as accordions with a
 * one-line summary and an item count when collapsed. Only one heavy section is
 * open at a time, so the page stays short and a save is always one scroll away.
 *
 * WHAT MAKES IT NOT OVERFLOW. The whole form lives inside a single
 * `max-w-[880px] min-w-0` column; every grid track is minmax(0,1fr); every
 * flex child that holds text carries min-w-0; the only horizontally scrolling
 * element is the combinations table, inside its own overflow-x-auto. That is
 * what the 360/390/768/1024/1440 checks in §12 are testing.
 *
 * THE SAVE BAR is sticky at the bottom of the CONTENT column, not fixed to the
 * viewport, so it cannot cover the admin sidebar or the app's bottom nav. It
 * carries the four things §1 asks for: save draft, preview, publish/save, and
 * the current change state with readable errors.
 *
 * ENGLISH ONLY (§3). There is no Arabic or Kurdish input anywhere; the labels
 * are Arabic because the panel is, the VALUES are English and every input is
 * dir="ltr". The Arabic and Kurdish copies are produced by the local
 * translator on the server, and the fields it could not translate come back in
 * `translation_review_needed` and are shown honestly after saving.
 *
 * TWO ENDPOINTS, ONE SAVE. The document goes to /api/admin/products-v2 and the
 * structure to /api/admin/products/:id/relations. A new product must exist
 * before its structure can reference it, so the document is saved first and the
 * relations immediately after; a failure in the second step is reported as
 * exactly that, never as a whole-form failure.
 */

import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { ArrowRight, ArrowLeft, Save, Eye, RefreshCw, AlertTriangle, Check } from 'lucide-react';
import { api, ApiError, formatIqd } from '../../lib/api';
import { useLanguage } from '../../LanguageContext';
import { useAuth } from '../../AuthContext';
import type { BrandV2, CatalogV2 } from '../../lib/productTypes';
import { blankDoc, toEditorDoc, type EditorDoc, type ProductResponse, type SaveResponse } from './types';
import {
  Banner,
  CheckCard,
  Field,
  Grid,
  Money,
  Qty,
  SectionCard,
  Select,
  TextArea,
  TextInput,
  Toggle,
  btnGhost,
  btnPrimary,
} from './form/formUi';
import {
  emptyRelations,
  relationsFromWire,
  relationsToWire,
  summarize,
  validateForm,
  type FormErrors,
  type RelationsState,
  type SaleType,
} from './form/model';
import { OptionsSection } from './form/OptionsSection';
import { UsageGuideSection } from './form/UsageGuideSection';
import PricePreview from './PricePreview';
import { ImagesSection } from './form/ImagesSection';

interface TemplateField {
  id: string;
  label_ar: string;
  label_en: string;
  type: 'text' | 'number' | 'select' | 'multiline' | 'hex';
  unit?: string;
  options?: string[];
  hint_ar?: string;
}
interface TemplateGroup {
  id: string;
  label_ar: string;
  label_en: string;
  fields: TemplateField[];
}

interface CatalogNode extends CatalogV2 {
  parent_id: string | null;
  effective_template_family: 'devices' | 'materials' | null;
}

interface FacetRow {
  id: string;
  name_en: string;
  name_ar: string;
  kind: string;
  active: boolean;
}

// «باقة» is gone from this list on the owner's order: bundles are now their
// own admin-composed entity (the الباقات tab), not a per-product checkbox.
// The backend still accepts the legacy 'bundle' value so old rows load.
const SALE_TYPES: Array<{ id: SaleType; ar: string; en: string; sub: string }> = [
  { id: 'direct_sale', ar: 'بيع مباشر', en: 'Direct sale', sub: 'يُشحن من المخزون' },
  { id: 'pre_order', ar: 'طلب مسبق', en: 'Pre-order', sub: 'يُطلب ثم يُشحن' },
];

/** The three pre-order journeys, with the owner's wording. */
const TRANSPORTS: Array<{ method: 'air' | 'sea' | 'land'; ar: string; en: string }> = [
  { method: 'land', ar: 'بري', en: 'Land' },
  { method: 'air', ar: 'جوي', en: 'Air' },
  { method: 'sea', ar: 'بحري', en: 'Sea' },
];

export default function ProductForm({
  productId,
  onBack,
  onListChanged,
}: {
  productId: string | null;
  onBack: () => void;
  onListChanged: () => void;
}) {
  const { dir } = useLanguage();
  const { user } = useAuth();
  // §11: cost is only rendered for a financial admin. The SERVER refuses to
  // read or write it either way — this only avoids showing an input that
  // would be rejected.
  const canSeeCost = user?.can_view_financials !== false;

  const [doc, setDoc] = useState<EditorDoc>(() => blankDoc());
  const [rel, setRel] = useState<RelationsState>(() => emptyRelations());
  const [baseline, setBaseline] = useState('');
  const [loadedUpdatedAt, setLoadedUpdatedAt] = useState('');
  const [loading, setLoading] = useState(!!productId);
  const [loadErr, setLoadErr] = useState<string | null>(null);

  const [brands, setBrands] = useState<BrandV2[]>([]);
  const [catalogs, setCatalogs] = useState<CatalogNode[]>([]);
  const [facets, setFacets] = useState<FacetRow[]>([]);
  const [tplGroups, setTplGroups] = useState<TemplateGroup[]>([]);
  const [brandSearch, setBrandSearch] = useState('');
  // Hashtags always existed on the doc (round-tripped by every save) — this
  // is their first actual INPUT: draft text, committed on Enter/comma/blur.
  const [hashtagDraft, setHashtagDraft] = useState('');
  const commitHashtag = () => {
    const tag = hashtagDraft.replace(/^#/, '').trim().replace(/\s+/g, '-').slice(0, 40);
    setHashtagDraft('');
    if (!tag) return;
    setDoc((d) => (d.hashtags.includes(tag) ? d : { ...d, hashtags: [...d.hashtags, tag] }));
  };

  const [open, setOpen] = useState(1);
  const [saving, setSaving] = useState(false);
  const [saveErr, setSaveErr] = useState<string | null>(null);
  const [saveNote, setSaveNote] = useState<string | null>(null);
  const [reviewNeeded, setReviewNeeded] = useState<string[]>([]);
  const [showErrors, setShowErrors] = useState(false);
  const [previewOpen, setPreviewOpen] = useState(false);

  // ------------------------------------------------------------- loading

  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const [b, cat, fc] = await Promise.all([
          api.get<{ brands: BrandV2[] }>('/api/admin/taxonomy/brands'),
          api.get<{ catalogs: CatalogNode[] }>('/api/admin/taxonomy/catalogs'),
          api.get<{ facets: FacetRow[] }>('/api/admin/taxonomy/facets'),
        ]);
        if (!alive) return;
        setBrands(b.brands ?? []);
        setCatalogs(cat.catalogs ?? []);
        setFacets((fc.facets ?? []).filter((f) => f.active));
      } catch {
        // The taxonomy is not required to edit prices or text; the section
        // says so rather than blocking the whole form.
        if (alive) setCatalogs([]);
      }
    })();
    return () => {
      alive = false;
    };
  }, []);

  const loadProduct = useCallback(async (id: string) => {
    setLoading(true);
    setLoadErr(null);
    try {
      const [p, r] = await Promise.all([
        api.get<ProductResponse>(`/api/admin/products-v2/${id}`),
        api.get<Parameters<typeof relationsFromWire>[0]>(`/api/admin/products/${id}/relations`),
      ]);
      const d = toEditorDoc(p.product);
      const rs = relationsFromWire(r);
      setDoc(d);
      setRel(rs);
      setLoadedUpdatedAt(p.product.updated_at ?? '');
      setBaseline(JSON.stringify({ d, rs }));
    } catch (e) {
      setLoadErr(e instanceof ApiError ? e.message : 'تعذّر تحميل المنتج / failed to load');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (productId) void loadProduct(productId);
    else {
      const d = blankDoc();
      const rs = emptyRelations();
      setDoc(d);
      setRel(rs);
      setBaseline(JSON.stringify({ d, rs }));
      setLoading(false);
    }
  }, [productId, loadProduct]);

  // Template fields follow the chosen section (§1: only relevant fields).
  useEffect(() => {
    const id = doc.sub_category_id || doc.category_id;
    if (!id) {
      setTplGroups([]);
      return;
    }
    let alive = true;
    (async () => {
      try {
        const res = await api.get<{ groups: TemplateGroup[]; template_family: string | null }>(
          `/api/admin/taxonomy/templates?category=${encodeURIComponent(id)}`
        );
        if (!alive) return;
        setTplGroups(res.groups ?? []);
        if (res.template_family && res.template_family !== doc.template_family) {
          setDoc((d) => ({ ...d, template_family: res.template_family }));
        }
      } catch {
        if (alive) setTplGroups([]);
      }
    })();
    return () => {
      alive = false;
    };
  }, [doc.category_id, doc.sub_category_id, doc.template_family]);

  // ------------------------------------------------------------- derived

  const roots = useMemo(() => catalogs.filter((c) => !c.parent_id && c.active), [catalogs]);
  const children = useMemo(
    () => catalogs.filter((c) => c.parent_id === doc.category_id && c.active),
    [catalogs, doc.category_id]
  );
  const filteredBrands = useMemo(() => {
    const q = brandSearch.trim().toLowerCase();
    if (!q) return brands.slice(0, 200);
    return brands.filter((b) => `${b.name_en} ${b.name_ar} ${b.slug}`.toLowerCase().includes(q)).slice(0, 200);
  }, [brands, brandSearch]);

  const dirty = baseline !== '' && JSON.stringify({ d: doc, rs: rel }) !== baseline;

  const errors: FormErrors = useMemo(
    () =>
      validateForm({
        name_en: doc.name_en,
        price_iqd: doc.price_iqd,
        prime_price_iqd: doc.prime_price_iqd,
        pro_price_iqd: doc.pro_price_iqd,
        product_cost_iqd: doc.product_cost_iqd,
        category_id: doc.category_id,
        sale_types: doc.sale_types as SaleType[],
        rel,
        publishing: doc.status === 'active',
      }),
    [doc, rel]
  );
  const errorList = Object.values(errors);
  const err = (k: string) => (showErrors ? (errors[k] ?? null) : null);

  const setSale = (t: SaleType, on: boolean) =>
    setDoc((d) => {
      const next = on ? [...new Set([...d.sale_types, t])] : d.sale_types.filter((x) => x !== t);
      return { ...d, sale_types: next as EditorDoc['sale_types'], selling_type: (next[0] ?? 'direct_sale') as EditorDoc['selling_type'] };
    });

  // -------------------------------------------------------------- saving

  const save = async (status: 'draft' | 'active') => {
    setShowErrors(true);
    const next = { ...doc, status } as EditorDoc;
    const check = validateForm({
      name_en: next.name_en,
      price_iqd: next.price_iqd,
      prime_price_iqd: next.prime_price_iqd,
      pro_price_iqd: next.pro_price_iqd,
      product_cost_iqd: next.product_cost_iqd,
      category_id: next.category_id,
      sale_types: next.sale_types as SaleType[],
      rel,
      publishing: status === 'active',
    });
    if (Object.keys(check).length > 0) {
      setSaveErr('راجع الحقول المعلّمة بالأحمر قبل الحفظ.');
      return;
    }

    setSaving(true);
    setSaveErr(null);
    setSaveNote(null);
    try {
      const body: Record<string, unknown> = {
        ...next,
        expected_updated_at: loadedUpdatedAt || undefined,
      };
      const res = await api.post<SaveResponse & { translation_review_needed?: string[] }>(
        '/api/admin/products-v2',
        body
      );
      const savedId = res.product?.id ?? next.id;
      setReviewNeeded(res.translation_review_needed ?? []);

      // The structure needs the product to exist, so it always follows.
      try {
        const rres = await api.put<Parameters<typeof relationsFromWire>[0] & { errors?: string[] }>(
          `/api/admin/products/${savedId}/relations`,
          relationsToWire(rel)
        );
        setRel(relationsFromWire(rres));
      } catch (e) {
        // The product IS saved. Saying otherwise would be a lie, and the admin
        // would re-save and create a duplicate.
        setSaveNote(
          `حُفظ المنتج، لكن تعذّر حفظ الخيارات/الصور: ${
            e instanceof ApiError ? e.message : 'خطأ غير معروف'
          }. أعد المحاولة من هذه الصفحة.`
        );
      }

      const fresh = res.product ? toEditorDoc(res.product) : next;
      setDoc(fresh);
      setLoadedUpdatedAt(res.product?.updated_at ?? loadedUpdatedAt);
      setBaseline(JSON.stringify({ d: fresh, rs: rel }));
      setShowErrors(false);
      onListChanged();
      if (!productId && savedId) {
        // Reload so the new id is reflected everywhere (relations, preview).
        void loadProduct(savedId);
      }
    } catch (e) {
      setSaveErr(e instanceof ApiError ? e.message : 'فشل الحفظ / save failed');
    } finally {
      setSaving(false);
    }
  };

  // --------------------------------------------------------------- render

  if (loading) {
    return (
      <div className="p-6 text-center text-zinc-400 text-sm">
        <RefreshCw className="w-5 h-5 animate-spin mx-auto mb-2" /> جارٍ التحميل…
      </div>
    );
  }
  if (loadErr) {
    return (
      <div className="p-4">
        <Banner kind="error">{loadErr}</Banner>
        <button type="button" className={btnGhost} onClick={onBack}>
          رجوع
        </button>
      </div>
    );
  }

  const Back = dir === 'rtl' ? ArrowRight : ArrowLeft;
  const section = (n: number) => ({
    open: open === n,
    onToggle: () => setOpen((o) => (o === n ? 0 : n)),
  });

  const valueCount = rel.groups.reduce((n, g) => n + g.values.length, 0);

  return (
    // min-w-0 on the outer column is what keeps a long value from widening the
    // whole admin page; pb-24 leaves room for the sticky bar below.
    <div className="min-w-0 w-full max-w-[880px] mx-auto px-3 pb-24">
      <div className="flex items-center gap-2 py-3 min-w-0">
        <button type="button" onClick={onBack} className={`${btnGhost} h-10 px-2.5`} aria-label="رجوع">
          <Back className="w-4 h-4" />
        </button>
        <h2 className="text-base font-black text-white truncate min-w-0 flex-1">
          {productId ? 'تعديل منتج' : 'منتج جديد'}
          <span className="text-[11px] font-medium text-zinc-500 ms-2">{doc.name_en || '—'}</span>
        </h2>
        <span
          className={`shrink-0 text-[11px] font-bold px-2 py-1 rounded-md ${
            doc.status === 'active'
              ? 'bg-emerald-500/15 text-emerald-300'
              : doc.status === 'draft'
                ? 'bg-zinc-700 text-zinc-300'
                : 'bg-amber-500/15 text-amber-300'
          }`}
        >
          {doc.status === 'active' ? 'منشور' : doc.status === 'draft' ? 'مسودة' : 'مخفي'}
        </span>
      </div>

      {saveErr && <Banner kind="error">{saveErr}</Banner>}
      {saveNote && <Banner kind="warn">{saveNote}</Banner>}
      {reviewNeeded.length > 0 && (
        <Banner kind="warn">
          حُفظ المنتج. لم يستطع المترجم المحلي ترجمة {reviewNeeded.length} حقلًا بأمان، فبقيت بالإنجليزية وعُلّمت
          للمراجعة: <span className="font-mono text-[11px]">{reviewNeeded.slice(0, 6).join(', ')}</span>
        </Banner>
      )}

      {/* 1 ──────────────── classification: section → sub-section → brand →
          hashtags, in that exact order (the owner's «اعد ترتيبه»). The
          derived template and the facet filters follow as secondary rows. */}
      <SectionCard
        n={1}
        ar="التصنيف: القسم والعلامة والهاشتاقات"
        en="Classification"
        summary={summarize([
          catalogs.find((c) => c.id === doc.category_id)?.name_en ?? 'بلا قسم',
          brands.find((b) => b.id === doc.brand_id)?.name_en,
          doc.hashtags.length ? `#${doc.hashtags.length}` : undefined,
        ])}
        error={showErrors && !!errors.category_id}
        {...section(1)}
      >
        <Grid cols={2}>
          <Field ar="١· القسم الرئيسي" en="Main section" required error={err('category_id')}>
            <Select
              value={doc.category_id ?? ''}
              onChange={(e) =>
                setDoc((d) => ({ ...d, category_id: e.target.value || null, sub_category_id: null }))
              }
            >
              <option value="">— اختر —</option>
              {roots.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name_ar} · {c.name_en}
                </option>
              ))}
            </Select>
          </Field>
          <Field ar="٢· القسم الفرعي" en="Sub-section" hint={doc.category_id ? undefined : 'اختر القسم الرئيسي أولًا'}>
            <Select
              value={doc.sub_category_id ?? ''}
              disabled={!doc.category_id || children.length === 0}
              onChange={(e) => setDoc((d) => ({ ...d, sub_category_id: e.target.value || null }))}
            >
              <option value="">— بدون —</option>
              {children.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name_ar} · {c.name_en}
                </option>
              ))}
            </Select>
          </Field>
          <Field ar="٣· العلامة التجارية" en="Brand">
            <div className="flex gap-1.5 min-w-0">
              <Select
                className="flex-1"
                value={doc.brand_id ?? ''}
                onChange={(e) => setDoc((d) => ({ ...d, brand_id: e.target.value || null }))}
              >
                <option value="">— بدون —</option>
                {filteredBrands.map((b) => (
                  <option key={b.id} value={b.id}>
                    {b.name_en || b.name_ar}
                  </option>
                ))}
              </Select>
              <TextInput
                className="!w-28 shrink-0"
                value={brandSearch}
                onChange={(e) => setBrandSearch(e.target.value)}
                placeholder="بحث…"
                aria-label="بحث عن علامة"
              />
            </div>
          </Field>
          <Field
            ar="٤· الهاشتاقات"
            en="Hashtags"
            hint="Enter أو فاصلة لإضافة وسم"
            tip="وسوم حرّة تُستخدم في البحث والاكتشاف. تُحفظ مع المنتج كما تكتبها."
          >
            <div className="min-w-0">
              <TextInput
                value={hashtagDraft}
                onChange={(e) => setHashtagDraft(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' || e.key === ',') {
                    e.preventDefault();
                    commitHashtag();
                  }
                }}
                onBlur={commitHashtag}
                placeholder="#tag"
              />
              {doc.hashtags.length > 0 && (
                <div className="flex flex-wrap gap-1 mt-1.5">
                  {doc.hashtags.map((h) => (
                    <span
                      key={h}
                      className="inline-flex items-center gap-1 bg-zinc-800 border border-zinc-700 rounded-full px-2 h-6 text-[11px] text-zinc-200"
                    >
                      <span dir="ltr">#{h}</span>
                      <button
                        type="button"
                        aria-label={`حذف ${h}`}
                        className="text-zinc-500 hover:text-red-400"
                        onClick={() => setDoc((d) => ({ ...d, hashtags: d.hashtags.filter((x) => x !== h) }))}
                      >
                        ×
                      </button>
                    </span>
                  ))}
                </div>
              )}
            </div>
          </Field>
          <Field
            ar="القالب"
            en="Template"
            hint="يُشتق من القسم"
            tip="القالب يحدد حقول المواصفات وأعمدة الاستيراد. يأتي من إعداد القسم في شجرة الأقسام."
          >
            <TextInput value={doc.template_family ?? ''} readOnly placeholder="—" />
          </Field>
        </Grid>

        {facets.length > 0 && (
          <div className="mt-3 min-w-0">
            <div className="text-[13px] font-bold text-zinc-300 mb-1.5">
              الفلاتر <span className="text-[11px] font-medium text-zinc-500">Filters — separate from sections</span>
            </div>
            <div className="grid gap-1.5 [grid-template-columns:repeat(auto-fill,minmax(150px,1fr))]">
              {facets.map((f) => (
                <CheckCard
                  key={f.id}
                  checked={rel.facet_ids.includes(f.id)}
                  onChange={(on) =>
                    setRel((r) => ({
                      ...r,
                      facet_ids: on ? [...r.facet_ids, f.id] : r.facet_ids.filter((x) => x !== f.id),
                    }))
                  }
                  title={f.name_en || f.name_ar}
                  sub={f.kind}
                />
              ))}
            </div>
          </div>
        )}
      </SectionCard>

      {/* 2 ────────────────────────────────────────────────── basic details */}
      <SectionCard
        n={2}
        ar="المعلومات الأساسية"
        en="Basics"
        summary={doc.name_en || 'بلا اسم'}
        error={showErrors && !!errors.name_en}
        {...section(2)}
      >
        <Grid cols={2}>
          <Field
            ar="الاسم"
            en="Name (English)"
            required
            error={err('name_en')}
            tip="اسم المنتج يبقى بالإنجليزية في كل اللغات ولا تتم ترجمته."
            span
          >
            <TextInput value={doc.name_en} onChange={(e) => setDoc((d) => ({ ...d, name_en: e.target.value }))} />
          </Field>
          <Field
            ar="الوصف"
            en="Description (English)"
            hint="يُترجم محليًا إلى العربية والكردية بعد الحفظ"
            span
          >
            <TextArea
              value={doc.description_en}
              onChange={(e) => setDoc((d) => ({ ...d, description_en: e.target.value }))}
            />
          </Field>
          <Field ar="SKU" en="SKU" hint="اختياري">
            <TextInput value={doc.sku ?? ''} onChange={(e) => setDoc((d) => ({ ...d, sku: e.target.value || null }))} />
          </Field>
          <Field ar="الحالة" en="Status">
            <Select
              value={doc.status}
              onChange={(e) => setDoc((d) => ({ ...d, status: e.target.value as EditorDoc['status'] }))}
            >
              <option value="draft">مسودة</option>
              <option value="active">منشور</option>
              <option value="hidden">مخفي</option>
            </Select>
          </Field>
          <Field ar="ترتيب العرض" en="Display order">
            <Qty
              value={doc.display_order}
              onChange={(v) => setDoc((d) => ({ ...d, display_order: v ?? 0 }))}
              placeholder="0"
            />
          </Field>
          <Field ar="مميز" en="Featured">
            <Toggle
              checked={doc.is_featured}
              onChange={(b) => setDoc((d) => ({ ...d, is_featured: b }))}
              label={doc.is_featured ? 'يظهر في المميزة' : 'عادي'}
            />
          </Field>
        </Grid>
      </SectionCard>

      {/* 3 ──────────────────────────────────────────── prices, memberships */}
      <SectionCard
        n={3}
        ar="الأسعار والعضويات"
        en="Prices & memberships"
        summary={summarize([
          doc.price_iqd !== null ? formatIqd(doc.price_iqd) : 'بلا سعر',
          doc.prime_price_iqd !== null ? `PRIME ${formatIqd(doc.prime_price_iqd)}` : null,
          doc.pro_price_iqd !== null ? `PRO ${formatIqd(doc.pro_price_iqd)}` : null,
        ])}
        error={showErrors && (!!errors.price_iqd || !!errors.prices)}
        {...section(3)}
      >
        {showErrors && errors.prices && <Banner kind="error">{errors.prices}</Banner>}
        <Grid cols={3}>
          <Field ar="السعر الاعتيادي" en="Regular" required error={err('price_iqd')}>
            <Money
              required
              value={doc.price_iqd}
              onChange={(v) => setDoc((d) => ({ ...d, price_iqd: v ?? 0 }))}
            />
          </Field>
          <Field
            ar="سعر LEVO PRIME"
            en="PRIME"
            hint="فارغ = السعر الاعتيادي"
            tip="خصم PRIME أقل من PRO. الترتيب المطلوب: PRO ≤ PRIME ≤ الاعتيادي."
          >
            <Money value={doc.prime_price_iqd} onChange={(v) => setDoc((d) => ({ ...d, prime_price_iqd: v }))} />
          </Field>
          <Field ar="سعر LEVO PRO" en="PRO" hint="فارغ = سياسة المتجر">
            <Money value={doc.pro_price_iqd} onChange={(v) => setDoc((d) => ({ ...d, pro_price_iqd: v }))} />
          </Field>
          {canSeeCost && (
            <Field ar="التكلفة" en="Cost" tip="إداري فقط — لا تظهر للعميل ولا لمساعد الأدمن، ولا في أي تصدير.">
              <Money value={doc.product_cost_iqd} onChange={(v) => setDoc((d) => ({ ...d, product_cost_iqd: v }))} />
            </Field>
          )}
        </Grid>
      </SectionCard>

      {/* 4 ─────────────────────────────────────── sale types, availability */}
      <SectionCard
        n={4}
        ar="البيع والتوفر والمخزون"
        en="Selling & stock"
        summary={summarize([
          doc.sale_types.map((t) => SALE_TYPES.find((s) => s.id === t)?.ar ?? t).join(' + '),
          rel.inventory_mode,
          doc.stock === null ? 'غير محدود' : `${doc.stock} قطعة`,
        ])}
        error={showErrors && !!errors.sale_types}
        {...section(4)}
      >
        {showErrors && errors.sale_types && <Banner kind="error">{errors.sale_types}</Banner>}
        <div className="grid gap-2 [grid-template-columns:repeat(auto-fill,minmax(160px,1fr))] mb-2">
          {SALE_TYPES.map((t) => (
            <CheckCard
              key={t.id}
              checked={doc.sale_types.includes(t.id)}
              onChange={(on) => setSale(t.id, on)}
              title={t.ar}
              sub={t.sub}
            />
          ))}
        </div>
        <p className="text-[11px] text-zinc-500 mb-3">
          يمكن تفعيل النوعين معًا. الافتراضي للعميل: بيع مباشر عند توفر المخزون، وإلا الطلب المسبق.
        </p>

        {/* Availability pricing — the owner's model: immediacy has a price
            the way each journey has one. Direct +X, and each pre-order
            transport its own commission. The CUSTOMER only ever sees final
            numbers; these inputs are the admin's side of that promise. */}
        {doc.sale_types.includes('direct_sale') && (
          <div className="mb-3 min-w-0">
            <Grid cols={3}>
              <Field
                ar="زيادة البيع المباشر"
                en="Direct premium"
                hint="تُضاف على السعر عند الشراء الفوري من المخزون. فارغ = بلا زيادة"
                tip="مثال: السعر ١٠٠ ألف والزيادة ٥٠ ألفًا — يرى الزبون ١٥٠ ألفًا كسعر نهائي للبيع المباشر، ولا تُعرض له الزيادة كبند منفصل."
              >
                <Money
                  value={doc.direct_surcharge_iqd}
                  onChange={(v) => setDoc((d) => ({ ...d, direct_surcharge_iqd: v }))}
                  placeholder="بلا زيادة"
                />
              </Field>
            </Grid>
          </div>
        )}
        {doc.sale_types.includes('pre_order') && (
          <div className="mb-3 min-w-0">
            <div className="text-[12px] font-bold text-zinc-300 mb-1.5">
              طرق الطلب المسبق وزياداتها{' '}
              <span className="text-[10px] font-medium text-zinc-500">Pre-order transports</span>
            </div>
            <div className="grid gap-2 [grid-template-columns:repeat(auto-fill,minmax(190px,1fr))]">
              {TRANSPORTS.map((t) => {
                const offer = doc.preorder_transports.find((o) => o.method === t.method);
                const active = offer?.active === true;
                return (
                  <div
                    key={t.method}
                    className={`rounded-lg border p-2.5 min-w-0 ${
                      active ? 'bg-[#6B46FF]/5 border-[#6B46FF]/40' : 'bg-zinc-800/30 border-zinc-700'
                    }`}
                  >
                    <Toggle
                      checked={active}
                      onChange={(on) =>
                        setDoc((d) => {
                          const rest = d.preorder_transports.filter((o) => o.method !== t.method);
                          const current = d.preorder_transports.find((o) => o.method === t.method);
                          return {
                            ...d,
                            preorder_transports: [
                              ...rest,
                              { method: t.method, commission_iqd: current?.commission_iqd ?? null, active: on },
                            ],
                          };
                        })
                      }
                      label={t.ar}
                      sub={t.en}
                    />
                    {active && (
                      <div className="mt-1.5">
                        <Money
                          value={offer?.commission_iqd ?? null}
                          onChange={(v) =>
                            setDoc((d) => ({
                              ...d,
                              preorder_transports: d.preorder_transports.map((o) =>
                                o.method === t.method ? { ...o, commission_iqd: v } : o
                              ),
                            }))
                          }
                          placeholder="الافتراضي العام"
                        />
                        <p className="text-[10px] text-zinc-500 mt-1">الزيادة بالدينار. فارغ = القيمة الافتراضية من الإعدادات</p>
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          </div>
        )}

        <Grid cols={3}>
          <Field
            ar="مخزون المنتج"
            en="Base stock"
            hint={
              rel.inventory_mode === 'BASE'
                ? 'المصدر المعتمد حاليًا'
                : 'مرجع عام — التوفر يُحسب من مخزون الخيارات/الألوان تلقائيًا'
            }
          >
            <Qty value={doc.stock} onChange={(v) => setDoc((d) => ({ ...d, stock: v }))} />
          </Field>
          <Field ar="حد التنبيه" en="Low-stock">
            <Qty
              value={doc.low_stock_threshold}
              onChange={(v) => setDoc((d) => ({ ...d, low_stock_threshold: v }))}
              placeholder="بدون / none"
            />
          </Field>
        </Grid>
      </SectionCard>

      {/* 5 ────────────────────────────────────────── options and colours */}
      <SectionCard
        n={5}
        ar="الخيارات والألوان"
        en="Options & colours"
        count={valueCount + rel.colors.length}
        summary={summarize([
          `${rel.groups.length} مجموعة`,
          `${valueCount} قيمة`,
          `${rel.colors.length} لون`,
          rel.inventory_mode,
        ])}
        error={showErrors && Object.keys(errors).some((k) => k.startsWith('group') || k.startsWith('value') || k.startsWith('color') || k.startsWith('variant') || k === 'inventory_mode')}
        {...section(5)}
      >
        <OptionsSection rel={rel} setRel={setRel} canSeeCost={canSeeCost} errors={showErrors ? errors : {}} />
      </SectionCard>

      {/* 6 ───────────────────────────────────────────────────────── images */}
      <SectionCard
        n={6}
        ar="الصور"
        en="Images"
        count={rel.images.length}
        summary={rel.images.length === 0 ? 'لا صور' : `${rel.images.length} صورة · رئيسية محددة`}
        error={showErrors && !!errors.images}
        {...section(6)}
      >
        <ImagesSection rel={rel} setRel={setRel} errors={showErrors ? errors : {}} />
      </SectionCard>

      {/* 7 ── template specs (responsive to the section & branch — a Bambu
             A1 asks printer questions, a filament asks material questions,
             an accessory its own) + the structured usage/setup guide. */}
      <SectionCard
        n={7}
        ar="المواصفات والمحتوى الإضافي"
        en="Specifications & extras"
        count={Object.keys(doc.spec_fields ?? {}).length + doc.usage_guide.steps.length}
        summary={summarize([
          tplGroups.length === 0
            ? 'اختر قسمًا لعرض حقول القالب'
            : `${tplGroups.reduce((n, g) => n + g.fields.length, 0)} حقل`,
          doc.usage_guide.steps.length ? `${doc.usage_guide.steps.length} خطوة دليل` : undefined,
        ])}
        {...section(7)}
      >
        {tplGroups.length === 0 ? (
          <p className="text-[12px] text-zinc-500 mb-3">
            حقول المواصفات تتبع القسم والقالب. اختر القسم الرئيسي في القسم رقم 1 لتظهر هنا.
          </p>
        ) : (
          <div className="space-y-4 mb-4">
            {tplGroups.map((g) => (
              <div key={g.id} className="min-w-0">
                <h4 className="text-[13px] font-bold text-zinc-300 mb-2 truncate">
                  {g.label_ar} <span className="text-[11px] font-medium text-zinc-500">{g.label_en}</span>
                </h4>
                <Grid cols={2}>
                  {g.fields.map((f) => (
                    <Field
                      key={f.id}
                      ar={f.label_ar}
                      en={f.unit ? `${f.label_en} (${f.unit})` : f.label_en}
                      hint={f.hint_ar}
                      span={f.type === 'multiline'}
                    >
                      {f.type === 'select' ? (
                        <Select
                          value={doc.spec_fields?.[f.id] ?? ''}
                          onChange={(e) =>
                            setDoc((d) => ({ ...d, spec_fields: { ...d.spec_fields, [f.id]: e.target.value } }))
                          }
                        >
                          <option value="">—</option>
                          {(f.options ?? []).map((o) => (
                            <option key={o} value={o}>
                              {o}
                            </option>
                          ))}
                        </Select>
                      ) : f.type === 'multiline' ? (
                        <TextArea
                          value={doc.spec_fields?.[f.id] ?? ''}
                          onChange={(e) =>
                            setDoc((d) => ({ ...d, spec_fields: { ...d.spec_fields, [f.id]: e.target.value } }))
                          }
                        />
                      ) : (
                        <TextInput
                          inputMode={f.type === 'number' ? 'numeric' : undefined}
                          value={doc.spec_fields?.[f.id] ?? ''}
                          onChange={(e) =>
                            setDoc((d) => ({ ...d, spec_fields: { ...d.spec_fields, [f.id]: e.target.value } }))
                          }
                        />
                      )}
                    </Field>
                  ))}
                </Grid>
              </div>
            ))}
          </div>
        )}

        {/* The structured guide — and the legacy free text BELOW it, always
            editable (it used to vanish for template-less products). */}
        <UsageGuideSection
          guide={doc.usage_guide}
          onChange={(next) => setDoc((d) => ({ ...d, usage_guide: next }))}
        />
        <div className="mt-4">
          <Field
            ar="طريقة الاستخدام (نص حر)"
            en="How to use (free text)"
            hint="يُعرض للزبون فقط عندما لا توجد خطوات في الدليل أعلاه"
            span
          >
            <TextArea
              value={doc.how_to_use}
              onChange={(e) => setDoc((d) => ({ ...d, how_to_use: e.target.value }))}
            />
          </Field>
        </div>
      </SectionCard>

      {/* 8 ────────────────────────────────────────────── preview and save */}
      <SectionCard
        n={8}
        ar="المعاينة والحفظ"
        en="Preview & save"
        summary={dirty ? 'تغييرات غير محفوظة' : 'محفوظ'}
        {...section(8)}
      >
        <div className="space-y-2 text-[12px] text-zinc-300 min-w-0">
          <Row k="الاسم" v={doc.name_en || '—'} />
          <Row k="القسم" v={catalogs.find((c) => c.id === doc.category_id)?.name_en ?? '—'} />
          <Row k="السعر" v={doc.price_iqd === null ? '—' : formatIqd(doc.price_iqd)} />
          <Row
            k="PRIME / PRO"
            v={`${doc.prime_price_iqd === null ? '—' : formatIqd(doc.prime_price_iqd)} / ${
              doc.pro_price_iqd === null ? '—' : formatIqd(doc.pro_price_iqd)
            }`}
          />
          <Row k="أنواع البيع" v={doc.sale_types.join(' + ')} />
          <Row k="مصدر المخزون" v={rel.inventory_mode} />
          <Row k="الخيارات / الألوان" v={`${valueCount} / ${rel.colors.length}`} />
          <Row k="الصور" v={String(rel.images.length)} />
        </div>
        {previewOpen && (
          <div className="mt-3 rounded-lg border border-zinc-800 bg-black/30 p-3 min-w-0">
            <pre className="text-[11px] text-zinc-400 overflow-x-auto" dir="ltr">
              {JSON.stringify({ doc: { ...doc, spec_fields: doc.spec_fields }, relations: relationsToWire(rel) }, null, 2)}
            </pre>
          </div>
        )}
        <button
          type="button"
          className={`${btnGhost} mt-3`}
          onClick={() => setPreviewOpen((v) => !v)}
        >
          <Eye className="w-4 h-4" /> {previewOpen ? 'إخفاء' : 'عرض'} البيانات المرسلة
        </button>

        {/* The resolver's own answer, per membership tier — computed on the
            server so the preview can never disagree with checkout. It reflects
            the last SAVED version, which the panel states when the form is
            dirty rather than showing a stale number as current. */}
        {doc.id && (
          <div className="mt-3">
            <PricePreview productId={doc.id} savedDoc={doc} dirty={dirty} />
          </div>
        )}
      </SectionCard>

      {/* Sticky save bar — inside the content column, never over the nav. */}
      <div
        data-form="save-bar"
        className="sticky bottom-0 z-10 -mx-3 px-3 pt-2 pb-[max(0.5rem,env(safe-area-inset-bottom))] bg-gradient-to-t from-zinc-950 via-zinc-950/95 to-transparent"
      >
        <div className="min-w-0 rounded-xl border border-zinc-800 bg-zinc-900/95 backdrop-blur px-2.5 py-2 flex items-center gap-2">
          <span className="min-w-0 flex-1 text-[11px] truncate">
            {showErrors && errorList.length > 0 ? (
              <span className="text-red-400 inline-flex items-center gap-1">
                <AlertTriangle className="w-3.5 h-3.5 shrink-0" />
                {errorList[0]}
                {errorList.length > 1 && ` (+${errorList.length - 1})`}
              </span>
            ) : dirty ? (
              <span className="text-amber-300">تغييرات غير محفوظة</span>
            ) : (
              <span className="text-emerald-300 inline-flex items-center gap-1">
                <Check className="w-3.5 h-3.5 shrink-0" /> محفوظ
              </span>
            )}
          </span>
          <button
            type="button"
            data-action="save-draft"
            className={`${btnGhost} h-10`}
            disabled={saving}
            onClick={() => void save('draft')}
          >
            مسودة
          </button>
          <button
            type="button"
            data-action="save"
            className={`${btnPrimary} h-10`}
            disabled={saving}
            onClick={() => void save('active')}
          >
            {saving ? <RefreshCw className="w-4 h-4 animate-spin" /> : <Save className="w-4 h-4" />} نشر
          </button>
        </div>
      </div>
    </div>
  );
}

function Row({ k, v }: { k: string; v: string }) {
  return (
    <div className="flex items-center justify-between gap-3 min-w-0 border-b border-zinc-800/60 pb-1.5">
      <span className="text-zinc-500 shrink-0">{k}</span>
      <span className="text-zinc-200 truncate min-w-0 text-end" dir="ltr">
        {v}
      </span>
    </div>
  );
}
