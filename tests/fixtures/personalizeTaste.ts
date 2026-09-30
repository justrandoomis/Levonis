/**
 * FIXTURES FOR THE ENGINE'S TASTE (Programme C, C1 lane L3): Smart Fit areas
 * that reach each stage of the fit, names in the three scripts, the reference
 * pairs CIEDE2000 is validated against, a shop's shelf, and blueprints and
 * configurations that call for each «Make it better» code. The blueprint
 * archetypes themselves are L1's (./personalizeBlueprints.ts) — imported,
 * never copied.
 */
import type { Area, BlueprintSpec, DesignConfig, PublicBlueprint, TextSpec } from '../../packages/catalog/src/personalize/types';
import type { ShelfRow } from '../../packages/catalog/src/personalize/color';
import { publicSpecOf } from '../../packages/catalog/src/personalize/spec';
import { FIXTURES, NAME_STAND_CONFIG, front } from './personalizeBlueprints';

/** A text area on the front face, `w × h` mm at scale 1. */
export function textArea(w: number, h: number, text: Partial<TextSpec> = {}): Area {
  return {
    id: 'name', kind: 'text', role: 'name', region: 'body', frame: front(0, w, h), required: true, fee_iqd: 0,
    text: { lines: 1, max: 40, count: 1, styles: 'all', default_style: 'bold', min_cap_mm: 4, paint: { allowed: 'all', default: 'black' }, sample: { ar: 'علي', en: 'ALI', ckb: 'عەلی' }, ...text },
  };
}

/** One area per Smart Fit stage, with the entry that reaches it. */
export const FIT_STAGES = {
  ok: { area: textArea(60, 20), value: ['ALI'], style: 'bold' },
  fitted: { area: textArea(60, 20), value: ['Mohammed'], style: 'bold' },
  twoLines: { area: textArea(60, 24, { lines: 2 }), value: ['Abdul Rahman Mustafa'], style: 'bold' },
  bolder: { area: textArea(50, 10, { styles: ['elegant', 'minimal', 'bold'] }), value: ['Omar'], style: 'elegant' },
  sizeUp: { area: textArea(40, 10, { styles: ['bold'] }), value: ['Maximilian Alexander'], style: 'bold' },
  tooLong: { area: textArea(40, 10, { styles: ['bold'] }), value: ['Maximilian Alexander'], style: 'bold' },
} as const;
/** Larger sizes for the size-up stage: M does not fit the name, L does. */
export const FIT_SIZES = [{ value: 'ov_l', scale: 1.5, iqd_delta: 5_000 }, { value: 'ov_m', scale: 1.2, iqd_delta: 2_000 }];

export const ARABIC_NAMES = ['علي', 'محمد', 'فاطمة', 'عبدالله', 'عبد الرحمن', 'زينب', 'مصطفى', 'ليلى', 'سلام', 'إسلام', 'آلاء', 'بلال', 'ريم', 'ياسمين'];
/** Every Kurdish letter the text rule adds (ە ۆ ێ ڕ ڵ ڤ, the patch's ړ) and the Persian-block letters Sorani writes (پ چ ژ ک گ ی ھ). */
export const SORANI_NAMES = ['ئەڤین', 'کۆسرەت', 'ڕێژین', 'هەڵۆ', 'گوڵاڵە', 'چیا', 'پەیمان', 'ژیلا', 'ھاوڕێ', 'ړوون', 'هێڵ', 'پێڕەو'];
export const LATIN_NAMES = ['ALI', 'Sara', 'Mohammed', "O'Neil", 'Zoë', 'Łukasz', 'Team+1', 'Dr. Omar'];

/**
 * CIEDE2000 reference pairs: [L1, a1, b1, L2, a2, b2, ΔE00] — the 34 pairs of
 * Sharma, Wu & Dalal, «The CIEDE2000 Color-Difference Formula: Implementation
 * Notes, Supplementary Test Data, and Mathematical Observations» (2005), table 1.
 */
