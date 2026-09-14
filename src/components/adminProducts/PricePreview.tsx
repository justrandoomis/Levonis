/**
 * Live price preview (admin) — asks POST /api/admin/products-v2/:id/quote,
 * which runs the central resolver server-side. Shows the full breakdown
 * including cost (admin-only endpoint). The quote reflects the last SAVED
 * version of the product; an honest note appears when the form is dirty.
 */

import React, { useEffect, useState } from 'react';
import { RefreshCw, AlertTriangle } from 'lucide-react';
import { api, ApiError, formatIqd } from '../../lib/api';
import type { ProductDocV2 } from '../../lib/productTypes';
import type { QuoteResponse } from './types';
import { hasRelationStructure, type RelationsState } from './form/model';
import { L, Section, inputCls } from './ui';

const ERROR_AR: Record<string, string> = {
  OPTION_NOT_FOUND: 'الخيار غير موجود',
  OPTION_INACTIVE: 'الخيار معطّل',
  COLOR_NOT_FOUND: 'اللون غير موجود',
  COLOR_INACTIVE: 'اللون معطّل',
  COLOR_OPTION_MISMATCH: 'اللون غير متاح مع هذا الخيار',
  TRANSPORT_REQUIRED: 'اختيار وسيلة الشحن مطلوب للطلب المسبق',
  TRANSPORT_NOT_OFFERED: 'وسيلة الشحن غير متاحة لهذا المنتج',
  TRANSPORT_COMMISSION_UNCONFIGURED: 'عمولة الشحن غير مُعدّة (لا قيمة للمنتج ولا افتراضي للإدارة)',
  TRANSPORT_NOT_APPLICABLE: 'لا شحن مسبق لمنتج بيع مباشر',
  WARRANTY_PLAN_NOT_FOUND: 'خطة الضمان غير موجودة',
  REGULAR_PRICE_INVALID: 'السعر الأساسي غير صالح',
};

const METHOD_AR: Record<string, string> = { air: 'جوي', sea: 'بحري', land: 'بري' };

