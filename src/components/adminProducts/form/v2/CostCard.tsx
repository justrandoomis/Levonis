/**
 * «التكلفة — للمالك فقط» (implementation spec §5.2 `CostCard.tsx`;
 * docs/PRICING-V2.md §1.2, §2.2, §2.3, §2.8; owner decision 2, row 184 (2)).
 *
 * The OWNER's card, mounted for the owner alone (the server sends no cost to
 * anyone else, and refuses any cost field from them by name):
 *   - the supplier price in its currency;
 *   - «مسار شحن المخزون» (how the stock arrives; it moves the direct price only
 *     through the replacement cost R);
 *   - the weight AND the box, always both shown (P4/P15), «مأخوذ من الأبعاد
 *     والوزن» when the package measure of section ٤ fills an empty one;
 *   - the extra cost per unit in dinars.
 * From cost this is the price's input; price-first it is optional (profit
 * reports and the owner's warnings only) and folds under «▸ التكلفة (اختياري)».
 * On a phone the card folds to its one-line summary.
 *
 * Nothing is converted here: R and every price are the server's answer.
 */
import { useEffect, useState } from 'react';
import { PRICING_PROFILE_LABELS } from '../../../../../packages/contracts/src/pricingFieldLabels';
import { Money, Select, TextInput } from '../formUi';
import { cleanUsdAmount, STOCK_ROUTES, SUPPLIER_CURRENCIES, iqdText, type CostDraft, type StockRoute, type SupplierCurrency } from './v2Model';
import { useV2Lang, useV2Strings, V2Field } from './v2Ui';

