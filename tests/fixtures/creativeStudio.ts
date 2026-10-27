/**
 * THE CREATIVE STUDIO TEST HARNESS (worker/routes/adminCreativeStudio.ts).
 *
 * The real router on its real prefix, behind the same no-store layer
 * worker/index.ts mounts on /api/admin/*, over a fully migrated database, with:
 *   - an in-memory private bucket (`memoryBucket`);
 *   - a vault secret in the documented format (32 bytes, base64, "v1:");
 *   - a STUB PROVIDER: the router's injectable transport answers from a handler
 *     the test writes, records every request (URL, headers, body) and never
 *     touches the network (the runner has none: scripts/test-no-network.mjs).
 * Model ids here are obviously fake (`test-model-a`): no real model id is
 * written anywhere in the repository.
 */
import type { DatabaseSync } from 'node:sqlite';
import { OWNER, asD1, freshDb, memoryBucket, stubApp, type MemoryBucket, type StubUser } from './app';
import { publishSeededV2 } from './autoPublish';
import { noStoreUnlessSet } from '../../worker/lib/edgePolicy';
import { adminCreativeStudioRoutes, creativeTransport } from '../../worker/routes/adminCreativeStudio';

export const BASE = '/api/admin/creative-studio';
/** A vault secret in the documented shape: "v1:" + base64 of 32 bytes. */
export const ENC_KEY = `v1:${Buffer.alloc(32, 11).toString('base64')}`;
/** A provider key shaped like one, invented for the tests (and searched for in every answer). */
export const TYPED_KEY = 'test-typed-provider-key-0123456789-ABCDEFGHIJ-zz';
export const SECRET_KEY = 'test-worker-secret-key-9876543210-QWERTYUIOP-yy';
export const MODEL_A = 'test-model-a';
export const MODEL_B = 'test-model-b';

export const FULL: StubUser = { id: 'usr_full', role: 'admin', email: 'full@x.co', admin_scope: 'full' };
export const ASSISTANT: StubUser = { id: 'usr_asst', role: 'admin', email: 'asst@x.co', admin_scope: 'assistant' };

export function seedStudioUsers(raw: DatabaseSync): DatabaseSync {
  raw.exec(`
    INSERT INTO users (id,name,email,password_hash,role,admin_scope,email_verified_at) VALUES
      ('usr_owner','Owner','boss@x.co','h','admin',NULL,'2026-01-01T00:00:00.000Z'),
      ('usr_full','Full','full@x.co','h','admin','full','2026-01-01T00:00:00.000Z'),
      ('usr_asst','Asst','asst@x.co','h','admin','assistant',NULL);
  `);
  return raw;
}

export interface StudioEnv {
  bucket: MemoryBucket;
  env: Record<string, unknown>;
}

export function studioApp(raw: DatabaseSync, user: StubUser | null = OWNER, env: Record<string, unknown> = {}, opts: { host?: string; sessionAgeSeconds?: number } = {}) {
  const bucket = (env.BUCKET as MemoryBucket | undefined) ?? memoryBucket();
  return stubApp(
    asD1(raw),
    user,
    (a) => {
      a.use('/api/admin/*', noStoreUnlessSet);
      a.route(BASE, adminCreativeStudioRoutes);
    },
    { env: { BUCKET: bucket, CREATIVE_STUDIO_ENC_KEY: ENC_KEY, ...env }, host: opts.host, sessionAgeSeconds: opts.sessionAgeSeconds }
  );
}

// ---------------------------------------------------------------------------
// The stub provider
// ---------------------------------------------------------------------------

export interface ProviderCall {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: Record<string, unknown> | null;
}

export type ProviderHandler = (call: ProviderCall) => Response | Promise<Response>;

/** Install the stub; `restore()` removes it. Every request is recorded in `calls`. */
export function stubProvider(handler: ProviderHandler) {
  const calls: ProviderCall[] = [];
  const sleeps: number[] = [];
  creativeTransport.fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    const headers: Record<string, string> = {};
    new Headers(init?.headers).forEach((v, k) => (headers[k] = v));
    let body: Record<string, unknown> | null = null;
    if (typeof init?.body === 'string') body = JSON.parse(init.body) as Record<string, unknown>;
    const call = { url, method: init?.method ?? 'GET', headers, body };
    calls.push(call);
    if (init?.redirect !== 'manual') throw new Error('the adapter must send redirect: manual');
    return handler(call);
  }) as typeof fetch;
  creativeTransport.sleep = async (ms: number) => {
    sleeps.push(ms);
  };
  return {
    calls,
    sleeps,
    messages: () => calls.filter((c) => c.url.endsWith('/v1/messages')),
    restore() {
      delete creativeTransport.fetchImpl;
      delete creativeTransport.sleep;
      delete creativeTransport.timeoutMs;
    },
  };
}

export function json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });
}

