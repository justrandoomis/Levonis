/**
 * LEAK AUDIT — client-bundles: the owner's PRINT-SERVICE MARGIN and two inputs
 * of the print price calculation ride the BOOT REQUEST of every page, for every
 * visitor and every signed-in role, and no client code ever reads them.
 *
 * The owner's rule: anyone other than the main admin / super admin receives
 * ONLY the final price, never a margin, an engine input or an intermediate
 * value of the pricing chain. `printServicePricing` is exactly that:
 * `margin_percent` (the markup the calculator adds on top of material + machine
 * + setup), `machine_iqd_per_hour` and `setup_fee_iqd` (two of the inputs it
 * is applied to). The seed leaves it null ("not configured"); this test has the
 * OWNER set it through the owner's own write path and then reads as everybody
 * else.
 *
 * The path, all of it real code:
 *
 *   1. src/App.tsx wraps every route in <WalletProvider>, and
 *      src/WalletContext.tsx's mount effect runs `refreshSettings()`, which is
 *      `api.get('/api/settings/public')`. Every page load, every visitor.
 *   2. GET /api/settings/public (worker/routes/misc.ts) returns
 *      `getSettings(PUBLIC_SETTING_KEYS)`, and PUBLIC_SETTING_KEYS
 *      (worker/lib/settings.ts) lists 'printServicePricing'. Session-free and
 *      `anonymousCached`, so one body for every guest, held by the colo.
 *   3. NO CONSUMER. Nothing under src/ names `printServicePricing`, the
 *      calculator route or `margin_percent` in the public-settings sense, and
 *      `PublicSettings` (src/lib/api.ts) has no such field. The browser
 *      receives the margin on every visit and throws it away, so withholding it
 *      costs no screen. The same holds for GET /api/products/print-calculator,
 *      which echoes the three rates to anyone and which no client code calls.
 *   4. GUARD GAP. The role-matrix seed (tests/fixtures/roleMatrix.ts) never
 *      sets printServicePricing, so the sweep over /api/settings/public (misc
 *      is in BASE_MOUNTS) sees nulls, and leaks() skips nulls. The live probe
 *      for /api/home exempts `margin` on purpose
 *      (scripts/live-cost-probes.d/s1.json: "Owner review item").
 *
 * LOCAL ONLY: an in-memory / temp-file SQLite database with every migration,
 * the real Worker and route modules, a stub ASSETS binding, no network.
 *
 * Run: node --import tsx --test tests/leakAudit_client-bundles_print_service_pricing_public_no_consumer.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import worker from '../worker/index';
import { APEX, OWNER, asD1, ctx, json, put, stubApp, type Mount } from './fixtures/app';
import { leaks } from './fixtures/costlyProduct';
import { ROLES, appFor, call, seededCopy, type MountSpec, type RoleName, type Router } from './fixtures/roleMatrix';
import { adminRoutes } from '../worker/routes/admin';
import { miscRoutes } from '../worker/routes/misc';
import { productRoutes } from '../worker/routes/products';
import { PUBLIC_SETTING_KEYS } from '../worker/lib/settings';

const ROOT = join(import.meta.dirname, '..');

/** The owner's print-service rates: figures no price, id, count or timestamp in the seed can equal. */
const RATES = {
  machine_iqd_per_hour: 6_847,
  setup_fee_iqd: 4_291,
  margin_percent: 31.75,
} as const;
const PRIVATE_KEYS = Object.keys(RATES);
const EXTRA = {
  numbers: Object.values(RATES) as number[],
  decimals: ['31.75', '6847', '6,847', '4291', '4,291'],
};

/** Every place one of the owner's rates sits in a body: the shared leak walk, each private key with a value, the sentinels in any form. */
function rateLeaks(body: unknown): string[] {
  const out = leaks(body, EXTRA);
  const walk = (v: unknown, path: string) => {
    if (Array.isArray(v)) v.forEach((x, i) => walk(x, `${path}[${i}]`));
    else if (v && typeof v === 'object') {
      for (const [k, x] of Object.entries(v as Record<string, unknown>)) {
        if (PRIVATE_KEYS.includes(k) && x !== null && x !== undefined) out.push(`${path}.${k} = ${JSON.stringify(x)}`);
        walk(x, `${path}.${k}`);
      }
    } else if (typeof v === 'number' && EXTRA.numbers.includes(v)) out.push(`${path} = ${v}`);
    else if (typeof v === 'string') for (const t of EXTRA.decimals) if (v.includes(t)) out.push(`${path} ⊃ "${t}"`);
  };
  walk(body, '$');
  return [...new Set(out)];
}

