/**
 * LEAK AUDIT — client-bundles: the customer's trade-in wizard runs the
 * buy-back VALUATION ENGINE on the phone, over the owner's own rule sets,
 * and paints the per-factor breakdown.
 *
 * The owner's rule (2026-10): «المستخدم واي شخص يحصل فقط على السعر النهائي لا
 * يتسرب تكلفه او عمليه حسابيه نهائيا» — anyone other than the main admin /
 * super admin gets the FINAL price only; no cost and no CALCULATION, in no
 * channel (API, JSON, JavaScript…). Engine inputs and rules, a market
 * adjustment and every intermediate value of a pricing chain are private.
 *
 * The trade-in value is a price Levonis sets (what it pays for a used device it
 * may resell). Its chain is: base (the price the customer paid) → thirteen
 * factor effects in basis points × the owner's weights (including «حالة السوق
 * وقيمة إعادة البيع» — the shop's resale view of the family and per-product
 * overrides) → clamp to [floor_bp, cap_bp] of the base → round down. The
 * customer may see the FINAL estimate (`estimated_iqd`, `value_iqd`); the
 * rules and the breakdown are the «عملية حسابية».
 *
 * The path, exercised with the real code:
 *
 *   owner   PUT  /api/admin/trade-in/rules/fdm|ams  (real adminTradeInRoutes)
 *           tunes the rule sets with recognisable sentinel numbers;
 *   server  GET  /api/trade-in/eligible  (real tradeInRoutes, every signed-in
 *           non-owner role of tests/fixtures/roleMatrix.ts ROLES — with or
 *           without a delivered order: `rules` is answered for ALL FIVE
 *           families unconditionally, worker/routes/tradeIn.ts);
 *   server  POST /api/trade-in/requests, GET /api/trade-in/requests/:id
 *           (`requestView(…, 'customer')` → `rules` + `estimate.components[].
 *           valuation.lines` with effect_bp, floor_iqd, cap_iqd);
 *   client  src/components/tradeIn/controls.tsx `Breakdown` paints each line
 *           with its signed percent (rendered here with react-dom/server on
 *           the server's real answer);
 *   bundle  the built engine chunk the customer TradeIn page loads (when dist/
 *           exists) carries DEFAULT_RULE_SETS — the rules in force until the
 *           owner saves a version — as a static asset anyone can download.
 *
 * Existing guards do not see it: FINANCIAL_FIELDS (and so the shared scanner
 * `leaks()` of tests/fixtures/costlyProduct.ts) names none of floor_bp,
 * cap_bp, weight_bp, effect_bp, resale_bp, product_overrides, min_base_iqd,
 * ams_reference_iqd or `lines`; costRouteClassification classifies only the
 * ADMIN trade-in mount; bundlePrivateNames lists no trade-in name.
 *
 * LOCAL ONLY: a temp SQLite with every migration, the stub session of
 * tests/fixtures/app.ts, the local dist/ when present. No network.
 *
 * Run: node --import tsx --test tests/leakAudit_client-bundles_trade_in_valuation_rules_client_side.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { DatabaseSync } from 'node:sqlite';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { asD1, freshDb, get, json, post, put, stubApp, OWNER, type StubUser } from './fixtures/app';
import { leaks } from './fixtures/costlyProduct';
import { ROLES, type RoleName } from './fixtures/roleMatrix';
import { tradeInRoutes, adminTradeInRoutes } from '../worker/routes/tradeIn';
import { type TradeInRuleSet, type FactorRule } from '../packages/pricing/src/tradeIn';
import { DEFAULT_RULE_SETS } from '../packages/pricing/src/tradeInDefaults';
import { LanguageProvider } from '../src/LanguageContext';
import { CurrencyValueProvider, currencyValue } from '../src/CurrencyContext';
import { Breakdown, bpText } from '../src/components/tradeIn/controls';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

// ------------------------------------------------------------ the owner's private rules

/** Recognisable numbers the owner's tuned rule sets carry — none can be a price, id or date of the fixture. */
const RULE = {
  floor_bp: 1_234,
  cap_bp: 7_891,
  min_base_iqd: 123_457,
  ams_reference_iqd: 287_653,
  resale_bp: -1_357,
  overrideA1: -2_468,
  overrideP1S: -2_579,
  ageMax: 4_321,
} as const;
const RULE_NUMBERS = Object.values(RULE);

