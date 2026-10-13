/**
 * LEAK AUDIT — customer-api: GUARD GAP. The cost sweeps cannot see the
 * customer-facing print-quote doors, the public settings that start null, nor
 * the customer order / claim answers over ENGINE-ERA data (migration 0181).
 *
 * The owner's rule: anyone other than the main admin / super admin receives
 * ONLY the final price — never a cost, an FX snapshot, the USD price the
 * engine stored privately, or a step of how a price was computed. The audit
 * rules count a gap in a guard (a route the sweep never reaches past its
 * validation, a private value the seed never holds, a private field the
 * scanner does not know) as a finding of its own.
 *
 * This file proves, LOCALLY, each half of the candidate:
 *
 *   A. THE REAL PATH TODAY (control — expected to pass). An engine-priced
 *      order line (price_basis 'engine', usd_iqd_at_purchase,
 *      base_usd_at_purchase) and a v5 price-protection claim (basis
 *      'usd_base', the rate, the base USD and the observed base USD) are
 *      seeded on the role-matrix database for the customer `u1`, on the very
 *      order `ord1` every order route of the sweep is filled with, plus an
 *      engine price-history row carrying the rate. The customer reads
 *      GET /api/orders, /api/orders/ord1 and /api/price-protection/claims
 *      (the line and the claim ARE in the answers: the path is exercised),
 *      and the whole role-matrix GET sweep runs for every non-owner role with
 *      the engine sentinels added. Today's DTOs (orders.ts orderPublic,
 *      returns.ts claimPublic) are allow-lists, so nothing reaches anyone.
 *
 *   B. THE GUARD GAPS (expected to FAIL on the current code):
 *      B1. the shared scanner (tests/fixtures/costlyProduct.ts `leaks`) and
 *          the production naming net (FINANCIAL_FIELDS / stripFinancials) do
 *          not know `usd_iqd_at_purchase`, `base_usd_at_purchase` or
 *          `base_usd_observed` (the list has `usd_iqd_rate_at_purchase` and
 *          `fx_usd_iqd_at_purchase` — a spelling trap). Run over the REAL row
 *          the customer routes load (ORDER_ITEMS_SELECT, the claims SELECT),
 *          i.e. exactly what a future DTO that spreads `oi.*` / the claim row
 *          would answer, the scanner reports nothing and the strip keeps all;
 *      B2. the role-matrix seed holds no engine-era order line, no v5 claim,
 *          no print economics (printServicePricing, printPricingConfig,
 *          material per-kg, printer-model economics) and no store for the
 *          matrix merchant — so every sweep reads nulls and the public payload;
 *      B3. the write sweep calls the four customer-facing Engine B print-quote
 *          doors (grams-quote, link, analyses/:id/quote, analyses/:id/compare)
 *          with an EMPTY body only (tests/routeClass classifies /api/admin
 *          alone, so no valid body exists for them), and never reaches their
 *          success path (publicQuote / merchantQuote) for any non-owner role —
 *          while the same door answers 200 to a guest with a valid body on the
 *          same database (control). Engine A's POST /api/marketplace/print/quote
 *          IS reached (its empty body is a default spec) — asserted as such;
 *      B4. the consequence: give the matrix merchant the store it lacks and
 *          send the grams door a valid body, and the role-matrix scanner itself
 *          (leaks() minus NOT_A_COST, exactly as sweepWrites filters) flags the
 *          merchant payload — a finding the sweep can never see.
 *
 * LOCAL ONLY: temp-file SQLite copies of the role-matrix database (every
 * migration), the real route modules, the stub session of
 * tests/fixtures/app.ts. No network, no secret, no live host.
 *
 * Run: node --import tsx --test tests/leakAudit_customer-api_guard_gap_print_doors_and_engine_seed.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { DatabaseSync } from 'node:sqlite';
import { ROOT } from './fixtures/d1';
import { asD1 } from './fixtures/app';
import { leaks } from './fixtures/costlyProduct';
import {
  NOT_A_COST,
  ROLES,
  appFor,
  call,
  seededCopy,
  sweepGets,
  sweepWrites,
  writeRoutes,
  type RoleName,
  type WriteBodies,
} from './fixtures/roleMatrix';
import { ruleOf, type RouteClassFile } from './routeClass/_types';
import { FINANCIAL_FIELDS, stripFinancials } from '../worker/lib/adminScope';
import { ORDER_ITEMS_SELECT } from '../worker/routes/orders';
import { baseUsdOf } from '../worker/lib/pricingEngine/orderBasis';
import { storeForUser } from '../worker/lib/merchantAuth';

// ------------------------------------------------------------- the sentinels

/** The USD/IQD the engine priced the line at — an FX purchase snapshot (private). */
const RATE = '1537.125';
/** The engine's regular price of the line — what the customer paid (public). */
const ENGINE_REGULAR = 900_000;
/** Base USD at purchase = price ÷ U, the engine's own record (private: «the USD final price stored privately»). */
const BASE_USD = baseUsdOf(ENGINE_REGULAR, RATE);
/** What the claim observed as today's base USD (private). */
const OBSERVED_USD = '571.904417';