/** A Messages API answer carrying `object` as its structured text. */
export function message(object: unknown, opts: { stop?: string; input?: number; output?: number; text?: string; thinking?: boolean } = {}): Response {
  const content: unknown[] = [];
  if (opts.thinking) content.push({ type: 'thinking', thinking: '', signature: 'sig' });
  content.push({ type: 'text', text: opts.text ?? JSON.stringify(object) });
  return json({
    id: 'msg_test',
    type: 'message',
    role: 'assistant',
    model: MODEL_A,
    content,
    stop_reason: opts.stop ?? 'end_turn',
    usage: { input_tokens: opts.input ?? 1200, output_tokens: opts.output ?? 300, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
  });
}

const caps = (vision = true) => ({
  structured_outputs: { supported: true },
  image_input: { supported: vision },
  effort: { supported: true, low: { supported: true }, medium: { supported: true }, high: { supported: true }, max: { supported: true } },
  thinking: { supported: true, types: { adaptive: { supported: true } } },
});

export function modelsPage(): Response {
  return json({
    data: [
      { type: 'model', id: MODEL_A, display_name: 'Test Model A', created_at: '2026-09-01T00:00:00Z', capabilities: caps(true) },
      { type: 'model', id: MODEL_B, display_name: 'Test Model B', created_at: '2026-08-01T00:00:00Z', capabilities: caps(false) },
    ],
    has_more: false,
    first_id: MODEL_A,
    last_id: MODEL_B,
  });
}

/**
 * A provider that lists the two fake models and answers every message with
 * `answer(body)` — the default answer is the connection test's `{ok: true}`.
 */
export function standardProvider(answer: (body: Record<string, unknown>) => Response = () => message({ ok: true })): ProviderHandler {
  return (call) => (call.url.includes('/v1/models') ? modelsPage() : answer(call.body ?? {}));
}

// ---------------------------------------------------------------------------
// The store
// ---------------------------------------------------------------------------

/**
 * Three visible products: a priced printer with two models (A1 with 3 in
 * stock, A1 Combo with none — stock is counted per option) and pictures bound
 * to each, an unpriced (catalog-only) product, and a pre-order-only product.
 * V2-published where they carry a price.
 */
export async function seedStore(raw: DatabaseSync): Promise<DatabaseSync> {
  raw.exec(`
    INSERT INTO brands (id,slug,name_ar,name_en,name_ckb) VALUES ('br_bambu','bambu-lab','بامبو لاب','Bambu Lab','بامبو لاب');
    INSERT INTO products (id,slug,name,name_ar,name_ku,description,description_ar,price_iqd,product_cost_iqd,status,stock,options,colors,
                          selling_type,sale_types,images,inventory_mode,ops_policy,brand_id,sku)
    VALUES ('p_print','a1-printer','Bambu Lab A1','بامبو لاب A1','بامبو لاب A1 چاپکەر','A reliable printer.','طابعة موثوقة.',
            900000,777777,'active',0,'[]','[]','direct_sale','["direct_sale"]','[]','OPTION','{}','br_bambu','A1-SKU'),
           ('p_unpriced','resin-x','Resin X','ريزن X','ڕێزنی X','','',0,111111,'active',0,'[]','[]','direct_sale','["direct_sale"]','[]','BASE','{}',NULL,NULL),
           ('p_pre','x2-pre','Printer X2','طابعة X2','چاپکەری X2','','',1500000,222222,'active',0,'[]','[]','pre_order','["pre_order"]','[]','BASE','{}',NULL,NULL);
    UPDATE products SET preorder_transports = '[{"method":"air","commission_iqd":0}]' WHERE id = 'p_pre';
    INSERT INTO product_option_groups (id,product_id,name_en,sort,active) VALUES ('g_model','p_print','Model',0,1);
    INSERT INTO product_option_values (id,product_id,group_id,name_en,name_ar,name_ckb,sort,active,stock,regular_price_iqd)
    VALUES ('ov_a1','p_print','g_model','A1','A1','A1',0,1,3,NULL),
           ('ov_combo','p_print','g_model','A1 Combo','A1 كومبو','A1 کۆمبۆ',1,1,0,1200000);
    INSERT INTO product_images (id,product_id,url,alt_en,sort_order,is_primary,option_value_id,width,height)
    VALUES ('pi_main','p_print','/files/products/p_print/main.webp','A1',0,1,NULL,1200,1000),
           ('pi_a1','p_print','/files/products/p_print/a1.webp','A1 alone',1,0,'ov_a1',1000,1000),
           ('pi_combo','p_print','/files/products/p_print/combo.webp','A1 with AMS',2,0,'ov_combo',1400,1000);
  `);
  await publishSeededV2(raw);
  return raw;
}

/** A fresh, migrated database with the studio's users (and optionally the store). */
export async function studioDb(store = false): Promise<DatabaseSync> {
  const raw = seedStudioUsers(freshDb());
  return store ? seedStore(raw) : raw;
}

/** The smallest valid design, plus whatever a test adds. */
export function design(extra: Record<string, unknown> = {}): Record<string, unknown> {
  return { schema_version: 1, format: { id: 'square', width: 1080, height: 1080 }, ...extra };
}

/** A text layer (free copy unless `source` says otherwise). */
export function textLayer(id: string, role: string, text: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id, type: 'text', name: id, role, x: 100, y: 100, width: 600, height: 120, text, source: { kind: 'free' },
    font: { family: 'plex-arabic', weight: 700, size: 60, lineHeight: 1.25 }, minSize: 40, maxLines: 2, color: '#f4f4f1', align: 'start', direction: 'rtl',
    ...extra,
  };
}

/** Every string anywhere in a JSON value (keys and values), for "this secret appears nowhere" checks. */
export function deepStrings(value: unknown): string {
  return JSON.stringify(value ?? null);
}
