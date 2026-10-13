/**
 * LEAK AUDIT — cache-headers: the shop's BUYING price of every print accessory
 * is stored in the shared colo cache (`caches.default`) and in every browser
 * under a PUBLIC policy, served to every guest, read by every signed-in role,
 * handed to every non-owner admin through /api/admin/settings, and exempted
 * from the role-matrix guard.
 *
 * The owner's rule: anyone other than the main admin / super admin receives
 * ONLY the final price — never a purchase cost, never an input or an
 * intermediate value of the pricing chain, in no channel (API, JSON, Cache…).
 * `PrintAccessory.cost_iqd` is documented as «What ONE unit costs the shop»
 * (worker/lib/printAccessories.ts), and worker/lib/printPricing.ts adds it to
 * the cost lines BEFORE `priceForMargin(cost, target_margin_percent)` («It IS
 * inside the margin, because the shop buys the magnet»). It is the shop's
 * buying cost, not a sale price.
 *
 * What this file proves, LOCALLY, on the real routers and the real edge policy
 * (worker/lib/edgePolicy.ts `anonymousCached`, `afterSettingsWrite`):
 *
 *   A. With NOTHING configured (the seed DEFAULT_ACCESSORIES, a fresh database
 *      with every migration), a guest GET of /api/print-quote/accessories and
 *      /api/marketplace/print/catalog leaves with
 *      `public, max-age=60, s-maxage=120, stale-while-revalidate=600`, no
 *      `Vary: Cookie`, and is PUT into the colo cache under host + path; the
 *      next guest is answered from that shared entry. The stored entry, the
 *      first answer and the cache hit are scanned for the buying price.
 *   B. Every non-owner role of tests/fixtures/roleMatrix.ts ROLES (guest,
 *      customer, merchant, assistant, full, legacy_null, grantee_off,
 *      employee, investor, support_assistant) on the role-matrix database:
 *      both public paths, and /api/admin/settings (printAccessories is not in
 *      COST_SETTING_KEYS, so the admins get the whole catalogue with its cost).
 *   C. The guard gap: the role-matrix filter (`leaks` minus NOT_A_COST, exactly
 *      as sweepGets filters) erases every one of the leaks B finds.
 *   D. The purge reaches the writing colo only: after the owner rewrites the
 *      catalogue in colo A, colo B keeps serving the PREVIOUS buying prices
 *      from its shared entry.
 *
 * LOCAL ONLY: temp/in-memory SQLite databases with every migration, a stand-in
 * `caches.default` (as tests/edgeCachePolicy.test.ts uses), the stub session of
 * tests/fixtures/app.ts. No network, no live host, no secret.
 *
 * Run: node --import tsx --test tests/leakAudit_cache-headers_accessory_buying_cost_anon_edge_cached_and_exempted.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { DatabaseSync } from 'node:sqlite';
import { asD1, freshDb, get, json, pending, put, stubApp, OWNER, type Mount } from './fixtures/app';
import { leaks } from './fixtures/costlyProduct';
import { NOT_A_COST, ROLES, appFor, call, seededCopy, type RoleName } from './fixtures/roleMatrix';
import { printQuoteRoutes } from '../worker/routes/printQuote';
import { printRequestRoutes } from '../worker/routes/printRequests';
import { adminRoutes } from '../worker/routes/admin';
import { DEFAULT_ACCESSORIES } from '../worker/lib/printAccessories';
import { ANONYMOUS_CACHE_CONTROL, canonicalKey, pathsChangedBySetting } from '../worker/lib/edgePolicy';
import { sessionFreePublicGet } from '../worker/lib/session';

const HOST = 'levonis-iq.com';
const PUBLIC_PATHS = ['/api/print-quote/accessories', '/api/marketplace/print/catalog'] as const;

/** The seed buying price of every active default accessory, by id. */
const DEFAULT_COST_BY_ID: ReadonlyMap<string, number> = new Map(
  DEFAULT_ACCESSORIES.filter((a) => a.active !== false).map((a) => [a.id, a.cost_iqd])
);

/**
 * Every accessory BUYING price in a body: a cost-named number on a row of an
 * `accessories` / `printAccessories` list, or any number on a row equal to the
 * known buying price of that row's id (so a rename would not hide it), plus the
 * shared scanner's own accessory findings (unfiltered — no NOT_A_COST).
 */
