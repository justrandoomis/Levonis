/**
 * LEAK AUDIT — client-bundles + JSON: any merchant / store owner receives the
 * FULL PRIVATE COST CHAIN behind the platform's OWN customer print quote.
 *
 * The owner's rule: anyone other than the main admin / super admin gets ONLY the
 * final price — no cost and no step of how the price was computed.
 *
 * The print calculator (/tools, the grams panel) answers a store owner with
 * `merchantQuote()` instead of `publicQuote()` (worker/routes/printQuote.ts, the
 * `/analyses/:id/quote` and `/grams-quote` doors). On those two doors the
 * merchant's own machine is NOT involved (`merchantPrinter: null`), so the
 * figures are the PLATFORM's: the machine hour is the owner's
 * `printPricingConfig.machine_hour_iqd` (a COST_SETTING_KEY), labour and
 * electricity are the platform constants, and the margin falls back to
 * `PLATFORM_TARGET_MARGIN_PERCENT` (35). The result is the very price an
 * anonymous customer is shown for the same file — plus every line behind it:
 * `lines` (DEPRECIATION `… h @ <owner rate>/h`, labour, energy, …),
 * `base_cost_iqd`, `failure_reserve_iqd`, `true_cost_iqd`, `profit_iqd`,
 * `margin_percent`, `markup_percent`, `break_even_iqd`.
 *
 * The browser types the reply as `PublicQuoteView` (src/lib/printQuote.ts) and
 * Tools.tsx renders only the price, so the private chain arrives in the JSON
 * and is hidden by the UI alone. /compare then states
 * `because.machine_iqd_per_hour` (the owner's rate) and CostingTab.tsx prints it.
 *
 * WHAT IS PRIVATE, FROM THE CODE ITSELF: a guest's quote on the same door is
 * persisted with its whole chain in `print_quotes` (merchant_id NULL) while the
 * guest is answered with the public shape — the row is the platform's own,
 * owner-only record of how the customer's price was built. The test reads that
 * row as the reference and looks for it in what the merchant gets.
 *
 * LOCAL ONLY: an in-memory SQLite database with every migration, the real route
 * modules, the stub session and in-memory R2 of tests/fixtures/app.ts. No network.
 *
 * Run: node --import tsx --test tests/leakAudit_client-bundles_merchant_gets_platform_print_cost_chain.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { MemoryBucket, asD1, freshDb, json, post, row, stubApp, type App, type Mount, type StubUser } from './fixtures/app';
import { leaks } from './fixtures/costlyProduct';
import { PLATFORM_TARGET_MARGIN_PERCENT, merchantQuote as merchantQuoteShape, printQuoteRoutes } from '../worker/routes/printQuote';
import { DEFAULT_PRICING } from '../worker/lib/printPricing';

// ------------------------------------------------------------- the sentinels

/** printPricingConfig.machine_hour_iqd.fdm — the owner's private machine-hour rate. */
const PLATFORM_HOUR_FDM = 3_917;
/** printPricingConfig.machine_hour_iqd.resin — set too, so neither is the code default. */
const PLATFORM_HOUR_RESIN = 5_821;
const RATE_TEXT = ['3,917', '3917', '5,821', '5821'];

/** The keys of the platform's private chain, as `print_quotes` stores them. */
const CHAIN_KEYS = [
  'base_cost_iqd',
  'failure_reserve_iqd',
  'true_cost_iqd',
  'profit_iqd',
  'margin_percent',
  'markup_percent',
  'break_even_iqd',
] as const;
/** Everything `merchantQuote()` adds over `publicQuote()`. */
const PRIVATE_KEYS = ['lines', ...CHAIN_KEYS] as const;

// ------------------------------------------------------------------- actors

const MERCHANT: StubUser = { id: 'u-shop', role: 'merchant', email: 'shop@x.co' };
const GUEST_TOKEN = 'guest-token-audit-0123456789abcdef';

