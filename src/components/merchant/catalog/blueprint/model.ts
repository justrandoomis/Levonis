/**
 * THE BUILDER'S ARITHMETIC (Programme C, phase C1; docs/LEVO_PROJECT_PROGRAMME.md
 * §B.1 hop 1, §B.2 items 1–5, §B.3 rows «Slots» and «Compatibility», §0 row 39).
 *
 * Pure — no DOM, no fetch — so tests/blueprintBuilderUi.test.ts holds it:
 *
 *   parts → regions   one region per role (its id is the role), a part in at
 *                     most one; «مخفي» is a part in no region (the publish
 *                     strips it from the public mesh — spec.ts `hiddenParts`)
 *   a tap → a frame   point + the triangle's normal → o / n / u (u = «up»,
 *                     the width axis is u × n, as the studio's look card and
 *                     decals read it), w × h sized from the tapped part
 *   what a blueprint  the steps, the rule kinds and the marker effects this
 *   can use           blueprint can take — nothing is offered that the
 *                     engine would refuse (no size rule without a size axis,
 *                     no modelled marker on a photo-only product …)
 *   «أضف مقاسات»      Small / Medium ⭐ / Large as the product's OWN variant
 *                     group, sent through its own write gate (PATCH
 *                     variant_model) — prices ×0.8 / ×1 / ×1.35 rounded to
 *                     250, the new sizes at stock 0 (nothing is guessed)
 *   a refusal's path  the step that edits it
 *
 * Every figure a customer pays is the server's; this file only shapes what
 * the merchant declares.
 */
import type {
  Area, AreaRole, BlueprintSpec, ContentKind, Frame, PaletteKey, PhotoFrame, Quad, Region, RegionRole, RuleIf, RuleThen, SayCode, SlotEffect, Text3, Tone, Vec3,
} from '../../../../../packages/catalog/src/personalize/types';
import { PALETTE_RGB } from '../../../../../packages/catalog/src/personalize/color';
import type { CatalogProductDetail, ProductBody } from '../catalogApi';

/** A sentence's `{holes}` filled; an unfilled hole stays visible rather than vanishing. */
export const fill = (text: string, values: Record<string, string | number>): string =>
  text.replace(/\{(\w+)\}/g, (hole, k: string) => (values[k] === undefined ? hole : String(values[k])));

/** The product's own option names «أضف مقاسات» writes (a product's names are Arabic and English). */
export const SIZE_WORDS = {
  group: { name: 'Size', name_ar: 'المقاس' },
  values: [
    { name: 'Small', name_ar: 'صغير' },
    { name: 'Medium', name_ar: 'وسط' },
    { name: 'Large', name_ar: 'كبير' },
  ],
} as const;

export type StepId = 'source' | 'parts' | 'areas' | 'sizes' | 'addons' | 'rules' | 'publish';
export const STEP_IDS: readonly StepId[] = ['source', 'parts', 'areas', 'sizes', 'addons', 'rules', 'publish'];

/** A compiled part as the builder's state carries it (worker/lib/personalize/compile.ts `CompiledPart`). Names are the merchant's own. */
export interface CompiledPart {
  n: number;
  name: string;
  triangles: number;
  /** [minX, minY, minZ, maxX, maxY, maxZ], mm, the centred frame. */
  bbox_mm: number[];
  share: number;
  colour?: string;
}

/** The roles the builder offers for a part, in the list's order (the engine's vocabulary). */
export const PART_ROLES: readonly RegionRole[] = ['body', 'base', 'name', 'text', 'border', 'accent', 'logo', 'icon', 'insert', 'accessory', 'fixed'];

export function blankSpec(): BlueprintSpec {
  return {
    v: 1, family: 'other', tags: [], sell: { cart: true, request: false }, regions: [], areas: [], axes: {}, colors: { included: 3, per_extra_iqd: 0, max: 4 },
    themes: 'all', slots: [], fixed: [], rules: [], extras: { nfc: null, roster: null }, photos: [], licence: 'remix', warranty_days: 0, prep_days_add: {}, private: {},
  };
}

