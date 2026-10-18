/**
 * «طلبات اعتماد التجار» — THE REVIEWER'S SIDE OF THE MERCHANT APPLICATION
 * (Community V3 push 1.2, DECISIONS row 257; gap §3.2–§3.3, §3.7).
 *
 * Proves, on the real routes and a fully migrated database:
 *   - the scope matrix (owner decision C5): the owner and a full admin review;
 *     an assistant reviews only with a live MERCHANT_REVIEW grant, and loses
 *     it on the next request after a revoke; a customer and a guest never
 *     reach the router; nobody decides their own application;
 *   - the owner alone grants and revokes (fresh sign-in to grant; a full
 *     admin needs no grant; a customer cannot hold one); the session hint
 *     `can_review_merchants` is the same rule;
 *   - the grant opens NOTHING financial: a reviewing assistant still hears
 *     403 FINANCIAL_SCOPE_REQUIRED at a money route of adminCommunity;
 *   - decisions are revision- and operation-guarded: two reviewers racing on
 *     one revision — exactly one wins; a replayed operation id writes nothing;
 *     an operation id reused for another move is refused; a stale revision is
 *     APPLICATION_CHANGED;
 *   - the queue never carries a legal name, a date of birth, the activity
 *     link, the photo or a user id; the detail decrypts once and is audited
 *     before anything is opened; the photo is no-store, audited and confined
 *     to its application's prefix;
 *   - `note_internal` never reaches the applicant (their GET, their writes,
 *     /api/merchant/me);
 *   - a revision never SENT is never a reviewer's — a draft, a draft
 *     withdrawn unsent, values edited after a reopen and then withdrawn —
 *     and such a withdrawal is purged at once (final check, row 257);
 *   - approve creates NO store and no public merchant row (the row is born
 *     with the store at /onboard);
 *   - Telegram notices carry ids only; a database without 0204 fails closed.
 *
 * Fixtures are anonymised: invented names, a placeholder link, a key minted
 * per run.
 *
 * Run: node --import tsx --test tests/merchantReview.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { DatabaseSync } from 'node:sqlite';
import { freshDb, dbThrough, asD1, stubApp, get, put, post, json, row, count, memoryBucket, type StubUser } from './fixtures/app';
import { imagesDouble, jpegBytes } from './fixtures/imageDoubles';
import { merchantApplicationRoutes } from '../worker/routes/merchantApplication';
import { adminMerchantApplicationRoutes } from '../worker/routes/adminMerchantApplications';
import { adminCommunityRoutes } from '../worker/routes/adminCommunity';
import { merchantRoutes } from '../worker/routes/merchant';
import { canReviewMerchants, reviewerNoticeText, submittedNoticeText } from '../worker/lib/merchantApproval';
import { canMoveMoney, canReviewMerchantsHint, canViewCost } from '../worker/lib/adminScope';
import { publicUser, type Env, type SessionUser } from '../worker/lib/types';

/** A throwaway 32-byte key minted per run — never a real secret. */
const KEY = `v1:${btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32))))}`;

const OWNER: StubUser = { id: 'u_owner', role: 'admin', email: 'boss@x.co' };
const FULL: StubUser = { id: 'u_full', role: 'admin', email: 'full@example.test', admin_scope: 'full' };
const ASSIST: StubUser = { id: 'u_assist', role: 'admin', email: 'assist@example.test', admin_scope: 'assistant' };
const ASSIST2: StubUser = { id: 'u_assist2', role: 'admin', email: 'assist2@example.test', admin_scope: 'assistant' };
const APPLICANT: StubUser = { id: 'u_app', role: 'customer', email: 'applicant@example.test' };
const APPLICANT2: StubUser = { id: 'u_app2', role: 'customer', email: 'applicant2@example.test' };

// Anonymised, deliberately distinctive values: any appearance where it does not belong is a leak.
const NAME = { given: 'عبد الله', father: 'Zayd Qorvan', grandfather: 'Ibn-Talvar' };
const DOB = '1990-07-14';
const LINK = 'https://www.instagram.com/qorvan.testprints.example';
const PII = [NAME.given, NAME.father, NAME.grandfather, DOB, 'qorvan.testprints.example'];
const NOTE = 'INTERNAL-ONLY-7f3a';

