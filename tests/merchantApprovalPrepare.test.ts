/**
 * COMMUNITY V3 PUSH 1.3 — EVERY EXISTING MERCHANT APPLIES (owner decisions C1,
 * C2; DECISIONS row 260), and the server half of wave 1.
 *
 *   - migration 0205: a DRAFT application for each unapproved merchant that
 *     has none, pre-filled with PUBLIC fields only; idempotent; no
 *     `approved_at` anywhere; a system 'created' event per draft;
 *   - the notice: once per merchant, in-app, ids only, on the next workspace
 *     load (GET /api/merchant/me) — never for an approved merchant;
 *   - product DRAFTS stay open under review (`requireDraftPrivileges`), while
 *     publishing — or editing what stays published — is MERCHANT_NOT_APPROVED;
 *   - `/api/merchant/me` says `selling.canDraft`; the attention read carries
 *     the readiness facts (approval, reach, pickup, services).
 *
 * Run: node --import tsx --test tests/merchantApprovalPrepare.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { all, asD1, count, dbThrough, get, json, patch, post, row, stubApp, type StubUser } from './fixtures/app';
import { ROOT } from './fixtures/d1';
import { merchantRoutes } from '../worker/routes/merchant';
import { merchantCatalogRoutes } from '../worker/routes/merchantCatalog';
import { merchantAttentionRoutes } from '../worker/routes/merchantWorkspace';
import { APPROVAL_REQUIRED_LINK, approvalRequiredNotice, MERCHANT_KINDS } from '../worker/lib/merchantNotify';

const MIGRATION = readFileSync(join(ROOT, 'migrations', '0205_merchant_application_backfill.sql'), 'utf8');
const FUTURE = '2099-01-01T00:00:00.000Z';
const STAMP = '2026-10-18T09:00:00.000Z';
const PHONE = '07701234567';

/**
 * The live shapes of gap §3.9 on a database at 0204 (anonymised):
 *   m1 S2  an onboarded store, with public links, a private phone and a governorate;
 *   m2 S1  a store-less community profile;
 *   m3     approved by a reviewer (push 1.2) — needs nothing;
 *   m4     already holds its own live draft — kept as it is;
 *   m5     its last application was rejected — keeps the reviewer's answer (C8);
 *   m6 S5  a suspended merchant — applies like everyone (the sanction is its own axis);
 *   m7 S3+S4  `verified = 1` with its admin audit row, and a store its merchant paused —
 *          the verified mark is not an approval (C1, C4): a draft like everyone;
 *   m8 S6  an admin-owned test merchant — a draft, and no self-approval.
 */
function world(): DatabaseSync {
  const raw = dbThrough('0204');
  raw.exec(`
    INSERT INTO users (id,name,email,password_hash,role,username) VALUES
      ('u1','Ali Hassan','u1@x.co','h','merchant','u1'), ('u2','Sara Kareem','u2@x.co','h','merchant','u2'),
      ('u3','Omar','u3@x.co','h','merchant','u3'), ('u4','Huda','u4@x.co','h','merchant','u4'),
      ('u5','Zaid','u5@x.co','h','merchant','u5'), ('u6','Noor','u6@x.co','h','merchant','u6'),
      ('u7','Layla','u7@x.co','h','merchant','u7'), ('u8','Staff Tester','u8@x.co','h','admin','u8'),
      ('boss','Boss','boss@x.co','h','admin','boss');
    INSERT INTO community_merchants (id,user_id,name,bio,status,phone,governorate,approved_at) VALUES
      ('m1','u1','Ali Hassan','profile bio','active','${PHONE}','baghdad',NULL),
      ('m2','u2','Sara Prints','I print miniatures','active','${PHONE}','basra',NULL),
      ('m3','u3','Omar','x','active','',  '',  '${STAMP}'),
      ('m4','u4','Huda','x','active','','',NULL),
      ('m5','u5','Zaid','x','active','','',NULL),
      ('m6','u6','Noor','x','suspended','','',NULL),
      ('m7','u7','Layla','x','active','','',NULL),
      ('m8','u8','Staff Tester','x','active','','',NULL);
    UPDATE community_merchants SET verified = 1 WHERE id = 'm7';
    INSERT INTO audit_log (actor_id, action, target, detail) VALUES ('boss','admin.merchant_verified','m7','{"verified":true}');
    INSERT INTO merchant_stores (id,merchant_id,user_id,slug,name,status) VALUES
      ('s7','m7','u7','layla','Layla Prints','paused'), ('s8','m8','u8','staff-test','Staff Test','active');
    INSERT INTO merchant_stores (id,merchant_id,user_id,slug,name,tagline,description,contact_phone,governorate,profile_links,social_links)
      VALUES ('s1','m1','u1','dragon','Dragon Forge','Prints for everyone','  Our long description  ','${PHONE}','baghdad',
        '[{"icon":"link","title":"Site","url":"https://dragon.example/shop","visible":true},
          {"icon":"link","title":"Old","url":"https://hidden.example","visible":false},
          {"icon":"link","title":"Plain","url":"http://insecure.example"},
          {"icon":"link","title":"Creds","url":"https://user:pw@evil.example/x"},
          {"icon":"link","title":"Dup","url":"https://dragon.example/shop"}]',
        '{"instagram":"https://instagram.com/dragonforge","whatsapp":"https://wa.me/9647701234567","tiktok":"https://www.tiktok.com/@dragonforge"}');
    INSERT INTO merchant_applications (id,user_id,state,revision,public_name) VALUES ('mapp_own','u4','draft',1,'Huda own');
    INSERT INTO merchant_application_events (id,application_id,revision,actor_id,actor_kind,action,operation_id)
      VALUES ('mape_own','mapp_own',1,'u4','applicant','created','create:mapp_own');
    INSERT INTO merchant_applications (id,user_id,state,revision,reason_public,decided_at) VALUES
      ('mapp_rej','u5','rejected',1,'ADD-A-CLEARER-PHOTO','${STAMP}');
  `);
  return raw;
}

