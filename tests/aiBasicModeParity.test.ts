/**
 * BASIC MODE IS PUSH A, BYTE FOR BYTE (push B plan §16 #5; invariant I11).
 *
 * This file RUNS push A's own corpora — tests/assistAcceptance.test.ts and
 * tests/assistPriceParity.test.ts, every test and every turn of them — and a
 * replay tap (tests/fixtures/app.ts `stubTaps`) sends every assistant request
 * they make again, on the same database at the same moment, under each
 * condition push B must answer in basic mode:
 *
 *   dark            the key, both bindings and Images, the 0210 tables as
 *                   migrations leave them (the state B1 deploys in)
 *   db_only         every task configured, an env holding nothing but the DB
 *   key_no_binding  the key alone, only a speech model (it needs the binding)
 *   no_tables       everything present but the 0210 tables
 *   disabled        the master switch off
 *   no_models       no model row
 *   no_rates        model rows without rates
 *   cap_zero        a cap of zero
 *   cap_spent       today's spend at the cap
 *   circuit_open    the provider's circuit open
 *   rate_limited    the visitor's AI limits spent
 *   timeout         the provider times out (both ranks)
 *   throws          the provider's network fails
 *   bad_json        the provider answers text that is not JSON
 *   refusal         the provider refuses
 *   max_tokens      the provider's answer is cut off
 *   invalid         a JSON answer the validator refuses (an extra key)
 *   none            a valid answer that places nothing (`action: none`)
 *
 * Each turn is first replayed under a PROBE (everything configured, a
 * provider that answers): a turn the probe never sends to the provider cannot
 * reach the consult point under any stricter condition, and is held to push
 * A's bytes under the probe, `dark` and `db_only`; every turn that does reach
 * it is replayed under every condition above. (All eighteen for every turn
 * took 22 minutes; this is the same proof in a fraction of it.)
 *
 * Every replay must answer the same status and the same bytes as the
 * original request, which ran with push A's own environment (`{DB}`): no
 * `mode` field, no new chip, nothing. Readiness says `basic` under every
 * condition the configuration decides. The rate limiter's table is put back
 * to what the original saw before each replay, and the 0210 tables to what
 * they were after, so the corpora run exactly as they do on their own.
 *
 * Run: node --import tsx --test tests/aiBasicModeParity.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { providerFetch, stubApp, stubTaps, type StubTap, type StubTapRequest } from './fixtures/app';
import { KEY, SPEECH_MODEL, TEXT_MODEL, TEXT_MODEL_B, answer, errorResponse, fakeAi } from './fixtures/aiLayer';
import { fakeImages, textReading } from './fixtures/aiRoutes';
import { forgetAiConfig } from '../worker/lib/ai/config';
import { supportRoutes } from '../worker/routes/support';

type Rec = Record<string, unknown>;

interface Condition {
  name: string;
  /** The env beside DB: undefined = everything (the key, the speech binding, Images). */
  env?: Rec;
  /** The 0210 tables: `full` = every task configured, `untouched` = as the original left them. */
  db: 'full' | 'untouched' | ((db: D1Database) => Promise<void>);
  /** Extra writes after `db` (on top of `full`). */
  then?: (db: D1Database, req: StubTapRequest) => Promise<void>;
  provider?: () => Response | Promise<Response>;
  /** Readiness must say basic (the configuration decides it, not a call's fate). */
  readinessBasic: boolean;
}

const FULL_ENV = (): Rec => ({ ANTHROPIC_API_KEY: KEY, AI: fakeAi({}), IMAGES: fakeImages() });
const TABLES = ['ai_settings', 'ai_task_models', 'ai_spend_day', 'ai_usage', 'ai_provider_health'] as const;
const today = () => new Date().toISOString().slice(0, 10);
const later = () => new Date(Date.now() + 10 * 60_000).toISOString();

async function exec(db: D1Database, sql: string, ...binds: unknown[]): Promise<void> {
  await db.prepare(sql).bind(...binds).run();
}

