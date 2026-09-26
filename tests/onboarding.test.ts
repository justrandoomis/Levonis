/**
 * Handles, profile completion, and not being annoying about it.
 *
 * Three things are being pinned here, and each one has a specific way of
 * going wrong that this file exists to prevent:
 *
 *   A USERNAME THAT IMPERSONATES THE PLATFORM. `support`, `admin`, `levonis`
 *   next to a message reads as a message from us. The rule has to hold on
 *   every path that can set a handle — signup, the account page, a handle
 *   DERIVED from a Google address — not just the one somebody remembered.
 *
 *   A COMPLETION FLAG THAT DISAGREES WITH THE PROFILE. Stored booleans go
 *   stale; this one is computed from the fields on every read, so the test is
 *   that it tracks the fields rather than that it was set correctly once.
 *
 *   A PROMPT THAT NEVER STOPS. «أكمل ملفك الشخصي» is asked ONCE, right after
 *   the account is created — whatever the signup method — and the decision
 *   is made server-side, so a close follows the person across devices.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Hono } from 'hono';
import { ROOT, SqliteD1 } from './fixtures/d1';
import type { AppContext, Env } from '../worker/lib/types';
import { HttpError } from '../worker/lib/http';
import { authRoutes } from '../worker/routes/auth';
import { profileRoutes } from '../worker/routes/profile';
import {
  RESERVED_USERNAMES,
  canonicalUsername,
  suggestUsername,
  usernameRejection,
} from '../worker/lib/usernames';
import {
  computeCompletion,
  shouldPromptCompletion,
  isPlaceholderEmail,
} from '../worker/lib/profileCompletion';

function db() {
  const raw = new DatabaseSync(':memory:');
  raw.exec('PRAGMA foreign_keys = ON;');
  const dir = join(ROOT, 'migrations');
  for (const f of readdirSync(dir).filter((x) => x.endsWith('.sql')).sort()) {
    raw.exec(readFileSync(join(dir, f), 'utf8'));
  }
  return { raw, d1: new SqliteD1(raw) as unknown as D1Database };
}

function app(d1: D1Database, userId: string | null = null, env: Partial<Env> = {}) {
  const a = new Hono<AppContext>();
  a.use('*', async (c, next) => {
    c.env = { DB: d1, ...env } as Env;
    if (userId) {
      const row = await d1.prepare('SELECT * FROM users WHERE id = ?').bind(userId).first();
      c.set('user', row as never);
    }
    await next();
  });
  a.route('/api/auth', authRoutes);
  a.route('/api/profile', profileRoutes);
  a.onError((err, c) => {
    if (err instanceof HttpError) {
      return c.json({ success: false, error: err.message, code: err.code }, err.status as 400);
    }
    throw err;
  });
  return a;
}

const json = (body: unknown) => ({
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(body),
});
const patch = (body: unknown) => ({ ...json(body), method: 'PATCH' });

// ============================================================== the handle

test('every reserved handle is refused, and refused as RESERVED', () => {
  for (const name of RESERVED_USERNAMES) {
    assert.equal(usernameRejection(name), 'reserved', name);
  }
  // The ones worth naming: these are impersonation, not taste.
  for (const name of ['levonis', 'support', 'admin', 'official', 'noreply', 'studio']) {
    assert.equal(usernameRejection(name), 'reserved', name);
  }
});

test('an ordinary handle is accepted', () => {
  for (const name of ['ali3d', 'sara.maker', 'levo_fan', 'baghdad-3d', 'x9y']) {
    assert.equal(usernameRejection(name), null, name);
  }
});

test('the refusal says WHICH rule was broken, because "invalid" helps nobody', () => {
  assert.equal(usernameRejection('ab'), 'too_short');
  assert.equal(usernameRejection('a'.repeat(31)), 'too_long');
  assert.equal(usernameRejection('ali 3d'), 'bad_characters');
  assert.equal(usernameRejection('ali@3d'), 'bad_characters');
  assert.equal(usernameRejection('.ali3d'), 'bad_edges');
  assert.equal(usernameRejection('ali3d-'), 'bad_edges');
  assert.equal(usernameRejection('ali..3d'), 'repeated_punctuation');
  assert.equal(usernameRejection('12345'), 'all_digits');
});

test('handles are one name in any case — `Ali3D` and `ali3d` cannot both exist', () => {
  assert.equal(canonicalUsername('  Ali3D  '), 'ali3d');
  assert.equal(usernameRejection('ADMIN'), 'reserved');
});

test('a suggestion is never a name the rules would refuse', () => {
  assert.equal(suggestUsername('ali3d@gmail.com'), 'ali3d');
  assert.equal(suggestUsername('Sara.Maker@example.com'), 'sara.maker');
  // Reserved, too short, or unusable → no suggestion at all, rather than one
  // that fails the moment it is submitted.
  assert.equal(suggestUsername('admin@gmail.com'), '');
  assert.equal(suggestUsername('ab@x.co'), '');
  assert.equal(suggestUsername('...@x.co'), '');
  for (const seed of ['ali3d@gmail.com', 'sara@x.co', 'levo_fan@x.co']) {
    const s = suggestUsername(seed);
    if (s) assert.equal(usernameRejection(s), null, s);
  }
});

// -------------------------------------------------- the availability check

test('the availability endpoint answers free, taken and reserved differently', async () => {
  const { raw, d1 } = db();
  raw.exec("INSERT INTO users (id,email,username,name) VALUES ('u1','a@b.co','ali3d','A')");
  const a = app(d1);

  const free = await (await a.request('/api/auth/username-available?u=sara.maker')).json() as Record<string, unknown>;
  assert.equal(free.available, true);
  assert.equal(free.reason, null);

  const taken = await (await a.request('/api/auth/username-available?u=ali3d')).json() as Record<string, unknown>;
  assert.equal(taken.available, false);
  assert.equal(taken.reason, 'taken');

  const reserved = await (await a.request('/api/auth/username-available?u=support')).json() as Record<string, unknown>;
  assert.equal(reserved.available, false);
  assert.equal(reserved.reason, 'reserved');

  const short = await (await a.request('/api/auth/username-available?u=ab')).json() as Record<string, unknown>;
  assert.equal(short.reason, 'too_short');
});

test('case does not hide a taken name', async () => {
  const { raw, d1 } = db();
  raw.exec("INSERT INTO users (id,email,username,name) VALUES ('u1','a@b.co','ali3d','A')");
  const r = await (await app(d1).request('/api/auth/username-available?u=ALI3D')).json() as Record<string, unknown>;
  assert.equal(r.available, false);
});

// ------------------------------------------------ the rule holds on signup

test('signup refuses a reserved handle rather than creating the account', async () => {
  const { raw, d1 } = db();
  const res = await app(d1).request(
    '/api/auth/register',
    json({ email: 'x@y.co', username: 'support', name: 'X', password: 'password-1234' })
  );
  assert.equal(res.status, 400);
  assert.equal(((await res.json()) as Record<string, unknown>).code, 'USERNAME_RESERVED');
  assert.equal(Number((raw.prepare('SELECT COUNT(*) AS n FROM users').get() as { n: number }).n), 0);
});

test('a taken handle at signup is a 409, not a 500', async () => {
  const { raw, d1 } = db();
  raw.exec("INSERT INTO users (id,email,username,name) VALUES ('u1','a@b.co','ali3d','A')");
  const res = await app(d1).request(
    '/api/auth/register',
    json({ email: 'x@y.co', username: 'ali3d', name: 'X', password: 'password-1234' })
  );
  assert.equal(res.status, 409);
  assert.equal(((await res.json()) as Record<string, unknown>).code, 'USERNAME_TAKEN');
});

test('signup stores the country and the language the person was using', async () => {
  const { raw, d1 } = db();
  const res = await app(d1).request(
    '/api/auth/register',
    json({ email: 'x@y.co', username: 'ali3d', name: 'X', password: 'password-1234', country: 'ae', locale: 'ckb' })
  );
  assert.equal(res.status, 200);
  const row = raw.prepare('SELECT country, locale FROM users WHERE email = ?').get('x@y.co') as
    { country: string; locale: string };
  assert.equal(row.country, 'AE');
  assert.equal(row.locale, 'ku'); // the API says ckb, the column stores ku
});

test('an unrecognised country at signup is stored as "not said", never as an error', async () => {
  // A dropdown is not worth failing an account creation over.
  const { raw, d1 } = db();
  const res = await app(d1).request(
    '/api/auth/register',
    json({ email: 'x@y.co', name: 'X', password: 'password-1234', country: 'ZZ' })
  );
  assert.equal(res.status, 200);
  const row = raw.prepare('SELECT country FROM users WHERE email = ?').get('x@y.co') as { country: string | null };
  assert.equal(row.country, null);
});

// ====================================================== profile completion

const FULL = {
  name: 'Sara',
  username: 'sara',
  avatar_key: 'avatars/u1/a.png',
  locale: 'ar',
  country: 'IQ',
  phone_e164: '+9647701234567',
  email: 'sara@example.com',
  onboarding_state: 'done',
};

test('a full profile is 100% and asks for nothing', () => {
  const c = computeCompletion(FULL);
  assert.equal(c.percent, 100);
  assert.equal(c.complete, true);
  assert.deepEqual(c.missing, []);
});

test('completion TRACKS the fields — it is not a flag that can go stale', () => {
  const noAvatar = computeCompletion({ ...FULL, avatar_key: null });
  assert.equal(noAvatar.complete, false);
  assert.ok(noAvatar.missing.includes('avatar'));
  assert.ok(noAvatar.percent < 100 && noAvatar.percent > 0);
  // Fill it in and the same input is complete again, with nothing to update.
  assert.equal(computeCompletion({ ...noAvatar, ...FULL }).complete, true);
});

test('the missing items are ordered by what is worth asking for first', () => {
  const c = computeCompletion({ onboarding_state: 'existing', email: 'a@b.co' });
  // What other people see comes first; the phone is last because supplying it
  // means a Telegram round-trip, and leading with the longest task is how a
  // prompt gets dismissed forever.
  assert.equal(c.missing[0], 'username');
  assert.equal(c.missing[1], 'avatar');
  assert.equal(c.missing[c.missing.length - 1], 'phone');
});

test('a Telegram placeholder address does not count as having an email', () => {
  assert.equal(isPlaceholderEmail('tg-usr_123@telegram.local'), true);
  assert.equal(isPlaceholderEmail('sara@example.com'), false);
  const c = computeCompletion({ ...FULL, email: 'tg-usr_1@telegram.local' });
  assert.ok(c.missing.includes('email'));
});

test('a one-character name is not a name', () => {
  assert.ok(computeCompletion({ ...FULL, name: 'S' }).missing.includes('name'));
  assert.ok(computeCompletion({ ...FULL, name: '   ' }).missing.includes('name'));
});

// ------------------------------------------------------- asking, and stopping


test('a complete profile is never prompted', () => {
  assert.equal(shouldPromptCompletion({ ...FULL, onboarding_state: 'new' }), false);
});

test('a brand-new account that has never been shown the sheet IS prompted', () => {
  assert.equal(shouldPromptCompletion({ ...FULL, avatar_key: null, onboarding_state: 'new' }), true);
});

test('once shown, never again — whether it was closed, completed, or walked away from', () => {
  const shown = { ...FULL, avatar_key: null, onboarding_state: 'new', profile_prompt_at: '2026-03-01T12:00:00Z' };
  assert.equal(shouldPromptCompletion(shown), false);
  for (const state of ['skipped', 'done']) {
    assert.equal(shouldPromptCompletion({ ...FULL, avatar_key: null, onboarding_state: state }), false, state);
  }
});

test('an account from before the question existed is not asked, however incomplete', () => {
  // Migration 0033 moved every account that existed then to 'existing'; the
  // old widening reminder is gone, so none of them is asked again.
  assert.equal(shouldPromptCompletion({ onboarding_state: 'existing', email: 'a@b.co' }), false);
  assert.equal(
    shouldPromptCompletion({ ...FULL, avatar_key: null, onboarding_state: 'done', profile_prompt_at: 'not-a-date' }),
    false
  );
});

// ------------------------------------------------------------- the endpoints

async function seedUser(raw: DatabaseSync, over: Record<string, string> = {}) {
  const cols = { id: 'u1', email: 'sara@example.com', name: 'Sara', ...over };
  raw.prepare(
    `INSERT INTO users (id,email,name,onboarding_state) VALUES (?,?,?,'existing')`
  ).run(cols.id, cols.email, cols.name);
}

test('the completion endpoint reports the same answer the library computes', async () => {
  const { raw, d1 } = db();
  await seedUser(raw);
  const res = await app(d1, 'u1').request('/api/profile/completion');
  const body = (await res.json()) as Record<string, unknown>;
  assert.equal(res.status, 200);
  assert.equal(body.complete, false);
  // An 'existing' account is past its first run: nothing is asked.
  assert.equal(body.shouldPrompt, false);
  assert.ok(Array.isArray(body.missing));
  assert.ok((body.missing as string[]).includes('username'));
});

function newUser(raw: DatabaseSync, id: string, email: string) {
  // No onboarding_state: the column default, exactly what every signup route inserts.
  raw.prepare('INSERT INTO users (id,email,name) VALUES (?,?,?)').run(id, email, 'Sara');
}
const promptOf = async (d1: D1Database, id: string) =>
  ((await (await app(d1, id).request('/api/profile/completion')).json()) as Record<string, unknown>).shouldPrompt;

test('every signup route inserts a first-run account — the sheet is not tied to one method', () => {
  // The email, Google, phone/WhatsApp and Telegram routes all INSERT without
  // naming onboarding_state, so each new row takes the DEFAULT 'new'. A route
  // that set it would opt its signups out of the sheet.
  const auth = readFileSync(join(ROOT, 'worker/routes/auth.ts'), 'utf8');
  const inserts = auth.match(/INSERT INTO users \([^)]*\)/g) ?? [];
  assert.ok(inserts.length >= 5, `expected the five signup inserts, found ${inserts.length}`);
  for (const ins of inserts) assert.doesNotMatch(ins, /onboarding_state|profile_prompt_at/, ins);
  const { raw } = db();
  newUser(raw, 'u9', 'n@x.co');
  const row = raw.prepare('SELECT onboarding_state, profile_prompt_at FROM users WHERE id = ?').get('u9') as
    { onboarding_state: string; profile_prompt_at: string | null };
  assert.equal(row.onboarding_state, 'new');
  assert.equal(row.profile_prompt_at, null);
});

test('shown once: the stamp is on the SERVER, so another device is not asked again', async () => {
  const { raw, d1 } = db();
  newUser(raw, 'u1', 'sara@example.com');
  assert.equal(await promptOf(d1, 'u1'), true);
  const seen = await app(d1, 'u1').request('/api/profile/completion/seen', json({}));
  assert.equal(seen.status, 200);
  // A DIFFERENT app instance — a different browser, as far as the server is concerned.
  assert.equal(await promptOf(d1, 'u1'), false);
  // Idempotent: a second stamp keeps the first.
  const first = (raw.prepare('SELECT profile_prompt_at FROM users WHERE id = ?').get('u1') as { profile_prompt_at: string }).profile_prompt_at;
  await app(d1, 'u1').request('/api/profile/completion/seen', json({}));
  const again = raw.prepare('SELECT profile_prompt_at, profile_prompt_count FROM users WHERE id = ?').get('u1') as
    { profile_prompt_at: string; profile_prompt_count: number };
  assert.equal(again.profile_prompt_at, first);
  assert.equal(again.profile_prompt_count, 1);
});

test('closing the sheet ends the first run ("skipped"), and never overwrites a "done"', async () => {
  const { raw, d1 } = db();
  newUser(raw, 'u1', 'sara@example.com');
  const res = await app(d1, 'u1').request('/api/profile/completion/dismiss', json({}));
  const body = (await res.json()) as { user: Record<string, unknown> };
  assert.equal(res.status, 200);
  assert.equal(body.user.onboarding, 'skipped');
  assert.equal(await promptOf(d1, 'u1'), false);

  newUser(raw, 'u2', 'b@example.com');
  raw.prepare("UPDATE users SET onboarding_state = 'done' WHERE id = 'u2'").run();
  await app(d1, 'u2').request('/api/profile/completion/dismiss', json({}));
  assert.equal((raw.prepare('SELECT onboarding_state FROM users WHERE id = ?').get('u2') as { onboarding_state: string }).onboarding_state, 'done');
});

test('a person can only stamp their OWN row — an id in the body is ignored', async () => {
  const { raw, d1 } = db();
  newUser(raw, 'u1', 'a@example.com');
  newUser(raw, 'u2', 'b@example.com');
  await app(d1, 'u1').request('/api/profile/completion/seen', json({ userId: 'u2', id: 'u2' }));
  await app(d1, 'u1').request('/api/profile/completion/dismiss', json({ userId: 'u2', id: 'u2' }));
  const other = raw.prepare('SELECT onboarding_state, profile_prompt_at FROM users WHERE id = ?').get('u2') as
    { onboarding_state: string; profile_prompt_at: string | null };
  assert.equal(other.onboarding_state, 'new');
  assert.equal(other.profile_prompt_at, null);
  assert.equal(await promptOf(d1, 'u2'), true);
  // Signed out, the routes are closed.
  const anon = await app(d1).request('/api/profile/completion/seen', json({}));
  assert.equal(anon.status, 401);
});

test('finishing the wizard records "done"; skipping records "skipped"; either one ends the sheet', async () => {
  const { raw, d1 } = db();
  newUser(raw, 'u1', 'sara@example.com');
  const done = await app(d1, 'u1').request('/api/profile/onboarding', json({ state: 'done' }));
  assert.equal(done.status, 200);
  assert.equal(
    (raw.prepare('SELECT onboarding_state FROM users WHERE id = ?').get('u1') as { onboarding_state: string })
      .onboarding_state,
    'done'
  );
  assert.equal(await promptOf(d1, 'u1'), false);

  newUser(raw, 'u2', 'b@example.com');
  await app(d1, 'u2').request('/api/profile/onboarding', json({ state: 'skipped' }));
  const row = raw.prepare('SELECT onboarding_state, profile_prompt_at FROM users WHERE id = ?').get('u2') as
    { onboarding_state: string; profile_prompt_at: string | null };
  assert.equal(row.onboarding_state, 'skipped');
  assert.ok(row.profile_prompt_at, 'the wizard did not stamp the sheet as asked');
  assert.equal(await promptOf(d1, 'u2'), false);
});

test('a state the wizard never sends is refused', async () => {
  const { raw, d1 } = db();
  await seedUser(raw);
  const res = await app(d1, 'u1').request('/api/profile/onboarding', json({ state: 'complete' }));
  assert.equal(res.status, 400);
});

// ------------------------------------------------------------- saving fields

test('the account page saves a country and rejects one that is not a country', async () => {
  const { raw, d1 } = db();
  await seedUser(raw);
  const ok = await app(d1, 'u1').request('/api/profile', patch({ country: 'gb' }));
  assert.equal(ok.status, 200);
  assert.equal((raw.prepare('SELECT country FROM users WHERE id = ?').get('u1') as { country: string }).country, 'GB');

  const bad = await app(d1, 'u1').request('/api/profile', patch({ country: 'ZZ' }));
  assert.equal(bad.status, 400);
  assert.equal(((await bad.json()) as Record<string, unknown>).code, 'BAD_COUNTRY');

  // '' clears it back to "not said".
  await app(d1, 'u1').request('/api/profile', patch({ country: '' }));
  assert.equal((raw.prepare('SELECT country FROM users WHERE id = ?').get('u1') as { country: string | null }).country, null);
});

test('a reserved handle is refused from the account page too, not only at signup', async () => {
  const { raw, d1 } = db();
  await seedUser(raw);
  const res = await app(d1, 'u1').request('/api/profile', patch({ username: 'levonis' }));
  assert.equal(res.status, 400);
  assert.equal(((await res.json()) as Record<string, unknown>).code, 'USERNAME_RESERVED');
});

test('an avatar key belonging to somebody else is refused', async () => {
  // The key is a path in the object store. Without this check a person could
  // point their avatar at another account's uploaded file.
  const { raw, d1 } = db();
  await seedUser(raw);
  const res = await app(d1, 'u1').request('/api/profile', patch({ avatarKey: 'avatars/u2/secret.png' }));
  assert.equal(res.status, 400);
  const ok = await app(d1, 'u1').request('/api/profile', patch({ avatarKey: 'avatars/u1/mine.png' }));
  assert.equal(ok.status, 200);
  const canonical = await app(d1, 'u1').request('/api/profile', patch({ avatarKey: 'users/u1/avatar/mine.webp' }));
  assert.equal(canonical.status, 200);
});

test('the user object carries completion, so every surface reads one answer', async () => {
  const { raw, d1 } = db();
  await seedUser(raw);
  const res = await app(d1, 'u1').request('/api/profile', patch({ name: 'Sara Ahmed' }));
  const body = (await res.json()) as { user: Record<string, unknown> };
  const completion = body.user.completion as { percent: number; complete: boolean; missing: string[] };
  assert.equal(typeof completion.percent, 'number');
  assert.equal(completion.complete, false);
  assert.ok(completion.missing.includes('username'));
  assert.equal(body.user.onboarding, 'existing');
  // The phone is masked and the Google subject is a boolean — neither the
  // number nor the subject belongs in a JSON response.
  assert.equal(body.user.has_google, false);
  assert.equal(body.user.phone, null);
});
