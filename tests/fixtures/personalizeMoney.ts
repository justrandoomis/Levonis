/**
 * MONEY, RULES, SURFACE AND CHECK FIXTURES (Programme C, C1 lane L2) — beside
 * L1's archetypes (./personalizeBlueprints.ts, imported, never copied).
 *
 *   ROWS           the store rows behind the brief's rotating display and the
 *                  name stand, as the Worker reads them (product, variants,
 *                  part products) — the price test builds the Worker's context
 *                  through resolveCatalogLine and the studio's from a
 *                  PublicBlueprint made of the SAME rows
 *   FEES           one blueprint with every fee kind and its expected adds
 *   SHELF, QR_PANEL, PICTURES, SIZED
 *                  minimal blueprints that make each check code appear
 *   generated(i)   a deterministic blueprint generator seeded by index: a
 *                  valid spec, its PublicBlueprint, a few valid configurations
 *                  and picture facts — the 30-blueprint sweeps
 */
import type { BlueprintSpec, DesignConfig, PaletteKey, PublicBlueprint, PublicSlotOption, PublicVariant, Rule, Slot, Area, Region } from '../../packages/catalog/src/personalize/types';
import { publicSpecOf } from '../../packages/catalog/src/personalize/spec';
import { defaultConfig, normalizeConfig } from '../../packages/catalog/src/personalize/config';
import { ICON_KEYS, LOOKS, PAINT_KEYS, SAY_CODES, STYLES } from '../../packages/catalog/src/personalize/vocab';
import { PART_KINDS } from '../../packages/catalog/src/personalize/parts';
import type { AssetFacts } from '../../packages/catalog/src/personalize/check';
import { front } from './personalizeBlueprints';

// ------------------------------------------------------------ the builders

export const EMPTY: Pick<BlueprintSpec, 'tags' | 'areas' | 'axes' | 'themes' | 'slots' | 'fixed' | 'rules' | 'extras' | 'photos' | 'licence' | 'warranty_days' | 'prep_days_add' | 'private'> = {
  tags: [], areas: [], axes: {}, themes: 'all', slots: [], fixed: [], rules: [], extras: { nfc: null, roster: null }, photos: [], licence: 'remix', warranty_days: 0, prep_days_add: {}, private: {},
};

export const region = (id: string, parts: number[], paint: Region['paint'], more: Partial<Region> = {}): Region => ({
  id, role: 'body', parts, tone: 'primary', paint, optional: null, shown_by: null, ...more,
});

export const nameArea = (id: string, regionId: string, more: Partial<Area> = {}, text: Partial<NonNullable<Area['text']>> = {}): Area => ({
  id, kind: 'text', role: 'name', region: regionId, frame: front(20, 60, 18),
  text: { lines: 1, max: 12, count: 1, styles: 'all', default_style: 'bold', min_cap_mm: 4, paint: { allowed: ['white', 'black', 'gold'], default: 'white' }, sample: { ar: 'علي', en: 'ALI', ckb: 'عەلی' }, ...text },
  required: false, fee_iqd: 0, ...more,
});

export const option = (key: string, product_id: string, variant_id: string | null, unit_iqd: number, in_stock = true): PublicSlotOption => ({
  key, product_id, variant_id, name: `${product_id} ${key}`, image: null, unit_iqd, in_stock,
});

/** Every combination of the spec's annotated groups; `price` per combination (by index), `soldOut` ids. */
export function variantsFor(spec: BlueprintSpec, price: (values: Record<string, string>, i: number) => number, soldOut: readonly string[] = []): PublicVariant[] {
  const axes = [spec.axes.size, spec.axes.look, spec.axes.tier].filter((a) => a !== undefined);
  if (!axes.length) return [];
  let combos: Array<Record<string, string>> = [{}];
  for (const a of axes) combos = combos.flatMap((c) => Object.keys(a.values).map((v) => ({ ...c, [a.group]: v })));
  return combos.map((values, i) => {
    const id = `pv_${Object.values(values).map((v) => v.replace(/^ov_/, '')).join('_')}`;
    return { id, values, price_iqd: price(values, i), in_stock: !soldOut.includes(id) };
  });
}

