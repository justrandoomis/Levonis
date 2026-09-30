/**
 * THE BLUEPRINT BUILDER, MOUNTED AS SHIPPED (Programme C, phase C1, lane L9) —
 * the product editor with its «التخصيص» door, the builder behind it over a
 * REAL three-part model and scripted merchant doors, and a photo-only path.
 * A browser fixture served only by a local `vite` dev server, never reachable
 * from production; L10's scripts/e2e-blueprint-builder.mjs drives it.
 *
 *   /tests/browser/blueprint-builder.html
 *       ?bp=off|model|photo|live|paused|heavy     (the product's customization)
 *       &lang=ar|en|ckb &theme=dark|light &motion=reduce
 *       &can=0                                   (/api/merchant/me says no: no door)
 *       &open=1                                  (the builder opened after the first paint)
 *
 *   off     never customized; a product with no options (Sources → upload, «أضف مقاسات»)
 *   model   a draft over the stand: 3 parts, a name area, sizes and looks, a magnet add-on, a rule
 *   photo   a photo-only draft: the product's own photos per colour, the name drawn on one
 *   live    version 3 live, no draft (editing opens version 4)
 *   paused  version 3 paused
 *   heavy   like `off`, but the model door answers 413 BLUEPRINT_TOO_HEAVY
 *
 * THE MODEL IS REAL: boxes written as LVM1 + the LVR1 ranges trailer
 * (worker/lib/personalize/compile.ts's format, lane L4), gzipped in the page
 * with CompressionStream and served as `application/gzip` by the merchant's
 * mesh door. `window.fetch` answers the builder's doors with the shapes
 * worker/routes/merchantBlueprints.ts returns; every request is kept in
 * `window.__calls` and every body in `window.__bodies` (the save body is the
 * merchant's declaration — ids and words, never a price the customer pays).
 */
import { useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import { LanguageProvider } from '../../src/LanguageContext';
import { AuthProvider } from '../../src/AuthContext';
import { StoreProvider } from '../../src/StoreContext';
import ProductEditorSheet from '../../src/components/merchant/catalog/ProductEditorSheet';
import { WorkspaceContext, type WorkspaceValue } from '../../src/components/merchant/shell/context';
import { Toaster } from '../../src/components/ui/Toast';
import { publicSpecOf } from '../../packages/catalog/src/personalize/spec';
import type { BlueprintSpec, PublicBlueprint } from '../../packages/catalog/src/personalize/types';
import type { BuilderState, RevisionOut } from '../../src/components/merchant/catalog/blueprint/api';
import '../../src/index.css';

const params = new URLSearchParams(location.search);
const lang = params.get('lang') === 'en' ? 'en' : params.get('lang') === 'ckb' ? 'ckb' : 'ar';
try {
  localStorage.setItem('levo_lang', lang);
} catch {
  /* Arabic, the default */
}
document.documentElement.lang = lang;
document.documentElement.dir = lang === 'en' ? 'ltr' : 'rtl';
document.documentElement.setAttribute('data-theme', params.get('theme') === 'light' ? 'light' : 'dark');
if (params.get('motion') === 'reduce') {
  const real = window.matchMedia.bind(window);
  window.matchMedia = (q: string) =>
    q.includes('prefers-reduced-motion')
      ? ({ matches: true, media: q, onchange: null, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {}, dispatchEvent: () => false } as MediaQueryList)
      : real(q);
}
const bp = (['off', 'model', 'photo', 'live', 'paused', 'heavy'] as const).find((x) => x === params.get('bp')) ?? 'model';

// ------------------------------------------------------------------ the model

type Box = [number, number, number, number, number, number];
/** Six faces, each wound so its normal points out. */
function boxTriangles([x0, y0, z0, x1, y1, z1]: Box): number[] {
  const faces = [
    [[x0, y0, z0], [x1, y0, z0], [x1, y0, z1], [x0, y0, z1]],
    [[x1, y1, z0], [x0, y1, z0], [x0, y1, z1], [x1, y1, z1]],
    [[x0, y1, z0], [x0, y0, z0], [x0, y0, z1], [x0, y1, z1]],
    [[x1, y0, z0], [x1, y1, z0], [x1, y1, z1], [x1, y0, z1]],
    [[x0, y1, z0], [x1, y1, z0], [x1, y0, z0], [x0, y0, z0]],
    [[x0, y0, z1], [x1, y0, z1], [x1, y1, z1], [x0, y1, z1]],
  ];
  return faces.flatMap(([a, b, c, d]) => [...a, ...b, ...c, ...a, ...c, ...d]);
}
/** The controller stand: 0 the base, 1 the body with its cradle back, 2 the name plate on the front. */
const PARTS: Box[][] = [
  [[-75, -50, -60, 75, 50, -48]],
  [[-60, -36, -48, 60, 40, -10], [-60, 14, -10, 60, 40, 60]],
  [[-42, -42, -40, 42, -36, -14]],
];
/** LVM1 (header, triangles in mm) + LVR1 (ranges only) — byte for byte the compiler's. */
function lvm(parts: Box[][]): ArrayBuffer {
  const tris = parts.map((boxes) => boxes.flatMap(boxTriangles));
  const t = tris.reduce((n, f) => n + f.length / 9, 0);
  const buf = new ArrayBuffer(32 + 36 * t + 8 + 8 * tris.length);
  const v = new DataView(buf);
  [0x4c, 0x56, 0x4d, 0x31].forEach((b, i) => v.setUint8(i, b));
  v.setUint32(4, t, true);
  const all = tris.flat();
  const min = [0, 1, 2].map((k) => Math.min(...all.filter((_, i) => i % 3 === k)));
  const max = [0, 1, 2].map((k) => Math.max(...all.filter((_, i) => i % 3 === k)));
  [...min, ...max].forEach((x, i) => v.setFloat32(8 + i * 4, x, true));
  all.forEach((x, i) => v.setFloat32(32 + i * 4, x, true));
  const at = 32 + 36 * t;
  [0x4c, 0x56, 0x52, 0x31].forEach((b, i) => v.setUint8(at + i, b));
  v.setUint16(at + 4, tris.length, true);
  let start = 0;
  tris.forEach((f, i) => {
    v.setUint32(at + 8 + i * 8, start, true);
    v.setUint32(at + 12 + i * 8, f.length / 9, true);
    start += f.length / 9;
  });
  return buf;
}
const RAW = lvm(PARTS);
const TRIANGLES = PARTS.flat().length * 12;
let meshGz: ArrayBuffer | null = null;
const DIMS: [number, number, number] = [150, 100, 120];
const COMPILED = [
  { n: 0, name: 'Base', triangles: 12, bbox_mm: [-75, -50, -60, 75, 50, -48], share: 0.41, volume_mm3: 180000 },
  { n: 1, name: 'Body', triangles: 24, bbox_mm: [-60, -36, -48, 60, 40, 60], share: 0.55, volume_mm3: 240000 },
  { n: 2, name: 'Name plate', triangles: 12, bbox_mm: [-42, -42, -40, 42, -36, -14], share: 0.04, volume_mm3: 13104 },
];

// ------------------------------------------------------------------ the product

const PID = 'cp_stand';
const L = (ar: string, en: string, ckb: string) => (lang === 'en' ? en : lang === 'ckb' ? ckb : ar);
function photo(board: [number, number, number], label: string): string {
  const c = document.createElement('canvas');
  c.width = 800;
  c.height = 600;
  const g = c.getContext('2d')!;
  g.fillStyle = 'rgb(214, 208, 198)';
  g.fillRect(0, 0, 800, 600);
  g.fillStyle = 'rgba(0, 0, 0, 0.22)';
  g.fillRect(150, 190, 520, 240);
  g.fillStyle = `rgb(${board.join(',')})`;
  g.fillRect(140, 180, 520, 240);
  g.fillStyle = 'rgba(255,255,255,0.7)';
  g.font = '28px sans-serif';
  g.fillText(label, 160, 560);
  return c.toDataURL('image/png');
}
const MEDIA = [
  { id: 'pm_black', kind: 'image' as const, key: 'merchants/u/public/black.webp', url: photo([34, 34, 38], 'black'), alt: 'Black', alt_ar: 'أسود' },
  { id: 'pm_white', kind: 'image' as const, key: 'merchants/u/public/white.webp', url: photo([236, 234, 228], 'white'), alt: 'White', alt_ar: 'أبيض' },
  { id: 'pm_wood', kind: 'image' as const, key: 'merchants/u/public/wood.webp', url: photo([156, 104, 58], 'wood'), alt: 'Wood', alt_ar: 'خشبي' },
];
const GROUPS = [
  { id: 'og_size', name: 'Size', name_ar: 'المقاس', kind: 'choice' as const, values: [{ id: 'ov_s', name: 'Small', name_ar: 'صغير', swatch: '' }, { id: 'ov_m', name: 'Medium', name_ar: 'وسط', swatch: '' }, { id: 'ov_l', name: 'Large', name_ar: 'كبير', swatch: '' }] },
  { id: 'og_look', name: 'Look', name_ar: 'المظهر', kind: 'choice' as const, values: [{ id: 'ov_classic', name: 'Classic', name_ar: 'كلاسيكي', swatch: '' }, { id: 'ov_silk', name: 'Silk', name_ar: 'حريري', swatch: '' }] },
];
const withGroups = bp === 'model' || bp === 'live' || bp === 'paused' || bp === 'photo';
const combos = withGroups ? GROUPS[0].values.flatMap((s, i) => GROUPS[1].values.map((lk, j) => ({ id: `pv_${s.id}_${lk.id}`, value_ids: [s.id, lk.id], label: `${s.name_ar} · ${lk.name_ar}`, price_iqd: 16000 + i * 4000 + j * 2000, compare_at_iqd: null, stock: 5, sku: '', active: true, image_key: null, low_stock_threshold: null }))) : [];
const base = {
  slug: 'controller-stand', description: '', description_ar: '', original_price_iqd: null, compare_at_iqd: null, sku: '', category: '', condition: 'new', prep_days: 2,
  lifecycle: 'active', status: 'active', legacy_note: null, options: [], colors: [], delivery_methods: [], collection_ids: [], section_id: null, featured: false, view_count: 0,
  moderation: null, created_at: '2026-09-28T10:00:00Z', updated_at: '2026-09-29T10:00:00Z', sold_out: false, low_stock: false, sold_count: 4, is_part: false, part_spec: null,
  attributes: { material: null, technology: null, color: null, finish: null, dim_x_mm: 150, dim_y_mm: 100, dim_z_mm: 120, weight_g: 180 }, low_stock_threshold: null, track_stock: true,
};
let product = {
  ...base,
  id: PID,
  name: 'Controller stand',
  name_ar: 'حامل يد التحكم',
  images: MEDIA.map((m) => m.url),
  price_iqd: 20000,
  stock: 12,
  state: 'published',
  variant_mode: withGroups ? 'variants' : 'simple',
  variant_count: combos.length,
  price_range: withGroups ? { min: 16000, max: 26000 } : null,
  media: MEDIA,
  option_groups: withGroups ? GROUPS : [],
  variants: combos,
};

const PARTS_LIST = [
  { ...base, id: 'pp_magnet', slug: 'magnet', name: 'N52 magnet', name_ar: 'مغناطيس N52', images: [], price_iqd: 1000, stock: 40, state: 'hidden', variant_mode: 'variants', variant_count: 2, price_range: { min: 1000, max: 1500 }, is_part: true },
  { ...base, id: 'pp_led', slug: 'led', name: 'LED strip 5V', name_ar: 'شريط LED ٥ فولت', images: [], price_iqd: 3000, stock: 10, state: 'hidden', variant_mode: 'simple', variant_count: 0, price_range: null, is_part: true },
];
const PART_DETAIL: Record<string, unknown> = {
  pp_magnet: {
    ...PARTS_LIST[0], media: [], option_groups: [{ id: 'po_d', name: 'Diameter', name_ar: 'القطر', kind: 'choice', values: [{ id: 'pov_10', name: '10 mm', name_ar: '١٠ مم', swatch: '' }, { id: 'pov_15', name: '15 mm', name_ar: '١٥ مم', swatch: '' }] }],
    variants: [
      { id: 'pv_m10', value_ids: ['pov_10'], label: '10 mm', price_iqd: null, compare_at_iqd: null, stock: 30, sku: '', active: true, image_key: null, low_stock_threshold: null },
      { id: 'pv_m15', value_ids: ['pov_15'], label: '15 mm', price_iqd: 1500, compare_at_iqd: null, stock: 10, sku: '', active: true, image_key: null, low_stock_threshold: null },
    ],
    part_spec: { printed_use: 'Yes', part_kind: 'magnet', part_shape: 'round', diameter_mm: '10', height_mm: '3' },
  },
  pp_led: { ...PARTS_LIST[1], media: [], option_groups: [], variants: [], part_spec: { printed_use: 'Yes', part_kind: 'led', voltage: '5' } },
};

// ------------------------------------------------------------------ the blueprint

const front = (z: number, w: number, h: number, y = -42) => ({ o: [0, y, z] as [number, number, number], n: [0, -1, 0] as [number, number, number], u: [0, 0, 1] as [number, number, number], w, h });
const MODEL_SPEC: BlueprintSpec = {
  v: 1, family: 'stand', tags: [], sell: { cart: true, request: false },
  regions: [
    { id: 'body', role: 'body', parts: [1], tone: 'primary', paint: { allowed: 'stocked', default: 'black' }, optional: null, shown_by: null },
    { id: 'base', role: 'base', parts: [0], tone: 'secondary', paint: { allowed: 'stocked', default: 'white' }, optional: null, shown_by: null },
    { id: 'name', role: 'name', parts: [2], tone: 'text', paint: { allowed: ['white', 'black', 'gold', 'red'], default: 'white' }, optional: null, shown_by: null },
  ],
  areas: [
    {
      id: 'a1', kind: 'text', role: 'name', region: 'name', frame: front(-27, 70, 20), required: true, fee_iqd: 0,
      text: { lines: 1, max: 12, count: 1, styles: 'all', default_style: 'bold', min_cap_mm: 4, paint: { allowed: 'stocked', default: 'black' }, sample: { ar: 'علي', en: 'ALI', ckb: 'عەلی' } },
    },
  ],
  axes: {
    size: { group: 'og_size', values: { ov_s: { dims_mm: [120, 80, 96], scale: 0.8 }, ov_m: { dims_mm: [150, 100, 120], scale: 1, recommended: true }, ov_l: { dims_mm: [203, 135, 162], scale: 1.35 } } },
    look: { group: 'og_look', values: { ov_classic: { look: 'classic', material_id: 'pla' }, ov_silk: { look: 'silk', material_id: 'pla-silk' } } },
  },
  colors: { included: 3, per_extra_iqd: 1000, max: 4 }, themes: 'all',
  slots: [{ id: 's1', kind: 'magnet', qty: 2, required: false, choice: 'customer', pricing: 'add', options: [{ key: 'o1', part: { p: 'pp_magnet', v: 'pv_m10' } }, { key: 'o2', part: { p: 'pp_magnet', v: 'pv_m15' } }], default: 'o1', show: { effect: 'ring', anchor: { o: [0, 0, -60], n: [0, 0, -1], u: [0, 1, 0], w: 12, h: 12 } } }],
  fixed: [],
  rules: [{ id: 'r1', if: { text: 'a1', longer_than: 10 }, then: { size_at_least: 'ov_m' }, fix: 'suggest', say: 'text_needs_size' }],
  extras: { nfc: null, roster: null }, photos: [], licence: 'remix', warranty_days: 30, prep_days_add: {}, private: { notes: 'Glue the base first' },
};
const PHOTO_SPEC: BlueprintSpec = {
  ...MODEL_SPEC,
  family: 'sign',
  regions: [{ id: 'body', role: 'body', parts: [], tone: 'primary', paint: { allowed: ['black', 'white', 'wood'], default: 'wood' }, optional: null, shown_by: null }],
  areas: [
    {
      id: 'a1', kind: 'text', role: 'name', region: 'body', photo_frame: { media_id: 'pm_wood', quad: [[0.24, 0.38], [0.76, 0.38], [0.76, 0.6], [0.24, 0.6]] }, required: true, fee_iqd: 0,
      text: { lines: 1, max: 14, count: 1, styles: 'all', default_style: 'bold', min_cap_mm: 6, paint: { allowed: ['black', 'white', 'gold'], default: 'white' }, sample: { ar: 'متجر الأمل', en: 'Hope Store', ckb: 'فرۆشگای هیوا' } },
    },
  ],
  slots: [],
  rules: [],
  photos: [{ media_id: 'pm_black', colour: 'black' }, { media_id: 'pm_white', colour: 'white' }, { media_id: 'pm_wood', colour: 'wood' }],
};

const meshUrl = (rev: number) => `/api/merchant/products/${PID}/blueprint/mesh?rev=${rev}`;
function revision(rev: number, state: RevisionOut['state'], spec: BlueprintSpec | null, look: RevisionOut['look'] = null): RevisionOut {
  const photoOnly = !!spec && spec.regions.every((r) => !r.parts.length);
  const model = !photoOnly && (spec !== null || bp === 'off' || bp === 'heavy');
  return {
    id: `bp_${rev}`, rev, state, spec, mesh_state: photoOnly ? 'photo' : model && meshGz ? 'ready' : 'none',
    mesh: !photoOnly && model && meshGz ? { url: meshUrl(rev), public_url: null, hash: 'f1x7u4e0a1b2', bytes: meshGz.byteLength, triangles: TRIANGLES, dims_mm: DIMS } : null,
    look, analysis: photoOnly || !meshGz ? {} : { format: '3mf', dims_mm: DIMS, warnings: ['UNIT_ASSUMED'], triangles: TRIANGLES }, source_keys: [], parts: photoOnly ? [] : COMPILED, from_iqd: null,
    published_at: state === 'draft' ? null : '2026-09-20T10:00:00Z', retired_at: state === 'retired' ? '2026-09-25T10:00:00Z' : null, updated_at: new Date().toISOString(),
  };
}
function previewOf(r: RevisionOut | null): PublicBlueprint | null {
  if (!r?.spec) return null;
  const photoOnly = r.spec.regions.every((x) => !x.parts.length);
  const unit = (p: string, v: string | null) => (v === 'pv_m15' ? 1500 : p === 'pp_led' ? 3000 : 1000);
  return {
    ...publicSpecOf(r.spec),
    product: { id: PID, slug: 'controller-stand', store_slug: 'ali3d', name: L(product.name_ar, product.name, product.name_ar), price_iqd: 20000, prep_days: 2 },
    variants: product.variants.filter((v) => v.active).map((v) => ({ id: v.id, values: Object.fromEntries(v.value_ids.map((id) => [product.option_groups.find((g) => g.values.some((x) => x.id === id))!.id, id])), price_iqd: v.price_iqd ?? product.price_iqd, in_stock: v.stock > 0 })),
    mesh: photoOnly || !r.mesh ? null : { url: r.mesh.url, hash: 'f1x7u4e0a1b2', bytes: r.mesh.bytes ?? 0, triangles: TRIANGLES, dims_mm: DIMS },
    look: photoOnly ? null : (r.look as PublicBlueprint['look']),
    photos: r.spec.photos.map((p) => ({ ...p, url: MEDIA.find((m) => m.id === p.media_id)?.url ?? '' })),
    stock: null, stock_rgb: {}, stock_names: {},
    slot_options: Object.fromEntries(r.spec.slots.map((s) => [s.id, s.options.map((o) => ({ key: o.key, product_id: o.part.p, variant_id: o.part.v, name: o.part.v === 'pv_m15' ? 'N52 · 15 mm' : o.part.p === 'pp_led' ? 'LED 5V' : 'N52 · 10 mm', image: null, unit_iqd: unit(o.part.p, o.part.v), in_stock: true }))])),
    printer: { max_mm: [256, 256, 256] },
    from_iqd: 16000,
    rev: r.rev,
  };
}
let state: BuilderState;
function stateOf(draft: RevisionOut | null, live: RevisionOut | null, retired: BuilderState['retired']): BuilderState {
  const cur = draft ?? live;
  const needsLook = !!draft?.spec && draft.mesh_state === 'ready' && !draft.look;
  return {
    product_id: PID, draft, live, retired, retired_more: false, mesh_state: cur?.mesh_state ?? (retired.length ? 'ready' : 'none'),
    parts: cur?.parts ?? (retired.length ? COMPILED : []), warnings: needsLook ? ['NEEDS_LOOK'] : [],
    suggestions: { roles: [{ n: 0, role: 'base' }, { n: 1, role: 'body' }, { n: 2, role: 'name' }], grams: { ov_s: 92, ov_m: 180, ov_l: 440 } },
    preview: previewOf(cur), limits: { max_triangles: 60000, max_blueprints_per_store: 200, source_files: 12 },
  };
}

// ------------------------------------------------------------------ the doors

declare global {
  interface Window {
    __calls: string[];
    __bodies: Array<{ path: string; body: unknown }>;
    __ready: boolean;
  }
}
window.__calls = [];
window.__bodies = [];

function answer(path: string, method: string, query: URLSearchParams, body: unknown): { status: number; body: unknown } | ArrayBuffer {
  const ok = (b: Record<string, unknown>) => ({ status: 200, body: { success: true, ...b } });
  const refuse = (status: number, code: string, details: Record<string, unknown>) => ({ status, body: { success: false, error: code, code, details } });
  const bpPath = `/api/merchant/products/${PID}/blueprint`;
  if (path === '/api/auth/me') return ok({ user: { id: 'u', name: 'Ali', email: 'a@x.co', role: 'merchant' } });
  if (path === '/api/storefront/resolve') return ok({ kind: 'main', store: null });
  if (path === '/api/merchant/printers') return ok({ printers: [], materials: [{ id: 'pla', name_en: 'PLA', name_ar: 'PLA' }, { id: 'pla-silk', name_en: 'PLA Silk', name_ar: 'PLA حريري' }, { id: 'petg', name_en: 'PETG', name_ar: 'PETG' }] });
  if (path === '/api/merchant/collections') return ok({ collections: [] });
  if (path === '/api/merchant/products' && method === 'GET') {
    const rows = query.get('kind') === 'parts' ? PARTS_LIST : [product];
    return ok({ products: rows, total: rows.length, next_cursor: null });
  }
  if (path === `/api/merchant/products/${PID}` && method === 'GET') return ok({ product });
  if (path === `/api/merchant/products/${PID}` && method === 'PATCH') {
    const model = (body as { variant_model?: { groups: Array<{ ref: string; name: string; name_ar: string; kind: 'choice'; values: Array<{ ref: string; name: string; name_ar: string; swatch: string }> }>; variants: Array<{ values: string[]; price_iqd: number | null; stock: number }> } }).variant_model;
    if (model) {
      const id = (ref: string) => (ref.startsWith('size_new') ? `ov_${ref}` : ref);
      const groups = model.groups.map((g) => ({ id: g.ref === 'size_new' ? 'og_new_size' : g.ref, name: g.name, name_ar: g.name_ar, kind: g.kind, values: g.values.map((v) => ({ id: id(v.ref), name: v.name, name_ar: v.name_ar, swatch: v.swatch })) }));
      const variants = model.variants.map((v, i) => ({ id: `pv_new_${i}`, value_ids: v.values.map(id), label: v.values.map(id).join(' · '), price_iqd: v.price_iqd, compare_at_iqd: null, stock: v.stock, sku: '', active: true, image_key: null, low_stock_threshold: null }));
      product = { ...product, variant_mode: 'variants', option_groups: groups, variants, variant_count: variants.length };
    }
    return ok({ product });
  }
  if (PART_DETAIL[path.split('/').pop() ?? ''] && method === 'GET') return ok({ product: PART_DETAIL[path.split('/').pop()!] });
  if (path === '/api/uploads/sessions' && method === 'POST') return ok({ session_id: 'us_fixture', chunk_bytes: 8 * 1024 * 1024 });
  if (/^\/api\/uploads\/sessions\/us_fixture\/parts\/\d+$/.test(path)) return ok({ received: [1] });
  if (path === '/api/uploads/sessions/us_fixture/complete') return ok({ key: `merchants/u_fixture/product-files/${Date.now()}.3mf`, url: '', mime: 'model/3mf', bytes: 1024, sha256: '0'.repeat(64) });
  if (path === bpPath && method === 'GET') return ok({ ...state });
  if (path === `${bpPath}/mesh`) return meshGz!;
  if (path === `${bpPath}/model` && method === 'PUT') {
    if (bp === 'heavy') return refuse(413, 'BLUEPRINT_TOO_HEAVY', { triangles: 84210, max: 60000 });
    const rev = (state.live?.rev ?? state.retired[0]?.rev ?? 0) + 1;
    state = stateOf({ ...revision(state.draft?.rev ?? rev, 'draft', state.draft?.spec ?? state.live?.spec ?? null), mesh_state: 'ready', mesh: { url: meshUrl(state.draft?.rev ?? rev), public_url: null, hash: 'f1x7u4e0a1b2', bytes: meshGz!.byteLength, triangles: TRIANGLES, dims_mm: DIMS }, parts: COMPILED, analysis: { format: '3mf', dims_mm: DIMS, warnings: ['UNIT_ASSUMED'], triangles: TRIANGLES } }, state.live, state.retired);
    return ok({ ...state });
  }
  if (path === `${bpPath}/draft` && method === 'PUT') {
    const b = body as { spec: BlueprintSpec; rev?: number };
    const from = state.draft ?? state.live;
    const rev = state.draft?.rev ?? (Math.max(state.live?.rev ?? 0, state.retired[0]?.rev ?? 0) + 1);
    const photoOnly = b.spec.regions.every((r) => !r.parts.length);
    const moved = JSON.stringify(from?.spec?.areas.map((a) => a.frame)) !== JSON.stringify(b.spec.areas.map((a) => a.frame)) || JSON.stringify(from?.spec?.regions.map((r) => r.parts)) !== JSON.stringify(b.spec.regions.map((r) => r.parts));
    state = stateOf({ ...revision(rev, 'draft', b.spec, moved ? null : state.draft?.look ?? null), mesh_state: photoOnly ? 'photo' : 'ready' }, state.live, state.retired);
    return ok({ ...state });
  }
  if (path === `${bpPath}/look` && method === 'PUT') {
    const b = body as { poster: string; idmap: string; quads: Record<string, unknown>; camera: number[] };
    const look = { poster_url: `data:image/png;base64,${b.poster}`, w: 1024, h: 1024, idmap: b.idmap, quads: b.quads, camera: b.camera };
    state = stateOf({ ...state.draft!, look }, state.live, state.retired);
    return ok({ ...state });
  }
  if (path === `${bpPath}/publish` && method === 'POST') {
    const rev = (body as { rev: number }).rev;
    const target = state.draft?.rev === rev ? state.draft : null;
    const retired = [...(state.live ? [{ id: state.live.id, rev: state.live.rev, published_at: state.live.published_at, retired_at: new Date().toISOString() }] : []), ...state.retired.filter((r) => r.rev !== rev)];
    const live = target ? { ...target, state: 'live' as const, published_at: new Date().toISOString() } : { ...revision(rev, 'live', MODEL_SPEC, state.live?.look ?? null) };
    state = stateOf(null, live, retired);
    return ok({ ...state });
  }
  if (path === `${bpPath}/pause` && method === 'POST') {
    state = stateOf(state.draft, null, state.live ? [{ id: state.live.id, rev: state.live.rev, published_at: state.live.published_at, retired_at: new Date().toISOString() }, ...state.retired] : state.retired);
    return ok({ ...state });
  }
  return ok({});
}

const realFetch = window.fetch.bind(window);
window.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
  const u = new URL(url, location.origin);
  if (!u.pathname.startsWith('/api/')) return realFetch(input, init);
  const method = (init?.method ?? 'GET').toUpperCase();
  window.__calls.push(`${method} ${u.pathname}${u.search}`);
  let body: unknown = null;
  if (typeof init?.body === 'string') {
    try {
      body = JSON.parse(init.body);
      window.__bodies.push({ path: `${method} ${u.pathname}`, body });
    } catch {
      body = null;
    }
  }
  await new Promise((r) => setTimeout(r, 60));
  const r = answer(u.pathname, method, u.searchParams, body);
  if (r instanceof ArrayBuffer) return new Response(r, { status: 200, headers: { 'content-type': 'application/gzip' } });
  return new Response(JSON.stringify(r.body), { status: r.status, headers: { 'content-type': 'application/json' } });
};

