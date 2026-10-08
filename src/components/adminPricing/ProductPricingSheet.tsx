/**
 * «التسعير والشحن» — ONE PRODUCT, AS THE OWNER DECIDES ABOUT IT.
 *
 * Read from `GET /api/admin/pricing/products/:id` and shown in the order the
 * owner needs it:
 *
 *   1. what the product is and its status — with every reason that holds it,
 *      in the contracts' own sentences, and the notes that explain a value;
 *   2. per model, what a customer pays TODAY on each channel: the item price,
 *      the old route fee, prepaid and cash on delivery, and the old landed cost
 *      (answer B: it already included shipping);
 *   3. the minimum target profit and the direct-sale premium the old prices
 *      carry, each with its state, its reasons with their figures (the route
 *      fee counted in), and — for a conflict or an off-step premium — the
 *      values the owner can choose between; never an average;
 *   4. the shipping measures the product page states (suggestions, not
 *      confirmed), and what the new price still needs;
 *   5. «كم سيصبح السعر؟», and the rates it uses.
 *
 * READ ONLY. Nothing here writes; the banner above says so. Every figure is
 * the server's (whole dinars, or exact decimal text); the screen formats.
 */
import React, { useCallback, useEffect, useId, useRef, useState } from 'react';
import { ArrowLeft, ArrowRight, CheckCircle2, ChevronDown, Info } from 'lucide-react';
import { Money } from '../ui/Money';
import { iqdNumber, iqdUnit } from '../../lib/money';
import { StatusChip } from '../ui/Badge';
import { Skeleton } from '../ui/Skeleton';
import type { Language } from '../../translations';
import { fetchPricingProduct, type PricingCandidateKind, type PricingChannelToday, type PricingModel, type PricingProductDetail, type PricingReasonFigure, type PricingRoute } from './api';
import { Eyebrow, Figure, MigrationStatusChip, PricingFailure, ReasonList, ValueStateChip, type ReasonItem } from './parts';
import {
  channelLabel,
  fieldLabel,
  readDecimal,
  readWhole,
  landedNoteText,
  mixLabel,
  nameOf,
  routeChannel,
  routeLabel,
  type PricingUiStrings,
} from './strings';
import WhatIfPanel from './WhatIfPanel';
import RatesReference from './RatesReference';

const LIST_SEP = (lang: Language) => (lang === 'en' ? ', ' : '، ');

/** «{method}: {iqd}» for a reason with a figure: the route's channel name and the formatted amount. */
/** A dinar figure inside a sentence, written exactly as `Money` writes it. */
const dinars = (n: number, lang: Language) => `${iqdNumber(n, lang)} ${iqdUnit(lang)}`;

function figureParams(f: Pick<PricingReasonFigure, 'route' | 'legacy_reason_iqd'>, lang: Language): { method?: string; iqd?: string } {
  return {
    method: f.route ? channelLabel(routeChannel(f.route), lang) : undefined,
    iqd: f.legacy_reason_iqd != null ? dinars(f.legacy_reason_iqd, lang) : undefined,
  };
}

/**
 * The product-level reasons, with figures where every model agrees on them
 * (one route and one amount), and a range where they differ — the per-model
 * figures are on each model below.
 */
function productReasonItems(codes: string[], models: PricingModel[], lang: Language): ReasonItem[] {
  return codes.map((code) => {
    const figures = models.flatMap((m) => [...m.target.reason_figures, ...m.premium.reason_figures]).filter((f) => f.code === code);
    if (!figures.length) return { code };
    const routes = [...new Set(figures.map((f) => f.route).filter((r): r is PricingRoute => r !== null))];
    const amounts = [...new Set(figures.map((f) => f.legacy_reason_iqd).filter((n): n is number => n !== null))].sort((a, b) => a - b);
    return {
      code,
      params: {
        method: routes.length ? routes.map((r) => channelLabel(routeChannel(r), lang)).join(LIST_SEP(lang)) : undefined,
        iqd: amounts.length
          ? amounts.length === 1
            ? dinars(amounts[0]!, lang)
            : `${iqdNumber(amounts[0]!, lang)} – ${dinars(amounts[amounts.length - 1]!, lang)}`
          : undefined,
      },
    };
  });
}

// ------------------------------------------------------------ today's prices

