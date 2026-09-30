/**
 * BLUEPRINT FIXTURES FOR THE PERSONALIZATION ENGINE (Programme C, C1 lane L1).
 *
 * The five archetypes of the customer track (docs/LEVO_PROJECT_PROGRAMME_SURVEY.md
 * §5.3: name stand, QR menu stand, request-only photo lamp, name keychain,
 * group participant), a photo-only sign (no mesh, §0 row 39), an icon area
 * (the keychain's, with an alternative charm part switched by `shown_by`) and
 * the brief's rotating display — base 20,000 + 2 × 1,000 magnets + RGB LED
 * 5,000 + motor 8,000 = 35,000 IQD (`GOLDEN_CONFIG`).
 *
 * Every `spec` is already in normalised form: `normalizeBlueprint(spec, opts)`
 * returns it unchanged (the round trip is pinned in personalizeSpec). `pub`
 * is the PublicBlueprint the Worker would serve for it. `tiles` is the
 * surface the survey pins for the archetype (compiled tiles, without the
 * door) — surface.ts's contract, not this lane's.
 *
 * Reused by L2 (price, rules, surface, check), L3 (fit, themes), L5 (routes),
 * L8 (studio) and L10 (privacy, vocabulary): import, never copy.
 */
import type { BlueprintSpec, DesignConfig, Frame, PublicBlueprint, PublicSlotOption, PublicVariant, TileId } from '../../packages/catalog/src/personalize/types';
import { publicSpecOf } from '../../packages/catalog/src/personalize/spec';

/** A frame on the front face (−y), `z` millimetres up. */
export const front = (z: number, w: number, h: number, y = -40): Frame => ({ o: [0, y, z], n: [0, -1, 0], u: [0, 0, 1], w, h });

/** Strings that exist only in `private`, hidden fixed parts and `accepts` — none may reach a public body. */
export const PRIVATE_MARKERS = ['PRIVATE-NOTE-7f3a', 'PRIVATE-QUALITY-19c2', 'cp_hidden_glue', 'diameter_mm', 'accepts', 'quality_notes'] as const;

export const NAME_STAND: BlueprintSpec = {
  v: 1,
  family: 'stand',
  tags: ['occ:birthday', 'for:kids'],
  sell: { cart: true, request: true },
  regions: [
    { id: 'body', role: 'body', parts: [0], tone: 'primary', paint: { allowed: 'stocked', default: 'black' }, optional: null, shown_by: null },
    { id: 'base', role: 'base', parts: [1], tone: 'secondary', paint: { allowed: 'stocked', default: 'white' }, optional: null, shown_by: null },
    { id: 'plate', role: 'name', parts: [2], tone: 'accent', paint: { allowed: ['black', 'white', 'gold', 'silver'], default: 'white', premium: { gold: 1000 } }, optional: null, shown_by: null },
  ],
  areas: [
    {
      id: 'name', kind: 'text', role: 'name', region: 'plate', frame: front(20, 62, 18),
      text: { lines: 1, max: 12, count: 1, styles: 'all', default_style: 'bold', min_cap_mm: 4, paint: { allowed: ['black', 'white', 'red', 'gold'], default: 'black' }, sample: { ar: 'علي', en: 'ALI', ckb: 'عەلی' } },
      required: true, fee_iqd: 0,
    },
  ],
  axes: {
    size: { group: 'og_size', values: { ov_s: { dims_mm: [120, 80, 96], scale: 0.8 }, ov_m: { dims_mm: [150, 100, 120], scale: 1, recommended: true }, ov_l: { dims_mm: [188, 125, 150], scale: 1.25 } } },
    look: { group: 'og_look', values: { ov_classic: { look: 'classic', material_id: 'pla' }, ov_silk: { look: 'silk', material_id: 'pla-silk' } } },
  },
  colors: { included: 3, per_extra_iqd: 1000, max: 4 },
  themes: 'all',
  slots: [
    {
      id: 'magnet', kind: 'magnet', qty: 2, required: false, choice: 'customer', pricing: 'add',
      options: [{ key: 'm10', part: { p: 'cp_magnet', v: 'pv_magnet_10' } }, { key: 'm15', part: { p: 'cp_magnet', v: 'pv_magnet_15' } }],
      show: { effect: 'ring', anchor: front(-40, 15, 15, -30) },
      accepts: { shape: 'round', diameter_mm: { min: 10, max: 15 } },
    },
  ],
  fixed: [{ part: { p: 'cp_hidden_glue', v: null }, qty: 1, show: false }, { part: { p: 'cp_felt_pads', v: null }, qty: 4, show: true }],
  rules: [
    { id: 'long-name', if: { text: 'name', longer_than: 10 }, then: { size_at_least: 'ov_m' }, fix: 'suggest', say: 'text_needs_size' },
    { id: 'big-magnet', if: { slot: 'magnet', is: 'm15' }, then: { size_at_least: 'ov_l' }, fix: 'suggest', say: 'addon_needs_size' },
    { id: 'silk-colours', if: { value: 'ov_silk' }, then: { only_colors: { target: 'body', keys: ['black', 'gold', 'silver', 'blue'] } }, fix: 'auto', say: 'look_limits_colors' },
  ],
  extras: { nfc: null, roster: null },
  photos: [],
  licence: 'remix',
  warranty_days: 30,
  prep_days_add: { size: { ov_l: 1 } },
  private: { quality_notes: { value: '0.20 mm · 15 %', best: 'PRIVATE-QUALITY-19c2 0.12 mm' }, notes: 'PRIVATE-NOTE-7f3a: glue the base before the magnets' },
};

