/**
 * Shared harness for route-level regression tests: a fresh SQLite database
 * with every migration applied, the real route modules mounted the way
 * worker/index.ts mounts them (host classification, the apex-only guard on
 * /api/admin/*, the same onError translation), and only the session lookup
 * stubbed. Nothing here is a mock of the code under test.
 */
import { DatabaseSync } from 'node:sqlite';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Hono } from 'hono';
import { ROOT, SqliteD1, SqliteStatement } from './d1';
import type { AppContext } from '../../worker/lib/types';
import { HttpError, requireMainHost } from '../../worker/lib/http';
import { classifyHost } from '../../worker/lib/hosts';

export const APEX = 'levonis-iq.com';
export const MERCHANT_HOST = 'somestore.levonis-iq.com';

export function freshDb(): DatabaseSync {
  return dbThrough(null);
}

/**
 * THE DATABASE A DEPLOY LANDS ON WHEN ITS MIGRATIONS HAVE NOT RUN.
 *
 * `through` is the highest migration NUMBER to apply, as the four digits that
 * start a filename — `dbThrough('0083')` is the live database on the night the
 * storefront's first screen went dark, because a Worker carrying migration
 * 0085's `products.condition_doc` had been deployed over it.
 *
 * Numbers, not filenames, on purpose: a test that says "one migration behind"
 * must keep meaning that when the file after it is renamed, and a test pinned
 * to `0085_product_condition.sql` would silently start proving nothing the day
 * somebody renumbered it.
 *
 * `null` means every migration, which is what `freshDb()` is.
 */
export function dbThrough(through: string | null): DatabaseSync {
  const raw = new DatabaseSync(':memory:');
  raw.exec('PRAGMA foreign_keys = ON;');
  const dir = join(ROOT, 'migrations');
  for (const f of readdirSync(dir).filter((x) => x.endsWith('.sql')).sort()) {
    if (through !== null && f.slice(0, 4) > through) break;
    raw.exec(readFileSync(join(dir, f), 'utf8'));
  }
  return raw;
}

/** Does this table carry this column? The question a deploy-ahead test asks. */
export const hasColumn = (raw: DatabaseSync, table: string, column: string): boolean =>
  (raw.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).some((r) => r.name === column);

export const asD1 = (raw: DatabaseSync) => new SqliteD1(raw) as unknown as D1Database;

// node:sqlite hands back null-prototype objects; spreading them gives plain
// objects so `assert.deepEqual` against a literal compares values only.
export const row = <T = Record<string, unknown>>(raw: DatabaseSync, sql: string, ...params: unknown[]) => {
  const r = raw.prepare(sql).get(...(params as never[]));
  return (r === undefined ? undefined : { ...(r as object) }) as T | undefined;
};
export const all = <T = Record<string, unknown>>(raw: DatabaseSync, sql: string, ...params: unknown[]) =>
  (raw.prepare(sql).all(...(params as never[])) as object[]).map((r) => ({ ...r })) as T[];
export const count = (raw: DatabaseSync, sql: string, ...params: unknown[]) =>
  (raw.prepare(sql).get(...(params as never[])) as { n: number }).n;

/** The spendable USD balance exactly as walletOps computes it: settled minus effective active holds. */
export const spendable = (raw: DatabaseSync, user: string) =>
  (raw.prepare(
    `SELECT (SELECT COALESCE(SUM(CASE WHEN t.type='deposit' THEN t.amount ELSE -t.amount END),0)
               FROM wallet_transactions t WHERE t.user_id = ?1 AND t.currency='USD' AND t.status='approved')
          - (SELECT COALESCE(SUM(h.amount_cents),0) FROM wallet_holds h
               LEFT JOIN wallet_transactions ht ON ht.id = h.tx_id
              WHERE h.user_id = ?1 AND h.state='active' AND (h.tx_id IS NULL OR ht.status <> 'approved')) AS v`
  ).get(user) as { v: number }).v;

export const settledPoints = (raw: DatabaseSync, user: string) =>
  (raw.prepare(
    `SELECT COALESCE(SUM(CASE WHEN type='deposit' THEN amount ELSE -amount END),0) AS v
       FROM wallet_transactions WHERE user_id = ? AND currency='POINT' AND status='approved'`
  ).get(user) as { v: number }).v;

export interface LedgerRow {
  id: string; type: string; currency: string; amount: number; status: string; ref: string; note: string; created_by: string;
}
export const ledger = (raw: DatabaseSync, user: string) =>
  all<LedgerRow>(
    raw,
    'SELECT id, type, currency, amount, status, ref, note, created_by FROM wallet_transactions WHERE user_id = ? ORDER BY rowid',
    user
  );

