/**
 * A product with a DIFFERENT, recognisable cost on every level the catalogue
 * can hold one — product, option, order-type cell, pre-order route, colour —
 * plus a received lot and an open purchase. The cost-leak suites
 * (tests/costLeaksPhase0.test.ts, tests/costRoleMatrix.test.ts) look for these
 * numbers anywhere in a response, as values, not only under known key names.
 */
import type { DatabaseSync } from 'node:sqlite';

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
} as const;

export const SENTINELS: ReadonlySet<number> = new Set(Object.values(COST));

/**
 * Every place a cost reaches: a key naming cost that carries a number, and
 * any number equal to a seeded cost, at any depth.
 */
export function leaks(value: unknown, path = '$'): string[] {
  const out: string[] = [];
  if (Array.isArray(value)) value.forEach((v, i) => out.push(...leaks(v, `${path}[${i}]`)));
  else if (value && typeof value === 'object') {
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (/cost/i.test(k) && typeof v === 'number') out.push(`${path}.${k} = ${v}`);
      out.push(...leaks(v, `${path}.${k}`));
    }
  } else if (typeof value === 'number' && SENTINELS.has(value)) out.push(`${path} = ${value}`);
  else if (typeof value === 'string') {
    for (const n of value.match(/\d[\d,]{3,}/g) ?? []) {
      if (SENTINELS.has(Number(n.replace(/,/g, '')))) out.push(`${path} ⊃ "${n}"`);
    }
  }
  return out;
}

export function seedCostlyProduct(raw: DatabaseSync) {
  raw.exec(`
    INSERT INTO users (id,name,email,password_hash,role) VALUES ('u1','Sara','s@x.co','h','customer');
    INSERT INTO products (id,slug,name,name_ar,price_iqd,product_cost_iqd,status,stock,options,colors,
                          selling_type,sale_types,preorder_transports,images,inventory_mode,ops_policy)
    VALUES ('p_a1','a1','Bambu Lab A1','بامبو A1',900000,${COST.product},'active',5,'[]','[]',
            'direct_sale','["direct_sale","pre_order"]','[]','[]','PRODUCT','{}');
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
                                    source_currency,source_unit_amount,exchange_rate_used,status)
    VALUES ('inc1','p_a1','base','',3,${COST.incomingUnit},'CNY',2999,203.7,'incoming');
    INSERT INTO inventory_lots (id,product_id,scope,scope_id,qty_received,qty_remaining,unit_cost_iqd,
                                purchase_unit_iqd,shipping_share_iqd,internal_share_iqd,total_cost_iqd,
                                cost_basis,received_at)
    VALUES ('lot1','p_a1','base','',2,2,${COST.lotUnit},${COST.lotPurchase},${COST.lotShipping},0,${COST.lotTotal},
            'received','2026-09-01T09:00:00Z');
  `);
}