function TodayChannels({ channels, lang, s }: { channels: PricingChannelToday[]; lang: Language; s: PricingUiStrings }) {
  const cod = (c: PricingChannelToday) => (
    <>
      <Money iqd={c.today_cod_iqd} />
      {c.cod_priced_as_direct && <span className="block text-[11px] font-normal text-text-muted">{s.codAsDirect}</span>}
    </>
  );
  // A pre-order shows its route fee (0 included); a direct sale shows its
  // product-level fee only when one is charged — otherwise there is none.
  const feeOf = (c: PricingChannelToday) =>
    c.route || (c.today_fee_iqd ?? 0) > 0 ? <Money iqd={c.today_fee_iqd} /> : <span className="text-text-muted">—</span>;
  const unpriced = (c: PricingChannelToday) =>
    c.resolver_errors.length > 0 && (
      <span className="block text-[12px] text-warning">
        {s.channelUnpriced}
        <Figure className="ms-1 text-text-muted">({c.resolver_errors.join(', ')})</Figure>
      </span>
    );
  return (
    <>
      {/* Wide screens: one row per channel, the columns the owner compares. */}
      <table className="hidden w-full text-[13px] md:table" data-pricing-today>
        <caption className="sr-only">{s.todayHeading}</caption>
        <thead>
          <tr className="text-[12px] text-text-muted">
            <th scope="col" className="py-2 pe-3 text-start font-semibold">{s.colChannel}</th>
            <th scope="col" className="px-3 py-2 text-end font-semibold">{s.colItem}</th>
            <th scope="col" className="px-3 py-2 text-end font-semibold">{s.colFee}</th>
            <th scope="col" className="px-3 py-2 text-end font-semibold">{s.colPrepaid}</th>
            <th scope="col" className="px-3 py-2 text-end font-semibold">{s.colCod}</th>
            <th scope="col" className="py-2 ps-3 text-end font-semibold">{s.colCost}</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-border-subtle/60 border-t border-border-subtle/60">
          {channels.map((c) => (
            <tr key={c.channel} data-today-channel={c.channel} className="align-top">
              <th scope="row" className="py-2.5 pe-3 text-start font-semibold text-text-primary">
                {channelLabel(c.channel, lang)}
                {unpriced(c)}
              </th>
              <td className="px-3 py-2.5 text-end text-text-secondary"><Money iqd={c.today_item_iqd} /></td>
              <td className="px-3 py-2.5 text-end text-text-secondary">{feeOf(c)}</td>
              <td className="px-3 py-2.5 text-end font-semibold text-text-primary"><Money iqd={c.today_prepaid_iqd} /></td>
              <td className="px-3 py-2.5 text-end text-text-secondary">{cod(c)}</td>
              <td className="py-2.5 ps-3 text-end text-text-secondary"><Money iqd={c.landed_cost_iqd} /></td>
            </tr>
          ))}
        </tbody>
      </table>

      {/* Phones: one block per channel, label beside value. */}
      <ul className="space-y-2 md:hidden" data-pricing-today-list>
        {channels.map((c) => (
          <li key={c.channel} data-today-channel={c.channel} className="rounded-[var(--radius-md)] bg-white/[0.03] p-3">
            <p className="text-[13px] font-bold text-text-primary">{channelLabel(c.channel, lang)}</p>
            {unpriced(c)}
            <dl className="mt-1.5 grid grid-cols-2 gap-x-3 gap-y-1.5 text-[13px]">
              <div className="min-w-0">
                <dt className="text-[11px] text-text-muted">{s.colItem}</dt>
                <dd className="text-text-secondary"><Money iqd={c.today_item_iqd} /></dd>
              </div>
              <div className="min-w-0">
                <dt className="text-[11px] text-text-muted">{s.colFee}</dt>
                <dd className="text-text-secondary">{feeOf(c)}</dd>
              </div>
              <div className="min-w-0">
                <dt className="text-[11px] text-text-muted">{s.colPrepaid}</dt>
                <dd className="font-semibold text-text-primary"><Money iqd={c.today_prepaid_iqd} /></dd>
              </div>
              <div className="min-w-0">
                <dt className="text-[11px] text-text-muted">{s.colCod}</dt>
                <dd className="text-text-secondary">{cod(c)}</dd>
              </div>
              <div className="col-span-2 min-w-0">
                <dt className="text-[11px] text-text-muted">{s.colCost}</dt>
                <dd className="text-text-secondary"><Money iqd={c.landed_cost_iqd} /></dd>
              </div>
            </dl>
          </li>
        ))}
      </ul>
    </>
  );
}