function buyingCostLeaks(body: unknown, costById: ReadonlyMap<string, number> = DEFAULT_COST_BY_ID): string[] {
  const out = new Set<string>(leaks(body).filter((l) => /ccessories\[\d+\]/.test(l)));
  const walk = (v: unknown, path: string, inList: boolean) => {
    if (Array.isArray(v)) {
      v.forEach((x, i) => walk(x, `${path}[${i}]`, inList));
      return;
    }
    if (!v || typeof v !== 'object') return;
    const row = v as Record<string, unknown>;
    if (inList && typeof row.id === 'string') {
      const known = costById.get(row.id);
      for (const [k, x] of Object.entries(row)) {
        if (typeof x !== 'number') continue;
        if (/cost/i.test(k)) out.add(`${path}.${k} = ${x}`);
        else if (known !== undefined && x === known) out.add(`${path}.${k} = ${x} (the buying price of ${row.id})`);
      }
    }
    for (const [k, x] of Object.entries(row)) walk(x, `${path}.${k}`, /^(print)?accessories$/i.test(k) || (inList && Array.isArray(x)));
  };
  walk(body, '$', false);
  return [...out];
}

/** The accessory ids an answer lists (the path is exercised only if they are there). */
function idsIn(body: unknown): string[] {
  const b = body as { accessories?: Array<{ id?: unknown }>; settings?: { printAccessories?: Array<{ id?: unknown }> } };
  const list = b?.accessories ?? b?.settings?.printAccessories ?? [];
  return list.map((a) => String(a?.id));
}

// ---------------------------------------------------------- the colo cache

/** `caches.default` as a Cloudflare colo behaves (the stand-in of tests/edgeCachePolicy.test.ts). */
function coloCache() {
  const store = new Map<string, Response>();
  let hits = 0;
  return {
    store,
    get hits() {
      return hits;
    },
    async match(req: Request) {
      const stored = store.get(req.url);
      if (!stored) return undefined;
      hits += 1;
      const copy = stored.clone();
      const headers = new Headers(copy.headers);
      headers.set('CF-Cache-Status', 'HIT');
      return new Response(copy.body, { status: copy.status, headers });
    },
    async put(req: Request, res: Response) {
      store.set(req.url, res);
    },
    async delete(req: Request) {
      return store.delete(req.url);
    },
  };
}
type ColoCache = ReturnType<typeof coloCache>;

/** Run `work` with `cache` as this isolate's `caches.default` (one colo). */
async function inColo<T>(cache: ColoCache, work: () => T | Promise<T>): Promise<T> {
  const scope = globalThis as { caches?: unknown };
  const before = scope.caches;
  scope.caches = { default: cache };
  try {
    const out = await work();
    await Promise.all(pending);
    return out;
  } finally {
    if (before === undefined) delete scope.caches;
    else scope.caches = before;
  }
}

const mount: Mount = (a) => {
  a.route('/api/print-quote', printQuoteRoutes);
  a.route('/api/marketplace/print', printRequestRoutes);
  a.route('/api/admin', adminRoutes);
};

/** A guest's GET as a browser sends it to the apex: no cookie, no Authorization, the apex Host. */
const guestGet = (raw: DatabaseSync, path: string) => get(stubApp(asD1(raw), null, mount), path, { Host: HOST });

// ====================================================================== A

