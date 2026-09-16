/**
 * ONE CARD PER MODEL. INSIDE IT, WHAT THAT MODEL DOES.
 *
 * The owner's rule for this screen, in their words:
 *
 *   "كل Model يظهر مرة واحدة" — each model appears ONCE, with its own Direct
 *   Sale card and its own Pre-order card, and the pre-order card holds a
 *   sub-card per transport.
 *
 * The old form could not express that: an order type WAS an option row, so
 * "A1 mini" appeared twice — once as a pre-order and once as a direct sale —
 * and the two halves of one model were edited as if they were two products.
 *
 * WHY THIS IS ITS OWN PANEL, saving through its own endpoint. The server has
 * two doors for the same reason: `PUT /:id/relations` writes MODELS,
 * `PUT /:id/fulfillment` writes what each model does. Mirroring that split in
 * the UI is what keeps the first rule true — there is no field here that could
 * create a model, and no field in the structure editor that could create an
 * order type.
 *
 * AIR / SEA / LAND IS NOT LOCAL DELIVERY. This panel is about how a unit
 * reaches Iraq. How it reaches the customer's door — standard or personal
 * delivery — is a separate, later choice and lives in its own section.
 *
 * ────────────────────────────────────────────────────────────────────────────
 * 0075 — TWO COUNTERS, AND THE SCREEN SAYS WHICH IS WHICH.
 *
 * DIRECT SALE HAS NO COUNTER OF ITS OWN. Its availability IS the model's
 * stock — the row `products.inventory_mode` already selects — so the direct
 * card here edits `rel` (section 5's own state) and NOT a field of its own.
 * Typing a number here moves the very same number in «الخيارات»: that is the
 * owner's «استخدم مصدر مخزون واحد لكل اختيار فعلي», made literal by sharing
 * one piece of React state rather than by asking the admin to trust a label.
 * It therefore saves with the PRODUCT (مسودة / نشر), not with this panel's own
 * button, and the field says so.
 *
 * PRE-ORDER HAS AN OPTIONAL ONE. `capacity` is NULL = UNTRACKED = unlimited,
 * and `0` is a tracked counter with nothing left. Those are different facts,
 * so they are DIFFERENT CONTROLS: a select states the choice out loud and the
 * number box only exists once "a set quota" has been chosen. An empty box that
 * silently means unlimited is exactly the defect this panel is fixing.
 *
 * A ROUTE EITHER SHARES OR OWNS. `transports[].capacity` NULL means air, sea
 * and land all spend from the cell's pool; a number means that route holds its
 * own and does not touch the pool. The consequence is written under the
 * control in one line, so nobody has to read a migration to know which they
 * picked — and no quantity is ever copied onto the three routes for them
 * («لا تكرر نفس الكمية تلقائيًا على الطرق الثلاث»).
 */
import React, { useCallback, useEffect, useState } from 'react';
import { Check, Loader2, Plane, Ship, Truck, X } from 'lucide-react';
import { ApiError, api } from '../../lib/api';
import { useLanguage } from '../../LanguageContext';
import * as T from './theme';
import { ErrorBanner, L, NullableIqd, SignedIqd, inputCls } from './ui';
import { MirrorNote } from './form/formUi';
import { deriveInventoryMode, type FormValue, type RelationsState } from './form/model';

type FulfillmentType = 'direct_sale' | 'pre_order';
type Method = 'air' | 'sea' | 'land';

const METHODS: Array<{ id: Method; ar: string; en: string; icon: React.ReactNode }> = [
  { id: 'air', ar: 'جوي', en: 'Air', icon: <Plane className="w-3.5 h-3.5" /> },
  { id: 'sea', ar: 'بحري', en: 'Sea', icon: <Ship className="w-3.5 h-3.5" /> },
  { id: 'land', ar: 'بري', en: 'Land', icon: <Truck className="w-3.5 h-3.5" /> },
];

interface Model {
  id: string;
  name_en: string;
  name_ar: string;
  sort: number;
  active: number | boolean;
  stock: number | null;
}

interface TransportCell {
  method: Method;
  enabled: boolean;
  surcharge_iqd: number | null;
  /** 0075 — null = THIS ROUTE DRAWS ON THE CELL'S SHARED POOL. A number = it
   *  holds its own quota and does not spend the pool. */
  capacity: number | null;
  /** Read-only, from the server: units this route already holds for live
   *  pre-orders. The save is refused below it (CAPACITY_BELOW_RESERVED). */
  capacity_reserved: number;
  lead_time_text: string;
  lead_time_min_days: number | null;
  lead_time_max_days: number | null;
}