/** A PublicBlueprint of `spec` as the Worker would serve it (rev 1). */
export function publicOf(spec: BlueprintSpec, extra: Partial<PublicBlueprint> & { productId: string; price: number }): PublicBlueprint {
  const { productId, price, ...rest } = extra;
  const variants = rest.variants ?? [];
  return {
    ...publicSpecOf(spec),
    product: { id: productId, slug: productId, store_slug: 'levo-prints', name: productId, price_iqd: price, prep_days: 2 },
    variants,
    mesh: spec.regions.every((r) => !r.parts.length) ? null : { url: `/files/merchants/u_fixture/public/bp/bp_${productId}-r1-0123456789ab.lvm.gz`, hash: '0123456789ab', bytes: 50_000, triangles: 10_000, dims_mm: [100, 100, 100] },
    look: null,
    photos: spec.photos.map((p) => ({ ...p, url: `/files/merchants/u_fixture/public/products/${p.media_id}.webp` })),
    stock: null,
    stock_rgb: {},
    stock_names: {},
    slot_options: {},
    printer: null,
    from_iqd: variants.length ? Math.min(...variants.map((v) => v.price_iqd)) : price,
    rev: 1,
    ...rest,
  };
}

/** A canonical configuration of `pub` from a partial one (strict: it must be valid). */
export function configOf(pub: PublicBlueprint, set: (c: Record<string, any>) => void = () => {}, variant?: string | null): DesignConfig { // eslint-disable-line @typescript-eslint/no-explicit-any
  const raw = structuredClone(defaultConfig(pub, variant)) as Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
  set(raw);
  const r = normalizeConfig(raw, pub);
  if (!r.ok) throw new Error(`fixture config refused: ${JSON.stringify(r)}`);
  return r.value;
}

// ------------------------------------------------------------ the store rows

/** A product row and its variants, as `community_products` ⋈ `community_product_variants` hold them. */
export interface ProductRow {
  id: string;
  price_iqd: number;
  variant_mode: 'simple' | 'variants';
  variants: Array<{ id: string; values: Record<string, string>; price_iqd: number | null; active: 0 | 1; stock: number }>;
}
/** A part product as loadStoreParts reads it: one row per sellable unit, `v_price` null = the product's price. */
export interface PartRow { product_id: string; variant_id: string | null; price_iqd: number; v_price: number | null; stock: number; tracked: boolean }

/** The brief's rotating display (Part 3): a simple product and its three part products. */
export const ROTATING_ROWS: { product: ProductRow; parts: PartRow[] } = {
  product: { id: 'cp_rotating', price_iqd: 20_000, variant_mode: 'simple', variants: [] },
  parts: [
    { product_id: 'cp_motor', variant_id: 'pv_motor_a', price_iqd: 11_000, v_price: 8_000, stock: 4, tracked: true },
    { product_id: 'cp_motor', variant_id: 'pv_motor_b', price_iqd: 11_000, v_price: null, stock: 2, tracked: true },
    { product_id: 'cp_magnet', variant_id: 'pv_magnet_10', price_iqd: 1_500, v_price: 1_000, stock: 40, tracked: true },
    { product_id: 'cp_magnet', variant_id: 'pv_magnet_15', price_iqd: 1_500, v_price: null, stock: 12, tracked: true },
    { product_id: 'cp_magnet', variant_id: 'pv_magnet_20', price_iqd: 1_500, v_price: 2_500, stock: 0, tracked: true },
    { product_id: 'cp_led', variant_id: 'pv_led_white', price_iqd: 3_000, v_price: null, stock: 9, tracked: true },
    { product_id: 'cp_led', variant_id: 'pv_led_rgb', price_iqd: 3_000, v_price: 5_000, stock: 0, tracked: false },
  ],
};

