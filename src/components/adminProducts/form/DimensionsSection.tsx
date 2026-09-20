import React from 'react';
import { Field, Grid } from './formUi';
import type { ProductDimensionsV2 } from '../../../lib/productTypes';

/**
 * «الأبعاد والوزن» — what one unit is, and what the box it ships in is.
 *
 * ###########################################################################
 * #  TWO SETS OF NUMBERS, AND CONFUSING THEM PRODUCES A FREIGHT QUOTE WRONG #
 * #  BY HALF.                                                               #
 * ###########################################################################
 *
 * A printer is 430x400x450 mm and weighs 8 kg; the carton it ships in is
 * 500x550x600 mm and weighs 9.4 kg. The first set answers the customer's
 * question — «هل يدخل على الطاولة؟» — and the second is what a courier
 * charges for. A form with one set of boxes gets whichever the person had to
 * hand, and neither number is then trustworthy.
 *
 * So they are two visibly separate blocks with their own headings, and the
 * packaged one carries the sanity check: a box cannot weigh LESS than what is
 * inside it. That warning is inline and advisory, not a refusal — a listing
 * being filed at speed with one figure mistyped should not be unsavable, and
 * the owner is the one who knows whether 8 kg net and 6 kg packed means they
 * fat-fingered a digit or shipped it without the spool.
 *
 * ---------------------------------------------------------------------------
 * KILOGRAMS AND CENTIMETRES ON SCREEN, GRAMS AND MILLIMETRES IN THE DATABASE.
 *
 * Nobody types 8000 for a printer, and nobody measures a carton in
 * millimetres. But a stored unit that has to be guessed from context is how a
 * volume comes out a thousand times too small, so the conversion happens HERE,
 * once, at the edge — and the column keeps one canonical integer unit.
 *
 * `null` IS NOT ZERO. An empty box means nobody has measured it, and a zero
 * would be a claim that the thing is weightless. Both round-trip distinctly.
 */

const INPUT =
  'w-full bg-zinc-900 border border-zinc-700 rounded-lg p-2.5 text-sm text-white focus:border-[#6B46FF] outline-none min-h-[44px]';

/**
 * Grams to kilograms for display, EXACTLY — not rounded to one decimal.
 *
 * One decimal is plenty for a printer and silently halves a magnet: 50 g
 * rounds to 0.1 kg, and typing that back stores 100 g. Every figure this shop
 * sells is somewhere between a magnet and a printer, so the display carries
 * whatever precision the stored integer has and the round-trip is exact.
 */
const toKg = (g: number | null): string => (g === null ? '' : String(g / 1000));
const fromKg = (text: string): number | null => {
  const t = text.trim();
  if (t === '') return null;
  const n = Number(t);
  if (!Number.isFinite(n) || n <= 0) return null;
  return Math.round(n * 1000);
};

/** Millimetres to centimetres, same reasoning. */
const toCm = (mm: number | null): string => (mm === null ? '' : String(mm / 10));
const fromCm = (text: string): number | null => {
  const t = text.trim();
  if (t === '') return null;
  const n = Number(t);
  if (!Number.isFinite(n) || n <= 0) return null;
  return Math.round(n * 10);
};

