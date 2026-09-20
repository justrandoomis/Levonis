/**
 * THE WATCHDOG ON CODE-VERSUS-SCHEMA DRIFT.
 *
 * The fault it watches for has taken this site down twice — a Worker deployed
 * ahead of its migrations, 500ing on whatever page touches the newest table —
 * and both times it was found by the owner looking at a broken screen. The
 * automatic migration (`.github/workflows/auto-migrate-on-push.yml`) closes the
 * window; this alarm is what covers that automation failing, which is the one
 * case the automation itself cannot.
 *
 * SO THE THING UNDER TEST IS NOT "does it detect drift" — readSchemaStatus
 * already had tests for that. It is whether the alarm is one somebody will
 * still be listening to in six months:
 *
 *   - it fires ONCE per distinct drift, not every fifteen minutes;
 *   - it says when the drift is OVER, so the reader is not left guessing;
 *   - it does not cry on `ahead` or `unknown`, which nobody can act on;
 *   - an unbound group or a refusing Telegram does NOT make it retry for ever;
 *   - and it works on a database that is actually behind, which is the whole
 *     point and the easiest property to break by putting its bookkeeping in a
 *     table a pending migration was going to create.
 *
 * Only Telegram's HTTP endpoint is stubbed. Everything else is the real router
 * reading real bindings out of a real SQLite built from the real migrations.
 *
 * Run: npx tsx --test tests/schemaDriftAlarm.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { DatabaseSync } from 'node:sqlite';
import { freshDb, dbThrough, asD1 } from './fixtures/app';
import {
  checkSchemaDrift,
  driftSignature,
  DRIFT_STATE_KEY,
  REPEAT_AFTER_MS,
} from '../worker/lib/schemaDriftAlarm';
import { EXPECTED_MIGRATION, EXPECTED_MIGRATION_COUNT, readSchemaStatus } from '../worker/lib/schemaVersion';
import type { Env } from '../worker/lib/types';

const GROUP = '-1001234567890';

/** The admin group, bound the way the owner actually bound theirs. */
function bindGroup(raw: DatabaseSync): void {
  raw
    .prepare(
      `INSERT INTO telegram_admin_config (id, group_chat_id, group_title, configured_by, configured_by_tg)
       VALUES ('singleton', ?, 'Levonis', 'boss', 1)`
    )
    .run(GROUP);
  raw
    .prepare(
      `INSERT INTO telegram_admin_topics (topic_key, message_thread_id, enabled, configured_by, configured_by_tg)
       VALUES ('general', 7, 1, 'boss', 1)`
    )
    .run();
}

/**
 * D1's own bookkeeping table, which `wrangler d1 migrations apply` writes and
 * `dbThrough` does not — the fixture execs the SQL files directly. Building it
 * here is what lets a test say "the database has run N of them" at all.
 */
function recordApplied(raw: DatabaseSync, names: readonly string[]): void {
  raw.exec('CREATE TABLE IF NOT EXISTS d1_migrations (id INTEGER PRIMARY KEY, name TEXT, applied_at TEXT)');
  for (const n of names) raw.prepare('INSERT INTO d1_migrations (name) VALUES (?)').run(n);
}

/** Every migration the code expects, so the database reads `current`. */
function appliedNames(count = EXPECTED_MIGRATION_COUNT, newest = EXPECTED_MIGRATION): string[] {
  const out: string[] = [];
  for (let i = 0; i < count - 1; i++) out.push(`${String(i + 1).padStart(4, '0')}_x.sql`);
  out.push(newest);
  return out;
}

interface Sent {
  chat_id: string;
  message_thread_id?: number;
  text: string;
}

function stubTelegram(mode: 'ok' | 'refuse' = 'ok'): { sent: Sent[]; restore: () => void } {
  const sent: Sent[] = [];
  const real = globalThis.fetch;
  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    const href = String(url);
    if (!href.includes('api.telegram.org')) return real(url as never, init as never);
    sent.push(JSON.parse(String(init?.body ?? '{}')) as Sent);
    if (mode === 'refuse') {
      return new Response(JSON.stringify({ ok: false, description: 'chat not found' }), { status: 400 });
    }
    return new Response(
      JSON.stringify({ ok: true, result: { message_id: 9, chat: { id: Number(GROUP) } } }),
      { status: 200 }
    );
  }) as typeof fetch;
  return { sent, restore: () => { globalThis.fetch = real; } };
}

const envFor = (raw: DatabaseSync): Env =>
  ({ DB: asD1(raw), TELEGRAM_ADMIN_BOT_TOKEN: '999:ADMINTOKEN' }) as unknown as Env;

const storedState = (raw: DatabaseSync): { signature: string; notified_at: string } | null => {
  const row = raw.prepare('SELECT value FROM admin_settings WHERE key = ?').get(DRIFT_STATE_KEY) as
    | { value: string }
    | undefined;
  return row ? JSON.parse(row.value) : null;
};

// ------------------------------------------------------------ the signature