const migrate = (raw: DatabaseSync) => raw.exec(MIGRATION);

test('0205: a DRAFT for every unapproved merchant with no application — and nobody else', () => {
  const raw = world();
  migrate(raw);
  const drafts = all<{ user_id: string; state: string; revision: number }>(
    raw,
    "SELECT user_id, state, revision FROM merchant_applications WHERE id NOT IN ('mapp_own','mapp_rej') ORDER BY user_id"
  );
  assert.deepEqual(drafts, [
    { user_id: 'u1', state: 'draft', revision: 1 },
    { user_id: 'u2', state: 'draft', revision: 1 },
    { user_id: 'u6', state: 'draft', revision: 1 },
    { user_id: 'u7', state: 'draft', revision: 1 },
    { user_id: 'u8', state: 'draft', revision: 1 },
  ]);
  // The approved merchant needs none; the one with its own draft keeps exactly that one; the rejected one keeps its answer.
  assert.equal(count(raw, "SELECT COUNT(*) AS n FROM merchant_applications WHERE user_id = 'u3'"), 0);
  assert.equal(count(raw, "SELECT COUNT(*) AS n FROM merchant_applications WHERE user_id = 'u4'"), 1);
  assert.equal(row<{ public_name: string }>(raw, "SELECT public_name FROM merchant_applications WHERE user_id = 'u4'")!.public_name, 'Huda own');
  assert.equal(count(raw, "SELECT COUNT(*) AS n FROM merchant_applications WHERE user_id = 'u5'"), 1);
  // Every id has the applicant route's shape.
  for (const r of all<{ id: string }>(raw, "SELECT id FROM merchant_applications WHERE id NOT IN ('mapp_own','mapp_rej')")) {
    assert.match(r.id, /^mapp_[0-9a-f]{20}$/);
  }
});

test('0205: PUBLIC fields only — what the storefront already shows, never a private value', () => {
  const raw = world();
  migrate(raw);
  const a = row<Record<string, unknown>>(raw, "SELECT * FROM merchant_applications WHERE user_id = 'u1'")!;
  assert.equal(a.public_name, 'Dragon Forge', 'the store name');
  assert.equal(a.public_bio, 'Our long description', 'the store description, trimmed');
  assert.deepEqual(JSON.parse(String(a.public_links)), [
    'https://dragon.example/shop',
    'https://instagram.com/dragonforge',
    'https://www.tiktok.com/@dragonforge',
  ], 'visible https links once each, then the social links; no hidden, plain-http, credential or phone link');
  // The sealed private columns stay empty, no photo, and no review context is guessed.
  for (const k of ['legal_name_enc', 'dob_enc', 'social_link_enc', 'governorate', 'activity_kind', 'activity_description', 'reason_public', 'note_internal']) {
    assert.equal(a[k], '', k);
  }
  for (const k of ['photo_key', 'submitted_at', 'decided_by', 'decided_at', 'retention_until', 'purged_at']) assert.equal(a[k], null, k);
  // Nothing in the whole row is the phone, the governorate or the account's legal-looking name.
  const whole = JSON.stringify(a);
  assert.doesNotMatch(whole, /7701234567|baghdad|Ali Hassan|u1@x\.co/);

  const b = row<Record<string, unknown>>(raw, "SELECT * FROM merchant_applications WHERE user_id = 'u2'")!;
  assert.equal(b.public_name, 'Sara Prints', 'a store-less merchant: the profile name');
  assert.equal(b.public_bio, 'I print miniatures');
  assert.equal(b.public_links, '[]');
  assert.doesNotMatch(JSON.stringify(b), /7701234567|basra/);
});

