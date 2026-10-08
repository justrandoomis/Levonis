/**
 * THE 41 LIVE PRODUCTS, AS A CENSUS-SHAPED SEED (MVP plan §6 P1; master plan v2
 * §7 "L1: fixtures/legacyCatalogue.ts, a 41-product seed built from the census
 * flags, used by L2–L4 and V2").
 *
 * The census (workflow 59, 2026-10-07) gives counts and yes/no flags only — no
 * value left the live database — so the SHAPE here is the live catalogue's and
 * the NUMBERS are synthetic but deterministic:
 *
 *   product i (0-based, census order)   base price B = 100,000 + 50,000·i
 *     product cost (p_cost)             B − 20,000 − 1,000·i
 *     route commission (p_route_fee)    10,000 per offered method (products.preorder_transports)
 *     package weight / box              1,000 + 100·i g / 400 × 300 × (200 + i) mm
 *   model j of that product
 *     fixed price (first opt_fixed)     B + 30,000·j
 *     price adjustment (next opt_adj)   + (10,000·j + 5,000)
 *     fixed cost (first opt_cost)       its item price − 25,000
 *     cost adjustment (next opt_cost_adj) + 3,000·(j + 1)
 *     package weight (first opt_pkg_w)  1,200 + 100·j g
 *   cells: the first direct_cells models sell direct, the first pre_cells
 *     pre-order; cell_price fixed prices go to direct cells first (item +
 *     50,000), then to pre-order cells (the item price itself); cell_cost costs
 *     likewise (cell price − 30,000)
 *   routes: every pre-order cell carries air, sea and land rows, enabled per
 *     route_methods; the first route_fee enabled routes carry a surcharge —
 *     air 25,000, sea 4,500, land 15,000
 *   colours and exact SKUs: rows with no price and no cost (census: none has
 *     either); sku_pkg_w SKUs carry a package weight
 *
 * Every count in the census row is reproduced for the ACTIVE rows (the census
 * counts active option values and enabled cells and routes; the 15 inactive
 * option values and their cells are not seeded) — tests/pricingLegacyTargets
 * checks the totals: 41 products, 92 models, 89 direct and 79 pre-order cells,
 * 80 enabled routes, 35 route surcharges, 28 products with a route fee, 153
 * colours and 266 SKUs.
 */
import type { DatabaseSync } from 'node:sqlite';