/** The owner set his machine-hour rate; a merchant opened a store and declared NO economics of their own. */
function shop(): DatabaseSync {
  const raw = freshDb();
  raw
    .prepare(
      `INSERT INTO admin_settings (key, value) VALUES ('printPricingConfig', ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value`
    )
    .run(JSON.stringify({ ...DEFAULT_PRICING, machine_hour_iqd: { fdm: PLATFORM_HOUR_FDM, resin: PLATFORM_HOUR_RESIN } }));
  raw.prepare(`INSERT INTO users (id, email, name, password_hash, role) VALUES (?, ?, 'Shop', 'x', 'merchant')`).run(MERCHANT.id, MERCHANT.email);
  raw.prepare(`INSERT INTO community_merchants (id, user_id, name, status) VALUES ('m-shop', ?, 'Shop', 'approved')`).run(MERCHANT.id);
  raw
    .prepare(`INSERT INTO merchant_stores (id, merchant_id, user_id, slug, name) VALUES ('st-shop', 'm-shop', ?, 'shop-audit', 'Shop')`)
    .run(MERCHANT.id);
  return raw;
}

const mount: Mount = (a) => {
  a.route('/api/print-quote', printQuoteRoutes);
};
const as = (raw: DatabaseSync, user: StubUser | null, bucket: MemoryBucket) =>
  stubApp(asD1(raw), user, mount, { env: { BUCKET: bucket, R2_PRIVATE: bucket, R2_PUBLIC: bucket } });

/** A real binary STL of a 20 mm cube, wound outward. */
function stlBytes(): Uint8Array {
  const S = 20;
  const v: Array<[number, number, number]> = [
    [0, 0, 0], [S, 0, 0], [S, S, 0], [0, S, 0],
    [0, 0, S], [S, 0, S], [S, S, S], [0, S, S],
  ];
  const tris: Array<[number, number, number]> = [
    [0, 2, 1], [0, 3, 2], [4, 5, 6], [4, 6, 7],
    [0, 1, 5], [0, 5, 4], [1, 2, 6], [1, 6, 5],
    [2, 3, 7], [2, 7, 6], [3, 0, 4], [3, 4, 7],
  ];
  const buf = new ArrayBuffer(84 + tris.length * 50);
  const dv = new DataView(buf);
  dv.setUint32(80, tris.length, true);
  let o = 84;
  for (const [a, b, c] of tris) {
    o += 12;
    for (const i of [a, b, c]) {
      dv.setFloat32(o, v[i][0], true);
      dv.setFloat32(o + 4, v[i][1], true);
      dv.setFloat32(o + 8, v[i][2], true);
      o += 12;
    }
    o += 2;
  }
  return new Uint8Array(buf);
}

/** The same file, measured the same way, for whoever asks (a guest passes its token). */
async function analyse(a: App, guest: boolean): Promise<string> {
  const headers: Record<string, string> = guest ? { 'X-Guest-Token': GUEST_TOKEN } : {};
  const form = new FormData();
  form.append('file', new File([stlBytes() as unknown as BlobPart], 'bracket.stl', { type: 'application/octet-stream' }));
  if (guest) form.append('guest_token', GUEST_TOKEN);
  const up = await json(await a.request('/api/print-quote/uploads', { method: 'POST', body: form, headers: { 'CF-Connecting-IP': '1.2.3.4' } }));
  assert.equal(up.success, true, JSON.stringify(up));
  const id = up.analysis_id as string;
  const analysed = await json(
    await post(
      a,
      `/api/print-quote/analyses/${id}`,
      {
        printer_model_id: 'bbl-a1m',
        stats: { filament_mm: 60_000, time_estimate: 14_400, layers: 200, model_layers: 200, raft_layers: 0 },
        tools: [{ slot: 0, material_id: 'pla', color_hex: '#000000' }],
        bounding_box_mm: { x: 100, y: 80, z: 40 },
        model_volume_mm3: 96_000,
        layer_height_mm: 0.2,
        preparation_minutes: 8,
        slicer_version: 'three-slicer@0.2.2',
        profile_revision: 'bbl-a1m-04-r1',
      },
      headers
    )
  );
  assert.equal(analysed.success, true, JSON.stringify(analysed));
  return id;
}

/** POST /analyses/:id/quote — exactly what Tools.tsx `quoteAnalysis()` sends (an empty body). */
async function quote(a: App, id: string, guest: boolean) {
  const res = await post(a, `/api/print-quote/analyses/${id}/quote`, {}, guest ? { 'X-Guest-Token': GUEST_TOKEN } : {});
  const body = await json(res);
  assert.equal(res.status, 200, JSON.stringify(body));
  assert.equal(body.success, true, JSON.stringify(body));
  return body;
}

