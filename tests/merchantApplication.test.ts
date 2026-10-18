/**
 * THE MERCHANT APPLICATION, THE APPLICANT'S SIDE (Community V3 push 1.1,
 * DECISIONS row 256; gap §3.1–§3.2, §3.7–§3.8).
 *
 * Proves, on the real routes and a fully migrated database:
 *   - the state machine: every legal move and every illegal one, replay by
 *     operation id, two reviewers racing on one revision, no self-decision;
 *   - one live application per user, and an IMMEDIATE re-application after a
 *     rejection (owner decision C8): a new application at revision 1;
 *   - privacy: the legal name, the date of birth and the activity link are
 *     sealed in D1 (no table holds them in clear), no response, audit row,
 *     event, notice or refusal carries them, the applicant never sees the
 *     internal note, and the review photo is re-encoded, private and 404s on
 *     /files for everyone;
 *   - 503 without a usable key ring, the private bucket or the re-encoder;
 *   - a date of birth round-trips as the same ten characters; compound names
 *     («عبد الله») are one part; under-18 and an unverified phone are refused;
 *   - applying needs no PLUS (owner decision C3);
 *   - the C7 retention sweep; the append-only event trail; a database
 *     without 0204 fails closed.
 *
 * Fixtures are anonymised: invented names, a placeholder link, a key minted
 * per run.
 *
 * Run: node --import tsx --test tests/merchantApplication.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { DatabaseSync } from 'node:sqlite';
import {
  freshDb,
  dbThrough,
  asD1,
  stubApp,
  get,
  put,
  post,
  json,
  row,
  all,
  count,
  memoryBucket,
  type StubUser,
} from './fixtures/app';
import { imagesDouble, jpegBytes, pngBytes } from './fixtures/imageDoubles';
import { merchantApplicationRoutes } from '../worker/routes/merchantApplication';
import { fileRoutes } from '../worker/routes/uploads';
import { unseal } from '../worker/lib/sealbox';
import {
  APPLICATION_STATES,
  TRANSITIONS,
  ageOn,
  applyTransition,
  canReviewMerchants,
  merchantApprovalOf,
  nextState,
  parseDob,
  parseLegalName,
  parseSocialLink,
  submittedNoticeText,
  sweepMerchantApplicationRetention,
  validClientOperationId,
  type ApplicationAction,
} from '../worker/lib/merchantApproval';

/** A throwaway 32-byte key minted per run — never a real secret. */
const KEY = `v1:${btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32))))}`;
const APPLICANT: StubUser = { id: 'u_app', role: 'customer', email: 'applicant@example.test' };
const REVIEWER: StubUser = { id: 'u_rev', role: 'admin', email: 'reviewer@example.test', admin_scope: 'full' };

// Anonymised, deliberately distinctive values: any appearance outside a sealed column is a leak.
const NAME = { given: 'عبد الله', father: 'Zayd Qorvan', grandfather: 'Ibn-Talvar' };
const DOB = '1990-07-14';
const LINK = 'https://www.instagram.com/qorvan.testprints.example';
const PII = [NAME.given, NAME.father, NAME.grandfather, DOB, 'qorvan.testprints.example'];

/** The in-memory bucket with R2's prefix listing, which the C7 purge reads. */
function listingBucket() {
  const b = memoryBucket();
  return Object.assign(b, {
    async list(o: { prefix?: string; cursor?: string } = {}) {
      const objects = [...b.objects.keys()].filter((k) => !o.prefix || k.startsWith(o.prefix)).sort().map((key) => ({ key }));
      return { objects, truncated: false as const, delimitedPrefixes: [] as string[] };
    },
  });
}

function world(opts: { key?: string | null; privateBucket?: boolean; images?: boolean; phone?: boolean; through?: string } = {}) {
  const raw: DatabaseSync = opts.through ? dbThrough(opts.through) : freshDb();
  raw.exec(`
    INSERT INTO users (id,email,password_hash,role) VALUES
      ('u_app','applicant@example.test','h','customer'),
      ('u_rev','reviewer@example.test','h','admin'),
      ('u_owner','boss@x.co','h','admin');
  `);
  if (opts.phone !== false) {
    raw.exec(`INSERT INTO telegram_links (user_id, telegram_user_id, chat_id, phone_e164, verified_at)
              VALUES ('u_app', 9100001, 9100001, '+9647700000000', '2026-01-01T00:00:00.000Z')`);
  }
  const bucket = listingBucket();
  const legacy = memoryBucket();
  const images = imagesDouble();
  const env: Record<string, unknown> = { BUCKET: legacy };
  if (opts.key !== null) env.KYC_ENC_KEY = opts.key ?? KEY;
  if (opts.privateBucket !== false) env.R2_PRIVATE = bucket;
  if (opts.images !== false) env.IMAGES = images.binding;
  const db = asD1(raw);
  const appAs = (user: StubUser | null) =>
    stubApp(
      db,
      user,
      (a) => {
        a.route('/api/merchant-application', merchantApplicationRoutes);
        a.route('/files', fileRoutes);
      },
      { env }
    );
  return { raw, db, bucket, legacy, images, env, app: appAs(APPLICANT), appAs };
}

const photoForm = (bytes: Uint8Array, name = 'qorvan-selfie.jpg', type = 'image/jpeg') => {
  const fd = new FormData();
  fd.set('file', new File([bytes as unknown as BlobPart], name, { type }));
  return fd;
};