const ENGINE_DECIMALS = [RATE, BASE_USD, OBSERVED_USD];
const ENGINE_EXTRA = {
  decimals: ENGINE_DECIMALS,
  numbers: ENGINE_DECIMALS.map(Number),
};

/** The 0181 columns that hold the private engine figures, on the line and on the claim. */
const ENGINE_PRIVATE_KEYS = ['usd_iqd_at_purchase', 'base_usd_at_purchase', 'base_usd_observed'] as const;

/** Every non-owner role of the matrix (the owner is not in ROLES). */
const NON_OWNER = Object.keys(ROLES) as RoleName[];

/**
 * The role-matrix database plus ENGINE-ERA rows: a second line on `ord1`
 * (u1's delivered order, the id every order route of the sweep is filled
 * with) bought at an engine price, a v5 claim on it, and an engine price-
 * history row carrying the rate. The shape trigger of 0181 is satisfied (all
 * five snapshot columns set together).
 */
function engineSeed(): DatabaseSync {
  const raw = seededCopy();
  raw
    .prepare(
      `INSERT INTO order_items (id, order_id, product_id, name_snapshot, qty, unit_price_iqd, line_total_iqd,
                                option_id, option_value_ids,
                                price_basis, engine_combo_key, engine_channel, engine_regular_iqd,
                                usd_iqd_at_purchase, base_usd_at_purchase)
       VALUES ('oi_eng', 'ord1', 'p_a1', 'Bambu Lab A1 (engine)', 1, ?, ?, 'v_a1', '["v_a1"]',
               'engine', 'v_a1', 'direct_sale', ?, ?, ?)`
    )
    .run(ENGINE_REGULAR, ENGINE_REGULAR, ENGINE_REGULAR, RATE, BASE_USD);
  raw
    .prepare(
      `INSERT INTO price_protection_claims (id, user_id, order_id, order_item_id, original_unit_iqd, observed_unit_iqd,
                                            qty, credited_iqd, state, policy_snapshot,
                                            eligible_unit_iqd, basis, usd_iqd_at_purchase, base_usd_at_purchase, base_usd_observed)
       VALUES ('ppc_eng', 'u1', 'ord1', 'oi_eng', ?, 880000, 1, 0, 'requested', '{}', 12000, 'usd_base', ?, ?, ?)`
    )
    .run(ENGINE_REGULAR, RATE, BASE_USD, OBSERVED_USD);
  raw
    .prepare(
      `INSERT INTO price_history (product_id, variant_key, field, old_iqd, new_iqd, changed_at, usd_iqd_rate, price_source)
       VALUES ('p_a1', '', 'regular', 950000, ?, '2026-10-04T09:00:00Z', ?, 'engine_fx')`
    )
    .run(ENGINE_REGULAR, RATE);
  return raw;
}

/** Every engine sentinel or private engine key, anywhere in a body. */
function engineLeaks(body: unknown): string[] {
  const out: string[] = [];
  const walk = (v: unknown, path: string) => {
    if (Array.isArray(v)) v.forEach((x, i) => walk(x, `${path}[${i}]`));
    else if (v && typeof v === 'object') {
      for (const [k, x] of Object.entries(v as Record<string, unknown>)) {
        if ((ENGINE_PRIVATE_KEYS as readonly string[]).includes(k) && x !== null && x !== undefined) {
          out.push(`${path}.${k} = ${JSON.stringify(x)}`);
        }
        walk(x, `${path}.${k}`);
      }
    } else if (typeof v === 'number' && ENGINE_EXTRA.numbers.includes(v)) out.push(`${path} = ${v}`);
    else if (typeof v === 'string') for (const d of ENGINE_DECIMALS) if (v.includes(d)) out.push(`${path} ⊃ "${d}"`);
  };
  walk(body, '$');
  return out;
}

// =========================================================== A. the real path

