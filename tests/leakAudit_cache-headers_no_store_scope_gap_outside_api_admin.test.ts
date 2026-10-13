/**
 * LEAK AUDIT — cache-headers: owner and staff answers OUTSIDE `/api/admin/*`
 * leave the Worker with no Cache-Control, so the browser keeps them on disk.
 *
 * The one blanket «private, no-store» of the Worker is `noStoreUnlessSet`
 * (worker/lib/edgePolicy.ts), and worker/index.ts mounts it on
 * `/api/admin/*`, `/api/cart` and `/api/cart/*` only. Every other answer
 * leaves with whatever its handler set — and most set nothing.
 *
 * The private value this file follows is the owner's bell. Since S1 a
 * withdrawal request is announced to the OWNER alone — «طلب سحب بقيمة X د.ع»
 * / «A withdrawal request of X IQD» — because a profit-percent wage reveals
 * profit (owner decision 2; worker/lib/financeParticipants.ts adminNotices;
 * worker/lib/notifications.ts HIDE_OWNER_FINANCE_NOTICES_SQL keeps the older
 * rows from every non-owner reader). The owner reads it at
 * `GET /api/notifications` (worker/routes/notifications.ts), which sets no
 * Cache-Control; only `/channels` sets `no-store`.
 *
 * WHO RECEIVES IT: the next person on a shared browser or device. There is no
 * shared-cache path (no shared cache stores a cookie-bearing request), so the
 * actor is the browser's own HTTP cache:
 *
 *   - RFC 9111 §3: a final 200 without `no-store` is storable by a private
 *     cache — 200 is heuristically cacheable (§4.2.2), no explicit freshness
 *     is needed to STORE it;
 *   - the client fetches with the default cache mode (src/lib/api.ts
 *     requestRaw: no `cache:` option), so the browser does store it;
 *   - the service worker never touches `/api/*` (public/sw.js NETWORK_ONLY),
 *     so the HTTP cache is the only copy — and the only control is the header;
 *   - sign-out (`POST /api/auth/logout`) sends no `Clear-Site-Data`, so the
 *     stored copy outlives the owner's session;
 *   - the answer carries no `Vary: Cookie`, so the stored copy matches the next
 *     person's request whatever cookie they carry;
 *   - Fetch `cache: 'force-cache'` / `'only-if-cached'` returns any stored match,
 *     stale or not — one line in the DevTools console of the next person:
 *       await (await fetch('/api/notifications', { cache: 'force-cache' })).text()
 *
 * Normal browsing by the next person does NOT replay it silently (no
 * validators, no Last-Modified: the stale copy is refetched), which is why the
 * candidate is low severity; but the owner-only body is on the device's disk
 * after the owner signed out, readable by the next user.
 *
 * The test drives the REAL Worker (worker/index.ts fetch, real session rows
 * and cookies, the apex host) on the role-matrix database: the employee on a
 * profit-percent wage asks for a withdrawal through the real route, the owner
 * reads the bell, the owner signs out, and a customer — then a guest — uses
 * the same browser. A small model of the browser's HTTP cache (the rules
 * above, nothing more) stands in for the device; `browserMayReuse` is the
 * Worker's own RFC 9111 §4.1 Vary check.
 *
 * LOCAL ONLY: an on-disk throwaway SQLite copy of the role-matrix database,
 * the real Worker and route modules, no network, no live host.
 *
 * Run: node --import tsx --test tests/leakAudit_cache-headers_no_store_scope_gap_outside_api_admin.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { DatabaseSync } from 'node:sqlite';
import worker from '../worker/index';
import { sha256Hex } from '../worker/lib/crypto';
import { browserMayReuse } from '../worker/lib/edgePolicy';
import { APEX, asD1, ctx } from './fixtures/app';
import { OWNER, ROLES, leaks, seededCopy } from './fixtures/roleMatrix';

// ------------------------------------------------------------- the private value

/**
 * The withdrawal the employee (`usr_emp`, staff `staff_rm`, a profit-percent
 * wage — seedRoleMatrix's `rule_rm`) asks for. Owner-only once it is in the
 * owner's bell: «A withdrawal request of 87,654 IQD is ready for review».
 */
