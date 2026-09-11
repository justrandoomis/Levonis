/**
 * THE NAMED ENTRYPOINTS — what another Worker can ask the core, and what it
 * must prove first (02-MIGRATION-PLAN.md 1.6, `01-TARGET.md` §4 item 3).
 *
 * Two properties are load-bearing:
 *
 *  1. The hop assertion. Binding identity is account-level trust: any Worker on
 *     the account can call these methods, so the caller's SIGNED hop is what
 *     says which one did and what it asked for. A valid signature for the
 *     wrong method, the wrong arguments or a caller not on that method's
 *     allowlist is refused — all four cases are here.
 *  2. Off by default. While no caller key is configured — every deployment
 *     today — the assertion is `off` and the methods answer, because nothing
 *     is bound to call them and a dark stack must be able to exercise them.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { DatabaseSync } from 'node:sqlite';
import { asD1, freshDb } from './fixtures/app';
import type { Env } from '../worker/lib/types';
import { resetEventBus } from '../worker/lib/eventBus';
import { IdentityEntrypoint } from '../worker/entrypoints/IdentityEntrypoint';
import { LedgerEntrypoint } from '../worker/entrypoints/LedgerEntrypoint';
import { CatalogEntrypoint } from '../worker/entrypoints/CatalogEntrypoint';
import { OrdersEntrypoint } from '../worker/entrypoints/OrdersEntrypoint';
import { HopRefused, hopMode, CORE_METHOD_CALLERS } from '../worker/entrypoints/base';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { generateKeyPair } from '@levonis/platform-kit/keys';
import { signHop } from '@levonis/platform-kit/hop';
import { importSigningKey } from '@levonis/platform-kit/keys';
import type { RpcCtx } from '@levonis/contracts/rpc/common';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const ctxStub = { waitUntil: () => {}, passThroughOnException: () => {} } as unknown as ExecutionContext;

function envFor(raw: DatabaseSync, extra: Record<string, unknown> = {}): Env {
  return { DB: asD1(raw), INITIAL_ADMIN_EMAIL: 'boss@x.co', EXTRA_ALLOWED_ORIGINS: '', ...extra } as unknown as Env;
}

function seedUser(raw: DatabaseSync, id = 'usr_1', role = 'customer'): void {
  raw.exec(`INSERT INTO users (id, email, username, name, role) VALUES ('${id}', '${id}@x.co', '${id}', 'Name', '${role}')`);
}

function seedSession(raw: DatabaseSync, sid: string, userId: string, expiresAt: string): void {
  raw.exec(`INSERT INTO sessions (id, user_id, expires_at) VALUES ('${sid}', '${userId}', '${expiresAt}')`);
}

const hour = (n: number) => new Date(Date.now() + n * 3600_000).toISOString();

// ------------------------------------------------------------ the assertion

test('with no caller keys configured the assertion is off, and with them it is on', () => {
  assert.equal(hopMode(envFor(freshDb())), 'off');
  assert.equal(hopMode(envFor(freshDb(), { ALLOWED_CALLER_KIDS: 'gateway:kid:key' })), 'on');
  assert.equal(hopMode(envFor(freshDb(), { ALLOWED_CALLER_KIDS: 'gateway:kid:key', ENTRYPOINT_HOP: 'log' })), 'log');
});

test('a registered caller with a valid hop is served; every way of getting it wrong is refused', async () => {
  resetEventBus();
  const raw = freshDb();
  seedUser(raw, 'usr_1');
  seedSession(raw, 'sid_hash_1', 'usr_1', hour(24));
  const pair = await generateKeyPair();
  const env = envFor(raw, { ALLOWED_CALLER_KIDS: `gateway:${pair.kid}:${pair.publicKeyB64}` });
  const identity = new IdentityEntrypoint(ctxStub, env);
  const signer = { iss: 'gateway', key: await importSigningKey(pair.privateKeyB64, pair.publicKeyB64) };
  const now = Math.floor(Date.now() / 1000);
  const hopFor = (method: string, args: unknown) => signHop(signer, { method, args, nowSeconds: now });

  // The happy path.
  const ok = await identity.introspect('sid_hash_1', { cid: 'c', hop: await hopFor('IdentityEntrypoint.introspect', ['sid_hash_1']) } as RpcCtx);
  assert.equal(ok.active, true);
  assert.equal(ok.user?.id, 'usr_1');

  // No hop at all.
  await assert.rejects(() => identity.introspect('sid_hash_1'), (e: Error) => e instanceof HopRefused && e.reason === 'MISSING_HOP');

  // A hop signed for a DIFFERENT method: a caller cannot re-use one call's
  // signature to make another call.
  const wrongMethod = { cid: 'c', hop: await hopFor('IdentityEntrypoint.revoke', ['sid_hash_1']) } as RpcCtx;
  await assert.rejects(
    () => identity.introspect('sid_hash_1', wrongMethod),
    (e: Error) => e instanceof HopRefused && e.reason === 'METHOD_MISMATCH'
  );

  // A hop signed for DIFFERENT arguments: the signature covers what was asked.
  const wrongArgs = { cid: 'c', hop: await hopFor('IdentityEntrypoint.introspect', ['someone_else']) } as RpcCtx;
  await assert.rejects(
    () => identity.introspect('sid_hash_1', wrongArgs),
    (e: Error) => e instanceof HopRefused && e.reason === 'ARGS_MISMATCH'
  );

  // A registered caller that is not on THIS method's allowlist (ADR-015: the
  // gateway may introspect a session and may never move money).
  const ledger = new LedgerEntrypoint(ctxStub, env);
  const moneyHop = { cid: 'c', hop: await hopFor('LedgerEntrypoint.getBalances', ['usr_1']) } as RpcCtx;
  await assert.rejects(
    () => ledger.getBalances('usr_1', moneyHop),
    (e: Error) => e instanceof HopRefused && e.reason === 'ISSUER_NOT_ALLOWED'
  );

  // Replay of a valid hop.
  const once = await hopFor('IdentityEntrypoint.introspect', ['sid_hash_1']);
  await identity.introspect('sid_hash_1', { cid: 'c', hop: once } as RpcCtx);
  await assert.rejects(
    () => identity.introspect('sid_hash_1', { cid: 'c', hop: once } as RpcCtx),
    (e: Error) => e instanceof HopRefused && e.reason === 'REPLAY'
  );
});

test('health() answers without a hop — a probe that must authenticate cannot report broken authentication', async () => {
  resetEventBus();
  const raw = freshDb();
  const env = envFor(raw, { ALLOWED_CALLER_KIDS: 'gateway:x:y', LEVONIS_VERSION: 'abc123' });
  const report = await new OrdersEntrypoint(ctxStub, env).health();
  assert.equal(report.ok, true);
  assert.equal(report.svc, 'core');
  assert.equal(report.ver, 'abc123');
  assert.equal(report.checks.db, 'ok');
});

// -------------------------------------------------------------------- Identity

test('introspect answers about a live session only, and never leaks more than display fields', async () => {
  resetEventBus();
  const raw = freshDb();
  seedUser(raw, 'usr_1');
  seedSession(raw, 'live', 'usr_1', hour(24));
  seedSession(raw, 'stale', 'usr_1', hour(-1));
  const identity = new IdentityEntrypoint(ctxStub, envFor(raw));

  const live = await identity.introspect('live');
  assert.equal(live.active, true);
  assert.deepEqual(Object.keys(live.user!).sort(), ['avatar_key', 'id', 'membership_tier', 'name', 'role', 'username']);
  assert.equal(await (await identity.introspect('stale')).active, false);
  assert.deepEqual(await identity.introspect('nope'), { active: false });
});

test('resolveSession mints nothing while no signing key is configured', async () => {
  resetEventBus();
  const raw = freshDb();
  seedUser(raw, 'usr_1');
  seedSession(raw, 'live', 'usr_1', hour(24));
  const identity = new IdentityEntrypoint(ctxStub, envFor(raw));
  assert.deepEqual(await identity.resolveSession({ sid_hash: 'missing', host_kind: 'main', cid: 'c' }), {
    principal: null,
    reason: 'NOT_FOUND',
  });
  // A live session with no key: an unsigned principal is never minted.
  const res = await identity.resolveSession({ sid_hash: 'live', host_kind: 'main', cid: 'c' });
  assert.equal('principal' in res && res.principal, null);
});

test('resolveSession signs the claims when a key is configured, and says nothing more than the claims', async () => {
  resetEventBus();
  const raw = freshDb();
  seedUser(raw, 'usr_1', 'admin');
  seedSession(raw, 'live', 'usr_1', hour(24));
  const pair = await generateKeyPair();
  const identity = new IdentityEntrypoint(
    ctxStub,
    envFor(raw, { CORE_SIGNING_KEY: pair.privateKeyB64, CORE_SIGNING_PUBLIC_KEY: pair.publicKeyB64 })
  );
  const res = await identity.resolveSession({ sid_hash: 'live', host_kind: 'main', cid: 'cid-1' });
  assert.ok('principal' in res && typeof res.principal === 'string');
  const [, payload] = (res as { principal: string }).principal.split('.');
  const claims = JSON.parse(Buffer.from(payload, 'base64url').toString()) as Record<string, unknown>;
  assert.equal(claims.sub, 'usr_1');
  assert.equal(claims.role, 'admin');
  assert.equal(claims.scope, 'full');
  assert.equal(claims.cid, 'cid-1');
  for (const forbidden of ['email', 'password_hash', 'google_sub', 'phone_e164']) {
    assert.equal(claims[forbidden], undefined, `${forbidden} must never be in a principal`);
  }
});

test('lookupUsers answers display fields, caps the id list and never returns a contact', async () => {
  resetEventBus();
  const raw = freshDb();
  seedUser(raw, 'usr_1');
  seedUser(raw, 'usr_2');
  const identity = new IdentityEntrypoint(ctxStub, envFor(raw));
  const rows = await identity.lookupUsers(['usr_1', 'usr_2', 'usr_missing', 'usr_1']);
  assert.equal(rows.length, 2);
  assert.deepEqual(Object.keys(rows[0]).sort(), ['avatar_key', 'id', 'membership_tier', 'name', 'role', 'username']);
  assert.deepEqual(await identity.lookupUsers([]), []);
});

test('contactFor answers one channel at a time, and refuses the placeholder address', async () => {
  resetEventBus();
  const raw = freshDb();
  seedUser(raw, 'usr_1');
  raw.exec("INSERT INTO users (id, email, name) VALUES ('usr_tg', 'tg-usr_tg@telegram.local', 'T')");
  const identity = new IdentityEntrypoint(ctxStub, envFor(raw));
  assert.deepEqual(await identity.contactFor('usr_1', 'email'), { address: 'usr_1@x.co' });
  assert.equal(await identity.contactFor('usr_tg', 'email'), null, 'the non-routable placeholder is not an address');
  assert.equal(await identity.contactFor('usr_1', 'phone'), null);
});

test('rateLimitHit is the cross-isolate counter: it counts, and it says when the window is exceeded', async () => {
  resetEventBus();
  const raw = freshDb();
  const identity = new IdentityEntrypoint(ctxStub, envFor(raw));
  assert.deepEqual(await identity.rateLimitHit('auth', 'k1', 2, 60), { allowed: true, count: 1 });
  assert.deepEqual(await identity.rateLimitHit('auth', 'k1', 2, 60), { allowed: true, count: 2 });
  assert.deepEqual(await identity.rateLimitHit('auth', 'k1', 2, 60), { allowed: false, count: 3 });
  // A different key is a different bucket.
  assert.deepEqual(await identity.rateLimitHit('auth', 'k2', 2, 60), { allowed: true, count: 1 });
});

test('revoke deletes exactly one session and reports whether it existed', async () => {
  resetEventBus();
  const raw = freshDb();
  seedUser(raw, 'usr_1');
  seedSession(raw, 'live', 'usr_1', hour(24));
  const identity = new IdentityEntrypoint(ctxStub, envFor(raw));
  assert.deepEqual(await identity.revoke('live'), { revoked: true });
  assert.deepEqual(await identity.revoke('live'), { revoked: false });
});

test('the core is not a consumer yet, and says so instead of acknowledging', async () => {
  resetEventBus();
  const identity = new IdentityEntrypoint(ctxStub, envFor(freshDb()));
  const res = await identity.deliver([{ event_id: 'e1' } as never]);
  assert.equal(res.results[0].result, 'invalid');
});

// ---------------------------------------------------------------------- Ledger

test('a money command without a server-minted event key is refused before the engine is touched', async () => {
  resetEventBus();
  const raw = freshDb();
  seedUser(raw, 'usr_1');
  const ledger = new LedgerEntrypoint(ctxStub, envFor(raw));
  const refused = await ledger.hold({
    eventKey: 'nope',
    userId: 'usr_1',
    currency: 'USD',
    amount: 100,
    ref: { type: 'order', id: 'ORD-1' },
    reason: 'test',
    actor: { kind: 'user', id: 'usr_1' },
    correlationId: 'c',
    kind: 'purchase',
  });
  assert.deepEqual(refused, { ok: false, reason: 'FORBIDDEN', detail: 'a money command needs a server-minted eventKey' });
});

test('hold refuses what the wallet engine refuses, in the contract’s words', async () => {
  resetEventBus();
  const raw = freshDb();
  seedUser(raw, 'usr_1');
  const ledger = new LedgerEntrypoint(ctxStub, envFor(raw));
  const cmd = {
    eventKey: 'commerce:order:ORD-1:hold',
    userId: 'usr_1',
    currency: 'USD' as const,
    amount: 100,
    ref: { type: 'order', id: 'ORD-1' },
    reason: 'test',
    actor: { kind: 'user' as const, id: 'usr_1' },
    correlationId: 'c',
    kind: 'purchase',
  };
  // An empty wallet cannot fund a hold.
  assert.deepEqual(await ledger.hold(cmd), { ok: false, reason: 'INSUFFICIENT' });

  raw.exec(
    "INSERT INTO wallet_transactions (id, user_id, type, currency, amount, status) VALUES ('t1','usr_1','deposit','USD',500,'approved')"
  );
  const placed = await ledger.hold(cmd);
  assert.equal(placed.ok, true);
  assert.equal('applied' in placed && placed.applied, true);
  // The same key again is the SAME hold, not a second one.
  const again = await ledger.hold(cmd);
  assert.equal('replayed' in again && again.replayed, true);
  assert.equal('holdId' in again && 'holdId' in placed && again.holdId, (placed as { holdId: string }).holdId);
  // The same key for a different amount is refused rather than silently reused.
  assert.deepEqual(await ledger.hold({ ...cmd, amount: 200 }), { ok: false, reason: 'EVENT_KEY_REUSED' });
});

test('getBalances reports settled, held and available separately', async () => {
  resetEventBus();
  const raw = freshDb();
  seedUser(raw, 'usr_1');
  raw.exec(
    `INSERT INTO wallet_transactions (id, user_id, type, currency, amount, status) VALUES ('t1','usr_1','deposit','USD',1000,'approved');
     INSERT INTO wallet_transactions (id, user_id, type, currency, amount, status) VALUES ('t2','usr_1','deposit','POINT',50,'approved');
     INSERT INTO wallet_holds (id, user_id, kind, amount_cents, state, event_key) VALUES ('h1','usr_1','purchase',300,'active','commerce:order:O:hold');`
  );
  const balances = await new LedgerEntrypoint(ctxStub, envFor(raw)).getBalances('usr_1');
  assert.deepEqual(balances.usd_cents, { settled: 1000, held: 300, available: 700 });
  assert.equal(balances.points.settled, 50);
  assert.equal(balances.points.available, 50, 'a wallet hold never reserves points');
});

// --------------------------------------------------------------------- Catalog

test('isPrinterCatalog reads the owner’s flag, and listForIndex pages by id', async () => {
  resetEventBus();
  const raw = freshDb();
  raw.exec(
    `INSERT INTO catalogs (id, slug, name_ar, name_en, is_printer_catalog) VALUES ('cat_p', 'test-printers', 'طابعات', 'Printers', 1);
     INSERT INTO catalogs (id, slug, name_ar, name_en, is_printer_catalog) VALUES ('cat_m', 'test-materials', 'مواد', 'Materials', 0);
     INSERT INTO products (id, slug, name, price_iqd, status) VALUES ('p1', 'p-1', 'One', 100, 'active');
     INSERT INTO products (id, slug, name, price_iqd, status) VALUES ('p2', 'p-2', 'Two', 200, 'active');
     INSERT INTO product_catalogs (product_id, catalog_id, position) VALUES ('p1', 'cat_p', 0);`
  );
  const catalog = new CatalogEntrypoint(ctxStub, envFor(raw));
  assert.equal(await catalog.isPrinterCatalog('cat_p'), true);
  assert.equal(await catalog.isPrinterCatalog('cat_m'), false);
  assert.equal(await catalog.isPrinterCatalog('missing'), false);

  const page = await catalog.listForIndex(null);
  assert.deepEqual(page.rows.map((r) => r.product_id), ['p1', 'p2']);
  assert.deepEqual(page.rows[0].catalog_ids, ['cat_p']);
  assert.equal(page.next, null, 'a short page ends the walk');
  assert.deepEqual((await catalog.listForIndex('p1')).rows.map((r) => r.product_id), ['p2']);
});

// ---------------------------------------------------------------------- Orders

test('canAccessOrder decides from the order row, never from what the caller claims to be', async () => {
  resetEventBus();
  const raw = freshDb();
  seedUser(raw, 'buyer');
  seedUser(raw, 'stranger');
  seedUser(raw, 'boss', 'admin');
  raw.exec(
    `INSERT INTO orders (id, user_id, address_snapshot, delivery_method_id, delivery_method_snapshot, payment_method_id, subtotal_iqd, total_iqd, exchange_rate, due_on_delivery_iqd)
     VALUES ('ORD-1', 'buyer', '{}', 'dm', '{}', 'cash', 100, 100, 1400, 0)`
  );
  const orders = new OrdersEntrypoint(ctxStub, envFor(raw));
  assert.deepEqual(await orders.canAccessOrder('ORD-1', 'buyer'), { allowed: true, role: 'owner' });
  assert.deepEqual(await orders.canAccessOrder('ORD-1', 'boss'), { allowed: true, role: 'admin' });
  assert.deepEqual(await orders.canAccessOrder('ORD-1', 'stranger'), { allowed: false, role: null });
  assert.deepEqual(await orders.canAccessOrder('missing', 'buyer'), { allowed: false, role: null });
});

test('itemSnapshots answers the frozen objects, which is what keeps OrderDelivered small', async () => {
  resetEventBus();
  const raw = freshDb();
  seedUser(raw, 'buyer');
  raw.exec(
    `INSERT INTO orders (id, user_id, address_snapshot, delivery_method_id, delivery_method_snapshot, payment_method_id, subtotal_iqd, total_iqd, exchange_rate, due_on_delivery_iqd)
       VALUES ('ORD-1', 'buyer', '{}', 'dm', '{}', 'cash', 100, 100, 1400, 0);
     INSERT INTO products (id, slug, name, price_iqd, status, ops_policy) VALUES ('p1', 'p-1', 'One', 100, 'active', '{"class":"printer"}');
     INSERT INTO order_items (id, order_id, product_id, name_snapshot, qty, unit_price_iqd, line_total_iqd, warranty_snapshot)
       VALUES ('oi_1', 'ORD-1', 'p1', 'One', 2, 100, 200, '{"plan_id":"wp_24","months":24}')`
  );
  const [item] = await new OrdersEntrypoint(ctxStub, envFor(raw)).itemSnapshots('ORD-1');
  assert.equal(item.order_item_id, 'oi_1');
  assert.equal(item.qty, 2);
  assert.equal(item.warranty_plan_id, 'wp_24');
  assert.deepEqual(item.warranty_snapshot, { plan_id: 'wp_24', months: 24 });
  assert.deepEqual(item.ops_policy, { class: 'printer' });
});

/**
 * EVERY HOP-GUARDED METHOD MUST HAVE AN ALLOWLIST ENTRY.
 *
 * `assertHop` resolves its allowlist through `allowedIssuersFor(CORE_METHOD_CALLERS,
 * '<Class>.<method>')`, and `allowedIssuersFor` returns `[]` for a method it has
 * never heard of. So a method that calls `assertHop` without an entry here is not
 * merely unrestricted — it is UNREACHABLE the moment `ALLOWED_CALLER_KIDS` is
 * set, for every caller, including a correctly signed one, and it presents as a
 * mysterious 403 in the calling service rather than as a configuration error.
 * `IdentityEntrypoint.lookupContacts` was in exactly that state.
 *
 * The class and method names are read out of the source, so the next method
 * added cannot silently become unreachable.
 */