test('A1 (control) the customer reads the engine-priced line and the v5 claim — and none of the engine figures', async () => {
  const raw = engineSeed();
  const app = appFor(raw, ROLES.customer);

  const detail = await call(app, 'GET', '/api/orders/ord1');
  assert.equal(detail.status, 200, `GET /api/orders/ord1 → ${detail.status}`);
  const items = ((detail.body as { order?: { items?: Array<{ id: string }> } }).order?.items ?? []) as Array<{ id: string }>;
  assert.ok(items.some((i) => i.id === 'oi_eng'), 'the engine-priced line is in the customer order answer (path exercised)');

  const list = await call(app, 'GET', '/api/orders');
  assert.equal(list.status, 200, `GET /api/orders → ${list.status}`);
  assert.ok(JSON.stringify(list.body).includes('oi_eng'), 'the engine-priced line is in the customer order list (path exercised)');

  const claims = await call(app, 'GET', '/api/price-protection/claims');
  assert.equal(claims.status, 200, `GET /api/price-protection/claims → ${claims.status}`);
  const c0 = ((claims.body as { claims?: Array<Record<string, unknown>> }).claims ?? []).find((c) => c.id === 'ppc_eng');
  assert.ok(c0, 'the v5 claim is in the customer claims answer (path exercised)');

  for (const [path, body] of [
    ['/api/orders/ord1', detail.body],
    ['/api/orders', list.body],
    ['/api/price-protection/claims', claims.body],
  ] as const) {
    assert.deepEqual(engineLeaks(body), [], `an engine figure reached the customer through ${path}`);
    assert.deepEqual(leaks(body, ENGINE_EXTRA), [], `the shared scanner found cost in ${path}`);
  }
});

test('A2 (control) the role-matrix GET sweep over the engine-era seed: no non-owner role gets an engine figure', async () => {
  const result = await sweepGets({ seed: engineSeed, extra: ENGINE_EXTRA });
  const found: string[] = [];
  for (const role of NON_OWNER) {
    const r = result[role]!;
    assert.ok(r.answered > 20, `only ${r.answered} GETs answered for ${role}`);
    for (const l of r.leaks) if (ENGINE_DECIMALS.some((d) => l.includes(d))) found.push(`${role}  ${l}`);
  }
  // The sweep did read the engine-era rows: the customer's order and claims answered.
  assert.equal(result.customer!.statuses['/api/orders/ord1'], 200, 'the sweep read u1’s order with the engine line');
  assert.equal(result.customer!.statuses['/api/price-protection/claims'], 200, 'the sweep read u1’s claims');
  assert.deepEqual(found, [], `engine figures reached a non-owner:\n${found.join('\n')}`);
});

// =========================================================== B. the guard gaps

test('B1 GUARD GAP: the shared scanner and the strip net know the engine-era private columns on the very rows the customer routes load', () => {
  const raw = engineSeed();
  // The rows exactly as the customer routes read them, before their DTOs pick
  // fields: ORDER_ITEMS_SELECT (GET /api/orders/:id, /api/orders) and the
  // claims SELECT of GET /api/price-protection/claims. A DTO that spreads
  // either one is the regression the guards exist to catch.
  const line = raw.prepare(`${ORDER_ITEMS_SELECT} WHERE oi.id = 'oi_eng'`).get() as Record<string, unknown>;
  const claim = raw
    .prepare(
      `SELECT ppc.*, oi.name_snapshot, oi.option_snapshot
         FROM price_protection_claims ppc JOIN order_items oi ON oi.id = ppc.order_item_id
        WHERE ppc.id = 'ppc_eng'`
    )
    .get() as Record<string, unknown>;
  assert.equal(line.usd_iqd_at_purchase, RATE);
  assert.equal(line.base_usd_at_purchase, BASE_USD);
  assert.equal(claim.base_usd_observed, OBSERVED_USD);

  const problems: string[] = [];
  const named = new Set<string>(FINANCIAL_FIELDS as readonly string[]);
  for (const [where, row] of [
    ['order_items row (ORDER_ITEMS_SELECT)', line],
    ['price_protection_claims row (GET /api/price-protection/claims SELECT)', claim],
  ] as const) {
    // The role-matrix sweeps call leaks() with NO engine sentinel: only names and the cost sentinels.
    const reported = leaks({ row });
    const stripped = stripFinancials({ ...row }) as Record<string, unknown>;
    for (const k of ENGINE_PRIVATE_KEYS) {
      if (!(k in row) || row[k] === null) continue;
      if (!named.has(k)) problems.push(`${where}: '${k}' is not in FINANCIAL_FIELDS`);
      if (!reported.some((l) => l.includes(`.${k} `))) problems.push(`${where}: leaks() does not report '${k}' = ${JSON.stringify(row[k])}`);
      if (k in stripped) problems.push(`${where}: stripFinancials keeps '${k}' = ${JSON.stringify(stripped[k])}`);
    }
  }
  assert.deepEqual(
    problems,
    [],
    `a DTO that spread the row would hand these private engine figures to the customer and every sweep would pass:\n${problems.join('\n')}`
  );
});

