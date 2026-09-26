/**
 * QUICK EDIT — the whole price table of one product, editable in place.
 *
 * The owner's measure of success is time: changing a cost, a price, or a
 * model's availability should take seconds and should not require opening the
 * full product form. The price grid remains focused on its four price columns;
 * the compact panel above it mirrors the option fulfilment and direct-stock
 * controls from the full editor.
 *
 * WHAT MAKES IT FAST, and why each piece is the way it is:
 *
 *  - ONE GRID, NOT A FORM PER ROW. Every option (which is one model on one
 *    fulfilment route) and every colour is a row; the four fields are columns.
 *    An admin comparing "A1 pre-order" against "A1 Combo direct" reads across,
 *    not through three screens.
 *
 *  - THE KEYBOARD IS THE INTERFACE. Tab walks the cells, Enter saves every
 *    pending change at once, Escape throws them away. Nothing needs the mouse.
 *
 *  - EVERY CELL SAYS WHERE ITS NUMBER COMES FROM. `inherit` shows the parent's
 *    price as a placeholder, `+60,000` shows an adjustment that will follow the
 *    base price, and a typed number is a pin that will not. That distinction is
 *    the entire difference between a price change that reaches the customer and
 *    one that silently does not.
 *
 *  - ONLY WHAT CHANGED IS SENT. The save posts the dirty cells; the server
 *    writes those columns and no others, and answers with the rebuilt grid.
 *
 *  - THE PROFIT IS ALWAYS VISIBLE, and a price under the cost (or under the
 *    configured margin floor) asks for a confirmation instead of silently
 *    saving or flatly refusing.
 *
 * On a phone the same rows render as cards, because a four-column table on a
 * 390px screen is a horizontal scroll bar with prices hidden inside it.
 */
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AlertTriangle, ArrowLeftRight, Check, History, Loader2, RotateCcw, Percent, X } from 'lucide-react';
import { api, ApiError, formatIqd } from '../../lib/api';
import { useLanguage } from '../../LanguageContext';
import * as T from './theme';
import { Field as FormField, Money, Qty, Toggle } from './form/formUi';
import {
  combinationKey,
  directStockCombinations,
  deriveInventoryMode,
  emptyFulfillment,
  relationsFromWire,
  relationsToWire,
  withBlankDirectStockAsZero,
  type FormFulfillment,
  type FormTransport,
  type FormVariant,
  type FormValue,
  type RelationsResponse,
  type RelationsState,
} from './form/model';

// ------------------------------------------------------------------- types

type Field = 'regular' | 'prime' | 'pro' | 'cost';
type Mode = 'inherit' | 'adjust' | 'fixed';
type Level = 'product' | 'option' | 'color';

interface Cell {
  mode: Mode;
  value: number | null;
  adjust: number | null;
  effective: number | null;
  inherited: number | null;
}

interface Row {
  level: Level;
  id: string;
  label_ar: string;
  label_en: string;
  active: boolean;
  variant_key: string;
  variant_label: string;
  availability_type: '' | 'direct_sale' | 'pre_order';
  option_id: string;
  hex: string;
  stock: number | null;
  cells: Partial<Record<Field, Cell>>;
  /** What each tier is CHARGED — see `rowCharges`. Optional so a response from
   *  a worker deployed before this field existed degrades to the raw ladder
   *  value rather than crashing the panel. */
  charges?: Partial<Record<Field, { charged: number | null; viaRegular: boolean }>>;
  profit: { cost_iqd: number | null; price_iqd: number | null; profit_iqd: number | null; margin_percent: number | null };
}

interface Guard {
  code: 'BELOW_COST' | 'THIN_MARGIN';
  where: string;
  field: Field;
  price_iqd: number;
  cost_iqd: number;
  margin_percent: number | null;
  min_margin_percent: number | null;
}

interface Change {
  level: Level;
  id: string;
  label_ar: string;
  label_en: string;
  field: Field;
  from_mode: Mode;
  to_mode: Mode;
  from_iqd: number | null;
  to_iqd: number | null;
}

interface Preview {
  changes: Change[];
  guards: Guard[];
  skipped: Array<{ level: Level; id: string; field: Field; reason: string }>;
  unmatched?: Array<{ id: string; label_ar: string; label_en: string }>;
}

interface GridResponse {
  product: { id: string; name_ar: string; name_en: string; sale_types: string[]; store: string };
  rows: Row[];
  variants: Array<{ key: string; label: string }>;
  availability: Array<'direct_sale' | 'pre_order'>;
  min_margin_percent: number | null;
  can_view_cost: boolean;
}

interface SaveResponse {
  changed: number;
  batch_id: string;
  rows: Row[];
  guards?: Guard[];
}

/** What PATCH /price-grid/traits answers. `undo` is the exact inverse batch. */
interface TraitPatch {
  level: 'option' | 'color';
  id: string;
  field: 'availability_type' | 'stock' | 'active';
  value: unknown;
}

interface TraitsResponse {
  changed: number;
  rows: Row[];
  undo: TraitPatch[];
  sale_types: string[];
  sale_types_changed?: boolean;
}

// ------------------------------------------------------------------ strings

const STRINGS = {
  ar: {
    title: 'تعديل سريع للأسعار',
    loading: 'جارٍ التحميل…',
    base: 'السعر الأساسي',
    option: 'خيار',
    color: 'لون',
    regular: 'السعر',
    prime: 'بريميوم',
    pro: 'PRO',
    cost: 'التكلفة',
    profit: 'الربح',
    margin: 'الهامش',
    inherit: 'موروث',
    adjust: 'فرق',
    fixed: 'ثابت',
    inheritHint: 'يتبع الأعلى',
    // The in-field «= / +» prefix explains itself on hover and to a screen
    // reader; the glyph alone is the visual, per the one-cue rule.
    required: 'مطلوب',
    fixedHint: 'رقم ثابت — اضغط ليصبح فرقًا عن الأعلى',
    adjustHint: 'فرق عن الأعلى — اضغط ليصبح رقمًا ثابتًا',
    save: 'حفظ',
    saving: 'جارٍ الحفظ…',
    cancel: 'تراجع عن التعديلات',
    pending: (n: number) => `${n} تعديل غير محفوظ`,
    saved: (n: number) => `تم حفظ ${n} تعديل`,
    heldByOrders: (n: number) => `بقيت ${n} قطعة محجوزة لطلبات قائمة، والمتاح للبيع الآن صفر`,
    nothing: 'لا يوجد تغيير',
    undo: 'تراجع عن آخر حفظ',
    undone: 'تم التراجع',
    directSale: 'بيع مباشر',
    preOrder: 'طلب مسبق',
    inactive: 'موقوف',
    guardTitle: 'تأكيد مطلوب',
    belowCost: 'السعر أقل من التكلفة',
    thinMargin: 'الهامش أقل من الحد الأدنى',
    confirmSave: 'أفهم — احفظ على أي حال',
    dismiss: 'إلغاء',
    bulk: 'تغيير جماعي',
    copy: 'نسخ الأسعار',
    history: 'سجل الأسعار',
    grid: 'الشبكة',
    op: 'العملية',
    opAdd: 'زيادة مبلغ',
    opSubtract: 'خصم مبلغ',
    opAddPercent: 'زيادة نسبة %',
    opSubtractPercent: 'خصم نسبة %',
    opSet: 'تعيين سعر',
    opInherit: 'إرجاع للتوريث',
    opAdjust: 'جعله فرقًا عن الأساس',
    fields: 'الحقول',
    scope: 'النطاق',
    scopeAll: 'كل المنتج',
    levels: 'المستوى',
    lvlProduct: 'الأساسي',
    lvlOption: 'الخيارات',
    lvlColor: 'الألوان',
    anyAvailability: 'كل أنواع التوفر',
    anyVariant: 'كل النسخ',
    selectedOnly: 'المحدد فقط',
    amount: 'المبلغ',
    percent: 'النسبة %',
    preview: 'معاينة',
    apply: 'تطبيق',
    previewFirst: 'اعرض المعاينة قبل التطبيق',
    noChanges: 'لن يتغيّر شيء بهذا النطاق',
    willChange: (n: number) => `${n} خانة ستتغيّر`,
    skipped: (n: number) => `${n} خانة لن تتغيّر`,
    from: 'من',
    to: 'إلى',
    copyFrom: 'انسخ من',
    copyTo: 'إلى',
    unmatched: 'بدون مقابل — لم يُنسخ',
    changedAt: 'التاريخ',
    changedBy: 'بواسطة',
    where: 'الموضع',
    field: 'الحقل',
    noHistory: 'لا يوجد سجل بعد',
    shorthandHint: '950K أو 1.25M مقبولة',
    costHidden: 'التكلفة غير متاحة لحسابك',
    stock: 'المخزون',
    route: 'طريقة البيع',
    followProduct: 'يتبع المنتج',
    activeOn: 'مفعّل',
    activeOff: 'موقوف',
    stockUntracked: 'غير محسوب',
    saleTypesDerived: (types: string) => `تم تحديث نوع البيع للمنتج: ${types}`,
    mixedSale: 'مختلط (مباشر + مسبق)',
  },
  en: {
    title: 'Quick price edit',
    loading: 'Loading…',
    base: 'Base price',
    option: 'Option',
    color: 'Colour',
    regular: 'Price',
    prime: 'PRIME',
    pro: 'PRO',
    cost: 'Cost',
    profit: 'Profit',
    margin: 'Margin',
    inherit: 'Inherit',
    adjust: 'Adjust',
    fixed: 'Fixed',
    inheritHint: 'follows the level above',
    required: 'required',
    fixedHint: 'A fixed number — tap to make it a difference',
    adjustHint: 'A difference from the level above — tap to make it fixed',
    save: 'Save',
    saving: 'Saving…',
    cancel: 'Discard changes',
    pending: (n: number) => `${n} unsaved change${n === 1 ? '' : 's'}`,
    saved: (n: number) => `Saved ${n} change${n === 1 ? '' : 's'}`,
    heldByOrders: (n: number) => `${n} unit(s) stay held for live orders; nothing more is on sale`,
    nothing: 'Nothing changed',
    undo: 'Undo the last save',
    undone: 'Undone',
    directSale: 'Direct sale',
    preOrder: 'Pre-order',
    inactive: 'Inactive',
    guardTitle: 'Confirmation needed',
    belowCost: 'The price is below the cost',
    thinMargin: 'The margin is below the floor',
    confirmSave: 'I understand — save anyway',
    dismiss: 'Cancel',
    bulk: 'Bulk change',
    copy: 'Copy prices',
    history: 'Price history',
    grid: 'Grid',
    op: 'Operation',
    opAdd: 'Add an amount',
    opSubtract: 'Subtract an amount',
    opAddPercent: 'Add a percentage',
    opSubtractPercent: 'Subtract a percentage',
    opSet: 'Set a price',
    opInherit: 'Back to inherit',
    opAdjust: 'Make it a difference from the base',
    fields: 'Fields',
    scope: 'Scope',
    scopeAll: 'The whole product',
    levels: 'Level',
    lvlProduct: 'Base',
    lvlOption: 'Options',
    lvlColor: 'Colours',
    anyAvailability: 'Every availability',
    anyVariant: 'Every version',
    selectedOnly: 'Selected rows only',
    amount: 'Amount',
    percent: 'Percent',
    preview: 'Preview',
    apply: 'Apply',
    previewFirst: 'Preview before applying',
    noChanges: 'Nothing would change in this scope',
    willChange: (n: number) => `${n} cell${n === 1 ? '' : 's'} would change`,
    skipped: (n: number) => `${n} cell${n === 1 ? '' : 's'} left alone`,
    from: 'from',
    to: 'to',
    copyFrom: 'Copy from',
    copyTo: 'onto',
    unmatched: 'No counterpart — not copied',
    changedAt: 'When',
    changedBy: 'By',
    where: 'Where',
    field: 'Field',
    noHistory: 'No history yet',
    shorthandHint: '950K and 1.25M are accepted',
    costHidden: 'Cost is not available to your account',
    stock: 'Stock',
    route: 'Sold as',
    followProduct: 'Follow the product',
    activeOn: 'Active',
    activeOff: 'Off',
    stockUntracked: 'Untracked',
    saleTypesDerived: (types: string) => `The product's selling type is now: ${types}`,
    mixedSale: 'Mixed (direct + pre-order)',
  },
};

