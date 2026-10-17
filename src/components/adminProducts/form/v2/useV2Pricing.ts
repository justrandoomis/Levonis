/**
 * PRICING V2 IN THE PRODUCT FORM — ITS STATE (implementation spec §5.2
 * `useV2Pricing.ts`, §5.6 and the addendum of 2026-10-14; docs/PRICING-V2.md
 * §2.6, §2.7; DECISIONS row 222).
 *
 * One state for sections ٣ and ٥ and the review sheet, for EVERY ordinary
 * product (the clean start: there is no old dinar form left):
 *   - the stored V2 answer (`GET /api/admin/products-v2/:id/pricing`) — for a
 *     product with no method yet (`needs_pricing`) the server's PREFILL, never
 *     an old price — and the reader's draft over it: dollars for the owner and
 *     the price editors alike (Q2), the cost inputs for the owner alone;
 *   - a debounced (400 ms) `POST /api/admin/products-v2/pricing/preview` of
 *     the draft and of the structure the form holds (a model added, a route
 *     switched on), aborted on each new keystroke: add-product is priced
 *     before its first save under the id the save persists;
 *   - `saveBlock()` — the product save's `pricing_v2` block (the draft, the
 *     preview's hash, the 15% tick), or null when the save is today's save;
 *   - the review sheet: opened by a 409 carrying `details.preview`; its
 *     cancel closes it and keeps every typed value.
 *
 * NO PRICING MATHS RUNS IN THE BROWSER: every price shown is the server's.
 */
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { api, ApiError } from '../../../../lib/api';
import type { ProductDimensionsV2 } from '../../../../lib/productTypes';
import { dollarsOf, draftOf, draftWire, measurePendingOf, withOptionMeasure, withPackageMeasure, wireIsEmpty, type PriceDraft, type V2Answer, type V2DraftWire, type V2LiveIds } from './v2Model';

export interface V2FormInput {
  /** The form edits an ordinary product (a bundle is never V2-priced). */
  enabled: boolean;
  /** The stored product's id; null on add-product. */
  productId: string | null;
  /** The id the add-product save persists (the preview prices the draft under it). */
  draftId: string;
  /** The session may read cost (a hint until the server's answer says who reads what). */
  ownerHint: boolean;
  /** The document and relations the save would post now. */
  structureOf: () => { doc: Record<string, unknown>; relations: Record<string, unknown> };
  /** Changes whenever a priced part of the structure changes (models, colours, routes, sale types). */
  structureKey: string;
  /** The structure differs from what is stored (a stored product's preview then sends it). */
  structureDirty: boolean;
  /** The live options, models and colours of the form (the sellable SKUs are the server's table's). */
  live: Omit<V2LiveIds, 'skus'>;
  /** «الأبعاد والوزن»: fills an empty pricing measure of a cost-first product. */
  packageDims: ProductDimensionsV2 | null;
  /** Each model's own «أبعاد الخيار» (by option value id): an own-cost model's weight and box ARE its packaged ones (row 247). */
  optionPackages: Readonly<Record<string, ProductDimensionsV2 | null | undefined>>;
  /** The same as last SAVED (the form's baseline): tells a pricing mirror of them from a pricing-only value. */
  savedOptionPackages?: Readonly<Record<string, ProductDimensionsV2 | null | undefined>>;
}

export interface V2Review {
  preview: V2Answer;
  status: 'draft' | 'active';
  error: string;
  reauth: boolean;
}