test('0205: nobody is approved — not a single approved_at or approved application is written', () => {
  const raw = world();
  const before = all(raw, 'SELECT id, approved_at, approved_application_id, status, verified FROM community_merchants ORDER BY id');
  const stores = all(raw, 'SELECT * FROM merchant_stores ORDER BY id');
  migrate(raw);
  assert.deepEqual(all(raw, 'SELECT id, approved_at, approved_application_id, status, verified FROM community_merchants ORDER BY id'), before);
  assert.deepEqual(all(raw, 'SELECT * FROM merchant_stores ORDER BY id'), stores, 'every store row untouched — a paused one stays paused');
  assert.equal(count(raw, 'SELECT COUNT(*) AS n FROM community_merchants WHERE approved_at IS NOT NULL'), 1, 'only the reviewer-approved merchant');
  assert.equal(count(raw, "SELECT COUNT(*) AS n FROM merchant_applications WHERE state = 'approved'"), 0);
  assert.doesNotMatch(MIGRATION.replace(/--[^\n]*/g, ''), /approved_at\s*=|UPDATE\s+community_merchants/i);
});

test('0205: the trail — one system "created" event per backfilled draft, none for the rest', () => {
  const raw = world();
  migrate(raw);
  const events = all<{ application_id: string; actor_id: string | null; actor_kind: string; action: string; operation_id: string; revision: number }>(
    raw,
    "SELECT application_id, actor_id, actor_kind, action, operation_id, revision FROM merchant_application_events WHERE actor_kind = 'system'"
  );
  assert.equal(events.length, 5);
  for (const e of events) {
    assert.equal(e.actor_id, null);
    assert.equal(e.action, 'created');
    assert.equal(e.revision, 1);
    assert.equal(e.operation_id, `backfill:${e.application_id}`);
  }
  assert.equal(count(raw, "SELECT COUNT(*) AS n FROM merchant_application_events WHERE application_id = 'mapp_own'"), 1, 'the applicant\'s own trail is untouched');
});

test('0205 is idempotent: a second run adds no application, no event and changes no value', () => {
  const raw = world();
  migrate(raw);
  const apps = all(raw, 'SELECT * FROM merchant_applications ORDER BY id');
  const events = all(raw, 'SELECT * FROM merchant_application_events ORDER BY id');
  migrate(raw);
  assert.deepEqual(all(raw, 'SELECT * FROM merchant_applications ORDER BY id'), apps);
  assert.deepEqual(all(raw, 'SELECT * FROM merchant_application_events ORDER BY id'), events);
});

test('0205 on an empty database writes nothing (the deploy runs it before any merchant exists in a test)', () => {
  const raw = dbThrough('0204');
  migrate(raw);
  assert.equal(count(raw, 'SELECT COUNT(*) AS n FROM merchant_applications'), 0);
});

// ------------------------------------------------------------- the notice

const user = (id: string): StubUser => ({ id, role: 'merchant', email: `${id}@x.co` });
const meApp = (raw: DatabaseSync, id: string) =>
  stubApp(asD1(raw), user(id), (a) => {
    a.route('/api/merchant/attention', merchantAttentionRoutes);
    a.route('/api/merchant', merchantRoutes);
    a.route('/api/merchant', merchantCatalogRoutes);
  }, { env: { STORE_ROOT_DOMAIN: 'levonis-iq.com' } });

const notices = (raw: DatabaseSync, userId: string) =>
  all<Record<string, string>>(raw, "SELECT * FROM user_notifications WHERE user_id = ? AND event_key LIKE 'approval_required:%'", userId);

function plus(raw: DatabaseSync, userId: string) {
  raw.prepare(
    `INSERT INTO memberships (id,user_id,plan_id,tier,state,duration_months,starts_at,expires_at)
     VALUES (?,?,'plus_12mo','plus','active',12,'2026-01-01T00:00:00.000Z',?)`
  ).run(`mem_${userId}`, userId, FUTURE);
}