export default function PricePreview({
  productId,
  savedDoc,
  rel,
  dirty,
}: {
  productId: string;
  savedDoc: ProductDocV2;
  /**
   * The structure the form is showing (rows, or the document's copy when no
   * rows exist). When given, the option / colour pickers list THAT, so the
   * preview and sections 5–6 can never disagree about what the product sells
   * (docs/TXT_IMPORT_PARITY.md §5.3.1); the document's JSON mirror is only
   * the fallback for a caller that has no relation state.
   */
  rel?: RelationsState;
  dirty: boolean;
}) {
  const fromRel = rel && hasRelationStructure(rel);
  const optionChoices = fromRel
    ? rel.groups.flatMap((g) => g.values.map((v) => ({ id: v.id, label: v.name_en || v.name_ar || v.id, active: v.active })))
    : (savedDoc.options ?? []).map((o) => ({ id: o.id, label: o.name_ar || o.name_en || o.id, active: o.active }));
  const colorChoices = fromRel
    ? rel.colors.map((c) => ({ id: c.id, label: c.name_en || c.name_ar || c.hex || c.id, active: c.active }))
    : (savedDoc.colors ?? []).map((c) => ({ id: c.id, label: c.name_ar || c.name_en || c.hex || c.id, active: c.active }));
  const [optionId, setOptionId] = useState('');
  const [colorId, setColorId] = useState('');
  const [transport, setTransport] = useState('');
  const [warrantyId, setWarrantyId] = useState('');
  const [tier, setTier] = useState<'free' | 'prime' | 'pro'>('free');
  const [quote, setQuote] = useState<QuoteResponse['quote'] | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    const t = setTimeout(async () => {
      try {
        const data = await api.post<QuoteResponse>(`/api/admin/products-v2/${productId}/quote`, {
          optionId: optionId || undefined,
          colorId: colorId || undefined,
          transportMethod: transport || undefined,
          warrantyPlanId: warrantyId || undefined,
          tier: tier === 'free' ? undefined : tier,
        });
        if (!cancelled) setQuote(data.quote);
      } catch (e) {
        if (!cancelled) {
          setQuote(null);
          setError(e instanceof ApiError ? e.message : 'تعذّر حساب السعر / quote failed');
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    }, 250);
    return () => { cancelled = true; clearTimeout(t); };
  }, [productId, optionId, colorId, transport, warrantyId, tier]);

  const activeTransports = (savedDoc.preorder_transports ?? []).filter((t) => t.active);

  return (
    <Section ar="معاينة السعر الحية" en="Live price preview" defaultOpen>
      {dirty && (
        <div className="flex items-start gap-2 bg-amber-500/10 border border-amber-500/30 text-amber-300 rounded-xl p-3 mb-4 text-xs">
          <AlertTriangle className="w-4 h-4 mt-0.5 shrink-0" />
          <span>
            المعاينة تُحسب من آخر نسخة محفوظة — احفظ أولاً لرؤية تعديلاتك.
            <span className="mx-1">Preview uses the last SAVED version; save to see your edits.</span>
          </span>
        </div>
      )}

      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-5 gap-3 mb-4">
        <div>
          <L ar="الخيار" en="Option" />
          <select value={optionId} onChange={(e) => setOptionId(e.target.value)} className={inputCls}>
            <option value="">بدون / none</option>
            {optionChoices.map((o) => (
              <option key={o.id} value={o.id}>{o.label + (o.active ? '' : ' (معطّل)')}</option>
            ))}
          </select>
        </div>
        <div>
          <L ar="اللون" en="Color" />
          <select value={colorId} onChange={(e) => setColorId(e.target.value)} className={inputCls}>
            <option value="">بدون / none</option>
            {colorChoices.map((c) => (
              <option key={c.id} value={c.id}>{c.label + (c.active ? '' : ' (معطّل)')}</option>
            ))}
          </select>
        </div>
        <div>
          <L ar="الشحن المسبق" en="Transport" />
          <select
            value={transport}
            onChange={(e) => setTransport(e.target.value)}
            className={inputCls}
            disabled={savedDoc.selling_type !== 'pre_order'}
          >
            <option value="">
              {savedDoc.selling_type === 'pre_order' ? 'اختر وسيلة / choose' : 'غير مطبق / n-a'}
            </option>
            {activeTransports.map((t) => (
              <option key={t.method} value={t.method}>{METHOD_AR[t.method] ?? t.method} / {t.method}</option>
            ))}
          </select>
        </div>
        <div>
          <L ar="الضمان" en="Warranty" />
          <select value={warrantyId} onChange={(e) => setWarrantyId(e.target.value)} className={inputCls}>
            <option value="">بدون / none</option>
            {(savedDoc.warranty_plans ?? []).filter((w) => w.active).map((w) => (
              <option key={w.id} value={w.id}>{w.title_ar || w.title_en || w.id}</option>
            ))}
          </select>
        </div>
        <div>
          <L ar="الفئة" en="Tier" />
          <div className="flex rounded-xl overflow-hidden border border-zinc-700">
            {(['free', 'prime', 'pro'] as const).map((t) => (
              <button
                key={t}
                type="button"
                onClick={() => setTier(t)}
                className={`flex-1 py-3 text-sm font-bold transition-colors ${
                  tier === t ? 'bg-[#6B46FF] text-white' : 'bg-zinc-800/40 text-zinc-400 hover:text-white'
                }`}
              >
                {t === 'free' ? 'عادي' : t === 'prime' ? 'PRIME' : 'PRO'}
              </button>
            ))}
          </div>
        </div>
      </div>

      {loading && (
        <div className="flex items-center gap-2 text-zinc-500 text-sm py-3">
          <RefreshCw className="w-4 h-4 animate-spin" /> جارٍ الحساب… / calculating…
        </div>
      )}
      {error && <div className="text-red-400 text-sm py-2">{error}</div>}

      {quote && !loading && (
        <div className="bg-zinc-900 border border-zinc-700 rounded-xl p-4">
          {quote.errors.length > 0 && (
            <div className="bg-red-500/10 border border-red-500/30 rounded-xl p-3 mb-3">
              <div className="text-red-400 text-sm font-bold mb-1">اختيار غير صالح / invalid selection</div>
              <ul className="text-red-300/90 text-xs list-disc ms-4">
                {quote.errors.map((e) => (
                  <li key={e}>{ERROR_AR[e] ?? e} <span className="text-red-400/60">({e})</span></li>
                ))}
              </ul>
            </div>
          )}

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-x-8 gap-y-2 text-sm">
            <Row ar="السعر العادي" en="regular" v={formatIqd(quote.regular_iqd)} />
            <Row
              ar="سعر PRO"
              en="pro"
              v={quote.pro_iqd === null ? 'لا خصم (لا سعر صريح ولا سياسة) / none' : formatIqd(quote.pro_iqd)}
              dim={quote.pro_iqd === null}
            />
            <Row
              ar="السعر المطبق"
              en={`applied (${quote.applied_tier})`}
              v={formatIqd(quote.applied_iqd)}
              strong
            />
            <Row ar="مصدر السعر" en="source" v={
              quote.price_source === 'color'
                ? 'اللون / color'
                : quote.price_source === 'transport'
                  ? 'الشحن / transport'
                  : quote.price_source === 'fulfillment'
                    ? 'نوع الطلب / order type'
                    : quote.price_source === 'option'
                      ? 'الخيار / option'
                      : 'الأساسي / base'
            } />
            {quote.prime_iqd !== null && (
              <Row ar="سعر PRIME" en="PRIME price" v={formatIqd(quote.prime_iqd)} />
            )}
            {quote.transport && (
              <Row
                ar={`عمولة الشحن (${METHOD_AR[quote.transport.method] ?? quote.transport.method})`}
                en="commission"
                v={
                  quote.transport.waived
                    ? `${formatIqd(quote.transport.commission_iqd)} — مُعفاة لعضو PRO / waived (PRO)`
                    : `+ ${formatIqd(quote.transport.commission_iqd)}`
                }
                dim={quote.transport.waived}
              />
            )}
            {quote.warranty && (
              <Row
                ar={`رسم الضمان (${quote.warranty.title_ar || quote.warranty.plan_id})`}
                en="warranty fee — never waived"
                v={`+ ${formatIqd(quote.warranty.fee_iqd)}`}
              />
            )}
            <Row ar="إجمالي الوحدة" en="unit subtotal" v={formatIqd(quote.unit_subtotal_iqd)} strong />
            {quote.cost_iqd !== null && quote.cost_iqd !== undefined && (
              <Row
                ar="الكلفة"
                en="cost — admin only, never public"
                v={formatIqd(quote.cost_iqd)}
                admin
              />
            )}
            <Row
              ar="بالدولار (تقريبي)"
              en={`USD @ ${quote.usd_preview.exchange_rate_iqd_per_usd}`}
              v={`$${quote.usd_preview.unit_subtotal_usd.toFixed(2)}`}
              dim
            />
          </div>
        </div>
      )}
    </Section>
  );
}

function Row({ ar, en, v, strong, dim, admin }: {
  ar: string; en: string; v: string; strong?: boolean; dim?: boolean; admin?: boolean;
}) {
  return (
    <div className="flex items-center justify-between gap-3 py-1 border-b border-zinc-800/60">
      <span className={`${dim ? 'text-zinc-500' : 'text-zinc-300'}`}>
        {ar} <span className="text-[10px] text-zinc-600 mx-1">{en}</span>
        {admin && (
          <span className="text-[9px] font-bold bg-red-500/10 text-red-400 border border-red-500/30 rounded px-1 py-0.5 mx-1">
            إداري فقط
          </span>
        )}
      </span>
      <span className={`${strong ? 'text-white font-bold' : dim ? 'text-zinc-500' : 'text-zinc-200'} whitespace-nowrap`} dir="ltr">
        {v}
      </span>
    </div>
  );
}