export const QR_MENU_STAND: BlueprintSpec = {
  v: 1,
  family: 'stand',
  tags: ['biz'],
  sell: { cart: true, request: false },
  regions: [
    { id: 'body', role: 'body', parts: [0], tone: 'primary', paint: { allowed: 'stocked', default: 'white' }, optional: null, shown_by: null },
    { id: 'panel', role: 'logo', parts: [1], tone: 'secondary', paint: { allowed: 'stocked', default: 'black' }, optional: null, shown_by: null },
  ],
  areas: [
    { id: 'logo', kind: 'logo', role: 'logo', region: 'panel', frame: front(60, 50, 50), logo: { max_colors: 2, modes: ['flat', 'raised'] }, required: true, fee_iqd: 0 },
    { id: 'qr', kind: 'qr', role: 'qr', region: 'panel', frame: front(10, 40, 40), qr: { kinds: ['menu', 'website', 'instagram', 'whatsapp'], min_module_mm: 1 }, required: true, fee_iqd: 0 },
    {
      id: 'shop', kind: 'text', role: 'text', region: 'body', frame: front(-30, 90, 16),
      text: { lines: 2, max: 24, count: 1, styles: ['elegant', 'minimal', 'bold'], default_style: 'minimal', min_cap_mm: 5, paint: { allowed: 'stocked', default: 'black' }, sample: { ar: 'مقهى الورد', en: 'Rose Café', ckb: 'کافێی گوڵ' } },
      required: false, fee_iqd: 2000,
    },
  ],
  axes: { tier: { group: 'og_tier', values: { ov_value: { tier: 'value' }, ov_best: { tier: 'best' } } } },
  colors: { included: 2, per_extra_iqd: 1500, max: 4 },
  themes: ['mono', 'royal', 'fresh'],
  slots: [],
  fixed: [],
  rules: [],
  extras: { nfc: { kinds: ['website', 'whatsapp', 'wifi'], fee_iqd: 3500 }, roster: null },
  photos: [],
  licence: 'personal',
  warranty_days: 0,
  prep_days_add: { tier_best: 1 },
  private: {},
};