function world(opts: { through?: string } = {}) {
  const raw: DatabaseSync = opts.through ? dbThrough(opts.through) : freshDb();
  raw.exec(`
    INSERT INTO users (id,email,password_hash,role,admin_scope,username) VALUES
      ('u_owner','boss@x.co','h','admin',NULL,'owner'),
      ('u_full','full@example.test','h','admin','full','fulladmin'),
      ('u_assist','assist@example.test','h','admin','assistant','assist'),
      ('u_assist2','assist2@example.test','h','admin','assistant','assist2'),
      ('u_app','applicant@example.test','h','customer',NULL,'orbit'),
      ('u_app2','applicant2@example.test','h','customer',NULL,'nebula');
    INSERT INTO telegram_links (user_id, telegram_user_id, chat_id, phone_e164, verified_at) VALUES
      ('u_app', 9100001, 9100001, '+9647700000000', '2026-01-01T00:00:00.000Z'),
      ('u_app2', 9100002, 9100002, '+9647700000001', '2026-01-01T00:00:00.000Z'),
      ('u_assist', 9100003, 9100003, '+9647700000002', '2026-01-01T00:00:00.000Z'),
      ('u_assist2', 9100004, 9100004, '+9647700000003', '2026-01-01T00:00:00.000Z');
  `);
  // With R2's prefix listing, which the C7 purge reads (a withdrawn draft is purged in its own request).
  const bucket = Object.assign(memoryBucket(), {
    async list(o: { prefix?: string } = {}) {
      const objects = [...bucket.objects.keys()].filter((k) => !o.prefix || k.startsWith(o.prefix)).sort().map((key) => ({ key }));
      return { objects, truncated: false as const, delimitedPrefixes: [] as string[] };
    },
  });
  const images = imagesDouble();
  const env: Record<string, unknown> = { BUCKET: memoryBucket(), KYC_ENC_KEY: KEY, R2_PRIVATE: bucket, IMAGES: images.binding };
  const db = asD1(raw);
  const appAs = (user: StubUser | null, extra: { sessionAgeSeconds?: number } = {}) =>
    stubApp(
      db,
      user,
      (a) => {
        a.route('/api/merchant-application', merchantApplicationRoutes);
        a.route('/api/admin/merchant-applications', adminMerchantApplicationRoutes);
        a.route('/api/admin/community', adminCommunityRoutes);
        a.route('/api/merchant', merchantRoutes);
      },
      { env, ...extra }
    );
  return { raw, db, env, bucket, appAs };
}

type World = ReturnType<typeof world>;
const BASE = '/api/admin/merchant-applications';

const photoForm = () => {
  const fd = new FormData();
  fd.set('file', new File([jpegBytes(640, 480) as unknown as BlobPart], 'selfie.jpg', { type: 'image/jpeg' }));
  return fd;
};

/** A complete, SUBMITTED application of `who`. */
async function submitted(w: World, who: StubUser = APPLICANT, name = 'Orbit Prints'): Promise<string> {
  const app = w.appAs(who);
  const saved = await put(app, '/api/merchant-application', {
    legal_name: NAME,
    dob: DOB,
    social_link: LINK,
    public_name: name,
    public_bio: 'Prints to order.',
    governorate: 'baghdad',
    activity_kind: 'print_services',
    activity_description: 'Custom printing for local customers.',
  });
  assert.equal(saved.status, 200, await saved.clone().text());
  const photo = await app.request('/api/merchant-application/photo', { method: 'POST', body: photoForm() });
  assert.equal(photo.status, 200, await photo.clone().text());
  const sent = await post(app, '/api/merchant-application/submit', { operation_id: `op-submit-${who.id}` });
  assert.equal(sent.status, 200, await sent.clone().text());
  return (await json(sent)).application.id as string;
}

let opCounter = 0;
const op = (tag = 'x') => `op-test-${tag}-${++opCounter}`;

async function decide(w: World, who: StubUser, id: string, action: string, body: Record<string, unknown> = {}) {
  return post(w.appAs(who), `${BASE}/${id}/${action}`, { revision: 1, operation_id: op(action), ...body });
}

const appState = (raw: DatabaseSync, id: string) =>
  row<{ state: string; revision: number; note_internal: string; reason_public: string; decided_by: string | null }>(
    raw,
    'SELECT state, revision, note_internal, reason_public, decided_by FROM merchant_applications WHERE id = ?',
    id
  );

function grant(raw: DatabaseSync, userId: string) {
  raw
    .prepare(
      `INSERT INTO admin_capability_grants (id, user_id, grant_key, granted_by, operation_id) VALUES (?, ?, 'MERCHANT_REVIEW', 'u_owner', ?)`
    )
    .run(`acg_${userId}`, userId, `op-grant-${userId}-seed`);
}

// ------------------------------------------------------------- scope matrix

test('scope matrix: owner and full admin review; an assistant only with the grant; customer, guest and self never decide', async () => {
  const w = world();
  const id = await submitted(w);

  for (const who of [OWNER, FULL]) {
    assert.equal((await get(w.appAs(who), BASE)).status, 200, `${who.id} lists`);
    assert.equal((await get(w.appAs(who), `${BASE}/${id}`)).status, 200, `${who.id} opens`);
  }
  // An assistant without the grant: refused at every door, before any id is read.
  for (const path of [BASE, `${BASE}/${id}`, `${BASE}/${id}/photo`, `${BASE}/mapp_nosuchapplication`]) {
    const res = await get(w.appAs(ASSIST), path);
    assert.equal(res.status, 403, path);
    assert.equal((await json(res)).code, 'MERCHANT_REVIEW_FORBIDDEN');
  }
  const refused = await decide(w, ASSIST, id, 'start-review');
  assert.equal(refused.status, 403);
  assert.equal((await json(refused)).code, 'MERCHANT_REVIEW_FORBIDDEN');
  assert.equal(appState(w.raw, id)!.state, 'submitted', 'a refused move changes nothing');

  // A customer and a guest never reach the router.
  assert.equal((await get(w.appAs(APPLICANT), BASE)).status, 403);
  assert.equal((await get(w.appAs(null), BASE)).status, 401);
  assert.equal((await decide(w, APPLICANT, id, 'approve')).status, 403);

  // With the owner's grant, the same assistant reviews…
  grant(w.raw, ASSIST.id);
  assert.equal((await get(w.appAs(ASSIST), BASE)).status, 200);
  const started = await decide(w, ASSIST, id, 'start-review');
  assert.equal(started.status, 200, await started.clone().text());
  assert.equal((await json(started)).application.state, 'in_review');

  // …and loses it on the very next request after a revoke (the server re-reads the grant).
  const revoked = await post(w.appAs(OWNER), `${BASE}/reviewers/${ASSIST.id}/revoke`, {});
  assert.equal(revoked.status, 200);
  assert.equal((await get(w.appAs(ASSIST), BASE)).status, 403);

  // SELF: an admin who applied sees their row marked, and cannot move it.
  const own = await submitted(w, ASSIST2, 'Assistant Prints');
  grant(w.raw, ASSIST2.id);
  const list = await json(await get(w.appAs(ASSIST2), BASE));
  const mine = (list.applications as Array<{ id: string; own: boolean }>).find((a) => a.id === own)!;
  assert.equal(mine.own, true);
  const self = await post(w.appAs(ASSIST2), `${BASE}/${own}/start-review`, { revision: 1, operation_id: op('self') });
  assert.equal(self.status, 403);
  assert.equal((await json(self)).code, 'SELF_DECISION_FORBIDDEN');
  assert.equal(appState(w.raw, own)!.state, 'submitted');
  // …while another reviewer may.
  assert.equal((await post(w.appAs(FULL), `${BASE}/${own}/start-review`, { revision: 1, operation_id: op('other') })).status, 200);
});

