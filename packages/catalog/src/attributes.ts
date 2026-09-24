/**
 * WHAT A 3D-PRINTED PRODUCT IS MADE OF, AND HOW — typed, never free JSON.
 *
 * Each attribute is a column of its own on `community_products` (migration
 * 0126) with a CHECK in the database; this module is the same vocabulary for
 * the editor and the storefront, and `normalizeAttributes` is the one gate the
 * Worker runs before it writes. The material is an id from the platform's
 * print-material list (admin setting `printMaterials`, the list the print
 * quote engine and the printers tab already use), checked by the Worker
 * against the live list — this module only checks its shape.
 */
import { swatchKey, type Swatch } from './palette';

export const TECHNOLOGIES = ['fdm', 'resin', 'sls', 'laser', 'other'] as const;
export type Technology = (typeof TECHNOLOGIES)[number];

export const TECHNOLOGY_NAMES: Record<Technology, { ar: string; en: string }> = {
  fdm: { ar: 'طباعة بالخيوط (FDM)', en: 'Filament (FDM)' },
  resin: { ar: 'طباعة بالريزن', en: 'Resin (SLA/MSLA)' },
  sls: { ar: 'تلبيد بالليزر (SLS)', en: 'Powder (SLS)' },
  laser: { ar: 'قص وحفر بالليزر', en: 'Laser cut / engraved' },
  other: { ar: 'تقنية أخرى', en: 'Other' },
};

export const FINISHES = ['raw', 'sanded', 'primed', 'painted', 'polished', 'coated'] as const;
export type Finish = (typeof FINISHES)[number];

export const FINISH_NAMES: Record<Finish, { ar: string; en: string }> = {
  raw: { ar: 'كما خرج من الطابعة', en: 'As printed' },
  sanded: { ar: 'مصنفر', en: 'Sanded' },
  primed: { ar: 'عليه برايمر', en: 'Primed' },
  painted: { ar: 'مطلي يدويًا', en: 'Hand painted' },
  polished: { ar: 'مصقول', en: 'Polished' },
  coated: { ar: 'مغطّى بطبقة حماية', en: 'Coated' },
};

/** Millimetres; a part bigger than 5 m is a typo, not a print. */
export const MAX_DIMENSION_MM = 5000;
/** Grams; 1 tonne is the ceiling of anything a shop here ships. */
export const MAX_WEIGHT_G = 1_000_000;
const MATERIAL_ID = /^[a-z0-9][a-z0-9-]{0,39}$/;

export interface Attributes {
  material: string | null;
  technology: Technology | null;
  color: Swatch | null;
  finish: Finish | null;
  dim_x_mm: number | null;
  dim_y_mm: number | null;
  dim_z_mm: number | null;
  weight_g: number | null;
}

export const EMPTY_ATTRIBUTES: Attributes = {
  material: null, technology: null, color: null, finish: null,
  dim_x_mm: null, dim_y_mm: null, dim_z_mm: null, weight_g: null,
};

export type AttributeError = { field: keyof Attributes; code: 'ATTRIBUTE_INVALID' };

const empty = (v: unknown) => v === undefined || v === null || v === '';

function dimension(v: unknown): number | null | false {
  if (empty(v)) return null;
  const n = typeof v === 'number' ? v : Number(v);
  if (!Number.isFinite(n) || n <= 0 || n > MAX_DIMENSION_MM) return false;
  return Math.round(n * 10) / 10;
}

/**
 * The attributes as they may be stored, or the fields that are wrong. Absent,
 * null and '' all mean "not stated" — never a zero that reads as a real size.
 */
export function normalizeAttributes(input: unknown): { ok: true; value: Attributes } | { ok: false; errors: AttributeError[] } {
  const src = input && typeof input === 'object' ? (input as Record<string, unknown>) : {};
  const out: Attributes = { ...EMPTY_ATTRIBUTES };
  const errors: AttributeError[] = [];
  const bad = (field: keyof Attributes) => errors.push({ field, code: 'ATTRIBUTE_INVALID' });

  if (!empty(src.material)) {
    if (typeof src.material === 'string' && MATERIAL_ID.test(src.material)) out.material = src.material;
    else bad('material');
  }
  if (!empty(src.technology)) {
    if ((TECHNOLOGIES as readonly unknown[]).includes(src.technology)) out.technology = src.technology as Technology;
    else bad('technology');
  }
  if (!empty(src.color)) {
    const k = swatchKey(src.color);
    if (k) out.color = k;
    else bad('color');
  }
  if (!empty(src.finish)) {
    if ((FINISHES as readonly unknown[]).includes(src.finish)) out.finish = src.finish as Finish;
    else bad('finish');
  }
  for (const f of ['dim_x_mm', 'dim_y_mm', 'dim_z_mm'] as const) {
    const d = dimension(src[f]);
    if (d === false) bad(f);
    else out[f] = d;
  }
  if (!empty(src.weight_g)) {
    const n = Number(src.weight_g);
    if (Number.isInteger(n) && n >= 1 && n <= MAX_WEIGHT_G) out.weight_g = n;
    else bad('weight_g');
  }
  return errors.length ? { ok: false, errors } : { ok: true, value: out };
}