/** The name stand: a variant product (size × look) whose medium silk has its own price, and its magnets. */
export const STAND_ROWS: { product: ProductRow; parts: PartRow[] } = {
  product: {
    id: 'cp_name_stand', price_iqd: 20_000, variant_mode: 'variants',
    variants: [
      { id: 'pv_s_classic', values: { og_size: 'ov_s', og_look: 'ov_classic' }, price_iqd: null, active: 1, stock: 5 },
      { id: 'pv_s_silk', values: { og_size: 'ov_s', og_look: 'ov_silk' }, price_iqd: 23_000, active: 1, stock: 5 },
      { id: 'pv_m_classic', values: { og_size: 'ov_m', og_look: 'ov_classic' }, price_iqd: 23_000, active: 1, stock: 5 },
      { id: 'pv_m_silk', values: { og_size: 'ov_m', og_look: 'ov_silk' }, price_iqd: 26_000, active: 1, stock: 5 },
      { id: 'pv_l_classic', values: { og_size: 'ov_l', og_look: 'ov_classic' }, price_iqd: 26_000, active: 1, stock: 5 },
      { id: 'pv_l_silk', values: { og_size: 'ov_l', og_look: 'ov_silk' }, price_iqd: 29_000, active: 1, stock: 0 },
    ],
  },
  parts: [
    { product_id: 'cp_magnet', variant_id: 'pv_magnet_10', price_iqd: 1_500, v_price: 1_000, stock: 40, tracked: true },
    { product_id: 'cp_magnet', variant_id: 'pv_magnet_15', price_iqd: 1_500, v_price: null, stock: 12, tracked: true },
  ],
};

// ------------------------------------------------------------ every fee kind

/**
 * Every fee kind at once: a required area on an optional piece, a filled
 * optional area, an optional piece switched on, premium colours on two
 * targets, one colour past the included two, an 'add' slot × 2, an
 * 'included' slot above its default, a fixed-choice slot × 4, an 'included'
 * slot with no default (measured against its cheapest option), a hidden
 * piece shown by a slot, and an NFC tag.
 */
export const FEES_SPEC: BlueprintSpec = {
  ...EMPTY,
  v: 1, family: 'stand', sell: { cart: true, request: false },
  regions: [
    region('body', [0], { allowed: 'all', default: 'black', premium: { gold: 1_500 } }),
    region('base', [1], { allowed: ['white', 'black', 'gold'], default: 'white', premium: { gold: 1_000 } }, { role: 'base', tone: 'secondary' }),
    region('stand', [2], { allowed: ['silver'], default: 'silver' }, { role: 'accessory', tone: 'neutral', optional: { on: false, fee_iqd: 2_500 } }),
    region('glow', [3], { allowed: ['clear'], default: 'clear' }, { role: 'accessory', tone: 'accent', shown_by: 'light' }),
  ],
  areas: [
    nameArea('name', 'body', { required: true }),
    nameArea('tagline', 'base', { role: 'text', frame: front(-20, 60, 10), fee_iqd: 2_000 }, { max: 20, paint: { allowed: ['red', 'white'], default: 'white' } }),
    { id: 'logo', kind: 'logo', role: 'logo', region: 'base', frame: front(-40, 30, 30), logo: { max_colors: 2, modes: ['flat'] }, required: false, fee_iqd: 3_000 },
    nameArea('plaque', 'stand', { role: 'text', frame: front(-60, 40, 10), required: true, fee_iqd: 1_200 }, { paint: { allowed: ['black'], default: 'black' } }),
  ],
  axes: { size: { group: 'og_size', values: { ov_s: { dims_mm: [80, 60, 90], scale: 0.8 }, ov_m: { dims_mm: [100, 75, 112], scale: 1, recommended: true }, ov_l: { dims_mm: [125, 94, 140], scale: 1.25 } } } },
  colors: { included: 2, per_extra_iqd: 750, max: 5 },
  slots: [
    { id: 'magnet', kind: 'magnet', qty: 2, required: true, choice: 'customer', pricing: 'add', options: [{ key: 'm10', part: { p: 'cp_magnet', v: 'pv_magnet_10' } }, { key: 'm15', part: { p: 'cp_magnet', v: 'pv_magnet_15' } }], default: 'm10' },
    { id: 'light', kind: 'led', qty: 1, required: false, choice: 'customer', pricing: 'included', options: [{ key: 'warm', part: { p: 'cp_led', v: 'pv_led_warm' } }, { key: 'rgb', part: { p: 'cp_led', v: 'pv_led_rgb' } }, { key: 'cold', part: { p: 'cp_led', v: 'pv_led_cold' } }], default: 'warm' },
    { id: 'screw', kind: 'screw', qty: 4, required: false, choice: 'fixed', pricing: 'add', options: [{ key: 's3', part: { p: 'cp_screw', v: null } }], default: 's3' },
    { id: 'motor', kind: 'motor', qty: 1, required: false, choice: 'customer', pricing: 'included', options: [{ key: 'a', part: { p: 'cp_motor', v: 'pv_motor_a' } }, { key: 'b', part: { p: 'cp_motor', v: 'pv_motor_b' } }] },
  ],
  fixed: [{ part: { p: 'cp_glue', v: null }, qty: 1, show: false }],
  extras: { nfc: { kinds: ['website'], fee_iqd: 3_500 }, roster: null },
};