const WITHDRAWAL = { amount: 87_654, text: '87,654' } as const;
/** The approved wage the withdrawal is taken from. */
const EARNED = 98_765;

const SESSION_USERS: Record<string, string> = {
  owner: OWNER.id,
  employee: ROLES.employee!.id,
  customer: ROLES.customer!.id,
  full: ROLES.full!.id,
  legacy_null: ROLES.legacy_null!.id,
};
const tokenOf = (who: string) => `leak-audit-nostore-scope-session-${who}-0000000001`;

async function world(): Promise<DatabaseSync> {
  const raw = seededCopy();
  raw.exec(`
    INSERT INTO orders (id,user_id,status,address_snapshot,delivery_method_id,delivery_method_snapshot,payment_method_id,
                        subtotal_iqd,exchange_rate,total_iqd,due_on_delivery_iqd)
      VALUES ('o_nostore','u1','delivered','{}','standard','{}','cash',500000,1500,505000,505000);
    INSERT INTO finance_order_costs (id,order_id,rule_id,rule_version,rule_name,group_key,staff_id,category_id,milestone,
                                     base_iqd,qty,amount_iqd,cost_day,state,snapshot)
      VALUES ('cost_nostore','o_nostore','rule_rm',1,'نسبة من الربح','prep','staff_rm','rm_wages','delivered',
              987650,1,${EARNED},'2026-10-01','approved','{}');
  `);
  const expires = new Date(Date.now() + 86_400_000).toISOString();
  for (const [who, userId] of Object.entries(SESSION_USERS)) {
    raw.prepare('INSERT INTO sessions (id,user_id,expires_at) VALUES (?,?,?)').run(await sha256Hex(tokenOf(who)), userId, expires);
  }
  return raw;
}

// ------------------------------------------------------------- the Worker

interface Answer {
  status: number;
  headers: Headers;
  text: string;
  body: unknown;
}

let ipSeq = 0;
/** One request through the REAL Worker on the apex — signed in as `who`, or a guest when `who` is null. */
async function send(raw: DatabaseSync, who: string | null, method: string, path: string, body?: unknown): Promise<{ req: Headers; res: Answer }> {
  const env = {
    DB: asD1(raw),
    STORE_ROOT_DOMAIN: APEX,
    APP_ORIGIN: `https://${APEX}`,
    INITIAL_ADMIN_EMAIL: 'boss@x.co',
    EXTRA_ALLOWED_ORIGINS: '',
    ASSETS: { fetch: async () => new Response('spa') },
  };
  ipSeq += 1;
  const headers = new Headers({
    Host: APEX,
    'CF-Connecting-IP': `10.77.${(ipSeq >> 8) & 255}.${ipSeq & 255}`,
  });
  if (who) headers.set('Cookie', `levonis_session=${tokenOf(who)}`);
  if (method !== 'GET') {
    headers.set('content-type', 'application/json');
    headers.set('Origin', `https://${APEX}`);
  }
  const res = await worker.fetch(
    new Request(`https://${APEX}${path}`, { method, headers, body: method === 'GET' ? undefined : JSON.stringify(body ?? {}) }),
    env as never,
    ctx
  );
  const text = await res.text();
  let parsed: unknown = text;
  try {
    parsed = JSON.parse(text);
  } catch {
    /* keep the text */
  }
  return { req: headers, res: { status: res.status, headers: res.headers, text, body: parsed } };
}

// ------------------------------------------------------------- the shared device

/**
 * THE BROWSER'S OWN HTTP CACHE on the shared device — only the rules this
 * audit relies on (see the header): store a final, heuristically cacheable
 * GET answer unless it says `no-store`; empty on `Clear-Site-Data` naming
 * "cache" (or "*"); give a `force-cache` lookup any stored match whose Vary
 * headers agree, stale or not.
 */