test('the session hint is the same rule: owner, full, granted assistant yes; plain assistant, customer no', async () => {
  const env = { INITIAL_ADMIN_EMAIL: 'boss@x.co' } as unknown as Env;
  const w = world();
  grant(w.raw, ASSIST.id);
  const cases: Array<[StubUser, string[], boolean]> = [
    [OWNER, [], true],
    [FULL, [], true],
    [{ ...FULL, admin_scope: null }, [], true],
    [ASSIST, ['MERCHANT_REVIEW'], true],
    [ASSIST2, [], false],
    [APPLICANT, [], false],
  ];
  for (const [u, grants, want] of cases) {
    const session = { ...u, capability_grants: grants } as unknown as SessionUser;
    assert.equal(canReviewMerchantsHint(env, session), want, `${u.id} hint`);
    assert.equal(publicUser(session, env).can_review_merchants, want, `${u.id} publicUser`);
    assert.equal(await canReviewMerchants({ DB: w.db, INITIAL_ADMIN_EMAIL: 'boss@x.co' }, u as unknown as SessionUser), want, `${u.id} rule`);
  }
  // A grant listed on a non-assistant's session, or a row column of the same name, widens nothing for a customer.
  assert.equal(canReviewMerchantsHint(env, { ...APPLICANT, capability_grants: ['MERCHANT_REVIEW'] } as never), false);
});

// ----------------------------------------------------------- owner's grants

test('grant and revoke are the owner\'s alone; a full admin needs none; a customer cannot hold one; granting needs a fresh sign-in', async () => {
  const w = world();
  for (const who of [FULL, ASSIST, APPLICANT]) {
    for (const [path, body] of [
      [`${BASE}/reviewers/${ASSIST2.id}/grant`, {}],
      [`${BASE}/reviewers/${ASSIST2.id}/revoke`, {}],
    ] as const) {
      const res = await post(w.appAs(who), path, body);
      assert.equal(res.status, 403, `${who.id} ${path}`);
    }
    assert.equal((await get(w.appAs(who), `${BASE}/reviewers`)).status, 403);
  }
  assert.equal(count(w.raw, 'SELECT COUNT(*) AS n FROM admin_capability_grants'), 0);

  // The owner, after a long-lived session: refused until a fresh sign-in.
  const stale = await post(w.appAs(OWNER, { sessionAgeSeconds: 3600 }), `${BASE}/reviewers/${ASSIST2.id}/grant`, {});
  assert.equal(stale.status, 401);
  assert.equal((await json(stale)).code, 'REAUTH_REQUIRED');

  const ok = await post(w.appAs(OWNER), `${BASE}/reviewers/${ASSIST2.id}/grant`, { operation_id: 'op-grant-assist2-1' });
  assert.equal(ok.status, 200, await ok.clone().text());
  assert.deepEqual(await json(ok), { success: true, granted: true, already: false });
  const again = await json(await post(w.appAs(OWNER), `${BASE}/reviewers/${ASSIST2.id}/grant`, { operation_id: 'op-grant-assist2-2' }));
  assert.equal(again.already, true, 'one live grant per key');
  assert.equal(count(w.raw, "SELECT COUNT(*) AS n FROM admin_capability_grants WHERE user_id = 'u_assist2' AND revoked_at IS NULL"), 1);
  assert.equal(count(w.raw, "SELECT COUNT(*) AS n FROM audit_log WHERE action = 'admin.capability_grant.issued' AND target = 'u_assist2'"), 1);

  const full = await post(w.appAs(OWNER), `${BASE}/reviewers/${FULL.id}/grant`, {});
  assert.equal(full.status, 400);
  assert.equal((await json(full)).code, 'CAPABILITY_GRANT_NOT_NEEDED');
  const customer = await post(w.appAs(OWNER), `${BASE}/reviewers/${APPLICANT.id}/grant`, {});
  assert.equal(customer.status, 400);
  assert.equal((await json(customer)).code, 'CAPABILITY_GRANT_TARGET_INVALID');
  const self = await post(w.appAs(OWNER), `${BASE}/reviewers/${OWNER.id}/grant`, {});
  assert.equal((await json(self)).code, 'CAPABILITY_GRANT_TARGET_INVALID');

  const list = await json(await get(w.appAs(OWNER), `${BASE}/reviewers`));
  const byId = new Map((list.reviewers as Array<{ id: string; granted: boolean; by_default: boolean }>).map((r) => [r.id, r]));
  assert.equal(byId.get(ASSIST2.id)!.granted, true);
  assert.equal(byId.get(ASSIST.id)!.granted, false);
  assert.equal(byId.get(FULL.id)!.by_default, true);
  assert.equal(byId.has(OWNER.id), false, 'the owner is not listed as someone to grant');
  assert.ok(!JSON.stringify(list).includes('@example.test'), 'no admin address in the answer');

  const revoke = await json(await post(w.appAs(OWNER), `${BASE}/reviewers/${ASSIST2.id}/revoke`, {}));
  assert.deepEqual(revoke, { success: true, granted: false, already: false });
  assert.equal(count(w.raw, "SELECT COUNT(*) AS n FROM admin_capability_grants WHERE user_id = 'u_assist2' AND revoked_at IS NULL"), 0);
  assert.equal(count(w.raw, "SELECT COUNT(*) AS n FROM audit_log WHERE action = 'admin.capability_grant.revoked' AND target = 'u_assist2'"), 1);
});

