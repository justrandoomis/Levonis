/**
 * THE MERCHANT'S BLUEPRINT, NORMALISED (docs/LEVO_PROJECT_PROGRAMME.md §B.1
 * hop 1 and «Shapes», §0 rows 5–7 and 39).
 *
 * `normalizeBlueprint` is the gate every blueprint write passes, in the
 * builder before a request and in the Worker before a row is written. Strict
 * types; NOTHING is clamped: an out-of-range value is an error with its JSON
 * path, and every error is collected (`errors`). An absent optional field
 * takes its documented default, so the output is fully explicit:
 *
 *   areas [] · axes {} · themes 'all' · slots [] · fixed [] · rules [] ·
 *   extras {nfc: null, roster: null} · photos [] · licence 'remix' ·
 *   warranty_days 0 · prep_days_add {} · family 'other' · tags [] ·
 *   private {} · region optional/shown_by null · area required false,
 *   fee_iqd 0 · text lines 1, count 1, styles 'all', default_style bold (or
 *   the first listed), min_cap_mm 4 · logo {max_colors 2, modes [flat]} ·
 *   photo min_px_per_mm 5 · qr min_module_mm 1 · icon keys 'all' · slot qty 1,
 *   required false, choice customer, pricing add · rule fix suggest ·
 *   fixed qty 1, show false (a hidden production material).
 *
 * `v`, `regions`, `colors` and `sell` have no default. With `strict: false`
 * an unknown key is ignored instead of refused (a stored revision read by an
 * older engine); every other rule still holds. The references the spec can
 * resolve are resolved here; what needs the database is the Worker's, fed in
 * through the options (the mesh's part count, the product's option groups
 * and media, the mesh's bounding box).
 */
import type { Area, AreaRole, Axes, BlueprintSpec, EngineIssue, EngineResult, Extras, FixedPart, Frame, IconKey, LogoSpec, Paint, PaletteKey, PartAccepts, PartRef, PhotoFrame, PublicSpec, Quad, Region, Rule, RuleIf, RuleThen, Slot, SlotShow, SpecPhoto, Text3, TextSpec, Vec3 } from './types';
import type { PartRange } from './parts';
import { CONTENT_KINDS, FAMILIES, ICON_KEYS, LICENCES, LOGO_MODES, LOOKS, NFC_KINDS, PAINT_KEYS, PHOTO_MODES, QR_KINDS, REGION_ROLES, SAY_CODES, SLOT_EFFECTS, STYLES, THEMES, TIERS, TONES, isTag } from './vocab';
import { PART_KINDS, PART_SHAPES } from './parts';
import { canonicalJson, cleanLine, utf8Bytes } from './canonical';
import { designTextOk, graphemeCount, isExtId, isPriceLikeKey, plainTextOk } from './config';

export const BLUEPRINT_LIMITS = {
  bytes: 65536, regions: 16, areas: 4, parts: 64, slots: 8, options: 12, fixed: 8, rules: 24, label: 60, photos: 12, tags: 12,
  fee: 50_000_000, qty: 20, warranty: 3650, prepDays: 30, roster: 100, lines: 4, graphemes: 40, names: 4, logoColors: 4, colors: 16,
  axisValues: 30, vary: 8, notes: 500, qualityNote: 120, mm: 5000,
} as const;

/** Per-error codes (the builder words them); the result's code is BLUEPRINT_INVALID, or BLUEPRINT_PRICE_INVALID when every error is a fee. */
export type SpecErrorCode = 'REQUIRED' | 'TYPE' | 'RANGE' | 'TOO_MANY' | 'TOO_LONG' | 'TOO_LARGE' | 'UNKNOWN_KEY' | 'UNKNOWN_REF' | 'DUPLICATE' | 'INVALID' | 'NOT_ALLOWED' | 'PRICE';

export interface NormalizeBlueprintOptions {
  /** Default true: an unknown key is an error. */
  strict?: boolean;
  /** Parts in the compiled mesh (LVR1 ranges, hidden ones included): every index must be < it. */
  partCount?: number;
  /** The product's option groups → their value ids: every axis must name one, and annotate all of its values. */
  variantGroups?: Record<string, readonly string[]>;
  /** The product's own media ids (`photos`, `photo_frame`). */
  mediaIds?: readonly string[];
  /** The mesh's bounding box: a frame's origin inside it × 1.05, its size within its diagonal × 1.05. */
  bboxMm?: Vec3;
}

type Obj = Record<string, unknown>;
const SID = /^[a-z][a-z0-9_-]{0,31}$/;
const MATERIAL = /^[a-z0-9][a-z0-9-]{0,39}$/;
const TOP = ['v', 'family', 'tags', 'sell', 'regions', 'areas', 'axes', 'colors', 'themes', 'slots', 'fixed', 'rules', 'extras', 'photos', 'licence', 'warranty_days', 'prep_days_add', 'private'];
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);
const miss = (v: unknown) => (v === undefined ? 'REQUIRED' : 'TYPE');