interface Cell {
  option_id: string;
  fulfillment_type: FulfillmentType;
  enabled: boolean;
  /** 0075 — PRE-ORDER ONLY. null = UNTRACKED (unlimited, nothing is held);
   *  0 = tracked and empty. A direct-sale cell never carries one: its number
   *  is the MODEL's stock, and sending one is refused (CAPACITY_ON_DIRECT). */
  capacity: number | null;
  /** Read-only, from the server. */
  capacity_reserved: number;
  regular_price_iqd: number | null;
  prime_price_iqd: number | null;
  pro_price_iqd: number | null;
  cost_iqd: number | null;
  regular_adjust_iqd: number | null;
  lead_time_text: string;
  lead_time_min_days: number | null;
  lead_time_max_days: number | null;
  transports: TransportCell[];
}

interface LoadResponse {
  models: Model[];
  fulfillments: Array<Record<string, unknown>>;
}

const emptyCell = (optionId: string, type: FulfillmentType): Cell => ({
  option_id: optionId,
  fulfillment_type: type,
  enabled: true,
  // A NEW CELL CLAIMS NO LIMIT. Untracked is what every pre-order in this
  // catalogue was before 0075, so switching an order type on changes nothing
  // about what can be sold until the admin decides otherwise.
  capacity: null,
  capacity_reserved: 0,
  regular_price_iqd: null,
  prime_price_iqd: null,
  pro_price_iqd: null,
  cost_iqd: null,
  regular_adjust_iqd: null,
  lead_time_text: '',
  lead_time_min_days: null,
  lead_time_max_days: null,
  transports: [],
});

const num = (v: unknown): number | null => (typeof v === 'number' ? v : null);

function cellFrom(raw: Record<string, unknown>): Cell {
  const rawTransports = Array.isArray(raw.transports) ? (raw.transports as Array<Record<string, unknown>>) : [];
  return {
    option_id: String(raw.option_id ?? ''),
    fulfillment_type: raw.fulfillment_type === 'pre_order' ? 'pre_order' : 'direct_sale',
    enabled: raw.enabled !== 0 && raw.enabled !== false,
    // `num` keeps 0 and turns anything non-numeric into null, which is the
    // whole null-versus-zero distinction this panel exists to preserve.
    capacity: num(raw.capacity),
    capacity_reserved: num(raw.capacity_reserved) ?? 0,
    regular_price_iqd: num(raw.regular_price_iqd),
    prime_price_iqd: num(raw.prime_price_iqd),
    pro_price_iqd: num(raw.pro_price_iqd),
    cost_iqd: num(raw.cost_iqd),
    regular_adjust_iqd: num(raw.regular_adjust_iqd),
    lead_time_text: String(raw.lead_time_text ?? ''),
    lead_time_min_days: num(raw.lead_time_min_days),
    lead_time_max_days: num(raw.lead_time_max_days),
    transports: rawTransports.map((t) => ({
      method: (t.method === 'air' || t.method === 'sea' ? t.method : 'land') as Method,
      enabled: t.enabled !== 0 && t.enabled !== false,
      surcharge_iqd: num(t.surcharge_iqd),
      capacity: num(t.capacity),
      capacity_reserved: num(t.capacity_reserved) ?? 0,
      lead_time_text: String(t.lead_time_text ?? ''),
      lead_time_min_days: num(t.lead_time_min_days),
      lead_time_max_days: num(t.lead_time_max_days),
    })),
  };
}

const key = (optionId: string, type: FulfillmentType) => `${optionId}|${type}`;