/** Keys that exist only to say HOW the trade-in value is computed. Any of them, carrying a value, is the calculation. */
const CALC_KEYS = new Set([
  'factors',
  'weight_bp',
  'effect_bp',
  'effects_bp',
  'resale_bp',
  'product_overrides',
  'per_month_bp',
  'per_item_bp',
  'max_bp',
  'max_total_bp',
  'grace_months',
  'bands',
  'floor_bp',
  'cap_bp',
  'min_base_iqd',
  'ams_reference_iqd',
  'floor_iqd',
  'cap_iqd',
  'lines',
]);

function tuned(family: 'fdm' | 'ams'): TradeInRuleSet {
  const r = structuredClone(DEFAULT_RULE_SETS[family]);
  if (family === 'ams') return { ...r, ams_reference_iqd: RULE.ams_reference_iqd };
  r.floor_bp = RULE.floor_bp;
  r.cap_bp = RULE.cap_bp;
  r.min_base_iqd = RULE.min_base_iqd;
  r.factors = r.factors.map((f): FactorRule => {
    if (f.factor === 'market') {
      return {
        ...f,
        config: {
          kind: 'market',
          resale_bp: RULE.resale_bp,
          product_overrides: [
            { product_id: 'p_a1', effect_bp: RULE.overrideA1 },
            { product_id: 'p_p1s', effect_bp: RULE.overrideP1S },
          ],
        },
      };
    }
    if (f.factor === 'usage_age' && f.config.kind === 'age') return { ...f, config: { ...f.config, max_bp: RULE.ageMax } };
    return f;
  });
  return r;
}

// ------------------------------------------------------------ world

const ENV = { APP_ORIGIN: 'https://shop.example', TELEGRAM_ADMIN_CHAT_ID: '' };
const DELIVERED = '2025-09-26T00:00:00.000Z';

/** Every signed-in caller the sweep runs as: every non-owner role of the role matrix. */
const SIGNED_IN: Array<[RoleName, StubUser]> = (Object.entries(ROLES) as Array<[RoleName, StubUser | null]>)
  .filter((e): e is [RoleName, StubUser] => e[1] !== null);
const CUSTOMER = ROLES.customer!;

function seed(): DatabaseSync {
  const raw = freshDb();
  const users = [OWNER, ...SIGNED_IN.map(([, u]) => u)];
  const stmt = raw.prepare(
    `INSERT OR IGNORE INTO users (id,name,email,password_hash,role,admin_scope,is_investor,email_verified_at) VALUES (?,?,?,?,?,?,?,?)`
  );
  for (const u of users) {
    stmt.run(u.id, u.id, u.email, 'h', u.role, u.admin_scope ?? null, u.is_investor ?? 0, '2026-01-01T00:00:00.000Z');
  }
  raw.exec(`
    INSERT INTO products (id,slug,name,name_ar,price_iqd,status,stock,options,colors,selling_type,sale_types,images,category_id,sub_category_id) VALUES
      ('p_a1','a1','Bambu Lab A1','بامبو A1',850000,'active',10,'[]','[]','direct_sale','["direct_sale"]','[]','cat_printers','cat_printers_fdm'),
      ('p_p1s','p1s','Bambu Lab P1S','بامبو P1S',1500000,'active',5,'[]','[]','direct_sale','["direct_sale"]','[]','cat_printers','cat_printers_fdm');
    INSERT INTO orders (id,user_id,status,stage,address_snapshot,delivery_method_id,delivery_method_snapshot,payment_method_id,
                        subtotal_iqd,shipping_iqd,exchange_rate,total_iqd,due_on_delivery_iqd,created_at,updated_at,delivered_at) VALUES
      ('ORD-DLV','${CUSTOMER.id}','delivered','delivered','{}','standard','{}','cash',850000,0,1400,850000,0,'2025-09-20T00:00:00.000Z','${DELIVERED}','${DELIVERED}');
    INSERT INTO order_items (id,order_id,product_id,name_snapshot,image_snapshot,option_snapshot,qty,unit_price_iqd,line_total_iqd,option_id,option_value_ids) VALUES
      ('oi_a1','ORD-DLV','p_a1','Bambu Lab A1','','',1,850000,850000,'','[]');
    INSERT INTO order_item_units (id,order_id,order_item_id,product_id,owner_user_id,unit_index,delivered_at,warranty_base_months,warranty_ext_months,warranty_start_at,warranty_end_at,policy_version)
      VALUES ('unit_a1','ORD-DLV','oi_a1','p_a1','${CUSTOMER.id}',1,'${DELIVERED}',24,0,'${DELIVERED}','2027-09-26T00:00:00.000Z','{}');
  `);
  return raw;
}