/** The tone the themes paint a role with. */
export function toneOf(role: RegionRole): Tone {
  if (role === 'body') return 'primary';
  if (role === 'base') return 'secondary';
  if (role === 'name' || role === 'text') return 'text';
  return role === 'insert' || role === 'accessory' || role === 'fixed' ? 'neutral' : 'accent';
}

const START: Record<RegionRole, PaletteKey> = {
  body: 'black', base: 'white', name: 'white', text: 'white', border: 'gold', accent: 'red', logo: 'white', icon: 'red', insert: 'black', accessory: 'silver', fixed: 'gray',
};

/** A new region's colours: the shelf, starting on the role's usual colour; a fixed part keeps one colour. */
export const paintFor = (role: RegionRole): Region['paint'] => (role === 'fixed' ? { allowed: [START.fixed], default: START.fixed } : { allowed: 'stocked', default: START[role] });

/** Every id a spec already uses (regions, areas, slots and rules share one namespace). */
export function takenIds(spec: BlueprintSpec): Set<string> {
  return new Set([...spec.regions, ...spec.areas, ...spec.slots, ...spec.rules].map((x) => x.id));
}

/** `base`, else `base2`, `base3` … — whichever is free. */
export function freeId(base: string, taken: Set<string>): string {
  let id = base;
  for (let k = 2; taken.has(id); k++) id = `${base}${k}`;
  return id;
}

export const regionOfPart = (spec: Pick<BlueprintSpec, 'regions'>, n: number): Region | undefined => spec.regions.find((r) => r.parts.includes(n));

/**
 * Part `n` becomes `role` (null = hidden: in no region). A region left with no
 * part goes; an area, rule or roster field that named it follows the part.
 */
export function setPartRole(spec: BlueprintSpec, n: number, role: RegionRole | null): BlueprintSpec {
  const was = regionOfPart(spec, n);
  let regions = spec.regions.map((r) => (r === was ? { ...r, parts: r.parts.filter((x) => x !== n) } : r));
  const gone = was && !regions.find((r) => r.id === was.id)?.parts.length ? was.id : null;
  regions = regions.filter((r) => r.parts.length || r.id !== gone);
  if (role) {
    const i = regions.findIndex((r) => r.role === role);
    if (i >= 0) regions[i] = { ...regions[i], parts: [...regions[i].parts, n].sort((a, b) => a - b) };
    else {
      const taken = takenIds({ ...spec, regions });
      regions.push({ id: freeId(role, taken), role, parts: [n], tone: toneOf(role), paint: paintFor(role), optional: null, shown_by: null });
    }
    regions.sort((a, b) => PART_ROLES.indexOf(a.role) - PART_ROLES.indexOf(b.role));
  }
  const to = gone ? (regionOfPart({ regions }, n) ?? regions[0])?.id : undefined;
  if (!gone || !to) return { ...spec, regions };
  const follow = (id: string) => (id === gone ? to : id);
  return {
    ...spec,
    regions,
    areas: spec.areas.map((a) => (a.region === gone ? { ...a, region: to } : a)),
    rules: spec.rules.map((r) => ('only_colors' in r.then ? { ...r, then: { only_colors: { ...r.then.only_colors, target: follow(r.then.only_colors.target) } } } : r)),
    extras: spec.extras.roster ? { ...spec.extras, roster: { ...spec.extras.roster, vary: [...new Set(spec.extras.roster.vary.map(follow))] } } : spec.extras,
  };
}

const ROLE_SET = new Set<string>(PART_ROLES);

/** Regions from the server's suggestions (a role per part, from the file's own names). */
export function regionsFrom(parts: readonly CompiledPart[], roles: ReadonlyArray<{ n: number; role: string }>): Region[] {
  let spec = blankSpec();
  for (const p of parts) {
    const r = roles.find((x) => x.n === p.n)?.role;
    spec = setPartRole(spec, p.n, ROLE_SET.has(r ?? '') ? (r as RegionRole) : 'accent');
  }
  return spec.regions;
}

