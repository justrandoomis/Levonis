/**
 * The HTTP glue every Print Cloud router shares: which hosts may serve it,
 * the installed/enabled gates, the actor of a request, and the answer shape
 * `{ success: true, data }` (refusals keep the house shape
 * `{ success: false, error, code, details }` from worker/index.ts onError).
 */
import type { Context, Next } from 'hono';
import { canMoveMoney } from '../adminScope';
import { requestHost } from '../http';
import type { HostInfo } from '../hosts';
import type { AppContext, SessionUser } from '../types';
import { isAbsentSchemaError, printCloudInstalled } from './db';
import { pcError } from './errors';
import type { Actor } from './jobs';
import { loadConfig, type LoadedConfig } from './settings';

/**
 * Print Cloud answers on the platform's own host, on `cloud.<root>` (a
 * reserved system name a merchant can never claim), and on operator hosts
 * outside the root domain (workers.dev, localhost). NEVER on a merchant
 * storefront: the session cookie is shared with every subdomain, and a
 * merchant's page must not be able to spend a visitor's printing hours.
 */
export function printCloudHostAllowed(host: HostInfo): boolean {
  if (host.kind === 'main') return true;
  if (host.kind === 'system') return host.system === 'cloud';
  if (host.kind === 'merchant') return false;
  return !host.underRoot;
}

/**
 * Host and schema gate for every Print Cloud router. 404 on a wrong host, like
 * the admin guard.
 *
 * On a database without 0215 a READ answers as the service does with no data
 * (db.ts `one`/`many`: lists are empty, a named record is 404), and a WRITE is
 * refused 503 PRINT_CLOUD_NOT_INSTALLED before any statement. A read that
 * reached a missing table another way is refused the same 503 — never a raw
 * SQL error, never a false answer.
 */
export async function pcGate(c: Context<AppContext>, next: Next) {
  if (!printCloudHostAllowed(requestHost(c))) return c.json({ success: false, error: 'Not found' }, 404);
  if (await printCloudInstalled(c.env.DB)) return next();
  if (c.req.method !== 'GET' && c.req.method !== 'HEAD') throw pcError('PRINT_CLOUD_NOT_INSTALLED');
  await next();
  if (c.error && isAbsentSchemaError(c.env.DB, c.error)) throw pcError('PRINT_CLOUD_NOT_INSTALLED');
}

const configs = new WeakMap<Request, LoadedConfig>();

export async function requestConfig(c: Context<AppContext>): Promise<LoadedConfig> {
  const hit = configs.get(c.req.raw);
  if (hit) return hit;
  const loaded = await loadConfig(c.env.DB);
  configs.set(c.req.raw, loaded);
  return loaded;
}

/** Customer doors stay shut until the owner opens the service; a platform admin may test it before. */
export async function enabledGate(c: Context<AppContext>, next: Next) {
  const { config } = await requestConfig(c);
  if (!config.enabled && c.get('user')?.role !== 'admin') throw pcError('PRINT_CLOUD_DISABLED');
  await next();
}

export const ok = (c: Context<AppContext>, data: unknown, status: 200 | 201 | 202 = 200) => c.json({ success: true, data }, status);

export function currentUser(c: Context<AppContext>): SessionUser {
  const user = c.get('user');
  if (!user) throw pcError('FORBIDDEN', {}, 401);
  return user;
}

export const customerActor = (c: Context<AppContext>): Actor => ({ type: 'customer', id: currentUser(c).id });

/** A full (money) admin acts as 'admin'; an assistant admin is the workshop's operator. */
export function staffActor(c: Context<AppContext>): Actor {
  const user = currentUser(c);
  return { type: canMoveMoney(c.env, user) ? 'admin' : 'operator', id: user.id };
}

export function idempotencyKey(c: Context<AppContext>): string {
  const key = c.req.header('Idempotency-Key') ?? '';
  if (!key) throw pcError('IDEMPOTENCY_KEY_REQUIRED');
  return key;
}

/** Work that should start right after the answer (the durable row guarantees it happens anyway). */
export function afterResponse(c: Context<AppContext>, work: Promise<unknown>): void {
  const guarded = work.catch(() => undefined);
  try {
    c.executionCtx.waitUntil(guarded);
  } catch {
    // No execution context (a unit test without one): the cron runner picks the row up.
  }
}

export function queryInt(c: Context<AppContext>, name: string, def: number, min: number, max: number): number {
  const raw = c.req.query(name);
  if (raw === undefined || raw === '') return def;
  const n = Number(raw);
  if (!Number.isSafeInteger(n) || n < min || n > max) throw pcError('VALIDATION', { field: name, reason: 'out_of_range' });
  return n;
}
