import type { CategoryDeliveryRule, ProductDeliveryMethod } from './shipping';
import { degradeIfSchemaMissing } from './membershipBenefits';

/**
 * CATEGORY-LEVEL QUANTITY DELIVERY RULES (migration 0135) — storage and
 * validation. The pricing itself is pure: `quoteShipping` in
 * packages/shipping/src/shipping.ts pools every unit filed under a ruled
 * section and charges ceil(units / quantity_step) × fee_per_step_iqd.
 *
 * Read once per checkout, beside the benefit rules and the section tree, so
 * the quote and the placement read the same rows and price identically. A
 * database without 0135 degrades to "no rules", i.e. exactly the pricing it
 * had before the feature existed.
 */

export const CATEGORY_DELIVERY_METHODS: readonly ProductDeliveryMethod[] = ['standard', 'personal'];
export const CATEGORY_DELIVERY_MAX_STEP = 100000;
export const CATEGORY_DELIVERY_MAX_FEE = 100000000;

interface Row {
  catalog_id: string;
  method: string;
  enabled: number;
  quantity_step: number;
  fee_per_step_iqd: number;
}

function fromRow(row: Row): CategoryDeliveryRule | null {
  if (row.method !== 'standard' && row.method !== 'personal') return null;
  const step = Math.trunc(Number(row.quantity_step));
  const fee = Math.trunc(Number(row.fee_per_step_iqd));
  if (!Number.isFinite(step) || step < 1 || !Number.isFinite(fee) || fee < 0) return null;
  return {
    catalog_id: String(row.catalog_id),
    method: row.method,
    enabled: Number(row.enabled) === 1,
    quantity_step: step,
    fee_iqd: fee,
  };
}

/** Every rule, disabled ones included — the admin's view. */
export async function allCategoryDeliveryRules(db: D1Database): Promise<CategoryDeliveryRule[]> {
  return degradeIfSchemaMissing(
    'category_delivery_rules (migration 0135)',
    async () => {
      const { results } = await db
        .prepare('SELECT catalog_id, method, enabled, quantity_step, fee_per_step_iqd FROM category_delivery_rules ORDER BY catalog_id, method')
        .all<Row>();
      return (results ?? []).map(fromRow).filter((r): r is CategoryDeliveryRule => r !== null);
    },
    [] as CategoryDeliveryRule[]
  );
}

/** The rules a checkout applies: switched on, on an active section. */
export async function activeCategoryDeliveryRules(db: D1Database): Promise<CategoryDeliveryRule[]> {
  return degradeIfSchemaMissing(
    'category_delivery_rules (migration 0135)',
    async () => {
      const { results } = await db
        .prepare(
          `SELECT r.catalog_id, r.method, r.enabled, r.quantity_step, r.fee_per_step_iqd
             FROM category_delivery_rules r
             JOIN catalogs c ON c.id = r.catalog_id
            WHERE r.enabled = 1 AND c.active = 1`
        )
        .all<Row>();
      return (results ?? []).map(fromRow).filter((r): r is CategoryDeliveryRule => r !== null);
    },
    [] as CategoryDeliveryRule[]
  );
}

export type CategoryRuleInput =
  | { ok: true; method: ProductDeliveryMethod; enabled: boolean; quantity_step: number; fee_iqd: number }
  | { ok: false; code: 'CATEGORY_DELIVERY_METHOD_INVALID' | 'CATEGORY_DELIVERY_STEP_INVALID' | 'CATEGORY_DELIVERY_FEE_INVALID' };

/** One rule from an admin request body, validated to the migration's CHECKs. */
export function parseCategoryRuleInput(raw: unknown): CategoryRuleInput {
  const b = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const method = b.method;
  if (method !== 'standard' && method !== 'personal') return { ok: false, code: 'CATEGORY_DELIVERY_METHOD_INVALID' };
  const step = Number(b.quantity_step);
  if (!Number.isInteger(step) || step < 1 || step > CATEGORY_DELIVERY_MAX_STEP) {
    return { ok: false, code: 'CATEGORY_DELIVERY_STEP_INVALID' };
  }
  const fee = Number(b.fee_iqd);
  if (!Number.isInteger(fee) || fee < 0 || fee > CATEGORY_DELIVERY_MAX_FEE) {
    return { ok: false, code: 'CATEGORY_DELIVERY_FEE_INVALID' };
  }
  return { ok: true, method, enabled: b.enabled !== false, quantity_step: step, fee_iqd: fee };
}