/**
 * A new model replaced the old one: the regions come from the new file's
 * parts; areas keep their frames on a region that still exists (else the
 * first); a marker part the new file does not have is dropped.
 */
export function afterNewModel(spec: BlueprintSpec, parts: readonly CompiledPart[], roles: ReadonlyArray<{ n: number; role: string }>): BlueprintSpec {
  const regions = regionsFrom(parts, roles);
  const ids = new Set(regions.map((r) => r.id));
  const first = regions[0]?.id ?? '';
  return {
    ...spec,
    regions,
    areas: spec.areas.filter((a) => a.frame).map((a) => (ids.has(a.region) ? a : { ...a, region: first })),
    slots: spec.slots.map((s) => (s.show?.part !== undefined && s.show.part >= parts.length ? { ...s, show: undefined } : s)),
    rules: spec.rules.filter((r) => !('only_colors' in r.then) || ids.has(r.then.only_colors.target)),
    extras: { ...spec.extras, roster: null },
  };
}

/**
 * «بالصور فقط» (§0 row 39): one region with no mesh part, its colours the
 * photos' colours; every area moves onto the first photo; markers go (a
 * photo has no model to draw them on).
 */
export function toPhotoOnly(spec: BlueprintSpec, photos: BlueprintSpec['photos']): BlueprintSpec {
  const keys = [...new Set(photos.flatMap((p) => (p.colour ? [p.colour] : [])))];
  const first = photos[0]?.media_id ?? '';
  const region: Region = {
    id: 'body', role: 'body', parts: [], tone: 'primary', paint: keys.length ? { allowed: keys, default: keys[0] } : { allowed: ['white'], default: 'white' }, optional: null, shown_by: null,
  };
  return {
    ...spec,
    regions: [region],
    photos,
    areas: spec.areas.map((a) => {
      const { frame: _f, ...rest } = a;
      return { ...rest, region: 'body', photo_frame: a.photo_frame && photos.some((p) => p.media_id === a.photo_frame!.media_id) ? a.photo_frame : { media_id: first, quad: photoQuad(a.kind) } };
    }),
    slots: spec.slots.map(({ show: _s, ...rest }) => rest),
    rules: spec.rules.filter((r) => !('only_colors' in r.then)),
    extras: { ...spec.extras, roster: null },
  };
}

// ------------------------------------------------------------------- frames

type V = readonly number[];
const dot = (a: V, b: V) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a: V, b: V): Vec3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
export const unit = (a: V): Vec3 => {
  const l = Math.hypot(a[0], a[1], a[2]) || 1;
  return [a[0] / l, a[1] / l, a[2] / l];
};
const r4 = (x: number) => Math.round(x * 1e4) / 1e4 || 0;
const half = (x: number) => Math.max(2, Math.round(x * 2) / 2);

/** A frame's width axis: up × n — the look card (lookcard.ts `frameWidthAxis`) and the decals read it so. */
export const widthAxis = (f: Pick<Frame, 'n' | 'u'>): Vec3 => unit(cross(f.u, f.n));

/** How far a box reaches along a direction, mm. */
function span(box: V | undefined, axis: V): number {
  if (!box || box.length < 6) return 60;
  let lo = Infinity;
  let hi = -Infinity;
  for (let k = 0; k < 8; k++) {
    const p = [box[k & 1 ? 3 : 0], box[k & 2 ? 4 : 1], box[k & 4 ? 5 : 2]];
    const d = dot(p, axis);
    lo = Math.min(lo, d);
    hi = Math.max(hi, d);
  }
  return Math.max(4, hi - lo);
}

/**
 * The frame an area gets where the merchant tapped: its origin on the
 * surface, facing out along the triangle's normal, «up» the model's up
 * (its Z) laid onto the face — or, on a face that looks up or down, its
 * depth (Y). Sized from the tapped part: a name about 70 % of its width.
 */