/** The platform's own record of how the guest's price was built — never served to a non-owner. */
function platformChain(raw: DatabaseSync, quoteId: string): Record<string, number> {
  const r = row<Record<string, unknown>>(
    raw,
    `SELECT merchant_id, price_iqd, ${CHAIN_KEYS.join(', ')} FROM print_quotes WHERE id = ?`,
    quoteId
  );
  assert.ok(r, `the guest quote ${quoteId} was not persisted`);
  assert.equal(r.merchant_id, null, 'the reference row must be the platform quote, not a merchant one');
  return Object.fromEntries(['price_iqd', ...CHAIN_KEYS].map((k) => [k, Number(r[k])]));
}

/**
 * Every place the platform's private chain, or the owner's machine-hour rate,
 * reaches a payload:
 *   - any key of the private chain (`lines`, `true_cost_iqd`, …) at any depth;
 *   - any number equal to a value of the platform's private chain (not the final price);
 *   - the owner's machine-hour rate as a number or spelled in a line's text
 *     (`… h @ 3,917/h`), or `because.machine_iqd_per_hour`;
 *   - the platform's target margin stated outright.
 */
function chainLeaks(body: unknown, chain: Record<string, number> | null): string[] {
  const out: string[] = [];
  const finals = new Set<number>();
  const privateValues = new Map<number, string>();
  if (chain) {
    finals.add(chain.price_iqd);
    for (const k of CHAIN_KEYS) {
      const v = chain[k];
      if (Number.isFinite(v) && Math.abs(v) >= 10 && !finals.has(v) && !privateValues.has(v)) privateValues.set(v, k);
    }
  }
  const walk = (v: unknown, path: string) => {
    if (Array.isArray(v)) return v.forEach((x, i) => walk(x, `${path}[${i}]`));
    if (v && typeof v === 'object') {
      for (const [k, x] of Object.entries(v as Record<string, unknown>)) {
        if ((PRIVATE_KEYS as readonly string[]).includes(k) && x !== undefined && x !== null) {
          const same = typeof x === 'number' && chain && chain[k] === x ? ' (= the platform’s private value for the guest’s quote)' : '';
          out.push(`${path}.${k} = ${JSON.stringify(x).slice(0, 70)}${same}`);
        }
        if (k === 'machine_iqd_per_hour' && x === PLATFORM_HOUR_FDM) {
          out.push(`${path}.${k} = ${x} (the owner’s printPricingConfig.machine_hour_iqd.fdm)`);
          continue;
        }
        // A private scalar already reported by its key is not reported again by its value.
        if ((PRIVATE_KEYS as readonly string[]).includes(k) && typeof x !== 'object') continue;
        walk(x, `${path}.${k}`);
      }
      return;
    }
    if (typeof v === 'number') {
      if (v === PLATFORM_HOUR_FDM || v === PLATFORM_HOUR_RESIN) out.push(`${path} = ${v} (owner machine-hour rate)`);
      else if (privateValues.has(v)) out.push(`${path} = ${v} (= platform ${privateValues.get(v)})`);
    } else if (typeof v === 'string') {
      for (const t of RATE_TEXT) if (new RegExp(`(^|[^\\d,])${t}([^\\d,]|$)`).test(v)) out.push(`${path} ⊃ "${t}" (owner machine-hour rate, «${v.slice(0, 60)}»)`);
    }
  };
  walk(body, '$');
  return [...new Set(out)];
}

function report(door: string, body: Record<string, unknown>, found: string[]): string {
  const generic = leaks(body).slice(0, 6);
  return (
    `${door}: a MERCHANT (store owner, not the owner) receives the platform’s private print cost chain — ` +
    found.slice(0, 14).join('; ') +
    (found.length > 14 ? `; … (+${found.length - 14})` : '') +
    (generic.length ? ` | the shared leak scanner flags only: ${generic.join('; ')}` : '')
  );
}

const GRAMS_BODY = { printer_model_id: 'bbl-a1m', rows: [{ material_id: 'pla', grams: 100 }], print_minutes: 120 };

// ----------------------------------------------------------------- control

