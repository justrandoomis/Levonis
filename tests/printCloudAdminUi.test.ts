/**
 * THE PRINT CLOUD CONSOLE CANNOT DRIFT FROM THE SERVER IT EDITS
 * (src/components/adminPrintCloud).
 *
 *   CATALOGUE   the console's field description (catalogFields.ts) mirrors
 *               `ENTITIES` (worker/lib/printCloud/catalog.ts) field for field:
 *               names in order, kinds, required, bounds, value lists,
 *               nullability, and the MONEY, COST and IMMUTABLE flags that
 *               decide who may edit what.
 *   SETTINGS    every key of `DEFAULT_CONFIG` has its control, with the bounds
 *               `normalizeConfig` enforces, and exactly the `COST_SETTING_KEYS`
 *               are the owner's.
 *   JOBS        every action offered from a state is a transition the server's
 *               machine allows (`TRANSITIONS`); every cancel and fail edge is
 *               offered; terminal states offer nothing.
 *   SHIPMENTS   the moves offered are the server's (fulfillment.ts
 *               `SHIPMENT_TRANSITIONS`), never «preparing» by hand.
 *   PRICES      the tier preview prices every case exactly as `priceMaterial`.
 *   WORDS       every phrase of the console in Arabic, English and real
 *               Sorani: never the Arabic pasted across, never an Arabic-only
 *               letter; every server code a table names exists on the server.
 *   MONEY DOORS the Idempotency-Key is minted only for the three doors the
 *               server keys (`idempotent: true` in openapi.ts); the manual
 *               payment door is sent none.
 *
 * Run: node --import tsx --test tests/printCloudAdminUi.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { ROOT } from './fixtures/d1';
import { ENTITIES } from '../worker/lib/printCloud/catalog';
import { COST_SETTING_KEYS, DEFAULT_CONFIG, MODEL_UPLOAD_CEILING_BYTES } from '../worker/lib/printCloud/settings';
import { TRANSITIONS } from '../worker/lib/printCloud/jobs';
import { priceMaterial, type TierRow } from '../worker/lib/printCloud/pricing';
import { TASK_KINDS } from '../worker/lib/printCloud/tasks';
import { ADAPTERS } from '../worker/lib/printCloud/adapters';
import { OPERATIONS } from '../worker/lib/printCloud/openapi';
import { CLIENT_ENTITIES, ENTITY_ORDER } from '../src/components/adminPrintCloud/catalogFields';
import { MODEL_UPLOAD_CEILING_BYTES as CLIENT_CEILING, SETTING_FIELDS } from '../src/components/adminPrintCloud/settingsFields';
import { ACTION_TARGET, DESTRUCTIVE, JOB_ACTIONS, actionsFor, shipmentMoves } from '../src/components/adminPrintCloud/jobRules';
import { previewMaterialPrice } from '../src/components/adminPrintCloud/pricePreview';
import { IDEMPOTENT_DOORS } from '../src/components/adminPrintCloud/api';
import * as I18N from '../src/components/adminPrintCloud/i18n';

const CONSOLE = join(ROOT, 'src/components/adminPrintCloud');

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    return statSync(p).isDirectory() ? walk(p) : /\.(ts|tsx)$/.test(name) ? [p] : [];
  });
}
const FILES = walk(CONSOLE);
const source = (rel: string) => readFileSync(join(ROOT, rel), 'utf8');

// ------------------------------------------------------------------ catalogue

test('CATALOGUE: the console describes every entity and every field exactly as ENTITIES does', () => {
  const server = ENTITIES as unknown as Record<string, { fields: ReadonlyArray<Record<string, unknown>> }>;
  assert.deepEqual(Object.keys(CLIENT_ENTITIES).sort(), Object.keys(server).sort(), 'the same entities');
  assert.deepEqual([...ENTITY_ORDER].sort(), Object.keys(server).sort(), 'every entity has its place in the console');
  const FLAGS = ['required', 'nullable', 'money', 'cost', 'immutable'] as const;
  for (const [key, spec] of Object.entries(server)) {
    const client = CLIENT_ENTITIES[key as keyof typeof CLIENT_ENTITIES];
    assert.deepEqual(
      client.fields.map((f) => f.name),
      spec.fields.map((f) => f.name),
      `${key}: the same fields, in the server's order`
    );
    spec.fields.forEach((s, i) => {
      const c = client.fields[i] as unknown as Record<string, unknown>;
      const where = `${key}.${String(s.name)}`;
      assert.equal(c.kind, s.kind, `${where}: kind`);
      for (const flag of FLAGS) assert.equal(c[flag] === true, s[flag] === true, `${where}: ${flag}`);
      assert.equal(c.min, s.min, `${where}: min`);
      assert.equal(c.max, s.max, `${where}: max`);
      assert.deepEqual(c.values ?? null, s.values ?? null, `${where}: allowed values`);
      if (s.kind === 'ref') assert.ok(c.ref, `${where}: a reference names the list it picks from`);
      if (c.money === true) assert.notEqual(c.cost, true, `${where}: a price is never also a cost`);
    });
    for (const col of client.columns) assert.ok(client.fields.some((f) => f.name === col) || col === 'id', `${key}: column ${col} is a field`);
  }
});

// ------------------------------------------------------------------ settings

/** `name: clampInt(r.name, d.name, MIN, MAX)` (or `del.` for the delivery keys), evaluated. */
function serverBounds(): Map<string, { min: number; max: number }> {
  const src = source('worker/lib/printCloud/settings.ts');
  const out = new Map<string, { min: number; max: number }>();
  const value = (expr: string): number => {
    const e = expr.trim().replace(/_/g, '').replace('MODELUPLOADCEILINGBYTES', String(MODEL_UPLOAD_CEILING_BYTES));
    assert.match(e, /^\d+(\s*\*\s*\d+)*$/, `a bound the test can read: ${expr}`);
    return e.split('*').reduce((p, n) => p * Number(n.trim()), 1);
  };
  for (const m of src.matchAll(/(\w+): clampInt\((r|del)\.(\w+), d\.[\w.]+, ([^,]+), ([^)]+)\)/g)) {
    out.set(m[2] === 'del' ? `delivery.${m[1]}` : m[1], { min: value(m[4]), max: value(m[5]) });
  }
  return out;
}

