/**
 * THE REVIEWS WORLD (docs/REVIEWS_GIFTS.md, lane S1): the real migrations, the
 * real review / gift / device routes mounted as worker/index.ts mounts them,
 * products filed under the SEEDED sections (so the printer family is the
 * owner's real taxonomy, not a flag), delivered orders with their units, and
 * an in-memory R2 bucket that keeps what the upload door writes — content
 * type, the sha256 custom metadata — and answers ranges.
 *
 * Used by tests/review*.test.ts. Nothing here mocks the code under test.
 */
import type { DatabaseSync } from 'node:sqlite';
import { freshDb, asD1, stubApp, json, type App, type StubUser } from './app';
import { reviewRoutes } from '../../worker/routes/reviews';
import { giftRoutes } from '../../worker/routes/gifts';
import { deviceRoutes } from '../../worker/routes/devices';

export const DELIVERED_AT = '2026-09-01T10:00:00.000Z';

/** Thirty-plus real characters, distinct per call (the advisory quality flags repeated text). */
export const goodText = (n = 1) =>
  `Printer ${n}: the first layer is clean, calibration took ten minutes and prints are accurate.`;

// ------------------------------------------------------------ the R2 fake

interface Stored {
  bytes: Uint8Array;
  httpMetadata: { contentType?: string; cacheControl?: string };
  customMetadata: Record<string, string>;
  etag: string;
}

/** An R2 bucket kept in memory: put/head/get(range)/delete with the metadata the routes read. */
export class ReviewBucket {
  readonly objects = new Map<string, Stored>();
  private seq = 0;

  async put(key: string, value: Uint8Array | ArrayBuffer, options: { httpMetadata?: Stored['httpMetadata']; customMetadata?: Record<string, string> } = {}) {
    const bytes = value instanceof Uint8Array ? value : new Uint8Array(value);
    this.seq += 1;
    this.objects.set(key, {
      bytes: new Uint8Array(bytes),
      httpMetadata: { ...(options.httpMetadata ?? {}) },
      customMetadata: { ...(options.customMetadata ?? {}) },
      etag: `etag-${this.seq}`,
    });
    return this.head(key);
  }

  private meta(key: string, o: Stored) {
    return {
      key,
      size: o.bytes.byteLength,
      etag: o.etag,
      httpEtag: `"${o.etag}"`,
      httpMetadata: { ...o.httpMetadata },
      customMetadata: { ...o.customMetadata },
      writeHttpMetadata(headers: Headers) {
        if (o.httpMetadata.contentType) headers.set('content-type', o.httpMetadata.contentType);
        if (o.httpMetadata.cacheControl) headers.set('cache-control', o.httpMetadata.cacheControl);
      },
    };
  }

  async head(key: string) {
    const o = this.objects.get(key);
    return o ? (this.meta(key, o) as unknown as R2Object) : null;
  }

  async get(key: string, options?: { range?: { offset: number; length: number } }) {
    const o = this.objects.get(key);
    if (!o) return null;
    const slice = options?.range
      ? o.bytes.subarray(options.range.offset, options.range.offset + options.range.length)
      : o.bytes;
    return {
      ...this.meta(key, o),
      body: new Blob([slice as unknown as BlobPart]).stream(),
      arrayBuffer: async () => slice.slice().buffer,
    } as unknown as R2ObjectBody;
  }

  async delete(key: string | string[]) {
    for (const k of Array.isArray(key) ? key : [key]) this.objects.delete(k);
  }
}

// ------------------------------------------------------------ byte builders

/** A JPEG signature with distinct bytes after it (the digest differs per `seed`). */
export function jpeg(seed: number, size = 64): Uint8Array {
  const b = new Uint8Array(Math.max(16, size));
  b.set([0xff, 0xd8, 0xff, 0xe0]);
  for (let i = 4; i < b.length; i++) b[i] = (seed * 31 + i * 7) & 0xff;
  return b;
}

const u32 = (n: number) => [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255];
const ascii = (s: string) => [...s].map((ch) => ch.charCodeAt(0));
function box(type: string, ...payload: number[][]): number[] {
  const body = payload.flat();
  return [...u32(8 + body.length), ...ascii(type), ...body];
}