test('the review grant opens nothing financial: a reviewing assistant is still refused at a money route', async () => {
  const w = world();
  grant(w.raw, ASSIST.id);
  assert.equal((await get(w.appAs(ASSIST), BASE)).status, 200, 'the assistant reviews');
  const money = await get(w.appAs(ASSIST), '/api/admin/community/merchants/cm_any/finance');
  assert.equal(money.status, 403);
  assert.equal((await json(money)).code, 'FINANCIAL_SCOPE_REQUIRED');
  const resolve = await post(w.appAs(ASSIST), '/api/admin/community/escrows/esc_any/resolve', {});
  assert.equal(resolve.status, 403);
  const env = { INITIAL_ADMIN_EMAIL: 'boss@x.co' } as unknown as Env;
  const session = { ...ASSIST, capability_grants: ['MERCHANT_REVIEW'] } as unknown as SessionUser;
  assert.equal(canMoveMoney(env, session), false);
  assert.equal(canViewCost(env, session), false);
  const hints = publicUser(session, env);
  assert.equal(hints.can_review_merchants, true);
  assert.equal(hints.can_move_money, false);
  assert.equal(hints.can_view_cost, false);
});

// ------------------------------------------------------- guarded decisions

/**
 * The other reviewer's decision lands BETWEEN this request's read of the
 * application and its write: the first batch that carries the conditional
 * UPDATE runs `meanwhile` first. (The SQLite shim runs one batch at a time, so
 * a Promise.all of two requests would only serialise; this is the
 * interleaving a real race reduces to.)
 */
function racing(db: D1Database, meanwhile: () => Promise<unknown>): D1Database {
  let fired = false;
  return new Proxy(db, {
    get(target, prop) {
      if (prop === 'batch') {
        return async (stmts: Array<{ sql?: string }>) => {
          if (!fired && stmts.some((st) => /UPDATE merchant_applications SET/.test(st.sql ?? ''))) {
            fired = true;
            await meanwhile();
          }
          return (target as unknown as { batch: (x: unknown) => Promise<unknown> }).batch(stmts);
        };
      }
      const v = Reflect.get(target, prop);
      return typeof v === 'function' ? v.bind(target) : v;
    },
  }) as D1Database;
}

test('two reviewers racing on one revision: exactly one decision lands', async () => {
  const w = world();
  const id = await submitted(w);
  assert.equal((await decide(w, OWNER, id, 'start-review')).status, 200);
  // Both reviewers have the application open at revision 1, in review.
  for (const who of [OWNER, FULL]) assert.equal((await json(await get(w.appAs(who), `${BASE}/${id}`))).application.revision, 1);

  // FULL rejects; between FULL's read and FULL's write, the OWNER approves.
  let ownerAnswer = 0;
  const fullApp = stubApp(
    racing(w.db, async () => {
      ownerAnswer = (await decide(w, OWNER, id, 'approve', { reason_public: 'Welcome aboard' })).status;
    }),
    FULL,
    (a) => a.route(BASE, adminMerchantApplicationRoutes),
    { env: w.env }
  );
  const lost = await post(fullApp, `${BASE}/${id}/reject`, { revision: 1, operation_id: op('race'), reason_public: 'Not a real business' });
  assert.equal(ownerAnswer, 200, 'the owner landed first');
  assert.equal(lost.status, 409, await lost.clone().text());
  assert.equal((await json(lost)).code, 'APPLICATION_CHANGED', 'the conditional UPDATE lost, the batch rolled back');
  const decisions = count(
    w.raw,
    "SELECT COUNT(*) AS n FROM merchant_application_events WHERE application_id = ? AND action IN ('approved','rejected')",
    id
  );
  assert.equal(decisions, 1, 'exactly one decision');
  assert.equal(appState(w.raw, id)!.state, 'approved');
  assert.equal(count(w.raw, "SELECT COUNT(*) AS n FROM audit_log WHERE action = 'merchant_application.rejected' AND target = ?", id), 0, 'the loser left no audit row');

  // The slower reviewer who clicks after the winner landed: the state already moved.
  const late = await decide(w, FULL, id, 'reject', { reason_public: 'Not a real business' });
  assert.equal(late.status, 409);
  assert.equal((await json(late)).code, 'APPLICATION_STATE_INVALID');

  // A reviewer whose screen is behind (the revision moved on) hears APPLICATION_CHANGED.
  const id2 = await submitted(w, APPLICANT2, 'Nebula Parts');
  assert.equal((await decide(w, OWNER, id2, 'start-review')).status, 200);
  const stale = await decide(w, FULL, id2, 'request-changes', { revision: 7, reason_public: 'Add your activity link' });
  assert.equal(stale.status, 409);
  assert.equal((await json(stale)).code, 'APPLICATION_CHANGED');
  assert.equal(appState(w.raw, id2)!.state, 'in_review');
});

