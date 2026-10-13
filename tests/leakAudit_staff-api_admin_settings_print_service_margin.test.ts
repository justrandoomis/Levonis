/**
 * LEAK AUDIT — staff-api: GET /api/admin/settings hands the owner's PRINT-SERVICE
 * MARGIN and two inputs of the print price calculation to every NON-owner admin.
 *
 * The owner's rule: anyone other than the main admin / super admin receives
 * ONLY the final price — never a margin, never an engine input, never an
 * intermediate value of the pricing chain. `printServicePricing`
 * (worker/lib/settings.ts) is exactly that:
 *   margin_percent        the markup the print calculator adds on top of
 *                         material + machine + setup;
 *   machine_iqd_per_hour  the machine-time rate it is applied to;
 *   setup_fee_iqd         the setup fee it is applied to.
 *
 * worker/routes/admin.ts — GET /api/admin/settings returns `getSettings()` and,
 * for a caller who fails `canViewCost`, deletes only COST_SETTING_KEYS
 * (`minMarginPercent`, `printPricingConfig`, `printMaterials`).
 * `printServicePricing` is not in that list, so it reaches the assistant, the
 * full-scope admin, the legacy NULL-scope admin, the grantee while delegation is
 * off, the support assistant and the owner's own unverified session.
 *
 * Why the existing guards miss it: tests/fixtures/roleMatrix.ts seedRoleMatrix
 * never sets printServicePricing, so every role sweep in
 * tests/costRoleMatrix.test.ts reads `{…: null}` and `leaks()` skips null
 * values; and FINANCIAL_FIELDS names `margin_percent` but neither
 * `machine_iqd_per_hour` nor `setup_fee_iqd`.
 *
 * The owner sets the rates through the owner's real write path
 * (PUT /api/admin/settings/printServicePricing); every caller then reads
 * through the same mounts the role matrix sweeps (`appFor` + BASE_MOUNTS).
 * A control shows the VERIFIED owner reading the same values, so the path is
 * really exercised.
 *
 * LOCAL ONLY: a byte copy of the seeded role-matrix database, the real route
 * modules, no network.
 *
 * Run: node --import tsx --test tests/leakAudit_staff-api_admin_settings_print_service_margin.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { DatabaseSync } from 'node:sqlite';
import { OWNER, json, put, stubApp, asD1, type StubUser } from './fixtures/app';
import { leaks } from './fixtures/costlyProduct';
import {
  ADMIN_ROLES,
  NOT_A_COST,
  OWNER_UNVERIFIED,
  ROLES,
  appFor,
  call,
  seededCopy,
} from './fixtures/roleMatrix';
import { adminRoutes } from '../worker/routes/admin';

/** The owner's print-service rates — sentinel figures no seeded price, id, count or timestamp can equal. */
const RATES = {
  machine_iqd_per_hour: 7_510_203,
  setup_fee_iqd: 7_520_213,
  margin_percent: 37.7731,
} as const;
const PRIVATE_KEYS = Object.keys(RATES) as Array<keyof typeof RATES>;
const EXTRA = {
  numbers: Object.values(RATES) as number[],
  decimals: ['37.7731', '7510203', '7,510,203', '7520213', '7,520,213'],
};

/**
 * Every place one of the owner's rates reaches: the shared leak walk (which
 * flags `margin_percent` as a FINANCIAL_FIELDS key), each private key by name
 * with a non-null value, and each sentinel figure as a number or inside text.
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
    } else if (typeof v === 'number' && EXTRA.numbers.includes(v)) out.push(`${path} = ${v}`);
    else if (typeof v === 'string') for (const t of EXTRA.decimals) if (v.includes(t)) out.push(`${path} ⊃ "${t}"`);
  };
  walk(body, '$');
  // The answers the role matrix already accepts on this route with a written
  // reason (the published per-piece accessory price, the farm game's coins)
  // are not this candidate; everything else is.
  const accepted = NOT_A_COST.filter((n) => n.path.test(ROUTE));
  return [...new Set(out)].filter((l) => !accepted.some((n) => n.leak.test(l)));
}

const ROUTE = '/api/admin/settings';

/** The seeded role-matrix shop, with the owner's rates written by the verified owner's own write path. */
async function shopWithRates(opts: { unverifyOwnerAfter?: boolean } = {}): Promise<DatabaseSync> {
  const raw = seededCopy();
  const ownerApp = stubApp(asD1(raw), OWNER, (a) => {
    a.route('/api/admin', adminRoutes);
  });
  const res = await put(ownerApp, '/api/admin/settings/printServicePricing', { value: RATES });
  assert.equal(res.status, 200, `the owner could not set the rates: ${JSON.stringify(await json(res))}`);
  const stored = raw.prepare(`SELECT value FROM admin_settings WHERE key = 'printServicePricing'`).get() as { value: string } | undefined;
  assert.deepEqual(JSON.parse(String(stored?.value)), RATES, 'the owner write did not store the rates');
  if (opts.unverifyOwnerAfter) raw.exec("UPDATE users SET email_verified_at = NULL WHERE id = 'usr_owner'");
  return raw;
}