/** Every leaf key of the default configuration, dotted; the two structured ones whole. */
function configPaths(): string[] {
  const out: string[] = [];
  for (const [k, v] of Object.entries(DEFAULT_CONFIG)) {
    if (k === 'import_providers') out.push(k);
    else if (v && typeof v === 'object' && !Array.isArray(v)) for (const sub of Object.keys(v)) out.push(`${k}.${sub}`);
    else out.push(k);
  }
  return out;
}

test('SETTINGS: one control per configuration key, the server’s bounds, and exactly the cost keys are the owner’s', () => {
  const paths = configPaths();
  const fields = new Map(SETTING_FIELDS.map((f) => [f.path, f]));
  assert.deepEqual([...fields.keys()].sort(), [...paths].sort(), 'every key, and nothing else');
  assert.equal(CLIENT_CEILING, MODEL_UPLOAD_CEILING_BYTES, 'the upload ceiling');
  const bounds = serverBounds();
  assert.ok(bounds.size >= 10, `the server's bounds were read (${bounds.size})`);
  for (const [path, b] of bounds) {
    const f = fields.get(path);
    assert.ok(f, `${path}: has a control`);
    assert.equal(f.kind, 'int', `${path}: a whole number`);
    assert.equal(f.min, b.min, `${path}: min`);
    assert.equal(f.max, b.max, `${path}: max`);
  }
  for (const f of SETTING_FIELDS) {
    const def = f.path.split('.').reduce<unknown>((o, k) => (o as Record<string, unknown>)[k], DEFAULT_CONFIG);
    if (f.kind === 'bool') assert.equal(typeof def, 'boolean', `${f.path}: a switch`);
    if (f.kind === 'int') assert.ok(bounds.has(f.path), `${f.path}: the server clamps it`);
    if (f.kind === 'enum') assert.ok(f.values?.includes(String(def)), `${f.path}: the default is one of the values`);
  }
  assert.deepEqual(
    SETTING_FIELDS.filter((f) => f.cost).map((f) => f.path).sort(),
    [...COST_SETTING_KEYS].sort(),
    'the owner’s keys are exactly COST_SETTING_KEYS'
  );
  assert.deepEqual(SETTING_FIELDS.filter((f) => f.ownerOnly).map((f) => f.path), ['enabled'], 'opening the service is the owner’s switch');
  for (const p of ['workshop', 'customer', 'model', 'undetermined']) {
    assert.deepEqual([...(fields.get(`failure_policy.${p}`)?.values ?? [])].sort(), ['charge_printed', 'manual_review', 'no_charge']);
  }
});

// ------------------------------------------------------------------ jobs and shipments