export function DimensionsSection({
  dimensions,
  onChange,
}: {
  dimensions: ProductDimensionsV2;
  onChange: (next: ProductDimensionsV2) => void;
}) {
  const set = (key: keyof ProductDimensionsV2, value: number | null) =>
    onChange({ ...dimensions, [key]: value });

  /**
   * THE ONE CHECK WORTH MAKING. Both numbers stated, and the box lighter than
   * its contents — physically impossible, so one of them is a typo. Shown as a
   * sentence beside the field rather than a blocking error: see the header.
   */
  const impossible =
    dimensions.net_weight_g !== null &&
    dimensions.package_weight_g !== null &&
    dimensions.package_weight_g < dimensions.net_weight_g;

  return (
    <div className="grid gap-5">
      {/* ------------------------------------------- 1. THE PRODUCT ITSELF */}
      <div>
        <h4 className="mb-2.5 text-[13px] font-bold text-white">
          المنتج نفسه <span className="text-zinc-500 font-medium">/ The product itself</span>
        </h4>
        <p className="mb-3 text-[11.5px] leading-[1.6] text-zinc-400">
          ما يراه الزبون — «هل يدخل على الطاولة؟». ليست أبعاد الصندوق.
        </p>
        <Grid cols={2}>
          <Field ar="الوزن الصافي" en="Net weight" hint="كيلوغرام / kg">
            <input
              className={INPUT}
              inputMode="decimal"
              value={toKg(dimensions.net_weight_g)}
              onChange={(e) => set('net_weight_g', fromKg(e.target.value))}
            />
          </Field>
          <div />
          <Field ar="العرض" en="Width" hint="سنتيمتر / cm">
            <input
              className={INPUT}
              inputMode="decimal"
              value={toCm(dimensions.width_mm)}
              onChange={(e) => set('width_mm', fromCm(e.target.value))}
            />
          </Field>
          <Field ar="العمق" en="Depth" hint="سنتيمتر / cm">
            <input
              className={INPUT}
              inputMode="decimal"
              value={toCm(dimensions.depth_mm)}
              onChange={(e) => set('depth_mm', fromCm(e.target.value))}
            />
          </Field>
          <Field ar="الارتفاع" en="Height" hint="سنتيمتر / cm">
            <input
              className={INPUT}
              inputMode="decimal"
              value={toCm(dimensions.height_mm)}
              onChange={(e) => set('height_mm', fromCm(e.target.value))}
            />
          </Field>
        </Grid>
      </div>

      {/* ------------------------------------------ 2. THE SHIPPING CARTON */}
      <div>
        <h4 className="mb-2.5 text-[13px] font-bold text-white">
          صندوق الشحن <span className="text-zinc-500 font-medium">/ The shipping box</span>
        </h4>
        <p className="mb-3 text-[11.5px] leading-[1.6] text-zinc-400">
          ما يحسب عليه الناقل. عادةً أكبر وأثقل من المنتج نفسه.
        </p>
        <Grid cols={2}>
          <Field
            ar="الوزن مع التغليف"
            en="Packaged weight"
            hint="كيلوغرام / kg"
            error={impossible ? 'الصندوق أخف من محتواه — راجع أحد الرقمين' : null}
          >
            <input
              className={INPUT}
              inputMode="decimal"
              value={toKg(dimensions.package_weight_g)}
              onChange={(e) => set('package_weight_g', fromKg(e.target.value))}
            />
          </Field>
          <div />
          <Field ar="عرض الصندوق" en="Box width" hint="سنتيمتر / cm">
            <input
              className={INPUT}
              inputMode="decimal"
              value={toCm(dimensions.package_width_mm)}
              onChange={(e) => set('package_width_mm', fromCm(e.target.value))}
            />
          </Field>
          <Field ar="عمق الصندوق" en="Box depth" hint="سنتيمتر / cm">
            <input
              className={INPUT}
              inputMode="decimal"
              value={toCm(dimensions.package_depth_mm)}
              onChange={(e) => set('package_depth_mm', fromCm(e.target.value))}
            />
          </Field>
          <Field ar="ارتفاع الصندوق" en="Box height" hint="سنتيمتر / cm">
            <input
              className={INPUT}
              inputMode="decimal"
              value={toCm(dimensions.package_height_mm)}
              onChange={(e) => set('package_height_mm', fromCm(e.target.value))}
            />
          </Field>
        </Grid>

        {/* THE VOLUME IS DERIVED AND NEVER STORED — a third number that can
            disagree with the two it came from is a number nobody can trust. */}
        <BoxVolume d={dimensions} />
      </div>
    </div>
  );
}

function BoxVolume({ d }: { d: ProductDimensionsV2 }) {
  const { package_width_mm: w, package_depth_mm: dp, package_height_mm: h } = d;
  if (w === null || dp === null || h === null) return null;
  const litres = Math.round(((w / 10) * (dp / 10) * (h / 10)) / 100) / 10;
  return (
    <p className="mt-3 text-[11.5px] leading-[1.6] text-zinc-400">
      حجم الصندوق: <span className="font-semibold text-white tabular-nums">{litres}</span> لتر
      <span className="text-zinc-500"> — محسوب من الأبعاد أعلاه، غير مخزّن.</span>
    </p>
  );
}
