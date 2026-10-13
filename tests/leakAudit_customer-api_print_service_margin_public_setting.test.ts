/**
 * LEAK AUDIT — customer-api: the owner's PRINT-SERVICE MARGIN and the inputs of
 * the print price calculation reach every signed-out visitor (and the colo's
 * anonymous cache).
 *
 * The owner's rule: anyone other than the main admin / super admin receives
 * ONLY the final price — never a margin, never an engine input, never an
 * intermediate value of the pricing chain. `printServicePricing` holds exactly
 * that: `margin_percent` (the markup the calculator adds on top of material +
 * machine + setup), `machine_iqd_per_hour` and `setup_fee_iqd` (two of the
 * inputs it is applied to). It is null until the owner sets it (settings.ts),
 * and it is in PUBLIC_SETTING_KEYS, so once set:
 *
 *   1. GET /api/products/print-calculator  echoes all three in `rates`;
 *   2. GET /api/settings/public            returns `settings.printServicePricing`
 *      (anonymousCached — one body for every guest, held by the colo);
 *   3. GET /api/home                       carries the same public settings
 *      (anonymousCached, the guest's first screen);
 *   4. GET /api/admin/settings             gives it to every NON-owner admin
 *      (printServicePricing is not in COST_SETTING_KEYS);
 *   5. the guard gap: the role-matrix seed never sets printServicePricing (so
 *      every sweep sees nulls and passes), and `setup_fee_iqd` /
 *      `machine_iqd_per_hour` are not FINANCIAL_FIELDS, so `leaks()` would not
 *      flag them even if it were seeded.
 *
 * The owner sets the rates through the real owner write path
 * (PUT /api/admin/settings/printServicePricing) and the guest reads through
 * the real Worker (worker/index.ts fetch), as tests/securityPricingLeak.test.ts
 * does.
 *
 * LOCAL ONLY: an in-memory SQLite database with every migration, the real
 * Worker and route modules, no network.
 *
 * Run: node --import tsx --test tests/leakAudit_customer-api_print_service_margin_public_setting.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { DatabaseSync } from 'node:sqlite';
import worker from '../worker/index';
import { APEX, OWNER, asD1, ctx, freshDb, get, json, put, stubApp, type Mount } from './fixtures/app';
import { leaks } from './fixtures/costlyProduct';
import { ROLES, seededCopy } from './fixtures/roleMatrix';
import { adminRoutes } from '../worker/routes/admin';
import { FINANCIAL_FIELDS } from '../worker/lib/adminScope';

/** The owner's print-service rates — figures no price, id, count or timestamp here can equal. */
const RATES = {
  machine_iqd_per_hour: 7_431,
  setup_fee_iqd: 3_917,
  margin_percent: 27.5,
} as const;
const PRIVATE_KEYS = Object.keys(RATES) as Array<keyof typeof RATES>;
const EXTRA = {
  numbers: Object.values(RATES),
  decimals: ['27.5', '7431', '7,431', '3917', '3,917'],
};

/**
 * Every place one of the owner's rates reaches: the shared leak walk (which
 * already flags `margin_percent` by FINANCIAL_FIELDS), every private key by
 * name with a value, and the sentinel figures in any form.
 */
function rateLeaks(body: unknown): string[] {
  const out = leaks(body, EXTRA);
  const walk = (v: unknown, path: string) => {
    if (Array.isArray(v)) v.forEach((x, i) => walk(x, `${path}[${i}]`));
    else if (v && typeof v === 'object') {
      for (const [k, x] of Object.entries(v as Record<string, unknown>)) {
        if ((PRIVATE_KEYS as string[]).includes(k) && x !== null && x !== undefined) out.push(`${path}.${k} = ${JSON.stringify(x)}`);
        walk(x, `${path}.${k}`);
      }
    } else if (typeof v === 'number' && (EXTRA.numbers as number[]).includes(v)) out.push(`${path} = ${v}`);
    else if (typeof v === 'string') for (const t of EXTRA.decimals) if (v.includes(t)) out.push(`${path} ⊃ "${t}"`);
  };
  walk(body, '$');
  return [...new Set(out)];
}

const adminMount: Mount = (a) => {
  a.route('/api/admin', adminRoutes);
};

/** A shop whose OWNER has published print-service rates through the owner's own write path. */
async function shopWithRates(): Promise<DatabaseSync> {
  const raw = freshDb();
  const res = await put(stubApp(asD1(raw), OWNER, adminMount), '/api/admin/settings/printServicePricing', { value: RATES });
  assert.equal(res.status, 200, `the owner could not set the rates: ${JSON.stringify(await json(res))}`);
  const stored = raw.prepare(`SELECT value FROM admin_settings WHERE key = 'printServicePricing'`).get() as { value: string } | undefined;
  assert.deepEqual(JSON.parse(String(stored?.value)), RATES, 'the owner write did not store the rates');
  return raw;
}

