/**
 * A product with a DIFFERENT, recognisable cost on every level the catalogue
 * can hold one — product, option, order-type cell, pre-order route, colour —
 * plus a received lot and an open purchase. The cost-leak suites
 * (tests/costLeaksPhase0.test.ts, tests/costRoleMatrix.test.ts) look for these
 * numbers anywhere in a response, as values, not only under known key names.
 */
import type { DatabaseSync } from 'node:sqlite';
import { FINANCIAL_FIELDS } from '../../worker/lib/adminScope';

/** Sentinel costs — numbers no price, stock, timestamp or id in the fixture can equal. */
export const COST = {
  product: 611_111,
  option: 622_222,
  optionAdjust: 6_333,
  cell: 644_444,
  cellAdjust: 6_555,
  route: 666_666,
  routeAdjust: 6_777,
  color: 688_888,
  colorAdjust: 6_999,
  lotPurchase: 681_001,
  lotShipping: 18_998,
  lotUnit: 699_999,
  lotTotal: 1_399_998,
  incomingUnit: 655_321,
  orderLine: 633_331,
  orderCogs: 699_331,
  incomingShipping: 612_345,
  incomingInternal: 6_123,
  purchaseUnit: 677_123,
  purchaseCharge: 61_234,
} as const;

export const SENTINELS: ReadonlySet<number> = new Set(Object.values(COST));

/**
 * DECIMAL SENTINELS — the private figures that are not whole dinars: the FX
 * rate and the supplier's own-currency unit price seedCostlyStock stores on
 * the open purchase. A supplier, FX or CBM figure travels as a decimal, so
 * the walk looks for these as numbers AND as decimal text.
 */
export const DECIMAL_SENTINELS = { fxRate: 203.7, sourceUnit: 2999.25 } as const;

/** What a caller adds to the walk: more sentinel numbers and more decimal text. */
export interface LeakExtra {
  numbers?: Iterable<number>;
  decimals?: Iterable<string>;
}

const FINANCIAL_KEYS: ReadonlySet<string> = new Set(FINANCIAL_FIELDS as readonly string[]);
const snakeOf = (k: string) => k.replace(/[A-Z]/g, (ch) => `_${ch.toLowerCase()}`);

/**
 * Every place a cost reaches, at any depth:
 *   - a key naming cost that carries a number;
 *   - ANY key of FINANCIAL_FIELDS (snake or camel) that carries a value —
 *     the naming contract of owner decision 2: `target_profit_iqd`, `fx_rate`
 *     or `effective_cbm` do not say "cost" and are cost all the same;
 *   - any number equal to a seeded cost, or digits inside a string (an
 *     exported .txt or .csv) that spell one;
 *   - a decimal sentinel, as a number or as text.
 *
 * `extra` adds a caller's own sentinels (a later step's seeded supplier price,
 * FX rate or CBM). The second argument used to be the path; it is internal now.
 */
export function leaks(value: unknown, extra: LeakExtra = {}): string[] {
  const numbers = new Set<number>([...SENTINELS, ...Object.values(DECIMAL_SENTINELS), ...(extra.numbers ?? [])]);
  const decimals = new Set<string>([
    ...Object.values(DECIMAL_SENTINELS).map((n) => String(n)),
    ...(extra.decimals ?? []),
  ]);
  const out: string[] = [];
  const walk = (v: unknown, path: string) => {
    if (Array.isArray(v)) v.forEach((x, i) => walk(x, `${path}[${i}]`));
    else if (v && typeof v === 'object') {
      for (const [k, x] of Object.entries(v as Record<string, unknown>)) {
        if (/cost/i.test(k) && typeof x === 'number') out.push(`${path}.${k} = ${x}`);
        else if ((FINANCIAL_KEYS.has(k) || FINANCIAL_KEYS.has(snakeOf(k))) && x !== null && x !== undefined) {
          out.push(`${path}.${k} ∈ FINANCIAL_FIELDS = ${JSON.stringify(x)?.slice(0, 60)}`);
        }
        walk(x, `${path}.${k}`);
      }
    } else if (typeof v === 'number' && numbers.has(v)) out.push(`${path} = ${v}`);
    else if (typeof v === 'string') {
      for (const n of v.match(/\d[\d,]{3,}/g) ?? []) {
        if (SENTINELS.has(Number(n.replace(/,/g, '')))) out.push(`${path} ⊃ "${n}"`);
      }
      for (const d of v.match(/\d+\.\d+/g) ?? []) {
        if (decimals.has(d)) out.push(`${path} ⊃ "${d}"`);
      }
    }
  };
  walk(value, '$');
  return out;
}

