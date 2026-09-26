/**
 * THE LIVE PRINTERS' OPTIONS OF 2026-09-26, AS A SEED (owner round 11).
 *
 * Captured from levonis-iq.com (GET /api/products/:slug) for the ten FDM
 * printers `liveCatalog.ts` seeds: every active model with its regular price
 * rung (an absolute price or an adjustment on the product's base), its
 * direct-sale cell's adjustment (the premium the product page adds for buying
 * from the shelf) and its shelf count. The product page priced these as, for
 * example, A1 799,000 / A1 Combo 965,000 and U1 1,749,000 — the figures the
 * tests assert, because they are what the customer was shown.
 *
 * `seedLivePrinterOptions` also re-runs migration 0144 (the colour facts and
 * the per-option lines), because `freshDb()` applied it before these rows
 * existed.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { DatabaseSync } from 'node:sqlite';
import { P } from './liveCatalog';

export interface LiveOption {
  id: string;
  name: string;
  /** Absolute regular price, or null to inherit the product's. */
  reg: number | null;
  /** Signed adjustment on the inherited regular price. */
  adj: number | null;
  /** The direct-sale cell's adjustment. */
  direct: number;
  stock: number;
}

export const LIVE_PRINTER_OPTIONS: Record<string, LiveOption[]> = {
  [P.A1MINI]: [
    { id: 'a1-mini', name: 'A1 mini', reg: null, adj: null, direct: 50000, stock: 0 },
    { id: 'a1-mini-combo', name: 'A1 mini Combo', reg: null, adj: 174000, direct: 26000, stock: 0 },
  ],
  [P.A1]: [
    { id: 'a1', name: 'A1', reg: 749000, adj: null, direct: 50000, stock: 0 },
    { id: 'a1-combo', name: 'A1 Combo', reg: 915000, adj: null, direct: 50000, stock: 5 },
  ],
  [P.A2L]: [
    { id: 'a2l', name: 'A2L', reg: null, adj: null, direct: 75000, stock: 0 },
    { id: 'a2l-combo', name: 'A2L Combo', reg: null, adj: 150000, direct: 75000, stock: 0 },
    { id: 'a2l-cutting-full-combo', name: 'A2L Cutting Full Combo', reg: null, adj: 300000, direct: 75000, stock: 0 },
  ],
  [P.H2C]: [
    { id: 'h2c-ams-combo', name: 'H2C AMS Combo', reg: null, adj: null, direct: 140000, stock: 0 },
    { id: 'h2c-laser-full-combo-10w', name: 'H2C Laser Full Combo 10W', reg: null, adj: 770000, direct: 170000, stock: 0 },
    { id: 'h2c-laser-full-combo-40w', name: 'H2C Laser Full Combo 40W', reg: null, adj: 1540000, direct: 200000, stock: 0 },
    { id: 'h2c-vortek-ultimate-bundle', name: 'H2C Vortek Ultimate Bundle', reg: null, adj: 440000, direct: 200000, stock: 0 },
  ],
  [P.H2D]: [
    { id: 'h2d', name: 'H2D', reg: null, adj: null, direct: 115000, stock: 0 },
    { id: 'h2d-combo', name: 'H2D Combo', reg: null, adj: 365000, direct: 150000, stock: 0 },
    { id: 'h2d-laser-full-combo-10w', name: 'H2D Laser Full Combo 10W', reg: null, adj: 1165000, direct: 150000, stock: 0 },
    { id: 'h2d-laser-full-combo-40w', name: 'H2D Laser Full Combo 40W', reg: null, adj: 1950000, direct: 165000, stock: 0 },
  ],
  [P.H2S]: [
    { id: 'h2s', name: 'H2S', reg: null, adj: null, direct: 100000, stock: 0 },
    { id: 'h2s-ams-combo', name: 'H2S AMS Combo', reg: null, adj: 400000, direct: 100000, stock: 1 },
    { id: 'h2s-laser-full-combo', name: 'H2S Laser Full Combo 10W', reg: null, adj: 1240000, direct: 100000, stock: 0 },
  ],
  [P.P1S]: [
    { id: 'p1s', name: 'P1S', reg: null, adj: null, direct: 50000, stock: 0 },
    { id: 'p1s-ams-combo', name: 'P1S AMS Combo', reg: null, adj: 230000, direct: 70000, stock: 0 },
    { id: 'p1s-ams-2-combo', name: 'P1S AMS 2 Combo', reg: null, adj: 280000, direct: 70000, stock: 0 },
  ],
  [P.P2S]: [
    { id: 'p2s', name: 'P2S', reg: null, adj: null, direct: 70000, stock: 0 },
    { id: 'p2s-combo', name: 'P2S Combo', reg: null, adj: 300000, direct: 70000, stock: 0 },
  ],
  [P.X2D]: [
    { id: 'x2d', name: 'X2D', reg: null, adj: null, direct: 74000, stock: 0 },
    { id: 'x2d-combo', name: 'X2D Combo', reg: null, adj: 350000, direct: 74000, stock: 2 },
    { id: 'x2d-print-more-bundle', name: 'X2D Print More Bundle', reg: 2425000, adj: null, direct: 74000, stock: 0 },
  ],
  [P.U1]: [{ id: 'u1', name: 'Snapmaker U1', reg: null, adj: null, direct: 170000, stock: 5 }],
};

