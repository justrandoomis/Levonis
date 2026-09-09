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
 * ONE REQUEST, ONE SAVE. The document AND the structure go to
 * /api/admin/products-v2 in a single POST (`relations` beside the document
 * fields), because the server plans both into ONE `db.batch`
 * (worker/lib/productPersistence.ts). Saving them in two requests is what left
 * a bare product row behind whenever the structure was refused by a rule only
 * the server knows — a cross-store SKU, an id owned by another product, the
 * price ladder, reserved stock — while the TXT apply refused the whole thing
 * and rolled its create back. Now both surfaces behave the same way: either
 * the product and its options, colours and pictures land together, or nothing
 * does and the refusal names the row (docs/TXT_IMPORT_PARITY.md).
 *
 * The structure the form SHOWS afterwards is still read back from
 * /api/admin/products/:id/relations — the rows, never an echo.
 */

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ArrowRight, ArrowLeft, Save, Eye, RefreshCw, AlertTriangle, Check, Plus } from 'lucide-react';
import { api, ApiError, formatIqd } from '../../lib/api';
import { refusalIssues } from './applyResult';
import { useLanguage } from '../../LanguageContext';
import { useAuth } from '../../AuthContext';
import type { BrandV2, CatalogV2 } from '../../lib/productTypes';
import {
  blankDoc,
  importedTexts,
  preservedGroups,
  specIdsOutsideTemplate,
  toEditorDoc,
  type EditorDoc,
  type ProductResponse,
  type SaveResponse,
} from './types';
import PinnedPriceNotice from './PinnedPriceNotice';
import { repriceRow, pinnedRows, type RepriceMode } from '../../../worker/lib/pinnedPrices';
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
  hydrateRelations,
  relationsFromWire,
  type RelationsResponse,
  relationsToWire,
  summarize,
  validateForm,
  type FormErrors,
  type RelationsState,
  type SaleType,
} from './form/model';
import { OptionsSection } from './form/OptionsSection';
import { UsageGuideSection } from './form/UsageGuideSection';
import { WarrantySection } from './form/WarrantySection';
import PricePreview from './PricePreview';
import { ImagesSection } from './form/ImagesSection';
import { QuickAddDialog, type QuickAddKind, type QuickAddResult } from './form/QuickAdd';

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
  const { dir, lang } = useLanguage();
  const { user } = useAuth();
  // §11: cost is only rendered for a financial admin. The SERVER refuses to
  // read or write it either way — this only avoids showing an input that
  // would be rejected.
  const canSeeCost = user?.can_view_financials !== false;

  const [doc, setDoc] = useState<EditorDoc>(() => blankDoc());
  const [rel, setRel] = useState<RelationsState>(() => emptyRelations());
  const [baseline, setBaseline] = useState('');
  const [loadedUpdatedAt, setLoadedUpdatedAt] = useState('');
  // The base price this product had when the editor opened. A pinned-price
  // warning is only honest against the value the owner started from, not
  // against every keystroke.
  const [loadedBasePrice, setLoadedBasePrice] = useState<number | null>(null);
  const [pinnedDismissed, setPinnedDismissed] = useState(false);
  const columnRef = useRef<HTMLDivElement>(null);
  const [loading, setLoading] = useState(!!productId);
  const [loadErr, setLoadErr] = useState<string | null>(null);

  const [brands, setBrands] = useState<BrandV2[]>([]);
  const [catalogs, setCatalogs] = useState<CatalogNode[]>([]);
  const [tplGroups, setTplGroups] = useState<TemplateGroup[]>([]);
  // The family the chosen section resolves to — shown beside the stored one
  // when they differ, never written over it silently.
  const [sectionFamily, setSectionFamily] = useState<string | null>(null);
  const [brandSearch, setBrandSearch] = useState('');
  // Quick-add of a section / sub-section / brand from inside the form (the
  // same rows the التصنيفات page manages), selected on creation.
  const [quickAdd, setQuickAdd] = useState<QuickAddKind | null>(null);
  // The managed hashtag vocabulary, offered as suggestions and as a datalist;
  // typing a new tag still works, and saving registers it in the list.
  const [hashtagOptions, setHashtagOptions] = useState<string[]>([]);
  // Hashtags always existed on the doc (round-tripped by every save) — this
  // is their first actual INPUT: draft text, committed on Enter/comma/blur.
  const [hashtagDraft, setHashtagDraft] = useState('');
  const addHashtag = (raw: string) => {
    // The same rule worker/lib/hashtags.ts applies on save, so the chip the
    // admin sees is the tag that gets stored.
    const tag = raw
      .replace(/^[#\s]+/, '')
      .replace(/[|,]+/g, '-')
      .trim()
      .replace(/\s+/g, '-')
      .replace(/-{2,}/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 40)
      .replace(/-+$/g, '');
    if (!tag) return;
    setDoc((d) => (d.hashtags.some((h) => h.toLowerCase() === tag.toLowerCase()) ? d : { ...d, hashtags: [...d.hashtags, tag] }));
  };
  const commitHashtag = () => {
    const draft = hashtagDraft;
    setHashtagDraft('');
    addHashtag(draft);
  };
  const hashtagSuggestions = useMemo(
    () => hashtagOptions.filter((t) => !doc.hashtags.some((h) => h.toLowerCase() === t.toLowerCase())).slice(0, 12),
    [hashtagOptions, doc.hashtags]
  );

  const onQuickAdded = (r: QuickAddResult) => {
    setQuickAdd(null);
    if (r.kind === 'brand') {
      const row = r.row as unknown as BrandV2;
      setBrands((b) => [...b.filter((x) => x.id !== row.id), { ...row, active: true }]);
      setBrandSearch('');
      setDoc((d) => ({ ...d, brand_id: row.id }));
      return;
    }
    const raw = r.row;
    const parent = r.kind === 'sub_category' ? catalogs.find((c) => c.id === doc.category_id) : undefined;
    const own = raw.template_family === 'devices' || raw.template_family === 'materials' ? raw.template_family : null;
    const node: CatalogNode = {
      id: r.id,
      parent_id: typeof raw.parent_id === 'string' ? raw.parent_id : null,
      slug: String(raw.slug ?? ''),
      name_ar: String(raw.name_ar ?? ''),
      name_en: String(raw.name_en ?? ''),
      name_ckb: String(raw.name_ckb ?? ''),
      sort: Number(raw.sort ?? 0),
      is_printer_catalog: !!raw.is_printer_catalog,
      active: true,
      effective_template_family: own ?? parent?.effective_template_family ?? null,
    };
    setCatalogs((c) => [...c.filter((x) => x.id !== node.id), node]);
    if (r.kind === 'category') setDoc((d) => ({ ...d, category_id: node.id, sub_category_id: null }));
    else setDoc((d) => ({ ...d, sub_category_id: node.id }));
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
        const [b, cat, hs] = await Promise.all([
          api.get<{ brands: BrandV2[] }>('/api/admin/taxonomy/brands'),
          api.get<{ catalogs: CatalogNode[] }>('/api/admin/taxonomy/catalogs'),
          api
            .get<{ hashtags: Array<{ tag: string; active: boolean }> }>('/api/admin/taxonomy/hashtags?counts=0')
            .catch(() => ({ hashtags: [] as Array<{ tag: string; active: boolean }> })),
        ]);
        if (!alive) return;
        setBrands(b.brands ?? []);
        setCatalogs(cat.catalogs ?? []);
        setHashtagOptions((hs.hashtags ?? []).filter((h) => h.active).map((h) => h.tag));
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

  /**
   * Move every row that carries its own price, in one pass over the two places
   * a price can live: the relational option values / colours / variants the
   * editor manages, and the JSON options and colours the document carries for
   * products that never grew relational rows. Both are written by the same
   * save, so the storefront and the cart cannot end up disagreeing.
   *
   * This edits the FORM, not the database. Nothing is committed until the
   * owner saves, so the move is as reviewable and as undoable as any other
   * edit they make on this screen.
   */
  const applyPinnedReprice = useCallback(
    (mode: RepriceMode, from: number, to: number) => {
      const move = <X extends { id: string; regular_price_iqd?: number | null; prime_price_iqd?: number | null; pro_price_iqd?: number | null }>(
        x: X
      ): X => {
        const [pinned] = pinnedRows({ options: [x as never] });
        if (!pinned) return x;
        const next = repriceRow(pinned, mode, from, to);
        return {
          ...x,
          regular_price_iqd: next.regular_price_iqd,
          prime_price_iqd: next.prime_price_iqd,
          pro_price_iqd: next.pro_price_iqd,
        };
      };
      setRel((r) => ({
        ...r,
        groups: r.groups.map((g) => ({ ...g, values: g.values.map(move) })),
        colors: r.colors.map(move),
        variants: r.variants.map(move),
      }));
      setDoc((d) => ({
        ...d,
        options: Array.isArray(d.options) ? d.options.map((o) => move(o)) : d.options,
        colors: Array.isArray(d.colors) ? d.colors.map((col) => move(col)) : d.colors,
      }));
      setPinnedDismissed(true);
    },
    []
  );

  const loadProduct = useCallback(async (id: string) => {
    setLoading(true);
    setLoadErr(null);
    try {
      const [p, r] = await Promise.all([
        api.get<ProductResponse>(`/api/admin/products-v2/${id}`),
        api.get<RelationsResponse>(`/api/admin/products/${id}/relations`),
      ]);
      const d = toEditorDoc(p.product);
      // Rows when they exist, else the document's own options / colours /
      // media — the precedence the storefront sells by. A product whose
      // structure lives only in the document is shown, and told so.
      const rs = hydrateRelations(r, p.product);
      setDoc(d);
      setRel(rs);
      setLoadedUpdatedAt(p.product.updated_at ?? '');
      setLoadedBasePrice(typeof d.price_iqd === 'number' ? d.price_iqd : null);
      setPinnedDismissed(false);
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
      setSectionFamily(null);
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
        setSectionFamily(res.template_family ?? null);
        // The section's family FILLS an empty template_family. It never
        // overwrites a stored one silently (a TXT file's value used to vanish
        // the moment the form opened): a mismatch is shown beside the field,
        // with the section's family one click away.
        if (res.template_family) {
          setDoc((d) => (d.template_family ? d : { ...d, template_family: res.template_family }));
        }
      } catch {
        if (alive) {
          setTplGroups([]);
          setSectionFamily(null);
        }
      }
    })();
    return () => {
      alive = false;
    };
  }, [doc.category_id, doc.sub_category_id]);

  // ------------------------------------------------------------- derived

  // The section a product ALREADY carries stays in its list even when it was
  // deactivated (as the brand select below does): otherwise an imported
  // product filed under an inactive section opens as «— اختر —» and the next
  // save files it nowhere.
  const roots = useMemo(
    () => catalogs.filter((c) => !c.parent_id && (c.active || c.id === doc.category_id)),
    [catalogs, doc.category_id]
  );
  const children = useMemo(
    () => catalogs.filter((c) => (c.parent_id === doc.category_id && c.active) || (!!doc.sub_category_id && c.id === doc.sub_category_id)),
    [catalogs, doc.category_id, doc.sub_category_id]
  );
  const filteredBrands = useMemo(() => {
    // Sections were already filtered to the active ones; brands
    // were not, and deactivating one is a single click in التصنيفات now. An
    // inactive brand is exactly what the importer refuses, so offering it in
    // the form would let the two disagree about the same product. The brand
    // a product ALREADY carries stays in the list, or editing that product
    // would silently drop its brand.
    const live = brands.filter((b) => b.active || b.id === doc.brand_id);
    const q = brandSearch.trim().toLowerCase();
    if (!q) return live.slice(0, 200);
    return live.filter((b) => `${b.name_en} ${b.name_ar} ${b.slug}`.toLowerCase().includes(q)).slice(0, 200);
  }, [brands, brandSearch, doc.brand_id]);

  const dirty = baseline !== '' && JSON.stringify({ d: doc, rs: rel }) !== baseline;

  // Extended warranty is a PRINTER's option (owner mandate): the block shows,
  // and the server accepts plans, only when the chosen section or sub-section
  // is a printer catalog — the same flag worker/lib/printerIdentity.ts reads.
  // The same answer the server gives (worker/lib/warrantyPlans.ts
  // catalogsArePrinter): the section pair AND the catalogs list.
  const isPrinterCatalog = useMemo(
    () =>
      catalogs.some(
        (c) =>
          c.is_printer_catalog &&
          (c.id === doc.category_id || c.id === doc.sub_category_id || doc.catalog_ids.includes(c.id))
      ),
    [catalogs, doc.category_id, doc.sub_category_id, doc.catalog_ids]
  );
  const warrantyInput = useMemo(
    () => ({
      isPrinter: isPrinterCatalog,
      plans: doc.warranty_plans.map((p) => ({
        id: p.id,
        duration_months: p.duration_months,
        duration_kind: p.duration_kind,
        fee_iqd: p.fee_iqd,
        fee_percent: p.fee_percent ?? null,
        active: p.active,
      })),
      serialized: doc.serialized ?? null,
      warranty_base_months: doc.warranty_base_months ?? null,
    }),
    [isPrinterCatalog, doc.warranty_plans, doc.serialized, doc.warranty_base_months]
  );

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
        warranty: warrantyInput,
      }),
    [doc, rel, warrantyInput]
  );
  const errorList = Object.values(errors);
  const err = (k: string) => (showErrors ? (errors[k] ?? null) : null);

  /**
   * 0043 — THE SALE TYPES ARE READ OFF THE OPTIONS, HERE TOO.
   *
   * `worker/lib/availability.ts` already derives the product's sale types from
   * its options and lets the options WIN whenever any of them declares one.
   * This form, though, still asked the admin to tick the same answer by hand,
   * which meant the screen could show "direct sale" while the saved product
   * was a pre-order — the checkbox was a lie the moment an option disagreed
   * with it, and it made the admin choose "both" for a mix the options had
   * already described.
   *
   * So the checkboxes stand down as soon as any ACTIVE option has an opinion,
   * and what is shown is what the server will conclude. The rule and its order
   * are the server's, copied deliberately rather than invented: an option that
   * is switched off is not consulted, and `bundle` is a catalogue label that no
   * option ever claims, so it survives whatever the options say.
   *
   * A product with no options at all keeps the manual choice, because that is
   * the only place its route can come from — and that is every product written
   * before options carried an availability type.
   */
  const optionSaleTypes = (() => {
    const declared = new Set<SaleType>();
    for (const g of rel.groups) {
      for (const v of g.values) {
        if (v.active === false) continue;
        if (v.availability_type === 'direct_sale' || v.availability_type === 'pre_order') {
          declared.add(v.availability_type);
        }
      }
    }
    return declared;
  })();
  const saleTypesAreDerived = optionSaleTypes.size > 0;
  const derivedSaleTypes: SaleType[] = saleTypesAreDerived
    ? (SALE_TYPES.map((t) => t.id).filter((id) => optionSaleTypes.has(id)) as SaleType[])
    : [];

  /**
   * Keep the saved document equal to what the server will derive, so the
   * summary line, the surcharge panels below and the eventual save all agree.
   * `bundle` is preserved: it is not a fulfilment route.
   */
  useEffect(() => {
    if (!saleTypesAreDerived) return;
    setDoc((d) => {
      const keptBundle = d.sale_types.includes('bundle' as SaleType) ? ['bundle' as SaleType] : [];
      const next = [...derivedSaleTypes, ...keptBundle];
      const same = next.length === d.sale_types.length && next.every((t, i) => d.sale_types[i] === t);
      if (same) return d;
      return {
        ...d,
        sale_types: next as EditorDoc['sale_types'],
        selling_type: (next[0] ?? 'direct_sale') as EditorDoc['selling_type'],
      };
    });
    // derivedSaleTypes is rebuilt every render from rel; comparing its join
    // keeps this to the transitions that actually change the answer.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [saleTypesAreDerived, derivedSaleTypes.join(',')]);

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
      warranty: warrantyInput,
    });
    if (Object.keys(check).length > 0) {
      setSaveErr('راجع الحقول المعلّمة بالأحمر قبل الحفظ.');
      return;
    }

    setSaving(true);
    setSaveErr(null);
    setSaveNote(null);
    try {
      // The document WITHOUT its derived copies of the structure: `options`,
      // `colors` and `media` have no editor here, and the server rebuilds the
      // product's JSON mirror from the rows this same request writes. Sending
      // the copy the form happened to be holding is how a deleted option came
      // back the next time the product was read.
      const { options: _o, colors: _c, media: _m, ...docFields } = next as EditorDoc & Record<string, unknown>;
      void _o; void _c; void _m;
      const body: Record<string, unknown> = {
        ...docFields,
        relations: relationsToWire(rel),
        expected_updated_at: loadedUpdatedAt || undefined,
      };
      const res = await api.post<SaveResponse & { translation_review_needed?: string[]; warnings?: string[] }>(
        '/api/admin/products-v2',
        body
      );
      const savedId = res.product?.id ?? next.id;
      setReviewNeeded(res.translation_review_needed ?? []);

      // WHAT THE FORM SHOWS AFTER A SAVE IS A READ-BACK, NOT THE ECHO.
      // The save answers with the product document; the structure is read from
      // the same endpoint the form LOADS from, so the picture list, the
      // variants and the stock level are the stored rows rather than a partial
      // echo. The ROWS, not the document: falling back to the document's JSON
      // copy here would resurrect an option or a picture just deleted.
      const fresh = await api.get<RelationsResponse>(`/api/admin/products/${savedId}/relations`);
      const savedRel = relationsFromWire(fresh);
      setRel(savedRel);
      if ((res.warnings?.length ?? 0) > 0) setSaveNote(res.warnings!.join(' · '));

      const freshDoc = res.product ? toEditorDoc(res.product) : next;
      setDoc(freshDoc);
      setLoadedUpdatedAt(res.product?.updated_at ?? loadedUpdatedAt);
      // The baseline is what the SERVER now holds — document and structure —
      // so the form is clean after a save instead of showing the read-back's
      // own normalisation (sort numbers, derived stock level) as unsaved work.
      setBaseline(JSON.stringify({ d: freshDoc, rs: savedRel }));
      setShowErrors(false);
      onListChanged();
      if (!productId && savedId) {
        // Reload so the new id is reflected everywhere (relations, preview).
        void loadProduct(savedId);
      }
    } catch (e) {
      // THE ROW-LEVEL REASONS REACH THE ADMIN. A refused structure answers
      // `{ code: 'VALIDATION', errors: ['colors[0].hex: must be #RGB or
      // #RRGGBB'] }` with no `error` key, so `api.ts` can only build «Server
      // error (400)». Reading the body's own lines — the same helper the
      // import window uses — is the difference between "something failed" and
      // "this row was rejected, for this reason".
      const lines = e instanceof ApiError ? refusalIssues((e.body ?? e.details ?? {}) as Parameters<typeof refusalIssues>[0]) : [];
      const base = e instanceof ApiError ? e.message : 'فشل الحفظ / save failed';
      setSaveErr(lines.length ? `${base}: ${lines.join(' · ')}` : base);
    } finally {
      setSaving(false);
    }
  };

  // THIS SCREEN OWNS ITS BOTTOM EDGE. A `position: sticky` footer can only
  // travel to the bottom of its containing block, and the admin shell holds
  // that short of the glass with a bottom padding on its scroll container —
  // which is exactly the strip of page the owner saw under the save bar
  // («فهو الان يبدو طائفا»). The form suspends that padding while it is open
  // and puts it back on the way out, so every other admin screen keeps it and
  // the safe-area inset is instead applied INSIDE the bar, where it belongs.
  // The deps are the two states that decide whether the column is mounted at
  // all: the loading and error screens have no column to reach up from.
  useEffect(() => {
    const main = columnRef.current?.closest('main') as HTMLElement | null;
    if (!main) return;
    const previous = main.style.paddingBottom;
    main.style.paddingBottom = '0px';
    return () => {
      main.style.paddingBottom = previous;
    };
  }, [loading, loadErr]);

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
  const imported = importedTexts(doc);
  const preserved = preservedGroups(doc);
  const templateFieldIds = tplGroups.flatMap((g) => g.fields.map((f) => f.id));
  const outsideSpecs = specIdsOutsideTemplate(doc.spec_fields, templateFieldIds);
  // A spec key whose value is empty is not a stored spec: it is a field the
  // admin cleared, and counting it kept the badge one ahead of the truth.
  const storedSpecCount = Object.values(doc.spec_fields ?? {}).filter((v) => (v ?? '').trim() !== '').length;
  const familyMismatch = !!sectionFamily && !!doc.template_family && sectionFamily !== doc.template_family;
  // The catalog placements that are not already visible as the section pair.
  const extraCatalogs = doc.catalog_ids
    .filter((id) => id !== doc.category_id && id !== doc.sub_category_id)
    .map((id) => catalogs.find((c) => c.id === id)?.name_ar || catalogs.find((c) => c.id === id)?.name_en || id);
  const activeTransportsHidden = !doc.sale_types.includes('pre_order') && doc.preorder_transports.some((o) => o.active);
  const surchargeHidden = !doc.sale_types.includes('direct_sale') && doc.direct_surcharge_iqd !== null;
  const warrantyHiddenValues =
    !isPrinterCatalog && doc.warranty_plans.length === 0 && (doc.warranty_base_months !== null || doc.serialized !== null);

  return (
    // min-w-0 on the outer column is what keeps a long value from widening the
    // whole admin page, and there is no bottom padding: this screen owns its
    // own bottom edge (see the effect above and the save bar below).
    <div ref={columnRef} className="min-w-0 w-full max-w-[880px] mx-auto px-3">
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
      {(rel.hydration_issues?.length ?? 0) > 0 && (
        <div data-form="hydration-issues">
          <Banner kind="warn">
            {rel.hydration_issues!.map((m, i) => (
              <div key={i}>{m}</div>
            ))}
          </Banner>
        </div>
      )}
      {reviewNeeded.length > 0 && (
        <Banner kind="warn">
          حُفظ المنتج. لم يستطع المترجم المحلي ترجمة {reviewNeeded.length} حقلًا بأمان، فبقيت بالإنجليزية وعُلّمت
          للمراجعة: <span className="font-mono text-[11px]">{reviewNeeded.slice(0, 6).join(', ')}</span>
        </Banner>
      )}

      {/* 1 ──────────────── classification: section → sub-section → brand →
          hashtags, in that exact order (the owner's «اعد ترتيبه»), with the
          derived template as the closing secondary row.

          THERE IS NO «الفلاتر» PICKER HERE ANY MORE. The owner's ruling:
          «احذف الفلاتر هي تابعه او نفسها القسم الفرعي» — the filter list was
          a second vocabulary repeating what the sub-section already says, so
          a product is classified once, in this section. The facets table and
          its التصنيفات tab are untouched, and a product that already carries
          facets keeps them: this form simply stops sending `facet_ids`, and
          the relations writer preserves what the payload does not mention. */}
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
          <Field ar="١· القسم الرئيسي" en="Main section" required error={err('category_id')} htmlFor="pf-category">
            <div className="flex gap-1.5 min-w-0">
              <div className="flex-1 min-w-0">
                <Select
                  id="pf-category"
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
              </div>
              <button
                type="button"
                className={`${btnGhost} !px-2.5 shrink-0`}
                onClick={() => setQuickAdd('category')}
                aria-label="إضافة قسم رئيسي جديد"
                title="إضافة قسم رئيسي جديد / New main section"
                data-quick-add-open="category"
              >
                <Plus className="w-4 h-4" aria-hidden />
              </button>
            </div>
          </Field>
          <Field
            ar="٢· القسم الفرعي"
            en="Sub-section"
            hint={doc.category_id ? undefined : 'اختر القسم الرئيسي أولًا'}
            htmlFor="pf-sub-category"
          >
            <div className="flex gap-1.5 min-w-0">
              <div className="flex-1 min-w-0">
                <Select
                  id="pf-sub-category"
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
              </div>
              <button
                type="button"
                className={`${btnGhost} !px-2.5 shrink-0`}
                disabled={!doc.category_id}
                onClick={() => setQuickAdd('sub_category')}
                aria-label="إضافة قسم فرعي جديد"
                title="إضافة قسم فرعي جديد تحت القسم المختار / New sub-section"
                data-quick-add-open="sub_category"
              >
                <Plus className="w-4 h-4" aria-hidden />
              </button>
            </div>
          </Field>
          <Field ar="٣· العلامة التجارية" en="Brand" htmlFor="pf-brand">
            <div className="flex gap-1.5 min-w-0">
              <div className="flex-1 min-w-0">
                <Select
                  id="pf-brand"
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
              </div>
              <TextInput
                className="!w-24 shrink-0"
                value={brandSearch}
                onChange={(e) => setBrandSearch(e.target.value)}
                placeholder="بحث…"
                aria-label="بحث عن علامة"
              />
              <button
                type="button"
                className={`${btnGhost} !px-2.5 shrink-0`}
                onClick={() => setQuickAdd('brand')}
                aria-label="إضافة علامة تجارية جديدة"
                title="إضافة علامة تجارية جديدة / New brand"
                data-quick-add-open="brand"
              >
                <Plus className="w-4 h-4" aria-hidden />
              </button>
            </div>
          </Field>
          <Field
            ar="٤· الهاشتاقات"
            en="Hashtags"
            hint="Enter أو فاصلة لإضافة وسم — أو اختر من المقترحات"
            tip="وسوم تُستخدم في البحث والاكتشاف. المقترحات من قائمة الهاشتاقات في صفحة التصنيفات، ووسم جديد تكتبه هنا يُضاف إلى تلك القائمة عند الحفظ."
            htmlFor="pf-hashtags"
          >
            <div className="min-w-0">
              <TextInput
                id="pf-hashtags"
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
                list="hashtag-options"
                autoComplete="off"
                data-hashtag-input
              />
              <datalist id="hashtag-options">
                {hashtagOptions.map((t) => (
                  <option key={t} value={t} />
                ))}
              </datalist>
              {hashtagSuggestions.length > 0 && (
                <div className="flex flex-wrap gap-1 mt-1.5" data-hashtag-suggestions>
                  {hashtagSuggestions.map((t) => (
                    <button
                      key={t}
                      type="button"
                      onClick={() => addHashtag(t)}
                      className="inline-flex items-center gap-0.5 rounded-full border border-dashed border-zinc-600 px-2.5 min-h-8 text-[11px] text-zinc-400 hover:text-white hover:border-zinc-400 transition-colors"
                      aria-label={`إضافة الوسم ${t}`}
                    >
                      <Plus className="w-3 h-3" aria-hidden />
                      <span dir="ltr">#{t}</span>
                    </button>
                  ))}
                </div>
              )}
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
            hint={familyMismatch ? `القسم المختار يشتق «${sectionFamily}» بينما المنتج يحمل «${doc.template_family}»` : 'يُشتق من القسم'}
            tip="القالب يحدد حقول المواصفات وأعمدة الاستيراد. يأتي من إعداد القسم في شجرة الأقسام. قيمة محفوظة (من ملف مثلًا) لا تُستبدل تلقائيًا."
          >
            <div className="flex gap-1.5 min-w-0">
              <TextInput value={doc.template_family ?? ''} readOnly placeholder="—" data-form="template-family" />
              {familyMismatch && (
                <button
                  type="button"
                  className={`${btnGhost} shrink-0 text-[11px]`}
                  onClick={() => setDoc((d) => ({ ...d, template_family: sectionFamily }))}
                  data-form="adopt-section-family"
                >
                  اعتمد قالب القسم
                </button>
              )}
            </div>
          </Field>
        </Grid>
        {/* The catalogs the product is filed under (`product_catalogs`). The
            form has no picker for them — they are set from the catalogs page
            and by the TXT template — so it SHOWS them: they decide the printer
            warranty block and the storefront's shelves, and a product that
            silently listed none was the reason an imported product looked
            unfiled. */}
        {extraCatalogs.length > 0 && (
          <p className="text-[11px] text-zinc-400 mt-2" data-form="catalogs-preserved">
            كتالوجات محفوظة: {extraCatalogs.join('، ')} — تُدار من صفحة التصنيفات أو عبر القالب النصي.
          </p>
        )}
      </SectionCard>

      {quickAdd && (
        <QuickAddDialog
          kind={quickAdd}
          parentId={doc.category_id}
          parentName={(() => {
            const p = catalogs.find((c) => c.id === doc.category_id);
            return p ? p.name_ar || p.name_en : '';
          })()}
          onClose={() => setQuickAdd(null)}
          onCreated={onQuickAdded}
        />
      )}

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
          {imported.length > 0 && (
            <Field
              ar="نصوص محفوظة (عربي / كردي)"
              en="Imported texts"
              hint="مخزّنة كما وردت من القالب النصي — لا مدخل لها في هذا النموذج"
              span
            >
              <div className="space-y-1 rounded-lg border border-zinc-800 bg-zinc-800/30 p-2" data-form="imported-texts">
                {imported.map((r) => (
                  <div key={r.key} className="text-[12px] min-w-0">
                    <span className="text-zinc-500">{r.label}: </span>
                    <span className="text-zinc-200 break-words" dir="auto">
                      {r.value}
                    </span>
                  </div>
                ))}
              </div>
            </Field>
          )}
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
          <Field
            ar="السعر الاعتيادي"
            en="Regular"
            required
            error={err('price_iqd')}
            tip="الخيار أو اللون الذي له سعر خاص يستبدل هذا السعر ولا يُضاف إليه. إن غيّرت هذا الرقم وكانت هناك أسعار خاصة، ستُسأل عمّا تفعل بها."
          >
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

        {/* Stored by the template as `original_price_iqd` (the struck-through
            "was" price). No input here by design — but it is stored, it is
            carried by every save, and it is shown so it is never mistaken for
            a value the import lost. */}
        {doc.original_price_iqd !== null && doc.original_price_iqd !== undefined && (
          <p className="text-[11px] text-zinc-400 mb-3" data-form="original-price-preserved">
            السعر قبل التخفيض المحفوظ: {formatIqd(doc.original_price_iqd)} — يُعدَّل عبر القالب النصي.
          </p>
        )}

        {/* The answer to "I changed the price and the cart still charges the
            old one". It appears the moment the base moves away from what this
            product was opened with, and only while rows exist that would
            ignore it. */}
        {!pinnedDismissed && loadedBasePrice !== null && doc.price_iqd !== null && doc.price_iqd !== loadedBasePrice && (
          <PinnedPriceNotice
            from={loadedBasePrice}
            to={doc.price_iqd}
            lang={lang}
            source={{
              options: [
                ...rel.groups.flatMap((g) => g.values as unknown as Array<Record<string, unknown>>),
                ...((doc.options ?? []) as unknown as Array<Record<string, unknown>>),
              ],
              colors: [
                ...(rel.colors as unknown as Array<Record<string, unknown>>),
                ...((doc.colors ?? []) as unknown as Array<Record<string, unknown>>),
              ],
              variants: rel.variants as unknown as Array<Record<string, unknown>>,
            }}
            onApply={(mode) => applyPinnedReprice(mode, loadedBasePrice, doc.price_iqd as number)}
            onDismiss={() => setPinnedDismissed(true)}
          />
        )}
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
          isPrinterCatalog && doc.warranty_plans.some((p) => p.active)
            ? `ضمان ممدد ${doc.warranty_plans.filter((p) => p.active).map((p) => `+${p.duration_months}`).join(' / ')}`
            : undefined,
        ])}
        error={
          showErrors &&
          (!!errors.sale_types ||
            Object.keys(errors).some((k) => k.startsWith('warranty') || k === 'serialized'))
        }
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
              sub={saleTypesAreDerived ? 'من الخيارات' : t.sub}
              disabled={saleTypesAreDerived}
            />
          ))}
        </div>
        {saleTypesAreDerived ? (
          <p className="text-[11px] text-zinc-400 mb-3" data-form="sale-types-derived">
            نوع البيع مأخوذ من خياراتك تلقائيًا:{' '}
            <b className="text-zinc-200">
              {derivedSaleTypes.map((t) => SALE_TYPES.find((s) => s.id === t)?.ar ?? t).join(' + ')}
            </b>
            {derivedSaleTypes.length > 1 ? ' (مختلط)' : ''} — لتغييره، غيّر «نوع التوفر» داخل الخيارات
            في قسم ٥. لا حاجة لاختيار «مختلط» يدويًا.
          </p>
        ) : (
          <p className="text-[11px] text-zinc-500 mb-3">
            يمكن تفعيل النوعين معًا. الافتراضي للعميل: بيع مباشر عند توفر المخزون، وإلا الطلب المسبق.
            وإذا حدّدت «نوع التوفر» داخل الخيارات، فسيُشتق النوع منها تلقائيًا.
          </p>
        )}

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
        {surchargeHidden && (
          <p className="text-[11px] text-amber-300 mb-3" data-form="surcharge-preserved">
            زيادة البيع المباشر المحفوظة {formatIqd(doc.direct_surcharge_iqd as number)} — تظهر للتعديل عند تفعيل «بيع مباشر»، وتبقى محفوظة كما هي.
          </p>
        )}
        {activeTransportsHidden && (
          <p className="text-[11px] text-amber-300 mb-3" data-form="transports-preserved">
            طرق طلب مسبق مفعّلة محفوظة ({doc.preorder_transports.filter((o) => o.active).map((o) => TRANSPORTS.find((t) => t.method === o.method)?.ar ?? o.method).join('، ')}) — تظهر للتعديل عند تفعيل «طلب مسبق».
          </p>
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

        {/* Extended warranty — printers only (owner mandate). Two switches
            (+12 → 24, +24 → 36), a percent of the printer price each, and the
            device coverage they rest on. Hidden for anything that is not
            filed under a printer catalog; a non-printer that still carries
            plans is told the save will be refused and offered a clear. */}
        {warrantyHiddenValues && (
          <p className="text-[11px] text-zinc-400 mb-3" data-form="warranty-preserved">
            محفوظ من الملف: {doc.warranty_base_months !== null ? `ضمان أساسي ${doc.warranty_base_months} شهرًا` : ''}
            {doc.warranty_base_months !== null && doc.serialized !== null ? ' · ' : ''}
            {doc.serialized !== null ? (doc.serialized ? 'جهاز مُرقَّم' : 'بلا تسجيل وحدات') : ''} — محرره يظهر لأقسام الطابعات فقط.
          </p>
        )}
        {doc.payment_options.length > 0 && (
          <p className="text-[11px] text-zinc-400 mb-3" data-form="payment-options-preserved">
            خيارات الدفع المحفوظة: <span dir="ltr">{doc.payment_options.join(', ')}</span> — تُعدَّل عبر القالب النصي.
          </p>
        )}
        <WarrantySection
          isPrinter={isPrinterCatalog}
          plans={doc.warranty_plans}
          serialized={doc.serialized ?? null}
          baseMonths={doc.warranty_base_months ?? null}
          priceIqd={doc.price_iqd}
          errors={showErrors ? errors : {}}
          onPlansChange={(next) => setDoc((d) => ({ ...d, warranty_plans: next }))}
          onSerializedChange={(v) => setDoc((d) => ({ ...d, serialized: v }))}
          onBaseMonthsChange={(v) => setDoc((d) => ({ ...d, warranty_base_months: v }))}
        />

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
        <OptionsSection
          rel={rel}
          setRel={setRel}
          // LIVE, not the loaded document: an admin who raises the base price in
          // section 4 must see every inheriting option's price move with it
          // before they save, not after a reload.
          base={{
            regular: doc.price_iqd,
            prime: doc.prime_price_iqd,
            pro: doc.pro_price_iqd,
            cost: doc.product_cost_iqd,
          }}
          canSeeCost={canSeeCost}
          errors={showErrors ? errors : {}}
        />
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
            ? storedSpecCount > 0
              ? `${storedSpecCount} مواصفة محفوظة بلا قالب قسم`
              : 'اختر قسمًا لعرض حقول القالب'
            : `${tplGroups.reduce((n, g) => n + g.fields.length, 0)} حقل`,
          storedSpecCount > 0 && tplGroups.length > 0 ? `${storedSpecCount} مواصفة محفوظة` : undefined,
          outsideSpecs.length > 0 ? `${outsideSpecs.length} خارج القالب` : undefined,
          doc.usage_guide.steps.length ? `${doc.usage_guide.steps.length} خطوة دليل` : undefined,
          preserved.length > 0 ? preserved.map((g) => `${g.count} ${g.label}`).join(' · ') : undefined,
        ])}
        {...section(7)}
      >
        {tplGroups.length === 0 && (
          <p className="text-[12px] text-zinc-500 mb-3">
            حقول المواصفات تتبع القسم والقالب. اختر القسم الرئيسي في القسم رقم 1 لتظهر هنا.
            {storedSpecCount > 0 ? ' المواصفات المحفوظة معروضة أدناه حتى بلا قالب.' : ''}
          </p>
        )}
        {tplGroups.length > 0 && (
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

        {/* Stored spec ids the section's template does not declare: a TXT file
            may state any `spec.<id>`, and hiding a stored value behind the
            section's field list is exactly the loss this form used to have.
            Shown editable; an emptied value is deleted by the server. */}
        {outsideSpecs.length > 0 && (
          <div className="min-w-0 mb-4" data-form="spec-outside-template">
            <h4 className="text-[13px] font-bold text-zinc-300 mb-2 truncate">
              مواصفات محفوظة خارج قالب هذا القسم{' '}
              <span className="text-[11px] font-medium text-zinc-500">Stored spec fields outside the section template</span>
            </h4>
            <Grid cols={2}>
              {outsideSpecs.map((id) => (
                <Field key={id} ar={id} en="Outside this section's template" hint="أفرغ القيمة لحذف الحقل">
                  <TextInput
                    value={doc.spec_fields?.[id] ?? ''}
                    onChange={(e) =>
                      setDoc((d) => {
                        // THE HINT IS TRUE. Emptying the input used to store
                        // the key with an empty value: the field came back on
                        // every reload, the section badge kept counting it and
                        // the apply kept reporting it. Clearing DELETES the
                        // key, which is what "أفرغ القيمة لحذف الحقل" says.
                        const rest = { ...d.spec_fields };
                        delete rest[id];
                        return { ...d, spec_fields: e.target.value ? { ...rest, [id]: e.target.value } : rest };
                      })
                    }
                    data-spec-outside={id}
                  />
                </Field>
              ))}
            </Grid>
          </div>
        )}

        {/* Groups this form has no editor for yet — spec groups, labels,
            content blocks, payment options. They are stored and carried by
            every save; showing them is the difference between "preserved" and
            "lost" in the owner's eyes. */}
        {preserved.length > 0 && (
          <div className="min-w-0 mb-4 rounded-lg border border-zinc-800 bg-zinc-800/30 p-2.5" data-form="preserved-groups">
            <h4 className="text-[12px] font-bold text-zinc-300 mb-1.5">
              محتوى محفوظ يُعدَّل عبر القالب النصي{' '}
              <span className="text-[11px] font-medium text-zinc-500">Preserved — edit via the TXT template</span>
            </h4>
            {preserved.map((g) => (
              <div key={g.key} className="text-[11px] text-zinc-400 mb-1.5 min-w-0" data-preserved={g.key}>
                <span className="text-zinc-200 font-bold">
                  {g.label} ({g.count})
                </span>
                <ul className="ms-4 list-disc space-y-0.5">
                  {g.lines.map((line, i) => (
                    <li key={i} className="break-words" dir="auto">
                      {line}
                    </li>
                  ))}
                </ul>
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
            <PricePreview productId={doc.id} savedDoc={doc} rel={rel} dirty={dirty} />
          </div>
        )}
      </SectionCard>

      {/* Sticky save bar — inside the content column, never over the nav.
          IT SITS ON THE BOTTOM EDGE (the owner's «عدله ليكون مع الحافه
          السفليه فهو الان يبدو طائفا»): no gap under it, no rounded corners
          under it and no gradient fade showing the page through — an opaque
          band whose only border is the hairline along its top, so it reads as
          the bottom of the screen rather than a card hovering above it. The
          safe-area inset is added as PADDING INSIDE the band, which is what
          keeps the buttons clear of the iPad home indicator while the band
          itself still reaches the glass. */}
      <div
        data-form="save-bar"
        className="sticky bottom-0 z-10 -mx-3 border-t border-zinc-800 bg-zinc-900 pb-[env(safe-area-inset-bottom)] shadow-[0_-10px_24px_-12px_rgba(0,0,0,0.9)]"
      >
        <div className="min-w-0 px-3 py-2 flex items-center gap-2">
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
