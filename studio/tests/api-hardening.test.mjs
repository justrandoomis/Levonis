/**
 * P1-10 Studio hardening — behavioural tests against the real handlers.
 *
 *   - a cross-site (and a same-site store subdomain) write to /api is refused
 *     before anything is written; reads and same-origin writes pass;
 *   - the D1 fixed-window rate limit: the budget, the 429 with Retry-After,
 *     separate read/write buckets, per-account keys, the window turning, the
 *     cron dropping stale windows — and a key derivation identical to the
 *     main site's worker/lib/ratelimit.ts (run side by side, not re-read);
 *   - the persisted Simple/Advanced mode: Simple for everyone by default, one
 *     account's choice never leaks to another, invalid values refused, and
 *     migration 0002 safe on every path (absent, after the bootstrap, twice).
 *
 * Same harness as api-projects.test.mjs: TypeScript sources through Node's
 * type stripping, D1 over node:sqlite running the real drizzle/ SQL.
 * The main-site module is loaded through the strip-types TRANSFORM (its
 * import graph has constructs plain stripping refuses), exactly as
 * auth-handoff.test.mjs does.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { registerHooks, stripTypeScriptTypes } from "node:module";
import { DatabaseSync } from "node:sqlite";

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier.startsWith(".") && !/\.[a-zA-Z]+$/.test(specifier)) {
      try {
        return nextResolve(`${specifier}.ts`, context);
      } catch {
        /* fall through to the default resolution */
      }
    }
    return nextResolve(specifier, context);
  },
  load(url, context, nextLoad) {
    if (url.startsWith("file:") && url.endsWith(".ts")) {
      const source = readFileSync(fileURLToPath(url), "utf8");
      return {
        format: "module",
        source: stripTypeScriptTypes(source, { mode: "transform", sourceUrl: url }),
        shortCircuit: true,
      };
    }
    return nextLoad(url, context);
  },
});

const { apiRouter, resetEnsuredTablesForTests } = await import("../worker/api/router.ts");
const ratelimit = await import("../worker/api/ratelimit.ts");
const { runCleanup } = await import("../worker/api/cleanup.ts");
const prefsMod = await import("../worker/api/prefs.ts");
const mainRatelimit = await import("../../worker/lib/ratelimit.ts");

// ---------------------------------------------------------------------------
// D1 over node:sqlite (the same adapter shape api-projects.test.mjs uses).
// ---------------------------------------------------------------------------

class FakeStatement {
  constructor(db, sql, params = []) {
    this.db = db;
    this.sql = sql;
    this.params = params;
  }
  bind(...params) {
    return new FakeStatement(this.db, this.sql, params.map((p) => (p === undefined ? null : p)));
  }
  async first() {
    const row = this.db.prepare(this.sql).get(...this.params);
    return row === undefined ? null : row;
  }
  async all() {
    return { success: true, results: this.db.prepare(this.sql).all(...this.params) };
  }
  async run() {
    const info = this.db.prepare(this.sql).run(...this.params);
    return { success: true, meta: { changes: Number(info.changes), last_row_id: Number(info.lastInsertRowid) } };
  }
}

