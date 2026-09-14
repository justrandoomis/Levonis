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
 */
import React, { useCallback, useEffect, useState } from 'react';
import { Check, Loader2, Plane, Ship, Truck, X } from 'lucide-react';
import { ApiError, api } from '../../lib/api';
import { useLanguage } from '../../LanguageContext';
import * as T from './theme';
import { ErrorBanner, L, NullableIqd, SignedIqd, inputCls } from './ui';

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
  lead_time_text: string;
  lead_time_min_days: number | null;
  lead_time_max_days: number | null;
}

interface Cell {
  option_id: string;
  fulfillment_type: FulfillmentType;
  enabled: boolean;
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
      lead_time_text: String(t.lead_time_text ?? ''),
      lead_time_min_days: num(t.lead_time_min_days),
      lead_time_max_days: num(t.lead_time_max_days),
    })),
  };
}

const key = (optionId: string, type: FulfillmentType) => `${optionId}|${type}`;

export default function FulfillmentPanel({ productId }: { productId: string }) {
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
      const res = await api.get<LoadResponse>(`/api/admin/products-v2/${productId}/fulfillment`);
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
            { method, enabled: true, surcharge_iqd: null, lead_time_text: '', lead_time_min_days: null, lead_time_max_days: null },
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
      }));
      const res = await api.put<{ sale_types: string[] }>(`/api/admin/products-v2/${productId}/fulfillment`, {
        fulfillments: payload,
      });
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
        return (
          <div key={m.id} className="rounded-[var(--ap-radius-md)] border border-[var(--ap-border)] bg-[var(--ap-surface-1)] p-3">
            <div className="flex items-center justify-between gap-2 mb-2.5">
              <span className={`font-bold text-[14px] ${T.text1}`}>{ar ? m.name_ar || m.name_en : m.name_en}</span>
              <span className={`text-[11px] ${T.text3}`}>
                {m.stock === null
                  ? tr('المخزون: غير مُتتبع', 'Stock: not tracked')
                  : tr(`المخزون: ${m.stock}`, `Stock: ${m.stock}`)}
              </span>
            </div>

            <div className="grid gap-2.5 md:grid-cols-2">
              {/* ---------------------------------------------- DIRECT SALE */}
              <div className="rounded-[var(--ap-radius-sm)] border border-[var(--ap-border)] p-2.5">
                <label className="flex items-center gap-2 cursor-pointer select-none mb-2">
                  <input
                    type="checkbox"
                    checked={!!direct}
                    onChange={() => toggleCell(m.id, 'direct_sale')}
                    className="h-4 w-4 accent-[var(--ap-accent)]"
                  />
                  <span className={`font-bold text-[13px] ${T.text1}`}>{tr('بيع مباشر', 'Direct sale')}</span>
                </label>
                {direct ? (
                  <div className="space-y-2">
                    <Toggle
                      label={tr('معروض الآن', 'Offered now')}
                      checked={direct.enabled}
                      onChange={(v) => update(m.id, 'direct_sale', { enabled: v })}
                    />
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
              <div className="rounded-[var(--ap-radius-sm)] border border-[var(--ap-border)] p-2.5">
                <label className="flex items-center gap-2 cursor-pointer select-none mb-2">
                  <input
                    type="checkbox"
                    checked={!!pre}
                    onChange={() => toggleCell(m.id, 'pre_order')}
                    className="h-4 w-4 accent-[var(--ap-accent)]"
                  />
                  <span className={`font-bold text-[13px] ${T.text1}`}>{tr('طلب مسبق', 'Pre-order')}</span>
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
                      <div className="space-y-2 mt-2">
                        {pre.transports
                          .slice()
                          .sort((a, b) => METHODS.findIndex((x) => x.id === a.method) - METHODS.findIndex((x) => x.id === b.method))
                          .map((t) => {
                            const meta = METHODS.find((x) => x.id === t.method)!;
                            return (
                              <div key={t.method} className="rounded-[var(--ap-radius-sm)] bg-[var(--ap-surface-2)] p-2">
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
                                    hint={tr(
                                      'تحلّ محل زيادة المنتج لهذه الطريقة ولا تُضاف إليها. فارغ = زيادة المنتج.',
                                      'REPLACES the product’s surcharge for this route — never adds to it. Empty = use the product’s.'
                                    )}
                                  />
                                  <NullableIqd
                                    value={t.surcharge_iqd}
                                    onChange={(v) => updateTransport(m.id, t.method, { surcharge_iqd: v })}
                                    placeholder={tr('زيادة المنتج', 'the product’s')}
                                  />
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

function Toggle({ label, checked, onChange }: { label: string; checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <label className="flex items-center gap-2 cursor-pointer select-none">
      <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} className="h-4 w-4 accent-[var(--ap-accent)]" />
      <span className={`text-[12px] ${T.text2}`}>{label}</span>
    </label>
  );
}