test('the signature separates a short tail from a hole in the middle', () => {
  // These are the two independent readings readSchemaStatus makes, and they
  // fail apart: a database missing 0090 but carrying 0097 has the right newest
  // NAME and the wrong COUNT. A signature built on only one of them would call
  // the second drift "the same as" the first and stay silent about it.
  const base = {
    expected: '0097_x.sql',
    state: 'behind' as const,
    behind: 1,
    expected_count: 95,
  };
  const shortTail = driftSignature({ ...base, applied: '0096_x.sql', applied_count: 94 });
  const hole = driftSignature({ ...base, applied: '0097_x.sql', applied_count: 94 });
  assert.notEqual(shortTail, hole, 'two different faults share one signature');
});

// ---------------------------------------------------------------- it fires

test('a database behind the code gets exactly one message, in the general topic', async () => {
  // 0083 is the real shape of this fault: the admin-bot tables (0080) are
  // there, so there IS a channel to shout down, and the newest tables are not.
  const raw = dbThrough('0083');
  bindGroup(raw);
  recordApplied(raw, appliedNames(83, '0083_x.sql'));
  const tg = stubTelegram();
  try {
    const env = envFor(raw);
    const status = await readSchemaStatus(env.DB);
    assert.equal(status.state, 'behind', 'the fixture is not actually drifting');

    const report = await checkSchemaDrift(env);
    assert.equal(report.sent, 'drift');
    assert.equal(report.state, 'behind');
    assert.ok(report.behind > 0);
    assert.equal(tg.sent.length, 1, 'one message, not one per topic');
    assert.equal(tg.sent[0].chat_id, GROUP);
    assert.equal(tg.sent[0].message_thread_id, 7, 'it did not land in the general topic');

    // The message must carry what the reader needs to act, not just an alarm
    // bell: both versions, the shortfall, and the name of the remedy.
    const text = tg.sent[0].text;
    assert.match(text, /متأخرة عن الكود/);
    assert.ok(text.includes(EXPECTED_MIGRATION), 'the expected migration is not named');
    assert.ok(text.includes('0083_x.sql'), 'what is actually applied is not named');
    assert.match(text, /Repair Staging Database/, 'the reader is not told what to run');
  } finally {
    tg.restore();
  }
});

test('the same drift on the next tick is silent — a watchdog that shouts is muted', async () => {
  const raw = dbThrough('0083');
  bindGroup(raw);
  recordApplied(raw, appliedNames(83, '0083_x.sql'));
  const tg = stubTelegram();
  try {
    const env = envFor(raw);
    assert.equal((await checkSchemaDrift(env)).sent, 'drift');
    for (let tick = 0; tick < 4; tick++) {
      assert.equal((await checkSchemaDrift(env)).sent, null, `tick ${tick} spoke again`);
    }
    assert.equal(tg.sent.length, 1, 'the cron runs every 15 minutes; this is 4 of them');
  } finally {
    tg.restore();
  }
});

test('a drift still there a day later is said once more', async () => {
  const raw = dbThrough('0083');
  bindGroup(raw);
  recordApplied(raw, appliedNames(83, '0083_x.sql'));
  const tg = stubTelegram();
  try {
    const env = envFor(raw);
    await checkSchemaDrift(env);
    // Age the stored timestamp rather than the clock: the rule under test is
    // "older than REPEAT_AFTER_MS", and a test that sleeps a day is a test
    // nobody runs.
    const state = storedState(raw)!;
    raw
      .prepare('UPDATE admin_settings SET value = ? WHERE key = ?')
      .run(
        JSON.stringify({ ...state, notified_at: new Date(Date.now() - REPEAT_AFTER_MS - 1000).toISOString() }),
        DRIFT_STATE_KEY
      );

    const again = await checkSchemaDrift(env);
    assert.equal(again.sent, 'repeat');
    assert.equal(tg.sent.length, 2);
    assert.match(tg.sent[1].text, /ما زالت متأخرة/, 'the repeat reads like a first report');
  } finally {
    tg.restore();
  }
});

test('drifting FURTHER speaks immediately, without waiting out the day', async () => {
  const raw = dbThrough('0083');
  bindGroup(raw);
  recordApplied(raw, appliedNames(83, '0083_x.sql'));
  const tg = stubTelegram();
  try {
    const env = envFor(raw);
    await checkSchemaDrift(env);
    assert.equal(tg.sent.length, 1);

    // A migration was rolled back, or a repair removed a row: a NEW fault, and
    // the daily quiet period must not swallow it.
    raw.prepare('DELETE FROM d1_migrations WHERE name = ?').run('0083_x.sql');
    const report = await checkSchemaDrift(env);
    assert.equal(report.sent, 'drift', 'a worse drift was silenced by the repeat window');
    assert.equal(tg.sent.length, 2);
  } finally {
    tg.restore();
  }
});

// ------------------------------------------------------------- it stands down

