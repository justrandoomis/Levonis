/**
 * «التسعير بالدولار والشحن» — THE PRODUCT'S USD PRICING INPUTS, WHERE THE
 * PRODUCT IS ADDED OR EDITED (owner brief 2026-10-09; the owner's request of
 * the same day: pricing and shipping belong in the product's prices section
 * and in its options' prices, not only in the procurement card).
 *
 * Two mount points, one state (`UsdPricingProvider`):
 *   - section ٣ «الأسعار»: the product level — supplier cost and currency, the
 *     base shipping route, the packed weight or volume, additional costs, the
 *     minimum profit in USD and the Direct Sale Extra — with the 4-cell bar;
 *   - section ٥ «الخيارات والألوان»: the same fields per model, each empty field
 *     inheriting the product's value, each model with its own bar. A colour
 *     follows its model until per-colour pricing exists (FX-7).
 *
 * THERE IS NO SECOND PERSISTENCE PATH. The values are private (owner only) and
 * save through the pricing door (`PUT /api/admin/pricing/products/:id/inputs`):
 * one atomic, version-fenced, audited batch — never with the product document,
 * whose body is not a place for private cost values. Every figure on screen is
 * the server's (E1 at the central rates); the screen formats and never computes
 * money. Saving writes the pricing DATA only: the store price stays as it is
 * until the engine applies the new price.
 */
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Loader2, Save } from 'lucide-react';
import { ApiError, api, isAborted } from '../../../lib/api';
import { useLanguage } from '../../../LanguageContext';
import PricingSummaryBar from '../../adminOperations/PricingSummaryBar';
import type { PricingSummary } from '../../adminOperations/procurementPricing';
import { procurementPricingStrings, profileName } from '../../adminOperations/procurementPricingStrings';
import { Banner, Field, Grid, Money, Select, TextInput, btnGhost, btnPrimary } from './formUi';
import { USD_PRICING_FORM_STRINGS, usdPricingFormStrings } from './usdPricingStrings';

const PRICING = '/api/admin/pricing';
const CURRENCIES = ['USD', 'EUR', 'CNY'] as const;
const ROUTES = ['GERMANY_LAND', 'CHINA_AIR', 'CHINA_SEA'] as const;

interface StoredInputs {
  supplier_cost_amount: string | null;
  supplier_cost_currency: string | null;
  supplier_input_mode: string | null;
  shipping_profile: string | null;
  shipping_weight_g: number | null;
  pricing_weight_g: number | null;
  manual_cbm: string | null;
  additional_cost_iqd: number | null;
  source_ref: string;
}

interface ScopeAnswer {
  scope: 'base' | 'option';
  scope_id: string;
  name_ar: string;
  name_en: string;
  name_ckb: string;
  pricing_inputs: StoredInputs | null;
  minimum_target_profit_usd: string | null;
  target_profit_iqd: number | null;
  target_profit_state: string | null;
  direct_sale_extra_iqd: number | null;
  direct_sale_extra_state: string | null;
}

interface ModelAnswer {
  option_id: string;
  name_ar: string;
  name_en: string;
  name_ckb: string;
  sells_direct: boolean;
  pricing_summary: PricingSummary;
}

export interface UsdPricingAnswer {
  product_id: string;
  mode: 'manual' | 'engine';
  inputs_seq: number;
  rates: { usd_iqd_rate: string | null; review_pending: boolean; derived_stale: boolean };
  scopes: ScopeAnswer[];
  models: ModelAnswer[];
}

/** What the owner typed for one scope, as text (absent = untouched). */
export interface ScopeDraft {
  supplier_cost_amount?: string;
  supplier_cost_currency?: string;
  shipping_profile?: string;
  weight_kg?: string;
  manual_cbm?: string;
  additional_cost_iqd?: number | null;
  minimum_target_profit_usd?: string;
  direct_sale_extra_iqd?: number | null;
}

const keyOf = (scope: 'base' | 'option', id: string) => (scope === 'base' ? 'base' : `option:${id}`);