// ------------------------------------------------------------------ helpers

const rowKey = (r: { level: Level; id: string }) => `${r.level}:${r.id}`;

/** The derived selling type, in words. Nothing stores "mixed" — it is the
 *  name for a product whose options answer both ways (worker/lib/availability). */
const saleTypesText = (t: Strings, types: readonly string[]): string => {
  const pre = types.includes('pre_order');
  const direct = types.includes('direct_sale') || types.includes('bundle');
  if (pre && direct) return t.mixedSale;
  if (pre) return t.preOrder;
  return t.directSale;
};

/** Project legacy product-level availability into the two model checkboxes. */
const withQuickFulfillmentDefaults = (rel: RelationsState, saleTypes: readonly string[]): RelationsState => ({
  ...rel,
  groups: rel.groups.map((group) => ({
    ...group,
    values: group.values.map((value) => {
      const own = value.availability_type;
      const directEnabled = own
        ? own === 'direct_sale'
        : saleTypes.includes('direct_sale') || saleTypes.includes('bundle');
      const preorderEnabled = own ? own === 'pre_order' : saleTypes.includes('pre_order');
      const direct = value.fulfillments.find((cell) => cell.fulfillment_type === 'direct_sale') ??
        emptyFulfillment('direct_sale', directEnabled);
      const preorder = value.fulfillments.find((cell) => cell.fulfillment_type === 'pre_order') ??
        emptyFulfillment('pre_order', preorderEnabled);
      return { ...value, fulfillments: [direct, preorder] };
    }),
  })),
});
const cellKey = (r: { level: Level; id: string }, f: Field) => `${rowKey(r)}:${f}`;

/**
 * Mirrors worker/lib/priceGrid.ts `parseAmount` for the local hint only. The
 * SERVER parses the value that is actually written — this copy exists so a
 * typo turns the cell red as it is typed, not one round trip later, and it
 * refuses exactly what the server refuses so the two can never disagree about
 * whether an entry is valid.
 */
function localParse(raw: string): { value: number | null; ok: boolean } {
  let s = raw
    .replace(/[٠-٩]/g, (d) => String(d.charCodeAt(0) - 0x0660))
    .replace(/[۰-۹]/g, (d) => String(d.charCodeAt(0) - 0x06f0))
    .replace(/٫/g, '.')
    .replace(/[٬,\u00a0\u202f \s_]/g, '')
    .trim();
  if (s === '') return { value: null, ok: true };
  let sign = 1;
  if (s.startsWith('+')) s = s.slice(1);
  else if (s.startsWith('-') || s.startsWith('−')) {
    sign = -1;
    s = s.slice(1);
  }
  const m = /^(\d+(?:\.\d+)?)(k|m|ك|م|الف|ألف|مليون)?$/i.exec(s);
  if (!m) return { value: null, ok: false };
  const suffix = (m[2] ?? '').toLowerCase();
  const mult = suffix === '' ? 1 : /^(k|ك|الف|ألف)$/i.test(suffix) ? 1_000 : 1_000_000;
  if (mult === 1 && m[1].includes('.')) return { value: null, ok: false };
  const scaled = Number(m[1]) * mult;
  if (Math.abs(scaled - Math.round(scaled)) > 1e-6) return { value: null, ok: false };
  const v = sign * Math.round(scaled);
  if (Math.abs(v) > 1_000_000_000) return { value: null, ok: false };
  return { value: v, ok: true };
}

const iqd = (n: number | null | undefined) => (n === null || n === undefined ? '—' : formatIqd(n));

// -------------------------------------------------------------- the panel

