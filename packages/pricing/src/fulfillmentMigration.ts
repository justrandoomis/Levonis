import { parseFulfillment, type ModelFulfillment, type FulfillmentOffer, type FulfillmentType } from './fulfillment';
import { variantLabelFallback } from './availability';

export interface LegacyModelInput {
  id: string;
  name_en: string;
  name_ar?: string;
  name_ckb?: string;
  group_id?: string;
  group_en?: string;
  variant_key?: string;
  variant_label?: string;
  availability_type?: string;
  fulfillment?: ModelFulfillment;
  reserved?: number;
  [key: string]: unknown;
}
export interface LegacyModelAlias {
  legacy_option_id: string;
  model_id: string;
  fulfillment_type: FulfillmentType;
  original: LegacyModelInput;
}
export interface LegacyNormalizationPlan {
  models: LegacyModelInput[];
  aliases: LegacyModelAlias[];
  conflicts: Array<{ key: string; ids: string[]; reason: string }>;
  changed: boolean;
}

/** Plans only. Never deletes or updates rows, orders, reservations or snapshots.
 * Group-scoped explicit variant keys are the ONLY merge signal. Similar names
 * alone are insufficient evidence that two SKUs describe the same model.
 * The write-side caller must also check linked colors/combinations and holds.
 */
export function planLegacyModelNormalization(rows: LegacyModelInput[]): LegacyNormalizationPlan {
  const groups = new Map<string, LegacyModelInput[]>();
  const result: LegacyNormalizationPlan = { models: [], aliases: [], conflicts: [], changed: false };
  const ids = new Set<string>();
  for (const row of rows) {
    if (!row.id || ids.has(row.id)) {
      result.conflicts.push({ key: row.id, ids: [row.id], reason: 'MISSING_OR_DUPLICATE_ID' });
      continue;
    }
    ids.add(row.id);
    const key = row.variant_key?.trim();
    const scoped = key ? JSON.stringify([row.group_id ?? row.group_en ?? '', key]) : JSON.stringify(['unkeyed', row.id]);
    const grouped = groups.get(scoped) ?? [];
    grouped.push(row); groups.set(scoped, grouped);
  }
  const clone = (r: LegacyModelInput): LegacyModelInput => JSON.parse(JSON.stringify(r)) as LegacyModelInput;
  for (const [key, group] of groups) {
    const legacy = group.filter(row => row.availability_type === 'direct_sale' || row.availability_type === 'pre_order');
    if (!legacy.length) { result.models.push(...group.map(clone)); continue; }
    let reason = '';
    if (legacy.length !== group.length) reason = 'STRUCTURED_AND_LEGACY_MODEL_COLLISION';
    const direct = legacy.filter(row => row.availability_type === 'direct_sale');
    const pre = legacy.filter(row => row.availability_type === 'pre_order');
    if (direct.length > 1 || pre.length > 1) reason = 'DUPLICATE_FULFILLMENT_ROWS';
    if (legacy.some(row => row.fulfillment && Object.keys(row.fulfillment).length)) reason = 'ROW_ALREADY_HAS_FULFILLMENT';
    const canonical = direct[0] ?? pre[0];
    if (legacy.some(row => row.id !== canonical?.id && Number(row.reserved ?? 0) > 0)) reason = 'LEGACY_ROW_HAS_RESERVATIONS';
    if (reason) {
      result.conflicts.push({ key, ids: group.map(row => row.id), reason });
      result.models.push(...group.map(clone)); continue;
    }
    function branch(row: LegacyModelInput | undefined): FulfillmentOffer {
      if (!row) return { enabled: false };
      const offer: Record<string, unknown> = { enabled: row.active !== false && row.active !== 0 };
      for (const field of ['regular_price_iqd','prime_price_iqd','pro_price_iqd','cost_iqd','regular_adjust_iqd','prime_adjust_iqd','pro_adjust_iqd','cost_adjust_iqd','lead_time_text','lead_time_min_days','lead_time_max_days','image']) {
        if (row[field] !== undefined) offer[field] = row[field];
      }
      if (row.sku !== undefined || row.sku_part !== undefined) offer.sku = row.sku ?? row.sku_part;
      if (row.availability_type === 'direct_sale' && row.stock !== undefined) offer.stock = row.stock;
      return offer as FulfillmentOffer;
    }
    const base = pre[0] ?? canonical;
    const model = clone(base);
    model.id = canonical.id; // Keep the direct inventory target and its holds.
    if (canonical.reserved !== undefined) model.reserved = canonical.reserved;
    else delete model.reserved;
    model.stock = direct[0]?.stock ?? null;
    model.active = legacy.some(row => row.active !== false && row.active !== 0);
    model.name_en = canonical.variant_label?.trim() || variantLabelFallback(canonical.name_en);
    if (canonical.name_ar) model.name_ar = variantLabelFallback(canonical.name_ar);
    if (canonical.name_ckb) model.name_ckb = variantLabelFallback(canonical.name_ckb);
    model.availability_type = '';
    model.fulfillment = parseFulfillment({ direct: branch(direct[0]), preorder: branch(pre[0]) });
    result.models.push(model);
    for (const row of legacy) result.aliases.push({ legacy_option_id: row.id, model_id: model.id, fulfillment_type: row.availability_type as FulfillmentType, original: clone(row) });
    result.changed = true;
  }
  // A caller must never publish a partly merged product after a conflict.
  if (result.conflicts.length) return { ...result, models: rows.map(clone), aliases: [], changed: false };
  return result;
}
