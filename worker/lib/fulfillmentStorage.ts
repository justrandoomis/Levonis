import { parseFulfillment, type ModelFulfillment, type FulfillmentType } from '@levonis/pricing/fulfillment';
import type { OptionValueRow } from './productRelations';

export interface StoredModelFulfillment { model_id: string; product_id: string; config_json: string }
export interface ModelFulfillmentAlias { legacy_option_id: string; product_id: string; model_id: string; fulfillment_type: FulfillmentType }
export interface ModelFulfillmentRows { configurations: StoredModelFulfillment[]; aliases: ModelFulfillmentAlias[] }

export class FulfillmentStorageError extends Error {
  constructor(cause: unknown) { super('Fulfillment configuration could not be read safely', { cause }); this.name = 'FulfillmentStorageError'; }
}
export const isFulfillmentStorageError = (error: unknown): boolean => error instanceof FulfillmentStorageError;

/** Two indexed reads per page, never one request for every product/model. Missing
 * 0072 is the only compatible fallback; corruption/driver faults fail CLOSED.
 */
export async function loadModelFulfillmentRows(db: D1Database, productIds: string[]): Promise<ModelFulfillmentRows> {
  const ids = [...new Set(productIds)].filter(Boolean);
  const out: ModelFulfillmentRows = { configurations: [], aliases: [] };
  for (let offset = 0; offset < ids.length; offset += 80) {
    const part = ids.slice(offset, offset + 80), placeholders = part.map(() => '?').join(',');
    try {
      const [configs, aliases] = await Promise.all([
        db.prepare(`SELECT model_id, product_id, config_json FROM product_model_fulfillment WHERE product_id IN (${placeholders})`).bind(...part).all<StoredModelFulfillment>(),
        db.prepare(`SELECT legacy_option_id, product_id, model_id, fulfillment_type FROM product_option_legacy_map WHERE product_id IN (${placeholders})`).bind(...part).all<ModelFulfillmentAlias>(),
      ]);
      out.configurations.push(...configs.results); out.aliases.push(...aliases.results);
    } catch (error) {
      const message = error instanceof Error ? `${error.message} ${String(error.cause ?? '')}` : String(error);
      if (/no such table:\s*(?:main\.)?(?:product_model_fulfillment|product_option_legacy_map)\b/i.test(message)) return { configurations: [], aliases: [] };
      throw new FulfillmentStorageError(error);
    }
  }
  return out;
}

/** The stock field is projected from the existing ledger's owner row, NEVER a
 * second inventory counter in config_json. Archived aliases are not new models.
 */
export function enrichModelFulfillmentValues(values: OptionValueRow[], rows: ModelFulfillmentRows): OptionValueRow[] {
  const configs = new Map(rows.configurations.map(row => [row.model_id, row]));
  const hidden = new Set(rows.aliases.filter(row => row.legacy_option_id !== row.model_id).map(row => row.legacy_option_id));
  const aliases = new Map<string, NonNullable<OptionValueRow['legacy_fulfillment_ids']>>();
  for (const alias of rows.aliases) {
    if (alias.legacy_option_id === alias.model_id) continue;
    const list = aliases.get(alias.model_id) ?? [];
    list.push({ id: alias.legacy_option_id, fulfillment_type: alias.fulfillment_type }); aliases.set(alias.model_id, list);
  }
  return values.filter(row => !hidden.has(row.id)).map(row => {
    const stored = configs.get(row.id);
    if (!stored) return row;
    if (stored.product_id !== row.product_id) throw new FulfillmentStorageError('Model owner mismatch');
    let config: ModelFulfillment | undefined;
    try { config = parseFulfillment(stored.config_json); } catch (error) { throw new FulfillmentStorageError(error); }
    if (!config) throw new FulfillmentStorageError('Stored configuration is absent');
    if (config.direct) config.direct.stock = row.stock;
    return { ...row, fulfillment: config, legacy_fulfillment_ids: aliases.get(row.id) ?? [] };
  });
}