const adminMount: Mount = (a) => {
  a.route('/api/admin', adminRoutes);
};

/** The seeded role-matrix shop, after its OWNER published print-service rates through PUT /api/admin/settings/printServicePricing. */
async function shopWithRates(): Promise<DatabaseSync> {
  const raw = seededCopy();
  const res = await put(stubApp(asD1(raw), OWNER, adminMount), '/api/admin/settings/printServicePricing', { value: RATES });
  assert.equal(res.status, 200, `the owner could not set the rates: ${JSON.stringify(await json(res))}`);
  const stored = raw.prepare(`SELECT value FROM admin_settings WHERE key = 'printServicePricing'`).get() as { value: string } | undefined;
  assert.deepEqual(JSON.parse(String(stored?.value)), RATES, 'precondition: the owner write did not store the rates');
  return raw;
}

/** The real Worker (worker/index.ts), as a signed-out visitor on the apex: the request a fresh tab's WalletProvider makes. */
async function guestGet(raw: DatabaseSync, path: string) {
  const env = {
    DB: asD1(raw),
    STORE_ROOT_DOMAIN: APEX,
    APP_ORIGIN: `https://${APEX}`,
    INITIAL_ADMIN_EMAIL: 'boss@x.co',
    EXTRA_ALLOWED_ORIGINS: '',
    ASSETS: {
      fetch: async () =>
        new Response('<!doctype html><html><head></head><body><div id="root"></div></body></html>', {
          headers: { 'content-type': 'text/html' },
        }),
    },
  };
  const res = await worker.fetch(
    new Request(`https://${APEX}${path}`, { headers: { Host: APEX, 'CF-Connecting-IP': '9.9.9.9', Accept: 'application/json' } }),
    env as never,
    ctx
  );
  return { status: res.status, cacheControl: res.headers.get('Cache-Control') ?? '', body: (await res.json()) as Record<string, any> };
}

/** Every client source file (src/**, .ts/.tsx), as text. */
function clientSources(): Array<{ file: string; text: string }> {
  const out: Array<{ file: string; text: string }> = [];
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      const p = join(dir, name);
      if (statSync(p).isDirectory()) walk(p);
      else if (/\.(ts|tsx|js|jsx|mjs)$/.test(name)) out.push({ file: relative(ROOT, p), text: readFileSync(p, 'utf8') });
    }
  };
  walk(join(ROOT, 'src'));
  return out;
}

// ------------------------------------------------------------------ the path is the boot request of every page

