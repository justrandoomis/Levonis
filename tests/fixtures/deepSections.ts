/**
 * «MAKERS-SUPPLY», DEEPER — a section's counts at any depth (docs/DECISIONS.md row 311).
 *
 * Over the live catalogue (./liveCatalog.ts, where «makers-supply» holds «new-products» and «maker-tools», one
 * Levo product each, both in stock):
 *   - «maker-tools» holds «hand-tools», which holds «saws», with one product in stock: «hand-tools» is a
 *     grandchild of «makers-supply», and «saws» a grandchild of «maker-tools» — what a listing page of
 *     «maker-tools» must already know when «hand-tools» is opened from it;
 *   - an INACTIVE «mid-inactive» under «makers-supply» holds «deep-leaf», whose one product sells on pre-order
 *     only: the map and the page lift «deep-leaf» to «makers-supply» (worker/lib/catalogPresentation.ts
 *     `visibleChildren`), and the inactive section itself is never a node;
 *   - «saws» also holds three products no count may see: a draft, a hidden one, and one the owner's switch
 *     holds from the catalogue for a missing picture (a catalog-blocking gap).
 */
import type { DatabaseSync } from 'node:sqlite';

export const DEEP = {
  /** Under «maker-tools» (`cat_makers_tools`). */
  hand: 'cat_hand_tools',
  /** Under «hand-tools»: the product in stock and the three no count sees. */
  saws: 'cat_saws',
  /** The inactive middle section, under «makers-supply» (`cat_makers`). */
  mid: 'cat_mid_inactive',
  /** Its active leaf, lifted to «makers-supply». */
  leaf: 'cat_deep_leaf',
  inStock: 'prd_saw_in_stock',
  preorder: 'prd_deep_preorder',
  unseen: ['prd_saw_draft', 'prd_saw_hidden', 'prd_saw_held'],
} as const;

export function seedDeepSections(raw: DatabaseSync): void {
  raw.exec(`
    INSERT INTO catalogs (id, parent_id, slug, name_ar, name_en, sort) VALUES ('${DEEP.hand}', 'cat_makers_tools', 'hand-tools', 'عدد يدوية', 'Hand tools', 90);
    INSERT INTO catalogs (id, parent_id, slug, name_ar, name_en, sort) VALUES ('${DEEP.saws}', '${DEEP.hand}', 'saws', 'مناشير', 'Saws', 91);
    INSERT INTO catalogs (id, parent_id, slug, name_ar, name_en, sort, active) VALUES ('${DEEP.mid}', 'cat_makers', 'mid-inactive', 'قسم معطّل', 'Inactive middle', 92, 0);
    INSERT INTO catalogs (id, parent_id, slug, name_ar, name_en, sort) VALUES ('${DEEP.leaf}', '${DEEP.mid}', 'deep-leaf', 'ورقة عميقة', 'Deep leaf', 93);
  `);
  const ins = raw.prepare(
    `INSERT INTO products (id, slug, name, name_ar, description, price_iqd, prime_price_iqd, pro_price_iqd, status, stock,
                           selling_type, sale_types, category_id, sub_category_id, display_order, created_at)
     VALUES (?, ?, ?, ?, '', 40000, 38000, 36000, ?, ?, 'direct_sale', ?, 'cat_makers', ?, 10, '2026-10-01T00:00:00.000Z')`
  );
  const direct = JSON.stringify(['direct_sale']);
  ins.run(DEEP.inStock, 'hand-saw', 'Hand saw', 'منشار يدوي', 'active', 3, direct, DEEP.saws);
  ins.run(DEEP.preorder, 'deep-kit', 'Deep kit', 'طقم عميق', 'active', 0, JSON.stringify(['direct_sale', 'pre_order']), DEEP.leaf);
  const [draft, hidden, held] = DEEP.unseen;
  ins.run(draft, 'saw-draft', 'Saw draft', 'مسودة', 'draft', 5, direct, DEEP.saws);
  ins.run(hidden, 'saw-hidden', 'Saw hidden', 'مخفي', 'hidden', 5, direct, DEEP.saws);
  ins.run(held, 'saw-held', 'Saw held', 'محجوب', 'active', 5, direct, DEEP.saws);
  raw.exec(
    `INSERT INTO product_completeness (product_id, complete, held, missing_json, missing_count, computed_at)
     VALUES ('${held}', 0, 1, '[{"c":"IMAGE"}]', 1, '2026-11-11T00:00:00.000Z')`
  );
}