const customerApp = (raw: DatabaseSync, user: StubUser) =>
  stubApp(asD1(raw), user, (a) => a.route('/api/trade-in', tradeInRoutes), { env: ENV });
const ownerApp = (raw: DatabaseSync) =>
  stubApp(asD1(raw), OWNER, (a) => a.route('/api/admin/trade-in', adminTradeInRoutes), { env: ENV });

/** The owner saves the tuned rule sets through the real admin door, and reads them back. */
async function ownerTunes(raw: DatabaseSync): Promise<void> {
  const app = ownerApp(raw);
  for (const family of ['fdm', 'ams'] as const) {
    const res = await put(app, `/api/admin/trade-in/rules/${family}`, { rules: tuned(family), note: 'owner tuning' });
    assert.equal(res.status, 200, `owner PUT rules/${family}: ${await res.clone().text()}`);
  }
  // Positive control: the tuned numbers are the rules in force.
  const book = (await json(await get(app, '/api/admin/trade-in/rules'))).rules;
  assert.equal(book.fdm.floor_bp, RULE.floor_bp, 'the owner’s floor is in force');
  assert.equal(book.fdm.cap_bp, RULE.cap_bp, 'the owner’s cap is in force');
  assert.equal(book.ams.ams_reference_iqd, RULE.ams_reference_iqd, 'the owner’s AMS reference is in force');
}

/** Every place the calculation reaches a non-owner: a calc key with a value, or one of the owner's rule numbers anywhere. */
function calculationLeaks(value: unknown): string[] {
  const out: string[] = [];
  const walk = (v: unknown, path: string) => {
    if (Array.isArray(v)) v.forEach((x, i) => walk(x, `${path}[${i}]`));
    else if (v && typeof v === 'object') {
      for (const [k, x] of Object.entries(v as Record<string, unknown>)) {
        if (CALC_KEYS.has(k) && x !== null && x !== undefined) out.push(`${path}.${k} = ${JSON.stringify(x)?.slice(0, 80)}`);
        else walk(x, `${path}.${k}`);
      }
    }
  };
  walk(value, '$');
  // The shared cost scanner, told the owner's rule numbers (it does not know them itself).
  for (const l of leaks(value, { numbers: RULE_NUMBERS })) out.push(`scanner: ${l}`);
  return out;
}

// ------------------------------------------------------------ the API

test('every signed-in non-owner role gets NO trade-in valuation rules from GET /api/trade-in/eligible', async () => {
  const raw = seed();
  await ownerTunes(raw);
  const found: string[] = [];
  let scannerBlind = true;
  for (const [role, user] of SIGNED_IN) {
    const res = await get(customerApp(raw, user), '/api/trade-in/eligible');
    assert.equal(res.status, 200, `${role}: ${await res.clone().text()}`);
    const body = await json(res);
    for (const l of calculationLeaks(body)) found.push(`${role} GET /api/trade-in/eligible ${l}`);
    // The guard gap: the scanner alone, as the role matrix runs it, sees nothing here.
    if (leaks(body).length) scannerBlind = false;
  }
  // Guest is turned away at requireAuth — the door is signed-in only.
  assert.equal((await get(stubApp(asD1(raw), null, (a) => a.route('/api/trade-in', tradeInRoutes), { env: ENV }), '/api/trade-in/eligible')).status, 401);
  assert.deepEqual(
    found.slice(0, 40),
    [],
    `the owner's trade-in valuation rules reach non-owners (${found.length} findings; shared leak scanner blind to them: ${scannerBlind}):\n${found.slice(0, 40).join('\n')}`
  );
});