export function normalizeBlueprint(raw: unknown, opts: NormalizeBlueprintOptions = {}): EngineResult<BlueprintSpec> {
  const L = BLUEPRINT_LIMITS;
  const strict = opts.strict !== false;
  const maxPart = (opts.partCount ?? L.parts) - 1;
  const errs: EngineIssue[] = [];
  const e = (path: string, code: SpecErrorCode): void => void errs.push({ path, code });
  const fail = (): EngineResult<BlueprintSpec> => ({ ok: false, code: errs.every((x) => x.code === 'PRICE') ? 'BLUEPRINT_PRICE_INVALID' : 'BLUEPRINT_INVALID', path: errs[0].path, errors: errs });
  let size = 0;
  try {
    size = JSON.stringify(raw)?.length ?? 0;
  } catch {
    e('', 'TYPE');
    return fail();
  }
  if (!isObj(raw)) e('', 'TYPE');
  else if (size > 4 * L.bytes) e('', 'TOO_LARGE');
  if (errs.length) return fail();

  // ------------------------------------------------------------ readers
  const obj = (v: unknown, path: string, keys: readonly string[], dflt?: Obj): Obj | undefined => {
    if (v === undefined && dflt) return dflt;
    if (!isObj(v)) return void e(path, miss(v));
    if (strict) for (const k of Object.keys(v)) if (!keys.includes(k)) e(`${path}.${k.slice(0, 64)}`, 'UNKNOWN_KEY');
    return v;
  };
  const arr = (v: unknown, path: string, max: number, optional = true): unknown[] => {
    if (v === undefined && optional) return [];
    if (!Array.isArray(v)) return e(path, miss(v)), [];
    if (v.length > max) e(path, 'TOO_MANY');
    return v.slice(0, max);
  };
  const int = (v: unknown, path: string, min: number, max: number, dflt?: number): number => {
    if (v === undefined && dflt !== undefined) return dflt;
    if (typeof v !== 'number' || !Number.isSafeInteger(v)) return e(path, miss(v)), min;
    if (v < min || v > max) e(path, 'RANGE');
    return v;
  };
  const num = (v: unknown, path: string, min: number, max: number, dflt?: number): number => {
    if (v === undefined && dflt !== undefined) return dflt;
    if (typeof v !== 'number' || !Number.isFinite(v)) return e(path, miss(v)), min;
    if (v < min || v > max) e(path, 'RANGE');
    return v;
  };
  const fee = (v: unknown, path: string): number => {
    if (v === undefined) return 0;
    if (typeof v === 'number' && Number.isSafeInteger(v) && v >= 0 && v <= L.fee) return v;
    return e(path, 'PRICE'), 0;
  };
  const bool = (v: unknown, path: string, dflt: boolean): boolean => {
    if (v === undefined) return dflt;
    if (typeof v !== 'boolean') return e(path, 'TYPE'), dflt;
    return v;
  };
  const one = <T extends string>(v: unknown, path: string, list: readonly T[], dflt?: T): T => {
    if (v === undefined && dflt !== undefined) return dflt;
    if (!list.includes(v as T)) e(path, v === undefined ? 'REQUIRED' : 'INVALID');
    return v as T;
  };
  const many = <T extends string>(v: unknown, path: string, list: readonly T[], allowEmpty = false): T[] => {
    const a = arr(v, path, list.length, false) as T[];
    if (Array.isArray(v) && !v.length && !allowEmpty) e(path, 'REQUIRED');
    a.forEach((x, i) => (!list.includes(x) ? e(`${path}.${i}`, 'INVALID') : a.indexOf(x) < i && e(`${path}.${i}`, 'DUPLICATE')));
    return a;
  };
  const ids = new Set<string>();
  /** A spec id: slug-like, not a price word, unique across regions, areas, slots and rules (`shared`). */
  const sid = (v: unknown, path: string, shared = true): string => {
    if (typeof v !== 'string' || !SID.test(v) || isPriceLikeKey(v) || v === 'constructor' || v === 'prototype') e(path, v === undefined ? 'REQUIRED' : 'INVALID');
    if (typeof v !== 'string') return '';
    if (shared && ids.has(v)) e(path, 'DUPLICATE');
    if (shared) ids.add(v);
    return v;
  };
  const xid = (v: unknown, path: string): string => {
    if (!isExtId(v)) e(path, v === undefined ? 'REQUIRED' : 'INVALID');
    return typeof v === 'string' ? v : '';
  };
  const vec = (v: unknown, path: string, min = -L.mm): Vec3 => {
    if (!Array.isArray(v) || v.length !== 3 || !v.every((x) => typeof x === 'number' && Number.isFinite(x))) return e(path, miss(v)), [0, 0, 0];
    if (v.some((x: number) => x < min || x > L.mm)) e(path, 'RANGE');
    return [v[0], v[1], v[2]];
  };
  const frame = (v: unknown, path: string): Frame | undefined => {
    const f = obj(v, path, ['o', 'n', 'u', 'w', 'h']);
    if (!f) return undefined;
    const out: Frame = { o: vec(f.o, `${path}.o`), n: vec(f.n, `${path}.n`), u: vec(f.u, `${path}.u`), w: num(f.w, `${path}.w`, 0.1, L.mm), h: num(f.h, `${path}.h`, 0.1, L.mm) };
    const ln = Math.hypot(...out.n);
    const lu = Math.hypot(...out.u);
    if (ln < 1e-6 || lu < 1e-6 || Math.abs(out.n[0] * out.u[0] + out.n[1] * out.u[1] + out.n[2] * out.u[2]) > 0.01 * ln * lu) e(path, 'INVALID');
    const b = opts.bboxMm;
    if (b && out.o.some((x, i) => Math.abs(x) > (b[i] / 2) * 1.05 + 0.01)) e(`${path}.o`, 'RANGE');
    if (b && Math.max(out.w, out.h) > Math.hypot(...b) * 1.05) e(path, 'RANGE');
    return out;
  };
  /** Words a person reads (labels, notes): NFC, spaces tidied, ≤ max characters, no controls or bidi marks. */
  const plain = (v: unknown, path: string, max: number, multiline = false): string => {
    if (typeof v !== 'string') return e(path, miss(v)), '';
    const s = multiline ? v.normalize('NFC').replace(/^[ \n]+|[ \n]+$/g, '') : cleanLine(v);
    if (!s) e(path, 'REQUIRED');
    else if ([...s].length > max) e(path, 'TOO_LONG');
    else if (!plainTextOk(s, multiline)) e(path, 'INVALID');
    return s;
  };
  const text3 = (v: unknown, path: string, read: (s: unknown, p: string) => string): Text3 => {
    const t = obj(v, path, ['ar', 'en', 'ckb']);
    return t ? { ar: read(t.ar, `${path}.ar`), en: read(t.en, `${path}.en`), ckb: read(t.ckb, `${path}.ckb`) } : { ar: '', en: '', ckb: '' };
  };
  const paint = (v: unknown, path: string): Paint => {
    const p = obj(v, path, ['allowed', 'default', 'premium']);
    if (!p) return { allowed: 'all', default: 'black' };
    const allowed = p.allowed === 'stocked' || p.allowed === 'all' ? p.allowed : many(p.allowed, `${path}.allowed`, PAINT_KEYS);
    const list: readonly string[] = Array.isArray(allowed) ? allowed : PAINT_KEYS;
    const out: Paint = { allowed, default: p.default as PaletteKey };
    if (!(PAINT_KEYS as readonly unknown[]).includes(p.default)) e(`${path}.default`, p.default === undefined ? 'REQUIRED' : 'INVALID');
    else if (!list.includes(out.default)) e(`${path}.default`, 'NOT_ALLOWED');
    if (p.premium !== undefined) {
      if (!isObj(p.premium)) e(`${path}.premium`, 'TYPE');
      else {
        const prem: Partial<Record<PaletteKey, number>> = {};
        for (const [k, x] of Object.entries(p.premium)) {
          if (list.includes(k)) prem[k as PaletteKey] = fee(x, `${path}.premium.${k}`);
          else e(`${path}.premium.${k.slice(0, 64)}`, 'NOT_ALLOWED');
        }
        out.premium = prem;
      }
    }
    return out;
  };
  const partRef = (v: unknown, path: string): PartRef => {
    const r = obj(v, path, ['p', 'v', 'src']);
    if (!r) return { p: '', v: null };
    const out: PartRef = { p: xid(r.p, `${path}.p`), v: r.v == null ? null : xid(r.v, `${path}.v`) };
    if (r.src !== undefined) {
      if (r.src === 'levonis') out.src = 'levonis';
      else e(`${path}.src`, 'INVALID');
    }
    return out;
  };
  const range = (v: unknown, path: string, cap: number): PartRange => {
    if (typeof v === 'number') return num(v, path, 1e-3, cap);
    const r = obj(v, path, ['min', 'max']);
    const out: { min?: number; max?: number } = {};
    if (!r) return out;
    if (r.min !== undefined) out.min = num(r.min, `${path}.min`, 0, cap);
    if (r.max !== undefined) out.max = num(r.max, `${path}.max`, 0, cap);
    if (out.min === undefined && out.max === undefined) e(path, 'REQUIRED');
    else if (out.min !== undefined && out.max !== undefined && out.min > out.max) e(path, 'RANGE');
    return out;
  };
  const oneOrMany = <T extends string>(v: unknown, path: string, list: readonly T[]): T | T[] => (Array.isArray(v) ? many(v, path, list) : one(v, path, list));

  const src = raw as Obj;
  if (strict) for (const k of Object.keys(src)) if (!TOP.includes(k)) e(k.slice(0, 64), 'UNKNOWN_KEY');
  if (src.v !== 1) e('v', src.v === undefined ? 'REQUIRED' : 'INVALID');

  // ------------------------------------------------------------ regions
  const owner = new Map<number, number>();
  const regions: Region[] = arr(src.regions, 'regions', L.regions, false).flatMap((v, i) => {
    const p = `regions.${i}`;
    const r = obj(v, p, ['id', 'role', 'parts', 'tone', 'paint', 'optional', 'shown_by']);
    if (!r) return [];
    const parts = arr(r.parts, `${p}.parts`, L.parts, false).map((x, j) => {
      const n = int(x, `${p}.parts.${j}`, 0, maxPart);
      if (owner.has(n)) e(`${p}.parts.${j}`, 'DUPLICATE');
      owner.set(n, i);
      return n;
    });
    let optional: Region['optional'] = null;
    const o = r.optional == null ? undefined : obj(r.optional, `${p}.optional`, ['on', 'fee_iqd']);
    if (o) optional = { on: bool(o.on, `${p}.optional.on`, false), fee_iqd: fee(o.fee_iqd, `${p}.optional.fee_iqd`) };
    if (r.shown_by != null && typeof r.shown_by !== 'string') e(`${p}.shown_by`, 'TYPE');
    const shown = typeof r.shown_by === 'string' ? r.shown_by : null;
    return [{ id: sid(r.id, `${p}.id`), role: one(r.role, `${p}.role`, REGION_ROLES), parts, tone: one(r.tone, `${p}.tone`, TONES), paint: paint(r.paint, `${p}.paint`), optional, shown_by: shown }];
  });
  if (Array.isArray(src.regions) && !src.regions.length) e('regions', 'REQUIRED');
  const photoOnly = regions.length > 0 && regions.every((r) => !r.parts.length);
  if (!photoOnly) regions.forEach((r, i) => !r.parts.length && e(`regions.${i}.parts`, 'REQUIRED'));

  // --------------------------------------------------------------- axes
  const ax = obj(src.axes, 'axes', ['size', 'look', 'tier'], {}) ?? {};
  const axes: Axes = {};
  const valueAxis = new Map<string, 'size' | 'look' | 'tier'>();
  const groups = new Set<string>();
  const axis = <V>(kind: 'size' | 'look' | 'tier', read: (v: unknown, p: string) => V): void => {
    const p = `axes.${kind}`;
    const a = ax[kind] === undefined ? undefined : obj(ax[kind], p, ['group', 'values']);
    if (!a) return;
    const group = xid(a.group, `${p}.group`);
    if (groups.has(group)) e(`${p}.group`, 'DUPLICATE');
    groups.add(group);
    if (!isObj(a.values)) return e(`${p}.values`, miss(a.values));
    const values: Record<string, V> = {};
    const list = Object.entries(a.values);
    if (!list.length) e(`${p}.values`, 'REQUIRED');
    if (list.length > L.axisValues) e(`${p}.values`, 'TOO_MANY');
    for (const [id, v] of list) {
      const vp = `${p}.values.${id.slice(0, 64)}`;
      if (!isExtId(id)) e(vp, 'INVALID');
      else {
        if (valueAxis.has(id)) e(vp, 'DUPLICATE');
        valueAxis.set(id, kind);
        values[id] = read(v, vp);
      }
    }
    const known = opts.variantGroups?.[group];
    if (opts.variantGroups && !known) e(`${p}.group`, 'UNKNOWN_REF');
    for (const id of Object.keys(values)) if (known && !known.includes(id)) e(`${p}.values.${id}`, 'UNKNOWN_REF');
    for (const id of known ?? []) if (!Object.keys(values).includes(id)) e(`${p}.values.${id}`, 'REQUIRED');
    (axes as Record<string, unknown>)[kind] = { group, values };
  };
  let recommended = 0;
  axis('size', (v, p) => {
    const s = obj(v, p, ['dims_mm', 'scale', 'recommended']) ?? {};
    const out = { dims_mm: vec(s.dims_mm, `${p}.dims_mm`, 0.1), scale: num(s.scale, `${p}.scale`, 0.05, 20) } as { dims_mm: Vec3; scale: number; recommended?: true };
    if (s.recommended === true) {
      out.recommended = true;
      if (recommended++) e(`${p}.recommended`, 'DUPLICATE');
    } else if (s.recommended !== undefined && s.recommended !== false) e(`${p}.recommended`, 'TYPE');
    return out;
  });
  axis('look', (v, p) => {
    const s = obj(v, p, ['look', 'material_id']) ?? {};
    if (typeof s.material_id !== 'string' || !MATERIAL.test(s.material_id)) e(`${p}.material_id`, s.material_id === undefined ? 'REQUIRED' : 'INVALID');
    return { look: one(s.look, `${p}.look`, LOOKS), material_id: String(s.material_id ?? '') };
  });
  axis('tier', (v, p) => ({ tier: one((obj(v, p, ['tier']) ?? {}).tier, `${p}.tier`, TIERS) }));

  // ------------------------------------------------------------- photos
  const media = new Set<string>();
  const photos: SpecPhoto[] = arr(src.photos, 'photos', L.photos).flatMap((v, i) => {
    const p = `photos.${i}`;
    const o = obj(v, p, ['media_id', 'value_id', 'colour']);
    if (!o) return [];
    const out: SpecPhoto = { media_id: xid(o.media_id, `${p}.media_id`) };
    if (opts.mediaIds && !opts.mediaIds.includes(out.media_id)) e(`${p}.media_id`, 'UNKNOWN_REF');
    if (o.value_id !== undefined) {
      out.value_id = xid(o.value_id, `${p}.value_id`);
      if (!valueAxis.has(out.value_id)) e(`${p}.value_id`, 'UNKNOWN_REF');
    }
    if (o.colour !== undefined) out.colour = one(o.colour, `${p}.colour`, PAINT_KEYS);
    return [out];
  });
  photos.forEach((x, i) => photos.findIndex((y) => y.media_id === x.media_id && y.value_id === x.value_id && y.colour === x.colour) < i && e(`photos.${i}`, 'DUPLICATE'));
  for (const x of photos) media.add(x.media_id);
  if (photoOnly && !photos.length) e('photos', 'REQUIRED');

  // -------------------------------------------------------------- areas
  const regionIds = new Set(regions.map((r) => r.id));
  const photoFrame = (v: unknown, path: string): PhotoFrame | undefined => {
    const f = obj(v, path, ['media_id', 'quad']);
    if (!f) return undefined;
    const media_id = xid(f.media_id, `${path}.media_id`);
    if (!media.has(media_id)) e(`${path}.media_id`, 'UNKNOWN_REF');
    const q = f.quad;
    const ok = Array.isArray(q) && q.length === 4 && q.every((pt) => Array.isArray(pt) && pt.length === 2 && pt.every((x) => typeof x === 'number' && x >= 0 && x <= 1));
    if (!ok) return e(`${path}.quad`, miss(q)), { media_id, quad: [[0, 0], [0, 0], [0, 0], [0, 0]] };
    const quad = q as Quad;
    const area = quad.reduce((s, [x, y], i) => s + x * quad[(i + 1) % 4][1] - quad[(i + 1) % 4][0] * y, 0) / 2;
    if (Math.abs(area) < 1e-4) e(`${path}.quad`, 'INVALID');
    return { media_id, quad };
  };
  const areas: Area[] = arr(src.areas, 'areas', L.areas).flatMap((v, i) => {
    const p = `areas.${i}`;
    const a = obj(v, p, ['id', 'kind', 'role', 'region', 'frame', 'photo_frame', 'text', 'logo', 'photo', 'qr', 'icon', 'required', 'fee_iqd']);
    if (!a) return [];
    const kind = one(a.kind, `${p}.kind`, CONTENT_KINDS);
    let role: AreaRole = kind;
    if (kind === 'text') role = one(a.role, `${p}.role`, ['name', 'text'] as const);
    else if (a.role !== undefined && a.role !== kind) e(`${p}.role`, 'INVALID');
    if (!regionIds.has(a.region as string)) e(`${p}.region`, a.region === undefined ? 'REQUIRED' : 'UNKNOWN_REF');
    const out: Area = { id: sid(a.id, `${p}.id`), kind, role, region: String(a.region ?? ''), required: bool(a.required, `${p}.required`, false), fee_iqd: fee(a.fee_iqd, `${p}.fee_iqd`) };
    if (a[photoOnly ? 'frame' : 'photo_frame'] !== undefined) e(`${p}.${photoOnly ? 'frame' : 'photo_frame'}`, 'NOT_ALLOWED');
    if (photoOnly) out.photo_frame = photoFrame(a.photo_frame, `${p}.photo_frame`);
    else out.frame = frame(a.frame, `${p}.frame`);
    for (const k of CONTENT_KINDS) if (k !== kind && a[k] !== undefined) e(`${p}.${k}`, 'NOT_ALLOWED');
    const sp = `${p}.${kind}`;
    if (kind === 'text') {
      const t = obj(a.text, sp, ['lines', 'max', 'count', 'styles', 'default_style', 'min_cap_mm', 'paint', 'sample']);
      if (t) {
        const max = int(t.max, `${sp}.max`, 1, L.graphemes);
        const styles = t.styles === undefined || t.styles === 'all' ? 'all' : many(t.styles, `${sp}.styles`, STYLES);
        const list = styles === 'all' ? STYLES : styles;
        const sample = (s: unknown, path: string): string => {
          if (typeof s !== 'string') return e(path, miss(s)), '';
          const line = cleanLine(s);
          if (!designTextOk(line)) e(path, 'INVALID');
          else if (graphemeCount(line) > max) e(path, 'TOO_LONG');
          return line;
        };
        const text: TextSpec = {
          lines: int(t.lines, `${sp}.lines`, 1, L.lines, 1), max, count: int(t.count, `${sp}.count`, 1, L.names, 1), styles,
          default_style: one(t.default_style, `${sp}.default_style`, list, list.includes('bold') ? 'bold' : list[0]),
          min_cap_mm: num(t.min_cap_mm, `${sp}.min_cap_mm`, 0.5, 100, 4), paint: paint(t.paint, `${sp}.paint`), sample: text3(t.sample, `${sp}.sample`, sample),
        };
        out.text = text;
      }
    } else if (kind === 'logo') {
      const l = obj(a.logo, sp, ['max_colors', 'modes'], {});
      if (l) out.logo = { max_colors: int(l.max_colors, `${sp}.max_colors`, 1, L.logoColors, 2), modes: l.modes === undefined ? ['flat'] : many(l.modes, `${sp}.modes`, LOGO_MODES) } as LogoSpec;
    } else if (kind === 'photo') {
      const f = obj(a.photo, sp, ['modes', 'min_px_per_mm']);
      if (f) out.photo = { modes: many(f.modes, `${sp}.modes`, PHOTO_MODES), min_px_per_mm: num(f.min_px_per_mm, `${sp}.min_px_per_mm`, 1, 50, 5) };
    } else if (kind === 'qr') {
      const q = obj(a.qr, sp, ['kinds', 'min_module_mm']);
      if (q) out.qr = { kinds: many(q.kinds, `${sp}.kinds`, QR_KINDS), min_module_mm: num(q.min_module_mm, `${sp}.min_module_mm`, 0.3, 10, 1) };
    } else if (kind === 'icon') {
      const c = obj(a.icon, sp, ['keys'], {});
      if (c) out.icon = { keys: c.keys === undefined || c.keys === 'all' ? 'all' : many(c.keys, `${sp}.keys`, ICON_KEYS) };
    }
    return [out];
  });
  const areaById = new Map(areas.map((a) => [a.id, a]));
  const colorIds = new Set([...regionIds, ...areas.filter((a) => a.kind === 'text').map((a) => a.id)]);

  // -------------------------------------------------------------- slots
  const slots: Slot[] = arr(src.slots, 'slots', L.slots).flatMap((v, i) => {
    const p = `slots.${i}`;
    const s = obj(v, p, ['id', 'kind', 'label', 'qty', 'required', 'choice', 'pricing', 'options', 'default', 'show', 'accepts']);
    if (!s) return [];
    const keys: string[] = [];
    const options = arr(s.options, `${p}.options`, L.options, false).flatMap((o, j) => {
      const op = `${p}.options.${j}`;
      const x = obj(o, op, ['key', 'part', 'kit']);
      if (!x) return [];
      if (x.kit !== undefined) return e(`${op}.kit`, 'NOT_ALLOWED'), [];
      const key = sid(x.key, `${op}.key`, false);
      if (keys.includes(key)) e(`${op}.key`, 'DUPLICATE');
      keys.push(key);
      return [{ key, part: partRef(x.part, `${op}.part`) }];
    });
    if (Array.isArray(s.options) && !s.options.length) e(`${p}.options`, 'REQUIRED');
    const out: Slot = {
      id: sid(s.id, `${p}.id`), kind: one(s.kind, `${p}.kind`, PART_KINDS), qty: int(s.qty, `${p}.qty`, 1, L.qty, 1), required: bool(s.required, `${p}.required`, false),
      choice: one(s.choice, `${p}.choice`, ['customer', 'fixed'] as const, 'customer'), pricing: one(s.pricing, `${p}.pricing`, ['add', 'included'] as const, 'add'), options,
    };
    if (s.label !== undefined) out.label = text3(s.label, `${p}.label`, (x, lp) => plain(x, lp, L.label));
    if (s.default !== undefined) {
      if (keys.includes(s.default as string)) out.default = s.default as string;
      else e(`${p}.default`, 'UNKNOWN_REF');
    } else if (out.required || out.choice === 'fixed') e(`${p}.default`, 'REQUIRED');
    if (s.show !== undefined && photoOnly) e(`${p}.show`, 'NOT_ALLOWED');
    else if (s.show !== undefined) {
      const w = obj(s.show, `${p}.show`, ['effect', 'part', 'anchor']) ?? {};
      const show: SlotShow = { effect: one(w.effect, `${p}.show.effect`, SLOT_EFFECTS) };
      if (w.part !== undefined) show.part = int(w.part, `${p}.show.part`, 0, maxPart);
      if (w.anchor !== undefined) show.anchor = frame(w.anchor, `${p}.show.anchor`);
      if (show.part === undefined && (show.effect === 'visible' || w.anchor === undefined)) e(`${p}.show`, 'REQUIRED');
      out.show = show;
    }
    if (s.accepts !== undefined) {
      const x = obj(s.accepts, `${p}.accepts`, ['kind', 'shape', 'diameter_mm', 'voltage']);
      const acc: PartAccepts = {};
      if (x?.kind !== undefined) acc.kind = oneOrMany(x.kind, `${p}.accepts.kind`, PART_KINDS);
      if (x?.shape !== undefined) acc.shape = oneOrMany(x.shape, `${p}.accepts.shape`, PART_SHAPES);
      if (x?.diameter_mm !== undefined) acc.diameter_mm = range(x.diameter_mm, `${p}.accepts.diameter_mm`, 1e4);
      if (x?.voltage !== undefined) acc.voltage = range(x.voltage, `${p}.accepts.voltage`, 400);
      out.accepts = acc;
    }
    return [out];
  });
  const slotById = new Map(slots.map((s) => [s.id, s]));
  /** `slot` names a slot and `is` one of its options. */
  const option = (x: Obj, path: string): { slot: string; is: string } => {
    const s = slotById.get(x.slot as string);
    if (!s) e(`${path}.slot`, x.slot === undefined ? 'REQUIRED' : 'UNKNOWN_REF');
    else if (!s.options.some((o) => o.key === x.is)) e(`${path}.is`, x.is === undefined ? 'REQUIRED' : 'UNKNOWN_REF');
    return { slot: String(x.slot ?? ''), is: String(x.is ?? '') };
  };

  // shown_by: `slot`, `slot:option` or `iconArea:iconKey`.
  regions.forEach((r, i) => {
    if (r.shown_by === null) return;
    const [id, key, extra] = r.shown_by.split(':');
    const slot = slotById.get(id);
    const icon = areaById.get(id)?.icon;
    const ok = extra === undefined && (slot ? key === undefined || slot.options.some((o) => o.key === key) : !!icon && ICON_KEYS.includes(key as IconKey) && (icon.keys === 'all' || icon.keys.includes(key as IconKey)));
    if (!ok) e(`regions.${i}.shown_by`, 'UNKNOWN_REF');
  });

  // -------------------------------------------------------------- rules
  const rules: Rule[] = arr(src.rules, 'rules', L.rules).flatMap((v, i) => {
    const p = `rules.${i}`;
    const r = obj(v, p, ['id', 'if', 'then', 'fix', 'say']);
    if (!r) return [];
    const w = obj(r.if, `${p}.if`, ['text', 'longer_than', 'slot', 'is', 'qr', 'value']);
    const t = obj(r.then, `${p}.then`, ['size_at_least', 'requires', 'excludes', 'only_colors', 'max_colors']);
    let when: RuleIf = { value: '' };
    let then: RuleThen = { max_colors: 1 };
    const whenKind = w && ['text', 'slot', 'qr', 'value'].filter((k) => w[k] !== undefined);
    if (w && whenKind?.length !== 1) e(`${p}.if`, 'INVALID');
    else if (w) {
      const k = whenKind![0];
      if (k !== 'text' && w.longer_than !== undefined) e(`${p}.if.longer_than`, 'NOT_ALLOWED');
      if (k !== 'slot' && w.is !== undefined) e(`${p}.if.is`, 'NOT_ALLOWED');
      if (k === 'slot') when = option(w, `${p}.if`);
      else if (k === 'value') {
        if (!valueAxis.has(w.value as string)) e(`${p}.if.value`, 'UNKNOWN_REF');
        when = { value: String(w.value) };
      } else {
        if (areaById.get(w[k] as string)?.kind !== k) e(`${p}.if.${k}`, 'UNKNOWN_REF');
        when = k === 'qr' ? { qr: String(w.qr) } : { text: String(w.text), longer_than: int(w.longer_than, `${p}.if.longer_than`, 1, L.graphemes) };
      }
    }
    const thenKind = t && Object.keys(t).filter((k) => ['size_at_least', 'requires', 'excludes', 'only_colors', 'max_colors'].includes(k));
    if (t && thenKind?.length !== 1) e(`${p}.then`, 'INVALID');
    else if (t) {
      const k = thenKind![0];
      const tp = `${p}.then.${k}`;
      if (k === 'size_at_least') {
        if (valueAxis.get(t.size_at_least as string) !== 'size') e(tp, 'UNKNOWN_REF');
        then = { size_at_least: String(t.size_at_least) };
      } else if (k === 'requires' || k === 'excludes') {
        const x = obj(t[k], tp, ['slot', 'is']);
        if (x) then = (k === 'requires' ? { requires: option(x, tp) } : { excludes: option(x, tp) });
      } else if (k === 'only_colors') {
        const x = obj(t.only_colors, tp, ['target', 'keys']);
        if (x && !colorIds.has(x.target as string)) e(`${tp}.target`, x.target === undefined ? 'REQUIRED' : 'UNKNOWN_REF');
        if (x) then = { only_colors: { target: String(x.target), keys: many(x.keys, `${tp}.keys`, PAINT_KEYS) } };
      } else then = { max_colors: int(t.max_colors, tp, 1, L.colors) };
    }
    return [{ id: sid(r.id, `${p}.id`), if: when, then, fix: one(r.fix, `${p}.fix`, ['auto', 'suggest'] as const, 'suggest'), say: one(r.say, `${p}.say`, SAY_CODES) }];
  });

  // ------------------------------------------------------------- extras
  const ex = obj(src.extras, 'extras', ['nfc', 'roster'], {}) ?? {};
  const extras: Extras = { nfc: null, roster: null };
  const nfc = ex.nfc == null ? undefined : obj(ex.nfc, 'extras.nfc', ['kinds', 'fee_iqd']);
  if (nfc) extras.nfc = { kinds: many(nfc.kinds, 'extras.nfc.kinds', NFC_KINDS), fee_iqd: fee(nfc.fee_iqd, 'extras.nfc.fee_iqd') };
  const ro = ex.roster == null ? undefined : obj(ex.roster, 'extras.roster', ['vary', 'max']);
  if (ro) {
    const vary = arr(ro.vary, 'extras.roster.vary', L.vary, false).map(String);
    if (Array.isArray(ro.vary) && !ro.vary.length) e('extras.roster.vary', 'REQUIRED');
    vary.forEach((x, i) => (!colorIds.has(x) ? e(`extras.roster.vary.${i}`, 'UNKNOWN_REF') : vary.indexOf(x) < i && e(`extras.roster.vary.${i}`, 'DUPLICATE')));
    extras.roster = { vary, max: int(ro.max, 'extras.roster.max', 1, L.roster) };
  }

  // -------------------------------------------------------------- the rest
  const co = obj(src.colors, 'colors', ['included', 'per_extra_iqd', 'max']) ?? {};
  const colors = { included: int(co.included, 'colors.included', 0, L.colors), per_extra_iqd: fee(co.per_extra_iqd, 'colors.per_extra_iqd'), max: int(co.max, 'colors.max', 1, L.colors) };
  if (colors.included > colors.max) e('colors.included', 'RANGE');
  const themes = src.themes === undefined || src.themes === 'all' ? 'all' : many(src.themes, 'themes', THEMES, true);
  const fixed: FixedPart[] = arr(src.fixed, 'fixed', L.fixed).flatMap((v, i) => {
    const f = obj(v, `fixed.${i}`, ['part', 'qty', 'show']);
    return f ? [{ part: partRef(f.part, `fixed.${i}.part`), qty: int(f.qty, `fixed.${i}.qty`, 1, L.qty, 1), show: bool(f.show, `fixed.${i}.show`, false) }] : [];
  });
  const pd = obj(src.prep_days_add, 'prep_days_add', ['tier_best', 'size'], {}) ?? {};
  const prep: BlueprintSpec['prep_days_add'] = {};
  if (pd.tier_best !== undefined) prep.tier_best = int(pd.tier_best, 'prep_days_add.tier_best', 0, L.prepDays);
  if (pd.size !== undefined && !isObj(pd.size)) e('prep_days_add.size', 'TYPE');
  else if (pd.size !== undefined) {
    const sizes: Record<string, number> = {};
    for (const [id, d] of Object.entries(pd.size as Obj)) {
      if (valueAxis.get(id) === 'size') sizes[id] = int(d, `prep_days_add.size.${id}`, 0, L.prepDays);
      else e(`prep_days_add.size.${id.slice(0, 64)}`, 'UNKNOWN_REF');
    }
    prep.size = sizes;
  }
  const tags = arr(src.tags, 'tags', L.tags).map(String);
  tags.forEach((x, i) => (!isTag(x) ? e(`tags.${i}`, 'INVALID') : tags.indexOf(x) < i && e(`tags.${i}`, 'DUPLICATE')));
  const se = obj(src.sell, 'sell', ['cart', 'request']);
  const sell = { cart: bool(se?.cart, 'sell.cart', false), request: bool(se?.request, 'sell.request', false) };
  if (se && !sell.cart && !sell.request) e('sell', 'REQUIRED');
  const pv = obj(src.private, 'private', ['quality_notes', 'notes'], {}) ?? {};
  const priv: BlueprintSpec['private'] = {};
  const qn = pv.quality_notes === undefined ? undefined : obj(pv.quality_notes, 'private.quality_notes', TIERS);
  if (qn) {
    priv.quality_notes = {};
    for (const k of TIERS) if (qn[k] !== undefined) priv.quality_notes[k] = plain(qn[k], `private.quality_notes.${k}`, L.qualityNote);
  }
  if (pv.notes !== undefined) priv.notes = plain(pv.notes, 'private.notes', L.notes, true);

  const out: BlueprintSpec = {
    v: 1, family: one(src.family, 'family', FAMILIES, 'other'), tags, sell, regions, areas, axes, colors, themes, slots, fixed, rules, extras, photos,
    licence: one(src.licence, 'licence', LICENCES, 'remix'), warranty_days: int(src.warranty_days, 'warranty_days', 0, L.warranty, 0), prep_days_add: prep, private: priv,
  };
  if (utf8Bytes(canonicalJson(out)) > L.bytes) e('', 'TOO_LARGE');
  return errs.length ? fail() : { ok: true, value: out };
}