test('a replayed operation id writes nothing and answers the state it produced; reused for another move it is refused', async () => {
  const w = world();
  const id = await submitted(w);
  const startOp = op('start');
  const first = await post(w.appAs(OWNER), `${BASE}/${id}/start-review`, { revision: 1, operation_id: startOp });
  const second = await post(w.appAs(OWNER), `${BASE}/${id}/start-review`, { revision: 1, operation_id: startOp });
  assert.equal(first.status, 200);
  assert.equal(second.status, 200);
  const replay = await json(second);
  assert.equal(replay.replay, true);
  assert.equal(replay.application.state, 'in_review');
  assert.equal(count(w.raw, "SELECT COUNT(*) AS n FROM merchant_application_events WHERE application_id = ? AND action = 'review_started'", id), 1);

  const reused = await post(w.appAs(OWNER), `${BASE}/${id}/approve`, { revision: 1, operation_id: startOp });
  assert.equal(reused.status, 409);
  assert.equal((await json(reused)).code, 'OPERATION_REUSED');
  assert.equal(appState(w.raw, id)!.state, 'in_review');

  // The decision doors ask for what they decide on.
  const noRevision = await post(w.appAs(OWNER), `${BASE}/${id}/approve`, { operation_id: op() });
  assert.equal((await json(noRevision)).code, 'APPLICATION_REVISION_REQUIRED');
  const noOperation = await post(w.appAs(OWNER), `${BASE}/${id}/approve`, { revision: 1 });
  assert.equal((await json(noOperation)).code, 'OPERATION_ID_INVALID');
  for (const action of ['request-changes', 'reject']) {
    const res = await decide(w, OWNER, id, action, { reason_public: 'no' });
    assert.equal(res.status, 400);
    assert.equal((await json(res)).code, 'DECISION_REASON_REQUIRED');
  }
  assert.equal(appState(w.raw, id)!.state, 'in_review');
});

// ------------------------------------------------------------------ privacy

test('the queue carries no legal name, date of birth, activity link, photo or user id', async () => {
  const w = world();
  await submitted(w);
  for (const state of ['queue', 'all', 'submitted']) {
    const res = await get(w.appAs(OWNER), `${BASE}?state=${state}`);
    assert.equal(res.status, 200);
    const text = await res.text();
    for (const v of PII) assert.ok(!text.includes(v), `the ${state} queue carries a personal value`);
    for (const key of ['legal_name', 'dob', 'social_link', 'photo', 'user_id', 'note_internal', 'u_app']) {
      assert.ok(!text.includes(`"${key}"`) && !text.includes(key === 'u_app' ? '"u_app"' : `"${key}":`), `the ${state} queue names ${key}`);
    }
    const body = JSON.parse(text);
    if (state !== 'all') assert.equal(body.applications.length, 1);
    assert.equal(body.applications[0].public.name, 'Orbit Prints');
  }
  assert.equal((await get(w.appAs(OWNER), `${BASE}?state=bogus`)).status, 400);
});

test('the detail decrypts once, audited BEFORE anything is opened; the photo is no-store, audited and confined', async () => {
  const w = world();
  const id = await submitted(w);
  const views = () => count(w.raw, "SELECT COUNT(*) AS n FROM audit_log WHERE action = 'merchant_application.view' AND target = ?", id);
  assert.equal(views(), 0);
  const res = await get(w.appAs(FULL), `${BASE}/${id}`);
  assert.equal(res.status, 200);
  const d = (await json(res)).application;
  assert.deepEqual(d.private.legal_name, NAME);
  assert.equal(d.private.dob, DOB);
  assert.equal(d.private.social_link, LINK);
  assert.equal(d.private.has_photo, true);
  assert.equal(d.private.readable, true);
  assert.ok(d.private.age >= 18);
  assert.equal(d.checks.pro_identity_verified, false, 'a computed flag, no KYC value');
  assert.equal(d.checks.phone_verified, true);
  assert.equal(views(), 1);
  // The audit row itself carries no value.
  const auditText = JSON.stringify(w.raw.prepare("SELECT * FROM audit_log WHERE target = ?").all(id));
  for (const v of PII) assert.ok(!auditText.includes(v), 'an audit row carries a personal value');

  const photo = await get(w.appAs(FULL), `${BASE}/${id}/photo`);
  assert.equal(photo.status, 200);
  assert.equal(photo.headers.get('Cache-Control'), 'no-store');
  assert.match(photo.headers.get('Content-Security-Policy') ?? '', /sandbox/);
  assert.equal(count(w.raw, "SELECT COUNT(*) AS n FROM audit_log WHERE action = 'merchant_application.photo_view' AND target = ?", id), 1);

  // A row pointing outside its own prefix is not served.
  w.raw.prepare("UPDATE merchant_applications SET photo_key = 'kyc/someone/else.webp' WHERE id = ?").run(id);
  assert.equal((await get(w.appAs(FULL), `${BASE}/${id}/photo`)).status, 404);
  assert.equal((await get(w.appAs(FULL), `${BASE}/not-an-application`)).status, 404);
});