test('B2 GUARD GAP: the role-matrix seed holds the data the customer-facing doors and DTOs need to be swept', async () => {
  const raw = seededCopy();
  const n = (sql: string) => Number((raw.prepare(sql).get() as { n: number }).n);
  const missing: string[] = [];
  if (n(`SELECT COUNT(*) AS n FROM order_items WHERE price_basis = 'engine'`) === 0)
    missing.push('no engine-priced order line (0181 price_basis / usd_iqd_at_purchase / base_usd_at_purchase)');
  if (n(`SELECT COUNT(*) AS n FROM price_protection_claims WHERE basis <> 'iqd' OR base_usd_at_purchase IS NOT NULL`) === 0)
    missing.push('no v5 price-protection claim with its 0181 basis columns');
  for (const key of ['printServicePricing', 'printPricingConfig']) {
    if (n(`SELECT COUNT(*) AS n FROM admin_settings WHERE key = '${key}' AND value IS NOT NULL AND value <> 'null'`) === 0)
      missing.push(`admin_settings.${key} is unset (the sweep reads null)`);
  }
  if (n(`SELECT COUNT(*) AS n FROM print_materials WHERE default_iqd_per_kg IS NOT NULL`) === 0)
    missing.push('no print material carries the platform per-kg price');
  if (n(`SELECT COUNT(*) AS n FROM printer_models WHERE maintenance_iqd_per_hour IS NOT NULL OR useful_print_hours IS NOT NULL OR purchase_iqd IS NOT NULL`) === 0)
    missing.push('no printer model carries its owner-only economics');
  if (!(await storeForUser(asD1(raw), 'u_m')))
    missing.push("the matrix merchant 'u_m' owns no store, so storeForUser() is null and the merchant print payload is never built");
  assert.deepEqual(missing, [], `the sweeps run over nulls here, so a leak of these values is invisible to them:\n${missing.join('\n')}`);
});

/** The valid bodies the write sweep uses (exactly tests/costRoleMatrixWrites.test.ts `bodies()`). */
async function sweepBodies(): Promise<WriteBodies> {
  const dir = join(ROOT, 'tests/routeClass');
  const out: Record<string, { body: unknown; path?: string } | { noBody: string; path?: string }> = {};
  for (const f of readdirSync(dir).filter((x) => x.endsWith('.ts') && !x.startsWith('_'))) {
    const mod = (await import(pathToFileURL(join(dir, f)).href)) as { default: RouteClassFile };
    for (const m of mod.default.mounts) {
      for (const [route, spec] of Object.entries(m.routes)) {
        const [method, path] = route.split(' ') as [string, string];
        if (method === 'GET') continue;
        const rule = ruleOf(spec);
        const k = `${method} ${m.prefix}${path === '/' ? '' : path}`;
        if (rule.body !== undefined) out[k] = { body: rule.body, path: rule.path };
        else if (rule.path) out[k] = { noBody: rule.noBody ?? m.writes ?? rule.cls, path: rule.path };
      }
    }
  }
  return out;
}

/** The customer-facing doors of Engine B that build publicQuote / merchantQuote. */
const PRINT_DOORS = [
  'POST /api/print-quote/grams-quote',
  'POST /api/print-quote/link',
  'POST /api/print-quote/analyses/:id/quote',
  'POST /api/print-quote/analyses/:id/compare',
] as const;
/** Engine A's door: its empty body falls back to defaults, so the sweep DOES reach its success path. */
const ENGINE_A_DOOR = 'POST /api/marketplace/print/quote';

/** The statuses the sweep's own empty-body calls get, per role, for the failure message. */
async function emptyBodyStatuses(door: string): Promise<string> {
  const path = door.split(' ')[1]!.replace(':id', 'p_a1');
  const out: string[] = [];
  for (const role of ['guest', 'customer', 'merchant'] as const) {
    const r = await call(appFor(seededCopy(), ROLES[role]), 'POST', path, {});
    out.push(`${role} ${r.status}`);
  }
  return out.join(', ');
}

