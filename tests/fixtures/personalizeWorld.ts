/**
 * ONE PERSONALISATION WORLD for the C1 door tests (tests/personalizeRoutes.test.ts,
 * tests/blueprintRoutes.test.ts) — Programme C, phase C1, lane L5.
 *
 * On top of the catalogue world (tests/fixtures/catalog.ts: Ali's and Zain's
 * PLUS stores, the admin «boss», the buyer «buyer») it seeds, straight into
 * the real migrations:
 *
 *   · Ali's customizable products, on 0126's own option rows:
 *       cp_stand  «Name stand»  Size S (20,000 — the product's price) / M (23,000),
 *                 5 of each — the MESH product (a Bambu Studio 3MF: Body + Name plate);
 *       cp_sign   «Shop sign»   Small (35,000) / Large (50,000), 3 of each, two
 *                 pictures — the PHOTO-ONLY product (§0 row 39);
 *       cp_lamp   «Moon lamp»   Finish Classic (30,000) / Silk (34,000) — a look axis;
 *       cp_plain  «Plain mug», a simple product; cp_private, one customer's quote (0152);
 *   · Ali's parts (hidden products with `part_spec`, 0164): a 10 mm round magnet
 *     (1,000, 50 in stock), a sold-out RGB LED (5,000), the hidden glue (100),
 *     a 20 mm magnet that fits no 8–12 mm slot; Zain's own 10 mm magnet;
 *   · Ali's shelf (black and white PLA) and his workshop's largest bed (256 mm);
 *   · the upload ledger rows and bytes the doors read: Ali's model files (a real
 *     3MF, an STL heavier than the smallest triangle ceiling, a PDF), Zain's
 *     STL, the buyer's and Sami's design pictures (private, `design_asset`).
 *
 * Buckets: `R2_PUBLIC` and `R2_PRIVATE` are separate MemoryBuckets, so a test
 * proves which side an object landed on; `BUCKET` (the legacy binding) is empty.
 */
import type { DatabaseSync } from 'node:sqlite';
import { freshDb, asD1, stubApp, MemoryBucket, get, post, put, json, type App, type StubUser, type Mount } from './app';
import { seedCatalog } from './catalog';
import { bambuAssembly3mf, binaryStl, boxTriangles, type Tri } from './meshParts';
import { personalizeRoutes } from '../../worker/routes/personalize';
import { merchantBlueprintRoutes } from '../../worker/routes/merchantBlueprints';
import { merchantRoutes } from '../../worker/routes/merchant';
import { merchantCatalogRoutes } from '../../worker/routes/merchantCatalog';
import { merchantPartRoutes } from '../../worker/routes/merchantParts';
import { adminRoutes } from '../../worker/routes/admin';
import { uploadSessionRoutes } from '../../worker/routes/uploadSessions';

export const ALI: StubUser = { id: 'ali', role: 'merchant', email: 'ali@x.co' };
export const ZAIN: StubUser = { id: 'zain', role: 'merchant', email: 'zain@x.co' };
export const BOSS: StubUser = { id: 'boss', role: 'admin', email: 'boss@x.co' };
export const BUYER: StubUser = { id: 'buyer', role: 'customer', email: 'buyer@x.co' };
export const SAMI: StubUser = { id: 'sami', role: 'customer', email: 'sami@x.co' };

export const MODEL_KEY = 'merchants/ali/product-files/stand0001.3mf';
export const HEAVY_KEY = 'merchants/ali/product-files/heavy0001.stl';
export const DOC_KEY = 'merchants/ali/product-files/notes0001.pdf';
export const ZAIN_MODEL_KEY = 'merchants/zain/product-files/zain0001.stl';
export const ASSET_KEY = 'users/buyer/design-assets/logo0001.png';
export const SAMI_ASSET_KEY = 'users/sami/design-assets/logo0002.png';

/** Strings that exist only in a spec's `private`, a hidden fixed part or a slot's `accepts` — never in a customer's answer. */
export const PRIVATE_NOTE = 'PRIVATE-NOTE-7f3a';