const HEURISTICALLY_CACHEABLE = new Set([200, 203, 204, 206, 300, 301, 308, 404, 405, 410, 414, 501]);
class BrowserHttpCache {
  private readonly stored = new Map<string, { req: Headers; res: Answer }>();
  observe(method: string, path: string, req: Headers, res: Answer): void {
    const csd = (res.headers.get('Clear-Site-Data') ?? '').toLowerCase();
    if (/"(cache|\*)"/.test(csd)) this.stored.clear();
    if (method !== 'GET' || !HEURISTICALLY_CACHEABLE.has(res.status)) return;
    if (/(^|,)\s*no-store\s*(,|$)/i.test(res.headers.get('Cache-Control') ?? '')) return;
    this.stored.set(path, { req, res });
  }
  forceCache(path: string, req: Headers): Answer | null {
    const hit = this.stored.get(path);
    if (!hit) return null;
    const asResponse = new Response(null, { status: hit.res.status === 204 ? 204 : 200, headers: hit.res.headers });
    return browserMayReuse(asResponse, hit.req, req) ? hit.res : null;
  }
  has(path: string): boolean {
    return this.stored.has(path);
  }
}

/** Everything of the owner-only notice a reader could recover from a body. */
function privateIn(body: unknown, text: string): string[] {
  const out = leaks(body, { numbers: [WITHDRAWAL.amount] });
  if (text.includes(WITHDRAWAL.text)) out.push(`the body carries «${WITHDRAWAL.text}» (the owner-only withdrawal amount)`);
  if (/طلب سحب بقيمة|withdrawal request of/i.test(text)) out.push('the body carries the owner-only withdrawal notice');
  return out;
}

/** The employee asks; the owner's bell is the real path that carries the amount. */
async function ownerBellWorld(): Promise<DatabaseSync> {
  const raw = await world();
  const asked = await send(raw, 'employee', 'POST', '/api/finance-earnings/withdrawals', {
    operation_id: 'leak-audit-nostore-withdrawal',
    amount_iqd: WITHDRAWAL.amount,
  });
  assert.equal(asked.res.status, 200, `the employee's withdrawal request did not run: ${asked.res.text.slice(0, 400)}`);
  return raw;
}

// ------------------------------------------------------------- 0. the path is real

test('the path is real: the owner — and only the owner — reads the withdrawal amount in GET /api/notifications', async () => {
  const raw = await ownerBellWorld();
  const owner = await send(raw, 'owner', 'GET', '/api/notifications');
  assert.equal(owner.res.status, 200, owner.res.text.slice(0, 300));
  const notices = (owner.res.body as { notifications?: Array<{ kind: string; body_en: string; link: string }> }).notifications ?? [];
  const payout = notices.find((n) => n.kind === 'payout_available' && n.link.startsWith('/admin?tab=finance'));
  assert.ok(payout, `the owner's bell has no withdrawal notice: ${owner.res.text.slice(0, 400)}`);
  assert.ok(payout.body_en.includes(WITHDRAWAL.text), `the notice does not carry the amount: ${payout.body_en}`);

  // The existing value guard holds: no other admin reads it at all.
  for (const who of ['full', 'legacy_null', 'customer'] as const) {
    const other = await send(raw, who, 'GET', '/api/notifications');
    assert.equal(other.res.status, 200);
    assert.deepEqual(privateIn(other.res.body, other.res.text), [], `${who} reads the owner's withdrawal notice directly`);
  }
  raw.close();
});

test('control: through the same Worker the owner\'s /api/admin/* answer and /api/notifications/channels DO leave no-store', async () => {
  const raw = await ownerBellWorld();
  const admin = await send(raw, 'owner', 'GET', '/api/admin/orders');
  assert.equal(admin.res.status, 200, admin.res.text.slice(0, 300));
  assert.equal(admin.res.headers.get('Cache-Control'), 'private, no-store');
  const channels = await send(raw, 'owner', 'GET', '/api/notifications/channels');
  assert.equal(channels.res.status, 200, channels.res.text.slice(0, 300));
  assert.match(channels.res.headers.get('Cache-Control') ?? '', /no-store/);
  raw.close();
});

// ------------------------------------------------------------- 1. the header