/** A minimal but structurally real MP4 (or MOV with brand 'qt  '): ftyp, moov/trak/…/stsd/<codec>, mdat. */
export function mp4({ brand = 'isom', handler = 'vide', codec = 'avc1', seed = 7 } = {}): Uint8Array {
  const stsd = box('stsd', [0, 0, 0, 0], u32(1), box(codec, new Array(78).fill(0)));
  const trak = box('trak', box('mdia', box('hdlr', [0, 0, 0, 0], u32(0), ascii(handler), new Array(12).fill(0)), box('minf', box('stbl', stsd))));
  return new Uint8Array([
    ...box('ftyp', ascii(brand), u32(512), ascii('isom'), ascii('mp41')),
    ...box('moov', trak),
    ...box('mdat', new Array(64).fill(seed & 0xff)),
  ]);
}

const el = (id: number[], payload: number[], unknown = false) => [...id, unknown ? 0xff : 0x80 | payload.length, ...payload];
/** A MediaRecorder-style WebM with one VP9 video track. */
export function webm(seed = 9): Uint8Array {
  const header = el([0x1a, 0x45, 0xdf, 0xa3], el([0x42, 0x82], ascii('webm')));
  const entry = el([0xae], [...el([0xd7], [1]), ...el([0x83], [1]), ...el([0x86], ascii('V_VP9'))]);
  const tracks = el([0x16, 0x54, 0xae, 0x6b], entry);
  const cluster = [0x1f, 0x43, 0xb6, 0x75, 0xff, ...new Array(40).fill(seed & 0xff)];
  const segment = [0x18, 0x53, 0x80, 0x67, 0xff, ...el([0x15, 0x49, 0xa9, 0x66], [0x2a, 0xd7, 0xb1, 0x83, 0x0f, 0x42, 0x40]), ...tracks, ...cluster];
  return new Uint8Array([...header, ...segment]);
}

/** An iPhone HEIC photograph's opening bytes. */
export function heic(): Uint8Array {
  return new Uint8Array([...box('ftyp', ascii('heic'), u32(0), ascii('mif1'), ascii('heic')), ...new Array(32).fill(1)]);
}

// ------------------------------------------------------------ the world

export interface WorldOptions {
  /** Link the buyer's printer unit to the buyer in the warranty centre. */
  registered?: boolean;
  /** Link it to another account instead. */
  registeredTo?: string;
}

/**
 * Users: buyer, other (a second customer), stranger (bought nothing), boss (admin).
 * Products, each filed under its OWN seeded section:
 *   p_fdm    a printer under cat_printers_fdm      (the gift program)
 *   p_resin  a printer under cat_printers_resin    (the gift program)
 *   p_lacc   a laser ACCESSORY under cat_laser_acc (not a printer)
 *   p_pla    a filament                            (not a printer)
 * Orders: ORD-1 (buyer, delivered) with oi_fdm, oi_pla, oi_lacc;
 *         ORD-2 (other, delivered) with oi_other_fdm.
 * Units: u_fdm (buyer's printer), u_other (other's printer).
 */
export function reviewWorld(opts: WorldOptions = {}): { raw: DatabaseSync; db: D1Database } {
  const raw = freshDb();
  raw.exec(`
    INSERT INTO users (id,name,email,username,password_hash,role) VALUES
      ('buyer','Sara Kareem','buyer@x.co','sara','h','customer'),
      ('other','Omar Ali','other@x.co','omar','h','customer'),
      ('stranger','Nobody','stranger@x.co','nobody','h','customer'),
      ('boss','Boss','boss@x.co','boss','h','admin');
    INSERT INTO products (id,slug,name,name_ar,price_iqd,category_id,sub_category_id) VALUES
      ('p_fdm','bambu-a1','Bambu A1','بامبو A1',899000,'cat_printers','cat_printers_fdm'),
      ('p_resin','elegoo-mars','Elegoo Mars','إليغو مارس',450000,'cat_printers','cat_printers_resin'),
      ('p_lacc','laser-lens','Laser lens','عدسة ليزر',20000,'cat_laser','cat_laser_acc'),
      ('p_pla','pla-white','PLA White','PLA أبيض',25000,NULL,NULL);
  `);
  order(raw, 'ORD-1', 'buyer');
  order(raw, 'ORD-2', 'other');
  raw.exec(`
    INSERT INTO order_items (id,order_id,product_id,name_snapshot,image_snapshot,option_snapshot,qty,unit_price_iqd,line_total_iqd) VALUES
      ('oi_fdm','ORD-1','p_fdm','Bambu A1','','',1,899000,899000),
      ('oi_pla','ORD-1','p_pla','PLA White','','',1,25000,25000),
      ('oi_lacc','ORD-1','p_lacc','Laser lens','','',1,20000,20000),
      ('oi_other_fdm','ORD-2','p_fdm','Bambu A1','','',1,899000,899000);
    INSERT INTO order_item_units (id,order_id,order_item_id,product_id,owner_user_id,unit_index,delivered_at) VALUES
      ('u_fdm','ORD-1','oi_fdm','p_fdm','buyer',0,'${DELIVERED_AT}'),
      ('u_other','ORD-2','oi_other_fdm','p_fdm','other',0,'${DELIVERED_AT}');
  `);
  if (opts.registered) register(raw, 'u_fdm', 'buyer');
  if (opts.registeredTo) register(raw, 'u_fdm', opts.registeredTo);
  return { raw, db: asD1(raw) };
}