async function readSettings(raw: DatabaseSync, user: StubUser) {
  const res = await call(appFor(raw, user), 'GET', ROUTE);
  const body = res.body as Record<string, any>;
  return { status: res.status, body };
}

// ------------------------------------------------------------------ control

test('control: the VERIFIED owner reads the print rates on GET /api/admin/settings (the path is exercised)', async () => {
  const raw = await shopWithRates();
  const { status, body } = await readSettings(raw, OWNER);
  assert.equal(status, 200, JSON.stringify(body).slice(0, 300));
  assert.deepEqual(body.settings?.printServicePricing, RATES, 'the owner did not read back the rates the owner set');
  // The owner also reads the owner-only cost keys: the cost gate let the owner through.
  assert.ok('printPricingConfig' in body.settings, 'the owner lost printPricingConfig');
  assert.ok(rateLeaks(body.settings.printServicePricing).length > 0, 'the scanner does not recognise the sentinel rates');
});

// ------------------------------------------------------------------ every non-owner admin

const NON_OWNER_ADMINS: Array<[string, StubUser, { unverifyOwnerAfter?: boolean }]> = [
  ...ADMIN_ROLES.map((r) => [r, ROLES[r]!, {}] as [string, StubUser, { unverifyOwnerAfter?: boolean }]),
  ['owner_unverified', OWNER_UNVERIFIED, { unverifyOwnerAfter: true }],
];

for (const [role, user, opts] of NON_OWNER_ADMINS) {
  test(`non-owner admin (${role}) GET /api/admin/settings carries no print margin and no print-calculation input`, async () => {
    const raw = await shopWithRates(opts);
    const { status, body } = await readSettings(raw, user);
    assert.equal(status, 200, `${role}: ${JSON.stringify(body).slice(0, 300)}`);
    assert.ok(body.settings && typeof body.settings === 'object', `${role}: no settings block`);
    // The route's own cost gate ran for this caller: the owner-only cost keys
    // are gone — so whatever survives is what the gate lets past.
    for (const k of ['minMarginPercent', 'printPricingConfig', 'printMaterials']) {
      assert.equal(k in body.settings, false, `precondition (${role}): the cost gate did not strip ${k}`);
    }
    const found = rateLeaks(body);
    assert.deepEqual(
      found,
      [],
      `${role} admin reads the owner's print margin / calculation inputs on GET /api/admin/settings: ${found.join('; ')}`
    );
  });
}

// ------------------------------------------------------------------ guard gap

test('guard gap: the role-matrix sweep of GET /api/admin/settings can see the print margin (its seed sets printServicePricing)', async () => {
  // Exactly what tests/costRoleMatrix.test.ts sees: the plain seeded copy, the
  // assistant, the shared `leaks()` with no extras.
  const plain = seededCopy();
  const swept = await readSettings(plain, ROLES.assistant!);
  assert.equal(swept.status, 200);
  const sweepSees = leaks(swept.body).filter((l) => /printServicePricing/.test(l));
  // With the owner's rates set, the same shared scanner does flag the margin —
  // so the guard misses this only because its seed leaves the setting null.
  const withRates = await readSettings(await shopWithRates(), ROLES.assistant!);
  const realLeak = leaks(withRates.body).filter((l) => /printServicePricing/.test(l));
  assert.ok(
    sweepSees.length > 0 || realLeak.length === 0,
    `the role-matrix seed leaves printServicePricing = ${JSON.stringify(swept.body.settings?.printServicePricing)}, so the sweep sees nothing, ` +
      `while the same scanner on a shop with rates finds: ${realLeak.join('; ')}`
  );
});