/** The census columns, verbatim from census-41-products.txt (status, proc_defaults and lots dropped: active / 0 / 0). */
const CENSUS = `
slug inv_mode sale_types p_cost p_direct_fee p_route_fee p_pkg_w p_pkg_dims p_net_w groups opts opt_cost opt_cost_adj opt_fixed opt_adj opt_pkg_w cols col_cost col_price col_pkg_w skus sku_price sku_cost sku_pkg_w direct_cells pre_cells cell_price cell_cost routes route_methods route_fee route_price
bambu-hotend-a1-a2 OPTION ["direct_sale","pre_order"] 1 0 0 1 1 0 1 5 0 4 0 4 0 0 0 0 0 0 0 0 0 5 5 0 0 5 air 5 0
bambu-hotend-h2-p2s-x2d-high-flow OPTION ["direct_sale","pre_order"] 1 0 1 1 1 0 1 3 0 0 0 0 0 0 0 0 0 3 0 0 0 3 3 0 0 3 air 0 0
bambu-hotend-h2-p2s-x2d-standard-flow OPTION ["direct_sale","pre_order"] 1 0 1 1 1 0 1 4 0 0 0 0 0 0 0 0 0 4 0 0 0 4 4 0 0 4 air 0 0
bambu-lab-a1 OPTION ["direct_sale","pre_order"] 1 0 0 0 0 1 1 2 0 1 2 0 2 0 0 0 0 0 0 0 0 2 2 2 0 2 land 0 0
bambu-lab-a1-mini OPTION ["direct_sale","pre_order"] 1 0 0 0 0 1 1 2 0 1 0 1 2 0 0 0 0 0 0 0 0 2 2 2 0 2 land 0 0
bambu-lab-a2l OPTION ["direct_sale","pre_order"] 1 0 0 0 0 1 1 3 0 2 0 2 3 0 0 0 0 0 0 0 0 3 3 3 0 3 land 0 0
bambu-lab-ams-2-pro OPTION ["direct_sale","pre_order"] 1 0 0 1 1 1 1 1 0 0 0 0 1 0 0 0 0 0 0 0 0 1 1 1 0 2 air,land 0 0
bambu-lab-ams-ht OPTION ["direct_sale","pre_order"] 1 0 0 1 1 1 1 1 0 0 0 0 1 0 0 0 0 0 0 0 0 1 1 1 0 1 land 0 0
bambu-lab-ams-lite OPTION ["direct_sale","pre_order"] 1 0 0 1 1 1 1 1 0 0 0 0 1 0 0 0 0 0 0 0 0 1 1 1 0 1 land 0 0
bambu-lab-h2c OPTION ["direct_sale","pre_order"] 0 0 1 0 0 1 1 4 0 0 0 3 4 0 0 0 0 0 0 0 0 4 4 4 0 4 land 4 0
bambu-lab-h2d OPTION ["direct_sale","pre_order"] 0 0 1 0 1 1 1 4 0 0 0 3 4 0 0 0 0 0 0 0 0 4 4 4 0 4 land 4 0
bambu-lab-h2s OPTION ["direct_sale","pre_order"] 1 0 1 0 1 1 1 3 3 0 0 2 3 0 0 0 0 0 0 0 0 3 3 3 0 3 land 3 0
bambu-lab-p1s OPTION ["direct_sale","pre_order"] 1 0 1 0 0 1 1 3 3 0 0 2 3 0 0 0 0 0 0 0 0 3 3 3 6 3 land 3 0
bambu-lab-p2s OPTION ["direct_sale","pre_order"] 1 0 1 0 0 1 1 2 2 0 0 1 2 0 0 0 0 0 0 0 0 2 2 2 4 2 land 2 0
bambu-lab-petg-basic VARIANT_COMBINATION ["direct_sale"] 0 0 0 0 0 0 1 2 2 0 0 1 0 13 0 0 0 26 0 0 0 2 0 0 0 0 null 0 0
bambu-lab-pla-aero VARIANT_COMBINATION ["direct_sale","pre_order"] 1 0 1 1 0 1 1 1 0 0 0 0 1 2 0 0 0 2 0 0 2 1 1 0 0 1 sea 1 0
bambu-lab-pla-basic-filament VARIANT_COMBINATION ["direct_sale","pre_order"] 1 0 0 0 0 1 1 2 0 1 0 1 0 30 0 0 0 60 0 0 0 2 2 0 0 2 sea 2 0
bambu-lab-pla-basic-gradient VARIANT_COMBINATION ["direct_sale","pre_order"] 1 0 1 0 0 1 1 1 0 0 0 0 0 8 0 0 0 8 0 0 0 1 1 0 0 1 sea 0 0
bambu-lab-pla-cf VARIANT_COMBINATION ["direct_sale","pre_order"] 1 0 1 0 0 1 1 2 0 0 0 0 0 7 0 0 0 14 0 0 0 2 2 0 0 2 sea 2 0
bambu-lab-pla-galaxy VARIANT_COMBINATION ["direct_sale","pre_order"] 1 0 1 0 0 1 1 1 0 0 0 0 0 4 0 0 0 4 0 0 0 1 1 0 0 1 sea 0 0
bambu-lab-pla-glow VARIANT_COMBINATION ["direct_sale","pre_order"] 1 0 1 0 0 1 1 1 0 0 0 0 0 5 0 0 0 5 0 0 0 1 1 0 0 1 sea 1 0
bambu-lab-pla-marble VARIANT_COMBINATION ["direct_sale","pre_order"] 1 0 1 0 0 1 1 1 0 0 0 0 0 2 0 0 0 2 0 0 0 1 1 0 0 1 sea 1 0
bambu-lab-pla-matte-1kg VARIANT_COMBINATION ["direct_sale","pre_order"] 0 0 0 0 0 1 1 2 2 0 0 1 2 25 0 0 0 50 0 0 0 2 2 0 0 2 sea 2 0
bambu-lab-pla-pure VARIANT_COMBINATION ["direct_sale","pre_order"] 1 0 1 0 0 1 1 2 0 1 0 1 0 5 0 0 0 10 0 0 0 2 2 0 0 2 sea 0 0
bambu-lab-pla-silk-multi-color VARIANT_COMBINATION ["direct_sale","pre_order"] 1 0 1 0 0 1 1 1 0 0 0 0 0 10 0 0 0 10 0 0 0 1 1 0 0 1 sea 0 0
bambu-lab-pla-silk-plus VARIANT_COMBINATION ["direct_sale","pre_order"] 1 0 1 0 0 1 1 2 0 1 0 1 0 13 0 0 0 26 0 0 0 2 2 0 0 2 sea 0 0
bambu-lab-pla-sparkle VARIANT_COMBINATION ["direct_sale","pre_order"] 1 0 1 0 0 1 1 1 0 0 0 0 0 6 0 0 0 6 0 0 0 1 1 0 0 1 sea 1 0
bambu-lab-pla-tough-plus VARIANT_COMBINATION ["direct_sale","pre_order"] 1 0 1 0 0 1 1 2 0 1 0 1 0 7 0 0 0 14 0 0 0 2 2 0 0 2 sea 0 0
bambu-lab-pla-translucent VARIANT_COMBINATION ["direct_sale","pre_order"] 1 0 1 0 0 1 1 1 0 0 0 0 0 10 0 0 0 10 0 0 0 1 1 0 0 1 sea 0 0
bambu-lab-pla-wood VARIANT_COMBINATION ["direct_sale","pre_order"] 1 0 1 0 0 1 1 1 0 0 0 0 0 6 0 0 0 6 0 0 0 1 1 0 0 1 sea 0 0
bambu-lab-r1-co2-laser BASE ["pre_order"] 1 0 0 1 1 1 1 3 3 0 0 2 1 0 0 0 0 0 0 0 0 0 3 3 3 3 land 3 0
bambu-lab-round-magnet OPTION ["direct_sale"] 0 0 0 0 0 0 1 9 9 0 0 9 0 0 0 0 0 0 0 0 0 9 0 0 0 0 null 0 0
bambu-lab-x2d OPTION ["direct_sale","pre_order"] 1 0 0 0 0 0 1 3 0 2 1 1 3 0 0 0 0 0 0 0 0 3 3 3 0 3 land 0 0
bambu-lab-x2d-combo-open-box-workshop-2026 OPTION ["direct_sale"] 0 0 0 0 0 0 1 1 0 0 0 0 0 0 0 0 0 0 0 0 0 1 0 0 0 0 null 0 0
bambu-reusable-spool OPTION ["direct_sale","pre_order"] 0 0 0 0 1 1 1 1 1 0 0 0 0 0 0 0 0 0 0 0 0 1 1 2 2 1 sea 1 0
bambu-tungsten-carbide-hotend-h2-p2s-x2d-high-flow OPTION ["direct_sale","pre_order"] 1 0 1 1 1 0 1 3 0 0 0 0 0 0 0 0 0 3 0 0 0 3 3 0 0 3 air 0 0
bambu-tungsten-carbide-hotend-h2-p2s-x2d-standard-flow OPTION ["direct_sale","pre_order"] 1 0 1 1 1 0 1 3 0 0 0 0 0 0 0 0 0 3 0 0 0 3 3 0 0 3 air 0 0
levo-metal-key-ring-25-30mm OPTION ["direct_sale","pre_order"] 1 0 1 0 0 0 1 2 2 0 1 0 0 0 0 0 0 0 0 0 0 2 2 0 0 2 sea 0 0
levo-switch-blue-3pin OPTION ["direct_sale"] 1 0 0 0 0 0 1 1 1 0 0 0 0 0 0 0 0 0 0 0 0 1 0 0 0 0 null 0 0
snapmaker-u1 OPTION ["direct_sale","pre_order"] 1 0 0 1 1 1 1 1 0 0 0 0 1 0 0 0 0 0 0 0 0 1 1 1 0 1 sea 0 0
snapmaker-u1-hot-end-nozzle-hardened-steel OPTION ["direct_sale","pre_order"] 1 0 0 0 0 1 1 4 0 0 0 0 0 0 0 0 0 0 0 0 0 4 4 0 0 4 air 0 0
`;

