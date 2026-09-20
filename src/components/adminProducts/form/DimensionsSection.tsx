import React, { useEffect, useId, useState } from 'react';
import { ChevronDown, RotateCcw } from 'lucide-react';
import {
  DIMENSION_KEYS,
  emptyDimensions,
  resolveDimensions,
  type ProductDimensionsV2,
} from '../../../lib/productTypes';
import { Field, Grid, btnGhost } from './formUi';

const INPUT =
  'w-full bg-zinc-900 border border-zinc-700 rounded-lg p-2.5 text-sm text-white placeholder:text-zinc-600 focus:border-[#6B46FF] outline-none min-h-[44px]';

/** Format a canonical integer without floating-point arithmetic. */
export function formatScaledInteger(value: number | null, scale: 10 | 1000): string {
  if (value === null) return '';
  const whole = Math.floor(value / scale);
  const remainder = value % scale;
  if (remainder === 0) return String(whole);
  return `${whole}.${String(remainder).padStart(String(scale).length - 1, '0').replace(/0+$/, '')}`;
}

/**
 * Parse the visible decimal as digits and a scale, not IEEE-754. Only
 * precision that maps exactly to grams/millimetres is accepted.
 */
export function parseScaledInteger(text: string, scale: 10 | 1000): number | null {
  const clean = text.trim();
  if (clean === '') return null;
  const precision = String(scale).length - 1;
  const match = clean.match(new RegExp(`^(\\d+)(?:\\.(\\d{0,${precision}}))?$`));
  if (!match) return null;
  const fraction = (match[2] ?? '').padEnd(precision, '0');
  const exact = BigInt(match[1]) * BigInt(scale) + BigInt(fraction || '0');
  if (exact <= 0n || exact > BigInt(Number.MAX_SAFE_INTEGER)) return null;
  return Number(exact);
}

export const gramsToKilograms = (grams: number | null): string => formatScaledInteger(grams, 1000);
export const kilogramsToGrams = (kilograms: string): number | null => parseScaledInteger(kilograms, 1000);
export const millimetresToCentimetres = (millimetres: number | null): string =>
  formatScaledInteger(millimetres, 10);
export const centimetresToMillimetres = (centimetres: string): number | null =>
  parseScaledInteger(centimetres, 10);

/**
 * An inherited measurement is guidance, not input state. Name both its source
 * and visible unit so an empty override cannot be mistaken for missing data.
 */
export function inheritedMeasurementPlaceholder(
  value: number | null | undefined,
  scale: 10 | 1000
): string {
  const formatted = formatScaledInteger(value ?? null, scale);
  if (!formatted) return '';
  const unit = scale === 1000 ? 'kg' : 'cm';
  return `Inherited / من الأعلى · ${formatted} ${unit}`;
}

function MeasurementInput({
  value,
  inherited,
  scale,
  onChange,
}: {
  value: number | null;
  inherited?: number | null;
  scale: 10 | 1000;
  onChange: (value: number | null) => void;
}) {
  const [text, setText] = useState(() => formatScaledInteger(value, scale));
  const [focused, setFocused] = useState(false);

  useEffect(() => {
    if (!focused) setText(formatScaledInteger(value, scale));
  }, [value, focused, scale]);

  const inheritedText = inheritedMeasurementPlaceholder(inherited, scale);
  return (
    <input
      className={INPUT}
      dir="ltr"
      inputMode="decimal"
      value={text}
      placeholder={inheritedText}
      onFocus={() => setFocused(true)}
      onChange={(event) => {
        const next = event.target.value;
        setText(next);
        if (next.trim() === '') {
          onChange(null);
          return;
        }
        const parsed = parseScaledInteger(next, scale);
        if (parsed !== null) onChange(parsed);
      }}
      onBlur={() => {
        setFocused(false);
        // Invalid or over-precise text never entered state. Restore the value
        // that will really be saved rather than implying otherwise.
        setText(formatScaledInteger(value, scale));
      }}
    />
  );
}