test('A: a guest answer is PUBLIC and stored in the shared colo cache — and carries no accessory buying price', async () => {
  const raw = freshDb();
  // Nothing configured: the route falls back to the seed DEFAULT_ACCESSORIES.
  const configured = raw.prepare(`SELECT COUNT(*) AS n FROM admin_settings WHERE key = 'printAccessories'`).get() as { n: number };
  assert.equal(configured.n, 0, 'the owner has configured nothing — the default catalogue is what is served');

  const cache = coloCache();
  const found: string[] = [];
  for (const path of PUBLIC_PATHS) {
    assert.equal(sessionFreePublicGet('GET', path), true, `${path} is session-free (worker/lib/session.ts)`);

    // First guest: built, stamped public, PUT into the colo cache.
    const first = await inColo(cache, () => guestGet(raw, path));
    assert.equal(first.status, 200, path);
    const cacheControl = first.headers.get('Cache-Control') ?? '';
    assert.equal(cacheControl, ANONYMOUS_CACHE_CONTROL, `${path}: the anonymous shared policy`);
    assert.doesNotMatch(first.headers.get('Vary') ?? '', /cookie/i, `${path}: no Vary: Cookie — one body for everyone`);
    const firstBody = await json(first);

    const key = canonicalKey(`https://${HOST}${path}`).url;
    const stored = cache.store.get(key);
    assert.ok(stored, `${path}: the guest answer is stored in caches.default under ${key}`);
    const storedBody = JSON.parse(await stored.clone().text());
    assert.equal(stored.headers.get('Cache-Control'), ANONYMOUS_CACHE_CONTROL, `${path}: stored with the shared policy`);

    // Second guest: answered from the shared entry.
    const hitsBefore = cache.hits;
    const second = await inColo(cache, () => guestGet(raw, path));
    assert.equal(second.status, 200);
    assert.equal(cache.hits, hitsBefore + 1, `${path}: the next guest is served from the colo cache`);
    assert.equal(second.headers.get('Cache-Control'), ANONYMOUS_CACHE_CONTROL);
    const secondBody = await json(second);

    // The path is exercised: every active default accessory is in the answer.
    assert.deepEqual(idsIn(firstBody).sort(), [...DEFAULT_COST_BY_ID.keys()].sort(), `${path}: the default catalogue is served`);

    for (const [where, body] of [
      ['first answer', firstBody],
      ['caches.default entry', storedBody],
      ['cache hit', secondBody],
    ] as const) {
      const l = buyingCostLeaks(body);
      if (l.length) found.push(`${path} [${where}; ${cacheControl}] ${l.length} buying prices, e.g. ${l.slice(0, 3).join(', ')}`);
    }
  }
  assert.deepEqual(
    found,
    [],
    `the shop's accessory BUYING price («What ONE unit costs the shop») is stored in the shared colo cache and served to every guest: ${found.join(' | ')}`
  );
});

// ====================================================================== B + C

const NON_OWNER = Object.keys(ROLES) as RoleName[];
const SWEPT = [...PUBLIC_PATHS, '/api/admin/settings'] as const;

interface RoleLeak {
  role: RoleName;
  path: string;
  leak: string;
}

/**
 * The buying price of every accessory the role-matrix database lists, by id:
 * its own seeded `printAccessories` (the matrix seeds a catalogue of its own)
 * on top of the defaults a database without one answers with.
 */
function seededCostById(raw: DatabaseSync): ReadonlyMap<string, number> {
  const row = raw.prepare("SELECT value FROM admin_settings WHERE key = 'printAccessories'").get() as { value?: string } | undefined;
  const list = row?.value ? (JSON.parse(row.value) as Array<{ id: string; cost_iqd: number; active?: boolean }>) : [];
  return new Map([...DEFAULT_COST_BY_ID, ...list.filter((a) => a.active !== false).map((a) => [a.id, a.cost_iqd] as [string, number])]);
}

async function nonOwnerReads(): Promise<{ found: RoleLeak[]; exercised: string[] }> {
  const found: RoleLeak[] = [];
  const exercised: string[] = [];
  for (const role of NON_OWNER) {
    const raw = seededCopy();
    const costById = seededCostById(raw);
    const app = appFor(raw, ROLES[role] ?? null);
    for (const path of SWEPT) {
      const { status, body } = await call(app, 'GET', path);
      if (status !== 200) continue;
      if (idsIn(body).some((id) => costById.has(id))) exercised.push(`${role} ${path}`);
      for (const leak of buyingCostLeaks(body, costById)) found.push({ role, path, leak });
    }
  }
  return { found, exercised };
}

