/**
 * LEAK VERIFY (money) — GUARD: every print amount a guest or a customer reads
 * is the same figure on 10c6541a and on HEAD (DECISIONS row 220).
 *
 * The figures below were produced by this file on the base worktree
 * (10c6541a); HEAD must answer the same dinar for the same inputs. Inputs
 * cover the three customer print doors — the grams calculator, the file
 * calculator and the request wizard's engine (/api/marketplace/print/quote) —
 * with and without a basket of platform hardware, with the print-service
 * setting (now owner-only) present, for a guest and for a customer.
 *
 * LOCAL ONLY: in-memory SQLite with every migration, the real routers, a stub
 * session. No network.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Hono } from 'hono';
import { asD1, freshDb, json, post, stubApp } from './fixtures/app';
import type { AppContext } from '../worker/lib/types';
import { analyseModel } from '../worker/lib/modelGeometry';
import { printRequestRoutes } from '../worker/routes/printRequests';
import { printQuoteRoutes } from '../worker/routes/printQuote';

const mount = (a: Hono<AppContext>) => {
  a.route('/api/print-quote', printQuoteRoutes);
  a.route('/api/marketplace/print', printRequestRoutes);
};
const CUSTOMER = { id: 'u-cust', role: 'customer' as const, email: 'cust@levonis.test' };

function boxStl(sx: number, sy: number, sz: number): Uint8Array {
  const v = [[0, 0, 0], [sx, 0, 0], [sx, sy, 0], [0, sy, 0], [0, 0, sz], [sx, 0, sz], [sx, sy, sz], [0, sy, sz]];
  const tris = [[0, 2, 1], [0, 3, 2], [4, 5, 6], [4, 6, 7], [0, 1, 5], [0, 5, 4], [1, 2, 6], [1, 6, 5], [2, 3, 7], [2, 7, 6], [3, 0, 4], [3, 4, 7]];
  const buf = new ArrayBuffer(84 + tris.length * 50);
  const dv = new DataView(buf);
  dv.setUint32(80, tris.length, true);
  let o = 84;
  for (const t of tris) {
    o += 12;
    for (const i of t) {
      dv.setFloat32(o, v[i][0], true);
      dv.setFloat32(o + 4, v[i][1], true);
      dv.setFloat32(o + 8, v[i][2], true);
      o += 12;
    }
    o += 2;
  }
  return new Uint8Array(buf);
}

function world() {
  const raw = freshDb();
  raw.prepare(`INSERT INTO users (id, email, name, password_hash, role) VALUES ('u-cust','cust@levonis.test','C','x','customer')`).run();
  raw.prepare(`UPDATE print_materials SET default_iqd_per_kg = 22000 WHERE id = 'pla'`).run();
  raw.prepare('INSERT OR REPLACE INTO admin_settings (key,value) VALUES (?,?)').run(
    'printServicePricing',
    JSON.stringify({ machine_iqd_per_hour: 2500, setup_fee_iqd: 1500, margin_percent: 31.25 })
  );
  raw.prepare('INSERT OR REPLACE INTO admin_settings (key,value) VALUES (?,?)').run(
    'printAccessories',
    JSON.stringify([
      { id: 'mv-magnet', name_ar: 'مغناطيس', name_en: 'Magnet', name_ckb: 'ماگنێت', unit: 'piece', category: 'magnet', active: true, cost_iqd: 1750 },
      { id: 'mv-insert', name_ar: 'صامولة', name_en: 'Heat insert', name_ckb: 'مووتە', unit: 'piece', category: 'insert', active: true, cost_iqd: 333 },
    ])
  );
  raw.exec("INSERT INTO print_analyses (id,owner_id,file_sha256,fingerprint,printer_model_id,print_minutes_per_plate) VALUES ('pa-c','u-cust','sha-c','fp-c','bbl-a1m',95)");
  raw.exec("INSERT INTO print_analysis_materials (id,analysis_id,material_id,material_type,model_grams) VALUES ('pam-c','pa-c','pla','PLA',137)");
  return raw;
}

const HW = [{ id: 'mv-magnet', qty: 4 }, { id: 'mv-insert', qty: 3 }];

async function fingerprint() {
  const raw = world();
  const out: Record<string, unknown> = {};
  for (const [who, user] of [['guest', null], ['customer', CUSTOMER]] as const) {
    const app = stubApp(asD1(raw), user, mount);
    for (const [name, body] of [
      ['g100', { printer_model_id: 'bbl-a1m', rows: [{ material_id: 'pla', grams: 100 }], print_minutes: 60 }],
      ['g100hw', { printer_model_id: 'bbl-a1m', rows: [{ material_id: 'pla', grams: 100 }], print_minutes: 60, accessories: HW }],
      ['g2rows', { printer_model_id: 'bbl-a1m', rows: [{ material_id: 'pla', grams: 412.5 }, { material_id: 'pla', grams: 18 }], print_minutes: 777 }],
      ['g_margin', { printer_model_id: 'bbl-a1m', rows: [{ material_id: 'pla', grams: 100 }], print_minutes: 60, target_margin_percent: 1 }],
    ] as const) {
      const r = await json(await post(app, '/api/print-quote/grams-quote', body));
      out[`${who}:grams:${name}`] = r.success ? [r.quote.price_iqd, r.quote.range_iqd ?? null, r.quote.confidence ?? null] : r;
    }
  }
  const cust = stubApp(asD1(raw), CUSTOMER, mount);
  for (const [name, body] of [['plain', {}], ['hw', { accessories: HW }], ['margin', { target_margin_percent: 2 }]] as const) {
    const r = await json(await post(cust, '/api/print-quote/analyses/pa-c/quote', body));
    out[`customer:file:${name}`] = r.success ? [r.quote.price_iqd, r.quote.range_iqd ?? null, r.estimate?.price_iqd ?? null, r.estimate?.range_iqd ?? null] : r;
  }
  const analysis = analyseModel(boxStl(40, 30, 25), 'part.stl');
  for (const qty of [1, 3, 10]) {
    for (const [name, extra] of [['plain', {}], ['hw', { accessories: HW }]] as const) {
      const r = await json(
        await post(cust, '/api/marketplace/print/quote', { process: 'fdm', material_id: 'pla', quality: 'standard', quantity: qty, analysis, ...extra })
      );
      out[`customer:wizard:q${qty}:${name}`] = r.success
        ? [r.quote?.price_iqd ?? null, r.quote?.unit_price_iqd ?? null, r.quote?.total_iqd ?? null, r.estimate?.price_iqd ?? null, r.estimate?.range_iqd ?? null]
        : r;
    }
  }
  raw.close();
  return out;
}

/** Produced on the base worktree (10c6541a) by `fingerprint()` above. */
const BASE_FIGURES: Record<string, unknown> | null = {
  "guest:grams:g100": [
    7331,
    {
      "low": 6451,
      "high": 8211
    },
    "estimated"
  ],
  "guest:grams:g100hw": [
    19637,
    {
      "low": 17281,
      "high": 21993
    },
    "estimated"
  ],
  "guest:grams:g2rows": [
    42242,
    {
      "low": 37173,
      "high": 47311
    },
    "estimated"
  ],
  "guest:grams:g_margin": [
    7331,
    {
      "low": 6451,
      "high": 8211
    },
    "estimated"
  ],
  "customer:grams:g100": [
    7331,
    {
      "low": 6451,
      "high": 8211
    },
    "estimated"
  ],
  "customer:grams:g100hw": [
    19637,
    {
      "low": 17281,
      "high": 21993
    },
    "estimated"
  ],
  "customer:grams:g2rows": [
    42242,
    {
      "low": 37173,
      "high": 47311
    },
    "estimated"
  ],
  "customer:grams:g_margin": [
    7331,
    {
      "low": 6451,
      "high": 8211
    },
    "estimated"
  ],
  "customer:file:plain": [
    9648,
    {
      "low": 8490,
      "high": 10806
    },
    9648,
    null
  ],
  "customer:file:hw": [
    21954,
    {
      "low": 19320,
      "high": 24588
    },
    21954,
    null
  ],
  "customer:file:margin": [
    9648,
    {
      "low": 8490,
      "high": 10806
    },
    9648,
    null
  ],
  "customer:wizard:q1:plain": [
    4500,
    4500,
    null,
    4500,
    null
  ],
  "customer:wizard:q1:hw": [
    16750,
    16750,
    null,
    16750,
    null
  ],
  "customer:wizard:q3:plain": [
    8750,
    2917,
    null,
    8750,
    null
  ],
  "customer:wizard:q3:hw": [
    42000,
    14000,
    null,
    42000,
    null
  ],
  "customer:wizard:q10:plain": [
    23000,
    2300,
    null,
    23000,
    null
  ],
  "customer:wizard:q10:hw": [
    121750,
    12175,
    null,
    121750,
    null
  ]
};

test('guest and customer print amounts: HEAD answers the base figures to the dinar', async () => {
  const now = await fingerprint();
  console.log(`FINGERPRINT ${JSON.stringify(now)}`);
  if (BASE_FIGURES) assert.deepEqual(now, BASE_FIGURES);
});