export interface V2PricingState {
  /** 'stored' (an existing product) or 'new' (add-product); null when the form prices nothing. */
  mode: 'stored' | 'new' | null;
  /** The server says this reader is the owner (or, before any answer, the session's hint). */
  owner: boolean;
  /** The reader may type dollars here (the owner; an editor on a price-first product). */
  money: boolean;
  /** The product has no method yet (add-product, or the clean start): the save states one. */
  needsMethod: boolean;
  /** No customer sees the product yet (no complete V2 write). */
  hidden: boolean;
  /** The last answer shown: the stored one, or the preview of the draft. */
  answer: V2Answer | null;
  stored: V2Answer | null;
  loading: boolean;
  previewing: boolean;
  error: string;
  draft: PriceDraft | null;
  setDraft: (fn: (d: PriceDraft) => PriceDraft) => void;
  /** What the save sends as `pricing`. */
  wire: V2DraftWire;
  /** The reader typed something not saved yet — or the preview prices a measure only a save writes. */
  touched: boolean;
  /** Own-cost models priced on the option's dimensions that the pricing row does not hold yet (row 247). */
  measurePending: ReadonlySet<string>;
  /** The draft as stored (before any edit or fill): what a «kept» choice shows. */
  storedDraft: PriceDraft | null;
  /** The answer on screen prices the draft (not the stored product). */
  drafting: boolean;
  discard: () => void;
  reload: () => void;
  /**
   * The product save's `pricing_v2` block, or null for today's save (a product
   * with no method, nothing typed, kept a draft). `confirm` is the review
   * sheet's answer: its hash and the 15% tick.
   */
  saveBlock: (status: 'draft' | 'active', confirm?: { hash: string; confirmLarge: boolean }) => Record<string, unknown> | null;
  /** After a save: the stored answer is read again and the draft starts over from it. */
  afterSave: () => void;
  review: V2Review | null;
  /** §2.1 rule 2 (the owner's): what the product's minimum profit inherits when its own field is empty. */
  inheritedMinimumProfit?: { amount_usd: string | null; amount_iqd: number | null } | null;
  openReview: (preview: V2Answer, status: 'draft' | 'active') => void;
  reviewError: (error: string, reauth?: boolean) => void;
  closeReview: () => void;
  /** «طبّق على الألوان المحددة»: the colours ticked in section ٥. */
  selectedColours: ReadonlySet<string>;
  toggleColour: (id: string) => void;
  clearColours: () => void;
}

const V2Context = createContext<V2PricingState | null>(null);
export const V2PricingProvider = V2Context.Provider;
export const useV2 = (): V2PricingState | null => useContext(V2Context);

/** No saved option dimensions (add-product, or before the first load). */
const NO_PACKAGES: Readonly<Record<string, ProductDimensionsV2 | null | undefined>> = {};
const failure = (e: unknown): string => (e instanceof ApiError ? e.message : e instanceof Error ? e.message : String(e));

