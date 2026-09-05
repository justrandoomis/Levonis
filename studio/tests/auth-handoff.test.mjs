/**
 * T2 behavioral tests for the LEVO Studio sign-in handoff (slice S2).
 *
 * Runs BOTH sides of the real implementation in-process — the main worker's
 * Hono route (worker/routes/studio.ts, composed exactly like worker/index.ts
 * does: securityHeaders + originCheck + loadSessionUser) and the Studio
 * worker's auth handler (studio/worker/auth/callback.ts behind the same
 * header sanitizer studio/worker/index.ts applies) — against real SQLite
 * databases (node:sqlite behind a D1-shaped adapter) initialized from the
 * real migration files (0001 + 0012). The Studio→main server-to-server
 * redemption goes through a patched global fetch that dispatches to the main
 * app, so the full round trip is the production code path, not a mock of it.
 *
 * Covered (mandate §14 T2):
 *   - full sign-in round trip: login → handoff start → callback → session
 *   - single-use codes: replay is rejected after one successful redemption
 *   - expired codes are rejected
 *   - destination not in the allowlist is rejected (and mints nothing)
 *   - state mismatch at the callback signs nobody in
 *   - forged oai-* / x-levo-user headers are stripped and never trusted
 *   - redeem/introspect require the shared secret
 *   - logout destroys the server-side session; cross-site logout is refused
 *   - honest 503 when the handoff is not configured
 *
 * Requires Node with type stripping (>=22.18 default-on) to import the TS
 * worker modules; otherwise the suite skips itself honestly.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const canImportTs = !!process.features.typescript;
const skipReason =
  canImportTs === false &&
  "Node >= 22.18 (built-in TypeScript type stripping) is required to import the worker modules";

// D1-shaped adapter over node:sqlite ----------------------------------------

function d1Adapter(db) {
  return {
    prepare(sql) {
      const statement = {
        params: [],
        bind(...args) {
          statement.params = args.map((a) => (a === undefined ? null : a));
          return statement;
        },
        async first() {
          const row = db.prepare(sql).get(...statement.params);
          return row === undefined ? null : row;
        },
        async run() {
          const info = db.prepare(sql).run(...statement.params);
          return {
            success: true,
            meta: { changes: Number(info.changes), last_row_id: Number(info.lastInsertRowid) },
          };
        },
        async all() {
          return { success: true, results: db.prepare(sql).all(...statement.params), meta: {} };
        },
      };
      return statement;
    },
    async batch(statements) {
      const out = [];
      for (const s of statements) out.push(await s.run());
      return out;
    },
    async exec(sql) {
      db.exec(sql);
    },
  };
}

if (!canImportTs) {
  test("studio auth handoff", { skip: skipReason }, () => {});
} else {
  // The worker sources use extensionless relative imports (tsc "bundler"
  // resolution) and a few non-erasable constructs (parameter properties in
  // worker/lib/http.ts); Node's default strip-only loader handles neither.
  // Bridge both with module hooks: retry "./x" as "./x.ts", and transpile
  // .ts sources through the public stripTypeScriptTypes transform.
  const { registerHooks, stripTypeScriptTypes } = await import("node:module");
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

  const { DatabaseSync } = await import("node:sqlite");
  const { Hono } = await import("hono");
  const { studioRoutes } = await import("../../worker/routes/studio.ts");
  const { HttpError, originCheck, securityHeaders } = await import("../../worker/lib/http.ts");
  const { loadSessionUser } = await import("../../worker/lib/session.ts");
  const { sha256Hex, randomToken } = await import("../../worker/lib/crypto.ts");
  const { handleAuthRoute } = await import("../worker/auth/callback.ts");
  const {
    isStudioSessionStillAuthorized,
    loadLiveStudioSession,
    loadStudioSession,
    resetLivenessCacheForTests,
    sanitizeRequestHeaders,
    withUserHeader,
    safeRelativeReturnPath,
  } = await import("../worker/auth/session.ts");

  const MAIN_ORIGIN = "https://levonis-iq.com";
  const STUDIO_ORIGIN = "https://studio.levonis-iq.com";
  const SECRET = "test-handoff-secret-0123456789";
  const CTX = { waitUntil() {}, passThroughOnException() {} };

  // Main worker app + database ----------------------------------------------

  const migrationsDir = fileURLToPath(new URL("../../migrations/", import.meta.url));
  const mainSqlite = new DatabaseSync(":memory:");
  mainSqlite.exec(readFileSync(`${migrationsDir}0001_init.sql`, "utf8"));
  mainSqlite.exec(readFileSync(`${migrationsDir}0012_studio_handoff.sql`, "utf8"));

  const mainEnv = {
    DB: d1Adapter(mainSqlite),
    ASSETS: { fetch: async () => new Response("not used", { status: 404 }) },
    GOOGLE_CLIENT_ID: "",
    INITIAL_ADMIN_EMAIL: "",
    EXTRA_ALLOWED_ORIGINS: "",
    APP_ORIGIN: MAIN_ORIGIN,
    STUDIO_HANDOFF_SECRET: SECRET,
    STUDIO_ALLOWED_DESTINATIONS: `${STUDIO_ORIGIN}, https://studio-staging.levonis-iq.com`,
  };

  const mainApp = new Hono();
  mainApp.use("*", securityHeaders());
  mainApp.use("*", originCheck());
  mainApp.use("*", async (c, next) => {
    await loadSessionUser(c);
    await next();
  });
  mainApp.route("/api/studio", studioRoutes);
  mainApp.onError((err, c) => {
    if (err instanceof HttpError) {
      return c.json({ success: false, error: err.message, code: err.code }, err.status);
    }
    console.error("unexpected main-worker error in test:", err);
    return c.json({ success: false, error: String(err && err.message) }, 500);
  });

  const mainFetch = (path, init) => mainApp.fetch(new Request(`${MAIN_ORIGIN}${path}`, init), mainEnv, CTX);

  // Seed one main-site user with a live levonis_session -----------------------

  const USER_ID = "usr_studiotest0001";
  mainSqlite
    .prepare("INSERT INTO users (id, email, username, name, locale) VALUES (?, ?, ?, ?, ?)")
    .run(USER_ID, "studio-test@example.com", "studiotester", "Ali Studio", "ar");

  async function mintMainSession(userId = USER_ID) {
    const token = randomToken(32);
    const id = await sha256Hex(token);
    const expires = new Date(Date.now() + 3_600_000).toISOString();
    mainSqlite
      .prepare("INSERT INTO sessions (id, user_id, expires_at, user_agent) VALUES (?, ?, ?, ?)")
      .run(id, userId, expires, "node-test");
    return token;
  }
  // Mutable holder: one test rotates the seeded session on purpose.
  const mainSession = { cookie: `levonis_session=${await mintMainSession()}` };

  // Studio worker side --------------------------------------------------------

  const studioSqlite = new DatabaseSync(":memory:");
  const studioEnv = {
    DB: d1Adapter(studioSqlite),
    // Deploy-wiring name from studio/wrangler.jsonc (MAIN_ORIGIN is an alias).
    MAIN_SITE_ORIGIN: MAIN_ORIGIN,
    STUDIO_HANDOFF_SECRET: SECRET,
  };

  // The Studio worker calls the main worker via fetch(); route that traffic
  // to the in-process main app so the real server-to-server path is tested.
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    const req = input instanceof Request ? (init ? new Request(input, init) : input) : new Request(input, init);
    const u = new URL(req.url);
    if (u.origin === MAIN_ORIGIN) return mainApp.fetch(req, mainEnv, CTX);
    throw new Error(`unexpected network call in test: ${req.url}`);
  };
  test.after(() => {
    globalThis.fetch = realFetch;
  });

  // Mirrors studio/worker/index.ts: sanitize headers, then the auth handler.
  const studioFetch = (path, init) =>
    handleAuthRoute(sanitizeRequestHeaders(new Request(`${STUDIO_ORIGIN}${path}`, init)), studioEnv);

  const getCookiePair = (response, name) => {
    const set = response.headers.getSetCookie().find((c) => c.startsWith(`${name}=`));
    return set ? set.split(";")[0] : null;
  };

  const studioSessionCount = () => studioSqlite.prepare("SELECT COUNT(*) AS n FROM studio_sessions").get().n;

  /** Drives the full browser round trip and returns the pieces. */
  async function signInThroughHandoff(returnTo = "/?p=1") {
    const login = await studioFetch(`/auth/login?return_to=${encodeURIComponent(returnTo)}`);
    assert.equal(login.status, 302, "login must redirect to the main worker");
    const handoffCookie = getCookiePair(login, "levo_studio_handoff");
    assert.ok(handoffCookie, "login must set the state cookie");
    const startUrl = new URL(login.headers.get("Location"));
    assert.equal(startUrl.origin, MAIN_ORIGIN);
    assert.equal(startUrl.pathname, "/api/studio/handoff/start");

    const start = await mainFetch(startUrl.pathname + startUrl.search, {
      headers: { Cookie: mainSession.cookie },
    });
    assert.equal(start.status, 302, "signed-in start must redirect to the studio callback");
    const callbackUrl = new URL(start.headers.get("Location"));
    assert.equal(callbackUrl.origin, STUDIO_ORIGIN);
    assert.equal(callbackUrl.pathname, "/auth/callback");
    assert.ok(callbackUrl.searchParams.get("code"), "callback URL carries the code");

    const callback = await studioFetch(callbackUrl.pathname + callbackUrl.search, {
      headers: { Cookie: handoffCookie },
    });
    return { callback, callbackUrl, handoffCookie };
  }

  // Tests ---------------------------------------------------------------------

  test("full handoff round trip establishes a studio session for the right user", async () => {
    const { callback } = await signInThroughHandoff("/?p=1");
    assert.equal(callback.status, 302);
    assert.equal(callback.headers.get("Location"), "/?p=1");
    const sessionCookie = getCookiePair(callback, "levo_studio_session");
    assert.ok(sessionCookie && sessionCookie.split("=")[1], "session cookie must be set");
    const setCookieLine = callback.headers
      .getSetCookie()
      .find((c) => c.startsWith("levo_studio_session="));
    assert.match(setCookieLine, /HttpOnly/i);
    assert.match(setCookieLine, /Secure/i);
    assert.match(setCookieLine, /SameSite=Lax/i);
    assert.doesNotMatch(setCookieLine, /Domain=/i, "cookie must stay host-scoped");

    const me = await studioFetch("/auth/me", { headers: { Cookie: sessionCookie } });
    assert.equal(me.status, 200);
    const body = await me.json();
    assert.equal(body.user.id, USER_ID);
    assert.equal(body.user.display_name, "Ali Studio");
    assert.equal(body.user.locale, "ar");
    assert.equal(body.user.email, undefined, "no email crosses the handoff (minimum identity)");
    assert.match(me.headers.get("Cache-Control") || "", /no-store/);
  });

  test("a handoff code is single-use: replay after redemption is rejected", async () => {
    // Mint a real code via the signed-in start endpoint.
    const state = randomToken(32);
    const start = await mainFetch(
      `/api/studio/handoff/start?dest=${encodeURIComponent(STUDIO_ORIGIN)}&state=${state}`,
      { headers: { Cookie: mainSession.cookie } }
    );
    assert.equal(start.status, 302);
    const code = new URL(start.headers.get("Location")).searchParams.get("code");

    const redeem = (c) =>
      mainFetch("/api/studio/handoff/redeem", {
        method: "POST",
        headers: { Authorization: `Bearer ${SECRET}`, "Content-Type": "application/json" },
        body: JSON.stringify({ code: c, dest: STUDIO_ORIGIN }),
      });

    const first = await redeem(code);
    assert.equal(first.status, 200);
    const firstBody = await first.json();
    assert.equal(firstBody.user_id, USER_ID);
    assert.equal(firstBody.display_name, "Ali Studio");
    assert.equal(firstBody.locale, "ar");
    assert.equal(firstBody.email, undefined);

    const replay = await redeem(code);
    assert.equal(replay.status, 400);
    assert.equal((await replay.json()).code, "BAD_CODE");
  });

  test("an expired handoff code is rejected", async () => {
    const rawCode = randomToken(32);
    mainSqlite
      .prepare(
        "INSERT INTO studio_handoff_codes (code_hash, user_id, dest, state, expires_at) VALUES (?, ?, ?, ?, ?)"
      )
      .run(await sha256Hex(rawCode), USER_ID, STUDIO_ORIGIN, "s", new Date(Date.now() - 1000).toISOString());
    const res = await mainFetch("/api/studio/handoff/redeem", {
      method: "POST",
      headers: { Authorization: `Bearer ${SECRET}`, "Content-Type": "application/json" },
      body: JSON.stringify({ code: rawCode, dest: STUDIO_ORIGIN }),
    });
    assert.equal(res.status, 400);
    assert.equal((await res.json()).code, "BAD_CODE");
  });

  test("a destination outside the allowlist is refused and mints nothing", async () => {
    const before = mainSqlite.prepare("SELECT COUNT(*) AS n FROM studio_handoff_codes").get().n;
    const res = await mainFetch(
      `/api/studio/handoff/start?dest=${encodeURIComponent("https://evil.example")}&state=${randomToken(32)}`,
      { headers: { Cookie: mainSession.cookie } }
    );
    assert.equal(res.status, 403);
    const after = mainSqlite.prepare("SELECT COUNT(*) AS n FROM studio_handoff_codes").get().n;
    assert.equal(after, before, "no code row may be created for a refused destination");
  });

  test("redemption bound to another destination is refused", async () => {
    const state = randomToken(32);
    const start = await mainFetch(
      `/api/studio/handoff/start?dest=${encodeURIComponent(STUDIO_ORIGIN)}&state=${state}`,
      { headers: { Cookie: mainSession.cookie } }
    );
    const code = new URL(start.headers.get("Location")).searchParams.get("code");
    const res = await mainFetch("/api/studio/handoff/redeem", {
      method: "POST",
      headers: { Authorization: `Bearer ${SECRET}`, "Content-Type": "application/json" },
      body: JSON.stringify({ code, dest: "https://studio-staging.levonis-iq.com" }),
    });
    assert.equal(res.status, 400, "a code minted for one destination must not redeem for another");
  });

  test("anonymous handoff start resumes via the main login, never minting a code", async () => {
    const before = mainSqlite.prepare("SELECT COUNT(*) AS n FROM studio_handoff_codes").get().n;
    const res = await mainFetch(
      `/api/studio/handoff/start?dest=${encodeURIComponent(STUDIO_ORIGIN)}&state=${randomToken(32)}`
    );
    assert.equal(res.status, 302);
    const target = new URL(res.headers.get("Location"));
    assert.equal(target.origin, MAIN_ORIGIN);
    assert.equal(target.pathname, "/auth");
    assert.match(target.searchParams.get("next") || "", /^\/api\/studio\/handoff\/start\?/);
    assert.equal(mainSqlite.prepare("SELECT COUNT(*) AS n FROM studio_handoff_codes").get().n, before);
  });

  test("a state mismatch at the callback signs nobody in", async () => {
    const sessionsBefore = studioSessionCount();
    const login = await studioFetch("/auth/login?return_to=%2F");
    const handoffCookie = getCookiePair(login, "levo_studio_handoff");
    const startUrl = new URL(login.headers.get("Location"));
    const start = await mainFetch(startUrl.pathname + startUrl.search, {
      headers: { Cookie: mainSession.cookie },
    });
    const callbackUrl = new URL(start.headers.get("Location"));
    callbackUrl.searchParams.set("state", randomToken(32)); // tampered
    const callback = await studioFetch(callbackUrl.pathname + callbackUrl.search, {
      headers: { Cookie: handoffCookie },
    });
    assert.equal(callback.status, 302);
    assert.equal(callback.headers.get("Location"), "/?auth_error=denied");
    assert.equal(getCookiePair(callback, "levo_studio_session"), null);
    assert.equal(studioSessionCount(), sessionsBefore);
  });

  test("a callback without the browser state cookie signs nobody in", async () => {
    const sessionsBefore = studioSessionCount();
    const login = await studioFetch("/auth/login?return_to=%2F");
    const startUrl = new URL(login.headers.get("Location"));
    const start = await mainFetch(startUrl.pathname + startUrl.search, {
      headers: { Cookie: mainSession.cookie },
    });
    const callbackUrl = new URL(start.headers.get("Location"));
    const callback = await studioFetch(callbackUrl.pathname + callbackUrl.search); // no cookie
    assert.equal(callback.headers.get("Location"), "/?auth_error=denied");
    assert.equal(studioSessionCount(), sessionsBefore);
  });

  test("forged oai-* and x-levo-user headers are stripped, not trusted", async () => {
    const forged = new Request(`${STUDIO_ORIGIN}/`, {
      headers: {
        Accept: "text/html",
        "oai-authenticated-user-email": "attacker@example.com",
        "oai-authenticated-user-full-name": "Attacker",
        "x-levo-user": encodeURIComponent(JSON.stringify({ id: "usr_fake", display_name: "Fake", locale: "ar" })),
      },
    });
    const clean = sanitizeRequestHeaders(forged);
    assert.equal(clean.headers.get("oai-authenticated-user-email"), null);
    assert.equal(clean.headers.get("oai-authenticated-user-full-name"), null);
    assert.equal(clean.headers.get("x-levo-user"), null);
    assert.equal(clean.headers.get("Accept"), "text/html", "unrelated headers survive");
    // Without a valid session cookie there is no identity, whatever was forged.
    assert.equal(await loadStudioSession(clean, studioEnv), null);
    // The worker-set identity header only exists after validation.
    const withIdentity = withUserHeader(clean, { id: USER_ID, display_name: "Ali Studio", locale: "ar" });
    assert.equal(
      decodeURIComponent(withIdentity.headers.get("x-levo-user")),
      JSON.stringify({ id: USER_ID, display_name: "Ali Studio", locale: "ar" })
    );
  });

  test("redeem and introspect require the shared secret", async () => {
    const noAuth = await mainFetch("/api/studio/handoff/redeem", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ code: randomToken(32), dest: STUDIO_ORIGIN }),
    });
    assert.equal(noAuth.status, 401);
    const wrong = await mainFetch("/api/studio/handoff/introspect", {
      method: "POST",
      headers: { Authorization: "Bearer wrong-secret", "Content-Type": "application/json" },
      body: JSON.stringify({ user_id: USER_ID }),
    });
    assert.equal(wrong.status, 401);
  });

  test("introspect reports main-site session liveness for studio APIs", async () => {
    const call = () =>
      mainFetch("/api/studio/handoff/introspect", {
        method: "POST",
        headers: { Authorization: `Bearer ${SECRET}`, "Content-Type": "application/json" },
        body: JSON.stringify({ user_id: USER_ID }),
      });
    assert.equal((await (await call()).json()).active, true);
    mainSqlite.prepare("DELETE FROM sessions WHERE user_id = ?").run(USER_ID);
    assert.equal((await (await call()).json()).active, false);
    // Restore a live session for the remaining tests.
    mainSession.cookie = `levonis_session=${await mintMainSession()}`;
  });

  // Main-site logout reaching Studio -----------------------------------------
  //
  // Studio mints its own 14-day session, so without this a main-site logout
  // would leave the account signed in here for a fortnight. The introspect
  // endpoint was built for exactly that and had NO CALLER until it was wired
  // into the /api/* path in studio/worker/index.ts — the module comment
  // promised main-site logout reaches Studio and nothing made it true.

  test("a studio session survives while the main-site session is live", async () => {
    resetLivenessCacheForTests();
    const { callback } = await signInThroughHandoff("/");
    const cookie = getCookiePair(callback, "levo_studio_session");
    const session = await loadStudioSession(
      new Request(`${STUDIO_ORIGIN}/api/projects`, { headers: { Cookie: cookie } }),
      studioEnv
    );
    assert.ok(session, "the round trip must have produced a session");
    assert.equal(await isStudioSessionStillAuthorized(studioEnv, session), true);
  });

  test("main-site logout revokes the studio session, and every session of that user", async () => {
    resetLivenessCacheForTests();
    const { callback: first } = await signInThroughHandoff("/");
    const cookie = getCookiePair(first, "levo_studio_session");
    // A second device for the same user: revocation must reach it too, or a
    // second browser becomes a way to keep a revoked session alive.
    await signInThroughHandoff("/");
    const before = studioSessionCount();
    assert.ok(before >= 2, `expected at least two studio sessions, saw ${before}`);

    const session = await loadStudioSession(
      new Request(`${STUDIO_ORIGIN}/api/projects`, { headers: { Cookie: cookie } }),
      studioEnv
    );
    assert.ok(session);

    // The user logs out of the main site: their main-site session rows go.
    mainSqlite.prepare("DELETE FROM sessions WHERE user_id = ?").run(USER_ID);
    resetLivenessCacheForTests();

    assert.equal(await isStudioSessionStillAuthorized(studioEnv, session), false,
      "a user with no live main-site session must not keep Studio access");
    assert.equal(studioSessionCount(), 0,
      "every studio session of that user must be destroyed, not just the calling one");

    // Restore the fixture for the tests that follow.
    mainSession.cookie = `levonis_session=${await mintMainSession()}`;
    resetLivenessCacheForTests();
  });

  test("an unreachable or unconfigured main site keeps the session — it never locks anyone out", async () => {
    resetLivenessCacheForTests();
    const { callback } = await signInThroughHandoff("/");
    const cookie = getCookiePair(callback, "levo_studio_session");
    const session = await loadStudioSession(
      new Request(`${STUDIO_ORIGIN}/api/projects`, { headers: { Cookie: cookie } }),
      studioEnv
    );
    assert.ok(session);

    // Unconfigured is the state production is in right now, and it answers
    // "unknown" for everyone. Failing closed here would sign out every account
    // on a feature that is supposed to be off.
    const unconfigured = { ...studioEnv, MAIN_SITE_ORIGIN: "", STUDIO_HANDOFF_SECRET: "" };
    assert.equal(await isStudioSessionStillAuthorized(unconfigured, session), true);
    assert.equal(studioSessionCount() > 0, true, "nothing may be destroyed on an unknown verdict");

    // Unreachable is the same answer for the same reason.
    resetLivenessCacheForTests();
    const broken = { ...studioEnv, MAIN_SITE_ORIGIN: "https://unreachable.invalid" };
    assert.equal(await isStudioSessionStillAuthorized(broken, session), true);
    resetLivenessCacheForTests();
  });

  test("a page reload after a main-site logout renders a guest — the document path applies the same rule", async () => {
    resetLivenessCacheForTests();
    const { callback } = await signInThroughHandoff("/");
    const cookie = getCookiePair(callback, "levo_studio_session");
    const documentRequest = () =>
      new Request(`${STUDIO_ORIGIN}/`, { headers: { Cookie: cookie, "Sec-Fetch-Dest": "document", Accept: "text/html" } });

    // Signed in on both sides: the document loader hands back the session.
    assert.ok(await loadLiveStudioSession(documentRequest(), studioEnv));

    // Main-site logout. The stored Studio session still exists — that is the
    // bug's precondition — but the live loader must now answer "nobody".
    mainSqlite.prepare("DELETE FROM sessions WHERE user_id = ?").run(USER_ID);
    resetLivenessCacheForTests();
    assert.ok(await loadStudioSession(documentRequest(), studioEnv), "the stale Studio cookie is still a stored session");
    assert.equal(await loadLiveStudioSession(documentRequest(), studioEnv), null,
      "the SSR document path must not render a signed-in shell for a revoked account");

    mainSession.cookie = `levonis_session=${await mintMainSession()}`;
    resetLivenessCacheForTests();
  });

  test("the liveness answer is cached, so editing does not call the main site on every request", async () => {
    resetLivenessCacheForTests();
    const { callback } = await signInThroughHandoff("/");
    const cookie = getCookiePair(callback, "levo_studio_session");
    const session = await loadStudioSession(
      new Request(`${STUDIO_ORIGIN}/api/projects`, { headers: { Cookie: cookie } }),
      studioEnv
    );
    assert.ok(session);

    let introspectCalls = 0;
    const counting = new Proxy(studioEnv, {}); // env is unchanged; count at the app
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async (input, init) => {
      const req = input instanceof Request ? (init ? new Request(input, init) : input) : new Request(input, init);
      if (new URL(req.url).pathname === "/api/studio/handoff/introspect") introspectCalls += 1;
      return originalFetch(input, init);
    };
    try {
      for (let i = 0; i < 5; i += 1) {
        assert.equal(await isStudioSessionStillAuthorized(counting, session), true);
      }
    } finally {
      globalThis.fetch = originalFetch;
    }
    assert.equal(introspectCalls, 1, `five checks should make one call, made ${introspectCalls}`);
    resetLivenessCacheForTests();
  });

  test("signing back in clears a stale revoked verdict", async () => {
    resetLivenessCacheForTests();
    // Revoke, so the cache holds "inactive" for this user.
    const { callback } = await signInThroughHandoff("/");
    const cookie = getCookiePair(callback, "levo_studio_session");
    const session = await loadStudioSession(
      new Request(`${STUDIO_ORIGIN}/api/projects`, { headers: { Cookie: cookie } }),
      studioEnv
    );
    mainSqlite.prepare("DELETE FROM sessions WHERE user_id = ?").run(USER_ID);
    assert.equal(await isStudioSessionStillAuthorized(studioEnv, session), false);

    // The user signs in again on the main site and comes back through the
    // handoff. Without the cache being cleared on redemption, their very first
    // API call would be revoked again by a verdict from a minute ago.
    mainSession.cookie = `levonis_session=${await mintMainSession()}`;
    const { callback: again } = await signInThroughHandoff("/");
    const freshCookie = getCookiePair(again, "levo_studio_session");
    const fresh = await loadStudioSession(
      new Request(`${STUDIO_ORIGIN}/api/projects`, { headers: { Cookie: freshCookie } }),
      studioEnv
    );
    assert.ok(fresh, "the second sign-in must produce a session");
    assert.equal(await isStudioSessionStillAuthorized(studioEnv, fresh), true);
    resetLivenessCacheForTests();
  });

  test("BOTH request paths enforce liveness through one loader — the wiring, not just the helper", async () => {
    // A helper nothing calls is what this whole block exists to prevent, so
    // assert the call sites themselves are present in the worker entry point:
    // the /api/* branch AND the SSR document branch, which used to call
    // loadStudioSession alone and rendered a signed-in shell after a
    // main-site logout.
    const entry = readFileSync(fileURLToPath(new URL("../worker/index.ts", import.meta.url)), "utf8");
    const apiBlock = entry.slice(entry.indexOf('url.pathname.startsWith("/api/")'));
    assert.match(apiBlock.slice(0, 900), /loadLiveStudioSession\(request, env\)/,
      "the /api/* branch must load the session through the liveness rule");
    const docBlock = entry.slice(entry.indexOf("isDocumentRequest(request)) {"));
    assert.match(docBlock.slice(0, 400), /loadLiveStudioSession\(request, env\)/,
      "the SSR document branch must load the session through the same rule");
    assert.doesNotMatch(entry, /await loadStudioSession\(/,
      "no path in the entry point may bypass the liveness rule with the raw loader");
    // …and the loader itself is what revokes: a definite "inactive" yields null.
    const sessionModule = readFileSync(fileURLToPath(new URL("../worker/auth/session.ts", import.meta.url)), "utf8");
    const helper = sessionModule.slice(sessionModule.indexOf("export async function loadLiveStudioSession"));
    assert.match(helper.slice(0, 600), /isStudioSessionStillAuthorized\(env, session\)\) \? session : null/);
  });

  test("logout destroys the server-side studio session", async () => {
    const { callback } = await signInThroughHandoff("/");
    const sessionCookie = getCookiePair(callback, "levo_studio_session");
    const logout = await studioFetch("/auth/logout", {
      method: "POST",
      headers: { Cookie: sessionCookie, Origin: STUDIO_ORIGIN },
    });
    assert.equal(logout.status, 200);
    assert.equal((await logout.json()).success, true);
    const cleared = logout.headers.getSetCookie().find((c) => c.startsWith("levo_studio_session="));
    assert.match(cleared, /Expires=Thu, 01 Jan 1970/);
    const me = await studioFetch("/auth/me", { headers: { Cookie: sessionCookie } });
    assert.equal((await me.json()).user, null, "the revoked session must be dead server-side");
  });

  test("cross-site logout navigation is refused", async () => {
    const { callback } = await signInThroughHandoff("/");
    const sessionCookie = getCookiePair(callback, "levo_studio_session");
    const attack = await studioFetch("/auth/logout", {
      headers: { Cookie: sessionCookie, "Sec-Fetch-Site": "cross-site", Accept: "text/html" },
    });
    assert.equal(attack.status, 403);
    const me = await studioFetch("/auth/me", { headers: { Cookie: sessionCookie } });
    assert.equal((await me.json()).user.id, USER_ID, "the session must survive the forged logout");
  });

  test("an expired studio session no longer authenticates", async () => {
    const { callback } = await signInThroughHandoff("/");
    const sessionCookie = getCookiePair(callback, "levo_studio_session");
    studioSqlite
      .prepare("UPDATE studio_sessions SET expires_at = ? ")
      .run(new Date(Date.now() - 1000).toISOString());
    const me = await studioFetch("/auth/me", { headers: { Cookie: sessionCookie } });
    assert.equal((await me.json()).user, null);
  });

  test("SPA-style POST /api/studio/handoff returns a redirect URL and enforces origin", async () => {
    const ok = await mainFetch("/api/studio/handoff", {
      method: "POST",
      headers: {
        Cookie: mainSession.cookie,
        Origin: MAIN_ORIGIN,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ dest: STUDIO_ORIGIN, state: randomToken(32) }),
    });
    assert.equal(ok.status, 200);
    const body = await ok.json();
    assert.ok(body.redirect_url.startsWith(`${STUDIO_ORIGIN}/auth/callback?code=`));

    const crossSite = await mainFetch("/api/studio/handoff", {
      method: "POST",
      headers: {
        Cookie: mainSession.cookie,
        Origin: "https://evil.example",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ dest: STUDIO_ORIGIN, state: randomToken(32) }),
    });
    assert.equal(crossSite.status, 403, "cross-origin POST must be rejected (CSRF)");
  });

  test("legacy chatgpt sign-in paths forward to the new endpoints", async () => {
    const signin = await studioFetch("/signin-with-chatgpt?return_to=%2F%3Fp%3D2");
    assert.equal(signin.status, 302);
    assert.equal(signin.headers.get("Location"), "/auth/login?return_to=%2F%3Fp%3D2");
    const signout = await studioFetch("/signout-with-chatgpt");
    assert.equal(signout.headers.get("Location"), "/auth/logout?return_to=%2F");
  });

  test("sign-in reports an honest 503 when the handoff is not configured", async () => {
    const unconfigured = { DB: d1Adapter(new DatabaseSync(":memory:")) };
    const res = await handleAuthRoute(new Request(`${STUDIO_ORIGIN}/auth/login`), unconfigured);
    assert.equal(res.status, 503);
    assert.equal((await res.json()).code, "AUTH_NOT_CONFIGURED");
  });

  test("return paths are confined to same-origin relative paths", () => {
    assert.equal(safeRelativeReturnPath("/projects?x=1"), "/projects?x=1");
    assert.equal(safeRelativeReturnPath("https://evil.example/"), "/");
    assert.equal(safeRelativeReturnPath("//evil.example"), "/");
    assert.equal(safeRelativeReturnPath("/\\evil.example"), "/");
    assert.equal(safeRelativeReturnPath("/auth/login"), "/");
    assert.equal(safeRelativeReturnPath(""), "/");
  });
}