export function frameAt(point: V, normal: V, kind: ContentKind, role: AreaRole, box?: V): Frame {
  const n = unit(normal);
  const ref = Math.abs(n[2]) > 0.9 ? [0, 1, 0] : [0, 0, 1];
  const d = dot(ref, n);
  const u = unit([ref[0] - d * n[0], ref[1] - d * n[1], ref[2] - d * n[2]]);
  const W = span(box, cross(u, n));
  const H = span(box, u);
  let w = W * 0.7;
  let h = Math.min(H * 0.6, w / (role === 'name' ? 3.5 : 4));
  if (kind === 'qr' || kind === 'logo') w = h = Math.min(W, H) * 0.6;
  else if (kind === 'icon') w = h = Math.min(W, H) * 0.3;
  else if (kind === 'photo') [w, h] = [W * 0.8, H * 0.8];
  return { o: [point[0], point[1], point[2]].map((x) => Math.round(x * 10) / 10 || 0) as Vec3, n: n.map(r4) as Vec3, u: u.map(r4) as Vec3, w: half(w), h: half(h) };
}

/** Where an area starts on a photo (0..1, top-left → clockwise). */
export function photoQuad(kind: ContentKind): Quad {
  const [x0, y0, x1, y1] = kind === 'text' ? [0.2, 0.42, 0.8, 0.58] : kind === 'photo' ? [0.2, 0.2, 0.8, 0.8] : [0.38, 0.38, 0.62, 0.62];
  return [[x0, y0], [x1, y0], [x1, y1], [x0, y1]];
}

/** The most letters a line of `w` mm holds at the smallest letter height — a suggestion the merchant may change. */
export const suggestMax = (w: number, minCap: number): number => Math.max(1, Math.min(40, Math.floor(w / (0.8 * Math.max(0.5, minCap)))));

/** A dark colour takes white letters, a light one black. */
export function inkOn(key: PaletteKey): PaletteKey {
  const [r, g, b] = PALETTE_RGB[key] ?? [128, 128, 128];
  return 0.2126 * r + 0.7152 * g + 0.0722 * b < 140 ? 'white' : 'black';
}

/** The placeholder a customer sees before typing — never copied into a design. */
const SAMPLES: Record<'name' | 'text', Text3> = {
  name: { ar: 'علي', en: 'ALI', ckb: 'عەلی' },
  text: { ar: 'مرحبا', en: 'Hello', ckb: 'سڵاو' },
};

/** A new area of `kind` on `region`, placed by a frame (model) or on a photo (photo-only). A name is required; anything else optional. */
export function newArea(spec: BlueprintSpec, kind: ContentKind, textRole: 'name' | 'text', region: string, place: { frame: Frame } | { photo_frame: PhotoFrame }): Area {
  const id = freeId(`a${spec.areas.length + 1}`, takenIds(spec));
  const role: AreaRole = kind === 'text' ? textRole : kind;
  const base = { id, kind, role, region, required: role === 'name', fee_iqd: 0, ...place };
  const colour = spec.regions.find((r) => r.id === region)?.paint.default ?? 'black';
  if (kind === 'text') {
    const w = 'frame' in place ? place.frame.w : 60;
    const t = role === 'name' ? SAMPLES.name : SAMPLES.text;
    // A suggested maximum shorter than the sample would refuse the sample itself.
    return { ...base, text: { lines: 1, max: Math.max(5, suggestMax(w, 4)), count: 1, styles: 'all', default_style: 'bold', min_cap_mm: 4, paint: { allowed: 'stocked', default: inkOn(colour) }, sample: t } };
  }
  if (kind === 'logo') return { ...base, logo: { max_colors: 2, modes: ['flat'] } };
  if (kind === 'photo') return { ...base, photo: { modes: ['print'], min_px_per_mm: 5 } };
  if (kind === 'qr') return { ...base, qr: { kinds: ['instagram', 'whatsapp', 'website'], min_module_mm: 1 } };
  return { ...base, icon: { keys: 'all' } };
}

// ------------------------------------------------------------ what it can use

