import { useId, useState } from 'react';
import { ChevronDown } from 'lucide-react';
import { useLanguage } from '../../LanguageContext';
import { formatUsdCents } from '../../lib/api';
import { money } from './shared';
import type { PricingSummary } from './procurementPricing';
import { issueText, procurementPricingStrings, profileName } from './procurementPricingStrings';

/**
 * THE 4-CELL PRICING SUMMARY AT THE END OF A PRODUCT CARD (owner brief
 * 2026-10-09 §6-§7; USD design §5.2-§5.3):
 *
 *   [ التكلفة النهائية $ ] [ الحد الأدنى للربح +$ ] [ السعر النهائي بالدولار $ ] [ السعر النهائي للزبون د.ع ]
 *
 * One row on a wide screen, two by two on a phone, RTL-safe (every figure an
 * LTR island). «تفاصيل» opens the brief's 13 items and the three notes. Every
 * figure is the server's — whole cents, whole dinars, exact text — so the
 * screen never computes money. Existing utilities only: the private operations
 * stylesheets have a fixed gzip budget (tests/bundleBudget.test.ts).
 */
const HIT_AREA = { position: 'absolute', inset: '-10px -4px' } as const;
const TWO_COLUMNS = { gridTemplateColumns: 'minmax(0, 1fr) max-content' } as const;
const CELL = 'rounded-[var(--ap-radius-md)] bg-[var(--ap-surface-1)] px-3 py-2';

const usd = (cents: number | null | undefined) => (cents == null ? '—' : formatUsdCents(cents));
const Fig = ({ children }: { children: React.ReactNode }) => <bdi dir="ltr" className="whitespace-nowrap tabular-nums">{children}</bdi>;