export default function QuickPricePanel({
  productId,
  onChanged,
  onDirtyChange,
  registerEscape,
}: {
  productId: string;
  /** Fires after a successful write so the list can refresh its own numbers. */
  onChanged?: () => void;
  /** Lets the enclosing modal warn before discarding unsaved cells. */
  onDirtyChange?: (dirty: boolean) => void;
  /**
   * Hands the dialog a first refusal on Escape. The dialog stops the key in the
   * capture phase — it has to, or a nested dialog would close two at once — so
   * a panel that wants Escape to mean something smaller has to be asked. Here
   * it means "throw away the cells I typed", and only an empty grid lets the
   * key close the window.
   */
  registerEscape?: (fn: () => boolean) => void;
}) {
  const { lang } = useLanguage();
  const t = STRINGS[lang === 'en' ? 'en' : 'ar'];

  const [data, setData] = useState<GridResponse | null>(null);
  const [relations, setRelations] = useState<RelationsState | null>(null);
  const [relationsBaseline, setRelationsBaseline] = useState('');
  const [relationsSaving, setRelationsSaving] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [tab, setTab] = useState<'grid' | 'bulk' | 'copy' | 'history'>('grid');

  // The dirty set: cell key -> what the admin typed, and in which mode.
  const [draft, setDraft] = useState<Record<string, { mode: Mode; text: string }>>({});
  const [saving, setSaving] = useState(false);
  const [toast, setToast] = useState('');
  const [guards, setGuards] = useState<Guard[]>([]);
  const [lastBatch, setLastBatch] = useState('');
  /**
   * Traits are not prices, so they are not in price_history and have no
   * batch_id — the endpoint hands back the exact inverse instead. Undo has one
   * button, so it undoes whichever of the two happened LAST.
   */
  const [lastTraits, setLastTraits] = useState<TraitPatch[]>([]);
  const [selected, setSelected] = useState<string[]>([]);

  const dirtyCount = Object.keys(draft).length;
  const relationsDirty = relations !== null && JSON.stringify(relations) !== relationsBaseline;
  useEffect(() => {
    onDirtyChange?.(dirtyCount > 0 || relationsDirty);
  }, [dirtyCount, relationsDirty, onDirtyChange]);

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const [res, relResponse] = await Promise.all([
        api.get<GridResponse>(`/api/admin/products/${productId}/price-grid`),
        api.get<RelationsResponse>(`/api/admin/products/${productId}/relations`),
      ]);
      const nextRelations = withQuickFulfillmentDefaults(relationsFromWire(relResponse), res.product.sale_types ?? []);
      setData(res);
      setRelations(nextRelations);
      setRelationsBaseline(JSON.stringify(nextRelations));
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'error');
    } finally {
      setLoading(false);
    }
  }, [productId]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    if (!toast) return;
    const timer = setTimeout(() => setToast(''), 3200);
    return () => clearTimeout(timer);
  }, [toast]);

  const fields: Field[] = useMemo(
    () => (data?.can_view_cost ? ['cost', 'regular', 'prime', 'pro'] : ['regular', 'prime', 'pro']),
    [data?.can_view_cost]
  );

  // ---------------------------------------------------------------- saving

  const buildCells = useCallback(() => {
    return Object.entries(draft).map(([key, d]) => {
      const parts = key.split(':');
      const field = parts[parts.length - 1] as Field;
      const level = parts[0] as Level;
      const id = parts.slice(1, -1).join(':');
      return { level, id, field, mode: d.mode, value: d.mode === 'inherit' ? null : d.text };
    });
  }, [draft]);

  const save = useCallback(
    async (confirm = false) => {
      const cells = buildCells();
      if (cells.length === 0) return;
      setSaving(true);
      setError('');
      try {
        const res = await api.patch<SaveResponse>(`/api/admin/products/${productId}/price-grid`, { cells, confirm });
        setData((d) => (d ? { ...d, rows: res.rows } : d));
        setDraft({});
        setGuards([]);
        setLastBatch(res.batch_id || '');
        setLastTraits([]);
        setToast(res.changed ? t.saved(res.changed) : t.nothing);
        if (res.changed) onChanged?.();
      } catch (e) {
        if (e instanceof ApiError && e.code === 'PROFIT_GUARD') {
          setGuards((e.details?.guards as Guard[]) ?? []);
        } else {
          setError(e instanceof ApiError ? e.message : 'error');
        }
      } finally {
        setSaving(false);
      }
    },
    [buildCells, onChanged, productId, t]
  );

  /** Active remains an immediate row trait; fulfilment and stock use the
   * atomic model panel above so a route checkbox and its shelf cannot split. */
  const patchTraits = useCallback(
    async (traits: TraitPatch[]) => {
      if (traits.length === 0) return;
      setSaving(true);
      setError('');
      try {
        const res = await api.patch<TraitsResponse>(
          `/api/admin/products/${productId}/price-grid/traits`,
          { traits }
        );
        if (res.rows) setData((d) => (d ? { ...d, rows: res.rows, product: { ...d.product, sale_types: res.sale_types } } : d));
        setLastTraits(res.undo ?? []);
        setLastBatch('');
        setToast(
          res.changed === 0
            ? t.nothing
            : res.sale_types_changed
              ? t.saleTypesDerived(saleTypesText(t, res.sale_types))
              : t.saved(res.changed)
        );
        if (res.changed) onChanged?.();
      } catch (e) {
        setError(e instanceof ApiError ? e.message : 'error');
      } finally {
        setSaving(false);
      }
    },
    [onChanged, productId, t]
  );

  /** Save the model checkboxes, route increases and direct-only stock. */
  const saveRelations = useCallback(async () => {
    if (!relations || !data) return;
    setRelationsSaving(true);
    setError('');
    try {
      const saleTypes = data.product.sale_types ?? [];
      const complete: RelationsState = {
        ...relations,
        groups: relations.groups.map((g) => ({
          ...g,
          values: g.values.map((v) =>
            v.fulfillments.length > 0
              ? v
              : {
                  ...v,
                  fulfillments: [
                    emptyFulfillment('direct_sale', saleTypes.includes('direct_sale') || saleTypes.includes('bundle')),
                    { ...emptyFulfillment('pre_order', saleTypes.includes('pre_order')), transports: [] },
                  ],
                }
          ),
        })),
      };
      /**
       * THE SAME RULE AS THE FULL FORM: a blank direct-sale shelf is zero.
       *
       * This panel threw twice for a blank — once for a combination with no
       * row at all, once for a row with no number — and the owner met the
       * same wall here that they met in the full editor. `relationsToWire`
       * resolves it (`withBlankDirectStockAsZero`), so the resolved state is
       * what this function reads from that point on. Reading `complete` below
       * would send the wire a zero and the ledger a null, from one save.
       */
      const resolved = withBlankDirectStockAsZero(complete);
      const wire = relationsToWire(resolved);
      const fulfillments = wire.groups.flatMap((g) =>
        g.values.flatMap((v) => v.fulfillments.map((f) => ({ ...f, option_id: v.id })))
      );
      const allValues = resolved.groups.flatMap((g) => g.values);
      const directValueIds = new Set(
        allValues
          .filter((v) => v.fulfillments.some((f) => f.fulfillment_type === 'direct_sale' && f.enabled))
          .map((v) => v.id)
      );
      const exact = directStockCombinations(resolved).filter((combo) =>
        combo.option_value_ids.some((id) => directValueIds.has(id))
      );
      const variantsByKey = new Map(resolved.variants.map((v) => [combinationKey(v), v] as const));
      // Every exact shelf has a row and a number now — the resolution above
      // materialised the ones nobody filled. The two refusals that stood here
      // are gone with the wall they were part of.
      const variantRows = exact.map((combo) => variantsByKey.get(combinationKey(combo))!).filter(Boolean);
      const optionRows = exact.length === 0
        ? allValues.filter((v) => directValueIds.has(v.id))
        : [];
      // The OPTION side keeps its own rule, which this panel already had: an
      // enabled direct option with no number saves as zero (see the `stock:`
      // expression in the fulfilment mapper above). Only a row the resolution
      // could not reach would still be null, and it is dropped rather than
      // sent as one.
      const optionStockRows = optionRows.filter((v) => v.stock !== null);
      const directStock = exact.length > 0
        ? variantRows.map((v) => ({
            scope: 'variant' as const,
            id: v.id,
            stock: v.stock,
            low_stock_threshold: v.low_stock_threshold,
          }))
        : optionStockRows.map((v) => ({
            scope: 'option' as const,
            id: v.id,
            stock: v.stock,
            low_stock_threshold: v.low_stock_threshold,
          }));
      const inventoryMode = exact.length > 0 ? 'VARIANT_COMBINATION' : 'OPTION';
      const saved = await api.put<{ stock_notices?: Array<{ requested: number; stored: number }> }>(`/api/admin/products/${productId}/fulfillment`, {
        fulfillments,
        direct_stock: directStock,
        ...(directStock.length > 0 ? { inventory_mode: inventoryMode } : {}),
      });
      const fresh = relationsFromWire(
        await api.get<RelationsResponse>(`/api/admin/products/${productId}/relations`)
      );
      setRelations(fresh);
      setRelationsBaseline(JSON.stringify(fresh));
      setData((d) => d ? { ...d, product: { ...d.product, sale_types: Array.from(new Set([
        ...(d.product.sale_types ?? []).filter((type) => type === 'bundle'),
        ...fresh.groups.flatMap((g) => g.values.flatMap((v) =>
          v.fulfillments.filter((f) => f.enabled).map((f) => f.fulfillment_type)
        )),
      ])) } } : d);
      const held = (saved?.stock_notices ?? []).reduce((n, row) => n + row.stored, 0);
      setToast(held > 0 ? `${t.saved(1)} — ${t.heldByOrders(held)}` : t.saved(1));
      onChanged?.();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'error');
    } finally {
      setRelationsSaving(false);
    }
  }, [data, onChanged, productId, relations, t]);

  const undo = useCallback(async () => {
    setSaving(true);
    setError('');
    try {
      if (lastTraits.length > 0) {
        const res = await api.patch<TraitsResponse>(
          `/api/admin/products/${productId}/price-grid/traits`,
          { traits: lastTraits }
        );
        if (res.rows) setData((d) => (d ? { ...d, rows: res.rows, product: { ...d.product, sale_types: res.sale_types } } : d));
        setLastTraits([]);
        setToast(`${t.undone} (${res.changed})`);
        onChanged?.();
        return;
      }
      if (!lastBatch) return;
      const res = await api.post<SaveResponse>(`/api/admin/products/${productId}/price-grid/undo`, { batch_id: lastBatch });
      if (res.rows) setData((d) => (d ? { ...d, rows: res.rows } : d));
      setLastBatch('');
      setToast(`${t.undone} (${res.changed})`);
      onChanged?.();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'error');
    } finally {
      setSaving(false);
    }
  }, [lastBatch, lastTraits, onChanged, productId, t]);

  // Enter saves everything pending. Escape throws it away — but only the
  // dialog can hear Escape (it stops the key in the capture phase), so that
  // half arrives through `registerEscape` rather than through this handler.
  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey && dirtyCount > 0) {
      e.preventDefault();
      void save(guards.length > 0);
    }
  };

  const discard = useCallback(() => {
    setDraft({});
    setGuards([]);
    if (relationsBaseline) setRelations(JSON.parse(relationsBaseline) as RelationsState);
  }, [relationsBaseline]);

  useEffect(() => {
    if (!registerEscape) return;
    registerEscape(() => {
      if (dirtyCount === 0 && !relationsDirty) return false; // nothing to cancel — let it close
      discard();
      return true;
    });
  }, [registerEscape, dirtyCount, relationsDirty, discard]);

  // --------------------------------------------------------------- render

  if (loading) {
    return (
      <div className="flex items-center justify-center gap-2 py-10 text-[13px] text-[var(--ap-text-3)]" data-qp="loading">
        <Loader2 className="w-4 h-4 animate-spin" /> {t.loading}
      </div>
    );
  }
  if (!data) {
    return (
      <p className="text-[13px] text-[var(--ap-danger)] py-6" data-qp="error">
        {error || 'error'}
      </p>
    );
  }

  const TABS: Array<{ id: typeof tab; label: string; icon: React.ReactNode }> = [
    { id: 'grid', label: t.grid, icon: <Check className="w-3.5 h-3.5" /> },
    { id: 'bulk', label: t.bulk, icon: <Percent className="w-3.5 h-3.5" /> },
    { id: 'copy', label: t.copy, icon: <ArrowLeftRight className="w-3.5 h-3.5" /> },
    ...(data.can_view_cost ? [{ id: 'history' as const, label: t.history, icon: <History className="w-3.5 h-3.5" /> }] : []),
  ];

  return (
    <div className="min-w-0" data-qp="panel" data-qp-store={data.product.store} onKeyDown={onKeyDown}>
      <div className="mb-4 flex w-full items-center gap-1 rounded-xl border border-[var(--ap-border)] bg-[var(--ap-surface-2)] p-1 sm:w-fit" role="tablist" aria-label={t.title}>
        {TABS.map((x) => (
          <button
            key={x.id}
            type="button"
            role="tab"
            className="flex min-h-10 flex-1 items-center justify-center gap-1.5 rounded-lg px-3 text-[12px] font-semibold text-[var(--ap-text-2)] transition-[color,background-color,box-shadow] duration-150 hover:text-[var(--ap-text-1)] aria-selected:bg-[var(--ap-surface-4)] aria-selected:text-[var(--ap-text-1)] aria-selected:shadow-[0_1px_3px_rgb(0_0_0_/_0.35)] focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-[var(--ap-ring)] sm:flex-none"
            aria-selected={tab === x.id}
            data-qp-tab={x.id}
            onClick={() => setTab(x.id)}
          >
            {x.icon} {x.label}
          </button>
        ))}
      </div>

      {error && (
        <p className="text-[12.5px] text-[var(--ap-danger)] mb-2" data-qp="error">
          {error}
        </p>
      )}
      {toast && (
        <p className="text-[12.5px] text-[var(--ap-success)] mb-2" data-qp="toast" role="status">
          {toast}
        </p>
      )}

      {tab === 'grid' && (
        <>
          {relations && (
            <QuickFulfillmentPanel
              rel={relations}
              setRel={setRelations}
              dirty={relationsDirty}
              saving={relationsSaving}
              onSave={() => void saveRelations()}
            />
          )}
          <GridTab
            t={t}
            rows={data.rows}
            fields={fields}
            draft={draft}
            setDraft={setDraft}
            selected={selected}
            setSelected={setSelected}
            minMargin={data.min_margin_percent}
            onTrait={(patches) => void patchTraits(patches)}
            busy={saving || relationsSaving}
          />
        </>
      )}
      {tab === 'bulk' && (
        <BulkTab
          t={t}
          productId={productId}
          data={data}
          fields={fields}
          selected={selected}
          onApplied={(rows) => {
            setData((d) => (d ? { ...d, rows } : d));
            onChanged?.();
          }}
          onBatch={setLastBatch}
        />
      )}
      {tab === 'copy' && (
        <CopyTab
          t={t}
          productId={productId}
          data={data}
          fields={fields}
          onApplied={(rows) => {
            setData((d) => (d ? { ...d, rows } : d));
            onChanged?.();
          }}
          onBatch={setLastBatch}
        />
      )}
      {tab === 'history' && <HistoryTab t={t} productId={productId} />}

      {/* --------------------------------------------------- the action bar */}
      {tab === 'grid' && (
        <div
          className="sticky bottom-0 z-10 -mx-3 mt-4 flex flex-wrap items-center gap-2 border-t border-[var(--ap-hairline)] bg-[rgba(31,31,36,0.92)] px-3 pb-1 pt-3 backdrop-blur-xl sm:-mx-5 sm:px-5"
          data-qp="actions"
        >
          {guards.length > 0 && (
            <div
              className="w-full rounded-[var(--ap-radius-md)] border border-[var(--ap-warning-border)] bg-[var(--ap-warning-bg)] p-2.5 mb-1"
              data-qp="guard"
              role="alert"
            >
              <p className="text-[12.5px] font-semibold text-[var(--ap-warning)] flex items-center gap-1.5">
                <AlertTriangle className="w-3.5 h-3.5" /> {t.guardTitle}
              </p>
              <ul className="mt-1 space-y-0.5">
                {guards.map((g, i) => (
                  <li key={i} className="text-[12px] text-[var(--ap-text-2)]" data-qp-guard={g.code}>
                    {g.where} · {t[g.field]} — {g.code === 'BELOW_COST' ? t.belowCost : t.thinMargin} (
                    <span dir="ltr">{iqd(g.price_iqd)}</span> / <span dir="ltr">{iqd(g.cost_iqd)}</span>
                    {g.margin_percent !== null && <span dir="ltr"> · {g.margin_percent}%</span>})
                  </li>
                ))}
              </ul>
            </div>
          )}
          <span className="text-[12px] text-[var(--ap-text-3)]" data-qp-dirty={dirtyCount}>
            {dirtyCount > 0 || relationsDirty ? t.pending(dirtyCount + (relationsDirty ? 1 : 0)) : t.shorthandHint}
          </span>
          <span className="flex-1" />
          {(dirtyCount > 0 || relationsDirty) && (
            <button type="button" className={T.btnGhostSm} data-qp="discard" onClick={discard}>
              <X className="w-3.5 h-3.5" /> {t.cancel}
            </button>
          )}
          {(lastBatch || lastTraits.length > 0) && dirtyCount === 0 && !relationsDirty && (
            <button type="button" className={T.btnGhostSm} data-qp="undo" onClick={() => void undo()} disabled={saving}>
              <RotateCcw className="w-3.5 h-3.5" /> {t.undo}
            </button>
          )}
          <button
            type="button"
            className={T.btnPrimary}
            data-qp="save"
            disabled={dirtyCount === 0 || saving}
            onClick={() => void save(guards.length > 0)}
          >
            {saving ? <Loader2 className="w-4 h-4 animate-spin" /> : <Check className="w-4 h-4" />}
            {saving ? t.saving : guards.length > 0 ? t.confirmSave : t.save}
          </button>
        </div>
      )}
    </div>
  );
}

