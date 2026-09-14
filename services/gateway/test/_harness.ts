/**
 * Test harness: the source readers that keep the gateway pinned to the CORE
 * (every mount, every upload call site, every rate-limit call site is read out
 * of `worker/` rather than restated here), and the stubs that let the real
 * Hono app run under `node --test`.
 *
 * Reading the core as TEXT is deliberate: importing `worker/index.ts` would
 * make the core a build input of a service's test, which is exactly the
 * dependency `tests/serviceBoundaries.test.ts` exists to forbid.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Env, ForwardTarget } from '../src/env';

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
export const readCore = (rel: string): string => readFileSync(join(ROOT, rel), 'utf8');

export interface Mount {
  /** the mounted prefix, e.g. `/api/admin/products` */
  prefix: string;
  /** the router identifier, e.g. `adminProductsRoutes` */
  router: string;
  /** the file it was imported from, e.g. `worker/routes/adminProducts.ts` */
  file: string;
}

/** Every `app.route('<prefix>', <router>)` in `worker/index.ts`, with the file each router came from. */
export function coreMounts(src = readCore('worker/index.ts')): Mount[] {
  const files = new Map<string, string>();
  for (const m of src.matchAll(/import\s*\{([^}]+)\}\s*from\s*'\.\/(routes\/[A-Za-z0-9_]+)'/g)) {
    for (const name of m[1].split(',').map((s) => s.trim().split(/\s+as\s+/).pop()!.trim()).filter(Boolean)) {
      files.set(name, `worker/${m[2]}.ts`);
    }
  }
  const out: Mount[] = [];
  for (const m of src.matchAll(/app\.route\(\s*'([^']+)'\s*,\s*([A-Za-z0-9_]+)\s*\)/g)) {
    out.push({ prefix: m[1], router: m[2], file: files.get(m[2]) ?? '?' });
  }
  return out;
}

/** Every `app.all('<path>', …)` — the four permanent 410s. */
export function coreAllRoutes(src = readCore('worker/index.ts')): string[] {
  return [...src.matchAll(/app\.all\(\s*'([^']+)'/g)].map((m) => m[1]);
}

export interface RateLimitCall {
  file: string;
  bucket: string;
  limit: number | null;
  windowSeconds: number | null;
  raw: string;
}

/** Every `rateLimit(c, '<bucket>', <limit>, <window>)` in `worker/routes/`. A dynamic limit is reported as null. */
export function coreRateLimitCalls(): RateLimitCall[] {
  const dir = join(ROOT, 'worker', 'routes');
  const re = /rateLimit\s*\(\s*c\s*,\s*(?:'([^']*)'|`([^`]*)`|([A-Za-z_$][\w$.]*))\s*,\s*([^,]+?)\s*,\s*([^,)]+?)\s*[,)]/g;
  const out: RateLimitCall[] = [];
  for (const f of readdirSync(dir).filter((x) => x.endsWith('.ts')).sort()) {
    const src = readFileSync(join(dir, f), 'utf8');
    for (const m of src.matchAll(re)) {
      const num = (s: string): number | null => {
        const n = Number.parseInt(s.replace(/_/g, ''), 10);
        return Number.isFinite(n) && String(n) === s.replace(/_/g, '').trim() ? n : null;
      };
      out.push({ file: `routes/${f}`, bucket: m[1] ?? m[2] ?? m[3], limit: num(m[4]), windowSeconds: num(m[5]), raw: m[0] });
    }
  }
  return out;
}

/** How many `rateLimit(` occurrences a file has, so the extractor cannot silently miss one. */
export function countRateLimitCalls(): number {
  const dir = join(ROOT, 'worker', 'routes');
  let n = 0;
  for (const f of readdirSync(dir).filter((x) => x.endsWith('.ts'))) n += (readFileSync(join(dir, f), 'utf8').match(/rateLimit\s*\(/g) ?? []).length;
  return n;
}

/**
 * Every admin path the core actually mounts: the mount prefix plus any route
 * inside the file whose path names `/admin`. This is how the capability test
 * discovers the seven admin surfaces that do NOT live under `/api/admin/*`.
 */
export function coreAdminPaths(): string[] {
  const out = new Set<string>();
  for (const m of coreMounts()) {
    if (m.prefix.includes('/admin')) out.add(m.prefix);
    if (m.file === '?') continue;
    const src = readCore(m.file);
    const re = new RegExp(`${m.router}\\.(get|post|put|patch|delete)\\(\\s*'([^']*admin[^']*)'`, 'g');
    for (const r of src.matchAll(re)) {
      const path = r[2].replace(/\/:[^/]+/g, '/x').replace(/\/$/, '');
      out.add((m.prefix + path).replace(/\/$/, ''));
    }
  }
  return [...out].sort();
}

/** Route files that read a request body as a form or a buffer — i.e. need a gateway size class. */
export function coreUploadRouteFiles(): string[] {
  const dir = join(ROOT, 'worker', 'routes');
  return readdirSync(dir)
    .filter((f) => f.endsWith('.ts'))
    .filter((f) => /c\.req\.(formData|arrayBuffer)\s*\(/.test(readFileSync(join(dir, f), 'utf8')))
    .sort();
}

// ---------------------------------------------------------------- stubs

export interface RecordedCall {
  url: string;
  method: string;
  headers: Record<string, string>;
}

export interface StubTarget extends ForwardTarget {
  calls: RecordedCall[];
}

/** A downstream Worker: records what it was handed and answers what the test asked for. */
export function stubTarget(reply?: (req: Request) => Response | Promise<Response>): StubTarget {
  const calls: RecordedCall[] = [];
  return {
    calls,
    async fetch(request: Request): Promise<Response> {
      if (new URL(request.url).pathname === '/api/products/cache-generation') return Response.json({ success: true, revision: 1 });
      calls.push({ url: request.url, method: request.method, headers: Object.fromEntries(request.headers.entries()) });
      if (reply) return reply(request);
      return new Response(JSON.stringify({ success: true, ok: true }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    },
  };
}

export function makeEnv(overrides: Partial<Env> = {}): Env {
  return {
    GATEWAY_PHASE: '1',
    GATEWAY_LOCKED: 'off',
    PRINCIPAL_MODE: 'off',
    CACHE_MODE: 'off',
    RATE_LIMIT_MODE: 'memory',
    STORE_ROOT_DOMAIN: 'levonis-iq.com',
    APP_ORIGIN: 'https://levonis-iq.com',
    ...overrides,
  } as Env;
}

/** An in-memory Cache API so cache behaviour is testable without a zone. */
export class MemoryEdgeCache {
  readonly entries = new Map<string, Response>();
  puts = 0;
  async match(key: string): Promise<Response | undefined> {
    const hit = this.entries.get(key);
    return hit ? hit.clone() : undefined;
  }
  async put(key: string, response: Response): Promise<void> {
    this.puts++;
    this.entries.set(key, response.clone());
  }
}

export const req = (url: string, init: RequestInit & { host?: string } = {}): Request => {
  const headers = new Headers(init.headers);
  if (init.host) headers.set('Host', init.host);
  else if (!headers.has('Host')) headers.set('Host', new URL(url).host);
  return new Request(url, { ...init, headers });
};