test('B3 GUARD GAP: the write sweep reaches the SUCCESS path of every customer-facing print-quote door for some non-owner role', async () => {
  const keys = new Set(writeRoutes().map((r) => r.key));
  for (const d of [...PRINT_DOORS, ENGINE_A_DOOR]) assert.ok(keys.has(d), `${d} is mounted in the write sweep`);

  // Control: the door is reachable locally — a guest with a VALID body gets the 200 public quote.
  const guest = appFor(seededCopy(), null);
  const ok = await call(guest, 'POST', '/api/print-quote/grams-quote', {
    printer_model_id: 'bbl-a1m',
    rows: [{ material_id: 'pla', grams: 120 }],
    print_minutes: 180,
  });
  assert.equal(ok.status, 200, `control: a valid grams body answers 200 (got ${ok.status} ${JSON.stringify(ok.body).slice(0, 200)})`);
  assert.ok((ok.body as { quote?: { price_iqd?: number } }).quote?.price_iqd, 'control: the public quote is priced');

  const bodies = await sweepBodies();
  const roles = { guest: ROLES.guest, customer: ROLES.customer, merchant: ROLES.merchant };

  // Engine A's door IS reached (the candidate overstates here): an empty body
  // is a default spec, priced, and the sweep walks that answer.
  const engineA = await sweepWrites({ roles, bodies, filter: (k) => k === ENGINE_A_DOOR });
  assert.ok(
    Object.values(engineA).reduce((s, r) => s + r.succeeded, 0) > 0,
    `${ENGINE_A_DOOR} is reached by the sweep's empty body`
  );

  const unreached: string[] = [];
  for (const door of PRINT_DOORS) {
    const given = bodies[door];
    const result = await sweepWrites({ roles, bodies, filter: (k) => k === door });
    const succeeded = Object.values(result).reduce((s, r) => s + r.succeeded, 0);
    const codes = Object.values(result)
      .flatMap((r) => Object.values(r.codes))
      .filter((v, i, a) => a.indexOf(v) === i);
    if (succeeded === 0) {
      unreached.push(
        `${door}: 0 of ${Object.values(result).reduce((s, r) => s + r.called, 0)} sweep calls succeeded ` +
          `(valid body in tests/routeClass: ${given && 'body' in given ? 'yes' : 'NONE'}; ` +
          `empty-body statuses: ${await emptyBodyStatuses(door)}; codes: ${codes.join(', ') || 'none'})`
      );
    }
  }
  assert.deepEqual(
    unreached,
    [],
    `the write sweep walks only the refusals of these doors — their quote payloads are never leak-checked:\n${unreached.join('\n')}`
  );
});

test('B4 GUARD GAP, consequence: had the sweep reached the merchant payload, its own scanner would have flagged it', async () => {
  // The two things the sweep lacks, and nothing else: a store for the matrix
  // merchant `u_m` (no economics of its own declared) and a valid grams body.
  const raw = seededCopy();
  raw.exec(`
    INSERT OR IGNORE INTO community_merchants (id, user_id, name) VALUES ('cm_um', 'u_m', 'Matrix Merchant');
    INSERT OR IGNORE INTO merchant_stores (id, merchant_id, user_id, slug, name) VALUES ('st_um', 'cm_um', 'u_m', 'matrix-merchant', 'Matrix Merchant');
  `);
  assert.ok(await storeForUser(asD1(raw), 'u_m'), 'the matrix merchant now owns a store');
  const app = appFor(raw, ROLES.merchant);
  const path = '/api/print-quote/grams-quote';
  const r = await call(app, 'POST', path, {
    printer_model_id: 'bbl-a1m',
    rows: [{ material_id: 'pla', grams: 120 }],
    print_minutes: 180,
  });
  assert.equal(r.status, 200, `the merchant's grams quote answers (got ${r.status})`);
  // Exactly the filter sweepWrites applies: leaks() minus the NOT_A_COST exceptions for this path.
  const found = leaks(r.body).filter((l) => !NOT_A_COST.some((x) => x.path.test(path) && x.leak.test(l)));
  assert.deepEqual(
    found,
    [],
    `the role-matrix scanner flags the merchant print payload that its sweep never reaches ` +
      `(priced on the platform's rates for a merchant with no economics — see leakAudit_customer-api_merchant_print_quote_owner_rates):\n${found.join('\n')}`
  );
});
