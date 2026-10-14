/**
 * A product with a DIFFERENT, recognisable cost on every level the catalogue
 * can hold one — product, option, order-type cell, pre-order route, colour —
 * plus a received lot and an open purchase. The cost-leak suites
 * (tests/costLeaksPhase0.test.ts, tests/costRoleMatrix.test.ts) look for these
 * numbers anywhere in a response, as values, not only under known key names.
 */
import type { DatabaseSync } from 'node:sqlite';
import { FINANCIAL_FIELDS } from '../../worker/lib/adminScope';
import {
  CUSTOMER_ARITHMETIC_KEYS,
  CUSTOMER_DEFERRED_ARITHMETIC,
  CUSTOMER_WARRANTY_ARITHMETIC_KEYS,
} from '../../worker/lib/customerPricing';

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

/**
 * A generated id — newId's 20 hex characters behind an optional prefix
 * (`pol_3f6333ab…`), an `ORD-` order id, or a UUID — is random text that can
 * spell a four-digit sentinel by chance (measured: about 1 in 130 sweeps of the
 * 54 policy documents). So is a digest: the audit chain's `hash`/`prev_hash`
 * are 64 hex characters, and one spelled a sentinel in a workflow 7 run on
 * 2026-10-14. Neither is ever a cost, so the digit scan skips a string that is
 * exactly such an id or digest. A cost inside any other text is still caught.
 */
const GENERATED_ID =
  /^(?:[A-Za-z][A-Za-z0-9]*[_-])?(?:[0-9A-Fa-f]{10,32}|[0-9A-Fa-f]{40}|[0-9A-Fa-f]{64}|[0-9A-Fa-f]{128}|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/;
export const isGeneratedId = (s: string): boolean =>
  GENERATED_ID.test(s) && /[A-Fa-f]/.test(s.replace(/^[A-Za-z][A-Za-z0-9]*[_-]/, ''));

const FINANCIAL_KEYS: ReadonlySet<string> = new Set(FINANCIAL_FIELDS as readonly string[]);
const snakeOf = (k: string) => k.replace(/[A-Z]/g, (ch) => `_${ch.toLowerCase()}`);

/**
 * THE STEPS OF A PRICE, by the names the print engines answer them under —
 * not in FINANCIAL_FIELDS (a merchant's own costing carries them by design),
 * but never something a sweep may pass in a non-owner answer without a
 * NOT_A_COST reason (DECISIONS row 220): the failure reserve, the markup, the
 * break-even. A `lines[]` row of a cost engine (`{ component, iqd }`) is the
 * same: one line of what a job cost.
 */
const PRICE_CHAIN_KEYS: ReadonlySet<string> = new Set(['failure_reserve_iqd', 'markup_percent', 'break_even_iqd']);

/**
 * Text keys that carry PRIVATE IDENTITY rather than a figure: a picture's
 * `source_url` is the supplier listing the owner fetched it from (the public
 * API v1 drops it; DECISIONS row 220). Flagged when non-empty inside a media
 * or image list.
 */
const PRIVATE_MEDIA_TEXT_KEYS: ReadonlySet<string> = new Set(['source_url']);

/**
 * Every whole number written in a text: plain digits, or digits grouped by
 * thousands (`611,111`). A comma that does not group three digits is a CSV
 * separator, so `900000,,,611111` reads as two numbers, not one.
 */
const numbersInText = (v: string): string[] => v.match(/\d{1,3}(?:,\d{3})+(?!\d)|\d{4,}/g) ?? [];

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
      const o = v as Record<string, unknown>;
      // One line of a cost engine: what this part of the job cost.
      if (typeof o.component === 'string' && /^[A-Z][A-Z_]+$/.test(o.component) && typeof o.iqd === 'number') {
        out.push(`${path}.iqd = ${o.iqd} (a cost line: ${o.component})`);
      }
      for (const [k, x] of Object.entries(o)) {
        if (/cost/i.test(k) && typeof x === 'number') out.push(`${path}.${k} = ${x}`);
        else if ((FINANCIAL_KEYS.has(k) || FINANCIAL_KEYS.has(snakeOf(k))) && x !== null && x !== undefined) {
          out.push(`${path}.${k} ∈ FINANCIAL_FIELDS = ${JSON.stringify(x)?.slice(0, 60)}`);
        } else if (PRICE_CHAIN_KEYS.has(k) && x !== null && x !== undefined) {
          out.push(`${path}.${k} = ${JSON.stringify(x)?.slice(0, 60)} (a step of the price)`);
        } else if (
          PRIVATE_MEDIA_TEXT_KEYS.has(k) &&
          typeof x === 'string' &&
          x.trim() !== '' &&
          /\.(media|images|gallery)\[\d+\]$/.test(path)
        ) {
          out.push(`${path}.${k} = ${x.slice(0, 80)} (a supplier source)`);
        }
        walk(x, `${path}.${k}`);
      }
    } else if (typeof v === 'number' && numbers.has(v)) out.push(`${path} = ${v}`);
    else if (typeof v === 'string' && !isGeneratedId(v)) {
      for (const n of numbersInText(v)) {
        if (numbers.has(Number(n.replace(/,/g, '')))) out.push(`${path} ⊃ "${n}"`);
      }
      for (const d of v.match(/\d+\.\d+/g) ?? []) {
        if (decimals.has(d)) out.push(`${path} ⊃ "${d}"`);
      }
    }
  };
  walk(value, '$');
  return out;
}