test('the customer’s own draft carries only the final estimate — no rules, no per-factor breakdown, no floor/cap', async () => {
  const raw = seed();
  await ownerTunes(raw);
  const app = customerApp(raw, CUSTOMER);
  const created = await post(app, '/api/trade-in/requests', { order_item_id: 'oi_a1', unit_index: 1, scope: 'whole' });
  assert.equal(created.status, 201, await created.clone().text());
  const draft = (await json(created)).request;
  // The path really priced with the owner's rules: the A1's market override is in force.
  assert.ok(typeof draft.estimated_iqd === 'number' && draft.estimated_iqd > 0, 'the final estimate is there (allowed)');
  const view = await json(await get(app, `/api/trade-in/requests/${draft.id}`));
  const found = [
    ...calculationLeaks(draft).map((l) => `POST /api/trade-in/requests ${l}`),
    ...calculationLeaks(view).map((l) => `GET /api/trade-in/requests/:id ${l}`),
  ];

  // What the wizard paints from that answer (src/components/tradeIn/controls.tsx Breakdown).
  const comp = (view.request?.estimate?.components ?? [])[0];
  if (comp?.valuation) {
    const html = renderToStaticMarkup(
      createElement(LanguageProvider, {
        children: createElement(CurrencyValueProvider, {
          value: currencyValue('IQD', () => undefined, null),
          children: createElement(Breakdown, { valuation: comp.valuation }),
        }),
      })
    );
    const pct = bpText(RULE.overrideA1);
    if (html.includes(pct)) found.push(`client Breakdown paints the owner's per-product market override «${pct}» (${RULE.overrideA1} bp) to the customer`);
    const calcLines = (comp.valuation.lines as Array<{ factor: string; effect_bp: number }>).filter((l) => l.factor !== 'base');
    const painted = calcLines.filter((l) => l.effect_bp === 0 || html.includes(bpText(l.effect_bp)));
    if (painted.length) found.push(`client Breakdown paints ${painted.length} calculation rows (${painted.map((l) => l.factor).join(', ')}) between the price paid and the final value`);
  }

  assert.deepEqual(found.slice(0, 40), [], `the trade-in calculation reaches the customer (${found.length} findings):\n${found.slice(0, 40).join('\n')}`);
});

// ------------------------------------------------------------ the bundle

test('the customer TradeIn chunks (dist/, when built) carry no valuation rule set', (t) => {
  const ASSETS = join(ROOT, 'dist', 'assets');
  if (!existsSync(ASSETS)) {
    t.skip('no dist/ — run npm run build first');
    return;
  }
  const files = readdirSync(ASSETS).filter((f) => f.endsWith('.js'));
  const page = files.filter((f) => /^TradeIn-.*\.js$/.test(f));
  assert.ok(page.length >= 1, 'dist/ exists but holds no customer TradeIn chunk');
  // The page chunk and every chunk it names (its static imports).
  const reach = new Set(page);
  for (const p of page) {
    const code = readFileSync(join(ASSETS, p), 'utf8');
    for (const f of files) if (f !== p && code.includes(f)) reach.add(f);
  }
  const found: string[] = [];
  for (const f of reach) {
    const code = readFileSync(join(ASSETS, f), 'utf8');
    // DEFAULT_RULE_SETS (packages/pricing/src/tradeIn.ts) — the rules in force until the owner saves a version.
    const marks = ['resale_bp', 'product_overrides', 'max_total_bp', 'nozzle_clog', 'floor_bp', 'cap_bp'].filter((m) => code.includes(m));
    if (marks.includes('nozzle_clog') && marks.includes('resale_bp')) {
      const sample = /resale_bp:-?\d[\d.e]*/.exec(code)?.[0] ?? '';
      found.push(`dist/assets/${f} ships the default valuation rule sets (${marks.join(', ')}; e.g. «${sample}»)`);
    }
  }
  assert.deepEqual(found, [], `a customer-reachable static chunk carries the trade-in valuation rules:\n${found.join('\n')}`);
});