test('note_internal never reaches the applicant — not their GET, not their writes, not /api/merchant/me', async () => {
  const w = world();
  const id = await submitted(w);
  assert.equal((await decide(w, OWNER, id, 'start-review')).status, 200);
  const changes = await decide(w, OWNER, id, 'request-changes', { reason_public: 'Please add a clearer photo', note_internal: NOTE });
  assert.equal(changes.status, 200);
  assert.equal(appState(w.raw, id)!.note_internal, NOTE, 'stored for staff');
  const detail = await json(await get(w.appAs(FULL), `${BASE}/${id}`));
  assert.equal(detail.application.note_internal, NOTE, 'reviewers read it');

  const applicant = w.appAs(APPLICANT);
  const seen: string[] = [];
  const mine = await get(applicant, '/api/merchant-application');
  seen.push(await mine.text());
  const me = await get(applicant, '/api/merchant/me');
  assert.equal(me.status, 200);
  const meText = await me.text();
  seen.push(meText);
  const meBody = JSON.parse(meText);
  assert.equal(meBody.approved, false);
  assert.deepEqual(meBody.application, { state: 'changes_requested', revision: 1, reason_public: 'Please add a clearer photo' });
  seen.push(await (await put(applicant, '/api/merchant-application', { public_bio: 'Prints to order, fast.' })).text());
  seen.push(await (await post(applicant, '/api/merchant-application/submit', { operation_id: op('resubmit') })).text());
  seen.push(await (await post(applicant, '/api/merchant-application/withdraw', { operation_id: op('withdraw') })).text());
  for (const text of seen) {
    assert.ok(!text.includes(NOTE), 'the internal note reached the applicant');
    assert.ok(!text.includes('note_internal'), 'the applicant sees the field name');
  }
  assert.match(seen[0]!, /Please add a clearer photo/, 'the public reason does reach them');
});

test('an admin who applied reads their own application WITHOUT the staff note; another reviewer still reads it', async () => {
  const w = world();
  const own = await submitted(w, ASSIST2, 'Assistant Prints');
  grant(w.raw, ASSIST2.id);
  assert.equal((await decide(w, OWNER, own, 'start-review')).status, 200);
  assert.equal((await decide(w, OWNER, own, 'request-changes', { reason_public: 'Please add a clearer photo', note_internal: NOTE })).status, 200);

  const mine = await get(w.appAs(ASSIST2), `${BASE}/${own}`);
  assert.equal(mine.status, 200);
  const text = await mine.text();
  assert.ok(!text.includes(NOTE), 'the staff note reached its own applicant');
  const body = JSON.parse(text);
  assert.equal(body.application.own, true);
  assert.equal(body.application.note_internal, '');
  assert.equal(body.application.reason_public, 'Please add a clearer photo', 'the public reason is theirs to read');

  const other = await json(await get(w.appAs(FULL), `${BASE}/${own}`));
  assert.equal(other.application.note_internal, NOTE);
});

test('a DRAFT is never a reviewer\'s: no filter lists it, the detail and the photo answer 404, nothing is opened', async () => {
  const w = world();
  grant(w.raw, ASSIST.id);
  // A complete draft, photo included, never sent.
  const app = w.appAs(APPLICANT);
  const saved = await put(app, '/api/merchant-application', { legal_name: NAME, dob: DOB, social_link: LINK, public_name: 'Orbit Prints' });
  assert.equal(saved.status, 200);
  const id = (await json(saved)).application.id as string;
  assert.equal((await app.request('/api/merchant-application/photo', { method: 'POST', body: photoForm() })).status, 200);

  for (const who of [OWNER, FULL, ASSIST]) {
    const filtered = await get(w.appAs(who), `${BASE}?state=draft`);
    assert.equal(filtered.status, 400, `${who.id}: ?state=draft`);
    assert.equal((await json(filtered)).code, 'STATE_FILTER_INVALID');
    for (const f of ['queue', 'all']) {
      const list = await json(await get(w.appAs(who), `${BASE}?state=${f}`));
      assert.ok(!(list.applications as Array<{ id: string }>).some((a) => a.id === id), `${who.id}: ${f} lists the draft`);
    }
    const detail = await get(w.appAs(who), `${BASE}/${id}`);
    assert.equal(detail.status, 404, `${who.id}: detail`);
    const body = await detail.text();
    for (const v of PII) assert.ok(!body.includes(v), `${who.id}: the detail carries a private value`);
    assert.equal((await get(w.appAs(who), `${BASE}/${id}/photo`)).status, 404, `${who.id}: photo`);
  }
  assert.equal(count(w.raw, "SELECT COUNT(*) AS n FROM audit_log WHERE action IN ('merchant_application.view','merchant_application.photo_view')"), 0, 'nothing was opened');

  // A submitted application reopened by its applicant is a draft again: closed to reviewers while it is edited.
  const sent = await post(app, '/api/merchant-application/submit', { operation_id: op('submit-draft') });
  assert.equal(sent.status, 200, await sent.clone().text());
  assert.equal((await get(w.appAs(OWNER), `${BASE}/${id}`)).status, 200);
  assert.equal((await put(app, '/api/merchant-application', { public_bio: 'Prints to order, fast.' })).status, 200);
  assert.equal((await get(w.appAs(OWNER), `${BASE}/${id}`)).status, 404);
  assert.equal((await get(w.appAs(OWNER), `${BASE}/${id}/photo`)).status, 404);
});