export const PHOTO_LAMP: BlueprintSpec = {
  v: 1,
  family: 'lamp',
  tags: ['occ:wedding', 'for:family'],
  sell: { cart: false, request: true },
  regions: [
    { id: 'shade', role: 'body', parts: [0], tone: 'neutral', paint: { allowed: ['white'], default: 'white' }, optional: null, shown_by: null },
    { id: 'base', role: 'base', parts: [1], tone: 'neutral', paint: { allowed: ['white'], default: 'white' }, optional: null, shown_by: null },
  ],
  areas: [
    { id: 'photo', kind: 'photo', role: 'photo', region: 'shade', frame: front(40, 90, 110, -45), photo: { modes: ['lithophane'], min_px_per_mm: 5 }, required: true, fee_iqd: 0 },
    {
      id: 'caption', kind: 'text', role: 'text', region: 'base', frame: front(-55, 80, 12, -45),
      text: { lines: 1, max: 20, count: 1, styles: ['elegant'], default_style: 'elegant', min_cap_mm: 4, paint: { allowed: ['white'], default: 'white' }, sample: { ar: 'ليلة العمر', en: 'Our day', ckb: 'ڕۆژی ئێمە' } },
      required: false, fee_iqd: 0,
    },
  ],
  axes: { size: { group: 'og_size', values: { ov_s: { dims_mm: [100, 100, 150], scale: 1, recommended: true }, ov_l: { dims_mm: [140, 140, 210], scale: 1.4 } } } },
  colors: { included: 1, per_extra_iqd: 0, max: 1 },
  themes: [],
  slots: [],
  fixed: [],
  rules: [],
  extras: { nfc: null, roster: null },
  photos: [],
  licence: 'no_remix',
  warranty_days: 90,
  prep_days_add: {},
  private: {},
};

export const NAME_KEYCHAIN: BlueprintSpec = {
  v: 1,
  family: 'keychain',
  tags: ['for:friend'],
  sell: { cart: true, request: false },
  regions: [
    { id: 'tag', role: 'body', parts: [0], tone: 'primary', paint: { allowed: 'all', default: 'navy' }, optional: null, shown_by: null },
    { id: 'charm', role: 'icon', parts: [1], tone: 'accent', paint: { allowed: ['red', 'pink', 'gold'], default: 'red' }, optional: null, shown_by: 'badge:heart' },
    { id: 'ring', role: 'accessory', parts: [2], tone: 'neutral', paint: { allowed: ['silver', 'gold'], default: 'silver' }, optional: { on: true, fee_iqd: 500 }, shown_by: null },
  ],
  areas: [
    {
      id: 'name', kind: 'text', role: 'name', region: 'tag', frame: front(0, 40, 12, -3),
      text: { lines: 1, max: 10, count: 1, styles: ['fun', 'gaming', 'bold'], default_style: 'fun', min_cap_mm: 3, paint: { allowed: 'all', default: 'white' }, sample: { ar: 'سارة', en: 'SARA', ckb: 'سارا' } },
      required: true, fee_iqd: 0,
    },
    { id: 'badge', kind: 'icon', role: 'icon', region: 'tag', frame: front(0, 10, 10, -3), icon: { keys: ['heart', 'star', 'crown', 'gamepad-2'] }, required: false, fee_iqd: 1000 },
  ],
  axes: { tier: { group: 'og_tier', values: { ov_value: { tier: 'value' }, ov_best: { tier: 'best' } } } },
  colors: { included: 2, per_extra_iqd: 500, max: 4 },
  themes: 'all',
  slots: [],
  fixed: [],
  rules: [],
  extras: { nfc: null, roster: null },
  photos: [],
  licence: 'remix',
  warranty_days: 0,
  prep_days_add: {},
  private: {},
};