export interface CensusRow {
  slug: string;
  inv_mode: string;
  sale_types: string[];
  [count: string]: string | string[] | number | Array<'air' | 'sea' | 'land'>;
  route_methods: Array<'air' | 'sea' | 'land'>;
}

function parseCensus(): CensusRow[] {
  const [head, ...lines] = CENSUS.trim().split('\n');
  const cols = head!.split(' ');
  return lines.map((line) => {
    const cells = line.trim().split(' ');
    if (cells.length !== cols.length) throw new Error(`census row has ${cells.length} cells: ${line}`);
    const row: Record<string, unknown> = {};
    cols.forEach((c, i) => {
      const v = cells[i]!;
      if (c === 'slug' || c === 'inv_mode') row[c] = v;
      else if (c === 'sale_types') row[c] = JSON.parse(v);
      else if (c === 'route_methods') row[c] = v === 'null' ? [] : v.split(',');
      else row[c] = Number(v);
    });
    return row as CensusRow;
  });
}

/** The 41 census rows, census order. */
export const LEGACY_CENSUS: readonly CensusRow[] = parseCensus();

const n = (r: CensusRow, k: string) => r[k] as number;

/** The seeded id of a census product. */
export const legacyProductId = (slug: string): string => {
  const i = LEGACY_CENSUS.findIndex((r) => r.slug === slug);
  if (i < 0) throw new Error(`no census product ${slug}`);
  return `lp_${String(i + 1).padStart(2, '0')}`;
};