/** A number typed in one unit and stored in another (kg → g, cm → mm): the text stays as typed while it is typed. */
export function UnitInput({ id, stored, factor, decimals, onChange, label, data, placeholder }: {
  id: string;
  stored: number | null;
  factor: number;
  decimals: number;
  onChange: (next: number | null) => void;
  label?: string;
  data?: string;
  /** The inherited value, in grey (§2.1 rule 2). */
  placeholder?: string;
}) {
  const shown = (v: number | null) => (v === null ? '' : String(Number((v / factor).toFixed(decimals))));
  const [text, setText] = useState(() => shown(stored));
  // A value set from outside (a reload, the package measure) replaces the text; one typed here keeps its text.
  useEffect(() => {
    setText((t) => (parse(t) === stored ? t : shown(stored)));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [stored]);
  function parse(t: string): number | null {
    const v = Number(t.replace(/[٠-٩]/g, (d) => String(d.charCodeAt(0) - 0x0660)).replace(/٫/g, '.').trim());
    if (!t.trim() || !Number.isFinite(v) || v <= 0) return null;
    return Math.round(v * factor);
  }
  return (
    <TextInput
      id={id}
      inputMode="decimal"
      autoComplete="off"
      aria-label={label}
      data-v2-field={data}
      value={text}
      placeholder={placeholder}
      onChange={(e) => {
        const t = e.target.value.replace(/[^\d.٠-٩٫]/g, '');
        setText(t);
        onChange(parse(t));
      }}
    />
  );
}

/** A box from its three typed axes: all three set, or none at all (a partial box is never sent). */
export function boxOf(axes: ReadonlyArray<number | null>): [number, number, number] | null {
  return axes.length === 3 && axes.every((x) => x !== null) ? (axes as [number, number, number]) : null;
}

/** The folded card's summary, one isolated part each — the number and its localized unit in one run. */
export function costSummaryParts(cost: Pick<CostDraft, 'supplier_amount' | 'supplier_currency' | 'weight_g' | 'extras_iqd'>, route: string | null, kgUnit: string): string[] {
  return [
    cost.supplier_amount && cost.supplier_currency ? `${cost.supplier_currency} ${cost.supplier_amount}` : null,
    route,
    cost.weight_g !== null ? `${Number((cost.weight_g / 1000).toFixed(3))} ${kgUnit}` : null,
    cost.extras_iqd ? `+${iqdText(cost.extras_iqd)}` : null,
  ].filter((x): x is string => !!x);
}

/** Wide screens show the card open; a phone folds it to its summary until it is opened. */
function useWide(): boolean {
  const [wide, setWide] = useState(() => (typeof window === 'undefined' || !window.matchMedia ? true : window.matchMedia('(min-width: 768px)').matches));
  useEffect(() => {
    if (typeof window === 'undefined' || !window.matchMedia) return;
    const q = window.matchMedia('(min-width: 768px)');
    const on = () => setWide(q.matches);
    q.addEventListener?.('change', on);
    return () => q.removeEventListener?.('change', on);
  }, []);
  return wide;
}

export default function CostCard({
  cost,
  onChange,
  optional,
  fromPackage,
}: {
  cost: CostDraft;
  onChange: (patch: Partial<CostDraft>) => void;
  /** Price-first: the cost is optional (profit and estimates only) and starts folded. */
  optional: boolean;
  /** Which of the measures the package measure of «الأبعاد والوزن» filled (nothing stored for them). */
  fromPackage: { weight: boolean; box: boolean };
}) {
  const s = useV2Strings();
  const lang = useV2Lang();
  const wide = useWide();
  const [open, setOpen] = useState<boolean | null>(null);
  const shown = open ?? (!optional && wide);
  const route = cost.route ? PRICING_PROFILE_LABELS[cost.route as StockRoute][lang] : null;
  // Each part its own isolated run (a number stays with its unit, in the reader's language): an RTL summary
  // never reorders «USD 500 · 9 · الشحن البحري من الصين kg» (review 2026-10-14).
  const summary = costSummaryParts(cost, route, s.kgUnit);
  // The box as TYPED: a partly typed box (one or two axes) stays on screen; the draft carries a box only once
  // all three axes are set — each keystroke no longer starts from an empty box (review 2026-10-14).
  const [box, setBoxDraft] = useState<Array<number | null>>(() => [...(cost.box ?? [null, null, null])]);
  const storedBox = cost.box ? cost.box.join(',') : '';
  useEffect(() => {
    if (cost.box) setBoxDraft([...cost.box]);
    // A stored box (loaded, or emitted complete) replaces the typed one; a partial one is kept while typing.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [storedBox]);
  const setBox = (i: 0 | 1 | 2, v: number | null) => {
    const next = [...box];
    next[i] = v;
    setBoxDraft(next);
    onChange({ box: boxOf(next) });
  };
  const invalidAmount = cost.supplier_amount.trim() !== '' && cleanUsdAmount(cost.supplier_amount) === null;
  return (
    <section className="lv-well min-w-0 rounded-lg p-3" data-v2-card="cost" aria-label={optional ? s.costOptional : s.costOwnerOnly}>
      <button
        type="button"
        className="flex min-h-11 w-full min-w-0 items-center gap-2 text-start"
        aria-expanded={shown}
        onClick={() => setOpen(!shown)}
        data-v2-toggle="cost"
      >
        <span className="shrink-0 text-[11px] text-text-muted" aria-hidden="true">
          {shown ? '▾' : '▸'}
        </span>
        <span className="min-w-0 flex-1">
          <span className="block truncate text-[12px] font-bold text-text-primary">{optional ? s.costOptional : s.costOwnerOnly}</span>
          {!shown && summary.length ? (
            <span className="block truncate text-[11px] text-text-muted" data-v2-cost-summary>
              {summary.map((part, i) => (
                <span key={i}>
                  {i ? ' · ' : null}
                  <bdi>{part}</bdi>
                </span>
              ))}
            </span>
          ) : null}
        </span>
      </button>
      {shown ? (
        <div className="mt-3 grid min-w-0 gap-3">
          <div className="grid min-w-0 gap-2 [grid-template-columns:minmax(0,1fr)_6.5rem]">
            <V2Field label={s.supplier}>
              {(id) => (
                <TextInput
                  id={id}
                  inputMode="decimal"
                  autoComplete="off"
                  value={cost.supplier_amount}
                  aria-invalid={invalidAmount || undefined}
                  data-v2-field="supplier"
                  onChange={(e) => onChange({ supplier_amount: e.target.value.replace(/[^\d.٠-٩٫]/g, '') })}
                />
              )}
            </V2Field>
            <V2Field label={s.supplierCurrency}>
              {(id) => (
                <Select id={id} value={cost.supplier_currency} onChange={(e) => onChange({ supplier_currency: e.target.value as SupplierCurrency | '' })} data-v2-field="currency">
                  <option value="">—</option>
                  {SUPPLIER_CURRENCIES.map((c) => (
                    <option key={c} value={c}>
                      {c}
                    </option>
                  ))}
                </Select>
              )}
            </V2Field>
          </div>
          <V2Field label={s.stockRoute}>
            {(id) => (
              <Select id={id} value={cost.route} onChange={(e) => onChange({ route: e.target.value as StockRoute | '' })} data-v2-field="route">
                <option value="">{s.stockRouteNone}</option>
                {STOCK_ROUTES.map((r) => (
                  <option key={r} value={r}>
                    {PRICING_PROFILE_LABELS[r][lang]}
                  </option>
                ))}
              </Select>
            )}
          </V2Field>
          <div className="grid min-w-0 gap-2 [grid-template-columns:minmax(0,1fr)] sm:[grid-template-columns:minmax(0,1fr)_minmax(0,2fr)]">
            <V2Field label={s.weightKg} hint={fromPackage.weight ? s.fromDimensions : undefined}>
              {(id) => <UnitInput id={id} stored={cost.weight_g} factor={1000} decimals={3} onChange={(weight_g) => onChange({ weight_g })} data="weight" />}
            </V2Field>
            <V2Field label={s.boxCm} hint={fromPackage.box ? s.fromDimensions : undefined}>
              {(id) => (
                <div className="grid min-w-0 gap-1.5 [grid-template-columns:repeat(3,minmax(0,1fr))]" dir="ltr">
                  <UnitInput id={id} stored={box[0]} factor={10} decimals={1} onChange={(v) => setBox(0, v)} label={s.boxLength} data="box-l" />
                  <UnitInput id={`${id}-w`} stored={box[1]} factor={10} decimals={1} onChange={(v) => setBox(1, v)} label={s.boxWidth} data="box-w" />
                  <UnitInput id={`${id}-h`} stored={box[2]} factor={10} decimals={1} onChange={(v) => setBox(2, v)} label={s.boxHeight} data="box-h" />
                </div>
              )}
            </V2Field>
          </div>
          <V2Field label={s.extras}>
            {(id) => <Money id={id} value={cost.extras_iqd} placeholder="0" onChange={(extras_iqd) => onChange({ extras_iqd })} />}
          </V2Field>
        </div>
      ) : null}
    </section>
  );
}