export const GROUP_PARTICIPANT: BlueprintSpec = {
  v: 1,
  family: 'keychain',
  tags: ['for:team'],
  sell: { cart: true, request: false },
  regions: [{ id: 'body', role: 'body', parts: [0], tone: 'primary', paint: { allowed: ['red', 'blue', 'green', 'yellow'], default: 'blue' }, optional: null, shown_by: null }],
  areas: [
    {
      id: 'name', kind: 'text', role: 'name', region: 'body', frame: front(0, 45, 12, -3),
      text: { lines: 1, max: 12, count: 1, styles: ['bold'], default_style: 'bold', min_cap_mm: 4, paint: { allowed: ['white'], default: 'white' }, sample: { ar: 'عمر', en: 'OMAR', ckb: 'ئۆمەر' } },
      required: true, fee_iqd: 0,
    },
  ],
  axes: {},
  colors: { included: 2, per_extra_iqd: 0, max: 2 },
  themes: [],
  slots: [],
  fixed: [],
  rules: [],
  extras: { nfc: null, roster: { vary: ['name', 'body'], max: 30 } },
  photos: [],
  licence: 'remix',
  warranty_days: 0,
  prep_days_add: {},
  private: {},
};

/** No mesh: the product's photos per colour and size, the name drawn on a photo. */
export const PHOTO_ONLY_SIGN: BlueprintSpec = {
  v: 1,
  family: 'sign',
  tags: ['biz', 'occ:opening'],
  sell: { cart: true, request: false },
  regions: [{ id: 'board', role: 'body', parts: [], tone: 'primary', paint: { allowed: ['black', 'white', 'wood'], default: 'wood' }, optional: null, shown_by: null }],
  areas: [
    {
      id: 'name', kind: 'text', role: 'name', region: 'board', photo_frame: { media_id: 'pm_wood', quad: [[0.2, 0.35], [0.8, 0.35], [0.8, 0.55], [0.2, 0.55]] },
      text: { lines: 2, max: 18, count: 1, styles: ['elegant', 'bold'], default_style: 'elegant', min_cap_mm: 8, paint: { allowed: ['black', 'white', 'gold'], default: 'black' }, sample: { ar: 'متجر الأمل', en: 'Hope Store', ckb: 'فرۆشگای هیوا' } },
      required: true, fee_iqd: 0,
    },
  ],
  axes: { size: { group: 'og_size', values: { ov_s: { dims_mm: [300, 100, 5], scale: 1, recommended: true }, ov_l: { dims_mm: [450, 150, 5], scale: 1.5 } } } },
  colors: { included: 2, per_extra_iqd: 0, max: 2 },
  themes: [],
  slots: [],
  fixed: [],
  rules: [],
  extras: { nfc: null, roster: null },
  photos: [{ media_id: 'pm_black', colour: 'black' }, { media_id: 'pm_white', colour: 'white' }, { media_id: 'pm_wood', colour: 'wood' }, { media_id: 'pm_large', value_id: 'ov_l' }],
  licence: 'remix',
  warranty_days: 365,
  prep_days_add: {},
  private: {},
};