// ------------------------------------------ model availability + direct stock

function QuickFulfillmentPanel({
  rel,
  setRel,
  dirty,
  saving,
  onSave,
}: {
  rel: RelationsState;
  setRel: (next: RelationsState) => void;
  dirty: boolean;
  saving: boolean;
  onSave: () => void;
}) {
  const values = rel.groups.flatMap((g) => g.values);
  const valueName = new Map(values.map((v) => [v.id, v.name_en || v.id] as const));
  const colorName = new Map(rel.colors.map((c) => [c.id, c.name_en || c.id] as const));
  // A product has one inventory mode. As soon as one option uses colours,
  // colour-less options are represented by exact colour-less variant rows too.
  const combos = directStockCombinations(rel);
  const variants = new Map(rel.variants.map((v) => [combinationKey(v), v] as const));

  const change = (fn: (current: RelationsState) => RelationsState) => {
    const next = fn(rel);
    setRel({ ...next, inventory_mode: deriveInventoryMode(next) });
  };
  const patchValue = (id: string, fn: (value: FormValue) => FormValue) =>
    change((current) => ({
      ...current,
      groups: current.groups.map((g) => ({
        ...g,
        values: g.values.map((v) => (v.id === id ? fn(v) : v)),
      })),
    }));
  const cellOf = (value: FormValue, type: 'direct_sale' | 'pre_order') =>
    value.fulfillments.find((f) => f.fulfillment_type === type) ?? emptyFulfillment(type);
  const setCell = (value: FormValue, next: FormFulfillment) =>
    patchValue(value.id, (v) => ({
      ...v,
      fulfillments: [
        ...v.fulfillments.filter((f) => f.fulfillment_type !== next.fulfillment_type),
        next,
      ].sort((a, b) => a.sort - b.sort),
    }));
  const toggleDirect = (value: FormValue, direct: FormFulfillment, enabled: boolean) => {
    const hasCombinations = combos.some((combo) => combo.option_value_ids.includes(value.id));
    change((current) => ({
      ...current,
      groups: current.groups.map((g) => ({
        ...g,
        values: g.values.map((v) => {
          if (v.id !== value.id) return v;
          const next = { ...direct, enabled };
          return {
            ...v,
            // Enabling direct sale always creates a real counter. Zero is an
            // explicit sold-out shelf; null is never interpreted as unlimited.
            stock: enabled && !hasCombinations && v.stock === null ? 0 : v.stock,
            fulfillments: [
              ...v.fulfillments.filter((f) => f.fulfillment_type !== 'direct_sale'),
              next,
            ].sort((a, b) => a.sort - b.sort),
          };
        }),
      })),
      variants: enabled && hasCombinations
        ? current.variants.map((variant) => {
            return variant.option_value_ids.includes(value.id) && variant.stock === null
              ? { ...variant, stock: 0 }
              : variant;
          })
        : current.variants,
    }));
  };
  const setVariantStock = (variant: FormVariant, stock: number | null) =>
    change((current) => ({
      ...current,
      variants: current.variants.map((v) => (v.id === variant.id ? { ...v, stock } : v)),
    }));
  const routeOf = (cell: FormFulfillment, method: 'land' | 'sea' | 'air') =>
    cell.transports.find((t) => t.method === method) ??
    emptyFulfillment('pre_order').transports.find((t) => t.method === method)!;
  const setRoute = (value: FormValue, preorder: FormFulfillment, next: FormTransport) =>
    setCell(value, {
      ...preorder,
      transports: [
        ...preorder.transports.filter((t) => t.method !== next.method),
        next,
      ].sort((a, b) => a.sort - b.sort),
    });
  const routes = [
    ['land', 'بري', 'Land'],
    ['sea', 'بحري', 'Sea'],
    ['air', 'جوي', 'Air'],
  ] as const;

  if (values.length === 0) return null;
  return (
    <section className="mb-4 rounded-2xl bg-[var(--ap-surface-2)] p-3 shadow-[inset_0_0_0_1px_var(--ap-hairline)] sm:p-4" data-qp="fulfillment-stock">
      <div className="mb-4 flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0">
          <h3 className="text-[14px] font-semibold tracking-[-0.01em] text-[var(--ap-text-1)]">التوفر والزيادة والمخزون حسب الخيار</h3>
          <p className="mt-1 text-[11.5px] leading-relaxed text-[var(--ap-text-3)]">
            البيع المباشر يملك مخزونًا؛ الطلب المسبق متوفر أو غير متوفر فقط.
          </p>
        </div>
        <button type="button" className={`${T.btnSecondary} min-h-11 sm:min-h-9`} disabled={!dirty || saving} onClick={onSave} data-qp-save-fulfillment>
          {saving ? <Loader2 className="w-4 h-4 animate-spin" /> : <Check className="w-4 h-4" />}
          حفظ التوفر
        </button>
      </div>
      <div className="space-y-3">
        {values.map((value) => {
          const direct = cellOf(value, 'direct_sale');
          const preorder = cellOf(value, 'pre_order');
          const mine = combos.filter((combo) => combo.option_value_ids.includes(value.id));
          const total = mine.reduce((sum, combo) => sum + (variants.get(combinationKey(combo))?.stock ?? 0), 0);
          return (
            <div key={value.id} className="rounded-xl bg-[var(--ap-surface-1)] p-3 shadow-[inset_0_0_0_1px_var(--ap-border)] sm:p-3.5">
              <p className="mb-3 text-[13px] font-semibold text-[var(--ap-text-1)]">{value.name_en || value.id}</p>
              <div className="grid gap-3 lg:grid-cols-2">
                <div className="rounded-xl bg-[var(--ap-surface-2)] p-3 shadow-[inset_0_0_0_1px_var(--ap-hairline)]">
                  <Toggle
                    checked={direct.enabled}
                    onChange={(enabled) => toggleDirect(value, direct, enabled)}
                    label="بيع مباشر"
                    sub="Direct sale"
                  />
                  {direct.enabled && (
                    <div className="mt-2 grid gap-2 sm:grid-cols-2">
                      <FormField ar="الزيادة" en="Direct increase">
                        <Money
                          value={direct.regular_adjust_iqd ?? null}
                          onChange={(regular_adjust_iqd) =>
                            setCell(value, { ...direct, regular_price_iqd: null, regular_adjust_iqd })
                          }
                          placeholder="بلا زيادة"
                        />
                      </FormField>
                      <FormField ar="المخزون" en="Direct stock" hint={mine.length ? `مجموع الألوان: ${total}` : undefined}>
                        {mine.length === 0 ? (
                          <Qty
                            value={value.stock}
                            onChange={(stock) => patchValue(value.id, (v) => ({ ...v, stock }))}
                            placeholder="مطلوب: 0 = نفد"
                          />
                        ) : (
                          <div className="space-y-1.5">
                            {mine.map((combo) => {
                              const variant = variants.get(combinationKey(combo));
                              const color = combo.color_id
                                ? colorName.get(combo.color_id) || combo.color_id
                                : 'بدون لون';
                              const other = combo.option_value_ids
                                .filter((id) => id !== value.id)
                                .map((id) => valueName.get(id) || id)
                                .join(' / ');
                              return (
                                <label key={combinationKey(combo)} className="grid grid-cols-[minmax(0,1fr)_5.5rem] items-center gap-1.5">
                                  <span className="truncate text-[10.5px] text-[var(--ap-text-3)]">{color}{other ? ` · ${other}` : ''}</span>
                                  {variant ? (
                                    <Qty value={variant.stock} onChange={(stock) => setVariantStock(variant, stock)} placeholder="0 = نفد" />
                                  ) : (
                                    <span className="text-[10px] text-[var(--ap-warning)]">من التعديل الكامل</span>
                                  )}
                                </label>
                              );
                            })}
                          </div>
                        )}
                      </FormField>
                    </div>
                  )}
                </div>

                <div className="rounded-xl bg-[var(--ap-surface-2)] p-3 shadow-[inset_0_0_0_1px_var(--ap-hairline)]">
                  <Toggle
                    checked={preorder.enabled}
                    onChange={(enabled) => setCell(value, { ...preorder, enabled })}
                    label="طلب مسبق"
                    sub="Pre-order — بلا مخزون"
                  />
                  {preorder.enabled && (
                    <div className="mt-2 grid gap-1.5 sm:grid-cols-3">
                      {routes.map(([method, ar, en]) => {
                        const current = routeOf(preorder, method);
                        return (
                          <div key={method} className="rounded-lg bg-[var(--ap-surface-1)] p-2 shadow-[inset_0_0_0_1px_var(--ap-hairline)]">
                            <Toggle
                              checked={current.enabled}
                              onChange={(enabled) => setRoute(value, preorder, { ...current, enabled })}
                              label={ar}
                              sub={en}
                            />
                            {current.enabled && (
                              <div className="mt-1">
                                <Money
                                  value={current.surcharge_iqd}
                                  onChange={(surcharge_iqd) => setRoute(value, preorder, { ...current, surcharge_iqd })}
                                  placeholder="بلا زيادة"
                                />
                              </div>
                            )}
                          </div>
                        );
                      })}
                    </div>
                  )}
                </div>
              </div>
            </div>
          );
        })}
      </div>
    </section>
  );
}