/** Kilograms as typed → whole grams, exactly (≤ 3 decimals; Arabic-Indic digits and a decimal comma accepted). */
export function kgToGrams(text: string): number | null | 'invalid' {
  const t = text.trim().replace(/[٠-٩]/g, (d) => String(d.charCodeAt(0) - 0x0660)).replace(/[۰-۹]/g, (d) => String(d.charCodeAt(0) - 0x06f0)).replace(/[,٫]/g, '.');
  if (t === '') return null;
  const m = /^(\d{1,6})(?:\.(\d{1,3}))?$/.exec(t);
  if (!m) return 'invalid';
  const grams = Number(m[1]) * 1000 + Number((m[2] ?? '').padEnd(3, '0') || '0');
  return grams >= 1 ? grams : 'invalid';
}

const gramsToKg = (g: number | null | undefined) => (g == null ? '' : (g / 1000).toLocaleString('en-US', { maximumFractionDigits: 3, useGrouping: false }));
const DECIMAL = /^[0-9٠-٩۰-۹]+(?:[.,٫][0-9٠-٩۰-۹]+)?$/;
const USD_TEXT = /^[0-9٠-٩۰-۹]+(?:[.,٫][0-9٠-٩۰-۹]{1,2})?$/;

/** A draft's problems, by field (the server refuses the same, by field). */
export function draftProblems(d: ScopeDraft): Partial<Record<keyof ScopeDraft, true>> {
  const out: Partial<Record<keyof ScopeDraft, true>> = {};
  if (d.supplier_cost_amount !== undefined && d.supplier_cost_amount.trim() !== '' && !DECIMAL.test(d.supplier_cost_amount.trim())) out.supplier_cost_amount = true;
  if (d.weight_kg !== undefined && kgToGrams(d.weight_kg) === 'invalid') out.weight_kg = true;
  if (d.manual_cbm !== undefined && d.manual_cbm.trim() !== '' && !DECIMAL.test(d.manual_cbm.trim())) out.manual_cbm = true;
  if (d.minimum_target_profit_usd !== undefined && d.minimum_target_profit_usd.trim() !== '' && !USD_TEXT.test(d.minimum_target_profit_usd.trim())) out.minimum_target_profit_usd = true;
  if (d.direct_sale_extra_iqd != null && d.direct_sale_extra_iqd % 1000 !== 0) out.direct_sale_extra_iqd = true;
  return out;
}

const blank = (v: string | undefined) => (v === undefined ? undefined : v.trim() === '' ? null : v.trim());

/** The drafts → the request's `{inputs, rules}` (only what was touched). */
export function draftWire(drafts: Record<string, ScopeDraft>, answer: UsdPricingAnswer) {
  const inputs: Array<Record<string, unknown>> = [];
  const rules: Array<Record<string, unknown>> = [];
  for (const s of answer.scopes) {
    const d = drafts[keyOf(s.scope, s.scope_id)];
    if (!d) continue;
    const entry: Record<string, unknown> = { scope: s.scope, ...(s.scope === 'option' ? { scope_id: s.scope_id } : {}) };
    if (d.supplier_cost_amount !== undefined) entry.supplier_cost_amount = blank(d.supplier_cost_amount);
    if (d.supplier_cost_currency !== undefined) entry.supplier_cost_currency = d.supplier_cost_currency || null;
    // A typed amount always names its currency (the stored one when untouched, USD when none).
    if (d.supplier_cost_amount !== undefined && blank(d.supplier_cost_amount) !== null && entry.supplier_cost_currency == null)
      entry.supplier_cost_currency = s.pricing_inputs?.supplier_cost_currency ?? 'USD';
    if (d.shipping_profile !== undefined) entry.shipping_profile = d.shipping_profile || null;
    if (d.weight_kg !== undefined) {
      const g = kgToGrams(d.weight_kg);
      entry.shipping_weight_g = g === 'invalid' ? null : g;
    }
    if (d.manual_cbm !== undefined) entry.manual_cbm = blank(d.manual_cbm);
    if (d.additional_cost_iqd !== undefined) entry.additional_cost_iqd = d.additional_cost_iqd;
    if (Object.keys(entry).length > (s.scope === 'option' ? 2 : 1)) inputs.push(entry);
    const ruleScope = s.scope === 'base' ? 'product' : 'option';
    const at = s.scope === 'option' ? { scope_id: s.scope_id } : {};
    if (d.minimum_target_profit_usd !== undefined) rules.push({ kind: 'target_profit', scope: ruleScope, ...at, amount_usd: blank(d.minimum_target_profit_usd) });
    if (d.direct_sale_extra_iqd !== undefined) rules.push({ kind: 'direct_sale_extra', scope: ruleScope, ...at, amount_iqd: d.direct_sale_extra_iqd });
  }
  return { inputs, rules };
}

