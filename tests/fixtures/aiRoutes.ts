/**
 * THE ASSISTANT'S AI ROUTES, MOUNTED FOR A TEST (push B part 2).
 *
 * The real support router (with push B's `/assistant/readiness`, `/read` and
 * `/read-frames`), over a fully migrated database, memory R2 buckets that
 * count every put, a fake Images binding that answers a JPEG (with an EXIF
 * block, so the strip is proven), and a fake speech binding. The text and
 * vision provider is reached only through the fetch tripwire of ./app.ts:
 * `provide(handler)` answers it, and nothing reaches a network.
 *
 * Requests carry no execution context, so the ledger's bookkeeping is awaited
 * inside the request (worker/lib/ai/run.ts `later`): a test reads the ledger
 * right after the response.
 *
 * No model is named: every model id is an invented, neutral string.
 */
import type { DatabaseSync } from 'node:sqlite';
import { Hono } from 'hono';
import { asD1, freshDb, providerFetch } from './app';
import { SqliteD1 } from './d1';
import { fakeAi, KEY, seedAi, speechModel, textModel, tinyJpeg, type SeedOpts } from './aiLayer';
import type { AppContext } from '../../worker/lib/types';
import { HttpError } from '../../worker/lib/http';
import { supportRoutes } from '../../worker/routes/support';
import { forgetAiConfig } from '../../worker/lib/ai/config';

type Rec = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

export const MARKER = 'ZZMODELZZ';

export class MemoryBucket {
  objects = new Map<string, { bytes: Uint8Array; metadata: Record<string, string> }>();
  puts = 0;
  async put(key: string, value: ArrayBuffer | ArrayBufferView | string, options?: { httpMetadata?: Record<string, string> }) {
    this.puts++;
    const bytes =
      typeof value === 'string'
        ? new TextEncoder().encode(value)
        : value instanceof ArrayBuffer
          ? new Uint8Array(value.slice(0))
          : new Uint8Array(value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength));
    this.objects.set(key, { bytes, metadata: options?.httpMetadata ?? {} });
  }
  async get(key: string) {
    const stored = this.objects.get(key);
    if (!stored) return null;
    return {
      body: new Blob([stored.bytes as unknown as BlobPart]).stream(),
      size: stored.bytes.byteLength,
      httpEtag: `"${key}"`,
      httpMetadata: stored.metadata,
      writeHttpMetadata(headers: Headers) {
        if (stored.metadata.contentType) headers.set('Content-Type', stored.metadata.contentType);
      },
      arrayBuffer: () => new Blob([stored.bytes as unknown as BlobPart]).arrayBuffer(),
    };
  }
  async head(key: string) {
    const stored = this.objects.get(key);
    return stored ? { key, size: stored.bytes.byteLength } : null;
  }
  async delete(key: string) {
    this.objects.delete(key);
  }
}

/** A fake Images binding: every transform answers `out` (a JPEG with an EXIF block by default) and records its options. */
export function fakeImages(out: Uint8Array = tinyJpeg(1200, 900, { app1: true, com: true })) {
  const calls: Array<{ transform?: Rec; output?: Rec }> = [];
  return {
    calls,
    async info() {
      return { format: 'image/webp', fileSize: 30, width: 640, height: 480 };
    },
    input() {
      const call: { transform?: Rec; output?: Rec } = {};
      calls.push(call);
      const chain = {
        transform(opts: Rec) {
          call.transform = opts;
          return chain;
        },
        async output(opts: Rec) {
          call.output = opts;
          return { response: () => new Response(out as unknown as BodyInit) };
        },
      };
      return chain;
    },
  };
}

export const USERS: Record<string, { id: string; role: 'customer' | 'admin'; email: string }> = {
  owner: { id: 'u_owner', role: 'customer', email: 'owner@x.test' },
  stranger: { id: 'u_stranger', role: 'customer', email: 'stranger@x.test' },
  admin: { id: 'u_admin', role: 'admin', email: 'admin@x.test' },
};

/** Every task configured, cheap rates, a $1 cap: everything a read needs, so only what a test removes is missing. */
export const FULL: SeedOpts = {
  enabled: true,
  capMicro: 1_000_000,
  guests: true,
  guestSharePct: 100,
  models: [textModel('understand', 0), textModel('vision', 0), speechModel(0)],
};

export interface HarnessOpts extends SeedOpts {
  /** Leave out the provider key. */
  noKey?: boolean;
  /** Leave out the speech binding. */
  noAi?: boolean;
  /** Leave out the Images binding. */
  noImages?: boolean;
  /** The speech binding's behaviour. */
  speech?: Parameters<typeof fakeAi>[0];
  /** The Images binding's output. */
  rendition?: Uint8Array;
  /** Record every SQL statement the routes send (tests/aiNoActions.test.ts). */
  spy?: boolean;
  /** Skip seeding: the 0210 tables as migrations leave them. */
  unseeded?: boolean;
  /** Run against this raw database instead of a fresh one. */
  raw?: DatabaseSync;
}

