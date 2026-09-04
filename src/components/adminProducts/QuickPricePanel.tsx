/**
 * QUICK EDIT — the whole price table of one product, editable in place.
 *
 * The owner's measure of success is time: changing a cost or a price should
 * take seconds, and the daily price change should never require opening the
 * full product form. So this panel is deliberately NOT a second product editor.
 * It shows exactly four numbers per row — cost, regular, PRIME, PRO — and
 * nothing else is editable here.
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
    save: 'حفظ',
    saving: 'جارٍ الحفظ…',
    cancel: 'تراجع عن التعديلات',
    pending: (n: number) => `${n} تعديل غير محفوظ`,
    saved: (n: number) => `تم حفظ ${n} تعديل`,
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
    save: 'Save',
    saving: 'Saving…',
    cancel: 'Discard changes',
    pending: (n: number) => `${n} unsaved change${n === 1 ? '' : 's'}`,
    saved: (n: number) => `Saved ${n} change${n === 1 ? '' : 's'}`,
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
  useEffect(() => {
    onDirtyChange?.(dirtyCount > 0);
  }, [dirtyCount, onDirtyChange]);

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const res = await api.get<GridResponse>(`/api/admin/products/${productId}/price-grid`);
      setData(res);
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

  /**
   * Availability / stock / active, from the same drawer as the prices.
   *
   * These write through PATCH /price-grid/traits, which re-derives the
   * product's sale_types from what its options will say AFTER the change —
   * §2's rule that the selling type is a CONCLUSION, never a choice. It is
   * deliberately NOT the relations PUT: that one rewrites the whole option
   * tree, and a drawer sending a partial body would delete it.
   *
   * A trait applies immediately. There is no dirty state for it because
   * "moved this variant to pre-order" is one decision, not part of a price
   * edit the admin is still composing — and the undo button takes it back.
   */
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
  }, []);

  useEffect(() => {
    if (!registerEscape) return;
    registerEscape(() => {
      if (dirtyCount === 0) return false; // nothing to cancel — let it close
      discard();
      return true;
    });
  }, [registerEscape, dirtyCount, discard]);

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
      <div className="flex items-center gap-1.5 flex-wrap mb-3">
        {TABS.map((x) => (
          <button
            key={x.id}
            type="button"
            className={T.chip}
            aria-pressed={tab === x.id}
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
          busy={saving}
        />
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
          className="sticky bottom-0 -mx-1 mt-3 px-1 pt-3 pb-1 bg-[var(--ap-surface-1)] border-t border-[var(--ap-hairline)] flex items-center gap-2 flex-wrap"
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
            {dirtyCount > 0 ? t.pending(dirtyCount) : t.shorthandHint}
          </span>
          <span className="flex-1" />
          {dirtyCount > 0 && (
            <button type="button" className={T.btnGhostSm} data-qp="discard" onClick={discard}>
              <X className="w-3.5 h-3.5" /> {t.cancel}
            </button>
          )}
          {(lastBatch || lastTraits.length > 0) && dirtyCount === 0 && (
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
              <th className="text-start font-semibold px-3 py-2">{t.where}</th>
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
 * The row's identity AND the three things about it that are not prices.
 *
 * Availability, stock and active used to be read-only here, so moving one
 * variant from pre-order to direct sale meant leaving the drawer and opening
 * the eight-section product form — the round trip this drawer exists to
 * remove. They write through PATCH /price-grid/traits, which re-derives the
 * product's sale types from its options; the admin never types "mixed".
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
  const availability =
    row.availability_type === 'direct_sale' ? t.directSale : row.availability_type === 'pre_order' ? t.preOrder : '';
  const editable = !!onTrait && row.level !== 'product';
  const level = row.level as 'option' | 'color';
  const send = (field: TraitPatch['field'], value: unknown) =>
    onTrait?.([{ level, id: row.id, field, value }]);

  return (
    <div className="min-w-0">
      <p className="text-[13px] font-semibold text-[var(--ap-text-1)] truncate" dir="auto">
        {row.level === 'color' && row.hex && (
          <span
            className="inline-block w-2.5 h-2.5 rounded-full align-middle me-1.5 border border-[var(--ap-hairline)]"
            style={{ background: row.hex }}
          />
        )}
        {row.level === 'product' ? t.base : row.label_ar || row.label_en}
        {!editable && !row.active && <span className={`${T.kbdTiny} ms-1.5`}>{t.inactive}</span>}
      </p>

      {!editable && (row.variant_label || availability || row.stock !== null) && (
        <p className="text-[11px] text-[var(--ap-text-3)] mt-0.5 truncate">
          {[row.variant_label, availability, row.stock === null ? '' : `${t.stock}: ${row.stock}`]
            .filter(Boolean)
            .join(' · ')}
        </p>
      )}

      {editable && (
        <div className="mt-1 flex flex-wrap items-center gap-1.5" data-qp-traits={rowKey(row)}>
          {row.variant_label && <span className={T.kbdTiny}>{row.variant_label}</span>}

          {/* Only an option carries a fulfilment route; a colour inherits the
              option it hangs from, so it is not offered one. */}
          {row.level === 'option' && (
            <select
              className={`${T.selectSm} h-7 px-1.5`}
              value={row.availability_type}
              disabled={busy}
              data-qp-availability={row.id}
              aria-label={t.route}
              onChange={(e) => send('availability_type', e.target.value)}
            >
              <option value="">{t.followProduct}</option>
              <option value="direct_sale">{t.directSale}</option>
              <option value="pre_order">{t.preOrder}</option>
            </select>
          )}

          <StockTrait t={t} row={row} busy={busy} onCommit={(v) => send('stock', v)} />

          <button
            type="button"
            className={`${T.chip} h-7 px-2 text-[11px]`}
            aria-pressed={row.active}
            disabled={busy}
            data-qp-active={rowKey(row)}
            onClick={() => send('active', !row.active)}
          >
            {row.active ? t.activeOn : t.activeOff}
          </button>
        </div>
      )}
    </div>
  );
}

/**
 * Stock as a number the admin types, where EMPTY IS A REAL ANSWER: it means
 * "we do not count these", which is not the same as zero ("sold out"). The
 * input is uncontrolled between edits so a slow round trip cannot swallow a
 * digit; it re-syncs whenever the server's value changes.
 */
function StockTrait({
  t,
  row,
  busy,
  onCommit,
}: {
  t: Strings;
  row: Row;
  busy?: boolean;
  onCommit: (value: number | null) => void;
}) {
  const stored = row.stock === null ? '' : String(row.stock);
  const [text, setText] = useState(stored);
  useEffect(() => setText(stored), [stored]);

  const commit = () => {
    const trimmed = text.trim();
    if (trimmed === '') {
      if (row.stock !== null) onCommit(null);
      return;
    }
    const n = Number(trimmed);
    if (!Number.isInteger(n) || n < 0) {
      setText(stored);
      return;
    }
    if (n !== row.stock) onCommit(n);
  };

  return (
    <label className="inline-flex items-center gap-1 text-[11px] text-[var(--ap-text-3)]">
      <span>{t.stock}</span>
      <input
        type="text"
        inputMode="numeric"
        className={`${T.input} h-7 w-16 px-1.5 text-[11px] text-center`}
        value={text}
        disabled={busy}
        placeholder={t.stockUntracked}
        data-qp-stock={rowKey(row)}
        aria-label={`${t.stock} — ${row.label_ar || row.label_en}`}
        onChange={(e) => setText(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
          if (e.key === 'Escape') setText(stored);
        }}
      />
    </label>
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

  const setText = (value: string) => {
    setDraft((d) => {
      const copy = { ...d };
      const nextMode: Mode = mode === 'inherit' && value !== '' ? 'fixed' : mode;
      const unchanged = nextMode === cell.mode && value === (stored === null ? '' : String(stored));
      if (unchanged) delete copy[key];
      else copy[key] = { mode: value === '' ? 'inherit' : nextMode, text: value };
      return copy;
    });
  };

  const placeholder =
    mode === 'inherit'
      ? cell.inherited === null
        ? t.inheritHint
        : formatIqd(cell.inherited)
      : mode === 'adjust'
        ? '+0'
        : '';

  return (
    <div className="min-w-0" data-qp-cell={key} data-qp-mode={mode} data-qp-dirty-cell={pending ? '1' : '0'}>
      <input
        ref={ref}
        type="text"
        inputMode="numeric"
        dir="ltr"
        className={`${T.input} h-8 w-full text-[12.5px] ${bad ? 'border-[var(--ap-danger)]' : pending ? 'border-[var(--ap-accent-border,var(--ap-border))]' : ''}`}
        value={text}
        placeholder={placeholder}
        onChange={(e) => setText(e.target.value)}
        aria-invalid={bad}
        aria-label={`${row.label_ar || row.label_en} ${t[field]}`}
        data-qp-input={key}
      />
      <div className="flex items-center gap-1 mt-1">
        {canInherit && (
          <ModeChip label={t.inherit} active={mode === 'inherit'} onClick={() => setMode('inherit')} cellKey={key} mode="inherit" />
        )}
        {canAdjust && (
          <ModeChip label={t.adjust} active={mode === 'adjust'} onClick={() => setMode('adjust')} cellKey={key} mode="adjust" />
        )}
        <ModeChip label={t.fixed} active={mode === 'fixed'} onClick={() => setMode('fixed')} cellKey={key} mode="fixed" />
        {mode !== 'fixed' && cell.effective !== null && (
          <span className="text-[10.5px] text-[var(--ap-text-3)] ms-auto" dir="ltr" data-qp-effective={key}>
            = {formatIqd(cell.effective)}
          </span>
        )}
      </div>
    </div>
  );
}

function ModeChip({
  label,
  active,
  onClick,
  cellKey: key,
  mode,
}: {
  label: string;
  active: boolean;
  onClick: () => void;
  cellKey: string;
  mode: Mode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      data-qp-mode-btn={`${key}:${mode}`}
      className={`text-[10px] leading-none px-1.5 h-5 rounded-[5px] border transition-colors duration-150 ${
        active
          ? 'border-[var(--ap-border)] bg-[var(--ap-surface-4)] text-[var(--ap-text-1)]'
          : 'border-transparent text-[var(--ap-text-3)] hover:text-[var(--ap-text-2)]'
      }`}
    >
      {label}
    </button>
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
  const [availability, setAvailability] = useState<string>('');
  const [variant, setVariant] = useState<string>('');
  const [onlySelected, setOnlySelected] = useState(false);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');

  const percent = op === 'add_percent' || op === 'subtract_percent';

  const scope = () => ({
    levels,
    availability: availability ? [availability] : [],
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
            value={availability}
            data-qp="bulk-availability"
            onChange={(e) => {
              setAvailability(e.target.value);
              invalidate();
            }}
          >
            <option value="">{t.anyAvailability}</option>
            {data.availability.map((a) => (
              <option key={a} value={a}>
                {a === 'direct_sale' ? t.directSale : t.preOrder}
              </option>
            ))}
          </select>
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
  // "availability:pre_order" or "variant:a1" — one control, two axes, so the
  // pairing rule ("copy across routes pairs by model") stays legible.
  const choices = [
    ...data.availability.map((a) => ({ id: `availability:${a}`, label: a === 'direct_sale' ? t.directSale : t.preOrder })),
    ...data.variants.map((v) => ({ id: `variant:${v.key}`, label: v.label })),
  ];
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
