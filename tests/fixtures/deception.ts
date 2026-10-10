/**
 * THE DECEPTION LAYER'S WORLD — the real Worker (worker/index.ts) on a fresh
 * database with an owner, a full admin, an assistant, two customers and their
 * sessions, so a test can play an attacker, a customer on the same network
 * and the owner side by side (DECISIONS row 206). Local only: nothing here
 * ever reaches a live service.
 */
import type { DatabaseSync } from 'node:sqlite';
import worker from '../../worker/index';
import { sha256Hex } from '../../worker/lib/crypto';
import { APEX, asD1, ctx, dbThrough, freshDb, pending } from './app';

export const ATTACKER_IP = '203.0.113.7';
export const NEIGHBOUR_IP = ATTACKER_IP;
export const OTHER_IP = '198.51.100.20';

export const USERS = {
  owner: { id: 'usr_owner', email: 'boss@x.co', role: 'admin', verified: true },
  full: { id: 'usr_full', email: 'full@x.co', role: 'admin', verified: true },
  assistant: { id: 'usr_asst', email: 'asst@x.co', role: 'admin', verified: true, scope: 'assistant' },
  customer: { id: 'usr_cust', email: 'cust@x.co', role: 'customer', verified: true },
  neighbour: { id: 'usr_nb', email: 'nb@x.co', role: 'customer', verified: true },
  probe: { id: 'usr_probe', email: 'probe@x.co', role: 'customer', verified: true },
} as const;
export type Who = keyof typeof USERS;

export const tokenOf = (who: Who) => `session-token-${who}-0000000000000000`;

/** Lets every write handed to waitUntil land. */
export const drain = async () => {
  while (pending.length) await Promise.all(pending.splice(0));
};

export interface CallOpts {
  method?: string;
  as?: Who | null;
  ip?: string;
  headers?: Record<string, string>;
  body?: unknown;
  cookies?: Record<string, string>;
  host?: string;
  /** Use the fixture's ExecutionContext (default true). */
  withCtx?: boolean;
}

export interface World {
  raw: DatabaseSync;
  env: Record<string, unknown>;
  call(path: string, opts?: CallOpts): Promise<Response>;
}

/** Cookie jar helper: the value a Set-Cookie line sets for `name`, or null ('' for a deletion). */
export function setCookieValue(res: Response, name: string): string | null {
  const lines = typeof (res.headers as Headers & { getSetCookie?: () => string[] }).getSetCookie === 'function'
    ? (res.headers as Headers & { getSetCookie: () => string[] }).getSetCookie()
    : (res.headers.get('set-cookie') ?? '').split(/,(?=\s*[A-Za-z_]+=)/);
  for (const l of lines) {
    const m = new RegExp(`(?:^|\\s)${name}=([^;]*)`).exec(l);
    if (m) return m[1]!;
  }
  return null;
}