/** Nothing of an application, for every reviewer: not listed under any filter, detail and photo 404, no value in any answer. */
async function closedToReviewers(w: World, id: string, secrets: string[]) {
  for (const who of [OWNER, FULL, ASSIST]) {
    for (const f of ['queue', 'all', 'withdrawn']) {
      const res = await get(w.appAs(who), `${BASE}?state=${f}`);
      assert.equal(res.status, 200);
      const text = await res.text();
      assert.ok(!(JSON.parse(text).applications as Array<{ id: string }>).some((a) => a.id === id), `${who.id}: ?state=${f} lists it`);
      for (const v of secrets) assert.ok(!text.includes(v), `${who.id}: ?state=${f} carries an unsent value`);
    }
    const detail = await get(w.appAs(who), `${BASE}/${id}`);
    assert.equal(detail.status, 404, `${who.id}: detail`);
    const body = await detail.text();
    for (const v of secrets) assert.ok(!body.includes(v), `${who.id}: the detail carries an unsent value`);
    assert.equal((await get(w.appAs(who), `${BASE}/${id}/photo`)).status, 404, `${who.id}: photo`);
  }
}

test('a draft WITHDRAWN without ever being sent is still never a reviewer\'s: listed nowhere, opened nowhere, purged at once', async () => {
  const w = world();
  grant(w.raw, ASSIST.id);
  const app = w.appAs(APPLICANT);
  const saved = await put(app, '/api/merchant-application', { legal_name: NAME, dob: DOB, social_link: LINK, public_name: 'Never Sent Prints' });
  assert.equal(saved.status, 200, await saved.clone().text());
  const id = (await json(saved)).application.id as string;
  assert.equal((await app.request('/api/merchant-application/photo', { method: 'POST', body: photoForm() })).status, 200);
  const out = await post(app, '/api/merchant-application/withdraw', { operation_id: op('withdraw-draft') });
  assert.equal(out.status, 200, await out.clone().text());
  assert.equal((await json(out)).application.state, 'withdrawn');

  await closedToReviewers(w, id, [...PII, 'Never Sent Prints']);
  assert.equal(count(w.raw, "SELECT COUNT(*) AS n FROM audit_log WHERE action IN ('merchant_application.view','merchant_application.photo_view')"), 0, 'nothing was opened');
  // And nothing of it is kept for the 90 days: there is no reviewer it could be kept for.
  const r = row<{ legal_name_enc: string; dob_enc: string; social_link_enc: string; photo_key: string | null; purged_at: string | null }>(
    w.raw,
    'SELECT legal_name_enc, dob_enc, social_link_enc, photo_key, purged_at FROM merchant_applications WHERE id = ?',
    id
  )!;
  assert.ok(r.purged_at);
  assert.deepEqual([r.legal_name_enc, r.dob_enc, r.social_link_enc, r.photo_key], ['', '', '', null]);
  assert.deepEqual([...w.bucket.objects.keys()].filter((k) => k.startsWith(`merchant-review/${id}/`)), []);
});

test('submitted, reopened by an edit, then withdrawn: the reviewer sees NOTHING of the unsent revision — and nothing older in its place', async () => {
  const w = world();
  grant(w.raw, ASSIST.id);
  const id = await submitted(w);
  const app = w.appAs(APPLICANT);
  // While it was sent, a reviewer could open it.
  assert.equal((await get(w.appAs(OWNER), `${BASE}/${id}`)).status, 200);
  const views = count(w.raw, "SELECT COUNT(*) AS n FROM audit_log WHERE action = 'merchant_application.view'");
  // The applicant edits: revision 2, values no reviewer was ever sent.
  const UNSENT = { given: 'Unsentgiven', father: 'Unsentfather', grandfather: 'Unsentgrand' };
  const edited = await put(app, '/api/merchant-application', { legal_name: UNSENT, public_name: 'Unsent Rename Prints' });
  assert.equal(edited.status, 200, await edited.clone().text());
  assert.equal((await json(edited)).application.revision, 2);
  assert.equal((await post(app, '/api/merchant-application/withdraw', { operation_id: op('withdraw-reopened') })).status, 200);

  // The sealed columns hold only the LATEST values, so the sent revision 1 cannot be shown
  // instead: the withdrawn application is closed to reviewers altogether.
  await closedToReviewers(w, id, [UNSENT.given, UNSENT.father, UNSENT.grandfather, 'Unsent Rename Prints', ...PII]);
  assert.equal(count(w.raw, "SELECT COUNT(*) AS n FROM audit_log WHERE action = 'merchant_application.view'"), views, 'no new view');
  assert.ok(row<{ purged_at: string | null }>(w.raw, 'SELECT purged_at FROM merchant_applications WHERE id = ?', id)!.purged_at, 'purged at once');
});