// ------------------------------------------------------ the derived values

function DerivedValue({
  title,
  value,
  state,
  reasons,
  candidates,
  extra,
  lang,
  s,
}: {
  title: string;
  value: number | null;
  state: PricingModel['target']['migration_state'];
  reasons: ReasonItem[];
  candidates: Array<{ kind: PricingCandidateKind; route: PricingRoute | null; value: number }>;
  extra?: React.ReactNode;
  lang: Language;
  s: PricingUiStrings;
}) {
  const candidateName = (c: { kind: PricingCandidateKind; route: PricingRoute | null }) =>
    c.kind === 'floor' ? s.candFloor : c.kind === 'ceiling' ? s.candCeiling : c.route ? channelLabel(routeChannel(c.route), lang) : '—';
  return (
    <div className="min-w-0 rounded-[var(--radius-md)] bg-white/[0.03] p-3" data-derived={title}>
      <div className="flex flex-wrap items-start justify-between gap-2">
        <p className="text-[12px] font-semibold text-text-muted">{title}</p>
        <ValueStateChip state={state} lang={lang} />
      </div>
      <p className="mt-1 text-[20px] font-black leading-tight text-text-primary">
        {value !== null ? <Money iqd={value} /> : state === 'NOT_APPLICABLE' ? <span className="text-[15px] font-semibold text-text-muted">—</span> : <span className="text-[15px] font-semibold text-warning">—</span>}
      </p>
      {extra}
      {candidates.length > 0 && (
        <div className="mt-2">
          <p className="text-[12px] text-text-muted">{s.candidates}</p>
          <ul className="mt-1 flex flex-wrap gap-1.5">
            {candidates.map((c, i) => (
              <li key={`${c.kind}-${c.route ?? ''}-${i}`} className="inline-flex items-center gap-1.5 rounded-full bg-white/[0.06] px-2.5 py-1 text-[12px] text-text-secondary">
                <span>{candidateName(c)}</span>
                <Money iqd={c.value} className="font-semibold text-text-primary" />
              </li>
            ))}
          </ul>
        </div>
      )}
      {reasons.length > 0 && (
        <div className="mt-2.5">
          <ReasonList items={reasons} lang={lang} />
        </div>
      )}
    </div>
  );
}

// ------------------------------------------------------------- one model

