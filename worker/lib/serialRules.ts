/**
 * SERIAL FORMAT RULES — the Worker's half (owner decision 2, 2026-10-09;
 * migration 0180 `serial_brand_rules`; docs/DECISIONS.md row 195). The format
 * itself, the parser and the evaluator are pure and shared with the screens:
 * packages/catalog/src/serialRules.ts.
 *
 * ONE RESOLUTION, EVERY DOOR. The preparation scan and change, the owner's
 * exception, the post-delivery door, a replacement that names a new serial,
 * Bulk Add's preview and commit and the inventory camera all ask this file
 * which rule judges the serial they hold — the product's own rule, else its
 * brand's (`products.brand_id`), else GENERIC_RULE — in ONE query each.
 *
 * DEPLOY-AHEAD. Before migration 0180 has applied, every answer is
 * LEGACY_RULE: today's behaviour exactly (the Bambu box refusal and the
 * five-prefix family check for every product, no warnings). Whether the
 * table exists is cached per database binding ONLY when true — the pattern
 * of `serialAssignmentsInstalled` (worker/lib/serialPolicy.ts): a cached
 * `false` would keep judging by the legacy rule after the migration landed
 * under a live isolate. A read that fails for any other reason answers the
 * legacy rule too — never a looser one.
 */
import {
  GENERIC_RULE,
  LEGACY_RULE,
  RULE_LEN_MAX,
  RULE_LEN_MIN,
  type SerialPosition,
  type SerialPrefix,
  type SerialRule,
} from '@levonis/catalog/serialRules';

export { GENERIC_RULE, LEGACY_RULE };

const installed = new WeakMap<object, true>();

/** Has migration 0180 applied? Cached only when true. */
export async function serialRulesInstalled(db: D1Database): Promise<boolean> {
  if (installed.has(db as object)) return true;
  try {
    const row = await db
      .prepare("SELECT 1 AS yes FROM sqlite_master WHERE type='table' AND name='serial_brand_rules'")
      .first<{ yes: number }>();
    if (row) installed.set(db as object, true);
    return !!row;
  } catch {
    return false;
  }
}

/** The columns a rule row is read with, in every query of this file and the routes. */
export const RULE_COLS =
  'id, scope, brand_id, product_id, label, mode, charset, min_len, max_len, lengths, prefixes, prefix_policy, positions, box_sn_shape, family_check, source_note, active, version, updated_by, created_at, updated_at';

/** `RULE_COLS` with a table alias, for a join. */
export const ruleCols = (alias: string) =>
  RULE_COLS.split(',')
    .map((c) => `${alias}.${c.trim()}`)
    .join(', ');

export interface RuleRow {
  id: string;
  scope: string;
  brand_id: string | null;
  product_id: string | null;
  label: string;
  mode: string;
  charset: string;
  min_len: number;
  max_len: number;
  lengths: string;
  prefixes: string;
  prefix_policy: string;
  positions: string;
  box_sn_shape: string;
  family_check: number;
  source_note: string;
  active: number;
  version: number;
  updated_by: string;
  created_at: string;
  updated_at: string;
}

function jsonList(text: string | null | undefined): unknown[] {
  try {
    const v = JSON.parse(String(text ?? '[]'));
    return Array.isArray(v) ? v : [];
  } catch {
    return [];
  }
}

const clampLen = (n: unknown, def: number) => {
  const v = Math.trunc(Number(n));
  return Number.isFinite(v) && v >= RULE_LEN_MIN && v <= RULE_LEN_MAX ? v : def;
};

/**
 * A stored row as the rule the evaluator takes. The table's CHECKs already
 * bound every column; this only reads them defensively (a JSON cell that is
 * not what the parser wrote reads as empty, never as a pattern).
 */