interface UsdPricingState {
  enabled: boolean;
  productId: string | null;
  answer: UsdPricingAnswer | null;
  /** The answer for the drafts (live preview), else the stored one. */
  shown: UsdPricingAnswer | null;
  drafts: Record<string, ScopeDraft>;
  dirty: boolean;
  invalid: boolean;
  busy: boolean;
  saving: boolean;
  notInstalled: boolean;
  error: string;
  notice: string;
  setDraft: (scope: 'base' | 'option', id: string, patch: ScopeDraft) => void;
  discard: () => void;
  save: () => Promise<void>;
  reload: () => void;
}

const Ctx = createContext<UsdPricingState | null>(null);

export function UsdPricingProvider({ productId, enabled, children }: { productId: string | null; enabled: boolean; children: ReactNode }) {
  const { lang } = useLanguage();
  const s = usdPricingFormStrings(lang);
  const [answer, setAnswer] = useState<UsdPricingAnswer | null>(null);
  const [preview, setPreview] = useState<UsdPricingAnswer | null>(null);
  const [drafts, setDrafts] = useState<Record<string, ScopeDraft>>({});
  const [busy, setBusy] = useState(false);
  const [saving, setSaving] = useState(false);
  const [notInstalled, setNotInstalled] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [tick, setTick] = useState(0);
  const live = enabled && !!productId;

  useEffect(() => {
    if (!live) return;
    const ctrl = new AbortController();
    setBusy(true);
    setError('');
    api
      .get<UsdPricingAnswer>(`${PRICING}/products/${encodeURIComponent(productId!)}/inputs`, { signal: ctrl.signal, mascot: 'silent' })
      .then((r) => {
        setAnswer(r);
        setPreview(null);
        setDrafts({});
      })
      .catch((e) => {
        if (isAborted(e)) return;
        if (e instanceof ApiError && e.code === 'PRICING_NOT_INSTALLED') setNotInstalled(true);
        else setError(e instanceof Error ? e.message : String(e));
      })
      .finally(() => {
        if (!ctrl.signal.aborted) setBusy(false);
      });
    return () => ctrl.abort();
  }, [live, productId, tick]);

  const dirty = Object.keys(drafts).length > 0;
  const invalid = Object.values(drafts).some((d) => Object.keys(draftProblems(d)).length > 0);
  const wire = useMemo(() => (answer && dirty && !invalid ? JSON.stringify(draftWire(drafts, answer)) : ''), [answer, drafts, dirty, invalid]);

  // The live preview: the server prices the drafts as they would be saved (debounced, latest wins).
  useEffect(() => {
    if (!live || !wire) {
      setPreview(null);
      return;
    }
    const ctrl = new AbortController();
    const timer = setTimeout(() => {
      setBusy(true);
      api
        .post<UsdPricingAnswer>(`${PRICING}/products/${encodeURIComponent(productId!)}/preview`, { draft: JSON.parse(wire) }, { signal: ctrl.signal, mascot: 'silent' })
        .then((r) => {
          setPreview(r);
          setError('');
        })
        .catch((e) => {
          if (isAborted(e)) return;
          setError(e instanceof Error ? e.message : String(e));
        })
        .finally(() => {
          if (!ctrl.signal.aborted) setBusy(false);
        });
    }, 450);
    return () => {
      clearTimeout(timer);
      ctrl.abort();
    };
  }, [live, productId, wire]);

  const setDraft = useCallback((scope: 'base' | 'option', id: string, patch: ScopeDraft) => {
    setNotice('');
    setDrafts((all) => ({ ...all, [keyOf(scope, id)]: { ...all[keyOf(scope, id)], ...patch } }));
  }, []);
  const discard = useCallback(() => {
    setDrafts({});
    setPreview(null);
    setError('');
  }, []);
  const saveRef = useRef(false);
  const save = useCallback(async () => {
    if (!answer || !productId || saveRef.current || invalid) return;
    saveRef.current = true;
    setSaving(true);
    setError('');
    try {
      const body = { inputs_seq: answer.inputs_seq, ...draftWire(drafts, answer) };
      const r = await api.put<UsdPricingAnswer>(`${PRICING}/products/${encodeURIComponent(productId)}/inputs`, body, { mascot: 'silent' });
      setAnswer(r);
      setPreview(null);
      setDrafts({});
      setNotice(s.saved);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      // Someone else saved first (a purchase applied, another tab): show the fresh values, keep the typed ones.
      if (e instanceof ApiError && e.code === 'PRICING_CHANGED') {
        try {
          const fresh = await api.get<UsdPricingAnswer>(`${PRICING}/products/${encodeURIComponent(productId)}/inputs`, { mascot: 'silent' });
          setAnswer(fresh);
        } catch {
          /* the message above stands */
        }
      }
    } finally {
      saveRef.current = false;
      setSaving(false);
    }
  }, [answer, productId, drafts, invalid, s.saved]);

  const value: UsdPricingState = {
    enabled: live,
    productId,
    answer,
    shown: preview ?? answer,
    drafts,
    dirty,
    invalid,
    busy,
    saving,
    notInstalled,
    error,
    notice,
    setDraft,
    discard,
    save,
    reload: () => setTick((t) => t + 1),
  };
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

const useUsdPricing = () => useContext(Ctx);

const nameOf = (x: { name_ar: string; name_en: string; name_ckb: string }, lang: string) =>
  (lang === 'en' ? x.name_en || x.name_ar : lang === 'ckb' ? x.name_ckb || x.name_ar : x.name_ar || x.name_en) || '—';

/** The fields of one scope; an option shows the product's values as its "inherits" placeholders. */
function ScopeFields({ scope, base }: { scope: ScopeAnswer; base: ScopeAnswer | null }) {
  const { lang } = useLanguage();
  const s = usdPricingFormStrings(lang);
  const en = USD_PRICING_FORM_STRINGS.en;
  const state = useUsdPricing()!;
  const d = state.drafts[keyOf(scope.scope, scope.scope_id)] ?? {};
  const stored = scope.pricing_inputs;
  const inherited = base?.pricing_inputs ?? null;
  const problems = draftProblems(d);
  const label = (ar: string, english: string) => ({ ar, en: lang === 'en' ? '' : english });
  const ph = (v: string | null | undefined) => (scope.scope === 'option' && v ? s.inheritPlaceholder(v) : undefined);
  const set = (patch: ScopeDraft) => state.setDraft(scope.scope, scope.scope_id, patch);
  const route = d.shipping_profile !== undefined ? d.shipping_profile : (stored?.shipping_profile ?? inherited?.shipping_profile ?? '');
  const volume = route === 'CHINA_SEA';
  const currency = d.supplier_cost_currency ?? stored?.supplier_cost_currency ?? (scope.scope === 'option' ? (inherited?.supplier_cost_currency ?? '') : '');
  const minProfit = d.minimum_target_profit_usd ?? scope.minimum_target_profit_usd ?? '';
  const baseMin = base?.minimum_target_profit_usd ? `$${base.minimum_target_profit_usd}` : null;
  return (
    <Grid cols={3}>
      <Field {...label(s.supplierCost, en.supplierCost)} error={problems.supplier_cost_amount ? s.decimalInvalid : null}>
        <TextInput inputMode="decimal" value={d.supplier_cost_amount ?? stored?.supplier_cost_amount ?? ''} placeholder={ph(inherited?.supplier_cost_amount ? `${inherited.supplier_cost_amount} ${inherited.supplier_cost_currency ?? ''}` : null)} onChange={(e) => set({ supplier_cost_amount: e.target.value })} />
      </Field>
      <Field {...label(s.supplierCurrency, en.supplierCurrency)}>
        <Select value={currency} onChange={(e) => set({ supplier_cost_currency: e.target.value })}>
          <option value="">{scope.scope === 'option' ? s.inheritPlaceholder(inherited?.supplier_cost_currency ?? '—') : '—'}</option>
          {CURRENCIES.map((c) => <option key={c} value={c}>{c}</option>)}
        </Select>
      </Field>
      <Field {...label(s.route, en.route)}>
        <Select value={d.shipping_profile ?? stored?.shipping_profile ?? ''} onChange={(e) => set({ shipping_profile: e.target.value })}>
          <option value="">{scope.scope === 'option' && inherited?.shipping_profile ? s.inheritPlaceholder(profileName(inherited.shipping_profile, lang)) : s.routeNone}</option>
          {ROUTES.map((r) => <option key={r} value={r}>{profileName(r, lang)}</option>)}
        </Select>
      </Field>
      {volume ? (
        <Field {...label(s.volumeCbm, en.volumeCbm)} error={problems.manual_cbm ? s.decimalInvalid : null}>
          <TextInput inputMode="decimal" value={d.manual_cbm ?? stored?.manual_cbm ?? ''} placeholder={ph(inherited?.manual_cbm)} onChange={(e) => set({ manual_cbm: e.target.value })} />
        </Field>
      ) : (
        <Field {...label(s.weightKg, en.weightKg)} error={problems.weight_kg ? s.weightInvalid : null} hint={stored?.pricing_weight_g != null ? s.pricingWeightWins : undefined}>
          <TextInput inputMode="decimal" value={d.weight_kg ?? gramsToKg(stored?.shipping_weight_g)} placeholder={ph(inherited?.shipping_weight_g != null ? gramsToKg(inherited.shipping_weight_g) : null)} onChange={(e) => set({ weight_kg: e.target.value })} />
        </Field>
      )}
      <Field {...label(s.additional, en.additional)}>
        <Money value={d.additional_cost_iqd !== undefined ? d.additional_cost_iqd : (stored?.additional_cost_iqd ?? null)} placeholder={ph(inherited?.additional_cost_iqd != null ? String(inherited.additional_cost_iqd) : null)} onChange={(v) => set({ additional_cost_iqd: v })} />
      </Field>
      <Field {...label(s.minProfit, en.minProfit)} error={problems.minimum_target_profit_usd ? procurementPricingStrings(lang).invalid : null} hint={s.minProfitHint}>
        <TextInput inputMode="decimal" value={minProfit} placeholder={ph(baseMin) ?? (scope.target_profit_iqd != null ? `${scope.target_profit_iqd.toLocaleString('en-US')} IQD` : undefined)} onChange={(e) => set({ minimum_target_profit_usd: e.target.value })} />
      </Field>
      <Field {...label(s.extra, en.extra)} error={problems.direct_sale_extra_iqd ? s.extraInvalid : null} hint={s.extraHint}>
        <Money value={d.direct_sale_extra_iqd !== undefined ? d.direct_sale_extra_iqd : scope.direct_sale_extra_iqd} placeholder={ph(base?.direct_sale_extra_iqd != null ? String(base.direct_sale_extra_iqd) : null)} onChange={(v) => set({ direct_sale_extra_iqd: v })} />
      </Field>
    </Grid>
  );
}

function SaveRow() {
  const { lang } = useLanguage();
  const s = usdPricingFormStrings(lang);
  const st = useUsdPricing()!;
  return (
    <div className="mt-3 flex flex-wrap items-center gap-2">
      <button type="button" className={btnPrimary} disabled={!st.dirty || st.invalid || st.saving} onClick={() => void st.save()}>
        {st.saving ? <Loader2 className="w-4 h-4 animate-spin" aria-hidden="true" /> : <Save className="w-4 h-4" aria-hidden="true" />}
        {s.save}
      </button>
      {st.dirty && <button type="button" className={btnGhost} disabled={st.saving} onClick={st.discard}>{s.discard}</button>}
      <span className="text-[11px] text-zinc-500">{st.dirty ? s.unsaved : s.saveHint}</span>
      {st.notice && <span role="status" className="text-[12px] text-emerald-400">{st.notice}</span>}
    </div>
  );
}

function Status() {
  const { lang } = useLanguage();
  const s = usdPricingFormStrings(lang);
  const ps = procurementPricingStrings(lang);
  const st = useUsdPricing()!;
  return (
    <>
      {st.shown?.rates.review_pending && st.shown.rates.usd_iqd_rate && <Banner kind="warn">{ps.reviewBanner(st.shown.rates.usd_iqd_rate)}</Banner>}
      {st.error && (
        <Banner kind="error">
          {st.error}{' '}
          {!st.answer && <button type="button" className="underline" onClick={st.reload}>{s.retry}</button>}
        </Banner>
      )}
    </>
  );
}

/** Section ٣: the product level and its bar. */
export function UsdPricingProductPanel() {
  const { lang } = useLanguage();
  const s = usdPricingFormStrings(lang);
  const ps = procurementPricingStrings(lang);
  const st = useUsdPricing();
  if (!st) return null;
  const head = (
    <h4 className="text-[13px] font-bold text-zinc-200">
      {s.formTitle} {lang !== 'en' && <span className="text-[10px] font-medium text-zinc-500">{USD_PRICING_FORM_STRINGS.en.formTitle}</span>}
    </h4>
  );
  if (!st.productId) return <div className="ap mt-4 rounded-xl border border-zinc-800 p-3" data-form="usd-pricing">{head}<p className="mt-1 text-[12px] text-zinc-500">{s.saveFirst}</p></div>;
  if (!st.enabled) return null;
  if (st.notInstalled) return <div className="ap mt-4 rounded-xl border border-zinc-800 p-3" data-form="usd-pricing">{head}<p className="mt-1 text-[12px] text-zinc-500">{ps.notInstalled}</p></div>;
  const base = st.answer?.scopes.find((x) => x.scope === 'base') ?? null;
  const models = st.shown?.models ?? [];
  // A product with one model shows that model's bar here; several models show theirs under options.
  const productModel = models.length === 1 ? models[0]! : null;
  const ok = models.filter((m) => m.pricing_summary.state === 'ok').length;
  return (
    <div className="ap mt-4 rounded-xl border border-zinc-800 p-3" data-form="usd-pricing">
      {head}
      <p className="mt-1 mb-3 text-[12px] text-zinc-500">{s.formIntro}</p>
      <Status />
      {!st.answer ? (
        <p role="status" className="text-[12px] text-zinc-500">{st.busy ? s.loading : ''}</p>
      ) : (
        <>
          {base && <ScopeFields scope={base} base={null} />}
          {productModel ? (
            <PricingSummaryBar summary={productModel.pricing_summary} label={s.productLevel} busy={st.busy && st.dirty} />
          ) : (
            models.length > 0 && <p className="mt-3 text-[12px] text-zinc-400">{s.modelsSummary(String(ok), String(models.length))}</p>
          )}
          <p className="mt-2 text-[11px] text-zinc-500">{s.pricesLater}</p>
          <SaveRow />
        </>
      )}
    </div>
  );
}

/** Section ٥: each model's own values (empty = the product's) and its bar. */
export function UsdPricingOptionsPanel({ formModelIds = [] }: { formModelIds?: readonly string[] }) {
  const { lang } = useLanguage();
  const s = usdPricingFormStrings(lang);
  const st = useUsdPricing();
  if (!st || !st.enabled || st.notInstalled || !st.answer) return null;
  const base = st.answer.scopes.find((x) => x.scope === 'base') ?? null;
  const options = st.answer.scopes.filter((x) => x.scope === 'option');
  // A model typed in this form and not saved yet has no pricing scope until the product is saved.
  const unsavedModels = formModelIds.some((id) => !options.some((o) => o.scope_id === id));
  if (!options.length && !unsavedModels) return null;
  return (
    <div className="ap mt-4 rounded-xl border border-zinc-800 p-3" data-form="usd-pricing-options">
      <h4 className="text-[13px] font-bold text-zinc-200">
        {s.optionsTitle} {lang !== 'en' && <span className="text-[10px] font-medium text-zinc-500">{USD_PRICING_FORM_STRINGS.en.optionsTitle}</span>}
      </h4>
      <p className="mt-1 mb-3 text-[12px] text-zinc-500">{s.optionsIntro}</p>
      <Status />
      {unsavedModels && <p className="mb-2 text-[12px] text-zinc-500">{s.newOptionsSaveFirst}</p>}
      <div className="grid gap-3">
        {options.map((o) => {
          const model = st.shown?.models.find((m) => m.option_id === o.scope_id) ?? null;
          const name = nameOf(o, lang);
          const touched = !!st.drafts[keyOf('option', o.scope_id)];
          return (
            <div key={o.scope_id} className="rounded-lg border border-zinc-800 px-3 py-2" data-usd-model={o.scope_id}>
              <p className="text-[13px] font-semibold text-zinc-200">{name}</p>
              {model && <PricingSummaryBar summary={model.pricing_summary} label={name} busy={st.busy && touched} />}
              <details className="mt-2" open={touched || undefined}>
                <summary className="cursor-pointer text-[12px] text-zinc-400">{s.edit}</summary>
                <div className="mt-3">
                  <ScopeFields scope={o} base={base} />
                </div>
              </details>
            </div>
          );
        })}
      </div>
      <SaveRow />
    </div>
  );
}
