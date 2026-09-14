import { badRequest } from './http';
import type { ModelAvailability, FulfillmentPricing, ModelPreorder, ModelTransport } from '@levonis/pricing/fulfillment';
import type { OptionV2 } from './pricing';
import { normalizeAvailability, variantLabelFallback } from './availability';

const PRICE_KEYS = ['regular_price_iqd', 'prime_price_iqd', 'pro_price_iqd', 'cost_iqd', 'regular_adjust_iqd', 'prime_adjust_iqd', 'pro_adjust_iqd', 'cost_adjust_iqd'] as const;

function pricing(raw: unknown, path: string): FulfillmentPricing {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw badRequest(`${path}: expected an object`);
  const r = raw as Record<string, unknown>;
  if (typeof r.enabled !== 'boolean') throw badRequest(`${path}.enabled: expected a boolean`);
  const out: FulfillmentPricing = { enabled: r.enabled };
  for (const k of [...PRICE_KEYS, 'stock', 'lead_time_min_days', 'lead_time_max_days'] as const) {
    const v = r[k];
    if (v == null || v === '') { out[k] = null; continue; }
    const max = k.includes('days') ? 3650 : 2_000_000_000;
    if (typeof v !== 'number' || !Number.isSafeInteger(v) || Math.abs(v) > max || (!k.includes('adjust') && v < 0)) throw badRequest(`${path}.${k}: invalid integer`);
    out[k] = v;
  }
  for (const k of ['lead_time_text', 'image', 'sku_part'] as const) {
    if (r[k] !== undefined && (typeof r[k] !== 'string' || (r[k] as string).length > 1000)) throw badRequest(`${path}.${k}: invalid text`);
    out[k] = String(r[k] ?? '');
  }
  if (out.lead_time_min_days != null && out.lead_time_max_days != null && out.lead_time_min_days > out.lead_time_max_days) throw badRequest(`${path}: min days exceeds max days`);
  for (const tier of ['regular', 'prime', 'pro'] as const) if (out[`${tier}_price_iqd`] != null) out[`${tier}_adjust_iqd`] = null;
  return out;
}

export function readModelAvailability(raw: Record<string, unknown>, path = 'option'): ModelAvailability {
  const out: ModelAvailability = {};
  if (raw.direct !== undefined) out.direct = pricing(raw.direct, `${path}.direct`);
  if (raw.preorder !== undefined) {
    const source = raw.preorder as Record<string, unknown>;
    const pre: ModelPreorder = pricing(source, `${path}.preorder`);
    if (source.transports !== undefined) {
      if (!Array.isArray(source.transports) || source.transports.length > 3) throw badRequest(`${path}.preorder.transports: expected at most three methods`);
      const seen = new Set<string>();
      pre.transports = source.transports.map((v, i) => {
        const t = v as Record<string, unknown>;
        const where = `${path}.preorder.transports.${i + 1}`;
        if (!['air', 'sea', 'land'].includes(String(t.method)) || seen.has(String(t.method))) throw badRequest(`${where}: invalid or duplicate method`);
        seen.add(String(t.method));
        const surcharge = t.surcharge_iqd ?? t.commission_iqd ?? null;
        if (surcharge !== null && (typeof surcharge !== 'number' || !Number.isSafeInteger(surcharge) || Math.abs(surcharge) > 2_000_000_000)) throw badRequest(`${where}.surcharge_iqd: invalid integer`);
        return { ...pricing(t, where), method: t.method as ModelTransport['method'], surcharge_iqd: surcharge as number | null };
      });
    }
    out.preorder = pre;
  }
  return out;
}

/** Input-only compatibility adapter. New rows are always real models. */
export function mergeLegacyModels(options: OptionV2[]): { options: OptionV2[]; aliases: Map<string, string> } {
  const byKey = new Map<string, OptionV2[]>();
  for (const o of options) {
    const key = normalizeAvailability(o.availability_type) ? o.variant_key || o.id : o.id;
    const group = byKey.get(key) ?? []; group.push(o); byKey.set(key, group);
  }
  const aliases = new Map<string, string>();
  const merged: OptionV2[] = [];
  for (const rows of byKey.values()) {
    if (!rows.some((r) => normalizeAvailability(r.availability_type))) { merged.push(...rows); continue; }
    const base = rows.find((r) => normalizeAvailability(r.availability_type) === 'pre_order') ?? rows[0];
    const model: OptionV2 = { ...base, name_en: base.variant_label || variantLabelFallback(base.name_en), name_ar: variantLabelFallback(base.name_ar), name_ckb: variantLabelFallback(base.name_ckb), availability_type: '', active: rows.some((r) => r.active), stock: null, direct: { enabled: false }, preorder: { enabled: false } };
    const seen = new Set<string>();
    for (const r of rows) {
      const kind = normalizeAvailability(r.availability_type);
      if (!kind || seen.has(kind)) throw badRequest(`Model ${base.variant_key}: ambiguous legacy availability rows`);
      seen.add(kind); aliases.set(r.id, base.id);
      const f: FulfillmentPricing = { enabled: r.active, stock: r.stock, image: r.image, sku_part: r.sku_part, lead_time_text: r.lead_time_text, lead_time_min_days: r.lead_time_min_days, lead_time_max_days: r.lead_time_max_days };
      for (const key of PRICE_KEYS) f[key] = r[key];
      if (kind === 'direct_sale') model.direct = f; else model.preorder = f;
    }
    merged.push(model);
  }
  return { options: merged, aliases };
}

