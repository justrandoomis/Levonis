/**
 * «كم سيصبح السعر؟» — THE WHAT-IF CALCULATOR OF ONE PRODUCT (MVP plan §6 P1).
 *
 * The owner types a supplier cost and its currency — the one routine input of
 * the new pricing — and, if they want, a model, measures, an additional cost
 * and rates. The SERVER prices every model × channel with E1's exact maths
 * (`POST /what-if`) and answers; this panel shows each new price next to what
 * a customer pays today, the change, and that the minimum profit is kept.
 *
 * NOTHING IS SAVED. Not the cost, not the rates, not the measures: the
 * request is a question, and the panel says so above the button.
 *
 * NO PRICE IS COMPUTED HERE. Every figure in the answer is the server's. The
 * client only validates the SHAPE of what was typed (Arabic-Indic digits are
 * read, a decimal travels as TEXT — never a JSON number), so the server's
 * exact parser receives exactly what the owner typed. The percentage beside a
 * change is for reading and never feeds a price.
 *
 * A refusal names a FIELD: PRICING_INPUT_INVALID carries `details.field`, and
 * the message is drawn under that field.
 *
 * WHILE THE SERVER WORKS the button says so («جارٍ الحساب…», `aria-busy`) and
 * refuses further presses, so a slow answer is never a dead button that sends
 * the same question three times.
 */
import React, { useMemo, useRef, useState } from 'react';
import { ArrowDown, ArrowUp, CheckCircle2, ChevronDown, Minus } from 'lucide-react';
import { Button } from '../ui/Button';
import { Field, Input, Select, focusFirstInvalid } from '../ui/Field';
import { Money } from '../ui/Money';
import { StatusChip } from '../ui/Badge';
import { Segmented } from '../ui/Segmented';
import { ApiError, isAborted } from '../../lib/api';
import { apiRefusal, refusalText } from '../../lib/refusalStrings';
import { isPricingFieldName } from '../../../packages/contracts/src/pricingFieldLabels';
import type { Language } from '../../translations';
import {
  PRICING_CURRENCIES,
  PRICING_PROFILES,
  runPricingWhatIf,
  type PricingCurrency,
  type PricingModel,
  type PricingProfile,
  type PricingRates,
  type PricingWhatIfAnswer,
  type PricingWhatIfChannel,
} from './api';
import { Eyebrow, Figure, ReasonList } from './parts';
import {
  changePercent,
  channelLabel,
  fieldLabel,
  readDecimal,
  readWhole,
  nameOf,
  noAdditionalCostsText,
  profileLabel,
  ratesFromPurchasesText,
  type PricingUiStrings,
} from './strings';
import { SERVER_FIELD, buildRequest, defaultCurrency, emptyDraft, type Draft, type FormKey } from './whatIfRequest';

/** The rate warnings every P1 answer carries (no rate is confirmed before P2) — said once, above the results. */
const UNCONFIRMED = new Set(['FX_RATE_UNCONFIRMED', 'SHIPPING_RATE_UNCONFIRMED']);

/** E1's rounding step, as the breakdown names it (the server's answer carries what rounding added). */
const ROUNDING_STEP_SHOWN = 1_000;

function ChangeLine({ change, today, lang, s }: { change: number | null; today: number | null; lang: Language; s: PricingUiStrings }) {
  if (change === null) return <span className="text-[13px] text-text-muted">—</span>;
  if (change === 0) {
    return (
      <span className="inline-flex items-center gap-1 text-[13px] font-semibold text-text-secondary">
        <Minus aria-hidden="true" className="h-3.5 w-3.5" />
        {s.noChange}
      </span>
    );
  }
  const pct = changePercent(change, today);
  const Icon = change > 0 ? ArrowUp : ArrowDown;
  return (
    <span data-change-direction={change > 0 ? 'up' : 'down'} className="inline-flex flex-wrap items-center gap-1 text-[13px] font-semibold text-text-primary">
      <Icon aria-hidden="true" className="h-3.5 w-3.5 shrink-0" />
      <Money iqd={change} signed />
      {pct !== null && (
        <Figure className="text-text-muted">
          ({pct > 0 ? '+' : '−'}
          {Math.abs(pct).toLocaleString(lang === 'en' ? 'en-US' : undefined, { maximumFractionDigits: 1 })}%)
        </Figure>
      )}
    </span>
  );
}