/** Every task configured with rates, a two-rank text chain, a $1 cap, guests and Sorani allowed. */
async function full(db: D1Database): Promise<void> {
  await exec(db, 'UPDATE ai_settings SET enabled = 1, daily_cap_micro_usd = 1000000, guests = 1, guest_share_pct = 100, understand_ckb = 1 WHERE id = 1');
  await exec(db, 'DELETE FROM ai_task_models');
  const row = (task: string, rank: number, provider: string, id: string, inR: number, outR: number, minR: number) =>
    exec(
      db,
      `INSERT INTO ai_task_models (task, rank, provider, model_id, in_micro_per_mtok, out_micro_per_mtok, speech_micro_per_minute) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      task,
      rank,
      provider,
      id,
      inR,
      outR,
      minR
    );
  await row('understand', 0, 'anthropic', TEXT_MODEL, 1_000_000, 5_000_000, 0);
  await row('understand', 1, 'anthropic', TEXT_MODEL_B, 1_000_000, 5_000_000, 0);
  await row('vision', 0, 'anthropic', TEXT_MODEL, 1_000_000, 5_000_000, 0);
  await row('speech', 0, 'workers_ai', SPEECH_MODEL, 0, 0, 6_000);
}

const timeoutError = () => {
  const e = new Error('timed out');
  e.name = 'TimeoutError';
  throw e;
};

const CONDITIONS: Condition[] = [
  { name: 'dark', db: 'untouched', readinessBasic: true },
  { name: 'db_only', env: {}, db: 'full', readinessBasic: true },
  {
    name: 'key_no_binding',
    env: { ANTHROPIC_API_KEY: KEY },
    db: 'full',
    then: async (db) => exec(db, "DELETE FROM ai_task_models WHERE task <> 'speech'"),
    readinessBasic: true,
  },
  {
    name: 'no_tables',
    db: async (db) => {
      for (const t of TABLES) await exec(db, `ALTER TABLE ${t} RENAME TO ${t}__parity`);
    },
    readinessBasic: true,
  },
  { name: 'disabled', db: 'full', then: async (db) => exec(db, 'UPDATE ai_settings SET enabled = 0 WHERE id = 1'), readinessBasic: true },
  { name: 'no_models', db: 'full', then: async (db) => exec(db, 'DELETE FROM ai_task_models'), readinessBasic: true },
  {
    name: 'no_rates',
    db: 'full',
    then: async (db) => exec(db, 'UPDATE ai_task_models SET in_micro_per_mtok = 0, out_micro_per_mtok = 0, speech_micro_per_minute = 0'),
    readinessBasic: true,
  },
  { name: 'cap_zero', db: 'full', then: async (db) => exec(db, 'UPDATE ai_settings SET daily_cap_micro_usd = 0 WHERE id = 1'), readinessBasic: true },
  {
    name: 'cap_spent',
    db: 'full',
    then: async (db) => exec(db, 'INSERT INTO ai_spend_day (day, spent_micro_usd) VALUES (?, 1000000)', today()),
    readinessBasic: true,
  },
  {
    name: 'circuit_open',
    db: 'full',
    then: async (db) => {
      for (const p of ['anthropic', 'workers_ai']) await exec(db, 'INSERT INTO ai_provider_health (provider, open_until) VALUES (?, ?)', p, later());
    },
    readinessBasic: true,
  },
  {
    name: 'rate_limited',
    db: 'full',
    then: async (db, req) => {
      const { rateLimitKey } = await import('../worker/lib/ratelimit');
      const ip = req.headers['cf-connecting-ip'] ?? 'unknown';
      const now = Math.floor(Date.now() / 1000);
      for (const [bucket, window] of [['assist-ai-text', 300], ['assist-ai-text-day', 86_400]] as const) {
        const key = rateLimitKey(bucket, req.user?.id ?? null, ip);
        await exec(db, 'INSERT OR REPLACE INTO rate_limits (key, window_start, count) VALUES (?, ?, 999)', key, now - (now % window));
      }
    },
    readinessBasic: false,
  },
  { name: 'timeout', db: 'full', provider: timeoutError, readinessBasic: false },
  {
    name: 'throws',
    db: 'full',
    provider: () => {
      throw new TypeError('fetch failed');
    },
    readinessBasic: false,
  },
  { name: 'bad_json', db: 'full', provider: () => answer(null, { rawText: 'not json at all' }), readinessBasic: false },
  { name: 'refusal', db: 'full', provider: () => answer(textReading({ action: 'triage', symptom: 'clog' }), { stop: 'refusal' }), readinessBasic: false },
  { name: 'max_tokens', db: 'full', provider: () => answer(textReading({ action: 'triage', symptom: 'clog' }), { stop: 'max_tokens' }), readinessBasic: false },
  { name: 'invalid', db: 'full', provider: () => answer({ ...textReading({ action: 'triage', symptom: 'clog' }), note: 'extra' }), readinessBasic: false },
  { name: 'none', db: 'full', provider: () => answer(textReading()), readinessBasic: false },
];

// A provider failure the circuit counts would open it: the same conditions also leave basic, never the reverse.
void errorResponse;

interface Snapshot {
  rateLimits: Rec[];
}

const tally = { requests: 0, replays: 0, consulted: 0, providerCalls: 0, skipped: 0, readiness: 0 };
const mismatches: string[] = [];
let replaying = false;

async function rows(db: D1Database, table: string): Promise<Rec[]> {
  return ((await db.prepare(`SELECT * FROM ${table}`).all<Rec>()).results ?? []).map((r) => ({ ...r }));
}

async function restoreRows(db: D1Database, table: string, saved: Rec[]): Promise<void> {
  await exec(db, `DELETE FROM ${table}`);
  for (const r of saved) {
    const cols = Object.keys(r);
    await exec(db, `INSERT INTO ${table} (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`, ...cols.map((c) => r[c]));
  }
}

async function hasTable(db: D1Database, name: string): Promise<boolean> {
  const r = await db.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE type = 'table' AND name = ?").bind(name).first<{ n: number }>();
  return Number(r?.n ?? 0) === 1;
}

const isAssistantTurn = (req: StubTapRequest) => req.method === 'POST' && req.path.split('?')[0] === '/api/support/assistant';

/**
 * THE PROBE: everything configured and a provider that answers a valid reading that would change
 * the reply (a read-only intent). A turn the probe does not send to the provider never reaches the
 * consult point, and no stricter condition can send it there: every condition below only removes
 * or breaks something on the way to the provider. Such a turn is held to push A's bytes under the
 * probe itself and two representative conditions; every turn that DOES reach the consult point is
 * replayed under all of them.
 */
const PROBE: Condition = { name: 'probe', db: 'full', provider: () => answer(textReading({ action: 'intent', intent: 'bot_identity' })), readinessBasic: false };
const REPRESENTATIVE = ['dark', 'db_only'];

const tap: StubTap = {
  async before(req) {
    if (replaying || !isAssistantTurn(req)) return null;
    const db = req.db as D1Database;
    return { rateLimits: await rows(db, 'rate_limits') } satisfies Snapshot;
  },
  async after(req) {
    if (replaying || !isAssistantTurn(req)) return;
    const snapshot = req.state as Snapshot | null;
    if (!snapshot) return;
    tally.requests++;
    const db = req.db as D1Database;
    if (!(await hasTable(db, 'ai_settings'))) {
      tally.skipped++;
      return;
    }
    const original = req.response;
    const originalStatus = original.status;
    const originalBody = await original.text();
    replaying = true;
    // What the original left behind, to put back after the replays.
    const afterOriginal = { rateLimits: await rows(db, 'rate_limits'), ai: {} as Record<string, Rec[]> };
    for (const t of TABLES) afterOriginal.ai[t] = await rows(db, t);
    /** One replay under `cond`, on the state the original saw; the 0210 tables put back after. */
    const replay = async (cond: Condition): Promise<{ status: number; body: string; consulted: boolean }> => {
      await restoreRows(db, 'rate_limits', snapshot.rateLimits);
      if (cond.db === 'full') await full(db);
      else if (typeof cond.db === 'function') await cond.db(db);
      await cond.then?.(db, req);
      forgetAiConfig();
      providerFetch.attempts.length = 0;
      providerFetch.handler = cond.provider ? async () => cond.provider!() : null;
      try {
        const app = stubApp(req.db, req.user, (a) => a.route('/api/support', supportRoutes), {
          ...req.opts,
          env: { ...(req.opts.env ?? {}), ...(cond.env ?? FULL_ENV()) },
          publishV2: false,
        });
        // No execution context: the ledger's bookkeeping is awaited inside the replay.
        const res = await app.request(req.path, { method: req.method, headers: { ...req.headers, 'x-stub-replay': '1' }, body: req.body });
        return { status: res.status, body: await res.text(), consulted: providerFetch.attempts.length > 0 };
      } finally {
        if (typeof cond.db === 'function') {
          for (const t of TABLES) await exec(db, `ALTER TABLE ${t}__parity RENAME TO ${t}`);
        }
        for (const t of TABLES) await restoreRows(db, t, afterOriginal.ai[t]!);
      }
    };
    const check = (cond: Condition, got: { status: number; body: string }) => {
      tally.replays++;
      if (got.status !== originalStatus || got.body !== originalBody) {
        mismatches.push(`[${cond.name}] ${req.body.slice(0, 160)}\n  push A: ${originalStatus} ${originalBody.slice(0, 300)}\n  replay: ${got.status} ${got.body.slice(0, 300)}`);
      }
    };
    try {
      const probe = await replay(PROBE);
      const conditions = probe.consulted ? CONDITIONS : CONDITIONS.filter((c) => REPRESENTATIVE.includes(c.name));
      if (probe.consulted) {
        tally.consulted++;
        // The probe's own answer is AI-assisted, so it differs; it must say so.
        if (!/"mode":"ai"/.test(probe.body)) mismatches.push(`[probe] reached the provider but is not marked: ${probe.body.slice(0, 200)}`);
      } else {
        check(PROBE, probe);
      }
      for (const cond of conditions) {
        const got = await replay(cond);
        if (got.consulted) tally.providerCalls++;
        check(cond, got);
      }
    } finally {
      await restoreRows(db, 'rate_limits', afterOriginal.rateLimits);
      for (const t of TABLES) await restoreRows(db, t, afterOriginal.ai[t]!);
      providerFetch.handler = null;
      providerFetch.attempts.length = 0;
      forgetAiConfig();
      replaying = false;
    }
  },
};

stubTaps.push(tap);
// Push A's corpora, every test of them, run here with the tap installed.
await import('./assistAcceptance.test.ts');
await import('./assistPriceParity.test.ts');

test('every assistant turn of push A’s corpora answers byte for byte under every basic condition', () => {
  stubTaps.splice(stubTaps.indexOf(tap), 1);
  console.log(JSON.stringify({ parity: tally }));
  assert.deepEqual(mismatches.slice(0, 5), [], `${mismatches.length} replies differ from push A`);
  assert.ok(tally.requests >= 150, `only ${tally.requests} assistant turns were replayed`);
  assert.equal(tally.skipped, 0);
  // Every turn: the probe or all conditions; the ones the probe sent to the provider, every condition.
  assert.equal(tally.replays, tally.consulted * CONDITIONS.length + (tally.requests - tally.consulted) * (REPRESENTATIVE.length + 1));
  // Some turns end at the clarify point, and there the failure conditions really reached the provider.
  assert.ok(tally.consulted > 0, 'no turn reached the consult point: the conditions proved nothing');
  assert.ok(tally.providerCalls > 0, 'no failure condition ever reached the provider');
});

test('readiness says basic under every condition the configuration decides', async () => {
  const { freshDb, asD1 } = await import('./fixtures/app');
  for (const cond of CONDITIONS.filter((c) => c.readinessBasic)) {
    const db = asD1(freshDb());
    if (cond.db === 'full') await full(db);
    else if (typeof cond.db === 'function') await cond.db(db);
    await cond.then?.(db, { db, user: null, opts: {}, method: 'GET', path: '/', headers: {}, body: '' });
    forgetAiConfig();
    for (const user of [null, { id: 'u_r', role: 'customer' as const, email: 'r@x.co' }]) {
      const app = stubApp(db, user, (a) => a.route('/api/support', supportRoutes), { env: cond.env ?? FULL_ENV(), publishV2: false });
      const body = (await (await app.request('/api/support/assistant/readiness')).json()) as Rec;
      assert.equal(body.mode, 'basic', `${cond.name}: ${JSON.stringify(body)}`);
      tally.readiness++;
    }
  }
  assert.equal(tally.readiness, CONDITIONS.filter((c) => c.readinessBasic).length * 2);
});