export function seedCostlyProduct(raw: DatabaseSync) {
  raw.exec(`
    INSERT INTO users (id,name,email,password_hash,role) VALUES ('u1','Sara','s@x.co','h','customer');
    INSERT INTO products (id,slug,name,name_ar,price_iqd,product_cost_iqd,status,stock,options,colors,
                          selling_type,sale_types,preorder_transports,images,inventory_mode,ops_policy)
    VALUES ('p_a1','a1','Bambu Lab A1','بامبو A1',900000,${COST.product},'active',5,'[]','[]',
            'direct_sale','["direct_sale","pre_order"]','[]','[]','BASE','{}');
    INSERT INTO product_option_groups (id,product_id,name_en,sort,active) VALUES ('g','p_a1','Model',0,1);
    INSERT INTO product_option_values
      (id,product_id,group_id,name_en,name_ar,sort,active,stock,availability_type,variant_key,variant_label,
       cost_iqd,cost_adjust_iqd)
    VALUES ('v_a1','p_a1','g','A1','A1',0,1,NULL,'','a1','A1',${COST.option},${COST.optionAdjust});
    INSERT INTO product_option_fulfillment (id,product_id,option_id,fulfillment_type,enabled,capacity,cost_iqd,cost_adjust_iqd)
    VALUES ('f_d','p_a1','v_a1','direct_sale',1,NULL,${COST.cell},${COST.cellAdjust}),
           ('f_p','p_a1','v_a1','pre_order',1,NULL,${COST.cell},${COST.cellAdjust});
    INSERT INTO product_option_transports (id,product_id,fulfillment_id,method,enabled,surcharge_iqd,cost_iqd,cost_adjust_iqd)
    VALUES ('t_air','p_a1','f_p','air',1,25000,${COST.route},${COST.routeAdjust});
    INSERT INTO product_colors (id,product_id,name_en,name_ar,hex,sort,active,cost_iqd,cost_adjust_iqd)
    VALUES ('c_blk','p_a1','Black','أسود','#000000',0,1,${COST.color},${COST.colorAdjust});
    INSERT INTO cart_items (id,user_id,product_id,option_id,option_value_ids,color_id,
                            shipping_method_id,transport_method,warranty_plan_id,qty)
    VALUES ('ci','u1','p_a1','v_a1','["v_a1"]','c_blk','','','',1);
  `);
}

/** A received lot and an open purchase for the same product. */
export function seedCostlyStock(raw: DatabaseSync) {
  raw.exec(`
    INSERT INTO incoming_inventory (id,product_id,scope,scope_id,qty_ordered,purchase_unit_iqd,
                                    source_currency,source_unit_amount,exchange_rate_used,status,
                                    shipping_total_iqd,internal_delivery_total_iqd)
    VALUES ('inc1','p_a1','base','',3,${COST.incomingUnit},'CNY',${DECIMAL_SENTINELS.sourceUnit},${DECIMAL_SENTINELS.fxRate},'incoming',
            ${COST.incomingShipping},${COST.incomingInternal});
    INSERT INTO inventory_lots (id,product_id,scope,scope_id,qty_received,qty_remaining,unit_cost_iqd,
                                purchase_unit_iqd,shipping_share_iqd,internal_share_iqd,total_cost_iqd,
                                cost_basis,received_at)
    VALUES ('lot1','p_a1','base','',2,2,${COST.lotUnit},${COST.lotPurchase},${COST.lotShipping},0,${COST.lotTotal},
            'received','2026-09-01T09:00:00Z');
  `);
}

/**
 * A delivered order of the costly product for the customer `u1`: its line
 * carries the cost snapshot and its allocation the COGS out of `lot1` — the
 * two places a sold unit's cost lives. Id `ord1` (tests/fixtures/roleMatrix.ts
 * fills an order route's `:id` with it).
 */
export function seedCostlyOrder(raw: DatabaseSync) {
  raw.exec(`
    INSERT INTO orders (id,user_id,status,address_snapshot,delivery_method_id,delivery_method_snapshot,payment_method_id,
                        subtotal_iqd,exchange_rate,total_iqd,due_on_delivery_iqd,delivered_at)
      VALUES ('ord1','u1','delivered','{}','standard','{}','cash',900000,1500,905000,905000,'2026-09-02T10:00:00Z');
    INSERT INTO order_items (id,order_id,product_id,name_snapshot,qty,unit_price_iqd,line_total_iqd,cost_iqd,cost_basis)
      VALUES ('oi1','ord1','p_a1','Bambu Lab A1',1,900000,900000,${COST.orderLine},'snapshot');
    INSERT INTO order_item_inventory_allocations (id,order_id,order_item_id,lot_id,scope,qty,unit_cost_iqd,cogs_iqd,idempotency_key)
      VALUES ('oa1','ord1','oi1','lot1','base',1,${COST.orderCogs},${COST.orderCogs},'seed-ord1');
  `);
}

/**
 * A purchase DOCUMENT (the procurement path, 0162): `po1` with one line `pl1`
 * on its own open purchase `inc2` for the costly product, priced in CNY with
 * a charge. What a receiving assistant receives against — and what only the
 * owner may read the cost of.
 */
export function seedCostlyPurchase(raw: DatabaseSync, createdBy = 'usr_owner') {
  raw.exec(`
    INSERT INTO incoming_inventory (id,product_id,scope,scope_id,qty_ordered,purchase_unit_iqd,source_currency,
                                    source_unit_amount,exchange_rate_used,status,shipping_total_iqd,internal_delivery_total_iqd)
      VALUES ('inc2','p_a1','base','',2,${COST.purchaseUnit},'CNY',${DECIMAL_SENTINELS.sourceUnit},${DECIMAL_SENTINELS.fxRate},'incoming',0,0);
    INSERT INTO purchase_orders (id,currency,exchange_rate,purchase_day,status,cost_state,created_by,created_at,updated_at)
      VALUES ('po1','CNY',${DECIMAL_SENTINELS.fxRate},'2026-09-01','ordered','final','${createdBy}','2026-09-01T00:00:00Z','2026-09-01T00:00:00Z');
    INSERT INTO purchase_lines (id,purchase_id,incoming_id,label,source_unit_amount,charges_iqd,invoiced_qty)
      VALUES ('pl1','po1','inc2','Bambu Lab A1',${DECIMAL_SENTINELS.sourceUnit},${COST.purchaseCharge},2);
  `);
}
