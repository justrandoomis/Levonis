/**
 * Platform administration is apex-only WHEREVER it is mounted.
 *
 * The guard used to be a prefix middleware on `/api/admin/*` alone, while
 * seven admin surfaces under other prefixes (`/api/kyc/admin`,
 * `/api/telegram/admin`, `/api/support/admin`, `/api/policies/admin`,
 * `/api/wallet/admin`, `/api/referrals/admin`, `/api/reviews/admin`) — plus
 * the inline-guarded routes in returns, invoices and misc — relied on
 * `requireAdmin`, which checked the role and never the host. The session
 * cookie is scoped to the parent domain, so a page on a merchant storefront
 * carries a visiting admin's own session and is same-origin with its API:
 * every one of those surfaces answered on `somestore.levonis-iq.com`.
 *
 * The rule now lives in `requireAdmin` itself (lib/http.ts). This test does
 * not trust a list: it DISCOVERS every admin route by reading worker/index.ts
 * and worker/routes/*.ts — anything mounted under `/api/admin`, anything
 * behind `requireAdmin` (router-wide, sub-path or inline) and any path with an
 * `/admin` segment — and drives the REAL Worker entry point with a real
 * session row and cookie, once on a merchant host (every route must not
 * exist: 404 "Not found", no code) and once on the apex (the control: the
 * same session reaches every route).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ROOT } from './fixtures/d1';
import { freshDb, asD1, ctx, APEX, MERCHANT_HOST } from './fixtures/app';
import worker from '../worker/index';
import { sha256Hex } from '../worker/lib/crypto';

interface AdminPath { method: string; path: string; source: string }

/** Every admin route the Worker serves, reconstructed from the source. */
function discoverAdminPaths(): AdminPath[] {
  const index = readFileSync(join(ROOT, 'worker/index.ts'), 'utf8');
  const mounts = new Map<string, string[]>();
  for (const m of index.matchAll(/app\.route\(\s*'([^']+)'\s*,\s*(\w+)\s*\)/g)) {
    mounts.set(m[2], [...(mounts.get(m[2]) ?? []), m[1]]);
  }
  assert.ok(mounts.size > 30, 'index.ts mounts were not parsed');

  const seen = new Set<string>();
  const out: AdminPath[] = [];
  const dir = join(ROOT, 'worker/routes');
  for (const file of readdirSync(dir).filter((f) => f.endsWith('.ts'))) {
    const src = readFileSync(join(dir, file), 'utf8');
    const routers = [...src.matchAll(/export const (\w+)\s*=\s*new Hono/g)].map((m) => m[1]);
    for (const v of routers) {
      const prefixes = mounts.get(v);
      if (!prefixes) continue;
      const routerWide = new RegExp(`\\b${v}\\.use\\(\\s*'\\*'\\s*,[^\\n]*requireAdmin`).test(src);
      const subGuards = [...src.matchAll(new RegExp(`\\b${v}\\.use\\(\\s*'([^']+)'\\s*,[^\\n]*requireAdmin`, 'g'))]
        .map((m) => m[1].replace(/\/\*$/, ''))
        .filter((p) => p !== '*');
      for (const m of src.matchAll(new RegExp(`\\b${v}\\.(get|post|put|patch|delete|all)\\(\\s*'([^']+)'([^\\n]*)`, 'g'))) {
        const method = (m[1] === 'all' ? 'get' : m[1]).toUpperCase();
        const sub = m[2];
        const inline = /\brequireAdmin\b/.test(m[3]);
        for (const prefix of prefixes) {
          const full = `${prefix}${sub === '/' ? '' : sub}`.replace(/\/{2,}/g, '/');
          const isAdmin =
            routerWide || inline || /\/admin(\/|$)/.test(full) || subGuards.some((g) => sub === g || sub.startsWith(`${g}/`));
          if (!isAdmin) continue;
          const key = `${method} ${full}`;
          if (seen.has(key)) continue;
          seen.add(key);
          out.push({ method, path: full, source: `${file}:${v}` });
        }
      }
    }
  }
  return out;
}

/** A concrete URL path for a Hono pattern: `:id` → a dummy segment, `*` → one segment. */
function materialize(pattern: string): string {
  return pattern.replace(/:[A-Za-z_]\w*\??/g, 'x1').replace(/\*/g, 'x');
}

async function realApp() {
  const raw = freshDb();
  raw.exec(`INSERT INTO users (id,name,email,password_hash,role,username) VALUES
    ('boss','Admin','boss@x.co','h','admin','boss'), ('cust','Sara','s@x.co','h','customer','sara')`);
  const token = 'test-admin-session-token-0001';
  raw.prepare('INSERT INTO sessions (id,user_id,expires_at) VALUES (?,?,?)').run(
    await sha256Hex(token), 'boss', new Date(Date.now() + 86_400_000).toISOString()
  );
  const env = {
    DB: asD1(raw),
    STORE_ROOT_DOMAIN: APEX,
    APP_ORIGIN: `https://${APEX}`,
    INITIAL_ADMIN_EMAIL: 'boss@x.co',
    EXTRA_ALLOWED_ORIGINS: '',
    ASSETS: { fetch: async () => new Response('spa') },
  };
  const call = (host: string, method: string, path: string) =>
    worker.fetch(
      new Request(`https://${host}${path}`, {
        method,
        headers: {
          Host: host,
          Cookie: `levonis_session=${token}`,
          'content-type': 'application/json',
          'CF-Connecting-IP': '9.9.9.9',
        },
        body: method === 'GET' ? undefined : '{}',
      }),
      env as never,
      ctx
    );
  return { raw, call };
}

