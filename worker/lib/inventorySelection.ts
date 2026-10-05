import { productImageFromRelations } from './productSelectionImage';
import type { ImageRow,VariantRow } from './productOverlay';
import { badRequest, notFound } from './http';
import { derivedRung, type PriceFields } from './pricing';
import { counterTarget } from './inventoryReceiving';
import { comboKey, type StockScope } from './inventory';
import { validateSelection, type OptionGroupRow, type OptionValueRow, type ColorRow, type ColorLinkRow } from './productRelations';
import { canonicalOptionValueIds, optionValueIdsInRelationOrder } from './cartSelectionIdentity';

export type Selection = {
  product_id: string;
  scope: StockScope;
  scope_id: string;
  label: string;
  sku: string;
  stock: number | null;
  reserved: number;
  selling_price_iqd: number;
  unit_cost_iqd: number | null;
  purchase_unit_iqd: number | null;
  cost_source: string;
  cost_date?:string|null;
  image_url?:string;
  weight_g: number;
  volume_mm3: number;
  option_id?: string;
  color_id?: string;
};
type Cell = Record<string, unknown> & {
  id: string;
  name_en?: string;
  name_ar?: string;
  regular_price_iqd: number | null;
  cost_iqd: number | null;
  regular_adjust_iqd?: number | null;
  cost_adjust_iqd?: number | null;
  stock: number | null;
  reserved: number;
};
type CostRow = Record<string, unknown>;
const knownCost = (value: unknown): number | null => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null;
export function selectionCostRung(cost: number | null, row: CostRow | undefined): number | null {
  if (!row) return cost;
  if (row.cost_iqd !== null && row.cost_iqd !== undefined) return knownCost(row.cost_iqd);
  return row.cost_adjust_iqd !== null && row.cost_adjust_iqd !== undefined && cost !== null && Number.isSafeInteger(row.cost_adjust_iqd)
    ? knownCost(Math.max(0, cost + Number(row.cost_adjust_iqd))) : cost;
}
/** Resolve a main-store order's persisted selectors, never the marketplace's
 * variant_id. Missing, foreign or ambiguous identities cannot inherit a cost. */