/** Statement planner, not an independent save. The caller appends this AFTER
 * its model INSERT/UPDATE in the SAME product/relations transaction.
 */
export function modelFulfillmentWriteStatements(db: D1Database, productId: string, modelId: string, config: ModelFulfillment | null): D1PreparedStatement[] {
  if (config === null) return [db.prepare('DELETE FROM product_model_fulfillment WHERE product_id = ? AND model_id = ?').bind(productId, modelId)];
  const cleaned = parseFulfillment(config)!;
  if (cleaned.direct) delete cleaned.direct.stock;
  return [db.prepare(
    `INSERT INTO product_model_fulfillment (model_id, product_id, schema_version, config_json)
     VALUES (?, ?, 2, ?)
     ON CONFLICT(model_id) DO UPDATE SET config_json = excluded.config_json, updated_at = datetime('now')
     WHERE product_model_fulfillment.product_id = excluded.product_id`
  ).bind(modelId, productId, JSON.stringify(cleaned))];
}

/** Explicit cost fields in a submitted patch are protected; omitted fields
 * keep their stored value, including cost in a hidden assistant-admin input.
 */
export function fulfillmentFinancialPaths(config: unknown, prefix = 'fulfillment'): Array<{ path: string; value: unknown }> {
  if (!config || typeof config !== 'object' || Array.isArray(config)) return [];
  return Object.entries(config).flatMap(([key, value]) => key === 'cost_iqd' || key === 'cost_adjust_iqd'
    ? [{ path: `${prefix}.${key}`, value }]
    : fulfillmentFinancialPaths(value, `${prefix}.${key}`));
}

/** Merge a configuration patch while preserving omitted paths. Explicit null
 * means inheritance for a field; null on the whole config clears its override.
 */
export function mergeFulfillmentWrite(previous: ModelFulfillment | undefined, patch: ModelFulfillment | null | undefined, money: boolean): { config: ModelFulfillment | undefined; refused: string[] } {
  if (patch === undefined) return { config: previous ? parseFulfillment(previous) : undefined, refused: [] };
  const before = new Map(fulfillmentFinancialPaths(previous).map(row => [row.path, row.value]));
  const refused = money ? [] : fulfillmentFinancialPaths(patch).filter(row => (before.get(row.path) ?? null) !== (row.value ?? null)).map(row => row.path);
  if (patch === null) {
    if (!money && [...before.values()].some(value => value !== null && value !== undefined)) return { config: parseFulfillment(previous), refused: ['fulfillment: financial fields cannot be cleared by this account'] };
    return { config: undefined, refused };
  }
  const raw = parseFulfillment(patch)!;
  function merge(base: unknown, next: unknown): unknown {
    if (!next || typeof next !== 'object' || Array.isArray(next)) return next;
    const stored = base && typeof base === 'object' && !Array.isArray(base) ? base as Record<string, unknown> : {};
    const out: Record<string, unknown> = { ...stored };
    for (const [key, value] of Object.entries(next as Record<string, unknown>)) {
      if (!money && (key === 'cost_iqd' || key === 'cost_adjust_iqd')) continue;
      out[key] = merge(stored[key], value);
      // Selecting a new price mode explicitly clears its old counterpart.
      if (value !== null && value !== undefined && /^(?:regular|prime|pro|cost)_adjust_iqd$/.test(key)) out[key.replace('_adjust_iqd', key.startsWith('cost_') ? '_iqd' : '_price_iqd')] = null;
      if (value !== null && value !== undefined && /^(?:regular|prime|pro)_price_iqd$/.test(key)) out[key.replace('_price_iqd', '_adjust_iqd')] = null;
      if (key === 'cost_iqd' && value !== null && value !== undefined) out.cost_adjust_iqd = null;
    }
    return out;
  }
  return { config: parseFulfillment(merge(previous, raw)), refused };
}