class FakeD1 {
  constructor(db) {
    this.db = db;
  }
  prepare(sql) {
    return new FakeStatement(this.db, sql);
  }
  async batch(statements) {
    this.db.exec("BEGIN");
    try {
      const out = [];
      for (const stmt of statements) out.push(await stmt.run());
      this.db.exec("COMMIT");
      return out;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }
}

const sql = (name) => readFileSync(new URL(`../drizzle/${name}`, import.meta.url), "utf8");
const MIGRATIONS = {
  "0000": sql("0000_studio_projects.sql"),
  "0001": sql("0001_project_archive_pins.sql"),
  "0002": sql("0002_user_prefs.sql"),
};

function applySql(raw, text) {
  for (const part of text.split("--> statement-breakpoint")) {
    const stmt = part.trim();
    if (stmt) raw.exec(stmt);
  }
}

/** upTo: the last migration applied ("0002" = the live shape after this push). */
function makeEnv({ upTo = "0002", vars = {} } = {}) {
  const raw = new DatabaseSync(":memory:");
  raw.exec("PRAGMA foreign_keys = ON");
  for (const [id, text] of Object.entries(MIGRATIONS)) {
    if (upTo && id <= upTo) applySql(raw, text);
  }
  resetEnsuredTablesForTests();
  return { env: { DB: new FakeD1(raw), ...vars }, raw };
}

const CTX = { waitUntil() {} };
const STUDIO = "https://studio.levonis-iq.com";

function sessionFor(userId) {
  return { sessionId: `sess-${userId}`, user: { id: userId, display_name: userId, locale: "ar" } };
}
const USER_A = sessionFor("a1b2c3d4-user-a");
const USER_B = sessionFor("e5f6a7b8-user-b");

async function call(env, session, method, path, { body, headers = {} } = {}) {
  const init = { method, headers: { ...headers } };
  if (body !== undefined) {
    init.body = JSON.stringify(body);
    init.headers["Content-Type"] = "application/json";
  }
  const response = await apiRouter(new Request(`${STUDIO}${path}`, init), env, CTX, session);
  const type = response.headers.get("Content-Type") || "";
  const json = type.includes("application/json") ? await response.json() : null;
  return { response, json };
}

const projectCount = (raw) => raw.prepare("SELECT COUNT(*) AS n FROM projects").get().n;

// ---------------------------------------------------------------------------
// Cross-origin writes
// ---------------------------------------------------------------------------

test("a cross-site POST to /api is refused before anything is written", async () => {
  const { env, raw } = makeEnv();
  for (const headers of [
    { Origin: "https://evil.example" },
    // A community-store subdomain is SAME-SITE: the Lax Studio cookie rides
    // along, so only the Origin can refuse it.
    { Origin: "https://ali3d.levonis-iq.com" },
    // The main site itself is not the Studio either.
    { Origin: "https://levonis-iq.com" },
    // Sandboxed frames and opaque redirects send the literal "null".
    { Origin: "null" },
    // No Origin, but the browser still says where it came from.
    { "Sec-Fetch-Site": "cross-site" },
    { "Sec-Fetch-Site": "same-site" },
  ]) {
    const { response, json } = await call(env, USER_A, "POST", "/api/projects", { body: { name: "forged" }, headers });
    assert.equal(response.status, 403, JSON.stringify(headers));
    assert.equal(json.code, "CROSS_ORIGIN_REFUSED");
    assert.equal(response.headers.get("Cache-Control"), "private, no-store");
  }
  for (const [method, path] of [
    ["PUT", "/api/uploads/aaaabbbbccccdddd"],
    ["DELETE", "/api/projects/aaaabbbbccccdddd"],
    ["PUT", "/api/prefs"],
  ]) {
    const { response } = await call(env, USER_A, method, path, { body: { mode: "advanced" }, headers: { Origin: "https://evil.example" } });
    assert.equal(response.status, 403, `${method} ${path}`);
  }
  assert.equal(projectCount(raw), 0, "a refused write must not have created anything");
  assert.equal(raw.prepare("SELECT COUNT(*) AS n FROM studio_rate_limits").get().n, 0,
    "the refusal comes before the rate limit — it costs no database write");
});

test("same-origin writes, header-less clients and every read pass the origin check", async () => {
  const { env, raw } = makeEnv();
  const same = await call(env, USER_A, "POST", "/api/projects", {
    body: { name: "own page" },
    headers: { Origin: STUDIO, "Sec-Fetch-Site": "same-origin" },
  });
  assert.equal(same.response.status, 201);
  // No Origin and no Sec-Fetch-Site: a non-browser client, which carries no
  // ambient cookie of ours. Refusing it would break nothing an attacker uses.
  const bare = await call(env, USER_A, "POST", "/api/projects", { body: { name: "cli" } });
  assert.equal(bare.response.status, 201);
  assert.equal(projectCount(raw), 2);
  // A read is never refused for its Origin (it changes nothing).
  const read = await call(env, USER_A, "GET", "/api/projects", { headers: { Origin: "https://evil.example" } });
  assert.equal(read.response.status, 200);
  const health = await call(env, null, "GET", "/api/health", { headers: { "Sec-Fetch-Site": "cross-site" } });
  assert.equal(health.response.status, 200);
});

test("POST /auth/logout and /api share ONE origin rule", () => {
  const source = readFileSync(new URL("../worker/auth/callback.ts", import.meta.url), "utf8");
  const logout = source.slice(source.indexOf("async function handleLogout"));
  assert.match(logout.slice(0, 800), /isCrossOriginWrite\(request, url\.origin\)/);
  const router = readFileSync(new URL("../worker/api/router.ts", import.meta.url), "utf8");
  const refusal = router.slice(router.indexOf("export function refuseCrossOriginApiWrite"));
  assert.match(refusal.slice(0, 400), /isReadMethod\(request\.method\)[\s\S]*isCrossOriginWrite\(request, new URL\(request\.url\)\.origin\)/);
  // The worker entry refuses BEFORE the session lookup, the router again for any caller.
  const entry = readFileSync(new URL("../worker/index.ts", import.meta.url), "utf8");
  const api = entry.slice(entry.indexOf('url.pathname.startsWith("/api/")'));
  assert.ok(api.indexOf("refuseCrossOriginApiWrite(request)") > 0, "the entry calls the refusal");
  assert.ok(api.indexOf("refuseCrossOriginApiWrite(request)") < api.indexOf("loadLiveStudioSession(request, env)"),
    "the refusal comes before the session lookup");
  assert.match(router, /const refused = refuseCrossOriginApiWrite\(request\);\n\s*if \(refused\) return refused;/);
});

// ---------------------------------------------------------------------------
// Rate limit
// ---------------------------------------------------------------------------

test("the rate-limit key is derived exactly as the main site derives it", () => {
  const cases = [
    ["studio_api_write", "usr_1", "1.2.3.4", undefined],
    ["studio_api_read", null, "1.2.3.4", undefined],
    ["studio_api_read", null, "unknown", undefined],
    ["login", null, "5.6.7.8", "deadbeef"],
    ["login", "usr_2", "5.6.7.8", "deadbeef"],
  ];
  for (const args of cases) {
    assert.equal(ratelimit.rateLimitKey(...args), mainRatelimit.rateLimitKey(...args), JSON.stringify(args));
  }
  // Signed in, the account is the key (carrier NAT puts strangers on one IP).
  assert.equal(ratelimit.rateLimitKey("b", "usr_1", "9.9.9.9"), "b:u:usr_1");
});

test("rate-limit window: the budget holds, the next call gets 429 with Retry-After, the next window opens again", async () => {
  const { env } = makeEnv({ vars: { STUDIO_RATE_LIMIT_WRITES: "3", STUDIO_RATE_LIMIT_READS: "5", STUDIO_RATE_LIMIT_WINDOW_SECONDS: "60" } });
  const req = (method) => new Request(`${STUDIO}/api/projects`, { method });
  // Drive the limiter directly with an explicit clock: 10:00:05 in a window.
  const t0 = Date.UTC(2026, 9, 19, 10, 0, 5);
  const { ensureStudioTables } = await import("../worker/api/router.ts");
  await ensureStudioTables(env.DB);
  for (let i = 0; i < 3; i++) assert.equal(await ratelimit.chargeStudioRateLimit(env, req("POST"), USER_A, t0 + i), null);
  const refused = await ratelimit.chargeStudioRateLimit(env, req("POST"), USER_A, t0 + 10);
  assert.equal(refused.status, 429);
  assert.equal(refused.headers.get("Retry-After"), "55", "seconds left in the 60 s window");
  const body = await refused.json();
  assert.equal(body.code, "RATE_LIMITED");
  assert.equal(body.retry_after_seconds, 55);
  // Reads have their own bucket; another account has its own key.
  assert.equal(await ratelimit.chargeStudioRateLimit(env, req("GET"), USER_A, t0 + 11), null);
  assert.equal(await ratelimit.chargeStudioRateLimit(env, req("POST"), USER_B, t0 + 12), null);
  // The window turns at 10:01:00 and the count starts again.
  const t1 = Date.UTC(2026, 9, 19, 10, 1, 0);
  assert.equal(await ratelimit.chargeStudioRateLimit(env, req("POST"), USER_A, t1), null);
  const row = env.DB.db.prepare("SELECT window_start, count FROM studio_rate_limits WHERE key = ?").get("studio_api_write:u:a1b2c3d4-user-a");
  assert.deepEqual({ ...row }, { window_start: Math.floor(t1 / 1000), count: 1 });
});

test("the router charges signed-in account calls and answers 429 past the budget; guests and health cost nothing", async () => {
  const { env, raw } = makeEnv({ vars: { STUDIO_RATE_LIMIT_WRITES: "2", STUDIO_RATE_LIMIT_READS: "100" } });
  assert.equal((await call(env, USER_A, "POST", "/api/projects", { body: { name: "1" } })).response.status, 201);
  assert.equal((await call(env, USER_A, "POST", "/api/projects", { body: { name: "2" } })).response.status, 201);
  const third = await call(env, USER_A, "POST", "/api/projects", { body: { name: "3" } });
  assert.equal(third.response.status, 429);
  assert.equal(third.json.code, "RATE_LIMITED");
  assert.ok(Number(third.response.headers.get("Retry-After")) >= 1);
  assert.equal(projectCount(raw), 2, "the refused call created nothing");
  // Reads still work for the same account; the other account is untouched.
  assert.equal((await call(env, USER_A, "GET", "/api/projects")).response.status, 200);
  assert.equal((await call(env, USER_B, "POST", "/api/projects", { body: { name: "b" } })).response.status, 201);
  // A guest is refused with 401 before any database work, and health is free.
  const before = raw.prepare("SELECT COUNT(*) AS n FROM studio_rate_limits").get().n;
  assert.equal((await call(env, null, "POST", "/api/projects", { body: { name: "g" } })).response.status, 401);
  assert.equal((await call(env, null, "GET", "/api/health")).response.status, 200);
  assert.equal(raw.prepare("SELECT COUNT(*) AS n FROM studio_rate_limits").get().n, before);
});

test("the defaults sit far above what the editor does, and the env overrides them", () => {
  assert.deepEqual(ratelimit.studioRateLimits({}), { windowSeconds: 60, reads: 1200, writes: 600 });
  // One autosave of a 64-file revision is OPEN + 64 PUT + COMMIT = 66 writes;
  // the 2.5 s debounce allows at most 24 saves a minute of ordinary size.
  assert.ok(ratelimit.DEFAULT_RATE_LIMITS.writes >= 66 * 4, "several full-size saves fit in one window");
  assert.deepEqual(
    ratelimit.studioRateLimits({ STUDIO_RATE_LIMIT_WINDOW_SECONDS: "10", STUDIO_RATE_LIMIT_READS: "7", STUDIO_RATE_LIMIT_WRITES: "x" }),
    { windowSeconds: 10, reads: 7, writes: 600 }
  );
});

test("the cleanup cron drops rate-limit windows older than a day", async () => {
  const { env, raw } = makeEnv();
  const now = Date.UTC(2026, 9, 19, 12, 0, 0);
  const nowS = Math.floor(now / 1000);
  raw.prepare("INSERT INTO studio_rate_limits (key, window_start, count) VALUES (?, ?, ?)").run("old", nowS - 90_000, 4);
  raw.prepare("INSERT INTO studio_rate_limits (key, window_start, count) VALUES (?, ?, ?)").run("fresh", nowS - 60, 4);
  const report = await runCleanup(env, now);
  assert.equal(report.expired_rate_limit_windows, 1);
  assert.deepEqual(raw.prepare("SELECT key FROM studio_rate_limits").all().map((r) => r.key), ["fresh"]);
});

// ---------------------------------------------------------------------------
// Simple / Advanced mode preference
// ---------------------------------------------------------------------------

test("mode: Simple for everyone by default; a choice is stored per account and never leaks", async () => {
  const { env } = makeEnv();
  const first = await call(env, USER_A, "GET", "/api/prefs");
  assert.equal(first.response.status, 200);
  assert.deepEqual(first.json.prefs, { mode: "simple" });
  assert.equal(first.json.stored, false);
  assert.equal(first.response.headers.get("Cache-Control"), "private, no-store");

  const put = await call(env, USER_A, "PUT", "/api/prefs", { body: { mode: "advanced" }, headers: { Origin: STUDIO } });
  assert.equal(put.response.status, 200);
  assert.deepEqual(put.json.prefs, { mode: "advanced" });
  assert.equal(put.json.stored, true);
  assert.equal((await call(env, USER_A, "GET", "/api/prefs")).json.prefs.mode, "advanced");
  // Another account still opens in Simple.
  const other = await call(env, USER_B, "GET", "/api/prefs");
  assert.deepEqual([other.json.prefs.mode, other.json.stored], ["simple", false]);
  // And back.
  await call(env, USER_A, "PUT", "/api/prefs", { body: { mode: "simple" } });
  const back = await call(env, USER_A, "GET", "/api/prefs");
  assert.deepEqual([back.json.prefs.mode, back.json.stored], ["simple", true]);
});

test("mode: invalid values are refused, guests get 401, an unknown stored value reads as Simple", async () => {
  const { env, raw } = makeEnv();
  for (const body of [{ mode: "expert" }, { mode: 1 }, {}, ["advanced"]]) {
    const { response, json } = await call(env, USER_A, "PUT", "/api/prefs", { body });
    assert.equal(response.status, 400, JSON.stringify(body));
    assert.equal(json.code, "INVALID_MODE");
  }
  assert.equal((await call(env, USER_A, "POST", "/api/prefs", { body: { mode: "simple" } })).response.status, 405);
  assert.equal((await call(env, null, "GET", "/api/prefs")).response.status, 401);
  assert.equal((await call(env, null, "PUT", "/api/prefs", { body: { mode: "advanced" } })).response.status, 401);
  // A value a future build wrote (no CHECK on purpose) is not trusted here.
  raw.prepare("INSERT INTO studio_user_prefs (owner_id, mode, updated_at) VALUES (?, ?, ?)").run(USER_A.user.id, "guided", "2026-10-19T00:00:00.000Z");
  const read = await call(env, USER_A, "GET", "/api/prefs");
  assert.deepEqual([read.json.prefs.mode, read.json.stored], ["simple", false]);
  assert.equal(prefsMod.DEFAULT_STUDIO_MODE, "simple");
});

test("migration 0002 is safe on every path: absent (bootstrap), after the bootstrap made its tables, and applied twice", async () => {
  // A database at 0001 (the live shape before this push) serves the new code.
  const { env, raw } = makeEnv({ upTo: "0001" });
  assert.equal((await call(env, USER_A, "PUT", "/api/prefs", { body: { mode: "advanced" } })).response.status, 200);
  // The workflow then applies 0002 over tables the worker already made.
  assert.doesNotThrow(() => applySql(raw, MIGRATIONS["0002"]));
  assert.doesNotThrow(() => applySql(raw, MIGRATIONS["0002"]));
  assert.equal((await call(env, USER_A, "GET", "/api/prefs")).json.prefs.mode, "advanced", "no data lost");
  // The bootstrap's DDL and the migration's agree column for column.
  const viaMigration = makeEnv({ upTo: "0002" }).raw;
  for (const table of ["studio_user_prefs", "studio_rate_limits"]) {
    const cols = (db) => db.prepare(`PRAGMA table_info(${table})`).all().map((c) => [c.name, c.type.toLowerCase(), c.notnull, c.dflt_value, c.pk]);
    assert.deepEqual(cols(raw), cols(viaMigration), table);
  }
  // And a cron run on a database no API call has touched yet still works.
  const cold = makeEnv({ upTo: "0001" });
  assert.equal((await runCleanup(cold.env)).expired_rate_limit_windows, 0);
});