export function useV2Pricing(input: V2FormInput): V2PricingState {
  const { enabled, productId, draftId, ownerHint, structureOf, structureKey, structureDirty, live, packageDims, optionPackages } = input;
  const savedOptionPackages = input.savedOptionPackages ?? NO_PACKAGES;
  const mode: V2PricingState['mode'] = !enabled ? null : productId ? 'stored' : 'new';
  const [stored, setStored] = useState<V2Answer | null>(null);
  const [answer, setAnswer] = useState<V2Answer | null>(null);
  const [loading, setLoading] = useState(false);
  const [previewing, setPreviewing] = useState(false);
  const [error, setError] = useState('');
  const [base, setBase] = useState<PriceDraft | null>(null);
  const [draft, setDraftState] = useState<PriceDraft | null>(null);
  const [review, setReview] = useState<V2Review | null>(null);
  const [selectedColours, setSelectedColours] = useState<ReadonlySet<string>>(() => new Set());
  const [generation, setGeneration] = useState(0);
  const loadedFor = useRef<string | null>(null);

  const shown = answer ?? stored;
  const owner = shown?.can_edit?.cost ?? ownerHint;
  // A cost-first product's prices are the owner's (PRICING_V2_OWNER_ONLY): an editor types nothing there.
  const money = shown ? shown.can_edit.money : mode === 'new' ? true : ownerHint;
  const needsMethod = mode === 'new' || (mode === 'stored' && !!stored && !stored.v2);
  const hidden = mode === 'new' || !!stored?.needs_pricing;

  /** Start the draft over from an answer (null: add-product). */
  const adopt = useCallback(
    (a: V2Answer | null) => {
      // Add-product: the owner starts from cost (the engine's chain), a price editor from the dollar price (Q9).
      const d = draftOf(a, a ? 'cost' : ownerHint ? 'cost' : 'usd');
      setBase(d);
      setDraftState(d);
    },
    [ownerHint]
  );

  // The stored answer of an existing product (and again after every save).
  useEffect(() => {
    if (mode !== 'stored' || !productId) return;
    const key = `${productId}#${generation}`;
    if (loadedFor.current === key) return;
    loadedFor.current = key;
    let alive = true;
    setLoading(true);
    setError('');
    api
      .get<V2Answer>(`/api/admin/products-v2/${encodeURIComponent(productId)}/pricing`, { mascot: 'silent' })
      .then((a) => {
        if (!alive) return;
        setStored(a);
        setAnswer(a);
        adopt(a);
      })
      .catch((e) => {
        if (alive) setError(failure(e));
      })
      .finally(() => {
        if (alive) setLoading(false);
      });
    return () => {
      alive = false;
    };
  }, [mode, productId, generation, adopt]);

  // Add-product: nothing stored.
  useEffect(() => {
    if (mode !== 'new') return;
    if (loadedFor.current === `new#${draftId}`) return;
    loadedFor.current = `new#${draftId}`;
    setStored(null);
    setAnswer(null);
    adopt(null);
  }, [mode, draftId, adopt]);

  // The pricing measure falls back to the package measure (cost-first, an empty pricing measure only), and an
  // own-cost model's weight and box ARE its option's packaged ones (row 247: the pricing row mirrors them).
  // Applied to the stored draft too, so the fill alone is not «typed» — it still travels with the save.
  const withDims = useCallback(
    (d: PriceDraft | null) =>
      d && d.method === 'cost' && owner
        ? { ...d, cost: withPackageMeasure(d.cost, packageDims), models: withOptionMeasure(d.models, optionPackages, savedOptionPackages) }
        : d,
    [owner, packageDims, optionPackages, savedOptionPackages]
  );
  const draftShown = useMemo(() => withDims(draft), [withDims, draft]);
  const baseShown = useMemo(() => withDims(base), [withDims, base]);

  const opts = useMemo(() => ({ needsMethod, cost: owner, money }), [needsMethod, owner, money]);
  // The sellable SKUs are the server's: the table of the answer on screen (the draft's structure once previewed).
  const skuKey = (shown?.table ?? []).map((r) => r.combo_key).join('|');
  const liveIds = useMemo<V2LiveIds>(() => ({ ...live, skus: new Set(skuKey.split('|').filter(Boolean)) }), [live, skuKey]);
  const storedDollars = useMemo(() => dollarsOf(stored), [stored]);
  const wire = useMemo<V2DraftWire>(() => {
    if (!mode || !base || !draftShown) return {};
    return draftWire(base, draftShown, storedDollars, liveIds, opts);
  }, [mode, base, draftShown, storedDollars, liveIds, opts]);
  const wireKey = JSON.stringify(wire);
  // The option's measure the preview prices on but the pricing row does not hold yet: unsaved until a save
  // writes it (row 247) — the leave warning and «تعديلات غير محفوظة» say so, and the model card notes it.
  const measurePending = useMemo(() => (mode && owner ? measurePendingOf(base, draftShown) : new Set<string>()), [mode, owner, base, draftShown]);
  const typed = useMemo(() => {
    if (!mode || !baseShown || !draftShown) return false;
    const w = draftWire(baseShown, draftShown, storedDollars, liveIds, { ...opts, needsMethod: false });
    return !wireIsEmpty(w) || (needsMethod && draftShown.method !== baseShown.method);
  }, [mode, baseShown, draftShown, storedDollars, liveIds, opts, needsMethod]);

  // A product with no method yet always names one (the server refuses a preview or a save that does not).
  const withMethod = useCallback(
    (w: V2DraftWire): V2DraftWire => (needsMethod && !w.method && draftShown ? { ...w, method: owner ? draftShown.method : 'usd' } : w),
    [needsMethod, draftShown, owner]
  );

  // The preview: the draft and the structure, 400 ms after the last change, the previous request aborted.
  const needsPreview = mode === 'new' || (mode === 'stored' && (!wireIsEmpty(wire) || structureDirty));
  const previewKey = needsPreview ? `${mode}|${wireKey}|${mode === 'new' || structureDirty ? structureKey : ''}` : '';
  const structureRef = useRef(structureOf);
  structureRef.current = structureOf;
  useEffect(() => {
    if (!previewKey) {
      // Nothing drafted: the stored answer is what is shown.
      if (mode === 'stored') setAnswer(stored);
      setPreviewing(false);
      return;
    }
    if (mode === 'stored' && !stored) return;
    const controller = new AbortController();
    const timer = window.setTimeout(() => {
      setPreviewing(true);
      const pricing = withMethod(wire);
      const body: Record<string, unknown> = {
        product_id: mode === 'stored' ? productId : null,
        ...(mode === 'new' || structureDirty ? { structure: draftStructure(structureRef.current(), mode === 'new' ? draftId : null) } : {}),
        ...(wireIsEmpty(pricing) ? {} : { pricing }),
      };
      api
        .post<V2Answer>('/api/admin/products-v2/pricing/preview', body, { signal: controller.signal, mascot: 'silent' })
        .then((a) => {
          setAnswer(a);
          setError('');
        })
        .catch((e) => {
          if (e instanceof ApiError && e.code === 'ABORTED') return;
          setError(failure(e));
        })
        .finally(() => {
          if (!controller.signal.aborted) setPreviewing(false);
        });
    }, 400);
    return () => {
      window.clearTimeout(timer);
      controller.abort();
    };
    // `wire` is in `previewKey` (as its JSON), the structure through its key.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [previewKey, stored]);

  const discard = useCallback(() => {
    setDraftState(base);
    setAnswer(stored);
    setError('');
  }, [base, stored]);

  const reload = useCallback(() => setGeneration((g) => g + 1), []);

  const saveBlock = useCallback(
    (status: 'draft' | 'active', confirm?: { hash: string; confirmLarge: boolean }): Record<string, unknown> | null => {
      if (!mode) return null;
      // A product with no method yet, nothing typed, kept a draft: today's save (its method is chosen when it is priced).
      if (mode === 'stored' && needsMethod && !typed && status !== 'active' && !confirm) return null;
      const pricing = withMethod(wire);
      const block: Record<string, unknown> = {};
      if (!wireIsEmpty(pricing)) block.pricing = pricing;
      const hash = saveHashOf(shown, confirm);
      if (hash) block.preview_hash = hash;
      if (confirm?.confirmLarge) block.confirm_large_change = true;
      return block;
    },
    [mode, needsMethod, typed, wire, withMethod, shown]
  );

  const afterSave = useCallback(() => {
    setReview(null);
    setSelectedColours(new Set());
    // The stored answer is read again (the GET effect) and the draft starts from it.
    setGeneration((g) => g + 1);
  }, []);

  const openReview = useCallback((preview: V2Answer, status: 'draft' | 'active') => {
    setAnswer(preview);
    setReview({ preview, status, error: '', reauth: false });
  }, []);
  const reviewError = useCallback((message: string, reauth = false) => setReview((r) => (r ? { ...r, error: message, reauth } : r)), []);
  const closeReview = useCallback(() => setReview(null), []);
  const toggleColour = useCallback(
    (id: string) =>
      setSelectedColours((s) => {
        const next = new Set(s);
        if (next.has(id)) next.delete(id);
        else next.add(id);
        return next;
      }),
    []
  );
  const clearColours = useCallback(() => setSelectedColours(new Set()), []);
  const setDraft = useCallback((fn: (d: PriceDraft) => PriceDraft) => setDraftState((d) => (d ? fn(d) : d)), []);

  return {
    mode,
    owner,
    money,
    needsMethod,
    hidden,
    answer: shown,
    stored,
    loading,
    previewing,
    error,
    draft: draftShown,
    setDraft,
    wire,
    touched: typed || measurePending.size > 0,
    measurePending,
    storedDraft: base,
    drafting: !!previewKey && shown !== stored,
    discard,
    reload,
    saveBlock,
    afterSave,
    review,
    inheritedMinimumProfit: shown?.v2_cost_inputs?.inherited_minimum_profit ?? null,
    openReview,
    reviewError,
    closeReview,
    selectedColours,
    toggleColour,
    clearColours,
  };
}

/**
 * The structure a preview prices: the form's document and relations, under the
 * add-product id (the save persists it). A preview writes nothing, and the name
 * plays no part in a price, so a product not yet named is priced under a
 * placeholder name rather than refused.
 */
/**
 * The hash a save carries (§2.6, A.8: no path publishes a price change without the review sheet). The sheet's
 * own confirm carries its hash. Without it, the preview on screen sends its hash only when NO customer price
 * moves; a save that moves a price goes without one, the server answers PRICING_PREVIEW_REQUIRED with its own
 * preview, and the form opens the one review sheet on it.
 */
export function saveHashOf(shown: Pick<V2Answer, 'review_hash' | 'changes'> | null | undefined, confirm?: { hash: string } | null): string | null {
  if (confirm?.hash) return confirm.hash;
  if (!shown?.review_hash) return null;
  return (shown.changes?.length ?? 0) > 0 ? null : shown.review_hash;
}

export function draftStructure(
  s: { doc: Record<string, unknown>; relations: Record<string, unknown> },
  draftId: string | null
): { doc: Record<string, unknown>; relations: Record<string, unknown> } {
  const doc: Record<string, unknown> = { ...s.doc };
  if (draftId) doc.id = draftId;
  const named = [doc.name_en, doc.name_ar].some((n) => typeof n === 'string' && n.trim() !== '');
  if (!named) doc.name_en = 'Draft';
  if (typeof doc.price_iqd !== 'number' || !Number.isInteger(doc.price_iqd) || doc.price_iqd < 0) doc.price_iqd = 0;
  return { doc, relations: s.relations };
}