/** The brief's rotating display: Motor (A / B), Magnet (10 / 15 / 20 mm) × 2, Lighting (none / white / RGB). */
export const ROTATING_DISPLAY: BlueprintSpec = {
  v: 1,
  family: 'decor',
  tags: [],
  sell: { cart: true, request: true },
  regions: [
    { id: 'body', role: 'body', parts: [0], tone: 'primary', paint: { allowed: 'stocked', default: 'black' }, optional: null, shown_by: null },
    { id: 'base', role: 'base', parts: [1], tone: 'secondary', paint: { allowed: 'stocked', default: 'white' }, optional: null, shown_by: null },
    { id: 'glow', role: 'accessory', parts: [2], tone: 'accent', paint: { allowed: ['clear'], default: 'clear' }, optional: null, shown_by: 'lighting' },
  ],
  areas: [],
  axes: {},
  colors: { included: 2, per_extra_iqd: 1000, max: 4 },
  themes: 'all',
  slots: [
    {
      id: 'motor', kind: 'motor', label: { ar: 'المحرّك', en: 'Motor', ckb: 'ماتۆڕ' }, qty: 1, required: true, choice: 'customer', pricing: 'add',
      options: [{ key: 'a', part: { p: 'cp_motor', v: 'pv_motor_a' } }, { key: 'b', part: { p: 'cp_motor', v: 'pv_motor_b' } }],
      default: 'a', show: { effect: 'badge', anchor: front(-50, 20, 20, 0) },
    },
    {
      id: 'magnet', kind: 'magnet', qty: 2, required: true, choice: 'customer', pricing: 'add',
      options: [{ key: 'm10', part: { p: 'cp_magnet', v: 'pv_magnet_10' } }, { key: 'm15', part: { p: 'cp_magnet', v: 'pv_magnet_15' } }, { key: 'm20', part: { p: 'cp_magnet', v: 'pv_magnet_20' } }],
      default: 'm10', show: { effect: 'ring', anchor: front(-60, 20, 20, 0) },
      accepts: { kind: 'magnet', shape: 'round', diameter_mm: { min: 10, max: 20 } },
    },
    {
      id: 'lighting', kind: 'led', qty: 1, required: false, choice: 'customer', pricing: 'add',
      options: [{ key: 'white', part: { p: 'cp_led', v: 'pv_led_white' } }, { key: 'rgb', part: { p: 'cp_led', v: 'pv_led_rgb' } }],
      show: { effect: 'visible', part: 2 },
    },
  ],
  fixed: [{ part: { p: 'cp_hidden_glue', v: null }, qty: 2, show: false }],
  rules: [{ id: 'big-magnet', if: { slot: 'magnet', is: 'm20' }, then: { requires: { slot: 'motor', is: 'b' } }, fix: 'suggest', say: 'addon_needs_addon' }],
  extras: { nfc: null, roster: null },
  photos: [],
  licence: 'remix',
  warranty_days: 180,
  prep_days_add: {},
  private: { notes: 'PRIVATE-NOTE-7f3a: test the motor before boxing' },
};

// ------------------------------------------------------------ the public side

const STOCKED = ['black', 'white', 'red', 'blue', 'gold', 'silver', 'navy', 'green'] as const;
const RGB: Record<string, [number, number, number]> = {
  black: [24, 24, 27], white: [240, 240, 236], red: [200, 40, 40], blue: [40, 90, 200], gold: [212, 175, 55], silver: [190, 190, 196], navy: [31, 45, 92], green: [40, 150, 80],
};

/** Every combination of the annotated groups, priced from `base` (+ `step` per value index past the first). */
function variantsOf(spec: BlueprintSpec, base: number, step: number, soldOut: string[] = []): PublicVariant[] {
  const axes = [spec.axes.size, spec.axes.look, spec.axes.tier].filter((a) => a !== undefined);
  let combos: Array<Record<string, string>> = [{}];
  for (const a of axes) combos = combos.flatMap((c) => Object.keys(a.values).map((v) => ({ ...c, [a.group]: v })));
  if (!axes.length) return [];
  return combos.map((values, i) => {
    const id = `pv_${Object.values(values).map((v) => v.replace(/^ov_/, '')).join('_')}`;
    const extra = axes.reduce((s, a) => s + Object.keys(a.values).indexOf(values[a.group]) * step, 0);
    return { id: i === 0 ? id : id, values, price_iqd: base + extra, in_stock: !soldOut.includes(id) };
  });
}

const option = (key: string, product_id: string, variant_id: string | null, name: string, unit_iqd: number, in_stock = true): PublicSlotOption => ({ key, product_id, variant_id, name, image: null, unit_iqd, in_stock });