/**
 * The spec a guest may read: no `private`, no hidden fixed parts (`show:
 * false` — production materials), no slot `accepts`. The Worker adds the rest
 * of a PublicBlueprint (product, variants, mesh, look, photo URLs, stock, part
 * names and prices).
 */
export function publicSpecOf(spec: BlueprintSpec): PublicSpec {
  const { private: _private, slots, fixed, ...rest } = spec;
  return { ...rest, slots: slots.map(({ accepts: _accepts, ...slot }) => slot), fixed: fixed.filter((f) => f.show) };
}

/**
 * The mesh parts a publish strips (worker/lib/personalize/compile.ts
 * `withoutParts` keeps their index with 0 triangles): every part no region
 * takes and no slot shows as its marker. A part is in at most one region.
 */
export function hiddenParts(spec: Pick<BlueprintSpec, 'regions' | 'slots'>, partCount: number): number[] {
  const seen = new Set<number>([...spec.regions.flatMap((r) => r.parts), ...spec.slots.flatMap((s) => (s.show?.part === undefined ? [] : [s.show.part]))]);
  return Array.from({ length: partCount }, (_, k) => k).filter((k) => !seen.has(k));
}

/** No region has a mesh part: the product's photos stand in for the 3D view (§0 row 39). */
export const isPhotoOnly = (spec: Pick<BlueprintSpec, 'regions'>): boolean => spec.regions.length > 0 && spec.regions.every((r) => !r.parts.length);

/** The size axis's value ids from the smallest to the largest (scale, then the longest side, then the id). */
export function sizeOrder(spec: Pick<BlueprintSpec, 'axes'>): string[] {
  const v = spec.axes.size?.values ?? {};
  const long = (id: string) => Math.max(...v[id].dims_mm);
  return Object.keys(v).sort((a, b) => v[a].scale - v[b].scale || long(a) - long(b) || (a < b ? -1 : a > b ? 1 : 0));
}