function ModelSection({ model, lang, s, defaultOpen, single }: { model: PricingModel; lang: Language; s: PricingUiStrings; defaultOpen: boolean; single: boolean }) {
  const name = nameOf(model, lang, s.productItself);
  const titleId = useId();
  const m = model.suggested_measures;
  const scope = (sc: 'base' | 'option' | null) => (sc === 'base' ? s.scopeProduct : sc === 'option' ? s.scopeModel : '');
  const box = m.shipping_length_mm !== null && m.shipping_width_mm !== null && m.shipping_height_mm !== null;

  // What the new price still needs: one line per code, with the channels it applies to.
  const missingByCode = new Map<string, string[]>();
  for (const x of model.missing) {
    const list = missingByCode.get(x.code) ?? [];
    list.push(channelLabel(x.channel, lang));
    missingByCode.set(x.code, list);
  }
  const missing: ReasonItem[] = [...missingByCode].map(([code, channels]) => ({ code, detail: channels.join(LIST_SEP(lang)) }));

  const targetReasons: ReasonItem[] = model.target.reason_codes.map((code) => {
    const f = model.target.reason_figures.find((x) => x.code === code);
    return f ? { code, params: figureParams(f, lang) } : { code };
  });
  const premiumReasons: ReasonItem[] = model.premium.reason_codes.map((code) => {
    const f = model.premium.reason_figures.find((x) => x.code === code);
    return f ? { code, params: figureParams(f, lang) } : { code };
  });

  const body = (
    <div className="space-y-4">
      <div>
        <Eyebrow>{s.todayHeading}</Eyebrow>
        <div className="mt-2">
          <TodayChannels channels={model.channels} lang={lang} s={s} />
        </div>
      </div>

      <div>
        <Eyebrow>{s.derivedHeading}</Eyebrow>
        <div className="mt-2 grid gap-2 md:grid-cols-2">
          <DerivedValue
            title={s.minProfit}
            value={model.target.target_profit_iqd}
            state={model.target.migration_state}
            reasons={targetReasons}
            candidates={model.target.candidates.map((c) => ({ kind: c.kind, route: c.route, value: c.target_profit_iqd }))}
            lang={lang}
            s={s}
          />
          <DerivedValue
            title={s.premium}
            value={model.premium.direct_premium_iqd}
            state={model.premium.migration_state}
            reasons={premiumReasons}
            candidates={model.premium.candidates.map((c) => ({ kind: c.kind, route: c.route, value: c.direct_premium_iqd }))}
            extra={
              model.base_route && model.premium.migration_state !== 'NOT_APPLICABLE' ? (
                <p className="mt-1 text-[12px] text-text-muted">
                  {s.baseRoute}: {channelLabel(routeChannel(model.base_route), lang)}
                </p>
              ) : undefined
            }
            lang={lang}
            s={s}
          />
        </div>
        {model.roundtrip_ok === true && (
          <p className="mt-2 flex items-start gap-1.5 text-[12px] leading-relaxed text-success">
            <CheckCircle2 aria-hidden="true" className="mt-[2px] h-3.5 w-3.5 shrink-0" />
            {s.roundtripOk}
          </p>
        )}
        {model.roundtrip_ok === false && (
          <div className="mt-2">
            <ReasonList items={[{ code: 'PLACEMENT_INVARIANT_FAILED' }]} lang={lang} />
          </div>
        )}
      </div>

      <div className="grid gap-4 md:grid-cols-2">
        <div className="min-w-0">
          <Eyebrow>{s.measuresHeading}</Eyebrow>
          <dl className="mt-2 divide-y divide-border-subtle/50 text-[13px]">
            <div className="flex items-baseline justify-between gap-3 py-1.5">
              <dt className="min-w-0 text-text-muted">{fieldLabel('shipping_weight_g', lang)}</dt>
              <dd className="shrink-0 text-end text-text-secondary">
                {m.shipping_weight_g !== null ? (
                  <>
                    <Figure>{readWhole(m.shipping_weight_g, lang)}</Figure> <span className="text-[11px] text-text-muted">{scope(m.weight_scope)}</span>
                  </>
                ) : (
                  <span className="font-semibold text-warning">{s.measureMissing}</span>
                )}
              </dd>
            </div>
            <div className="flex items-baseline justify-between gap-3 py-1.5">
              <dt className="min-w-0 text-text-muted">{fieldLabel('shipping_box', lang)}</dt>
              <dd className="shrink-0 text-end text-text-secondary">
                {box ? (
                  <>
                    <Figure>
                      {readWhole(m.shipping_length_mm, lang)} × {readWhole(m.shipping_width_mm, lang)} × {readWhole(m.shipping_height_mm, lang)}
                    </Figure>{' '}
                    <span className="text-[11px] text-text-muted">{scope(m.box_scope)}</span>
                  </>
                ) : (
                  <span className="font-semibold text-warning">{s.measureMissing}</span>
                )}
              </dd>
            </div>
            <div className="flex items-baseline justify-between gap-3 py-1.5">
              <dt className="min-w-0 text-text-muted">{fieldLabel('calculated_cbm', lang)}</dt>
              <dd className="shrink-0 text-end text-text-secondary">
                {m.calculated_cbm !== null ? <Figure>{readDecimal(m.calculated_cbm, lang)}</Figure> : <span className="font-semibold text-warning">{s.measureMissing}</span>}
              </dd>
            </div>
          </dl>
        </div>
        <div className="min-w-0">
          <Eyebrow>{s.missingHeading}</Eyebrow>
          <div className="mt-2">
            {missing.length ? <ReasonList items={missing} lang={lang} quiet /> : <p className="text-[13px] text-text-muted">{s.missingNone}</p>}
          </div>
        </div>
      </div>
    </div>
  );

  // A product without models (or with one) shows it open, with no disclosure to press.
  if (single) {
    return (
      <section aria-labelledby={titleId} data-pricing-model={model.option_id || 'base'} className="lv-surface min-w-0 p-4">
        <h3 id={titleId} className="mb-3 text-[15px] font-bold text-text-primary">{name}</h3>
        {body}
      </section>
    );
  }
  return (
    <details data-pricing-model={model.option_id || 'base'} className="lv-surface group min-w-0" open={defaultOpen || undefined}>
      <summary className="flex min-h-[56px] cursor-pointer list-none items-center gap-3 rounded-[var(--radius-lg)] px-4 py-3 hover:bg-white/[0.02] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-focus [&::-webkit-details-marker]:hidden">
        <span className="min-w-0 flex-1">
          <span id={titleId} className="block text-[15px] font-bold text-text-primary">{name}</span>
          <span className="mt-0.5 flex flex-wrap items-center gap-x-3 gap-y-0.5 text-[12px] text-text-muted">
            <span>
              {s.minProfit}: <Money iqd={model.target.target_profit_iqd} className="font-semibold text-text-secondary" />
            </span>
            {model.premium.migration_state !== 'NOT_APPLICABLE' && (
              <span>
                {s.premium}: <Money iqd={model.premium.direct_premium_iqd} className="font-semibold text-text-secondary" />
              </span>
            )}
          </span>
        </span>
        <span className="hidden sm:inline-flex">
          <ValueStateChip state={worstState(model)} lang={lang} />
        </span>
        <ChevronDown aria-hidden="true" className="h-4 w-4 shrink-0 text-text-muted transition-transform group-open:rotate-180" />
      </summary>
      <div className="border-t border-border-subtle/60 p-4">{body}</div>
    </details>
  );
}