function publicOf(
  spec: BlueprintSpec,
  product: PublicBlueprint['product'],
  extra: Partial<Omit<PublicBlueprint, keyof ReturnType<typeof publicSpecOf> | 'product'>> & { variants?: PublicVariant[] },
  photoUrls = false
): PublicBlueprint {
  const pub = publicSpecOf(spec);
  const variants = extra.variants ?? [];
  return {
    ...pub,
    product,
    variants,
    mesh: extra.mesh === undefined ? { url: `/files/merchants/u_fixture/public/bp/bp_${product.id}-r3-0123456789ab.lvm.gz`, hash: '0123456789ab', bytes: 99_000, triangles: 20_000, dims_mm: [150, 100, 120] } : extra.mesh,
    look: extra.look ?? null,
    photos: photoUrls ? spec.photos.map((p) => ({ ...p, url: `/files/merchants/u_fixture/public/products/${p.media_id}.webp` })) : [],
    stock: extra.stock === undefined ? { default: Object.fromEntries(STOCKED.map((k) => [k, 'in'])), silk: { black: 'in', gold: 'in', silver: 'in', blue: 'sub:navy' } } : extra.stock,
    stock_rgb: extra.stock_rgb ?? RGB,
    stock_names: extra.stock_names ?? { black: 'Black PLA', white: 'White PLA', navy: 'Navy PLA Silk' },
    slot_options: extra.slot_options ?? {},
    printer: extra.printer === undefined ? { max_mm: [256, 256, 256] } : extra.printer,
    from_iqd: extra.from_iqd ?? (variants.length ? Math.min(...variants.map((v) => v.price_iqd)) : product.price_iqd),
    rev: 3,
  };
}

const product = (id: string, name: string, price_iqd: number, prep_days = 2): PublicBlueprint['product'] => ({ id, slug: id.replace(/^cp_/, '').replace(/_/g, '-'), store_slug: 'levo-prints', name, price_iqd, prep_days });

export interface BlueprintFixture {
  name: string;
  spec: BlueprintSpec;
  /** normalizeBlueprint options that resolve every reference. */
  opts: { partCount: number; variantGroups: Record<string, string[]>; mediaIds: string[]; bboxMm?: [number, number, number] };
  pub: PublicBlueprint;
  /** The survey's compiled tiles for an archetype (§5.3), without the door; null = no archetype. */
  tiles: TileId[] | null;
}

const groupsOf = (spec: BlueprintSpec): Record<string, string[]> =>
  Object.fromEntries(Object.values(spec.axes).filter((a) => a !== undefined).map((a) => [a.group, Object.keys(a.values)]));