test('when the migration lands, it says so — once', async () => {
  const raw = freshDb();
  bindGroup(raw);
  recordApplied(raw, appliedNames(83, '0083_x.sql'));
  const tg = stubTelegram();
  try {
    const env = envFor(raw);
    assert.equal((await checkSchemaDrift(env)).sent, 'drift');

    // The workflow ran.
    raw.exec('DELETE FROM d1_migrations');
    recordApplied(raw, appliedNames());
    assert.equal((await readSchemaStatus(env.DB)).state, 'current');

    const recovered = await checkSchemaDrift(env);
    assert.equal(recovered.sent, 'recovered');
    assert.match(tg.sent[1].text, /لحقت الكود/);

    // And then quiet. An alarm that keeps announcing good news is an alarm.
    assert.equal((await checkSchemaDrift(env)).sent, null);
    assert.equal(tg.sent.length, 2);
    assert.equal(storedState(raw)!.signature, '', 'the cleared state was not recorded');
  } finally {
    tg.restore();
  }
});

test('a site that has never drifted is never told it recovered', async () => {
  // The first tick after any deploy runs this. A "✅ recovered" message for a
  // fault that never happened is how an operator learns to ignore the channel.
  const raw = freshDb();
  bindGroup(raw);
  recordApplied(raw, appliedNames());
  const tg = stubTelegram();
  try {
    const report = await checkSchemaDrift(envFor(raw));
    assert.equal(report.state, 'current');
    assert.equal(report.sent, null);
    assert.equal(tg.sent.length, 0);
    assert.equal(storedState(raw), null, 'a quiet tick wrote bookkeeping nobody needs');
  } finally {
    tg.restore();
  }
});

test('`ahead` and `unknown` are reported, not alarmed', async () => {
  const tg = stubTelegram();
  try {
    // AHEAD: the ordinary state during a rollback, and during the minute
    // between this migration landing and Cloudflare finishing its build.
    const ahead = freshDb();
    bindGroup(ahead);
    recordApplied(ahead, [...appliedNames(), '9999_from_the_future.sql']);
    const a = await checkSchemaDrift(envFor(ahead));
    assert.equal(a.state, 'ahead');
    assert.equal(a.sent, null);

    // UNKNOWN: a database not built by `migrations apply` at all. Nobody can
    // act on it, and a database with no d1_migrations table is every test
    // fixture and every local dev copy.
    const unknown = freshDb();
    bindGroup(unknown);
    const u = await checkSchemaDrift(envFor(unknown));
    assert.equal(u.state, 'unknown');
    assert.equal(u.sent, null);

    assert.equal(tg.sent.length, 0);
  } finally {
    tg.restore();
  }
});

// --------------------------------------------------------- it cannot loop

test('a Telegram that refuses does not make it retry every fifteen minutes', async () => {
  // THE FAILURE THIS PINS. The obvious implementation writes the de-duplication
  // state only after a successful send — which turns an unbound group, a
  // deleted topic or an hour of Telegram being down into a message attempt on
  // every single tick, for as long as the drift lasts. The daily repeat IS the
  // retry; there is no second one.
  const raw = dbThrough('0083');
  bindGroup(raw);
  recordApplied(raw, appliedNames(83, '0083_x.sql'));
  const tg = stubTelegram('refuse');
  try {
    const env = envFor(raw);
    const first = await checkSchemaDrift(env);
    assert.equal(first.sent, 'drift');
    assert.ok(first.error, 'a refused send was reported as a success');

    assert.equal((await checkSchemaDrift(env)).sent, null);
    assert.equal((await checkSchemaDrift(env)).sent, null);
    assert.equal(tg.sent.length, 1, 'it kept hammering a chat that refuses');
  } finally {
    tg.restore();
  }
});

test('a corrupt bookkeeping row cannot silence the alarm', async () => {
  // Fail open, not closed. Unreadable state must mean "we do not know whether
  // this was reported", and the safe reading of that is to report it.
  const raw = dbThrough('0083');
  bindGroup(raw);
  recordApplied(raw, appliedNames(83, '0083_x.sql'));
  const tg = stubTelegram();
  try {
    const env = envFor(raw);
    raw
      .prepare('INSERT INTO admin_settings (key, value) VALUES (?, ?)')
      .run(DRIFT_STATE_KEY, 'not json at all');
    assert.equal((await checkSchemaDrift(env)).sent, 'drift');
    assert.equal(tg.sent.length, 1);
  } finally {
    tg.restore();
  }
});

test('the alarm never throws, whatever the database does', async () => {
  // It is a cron step beside the outbox. A watchdog that can take a customer's
  // notification down with it has made the reliability worse than the fault.
  const raw = dbThrough('0083');
  bindGroup(raw);
  recordApplied(raw, appliedNames(83, '0083_x.sql'));
  const tg = stubTelegram();
  try {
    const env = envFor(raw);
    // No bot token: resolveAdminDestination has nothing to send with.
    const noToken = { ...env, TELEGRAM_ADMIN_BOT_TOKEN: '' } as unknown as Env;
    const report = await checkSchemaDrift(noToken);
    assert.equal(report.state, 'behind');
    assert.equal(tg.sent.length, 0, 'it invented a send with no token');
  } finally {
    tg.restore();
  }
});