// ------------------------------------------------------------------ the grid

type Strings = typeof STRINGS.ar;

function GridTab({
  t,
  rows,
  fields,
  draft,
  setDraft,
  selected,
  setSelected,
  minMargin,
  onTrait,
  busy,
}: {
  t: Strings;
  rows: Row[];
  fields: Field[];
  draft: Record<string, { mode: Mode; text: string }>;
  setDraft: React.Dispatch<React.SetStateAction<Record<string, { mode: Mode; text: string }>>>;
  selected: string[];
  setSelected: React.Dispatch<React.SetStateAction<string[]>>;
  minMargin: number | null;
  onTrait?: (patches: TraitPatch[]) => void;
  busy?: boolean;
}) {
  const toggle = (key: string) =>
    setSelected((s) => (s.includes(key) ? s.filter((x) => x !== key) : [...s, key]));

  return (
    <>
      {/* Desktop: one table, read across. */}
      <div className="hidden md:block overflow-x-auto rounded-[var(--ap-radius-md)] border border-[var(--ap-border)]">
        <table className="w-full border-collapse" data-qp="table">
          <thead>
            <tr className={T.tableHead}>
              <th className="text-start font-semibold px-3 py-2 w-8"> </th>
              <th className="text-start font-semibold px-3 py-2 min-w-[14rem]">{t.where}</th>
              {fields.map((f) => (
                <th key={f} className="text-start font-semibold px-2 py-2 w-[8.5rem]">
                  {t[f]}
                </th>
              ))}
              <th className="text-start font-semibold px-3 py-2 w-[9rem]">{t.profit}</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-[var(--ap-hairline)]">
            {rows.map((r) => (
              <tr key={rowKey(r)} data-qp-row={rowKey(r)} className={T.tableRow}>
                <td className="px-3 py-2">
                  {r.level !== 'product' && (
                    <input
                      type="checkbox"
                      checked={selected.includes(rowKey(r))}
                      onChange={() => toggle(rowKey(r))}
                      data-qp-select={rowKey(r)}
                      aria-label={r.label_ar || r.label_en}
                    />
                  )}
                </td>
                <td className="px-3 py-2">
                  <RowLabel t={t} row={r} onTrait={onTrait} busy={busy} />
                </td>
                {fields.map((f) => (
                  <td key={f} className="px-2 py-2">
                    <CellEditor t={t} row={r} field={f} draft={draft} setDraft={setDraft} />
                  </td>
                ))}
                <td className="px-3 py-2">
                  <ProfitCell row={r} minMargin={minMargin} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/* Phone: the same rows as cards. A four-column table at 390px is a
          scroll bar with the prices hidden inside it. */}
      <div className="md:hidden space-y-2" data-qp="cards">
        {rows.map((r) => (
          <div key={rowKey(r)} data-qp-card={rowKey(r)} className={`${T.surface} p-3`}>
            <div className="flex items-start justify-between gap-2">
              <RowLabel t={t} row={r} onTrait={onTrait} busy={busy} />
              {r.level !== 'product' && (
                <input
                  type="checkbox"
                  checked={selected.includes(rowKey(r))}
                  onChange={() => toggle(rowKey(r))}
                  data-qp-select-m={rowKey(r)}
                  aria-label={r.label_ar || r.label_en}
                />
              )}
            </div>
            <div className="grid grid-cols-2 gap-2 mt-2.5">
              {fields.map((f) => (
                <label key={f} className="block min-w-0">
                  <span className="block text-[11px] text-[var(--ap-text-3)] mb-1">{t[f]}</span>
                  <CellEditor t={t} row={r} field={f} draft={draft} setDraft={setDraft} />
                </label>
              ))}
            </div>
            <div className="mt-2 pt-2 border-t border-[var(--ap-hairline)]">
              <ProfitCell row={r} minMargin={minMargin} />
            </div>
          </div>
        ))}
      </div>
    </>
  );
}

/**
 * The row's identity and active state. Availability and direct stock live in
 * QuickFulfillmentPanel above, where they are saved atomically per model.
 *
 * `variant_label` stays TEXT, never a control: it is the link between the A1
 * and the A1 Combo rows and it is edited where variants are, in the form.
 */
function RowLabel({
  t,
  row,
  onTrait,
  busy,
}: {
  t: Strings;
  row: Row;
  onTrait?: (patches: TraitPatch[]) => void;
  busy?: boolean;
}) {
  const editable = !!onTrait && row.level !== 'product';
  const level = row.level as 'option' | 'color';
  const setActive = (value: boolean) => onTrait?.([{ level, id: row.id, field: 'active', value }]);

  return (
    <div className="min-w-0">
      {/* IDENTITY AND STATE ON ONE LINE. Whether a row is live is a fact ABOUT
          the row, so it reads beside the name — not at the end of a list of
          settings, where it was competing with the controls for attention. */}
      <div className="flex items-center gap-1.5 min-w-0">
        <p className="text-[13px] font-semibold text-[var(--ap-text-1)] truncate min-w-0 flex-1" dir="auto">
        {row.level === 'color' && row.hex && (
          <span
            className="inline-block w-2.5 h-2.5 rounded-full align-middle me-1.5 border border-[var(--ap-hairline)]"
            style={{ background: row.hex }}
          />
        )}
        {row.level === 'product' ? t.base : row.label_ar || row.label_en}
          {!editable && !row.active && <span className={`${T.kbdTiny} ms-1.5`}>{t.inactive}</span>}
        </p>
        {row.variant_label && <span className={`${T.kbdTiny} shrink-0`}>{row.variant_label}</span>}
        {editable && (
          <button
            type="button"
            className={`${T.chip} h-6 px-2 text-[11px] shrink-0`}
            aria-pressed={row.active}
            disabled={busy}
            data-qp-active={rowKey(row)}
            onClick={() => setActive(!row.active)}
          >
            {row.active ? t.activeOn : t.activeOff}
          </button>
        )}
      </div>

      {!editable && row.variant_label && (
        <p className="text-[11px] text-[var(--ap-text-3)] mt-0.5 truncate">
          {row.variant_label}
        </p>
      )}
    </div>
  );
}

/**
 * One editable cell.
 *
 * The mode chips are the point of the whole feature: `inherit` follows the
 * level above, `adjust` is a difference that KEEPS following it, and a typed
 * number pins the cell so a later base change will not reach it. Showing them
 * on every cell is what stops the pinning problem from happening silently.
 */
function CellEditor({
  t,
  row,
  field,
  draft,
  setDraft,
}: {
  t: Strings;
  row: Row;
  field: Field;
  draft: Record<string, { mode: Mode; text: string }>;
  setDraft: React.Dispatch<React.SetStateAction<Record<string, { mode: Mode; text: string }>>>;
}) {
  const cell = row.cells[field];
  const key = cellKey(row, field);
  const pending = draft[key];
  const ref = useRef<HTMLInputElement>(null);

  if (!cell) {
    return <span className="text-[12px] text-[var(--ap-text-3)]">—</span>;
  }

  const mode: Mode = pending ? pending.mode : cell.mode;
  const stored = cell.mode === 'adjust' ? cell.adjust : cell.value;
  const text = pending ? pending.text : stored === null ? '' : String(stored);
  const parsed = localParse(text);
  const bad = !parsed.ok;

  // The base regular price is the product's only unconditional number: there
  // is nothing above it to inherit from and nothing to adjust against.
  const canInherit = !(row.level === 'product' && field === 'regular');
  const canAdjust = row.level !== 'product';

  const setMode = (next: Mode) => {
    setDraft((d) => {
      const copy = { ...d };
      if (next === cell.mode && (next === 'inherit' || text === (stored === null ? '' : String(stored)))) {
        delete copy[key];
        return copy;
      }
      copy[key] = { mode: next, text: next === 'inherit' ? '' : text };
      return copy;
    });
    if (next !== 'inherit') setTimeout(() => ref.current?.focus(), 0);
  };

  /**
   * THE BOX IS THE MODE CONTROL. Clearing it means "follow the level above";
   * typing a number means "this row's own price". That was already true and is
   * now the only way those two are set — which is why the chips could go.
   *
   * `canInherit` is honoured HERE, not merely by hiding a button. The product's
   * base regular price has nothing above it to follow, so emptying that one box
   * must leave it an empty required field rather than silently marking it
   * inherited from a level that does not exist.
   */
  const setText = (value: string) => {
    setDraft((d) => {
      const copy = { ...d };
      const nextMode: Mode = mode === 'inherit' && value !== '' ? 'fixed' : mode;
      const cleared: Mode = canInherit ? 'inherit' : 'fixed';
      const unchanged = nextMode === cell.mode && value === (stored === null ? '' : String(stored));
      if (unchanged) delete copy[key];
      else copy[key] = { mode: value === '' ? cleared : nextMode, text: value };
      return copy;
    });
  };

  const charge = row.charges?.[field] ?? { charged: cell.effective, viaRegular: false };

  const placeholder = !canInherit
    ? t.required
    : mode === 'inherit'
      ? cell.inherited === null
        ? t.inheritHint
        : formatIqd(cell.inherited)
      : mode === 'adjust'
        ? '+0'
        : '';

  /**
   * THREE CHIPS PER CELL WERE TWO CHIPS TOO MANY.
   *
   * The cell used to carry an input, then a row of «موروث / فرق / ثابت»
   * buttons, then the resolved «= 675,000». Four pieces of chrome, in every
   * cell, of four columns, of every row — which is what the owner was looking
   * at when they called the screen مربك.
   *
   * Two of those three chips never had to exist, because the field ALREADY
   * expresses what they set: `setText` above turns an empty box back into
   * `inherit` and a typed number into `fixed`, all by itself. So «موروث» is
   * "clear the box" and «ثابت» is "type a number" — both already reachable,
   * both shown by the box's own contents.
   *
   * What genuinely needs a control is the one thing typing cannot say: whether
   * `60000` means "this row costs 60,000" or "this row costs 60,000 MORE than
   * the one above it". That is a single binary, so it is a single affordance —
   * a prefix INSIDE the field, where the sign of a number belongs, reading
   * `=` or `+`. It is the only glyph left in the cell, which is what makes it
   * readable at a glance across twenty rows.
   */
  const toggleAdjust = () => setMode(mode === 'adjust' ? 'fixed' : 'adjust');
  const dirty = !!pending;
  const showsResolved = mode !== 'fixed' && charge.charged !== null;

  return (
    <div className="min-w-0" data-qp-cell={key} data-qp-mode={mode} data-qp-dirty-cell={dirty ? '1' : '0'}>
      <div
        className={`flex items-center h-8 rounded-[var(--ap-radius-md)] border bg-[var(--ap-surface-2)] transition-colors duration-150 focus-within:border-[var(--ap-accent)] focus-within:shadow-[0_0_0_3px_var(--ap-accent-soft)] ${
          bad
            ? 'border-[var(--ap-danger)]'
            : dirty
              ? 'border-[var(--ap-accent-border,var(--ap-border-hover))]'
              : 'border-[var(--ap-border)]'
        }`}
      >
        {canAdjust && (
          <button
            type="button"
            onClick={toggleAdjust}
            aria-pressed={mode === 'adjust'}
            data-qp-mode-btn={`${key}:adjust`}
            title={mode === 'adjust' ? t.adjustHint : t.fixedHint}
            className="shrink-0 w-7 h-full grid place-items-center text-[13px] font-bold leading-none rounded-s-[var(--ap-radius-md)] text-[var(--ap-text-3)] aria-pressed:text-[var(--ap-accent-text)] hover:text-[var(--ap-text-1)] focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-[var(--ap-ring)]"
          >
            <span aria-hidden="true">{mode === 'adjust' ? '+' : '='}</span>
            <span className="sr-only">{mode === 'adjust' ? t.adjust : t.fixed}</span>
          </button>
        )}
        <input
          ref={ref}
          type="text"
          inputMode="numeric"
          dir="ltr"
          className={`min-w-0 flex-1 h-full bg-transparent border-0 outline-none text-[12.5px] text-[var(--ap-text-1)] placeholder:text-[var(--ap-text-3)] ${canAdjust ? 'pe-2.5' : 'px-2.5'}`}
          value={text}
          placeholder={placeholder}
          onChange={(e) => setText(e.target.value)}
          aria-invalid={bad}
          aria-label={`${row.label_ar || row.label_en} ${t[field]}`}
          data-qp-input={key}
        />
      </div>
      {/*
        WHAT THE CUSTOMER IS CHARGED, not the raw ladder value. `row.charges`
        walks the same rungs the resolver walks, in the same order — including
        the colour rung it walks even with no colour chosen, which erases a
        member price of zero or less and sends that tier back to the regular
        price. Reading `cell.effective` here showed «= 0» on a row the till
        charges the full price for.

        One quiet line under the field instead of a chip competing with it: it
        is an ANSWER to what was typed, so it reads below, in the calm colour.
      */}
      {showsResolved && (
        <p
          className="mt-1 text-[10.5px] leading-none text-[var(--ap-text-3)] truncate"
          dir="ltr"
          data-qp-effective={key}
          data-qp-via-regular={charge.viaRegular ? '1' : '0'}
          title={charge.viaRegular ? 'لا سعر لهذه الفئة — تُحاسب بسعر البيع' : undefined}
        >
          = {formatIqd(charge.charged as number)}
        </p>
      )}
    </div>
  );
}

function ProfitCell({ row, minMargin }: { row: Row; minMargin: number | null }) {
  const p = row.profit;
  if (p.profit_iqd === null) {
    return <span className="text-[11.5px] text-[var(--ap-text-3)]" data-qp-profit={rowKey(row)}>—</span>;
  }
  const below = p.profit_iqd < 0;
  const thin = !below && minMargin !== null && p.margin_percent !== null && p.margin_percent < minMargin;
  const tone = below ? 'text-[var(--ap-danger)]' : thin ? 'text-[var(--ap-warning)]' : 'text-[var(--ap-text-2)]';
  return (
    <span className={`text-[11.5px] ${tone}`} data-qp-profit={rowKey(row)} data-qp-profit-state={below ? 'below' : thin ? 'thin' : 'ok'}>
      <span dir="ltr">{iqd(p.profit_iqd)}</span>
      {p.margin_percent !== null && (
        <span className="text-[var(--ap-text-3)]">
          {' '}
          · <span dir="ltr">{p.margin_percent}%</span>
        </span>
      )}
    </span>
  );
}

// -------------------------------------------------------------- bulk change

const BULK_OPS = [
  { id: 'add', key: 'opAdd' },
  { id: 'subtract', key: 'opSubtract' },
  { id: 'add_percent', key: 'opAddPercent' },
  { id: 'subtract_percent', key: 'opSubtractPercent' },
  { id: 'set', key: 'opSet' },
  { id: 'adjust', key: 'opAdjust' },
  { id: 'inherit', key: 'opInherit' },
] as const;

function BulkTab({
  t,
  productId,
  data,
  fields,
  selected,
  onApplied,
  onBatch,
}: {
  t: Strings;
  productId: string;
  data: GridResponse;
  fields: Field[];
  selected: string[];
  onApplied: (rows: Row[]) => void;
  onBatch: (id: string) => void;
}) {
  const [op, setOp] = useState<string>('add');
  const [chosen, setChosen] = useState<Field[]>(['regular']);
  const [value, setValue] = useState('');
  const [levels, setLevels] = useState<Level[]>([]);
  const [variant, setVariant] = useState<string>('');
  const [onlySelected, setOnlySelected] = useState(false);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');

  const percent = op === 'add_percent' || op === 'subtract_percent';

  const scope = () => ({
    levels,
    // Availability is now two independent cells per model, not one legacy
    // option label. Direct/pre-order increases are edited in the panel above.
    availability: [],
    variant_keys: variant ? [variant] : [],
    row_ids: onlySelected ? selected : [],
  });

  const run = async (apply: boolean, confirm = false) => {
    setBusy(true);
    setErr('');
    try {
      const res = await api.post<{ preview: Preview; rows?: Row[]; batch_id?: string; changed?: number }>(
        `/api/admin/products/${productId}/price-grid/bulk`,
        { op, fields: chosen, value: op === 'inherit' ? null : value, scope: scope(), apply, confirm }
      );
      setPreview(res.preview);
      if (apply && res.rows) {
        onApplied(res.rows);
        onBatch(res.batch_id ?? '');
      }
    } catch (e) {
      if (e instanceof ApiError && e.code === 'PROFIT_GUARD') {
        setPreview((e.details?.preview as Preview) ?? null);
      } else {
        setErr(e instanceof ApiError ? e.message : 'error');
      }
    } finally {
      setBusy(false);
    }
  };

  // The preview is invalidated by every change to the request, so "Apply" can
  // never send something other than what the admin just read.
  const invalidate = () => setPreview(null);

  return (
    <div className="space-y-3" data-qp="bulk">
      <div className="grid gap-2 sm:grid-cols-2">
        <label className="block">
          <span className="block text-[11px] text-[var(--ap-text-3)] mb-1">{t.op}</span>
          <select
            className={T.select}
            value={op}
            data-qp="bulk-op"
            onChange={(e) => {
              setOp(e.target.value);
              invalidate();
            }}
          >
            {BULK_OPS.map((o) => (
              <option key={o.id} value={o.id}>
                {t[o.key]}
              </option>
            ))}
          </select>
        </label>
        {op !== 'inherit' && (
          <label className="block">
            <span className="block text-[11px] text-[var(--ap-text-3)] mb-1">{percent ? t.percent : t.amount}</span>
            <input
              className={T.input}
              dir="ltr"
              inputMode="numeric"
              value={value}
              data-qp="bulk-value"
              placeholder={percent ? '10' : t.shorthandHint}
              onChange={(e) => {
                setValue(e.target.value);
                invalidate();
              }}
            />
          </label>
        )}
      </div>

      <div>
        <span className="block text-[11px] text-[var(--ap-text-3)] mb-1">{t.fields}</span>
        <div className="flex items-center gap-1.5 flex-wrap">
          {fields.map((f) => (
            <button
              key={f}
              type="button"
              className={T.chip}
              aria-pressed={chosen.includes(f)}
              data-qp-bulk-field={f}
              onClick={() => {
                setChosen((c) => (c.includes(f) ? c.filter((x) => x !== f) : [...c, f]));
                invalidate();
              }}
            >
              {t[f]}
            </button>
          ))}
        </div>
      </div>

      <div>
        <span className="block text-[11px] text-[var(--ap-text-3)] mb-1">{t.scope}</span>
        <div className="flex items-center gap-1.5 flex-wrap">
          {(['product', 'option', 'color'] as Level[]).map((l) => (
            <button
              key={l}
              type="button"
              className={T.chip}
              aria-pressed={levels.includes(l)}
              data-qp-bulk-level={l}
              onClick={() => {
                setLevels((s) => (s.includes(l) ? s.filter((x) => x !== l) : [...s, l]));
                invalidate();
              }}
            >
              {l === 'product' ? t.lvlProduct : l === 'option' ? t.lvlOption : t.lvlColor}
            </button>
          ))}
          <select
            className={T.selectSm}
            value={variant}
            data-qp="bulk-variant"
            onChange={(e) => {
              setVariant(e.target.value);
              invalidate();
            }}
          >
            <option value="">{t.anyVariant}</option>
            {data.variants.map((v) => (
              <option key={v.key} value={v.key}>
                {v.label}
              </option>
            ))}
          </select>
          {selected.length > 0 && (
            <button
              type="button"
              className={T.chip}
              aria-pressed={onlySelected}
              data-qp="bulk-selected"
              onClick={() => {
                setOnlySelected((s) => !s);
                invalidate();
              }}
            >
              {t.selectedOnly} ({selected.length})
            </button>
          )}
        </div>
      </div>

      {err && <p className="text-[12.5px] text-[var(--ap-danger)]">{err}</p>}

      <ChangeList t={t} preview={preview} />

      <div className="flex items-center gap-2 flex-wrap">
        <button type="button" className={T.btnSecondary} data-qp="bulk-preview" disabled={busy} onClick={() => void run(false)}>
          {busy ? <Loader2 className="w-4 h-4 animate-spin" /> : null} {t.preview}
        </button>
        <button
          type="button"
          className={T.btnPrimary}
          data-qp="bulk-apply"
          disabled={busy || !preview || preview.changes.length === 0}
          title={preview ? undefined : t.previewFirst}
          onClick={() => void run(true, (preview?.guards.length ?? 0) > 0)}
        >
          <Check className="w-4 h-4" /> {preview && preview.guards.length > 0 ? t.confirmSave : t.apply}
        </button>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- copy tab

function CopyTab({
  t,
  productId,
  data,
  fields,
  onApplied,
  onBatch,
}: {
  t: Strings;
  productId: string;
  data: GridResponse;
  fields: Field[];
  onApplied: (rows: Row[]) => void;
  onBatch: (id: string) => void;
}) {
  // Direct/pre-order differences have their own cells above. Price-copy here
  // therefore stays on real model variants and never consults the removed
  // single availability label.
  const choices = data.variants.map((v) => ({ id: `variant:${v.key}`, label: v.label }));
  const [from, setFrom] = useState(choices[0]?.id ?? '');
  const [to, setTo] = useState(choices[1]?.id ?? '');
  const [chosen, setChosen] = useState<Field[]>(['regular', 'prime', 'pro']);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');

  const side = (v: string) => {
    const [kind, val] = v.split(':');
    return kind === 'availability' ? { availability: val } : { variant_key: val };
  };

  const run = async (apply: boolean, confirm = false) => {
    setBusy(true);
    setErr('');
    try {
      const res = await api.post<{ preview: Preview; rows?: Row[]; batch_id?: string }>(
        `/api/admin/products/${productId}/price-grid/copy`,
        { from: side(from), to: side(to), fields: chosen, apply, confirm }
      );
      setPreview(res.preview);
      if (apply && res.rows) {
        onApplied(res.rows);
        onBatch(res.batch_id ?? '');
      }
    } catch (e) {
      if (e instanceof ApiError && e.code === 'PROFIT_GUARD') setPreview((e.details?.preview as Preview) ?? null);
      else setErr(e instanceof ApiError ? e.message : 'error');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-3" data-qp="copy">
      <div className="grid gap-2 sm:grid-cols-2">
        <label className="block">
          <span className="block text-[11px] text-[var(--ap-text-3)] mb-1">{t.copyFrom}</span>
          <select className={T.select} value={from} data-qp="copy-from" onChange={(e) => { setFrom(e.target.value); setPreview(null); }}>
            {choices.map((x) => (
              <option key={x.id} value={x.id}>{x.label}</option>
            ))}
          </select>
        </label>
        <label className="block">
          <span className="block text-[11px] text-[var(--ap-text-3)] mb-1">{t.copyTo}</span>
          <select className={T.select} value={to} data-qp="copy-to" onChange={(e) => { setTo(e.target.value); setPreview(null); }}>
            {choices.map((x) => (
              <option key={x.id} value={x.id}>{x.label}</option>
            ))}
          </select>
        </label>
      </div>

      <div>
        <span className="block text-[11px] text-[var(--ap-text-3)] mb-1">{t.fields}</span>
        <div className="flex items-center gap-1.5 flex-wrap">
          {fields.map((f) => (
            <button
              key={f}
              type="button"
              className={T.chip}
              aria-pressed={chosen.includes(f)}
              data-qp-copy-field={f}
              onClick={() => {
                setChosen((c) => (c.includes(f) ? c.filter((x) => x !== f) : [...c, f]));
                setPreview(null);
              }}
            >
              {t[f]}
            </button>
          ))}
        </div>
      </div>

      {err && <p className="text-[12.5px] text-[var(--ap-danger)]">{err}</p>}

      <ChangeList t={t} preview={preview} />

      <div className="flex items-center gap-2 flex-wrap">
        <button type="button" className={T.btnSecondary} data-qp="copy-preview" disabled={busy} onClick={() => void run(false)}>
          {busy ? <Loader2 className="w-4 h-4 animate-spin" /> : null} {t.preview}
        </button>
        <button
          type="button"
          className={T.btnPrimary}
          data-qp="copy-apply"
          disabled={busy || !preview || preview.changes.length === 0}
          title={preview ? undefined : t.previewFirst}
          onClick={() => void run(true, (preview?.guards.length ?? 0) > 0)}
        >
          <Check className="w-4 h-4" /> {preview && preview.guards.length > 0 ? t.confirmSave : t.apply}
        </button>
      </div>
    </div>
  );
}

/** The preview both bulk and copy must show before anything is written. */
function ChangeList({ t, preview }: { t: Strings; preview: Preview | null }) {
  if (!preview) return null;
  if (preview.changes.length === 0) {
    return (
      <p className="text-[12.5px] text-[var(--ap-text-3)]" data-qp="preview-empty">
        {t.noChanges}
        {preview.unmatched && preview.unmatched.length > 0 && (
          <> — {t.unmatched}: {preview.unmatched.map((u) => u.label_ar || u.label_en).join('، ')}</>
        )}
      </p>
    );
  }
  return (
    <div className="rounded-[var(--ap-radius-md)] border border-[var(--ap-border)] overflow-hidden" data-qp="preview">
      <p className="text-[12px] font-semibold px-3 py-2 bg-[var(--ap-surface-2)]" data-qp-preview-count={preview.changes.length}>
        {t.willChange(preview.changes.length)}
        {preview.skipped.length > 0 && (
          <span className="text-[var(--ap-text-3)] font-normal"> · {t.skipped(preview.skipped.length)}</span>
        )}
      </p>
      <ul className="divide-y divide-[var(--ap-hairline)] max-h-56 overflow-y-auto">
        {preview.changes.map((ch, i) => (
          <li key={i} className="px-3 py-1.5 text-[12px] flex items-center gap-2 flex-wrap" data-qp-change={`${ch.level}:${ch.id}:${ch.field}`}>
            <span className="text-[var(--ap-text-1)] truncate max-w-[10rem]" dir="auto">
              {ch.label_ar || ch.label_en}
            </span>
            <span className="text-[var(--ap-text-3)]">{t[ch.field]}</span>
            <span className="text-[var(--ap-text-3)]" dir="ltr">
              {iqd(ch.from_iqd)} → <b className="text-[var(--ap-text-1)]">{iqd(ch.to_iqd)}</b>
            </span>
            {ch.to_mode !== 'fixed' && <span className={T.kbdTiny}>{ch.to_mode === 'adjust' ? t.adjust : t.inherit}</span>}
          </li>
        ))}
      </ul>
      {preview.guards.length > 0 && (
        <ul className="border-t border-[var(--ap-warning-border)] bg-[var(--ap-warning-bg)] px-3 py-2 space-y-0.5" data-qp="preview-guards">
          {preview.guards.map((g, i) => (
            <li key={i} className="text-[12px] text-[var(--ap-warning)]" data-qp-guard={g.code}>
              <AlertTriangle className="w-3 h-3 inline me-1" />
              {g.where} · {t[g.field]} — {g.code === 'BELOW_COST' ? t.belowCost : t.thinMargin}
            </li>
          ))}
        </ul>
      )}
      {preview.unmatched && preview.unmatched.length > 0 && (
        <p className="text-[11.5px] text-[var(--ap-text-3)] px-3 py-1.5 border-t border-[var(--ap-hairline)]" data-qp="preview-unmatched">
          {t.unmatched}: {preview.unmatched.map((u) => u.label_ar || u.label_en).join('، ')}
        </p>
      )}
    </div>
  );
}

// -------------------------------------------------------------- history tab

interface HistoryEntry {
  id: number;
  where: string;
  field: Field;
  old_iqd: number | null;
  new_iqd: number | null;
  changed_at: string;
  changed_by: string;
}

function HistoryTab({ t, productId }: { t: Strings; productId: string }) {
  const [entries, setEntries] = useState<HistoryEntry[] | null>(null);
  const [err, setErr] = useState('');

  useEffect(() => {
    let alive = true;
    api
      .get<{ entries: HistoryEntry[] }>(`/api/admin/products/${productId}/price-history?limit=80`)
      .then((r) => {
        if (alive) setEntries(r.entries);
      })
      .catch((e) => {
        if (alive) setErr(e instanceof ApiError ? e.message : 'error');
      });
    return () => {
      alive = false;
    };
  }, [productId]);

  if (err) return <p className="text-[12.5px] text-[var(--ap-danger)]">{err}</p>;
  if (!entries) return <p className="text-[12.5px] text-[var(--ap-text-3)]">{t.loading}</p>;
  if (entries.length === 0) return <p className="text-[12.5px] text-[var(--ap-text-3)]" data-qp="history-empty">{t.noHistory}</p>;

  return (
    <div className="overflow-x-auto rounded-[var(--ap-radius-md)] border border-[var(--ap-border)]" data-qp="history">
      <table className="w-full border-collapse">
        <thead>
          <tr className={T.tableHead}>
            <th className="text-start font-semibold px-3 py-2">{t.where}</th>
            <th className="text-start font-semibold px-3 py-2">{t.field}</th>
            <th className="text-start font-semibold px-3 py-2">{t.from}</th>
            <th className="text-start font-semibold px-3 py-2">{t.to}</th>
            <th className="text-start font-semibold px-3 py-2">{t.changedAt}</th>
            <th className="text-start font-semibold px-3 py-2">{t.changedBy}</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-[var(--ap-hairline)]">
          {entries.map((e) => (
            <tr key={e.id} className={T.tableRow} data-qp-history-row={e.id}>
              <td className="px-3 py-1.5 text-[12px]" dir="auto">{e.where || t.base}</td>
              <td className="px-3 py-1.5 text-[12px]">{t[e.field] ?? e.field}</td>
              <td className="px-3 py-1.5 text-[12px]" dir="ltr">{iqd(e.old_iqd)}</td>
              <td className="px-3 py-1.5 text-[12px] font-semibold" dir="ltr">{iqd(e.new_iqd)}</td>
              <td className="px-3 py-1.5 text-[11.5px] text-[var(--ap-text-3)]" dir="ltr">
                {String(e.changed_at ?? '').slice(0, 16).replace('T', ' ')}
              </td>
              <td className="px-3 py-1.5 text-[11.5px] text-[var(--ap-text-3)]" dir="auto">{e.changed_by}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