async function uploadPhoto(app: ReturnType<typeof world>['app'], bytes = jpegBytes(640, 480)) {
  return app.request('/api/merchant-application/photo', { method: 'POST', body: photoForm(bytes) });
}

/** A complete draft: the three private values, a public name and a photo. */
async function completeDraft(w: ReturnType<typeof world>) {
  const saved = await put(w.app, '/api/merchant-application', {
    legal_name: NAME,
    dob: DOB,
    social_link: LINK,
    public_name: 'Orbit Prints',
    public_bio: 'Prints to order.',
    governorate: 'baghdad',
    activity_kind: 'print_services',
    activity_description: 'Custom printing for local customers.',
  });
  assert.equal(saved.status, 200, await saved.clone().text());
  const photo = await uploadPhoto(w.app);
  assert.equal(photo.status, 200, await photo.clone().text());
  return (await json(saved)).application as { id: string };
}

/** Every text value in every table, as one string. */
function everyText(raw: DatabaseSync): string {
  const tables = (raw.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").all() as Array<{ name: string }>).map((t) => t.name);
  return tables.map((t) => JSON.stringify(raw.prepare(`SELECT * FROM "${t}"`).all())).join('\n');
}

const assertNoPii = (text: string, where: string) => {
  for (const v of PII) assert.ok(!text.includes(v), `${where} carries a personal value`);
};

const appRow = (raw: DatabaseSync, id: string) =>
  row<{ id: string; user_id: string; state: string; revision: number; legal_name_enc: string; dob_enc: string; social_link_enc: string; photo_key: string | null; retention_until: string | null; purged_at: string | null; note_internal: string }>(
    raw,
    'SELECT * FROM merchant_applications WHERE id = ?',
    id
  );

// ---------------------------------------------------------------- the machine

test('the state machine: every legal move, and every other move is illegal', () => {
  const legal: Record<ApplicationAction, Record<string, string>> = {
    submit: { draft: 'submitted' },
    reopen: { submitted: 'draft', changes_requested: 'draft' },
    withdraw: { draft: 'withdrawn', submitted: 'withdrawn', in_review: 'withdrawn', changes_requested: 'withdrawn' },
    start_review: { submitted: 'in_review' },
    request_changes: { in_review: 'changes_requested' },
    approve: { in_review: 'approved' },
    reject: { in_review: 'rejected' },
  };
  for (const action of Object.keys(TRANSITIONS) as ApplicationAction[]) {
    for (const from of APPLICATION_STATES) {
      assert.equal(nextState(action, from), legal[action][from] ?? null, `${action} from ${from}`);
    }
  }
  // A finished application never moves again.
  for (const done of ['approved', 'rejected', 'withdrawn']) {
    for (const action of Object.keys(TRANSITIONS) as ApplicationAction[]) assert.equal(nextState(action, done), null);
  }
});

test('transitions are conditional on state AND revision, replay-safe, race-safe and never self-decided', async () => {
  const w = world();
  const created = await completeDraft(w);
  const id = created.id;
  const load = () => appRow(w.raw, id)!;

  // An applicant cannot take a reviewer's action, and a reviewer cannot act from the wrong state.
  assert.deepEqual(await applyTransition(w.db, { application: load(), action: 'approve', actor: { id: 'u_app', kind: 'applicant' }, operationId: 'op-illegal-1' }), { ok: false, code: 'APPLICATION_STATE_INVALID' });
  assert.deepEqual(await applyTransition(w.db, { application: load(), action: 'approve', actor: { id: 'u_rev', kind: 'reviewer' }, operationId: 'op-illegal-2' }), { ok: false, code: 'APPLICATION_STATE_INVALID' });

  const submitted = await post(w.app, '/api/merchant-application/submit', { operation_id: 'op-submit-0001' });
  assert.equal(submitted.status, 200, await submitted.clone().text());
  // The same operation again: answered as its replay, nothing written twice.
  const again = await post(w.app, '/api/merchant-application/submit', { operation_id: 'op-submit-0001' });
  assert.equal(again.status, 200);
  assert.equal(count(w.raw, "SELECT COUNT(*) AS n FROM merchant_application_events WHERE application_id = ? AND action = 'submitted'", id), 1);
  // A different operation on the finished move is refused.
  const third = await post(w.app, '/api/merchant-application/submit', { operation_id: 'op-submit-0002' });
  assert.equal(third.status, 409);
  assert.equal((await json(third)).code, 'APPLICATION_STATE_INVALID');

  // No self-decision: the applicant holding a reviewer's role still cannot move their own application.
  assert.deepEqual(
    await applyTransition(w.db, { application: load(), action: 'start_review', actor: { id: 'u_app', kind: 'reviewer' }, operationId: 'op-self-0001' }),
    { ok: false, code: 'SELF_DECISION_FORBIDDEN' }
  );

  const started = await applyTransition(w.db, { application: load(), action: 'start_review', actor: { id: 'u_rev', kind: 'reviewer' }, operationId: 'op-start-0001' });
  assert.deepEqual(started, { ok: true, replay: false, state: 'in_review', revision: 1 });

  // Two reviewers loaded the same revision and both decide: exactly one wins.
  // The second decides on its STALE snapshot, which is what a race reduces to
  // once D1 has serialised the two batches.
  const snapshot = load();
  const a = await applyTransition(w.db, { application: snapshot, action: 'approve', actor: { id: 'u_rev', kind: 'reviewer' }, operationId: 'op-race-approve' });
  const b = await applyTransition(w.db, { application: snapshot, action: 'reject', actor: { id: 'u_owner', kind: 'reviewer' }, operationId: 'op-race-reject', reasonPublic: 'Not this time.' });
  assert.equal(a.ok, true, JSON.stringify(a));
  assert.deepEqual(b, { ok: false, code: 'APPLICATION_CHANGED' });
  assert.equal(appRow(w.raw, id)!.state, 'approved', 'the first decision stands');
  assert.equal(count(w.raw, "SELECT COUNT(*) AS n FROM merchant_application_events WHERE application_id = ? AND action IN ('approved','rejected')", id), 1);
  // An operation id is bound to its action: reusing it for another is refused.
  assert.deepEqual(
    await applyTransition(w.db, { application: load(), action: 'withdraw', actor: { id: 'u_app', kind: 'applicant' }, operationId: 'op-start-0001' }),
    { ok: false, code: 'OPERATION_REUSED' }
  );
});

test('the applicant edits after a submission: the application returns to draft at revision + 1', async () => {
  const w = world();
  const { id } = await completeDraft(w);
  assert.equal((await post(w.app, '/api/merchant-application/submit', {})).status, 200);
  // An empty save is not an edit: it never pulls a submitted application back.
  const idle = (await json(await put(w.app, '/api/merchant-application', {}))).application;
  assert.deepEqual([idle.state, idle.revision], ['submitted', 1]);
  const edited = await put(w.app, '/api/merchant-application', { public_bio: 'Prints to order, fast.' });
  assert.equal(edited.status, 200);
  const app = (await json(edited)).application;
  assert.equal(app.id, id);
  assert.equal(app.state, 'draft');
  assert.equal(app.revision, 2, 'a reviewer never decides on a revision that changed under them');

  // While a reviewer holds it, it is locked.
  assert.equal((await post(w.app, '/api/merchant-application/submit', {})).status, 200);
  await applyTransition(w.db, { application: appRow(w.raw, id)!, action: 'start_review', actor: { id: 'u_rev', kind: 'reviewer' }, operationId: 'op-start-rev2' });
  const locked = await put(w.app, '/api/merchant-application', { public_bio: 'x' });
  assert.equal(locked.status, 409);
  assert.equal((await json(locked)).code, 'APPLICATION_LOCKED');
});

// ------------------------------------------------- one live, re-apply at once

test('one live application per user — enforced by the database, not only the route', async () => {
  const w = world();
  const first = await json(await put(w.app, '/api/merchant-application', { public_name: 'Orbit Prints' }));
  const second = await json(await put(w.app, '/api/merchant-application', { public_bio: 'b' }));
  assert.equal(second.application.id, first.application.id);
  assert.equal(count(w.raw, "SELECT COUNT(*) AS n FROM merchant_applications WHERE user_id = 'u_app'"), 1);
  assert.throws(
    () => w.raw.exec("INSERT INTO merchant_applications (id, user_id, state) VALUES ('mapp_dup', 'u_app', 'submitted')"),
    /UNIQUE constraint failed/
  );
  // A finished one does not count: history is kept beside the live one.
  w.raw.exec("INSERT INTO merchant_applications (id, user_id, state) VALUES ('mapp_old', 'u_app', 'rejected')");
});

test('C8: a rejected applicant re-applies IMMEDIATELY — a new application at revision 1', async () => {
  const w = world();
  const { id } = await completeDraft(w);
  assert.equal((await post(w.app, '/api/merchant-application/submit', {})).status, 200);
  await applyTransition(w.db, { application: appRow(w.raw, id)!, action: 'start_review', actor: { id: 'u_rev', kind: 'reviewer' }, operationId: 'op-c8-start' });
  const rejected = await applyTransition(w.db, {
    application: appRow(w.raw, id)!,
    action: 'reject',
    actor: { id: 'u_rev', kind: 'reviewer' },
    operationId: 'op-c8-reject',
    reasonPublic: 'The activity link does not open.',
    noteInternal: 'INTERNAL-NOTE-SENTINEL',
  });
  assert.equal(rejected.ok, true);

  const seen = await json(await get(w.app, '/api/merchant-application'));
  assert.equal(seen.application.state, 'rejected');
  assert.equal(seen.application.reason_public, 'The activity link does not open.');
  assert.equal(seen.can.apply, true);
  assert.ok(!JSON.stringify(seen).includes('INTERNAL-NOTE-SENTINEL'), 'the applicant never sees the internal note');

  const re = await put(w.app, '/api/merchant-application', { public_name: 'Orbit Prints' });
  assert.equal(re.status, 200, 'no cooldown');
  const fresh = (await json(re)).application;
  assert.notEqual(fresh.id, id);
  assert.equal(fresh.state, 'draft');
  assert.equal(fresh.revision, 1);
  assert.equal(appRow(w.raw, id)!.state, 'rejected', 'the rejected one stays as history');
  assert.ok(appRow(w.raw, id)!.retention_until, 'a rejection starts the C7 clock');
});

test('an approved merchant cannot open a second application', async () => {
  const w = world();
  const { id } = await completeDraft(w);
  assert.equal((await post(w.app, '/api/merchant-application/submit', {})).status, 200);
  await applyTransition(w.db, { application: appRow(w.raw, id)!, action: 'start_review', actor: { id: 'u_rev', kind: 'reviewer' }, operationId: 'op-ap-start' });
  await applyTransition(w.db, { application: appRow(w.raw, id)!, action: 'approve', actor: { id: 'u_rev', kind: 'reviewer' }, operationId: 'op-ap-approve' });
  assert.deepEqual(await merchantApprovalOf(w.db, 'u_app'), { merchant: true, approved: true });
  const m = row<{ approved_application_id: string; name: string; status: string }>(w.raw, "SELECT * FROM community_merchants WHERE user_id = 'u_app'")!;
  assert.equal(m.approved_application_id, id);
  assert.equal(m.name, 'Orbit Prints', 'the merchant row takes the PUBLIC name, never the legal one');
  assert.equal(count(w.raw, 'SELECT COUNT(*) AS n FROM merchant_stores'), 0, 'approval creates no store and publishes nothing');
  const again = await put(w.app, '/api/merchant-application', { public_name: 'Second' });
  assert.equal(again.status, 409);
  assert.equal((await json(again)).code, 'MERCHANT_ALREADY_APPROVED');
});

// ------------------------------------------------------------------ privacy

test('the private values are SEALED in D1 — no table anywhere holds them in clear — and round-trip exactly', async () => {
  const w = world();
  const { id } = await completeDraft(w);
  assert.equal((await post(w.app, '/api/merchant-application/submit', {})).status, 200);
  const r = appRow(w.raw, id)!;
  for (const col of ['legal_name_enc', 'dob_enc', 'social_link_enc'] as const) assert.match(r[col], /^sealed:v1:/);
  assertNoPii(everyText(w.raw), 'the database');

  // The date of birth is the same ten characters, never a timestamp.
  assert.equal(await unseal(KEY, r.dob_enc), DOB);
  assert.deepEqual(JSON.parse((await unseal(KEY, r.legal_name_enc))!), NAME, 'a compound part stays one part');
  assert.equal(await unseal(KEY, r.social_link_enc), LINK);
});

test('no personal value in any response, refusal, audit row, event or notice', async () => {
  const w = world();
  const bodies: string[] = [];
  const keep = async (res: Response) => {
    bodies.push(await res.clone().text());
    return res;
  };
  const logged: string[] = [];
  const realError = console.error;
  console.error = (...args: unknown[]) => logged.push(args.map(String).join(' '));
  try {
    await keep(await put(w.app, '/api/merchant-application', { legal_name: NAME, dob: DOB, social_link: LINK, public_name: 'Orbit Prints' }));
    await keep(await uploadPhoto(w.app));
    // Refusals for each private field, with the value inside a bad shape: the refusal names the field only.
    await keep(await put(w.app, '/api/merchant-application', { legal_name: { ...NAME, grandfather: `${NAME.grandfather}123` } }));
    await keep(await put(w.app, '/api/merchant-application', { dob: `${DOB}T00:00:00Z` }));
    await keep(await put(w.app, '/api/merchant-application', { social_link: `${LINK.replace('instagram.com', 'evil.example')}` }));
    await keep(await get(w.app, '/api/merchant-application'));
    const submitted = await keep(await post(w.app, '/api/merchant-application/submit', {}));
    assert.equal(submitted.status, 200);
    await keep(await post(w.app, '/api/merchant-application/withdraw', {}));
    await keep(await get(w.app, '/api/merchant-application'));
  } finally {
    console.error = realError;
  }
  for (const b of bodies) assertNoPii(b, `a response (${b.slice(0, 60)})`);
  assertNoPii(logged.join('\n'), 'a log line');
  assertNoPii(JSON.stringify(all(w.raw, 'SELECT * FROM audit_log')), 'the audit log');
  assertNoPii(JSON.stringify(all(w.raw, 'SELECT * FROM merchant_application_events')), 'the event trail');
  const field = JSON.parse(bodies[2]!);
  assert.equal(field.code, 'APPLICATION_FIELD_INVALID');
  assert.deepEqual(field.details, { field: 'legal_name' });

  // The applicant's answer says WHICH values were provided, never what they are.
  const seen = JSON.parse(bodies[bodies.length - 1]!);
  assert.deepEqual(seen.application.provided, { legal_name: true, dob: true, social_link: true, photo: true });
  assert.equal('photo_key' in seen.application, false);
  assert.ok(!bodies.join('\n').includes('merchant-review/'), 'no response carries the photo key');

  // The «توثيق التجار» notice is ids only.
  const notice = submittedNoticeText('mapp_abc', 3);
  assert.equal(notice, '⚡ New merchant application awaiting review\nApplication: mapp_abc\nRevision: 3');
});

test('the review photo is re-encoded (no EXIF), private, keeps no file name, and 404s on /files for everyone', async () => {
  const w = world();
  const { id } = await completeDraft(w);
  const key = appRow(w.raw, id)!.photo_key!;
  assert.match(key, new RegExp(`^merchant-review/${id}/photo/[a-z0-9]+\\.webp$`));
  assert.ok(await w.bucket.head(key), 'stored in the PRIVATE bucket');
  assert.equal(await w.legacy.head(key), null, 'never in the legacy bucket');
  assert.equal(w.images.calls.at(-1)?.format, 'image/webp', 'the Images binding re-encoded it');
  assert.ok(!everyText(w.raw).includes('qorvan-selfie'), 'the original file name is not recorded');

  for (const [who, user] of [['the applicant', APPLICANT], ['an admin', REVIEWER]] as const) {
    const res = await w.appAs(user).request(`/files/${key}`);
    assert.equal(res.status, 404, `${who} read the review photo through /files`);
  }
  const guest = await w.appAs(null).request(`/files/${key}`);
  assert.notEqual(guest.status, 200);

  // Replacing it deletes the old object.
  assert.equal((await uploadPhoto(w.app, pngBytes(800, 600))).status, 200);
  const next = appRow(w.raw, id)!.photo_key!;
  assert.notEqual(next, key);
  assert.equal(await w.bucket.head(key), null, 'the replaced photo is gone');

  // Anything but JPEG or PNG is refused before a byte is stored.
  const gif = new Uint8Array([0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 1, 0, 1, 0, 0, 0, 0, 0, 0, 0]);
  const refused = await w.app.request('/api/merchant-application/photo', { method: 'POST', body: photoForm(gif, 'a.gif', 'image/gif') });
  assert.equal(refused.status, 400);
  assert.equal((await json(refused)).code, 'PHOTO_TYPE_UNSUPPORTED');
});

test('503 MERCHANT_REVIEW_NOT_CONFIGURED without the key ring, the private bucket or the re-encoder — and nothing is stored', async () => {
  for (const opts of [{ key: null }, { key: 'not-a-key' }, { privateBucket: false }] as const) {
    const w = world(opts);
    for (const res of [
      await put(w.app, '/api/merchant-application', { legal_name: NAME, dob: DOB }),
      await uploadPhoto(w.app),
      await post(w.app, '/api/merchant-application/submit', {}),
    ]) {
      assert.equal(res.status, 503, JSON.stringify(opts));
      assert.equal((await json(res)).code, 'MERCHANT_REVIEW_NOT_CONFIGURED');
    }
    assert.equal(count(w.raw, 'SELECT COUNT(*) AS n FROM merchant_applications'), 0);
    const seen = await json(await get(w.app, '/api/merchant-application'));
    assert.equal(seen.requirements.ready, false);
  }
  const noImages = world({ images: false });
  assert.equal((await put(noImages.app, '/api/merchant-application', { public_name: 'Orbit Prints' })).status, 200);
  const photo = await uploadPhoto(noImages.app);
  assert.equal(photo.status, 503, 'a photo that would keep its EXIF is never stored');
  assert.equal(noImages.bucket.objects.size, 0);
});

// --------------------------------------------------------- the applicant rules

test('names, dates and links: compound names pass, impossible dates and foreign links do not', () => {
  assert.deepEqual(parseLegalName({ given: '  عبد   الله ', father: 'محمد علي', grandfather: "O'Neil-Smith" }), {
    given: 'عبد الله',
    father: 'محمد علي',
    grandfather: "O'Neil-Smith",
  });
  assert.equal(parseLegalName({ given: 'A', father: 'Bb', grandfather: 'Cc' }), null, 'a part is at least two letters');
  assert.equal(parseLegalName({ given: 'Aa1', father: 'Bb', grandfather: 'Cc' }), null, 'no digits');
  assert.equal(parseLegalName({ given: 'Aa', father: 'Bb' }), null, 'three parts');

  assert.equal(parseDob('2000-02-29', '2026-10-18'), '2000-02-29');
  assert.equal(parseDob('2001-02-29', '2026-10-18'), null, 'not a calendar date');
  assert.equal(parseDob('2030-01-01', '2026-10-18'), null, 'not in the future');
  assert.equal(parseDob('1990-07-14T00:00:00Z', '2026-10-18'), null, 'a date, never a timestamp');
  assert.equal(ageOn('2008-10-18', '2026-10-18'), 18, 'eighteen ON the birthday');
  assert.equal(ageOn('2008-10-19', '2026-10-18'), 17);

  assert.equal(parseSocialLink('instagram.com/some.shop?utm=x#y'), 'https://instagram.com/some.shop');
  assert.equal(parseSocialLink('https://m.facebook.com/some.page/'), 'https://m.facebook.com/some.page');
  assert.equal(parseSocialLink('https://instagram.com/'), null, 'a profile, not the home page');
  assert.equal(parseSocialLink('https://instagram.com.evil.example/x'), null);
  assert.equal(parseSocialLink('javascript:alert(1)'), null);
});

test('C6: under 18 is refused at save and at submit; an unverified phone is refused at submit', async () => {
  const w = world();
  const today = new Date(Date.now() + 3 * 3_600_000).toISOString().slice(0, 10);
  const minor = `${Number(today.slice(0, 4)) - 17}${today.slice(4)}`;
  const minorRes = await put(w.app, '/api/merchant-application', { dob: minor });
  assert.equal(minorRes.status, 400);
  assert.equal((await json(minorRes)).code, 'APPLICANT_UNDER_18');

  const noPhone = world({ phone: false });
  await completeDraft(noPhone);
  const refused = await post(noPhone.app, '/api/merchant-application/submit', {});
  assert.equal(refused.status, 400);
  assert.equal((await json(refused)).code, 'PHONE_NOT_VERIFIED');
  assert.equal(row<{ state: string }>(noPhone.raw, "SELECT state FROM merchant_applications WHERE user_id='u_app'")!.state, 'draft');
  // A revoked link is no verified phone either.
  const revoked = world();
  revoked.raw.exec("UPDATE telegram_links SET revoked_at = '2026-02-01T00:00:00.000Z' WHERE user_id = 'u_app'");
  await completeDraft(revoked);
  assert.equal((await json(await post(revoked.app, '/api/merchant-application/submit', {}))).code, 'PHONE_NOT_VERIFIED');
});

test('submit names what is missing, by field', async () => {
  const w = world();
  await put(w.app, '/api/merchant-application', { public_name: 'Orbit Prints' });
  const res = await post(w.app, '/api/merchant-application/submit', {});
  assert.equal(res.status, 400);
  const body = await json(res);
  assert.equal(body.code, 'APPLICATION_INCOMPLETE');
  assert.deepEqual(body.details.missing, ['legal_name', 'dob', 'social_link', 'photo']);
});

test('C3: applying needs no PLUS — an account with no membership applies and submits', async () => {
  const w = world();
  assert.equal(count(w.raw, "SELECT COUNT(*) AS n FROM memberships WHERE user_id = 'u_app'"), 0);
  await completeDraft(w);
  assert.equal((await post(w.app, '/api/merchant-application/submit', {})).status, 200);
});

// --------------------------------------------------------------- retention

test('C7: 90 days after a withdrawal the sealed values are blanked, the photo deleted, the trail kept', async () => {
  const w = world();
  const { id } = await completeDraft(w);
  const photo = appRow(w.raw, id)!.photo_key!;
  const out = await json(await post(w.app, '/api/merchant-application/withdraw', { operation_id: 'op-withdraw-01' }));
  assert.equal(out.application.state, 'withdrawn');
  const until = appRow(w.raw, id)!.retention_until!;
  const days = (Date.parse(until) - Date.now()) / 86_400_000;
  assert.ok(days > 89.9 && days <= 90, `retention is 90 days (${days})`);

  const early = await sweepMerchantApplicationRetention({ ...w.env, DB: w.db } as never, new Date(Date.parse(until) - 1000).toISOString());
  assert.equal(early.purged, 0);
  assert.ok(await w.bucket.head(photo));

  const due = await sweepMerchantApplicationRetention({ ...w.env, DB: w.db } as never, new Date(Date.parse(until) + 1000).toISOString());
  assert.deepEqual(due, { scanned: 1, purged: 1, photo_failures: 0, failures: 0 });
  const r = appRow(w.raw, id)!;
  assert.equal(r.legal_name_enc, '');
  assert.equal(r.dob_enc, '');
  assert.equal(r.social_link_enc, '');
  assert.equal(r.photo_key, null);
  assert.ok(r.purged_at);
  assert.equal(await w.bucket.head(photo), null, 'the photo object is deleted');
  assert.deepEqual(
    all<{ action: string }>(w.raw, 'SELECT action FROM merchant_application_events WHERE application_id = ? ORDER BY at, rowid', id).map((e) => e.action),
    ['created', 'withdrawn', 'purged']
  );
  // A second pass finds nothing; a live application is never touched.
  assert.equal((await sweepMerchantApplicationRetention({ ...w.env, DB: w.db } as never, new Date(Date.parse(until) + 5000).toISOString())).scanned, 0);
});

// ------------------------------------------------------- append-only, grants

const sweepAt = (w: ReturnType<typeof world>, at: string) => sweepMerchantApplicationRetention({ ...w.env, DB: w.db } as never, at);
const keysUnder = (w: ReturnType<typeof world>, id: string) => [...w.bucket.objects.keys()].filter((k) => k.startsWith(`merchant-review/${id}/`)).sort();
const after = (until: string, ms = 1000) => new Date(Date.parse(until) + ms).toISOString();

test("C7: no client takes the sweep's operation id — a withdraw sent as 'purge:<id>' is still purged", async () => {
  const w = world();
  const { id } = await completeDraft(w);
  // A client id never carries ':' — every server id lives in a ':' namespace.
  for (const reserved of [`purge:${id}`, `create:${id}`, 'srv:abcdefgh1234']) assert.equal(validClientOperationId(reserved), false, reserved);
  assert.equal(validClientOperationId('op-withdraw-01'), true);

  const out = await post(w.app, '/api/merchant-application/withdraw', { operation_id: `purge:${id}` });
  assert.equal(out.status, 200, await out.clone().text());
  const ops = all<{ operation_id: string }>(w.raw, 'SELECT operation_id FROM merchant_application_events WHERE application_id = ?', id).map((e) => e.operation_id);
  assert.ok(!ops.includes(`purge:${id}`), 'the client id never lands in a server namespace');
  // Even an event already holding `purge:<id>` (whatever wrote it) cannot block the purge: the sweep's id is fresh.
  w.raw
    .prepare(
      `INSERT INTO merchant_application_events (id, application_id, revision, actor_id, actor_kind, action, reason_public, at, operation_id)
       VALUES ('mape_seeded', ?, 1, 'u_app', 'applicant', 'withdrawn', '', '2026-01-01T00:00:00.000Z', ?)`
    )
    .run(id, `purge:${id}`);

  const until = appRow(w.raw, id)!.retention_until!;
  assert.deepEqual(await sweepAt(w, after(until)), { scanned: 1, purged: 1, photo_failures: 0, failures: 0 });
  const r = appRow(w.raw, id)!;
  assert.ok(r.purged_at);
  assert.equal(r.legal_name_enc, '');
  assert.equal(r.dob_enc, '');
  assert.equal(r.social_link_enc, '');
});

test('C7: a blanking that fails for any reason but a lost race is REPORTED and retried, never counted as purged', async () => {
  const w = world();
  const { id } = await completeDraft(w);
  assert.equal((await post(w.app, '/api/merchant-application/withdraw', { operation_id: 'op-withdraw-fail' })).status, 200);
  const until = appRow(w.raw, id)!.retention_until!;
  w.raw.exec(`CREATE TRIGGER fail_purged_event BEFORE INSERT ON merchant_application_events
              WHEN NEW.action = 'purged' BEGIN SELECT RAISE(ABORT, 'simulated write failure'); END;`);
  assert.deepEqual(await sweepAt(w, after(until)), { scanned: 1, purged: 0, photo_failures: 0, failures: 1 });
  assert.equal(appRow(w.raw, id)!.purged_at, null, 'nothing pretended to be purged');
  w.raw.exec('DROP TRIGGER fail_purged_event');
  assert.deepEqual(await sweepAt(w, after(until, 2000)), { scanned: 1, purged: 1, photo_failures: 0, failures: 0 });
  assert.ok(appRow(w.raw, id)!.purged_at);
});

test("C7: the purge empties the application's whole private prefix, not only the current photo", async () => {
  const w = world();
  const { id } = await completeDraft(w);
  // An object a failed replace-delete or a lost upload race left behind.
  await w.bucket.put(`merchant-review/${id}/photo/leftover01.webp`, new Uint8Array([1, 2, 3]));
  assert.equal(keysUnder(w, id).length, 2);
  assert.equal((await post(w.app, '/api/merchant-application/withdraw', { operation_id: 'op-withdraw-pre' })).status, 200);
  const until = appRow(w.raw, id)!.retention_until!;
  assert.equal((await sweepAt(w, after(until))).purged, 1);
  assert.deepEqual(keysUnder(w, id), [], 'no photograph of this person survives');
});

test('two overlapping photo uploads: one wins, the loser deletes its own object — nothing is left unreferenced', async () => {
  const w = world();
  const { id } = await completeDraft(w);
  const first = appRow(w.raw, id)!.photo_key!;
  // Hold every store until BOTH uploads have read the application (photo P0), then let them land one by one.
  const put = w.bucket.put.bind(w.bucket);
  const held: Array<() => void> = [];
  let bothHeld!: () => void;
  const both = new Promise<void>((r) => (bothHeld = r));
  w.bucket.put = (async (...args: Parameters<typeof put>) => {
    await new Promise<void>((release) => {
      held.push(release);
      if (held.length === 2) bothHeld();
    });
    return put(...args);
  }) as typeof w.bucket.put;
  const a = uploadPhoto(w.app);
  const b = uploadPhoto(w.app);
  await both;
  held[0]();
  const firstDone = await Promise.race([a, b]);
  held[1]();
  const statuses = [(await a).status, (await b).status].sort();
  w.bucket.put = put;
  assert.deepEqual(statuses, [200, 409], `one wins (first answered ${firstDone.status})`);
  const now = appRow(w.raw, id)!.photo_key!;
  assert.notEqual(now, first);
  assert.deepEqual(keysUnder(w, id), [now], 'only the referenced photo is stored');
});

test('a refused photo never moves a SUBMITTED application back to draft', async () => {
  const w = world();
  const { id } = await completeDraft(w);
  assert.equal((await post(w.app, '/api/merchant-application/submit', { operation_id: 'op-submit-photo' })).status, 200);
  const before = appRow(w.raw, id)!;
  assert.equal(before.state, 'submitted');

  w.images.state.mode = 'throw9422';
  const refused = await uploadPhoto(w.app);
  assert.equal(refused.status, 400);
  assert.equal((await json(refused)).code, 'PHOTO_UNREADABLE');
  const still = appRow(w.raw, id)!;
  assert.equal(still.state, 'submitted', 'still with the reviewer');
  assert.equal(still.revision, before.revision);
  assert.deepEqual(keysUnder(w, id), [before.photo_key], 'nothing new stored');

  // A photo that IS stored reopens it, as any edit does.
  w.images.state.mode = 'ok';
  const ok = await uploadPhoto(w.app);
  assert.equal(ok.status, 200, await ok.clone().text());
  const reopened = appRow(w.raw, id)!;
  assert.equal(reopened.state, 'draft');
  assert.equal(reopened.revision, before.revision + 1);
  assert.deepEqual(keysUnder(w, id), [reopened.photo_key]);
});

test('submit re-checks completeness in its own write: a draft blanked after the check is not submitted', async () => {
  const w = world();
  const { id } = await completeDraft(w);
  const checked = appRow(w.raw, id)!;
  // A draft save lands between the route's completeness check and the submit batch (draft saves keep the revision).
  w.raw.prepare("UPDATE merchant_applications SET public_name = '' WHERE id = ?").run(id);
  const out = await applyTransition(w.db, { application: checked, action: 'submit', actor: { id: 'u_app', kind: 'applicant' }, operationId: 'op-submit-stale' });
  assert.deepEqual(out, { ok: false, code: 'APPLICATION_CHANGED' });
  assert.equal(appRow(w.raw, id)!.state, 'draft');
  assert.equal(count(w.raw, "SELECT COUNT(*) AS n FROM merchant_application_events WHERE application_id = ? AND action = 'submitted'", id), 0);
});

test('the activity description keeps its line breaks; spaces and blank-line runs collapse', async () => {
  const w = world();
  const saved = await put(w.app, '/api/merchant-application', { activity_description: '  line   one\r\n\r\n\r\n\nline two  \nthree ' });
  assert.equal(saved.status, 200, await saved.clone().text());
  assert.equal((await json(saved)).application.review.activity_description, 'line one\n\nline two\nthree');
});

test('the event trail rejects UPDATE and DELETE', async () => {
  const w = world();
  await put(w.app, '/api/merchant-application', { public_name: 'Orbit Prints' });
  assert.equal(count(w.raw, 'SELECT COUNT(*) AS n FROM merchant_application_events'), 1);
  assert.throws(() => w.raw.exec("UPDATE merchant_application_events SET reason_public = 'x'"), /append-only/);
  assert.throws(() => w.raw.exec('DELETE FROM merchant_application_events'), /append-only/);
});

test('C5: who reviews — owner and full admins by default, an assistant only with a live MERCHANT_REVIEW grant, never a customer', async () => {
  const w = world();
  w.raw.exec(`
    INSERT INTO users (id,email,password_hash,role,admin_scope) VALUES
      ('u_asst','asst@example.test','h','admin','assistant'),
      ('u_asst2','asst2@example.test','h','admin','assistant');
    UPDATE users SET admin_scope = 'assistant' WHERE id = 'u_asst';
    UPDATE users SET admin_scope = 'assistant' WHERE id = 'u_asst2';
  `);
  const env = { DB: w.db, INITIAL_ADMIN_EMAIL: 'boss@x.co' };
  assert.equal(await canReviewMerchants(env, { id: 'u_owner', role: 'admin', email: 'boss@x.co', admin_scope: 'assistant' }), true);
  assert.equal(await canReviewMerchants(env, { id: 'u_rev', role: 'admin', email: 'r@example.test', admin_scope: 'full' }), true);
  assert.equal(await canReviewMerchants(env, { id: 'u_rev', role: 'admin', email: 'r@example.test', admin_scope: null }), true);
  assert.equal(await canReviewMerchants(env, { id: 'u_asst', role: 'admin', email: 'asst@example.test', admin_scope: 'assistant' }), false);
  assert.equal(await canReviewMerchants(env, { id: 'u_app', role: 'customer', email: 'applicant@example.test' }), false);
  assert.equal(await canReviewMerchants(env, null), false);

  w.raw.exec(`INSERT INTO admin_capability_grants (id, user_id, grant_key, granted_by, operation_id)
              VALUES ('acg_1', 'u_asst', 'MERCHANT_REVIEW', 'u_owner', 'op-grant-0001')`);
  assert.equal(await canReviewMerchants(env, { id: 'u_asst', role: 'admin', email: 'asst@example.test', admin_scope: 'assistant' }), true);
  assert.equal(await canReviewMerchants(env, { id: 'u_asst2', role: 'admin', email: 'asst2@example.test', admin_scope: 'assistant' }), false, 'the grant is per person');

  // The grant table's own rules.
  assert.throws(() => w.raw.exec(`INSERT INTO admin_capability_grants (id, user_id, grant_key, granted_by, operation_id) VALUES ('acg_self', 'u_owner', 'MERCHANT_REVIEW', 'u_owner', 'op-grant-self')`), /CHECK constraint failed/);
  assert.throws(() => w.raw.exec(`INSERT INTO admin_capability_grants (id, user_id, grant_key, granted_by, operation_id) VALUES ('acg_2', 'u_asst', 'MERCHANT_REVIEW', 'u_owner', 'op-grant-0002')`), /UNIQUE constraint failed/, 'one live grant per key');
  assert.throws(() => w.raw.exec(`INSERT INTO admin_capability_grants (id, user_id, grant_key, granted_by, operation_id) VALUES ('acg_3', 'u_asst2', 'merchant review', 'u_owner', 'op-grant-0003')`), /CHECK constraint failed/);
  assert.throws(() => w.raw.exec("UPDATE admin_capability_grants SET grant_key = 'OTHER_KEY' WHERE id = 'acg_1'"), /only be revoked/);
  assert.throws(() => w.raw.exec("DELETE FROM admin_capability_grants WHERE id = 'acg_1'"), /append-only/);
  // Demotion revokes.
  w.raw.exec("UPDATE users SET role = 'customer' WHERE id = 'u_asst'");
  assert.equal(row<{ revoked_by: string }>(w.raw, "SELECT revoked_by FROM admin_capability_grants WHERE id = 'acg_1'")!.revoked_by, 'system:role_change');
  w.raw.exec("UPDATE users SET role = 'admin', admin_scope = 'assistant' WHERE id = 'u_asst'");
  assert.equal(await canReviewMerchants(env, { id: 'u_asst', role: 'admin', email: 'asst@example.test', admin_scope: 'assistant' }), false);
});

// ------------------------------------------------------------ schema absence

test('a database without 0204 fails closed: no application, no approval, no grant, an empty sweep', async () => {
  const w = world({ through: '0203' });
  const seen = await json(await get(w.app, '/api/merchant-application'));
  assert.equal(seen.available, false);
  assert.equal(seen.application, null);
  const res = await put(w.app, '/api/merchant-application', { public_name: 'Orbit Prints' });
  assert.equal(res.status, 503);
  assert.equal((await json(res)).code, 'MERCHANT_APPLICATIONS_UNAVAILABLE');
  w.raw.exec("INSERT INTO community_merchants (id, user_id, name) VALUES ('cm_old', 'u_app', 'Old Shop')");
  assert.deepEqual(await merchantApprovalOf(w.db, 'u_app'), { merchant: true, approved: false });
  assert.equal(
    await canReviewMerchants({ DB: w.db, INITIAL_ADMIN_EMAIL: 'boss@x.co' }, { id: 'u_rev', role: 'admin', email: 'r@example.test', admin_scope: 'assistant' }),
    false
  );
  assert.deepEqual(await sweepMerchantApplicationRetention({ ...w.env, DB: w.db } as never), { scanned: 0, purged: 0, photo_failures: 0, failures: 0 });
});