test('the notice: ONCE per merchant, on the next workspace load — a reload writes nothing more', async () => {
  const raw = world();
  migrate(raw);
  const res = await get(meApp(raw, 'u1'), '/api/merchant/me');
  assert.equal(res.status, 200);
  assert.equal((await json(res)).application.state, 'draft');
  assert.equal(notices(raw, 'u1').length, 1);
  for (let i = 0; i < 3; i++) await get(meApp(raw, 'u1'), '/api/merchant/me');
  assert.equal(notices(raw, 'u1').length, 1, 'the event key makes a replay a no-op');
  // The store-less merchant hears it too (the main site's /me is their workspace).
  await get(meApp(raw, 'u2'), '/api/merchant/me');
  assert.equal(notices(raw, 'u2').length, 1);
});

test('the notice is ID-ONLY: fixed words in three languages, the merchant id, the application link — no name, store or phone', async () => {
  const raw = world();
  migrate(raw);
  await get(meApp(raw, 'u1'), '/api/merchant/me');
  const [n] = notices(raw, 'u1');
  assert.equal(n.kind, 'store_status_changed');
  assert.ok((MERCHANT_KINDS as readonly string[]).includes(n.kind), 'listed in the merchant notification centre');
  assert.equal(n.link, APPROVAL_REQUIRED_LINK);
  assert.equal(n.link, '/merchant/start');
  assert.equal(n.entity_type, 'store');
  assert.equal(n.entity_id, 'm1');
  assert.equal(n.event_key, 'approval_required:m1');
  const meta = JSON.parse(n.meta) as Record<string, string>;
  assert.equal(meta.status, 'approval_required');
  assert.ok(meta.title_ckb && meta.body_ckb);
  assert.notEqual(meta.title_ckb, n.title_ar);
  assert.match(meta.title_ckb + meta.body_ckb, /[ەێۆڕڵ]/u, 'real Sorani, not the Arabic');
  const words = JSON.stringify(n);
  assert.doesNotMatch(words, /Dragon|Ali|Hassan|7701234567|baghdad|u1@x/);
  // The same text for every merchant — only the id differs.
  const a = approvalRequiredNotice('m1');
  const b = approvalRequiredNotice('m2');
  assert.deepEqual({ ...a, entity_id: '', eventKey: '' }, { ...b, entity_id: '', eventKey: '' });
});

test('no notice for an approved merchant, one in review, one rejected, or a database without the backfill', async () => {
  const raw = world();
  migrate(raw);
  raw.exec("UPDATE merchant_applications SET state = 'in_review' WHERE user_id = 'u4'");
  for (const id of ['u3', 'u4', 'u5']) await get(meApp(raw, id), '/api/merchant/me');
  for (const id of ['u3', 'u4', 'u5']) assert.equal(notices(raw, id).length, 0, id);
  // 0204 without 0205: no draft to finish, so nothing is said yet.
  const early = world();
  await get(meApp(early, 'u1'), '/api/merchant/me');
  assert.equal(notices(early, 'u1').length, 0);
});

// --------------------------------------------------------------- drafts

const PRODUCT = { name: 'Dragon lamp', price_iqd: 15000 };

test('under review a product DRAFT saves; publishing it, or creating one published, is MERCHANT_NOT_APPROVED', async () => {
  const raw = world();
  migrate(raw);
  plus(raw, 'u1');
  const m = meApp(raw, 'u1');
  const draft = await post(m, '/api/merchant/products', { ...PRODUCT, state: 'draft' });
  assert.equal(draft.status, 201, JSON.stringify(await draft.clone().json()));
  const id = (await json(draft)).product.id as string;
  const edit = await patch(m, `/api/merchant/products/${id}`, { name: 'Dragon lamp v2' });
  assert.equal(edit.status, 200, 'a draft stays editable');
  for (const [name, call] of [
    ['create with no state (published by default)', () => post(m, '/api/merchant/products', PRODUCT)],
    ['create published', () => post(m, '/api/merchant/products', { ...PRODUCT, state: 'published' })],
    ['publish the draft', () => patch(m, `/api/merchant/products/${id}`, { state: 'published' })],
  ] as const) {
    const res = await call();
    assert.equal(res.status, 403, name);
    assert.equal((await json(res)).code, 'MERCHANT_NOT_APPROVED', name);
  }
  assert.equal(row<{ publish_state: string; name: string }>(raw, 'SELECT publish_state, name FROM community_products WHERE id = ?', id)!.publish_state, 'draft');
});