export const FEES_PUB: PublicBlueprint = publicOf(FEES_SPEC, {
  productId: 'cp_fees', price: 20_000,
  variants: variantsFor(FEES_SPEC, (v) => ({ ov_s: 18_000, ov_m: 20_000, ov_l: 24_000 })[v.og_size]!),
  slot_options: {
    magnet: [option('m10', 'cp_magnet', 'pv_magnet_10', 1_000), option('m15', 'cp_magnet', 'pv_magnet_15', 1_500)],
    light: [option('warm', 'cp_led', 'pv_led_warm', 2_000), option('rgb', 'cp_led', 'pv_led_rgb', 4_500), option('cold', 'cp_led', 'pv_led_cold', 1_500)],
    screw: [option('s3', 'cp_screw', null, 100)],
    motor: [option('a', 'cp_motor', 'pv_motor_a', 8_000), option('b', 'cp_motor', 'pv_motor_b', 11_000)],
  },
});

/** Medium, gold body and base, a red tagline, the stand on, magnets 15 mm, the RGB light, motor B, an NFC link. */
export const FEES_CONFIG: DesignConfig = configOf(FEES_PUB, (c) => {
  c.colors.body = 'gold';
  c.colors.base = 'gold';
  c.colors.tagline = 'red';
  c.texts.name.value = ['ALI'];
  c.texts.tagline.value = ['Hello'];
  c.parts.stand = true;
  c.slots.magnet = { option: 'm15' };
  c.slots.light = { option: 'rgb' };
  c.slots.motor = { option: 'b' };
  c.nfc = { kind: 'website', value: 'example.com' };
}, 'pv_m');

export const FEES_ADDS = [
  { key: 'area:tagline', iqd: 2_000 },
  { key: 'area:plaque', iqd: 1_200 },
  { key: 'region:stand', iqd: 2_500 },
  { key: 'colour:gold', iqd: 2_500 },
  { key: 'colours:extra', iqd: 750 },
  { key: 'slot:magnet', iqd: 1_500, qty: 2 },
  { key: 'slot:light', iqd: 2_500 },
  { key: 'slot:screw', iqd: 100, qty: 4 },
  { key: 'slot:motor', iqd: 3_000 },
  { key: 'nfc', iqd: 3_500 },
];
export const FEES_UNIT_IQD = 41_350;

// ------------------------------------------------------------ the check worlds

/** Colours and the shop's shelf: a 'stocked' body, a listed trim, an 'all' base. */
export const SHELF_SPEC: BlueprintSpec = {
  ...EMPTY,
  v: 1, family: 'decor', sell: { cart: true, request: false },
  regions: [
    region('body', [0], { allowed: 'stocked', default: 'black' }),
    region('trim', [1], { allowed: ['red', 'white', 'navy', 'blue'], default: 'white' }, { role: 'accent', tone: 'accent' }),
    region('base', [2], { allowed: 'all', default: 'white' }, { role: 'base', tone: 'secondary' }),
  ],
  colors: { included: 3, per_extra_iqd: 0, max: 3 },
};
/** blue → the shop's navy (`sub:`), red out, purple not stocked; the shop's own navy line is bluish. */
export const SHELF_STOCK: NonNullable<PublicBlueprint['stock']> = { default: { black: 'in', white: 'in', navy: 'in', teal: 'in', blue: 'sub:navy', red: 'out' } };
export const shelfPub = (over: Partial<BlueprintSpec> = {}, pub: Partial<PublicBlueprint> = {}): PublicBlueprint =>
  publicOf({ ...SHELF_SPEC, ...over }, { productId: 'cp_shelf', price: 10_000, stock: SHELF_STOCK, ...pub });