test('the owner\'s bell — which carries the owner-only withdrawal amount — leaves `private, no-store`, like every /api/admin/* answer', async () => {
  const raw = await ownerBellWorld();
  const owner = await send(raw, 'owner', 'GET', '/api/notifications');
  assert.equal(owner.res.status, 200);
  assert.ok(privateIn(owner.res.body, owner.res.text).length > 0, 'precondition: the owner answer carries the private amount');
  const cc = owner.res.headers.get('Cache-Control') ?? '';
  assert.ok(
    /\bno-store\b/i.test(cc) && /\bprivate\b/i.test(cc),
    `GET /api/notifications (owner) carries «A withdrawal request of ${WITHDRAWAL.text} IQD» and leaves with Cache-Control: ${cc || '(none)'} — ` +
      `a browser stores it on disk; noStoreUnlessSet is mounted on /api/admin/* and /api/cart* only (worker/index.ts)`
  );
  raw.close();
});

// ------------------------------------------------------------- 2. the next person on the device

test('a later user of the same browser (a customer, then a guest) never receives the owner\'s withdrawal amount from the browser cache after the owner signs out', async () => {
  const raw = await ownerBellWorld();
  const device = new BrowserHttpCache();
  const path = '/api/notifications';

  // The owner opens the bell (the SPA's default-mode fetch), then signs out.
  const read = await send(raw, 'owner', 'GET', path);
  assert.equal(read.res.status, 200);
  assert.ok(privateIn(read.res.body, read.res.text).length > 0, 'precondition: the owner answer carries the private amount');
  device.observe('GET', path, read.req, read.res);
  const out = await send(raw, 'owner', 'POST', '/api/auth/logout', {});
  assert.equal(out.res.status, 200, out.res.text.slice(0, 300));
  device.observe('POST', '/api/auth/logout', out.req, out.res);
  // The session is really gone: the owner cookie no longer opens the bell.
  const after = await send(raw, 'owner', 'GET', path);
  assert.equal(after.res.status, 401, `sign-out did not end the owner's session: ${after.res.status}`);

  const reached: string[] = [];
  for (const next of ['customer', null] as const) {
    const label = next ?? 'guest';
    // What the server answers this person is clean (the value guard above)…
    const live = await send(raw, next, 'GET', path);
    if (live.res.status === 200) {
      assert.deepEqual(privateIn(live.res.body, live.res.text), [], `${label}: the server itself answered the owner's notice`);
    }
    // …but the device answers `force-cache` from what the owner left behind.
    const fromDisk = device.forceCache(path, live.req);
    if (fromDisk) for (const l of privateIn(fromDisk.body, fromDisk.text)) reached.push(`${label} via the browser cache (fetch ${path} {cache:'force-cache'}): ${l}`);
  }
  assert.deepEqual(
    reached,
    [],
    `the owner's withdrawal notice outlives the owner's session in the shared browser's HTTP cache ` +
      `(Cache-Control on the owner's answer: ${read.res.headers.get('Cache-Control') ?? '(none)'}; ` +
      `Clear-Site-Data on sign-out: ${out.res.headers.get('Clear-Site-Data') ?? '(none)'}; Vary: ${read.res.headers.get('Vary') ?? '(none)'}):\n` +
      reached.join('\n')
  );
  raw.close();
});

// ------------------------------------------------------------- 3. the owner's admin answers mounted off the prefix

test('the owner\'s admin answers mounted outside /api/admin/* (returns, price protection, devices, serial inventory) leave `no-store` too', async () => {
  const raw = await ownerBellWorld();
  const missing: string[] = [];
  const answered: string[] = [];
  for (const path of [
    '/api/returns/admin/queue',
    '/api/price-protection/admin/claims',
    '/api/devices/admin/claims',
    '/api/devices/admin/serial-inventory',
    '/api/devices/admin/units?user_id=u1',
  ]) {
    const a = await send(raw, 'owner', 'GET', path);
    if (a.res.status < 200 || a.res.status >= 300) continue;
    answered.push(path);
    const cc = a.res.headers.get('Cache-Control') ?? '';
    if (!/\bno-store\b/i.test(cc)) missing.push(`owner GET ${path}  Cache-Control: ${cc || '(none)'}`);
  }
  assert.ok(answered.length >= 3, `only ${answered.length} of the owner's off-prefix admin GETs answered: ${answered.join(', ')}`);
  assert.deepEqual(missing, [], `owner admin answers outside /api/admin/* leave without no-store:\n${missing.join('\n')}`);
  raw.close();
});