test('JOBS: every offered action is a transition the server allows from that state', () => {
  assert.deepEqual(Object.keys(JOB_ACTIONS).sort(), Object.keys(TRANSITIONS).sort(), 'every state, and nothing else');
  const machine = TRANSITIONS as Readonly<Record<string, readonly string[]>>;
  for (const [state, actions] of Object.entries(JOB_ACTIONS)) {
    for (const a of actions) {
      const to = ACTION_TARGET[a];
      if (to !== null) assert.ok(machine[state].includes(to), `${state} → ${a} (${to}) is not an edge of TRANSITIONS`);
    }
    assert.equal(actions.includes('cancel'), machine[state].includes('cancelled'), `${state}: cancel is offered exactly where the edge exists`);
    assert.equal(actions.includes('fail'), machine[state].includes('failed'), `${state}: fail is offered exactly where the edge exists`);
    if (machine[state].length === 0) assert.deepEqual(actions, [], `${state}: terminal, nothing to offer`);
  }
  assert.ok(!actionsFor('printing', false).includes('verify'), 'verify only when an agent report waits');
  assert.ok(actionsFor('printing', true).includes('verify'));
  for (const a of ['reject', 'cancel', 'fail', 'unassign'] as const) assert.ok(DESTRUCTIVE.has(a), `${a} is asked twice`);
});

test('SHIPMENTS: the moves offered are the server’s, and a fee-bound shipment never moves on by hand', () => {
  const src = source('worker/lib/printCloud/fulfillment.ts');
  const block = /const SHIPMENT_TRANSITIONS[^=]*= \{([\s\S]*?)\n\};/.exec(src);
  assert.ok(block, 'SHIPMENT_TRANSITIONS is where it was');
  const machine: Record<string, string[]> = {};
  for (const m of block[1].matchAll(/(\w+): \[([^\]]*)\]/g)) machine[m[1]] = [...m[2].matchAll(/'(\w+)'/g)].map((x) => x[1]);
  assert.ok(Object.keys(machine).length >= 7, 'every shipment state was read');
  for (const kind of ['pickup', 'delivery']) {
    for (const [state, edges] of Object.entries(machine)) {
      for (const to of shipmentMoves(state, kind)) {
        assert.ok(edges.includes(to), `${kind} ${state} → ${to} is not a server edge`);
        assert.ok(!(state === 'awaiting_payment' && to === 'preparing'), 'paid through the fee order only');
        if (to === 'ready_for_pickup') assert.equal(kind, 'pickup');
        if (to === 'shipped') assert.equal(kind, 'delivery');
      }
    }
  }
  assert.deepEqual(shipmentMoves('preparing', 'pickup'), ['ready_for_pickup', 'cancelled']);
  assert.deepEqual(shipmentMoves('preparing', 'delivery'), ['shipped', 'cancelled']);
});

// ------------------------------------------------------------------ prices

test('PRICES: the tier preview prices every case exactly as the server', () => {
  const sets: TierRow[][] = [
    [
      { mode: 'pack', min_qty: 250, pack_price_iqd: 7000, unit_price_milli_iqd: null },
      { mode: 'pack', min_qty: 1000, pack_price_iqd: 22000, unit_price_milli_iqd: null },
      { mode: 'bracket', min_qty: 1, unit_price_milli_iqd: 30000, pack_price_iqd: null },
      { mode: 'bracket', min_qty: 500, unit_price_milli_iqd: 24500, pack_price_iqd: null },
    ],
    [{ mode: 'bracket', min_qty: 10, unit_price_milli_iqd: 1333, pack_price_iqd: null }],
    [{ mode: 'pack', min_qty: 20, pack_price_iqd: 5000, unit_price_milli_iqd: null }],
  ];
  const quantities = [1, 9, 10, 37, 100, 249, 250, 251, 499, 500, 777, 999, 1000, 1001, 5000];
  for (const tiers of sets) {
    for (const rounding of [0, 1, 250, 1000]) {
      for (const capAtNextPack of [true, false]) {
        for (const q of quantities) {
          const server = priceMaterial(q, tiers, { rounding, capAtNextPack });
          const preview = previewMaterialPrice(q, tiers, { rounding, capAtNextPack });
          const where = `${q} under ${JSON.stringify(tiers.map((t) => [t.mode, t.min_qty]))}, rounding ${rounding}, cap ${capAtNextPack}`;
          if (!server) {
            assert.equal(preview, null, `${where}: no price on either side`);
            continue;
          }
          assert.ok(preview, `${where}: the preview prices it too`);
          assert.equal(preview.price_iqd, server.price_iqd, `${where}: price`);
          assert.equal(preview.rule, server.rule.type, `${where}: rule`);
          assert.equal(preview.tier_qty, server.rule.type === 'pack' ? server.rule.pack_qty : server.rule.min_qty, `${where}: tier`);
          assert.equal(preview.capped_by_pack_qty, server.capped_by_pack_qty, `${where}: cap`);
        }
      }
    }
  }
});