/** A PNG the upload doors and the look card accept: the signature and an IHDR naming `w`×`h`. */
export function pngBytes(w: number, h: number, pad = 64): Uint8Array {
  const out = new Uint8Array(33 + pad);
  out.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52]);
  const dv = new DataView(out.buffer);
  dv.setUint32(16, w);
  dv.setUint32(20, h);
  out.set([8, 6, 0, 0, 0], 24);
  for (let i = 33; i < out.length; i++) out[i] = i & 0xff;
  return out;
}

export const b64 = (bytes: Uint8Array): string => Buffer.from(bytes).toString('base64');

/** Part facts as the stored flat map (L6's `part_spec`). */
const partSpec = (facts: Record<string, string>) => JSON.stringify(facts).replace(/'/g, "''");

export interface World {
  raw: DatabaseSync;
  pub: MemoryBucket;
  priv: MemoryBucket;
  legacy: MemoryBucket;
}

export function personalizeWorld(opts: { on?: boolean } = {}): World {
  const raw = freshDb();
  seedCatalog(raw);
  raw.exec(`
    INSERT INTO users (id, name, email, password_hash, role) VALUES ('sami', 'Sami', 'sami@x.co', 'h', 'customer');

    INSERT INTO community_products (id, merchant_id, store_id, slug, name, name_ar, price_iqd, publish_state, variant_mode, track_stock, stock, prep_days) VALUES
      ('cp_stand', 'm_ali', 's_ali', 'name-stand', 'Name stand', 'حامل اسم', 20000, 'published', 'variants', 1, 0, 2),
      ('cp_sign', 'm_ali', 's_ali', 'shop-sign', 'Shop sign', 'لوحة محل', 35000, 'published', 'variants', 1, 0, 3),
      ('cp_plain', 'm_ali', 's_ali', 'plain-mug', 'Plain mug', 'كوب', 8000, 'published', 'simple', 1, 9, 1),
      ('cp_lamp', 'm_ali', 's_ali', 'moon-lamp', 'Moon lamp', 'مصباح القمر', 30000, 'published', 'variants', 1, 0, 4),
      ('cp_zprod', 'm_zain', 's_zain', 'zain-cup', 'Zain cup', '', 6000, 'published', 'simple', 1, 9, 1);
    INSERT INTO community_products (id, merchant_id, store_id, slug, name, price_iqd, publish_state, audience_user_id) VALUES
      ('cp_private', 'm_ali', 's_ali', 'a-quote', 'A quote for Sara', 9000, 'published', 'buyer');
    INSERT INTO community_products (id, merchant_id, store_id, slug, name, name_ar, price_iqd, publish_state, variant_mode, track_stock, stock, part_spec) VALUES
      ('cp_magnet', 'm_ali', 's_ali', 'magnet-10', 'Round magnet 10 mm', 'مغناطيس ١٠ مم', 1000, 'hidden', 'simple', 1, 50,
        '${partSpec({ part_kind: 'magnet', part_shape: 'round', diameter_mm: '10', height_mm: '3' })}'),
      ('cp_bigmag', 'm_ali', 's_ali', 'magnet-20', 'Round magnet 20 mm', '', 2500, 'hidden', 'simple', 1, 50,
        '${partSpec({ part_kind: 'magnet', part_shape: 'round', diameter_mm: '20', height_mm: '3' })}'),
      ('cp_led', 'm_ali', 's_ali', 'rgb-led', 'RGB LED', '', 5000, 'hidden', 'simple', 1, 0,
        '${partSpec({ part_kind: 'led', part_shape: 'strip', voltage: '5' })}'),
      ('cp_glue', 'm_ali', 's_ali', 'glue', 'Glue', '', 100, 'hidden', 'simple', 1, 100,
        '${partSpec({ part_kind: 'other' })}'),
      ('cp_zmagnet', 'm_zain', 's_zain', 'z-magnet', 'Zain magnet', '', 900, 'hidden', 'simple', 1, 50,
        '${partSpec({ part_kind: 'magnet', part_shape: 'round', diameter_mm: '10', height_mm: '3' })}');

    INSERT INTO community_product_options (id, product_id, store_id, name, name_ar, position) VALUES
      ('og_size', 'cp_stand', 's_ali', 'Size', 'المقاس', 0),
      ('og_sign', 'cp_sign', 's_ali', 'Size', 'المقاس', 0),
      ('og_look', 'cp_lamp', 's_ali', 'Finish', 'اللمسة', 0);
    INSERT INTO community_product_option_values (id, option_id, product_id, name, name_ar, position) VALUES
      ('ov_s', 'og_size', 'cp_stand', 'Small', 'صغير', 0),
      ('ov_m', 'og_size', 'cp_stand', 'Medium', 'وسط', 1),
      ('ov_ss', 'og_sign', 'cp_sign', 'Small', 'صغيرة', 0),
      ('ov_sl', 'og_sign', 'cp_sign', 'Large', 'كبيرة', 1),
      ('ov_classic', 'og_look', 'cp_lamp', 'Classic', 'كلاسيك', 0),
      ('ov_silk', 'og_look', 'cp_lamp', 'Silk', 'حريري', 1);
    INSERT INTO community_product_variants (id, product_id, store_id, value1_id, price_iqd, stock, position) VALUES
      ('pv_s', 'cp_stand', 's_ali', 'ov_s', NULL, 5, 0),
      ('pv_m', 'cp_stand', 's_ali', 'ov_m', 23000, 5, 1),
      ('pv_ss', 'cp_sign', 's_ali', 'ov_ss', NULL, 3, 0),
      ('pv_sl', 'cp_sign', 's_ali', 'ov_sl', 50000, 3, 1),
      ('pv_classic', 'cp_lamp', 's_ali', 'ov_classic', NULL, 2, 0),
      ('pv_silk', 'cp_lamp', 's_ali', 'ov_silk', 34000, 2, 1);
    INSERT INTO community_product_media (id, product_id, store_id, kind, media_key, position) VALUES
      ('pm_wood', 'cp_sign', 's_ali', 'image', 'merchants/ali/public/aaaa1111.webp', 0),
      ('pm_black', 'cp_sign', 's_ali', 'image', 'merchants/ali/public/bbbb2222.webp', 1);

    INSERT INTO merchant_material_stock (id, merchant_id, material_id, color_hex, color_name, grams) VALUES
      ('mms_black', 'm_ali', 'pla', '#111111', 'Black PLA', 800),
      ('mms_white', 'm_ali', 'pla', '#F4F4F4', 'White PLA', 600);
    INSERT INTO merchant_request_prefs (merchant_id, max_build_mm) VALUES ('m_ali', '{"x":256,"y":256,"z":256}');

    INSERT INTO file_objects (object_key, visibility, domain, owner_id, entity_id, mime_type, byte_size, original_name, purpose) VALUES
      ('${MODEL_KEY}', 'private', 'merchants', 'ali', 'ali', 'model/3mf', 1, 'Keychain stand.3mf', 'product_file'),
      ('${HEAVY_KEY}', 'private', 'merchants', 'ali', 'ali', 'model/stl', 1, 'Heavy.stl', 'product_file'),
      ('${DOC_KEY}', 'private', 'merchants', 'ali', 'ali', 'application/pdf', 1, 'Notes.pdf', 'product_file'),
      ('${ZAIN_MODEL_KEY}', 'private', 'merchants', 'zain', 'zain', 'model/stl', 1, 'Zain.stl', 'product_file');
    INSERT INTO file_objects (object_key, visibility, domain, owner_id, entity_id, mime_type, byte_size, width, height, original_name, purpose) VALUES
      ('${ASSET_KEY}', 'private', 'users', 'buyer', 'cp_sign', 'image/png', 97, 800, 800, 'logo.png', 'design_asset'),
      ('${SAMI_ASSET_KEY}', 'private', 'users', 'sami', 'cp_sign', 'image/png', 97, 800, 800, 'logo.png', 'design_asset');
  `);
  if (opts.on) setSwitch(raw, { enabled: true });
  const pub = new MemoryBucket();
  const priv = new MemoryBucket();
  const legacy = new MemoryBucket();
  const heavy: Tri[] = [];
  for (let i = 0; i < 101; i++) heavy.push(...boxTriangles(4, 4, 4, i * 5, 0, 0));
  void priv.put(MODEL_KEY, bambuAssembly3mf(), { httpMetadata: { contentType: 'model/3mf' } });
  void priv.put(HEAVY_KEY, binaryStl(heavy), { httpMetadata: { contentType: 'model/stl' } });
  void priv.put(DOC_KEY, new TextEncoder().encode('%PDF-1.4\n%notes\n'), { httpMetadata: { contentType: 'application/pdf' } });
  void priv.put(ZAIN_MODEL_KEY, binaryStl(boxTriangles(10, 10, 10)), { httpMetadata: { contentType: 'model/stl' } });
  void priv.put(ASSET_KEY, pngBytes(800, 800), { httpMetadata: { contentType: 'image/png' } });
  void priv.put(SAMI_ASSET_KEY, pngBytes(800, 800), { httpMetadata: { contentType: 'image/png' } });
  return { raw, pub, priv, legacy };
}

/** Write `customizationConfig` as an admin would (the reader normalises it). */
export function setSwitch(raw: DatabaseSync, value: Record<string, unknown>): void {
  raw
    .prepare("INSERT INTO admin_settings (key, value) VALUES ('customizationConfig', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
    .run(JSON.stringify(value));
}

export const mount: Mount = (a) => {
  a.route('/api/uploads/sessions', uploadSessionRoutes);
  a.route('/api/admin', adminRoutes);
  a.route('/api/merchant', merchantRoutes);
  a.route('/api/merchant', merchantCatalogRoutes);
  a.route('/api/merchant/parts', merchantPartRoutes);
  a.route('/api/merchant', merchantBlueprintRoutes);
  a.route('/api/personalize', personalizeRoutes);
};

export function as(w: World, user: StubUser | null, opts: { host?: string; db?: unknown; env?: Record<string, unknown> } = {}): App {
  return stubApp(opts.db ?? asD1(w.raw), user, mount, {
    host: opts.host,
    env: { BUCKET: w.legacy, R2_PUBLIC: w.pub, R2_PRIVATE: w.priv, ...(opts.env ?? {}) },
  });
}

// ------------------------------------------------------------------ specs

/**
 * The stand's blueprint, against the 3MF's two parts (0 Body, 1 Name plate —
 * the plate is taken by no region, so the public mesh drops it) and the
 * product's own size values. The frame sits on the 20 × 20 × 7 mm model.
 */
export function standSpec(): Record<string, unknown> {
  return {
    v: 1,
    family: 'stand',
    tags: ['occ:birthday', 'for:kids'],
    sell: { cart: true, request: true },
    regions: [{ id: 'body', role: 'body', parts: [0], tone: 'primary', paint: { allowed: 'stocked', default: 'black' } }],
    areas: [
      {
        id: 'name', kind: 'text', role: 'name', region: 'body',
        frame: { o: [0, -10, 0], n: [0, -1, 0], u: [0, 0, 1], w: 16, h: 5 },
        text: { max: 12, paint: { allowed: ['white', 'gold'], default: 'white' }, sample: { ar: 'علي', en: 'ALI', ckb: 'عەلی' } },
        required: true,
      },
    ],
    axes: { size: { group: 'og_size', values: { ov_s: { dims_mm: [120, 80, 96], scale: 0.8 }, ov_m: { dims_mm: [150, 100, 120], scale: 1, recommended: true } } } },
    colors: { included: 2, per_extra_iqd: 1000, max: 3 },
    slots: [
      {
        id: 'magnet', kind: 'magnet', qty: 2,
        options: [{ key: 'm10', part: { p: 'cp_magnet', v: null } }],
        accepts: { shape: 'round', diameter_mm: { min: 8, max: 12 } },
      },
    ],
    fixed: [{ part: { p: 'cp_glue', v: null }, qty: 1, show: false }],
    warranty_days: 30,
    private: { notes: `${PRIVATE_NOTE}: glue the base before the magnets` },
  };
}

/** The photo-only sign: the name drawn on the wood picture, a logo below it, magnets and a (sold-out) light. */
export function signSpec(): Record<string, unknown> {
  return {
    v: 1,
    family: 'sign',
    tags: ['biz'],
    sell: { cart: true, request: false },
    regions: [{ id: 'board', role: 'body', parts: [], tone: 'primary', paint: { allowed: ['black', 'white', 'wood'], default: 'wood' } }],
    areas: [
      {
        id: 'name', kind: 'text', role: 'name', region: 'board',
        photo_frame: { media_id: 'pm_wood', quad: [[0.2, 0.3], [0.8, 0.3], [0.8, 0.5], [0.2, 0.5]] },
        text: { lines: 2, max: 18, styles: ['elegant', 'bold'], default_style: 'elegant', min_cap_mm: 8, paint: { allowed: ['black', 'white', 'gold'], default: 'black' }, sample: { ar: 'متجر الأمل', en: 'Hope Store', ckb: 'فرۆشگای هیوا' } },
        required: true,
      },
      {
        id: 'logo', kind: 'logo', role: 'logo', region: 'board',
        photo_frame: { media_id: 'pm_wood', quad: [[0.4, 0.6], [0.6, 0.6], [0.6, 0.8], [0.4, 0.8]] },
        logo: { max_colors: 2, modes: ['flat'] },
      },
    ],
    axes: { size: { group: 'og_sign', values: { ov_ss: { dims_mm: [200, 80, 5], scale: 1, recommended: true }, ov_sl: { dims_mm: [250, 100, 5], scale: 1.25 } } } },
    colors: { included: 2, per_extra_iqd: 0, max: 2 },
    slots: [
      { id: 'magnet', kind: 'magnet', qty: 2, options: [{ key: 'm10', part: { p: 'cp_magnet', v: null } }], accepts: { shape: 'round' } },
      { id: 'light', kind: 'led', qty: 1, options: [{ key: 'rgb', part: { p: 'cp_led', v: null } }] },
    ],
    photos: [{ media_id: 'pm_wood', colour: 'wood' }, { media_id: 'pm_black', colour: 'black' }],
    private: { notes: `${PRIVATE_NOTE}: varnish twice` },
  };
}

/** The builder's capture of the stand's draft: a PNG poster, an id map, the name's quad and a camera. */
export function lookBody(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    poster: b64(pngBytes(640, 480, 2048)),
    idmap: b64(new Uint8Array([1, 0, 200, 1, 1, 40])),
    quads: { name: [[0.3, 0.55], [0.7, 0.55], [0.7, 0.7], [0.3, 0.7]] },
    camera: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, -120, 1],
    ...over,
  };
}