test('under review an already PUBLISHED product cannot be edited as published, but may be taken down to a draft', async () => {
  const raw = world();
  migrate(raw);
  plus(raw, 'u1');
  raw.exec(`INSERT INTO community_products (id,merchant_id,store_id,slug,name,status,publish_state,price_iqd,stock,track_stock)
            VALUES ('cpp','m1','s1','lamp','Lamp','active','published',9000,3,1)`);
  const m = meApp(raw, 'u1');
  const price = await patch(m, '/api/merchant/products/cpp', { price_iqd: 8000 });
  assert.equal(price.status, 403);
  assert.equal((await json(price)).code, 'MERCHANT_NOT_APPROVED');
  const down = await patch(m, '/api/merchant/products/cpp', { state: 'draft' });
  assert.equal(down.status, 200, 'taking a promise back is never refused');
  assert.equal(row<{ publish_state: string }>(raw, "SELECT publish_state FROM community_products WHERE id = 'cpp'")!.publish_state, 'draft');
});

test('the draft gate is still the selling gate otherwise: no PLUS, a pause or a suspension still refuse a draft', async () => {
  const raw = world();
  migrate(raw);
  // No PLUS at all.
  const none = await post(meApp(raw, 'u1'), '/api/merchant/products', { ...PRODUCT, state: 'draft' });
  assert.equal((await json(none)).code, 'SUBSCRIPTION_INACTIVE');
  plus(raw, 'u1');
  raw.exec("UPDATE merchant_stores SET status = 'paused' WHERE id = 's1'");
  assert.equal((await json(await post(meApp(raw, 'u1'), '/api/merchant/products', { ...PRODUCT, state: 'draft' }))).code, 'STORE_PAUSED');
  raw.exec("UPDATE merchant_stores SET status = 'active' WHERE id = 's1'; UPDATE community_merchants SET status = 'suspended' WHERE id = 'm1'");
  assert.equal((await json(await post(meApp(raw, 'u1'), '/api/merchant/products', { ...PRODUCT, state: 'draft' }))).code, 'MERCHANT_SUSPENDED');
});

test('/api/merchant/me says canDraft: open under review with PLUS, closed when paused, open when approved', async () => {
  const raw = world();
  migrate(raw);
  plus(raw, 'u1');
  const read = async () => (await json(await get(meApp(raw, 'u1'), '/api/merchant/me'))).selling as Record<string, unknown>;
  assert.deepEqual(await read(), { canSell: false, reason: 'not_approved', canDraft: true });
  raw.exec("UPDATE merchant_stores SET status = 'paused' WHERE id = 's1'");
  assert.equal((await read()).canDraft, false);
  raw.exec(`UPDATE merchant_stores SET status = 'active' WHERE id = 's1'; UPDATE community_merchants SET approved_at = '${STAMP}' WHERE id = 'm1'`);
  assert.deepEqual(await read(), { canSell: true, reason: '', canDraft: true });
});

// ------------------------------------------------------- readiness facts

test('the attention read carries the readiness facts: approval, governorates reached, pickup, services', async () => {
  const raw = world();
  migrate(raw);
  plus(raw, 'u1');
  const setup = async () => (await json(await get(meApp(raw, 'u1'), '/api/merchant/attention'))).attention.setup as Record<string, unknown>;
  let s = await setup();
  assert.equal(s.approved, false);
  assert.equal(s.phone, true);
  assert.equal(s.services, 0);
  assert.equal(typeof s.reach, 'number');
  assert.equal(typeof s.pickup, 'boolean');
  raw.exec(`
    INSERT INTO merchant_delivery_profiles (store_id, default_mode, pickup_enabled, pickup_governorate) VALUES ('s1','disabled',0,'');
    INSERT INTO merchant_services (id,store_id,merchant_id,title) VALUES ('sv1','s1','m1','Printing');
    UPDATE community_merchants SET approved_at = '${STAMP}' WHERE id = 'm1';
  `);
  s = await setup();
  assert.equal(s.approved, true);
  assert.equal(s.reach, 0, 'delivery switched off everywhere reaches nobody');
  assert.equal(s.pickup, false);
  assert.equal(s.services, 1);
  raw.exec("INSERT INTO merchant_delivery_rules (store_id, governorate_id, mode) VALUES ('s1','basra','free')");
  s = await setup();
  assert.equal(s.reach, 1);
  assert.equal((s.links as Record<string, string>).services, '/merchant/services');
});
