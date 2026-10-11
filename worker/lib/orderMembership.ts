/** Checkout records the whole membership saving, including savings already
 * inside the unit price. Only the frozen application site can say whether
 * another subtraction remains. Never consult today's membership rules. */
type Row = Record<string, unknown>;
export const UNLINKED_MEMBERSHIP_PRODUCTS = '_levonis_unlinked_product_ids_v1';

export function membershipDiscountAtLine(order: Row, item: Row): number {
  const saved = Number(item.membership_discount_iqd ?? 0);
  if (!saved || (typeof item.product_id !== 'string' && item.product_id !== null)) return saved;
  try {
    const snapshot: unknown = JSON.parse(String(order.benefit_snapshot ?? 'null'));
    if (!snapshot || typeof snapshot !== 'object' || !('lines' in snapshot) || !Array.isArray(snapshot.lines)) return saved;
    let productId = item.product_id;
    if (productId === null) {
      const identities = (snapshot as Row)[UNLINKED_MEMBERSHIP_PRODUCTS];
      if (typeof item.id !== 'string' || !item.id || !identities || typeof identities !== 'object'
        || Array.isArray(identities) || !Object.hasOwn(identities, item.id)) return saved;
      const preservedId = (identities as Row)[item.id];
      if (typeof preservedId !== 'string' || !preservedId) return saved;
      productId = preservedId;
    }
    const matches = snapshot.lines.filter((line: unknown): line is Row => !!line && typeof line === 'object'
      && (line as Row).product_id === productId
      && ((line as Row).rule_id ?? null) === (item.membership_rule_id ?? null));
    // Several variants can share a product/rule. A unanimous application site
    // is sufficient; absent or contradictory historical evidence keeps the
    // previous interpretation instead of inventing a new discount allocation.
    return matches.length && matches.every(line => line.applied_at === 'unit') ? 0 : saved;
  } catch { return saved; }
}

/** Same frozen-evidence rule for aggregate reports. `item` is a trusted SQL
 * alias; keeping the order lookup here also covers CTEs without an order join. */
export function membershipDiscountAtLineSql(item = 'i'): string {
  const snapshot = "CASE WHEN json_valid(om.benefit_snapshot) THEN om.benefit_snapshot ELSE '{}' END";
  const identities = `CASE WHEN json_type(${snapshot},'$.${UNLINKED_MEMBERSHIP_PRODUCTS}')='object'
    THEN json_extract(${snapshot},'$.${UNLINKED_MEMBERSHIP_PRODUCTS}') ELSE '{}' END`;
  const product = `CASE WHEN typeof(${item}.product_id)='text' THEN ${item}.product_id
    WHEN ${item}.product_id IS NULL AND typeof(${item}.id)='text' AND ${item}.id<>''
    THEN (SELECT mp.value FROM json_each(${identities}) mp WHERE mp.key=${item}.id AND mp.type='text' AND mp.value<>'') END`;
  const lines = `CASE WHEN json_valid(om.benefit_snapshot) THEN
    CASE WHEN json_type(om.benefit_snapshot,'$.lines')='array' THEN json_extract(om.benefit_snapshot,'$.lines') ELSE '[]' END
    ELSE '[]' END`;
  const value = "CASE WHEN mb.type='object' THEN mb.value ELSE '{}' END";
  const matches = `json_type(${value},'$.product_id')='text'
    AND (json_type(${value},'$.rule_id') IN ('text','null') OR json_type(${value},'$.rule_id') IS NULL)
    AND json_extract(${value},'$.product_id')=(${product})
    AND json_extract(${value},'$.rule_id') IS ${item}.membership_rule_id`;
  return `CASE WHEN EXISTS(SELECT 1 FROM orders om WHERE om.id=${item}.order_id
    AND EXISTS(SELECT 1 FROM json_each(${lines}) mb WHERE ${matches} AND json_extract(${value},'$.applied_at')='unit')
    AND NOT EXISTS(SELECT 1 FROM json_each(${lines}) mb WHERE ${matches} AND COALESCE(json_extract(${value},'$.applied_at'),'')<>'unit'))
    THEN 0 ELSE COALESCE(${item}.membership_discount_iqd,0) END`;
}

/** Keep persisted fingerprints byte-identical for unaffected orders. Only a
 * proven unit-applied saving changes the calculation introduced by this fix;
 * that order's old projection must be reconciled before it can fund a payout. */
export function withMembershipFinancialFingerprintSql(baseSql: string, orderSql: string): string {
  return `CASE WHEN EXISTS(SELECT 1 FROM order_items mfi WHERE mfi.order_id=${orderSql}
    AND mfi.membership_discount_iqd>0 AND (${membershipDiscountAtLineSql('mfi')})=0)
    THEN json_array('membership-unit-v1',json((${baseSql})),
      (SELECT benefit_snapshot FROM orders WHERE id=${orderSql}),
      (SELECT json_group_array(json_array(id,product_id,membership_rule_id,membership_discount_iqd))
        FROM (SELECT * FROM order_items WHERE order_id=${orderSql} ORDER BY id)))
    ELSE (${baseSql}) END`;
}