// ------------------------------------------------------------------ flows

const ok = async (res: Response, what: string) => {
  if (res.status >= 300) throw new Error(`${what}: ${res.status} ${await res.text()}`);
  return json(res);
};

/** The sign, published through the builder's doors (draft, then publish) — photo-only needs no model. */
export async function publishSign(w: World, spec: Record<string, unknown> = signSpec()) {
  const app = as(w, ALI);
  const saved = await ok(await put(app, '/api/merchant/products/cp_sign/blueprint/draft', { spec }), 'sign draft');
  return ok(await post(app, '/api/merchant/products/cp_sign/blueprint/publish', { rev: saved.draft.rev }), 'sign publish');
}

/** The stand, published the long way: the model, the draft, the look card, then publish. */
export async function publishStand(w: World, spec: Record<string, unknown> = standSpec()) {
  const app = as(w, ALI);
  await ok(await put(app, '/api/merchant/products/cp_stand/blueprint/model', { keys: [MODEL_KEY] }), 'stand model');
  const saved = await ok(await put(app, '/api/merchant/products/cp_stand/blueprint/draft', { spec }), 'stand draft');
  await ok(await put(app, '/api/merchant/products/cp_stand/blueprint/look', lookBody()), 'stand look');
  return ok(await post(app, '/api/merchant/products/cp_stand/blueprint/publish', { rev: saved.draft.rev }), 'stand publish');
}

/** A guest's read of a product's public blueprint. */
export const readBlueprint = (w: World, productId: string, user: StubUser | null = null, query = '') =>
  get(as(w, user), `/api/personalize/blueprints/${productId}${query}`);
