/** Private stock-purchase inputs. These patches are evaluated on direct sale only.
 * Explicit owner edits of the corresponding ordinary input/rule supersede the
 * purchase patch. Rate changes do not, so stocked goods retain their cost basis.
 */
import { mergedInputs, mergedRules } from './fromPurchase';
import { INPUT_FIELD_NAMES, nextInputRow, ownerRow, type InputFields, type InputWrite, type ProductPricingData, type RuleWrite, type StoredInputRow } from './store';

export interface DirectPurchaseOverlay {
  version: number;
  direct_only?: boolean;
  inputs: Array<Omit<InputWrite, 'existing' | 'iqd'> & { baseline: Partial<InputFields> }>;
  rules: Array<Omit<RuleWrite, 'existing'> & { baseline_version: number | null }>;
}

const ruleExisting = (s: ProductPricingData, w: Pick<RuleWrite, 'kind' | 'scope' | 'scope_id'>) =>
  s.rules.find((r) => r.product_id === s.product_id && r.kind === w.kind && r.scope === w.scope && r.scope_id === w.scope_id) ?? null;

function activeInput(s: ProductPricingData, w: DirectPurchaseOverlay['inputs'][number]) {
  const existing = ownerRow(s.inputs, w.scope, w.scope_id);
  const supplier = ['supplier_cost_amount', 'supplier_cost_currency', 'supplier_cost_delta'] as const;
  const supplierChanged = supplier.some((k) => (existing?.[k] ?? null) !== (w.baseline[k] ?? null));
  const set = Object.fromEntries(Object.entries(w.set).filter(([key]) => {
    const k = key as keyof InputFields;
    return supplier.includes(k as typeof supplier[number]) ? !supplierChanged : (existing?.[k] ?? null) === (w.baseline[k] ?? null);
  })) as Partial<InputFields>;
  return { ...w, existing, set };
}

/** Ordinary inputs remain the source for preorder; only direct calls use this view. */
export function directPurchaseStore(s: ProductPricingData, overlay = s.direct_purchase): ProductPricingData {
  if (!overlay) return s;
  const inputs = overlay.inputs.map((w) => activeInput(s, w)).filter((w) => Object.keys(w.set).length > 0);
  const rules = overlay.rules.flatMap((w) => {
    const existing = ruleExisting(s, w);
    return (existing?.version ?? null) === w.baseline_version ? [{ ...w, existing }] : [];
  });
  const merged = mergedInputs(s.inputs, inputs).map((r) => {
    const w = inputs.find((x) => x.scope === r.scope && x.scope_id === r.scope_id && r.origin === 'MANUAL_OVERRIDE');
    if (!w) return r as StoredInputRow;
    const next = nextInputRow(w);
    return {
      product_id: s.product_id, unresolved_fields: '[]', updated_at: '', version: overlay.version,
      original_input_amount: null, original_input_currency: null, conversion_rate_snapshot: null,
      conversion_fx_version: null, canonical_supplier_cost_usd: null, converted_at: null,
      ...r, ...Object.fromEntries(INPUT_FIELD_NAMES.map((k) => [k, next[k]])),
      ...(next.clears_iqd_snapshot ? { original_input_amount: null, original_input_currency: null, conversion_rate_snapshot: null, conversion_fx_version: null, canonical_supplier_cost_usd: null, converted_at: null } : {}),
      supplier_input_mode: next.supplier_input_mode, source_ref: w.source_ref,
    } as StoredInputRow;
  });
  return { ...s, inputs: merged, rules: mergedRules(s, rules) };
}