export default function FulfillmentPanel({
  productId,
  rel,
  setRel,
  onProductTouched,
}: {
  productId: string;
  /**
   * SECTION 5'S OWN STATE, NOT A COPY OF IT. The direct-sale number this panel
   * edits is `product_option_values.stock` — the one column the storefront
   * resolves for a direct sale — so it is edited THROUGH the same state the
   * options section edits and saved by the same PUT /relations. There is no
   * second direct-stock field anywhere in this form, and none on the server.
   */
  rel: RelationsState;
  setRel: (fn: (r: RelationsState) => RelationsState) => void;
  /**
   * This panel's own save writes `products.updated_at`, and the form around it
   * echoes the `updated_at` it loaded back as `expected_updated_at`. Without
   * this the form's token goes stale the moment this button is used, and the
   * next مسودة / نشر is refused as "modified by someone else" — by the same
   * admin, through the same screen.
   */
  onProductTouched?: (updatedAt: string) => void;
}) {
  const { lang } = useLanguage();
  const ar = lang === 'ar';
  const tr = (a: string, e: string) => (ar ? a : e);

  const [models, setModels] = useState<Model[]>([]);
  const [cells, setCells] = useState<Map<string, Cell>>(new Map());
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [notice, setNotice] = useState('');
  const [error, setError] = useState('');

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const res = await api.get<LoadResponse>(`/api/admin/products/${productId}/fulfillment`);
      setModels(res.models ?? []);
      const map = new Map<string, Cell>();
      for (const raw of res.fulfillments ?? []) {
        const cell = cellFrom(raw);
        map.set(key(cell.option_id, cell.fulfillment_type), cell);
      }
      setCells(map);
    } catch (e) {
      // The literal rather than `tr` here: a new `tr` on every render would
      // make this callback new on every render, and the effect below would
      // reload the panel forever. Both languages, one string.
      setError(e instanceof ApiError ? e.message : 'تعذّر تحميل أنواع الطلب / could not load the order types');
    } finally {
      setLoading(false);
    }
  }, [productId]);

  useEffect(() => {
    void load();
  }, [load]);

  /** The MODEL row as section 5 holds it — the single owner of direct stock. */
  const modelValue = (optionId: string): FormValue | null => {
    for (const g of rel.groups) {
      const v = g.values.find((x) => x.id === optionId);
      if (v) return v;
    }
    return null;
  };

  /**
   * Writes the model's own stock / low-stock threshold, and re-derives the
   * inventory source exactly as section 5 does — a stock number appearing on a
   * model IS what moves the product from BASE to OPTION, and a panel that
   * wrote the number without re-deriving would leave the form claiming one
   * level while the rows said another.
   */
  const patchModel = (optionId: string, patch: Partial<FormValue>) =>
    setRel((r) => {
      const next: RelationsState = {
        ...r,
        groups: r.groups.map((g) => ({
          ...g,
          values: g.values.map((v) => (v.id === optionId ? { ...v, ...patch } : v)),
        })),
      };
      return { ...next, inventory_mode: deriveInventoryMode(next) };
    });

  const update = (optionId: string, type: FulfillmentType, patch: Partial<Cell>) => {
    setCells((prev) => {
      const next = new Map(prev);
      const k = key(optionId, type);
      next.set(k, { ...(next.get(k) ?? emptyCell(optionId, type)), ...patch });
      return next;
    });
    setNotice('');
  };

  const toggleCell = (optionId: string, type: FulfillmentType) => {
    setCells((prev) => {
      const next = new Map(prev);
      const k = key(optionId, type);
      if (next.has(k)) next.delete(k);
      else next.set(k, emptyCell(optionId, type));
      return next;
    });
    setNotice('');
  };

  const toggleTransport = (optionId: string, method: Method) => {
    const cell = cells.get(key(optionId, 'pre_order'));
    if (!cell) return;
    const has = cell.transports.some((t) => t.method === method);
    update(optionId, 'pre_order', {
      transports: has
        ? cell.transports.filter((t) => t.method !== method)
        : [
            ...cell.transports,
            {
              method,
              enabled: true,
              surcharge_iqd: null,
              // SHARED BY DEFAULT, AND NEVER A COPY OF THE POOL'S NUMBER. A new
              // route spends the model's pool until the admin gives it a quota.
              capacity: null,
              capacity_reserved: 0,
              lead_time_text: '',
              lead_time_min_days: null,
              lead_time_max_days: null,
            },
          ],
    });
  };

  const updateTransport = (optionId: string, method: Method, patch: Partial<TransportCell>) => {
    const cell = cells.get(key(optionId, 'pre_order'));
    if (!cell) return;
    update(optionId, 'pre_order', {
      transports: cell.transports.map((t) => (t.method === method ? { ...t, ...patch } : t)),
    });
  };

  const save = async () => {
    setSaving(true);
    setError('');
    setNotice('');
    try {
      const payload = [...cells.values()].map((cell) => ({
        ...cell,
        // A direct sale has no journey, so its transports are never sent — the
        // server refuses them, and sending them would be asking to be refused.
        transports: cell.fulfillment_type === 'pre_order' ? cell.transports : undefined,
        // 0075 — AND IT HAS NO CAPACITY EITHER. The direct number is the
        // model's stock, which travels with the product's own save; a capacity
        // on a direct cell is CAPACITY_ON_DIRECT. The panel never offers the
        // control, and this line makes the payload say so even if a cell was
        // switched from pre-order to direct while it held one.
        capacity: cell.fulfillment_type === 'pre_order' ? cell.capacity : null,
      }));
      const res = await api.put<{ sale_types: string[]; updated_at?: string }>(
        `/api/admin/products/${productId}/fulfillment`,
        { fulfillments: payload }
      );
      if (res.updated_at) onProductTouched?.(res.updated_at);
      setNotice(
        tr(
          `حُفظ. المنتج يُباع الآن: ${res.sale_types.map((t) => (t === 'pre_order' ? 'طلب مسبق' : 'بيع مباشر')).join(' + ') || '—'}`,
          `Saved. This product now sells: ${res.sale_types.join(' + ') || '—'}`
        )
      );
      await load();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : tr('تعذّر الحفظ', 'Could not save'));
    } finally {
      setSaving(false);
    }
  };

  if (loading) {
    return (
      <div className={`flex items-center gap-2 py-6 justify-center text-[13px] ${T.text2}`}>
        <Loader2 className="w-4 h-4 animate-spin" />
        {tr('جارِ التحميل…', 'Loading…')}
      </div>
    );
  }

  if (!models.length) {
    return (
      <p className={`text-[13px] leading-relaxed ${T.text2}`}>
        {tr(
          'أضف موديلًا واحدًا على الأقل في «الخيارات» أولًا. نوع الطلب يُضبط على الموديل، وليس كخيار منفصل.',
          'Add at least one model under Options first. An order type is set ON a model, never as a separate option.'
        )}
      </p>
    );
  }

  return (
    <div className="space-y-3">
      <p className={`text-[12px] leading-relaxed ${T.text2}`}>
        {tr(
          'كل موديل يظهر مرة واحدة. البيع المباشر والطلب المسبق خصائص للموديل نفسه — وطرق الشحن (جوي/بحري/بري) هي كيف يصل الجهاز إلى العراق، لا كيف يصل إلى باب الزبون.',
          'Each model appears once. Direct sale and pre-order are properties OF the model — and air/sea/land is how the unit reaches Iraq, not how it reaches the customer’s door.'
        )}
      </p>

      <ErrorBanner text={error || null} />
      {notice ? (
        <div className="rounded-[var(--ap-radius-sm)] border border-[var(--ap-border)] bg-[var(--ap-surface-2)] px-3 py-2 text-[12px] text-[var(--ap-text-1)]">
          {notice}
        </div>
      ) : null}

      {models.map((m) => {
        const direct = cells.get(key(m.id, 'direct_sale'));
        const pre = cells.get(key(m.id, 'pre_order'));
        // THE LIVE number, not the loaded one: the admin may have just typed it
        // in the direct card below, or in section 5, and the header must agree
        // with both — there is only one number to agree about.
        const mv = modelValue(m.id);
        const shownStock = mv ? mv.stock : m.stock;
        return (
          <div key={m.id} className="rounded-[var(--ap-radius-lg)] border border-[var(--ap-border)] bg-[var(--ap-surface-1)] overflow-hidden">
            {/* ONE HEADER BAND PER MODEL, and a hairline instead of a second
                border. Three nested boxes — card, sub-card, tinted inner box —
                gave every field its own frame and left nothing for the eye to
                rank; a band plus spacing says the same hierarchy with one line
                instead of three rectangles. */}
            <div className="flex items-center justify-between gap-2 px-3 py-2.5 bg-[var(--ap-surface-2)] border-b border-[var(--ap-hairline)]">
              <span className={`font-bold text-[14px] truncate min-w-0 ${T.text1}`}>{ar ? m.name_ar || m.name_en : m.name_en}</span>
              <span className={`text-[11px] shrink-0 tabular-nums ${T.text3}`} data-model-stock={m.id}>
                {shownStock === null
                  ? tr('المخزون: غير مُتتبع', 'Stock: not tracked')
                  : tr(`المخزون: ${shownStock}`, `Stock: ${shownStock}`)}
              </span>
            </div>

            <div className="grid md:grid-cols-2 md:divide-x md:divide-[var(--ap-hairline)] divide-y md:divide-y-0 divide-[var(--ap-hairline)]">
              {/* ---------------------------------------------- DIRECT SALE */}
              <div className="p-3 min-w-0">
                <label className="flex items-center gap-2 cursor-pointer select-none mb-2.5 min-w-0">
                  <input
                    type="checkbox"
                    checked={!!direct}
                    onChange={() => toggleCell(m.id, 'direct_sale')}
                    className="h-4 w-4 accent-[var(--ap-accent)] shrink-0"
                  />
                  <span className={`font-bold text-[13px] ${direct ? T.text1 : T.text3}`}>{tr('بيع مباشر', 'Direct sale')}</span>
                </label>
                {direct ? (
                  <div className="space-y-2">
                    <Toggle
                      label={tr('معروض الآن', 'Offered now')}
                      checked={direct.enabled}
                      onChange={(v) => update(m.id, 'direct_sale', { enabled: v })}
                    />

                    {/* ───────────────────────────────── THE MODEL'S OWN STOCK.
                        NOT A FIELD OF THIS PANEL. `mv` is the row section 5
                        holds, and `patchModel` writes it there — so this box
                        and the one under «الخيارات» are the same number, and
                        the panel's own Save never sends a direct quantity. */}
                    {mv ? (
                      <div className="pt-2 border-t border-[var(--ap-hairline)] space-y-2" data-direct-stock={m.id}>
                        <L
                          ar="مخزون البيع المباشر"
                          en="Direct-sale stock"
                          hint={tr('رقم واحد لهذا الموديل، لا رفّ ثانٍ.', 'One number for this model, never a second shelf.')}
                        />
                        {/* The owner read the two boxes as two settings that
                            mysteriously moved together. Same marker, same
                            wording, wherever a value is shown twice. */}
                        <MirrorNote kind="same" where="٥ الخيارات والألوان" detail="يُحفظ مع المنتج (مسودة/نشر)، لا بزر هذه اللوحة" />
                        <select
                          className={`${T.select} w-full`}
                          data-direct-stock-mode={m.id}
                          aria-label={tr('تتبّع مخزون البيع المباشر', 'Direct-sale stock tracking')}
                          value={mv.stock === null ? 'untracked' : 'tracked'}
                          onChange={(e) =>
                            patchModel(m.id, { stock: e.target.value === 'tracked' ? mv.stock ?? 0 : null })
                          }
                        >
                          <option value="untracked">{tr('غير مُتتبع — يُباع دائمًا', 'Untracked — always sellable')}</option>
                          <option value="tracked">{tr('عدد محدّد', 'A counted number')}</option>
                        </select>
                        {mv.stock !== null ? (
                          <div className="grid grid-cols-2 gap-2">
                            <div>
                              <L ar="القطع المتوفرة" en="Units on hand" />
                              <Units
                                value={mv.stock}
                                onChange={(n) => patchModel(m.id, { stock: n })}
                                label={tr('القطع المتوفرة', 'Units on hand')}
                              />
                            </div>
                            <div>
                              <L ar="حد التنبيه" en="Low-stock warning" />
                              <NullableIqd
                                value={mv.low_stock_threshold}
                                onChange={(v) => patchModel(m.id, { low_stock_threshold: v })}
                                placeholder={tr('بلا تنبيه', 'no warning')}
                              />
                            </div>
                          </div>
                        ) : null}
                      </div>
                    ) : (
                      <p className={`text-[11px] leading-relaxed ${T.text3}`}>
                        {tr(
                          'هذا الموديل غير ظاهر في «الخيارات» بعد — مخزون البيع المباشر يُضبط هناك.',
                          'This model is not in the Options section yet — its direct-sale stock is set there.'
                        )}
                      </p>
                    )}

                    <div>
                      <L ar="سعر البيع المباشر" en="Direct price" hint={tr('فارغ = نفس سعر الموديل', 'Empty = the model’s own price')} />
                      <NullableIqd
                        value={direct.regular_price_iqd}
                        onChange={(v) => update(m.id, 'direct_sale', { regular_price_iqd: v })}
                        placeholder={tr('وراثة', 'inherit')}
                      />
                    </div>
                    <div>
                      <L
                        ar="أو الفرق عن سعر الموديل"
                        en="…or the difference"
                        hint={tr('مثال: 50000 يعني أغلى بـ50,000', 'e.g. 50000 = 50,000 dearer')}
                      />
                      <SignedIqd
                        value={direct.regular_adjust_iqd}
                        onChange={(v) => update(m.id, 'direct_sale', { regular_adjust_iqd: v })}
                        placeholder={tr('بلا فرق', 'no difference')}
                                      />
                    </div>
                  </div>
                ) : null}
              </div>

              {/* ------------------------------------------------ PRE-ORDER */}
              <div className="p-3 min-w-0">
                <label className="flex items-center gap-2 cursor-pointer select-none mb-2.5 min-w-0">
                  <input
                    type="checkbox"
                    checked={!!pre}
                    onChange={() => toggleCell(m.id, 'pre_order')}
                    className="h-4 w-4 accent-[var(--ap-accent)] shrink-0"
                  />
                  <span className={`font-bold text-[13px] ${pre ? T.text1 : T.text3}`}>{tr('طلب مسبق', 'Pre-order')}</span>
                </label>
                {pre ? (
                  <div className="space-y-2">
                    <Toggle
                      label={tr('معروض الآن', 'Offered now')}
                      checked={pre.enabled}
                      onChange={(v) => update(m.id, 'pre_order', { enabled: v })}
                    />
                    <div>
                      <L ar="سعر الطلب المسبق" en="Pre-order price" hint={tr('فارغ = نفس سعر الموديل', 'Empty = the model’s own price')} />
                      <NullableIqd
                        value={pre.regular_price_iqd}
                        onChange={(v) => update(m.id, 'pre_order', { regular_price_iqd: v })}
                        placeholder={tr('وراثة', 'inherit')}
                      />
                    </div>
                    <div>
                      <L ar="المدة كما تُعرض للزبون" en="Lead time (as shown)" />
                      <input
                        className={inputCls}
                        value={pre.lead_time_text}
                        onChange={(e) => update(m.id, 'pre_order', { lead_time_text: e.target.value })}
                        placeholder={tr('مثال: ٢١ إلى ٣٠ يوم', 'e.g. 21 to 30 days')}
                      />
                    </div>

                    {/* ─────────────────────── PRE-ORDER CAPACITY (0075).
                        UNTRACKED IS A CHOICE, NOT AN EMPTY BOX. The select
                        states it in words; the number box only exists once a
                        quota has been asked for, so `0` (tracked and empty)
                        can never be confused with «no limit». */}
                    <div className="pt-2 border-t border-[var(--ap-hairline)] space-y-2" data-preorder-capacity={m.id}>
                      <L
                        ar="سعة الطلب المسبق"
                        en="Pre-order capacity"
                        tip={tr(
                          'عدّاد مستقل تمامًا عن مخزون البيع المباشر — لا يُخصم منه ولا يمسّه.',
                          'A counter entirely separate from direct-sale stock — a pre-order never comes off the shelf.'
                        )}
                      />
                      <select
                        className={`${T.select} w-full`}
                        data-capacity-mode={m.id}
                        aria-label={tr('تتبّع سعة الطلب المسبق', 'Pre-order capacity tracking')}
                        value={pre.capacity === null ? 'untracked' : 'tracked'}
                        onChange={(e) =>
                          update(m.id, 'pre_order', {
                            capacity: e.target.value === 'tracked' ? pre.capacity ?? 0 : null,
                          })
                        }
                      >
                        <option value="untracked">{tr('غير محدودة (غير مُتتبعة)', 'Unlimited (untracked)')}</option>
                        <option value="tracked">{tr('كمية محدّدة', 'A set quota')}</option>
                      </select>
                      {pre.capacity === null ? (
                        <p className={`text-[11px] leading-relaxed ${T.text3}`}>
                          {tr(
                            'لا حدّ لعدد الطلبات المسبقة، ولا يُحجز شيء.',
                            'No limit is claimed, nothing is held, and the pre-order stays sellable.'
                          )}
                        </p>
                      ) : (
                        <>
                          <Units
                            value={pre.capacity}
                            onChange={(n) => update(m.id, 'pre_order', { capacity: n })}
                            label={tr('سعة الطلب المسبق', 'Pre-order capacity')}
                          />
                          <p className={`text-[11px] leading-relaxed ${T.text3}`}>
                            {tr('٠ يعني: لا يوجد متاح الآن، ويُرفض الطلب المسبق.', '0 means none available right now — a pre-order is refused.')}
                          </p>
                        </>
                      )}
                      {pre.capacity_reserved > 0 ? (
                        <p className={`text-[11px] leading-relaxed ${T.text2}`} data-capacity-held={m.id}>
                          {tr(
                            `محجوز الآن لطلبات قائمة: ${pre.capacity_reserved}`,
                            `Held now for live orders: ${pre.capacity_reserved}`
                          )}
                        </p>
                      ) : null}
                    </div>

                    {/* ------------------------------- ONE SUB-CARD PER ROUTE */}
                    <div>
                      <L
                        ar="طرق وصول الجهاز إلى العراق"
                        en="How the unit reaches Iraq"
                        hint={tr(
                          'ليست طريقة التوصيل داخل العراق — تلك تُضبط في «خيارات التوصيل».',
                          'Not delivery inside Iraq — that is set under Delivery options.'
                        )}
                      />
                      <div className="flex flex-wrap gap-1.5 mt-1">
                        {METHODS.map((mm) => {
                          const on = pre.transports.some((t) => t.method === mm.id);
                          return (
                            <button
                              key={mm.id}
                              type="button"
                              aria-pressed={on}
                              onClick={() => toggleTransport(m.id, mm.id)}
                              className={T.chip}
                            >
                              {mm.icon}
                              <span className="ms-1">{ar ? mm.ar : mm.en}</span>
                              {on ? <Check className="w-3 h-3 ms-1" /> : null}
                            </button>
                          );
                        })}
                      </div>
                      <div className="mt-2">
                        {pre.transports
                          .slice()
                          .sort((a, b) => METHODS.findIndex((x) => x.id === a.method) - METHODS.findIndex((x) => x.id === b.method))
                          .map((t) => {
                            const meta = METHODS.find((x) => x.id === t.method)!;
                            return (
                              /* A ROW, NOT A CARD. Three routes stacked as
                                 three tinted rectangles inside a section
                                 inside a card was the third frame in a row;
                                 a divided list says "these are siblings"
                                 with one hairline. */
                              <div key={t.method} className="py-2 first:pt-0 border-t first:border-t-0 border-[var(--ap-hairline)]">
                                <div className="flex items-center justify-between gap-2 mb-1.5">
                                  <span className={`text-[12px] font-bold ${T.text1}`}>{ar ? meta.ar : meta.en}</span>
                                  <button
                                    type="button"
                                    className={T.btnIconGhost}
                                    onClick={() => toggleTransport(m.id, t.method)}
                                    aria-label={tr('إزالة', 'Remove')}
                                  >
                                    <X className="w-3.5 h-3.5" />
                                  </button>
                                </div>
                                <Toggle
                                  label={tr('معروض الآن', 'Offered now')}
                                  checked={t.enabled}
                                  onChange={(v) => updateTransport(m.id, t.method, { enabled: v })}
                                />
                                <div className="mt-1.5">
                                  <L
                                    ar="زيادة هذه الطريقة"
                                    en="This route’s surcharge"
                                    hint={tr('فارغ = زيادة المنتج.', 'Empty = use the product’s.')}
                                  />
                                  <NullableIqd
                                    value={t.surcharge_iqd}
                                    onChange={(v) => updateTransport(m.id, t.method, { surcharge_iqd: v })}
                                    placeholder={tr('زيادة المنتج', 'the product’s')}
                                  />
                                  <MirrorNote kind="replaces" where="٤ البيع والتوفر والمخزون" detail="لهذه الطريقة وحدها" />
                                </div>
                                {/* ───────── SHARED POOL, OR THIS ROUTE'S OWN.
                                    The consequence is written under the choice
                                    because it is the whole rule: one counter
                                    per sale, never two. */}
                                <div className="mt-1.5">
                                  <L ar="كمية هذه الطريقة" en="This route’s quota" />
                                  <select
                                    className={`${T.select} w-full`}
                                    data-route-capacity-mode={`${m.id}|${t.method}`}
                                    aria-label={tr('كمية هذه الطريقة', 'This route’s quota')}
                                    value={t.capacity === null ? 'shared' : 'own'}
                                    onChange={(e) =>
                                      updateTransport(m.id, t.method, {
                                        capacity: e.target.value === 'own' ? t.capacity ?? 0 : null,
                                      })
                                    }
                                  >
                                    <option value="shared">{tr('تسحب من السعة المشتركة', 'Draws on the shared capacity')}</option>
                                    <option value="own">{tr('كمية خاصة بهذه الطريقة', 'Its own quota')}</option>
                                  </select>
                                  <p className={`mt-1 text-[11px] leading-relaxed ${T.text3}`}>
                                    {t.capacity === null
                                      ? tr(
                                          'بيع وحدة جوًا يُنقص المتاح بحرًا وبرًا — عدّاد واحد مشترك.',
                                          'Selling one by air leaves one fewer by sea and by land — one shared counter.'
                                        )
                                      : tr(
                                          'هذه الطريقة تملك كميتها ولا تمسّ السعة المشتركة.',
                                          'This route holds its own quota and never spends the shared capacity.'
                                        )}
                                  </p>
                                  {t.capacity !== null ? (
                                    <div className="mt-1.5">
                                      <Units
                                        value={t.capacity}
                                        onChange={(n) => updateTransport(m.id, t.method, { capacity: n })}
                                        label={tr('كمية هذه الطريقة', 'This route’s quota')}
                                      />
                                    </div>
                                  ) : null}
                                  {t.capacity_reserved > 0 ? (
                                    <p className={`mt-1 text-[11px] leading-relaxed ${T.text2}`}>
                                      {tr(
                                        `محجوز على هذه الطريقة: ${t.capacity_reserved}`,
                                        `Held on this route: ${t.capacity_reserved}`
                                      )}
                                    </p>
                                  ) : null}
                                </div>
                                <div className="mt-1.5">
                                  <L ar="مدة هذه الطريقة" en="This route’s lead time" />
                                  <input
                                    className={inputCls}
                                    value={t.lead_time_text}
                                    onChange={(e) => updateTransport(m.id, t.method, { lead_time_text: e.target.value })}
                                    placeholder={tr('فارغ = مدة الطلب المسبق أعلاه', 'Empty = the pre-order’s lead time')}
                                  />
                                </div>
                              </div>
                            );
                          })}
                      </div>
                      {pre.transports.length > 1 ? (
                        <p className={`mt-1.5 text-[11px] leading-relaxed ${T.text3}`} data-no-auto-copy>
                          {tr(
                            'الكمية لا تُنسخ تلقائيًا على الطرق الثلاث — كل طريقة تُضبط وحدها.',
                            'A quantity is never copied onto the three routes — each one is set on its own.'
                          )}
                        </p>
                      ) : null}
                    </div>
                  </div>
                ) : null}
              </div>
            </div>
          </div>
        );
      })}

      <div className="flex items-center justify-end gap-2 pt-1">
        <button type="button" className={T.btnPrimary} onClick={() => void save()} disabled={saving}>
          {saving ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : null}
          {tr('حفظ أنواع الطلب', 'Save order types')}
        </button>
      </div>
    </div>
  );
}