export default function PricingSummaryBar({ summary, label, busy = false, notInstalled = false, readOnlyLabel, directFirst = false }: {
  summary: PricingSummary | null | undefined;
  /** The line's name, for the bar's and the pill's accessible names. */
  label: string;
  busy?: boolean;
  /** 503 PRICING_NOT_INSTALLED: one line, no bar. */
  notInstalled?: boolean;
  /** «الحالي» on the review step and on a saved document. */
  readOnlyLabel?: boolean;
  /**
   * The procurement card (owner request 2026-10-10: a stock purchase is for
   * direct sale): for a model that sells direct, cell 4 is its direct sale
   * price — the pre-order base + the Direct Sale Extra, the caption says so —
   * or, while the extra is missing, the base pre-order price under its own
   * name with the way to complete it. A pre-order-only model, and every other
   * screen (no prop), reads exactly as before.
   */
  directFirst?: boolean;
}) {
  const { lang } = useLanguage();
  const s = procurementPricingStrings(lang);
  const [open, setOpen] = useState(false);
  const panel = useId();
  if (notInstalled) return <p role="status" className="mt-3 border-t border-[var(--ap-border)] pt-3 text-[13px] text-[var(--ap-text-3)]">{s.notInstalled}</p>;
  const ok = summary?.state === 'ok';
  const engine = summary?.engine_priced === true;
  const level = (l: string | null) =>
    l === 'option' ? s.levelOption : l === 'color' ? s.levelColour : l === 'sku' ? s.levelVariant : s.levelProduct;
  const profit = ok && summary!.target_profit_cents != null ? `+${usd(summary!.target_profit_cents)}` : '—';
  const reasons = !busy && summary && !ok
    ? summary.issue_codes.map((code) =>
        code === 'SHIPPING_RATE_MISSING' ? s.shippingRateMissing : code === 'TARGET_PROFIT_MISSING' ? s.targetProfitMissing : issueText(code, lang)
      )
    : [];
  const shown = (v: string) => (busy ? '…' : v);
  // Direct first: the model sells direct; `priced` when the engine gave its direct cell a price.
  const direct = directFirst && summary?.sells_direct === true;
  const priced = direct && ok && summary!.direct_sale_price_iqd != null;
  const cell4Label = !direct ? (engine ? s.cellCustomer : s.cellSuggested) : priced || !ok ? (engine ? s.cellDirectCustomer : s.cellDirectSuggested) : s.cellPreorderBase;
  const cell4Value = !ok ? '—' : priced ? money(summary!.direct_sale_price_iqd) : money(summary!.preorder_base_iqd);

  return (
    <section aria-label={s.barAria(label)} aria-busy={busy || undefined} className="mt-3 border-t border-[var(--ap-border)] pt-3" data-pricing-summary>
      {readOnlyLabel && <p className="mb-1.5 text-[12px] font-semibold text-[var(--ap-text-3)]">{s.current}</p>}
      <dl className="grid grid-cols-2 gap-2 tabular-nums sm:grid-cols-4">
        <div className={CELL}>
          <dt className="text-[12px] text-[var(--ap-text-3)]">{s.cellCost}</dt>
          <dd className="text-[15px] font-semibold text-[var(--ap-text-1)]"><Fig>{shown(ok ? usd(summary!.current_total_cost_cents) : '—')}</Fig></dd>
        </div>
        <div className={CELL}>
          <dt className="text-[12px] text-[var(--ap-text-3)]">{s.cellProfit}</dt>
          <dd className="text-[15px] font-semibold text-[var(--ap-text-1)]"><Fig>{shown(profit)}</Fig></dd>
        </div>
        <div className={CELL}>
          <dt className="text-[12px] text-[var(--ap-text-3)]">{s.cellFinalUsd}</dt>
          <dd className="text-[15px] font-semibold text-[var(--ap-text-1)]"><Fig>{shown(ok ? usd(summary!.final_price_cents) : '—')}</Fig></dd>
        </div>
        <div className="rounded-[var(--ap-radius-md)] bg-[var(--ap-accent-soft)] px-3 py-2 text-[var(--ap-accent-text)]">
          <dt className="text-[12px]">{cell4Label}</dt>
          <dd className="text-[15px] font-semibold">
            <output aria-live="polite"><Fig>{shown(cell4Value)}</Fig></output>
          </dd>
        </div>
      </dl>
      {busy && <p role="status" className="sr-only">{s.computing}</p>}
      {reasons.length > 0 && <p role="status" className="mt-2 text-[13px] text-[var(--ap-text-2)]">{reasons.join(lang === 'en' ? '; ' : '؛ ')}</p>}
      {ok && (
        <p className="mt-1.5 flex flex-wrap gap-x-3 gap-y-1 text-[12px] text-[var(--ap-text-3)]">
          <span>{s.basedOn(profileName(summary!.shipping_profile, lang))}</span>
          {priced ? (
            <span data-direct-caption>{s.directCaption(money(summary!.preorder_base_iqd), money(summary!.direct_sale_extra_iqd))}</span>
          ) : direct ? (
            summary!.direct_sale_extra_iqd == null && <span>{s.extraInReview}</span>
          ) : (
            summary!.direct_sale_price_iqd != null && <span>{s.directSale(money(summary!.direct_sale_price_iqd))}</span>
          )}
          {!engine && summary!.store_price_iqd != null && <span>{s.storePrice(money(summary!.store_price_iqd))}</span>}
        </p>
      )}
      {summary && (
        <>
          <button
            type="button"
            className="relative mt-2 inline-flex items-center gap-1 rounded-full border border-[var(--ap-border)] bg-[var(--ap-surface-1)] px-2.5 py-0.5 text-[12px] text-[var(--ap-text-2)] hover:border-[var(--ap-border-hover)] hover:text-[var(--ap-text-1)] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--ap-ring)]"
            aria-expanded={open}
            aria-controls={panel}
            aria-label={s.detailsAria(label)}
            onClick={() => setOpen((v) => !v)}
          >
            <span aria-hidden="true" style={HIT_AREA} />
            {s.details}
            <ChevronDown size={14} aria-hidden="true" className={`transition-transform duration-150 ${open ? 'rotate-180' : ''}`} />
          </button>
          <div id={panel} hidden={!open} role="region" aria-label={s.detailsAria(label)} className={open ? 'mt-2 grid gap-2 rounded-[var(--ap-radius-md)] border border-[var(--ap-border)] bg-[var(--ap-surface-1)] p-3 text-[12px] text-[var(--ap-text-3)]' : undefined}>
            {open && <PricingDetails summary={summary} level={level} />}
          </div>
        </>
      )}
    </section>
  );
}