export function DimensionsSection({
  dimensions,
  onChange,
  inherited,
  collapsible = false,
  label,
}: {
  dimensions: ProductDimensionsV2;
  onChange: (next: ProductDimensionsV2) => void;
  /** Placeholder values only; never copied into override state. */
  inherited?: ProductDimensionsV2;
  collapsible?: boolean;
  label?: string;
}) {
  const customCount = DIMENSION_KEYS.filter((key) => dimensions[key] !== null).length;
  // Selection-level editors stay compact on first render even when they
  // already contain overrides; the badge still makes that state visible.
  const [open, setOpen] = useState(false);
  const panelId = useId();
  const effective = resolveDimensions(inherited ?? emptyDimensions(), dimensions);
  const set = (key: keyof ProductDimensionsV2, value: number | null) =>
    onChange({ ...dimensions, [key]: value });
  const impossible =
    effective.net_weight_g !== null &&
    effective.package_weight_g !== null &&
    effective.package_weight_g < effective.net_weight_g;

  const body = (
    <div className="grid gap-5">
      <div>
        <h4 className="mb-2.5 text-[13px] font-bold text-white">
          المنتج نفسه <span className="text-zinc-500 font-medium">/ The product itself</span>
        </h4>
        {!collapsible && (
          <p className="mb-3 text-[11.5px] leading-[1.6] text-zinc-400">
            ما يراه الزبون — «هل يدخل على الطاولة؟». ليست أبعاد الصندوق.
          </p>
        )}
        <Grid cols={2}>
          <Field ar="الوزن الصافي" en="Net weight" hint="كيلوغرام / kg">
            <MeasurementInput value={dimensions.net_weight_g} inherited={inherited?.net_weight_g} scale={1000} onChange={(value) => set('net_weight_g', value)} />
          </Field>
          <div />
          <Field ar="العرض" en="Width" hint="سنتيمتر / cm">
            <MeasurementInput value={dimensions.width_mm} inherited={inherited?.width_mm} scale={10} onChange={(value) => set('width_mm', value)} />
          </Field>
          <Field ar="العمق" en="Depth" hint="سنتيمتر / cm">
            <MeasurementInput value={dimensions.depth_mm} inherited={inherited?.depth_mm} scale={10} onChange={(value) => set('depth_mm', value)} />
          </Field>
          <Field ar="الارتفاع" en="Height" hint="سنتيمتر / cm">
            <MeasurementInput value={dimensions.height_mm} inherited={inherited?.height_mm} scale={10} onChange={(value) => set('height_mm', value)} />
          </Field>
        </Grid>
      </div>

      <div>
        <h4 className="mb-2.5 text-[13px] font-bold text-white">
          صندوق الشحن <span className="text-zinc-500 font-medium">/ The shipping box</span>
        </h4>
        {!collapsible && (
          <p className="mb-3 text-[11.5px] leading-[1.6] text-zinc-400">
            ما يحسب عليه الناقل. عادةً أكبر وأثقل من المنتج نفسه.
          </p>
        )}
        <Grid cols={2}>
          <Field ar="الوزن مع التغليف" en="Packaged weight" hint="كيلوغرام / kg" error={impossible ? 'الصندوق أخف من محتواه — راجع أحد الرقمين' : null}>
            <MeasurementInput value={dimensions.package_weight_g} inherited={inherited?.package_weight_g} scale={1000} onChange={(value) => set('package_weight_g', value)} />
          </Field>
          <div />
          <Field ar="عرض الصندوق" en="Box width" hint="سنتيمتر / cm">
            <MeasurementInput value={dimensions.package_width_mm} inherited={inherited?.package_width_mm} scale={10} onChange={(value) => set('package_width_mm', value)} />
          </Field>
          <Field ar="عمق الصندوق" en="Box depth" hint="سنتيمتر / cm">
            <MeasurementInput value={dimensions.package_depth_mm} inherited={inherited?.package_depth_mm} scale={10} onChange={(value) => set('package_depth_mm', value)} />
          </Field>
          <Field ar="ارتفاع الصندوق" en="Box height" hint="سنتيمتر / cm">
            <MeasurementInput value={dimensions.package_height_mm} inherited={inherited?.package_height_mm} scale={10} onChange={(value) => set('package_height_mm', value)} />
          </Field>
        </Grid>
        <BoxVolume d={effective} />
      </div>

      {customCount > 0 && collapsible && (
        <button type="button" className={`${btnGhost} justify-self-start`} onClick={() => onChange(emptyDimensions())} data-dimensions-clear>
          <RotateCcw className="h-3.5 w-3.5" /> مسح التخصيص / inherit all
        </button>
      )}
    </div>
  );

  if (!collapsible) return body;

  return (
    <div className="mt-2.5 min-w-0 rounded-lg border border-zinc-700/70 bg-zinc-950/25" data-dimensions-editor>
      <button
        type="button"
        className="flex min-h-10 w-full min-w-0 items-center gap-2 px-2.5 text-start"
        aria-expanded={open}
        aria-controls={panelId}
        onClick={() => setOpen((value) => !value)}
      >
        <ChevronDown className={`h-4 w-4 shrink-0 text-zinc-500 transition-transform ${open ? 'rotate-180' : ''}`} />
        <span className="min-w-0 flex-1 truncate text-[12px] font-bold text-zinc-300">
          {label ?? 'الأبعاد والوزن / Dimensions & weight'}
        </span>
        <span
          className={`shrink-0 rounded-full border px-2 py-0.5 text-[10px] font-bold ${customCount > 0 ? 'border-[#6B46FF]/50 bg-[#6B46FF]/10 text-violet-200' : 'border-zinc-700 bg-zinc-900 text-zinc-500'}`}
          data-dimensions-mode={customCount > 0 ? 'custom' : 'inherit'}
        >
          {customCount > 0 ? `مخصص ${customCount} / custom` : 'موروث / inherit'}
        </span>
      </button>
      <div id={panelId} className={`grid min-w-0 transition-[grid-template-rows] duration-200 ${open ? 'grid-rows-[1fr]' : 'grid-rows-[0fr]'}`}>
        <div className="min-h-0 min-w-0 overflow-hidden">
          <div className="border-t border-zinc-800 p-2.5">
            <p className="mb-3 text-[10px] leading-relaxed text-zinc-500">
              اترك الحقل فارغًا ليرث الرقم الظاهر من المستوى السابق. Leave blank to inherit the placeholder value.
            </p>
            {body}
          </div>
        </div>
      </div>
    </div>
  );
}

function BoxVolume({ d }: { d: ProductDimensionsV2 }) {
  const { package_width_mm: width, package_depth_mm: depth, package_height_mm: height } = d;
  if (width === null || depth === null || height === null) return null;
  const litres = Math.round((width * depth * height) / 100_000) / 10;
  return (
    <p className="mt-3 text-[11.5px] leading-[1.6] text-zinc-400">
      حجم الصندوق: <span className="font-semibold text-white tabular-nums">{litres}</span> لتر
      <span className="text-zinc-500"> — محسوب من الأبعاد أعلاه، غير مخزّن.</span>
    </p>
  );
}
