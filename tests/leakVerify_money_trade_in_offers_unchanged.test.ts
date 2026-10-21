/**
 * LEAK VERIFY (money) — GUARD: the trade-in figures a customer is offered are
 * the same dinar on 10c6541a and on HEAD (DECISIONS row 220 moved the
 * valuation off the phone: rules → server, `publicEstimate`). Re-baselined by
 * Services S-P2 (row 238): the store-safe offer, never above the old figures.
 *
 * For the same unit, answers and target, the saved estimate's per-part value,
 * total and settlement must equal the figures 10c6541a saved (embedded below,
 * produced by this file on the base worktree). The seed is the one of
 * tests/leakVerify_features_trade_in_preview_matches_saved_figure.test.ts.
 *
 * Since Services V2 (trade-in G11) a draft's own view carries no figure for
 * its customer; the saved answers are priced by the counted preview door (an
 * empty body prices what was saved), which is what the customer reads.
 *
 * LOCAL ONLY: in-memory SQLite, the real trade-in routes, a stub session.
 */
import { mock, test } from 'node:test';
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
    await send(a, 'PATCH', `/api/trade-in/requests/${req.id}`, { components });
    if (target) await send(a, 'PATCH', `/api/trade-in/requests/${req.id}`, { target });
    const saved = (await json(await post(a, `/api/trade-in/requests/${req.id}/preview`, {}))).estimate as Est;
    out[label] = { estimate: figures(saved), estimated_iqd: saved.total_iqd };
    raw.close();
  }
  return out;
}

/**
 * Services S-P2 (DECISIONS row 238, owner decision 1): the store-safe offer replaced the
 * paid-price formula, so the figures the guard holds were re-produced by `fingerprint()` on
 * feat/services-p2 — ONE figure, no part value. Every one is at or below what 10c6541a offered
 * (`V1_FIGURES`, kept below): the decision only ever lowers an offer the store could not resell.
 */
const BASE_FIGURES: Record<string, unknown> | null = {
  "resin-blank": {
    "estimate": {
      "total": 220000,
      "parts": [],
      "settlement": null
    },
    "estimated_iqd": 220000
  },
  "resin-worn": {
    "estimate": {
      "total": 165000,
      "parts": [],
      "settlement": null
    },
    "estimated_iqd": 165000
  },
  "resin-worn-p1s": {
    "estimate": {
      "total": 165000,
      "parts": [],
      "settlement": {
        "target_price_iqd": 1500000,
        "trade_in_value_iqd": 165000,
        "credit_iqd": 165000,
        "difference_iqd": 1335000,
        "excess_iqd": 0
      }
    },
    "estimated_iqd": 165000
  },
  "combo": {
    "estimate": {
      "total": 550000,
      "parts": [],
      "settlement": null
    },
    "estimated_iqd": 550000
  },
  "combo-p1s": {
    "estimate": {
      "total": 470000,
      "parts": [],
      "settlement": {
        "target_price_iqd": 1500000,
        "trade_in_value_iqd": 470000,
        "credit_iqd": 470000,
        "difference_iqd": 1030000,
        "excess_iqd": 0
      }
    },
    "estimated_iqd": 470000
  }
};

/** Produced on the base worktree (10c6541a) by the v1 `fingerprint()`: the paid-price formula. */
const V1_FIGURES: Record<string, { estimated_iqd: number; estimate: unknown }> = {
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

/**
 * The offer falls with whole 30-day months since delivery (`wholeMonthsBetween`), so the figures above hold only
 * while the unit is 12 months old: from 2026-09-21 to 2026-10-20 after DELIVERED. The clock is pinned inside that
 * window, or the guard turns red on the day the unit ages a month, with no change to the code.
 */
const PRICED_AT = '2026-10-10T00:00:00.000Z';

test('trade-in offers for the same unit, answers and target: HEAD saves the base figures', async () => {
  mock.timers.enable({ apis: ['Date'], now: Date.parse(PRICED_AT) });
  try {
    const now = await fingerprint();
    console.log(`FINGERPRINT ${JSON.stringify(now)}`);
    if (BASE_FIGURES) assert.deepEqual(now, BASE_FIGURES);
    for (const [label, v] of Object.entries(now as Record<string, { estimated_iqd: number }>)) {
      assert.ok(v.estimated_iqd <= V1_FIGURES[label].estimated_iqd, `${label}: the store-safe offer ${v.estimated_iqd} never exceeds the old ${V1_FIGURES[label].estimated_iqd}`);
    }
  } finally {
    mock.timers.reset();
  }
});