/** Keep only current patches, then merge the latest purchase's fields by scope. */
export function nextDirectPurchase(s: ProductPricingData, inputs: readonly InputWrite[], rules: readonly RuleWrite[]): DirectPurchaseOverlay {
  const before = s.direct_purchase;
  const out: DirectPurchaseOverlay = {
    version: (before?.version ?? 0) + 1,
    direct_only: before?.direct_only === true || s.state?.mode !== 'engine',
    inputs: (before?.inputs ?? []).map((w) => activeInput(s, w)).filter((w) => Object.keys(w.set).length > 0).map(({ existing: _existing, ...w }) => w),
    rules: (before?.rules ?? []).filter((w) => (ruleExisting(s, w)?.version ?? null) === w.baseline_version).map((w) => ({ ...w })),
  };
  for (const w of inputs) {
    const at = out.inputs.findIndex((r) => r.scope === w.scope && r.scope_id === w.scope_id);
    const next = { scope: w.scope, scope_id: w.scope_id, set: { ...(at >= 0 ? out.inputs[at]!.set : {}), ...w.set }, source_ref: w.source_ref, baseline: Object.fromEntries(INPUT_FIELD_NAMES.map((k) => [k, ownerRow(s.inputs, w.scope, w.scope_id)?.[k] ?? null])) };
    if (at >= 0) out.inputs[at] = next; else out.inputs.push(next);
  }
  for (const w of rules) {
    const at = out.rules.findIndex((r) => r.kind === w.kind && r.scope === w.scope && r.scope_id === w.scope_id);
    const next = { kind: w.kind, scope: w.scope, scope_id: w.scope_id, next: w.next, new_id: `purchase:${s.product_id}:${w.kind}:${w.scope}:${w.scope_id}`, baseline_version: ruleExisting(s, w)?.version ?? null };
    if (at >= 0) out.rules[at] = next; else out.rules.push(next);
  }
  return out;
}

export function directPurchaseStatement(db: D1Database, s: ProductPricingData, next: DirectPurchaseOverlay, actor: string, now: string): D1PreparedStatement {
  const payload = JSON.stringify({ direct_only: next.direct_only ?? false, inputs: next.inputs, rules: next.rules });
  return s.direct_purchase
    ? db.prepare('UPDATE pricing_direct_purchase SET payload_json = ?, version = ?, updated_by = ?, updated_at = ? WHERE product_id = ? AND version = ?').bind(payload, next.version, actor, now, s.product_id, s.direct_purchase.version)
    : db.prepare('INSERT INTO pricing_direct_purchase (product_id, payload_json, version, updated_by, updated_at) VALUES (?, ?, ?, ?, ?)').bind(s.product_id, payload, next.version, actor, now);
}

/** Ordinary owner edits permanently remove their corresponding purchase fields.
 * This avoids stale values reviving if the owner later restores an old value.
 */
export function pruneDirectPurchase(s: ProductPricingData, inputs: readonly InputWrite[], rules: readonly RuleWrite[]): DirectPurchaseOverlay | null {
  const before = s.direct_purchase;
  if (!before) return null;
  const supplier = ['supplier_cost_amount', 'supplier_cost_currency', 'supplier_cost_delta'];
  const next: DirectPurchaseOverlay = { version: before.version + 1, direct_only: before.direct_only, inputs: [], rules: [] };
  for (const r of before.inputs) {
    const writes = inputs.filter((w) => w.scope === r.scope && w.scope_id === r.scope_id);
    const keys = new Set(writes.flatMap((w) => Object.keys(w.set).filter((k) => (w.set[k as keyof InputFields] ?? null) !== (w.existing?.[k as keyof InputFields] ?? null))));
    if (supplier.some((k) => keys.has(k))) for (const k of supplier) keys.add(k);
    const set = Object.fromEntries(Object.entries(r.set).filter(([k]) => !keys.has(k)));
    if (Object.keys(set).length) next.inputs.push({ ...r, set });
  }
  next.rules = before.rules.filter((r) => !rules.some((w) => w.kind === r.kind && w.scope === r.scope && w.scope_id === r.scope_id));
  return JSON.stringify({ inputs: before.inputs, rules: before.rules }) === JSON.stringify({ inputs: next.inputs, rules: next.rules }) ? null : next;
}

export function pruneDirectPurchaseStatements(db: D1Database, s: ProductPricingData, inputs: readonly InputWrite[], rules: readonly RuleWrite[], actor: string, now: string): D1PreparedStatement[] {
  const next = pruneDirectPurchase(s, inputs, rules);
  return next ? [directPurchaseStatement(db, s, next, actor, now)] : [];
}
