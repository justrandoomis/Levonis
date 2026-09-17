/**
 * Canonical identity for an ordinary cart line's complete option selection.
 *
 * `option_value_ids` is stored as JSON TEXT and participates in a SQLite
 * unique index. Therefore equivalent selections must serialize byte-for-byte
 * alike regardless of the order in which a client submitted the groups.
 * Code-unit ordering is deliberately used instead of localeCompare so the
 * result is identical in Workers, Node tests and migration-era runtimes.
 */
export function canonicalOptionValueIds(
  values: readonly unknown[],
  legacyOptionId: unknown = ''
): string[] {
  const unique = new Set<string>();
  for (const value of values) {
    if (typeof value === 'string' && value.length > 0) unique.add(value);
  }
  if (typeof legacyOptionId === 'string' && legacyOptionId.length > 0) {
    unique.add(legacyOptionId);
  }
  return [...unique].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}

/** The exact TEXT value persisted in, indexed by and queried from D1. */
export const optionValueIdsJson = (
  values: readonly unknown[],
  legacyOptionId: unknown = ''
): string => JSON.stringify(canonicalOptionValueIds(values, legacyOptionId));

/** Compare selections by the same canonical representation the index uses. */
export const sameOptionValueIds = (left: readonly unknown[], right: readonly unknown[]): boolean =>
  optionValueIdsJson(left) === optionValueIdsJson(right);

type RelationOrder = {
  groups: ReadonlyArray<{ id: string; sort?: number; name_en?: string; active?: number | boolean | null }>;
  values: ReadonlyArray<{
    id: string;
    group_id: string;
    sort?: number;
    name_en?: string;
    active?: number | boolean | null;
  }>;
};

const textOrder = (left: string, right: string): number =>
  left < right ? -1 : left > right ? 1 : 0;

/**
 * Pricing has a separate ordering concern from TEXT identity: the first
 * option is the price-bearing model. Relational group/value order is the
 * catalog's authored order, so use it whenever it is available and keep the
 * lexical identity order only as a deterministic fallback for legacy rows.
 */
export function optionValueIdsInRelationOrder(
  values: readonly unknown[],
  relations?: RelationOrder
): string[] {
  const canonical = canonicalOptionValueIds(values);
  if (!relations || canonical.length < 2) return canonical;

  const groups = relations.groups
    // Rolling-schema rows may omit active or expose NULL; only explicit 0 / false is off.
    .filter((group) => group.active !== 0 && group.active !== false)
    .sort((left, right) =>
      (Number(left.sort) || 0) - (Number(right.sort) || 0) ||
      textOrder(String(left.name_en ?? ''), String(right.name_en ?? '')) ||
      textOrder(left.id, right.id)
    );
  const groupRank = new Map(groups.map((group, index) => [group.id, index]));
  const valueById = new Map(relations.values.map((value) => [value.id, value]));

  return canonical.sort((leftId, rightId) => {
    const left = valueById.get(leftId);
    const right = valueById.get(rightId);
    if (!left || !right) return left ? -1 : right ? 1 : textOrder(leftId, rightId);
    return (
      (groupRank.get(left.group_id) ?? Number.MAX_SAFE_INTEGER) -
        (groupRank.get(right.group_id) ?? Number.MAX_SAFE_INTEGER) ||
      (Number(left.sort) || 0) - (Number(right.sort) || 0) ||
      textOrder(String(left.name_en ?? ''), String(right.name_en ?? '')) ||
      textOrder(leftId, rightId)
    );
  });
}
