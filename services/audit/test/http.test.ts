/**
 * `/api/v1/audit/admin/*`: who may read the log, and what the two routes
 * answer. The whole authorisation path is real — a principal signed with a key
 * generated in the test, published through the bootstrap allowlist var exactly
 * as the deploy publishes it, and verified by the service.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { AuditEventsResponse, AuditVerifyResponse } from '@levonis/contracts/http/audit';
import { PRINCIPAL_HEADER } from '@levonis/contracts/http/common';
import { buildPrincipal, signPrincipal, type MintInput } from '@levonis/platform-kit/principal';
import { generateKeyPair, importSigningKey } from '@levonis/platform-kit/keys';
import { createApp } from '../src/http';
import { auditConsumer } from '../src/consumer';
import { sealOnce } from '../src/seal';
import type { Env } from '../src/env';
import { auditDb } from './_db';
import { fixture, producers } from './_events';

async function stack(opts: { issuer?: string } = {}) {
  const { db, raw } = auditDb();
  const material = await generateKeyPair();
  const signer = await importSigningKey(material.privateKeyB64, material.publicKeyB64);
  const issuer = opts.issuer ?? 'identity';
  const env: Env = {
    DB: db,
    // exactly the shape the deploy writes: service:kid:publicKey
    ALLOWED_CALLER_KIDS: `${issuer}:${material.kid}:${material.publicKeyB64}`,
    SVC_VERSION: 'test',
  };
  const app = createApp();
  const principal = async (patch: Partial<MintInput> = {}) => {
    const input: MintInput = {
      sub: 'usr_admin',
      sid_hash: 'sid',
      role: 'admin',
      scope: 'full',
      investor: false,
      tier: null,
      locale: 'en',
      host_kind: 'main',
      cid: 'cid_1',
      ...patch,
    };
    return signPrincipal(signer, buildPrincipal(input, Math.floor(Date.now() / 1000)));
  };
  const get = (path: string, header?: string) =>
    app.fetch(new Request(`https://audit.internal${path}`, { headers: header ? { [PRINCIPAL_HEADER]: header } : {} }), env);
  return { db, raw, env, app, principal, get };
}

async function seed(db: D1Database, keys: string[]): Promise<void> {
  const p = await producers();
  const consumer = auditConsumer({ keys: p.ring });
  for (const key of keys) await consumer.deliver(db, [await p.sign(fixture(key))]);
  await sealOnce(db, { chainKey: undefined, limit: 100, now: new Date().toISOString() });
}

test('health answers without a principal — a probe that must authenticate cannot report broken authentication', async () => {
  const s = await stack();
  const res = await s.get('/health');
  assert.equal(res.status, 200);
  // The legacy fields stay, and §11.3's report is added on top: `checks.db` is
  // what makes the dark twin's URL a real probe rather than a liveness ping —
  // a `/health` that never touches D1 answers `ok` for a Worker whose tables
  // are all missing.
  assert.deepEqual(await res.json(), {
    success: true,
    status: 'ok',
    version: 'test',
    ok: true,
    svc: 'audit',
    ver: 'test',
    checks: { db: 'ok' },
  });
});

test('no principal is 401, and the body is the platform envelope', async () => {
  const s = await stack();
  for (const path of ['/api/v1/audit/admin/events', '/api/v1/audit/admin/verify']) {
    const res = await s.get(path);
    assert.equal(res.status, 401, path);
    assert.deepEqual(await res.json(), { success: false, error: 'Authentication required', code: 'UNAUTHORIZED' });
  }
});

test('a customer is 401 by verification, an assistant admin is 403, a full admin reads', async () => {
  const s = await stack();
  await seed(s.db, ['RoleChanged.v1', 'DepositDecided.v1']);

  const customer = await s.get('/api/v1/audit/admin/events', await s.principal({ role: 'customer', scope: null }));
  assert.equal(customer.status, 403, 'a signed non-admin principal is refused, not authenticated away');

  const assistant = await s.get('/api/v1/audit/admin/events', await s.principal({ scope: 'assistant' }));
  assert.equal(assistant.status, 403);
  assert.equal((await assistant.json() as { code: string }).code, 'FORBIDDEN');

  const admin = await s.get('/api/v1/audit/admin/events', await s.principal());
  assert.equal(admin.status, 200);
  const body = (await admin.json()) as AuditEventsResponse;
  assert.equal(body.success, true);
  assert.equal(body.rows.length, 2);
  assert.equal(body.next, null);
  const row = body.rows[0];
  for (const field of ['id', 'seq', 'prev_hash', 'hash', 'event_id', 'action', 'target', 'source_service', 'created_at']) {
    assert.ok(field in row, `the row is the AuditRow contract: ${field} is missing`);
  }
  assert.match(row.hash, /^[0-9a-f]{64}$/, 'a sealed row carries its chain hash');
});

test('a principal signed by anyone but Identity is refused, and so is one minted on a merchant host', async () => {
  const wrongIssuer = await stack({ issuer: 'ads' });
  const forged = await wrongIssuer.get('/api/v1/audit/admin/events', await wrongIssuer.principal());
  assert.equal(forged.status, 401, 'only Identity (the core until Phase 9) may sign a principal');

  const s = await stack();
  const merchant = await s.get('/api/v1/audit/admin/events', await s.principal({ host_kind: 'merchant' }));
  assert.equal(merchant.status, 401, 'admin surfaces are apex-only, and the service checks it too');
});

test('the query string drives the filters and the cursor', async () => {
  const s = await stack();
  await seed(s.db, ['RoleChanged.v1', 'DepositDecided.v1', 'OrderCreated.v1', 'UserCreated.v1']);
  const header = await s.principal();

  const page = (await (await s.get('/api/v1/audit/admin/events?limit=2', header)).json()) as AuditEventsResponse;
  assert.equal(page.rows.length, 2);
  assert.ok(page.next);
  const next = (await (await s.get(`/api/v1/audit/admin/events?limit=2&cursor=${page.next}`, header)).json()) as AuditEventsResponse;
  assert.equal(next.rows.length, 2);
  assert.equal(next.next, null);

  const filtered = (await (await s.get('/api/v1/audit/admin/events?action=user.role_changed', header)).json()) as AuditEventsResponse;
  assert.equal(filtered.rows.length, 1);

  const nothing = (await (await s.get('/api/v1/audit/admin/events?action=nope', header)).json()) as AuditEventsResponse;
  assert.deepEqual(nothing.rows, []);
});

test('verify reports the chain, and reports it broken after a row is edited behind the service', async () => {
  const s = await stack();
  await seed(s.db, ['RoleChanged.v1', 'DepositDecided.v1', 'OrderCreated.v1']);
  const header = await s.principal();

  const ok = (await (await s.get('/api/v1/audit/admin/verify', header)).json()) as AuditVerifyResponse;
  assert.equal(ok.ok, true);
  assert.equal(ok.checked, 3);
  assert.equal(ok.anchored_head, null);
  assert.match(ok.head, /^[0-9a-f]{64}$/);
  assert.equal('broken_at' in ok, false, 'an intact chain reports no broken link');

  s.raw.exec("UPDATE audit_events SET target = 'user:someone_else' WHERE chain_index = 2");
  const broken = (await (await s.get('/api/v1/audit/admin/verify', header)).json()) as AuditVerifyResponse;
  assert.equal(broken.ok, false);
  assert.equal(broken.broken_at, 2);
});

test('an unknown path under the service is a 404 in the platform envelope, never an unhandled throw', async () => {
  const s = await stack();
  const res = await s.get('/api/v1/audit/admin/nope', await s.principal());
  assert.equal(res.status, 404);
  assert.deepEqual(await res.json(), { success: false, error: 'Not found', code: 'NOT_FOUND' });
});