export { PRICE_KEYS as FULFILLMENT_PRICE_KEYS };

export async function attachModelAvailability<T extends { id: string }>(db: D1Database, values: T[]): Promise<Array<T & ModelAvailability>> {
  if (!values.length) return values;
  const out: Array<T & ModelAvailability> = values.map((v) => ({ ...v }));
  for (let i = 0; i < out.length; i += 80) {
    const part = out.slice(i, i + 80);
    const ids = part.map((v) => v.id);
    const ph = ids.map(() => '?').join(',');
    let loaded;
    try { loaded = await Promise.all([
      db.prepare(`SELECT * FROM product_option_fulfillment WHERE option_id IN (${ph})`).bind(...ids).all<Record<string, unknown>>(),
      db.prepare(`SELECT * FROM product_option_transports WHERE option_id IN (${ph}) ORDER BY method`).bind(...ids).all<Record<string, unknown>>(),
    ]); } catch (error) {
      if (/no such table: (product_option_fulfillment|product_option_transports)/.test(String(error))) continue;
      throw error;
    }
    const [fulfillments, transports] = loaded;
    for (const value of part) for (const f of fulfillments.results.filter((r) => r.option_id === value.id)) {
      const parsed = pricing({ ...f, enabled: !!f.enabled }, 'fulfillment');
      parsed.id = String(f.id); parsed.reserved = Number(f.reserved ?? 0);
      if (f.fulfillment_type === 'direct_sale') value.direct = parsed;
      else value.preorder = {
        ...parsed,
        ...(f.transports_override ? { transports: transports.results.filter((t) => t.fulfillment_id === f.id).map((t) => ({ ...pricing({ ...t, enabled: !!t.enabled }, 'transport'), id: String(t.id), method: t.method as ModelTransport['method'], surcharge_iqd: t.surcharge_iqd as number | null })) } : {}),
      };
    }
  }
  return out;
}

/** Called inside the existing atomic product-save batch, after the model row. */
export function modelAvailabilityStatements(db: D1Database, productId: string, optionId: string, model: ModelAvailability, money: boolean): D1PreparedStatement[] {
  const statements: D1PreparedStatement[] = [];
  for (const [key, kind] of [['direct', 'direct_sale'], ['preorder', 'pre_order']] as const) {
    const f = model[key];
    if (f === undefined) continue; // old clients preserve existing nested data
    const id = `ful_${optionId}_${kind}`;
    const cols = ['id', 'product_id', 'option_id', 'fulfillment_type', 'enabled', ...PRICE_KEYS, 'stock', 'image', 'sku_part', 'lead_time_text', 'lead_time_min_days', 'lead_time_max_days', 'transports_override'];
    const args = [id, productId, optionId, kind, f.enabled ? 1 : 0, ...PRICE_KEYS.map((k) => !money && k.startsWith('cost') ? null : f[k] ?? null), f.stock ?? null, f.image ?? '', f.sku_part ?? '', f.lead_time_text ?? '', f.lead_time_min_days ?? null, f.lead_time_max_days ?? null, key === 'preorder' && (f as ModelPreorder).transports !== undefined ? 1 : 0];
    const update = cols.slice(4).filter((k) => money || !k.startsWith('cost')).map((k) => `${k}=excluded.${k}`).join(',');
    statements.push(db.prepare(`INSERT INTO product_option_fulfillment (${cols.join(',')}) VALUES (${cols.map(() => '?').join(',')}) ON CONFLICT(product_id,option_id,fulfillment_type) DO UPDATE SET ${update}`).bind(...args));
    if (key === 'preorder') {
      const methods = (f as ModelPreorder).transports?.map((t) => t.method) ?? [];
      statements.push(db.prepare(`DELETE FROM product_option_transports WHERE fulfillment_id=? ${methods.length ? `AND method NOT IN (${methods.map(() => '?').join(',')})` : ''}`).bind(id, ...methods));
      for (const t of (f as ModelPreorder).transports ?? []) {
        const tc = ['id', 'product_id', 'option_id', 'fulfillment_id', 'method', 'enabled', 'surcharge_iqd', ...PRICE_KEYS, 'lead_time_text', 'lead_time_min_days', 'lead_time_max_days'];
        const ta = [`${id}_${t.method}`, productId, optionId, id, t.method, t.enabled ? 1 : 0, t.surcharge_iqd ?? null, ...PRICE_KEYS.map((k) => !money && k.startsWith('cost') ? null : t[k] ?? null), t.lead_time_text ?? '', t.lead_time_min_days ?? null, t.lead_time_max_days ?? null];
        statements.push(db.prepare(`INSERT INTO product_option_transports (${tc.join(',')}) VALUES (${tc.map(() => '?').join(',')}) ON CONFLICT(fulfillment_id,method) DO UPDATE SET ${tc.slice(5).filter((k) => money || !k.startsWith('cost')).map((k) => `${k}=excluded.${k}`).join(',')}`).bind(...ta));
      }
    }
  }
  return statements;
}
