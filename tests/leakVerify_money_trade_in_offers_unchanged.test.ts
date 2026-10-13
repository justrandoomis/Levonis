/**
 * LEAK VERIFY (money) — GUARD: the trade-in figures a customer is offered are
 * the same dinar on 10c6541a and on HEAD (DECISIONS row 220 moved the
 * valuation off the phone: rules → server, `publicEstimate`).
 *
 * For the same unit, answers and target, the saved estimate's per-part value,
 * total and settlement must equal the figures 10c6541a saved (embedded below,
 * produced by this file on the base worktree). The seed is the one of
 * tests/leakVerify_features_trade_in_preview_matches_saved_figure.test.ts.
 *
 * LOCAL ONLY: in-memory SQLite, the real trade-in routes, a stub session.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { DatabaseSync } from 'node:sqlite';
import { asD1, freshDb, stubApp, post, json, send, type StubUser } from './fixtures/app';
import { tradeInRoutes } from '../worker/routes/tradeIn';
import { blankInputs } from '../packages/pricing/src/tradeIn';

const CUSTOMER: StubUser = { id: 'cust', role: 'customer', email: 'sara@x.co' };
const DELIVERED = '2025-09-26T00:00:00.000Z';

function seed(): DatabaseSync {
  const raw = freshDb();
  raw.exec(`
    INSERT INTO users (id,name,email,password_hash,role,email_verified_at,locale) VALUES
      ('cust','سارة','sara@x.co','h','customer','2026-01-01T00:00:00.000Z','ar');
    INSERT INTO products (id,slug,name,name_ar,price_iqd,status,stock,options,colors,selling_type,sale_types,images,category_id,sub_category_id) VALUES
      ('p_a1','a1','Bambu Lab A1','بامبو A1',850000,'active',10,'[]','[]','direct_sale','["direct_sale"]','[]','cat_printers','cat_printers_fdm'),
      ('p_p1s','p1s','Bambu Lab P1S','بامبو P1S',1500000,'active',5,'[]','[]','direct_sale','["direct_sale"]','[]','cat_printers','cat_printers_fdm'),
      ('p_resin','saturn','Elegoo Saturn 4','إليغو ساتورن 4',600000,'active',3,'[]','[]','direct_sale','["direct_sale"]','[]','cat_printers','cat_printers_resin');
    INSERT INTO product_option_groups (id, product_id, name_en, sort, active) VALUES ('g_a1','p_a1','Model',0,1);
    INSERT INTO product_option_values (id, product_id, group_id, name_en, name_ar, sort, active, regular_price_iqd, variant_key) VALUES
      ('v_a1','p_a1','g_a1','A1','A1',0,1,850000,'a1'),
      ('v_a1c','p_a1','g_a1','A1 Combo','A1 كومبو',1,1,1150000,'a1-combo');
    INSERT INTO orders (id,user_id,status,stage,address_snapshot,delivery_method_id,delivery_method_snapshot,payment_method_id,
                        subtotal_iqd,shipping_iqd,exchange_rate,total_iqd,due_on_delivery_iqd,created_at,updated_at,delivered_at) VALUES
      ('ORD-DLV','cust','delivered','delivered','{}','standard','{}','cash',1700000,0,1400,1700000,0,'2025-09-20T00:00:00.000Z','${DELIVERED}','${DELIVERED}');
    INSERT INTO order_items (id,order_id,product_id,name_snapshot,image_snapshot,option_snapshot,qty,unit_price_iqd,line_total_iqd,option_id,option_value_ids) VALUES
      ('oi_combo','ORD-DLV','p_a1','Bambu Lab A1','','A1 Combo',1,1100000,1100000,'v_a1c','["v_a1c"]'),
      ('oi_resin','ORD-DLV','p_resin','Elegoo Saturn 4','','',1,600000,600000,'','[]');
    INSERT INTO order_item_units (id,order_id,order_item_id,product_id,owner_user_id,unit_index,delivered_at,warranty_base_months,warranty_ext_months,warranty_start_at,warranty_end_at,policy_version)
      VALUES ('unit_combo','ORD-DLV','oi_combo','p_a1','cust',1,'${DELIVERED}',24,0,'${DELIVERED}','2027-09-26T00:00:00.000Z','{}');
  `);
  return raw;
}
const appOf = (raw: DatabaseSync) => stubApp(asD1(raw), CUSTOMER, (a) => a.route('/api/trade-in', tradeInRoutes));

type Comp = { role: string; family: 'fdm' | 'ams' | 'resin'; value_iqd?: number; valuation?: { value_iqd: number } };
type Est = { total_iqd: number; components: Comp[]; settlement: Record<string, unknown> | null };
const figures = (e: Est) => ({
  total: e.total_iqd,
  parts: e.components.map((c) => [c.role, c.value_iqd ?? c.valuation?.value_iqd ?? null]),
  settlement: e.settlement,
});

async function fingerprint() {
  const out: Record<string, unknown> = {};
  const cases = [
    ['resin-blank', 'oi_resin', {}, null],
    ['resin-worn', 'oi_resin', { device: { exterior: 2, scratches: 3, repairs_count: 1, original_accessories: 'partial' } }, null],
    ['resin-worn-p1s', 'oi_resin', { device: { exterior: 2, scratches: 3, repairs_count: 1, original_accessories: 'partial' } }, { product_id: 'p_p1s', option_value_ids: [], color_id: null }],
    ['combo', 'oi_combo', { device: { hours: 900, cleanliness: 3 }, ams: { exterior: 1, original_accessories: 'none' } }, null],
    ['combo-p1s', 'oi_combo', { device: { hours: 2400, cleanliness: 1, faults: ['nozzle_clog'] }, ams: { exterior: 1 } }, { product_id: 'p_p1s', option_value_ids: [], color_id: null }],
  ] as const;
  for (const [label, item, over, target] of cases) {
    const raw = seed();
    const a = appOf(raw);
    const opened = await json(await post(a, '/api/trade-in/requests', { order_item_id: item, unit_index: 1, scope: 'whole' }));
    const req = opened.request as { id: string; components: Comp[] };
    assert.ok(req?.id, JSON.stringify(opened));
    const components = Object.fromEntries(
      req.components.map((c) => [c.role, { ...blankInputs(c.family), ...((over as Record<string, Record<string, unknown>>)[c.role] ?? {}) }])
    );
    let saved = (await json(await send(a, 'PATCH', `/api/trade-in/requests/${req.id}`, { components }))).request;
    if (target) saved = (await json(await send(a, 'PATCH', `/api/trade-in/requests/${req.id}`, { target }))).request;
    out[label] = { estimate: figures(saved.estimate as Est), estimated_iqd: saved.estimated_iqd };
    raw.close();
  }
  return out;
}

/** Produced on the base worktree (10c6541a) by `fingerprint()` above. */
const BASE_FIGURES: Record<string, unknown> | null = {
  "resin-blank": {
    "estimate": {
      "total": 336000,
      "parts": [
        [
          "device",
          336000
        ]
      ],
      "settlement": null
    },
    "estimated_iqd": 336000
  },
  "resin-worn": {
    "estimate": {
      "total": 255000,
      "parts": [
        [
          "device",
          255000
        ]
      ],
      "settlement": null
    },
    "estimated_iqd": 255000
  },
  "resin-worn-p1s": {
    "estimate": {
      "total": 255000,
      "parts": [
        [
          "device",
          255000
        ]
      ],
      "settlement": {
        "target_price_iqd": 1500000,
        "trade_in_value_iqd": 255000,
        "credit_iqd": 255000,
        "difference_iqd": 1245000,
        "excess_iqd": 0
      }
    },
    "estimated_iqd": 255000
  },
  "combo": {
    "estimate": {
      "total": 762000,
      "parts": [
        [
          "device",
          574000
        ],
        [
          "ams",
          188000
        ]
      ],
      "settlement": null
    },
    "estimated_iqd": 762000
  },
  "combo-p1s": {
    "estimate": {
      "total": 653000,
      "parts": [
        [
          "device",
          448000
        ],
        [
          "ams",
          205000
        ]
      ],
      "settlement": {
        "target_price_iqd": 1500000,
        "trade_in_value_iqd": 653000,
        "credit_iqd": 653000,
        "difference_iqd": 847000,
        "excess_iqd": 0
      }
    },
    "estimated_iqd": 653000
  }
};

test('trade-in offers for the same unit, answers and target: HEAD saves the base figures', async () => {
  const now = await fingerprint();
  console.log(`FINGERPRINT ${JSON.stringify(now)}`);
  if (BASE_FIGURES) assert.deepEqual(now, BASE_FIGURES);
});