export function ruleFromRow(r: RuleRow): SerialRule {
  const min = clampLen(r.min_len, RULE_LEN_MIN);
  const max = Math.max(min, clampLen(r.max_len, RULE_LEN_MAX));
  const lengths = jsonList(r.lengths)
    .map((n) => Math.trunc(Number(n)))
    .filter((n) => Number.isFinite(n) && n >= RULE_LEN_MIN && n <= RULE_LEN_MAX)
    .slice(0, 6);
  const prefixes: SerialPrefix[] = jsonList(r.prefixes)
    .flatMap((e) => {
      if (!e || typeof e !== 'object') return [];
      const o = e as Record<string, unknown>;
      const p = typeof o.p === 'string' ? o.p.trim().toUpperCase() : '';
      const m = typeof o.m === 'string' ? o.m.trim().slice(0, 40) : '';
      if (!/^[A-Z0-9]{1,6}$/.test(p) || !m) return [];
      const a = Array.isArray(o.a) ? o.a.filter((x): x is string => typeof x === 'string' && !!x.trim()).map((x) => x.trim().slice(0, 40)).slice(0, 4) : [];
      return [a.length ? { p, m, a } : { p, m }];
    })
    .slice(0, 64);
  const positions: SerialPosition[] = jsonList(r.positions)
    .flatMap((e) => {
      if (!e || typeof e !== 'object') return [];
      const o = e as Record<string, unknown>;
      const at = Math.trunc(Number(o.at));
      const len = Math.trunc(Number(o.len));
      const cls = typeof o.cls === 'string' ? o.cls.trim().toUpperCase() : '';
      if (!(at >= 1 && at <= 40 && len >= 1 && len <= 8 && /^[A-Z0-9]{1,8}$/.test(cls))) return [];
      return [{ at, len, cls }];
    })
    .slice(0, 8);
  return {
    id: r.id,
    version: Number(r.version) || 1,
    scope: r.scope === 'product' ? 'product' : 'brand',
    brand_id: r.brand_id ?? null,
    product_id: r.product_id ?? null,
    label: String(r.label ?? ''),
    mode: r.mode === 'off' || r.mode === 'enforce' ? r.mode : 'warn',
    charset: r.charset === 'DIGITS' || r.charset === 'HEX' ? r.charset : 'ALNUM',
    min_len: min,
    max_len: max,
    lengths,
    prefixes,
    prefix_policy: r.prefix_policy === 'known_only' ? 'known_only' : 'hint',
    positions,
    box_sn_shape: r.box_sn_shape === 'bambu' ? 'bambu' : 'none',
    family_check: Number(r.family_check) === 1,
    source_note: String(r.source_note ?? ''),
  };
}

/** The ranked rules of one product: its own first, then its brand's. `pid` is an SQL expression. */
const RULE_MATCH = (pid: string) =>
  `r.active = 1 AND ((r.scope = 'product' AND r.product_id = ${pid})
     OR (r.scope = 'brand' AND r.brand_id IS NOT NULL AND r.brand_id = p.brand_id))`;
const RULE_RANK = `(r.scope <> 'product')`;

/**
 * THE rule that judges a serial filed under this product: its own rule, else
 * its brand's, else GENERIC_RULE. No product (Bulk Add without one, an
 * unidentified label): GENERIC_RULE. Before 0180, or when the read fails:
 * LEGACY_RULE.
 */
export async function ruleForProduct(db: D1Database, productId: string | null | undefined): Promise<SerialRule> {
  if (!(await serialRulesInstalled(db))) return LEGACY_RULE;
  const pid = typeof productId === 'string' ? productId.trim() : '';
  if (!pid) return GENERIC_RULE;
  try {
    const row = await db
      .prepare(
        `SELECT ${ruleCols('r')} FROM products p JOIN serial_brand_rules r ON ${RULE_MATCH('p.id')}
          WHERE p.id = ? ORDER BY ${RULE_RANK} LIMIT 1`
      )
      .bind(pid)
      .first<RuleRow>();
    return row ? ruleFromRow(row) : GENERIC_RULE;
  } catch {
    return LEGACY_RULE;
  }
}

/**
 * `ruleForProduct` for many products in ONE query (the order screen's slots).
 * The key '' holds the rule of a slot with no product — GENERIC_RULE, or
 * LEGACY_RULE before 0180 — the same answer `ruleForProduct(db, null)` gives.
 */