test('control: a guest’s quote of the file is the public shape; the platform keeps its whole cost chain to itself', async () => {
  const raw = shop();
  const bucket = new MemoryBucket();
  const guest = as(raw, null, bucket);
  const body = await quote(guest, await analyse(guest, true), true);
  assert.ok(Number(body.quote?.price_iqd) > 0, 'no final price');
  for (const k of PRIVATE_KEYS) assert.equal(body.quote[k], undefined, `the public shape carries ${k}`);
  const chain = platformChain(raw, body.quote_id);
  assert.equal(chain.price_iqd, body.quote.price_iqd, 'the persisted row is the guest’s quote');
  assert.ok(chain.true_cost_iqd > 0 && chain.break_even_iqd > 0, `the platform chain was not computed: ${JSON.stringify(chain)}`);
  assert.deepEqual(chainLeaks(body, chain), [], 'the guest receives none of the private chain');
});

// ------------------------------------------- door 1: Tools «quoteAnalysis»

test('merchant POST /api/print-quote/analyses/:id/quote (Tools page) carries none of the platform’s private cost chain', async () => {
  const raw = shop();
  const bucket = new MemoryBucket();

  // The reference: what the platform charges a guest for this file, and the chain behind it.
  const guest = as(raw, null, bucket);
  const guestBody = await quote(guest, await analyse(guest, true), true);
  const chain = platformChain(raw, guestBody.quote_id);

  // The same file, measured the same way, priced for a store owner with NO economics of their own.
  const merchant = as(raw, MERCHANT, bucket);
  const body = await quote(merchant, await analyse(merchant, false), false);

  // Prove this exercises the path: the store owner's call priced the same
  // file, at the PLATFORM's price (the door answers everyone the public
  // estimate since DECISIONS row 220).
  assert.ok(Number(body.quote?.price_iqd) > 0, `the door did not price the file: ${JSON.stringify(body.quote)}`);
  assert.equal(
    body.quote.price_iqd,
    guestBody.quote.price_iqd,
    'the merchant door priced different economics — then this is not the platform’s customer quote'
  );

  const found = chainLeaks(body, chain);
  assert.deepEqual(found, [], report('POST /api/print-quote/analyses/:id/quote', body, found));
});

// ------------------------------------------- door 2: the grams panel

test('merchant POST /api/print-quote/grams-quote carries none of the platform’s private cost chain behind the public price', async () => {
  const raw = shop();
  const bucket = new MemoryBucket();
  const anon = await json(await post(as(raw, null, bucket), '/api/print-quote/grams-quote', GRAMS_BODY));
  assert.equal(anon.success, true, JSON.stringify(anon));
  assert.equal(anon.quote.lines, undefined, 'control: the anonymous grams quote is the public shape');

  const body = await json(await post(as(raw, MERCHANT, bucket), '/api/print-quote/grams-quote', GRAMS_BODY));
  assert.equal(body.success, true, JSON.stringify(body));
  assert.ok(Number(body.quote?.price_iqd) > 0, `the door did not price the job: ${JSON.stringify(body.quote)}`);
  assert.equal(body.quote.price_iqd, anon.quote.price_iqd, 'the merchant grams quote is the same public price');

  const found = chainLeaks(body, null);
  // The platform's target margin, stated or derivable as price ↔ true cost.
  const q = body.quote as Record<string, number>;
  if (q.true_cost_iqd > 0 && q.price_iqd > 0) {
    const derived = ((q.price_iqd - q.true_cost_iqd) / q.price_iqd) * 100;
    if (Math.abs(derived - PLATFORM_TARGET_MARGIN_PERCENT) <= 1.5) {
      found.push(`(price_iqd − true_cost_iqd) / price_iqd = ${derived.toFixed(2)} % ≈ the platform target margin ${PLATFORM_TARGET_MARGIN_PERCENT} %`);
    }
  }
  assert.deepEqual(found, [], report('POST /api/print-quote/grams-quote', body, found));
});

// ------------------------------------------- door 3: CostingTab «compare»