/** The seeded id of model j (0-based) of a census product. */
export const legacyOptionId = (slug: string, j: number): string => `${legacyProductId(slug)}_o${j}`;

const ROUTE_FEE: Readonly<Record<'air' | 'sea' | 'land', number>> = { air: 25_000, sea: 4_500, land: 15_000 };
const sql = (v: unknown): string => (v === null || v === undefined ? 'NULL' : typeof v === 'number' ? String(v) : `'${String(v).replace(/'/g, "''")}'`);
const title = (slug: string) => slug.split('-').map((w) => w[0]!.toUpperCase() + w.slice(1)).join(' ');

/** Seed the 41 products (see the file header). Returns the product ids in census order. */
export function seedLegacyCatalogue(raw: DatabaseSync): string[] {
  const ids: string[] = [];
  raw.exec('BEGIN');
  try {
    LEGACY_CENSUS.forEach((r, i) => {
      const id = `lp_${String(i + 1).padStart(2, '0')}`;
      ids.push(id);
      const base = 100_000 + 50_000 * i;
      const productCost = n(r, 'p_cost') ? base - 20_000 - 1_000 * i : null;
      const methods = r.route_methods;
      const transports = n(r, 'p_route_fee') ? methods.map((m) => ({ method: m, commission_iqd: 10_000, active: true })) : [];
      raw.exec(`
        INSERT INTO products (id, slug, name, name_ar, name_ku, status, price_iqd, product_cost_iqd, stock, selling_type, sale_types,
                              preorder_transports, inventory_mode, direct_surcharge_iqd, package_weight_g, package_depth_mm,
                              package_width_mm, package_height_mm, net_weight_g)
        VALUES (${sql(id)}, ${sql(r.slug)}, ${sql(title(r.slug))}, ${sql(`منتج ${i + 1}`)}, ${sql(`بەرهەمی ${i + 1}`)}, 'active', ${base},
                ${sql(productCost)}, 5, ${sql(r.sale_types[0])}, ${sql(JSON.stringify(r.sale_types))}, ${sql(JSON.stringify(transports))},
                ${sql(r.inv_mode)}, ${n(r, 'p_direct_fee') ? 50_000 : 'NULL'}, ${n(r, 'p_pkg_w') ? 1_000 + 100 * i : 'NULL'},
                ${n(r, 'p_pkg_dims') ? 400 : 'NULL'}, ${n(r, 'p_pkg_dims') ? 300 : 'NULL'}, ${n(r, 'p_pkg_dims') ? 200 + i : 'NULL'},
                ${n(r, 'p_net_w') ? 900 + 100 * i : 'NULL'});
        INSERT INTO product_option_groups (id, product_id, name_en, sort, active) VALUES (${sql(`${id}_g`)}, ${sql(id)}, 'Model', 0, 1);
      `);

      const opts = n(r, 'opts');
      let cellPrices = n(r, 'cell_price');
      let cellCosts = n(r, 'cell_cost');
      let routeFees = n(r, 'route_fee');
      const items: number[] = [];
      for (let j = 0; j < opts; j += 1) {
        const fixed = j < n(r, 'opt_fixed');
        const adjusted = !fixed && j < n(r, 'opt_fixed') + n(r, 'opt_adj');
        const adjust = adjusted ? 10_000 * j + 5_000 : null;
        const item = fixed ? base + 30_000 * j : base + (adjust ?? 0);
        items.push(item);
        const costFixed = j < n(r, 'opt_cost') ? item - 25_000 : null;
        const costAdjust = costFixed === null && j < n(r, 'opt_cost') + n(r, 'opt_cost_adj') ? 3_000 * (j + 1) : null;
        const optId = `${id}_o${j}`;
        raw.exec(`
          INSERT INTO product_option_values (id, product_id, group_id, name_en, name_ar, name_ckb, sort, active, stock,
                                             regular_price_iqd, regular_adjust_iqd, cost_iqd, cost_adjust_iqd, package_weight_g,
                                             variant_key, variant_label)
          VALUES (${sql(optId)}, ${sql(id)}, ${sql(`${id}_g`)}, ${sql(`Model ${j + 1}`)}, ${sql(`موديل ${j + 1}`)}, ${sql(`مۆدێلی ${j + 1}`)},
                  ${j}, 1, 5, ${fixed ? item : 'NULL'}, ${sql(adjust)}, ${sql(costFixed)}, ${sql(costAdjust)},
                  ${j < n(r, 'opt_pkg_w') ? 1_200 + 100 * j : 'NULL'}, ${sql(`m${j}`)}, ${sql(`Model ${j + 1}`)});
        `);
      }
      // Cells: direct first, then pre-order, so the fixed prices and costs land as the census counts them.
      const cell = (j: number, type: 'direct_sale' | 'pre_order', enabled: boolean) => {
        const item = items[j]!;
        let price: number | null = null;
        let cost: number | null = null;
        if (enabled && cellPrices > 0) {
          price = type === 'direct_sale' ? item + 50_000 : item;
          cellPrices -= 1;
        }
        if (enabled && cellCosts > 0) {
          cost = (price ?? item) - 30_000;
          cellCosts -= 1;
        }
        return { id: `${id}_o${j}_${type === 'direct_sale' ? 'd' : 'p'}`, type, enabled, price, cost };
      };
      const cells = [
        ...Array.from({ length: opts }, (_, j) => cell(j, 'direct_sale', j < n(r, 'direct_cells'))),
        ...Array.from({ length: opts }, (_, j) => cell(j, 'pre_order', j < n(r, 'pre_cells'))),
      ];
      for (const c of cells) {
        const optId = c.id.replace(/_[dp]$/, '');
        raw.exec(`
          INSERT INTO product_option_fulfillment (id, product_id, option_id, fulfillment_type, enabled, regular_price_iqd, cost_iqd)
          VALUES (${sql(c.id)}, ${sql(id)}, ${sql(optId)}, ${sql(c.type)}, ${c.enabled ? 1 : 0}, ${sql(c.price)}, ${sql(c.cost)});
        `);
        if (c.type !== 'pre_order') continue;
        for (const m of ['air', 'sea', 'land'] as const) {
          const enabled = c.enabled && methods.includes(m);
          let surcharge: number | null = null;
          if (enabled && routeFees > 0) {
            surcharge = ROUTE_FEE[m];
            routeFees -= 1;
          }
          raw.exec(`
            INSERT INTO product_option_transports (id, product_id, fulfillment_id, method, enabled, surcharge_iqd)
            VALUES (${sql(`${c.id}_${m}`)}, ${sql(id)}, ${sql(c.id)}, ${sql(m)}, ${enabled ? 1 : 0}, ${sql(surcharge)});
          `);
        }
      }
      for (let k = 0; k < n(r, 'cols'); k += 1) {
        raw.exec(`
          INSERT INTO product_colors (id, product_id, name_en, name_ar, name_ckb, hex, sort, active, stock)
          VALUES (${sql(`${id}_c${k}`)}, ${sql(id)}, ${sql(`Colour ${k + 1}`)}, ${sql(`لون ${k + 1}`)}, ${sql(`ڕەنگی ${k + 1}`)}, '#336699', ${k}, 1, 5);
        `);
      }
      const combos: string[] = [];
      for (let j = 0; j < opts; j += 1) {
        if (n(r, 'cols') === 0) combos.push(`o:${id}_o${j}`);
        else for (let k = 0; k < n(r, 'cols'); k += 1) combos.push(`o:${id}_o${j}|c:${id}_c${k}`);
      }
      combos.slice(0, n(r, 'skus')).forEach((combo, k) => {
        raw.exec(`
          INSERT INTO product_variants (id, product_id, combo_key, sku, active, stock, package_weight_g)
          VALUES (${sql(`${id}_v${k}`)}, ${sql(id)}, ${sql(combo)}, ${sql(`${r.slug}-${k}`)}, 1, 5, ${k < n(r, 'sku_pkg_w') ? 1_100 : 'NULL'});
        `);
      });
      if (cellPrices || cellCosts || routeFees) throw new Error(`census row ${r.slug} could not place every count`);
    });
    raw.exec('COMMIT');
  } catch (e) {
    raw.exec('ROLLBACK');
    throw e;
  }
  return ids;
}

/** The purchase-screen rates, as the procurement profiles hold them (the P1 rate reference reads these). */
export const PROFILE_RATES = {
  germany_land: { exchange_rate: 1610.25, shipping_rate_iqd: 9_000, updated_at: '2026-09-01T00:00:00.000Z' },
  china_air: { exchange_rate: 205.5, shipping_rate_iqd: 14_000, updated_at: '2026-09-02T00:00:00.000Z' },
  china_sea: { exchange_rate: 206.25, shipping_rate_iqd: 350_000, updated_at: '2026-09-03T00:00:00.000Z' },
} as const;

export function seedProfileRates(raw: DatabaseSync): void {
  for (const [id, r] of Object.entries(PROFILE_RATES)) {
    raw.prepare('UPDATE procurement_cost_profiles SET exchange_rate = ?, shipping_rate_iqd = ?, updated_at = ? WHERE id = ?').run(r.exchange_rate, r.shipping_rate_iqd, r.updated_at, id);
  }
}