/**
 * THE ARITHMETIC OF A PRICE ON A CUSTOMER CHANNEL (Pricing V2 V2-0, C5;
 * DECISIONS row 225). `leaks` above finds COST; this finds the STEPS of a
 * price that a customer payload must not carry either — the resolver's
 * `components`, `price_source`, `member_rule`, `pricing_basis`, a fee by name
 * (`commission_iqd`, `surcharge_iqd`, `direct_surcharge_iqd`), the raw ladder
 * (`regular_price_iqd`, every `*_adjust_iqd`) and a chosen warranty's formula.
 * The key names come from the worker's own list
 * (`worker/lib/customerPricing.ts`), so a key added there is scanned here.
 *
 * Presence is the leak, whatever the value: a `regular_adjust_iqd: null`
 * still publishes the shape of the ladder. Three discriminations keep a
 * same-named fact that is NOT arithmetic out of the net:
 *   - `components` is the resolver's OBJECT; the shipping breakdown and a
 *     bundle's contents are ARRAYS of rendered rows;
 *   - `price_source` under `offer` is the card's offer state ('ladder' |
 *     'offer'), which the public API reads to say «on offer»;
 *   - `fee_percent` / `basis_iqd` are flagged on a line's `warranty` only —
 *     the plan catalogue and the free-delivery threshold are other questions.
 * The paths still RENDERED today are `CUSTOMER_DEFERRED_ARITHMETIC` (V2-7).
 */
export function arithmeticLeaks(value: unknown, opts: { allow?: readonly RegExp[] } = {}): string[] {
  const banned = new Set<string>(CUSTOMER_ARITHMETIC_KEYS);
  const warrantyOnly = new Set<string>(CUSTOMER_WARRANTY_ARITHMETIC_KEYS);
  const allow = [...CUSTOMER_DEFERRED_ARITHMETIC, ...(opts.allow ?? [])];
  const out: string[] = [];
  const walk = (v: unknown, path: string, parentKey: string) => {
    if (Array.isArray(v)) v.forEach((x, i) => walk(x, `${path}[${i}]`, parentKey));
    else if (v && typeof v === 'object') {
      for (const [k, x] of Object.entries(v as Record<string, unknown>)) {
        const at = `${path}.${k}`;
        const flagged =
          (banned.has(k) &&
            !(k === 'components' && Array.isArray(x)) &&
            !(k === 'price_source' && parentKey === 'offer')) ||
          (warrantyOnly.has(k) && parentKey === 'warranty');
        if (flagged && !allow.some((re) => re.test(at.replace(/\[\d+\]/g, '[n]')))) {
          out.push(`${at} = ${JSON.stringify(x)?.slice(0, 60)}`);
        }
        walk(x, at, k);
      }
    }
  };
  walk(value, '$', '');
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