function ResultChannel({ c, lang, s, currency }: { c: PricingWhatIfChannel; lang: Language; s: PricingUiStrings; currency: PricingCurrency }) {
  const priced = c.computed_price_iqd !== null;
  const issues = c.issue_codes.filter((code) => !UNCONFIRMED.has(code));
  // A figure sits beside its label; a longer statement (the rates) sits under it.
  const row = (label: string, value: React.ReactNode, key: string, stacked = false) =>
    stacked ? (
      <div key={key} className="py-1">
        <dt className="text-[12px] text-text-muted">{label}</dt>
        <dd className="mt-0.5 text-[13px] leading-relaxed text-text-secondary">{value}</dd>
      </div>
    ) : (
      <div key={key} className="flex items-baseline justify-between gap-3 py-1">
        <dt className="min-w-0 text-[12px] text-text-muted">{label}</dt>
        <dd className="shrink-0 text-end text-[13px] text-text-secondary">{value}</dd>
      </div>
    );
  return (
    <li data-whatif-channel={c.channel} className="lv-surface-raised min-w-0 p-3.5">
      <p className="text-[13px] font-bold text-text-primary">{channelLabel(c.channel, lang)}</p>
      <div className="mt-2 grid grid-cols-2 gap-3">
        <div className="min-w-0">
          <p className="text-[12px] text-text-muted">{s.colToday}</p>
          <p className="mt-0.5 text-[15px] font-semibold text-text-secondary">
            <Money iqd={c.today_prepaid_iqd} />
          </p>
        </div>
        <div className="min-w-0">
          <p className="text-[12px] text-text-muted">{s.colNew}</p>
          <p className="mt-0.5 text-[17px] font-black text-text-primary">{priced ? <Money iqd={c.computed_price_iqd} /> : <span className="text-[13px] font-semibold text-warning">{s.notPriced}</span>}</p>
        </div>
      </div>
      {priced && (
        <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1.5">
          <ChangeLine change={c.change_iqd} today={c.today_prepaid_iqd} lang={lang} s={s} />
          <span data-minimum-kept className="inline-flex items-center gap-1 text-[12px] font-semibold text-success">
            <CheckCircle2 aria-hidden="true" className="h-3.5 w-3.5" />
            {s.minimumKept}
          </span>
        </div>
      )}
      {issues.length > 0 && (
        <div className="mt-2.5">
          <ReasonList lang={lang} items={issues.map((code) => ({ code }))} />
        </div>
      )}
      {priced && (
        <details className="group mt-2.5">
          <summary className="inline-flex min-h-[44px] cursor-pointer list-none items-center gap-1 rounded-md text-[12px] font-semibold text-text-secondary hover:text-text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus [&::-webkit-details-marker]:hidden">
            <ChevronDown aria-hidden="true" className="h-3.5 w-3.5 transition-transform group-open:rotate-180" />
            {s.breakdown}
          </summary>
          <p className="mb-1.5 text-[12px] leading-relaxed text-text-muted">{s.minimumKeptHow(readWhole(ROUNDING_STEP_SHOWN, lang))}</p>
          <dl className="divide-y divide-border-subtle/50">
            {row(fieldLabel('supplier_cost_iqd', lang), <Money iqd={c.supplier_cost_iqd} />, 'sup')}
            {row(fieldLabel('shipping_cost_iqd', lang), <Money iqd={c.shipping_cost_iqd} />, 'ship')}
            {row(fieldLabel('additional_cost_iqd', lang), c.additional_cost_iqd ? <Money iqd={c.additional_cost_iqd} /> : <span className="text-text-muted">{noAdditionalCostsText(lang).replace(/^ℹ\s*/, '')}</span>, 'add', !c.additional_cost_iqd)}
            {row(fieldLabel('replacement_cost_iqd', lang), <Money iqd={c.replacement_cost_iqd} className="font-semibold text-text-primary" />, 'rep')}
            {row(s.minProfit, <Money iqd={c.target_profit_iqd} />, 'min')}
            {c.direct_sale_extra_iqd !== null && row(s.directSaleExtra, <Money iqd={c.direct_sale_extra_iqd} />, 'extra')}
            {c.direct_sale_extra_iqd !== null && row(fieldLabel('preorder_base_iqd', lang), <Money iqd={c.preorder_base_iqd} />, 'base')}
            {row(fieldLabel('rounding_added_iqd', lang), <Money iqd={c.rounding_added_iqd} />, 'round')}
            {row(
              s.ratesUsed,
              <span className="block">
                {c.fx_rate && (
                  <span className="block">
                    <Figure>
                      {readDecimal('1', lang)} {currency} = {readDecimal(c.fx_rate, lang)}
                    </Figure>{' '}
                    {lang === 'en' ? 'IQD' : 'د.ع'}
                  </span>
                )}
                {c.shipping_profile && c.shipping_rate && (
                  <span className="block">
                    {profileLabel(c.shipping_profile, lang)}: <Figure>{readDecimal(c.shipping_rate, lang)}</Figure>{' '}
                    {c.shipping_profile === 'CHINA_SEA' ? s.perCbm : s.perKg}
                  </span>
                )}
              </span>,
              'rates',
              true
            )}
            {c.effective_weight_g !== null && row(s.weightUsed, <><Figure>{readWhole(c.effective_weight_g, lang)}</Figure> {s.grams}</>, 'w')}
            {c.effective_cbm !== null && row(s.cbmUsed, <Figure>{readDecimal(c.effective_cbm, lang)} CBM</Figure>, 'cbm')}
          </dl>
        </details>
      )}
    </li>
  );
}