test('withdrawn from a SENT revision, the application stays a reviewer\'s for the C7 period', async () => {
  const w = world();
  const id = await submitted(w);
  assert.equal((await post(w.appAs(APPLICANT), '/api/merchant-application/withdraw', { operation_id: op('withdraw-sent') })).status, 200);
  const list = await json(await get(w.appAs(OWNER), `${BASE}?state=withdrawn`));
  assert.ok((list.applications as Array<{ id: string }>).some((a) => a.id === id), 'listed under withdrawn');
  const detail = await json(await get(w.appAs(OWNER), `${BASE}/${id}`));
  assert.deepEqual(detail.application.private.legal_name, NAME, 'the revision the applicant sent');
  assert.equal((await get(w.appAs(OWNER), `${BASE}/${id}/photo`)).status, 200);
  const r = row<{ retention_until: string; purged_at: string | null }>(w.raw, 'SELECT retention_until, purged_at FROM merchant_applications WHERE id = ?', id)!;
  assert.equal(r.purged_at, null);
  assert.ok(Date.parse(r.retention_until) > Date.now() + 89 * 86_400_000, 'kept the 90 days');
});

test("a reviewer's operation id never takes a server namespace ('purge:', 'create:', 'srv:')", async () => {
  const w = world();
  const id = await submitted(w);
  for (const reserved of [`purge:${id}`, `create:${id}`, 'srv:abcdefgh1234']) {
    const out = await post(w.appAs(OWNER), `${BASE}/${id}/start-review`, { revision: 1, operation_id: reserved });
    assert.equal(out.status, 400, reserved);
    assert.equal((await json(out)).code, 'OPERATION_ID_INVALID');
  }
  assert.equal(appState(w.raw, id)!.state, 'submitted');
});

// ------------------------------------------------------------------ approve

test('approve creates NO store and NO public merchant row; /api/merchant/me then says approved', async () => {
  const w = world();
  const id = await submitted(w);
  const stores = () => count(w.raw, 'SELECT COUNT(*) AS n FROM merchant_stores');
  const before = stores();
  assert.equal((await decide(w, OWNER, id, 'start-review')).status, 200);
  const approved = await decide(w, OWNER, id, 'approve', { reason_public: 'Welcome', note_internal: NOTE });
  assert.equal(approved.status, 200, await approved.clone().text());
  assert.equal((await json(approved)).application.state, 'approved');
  assert.equal(stores(), before, 'approval opens no store');
  // The approval lives on the application; the merchant row is born with the store at /onboard.
  assert.equal(count(w.raw, 'SELECT COUNT(*) AS n FROM community_merchants WHERE user_id = ?', APPLICANT.id), 0, 'no card in «المتاجر» before a store');
  assert.equal(appState(w.raw, id)!.decided_by, OWNER.id);

  const me = await json(await get(w.appAs(APPLICANT), '/api/merchant/me'));
  assert.equal(me.approved, true);
  assert.equal(me.store, null);
  assert.equal(me.application.state, 'approved');
  assert.ok(!JSON.stringify(me).includes(NOTE));

  // A finished application never moves again.
  const late = await decide(w, FULL, id, 'reject', { reason_public: 'Changed my mind' });
  assert.equal(late.status, 409);
  assert.equal((await json(late)).code, 'APPLICATION_STATE_INVALID');
});

test('reject lets the applicant apply again at once (C8) and starts the C7 clock', async () => {
  const w = world();
  const id = await submitted(w);
  assert.equal((await decide(w, OWNER, id, 'start-review')).status, 200);
  assert.equal((await decide(w, OWNER, id, 'reject', { reason_public: 'The link shows no activity' })).status, 200);
  const r = row<{ retention_until: string | null }>(w.raw, 'SELECT retention_until FROM merchant_applications WHERE id = ?', id)!;
  assert.ok(r.retention_until, 'the 90-day clock starts');
  const mine = await json(await get(w.appAs(APPLICANT), '/api/merchant-application'));
  assert.equal(mine.application.state, 'rejected');
  assert.equal(mine.application.reason_public, 'The link shows no activity');
  assert.equal(mine.can.apply, true, 'immediately, no cooldown');
  const again = await put(w.appAs(APPLICANT), '/api/merchant-application', { public_name: 'Orbit Prints 2' });
  assert.equal(again.status, 200);
  const fresh = (await json(again)).application;
  assert.notEqual(fresh.id, id);
  assert.equal(fresh.state, 'draft');
});

// ------------------------------------------------------------- notices, schema

test('Telegram notices carry ids, revision and the action — nothing a reader could learn the person from', () => {
  const text = reviewerNoticeText('mapp_abc123', 3, 'changes_requested') + submittedNoticeText('mapp_abc123', 3);
  assert.match(text, /mapp_abc123/);
  assert.match(text, /changes requested/);
  for (const v of [...PII, 'Orbit', '@', 'http']) assert.ok(!text.includes(v), `notice carries ${v}`);
});

test('a database without 0204: the queue says unavailable, every other door fails closed', async () => {
  const w = world({ through: '0203' });
  const list = await get(w.appAs(OWNER), BASE);
  assert.equal(list.status, 200);
  assert.deepEqual(await json(list), { success: true, available: false, applications: [] });
  const detail = await get(w.appAs(OWNER), `${BASE}/mapp_abcdefabcdef`);
  assert.equal(detail.status, 503);
  const move = await post(w.appAs(OWNER), `${BASE}/mapp_abcdefabcdef/approve`, { revision: 1, operation_id: op() });
  assert.equal(move.status, 503);
  // No grant table: an assistant is no reviewer.
  assert.equal((await get(w.appAs(ASSIST), BASE)).status, 403);
  const me = await json(await get(w.appAs(APPLICANT), '/api/merchant/me'));
  assert.equal(me.approved, false);
  assert.equal(me.application, null);
});