export function matchOrderCostSelection(product: CostRow, line: CostRow, rows: { options: CostRow[]; colors: CostRow[]; variants: CostRow[]; fulfillments: CostRow[]; groups?: CostRow[]; links?: CostRow[]; transports?: CostRow[] }) {
  let stored: unknown = line.option_value_ids;
  try { if (typeof stored === 'string') stored = JSON.parse(stored); } catch { return null; }
  if (stored !== undefined && stored !== null && (!Array.isArray(stored) || stored.some(id => typeof id !== 'string' || !id))) return null;
  const ids = canonicalOptionValueIds(Array.isArray(stored) && stored.length ? stored : line.option_id ? [line.option_id] : []);
  const colorId = typeof line.color_id === 'string' ? line.color_id : '';
  const active = (row: CostRow) => row.product_id === product.id && row.active !== 0 && row.active !== false && !row.merged_into;
  const options = rows.options.filter(row => active(row) && ids.includes(String(row.id)));
  const colors = rows.colors.filter(row => active(row) && row.id === colorId);
  if (options.length !== ids.length || (colorId && colors.length !== 1)) return null;
  if (validateSelection({ groups: (rows.groups ?? []) as unknown as OptionGroupRow[], values: rows.options as unknown as OptionValueRow[], colors: rows.colors as unknown as ColorRow[], links: (rows.links ?? []) as unknown as ColorLinkRow[], selectedValueIds: ids, selectedColorId: colorId || null }).length) return null;
  let scope: StockScope, scopeId = '', variant: CostRow | undefined;
  if (product.inventory_mode === 'VARIANT_COMBINATION') {
    const key = comboKey({ option_value_ids: ids, color_id: colorId });
    const matches = rows.variants.filter(row => active(row) && row.combo_key === key);
    if (!key || matches.length !== 1) return null;
    scope = 'variant'; variant = matches[0]; scopeId = String(variant.id);
  } else if (product.inventory_mode === 'OPTION') {
    if (options.length !== 1) return null;
    scope = 'option'; scopeId = String(options[0].id);
  } else if (product.inventory_mode === 'COLOR') {
    if (!colorId) return null;
    scope = 'color'; scopeId = colorId;
  } else if (product.inventory_mode === 'BASE') scope = 'base';
  else return null;
  let cost = knownCost(product.product_cost_iqd);
  const firstId = optionValueIdsInRelationOrder(ids, { groups: (rows.groups ?? []) as unknown as OptionGroupRow[], values: rows.options as unknown as OptionValueRow[] })[0];
  const pricingOption = options.find(option => option.id === firstId);
  cost = selectionCostRung(cost, pricingOption);
  const cells = rows.fulfillments.filter(row => row.option_id === pricingOption?.id && row.enabled === 1);
  if (cells.length) {
    let pricing: CostRow = {}, transport: CostRow = {};
    try {
      pricing = typeof line.pricing_snapshot === 'string' ? JSON.parse(line.pricing_snapshot) ?? {} : {};
      transport = typeof line.transport_snapshot === 'string' ? JSON.parse(line.transport_snapshot) ?? {} : {};
    } catch { return null; }
    const declared = (pricing.fulfillment as CostRow | undefined)?.type;
    const direct = cells.find(row => row.fulfillment_type === 'direct_sale');
    const type = pricing.pricing_basis === 'preorder' ? 'pre_order'
      : pricing.pricing_basis === 'direct' ? (declared === 'pre_order' && !direct ? 'pre_order' : 'direct_sale')
      : declared === 'direct_sale' ? 'direct_sale'
      : declared === 'pre_order' ? null
      : line.order_shipping_type === 'direct' ? 'direct_sale' : null;
    // Pre-order COD may use the direct cell, while prepaid uses its own
    // transport ladder. Without the saved pricing basis these disagree.
    if (!type) return null;
    const cell = cells.find(row => row.fulfillment_type === type);
    if (!cell) return null;
    cost = selectionCostRung(cost, cell);
    if (type === 'pre_order' && cell) {
      const routes = (rows.transports ?? []).filter(row => row.fulfillment_id === cell.id && row.enabled === 1);
      const method = transport.method ?? (pricing.transport as CostRow | undefined)?.method;
      if (routes.length && !['air', 'sea', 'land'].includes(String(method))) return null;
      const route = routes.find(row => row.method === method);
      if (routes.length && !route) return null;
      cost = selectionCostRung(cost, route);
    }
  }
  cost = selectionCostRung(cost, colors[0]);
  cost = selectionCostRung(cost, variant);
  return { product_id: String(product.id), scope, scope_id: scopeId, unit_cost_iqd: cost };
}
export async function productSelections(db: D1Database, productId: string): Promise<Selection[]> {
  const p = await db
    .prepare('SELECT * FROM products WHERE id=?')
    .bind(productId)
    .first<Record<string, unknown>>();
  if (!p) throw notFound('Product not found');
  if (p.composition)
    throw badRequest('اختر المنتج الفعلي؛ الحزم لا تملك مخزونًا منفصلًا', 'COMPOSITION_STOCK');
  const scopes: Record<string, StockScope> = {
    BASE: 'base',
    OPTION: 'option',
    COLOR: 'color',
    VARIANT_COMBINATION: 'variant',
  };
  const scope = scopes[String(p.inventory_mode)];
  if (!scope) throw badRequest('Invalid inventory mode');
  const [options, colors, variants] = await Promise.all(
    ['product_option_values', 'product_colors', 'product_variants'].map((t) =>
      db.prepare(`SELECT * FROM ${t} WHERE product_id=? AND active=1`).bind(productId).all<Cell>(),
    ),
  );
  const opts = options.results ?? [],
    cols = colors.results ?? [];
  const fulfillments =
    (
      await db
        .prepare(
          "SELECT f.* FROM product_option_fulfillment f JOIN product_option_values o ON o.id=f.option_id WHERE o.product_id=? AND f.fulfillment_type='direct_sale' AND f.enabled=1",
        )
        .bind(productId)
        .all<Cell & { option_id: string }>()
    ).results ?? [];
  const cells: Cell[] =
    scope === 'base'
      ? [
          {
            ...p,
            id: productId,
            regular_price_iqd: Number(p.price_iqd),
            cost_iqd: p.product_cost_iqd as number | null,
            stock: p.stock as number | null,
            reserved: Number(p.stock_reserved),
          },
        ]
      : scope === 'option'
        ? opts.filter((o) => !o.merged_into)
        : scope === 'color'
          ? cols
          : (variants.results ?? []);
  const latest =
    (
      await db
        .prepare(
          `SELECT i.scope,i.scope_id,COALESCE(i.purchase_total_iqd*1.0/i.qty_ordered,i.purchase_unit_iqd) AS purchase_unit_iqd,COALESCE(i.purchase_date,i.updated_at) AS cost_date FROM incoming_inventory i LEFT JOIN purchase_lines pl ON pl.incoming_id=i.id LEFT JOIN purchase_orders po ON po.id=pl.purchase_id WHERE i.product_id=? AND i.qty_received>0 AND i.status<>'cancelled' AND (po.id IS NULL OR po.cost_state='final') ORDER BY COALESCE(i.purchase_date,i.updated_at) DESC,i.id DESC`,
        )
        .bind(productId)
        .all<{ scope: string; scope_id: string; purchase_unit_iqd: number;cost_date:string }>()
    ).results ?? [];
  const images=(await db.prepare('SELECT * FROM product_images WHERE product_id=? ORDER BY sort_order,id').bind(productId).all<ImageRow>()).results??[];
  const out: Selection[] = [];
  for (const cell of cells) {
    let regular = Number(p.price_iqd),
      cost = p.product_cost_iqd as number | null;
    const apply = (r: Cell | undefined) => {
      if (!r) return;
      regular = derivedRung(r as unknown as PriceFields, { regular, prime: null, pro: null }).regular;
      cost = selectionCostRung(cost, r);
    };
    let option: Cell | undefined, color: Cell | undefined;
    if (scope === 'variant') {
      const parts = new Set(String(cell.combo_key).split('|'));
      const optionIds = opts.filter((o) => parts.has(`o:${o.id}`));
      option = optionIds[0];
      color = cols.find((c) => parts.has(`c:${c.id}`));
      apply(option);
      apply(fulfillments.find((f) => f.option_id === option?.id));
      apply(color);
      apply(cell);
    } else {
      apply(cell);
      if (scope === 'option') apply(fulfillments.find((f) => f.option_id === cell.id));
    }
    regular += Number(p.direct_surcharge_iqd ?? 0);
    const scopeId = scope === 'base' ? '' : cell.id;
    const last = latest.find((l) => l.scope === scope && l.scope_id === scopeId);
    const weight = Number(
      cell.package_weight_g ?? cell.net_weight_g ?? p.package_weight_g ?? p.net_weight_g ?? 0,
    );
    const dim = (k: string) =>
      Number(cell[`package_${k}_mm`] ?? cell[`${k}_mm`] ?? p[`package_${k}_mm`] ?? p[`${k}_mm`] ?? 0);
    const name = String(p.name_ar || p.name);
    const detail =
      scope === 'variant'
        ? [option?.name_ar || option?.name_en, color?.name_ar || color?.name_en]
            .filter(Boolean)
            .join(' / ') || String(cell.sku || cell.combo_key)
        : scope === 'base'
          ? ''
          : cell.name_ar || cell.name_en;
    out.push({
      product_id: productId,
      scope,
      scope_id: scopeId,
      label: [name, detail].filter(Boolean).join(' · '),
      sku: String(cell.sku ?? cell.sku_part ?? p.sku ?? ''),
      stock: cell.stock,
      reserved: cell.reserved,
      selling_price_iqd: regular,
      unit_cost_iqd: cost,
      purchase_unit_iqd: last?.purchase_unit_iqd ?? cost,
      cost_source: last ? 'confirmed_purchase' : cost !== null ? 'catalogue' : 'unknown',
      cost_date:last?.cost_date??null,
      image_url:productImageFromRelations(images,{optionValueIds:option?[option.id]:scope==='option'?[cell.id]:[],colorId:color?.id??(scope==='color'?cell.id:null)},(variants.results??[]) as unknown as VariantRow[]),
      weight_g: weight,
      volume_mm3: dim('width') * dim('depth') * dim('height'),
      option_id: option?.id??(scope==='option'?cell.id:undefined),
      color_id: color?.id??(scope==='color'?cell.id:undefined),
    });
  }
  return out;
}
export async function requireSelection(db: D1Database, productId: string, scope: string, scopeId: string) {
  const selection = (await productSelections(db, productId)).find(
    (s) => s.scope === scope && s.scope_id === (scope === 'base' ? '' : scopeId),
  );
  if (!selection)
    throw badRequest('الخيار أو اللون لا ينتمي للمنتج أو لا يمثل مخزونه الحالي', 'INVALID_SELECTION');
  return selection;
}
export async function selectionStock(
  db: D1Database,
  selection: Pick<Selection, 'product_id' | 'scope' | 'scope_id'>,
) {
  const target = counterTarget(selection.scope)!;
  return db
    .prepare(
      `SELECT stock,${selection.scope === 'base' ? 'stock_reserved' : 'reserved'} AS reserved FROM ${target.table} WHERE id=?`,
    )
    .bind(selection.scope === 'base' ? selection.product_id : selection.scope_id)
    .first<{ stock: number | null; reserved: number }>();
}