test('every assertHop() call site in worker/entrypoints has a CORE_METHOD_CALLERS entry', () => {
  const dir = join(ROOT, 'worker', 'entrypoints');
  const missing: string[] = [];
  const seen: string[] = [];
  for (const file of readdirSync(dir).filter((f) => f.endsWith('Entrypoint.ts'))) {
    const src = readFileSync(join(dir, file), 'utf8');
    const cls = file.replace(/\.ts$/, '');
    for (const m of src.matchAll(/this\.assertHop\(\s*'([A-Za-z0-9_]+)'/g)) {
      const qualified = `${cls}.${m[1]}`;
      seen.push(qualified);
      const allowed = CORE_METHOD_CALLERS[qualified];
      if (!Array.isArray(allowed) || allowed.length === 0) missing.push(qualified);
    }
  }
  assert.ok(seen.length >= 18, `expected to find the entrypoint methods, found ${seen.length}`);
  assert.deepEqual(missing, [], `these methods fail closed for EVERY caller once the hop is on:\n${missing.join('\n')}`);

  // …and the reverse: an entry naming a method that does not exist is a
  // permission granted to nothing, which hides the next real omission. The one
  // exception is a method the plan has allocated but not yet written, and it
  // has to be named HERE to count as one.
  const PLANNED = ['IdentityEntrypoint.redeemHandoff']; // Studio SSO over the binding, plan slice 2.4
  const stale = Object.keys(CORE_METHOD_CALLERS).filter((k) => !seen.includes(k) && !PLANNED.includes(k));
  assert.deepEqual(stale, [], `these allowlist entries name no assertHop() call site:\n${stale.join('\n')}`);
});

test('the gateway is never allowed a contact, money or role method', () => {
  for (const [method, callers] of Object.entries(CORE_METHOD_CALLERS)) {
    if (!(callers as string[]).includes('gateway')) continue;
    assert.match(method, /^IdentityEntrypoint\.(introspect|resolveSession|revoke)$/, `${method} is not a gateway concern (ADR-015)`);
  }
  assert.ok(!(CORE_METHOD_CALLERS['IdentityEntrypoint.lookupContacts'] as string[]).includes('gateway'));
  assert.ok(!(CORE_METHOD_CALLERS['IdentityEntrypoint.lookupContacts'] as string[]).includes('*'), 'contacts in bulk are never open to every service');
});