const MIGRATION = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'migrations', '0144_printer_multicolor_specs.sql');

/** Seeds the options (after `seedLiveCatalog`) and applies 0144 to the seeded rows. */
export function seedLivePrinterOptions(raw: DatabaseSync, opts: { migration?: boolean } = {}): void {
  const group = raw.prepare('INSERT INTO product_option_groups (id, product_id, name_en, sort, active) VALUES (?, ?, ?, 0, 1)');
  const value = raw.prepare(
    `INSERT INTO product_option_values
       (id, product_id, group_id, name_en, name_ar, sort, active, stock, availability_type, variant_key, variant_label,
        regular_price_iqd, regular_adjust_iqd)
     VALUES (?, ?, ?, ?, ?, ?, 1, ?, '', ?, ?, ?, ?)`
  );
  const cell = raw.prepare(
    `INSERT INTO product_option_fulfillment (id, product_id, option_id, fulfillment_type, enabled, regular_adjust_iqd)
     VALUES (?, ?, ?, ?, 1, ?)`
  );
  for (const [productId, options] of Object.entries(LIVE_PRINTER_OPTIONS)) {
    raw.prepare("UPDATE products SET inventory_mode = 'OPTION', stock = NULL WHERE id = ?").run(productId);
    const g = `g_${productId}`;
    group.run(g, productId, 'Model');
    options.forEach((o, i) => {
      value.run(o.id, productId, g, o.name, o.name, i, o.stock, o.id, o.name, o.reg, o.adj);
      cell.run(`f_${o.id}_d`, productId, o.id, 'direct_sale', o.direct);
      cell.run(`f_${o.id}_p`, productId, o.id, 'pre_order', null);
    });
  }
  if (opts.migration !== false) raw.exec(readFileSync(MIGRATION, 'utf8'));
}

/**
 * The 0144 facts as a map, parsed from the migration itself (one source): product
 * id → { field: value }. For the pure scorer tests, which build candidates
 * without a database.
 */
export function liveColourFacts(): Map<string, Record<string, string>> {
  const sql = readFileSync(MIGRATION, 'utf8');
  const out = new Map<string, Record<string, string>>();
  const re = /json_set\(spec_fields, '\$\.([a-z_]+)', '((?:[^']|'')*)'\)\s*WHERE id = '([^']+)'/g;
  for (const m of sql.matchAll(re)) {
    const facts = out.get(m[3]) ?? {};
    facts[m[1]] = m[2].replace(/''/g, "'");
    out.set(m[3], facts);
  }
  return out;
}