test('precondition: every page boots through WalletProvider, whose mount effect GETs /api/settings/public — and the key is no longer public', () => {
  const app = readFileSync(join(ROOT, 'src/App.tsx'), 'utf8');
  const wallet = readFileSync(join(ROOT, 'src/WalletContext.tsx'), 'utf8');
  assert.match(app, /export default function App\(\)[\s\S]*<WalletProvider>/, 'App() no longer wraps the routes in <WalletProvider>');
  assert.match(
    wallet,
    /const refreshSettings = useCallback\(async \(\) => \{[\s\S]{0,200}api\.get<[^>]*>\('\/api\/settings\/public'\)/,
    'refreshSettings no longer GETs /api/settings/public'
  );
  assert.match(wallet, /await Promise\.all\(\[refreshSettings\(\), refreshWallet\(\)\]\)/, 'the mount effect no longer runs refreshSettings()');
  // The fix (DECISIONS row 219): the rates left the public allow-list.
  assert.ok(
    !(PUBLIC_SETTING_KEYS as string[]).includes('printServicePricing'),
    'printServicePricing is a public setting key again: every page load would hand it to every visitor'
  );
});

test('evidence: no client code consumes printServicePricing or the print calculator route', () => {
  const consumers = clientSources()
    .filter(({ text }) => /printServicePricing|print-calculator|printCalculator/.test(text))
    .map(({ file }) => file);
  assert.deepEqual(consumers, [], `client code that reads the public print rates (if any, the leak would carry a UI cost): ${consumers.join(', ')}`);
  const api = readFileSync(join(ROOT, 'src/lib/api.ts'), 'utf8');
  const decl = api.match(/export interface PublicSettings \{[\s\S]*?\n\}/)?.[0] ?? '';
  assert.ok(decl.length > 0, 'PublicSettings declaration not found');
  assert.equal(/printServicePricing/.test(decl), false, 'PublicSettings now declares printServicePricing');
  // The shipped bundle, when one is built locally (dist/ is git-ignored), says the same.
  const assets = join(ROOT, 'dist/assets');
  if (existsSync(assets)) {
    const inBundle = readdirSync(assets)
      .filter((n) => n.endsWith('.js'))
      .filter((n) => /printServicePricing|print-calculator/.test(readFileSync(join(assets, n), 'utf8')));
    assert.deepEqual(inBundle, [], `built chunks that read the print rates: ${inBundle.join(', ')}`);
  }
});

// ------------------------------------------------------------------ 1. the anonymous boot request, through the real Worker

test('anonymous boot request (real Worker GET /api/settings/public) carries no print margin and no calculation input', async () => {
  const raw = await shopWithRates();
  const { status, cacheControl, body } = await guestGet(raw, '/api/settings/public');
  assert.equal(status, 200, JSON.stringify(body).slice(0, 400));
  assert.equal(body.success, true, JSON.stringify(body).slice(0, 400));
  // The public settings really were served (the path is exercised).
  assert.ok(body.settings && typeof body.settings === 'object' && 'exchangeRate' in body.settings, 'no public settings block');
  const found = rateLeaks(body);
  assert.deepEqual(
    found,
    [],
    `the boot request every page makes (GET /api/settings/public, Cache-Control: ${cacheControl}) hands an anonymous visitor the owner's print margin / rates, which no client code reads: ${found.join('; ')}`
  );
});

// ------------------------------------------------------------------ 2. the same boot request as every signed-in non-owner role

const MISC: readonly MountSpec[] = [['/api', miscRoutes as Router]];
const NON_OWNER: RoleName[] = Object.keys(ROLES) as RoleName[];

for (const role of NON_OWNER) {
  test(`boot request GET /api/settings/public as ${role} carries no print margin and no calculation input`, async () => {
    const raw = await shopWithRates();
    const { status, body } = await call(appFor(raw, ROLES[role], MISC), 'GET', '/api/settings/public');
    const b = body as Record<string, any>;
    assert.equal(status, 200, JSON.stringify(b).slice(0, 300));
    assert.ok(b.settings && 'exchangeRate' in b.settings, `${role}: no public settings block`);
    const found = rateLeaks(b);
    assert.deepEqual(found, [], `${role} receives the owner's print margin / rates on every page load (GET /api/settings/public): ${found.join('; ')}`);
  });
}

// ------------------------------------------------------------------ 3. the calculator route: no client caller, rates to anyone

for (const role of ['guest', 'customer', 'merchant'] as const) {
  test(`GET /api/products/print-calculator as ${role} (no client caller) carries no print margin and no calculation input`, async () => {
    const raw = await shopWithRates();
    const { status, body } = await call(appFor(raw, ROLES[role], [['/api/products', productRoutes as Router]]), 'GET', '/api/products/print-calculator');
    const b = body as Record<string, any>;
    assert.equal(status, 200, JSON.stringify(b).slice(0, 300));
    // The route really read the owner's setting, otherwise this proves nothing.
    assert.equal(b.rates?.configured, true, `the calculator did not read the owner's rates: ${JSON.stringify(b.rates)}`);
    const found = rateLeaks(b);
    assert.deepEqual(found, [], `${role} reads the owner's print margin / rates on /api/products/print-calculator: ${found.join('; ')}`);
  });
}

// ------------------------------------------------------------------ 4. guard gap

test('guard gap: the role-matrix sweep over /api/settings/public would see a configured print margin', async () => {
  // The seed configures the margin, so a regression that publishes it again
  // hands the sweep a real value (leaks() skips nulls) — and today the public
  // answer carries none of it.
  const raw = seededCopy();
  const row = raw.prepare(`SELECT value FROM admin_settings WHERE key = 'printServicePricing'`).get() as { value: string } | undefined;
  const seeded = row ? (JSON.parse(row.value) as Record<string, unknown>) : null;
  assert.ok(
    seeded && seeded.margin_percent !== null && seeded.margin_percent !== undefined,
    `the role-matrix seed stores printServicePricing = ${row?.value ?? 'no row'}, so tests/costRoleMatrix.test.ts would see nulls (leaks() skips them) and could never catch a public print margin`
  );
  const { status, body } = await call(appFor(raw, ROLES.guest, MISC), 'GET', '/api/settings/public');
  assert.equal(status, 200);
  assert.equal((body as Record<string, any>).settings?.printServicePricing, undefined, 'the public settings carry the print rates');
  assert.deepEqual(rateLeaks(body as Record<string, any>), []);
});