export const SHARMA_PAIRS: ReadonlyArray<readonly [number, number, number, number, number, number, number]> = [
  [50, 2.6772, -79.7751, 50, 0, -82.7485, 2.0425],
  [50, 3.1571, -77.2803, 50, 0, -82.7485, 2.8615],
  [50, 2.8361, -74.02, 50, 0, -82.7485, 3.4412],
  [50, -1.3802, -84.2814, 50, 0, -82.7485, 1.0],
  [50, -1.1848, -84.8006, 50, 0, -82.7485, 1.0],
  [50, -0.9009, -85.5211, 50, 0, -82.7485, 1.0],
  [50, 0, 0, 50, -1, 2, 2.3669],
  [50, -1, 2, 50, 0, 0, 2.3669],
  [50, 2.49, -0.001, 50, -2.49, 0.0009, 7.1792],
  [50, 2.49, -0.001, 50, -2.49, 0.001, 7.1792],
  [50, 2.49, -0.001, 50, -2.49, 0.0011, 7.2195],
  [50, 2.49, -0.001, 50, -2.49, 0.0012, 7.2195],
  [50, -0.001, 2.49, 50, 0.0009, -2.49, 4.8045],
  [50, -0.001, 2.49, 50, 0.001, -2.49, 4.8045],
  [50, -0.001, 2.49, 50, 0.0011, -2.49, 4.7461],
  [50, 2.5, 0, 50, 0, -2.5, 4.3065],
  [50, 2.5, 0, 73, 25, -18, 27.1492],
  [50, 2.5, 0, 61, -5, 29, 22.8977],
  [50, 2.5, 0, 56, -27, -3, 31.903],
  [50, 2.5, 0, 58, 24, 15, 19.4535],
  [50, 2.5, 0, 50, 3.1736, 0.5854, 1.0],
  [50, 2.5, 0, 50, 3.2972, 0, 1.0],
  [50, 2.5, 0, 50, 1.8634, 0.5757, 1.0],
  [50, 2.5, 0, 50, 3.2592, 0.335, 1.0],
  [60.2574, -34.0099, 36.2677, 60.4626, -34.1751, 39.4387, 1.2644],
  [63.0109, -31.0961, -5.8663, 62.8187, -29.7946, -4.0864, 1.263],
  [61.2901, 3.7196, -5.3901, 61.4292, 2.248, -4.962, 1.8731],
  [35.0831, -44.1164, 3.7933, 35.0232, -40.0716, 1.5901, 1.8645],
  [22.7233, 20.0904, -46.694, 23.0331, 14.973, -42.5619, 2.0373],
  [36.4612, 47.858, 18.3852, 36.2715, 50.5065, 21.2231, 1.4146],
  [90.8027, -2.0831, 1.441, 91.1528, -1.6435, 0.0447, 1.4441],
  [90.9257, -0.5406, -0.9208, 88.6381, -0.8985, -0.7239, 1.5381],
  [6.7747, -0.2908, -2.4247, 5.8714, -0.0985, -2.2286, 0.6377],
  [2.0776, 0.0795, -1.135, 0.9033, -0.0636, -0.5514, 0.9082],
];

/** A shop's shelf (merchant_material_stock rows): PLA and PLA silk spools, named and unnamed. */
export const SHELF: ShelfRow[] = [
  { material_id: 'pla', color_hex: '#101010', color_name: 'Black', grams: 800 },
  { material_id: 'pla', color_hex: '#fafafa', color_name: 'أبيض', grams: 650 },
  { material_id: 'pla', color_hex: '#c62839', color_name: '', grams: 400 },
  { material_id: 'pla', color_hex: '#3a74d9', color_name: 'Sky', grams: 0 },
  { material_id: 'pla', color_hex: '#7351cc', color_name: '', grams: 300 },
  { material_id: 'pla', color_hex: '#f0f0f0', color_name: 'Transparent', grams: 200 },
  { material_id: 'pla', color_hex: '#6060d0', color_name: '', grams: 250 },
  { material_id: 'pla', color_hex: '#e8c040', color_name: '', grams: 100 },
  { material_id: 'pla-silk', color_hex: '#d4af37', color_name: 'Silk Gold', grams: 500 },
  { material_id: 'pla-silk', color_hex: '#1f2e5e', color_name: 'Navy Blue', grams: 500 },
];

/** A name stand whose text offers only Kids and Bold — for STYLE_FOR_LENGTH. */
export const KIDS_STAND: BlueprintSpec = {
  ...FIXTURES.nameStand.spec,
  areas: [{ ...FIXTURES.nameStand.spec.areas[0], text: { ...FIXTURES.nameStand.spec.areas[0].text!, styles: ['kids', 'bold'], default_style: 'kids' } }],
  rules: [],
  axes: {},
};
export const KIDS_STAND_PUB: PublicBlueprint = { ...FIXTURES.nameStand.pub, ...publicSpecOf(KIDS_STAND), photos: [], variants: [], stock: null };

const stand = FIXTURES.nameStand.pub;
/** The name stand in medium classic, no magnet — the base of the Make-it-better cases. */
export const STAND_BASE: DesignConfig = { ...NAME_STAND_CONFIG, variant: 'pv_m_classic', slots: { magnet: { option: null } }, notes: '' };
/** The name stand when the shop tracks no stock: every allowed colour can be made. */
export const STAND_ANY: PublicBlueprint = { ...stand, stock: null };