export const FIXTURES: Record<'nameStand' | 'qrMenuStand' | 'photoLamp' | 'nameKeychain' | 'groupParticipant' | 'photoOnlySign' | 'rotatingDisplay', BlueprintFixture> = {
  nameStand: {
    name: 'nameStand', spec: NAME_STAND, tiles: ['name', 'look', 'size', 'more'],
    opts: { partCount: 3, variantGroups: groupsOf(NAME_STAND), mediaIds: [], bboxMm: [150, 100, 120] },
    pub: publicOf(NAME_STAND, product('cp_name_stand', 'Controller stand', 20_000), {
      variants: variantsOf(NAME_STAND, 20_000, 3_000, ['pv_l_silk']),
      slot_options: { magnet: [option('m10', 'cp_magnet', 'pv_magnet_10', 'Round magnet 10 × 3 mm', 1_000), option('m15', 'cp_magnet', 'pv_magnet_15', 'Round magnet 15 × 3 mm', 1_500)] },
    }),
  },
  qrMenuStand: {
    name: 'qrMenuStand', spec: QR_MENU_STAND, tiles: ['logo', 'look', 'qr', 'more'],
    opts: { partCount: 2, variantGroups: groupsOf(QR_MENU_STAND), mediaIds: [] },
    pub: publicOf(QR_MENU_STAND, product('cp_qr_menu', 'QR menu stand', 18_000), { variants: variantsOf(QR_MENU_STAND, 18_000, 4_000) }),
  },
  photoLamp: {
    name: 'photoLamp', spec: PHOTO_LAMP, tiles: ['photo', 'size', 'text'],
    opts: { partCount: 2, variantGroups: groupsOf(PHOTO_LAMP), mediaIds: [] },
    pub: publicOf(PHOTO_LAMP, product('cp_photo_lamp', 'Memory lamp', 30_000, 4), { variants: variantsOf(PHOTO_LAMP, 30_000, 10_000), stock: null }),
  },
  nameKeychain: {
    name: 'nameKeychain', spec: NAME_KEYCHAIN, tiles: ['name', 'look', 'more'],
    opts: { partCount: 3, variantGroups: groupsOf(NAME_KEYCHAIN), mediaIds: [] },
    pub: publicOf(NAME_KEYCHAIN, product('cp_keychain', 'Name keychain', 5_000, 1), { variants: variantsOf(NAME_KEYCHAIN, 5_000, 1_500) }),
  },
  groupParticipant: {
    name: 'groupParticipant', spec: GROUP_PARTICIPANT, tiles: ['name', 'look'],
    opts: { partCount: 1, variantGroups: {}, mediaIds: [] },
    pub: publicOf(GROUP_PARTICIPANT, product('cp_group_tag', 'Team tag', 4_000, 3), {}),
  },
  photoOnlySign: {
    name: 'photoOnlySign', spec: PHOTO_ONLY_SIGN, tiles: null,
    opts: { partCount: 0, variantGroups: groupsOf(PHOTO_ONLY_SIGN), mediaIds: ['pm_black', 'pm_white', 'pm_wood', 'pm_large'] },
    pub: publicOf(PHOTO_ONLY_SIGN, product('cp_photo_sign', 'Shop sign', 35_000, 5), { variants: variantsOf(PHOTO_ONLY_SIGN, 35_000, 15_000), mesh: null, stock: null }, true),
  },
  rotatingDisplay: {
    name: 'rotatingDisplay', spec: ROTATING_DISPLAY, tiles: null,
    opts: { partCount: 3, variantGroups: {}, mediaIds: [] },
    pub: publicOf(ROTATING_DISPLAY, product('cp_rotating', 'Rotating display', 20_000), {
      slot_options: {
        motor: [option('a', 'cp_motor', 'pv_motor_a', 'Small motor A', 8_000), option('b', 'cp_motor', 'pv_motor_b', 'Motor B', 11_000)],
        magnet: [option('m10', 'cp_magnet', 'pv_magnet_10', 'Round magnet 10 mm', 1_000), option('m15', 'cp_magnet', 'pv_magnet_15', 'Round magnet 15 mm', 1_500), option('m20', 'cp_magnet', 'pv_magnet_20', 'Round magnet 20 mm', 2_500, false)],
        lighting: [option('white', 'cp_led', 'pv_led_white', 'White LED', 3_000), option('rgb', 'cp_led', 'pv_led_rgb', 'RGB LED', 5_000)],
      },
    }),
  },
};

/**
 * The brief's golden (Part 3): base 20,000 + 2 × magnets 1,000 + RGB LED 5,000
 * + motor 8,000 = 35,000 IQD — the rotating display's canonical configuration.
 */
export const GOLDEN_CONFIG: DesignConfig = {
  colors: { base: 'white', body: 'black', glow: 'clear' },
  icon: {},
  logo: {},
  nfc: null,
  notes: '',
  p: 'cp_rotating',
  parent: null,
  parts: {},
  photo: {},
  qr: {},
  rev: 3,
  roster: null,
  slots: { lighting: { option: 'rgb' }, magnet: { option: 'm10' }, motor: { option: 'a' } },
  texts: {},
  theme: null,
  v: 1,
  variant: null,
};
export const GOLDEN_UNIT_IQD = 35_000;

/** A filled name stand: ALI in gold on white, medium silk, 15 mm magnets. */
export const NAME_STAND_CONFIG: DesignConfig = {
  colors: { base: 'white', body: 'navy', name: 'gold', plate: 'white' },
  icon: {},
  logo: {},
  nfc: null,
  notes: 'please wrap it',
  p: 'cp_name_stand',
  parent: null,
  parts: {},
  photo: {},
  qr: {},
  rev: 3,
  roster: null,
  slots: { magnet: { option: 'm15' } },
  texts: { name: { style: 'gaming', value: ['ALI'] } },
  theme: null,
  v: 1,
  variant: 'pv_m_silk',
};