export interface HoldRow {
  id: string; kind: string; amount_cents: number; state: string; tx_id: string | null; event_key: string; ref_type: string;
}
export const holds = (raw: DatabaseSync, user: string) =>
  all<HoldRow>(
    raw,
    'SELECT id, kind, amount_cents, state, tx_id, event_key, ref_type FROM wallet_holds WHERE user_id = ? ORDER BY rowid',
    user
  );

/**
 * A D1 adapter whose batch() can be made to fail on a chosen statement (a
 * simulated transient D1 failure), or to run a hook BEFORE a batch executes
 * (a simulated concurrent writer). Everything else is the real adapter.
 */
export class FailingStatement {
  constructor(public readonly inner: SqliteStatement, public readonly sql: string, public readonly params: unknown[] = []) {}
  bind(...values: unknown[]) { return new FailingStatement(this.inner.bind(...values), this.sql, values); }
  run() { return this.inner.run(); }
  first<T = Record<string, unknown>>() { return this.inner.first<T>(); }
  all<T = Record<string, unknown>>() { return this.inner.all<T>(); }
}
export class FailingD1 {
  public failWhen: ((s: FailingStatement[]) => boolean) | null = null;
  public beforeBatch: ((s: FailingStatement[]) => void) | null = null;
  public batches: string[][] = [];
  constructor(private readonly inner: SqliteD1) {}
  prepare(sql: string) { return new FailingStatement(this.inner.prepare(sql), sql); }
  async batch(statements: FailingStatement[]) {
    this.batches.push(statements.map((s) => s.sql.replace(/\s+/g, ' ').trim().slice(0, 90)));
    this.beforeBatch?.(statements);
    if (this.failWhen?.(statements)) throw new Error('simulated D1 failure (injected by the test)');
    return this.inner.batch(statements.map((s) => s.inner));
  }
}
export const failingD1 = (raw: DatabaseSync) => {
  const f = new FailingD1(new SqliteD1(raw));
  return { failing: f, db: f as unknown as D1Database };
};

export interface StubUser {
  id: string;
  role: 'customer' | 'merchant' | 'admin';
  email: string;
  username?: string;
  admin_scope?: string | null;
  is_investor?: number;
}

export type Mount = (app: Hono<AppContext>) => void;

/**
 * Mirrors worker/index.ts for what a route test needs: host classification,
 * the apex-only guard on /api/admin/*, a stubbed session user and the same
 * onError translation (HttpError → JSON; anything else → a generic 500).
 */
export function stubApp(
  db: unknown,
  user: StubUser | null,
  mount: Mount,
  opts: { host?: string; env?: Record<string, unknown> } = {}
) {
  const a = new Hono<AppContext>();
  a.use('*', async (c, next) => {
    c.set('host', classifyHost(opts.host ?? APEX, APEX));
    c.set('user', user ? ({ admin_scope: null, username: user.id, is_investor: 0, ...user } as never) : (null as never));
    c.env = { DB: db, INITIAL_ADMIN_EMAIL: 'boss@x.co', EXTRA_ALLOWED_ORIGINS: '', ...(opts.env ?? {}) } as never;
    await next();
  });
  a.use('/api/admin/*', requireMainHost);
  mount(a);
  a.onError((err, c) => {
    if (err instanceof HttpError) {
      return c.json({ success: false, error: err.message, code: err.code, ...(err.details ? { details: err.details } : {}) }, err.status as 400);
    }
    return c.json({ success: false, error: 'Something went wrong. Please try again.', _debug: String(err) }, 500);
  });
  return a;
}
export type App = ReturnType<typeof stubApp>;

/** Stub of the Workers ExecutionContext: collects waitUntil promises so a test can let them settle. */
export const pending: Promise<unknown>[] = [];
export const ctx = {
  waitUntil: (p: Promise<unknown>) => { pending.push(p.catch(() => undefined)); },
  passThroughOnException() {},
} as unknown as ExecutionContext;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const json = async (res: Response) => (await res.json()) as Record<string, any>;
export const send = (a: App, method: string, path: string, body: unknown = {}, headers: Record<string, string> = {}) =>
  a.request(path, {
    method,
    headers: { 'content-type': 'application/json', 'CF-Connecting-IP': '1.2.3.4', ...headers },
    body: JSON.stringify(body),
  }, undefined, ctx);
export const post = (a: App, path: string, body: unknown = {}, headers: Record<string, string> = {}) =>
  send(a, 'POST', path, body, headers);
export const patch = (a: App, path: string, body: unknown = {}, headers: Record<string, string> = {}) =>
  send(a, 'PATCH', path, body, headers);
export const put = (a: App, path: string, body: unknown = {}, headers: Record<string, string> = {}) =>
  send(a, 'PUT', path, body, headers);
export const get = (a: App, path: string, headers: Record<string, string> = {}) =>
  a.request(path, { headers: { 'CF-Connecting-IP': '1.2.3.4', ...headers } }, undefined, ctx);
