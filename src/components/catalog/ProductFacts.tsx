/**
 * A printed product's typed facts (W2-F attributes) — material, technology,
 * colour, finish, size, weight — as a definition list. Only what the merchant
 * stated is shown; nothing is shown as «0 mm» (not stated is null, never 0).
 *
 * The material is the platform vocabulary's id (`pla`, `petg`, …), shown
 * upper-cased: those ids ARE the names printers use.
 */
import type { ReactNode } from 'react';
import { FINISH_NAMES, TECHNOLOGY_NAMES, type Attributes } from '../../../packages/catalog/src/attributes';
import { SWATCH_NAMES } from '../../../packages/catalog/src/palette';
import './swatches.css';

type Loc = (ar: string, en: string, ckb?: string) => string;

export function ProductFacts({ attributes, loc, lang }: { attributes: Attributes | undefined; loc: Loc; lang: string }) {
  if (!attributes) return null;
  const pick = (x: { ar: string; en: string }) => (lang === 'en' ? x.en : x.ar);
  const mm = (n: number) => n.toLocaleString('en-US', { maximumFractionDigits: 1 });
  const dims = [attributes.dim_x_mm, attributes.dim_y_mm, attributes.dim_z_mm];
  const rows: Array<{ k: string; label: string; value: ReactNode }> = [];
  if (attributes.material) rows.push({ k: 'material', label: loc('الخامة', 'Material'), value: attributes.material.toUpperCase() }); // OWNER: Sorani to be written by hand.
  if (attributes.technology) rows.push({ k: 'tech', label: loc('التقنية', 'Technology'), value: pick(TECHNOLOGY_NAMES[attributes.technology]) }); // OWNER: Sorani to be written by hand.
  if (attributes.color) {
    rows.push({
      k: 'color',
      label: loc('اللون', 'Colour'), // OWNER: Sorani to be written by hand.
      value: (
        <span className="inline-flex items-center gap-1.5">
          <span className="lv-swatch" data-swatch={attributes.color} aria-hidden="true" />
          {pick(SWATCH_NAMES[attributes.color])}
        </span>
      ),
    });
  }
  if (attributes.finish) rows.push({ k: 'finish', label: loc('التشطيب', 'Finish'), value: pick(FINISH_NAMES[attributes.finish]) }); // OWNER: Sorani to be written by hand.
  if (dims.some((d) => d !== null)) {
    rows.push({
      k: 'dims',
      label: loc('الأبعاد', 'Size'), // OWNER: Sorani to be written by hand.
      value: <span dir="ltr" className="tabular-nums">{dims.map((d) => (d === null ? '—' : mm(d))).join(' × ')} mm</span>,
    });
  }
  if (attributes.weight_g !== null) {
    rows.push({ k: 'weight', label: loc('الوزن', 'Weight'), value: <span dir="ltr" className="tabular-nums">{mm(attributes.weight_g)} g</span> }); // OWNER: Sorani to be written by hand.
  }
  if (!rows.length) return null;
  return (
    <dl className="mb-6 grid grid-cols-2 gap-x-4 gap-y-2 rounded-2xl border border-white/10 bg-white/[0.03] p-3 text-[12.5px]" data-product-facts>
      {rows.map((r) => (
        <div key={r.k} className="min-w-0">
          <dt className="text-zinc-500">{r.label}</dt>
          <dd className="truncate text-zinc-200">{r.value}</dd>
        </div>
      ))}
    </dl>
  );
}