// ------------------------------------------------------------------ words

/** Letters Arabic writes and Sorani does not. */
const ARABIC_ONLY = /[يكةى]/;
/** A phrase that is a symbol in every language (house convention: «د.ع» is the dinar in Arabic and Sorani). */
const SAME_EVERYWHERE = new Set(['د.ع', '°C']);

function checkTri(t: { ar: string; en: string; ckb: string }, where: string) {
  assert.ok(t.ar && t.en && t.ckb, `${where}: all three languages present`);
  if (!SAME_EVERYWHERE.has(t.ckb)) {
    assert.notEqual(t.ckb, t.ar, `${where}: the Sorani is the Arabic pasted across («${t.ckb}»)`);
  }
  assert.doesNotMatch(t.ckb, ARABIC_ONLY, `${where}: the Sorani carries an Arabic-only letter («${t.ckb}»)`);
}

test('WORDS: every table of the console in three languages, the Sorani real Sorani', () => {
  let n = 0;
  for (const [name, table] of Object.entries(I18N)) {
    if (!table || typeof table !== 'object' || Array.isArray(table)) continue;
    for (const [code, t] of Object.entries(table as Record<string, unknown>)) {
      if (!t || typeof t !== 'object' || !('ckb' in t)) continue;
      checkTri(t as { ar: string; en: string; ckb: string }, `${name}.${code}`);
      n++;
    }
  }
  assert.ok(n > 200, `the tables were read (${n} phrases)`);
});

