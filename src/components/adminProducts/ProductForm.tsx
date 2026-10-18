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
import { ArrowRight, ArrowLeft, Save, Eye, RefreshCw, AlertTriangle, Check, Plus, FileUp } from 'lucide-react';
import { api, ApiError, failureText } from '../../lib/api';
import { PRODUCT_WRITE_TIMEOUT_MS, STILL_SAVING_AFTER_MS, confirmSaveOutcome, saveOutcomeText, writeOutcomeUnknown } from './saveOutcome';
import { refusalIssues } from './applyResult';
import { contractRefusal, refusalLang, refusalText } from '../../lib/refusalStrings';
import { useLanguage } from '../../LanguageContext';
import { useAuth } from '../../AuthContext';
// «الأسعار» — Pricing V2 for every product (the clean start, DECISIONS row 222): sections ٣ and ٥ and
// the one review sheet. No dinar price is typed anywhere in this form (spec §5, addendum A.6/A.7).
import { useV2Pricing, V2PricingProvider } from './form/v2/useV2Pricing';
import PricesSectionV2 from './form/v2/PricesSectionV2';
import StatusChipV2 from './form/v2/StatusChipV2';
import ReviewSheetV2 from './form/v2/ReviewSheetV2';
import ModelPriceSelector from './form/v2/ModelPriceSelector';
import ColourPriceSelector, { ColourBulkBar } from './form/v2/ColourPriceSelector';
import { comboKeyOf, docWithoutLegacyMoney, iqdText, isContentOnlySave, lineWithOption, lowestPrice, optionDimsHeading, previewOf, pricedStructureKey, sectionOf as refusalSection, skuLines, withoutLegacyMoney, type V2LiveIds } from './form/v2/v2Model';
import { headerStatusText, v2Strings } from './form/v2/v2Strings';
import { emptyDimensions } from '../../lib/productTypes';
import type { BrandV2, CatalogV2, ProductDimensionsV2 } from '../../lib/productTypes';
import {
  blankDoc,
  defaultProductDeliveryOptions,
  importedTexts,
  preservedGroups,
  specIdsOutsideTemplate,
  toEditorDoc,
  type EditorDoc,
  type ImportStockState,
  type ProductResponse,
  type SaveResponse,
} from './types';
import DeliveryAvailabilityNotice from './DeliveryAvailabilityNotice';
const TranslationsSheet = React.lazy(() => import('./form/TranslationsSheet'));
// «تحديث البيانات» — the product data file, both ways (owner brief 2026-10-10):
// its own lazy chunk too; only a saved product opens it. (The older
// specs-only sheet, ./form/SectionUpdateSheet, stays for its routes' callers.)
const DataFileSheet = React.lazy(() => import('./form/DataFileSheet'));
import { DATA_FILE_STRINGS, pick as pickDataFileString } from './dataFileStrings';
import { COMPLETENESS_UI, CompletenessBanner, CompletenessProvider, MissingBlock, fill, tri, useProductCompleteness } from './completeness';
import InfoCompletenessCard from './InfoCompleteness';
// Types only — no runtime import, so the sheet stays in its own lazy chunk.
import type { ReviewItem, TranslationOverrides } from './form/TranslationsSheet';
import {
  Banner,
  Field,
  Grid,
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
import { ConditionSection, nearestSectionSerial } from './form/ConditionSection';
import { DimensionsSection } from './form/DimensionsSection';
import { InventorySummary } from './form/InventorySummary';
// «إعداد المخزون للمنتج المستورد» (Bambu import spec §B.10): an imported product's stock mode, before its price.
import ImportStockCard, { importStockMissing, importStockText } from './form/ImportStockCard';
import OwnerCostVerifyCard, { CostOpensAfterSave } from '../auth/OwnerCostVerifyCard';
import PricePreview from './PricePreview';
import MembershipDiscountSection from './form/MembershipDiscountSection';
import ProductDiscountCard from './form/ProductDiscountCard';
import { useProPaused } from '../../lib/proPause';
import { SpecMultiPick } from './form/SpecMultiPick';
import PrinterFitsSection from './form/PrinterFitsSection';
import { ImagesSection } from './form/ImagesSection';
import { MainImagesPair } from './form/MainImagesPair';
import { QuickAddDialog, type QuickAddKind, type QuickAddResult } from './form/QuickAdd';
import { setLeaveGuard } from '../../lib/leaveGuard';

interface TemplateField {
  id: string;
  label_ar: string;
  label_en: string;
  type: 'text' | 'number' | 'select' | 'multiline' | 'hex';
  unit?: string;
  options?: string[];
  /** A list drawn from `options` (templateFamilies `multiple`) — rendered as toggles. */
  multiple?: boolean;
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
  /** §29 serial tracking by section (migration 0178); absent before it. */
  serial_policy?: 'inherit' | 'required' | 'off';
}

/**
 * Whether a served product document carries its cost. The server removes every
 * cost KEY for a session that may not see cost (`stripFinancials`), and a
 * document served to the owner always has `product_cost_iqd` (null or a number).
 */
function carriesCost(product: object): boolean {
  return Object.prototype.hasOwnProperty.call(product, 'product_cost_iqd');
}

/** The relations answer says whether it carried its row costs (option, colour, order type, route). */
type RelationsRead = RelationsResponse & { can_view_cost?: boolean };
/**
 * Whether a structure read carried its costs. The product and its relations
 * are two requests in parallel: an address verified between them leaves one
 * answer with cost and one without, so each answer is asked, and only a read
 * where BOTH say so counts as loaded. `=== true`: an answer from a server that
 * predates the flag is read as "without cost", which only ever keeps costs.
 */
function relationsCarryCost(relations: RelationsRead): boolean {
  return relations.can_view_cost === true;
}

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
  const { user, logout } = useAuth();
  /**
   * PRO, PAUSED (0145): its price field and its discount rule are hidden
   * until the owner resumes it. PREMIUM has none at all any more — «حذف خيار
   * خصم البريميوم» — so its field is gone, not hidden.
   */
  const proPaused = useProPaused();
  // Cost is rendered for the owner only (owner decision 2). The SERVER strips
  // it from every non-owner read and refuses every non-owner write either
  // way — this only avoids showing an input that would be rejected. `=== true`
  // so a hint the session lacks hides the fields instead of showing them.
  const canSeeCost = user?.can_view_cost === true;
  /**
   * WHETHER THE DOCUMENT ON SCREEN WAS READ WITH ITS COST (DECISIONS row 185
   * amendment). The server removes every cost key from a document it serves
   * to a session that may not see cost, so a document read by the owner before
   * the address was verified holds blanks that mean "not shown". The session
   * can turn cost-capable while this form stays open (verified in another
   * tab); its blanks must then never be shown as the cost, or saved as one.
   * Cost inputs show only when both are true, an untouched form re-reads the
   * product, and a save of a form read without cost says so
   * (`cost_loaded: false`), which keeps every stored cost on the server.
   * A new product has nothing stored to lose.
   */
  const [costLoaded, setCostLoaded] = useState(true);
  /**
   * The id add-product's save persists (the server keeps a sent id): the V2
   * preview prices the draft under it before the first save (spec §4.1, P13).
   */
  const [draftId] = useState(() => `prd_${Math.random().toString(36).slice(2, 10)}${Date.now().toString(36)}`);

  const [doc, setDoc] = useState<EditorDoc>(() => blankDoc());
  const [rel, setRel] = useState<RelationsState>(() => emptyRelations());
  const [baseline, setBaseline] = useState('');
  const [loadedUpdatedAt, setLoadedUpdatedAt] = useState('');
  /** The status the server holds (not the editor's): a content save keeps an active product active (`isContentOnlySave`). */
  const [storedStatus, setStoredStatus] = useState('');
  const columnRef = useRef<HTMLDivElement>(null);
  const [loading, setLoading] = useState(!!productId);
  const [loadErr, setLoadErr] = useState<string | null>(null);

  const [brands, setBrands] = useState<BrandV2[]>([]);
  const [catalogs, setCatalogs] = useState<CatalogNode[]>([]);
  const [tplGroups, setTplGroups] = useState<TemplateGroup[]>([]);
  // The family the chosen section resolves to — shown beside the stored one
  // when they differ, never written over it silently.
  const [sectionFamily, setSectionFamily] = useState<string | null>(null);
  /** The product type the chosen section resolves to (worker/lib/templateFamilies.ts). */
  const [sectionType, setSectionType] = useState<string | null>(null);
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
  /** «ما زال الحفظ جارياً» / «نتحقّق…» while a slow save is on its way (saveOutcome.ts); null otherwise. */
  const [saveProgress, setSaveProgress] = useState<string | null>(null);
  const [reviewNeeded, setReviewNeeded] = useState<string[]>([]);
  /**
   * The same fields WITH the reason each one could not be translated, and the
   * Arabic/Kurdish the admin writes by hand for them. §3 forbids inventing
   * prose, so a flagged field can only become correct if a human supplies the
   * copy — `translation_overrides` is how this save carries it, and the server
   * stores it as `approved` so the next save does not regenerate over it.
   */
  const [reviewDetail, setReviewDetail] = useState<ReviewItem[]>([]);
  const [overrides, setOverrides] = useState<TranslationOverrides>({});
  const [transOpen, setTransOpen] = useState(false);
  /**
   * A REFUSED SAVE NEEDS A WAY OUT, NOT JUST A SENTENCE.
   *
   * `STALE_EDIT` said "Review the current version below" and there was nothing
   * below — no current version, no reload, no overwrite. The admin's only
   * option was to leave the screen and lose everything they had typed. This
   * holds the refusal so the banner can offer the two answers that actually
   * exist: take the stored version, or keep mine and write over it.
   */
  const [staleSave, setStaleSave] = useState<'draft' | 'active' | null>(null);
  const [showErrors, setShowErrors] = useState(false);
  const [previewOpen, setPreviewOpen] = useState(false);
  /** «تحديث البيانات»: the sheet, and what its last save did (shown until the next edit). */
  const [sectionUpdateOpen, setSectionUpdateOpen] = useState(false);
  const [fileUpdateNote, setFileUpdateNote] = useState<string | null>(null);
  /**
   * «إعداد المخزون للمنتج المستورد» (Bambu import spec §B.10): the imported product's stock decision, as the
   * admin read answers it. While it is `not_configured` its price cannot be published (409
   * IMPORT_STOCK_NOT_CONFIGURED): section ٣ shows the card, and the save bar the refusal in place of «نشر».
   */
  const [importStock, setImportStock] = useState<ImportStockState | null>(null);
  /** The stock mode was just chosen here: section ٣ says so once, where the card was. */
  const [importStockDone, setImportStockDone] = useState(false);

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

  /** The product and its structure, read in parallel. Nothing on screen changes. */
  const readProduct = useCallback(async (id: string) => {
    const [p, r] = await Promise.all([
      api.get<ProductResponse>(`/api/admin/products-v2/${id}`),
      api.get<RelationsRead>(`/api/admin/products/${id}/relations`),
    ]);
    return { p, r };
  }, []);
  /**
   * Bumped whenever the form takes a new baseline (a load, a background swap,
   * a save). A background read started before one of those is older than what
   * the form now holds, and is dropped.
   */
  const baselineGeneration = useRef(0);
  const applyProduct = useCallback(({ p, r }: { p: ProductResponse; r: RelationsRead }) => {
    const d = toEditorDoc(p.product);
    // Rows when they exist, else the document's own options / colours /
    // media — the precedence the storefront sells by. A product whose
    // structure lives only in the document is shown, and told so.
    const rs = hydrateRelations(r, p.product);
    baselineGeneration.current += 1;
    setDoc(d);
    setRel(rs);
    // Both answers, never the first one alone (see `relationsCarryCost`).
    setCostLoaded(carriesCost(p.product) && relationsCarryCost(r));
    setLoadedUpdatedAt(p.product.updated_at ?? '');
    setStoredStatus(String(p.product.status ?? ''));
    setBaseline(JSON.stringify({ d, rs }));
    setImportStock(p.import_stock ?? null);
    setImportStockDone(false);
  }, []);
  const loadProduct = useCallback(async (id: string) => {
    setLoading(true);
    setLoadErr(null);
    try {
      applyProduct(await readProduct(id));
    } catch (e) {
      setLoadErr(e instanceof ApiError ? e.message : 'تعذّر تحميل المنتج / failed to load');
    } finally {
      setLoading(false);
    }
  }, [readProduct, applyProduct]);

  /**
   * AFTER «تحديث البيانات» SAVED: the product is read back, and the admin's
   * unsaved edits OUTSIDE «المواصفات والمحتوى الإضافي» are laid back on top —
   * that section now holds what the file wrote; nothing else the admin typed
   * is lost. The form stays dirty for those edits, as it should.
   */
  const docRef = useRef(doc);
  docRef.current = doc;
  const relRef = useRef(rel);
  relRef.current = rel;
  const baselineRef = useRef(baseline);
  baselineRef.current = baseline;
  const costLoadedRef = useRef(costLoaded);
  costLoadedRef.current = costLoaded;
  const reloadKeepingEdits = useCallback(
    async (id: string) => {
      const before = baselineRef.current ? (JSON.parse(baselineRef.current) as { d: EditorDoc; rs: RelationsState }) : null;
      const mine = docRef.current;
      const myRel = relRef.current;
      const mineCostLoaded = costLoadedRef.current;
      const section = new Set<string>(['spec_fields', 'spec_groups', 'labels', 'content_blocks', 'usage_guide', 'how_to_use', 'how_to_use_ar', 'how_to_use_ckb', 'printer_fit_ids']);
      const edited = before
        ? (Object.keys(mine) as Array<keyof EditorDoc>).filter(
            (k) => !section.has(k as string) && JSON.stringify(mine[k]) !== JSON.stringify(before.d[k])
          )
        : [];
      const relEdited = !!before && JSON.stringify(myRel) !== JSON.stringify(before.rs);
      await loadProduct(id);
      if (edited.length > 0) {
        setDoc((d) => {
          const next = { ...d } as Record<string, unknown>;
          for (const k of edited) next[k as string] = mine[k];
          return next as unknown as EditorDoc;
        });
      }
      if (relEdited) setRel(myRel);
      // Structure edited on a form read without cost carries its blanks back
      // in: the form stays "read without cost" until it is saved.
      if (relEdited && !mineCostLoaded) setCostLoaded(false);
    },
    [loadProduct]
  );

  useEffect(() => {
    if (productId) void loadProduct(productId);
    else {
      const d = blankDoc();
      const rs = emptyRelations();
      setDoc(d);
      setRel(rs);
      setCostLoaded(true);
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
      setSectionType(null);
      return;
    }
    let alive = true;
    (async () => {
      try {
        const res = await api.get<{ groups: TemplateGroup[]; template_family: string | null; product_type?: string | null }>(
          `/api/admin/taxonomy/templates?category=${encodeURIComponent(id)}`
        );
        if (!alive) return;
        setTplGroups(res.groups ?? []);
        setSectionFamily(res.template_family ?? null);
        setSectionType(res.product_type ?? null);
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
          setSectionType(null);
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
  /**
   * «ناقص» (owner brief 2026-10-10): the SAVED product's verdict against the
   * central required-field list, read again after every load and save (the
   * product's clock). The red flags below describe it; a private field (cost,
   * USD pricing data) is named for the owner alone.
   */
  const completeness = useProductCompleteness(doc.id || productId || null, loadedUpdatedAt);
  const missingItems = completeness?.installed && completeness.evaluated ? (completeness.items ?? []) : [];
  const optionNameOf = useCallback(
    (id: string) => {
      for (const g of rel.groups) for (const v of g.values) if (v.id === id) return v.name_en || v.name_ar || id;
      return id;
    },
    [rel.groups]
  );
  const sectionMissing = (n: number) => missingItems.filter((i) => i.section === n).length;
  const sectionMissingLabel = (n: number) => fill(tri(COMPLETENESS_UI.sectionMissing, lang), { n: sectionMissing(n) });
  /**
   * Cost opened while this form was open (the owner verified the address in
   * another tab): an untouched form simply re-reads the product, once per
   * product, so the cost inputs appear filled with the stored values. A form
   * with edits keeps them; its save keeps every stored cost and the read-back
   * brings the cost in (`CostOpensAfterSave` says so meanwhile).
   */
  const costReloadTried = useRef<string | null>(null);
  const reloadId = productId || doc.id || '';
  const reloadIdRef = useRef(reloadId);
  reloadIdRef.current = reloadId;
  useEffect(() => {
    if (!canSeeCost || costLoaded || !reloadId || loading || dirty) return;
    if (costReloadTried.current === reloadId) return;
    costReloadTried.current = reloadId;
    // A BACKGROUND READ, NOT A RELOAD: `loadProduct` shows the spinner, which
    // unmounts the form and with it every edit held outside the document and
    // structure (the membership discount section keeps its own). The read is
    // swapped in only if, when it lands, the form is the same product, still
    // untouched, and has taken no newer baseline (a save meanwhile) — else it
    // is dropped and the save keeps every stored cost (`cost_loaded: false`).
    const generation = baselineGeneration.current;
    void readProduct(reloadId)
      .then((read) => {
        if (reloadIdRef.current !== reloadId || baselineGeneration.current !== generation) return;
        const clean = JSON.stringify({ d: docRef.current, rs: relRef.current }) === baselineRef.current;
        if (clean) applyProduct(read);
      })
      .catch(() => {
        // Nothing changes: the form keeps working and says the cost comes after the save.
      });
  }, [canSeeCost, costLoaded, reloadId, loading, dirty, readProduct, applyProduct]);
  // The note of a file update stands until the next edit.
  useEffect(() => {
    if (dirty) setFileUpdateNote(null);
  }, [dirty]);

  /**
   * Filed under «المستعمل» (migration 0147): the section's main section is
   * `cat_used`. Read up the tree, so a sub-section the owner adds under it
   * later counts too.
   */
  const inUsedSection = useMemo(() => {
    const byId = new Map(catalogs.map((c) => [c.id, c]));
    return [doc.sub_category_id, doc.category_id].some((start) => {
      let node = start ? byId.get(start) : undefined;
      for (let hop = 0; node && hop < 12; hop++) {
        if (node.id === 'cat_used') return true;
        node = node.parent_id ? byId.get(node.parent_id) : undefined;
      }
      return false;
    });
  }, [catalogs, doc.category_id, doc.sub_category_id]);

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
  // §29: the nearest section that says something about serials, named in the
  // form's language — the server's walk (nearestSectionSerial, ConditionSection.tsx).
  const sectionSerial = useMemo(
    () => nearestSectionSerial(catalogs, [doc.sub_category_id, doc.category_id, ...doc.catalog_ids], lang),
    [catalogs, doc.category_id, doc.sub_category_id, doc.catalog_ids, lang]
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

  // -------------------------------------------------------------- «الأسعار» (Pricing V2)
  // Every ordinary product is priced in sections ٣ and ٥ by the V2 writer (the clean start, DECISIONS
  // row 222): the owner and the price editors type dollars (Q2), the owner alone the cost; the save
  // sends structure and prices together (`pricing_v2`, one batch) and the review sheet shows only the
  // prices that change. Every price shown is the server's answer (form/v2/useV2Pricing.ts).
  const v2Lang = lang === 'en' ? 'en' : lang === 'ckb' ? 'ckb' : 'ar';
  const v2s = v2Strings(v2Lang);
  /** The document and relations the save would post (the structure a preview prices). */
  const structureOf = useCallback(() => {
    const { options: _o, colors: _c, media: _m, ...docFields } = docRef.current as EditorDoc & Record<string, unknown>;
    void _o; void _c; void _m;
    return { doc: docFields as Record<string, unknown>, relations: relationsToWire(relRef.current) as unknown as Record<string, unknown> };
  }, []);
  /** The priced part of the structure (v2Model `pricedStructureKey`), the model's and the colours' packages with it. */
  const structureKeyOf = (d: Pick<EditorDoc, 'sale_types'>, r: RelationsState) => pricedStructureKey(d.sale_types, r);
  const structureKey = structureKeyOf(doc, rel);
  const savedStructureKey = useMemo(() => {
    try {
      const b = baseline ? (JSON.parse(baseline) as { d: EditorDoc; rs: RelationsState }) : null;
      return b ? structureKeyOf(b.d, b.rs) : '';
    } catch {
      return '';
    }
  }, [baseline]);
  const live = useMemo<Omit<V2LiveIds, 'skus'>>(() => {
    const active = rel.groups.flatMap((g) => g.values.filter((v) => v.active !== false));
    return {
      options: new Set(active.map((v) => v.id)),
      models: new Set((rel.groups[0]?.values ?? []).filter((v) => v.active !== false).map((v) => v.id)),
      colours: new Set(rel.colors.filter((c) => c.active !== false).map((c) => c.id)),
    };
  }, [rel.groups, rel.colors]);
  // Row 247: each model's own «أبعاد الخيار» — an own-cost model's weight and box are its packaged ones.
  const optionPackagesKey = JSON.stringify((rel.groups[0]?.values ?? []).map((v) => [v.id, v.dimensions ?? null]));
  const optionPackages = useMemo(
    () => Object.fromEntries((JSON.parse(optionPackagesKey) as Array<[string, ProductDimensionsV2 | null]>).map(([id, d]) => [id, d])),
    [optionPackagesKey]
  );
  // The same as last saved (the baseline): a pricing value equal to it is a mirror that follows the dimensions.
  const savedOptionPackagesKey = useMemo(() => {
    try {
      const b = baseline ? (JSON.parse(baseline) as { rs: RelationsState }) : null;
      return JSON.stringify((b?.rs.groups[0]?.values ?? []).map((v) => [v.id, v.dimensions ?? null]));
    } catch {
      return '[]';
    }
  }, [baseline]);
  const savedOptionPackages = useMemo(
    () => Object.fromEntries((JSON.parse(savedOptionPackagesKey) as Array<[string, ProductDimensionsV2 | null]>).map(([id, d]) => [id, d])),
    [savedOptionPackagesKey]
  );
  const v2 = useV2Pricing({
    // Every product this form edits is priced by V2 (a bundle never opens here: its editor is the bundles panel).
    enabled: true,
    productId: productId || doc.id || null,
    draftId,
    ownerHint: canSeeCost,
    structureOf,
    structureKey,
    structureDirty: baseline !== '' && structureKey !== savedStructureKey,
    live,
    packageDims: doc.dimensions ?? null,
    optionPackages,
    savedOptionPackages,
  });
  const modelNames = useCallback(
    (id: string) => {
      for (const g of rel.groups) for (const v of g.values) if (v.id === id) return { ar: v.name_ar || v.name_en, en: v.name_en, ckb: v.name_ckb || v.name_en };
      return null;
    },
    [rel.groups]
  );
  const firstModelId = rel.groups[0]?.values.find((v) => v.active !== false)?.id ?? null;
  const lowest = v2.answer ? lowestPrice(v2.answer.table) : null;
  // THE TYPED PRICES NEVER LEAVE SILENTLY (owner report 2026-10-10, row 214 F3): dollars typed and not
  // saved — or a review sheet waiting — live only in this page, so leaving it asks first. Every way out
  // asks — «رجوع», the browser, and the dashboard's sidebar, drawer and menus (lib/leaveGuard.ts).
  const leaveWarning = v2.touched || !!v2.review ? v2s.leaveUnsaved : null;
  const leave = () => {
    if (leaveWarning && !window.confirm(leaveWarning)) return;
    onBack();
  };
  useEffect(() => {
    if (!leaveWarning) return;
    const warn = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      e.returnValue = '';
    };
    window.addEventListener('beforeunload', warn);
    const release = setLeaveGuard(() => window.confirm(leaveWarning));
    return () => {
      window.removeEventListener('beforeunload', warn);
      release();
    };
  }, [leaveWarning]);
  /** The imported product's price publish waits for its stock mode (§B.10): the save bar says so, «نشر» stays. */
  const stockMissing = importStockMissing(importStock);
  /** The save bar's way to the stock card: section ٣ opened, the card scrolled to. */
  const showImportStock = () => {
    setOpen(3);
    requestAnimationFrame(() => document.querySelector('[data-import-stock]')?.scrollIntoView({ block: 'start', behavior: 'smooth' }));
  };
  /** «اعرض»: the section a pricing refusal or a missing line names, opened and scrolled to (٣ the product, ٥ its models). */
  const showPricing = (n: 3 | 5) => {
    setOpen(n);
    requestAnimationFrame(() =>
      document.querySelector(n === 3 ? '[data-form="pricing-v2"]' : '[data-section="5"]')?.scrollIntoView({ block: 'start', behavior: 'smooth' })
    );
  };

  const errors: FormErrors = useMemo(
    () =>
      validateForm({
        name_en: doc.name_en,
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

  /** Product sale types are the union of the enabled per-model checkboxes. */
  const optionSaleTypes = (() => {
    const declared = new Set<SaleType>();
    for (const g of rel.groups) {
      for (const v of g.values) {
        if (v.active === false) continue;
        for (const fulfillment of v.fulfillments) {
          if (fulfillment.enabled) declared.add(fulfillment.fulfillment_type);
        }
      }
    }
    return declared;
  })();
  const saleTypesAreDerived = optionSaleTypes.size > 0;
  const derivedSaleTypes: SaleType[] = saleTypesAreDerived
    ? (['direct_sale', 'pre_order'].filter((id) => optionSaleTypes.has(id as SaleType)) as SaleType[])
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

  // -------------------------------------------------------------- saving

  /**
   * ONE «نشر» (spec §5.6, docs/PRICING-V2.md §2.6): the document, the structure and — for every ordinary
   * product — its `pricing_v2` block go in ONE request, which the server writes in ONE batch. When no
   * price moves it saves with no sheet; when prices move the server answers 409 with its preview and
   * the review sheet lists only the changed rows; its confirm resends with the preview's hash (and the
   * 15% tick); a fresh sign-in is asked for a large change. Cancel keeps every typed value.
   */
  const save = async (
    status: 'draft' | 'active',
    { overwrite = false, confirm }: { overwrite?: boolean; confirm?: { hash: string; confirmLarge: boolean } } = {}
  ) => {
    setShowErrors(true);
    setStaleSave(null);
    const next = { ...doc, status } as EditorDoc;
    const check = validateForm({
      name_en: next.name_en,
      category_id: next.category_id,
      sale_types: next.sale_types as SaleType[],
      rel,
      publishing: status === 'active',
      warranty: warrantyInput,
      delivery_options: next.delivery_options,
    });
    if (Object.keys(check).length > 0) {
      setSaveErr(saveOutcomeText('checkFields', lang));
      return;
    }

    setSaving(true);
    setSaveErr(null);
    setSaveNote(null);
    setSaveProgress(null);
    // A slow save is SAID, not left to look stuck (saveOutcome.ts): the deadline is the write's own.
    const stillSaving = window.setTimeout(() => setSaveProgress(saveOutcomeText('stillSaving', lang)), STILL_SAVING_AFTER_MS);
    // The prices as typed now (and the review sheet's answer): they travel with the product. A content save of
    // a visible, unpriced product sends none (`isContentOnlySave`): it stays visible and unpriced.
    const pricingBlock = isContentOnlySave({ status, storedStatus, needsMethod: v2.needsMethod, touched: v2.touched, confirming: !!confirm })
      ? null
      : v2.saveBlock(status, confirm);
    try {
      // The document WITHOUT its derived copies of the structure: `options`,
      // `colors` and `media` have no editor here, and the server rebuilds the
      // product's JSON mirror from the rows this same request writes. Sending
      // the copy the form happened to be holding is how a deleted option came
      // back the next time the product was read.
      const { options: _o, colors: _c, media: _m, ...docFields } = next as EditorDoc & Record<string, unknown>;
      void _o; void _c; void _m;
      const body: Record<string, unknown> = {
        // The clean start (A.6): no dinar price travels — the server keeps every stored one.
        ...docWithoutLegacyMoney(docFields),
        // Add-product: the id the V2 preview priced the draft under (the server keeps a sent id).
        ...(next.id ? {} : { id: draftId }),
        relations: withoutLegacyMoney(relationsToWire(rel)),
        ...(Object.keys(overrides).length ? { translation_overrides: overrides } : {}),
        // Omitted deliberately when the admin has chosen to overwrite: the
        // server skips the stale check when no expectation is stated, which is
        // exactly what "keep my version" means.
        expected_updated_at: overwrite ? undefined : loadedUpdatedAt || undefined,
        // Read without cost: the blanks this form holds are "not shown", and
        // the server keeps every stored cost (see `costLoaded`).
        ...(next.id && !costLoaded ? { cost_loaded: false } : {}),
        ...(pricingBlock ? { pricing_v2: pricingBlock } : {}),
      };
      const res = await api.post<SaveResponse & {
        translation_review_needed?: string[];
        translation_review?: ReviewItem[];
        warnings?: string[];
        already?: boolean;
        pricing_v2?: { priced: boolean };
      }>(
        '/api/admin/products-v2',
        body,
        // The product write's own deadline: its measured worst case with room, never the 20 s of a page read.
        { timeoutMs: PRODUCT_WRITE_TIMEOUT_MS }
      );
      const savedId = res.product?.id ?? next.id ?? draftId;
      setReviewNeeded(res.translation_review_needed ?? []);
      setReviewDetail(res.translation_review ?? []);
      // What was just written is stored and `approved`; re-sending it on every
      // later save would only be noise, and the read-back below already carries
      // the text into the document.
      setOverrides({});

      // WHAT THE FORM SHOWS AFTER A SAVE IS A READ-BACK, NOT THE ECHO.
      // The save answers with the product document; the structure is read from
      // the same endpoint the form LOADS from, so the picture list, the
      // variants and the stock level are the stored rows rather than a partial
      // echo. The ROWS, not the document: falling back to the document's JSON
      // copy here would resurrect an option or a picture just deleted.
      const fresh = await api.get<RelationsResponse>(`/api/admin/products/${savedId}/relations`);
      const savedRel = relationsFromWire(fresh);
      setRel(savedRel);
      const notes = [...(res.warnings ?? [])];
      if (res.pricing_v2) notes.push(res.pricing_v2.priced ? v2s.savedPriced : v2s.savedDataOnly);
      if (notes.length) setSaveNote(notes.join(' · '));

      const freshDoc = res.product ? toEditorDoc(res.product) : { ...next, id: savedId };
      setDoc(freshDoc);
      // The echo and the structure read-back are two answers too.
      if (res.product) setCostLoaded(carriesCost(res.product) && relationsCarryCost(fresh));
      setLoadedUpdatedAt(res.product?.updated_at ?? loadedUpdatedAt);
      setStoredStatus(String(res.product?.status ?? status));
      // The baseline is what the SERVER now holds — document and structure —
      // so the form is clean after a save instead of showing the read-back's
      // own normalisation (sort numbers, derived stock level) as unsaved work.
      baselineGeneration.current += 1;
      setBaseline(JSON.stringify({ d: freshDoc, rs: savedRel }));
      setShowErrors(false);
      // The prices are read again from the server and the draft starts over from them.
      v2.afterSave();
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
      if (e instanceof ApiError && e.code === 'STALE_EDIT') {
        setStaleSave(status);
        setSaveErr(null);
        return;
      }
      // NO ANSWER IS NOT «NOT SAVED» (saveOutcome.ts): the deadline fired or the answer was lost, and the
      // server may have written. Read the product again and say what is true — never a blind «try again».
      if (writeOutcomeUnknown(e)) {
        const savedId = next.id || draftId;
        setSaveProgress(saveOutcomeText('checking', lang));
        const { outcome } = await confirmSaveOutcome(savedId, next.id ? loadedUpdatedAt || '' : '');
        setSaveProgress(null);
        if (outcome === 'saved') {
          setOverrides({});
          setShowErrors(false);
          v2.afterSave();
          onListChanged();
          await loadProduct(savedId);
          setSaveNote(saveOutcomeText('saved', lang));
          return;
        }
        const said = saveOutcomeText(outcome, lang);
        setSaveErr(said);
        if (v2.review) v2.reviewError(said);
        return;
      }
      const text = contractRefusal(e, refusalLang(lang), failureText(e, saveOutcomeText('failed', lang)));
      // THE ONE SHEET: prices move — the server's preview of exactly what this save writes.
      const preview = e instanceof ApiError ? previewOf(e.details) : null;
      if (
        e instanceof ApiError &&
        preview &&
        (e.code === 'PRICING_PREVIEW_REQUIRED' || e.code === 'PRICING_PREVIEW_STALE' || e.code === 'PRICING_LARGE_CHANGE_CONFIRM')
      ) {
        v2.openReview(preview, status);
        if (e.code === 'PRICING_PREVIEW_STALE' && confirm) v2.reviewError(text);
        return;
      }
      if (e instanceof ApiError && e.code === 'REAUTH_REQUIRED' && v2.review) {
        v2.reviewError(v2s.reauth, true);
        return;
      }
      // A refusal that names its section opens it (٣ the prices, ٥ a model or a colour).
      const section = e instanceof ApiError ? refusalSection(e.details) : null;
      if (section) {
        v2.closeReview();
        showPricing(section);
      }
      const lines = e instanceof ApiError ? refusalIssues((e.body ?? e.details ?? {}) as Parameters<typeof refusalIssues>[0]) : [];
      // A refusal of the programme contract (OWNER_ONLY: the product's serial
      // answer is the owner's) in the reader's language, Sorani included; any
      // other failure reads exactly as before.
      setSaveErr(lines.length ? `${text}: ${lines.join(' · ')}` : text);
      if (v2.review) v2.reviewError(text);
    } finally {
      window.clearTimeout(stillSaving);
      setSaveProgress(null);
      setSaving(false);
    }
  };

  /** The review sheet's confirm: the same save, with the preview's hash and the tick. */
  const confirmReview = (confirmLarge: boolean) => {
    const r = v2.review;
    if (!r?.preview.review_hash) return;
    void save(r.status, { confirm: { hash: r.preview.review_hash, confirmLarge } });
  };
  /** A large change needs a NEW sign-in: the session ends first; the way back is this product's form. */
  const signInAgain = async () => {
    const id = productId || doc.id;
    try {
      await logout?.();
    } finally {
      window.location.assign(`/auth?next=${encodeURIComponent(id ? `/admin?tab=products&edit=${encodeURIComponent(id)}` : '/admin?tab=products')}`);
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

  /** One line per REASON rather than 66 keys — the counts an owner can act on. */
  const reviewSummary = useMemo(() => {
    const text: Record<ReviewItem['reason'], string> = {
      not_english: 'مكتوبة بالعربية داخل حقل الإنجليزية — صفحة الإنجليزية تعرضها كما هي',
      prose: 'جُمل حرّة — تحتاج مترجمًا بشريًا دائمًا',
      terms: 'مصطلحات غير موجودة في القاموس المحلي',
    };
    const counts = new Map<ReviewItem['reason'], number>();
    for (const item of reviewDetail) counts.set(item.reason, (counts.get(item.reason) ?? 0) + 1);
    return [...counts].map(([reason, count]) => ({ reason, count, text: text[reason] }));
  }, [reviewDetail]);
  if (loading) {
    return (
      <div className="p-6 text-center text-text-secondary text-sm">
        <RefreshCw className="w-5 h-5 animate-spin mx-auto mb-2" /> جارٍ التحميل…
      </div>
    );
  }
  if (loadErr) {
    return (
      <div className="p-4">
        <Banner kind="error">{loadErr}</Banner>
        <button type="button" className={btnGhost} onClick={leave}>
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
  // Serial tracking has its own control for every product now (§29); only the
  // base months of a non-printer are kept without an editor.
  const warrantyHiddenValues = !isPrinterCatalog && doc.warranty_plans.length === 0 && doc.warranty_base_months !== null;

  return (
    // min-w-0 on the outer column is what keeps a long value from widening the
    // whole admin page, and there is no bottom padding: this screen owns its
    // own bottom edge (see the effect above and the save bar below).
    // «الأسعار» (Pricing V2): one state for its mount points (sections ٣, ٥ and ٨, and the review sheet).
    <V2PricingProvider value={v2}>
    <CompletenessProvider items={missingItems} lang={lang} optionName={optionNameOf}>
    <div ref={columnRef} className="min-w-0 w-full max-w-[880px] mx-auto px-3">
      <div className="flex items-center gap-2 py-3 min-w-0">
        <button type="button" onClick={leave} className={`${btnGhost} h-10 px-2.5`} aria-label="رجوع">
          <Back className="w-4 h-4" />
        </button>
        <h2 className="text-base font-black text-white truncate min-w-0 flex-1">
          {productId ? 'تعديل منتج' : 'منتج جديد'}
          <span className="text-[11px] font-medium text-text-muted ms-2">{doc.name_en || '—'}</span>
        </h2>
        {/* The clean start: an active product still «يحتاج تسعيرًا» is hidden from customers — the header
            says so in the warning tone, never «منشور» beside section ٣'s «مخفي». */}
        <span
          data-form="status-chip"
          className={`shrink-0 text-[11px] font-bold px-2 py-1 rounded-md ${
            doc.status === 'active' && !v2.hidden
              ? 'lv-chip [--chip:var(--color-success)]'
              : doc.status === 'draft'
                ? 'bg-surface-selected text-text-secondary'
                : 'lv-chip [--chip:var(--color-warning)]'
          }`}
        >
          {headerStatusText(doc.status, v2.hidden, v2s)}
        </span>
      </div>

      {saveErr && <Banner kind="error">{saveErr}</Banner>}
      <CompletenessBanner read={completeness} lang={lang} dirty={dirty} status={doc.status} />
      {/* «اكتمال المعلومات» (the Bambu import spec §H.2): how well the product is described — never a sale gate. */}
      <InfoCompletenessCard productId={doc.id || productId || null} lang={lang === 'en' || lang === 'ckb' ? lang : 'ar'} />
      {staleSave && (
        <div data-form="stale-edit">
          <Banner kind="warn">
            <p className="mb-2 leading-relaxed">
              النسخة المحفوظة تغيّرت بعد فتح هذه الصفحة — غالبًا لأن تعديلًا سريعًا حُفظ، أو لأن
              المنتج مفتوح في تبويب آخر. تغييراتك ما زالت أمامك ولم يُحذف شيء.
              <span className="block text-text-secondary text-[11px] mt-1">
                The stored copy moved since this page was opened. Nothing you typed was lost.
              </span>
            </p>
            <div className="flex flex-wrap gap-2">
              <button type="button" className={btnPrimary} disabled={saving} onClick={() => void save(staleSave, { overwrite: true })}>
                احفظ تغييراتي فوقها
              </button>
              <button
                type="button"
                className={btnGhost}
                disabled={saving || !productId}
                onClick={() => {
                  setStaleSave(null);
                  if (productId) void loadProduct(productId);
                }}
              >
                اعرض النسخة المحفوظة (تُلغى تغييراتي)
              </button>
            </div>
          </Banner>
        </div>
      )}
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
        <div data-form="translation-review">
          <Banner kind="warn">
            {/*
              WHAT THIS USED TO SAY: that the fields had "stayed in English",
              printed under a list of 66 opaque field keys. For a form filled in
              Arabic that sentence was not even true, and it hid the one fact
              that mattered: the local engine runs English → ar/ckb and never
              invents prose (§3), so these fields need a person, not a retry.
              The counts below say which situation each field is in, and the
              button is the door that was missing.
            */}
            <p className="mb-2 leading-relaxed">
              حُفظ المنتج. {reviewNeeded.length} حقلًا تحتاج ترجمة بشرية — المترجم المحلي يعمل من الإنجليزية إلى
              العربية والكردية ولا يؤلّف جملًا.
            </p>
            {reviewSummary.length > 0 && (
              <ul className="mb-2 space-y-0.5 text-[11px] text-amber-200/90">
                {reviewSummary.map((r) => (
                  <li key={r.reason}>
                    • {r.count} — {r.text}
                  </li>
                ))}
              </ul>
            )}
            <button type="button" className={btnPrimary} onClick={() => setTransOpen(true)}>
              اكتب الترجمة يدويًا
            </button>
          </Banner>
        </div>
      )}
      {transOpen && (
        <React.Suspense fallback={null}>
          <TranslationsSheet
            doc={doc}
            review={reviewDetail}
            overrides={overrides}
            onApply={setOverrides}
            onClose={() => setTransOpen(false)}
          />
        </React.Suspense>
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
        missing={sectionMissing(1)}
        missingLabel={sectionMissingLabel(1)}
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
          <Field ar="١· القسم الرئيسي" en="Main section" required need="CATEGORY" error={err('category_id')} htmlFor="pf-category">
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
                      className="inline-flex items-center gap-0.5 rounded-full border border-dashed border-border-subtle px-2.5 min-h-8 text-[11px] text-text-secondary hover:text-text-primary hover:border-text-muted transition-colors"
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
                      className="inline-flex items-center gap-1 bg-surface-selected border border-border-subtle rounded-full px-2 h-6 text-[11px] text-text-primary"
                    >
                      <span dir="ltr">#{h}</span>
                      <button
                        type="button"
                        aria-label={`حذف ${h}`}
                        className="text-text-muted hover:text-red-400"
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
          <p className="text-[11px] text-text-secondary mt-2" data-form="catalogs-preserved">
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
        missing={sectionMissing(2)}
        missingLabel={sectionMissingLabel(2)}
        ar="المعلومات الأساسية"
        en="Basics"
        summary={doc.name_en || 'بلا اسم'}
        error={showErrors && !!errors.name_en}
        {...section(2)}
      >
        {/* The Arabic name has no input of its own here (it is translated on
            save, or written in the translations sheet): the flag says so. */}
        <MissingBlock codes={['NAME_AR']} />
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
              <div className="space-y-1 rounded-lg bg-surface-raised p-2" data-form="imported-texts">
                {imported.map((r) => (
                  <div key={r.key} className="text-[12px] min-w-0">
                    <span className="text-text-muted">{r.label}: </span>
                    <span className="text-text-primary break-words" dir="auto">
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

      {/* 3 ──────────────────────────────────────────── prices, memberships
          «الأسعار» — Pricing V2 for every product (spec §5.3, addendum A.7): the method, the cost
          (the owner's), the dollar price and the pre-order discount, the result, what is missing and
          the final customer prices. No dinar price is typed here, and no old one is shown. */}
      <SectionCard
        n={3}
        missing={sectionMissing(3)}
        missingLabel={sectionMissingLabel(3)}
        ar={proPaused ? 'الأسعار' : 'الأسعار والعضويات'}
        en={proPaused ? 'Prices' : 'Prices & memberships'}
        chip={<StatusChipV2 answer={v2.answer} owner={v2.owner} hidden={v2.hidden} />}
        // The chip already says «مخفي: يحتاج تسعيرًا»: the summary never repeats it.
        summary={summarize([lowest !== null ? v2s.from(iqdText(lowest)) : v2.hidden ? null : v2s.noPriceYet])}
        error={showErrors && !!errors.prices}
        {...section(3)}
      >
        {/* The owner before the address is verified: no cost input, and the
            way to open it (DECISIONS row 185 amendment). */}
        {!canSeeCost && user?.owner_email_unverified === true && <OwnerCostVerifyCard compact />}
        {/* Verified while this form was open, with edits not saved yet: the
            cost appears after the save (which keeps every stored cost). */}
        {canSeeCost && !costLoaded && <CostOpensAfterSave />}

        {/* «إعداد المخزون للمنتج المستورد» (§B.10): the stock mode an imported product needs before its price. */}
        {stockMissing && doc.id ? (
          <ImportStockCard
            productId={doc.id}
            dirty={dirty}
            onDecided={(next) => {
              setImportStock(next);
              setImportStockDone(true);
            }}
          />
        ) : null}
        {importStockDone && !stockMissing ? (
          <p className="mb-3 text-[12px] text-text-secondary" role="status" data-import-stock-done>
            {importStockText('done', v2Lang)}
          </p>
        ) : null}

        <PricesSectionV2 modelNames={modelNames} firstModelId={firstModelId} packageDims={doc.dimensions ?? null} onJump={showPricing} productId={doc.id || null} />

        {/* The real cost layers behind the stock (the owner's batches): renders nothing
            for a product with no batches, or for an admin whose payload carries no costs. */}
        {canSeeCost && doc.id && <InventorySummary productId={doc.id} />}

        {/* «تخفيض السعر» (docs/ux/PRODUCT-DISCOUNT.md §6): the price AFTER a discount, in dollars or a
            percent, on the published price. It saves through the special-offers door — the same row
            the «العروض الخاصة» tab edits — with its own button, never with this form's «حفظ». */}
        <ProductDiscountCard productId={doc.id || null} />

        {/* §18 — THE MEMBERSHIP DISCOUNT RULE FOR THIS ONE PRODUCT. A membership
            benefit, not a typed price (typed member prices are retired with the old
            dinar pricing, DECISIONS row 222): it saves through the admin benefits
            door, NOT with this form — every write to a benefit rule appends a
            version and an audit row in one batch. */}
        {!proPaused && (
          <MembershipDiscountSection
            // `doc.id`, not the `productId` prop: after the FIRST save the prop
            // is still null (the parent list has not re-mounted the editor) while
            // the document already carries the id the server assigned.
            productId={doc.id || null}
            typedMemberPrice={{ prime: null, pro: null }}
          />
        )}
      </SectionCard>

      {/* 4 ───────────────────────────────────── delivery and warranty only */}
      <SectionCard
        n={4}
        missing={sectionMissing(4)}
        missingLabel={sectionMissingLabel(4)}
        ar="خيارات التوصيل والضمان"
        en="Delivery & warranty"
        summary={summarize([
          doc.delivery_options ? 'توصيل مخصص' : 'تعرفة التوصيل العامة',
          doc.delivery_options?.standard.enabled === false ? 'العادي معطّل' : undefined,
          isPrinterCatalog && doc.warranty_plans.some((p) => p.active)
            ? `ضمان ممدد ${doc.warranty_plans.filter((p) => p.active).map((p) => `+${p.duration_months}`).join(' / ')}`
            : undefined,
        ])}
        error={
          showErrors &&
          Object.keys(errors).some((k) => k.startsWith('warranty') || k === 'serialized')
        }
        {...section(4)}
      >
        {/* Product-owned delivery tariffs. Existing products remain on the
            global legacy tariff until an admin explicitly opts them in; this
            prevents an unrelated edit from changing live checkout totals. */}
        <div className="border-t border-border-subtle pt-3 mb-4" data-form="delivery-options">
          <div className="flex flex-wrap items-start justify-between gap-2 mb-3">
            <div className="min-w-0">
              <h4 className="text-[13px] font-bold text-text-primary">
                خيارات التوصيل <span className="text-[11px] font-medium text-text-muted">Delivery options</span>
              </h4>
              <p className="text-[11px] leading-relaxed text-text-muted mt-0.5">
                العادي رسم واحد للشحنة: ٥٬٠٠٠ د.ع للقطع العادية و١٠٬٠٠٠ د.ع للشحنة التي تحتوي طابعة. تعطيل الطريقة يمنع اختيارها لهذا المنتج.
              </p>
            </div>
            {doc.delivery_options ? (
              <button
                type="button"
                className={`${btnGhost} !h-8 text-[11px]`}
                onClick={() => setDoc((d) => ({ ...d, delivery_options: null }))}
                data-delivery-use-legacy
              >
                استخدام التعرفة العامة
              </button>
            ) : (
              <button
                type="button"
                className={`${btnGhost} !h-8 text-[11px]`}
                onClick={() => setDoc((d) => ({ ...d, delivery_options: defaultProductDeliveryOptions() }))}
                data-delivery-configure
              >
                تخصيص لهذا المنتج
              </button>
            )}
          </div>

          <DeliveryAvailabilityNotice options={doc.delivery_options} printer={isPrinterCatalog} />

          {!doc.delivery_options ? (
            <p className="rounded-md bg-surface-raised px-3 py-2 text-[11px] text-text-secondary" data-delivery-legacy-note>
              هذا المنتج يستخدم تعرفة التوصيل العامة الحالية للحفاظ على توافق الطلبات والمنتجات القديمة.
            </p>
          ) : (
            <div className="divide-y divide-border-subtle rounded-lg border border-border-subtle px-3">
              {([
                ['standard', 'التوصيل العادي', 'Standard delivery'],
              ] as const).map(([method, ar, en]) => {
                const rule = doc.delivery_options![method];
                const setRule = (change: Partial<typeof rule>) =>
                  setDoc((d) =>
                    d.delivery_options
                      ? {
                          ...d,
                          delivery_options: {
                            ...d.delivery_options,
                            [method]: { ...d.delivery_options[method], ...change },
                          },
                        }
                      : d
                  );
                return (
                  <div key={method} className="py-3" data-delivery-method={method}>
                    <div className="max-w-sm mb-2">
                      <Toggle
                        checked={rule.enabled}
                        onChange={(enabled) => setRule({ enabled })}
                        label={ar}
                        sub={en}
                      />
                    </div>
                    <p className="text-[11px] text-text-secondary">تعطيل أو تفعيل التوصيل العادي فقط؛ الرسم ثابت للشحنة ولا يزيد مع الكمية أو عدد المنتجات.</p>
                  </div>
                );
              })}
            </div>
          )}
        </div>

        {/* Extended warranty — printers only (owner mandate). Two switches
            (+12 → 24, +24 → 36), a percent of the printer price each, and the
            device coverage they rest on. Hidden for anything that is not
            filed under a printer catalog; a non-printer that still carries
            plans is told the save will be refused and offered a clear. */}
        {warrantyHiddenValues && (
          <p className="text-[11px] text-text-secondary mb-3" data-form="warranty-preserved">
            محفوظ من الملف: {`ضمان أساسي ${doc.warranty_base_months} شهرًا`} — محرره يظهر لأقسام الطابعات فقط.
          </p>
        )}
        {doc.payment_options.length > 0 && (
          <p className="text-[11px] text-text-secondary mb-3" data-form="payment-options-preserved">
            خيارات الدفع المحفوظة: <span dir="ltr">{doc.payment_options.join(', ')}</span> — تُعدَّل عبر القالب النصي.
          </p>
        )}

        {/* «تريدها أقساط؟» — the ONE switch that turns the instalments note on
            for this product. Until this field existed the column could only be
            written from the TXT template, so a feature that shipped enabled had
            no way to appear on any product from the admin at all.

            EMPTY IS THE OFF POSITION and it is the default: the storefront
            draws nothing without a link, because a note under an offer the
            shop cannot open is worse than no note. The value is stored through
            `safeLink` (worker/lib/productModel.ts) and the product page refuses
            anything that is not http(s), so a pasted `javascript:` or a
            relative path is dropped rather than rendered — which is also why
            the hint asks for the full link and not a path. */}
        <div className="mb-4 max-w-xl">
          <Field
            ar="رابط المنتج في تطبيق جني (التقسيط)"
            en="This product's page in the Gini instalments app"
            hint="اتركه فارغًا إذا لم يكن المنتج معروضًا في جني — عندها لا تظهر ملاحظة «تريدها أقساط؟». الرابط الكامل فقط (https://…)."
          >
            <TextInput
              type="url"
              inputMode="url"
              placeholder="https://"
              data-form="gini-url"
              value={doc.gini_url}
              onChange={(e) => setDoc((d) => ({ ...d, gini_url: e.target.value }))}
            />
          </Field>
        </div>
        <WarrantySection
          isPrinter={isPrinterCatalog}
          plans={doc.warranty_plans}
          serialized={doc.serialized ?? null}
          baseMonths={doc.warranty_base_months ?? null}
          // The example is the V2 direct price (the lowest sold), never an old dinar price of the document.
          priceIqd={v2.answer && !v2.answer.needs_pricing ? lowestPrice((v2.answer.table ?? []).filter((r) => r.channel === 'direct_sale')) : null}
          errors={showErrors ? errors : {}}
          onPlansChange={(next) => setDoc((d) => ({ ...d, warranty_plans: next }))}
          onSerializedChange={(v) => setDoc((d) => ({ ...d, serialized: v }))}
          canEditSerial={!!user?.is_owner}
          sectionSerial={sectionSerial}
          onBaseMonthsChange={(v) => setDoc((d) => ({ ...d, warranty_base_months: v }))}
        />

        {/* Open box / used / refurbished. Beside the warranty because a graded
            listing's coverage IS one of its condition facts — the server
            refuses to sell extensions on top of it. Collapsed to a single
            select for a new product, which is nearly every product. */}
        <div className="mt-5 pt-5 border-t border-border-subtle">
          <ConditionSection
            condition={doc.condition ?? null}
            onChange={(next) => setDoc((d) => ({ ...d, condition: next }))}
            inUsedSection={inUsedSection}
            serialTracking={{ own: doc.serialized ?? null, isPrinter: isPrinterCatalog, section: sectionSerial }}
          />
        </div>

        {/* «الأبعاد والوزن». Beside the warranty and the grade because all
            three are facts about the physical thing rather than about its
            price — and because a courier quote and a «هل يدخل على الطاولة؟»
            are the two questions this block answers. */}
        <div className="mt-5 pt-5 border-t border-border-subtle">
          <h3 className="mb-3 text-sm font-bold text-white">
            الأبعاد والوزن <span className="text-text-muted font-medium">/ Dimensions & weight</span>
          </h3>
          <DimensionsSection
            dimensions={doc.dimensions ?? emptyDimensions()}
            onChange={(next) => setDoc((d) => ({ ...d, dimensions: next }))}
            flags
          />
        </div>

      </SectionCard>

      {/* 5 ────────────────────────────────────────── options and colours */}
      <SectionCard
        n={5}
        missing={sectionMissing(5)}
        missingLabel={sectionMissingLabel(5)}
        ar="الخيارات والألوان"
        en="Options & colours"
        count={valueCount + rel.colors.length}
        summary={summarize([
          `${rel.groups.length} مجموعة`,
          `${valueCount} قيمة`,
          `${rel.colors.length} لون`,
          rel.inventory_mode,
        ])}
        error={showErrors && Object.keys(errors).some((k) => k.startsWith('group') || k.startsWith('value') || k.startsWith('option_stock') || k.startsWith('color') || k.startsWith('variant') || k === 'inventory_mode' || k === 'sale_types')}
        {...section(5)}
      >
        {showErrors && errors.sale_types && <Banner kind="error">{errors.sale_types}</Banner>}
        <OptionsSection
          rel={rel}
          setRel={setRel}
          baseDimensions={doc.dimensions ?? emptyDimensions()}
          errors={showErrors ? errors : {}}
          // «الخيارات والألوان» on Pricing V2 (spec §5.4): the only money on these cards is one dollar
          // selector per model and per colour; the price beside it is the server's answer.
          pricingV2={
            v2.mode
              ? {
                  model: (v, isModel, onDims) => (
                    <ModelPriceSelector
                      id={v.id}
                      isModel={isModel}
                      line={lineWithOption(v2.answer?.table ?? [], v.id, v2.draft?.colours)}
                      measure={{ dims: v.dimensions ?? null, onDims, heading: optionDimsHeading(v.name_en) }}
                    />
                  ),
                  colour: (c) => <ColourPriceSelector id={c.id} table={v2.answer?.table ?? []} />,
                  combo: (combo) => {
                    const key = comboKeyOf(combo.option_value_ids, combo.color_id);
                    const line = skuLines(v2.answer?.table ?? []).find((l) => l.combo_key === key);
                    const direct = line?.channels.direct_sale?.price_iqd ?? null;
                    return direct !== null ? (
                      <p className="mt-1 text-[11px] text-text-secondary" data-v2-combo={key}>
                        {v2s.direct} <span dir="ltr" className="font-bold tabular-nums text-text-primary">{iqdText(direct)}</span>
                      </p>
                    ) : null;
                  },
                  colourBar: <ColourBulkBar colourIds={rel.colors.filter((c) => c.active !== false).map((c) => c.id)} />,
                }
              : undefined
          }
        />
      </SectionCard>

      {/* 6 ───────────────────────────────────────────────────────── images */}
      <SectionCard
        n={6}
        missing={sectionMissing(6)}
        missingLabel={sectionMissingLabel(6)}
        ar="الصور"
        en="Images"
        count={rel.images.length}
        summary={rel.images.length === 0 ? 'لا صور' : `${rel.images.length} صورة · رئيسية محددة`}
        error={showErrors && !!errors.images}
        {...section(6)}
      >
        <MissingBlock codes={['IMAGE']} />
        <MainImagesPair
          darkUrl={(rel.images.find((i) => i.is_primary) ?? rel.images[0])?.url ?? ''}
          lightUrl={doc.light_image ?? ''}
          onLightChange={(url) => setDoc((d) => ({ ...d, light_image: url }))}
        />
        <ImagesSection rel={rel} setRel={setRel} errors={showErrors ? errors : {}} />
      </SectionCard>

      {/* 7 ── template specs (responsive to the section & branch — a Bambu
             A1 asks printer questions, a filament asks material questions,
             an accessory its own) + the structured usage/setup guide. */}
      <SectionCard
        n={7}
        missing={sectionMissing(7)}
        missingLabel={sectionMissingLabel(7)}
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
          doc.printer_fit_ids.length ? `يناسب ${doc.printer_fit_ids.length} ${doc.printer_fit_ids.length === 1 ? 'طابعة' : 'طابعات'}` : undefined,
          doc.usage_guide.steps.length ? `${doc.usage_guide.steps.length} خطوة دليل` : undefined,
          preserved.length > 0 ? preserved.map((g) => `${g.count} ${g.label}`).join(' · ') : undefined,
        ])}
        {...section(7)}
      >
        {/* «يناسب الطابعات» (0148) — for a part or an accessory, which is what
            the owner links to a printer; shown for any product that already
            carries links, so a stored link is never hidden by a section change. */}
        {sectionType === 'parts' || sectionType === 'accessory' || doc.printer_fit_ids.length > 0 ? (
          <PrinterFitsSection
            value={doc.printer_fit_ids}
            productId={doc.id}
            onChange={(next) => setDoc((d) => ({ ...d, printer_fit_ids: next }))}
          />
        ) : null}
        {tplGroups.length === 0 && (
          <p className="text-[12px] text-text-muted mb-3">
            حقول المواصفات تتبع القسم والقالب. اختر القسم الرئيسي في القسم رقم 1 لتظهر هنا.
            {storedSpecCount > 0 ? ' المواصفات المحفوظة معروضة أدناه حتى بلا قالب.' : ''}
          </p>
        )}
        {tplGroups.length > 0 && (
          <div className="space-y-4 mb-4">
            {tplGroups.map((g) => (
              <div key={g.id} className="min-w-0">
                <h4 className="text-[13px] font-bold text-text-secondary mb-2 truncate">
                  {g.label_ar} <span className="text-[11px] font-medium text-text-muted">{g.label_en}</span>
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
                      {f.multiple && f.options?.length ? (
                        <SpecMultiPick
                          id={f.id}
                          label={f.label_ar}
                          options={f.options}
                          value={doc.spec_fields?.[f.id] ?? ''}
                          onChange={(next) =>
                            setDoc((d) => ({ ...d, spec_fields: { ...d.spec_fields, [f.id]: next } }))
                          }
                        />
                      ) : f.type === 'select' ? (
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
            <h4 className="text-[13px] font-bold text-text-secondary mb-2 truncate">
              مواصفات محفوظة خارج قالب هذا القسم{' '}
              <span className="text-[11px] font-medium text-text-muted">Stored spec fields outside the section template</span>
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
          <div className="min-w-0 mb-4 rounded-lg bg-surface-raised p-2.5" data-form="preserved-groups">
            <h4 className="text-[12px] font-bold text-text-secondary mb-1.5">
              محتوى محفوظ يُعدَّل عبر القالب النصي{' '}
              <span className="text-[11px] font-medium text-text-muted">Preserved — edit via the TXT template</span>
            </h4>
            {preserved.map((g) => (
              <div key={g.key} className="text-[11px] text-text-secondary mb-1.5 min-w-0" data-preserved={g.key}>
                <span className="text-text-primary font-bold">
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
        summary={dirty || v2.touched ? v2s.unsaved : v2s.saved}
        {...section(8)}
      >
        <div className="space-y-2 text-[12px] text-text-secondary min-w-0">
          <Row k="الاسم" v={doc.name_en || '—'} />
          <Row k="القسم" v={catalogs.find((c) => c.id === doc.category_id)?.name_en ?? '—'} />
          {/* «السعر» is the lowest final price of the table (the server's), never a typed field. */}
          <Row k={v2s.price} v={lowest !== null ? v2s.from(iqdText(lowest)) : v2.hidden ? v2s.chipHidden : '—'} />
          <Row k="أنواع البيع" v={doc.sale_types.join(' + ')} />
          <Row k="مصدر المخزون" v={rel.inventory_mode} />
          <Row k="الخيارات / الألوان" v={`${valueCount} / ${rel.colors.length}`} />
          <Row k="الصور" v={String(rel.images.length)} />
        </div>
        {previewOpen && (
          <div className="lv-well mt-3 rounded-md p-3 min-w-0">
            <pre className="text-[11px] text-text-secondary overflow-x-auto" dir="ltr">
              {JSON.stringify(withoutLegacyMoney({ doc: { ...doc, spec_fields: doc.spec_fields }, relations: relationsToWire(rel), pricing_v2: v2.wire }), null, 2)}
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
        {/* A product no customer sees yet has no checkout price to preview (the clean start). */}
        {doc.id && !v2.hidden && (
          <div className="mt-3">
            <PricePreview productId={doc.id} savedDoc={doc} rel={rel} dirty={dirty || v2.touched} savedRevision={baseline} />
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
        className="sticky bottom-0 z-10 -mx-3 border-t border-border-subtle bg-surface-raised pb-[env(safe-area-inset-bottom)] shadow-dock"
      >
        <div className="min-w-0 px-3 py-2 flex items-center gap-2">
          <span className="min-w-0 flex-1 text-[11px] truncate">
            {saving && saveProgress ? (
              <span className="text-amber-300" role="status" data-save-progress>
                {saveProgress}
              </span>
            ) : showErrors && errorList.length > 0 ? (
              <span className="text-red-400 inline-flex items-center gap-1">
                <AlertTriangle className="w-3.5 h-3.5 shrink-0" />
                {errorList[0]}
                {errorList.length > 1 && ` (+${errorList.length - 1})`}
              </span>
            ) : saveErr ? (
              // The product's save failed: the pricing was not sent either.
              <span className="text-red-400 inline-flex items-center gap-1" title={saveErr} data-pricing-status="product-error">
                <AlertTriangle className="w-3.5 h-3.5 shrink-0" />
                {saveErr}
              </span>
            ) : v2.review ? (
              // The review sheet is open: nothing is saved until it is confirmed.
              <span className="text-amber-300" data-pricing-status="review">
                {v2s.chipReview(String((v2.review.preview.changes ?? []).length))}
              </span>
            ) : dirty || v2.touched ? (
              <span className="text-amber-300" data-pricing-status={v2.touched ? 'unsaved' : undefined}>
                {v2s.unsaved}
              </span>
            ) : stockMissing ? (
              // The price of an imported product waits for its stock mode (§B.10): said before the refusal is met,
              // with the way to the card. «نشر» stays: a content save of the visible, unpriced product sends no
              // price (`isContentOnlySave`) and lands, where «مسودة» would take it off the storefront.
              <button
                type="button"
                className="text-amber-300 underline underline-offset-2 text-start"
                title={refusalText('IMPORT_STOCK_NOT_CONFIGURED', v2Lang)}
                data-pricing-status="import-stock"
                data-action="import-stock"
                onClick={showImportStock}
              >
                {refusalText('IMPORT_STOCK_NOT_CONFIGURED', v2Lang)}
              </button>
            ) : (
              <span className="text-emerald-300 inline-flex items-center gap-1" data-pricing-status="saved">
                <Check className="w-3.5 h-3.5 shrink-0" /> {fileUpdateNote ?? v2s.saved}
              </span>
            )}
          </span>
          {productId && (
            <button
              type="button"
              data-action="update-data"
              className={`${btnGhost} h-10`}
              disabled={saving}
              onClick={() => setSectionUpdateOpen(true)}
              aria-haspopup="dialog"
              title={pickDataFileString(DATA_FILE_STRINGS.updateDataTitle, lang)}
            >
              <FileUp className="w-4 h-4" /> {pickDataFileString(DATA_FILE_STRINGS.title, lang)}
            </button>
          )}
          <button
            type="button"
            data-action="save-draft"
            className={`${btnGhost} h-10`}
            disabled={saving}
            onClick={() => void save('draft')}
          >
            {v2s.draft}
          </button>
          <button
            type="button"
            data-action="save"
            className={`${btnPrimary} h-10`}
            disabled={saving}
            onClick={() => void save('active')}
          >
            {saving ? <RefreshCw className="w-4 h-4 animate-spin" /> : <Save className="w-4 h-4" />} {v2s.publish}
          </button>
        </div>
      </div>

      {/* THE ONE REVIEW SHEET (spec §5.6), at the form's ROOT: seen whichever section is open. Its cancel
          keeps every typed value; its confirm resends the same save with the preview's hash and tick. */}
      {v2.review && (
        <ReviewSheetV2
          key={v2.review.preview.review_hash ?? 'review'}
          preview={v2.review.preview}
          busy={saving}
          error={v2.review.error}
          progress={saveProgress}
          reauth={v2.review.reauth}
          onConfirm={confirmReview}
          onCancel={v2.closeReview}
          onSignIn={() => void signInAgain()}
        />
      )}

      {sectionUpdateOpen && productId && (
        <React.Suspense fallback={null}>
          <DataFileSheet
            productId={productId}
            formDirty={dirty}
            onClose={() => setSectionUpdateOpen(false)}
            onApplied={(note) => {
              setFileUpdateNote(note);
              void reloadKeepingEdits(productId);
            }}
          />
        </React.Suspense>
      )}
    </div>
    </CompletenessProvider>
    </V2PricingProvider>
  );
}

function Row({ k, v }: { k: string; v: string }) {
  return (
    <div className="flex items-center justify-between gap-3 min-w-0 border-b border-border-subtle pb-1.5">
      <span className="text-text-muted shrink-0">{k}</span>
      <span className="text-text-primary truncate min-w-0 text-end" dir="ltr">
        {v}
      </span>
    </div>
  );
}
