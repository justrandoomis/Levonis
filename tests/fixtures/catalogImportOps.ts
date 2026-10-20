/**
 * THE OPS DOOR'S WORLD (Bambu import spec §A.3; tests/catalogImport{Auth,E2E}.test.ts):
 * the REAL Worker (worker/index.ts) on a fresh, fully migrated database behind
 * `LimitD1` (D1's 100-parameter and 5-term limits), the R2 and IMAGES doubles,
 * a run row holding the SHA-256 of a token (what cf.mjs `open` writes), the
 * reviewed bundle injected through the bundle module's test seam, and a fetcher
 * double for store.bblcdn.com that counts every request and refuses every other
 * host. Nothing here reaches a network.
 */
import { createHash } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import worker from '../../worker/index';
import { APEX, ctx, freshDb, pending } from './app';
import { limitD1 } from './d1Limits';
import { R2Double, imagesDouble, pngBytes } from './imageDoubles';
import { useReviewedTextsForTests } from '../../worker/lib/catalogImport/bundle';
import type { ReviewedTexts } from '../../worker/lib/catalogImport/reviewed';

export const OPS = '/api/ops/catalog-import';
export const OPS_RUN = 'cir_00aa11bb22cc33dd44ee55ff';
export const TOKEN = 'c0ffee'.repeat(10) + '1234';
export const tokenHash = (t: string) => createHash('sha256').update(t).digest('hex');
export const OWNER_SESSION = 'session-token-owner-ops-000000000000';
export const CUSTOMER_SESSION = 'session-token-customer-ops-0000000000';

export interface OpsWorld {
  raw: DatabaseSync;
  env: Record<string, unknown>;
  bucket: R2Double;
  /** Every request the fetcher double saw: store.bblcdn.com served, anything else refused and counted. */
  cdn: { served: string[]; refused: string[] };
  call(path: string, opts?: OpsCallOpts): Promise<Response>;
  /** A FetchLike for the runner's client: the request goes through the real Worker. */
  fetch: (url: string, init?: RequestInit) => Promise<Response>;
}

export interface OpsCallOpts {
  method?: string;
  body?: unknown;
  token?: string | null;
  protocol?: string | null;
  headers?: Record<string, string>;
  cookie?: string;
  ip?: string;
  host?: string;
}

/** Bytes per URL, distinct for every path (a CDN never serves one picture under two names by accident). */
function imageFor(url: string): Uint8Array {
  const h = createHash('sha256').update(url).digest();
  return pngBytes(200 + (h[0] % 200), 150 + (h[1] % 150));
}

let realFetch: typeof fetch | null = null;

/** The Worker itself, with no fixture publishing in front of it (an imported product must stay unpriced). */
const workerFetch = (req: Request, env: Record<string, unknown>): Promise<Response> =>
  (worker as unknown as { fetch: (r: Request, e: unknown, c: unknown) => Promise<Response> }).fetch(req, env, ctx);

/** Replaces the global fetch with the CDN double until `restoreFetch`. */
export function installCdnDouble(world: Pick<OpsWorld, 'cdn'>, opts: { sameBytes?: boolean; bytesOf?: (url: string) => string } = {}): void {
  realFetch ??= globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    const host = new URL(url).hostname;
    if (host !== 'store.bblcdn.com' && host !== 'store.bblcdn.eu') {
      world.cdn.refused.push(host);
      throw new Error('the fetcher double refuses every host but the two CDN hosts of the allow-list');
    }
    world.cdn.served.push(url);
    // `bytesOf`: serve another URL's picture under this one (a re-upload of the same file under a new name).
    const bytes = opts.sameBytes ? pngBytes(320, 240) : imageFor(opts.bytesOf?.(url) ?? url);
    return new Response(bytes as unknown as BodyInit, { status: 200, headers: { 'content-type': 'image/png' } });
  }) as typeof fetch;
}

export function restoreFetch(): void {
  if (realFetch) globalThis.fetch = realFetch;
  realFetch = null;
}

export function setBundle(texts: ReviewedTexts | null): void {
  useReviewedTextsForTests(texts);
}

/** A run row as cf.mjs `open` creates it, with the hash of `token`. */
export function openRun(raw: DatabaseSync, opts: { id?: string; token?: string; state?: string; expiresInMs?: number } = {}): string {
  const id = opts.id ?? OPS_RUN;
  raw
    .prepare("INSERT INTO catalog_import_runs (id, source, state, token_sha256, token_expires_at, github_run_id, manifest_total) VALUES (?, 'bambu_us', ?, ?, ?, 'e2e', 0)")
    .run(id, opts.state ?? 'open', tokenHash(opts.token ?? TOKEN), new Date(Date.now() + (opts.expiresInMs ?? 6 * 3600_000)).toISOString());
  return id;
}

export const drainPending = async () => {
  while (pending.length) await Promise.all(pending.splice(0));
};

export function opsWorld(opts: { raw?: DatabaseSync; env?: Record<string, unknown> } = {}): OpsWorld {
  const raw = opts.raw ?? freshDb();
  for (const [id, email, role, session] of [
    ['usr_owner', 'boss@x.co', 'admin', OWNER_SESSION],
    ['usr_cust', 'cust@x.co', 'customer', CUSTOMER_SESSION],
  ] as const) {
    raw.prepare('INSERT OR IGNORE INTO users (id,name,email,password_hash,role,username,email_verified_at) VALUES (?,?,?,?,?,?,?)').run(id, id, email, 'h', role, id, '2026-01-01T00:00:00.000Z');
    raw.prepare('INSERT OR IGNORE INTO sessions (id,user_id,expires_at) VALUES (?,?,?)').run(tokenHash(session), id, new Date(Date.now() + 86_400_000).toISOString());
  }
  const bucket = new R2Double();
  const images = imagesDouble();
  const env: Record<string, unknown> = {
    DB: limitD1(raw),
    STORE_ROOT_DOMAIN: APEX,
    APP_ORIGIN: `https://${APEX}`,
    INITIAL_ADMIN_EMAIL: 'boss@x.co',
    EXTRA_ALLOWED_ORIGINS: '',
    BUCKET: bucket,
    R2_PUBLIC: bucket,
    R2_PRIVATE: new R2Double(),
    IMAGES: images.binding,
    ASSETS: { fetch: async () => new Response('<!doctype html><title>LEVONIS</title>', { headers: { 'content-type': 'text/html' } }) },
    ...(opts.env ?? {}),
  };
  const world: OpsWorld = {
    raw,
    env,
    bucket,
    cdn: { served: [], refused: [] },
    async call(path, o = {}) {
      const host = o.host ?? APEX;
      const headers: Record<string, string> = { Host: host, 'CF-Connecting-IP': o.ip ?? '192.0.2.60', ...(o.headers ?? {}) };
      const token = o.token === undefined ? TOKEN : o.token;
      if (token !== null) headers.Authorization = `Bearer ${token}`;
      const protocol = o.protocol === undefined ? '2' : o.protocol;
      if (protocol !== null) headers['X-Levonis-Import-Protocol'] = protocol;
      if (o.cookie) headers.Cookie = o.cookie;
      const method = o.method ?? (o.body === undefined ? 'GET' : 'POST');
      if (o.body !== undefined) headers['content-type'] = 'application/json';
      const req = new Request(`https://${host}${path}`, { method, headers, body: o.body === undefined ? undefined : JSON.stringify(o.body) });
      const res = await workerFetch(req, env);
      await drainPending();
      return res;
    },
    async fetch(url, init) {
      const res = await workerFetch(new Request(url, init), env);
      await drainPending();
      return res;
    },
  };
  return world;
}