/** The steps a blueprint has: a photo-only product has no parts to assign. */
export const stepsFor = (photoOnly: boolean): StepId[] => STEP_IDS.filter((s) => !(photoOnly && s === 'parts'));

/** The step that edits a refusal's path (`BLUEPRINT_INVALID` errors, `BLUEPRINT_NOT_READY` missing). */
export function stepOf(path: string, photoOnly: boolean): StepId {
  const head = path.split('.')[0];
  if (head === 'regions') return photoOnly ? 'source' : 'parts';
  if (head === 'photos' || head === 'mesh' || head === 'keys') return 'source';
  if (head === 'areas' || head === 'quads') return 'areas';
  if (head === 'axes' || head === 'prep_days_add') return 'sizes';
  if (head === 'slots' || head === 'fixed') return 'addons';
  if (head === 'rules') return 'rules';
  return 'publish';
}

export type IfKind = 'text' | 'slot' | 'qr' | 'value';
export type ThenKind = 'size_at_least' | 'requires' | 'excludes' | 'only_colors' | 'max_colors';

/** The «when» a rule may start from on this blueprint: a text rule needs a text area, and so on. */
export function ifKinds(spec: BlueprintSpec): IfKind[] {
  const out: IfKind[] = [];
  if (spec.areas.some((a) => a.kind === 'text')) out.push('text');
  if (spec.slots.length) out.push('slot');
  if (spec.areas.some((a) => a.kind === 'qr')) out.push('qr');
  if (spec.axes.size || spec.axes.look || spec.axes.tier) out.push('value');
  return out;
}

/** The «then» it may end in: a size only with a size axis, another add-on only with add-ons. */
export function thenKinds(spec: BlueprintSpec): ThenKind[] {
  const out: ThenKind[] = [];
  if (spec.axes.size) out.push('size_at_least');
  if (spec.slots.length) out.push('requires', 'excludes');
  out.push('only_colors', 'max_colors');
  return out;
}

/** The explanation a rule gives the customer (its `say`), from what it joins. */
export function sayFor(when: RuleIf, then: RuleThen): SayCode {
  if ('size_at_least' in then) return 'text' in when ? 'text_needs_size' : 'qr' in when ? 'qr_needs_size' : 'addon_needs_size';
  if ('requires' in then) return 'addon_needs_addon';
  if ('excludes' in then) return 'addons_conflict';
  return 'only_colors' in then ? 'look_limits_colors' : 'fewer_colors';
}

/** How a slot's part shows on the product: a modelled part, or a simplified marker — none on a photo. */
export const markerEffects = (photoOnly: boolean): Array<SlotEffect | ''> => (photoOnly ? [''] : ['', 'glow', 'ring', 'badge', 'visible']);

/** The size rows to annotate, or null when no option group is the size axis. */
export function sizeRows(spec: BlueprintSpec, detail: Pick<CatalogProductDetail, 'option_groups'>): Array<{ id: string; name: string; name_ar: string }> | null {
  const g = spec.axes.size && detail.option_groups.find((x) => x.id === spec.axes.size!.group);
  return g ? g.values.map((v) => ({ id: v.id, name: v.name, name_ar: v.name_ar })) : null;
}

/** After an axis changed: whatever named a value no axis annotates any more lets go of it (a photo keeps its picture). */
export function pruneValues(spec: BlueprintSpec): BlueprintSpec {
  const ids = new Set([spec.axes.size, spec.axes.look, spec.axes.tier].flatMap((a) => (a ? Object.keys(a.values) : [])));
  const sizes = new Set(Object.keys(spec.axes.size?.values ?? {}));
  const days = spec.prep_days_add.size;
  return {
    ...spec,
    photos: spec.photos.map(({ value_id, ...p }) => (value_id && ids.has(value_id) ? { ...p, value_id } : p)),
    rules: spec.rules.filter((r) => !('value' in r.if && !ids.has(r.if.value)) && !('size_at_least' in r.then && !sizes.has(r.then.size_at_least))),
    prep_days_add: days ? { ...spec.prep_days_add, size: Object.fromEntries(Object.entries(days).filter(([id]) => sizes.has(id))) } : spec.prep_days_add,
  };
}