test('merchant POST /api/print-quote/analyses/:id/compare (CostingTab) does not state the owner’s machine-hour rate', async () => {
  const raw = shop();
  const bucket = new MemoryBucket();
  const merchant = as(raw, MERCHANT, bucket);
  const id = await analyse(merchant, false);
  raw
    .prepare(
      `INSERT INTO merchant_printers (id, merchant_id, name, technology, brand, model,
         build_x_mm, build_y_mm, build_z_mm, nozzle_mm, materials, model_id)
       VALUES ('mp-mini','m-shop','My A1 mini','fdm','Bambu','A1 mini',180,180,180,0.4,'["PLA"]','bbl-a1m')`
    )
    .run();
  // What CostingTab.tsx sends (its margin field defaults to 35).
  const body = await json(await post(merchant, `/api/print-quote/analyses/${id}/compare`, { target_margin_percent: 35 }));
  assert.equal(body.success, true, JSON.stringify(body));
  const mini = (body.printers as Array<Record<string, unknown>>).find((p) => p.merchant_printer_id === 'mp-mini');
  assert.ok(mini && mini.eligible === true, `the merchant's printer was not priced: ${JSON.stringify(body.printers)}`);
  const found = chainLeaks(body, null).filter((f) => /machine-hour|machine_iqd_per_hour/.test(f));
  assert.deepEqual(found, [], report('POST /api/print-quote/analyses/:id/compare', body, found));
});

// ------------------------------------------- the client bundle only hides it

test('client bundle: what /analyses/:id/quote delivers to a merchant on /tools is no more than PublicQuoteView declares', async () => {
  const src = readFileSync(join(import.meta.dirname, '..', 'src', 'lib', 'printQuote.ts'), 'utf8');
  const decl = /export interface PublicQuoteView \{([\s\S]*?)\n\}/.exec(src);
  assert.ok(decl, 'PublicQuoteView not found in src/lib/printQuote.ts');
  const declared = new Set([...decl[1].matchAll(/^\s+([a-z_]+)\??:/gm)].map((m) => m[1]));
  const tools = readFileSync(join(import.meta.dirname, '..', 'src', 'pages', 'Tools.tsx'), 'utf8');
  assert.match(tools, /useState<PublicQuoteView \| null>/, 'Tools.tsx no longer types the reply as PublicQuoteView');

  const raw = shop();
  const bucket = new MemoryBucket();
  const merchant = as(raw, MERCHANT, bucket);
  const body = await quote(merchant, await analyse(merchant, false), false);
  const undeclared = Object.keys(body.quote).filter((k) => !declared.has(k));
  assert.deepEqual(
    undeclared,
    [],
    `Tools.tsx types the merchant's reply as PublicQuoteView {${[...declared].join(', ')}} and renders only the price, ` +
      `but the JSON carries ${undeclared.map((k) => `${k}=${JSON.stringify(body.quote[k]).slice(0, 40)}`).join(', ')} — hidden by the UI only`
  );
});

// --------------------------------------------------------------- guard gap

test('guard gap: the shared leak scanner flags every field of the merchant print-quote chain', () => {
  const sample = {
    ...merchantQuoteShape({
      confidence: 'exact',
      lines: [{ component: 'DEPRECIATION', iqd: 1_111, from: 'platform', detail: '1.00 h @ 3,917/h' }],
      baseCostIqd: 2_222,
      failureReserveIqd: 3_333,
      trueExpectedCostIqd: 4_444,
      recommendedPriceIqd: 6_837,
      profitIqd: 2_393,
      marginPercent: 35,
      markupPercent: 53.85,
      breakEvenIqd: 4_444,
      rangeIqd: { low: 6_000, high: 7_000 },
      wasteGrams: 1,
      wastePercent: 1,
      machineHours: 1,
      engineVersion: 1,
    } as unknown as Parameters<typeof merchantQuoteShape>[0]),
    because: { machine_iqd_per_hour: PLATFORM_HOUR_FDM },
  } as Record<string, unknown>;
  const flagged = leaks(sample).join('\n');
  const missed = ['failure_reserve_iqd', 'markup_percent', 'break_even_iqd', 'machine_iqd_per_hour', 'lines'].filter(
    (k) => !new RegExp(`\\.${k}\\b`).test(flagged)
  );
  assert.deepEqual(
    missed,
    [],
    `tests/fixtures/costlyProduct.ts leaks() (FINANCIAL_FIELDS + /cost/ keys) does not know ${missed.join(', ')}: ` +
      'a sweep that did reach merchantQuote() would pass these private figures'
  );
});