// ------------------------------------------------------------------ the page

const WORKSPACE = { me: { can: { customize: params.get('can') !== '0' } } } as unknown as WorkspaceValue;

function Editor() {
  const [open, setOpen] = useState(false);
  useEffect(() => setOpen(true), []);
  useEffect(() => {
    if (params.get('open') !== '1') return;
    const id = window.setInterval(() => {
      const b = document.querySelector<HTMLElement>('[data-blueprint-open]');
      if (b) {
        b.click();
        window.clearInterval(id);
      }
    }, 150);
    return () => window.clearInterval(id);
  }, []);
  return (
    <div className="min-h-[100dvh] bg-canvas text-text-secondary">
      <WorkspaceContext.Provider value={WORKSPACE}>
        <ProductEditorSheet open={open} productId={PID} canSell collections={[]} onClose={() => {}} onSaved={() => {}} />
      </WorkspaceContext.Provider>
      <Toaster />
    </div>
  );
}

async function boot() {
  meshGz = await new Response(new Blob([RAW]).stream().pipeThrough(new CompressionStream('gzip'))).arrayBuffer();
  const retiredV3 = [{ id: 'bp_3', rev: 3, published_at: '2026-09-20T10:00:00Z', retired_at: '2026-09-25T10:00:00Z' }];
  state =
    bp === 'model' ? stateOf(revision(2, 'draft', MODEL_SPEC), null, [])
      : bp === 'photo' ? stateOf(revision(1, 'draft', PHOTO_SPEC), null, [])
        : bp === 'live' ? stateOf(null, revision(3, 'live', MODEL_SPEC), [])
          : bp === 'paused' ? stateOf(null, null, retiredV3)
            : stateOf(null, null, []);
  window.__ready = true;
  createRoot(document.getElementById('root')!).render(
    <LanguageProvider>
      <AuthProvider>
        <StoreProvider>
          <MemoryRouter initialEntries={['/merchant/products']}>
            <Editor />
          </MemoryRouter>
        </StoreProvider>
      </AuthProvider>
    </LanguageProvider>
  );
}
void boot();