export function order(raw: DatabaseSync, id: string, user: string, status = 'delivered', deliveredAt: string | null = DELIVERED_AT) {
  raw
    .prepare(
      `INSERT INTO orders
         (id,user_id,status,address_snapshot,delivery_method_id,delivery_method_snapshot,payment_method_id,
          subtotal_iqd,shipping_iqd,points_discount_iqd,wallet_applied_iqd,wallet_applied_usd_cents,
          exchange_rate,total_iqd,due_on_delivery_iqd,delivered_at,created_at,updated_at)
       VALUES (?,?,?,'{}','standard','{}','cash',100000,0,0,0,0,1300,100000,0,?,?,?)`
    )
    .run(id, user, status, deliveredAt, '2026-08-25T10:00:00.000Z', '2026-08-25T10:00:00.000Z');
}

export function register(raw: DatabaseSync, unitId: string, userId: string) {
  raw.prepare('INSERT INTO device_registrations (unit_id, user_id) VALUES (?, ?)').run(unitId, userId);
}

export const USERS: Record<string, StubUser> = {
  buyer: { id: 'buyer', role: 'customer', email: 'buyer@x.co' },
  other: { id: 'other', role: 'customer', email: 'other@x.co' },
  stranger: { id: 'stranger', role: 'customer', email: 'stranger@x.co' },
  boss: { id: 'boss', role: 'admin', email: 'boss@x.co' },
};

/** The routes as worker/index.ts mounts them: reviews and gifts share /api/reviews. */
export function reviewApp(db: D1Database, who: keyof typeof USERS | null, bucket: ReviewBucket = new ReviewBucket()): App {
  return stubApp(
    db,
    who ? USERS[who] : null,
    (a) => {
      a.route('/api/reviews', reviewRoutes);
      a.route('/api/reviews', giftRoutes);
      a.route('/api/devices', deviceRoutes);
    },
    { env: { BUCKET: bucket, R2_PRIVATE: bucket } }
  );
}

/** POST one file through the review upload door. */
export async function upload(
  app: App,
  bytes: Uint8Array,
  opts: { name?: string; type?: string; productId?: string | null; purpose?: string } = {}
) {
  const form = new FormData();
  form.set('purpose', opts.purpose ?? 'media');
  if (opts.productId !== null) form.set('productId', opts.productId ?? 'p_fdm');
  form.set('file', new File([bytes as unknown as BlobPart], opts.name ?? 'photo.jpg', { type: opts.type ?? 'image/jpeg' }));
  const res = await app.request('/api/reviews/uploads', { method: 'POST', body: form, headers: { 'CF-Connecting-IP': '1.2.3.4' } });
  return { status: res.status, body: await json(res) };
}

/** Upload `n` distinct photos and return their keys. */
export async function uploadPhotos(app: App, n: number, from = 1, productId = 'p_fdm'): Promise<string[]> {
  const keys: string[] = [];
  for (let i = 0; i < n; i++) {
    const res = await upload(app, jpeg(from + i), { productId });
    if (res.status !== 200) throw new Error(`upload ${i} failed: ${JSON.stringify(res.body)}`);
    keys.push(res.body.key as string);
  }
  return keys;
}