test('WORDS: every tri(…) written in the console’s files is three languages and real Sorani', () => {
  // A phrase is a quoted string, or a template (format.ts `ago`: the figure inside every language).
  const str = "['`]((?:[^'`\\\\]|\\\\.)*)['`]";
  const re = new RegExp(`\\btri\\(\\s*${str},\\s*${str},\\s*${str}\\s*\\)`, 'g');
  let n = 0;
  for (const file of FILES) {
    const src = readFileSync(file, 'utf8');
    const calls = (src.match(/\btri\(/g) ?? []).length;
    let parsed = 0;
    for (const m of src.matchAll(re)) {
      checkTri({ ar: m[1], en: m[2], ckb: m[3] }, `${relative(ROOT, file)}: ${m[0].slice(0, 80)}`);
      parsed++;
    }
    assert.equal(parsed, calls, `${relative(ROOT, file)}: every tri( call was read (${parsed} of ${calls})`);
    n += parsed;
    assert.doesNotMatch(src, /\bloc\(\s*'[^']*'\s*,\s*'[^']*'\s*\)/, `${relative(ROOT, file)}: a two-language loc( — the Arabic would show in Sorani`);
    assert.doesNotMatch(src, /علاو/, `${relative(ROOT, file)}: the word «علاوة» is never used`);
    assert.doesNotMatch(src, /ليفونيس|لێڤۆنیس|ليفونس/, `${relative(ROOT, file)}: the brand is written «Levonis»`);
  }
  assert.ok(n > 600, `the console's phrases were read (${n})`);
});

test('WORDS: every server code a table names exists on the server, and every server code has its words', () => {
  const machine = TRANSITIONS as Readonly<Record<string, readonly string[]>>;
  const keys = (t: Readonly<Record<string, unknown>>) => Object.keys(t).sort();
  assert.deepEqual(keys(I18N.JOB_STATUS), Object.keys(machine).sort(), 'job states');
  assert.deepEqual(keys(I18N.TASK_KIND), [...TASK_KINDS].sort(), 'task kinds');
  assert.deepEqual(keys(I18N.ADAPTER), ADAPTERS.map((a) => a.name).sort(), 'adapters');
  const migration = source('migrations/0215_print_cloud.sql');
  const checkOf = (table: string, column: string): string[] => {
    const body = new RegExp(`CREATE TABLE IF NOT EXISTS ${table} \\(([\\s\\S]*?)\\n\\);`).exec(migration);
    assert.ok(body, `${table} is in the migration`);
    const m = new RegExp(`${column} TEXT NOT NULL[^,]*?CHECK \\(${column} IN \\(([^)]*)\\)\\)`).exec(body[1]);
    assert.ok(m, `${table}.${column} has a CHECK list`);
    return [...m[1].matchAll(/'(\w+)'/g)].map((x) => x[1]).sort();
  };
  assert.deepEqual(keys(I18N.ORDER_STATUS), checkOf('pc_orders', 'status'), 'order states');
  assert.deepEqual(keys(I18N.PROVIDER), checkOf('pc_orders', 'payment_method'), 'payment methods');
  assert.deepEqual(keys(I18N.SHIPMENT_STATUS), checkOf('pc_shipments', 'status'), 'shipment states');
  assert.deepEqual(keys(I18N.BUYBACK_STATUS), checkOf('pc_buyback_requests', 'status'), 'buyback states');
  assert.deepEqual(keys(I18N.PAYOUT_STATUS), checkOf('pc_buyback_requests', 'payout_status'), 'payout states');
  assert.deepEqual(keys(I18N.TASK_STATUS), checkOf('pc_background_jobs', 'status'), 'task states');
  assert.deepEqual(keys(I18N.PAYMENT_OUTCOME), [...checkOf('pc_payment_events', 'outcome'), 'duplicate_event'].sort(), 'payment outcomes, and the replay');
  const reconcile = source('worker/lib/printCloud/reconcile.ts');
  const checks = [...reconcile.matchAll(/check\(\s*(?:\/\/[^\n]*\n\s*)*'(\w+)'/g)].map((m) => m[1]).sort();
  assert.ok(checks.length >= 20, `the reconciliation checks were read (${checks.length})`);
  assert.deepEqual(keys(I18N.RECONCILE_CHECK), checks, 'reconciliation checks');
});

// ------------------------------------------------------------------ money doors

test('MONEY DOORS: an Idempotency-Key exactly where the server keys a door — never on the manual payment', () => {
  const keyed = OPERATIONS.filter((o) => o.base === 'admin' && o.idempotent).map((o) => o.path).sort();
  assert.deepEqual([...IDEMPOTENT_DOORS].sort(), keyed, 'the console knows the keyed doors');
  const minting = FILES.filter((f) => /newIdempotencyKey\(/.test(readFileSync(f, 'utf8'))).map((f) => relative(CONSOLE, f)).sort();
  assert.deepEqual(minting, ['sections/CustomersSection.tsx', 'sections/OrdersSection.tsx', 'sections/StockSection.tsx'], 'only the balance, refund and stock screens mint a key');
  const orders = readFileSync(join(CONSOLE, 'sections/OrdersSection.tsx'), 'utf8');
  const payment = /pc\.post<PaymentResult>\(`\/orders\/\$\{enc\(o\.id\)\}\/confirm-payment`, (\{[^}]*\})\)/.exec(orders);
  assert.ok(payment, 'the manual payment is posted with its body and nothing else');
  assert.doesNotMatch(payment[1], /method/, 'the manual payment door takes no method field');
  assert.match(orders, /pc\.post<RefundAnswer>\(`\/orders\/\$\{enc\(o\.id\)\}\/refunds`, planned\.body, planned\.key\)/, 'a refund carries the key of its plan');
  const customers = readFileSync(join(CONSOLE, 'sections/CustomersSection.tsx'), 'utf8');
  assert.match(customers, /\/adjust`,[\s\S]{0,400}?\n\s*key\n\s*\)/, 'a balance correction carries its key');
  const stock = readFileSync(join(CONSOLE, 'sections/StockSection.tsx'), 'utf8');
  assert.match(stock, /`\/stock\/\$\{kind\}`, body, keyFor\(body\)\)/, 'a stock movement carries the key of its body');
});

test('COST AND MONEY: the console reads its access hints fail-closed, and money sections are gated', () => {
  const access = readFileSync(join(CONSOLE, 'access.ts'), 'utf8');
  for (const hint of ['can_move_money', 'can_view_cost', 'can_write_cost', 'is_owner']) {
    assert.match(access, new RegExp(`user\\?\\.${hint} === true`), `${hint} compared with === true`);
  }
  const shell = readFileSync(join(CONSOLE, 'AdminPrintCloud.tsx'), 'utf8');
  for (const s of ['orders', 'customers', 'buybacks']) {
    assert.match(shell, new RegExp(`section === '${s}' && access\\.money && <`), `${s} renders only with money scope`);
  }
});