export async function rulesForProducts(db: D1Database, productIds: ReadonlyArray<string | null | undefined>): Promise<Map<string, SerialRule>> {
  const ids = [...new Set(productIds.map((x) => (typeof x === 'string' ? x.trim() : '')).filter(Boolean))].slice(0, 500);
  const out = new Map<string, SerialRule>();
  if (!(await serialRulesInstalled(db))) {
    out.set('', LEGACY_RULE);
    for (const id of ids) out.set(id, LEGACY_RULE);
    return out;
  }
  out.set('', GENERIC_RULE);
  for (const id of ids) out.set(id, GENERIC_RULE);
  if (!ids.length) return out;
  try {
    const { results } = await db
      .prepare(
        `SELECT p.id AS for_product, ${ruleCols('r')}
           FROM products p JOIN serial_brand_rules r ON ${RULE_MATCH('p.id')}
          WHERE p.id IN (SELECT value FROM json_each(?))
          ORDER BY p.id, ${RULE_RANK}`
      )
      .bind(JSON.stringify(ids))
      .all<RuleRow & { for_product: string }>();
    const seen = new Set<string>();
    for (const r of results ?? []) {
      if (seen.has(r.for_product)) continue;
      seen.add(r.for_product);
      out.set(r.for_product, ruleFromRow(r));
    }
  } catch {
    for (const id of ids) out.set(id, LEGACY_RULE);
  }
  return out;
}

/**
 * The rule of an order line's product — the preparation scan, change and the
 * owner's exception read it BEFORE the serial is canonicalised (a box-shaped
 * read is a box number only under a Bambu rule). ONE query. A line that is
 * not this order's reads the generic rule; the link then answers its own 404.
 */
export async function ruleForOrderItem(db: D1Database, orderId: string, orderItemId: string): Promise<SerialRule> {
  if (!(await serialRulesInstalled(db))) return LEGACY_RULE;
  try {
    const row = await db
      .prepare(
        `SELECT ${ruleCols('r')} FROM order_items oi
           JOIN products p ON p.id = oi.product_id
           JOIN serial_brand_rules r ON ${RULE_MATCH('p.id')}
          WHERE oi.id = ? AND oi.order_id = ? ORDER BY ${RULE_RANK} LIMIT 1`
      )
      .bind(String(orderItemId ?? ''), String(orderId ?? ''))
      .first<RuleRow>();
    return row ? ruleFromRow(row) : GENERIC_RULE;
  } catch {
    return LEGACY_RULE;
  }
}

/**
 * The rule of a delivered unit's product — the post-delivery door and the
 * replacement — in ONE query. A unit that does not exist reads the generic
 * rule; the door then answers its own 404.
 */
export async function ruleForUnit(db: D1Database, unitId: string): Promise<SerialRule> {
  if (!(await serialRulesInstalled(db))) return LEGACY_RULE;
  try {
    const row = await db
      .prepare(
        `SELECT ${ruleCols('r')} FROM order_item_units u
           JOIN products p ON p.id = u.product_id
           JOIN serial_brand_rules r ON ${RULE_MATCH('p.id')}
          WHERE u.id = ? ORDER BY ${RULE_RANK} LIMIT 1`
      )
      .bind(String(unitId ?? ''))
      .first<RuleRow>();
    return row ? ruleFromRow(row) : GENERIC_RULE;
  } catch {
    return LEGACY_RULE;
  }
}

/**
 * What the screens receive about the rule that judges a slot or a product:
 * enough to read a lone box-shaped camera read correctly and to say a
 * warning before the round trip. No secret lives in a rule.
 */
export function publicRule(rule: SerialRule) {
  return {
    id: rule.id,
    version: rule.version,
    scope: rule.scope,
    label: rule.label,
    mode: rule.mode,
    box_sn_shape: rule.mode === 'off' ? 'none' : rule.box_sn_shape,
    family_check: rule.family_check,
    expected: rule.lengths.length ? rule.lengths.join(' / ') : `${rule.min_len}–${rule.max_len}`,
  };
}
export type PublicRule = ReturnType<typeof publicRule>;

/**
 * The `format` block of an audit detail: which rule judged the serial, at
 * which version, and what it said. Null before 0180 (the legacy rule), so
 * today's audit rows stay exactly as they were.
 */
export function formatAudit(rule: SerialRule, warnings: ReadonlyArray<{ code: string }>): { rule_id: string; rule_version: number; warnings: string[] } | null {
  if (rule.scope === 'legacy') return null;
  return { rule_id: rule.id, rule_version: rule.version, warnings: warnings.map((w) => w.code) };
}