export async function deceptionWorld(opts: { through?: string | null; env?: Record<string, unknown> } = {}): Promise<World> {
  const raw = opts.through === undefined ? freshDb() : dbThrough(opts.through);
  for (const [who, u] of Object.entries(USERS)) {
    raw
      .prepare('INSERT INTO users (id,name,email,password_hash,role,username,admin_scope,email_verified_at) VALUES (?,?,?,?,?,?,?,?)')
      .run(u.id, who, u.email, 'h', u.role, who, 'scope' in u ? u.scope : null, u.verified ? '2026-01-01T00:00:00.000Z' : null);
    raw.prepare('INSERT INTO sessions (id,user_id,expires_at) VALUES (?,?,?)').run(
      await sha256Hex(tokenOf(who as Who)),
      u.id,
      new Date(Date.now() + 86_400_000).toISOString()
    );
  }
  const env: Record<string, unknown> = {
    DB: asD1(raw),
    STORE_ROOT_DOMAIN: APEX,
    APP_ORIGIN: `https://${APEX}`,
    INITIAL_ADMIN_EMAIL: 'boss@x.co',
    EXTRA_ALLOWED_ORIGINS: '',
    SECURITY_PROBE_USER_IDS: USERS.probe.id,
    ASSETS: {
      fetch: async () => new Response('<!doctype html><html><head><title>LEVONIS</title></head><body>app</body></html>', { headers: { 'content-type': 'text/html; charset=utf-8' } }),
    },
    ...(opts.env ?? {}),
  };
  const call = async (path: string, o: CallOpts = {}) => {
    const host = o.host ?? APEX;
    const headers: Record<string, string> = { Host: host, 'CF-Connecting-IP': o.ip ?? ATTACKER_IP, ...(o.headers ?? {}) };
    const cookies: Record<string, string> = { ...(o.cookies ?? {}) };
    if (o.as) cookies.levonis_session = tokenOf(o.as);
    const jar = Object.entries(cookies).map(([k, v]) => `${k}=${v}`).join('; ');
    if (jar) headers.Cookie = jar;
    const method = o.method ?? (o.body === undefined ? 'GET' : 'POST');
    if (o.body !== undefined) headers['content-type'] = 'application/json';
    const req = new Request(`https://${host}${path}`, { method, headers, body: o.body === undefined ? undefined : JSON.stringify(o.body) });
    const res = await worker.fetch(req, env as never, (o.withCtx === false ? undefined : ctx) as never);
    await drain();
    return res;
  };
  return { raw, env, call };
}

export const blocks = (raw: DatabaseSync) =>
  (raw.prepare('SELECT * FROM security_blocks ORDER BY created_at, id').all() as Record<string, unknown>[]).map((r) => ({ ...r }));
export const deceptionEvents = (raw: DatabaseSync, code?: string) =>
  (code
    ? (raw.prepare('SELECT * FROM security_events WHERE code = ? ORDER BY first_at').all(code) as Record<string, unknown>[])
    : (raw.prepare('SELECT * FROM security_events ORDER BY first_at').all() as Record<string, unknown>[])
  ).map((r) => ({ ...r }));
export const ownerBells = (raw: DatabaseSync) =>
  (raw.prepare("SELECT * FROM user_notifications WHERE user_id = 'usr_owner' AND kind = 'security_alert' ORDER BY created_at").all() as Record<string, unknown>[]).map((r) => ({ ...r }));

/** A browser's deliberate requests: typed in the address bar, or the page's own fetch. */
export const TYPED = { 'Sec-Fetch-Site': 'none', 'Sec-Fetch-Mode': 'navigate', 'Sec-Fetch-Dest': 'document', 'Sec-Fetch-User': '?1' };
export const SCRIPT = { 'Sec-Fetch-Site': 'same-origin', 'Sec-Fetch-Mode': 'cors', 'Sec-Fetch-Dest': 'empty' };
export const CLICKED = { 'Sec-Fetch-Site': 'same-origin', 'Sec-Fetch-Mode': 'navigate', 'Sec-Fetch-Dest': 'document', 'Sec-Fetch-User': '?1' };
/** Requests a page can make a visitor's browser send without the visitor meaning to. */
export const INDUCED: ReadonlyArray<Record<string, string>> = [
  { 'Sec-Fetch-Site': 'same-origin', 'Sec-Fetch-Mode': 'no-cors', 'Sec-Fetch-Dest': 'image' },
  { 'Sec-Fetch-Site': 'cross-site', 'Sec-Fetch-Mode': 'navigate', 'Sec-Fetch-Dest': 'document', 'Sec-Fetch-User': '?1' },
  { 'Sec-Fetch-Site': 'same-origin', 'Sec-Fetch-Mode': 'navigate', 'Sec-Fetch-Dest': 'document' },
  { 'Sec-Fetch-Site': 'same-origin', 'Sec-Fetch-Mode': 'navigate', 'Sec-Fetch-Dest': 'iframe' },
];