export interface Harness {
  raw: DatabaseSync;
  db: D1Database;
  privateBucket: MemoryBucket;
  publicBucket: MemoryBucket;
  images: ReturnType<typeof fakeImages>;
  ai: ReturnType<typeof fakeAi>;
  statements: string[];
  as(who: string, path: string, init?: RequestInit): Promise<Response>;
  postJson(who: string, path: string, body: unknown): Promise<Response>;
  assistant(who: string, body: Rec): Promise<Rec>;
  read(who: string, body: Rec): Promise<Response>;
  readFrames(who: string, fields: Record<string, string | Uint8Array>): Promise<Response>;
  readiness(who: string): Promise<Response>;
  seedFile(who: string, folder: 'attachments' | 'video' | 'audio', bytes: Uint8Array, mime: string): string;
}

let fileSeq = 0;

export function aiHarness(opts: HarnessOpts = {}): Harness {
  const raw = opts.raw ?? freshDb();
  for (const u of Object.values(USERS)) {
    raw.prepare("INSERT OR IGNORE INTO users (id,name,email,password_hash,role) VALUES (?,?,?,'h',?)").run(u.id, u.id, u.email, u.role);
  }
  if (!opts.unseeded) {
    // A second harness over the same database re-seeds the settings and the model rows.
    raw.exec('DELETE FROM ai_task_models');
    seedAi(raw, opts);
  }
  forgetAiConfig();
  const statements: string[] = [];
  const base = asD1(raw);
  const db = opts.spy ? spyD1(raw, statements) : base;
  const privateBucket = new MemoryBucket();
  const publicBucket = new MemoryBucket();
  const images = fakeImages(opts.rendition);
  const ai = fakeAi(opts.speech ?? {});
  const env: Rec = {
    DB: db,
    BUCKET: privateBucket,
    R2_PUBLIC: publicBucket,
    R2_PRIVATE: privateBucket,
    ...(opts.noKey ? {} : { ANTHROPIC_API_KEY: KEY }),
    ...(opts.noAi ? {} : { AI: ai }),
    ...(opts.noImages ? {} : { IMAGES: images }),
  };
  const hono = new Hono<AppContext>();
  hono.use('*', async (c, next) => {
    c.env = env as never;
    const who = c.req.header('x-test-user') ?? '';
    c.set('user', (USERS[who] ?? null) as never);
    c.set('host', { kind: 'apex' } as never);
    await next();
  });
  hono.route('/api/support', supportRoutes);
  hono.onError((e, c) =>
    e instanceof HttpError
      ? c.json({ success: false, code: e.code, error: e.message }, e.status as 400)
      : c.json({ success: false, error: String(e) }, 500)
  );
  const as = async (who: string, path: string, init: RequestInit = {}): Promise<Response> =>
    hono.request(path, { ...init, headers: { 'x-test-user': who, 'CF-Connecting-IP': '1.2.3.4', ...((init.headers as Record<string, string>) ?? {}) } });
  const postJson = (who: string, path: string, body: unknown) =>
    as(who, path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  return {
    raw,
    db,
    privateBucket,
    publicBucket,
    images,
    ai,
    statements,
    as,
    postJson,
    async assistant(who, body) {
      const res = await postJson(who, '/api/support/assistant', { locale: 'ar', ...body });
      if (res.status !== 200) throw new Error(`assistant answered ${res.status}: ${await res.text()}`);
      return (await res.json()) as Rec;
    },
    read: (who, body) => postJson(who, '/api/support/assistant/read', { locale: 'ar', consent: true, ...body }),
    readFrames(who, fields) {
      const form = new FormData();
      for (const [k, v] of Object.entries(fields)) {
        if (typeof v === 'string') form.set(k, v);
        else form.set(k, new File([v as unknown as BlobPart], `${k}.jpg`, { type: 'image/jpeg' }));
      }
      return as(who, '/api/support/assistant/read-frames', { method: 'POST', body: form });
    },
    readiness: (who) => as(who, '/api/support/assistant/readiness'),
    seedFile(who, folder, bytes, mime) {
      const user = USERS[who]!;
      const ext = folder === 'attachments' ? 'webp' : folder === 'video' ? 'mp4' : 'webm';
      const key = `assist/${user.id}/${folder}/${(++fileSeq).toString(16).padStart(8, '0')}.${ext}`;
      privateBucket.objects.set(key, { bytes, metadata: { contentType: mime } });
      raw
        .prepare(
          `INSERT INTO file_objects (object_key, visibility, domain, owner_id, entity_id, mime_type, byte_size) VALUES (?, 'private', 'assist', ?, ?, ?, ?)`
        )
        .run(key, user.id, user.id, mime, bytes.byteLength);
      return key;
    },
  };
}

/** A D1 over `raw` that records the SQL of every statement it prepares (bound or batched). */
export function spyD1(raw: DatabaseSync, into: string[]): D1Database {
  const inner = new SqliteD1(raw);
  const wrap = (sql: string) => {
    into.push(sql.replace(/\s+/g, ' ').trim());
    return inner.prepare(sql);
  };
  return new Proxy(inner, {
    get(target, prop, receiver) {
      if (prop === 'prepare') return wrap;
      const v = Reflect.get(target, prop, receiver);
      return typeof v === 'function' ? v.bind(target) : v;
    },
  }) as unknown as D1Database;
}

/** Answer the text and vision provider with `handler` (and count its calls) until `reset`. */
export function provide(handler: (url: string, init?: RequestInit) => Response | Promise<Response>): void {
  providerFetch.attempts.length = 0;
  providerFetch.handler = async (url, init) => handler(url, init);
}

export function resetProvider(): void {
  providerFetch.handler = null;
  providerFetch.attempts.length = 0;
}

/** The provider calls made so far, to the messages endpoint only. */
export const providerCalls = () => providerFetch.attempts.filter((a) => a.url.endsWith('/v1/messages')).length;

/** The JSON body a provider call sent, by index (from the handler's own record). */
export async function bodyOf(init?: RequestInit): Promise<Rec> {
  return JSON.parse(String(init?.body ?? '{}')) as Rec;
}

/** A valid photo reading with these fields overridden. */
export const photoReading = (o: Rec = {}): Rec => ({
  subject: 'printer_screen',
  printer: 'none',
  symptom: 'none',
  part: 'none',
  hms_codes: [],
  label_codes: [],
  confidence: 'high',
  ...o,
});

/** A valid understanding reading with these fields overridden. */
export const textReading = (o: Rec = {}): Rec => ({
  action: 'none',
  intent: 'none',
  printer: 'none',
  part: 'none',
  symptom: 'none',
  outcome: 'none',
  maintenance: false,
  terms: [],
  ...o,
});

export { tinyJpeg };

/**
 * A SMALL SHOP: five printers, two hotends linked to their printers, a
 * cleaning needle, a PEI plate and PLA, V2-published (the listing shows only
 * those) and indexed for the search box, so push A's rules, the legacy scorer
 * and the strong lookup each have something real to answer with.
 */
export async function seedShop(raw: DatabaseSync): Promise<void> {
  const { backfillSearchIndex } = await import('../../worker/lib/search/store');
  const { publishSeededV2 } = await import('./autoPublish');
  const add = (id: string, slug: string, name: string, nameAr: string, price: number, category: string) =>
    raw
      .prepare(
        `INSERT INTO products (id,slug,name,name_ar,name_ku,price_iqd,status,stock,options,colors,selling_type,sale_types,
           preorder_transports,images,inventory_mode,ops_policy,category_id)
         VALUES (?,?,?,?,'',?,'active',5,'[]','[]','direct_sale','["direct_sale"]','[]','[]','BASE','{}',?)`
      )
      .run(id, slug, name, nameAr, price, category);
  const printers = [
    ['p_a1', 'bambu-lab-a1', 'Bambu Lab A1', 'طابعة بامبو لاب A1'],
    ['p_a1m', 'bambu-lab-a1-mini', 'Bambu Lab A1 mini', 'طابعة بامبو لاب A1 ميني'],
    ['p_x1c', 'bambu-lab-x1-carbon', 'Bambu Lab X1 Carbon', 'طابعة بامبو لاب X1 كاربون'],
    ['p_p1s', 'bambu-lab-p1s', 'Bambu Lab P1S', 'طابعة بامبو لاب P1S'],
  ] as const;
  printers.forEach(([id, slug, name, nameAr], position) => {
    add(id, slug, name, nameAr, 1_000_000, 'cat_printers_fdm');
    raw.prepare('INSERT OR IGNORE INTO product_catalogs (product_id, catalog_id, position) VALUES (?, ?, ?)').run(id, 'cat_printers_fdm', 100 + position);
  });
  add('h_a1', 'bambu-hotend-a1-a2', 'Bambu Hotend - A1/A2', 'هوت إند بامبو - A1/A2', 45_000, 'cat_maint_hotend');
  add('h_x1', 'bambu-hotend-x1-p1', 'Bambu Hotend - X1/P1', 'هوت إند بامبو - X1/P1', 60_000, 'cat_maint_hotend');
  add('n_needle', 'nozzle-cleaning-needle', 'Nozzle Cleaning Needle', 'إبرة تنظيف النوزل', 5_000, 'cat_maint_spare');
  add('pl_pei', 'textured-pei-plate', 'Textured PEI Plate', 'بليت PEI محبب', 30_000, 'cat_maint_plate');
  add('f_pla', 'pla-basic', 'PLA Basic', 'فلامنت PLA', 20_000, 'cat_materials');
  const fit = (part: string, printer: string) => raw.prepare('INSERT INTO product_printer_fits (product_id, printer_id, position) VALUES (?, ?, 0)').run(part, printer);
  for (const p of ['p_a1', 'p_a1m']) fit('h_a1', p);
  for (const p of ['p_x1c', 'p_p1s']) fit('h_x1', p);
  fit('n_needle', 'p_a1');
  fit('pl_pei', 'p_a1');
  // A code printed on the hotend's label: the identifier lane's exact match.
  raw.prepare("UPDATE products SET sku = 'BLHE-A1-0004' WHERE id = 'h_a1'").run();
  await publishSeededV2(raw);
  await backfillSearchIndex(asD1(raw), { limit: 50 });
}