/**
 * A COUNT THAT CANNOT MEAN "UNLIMITED".
 *
 * `Money`/`Qty` emit `null` for an empty box, which is right for a price that
 * inherits and wrong for a counter: here an empty box is ZERO — tracked, and
 * nothing left — because the untracked state is reached from the select beside
 * it and nowhere else. The text is kept locally while typing so a half-typed
 * number is not snapped under the admin's finger.
 */
function Units({ value, onChange, label }: { value: number; onChange: (n: number) => void; label: string }) {
  const [text, setText] = useState(String(value));
  const [touched, setTouched] = useState(false);
  useEffect(() => {
    if (!touched) setText(String(value));
  }, [value, touched]);
  return (
    <input
      dir="ltr"
      inputMode="numeric"
      aria-label={label}
      className={inputCls}
      value={text}
      onChange={(e) => {
        const raw = e.target.value.replace(/[^\d]/g, '');
        setTouched(true);
        setText(raw);
        onChange(raw === '' ? 0 : Number(raw));
      }}
      onBlur={() => {
        setTouched(false);
        setText(String(value));
      }}
    />
  );
}

function Toggle({ label, checked, onChange }: { label: string; checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <label className="flex items-center gap-2 cursor-pointer select-none">
      <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} className="h-4 w-4 accent-[var(--ap-accent)]" />
      <span className={`text-[12px] ${T.text2}`}>{label}</span>
    </label>
  );
}