/** Fits a bed of `max` mm in any of the six axis-aligned orientations (worker/lib/eligibility.ts `fitsInBuild`). */
export function fitsBed(dims: V, max: V | null | undefined): boolean {
  if (!max) return true;
  const a = [...dims].sort((x, y) => x - y);
  const b = [...max].sort((x, y) => x - y);
  return a.every((x, i) => x <= b[i]);
}

// ------------------------------------------------------------- «أضف مقاسات»

export const SIZE_FACTORS = [0.8, 1, 1.35] as const;
const round250 = (x: number) => Math.max(0, Math.round(x / 250) * 250);

/**
 * The product's variant model with a Size group added (Small / Medium /
 * Large): every existing variant becomes three, Medium keeps its price,
 * stock and SKU, Small and Large start at stock 0 with ×0.8 / ×1.35 of the
 * price rounded to 250. null when the product cannot take another group.
 */
export function withSizeGroup(
  p: Pick<CatalogProductDetail, 'option_groups' | 'variants' | 'variant_mode' | 'price_iqd' | 'stock' | 'sku'>,
  words: { group: { name: string; name_ar: string }; values: ReadonlyArray<{ name: string; name_ar: string }> }
): NonNullable<ProductBody['variant_model']> | null {
  if (p.option_groups.length >= 3) return null;
  const groups = p.option_groups.map((g) => ({ ref: g.id, name: g.name, name_ar: g.name_ar, kind: g.kind, values: g.values.map((v) => ({ ref: v.id, name: v.name, name_ar: v.name_ar, swatch: v.swatch })) }));
  const refs = words.values.map((_, i) => `size_new_${i}`);
  const base = p.variant_mode === 'variants' && p.variants.length
    ? p.variants
    : [{ value_ids: [] as string[], price_iqd: null, compare_at_iqd: null, stock: p.stock, sku: p.sku, active: true, image_key: null, low_stock_threshold: null }];
  if (base.length * refs.length > 100) return null;
  const variants = base.flatMap((v) =>
    refs.map((ref, i) => ({
      values: [...v.value_ids, ref],
      price_iqd: SIZE_FACTORS[i] === 1 ? v.price_iqd : round250((v.price_iqd ?? p.price_iqd) * SIZE_FACTORS[i]),
      compare_at_iqd: SIZE_FACTORS[i] === 1 ? v.compare_at_iqd : null,
      stock: SIZE_FACTORS[i] === 1 ? v.stock : 0,
      sku: SIZE_FACTORS[i] === 1 ? v.sku : '',
      active: v.active,
      image_key: v.image_key,
      low_stock_threshold: v.low_stock_threshold,
    }))
  );
  return {
    groups: [...groups, { ref: 'size_new', name: words.group.name, name_ar: words.group.name_ar, kind: 'choice', values: words.values.map((w, i) => ({ ref: refs[i], name: w.name, name_ar: w.name_ar, swatch: '' })) }],
    variants,
  };
}

/** A size axis over a group: each value's scale by its place (0.8 / 1 / 1.35, then +0.35), dims from the model's. */
export function sizeAxis(group: { id: string; values: ReadonlyArray<{ id: string }> }, dims: V | null): NonNullable<BlueprintSpec['axes']['size']> {
  const n = group.values.length;
  const mid = Math.floor((n - 1) / 2);
  const values: NonNullable<BlueprintSpec['axes']['size']>['values'] = {};
  group.values.forEach((v, i) => {
    const scale = Math.round((i === mid ? 1 : i < mid ? Math.max(0.1, 1 - 0.2 * (mid - i)) : 1 + 0.35 * (i - mid)) * 100) / 100;
    const d = (dims && dims.length === 3 ? dims : [100, 100, 100]).map((x) => Math.max(1, Math.round(x * scale))) as Vec3;
    values[v.id] = i === mid ? { dims_mm: d, scale, recommended: true } : { dims_mm: d, scale };
  });
  return { group: group.id, values };
}