/** A QR on a panel over a body, three sizes (the large one the same price as the medium unless `large` says otherwise). */
export function qrPanel(over: { panel?: Region['paint']; body?: Region['paint']; large?: number; min_module_mm?: number; printer?: PublicBlueprint['printer']; rules?: Rule[] } = {}): PublicBlueprint {
  const spec: BlueprintSpec = {
    ...EMPTY,
    v: 1, family: 'stand', sell: { cart: true, request: false },
    regions: [
      region('body', [0], over.body ?? { allowed: ['black', 'white'], default: 'black' }),
      region('panel', [1], over.panel ?? { allowed: ['navy', 'white'], default: 'white' }, { role: 'logo', tone: 'secondary' }),
    ],
    areas: [{ id: 'qr', kind: 'qr', role: 'qr', region: 'panel', frame: front(10, 20, 20), qr: { kinds: ['website', 'instagram', 'whatsapp', 'menu'], min_module_mm: over.min_module_mm ?? 0.8 }, required: true, fee_iqd: 0 }],
    axes: { size: { group: 'og_size', values: { ov_s: { dims_mm: [60, 40, 80], scale: 1, recommended: true }, ov_m: { dims_mm: [90, 60, 120], scale: 1.5 }, ov_l: { dims_mm: [150, 100, 200], scale: 2.5 } } } },
    colors: { included: 2, per_extra_iqd: 0, max: 2 },
    rules: over.rules ?? [],
  };
  return publicOf(spec, {
    productId: 'cp_qr_panel', price: 10_000, printer: over.printer ?? null,
    variants: variantsFor(spec, (v) => ({ ov_s: 10_000, ov_m: 12_000, ov_l: over.large ?? 12_000 })[v.og_size]!),
  });
}
/** A long menu address: 100 bytes → version 6 (41 modules). */
export const LONG_MENU = `https://example.com/${'m'.repeat(80)}`;

/** A logo area and a silhouette photo area, both on the body. */
export const PICTURES_SPEC: BlueprintSpec = {
  ...EMPTY,
  v: 1, family: 'frame', sell: { cart: true, request: true },
  regions: [region('body', [0], { allowed: ['white', 'black'], default: 'white' }), region('back', [1], { allowed: ['black'], default: 'black' })],
  areas: [
    { id: 'logo', kind: 'logo', role: 'logo', region: 'body', frame: front(30, 40, 40), logo: { max_colors: 2, modes: ['flat', 'raised'] }, required: false, fee_iqd: 0 },
    { id: 'photo', kind: 'photo', role: 'photo', region: 'back', frame: front(-20, 100, 80), photo: { modes: ['silhouette', 'lithophane'], min_px_per_mm: 5 }, required: false, fee_iqd: 0 },
  ],
  colors: { included: 2, per_extra_iqd: 0, max: 2 },
};
export const PICTURES_PUB: PublicBlueprint = publicOf(PICTURES_SPEC, { productId: 'cp_pictures', price: 15_000 });
export const ASSET_KEY = 'users/u_owner/design-assets/a1b2c3.png';

// ------------------------------------------------------------ the generator