export default function WhatIfPanel({
  productId,
  routes,
  models,
  rates,
  lang,
  s,
}: {
  productId: string;
  routes: readonly string[];
  models: PricingModel[];
  rates: PricingRates;
  lang: Language;
  s: PricingUiStrings;
}) {
  const [draft, setDraft] = useState<Draft>(() => emptyDraft(defaultCurrency(routes)));
  const [errors, setErrors] = useState<Partial<Record<FormKey, string>>>({});
  const [failure, setFailure] = useState('');
  const [answer, setAnswer] = useState<PricingWhatIfAnswer | null>(null);
  const [busy, setBusy] = useState(false);
  const formRef = useRef<HTMLFormElement>(null);
  const resultRef = useRef<HTMLDivElement>(null);
  const controller = useRef<AbortController | null>(null);
  const named = models.filter((m) => m.option_id !== '');

  const set = <K extends keyof Draft>(key: K, value: Draft[K]) => setDraft((d) => ({ ...d, [key]: value }));
  const fxPlaceholder = useMemo(() => Object.fromEntries(rates.fx_rates.map((r) => [r.currency, r.rate_iqd ?? ''])) as Record<PricingCurrency, string>, [rates]);
  const shipPlaceholder = useMemo(
    () => Object.fromEntries(rates.shipping_rates.map((r) => [r.profile, r.rate_iqd ?? ''])) as Record<PricingProfile, string>,
    [rates]
  );

  const submit = async () => {
    // One question at a time: an Enter in a field while the answer is on its way asks nothing more.
    if (busy) return;
    setFailure('');
    const { body, errors: found } = buildRequest(draft, s);
    setErrors(found);
    if (!body) {
      requestAnimationFrame(() => focusFirstInvalid(formRef.current));
      return;
    }
    controller.current?.abort();
    const ac = new AbortController();
    controller.current = ac;
    setBusy(true);
    try {
      const res = await runPricingWhatIf(productId, body, { signal: ac.signal });
      if (ac.signal.aborted) return;
      setAnswer(res);
      requestAnimationFrame(() => resultRef.current?.focus({ preventScroll: false }));
    } catch (e) {
      if (isAborted(e) || ac.signal.aborted) return;
      const field = e instanceof ApiError && e.code === 'PRICING_INPUT_INVALID' ? String(e.details?.field ?? '') : '';
      const key = SERVER_FIELD[field];
      if (key) {
        // The contract's sentence, with the field's own name in the reader's language.
        const label = isPricingFieldName(field) ? fieldLabel(field, lang) : field === 'option_id' ? s.modelLabel : field;
        setErrors({ [key]: refusalText('PRICING_INPUT_INVALID', lang, s.whatIfFailed).replace('{field}', label) });
        requestAnimationFrame(() => focusFirstInvalid(formRef.current));
      } else {
        setFailure(apiRefusal(e, lang, s.whatIfFailed));
      }
    } finally {
      // Only the question still being asked clears the busy state; one cleared or replaced does not.
      if (controller.current === ac) setBusy(false);
    }
  };

  const clear = () => {
    controller.current?.abort();
    setBusy(false);
    setDraft(emptyDraft(defaultCurrency(routes)));
    setErrors({});
    setFailure('');
    setAnswer(null);
  };

  const moreOpen = !!(errors.additional || errors.weight || errors.box || errors.cbm || errors.profile || errors.fx || errors.shipping);
  const unconfirmed = answer?.models.some((m) => m.channels.some((c) => c.issue_codes.some((code) => UNCONFIRMED.has(code))));

  return (
    <section aria-labelledby="pricing-whatif-title" data-pricing-whatif className="lv-surface min-w-0 p-4">
      <h3 id="pricing-whatif-title" className="text-[17px] font-bold leading-snug text-text-primary">
        {s.whatIfTitle}
      </h3>
      <p className="mt-1 text-[13px] leading-relaxed text-text-muted">{s.whatIfIntro}</p>

      <form
        ref={formRef}
        noValidate
        className="mt-4 space-y-4"
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
      >
        <div className="grid gap-4 sm:grid-cols-[minmax(0,1fr)_auto]">
          <Field label={fieldLabel('supplier_cost', lang)} hint={s.supplierCostHint} error={errors.cost} required>
            <Input ltr inputMode="decimal" autoComplete="off" value={draft.cost} onChange={(e) => set('cost', e.target.value)} placeholder="250" data-whatif-cost />
          </Field>
          <div className="min-w-0">
            <p id="pricing-whatif-currency" className="mb-1.5 text-[13px] font-semibold text-text-secondary">
              {fieldLabel('supplier_currency', lang)}
            </p>
            <div className="sm:w-[228px]">
              <Segmented
                group="pricing-whatif-currency"
                label={fieldLabel('supplier_currency', lang)}
                value={draft.currency}
                onChange={(id) => set('currency', id as PricingCurrency)}
                dataAttr="data-whatif-currency"
                items={PRICING_CURRENCIES.map((c) => ({ id: c, label: c }))}
              />
            </div>
            {errors.currency && <p className="lv-field-error">{errors.currency}</p>}
          </div>
        </div>

        {named.length > 1 && (
          <Field label={s.modelLabel} error={errors.model}>
            <Select value={draft.model} onChange={(e) => set('model', e.target.value)}>
              <option value="">{s.allModels}</option>
              {named.map((m) => (
                <option key={m.option_id} value={m.option_id}>
                  {nameOf(m, lang, m.option_id)}
                </option>
              ))}
            </Select>
          </Field>
        )}

        <details className="group rounded-[var(--radius-md)] border border-border-subtle/70" open={moreOpen || undefined}>
          <summary className="flex min-h-[44px] cursor-pointer list-none items-center justify-between gap-2 px-3 text-[13px] font-semibold text-text-secondary hover:text-text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus [&::-webkit-details-marker]:hidden">
            {s.moreInputs}
            <ChevronDown aria-hidden="true" className="h-4 w-4 transition-transform group-open:rotate-180" />
          </summary>
          <div className="space-y-4 border-t border-border-subtle/60 p-3">
            <p className="text-[12px] leading-relaxed text-text-muted">{s.moreHint}</p>
            <div className="grid gap-4 sm:grid-cols-2">
              <Field label={fieldLabel('additional_cost_iqd', lang)} error={errors.additional} optional>
                <Input ltr inputMode="numeric" autoComplete="off" value={draft.additional} onChange={(e) => set('additional', e.target.value)} placeholder="0" />
              </Field>
              <Field label={fieldLabel('shipping_weight_g', lang)} error={errors.weight} optional>
                <Input ltr inputMode="numeric" autoComplete="off" value={draft.weight} onChange={(e) => set('weight', e.target.value)} />
              </Field>
            </div>
            <fieldset className="min-w-0">
              <legend className="mb-1.5 text-[13px] font-semibold text-text-secondary">{fieldLabel('shipping_box', lang)}</legend>
              <div className="grid grid-cols-3 gap-2" dir="ltr">
                {(['length', 'width', 'height'] as const).map((k) => (
                  <input
                    className="lv-input text-center"
                    key={k}
                    aria-label={fieldLabel(k === 'length' ? 'shipping_length_mm' : k === 'width' ? 'shipping_width_mm' : 'shipping_height_mm', lang)}
                    aria-invalid={errors.box ? true : undefined}
                    inputMode="numeric"
                    autoComplete="off"
                    value={draft[k]}
                    onChange={(e) => set(k, e.target.value)}
                    placeholder={k === 'length' ? 'L' : k === 'width' ? 'W' : 'H'}
                  />
                ))}
              </div>
              {errors.box && <p className="lv-field-error">{errors.box}</p>}
            </fieldset>
            <div className="grid gap-4 sm:grid-cols-2">
              <Field label={fieldLabel('manual_cbm', lang)} error={errors.cbm} optional>
                <Input ltr inputMode="decimal" autoComplete="off" value={draft.cbm} onChange={(e) => set('cbm', e.target.value)} />
              </Field>
              <Field label={fieldLabel('shipping_profile', lang)} error={errors.profile} optional>
                <Select value={draft.profile} onChange={(e) => set('profile', e.target.value as Draft['profile'])}>
                  <option value="">{s.profileAuto}</option>
                  {PRICING_PROFILES.map((p) => (
                    <option key={p} value={p}>
                      {profileLabel(p, lang)}
                    </option>
                  ))}
                </Select>
              </Field>
            </div>
            <div className="space-y-3">
              <Eyebrow>{s.ratesSection}</Eyebrow>
              <div className="grid gap-3 sm:grid-cols-3">
                {PRICING_CURRENCIES.map((c) => (
                  <Field key={c} label={`${fieldLabel('fx_rate', lang)} — ${c}`} optional>
                    <Input
                      ltr
                      inputMode="decimal"
                      autoComplete="off"
                      aria-invalid={errors.fx ? true : undefined}
                      value={draft.fx[c]}
                      onChange={(e) => set('fx', { ...draft.fx, [c]: e.target.value })}
                      placeholder={fxPlaceholder[c] || '—'}
                    />
                  </Field>
                ))}
              </div>
              {errors.fx && <p className="lv-field-error">{errors.fx}</p>}
              <div className="grid gap-3 sm:grid-cols-3">
                {PRICING_PROFILES.map((p) => (
                  <Field key={p} label={`${profileLabel(p, lang)} (${p === 'CHINA_SEA' ? s.perCbm : s.perKg})`} optional>
                    <Input
                      ltr
                      inputMode="decimal"
                      autoComplete="off"
                      aria-invalid={errors.shipping ? true : undefined}
                      value={draft.shipping[p]}
                      onChange={(e) => set('shipping', { ...draft.shipping, [p]: e.target.value })}
                      placeholder={shipPlaceholder[p] || '—'}
                    />
                  </Field>
                ))}
              </div>
              {errors.shipping && <p className="lv-field-error">{errors.shipping}</p>}
            </div>
          </div>
        </details>

        {failure && (
          <p role="alert" className="lv-alert lv-alert-danger text-[13px] leading-relaxed text-text-primary">
            {failure}
          </p>
        )}

        <div className="flex flex-wrap items-center gap-2">
          <Button type="submit" variant="primary" loading={busy} loadingLabel={s.calculating} data-whatif-submit>
            {s.calculate}
          </Button>
          {(answer || draft.cost) && (
            <Button type="button" variant="ghost" onClick={clear}>
              {s.clear}
            </Button>
          )}
        </div>
      </form>

      {answer && (
        <div ref={resultRef} tabIndex={-1} aria-live="polite" data-whatif-result className="mt-5 space-y-4 border-t border-border-subtle/70 pt-4 focus:outline-none">
          <div className="flex flex-wrap items-baseline justify-between gap-2">
            <h4 className="text-[15px] font-bold text-text-primary">{s.resultHeading}</h4>
            <p className="text-[13px] text-text-muted">
              {s.resultFor}{' '}
              <Figure className="font-semibold text-text-secondary">
                {readDecimal(answer.inputs.supplier_cost, lang)} {answer.inputs.supplier_currency}
              </Figure>
            </p>
          </div>
          {unconfirmed && (
            <p className="flex items-center gap-2 text-[12px] text-text-muted">
              <StatusChip tone="warning" className="shrink-0">{s.notConfirmed}</StatusChip>
              {ratesFromPurchasesText(lang)}
            </p>
          )}
          {answer.models.map((m) => (
            <div key={m.option_id || 'base'} className="space-y-2">
              {answer.models.length > 1 && <Eyebrow>{nameOf(m, lang, s.productItself)}</Eyebrow>}
              {m.channels.length === 0 ? (
                <p className="text-[13px] text-text-muted">{s.notPriced}</p>
              ) : (
                <ul className="grid items-start gap-2 sm:grid-cols-2">
                  {m.channels.map((c) => (
                    <ResultChannel key={c.channel} c={c} lang={lang} s={s} currency={answer.inputs.supplier_currency} />
                  ))}
                </ul>
              )}
            </div>
          ))}
        </div>
      )}
    </section>
  );
}