/** «تفاصيل»: the brief's 13 items, in order, and the notes N1-N3. */
function PricingDetails({ summary: d, level }: { summary: PricingSummary; level: (l: string | null) => string }) {
  const { lang } = useLanguage();
  const s = procurementPricingStrings(lang);
  const dash = '—';
  const supplier =
    d.iqd_converted ? `${money(Number(d.iqd_converted.original_input_amount))} · ${s.convertedOnce(d.iqd_converted.conversion_rate_snapshot, (d.iqd_converted.converted_at ?? '').slice(0, 10))}` : d.supplier_original_amount ?? dash;
  const measure =
    d.basis === 'volume'
      ? d.effective_cbm ? `${d.effective_cbm} CBM ${d.shipping_rate ? s.perCbm(d.shipping_rate) : ''}` : dash
      : d.effective_weight_g != null ? `${(d.effective_weight_g / 1000).toLocaleString('en-US', { maximumFractionDigits: 3 })} kg ${d.shipping_rate ? s.perKg(d.shipping_rate) : ''}` : dash;
  const profit = d.minimum_target_profit_usd != null ? `$${d.minimum_target_profit_usd}` : d.target_profit_cents != null ? usd(d.target_profit_cents) : dash;
  const inherited = d.rule_level ? s.fromLevel(level(d.rule_level)) : '';
  const rows: Array<[string, React.ReactNode]> = [
    [s.row1, <Fig key="1">{supplier}</Fig>],
    [s.row2, <Fig key="2">{d.iqd_converted ? `IQD → USD` : d.supplier_original_currency ?? dash}</Fig>],
    [s.row3, <Fig key="3">{d.supplier_original_currency === 'USD' ? dash : d.cross_rate ?? dash}</Fig>],
    [s.row4, <Fig key="4">{usd(d.supplier_cost_cents)}</Fig>],
    [s.row5, <Fig key="5">{measure}</Fig>],
    [s.row6, <Fig key="6">{d.shipping_cost_iqd == null ? dash : money(d.shipping_cost_iqd)}</Fig>],
    [s.row7, <Fig key="7">{usd(d.shipping_cost_cents)}</Fig>],
    [
      s.row8,
      <span key="8">
        <Fig>{d.additional_cost_iqd == null ? dash : `${money(d.additional_cost_iqd)} · ${usd(d.additional_cost_cents)}`}</Fig>
        {d.excluded_charges.length > 0 && <span className="block">{s.excludedListed(d.excluded_charges.join(lang === 'en' ? ', ' : '، '))}</span>}
      </span>,
    ],
    [s.row9, <Fig key="9">{usd(d.current_total_cost_cents)}</Fig>],
    [
      s.row10,
      <span key="10">
        <Fig>{profit}</Fig>
        {inherited && <span className="ms-1">{inherited}</span>}
        {d.minimum_target_profit_usd == null && d.target_profit_iqd != null && <span className="block">{s.migratedDinars}</span>}
      </span>,
    ],
    [s.row11, <Fig key="11">{usd(d.final_price_cents)}</Fig>],
    [s.row12, <Fig key="12">{d.usd_iqd_rate ?? dash}</Fig>],
    [s.row13, <Fig key="13">{d.preorder_base_iqd == null ? dash : money(d.preorder_base_iqd)}</Fig>],
  ];
  return (
    <>
      <dl className="grid gap-x-3 gap-y-1.5" style={TWO_COLUMNS} data-pricing-details>
        {rows.map(([k, v], i) => (
          <div key={i} className="contents">
            <dt>{k}</dt>
            <dd className="text-end text-[var(--ap-text-2)] [overflow-wrap:anywhere]">{v}</dd>
          </div>
        ))}
      </dl>
      <ul className="grid gap-1 border-t border-[var(--ap-border)] pt-2">
        <li>
          {s.n1}
          {d.document_rate && <span className="block"><Fig>{s.n1Doc(d.document_rate)}</Fig></span>}
        </li>
        {d.direct_sale_price_iqd != null && d.preorder_base_iqd != null && d.direct_sale_extra_iqd != null && (
          <li>{s.n2(money(d.preorder_base_iqd), money(d.direct_sale_extra_iqd), money(d.direct_sale_price_iqd))}</li>
        )}
        {d.rounding_added_iqd != null && (
          <li title={s.n3Tooltip}>
            {s.n3(d.rounding_added_iqd.toLocaleString('en-US'))}
            <span className="block">{s.n3Tooltip}</span>
          </li>
        )}
      </ul>
    </>
  );
}