const ADMIN_PATHS = discoverAdminPaths();

test('discovery finds the whole admin surface, including the seven off-prefix mounts', () => {
  const paths = ADMIN_PATHS.map((p) => p.path);
  for (const prefix of [
    '/api/kyc/admin/', '/api/telegram/admin/', '/api/support/admin/', '/api/policies/admin/',
    '/api/wallet/admin/', '/api/referrals/admin/', '/api/reviews/admin/', '/api/returns/admin/',
    '/api/price-protection/admin/', '/api/devices/admin/', '/api/memberships/admin/', '/api/admin/',
  ]) {
    assert.ok(paths.some((p) => p.startsWith(prefix)), `no admin route discovered under ${prefix}`);
  }
  // Inline-guarded routes without an /admin segment are admin routes too.
  assert.ok(paths.includes('/api/translate'), 'misc /translate (requireAdmin inline) must be discovered');
  assert.ok(paths.includes('/api/invoices/:id/revise'), 'invoices revise (requireAdmin inline) must be discovered');
  assert.ok(ADMIN_PATHS.length >= 150, `only ${ADMIN_PATHS.length} admin routes discovered — the parser regressed`);
});

test(`every admin route (${ADMIN_PATHS.length}) does not exist on a merchant host, even with a platform admin's own session`, async () => {
  const { call } = await realApp();
  const leaks: string[] = [];
  for (const p of ADMIN_PATHS) {
    const res = await call(MERCHANT_HOST, p.method, materialize(p.path));
    const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    const refused = res.status === 404 && body.success === false && body.error === 'Not found' && body.code === undefined;
    if (!refused) leaks.push(`${p.method} ${p.path} (${p.source}) → ${res.status} ${JSON.stringify(body).slice(0, 120)}`);
  }
  assert.deepEqual(leaks, [], `admin routes reachable on ${MERCHANT_HOST}:\n${leaks.join('\n')}`);
});

test('control: on the apex the same session reaches every one of those routes', async () => {
  const { call } = await realApp();
  const unreachable: string[] = [];
  for (const p of ADMIN_PATHS) {
    const res = await call(APEX, p.method, materialize(p.path));
    const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    // The guard's exact answer (404, "Not found", no code) is the only thing
    // that counts as "the route does not exist here". A handler that answers
    // 404 for a dummy id says so with a code (notFound → NOT_FOUND).
    const guarded = res.status === 404 && body.error === 'Not found' && body.code === undefined;
    if (guarded) unreachable.push(`${p.method} ${p.path} (${p.source})`);
  }
  assert.deepEqual(unreachable, [], `admin routes refused on the apex:\n${unreachable.join('\n')}`);

  // And the seven that used to leak answer normally on the apex.
  for (const path of [
    '/api/kyc/admin/queue', '/api/telegram/admin/tg-identities', '/api/support/admin/tickets',
    '/api/policies/admin/list', '/api/wallet/admin/reconciliation', '/api/referrals/admin/gifts',
    '/api/reviews/admin/queue', '/api/admin/providers', '/api/admin/wallet-requests',
  ]) {
    const res = await call(APEX, 'GET', path);
    assert.equal(res.status, 200, `${path} on the apex → ${res.status}`);
  }
});

test('a customer session is refused with 403 on the apex and still sees 404 on a merchant host', async () => {
  const { raw, call } = await realApp();
  const token = 'test-customer-session-token-0001';
  raw.prepare('INSERT INTO sessions (id,user_id,expires_at) VALUES (?,?,?)').run(
    await sha256Hex(token), 'cust', new Date(Date.now() + 86_400_000).toISOString()
  );
  void call;
  const env = { DB: asD1(raw), STORE_ROOT_DOMAIN: APEX, APP_ORIGIN: `https://${APEX}`, INITIAL_ADMIN_EMAIL: 'boss@x.co', EXTRA_ALLOWED_ORIGINS: '', ASSETS: { fetch: async () => new Response('spa') } };
  const as = (host: string, path: string) =>
    worker.fetch(new Request(`https://${host}${path}`, { headers: { Host: host, Cookie: `levonis_session=${token}` } }), env as never, ctx);
  for (const path of ['/api/wallet/admin/reconciliation', '/api/kyc/admin/queue', '/api/support/admin/tickets']) {
    assert.equal((await as(APEX, path)).status, 403, `${path} apex as customer`);
    assert.equal((await as(MERCHANT_HOST, path)).status, 404, `${path} merchant host as customer`);
  }
});