/** The real Worker, as a signed-out visitor on the apex. */
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
    new Request(`https://${APEX}${path}`, { headers: { Host: APEX, 'CF-Connecting-IP': '9.9.9.9' } }),
    env as never,
    ctx
  );
  return { status: res.status, cacheControl: res.headers.get('Cache-Control') ?? '', body: (await res.json()) as Record<string, any> };
}

// ------------------------------------------------------------------ 1

test('anonymous GET /api/products/print-calculator carries no print margin and no calculation input', async () => {
  const raw = await shopWithRates();
  const { status, cacheControl, body } = await guestGet(raw, '/api/products/print-calculator');
  assert.equal(status, 200, JSON.stringify(body));
  assert.equal(body.success, true, JSON.stringify(body));
  // The route really read the owner's setting — otherwise this proves nothing.
  assert.equal(body.rates?.configured, true, `the calculator did not read the owner's rates: ${JSON.stringify(body.rates)}`);
  const found = rateLeaks(body);
  assert.deepEqual(
    found,
    [],
    `anonymous /api/products/print-calculator (Cache-Control: ${cacheControl}) publishes the owner's print margin / rates: ${found.join('; ')}`
  );
});

// ------------------------------------------------------------------ 2 + 3

for (const path of ['/api/settings/public', '/api/home']) {
  test(`anonymous GET ${path} carries no print margin and no calculation input`, async () => {
    const raw = await shopWithRates();
    const { status, cacheControl, body } = await guestGet(raw, path);
    assert.equal(status, 200, JSON.stringify(body).slice(0, 400));
    assert.equal(body.success, true, JSON.stringify(body).slice(0, 400));
    // The public settings really were served (the path is exercised).
    assert.ok(body.settings && typeof body.settings === 'object', `${path}: no settings block`);
    const found = rateLeaks(body);
    assert.deepEqual(
      found,
      [],
      `anonymous ${path} (Cache-Control: ${cacheControl}) publishes the owner's print margin / rates: ${found.join('; ')}`
    );
  });
}

// ------------------------------------------------------------------ 4

for (const role of ['assistant', 'full', 'legacy_null', 'support_assistant'] as const) {
  test(`non-owner admin (${role}) GET /api/admin/settings carries no print margin`, async () => {
    const raw = await shopWithRates();
    raw.exec(`
      INSERT OR IGNORE INTO users (id,name,email,password_hash,role,admin_scope) VALUES
        ('usr_asst','Asst','asst@x.co','h','admin','assistant'),
        ('usr_full','Full','full@x.co','h','admin','full'),
        ('usr_legacy','Legacy','legacy@x.co','h','admin',NULL),
        ('usr_support','Support','support@x.co','h','admin','assistant');
    `);
    const res = await get(stubApp(asD1(raw), ROLES[role]!, adminMount), '/api/admin/settings');
    const body = await json(res);
    assert.equal(res.status, 200, JSON.stringify(body).slice(0, 300));
    assert.ok(body.settings, 'no settings block');
    // The owner-only cost keys ARE stripped for this caller — so the route's own
    // cost gate ran, and printServicePricing is what slips past it.
    assert.equal('printPricingConfig' in body.settings, false, 'precondition: the cost gate did not run');
    const found = rateLeaks(body.settings.printServicePricing ?? {});
    assert.deepEqual(found, [], `${role} admin reads the owner's print margin / rates on /api/admin/settings: ${found.join('; ')}`);
  });
}

// ------------------------------------------------------------------ 5 (guard gap)

test('the role-matrix sweep can see the print margin: its seed sets printServicePricing', () => {
  const raw = seededCopy();
  const row = raw.prepare(`SELECT value FROM admin_settings WHERE key = 'printServicePricing'`).get() as { value: string } | undefined;
  const seeded = row ? (JSON.parse(row.value) as Record<string, unknown>) : null;
  assert.ok(
    seeded && seeded.margin_percent !== null && seeded.margin_percent !== undefined,
    `tests/fixtures/roleMatrix.ts seedRoleMatrix never sets printServicePricing (stored: ${row?.value ?? 'no row'}), so every role sweep sees margin_percent: null and the public print margin can never fail it`
  );
});

test('the shared leak walk flags every print-calculation input, not only margin_percent', () => {
  const missing = PRIVATE_KEYS.filter((k) => !(FINANCIAL_FIELDS as readonly string[]).includes(k));
  const flagged = leaks({ rates: { ...RATES } });
  assert.deepEqual(
    missing,
    [],
    `FINANCIAL_FIELDS lacks ${missing.join(', ')}; tests/fixtures/costlyProduct.ts leaks() on the calculator's rates flags only: ${flagged.join('; ') || 'nothing'}`
  );
});