/** The state that needs the owner most, of a model's two derived values. */
function worstState(m: PricingModel): PricingModel['target']['migration_state'] {
  const order: Array<PricingModel['target']['migration_state']> = [
    'CONFLICT',
    'TARGET_PROFIT_UNRESOLVED',
    'TARGET_PROFIT_REVIEW_REQUIRED',
    'DIRECT_PREMIUM_REVIEW_REQUIRED',
    'MIGRATED',
    'NOT_APPLICABLE',
  ];
  const a = order.indexOf(m.target.migration_state);
  const b = order.indexOf(m.premium.migration_state);
  return order[Math.min(a < 0 ? 99 : a, b < 0 ? 99 : b)] ?? m.target.migration_state;
}

// ---------------------------------------------------------- the product

function SheetSkeleton() {
  return (
    <div className="space-y-3" aria-hidden="true">
      <Skeleton className="h-7 w-2/3" />
      <Skeleton className="h-4 w-1/3" />
      <Skeleton className="h-24 w-full" />
      <Skeleton className="h-48 w-full" />
    </div>
  );
}

export default function ProductPricingSheet({
  id,
  lang,
  dir,
  s,
  onBack,
}: {
  id: string;
  lang: Language;
  dir: 'rtl' | 'ltr';
  s: PricingUiStrings;
  onBack: () => void;
}) {
  const [data, setData] = useState<PricingProductDetail | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [reload, setReload] = useState(0);
  const headingRef = useRef<HTMLHeadingElement>(null);

  useEffect(() => {
    const ac = new AbortController();
    setData(null);
    setError(null);
    fetchPricingProduct(id, { signal: ac.signal })
      .then((d) => {
        if (!ac.signal.aborted) setData(d);
      })
      .catch((e) => {
        if (!ac.signal.aborted) setError(e);
      });
    return () => ac.abort();
  }, [id, reload]);

  // Focus follows the navigation: the product's own title, once it is there.
  useEffect(() => {
    if (data) headingRef.current?.focus({ preventScroll: true });
  }, [data]);

  const retry = useCallback(() => setReload((n) => n + 1), []);
  const Back = dir === 'rtl' ? ArrowRight : ArrowLeft;

  const back = (
    <button
      type="button"
      onClick={onBack}
      data-pricing-back
      className="lv-button lv-button-ghost lv-button-sm -ms-2 inline-flex items-center gap-1.5"
    >
      <Back aria-hidden="true" className="h-4 w-4" />
      {s.back}
    </button>
  );

  if (error) {
    return (
      <div className="space-y-3">
        {back}
        <PricingFailure error={error} lang={lang} onRetry={retry} fallback={s.loadFailed} />
      </div>
    );
  }
  if (!data) {
    return (
      <div className="space-y-3" aria-busy="true">
        {back}
        <p className="sr-only" role="status">{s.loading}</p>
        <SheetSkeleton />
      </div>
    );
  }

  const p = data.product;
  const name = nameOf(p, lang, p.slug);
  const holding = productReasonItems(p.reason_codes, data.models, lang);
  const notes = productReasonItems(p.info_codes, data.models, lang);
  const routes = p.routes.map((r) => routeLabel(r, lang)).join(LIST_SEP(lang));
  const open = data.models.length <= 2;

  return (
    <article aria-labelledby="pricing-product-title" data-pricing-product-sheet={p.id} className="space-y-4">
      {back}

      <header className="space-y-2">
        <h3 id="pricing-product-title" ref={headingRef} tabIndex={-1} className="text-[20px] font-black leading-snug text-text-primary focus:outline-none sm:text-[22px]">
          {name}
        </h3>
        <p className="text-[12px] text-text-muted">
          <bdi dir="ltr">{p.slug}</bdi>
        </p>
        <div className="flex flex-wrap items-center gap-1.5">
          <MigrationStatusChip status={p.migration_status} lang={lang} />
          {p.status !== 'active' && <StatusChip tone="neutral" dot={false}>{s.notLive}</StatusChip>}
        </div>
      </header>

      <dl className="lv-surface grid grid-cols-2 gap-x-4 gap-y-3 p-4 text-[13px] md:grid-cols-4" data-pricing-facts>
        <div className="min-w-0">
          <dt className="text-[12px] text-text-muted">{s.factsSale}</dt>
          <dd className="mt-0.5 font-semibold text-text-primary">{mixLabel(p.channel_mix, lang)}</dd>
        </div>
        <div className="min-w-0">
          <dt className="text-[12px] text-text-muted">{s.factsRoutes}</dt>
          <dd className="mt-0.5 font-semibold text-text-primary">{routes || s.none}</dd>
        </div>
        <div className="min-w-0">
          <dt className="text-[12px] text-text-muted">{s.modelsLabel}</dt>
          <dd className="mt-0.5 font-semibold text-text-primary"><Figure>{readWhole(p.model_count, lang)}</Figure></dd>
        </div>
        <div className="min-w-0" data-typed-member-prices={p.typed_member_prices ? 'yes' : 'no'}>
          <dt className="text-[12px] text-text-muted">{s.factsMembers}</dt>
          <dd className="mt-0.5 font-semibold text-text-primary">
            {p.typed_member_prices ? s.yes : s.no}
            {p.typed_member_prices && <span className="mt-0.5 block text-[12px] font-normal leading-relaxed text-text-muted">{s.membersDropped}</span>}
          </dd>
        </div>
      </dl>

      <section aria-labelledby="pricing-decision-title" className="lv-surface p-4" data-pricing-decision>
        <h4 id="pricing-decision-title" className="text-[15px] font-bold text-text-primary">{s.decisionHeading}</h4>
        <div className="mt-2.5">
          {holding.length ? (
            <ReasonList items={holding} lang={lang} />
          ) : (
            <p className="flex items-start gap-2 text-[13px] leading-relaxed text-text-secondary">
              <CheckCircle2 aria-hidden="true" className="mt-[2px] h-4 w-4 shrink-0 text-success" />
              {s.nothingHeld}
            </p>
          )}
        </div>
        {notes.length > 0 && (
          <div className="mt-4 border-t border-border-subtle/60 pt-3">
            <Eyebrow>{s.notesHeading}</Eyebrow>
            <div className="mt-2">
              <ReasonList items={notes} lang={lang} quiet />
            </div>
          </div>
        )}
        <details className="group mt-4 border-t border-border-subtle/60 pt-3">
          <summary className="inline-flex min-h-[40px] cursor-pointer list-none items-center gap-1.5 rounded-md text-[13px] font-semibold text-text-secondary hover:text-text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus [&::-webkit-details-marker]:hidden">
            <Info aria-hidden="true" className="h-4 w-4 text-info" />
            {s.landedNoteTitle}
            <ChevronDown aria-hidden="true" className="h-3.5 w-3.5 transition-transform group-open:rotate-180" />
          </summary>
          <p className="mt-1.5 max-w-[70ch] text-[13px] leading-relaxed text-text-muted">{landedNoteText(lang)}</p>
        </details>
      </section>

      <div className="space-y-2" data-pricing-models>
        {data.models.map((m, i) => (
          <ModelSection key={m.option_id || 'base'} model={m} lang={lang} s={s} defaultOpen={open || i === 0} single={data.models.length === 1} />
        ))}
      </div>

      <WhatIfPanel productId={p.id} routes={p.routes} models={data.models} rates={data} lang={lang} s={s} />

      <RatesReference rates={data} lang={lang} s={s} />
    </article>
  );
}