test('B: no non-owner role (signed in or not, admin or not) reads an accessory buying price', async () => {
  const { found, exercised } = await nonOwnerReads();
  // The path is exercised for every role on the two public routes, and for the admins on /api/admin/settings.
  for (const role of NON_OWNER) {
    for (const path of PUBLIC_PATHS) assert.ok(exercised.includes(`${role} ${path}`), `${role} ${path} was not answered with the catalogue`);
  }
  assert.ok(
    exercised.some((e) => e.endsWith('/api/admin/settings')),
    'no admin role read /api/admin/settings with the accessory catalogue — the admin path is not exercised'
  );
  const byRole = new Map<string, Set<string>>();
  for (const f of found) {
    const k = `${f.role}`;
    if (!byRole.has(k)) byRole.set(k, new Set());
    byRole.get(k)!.add(f.path);
  }
  const summary = [...byRole.entries()].map(([r, ps]) => `${r}: ${[...ps].join(', ')}`);
  assert.deepEqual(
    summary.map((x) => x.split(':')[0]),
    [],
    `non-owner roles read the accessory BUYING price (${found.length} leaks; e.g. ${found
      .slice(0, 3)
      .map((f) => `${f.role} ${f.path} ${f.leak}`)
      .join(' | ')}) — per role: ${summary.join(' ; ')}`
  );
});

test('C (guard gap): the role-matrix filter does not erase the accessory buying price', async () => {
  const { found } = await nonOwnerReads();
  // Exactly the filter sweepGets applies: a leak is dropped when a NOT_A_COST entry matches the path AND the line.
  const raw = found.filter((f) => /\.cost_iqd = /.test(f.leak));
  const exempted = raw.filter((f) => NOT_A_COST.some((n) => n.path.test(f.path) && n.leak.test(`${f.leak}`)));
  const exemptedPaths = [...new Set(exempted.map((f) => f.path))].sort();
  assert.deepEqual(
    exemptedPaths,
    [],
    `tests/fixtures/roleMatrix.ts NOT_A_COST hides ${exempted.length} of ${raw.length} accessory buying-price leaks from the role-matrix sweep (justified as «the per-piece accessory price a print quote bills», while worker/lib/printAccessories.ts calls it «What ONE unit costs the shop» and printPricing.ts puts the margin on top of it) on: ${exemptedPaths.join(', ')}`
  );
});

// ====================================================================== D

test('D: the owner rewriting the catalogue purges only the writing colo — another colo keeps the previous buying prices', async () => {
  const raw = freshDb();
  raw.exec(
    `INSERT INTO users (id,name,email,password_hash,role,email_verified_at)
       VALUES ('${OWNER.id}','Owner','${OWNER.email}','h','admin','2026-01-01T00:00:00.000Z')`
  );
  const path = '/api/print-quote/accessories';
  assert.ok(pathsChangedBySetting('printAccessories').includes(path), 'a printAccessories write names this path for the purge');

  const coloA = coloCache();
  const coloB = coloCache();
  // Both colos served a guest before the write.
  assert.equal((await inColo(coloA, () => guestGet(raw, path))).status, 200);
  assert.equal((await inColo(coloB, () => guestGet(raw, path))).status, 200);
  const key = canonicalKey(`https://${HOST}${path}`).url;
  assert.ok(coloA.store.has(key) && coloB.store.has(key), 'both colos hold the guest answer');

  // The owner replaces the catalogue in colo A (one row, a new buying price).
  const NEW_ROW = { ...DEFAULT_ACCESSORIES[0]!, cost_iqd: 47_393 };
  const write = await inColo(coloA, () =>
    put(stubApp(asD1(raw), OWNER, mount), '/api/admin/settings/printAccessories', { value: [NEW_ROW] }, { Host: HOST })
  );
  assert.equal(write.status, 200, JSON.stringify(await json(write.clone())));
  assert.equal(coloA.store.has(key), false, 'the writing colo purged its entry');

  // Colo B never heard of the write: its next guest is served the PREVIOUS catalogue from the shared entry.
  const hitsBefore = coloB.hits;
  const afterB = await inColo(coloB, () => guestGet(raw, path));
  assert.equal(coloB.hits, hitsBefore + 1, 'colo B answered from its shared entry');
  const bodyB = await json(afterB);
  assert.deepEqual(idsIn(bodyB).sort(), [...DEFAULT_COST_BY_ID.keys()].sort(), 'colo B still lists the previous catalogue');

  const stale = buyingCostLeaks(bodyB);
  assert.deepEqual(
    stale,
    [],
    `after the owner's write purged only colo A, colo B still serves the PREVIOUS accessory buying prices to guests (${afterB.headers.get('Cache-Control')}): ${stale.length} buying prices, e.g. ${stale.slice(0, 4).join(' | ')}`
  );
});