/** mulberry32 — a small deterministic PRNG. */
export function prng(seed: number): () => number {
  let a = seed | 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export interface Generated {
  spec: BlueprintSpec;
  pub: PublicBlueprint;
  opts: { partCount: number; variantGroups: Record<string, string[]>; mediaIds: string[] };
  configs: DesignConfig[];
  assets: Record<string, AssetFacts>;
}

const NAMES = ['ALI', 'SARA', 'MOHAMMED', 'علي', 'ئەڤین', 'LEVO PRINTS', 'Happy Birthday Omar', 'WWWWWWWWWWWW', 'نور الهدى', 'X'];

/** Blueprint `i` of the sweep: every feature drawn from a PRNG seeded by `i`, always a valid spec. */
export function generated(i: number): Generated {
  const rnd = prng(7919 * (i + 1));
  const int = (a: number, b: number): number => a + Math.floor(rnd() * (b - a + 1));
  const pick = <T>(xs: readonly T[]): T => xs[int(0, xs.length - 1)];
  const chance = (p: number): boolean => rnd() < p;
  const some = <T>(xs: readonly T[], n: number): T[] => [...xs].sort(() => rnd() - 0.5).slice(0, n);
  const photoOnly = i % 6 === 5;

  const regions: Region[] = [];
  const nRegions = int(1, 4);
  for (let r = 0; r < nRegions; r++) {
    const mode = pick(['stocked', 'all', 'one', 'list', 'list'] as const);
    const list = mode === 'one' ? some(PAINT_KEYS, 1) : mode === 'list' ? some(PAINT_KEYS, int(2, 4)) : null;
    const allowed = list ?? (mode as 'stocked' | 'all');
    const dflt = list ? list[0] : pick(['black', 'white', 'navy', 'red'] as const);
    const premiumKey = list ? pick(list) : pick(PAINT_KEYS);
    regions.push(region(`r${r}`, photoOnly ? [] : [r], { allowed, default: dflt, ...(chance(0.3) ? { premium: { [premiumKey]: 500 * int(1, 4) } } : {}) }, {
      role: pick(['body', 'base', 'name', 'accent', 'border', 'accessory'] as const),
      optional: r > 0 && chance(0.25) ? { on: chance(0.5), fee_iqd: 250 * int(0, 8) } : null,
    }));
  }

  const photos = photoOnly ? [{ media_id: 'pm_0' }, { media_id: 'pm_1', colour: 'white' as PaletteKey }] : [];
  const where = (k: number): Pick<Area, 'frame' | 'photo_frame'> =>
    photoOnly ? { photo_frame: { media_id: 'pm_0', quad: [[0.2, 0.2 + 0.15 * k], [0.8, 0.2 + 0.15 * k], [0.8, 0.3 + 0.15 * k], [0.2, 0.3 + 0.15 * k]] } } : { frame: front(40 - 25 * k, int(10, 80), int(8, 40)) };
  const areas: Area[] = [];
  const nAreas = int(0, 4);
  for (let k = 0; k < nAreas; k++) {
    const kind = pick(['text', 'text', 'logo', 'photo', 'qr', 'icon'] as const);
    const base = { id: `a${k}`, region: pick(regions).id, required: chance(0.35), fee_iqd: chance(0.4) ? 500 * int(1, 6) : 0, ...where(k) };
    if (kind === 'text') {
      const styles = chance(0.5) ? ('all' as const) : some(STYLES, int(1, 3));
      const tl = pick([['white', 'black'], ['gold'], ['red', 'white', 'black', 'gold']] as PaletteKey[][]);
      areas.push({
        ...base, kind, role: pick(['name', 'text'] as const),
        text: { lines: int(1, 2), max: int(6, 20), count: 1, styles, default_style: styles === 'all' ? 'bold' : styles[0], min_cap_mm: int(3, 6), paint: { allowed: tl, default: tl[0] }, sample: { ar: 'علي', en: 'ALI', ckb: 'عەلی' } },
      });
    } else if (kind === 'logo') areas.push({ ...base, kind, role: kind, logo: { max_colors: int(1, 3), modes: ['flat'] } });
    else if (kind === 'photo') areas.push({ ...base, kind, role: kind, photo: { modes: some(['lithophane', 'relief', 'silhouette', 'print'] as const, int(1, 2)), min_px_per_mm: int(3, 8) } });
    else if (kind === 'qr') areas.push({ ...base, kind, role: kind, qr: { kinds: ['website', 'instagram', 'whatsapp'], min_module_mm: pick([0.5, 0.8, 1]) } });
    else areas.push({ ...base, kind, role: kind, icon: { keys: chance(0.5) ? 'all' : some(ICON_KEYS, int(2, 5)) } });
  }

  const axes: BlueprintSpec['axes'] = {};
  if (chance(0.65)) {
    const n = int(1, 4);
    const values: Record<string, { dims_mm: [number, number, number]; scale: number; recommended?: true }> = {};
    const rec = int(0, n - 1);
    for (let s = 0; s < n; s++) {
      const scale = [0.8, 1, 1.25, 1.6][s];
      values[`ov_s${s}`] = { dims_mm: [Math.round(120 * scale), Math.round(80 * scale), Math.round(150 * scale)], scale, ...(s === rec ? { recommended: true as const } : {}) };
    }
    axes.size = { group: 'og_size', values };
  }
  if (chance(0.4)) {
    const looks = some(LOOKS, int(1, 3));
    axes.look = { group: 'og_look', values: Object.fromEntries(looks.map((l, k) => [`ov_l${k}`, { look: l, material_id: `pla-${l}` }])) };
  }
  if (chance(0.3)) axes.tier = { group: 'og_tier', values: { ov_value: { tier: 'value' }, ov_best: { tier: 'best' } } };

  const slots: Slot[] = [];
  const nSlots = int(0, 3);
  for (let s = 0; s < nSlots; s++) {
    const choice = chance(0.8) ? ('customer' as const) : ('fixed' as const);
    const required = chance(0.4);
    const n = int(1, 4);
    const options = Array.from({ length: n }, (_, k) => ({ key: `o${k}`, part: { p: `cp_g${i}_s${s}`, v: chance(0.8) ? `pv_g${i}_s${s}_${k}` : k === 0 ? null : `pv_g${i}_s${s}_${k}` } }));
    slots.push({
      id: `s${s}`, kind: pick(PART_KINDS), qty: int(1, 3), required, choice, pricing: chance(0.6) ? 'add' : 'included', options,
      ...(required || choice === 'fixed' || chance(0.4) ? { default: `o${int(0, n - 1)}` } : {}),
    });
  }
  // A hidden piece switched by a slot or an icon.
  const hidden = regions.find((r, k) => k > 0 && !r.optional);
  const icon = areas.find((a) => a.kind === 'icon');
  if (hidden && slots.length && chance(0.4)) hidden.shown_by = chance(0.5) ? slots[0].id : `${slots[0].id}:o0`;
  else if (hidden && icon && chance(0.5)) hidden.shown_by = `${icon.id}:${icon.icon!.keys === 'all' ? 'heart' : icon.icon!.keys[0]}`;

  const rules: Rule[] = [];
  const sizeIds = Object.keys(axes.size?.values ?? {});
  const texts = areas.filter((a) => a.kind === 'text');
  const qrs = areas.filter((a) => a.kind === 'qr');
  const multi = slots.filter((s) => s.options.length > 1);
  const colourIds = [...regions.map((r) => r.id), ...texts.map((a) => a.id)];
  const nRules = int(0, 3);
  for (let k = 0; k < nRules; k++) {
    const kind = pick(['text', 'slot', 'qr', 'value', 'pair', 'colours'] as const);
    const fix = pick(['auto', 'suggest'] as const);
    const say = pick(SAY_CODES);
    const id = `u${k}`;
    const top = sizeIds.length ? sizeIds[int(Math.min(1, sizeIds.length - 1), sizeIds.length - 1)] : null;
    if (kind === 'text' && texts.length && top) rules.push({ id, if: { text: pick(texts).id, longer_than: int(3, 8) }, then: { size_at_least: top }, fix, say });
    else if (kind === 'slot' && multi.length && top) {
      const s = pick(multi);
      rules.push({ id, if: { slot: s.id, is: pick(s.options).key }, then: { size_at_least: top }, fix, say });
    } else if (kind === 'qr' && qrs.length && top) rules.push({ id, if: { qr: pick(qrs).id }, then: { size_at_least: top }, fix, say });
    else if (kind === 'value' && axes.look) {
      const v = pick(Object.keys(axes.look.values));
      rules.push({ id, if: { value: v }, then: { only_colors: { target: pick(colourIds), keys: some(PAINT_KEYS, int(2, 5)) } }, fix, say });
    } else if (kind === 'pair' && multi.length > 1) {
      const [a, b] = some(multi, 2);
      rules.push({ id, if: { slot: a.id, is: pick(a.options).key }, then: chance(0.5) ? { requires: { slot: b.id, is: pick(b.options).key } } : { excludes: { slot: b.id, is: pick(b.options).key } }, fix, say });
    } else if (kind === 'colours' && multi.length) {
      const s = pick(multi);
      rules.push({ id, if: { slot: s.id, is: pick(s.options).key }, then: { max_colors: int(1, 3) }, fix, say });
    }
  }

  const included = int(1, 3);
  const spec: BlueprintSpec = {
    v: 1, family: 'decor', tags: [], sell: chance(0.8) ? { cart: true, request: chance(0.5) } : { cart: false, request: true },
    regions, areas, axes, colors: { included, per_extra_iqd: chance(0.5) ? 500 * int(1, 3) : 0, max: int(included, 5) },
    themes: pick(['all', [], ['mono', 'royal']] as Array<BlueprintSpec['themes']>), slots, fixed: chance(0.3) ? [{ part: { p: 'cp_glue', v: null }, qty: 1, show: false }] : [], rules,
    extras: { nfc: chance(0.3) ? { kinds: ['website', 'whatsapp'], fee_iqd: 500 * int(0, 8) } : null, roster: texts.length && chance(0.15) ? { vary: [texts[0].id], max: int(2, 30) } : null },
    photos, licence: 'remix', warranty_days: 0, prep_days_add: {}, private: {},
  };

  const base = 1_000 * int(5, 40);
  const variants = variantsFor(spec, () => base + 1_000 * int(0, 4) * (chance(0.5) ? 1 : 0));
  for (const v of variants) v.in_stock = chance(0.85);
  const slot_options: Record<string, PublicSlotOption[]> = {};
  for (const s of slots) slot_options[s.id] = s.options.map((o) => option(o.key, o.part.p, o.part.v, 250 * int(0, 40), chance(0.85)));
  const keys = some(PAINT_KEYS, int(4, 12));
  const stockMap: Partial<Record<PaletteKey, 'in' | 'out' | `sub:${PaletteKey}`>> = {};
  keys.forEach((k, n) => (stockMap[k] = n < 2 || chance(0.7) ? 'in' : chance(0.5) ? 'out' : `sub:${keys[0]}`));
  const stock: PublicBlueprint['stock'] = chance(0.3) ? null : { default: stockMap, ...(axes.look ? { [Object.values(axes.look.values)[0].look]: { [keys[0]]: 'in', [keys[1]]: 'in' } } : {}) };
  const pub = publicOf(spec, {
    productId: `cp_gen_${i}`, price: base, variants, slot_options, stock,
    printer: chance(0.35) ? null : { max_mm: [int(120, 300), int(120, 300), int(150, 300)] },
  });

  const configs: DesignConfig[] = [defaultConfig(pub)];
  for (let n = 0; n < 4; n++) {
    const raw = structuredClone(configs[0]) as Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
    if (variants.length) raw.variant = pick(variants).id;
    for (const id of colourIds) if (chance(0.6)) raw.colors[id] = pick(PAINT_KEYS);
    for (const a of areas) {
      if (a.kind === 'text' && chance(0.8)) raw.texts[a.id] = { value: [pick(NAMES)], style: pick(STYLES) };
      if (a.kind === 'qr' && chance(0.8)) raw.qr[a.id] = pick([{ kind: 'website', value: `https://example.com/${'q'.repeat(int(1, 150))}` }, { kind: 'instagram', value: 'ali.prints' }, { kind: 'whatsapp', value: '07701234567' }]);
      if (a.kind === 'icon' && chance(0.8)) raw.icon[a.id] = pick(ICON_KEYS);
      if (a.kind === 'logo' && chance(0.8)) raw.logo[a.id] = { key: ASSET_KEY, crop: [0, 0, 1, 1], mode: 'flat' };
      if (a.kind === 'photo' && chance(0.8)) raw.photo[a.id] = { key: ASSET_KEY, crop: [0, 0, 1, 1], mode: a.photo!.modes[0] };
    }
    for (const r of regions) if (r.optional && chance(0.5)) raw.parts[r.id] = chance(0.5);
    for (const s of slots) if (s.choice === 'customer' && chance(0.7)) raw.slots[s.id] = { option: chance(0.8) ? pick(s.options).key : null };
    if (spec.extras.nfc && chance(0.5)) raw.nfc = { kind: 'website', value: 'example.com' };
    const r = normalizeConfig(raw, pub, { lenient: true });
    if (r.ok) configs.push(r.value);
  }
  const assets: Record<string, AssetFacts> = {};
  for (const a of areas) if (a.kind === 'logo' || a.kind === 'photo') assets[a.id] = { px_w: int(100, 2400), px_h: int(100, 2400), colours: int(1, 14), has_alpha: chance(0.5) };
  const variantGroups = Object.fromEntries(Object.values(axes).filter((a) => a !== undefined).map((a) => [a.group, Object.keys(a.values)]));
  return { spec, pub, opts: { partCount: photoOnly ? 0 : nRegions, variantGroups, mediaIds: photos.map((p) => p.media_id) }, configs, assets };
}
