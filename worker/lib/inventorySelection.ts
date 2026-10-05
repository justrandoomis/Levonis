import { productImageFromRelations } from './productSelectionImage';
import type { ImageRow,VariantRow } from './productOverlay';
import { badRequest, notFound } from './http';
import { derivedRung, type PriceFields } from './pricing';
import { counterTarget } from './inventoryReceiving';
import type { StockScope } from './inventory';

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
      cost =
        r.cost_iqd ??
        (r.cost_adjust_iqd !== null && r.cost_adjust_iqd !== undefined && cost !== null
          ? Math.max(0, cost + r.cost_adjust_iqd)
          : cost);
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
