/** Inline procurement pricing uses the normal V2 preview and prices-only writer.
 * A typed final cost adjusts the supplier component after freight and extras;
 * it never rewrites a purchase, a received lot or its accounting cost.
 *
 * DECISIONS row 273 (amends row 224 on this screen): with an unsaved purchase,
 * the final cost the card starts from is THIS shipment's landed unit cost (the
 * document's rate, its raw supplier price, its freight and charges)
 * at the shipment's dollar rate (`shipmentUsdIqd`), not the product's stored
 * inputs at the central rates. It is applied exactly like a typed final cost,
 * so the preview, its hash and the saved prices all carry the same figure. */
import type { Context } from 'hono';
import type { AppContext } from '../../types';
import { notFound } from '../../http';
import { replacementCost, resolveSkuInputs } from '@levonis/pricing/costToPrice';
import { parseV2Usd } from '@levonis/pricing/priceV2';
import { resolveRuleAt } from '@levonis/pricing/ruleResolution';
import { addProcurementExact, ceilToPlaces, floorToPlaces, procurementExact, procurementExactText, quotientProcurementExact, typedDecimalText } from '@levonis/contracts/procurementCost';
import { deriveProductEntries, mergedRules, openSeedFields, shipmentUnitLandedIqd, shipmentUsdIqd, skuLevelOf, type PurchaseForPricing } from '../fromPurchase';
import { purchaseSkuLevels, unitRuleTarget } from '../procurementPreview';
import { chainOfUnit, packagesOf } from '../store';
import { unitColorId, unitComboKey, unitOptionIds } from '../legacy';
import { FORM_INPUT_FIELDS } from '../productInputs';
import { inputInvalid } from '../whatIf';
import { desiredFor, evaluateDesired, loadV2Read, parseV2Wire, storedMethodOf, v2Answer } from './api';
import type { V2Evaluation } from './evaluate';
import { importStockNotConfigured } from '../../importStock';
import { withPreparedProcurementStock } from '../../procurementImportStock';

export async function procurementLinePricing(c: Context<AppContext>, body: Record<string, unknown>, purchase: PurchaseForPricing | null) {
  if (typeof body.product_id !== 'string' || !body.product_id) throw inputInvalid('product_id');
  const storedRead = await loadV2Read(c.env.DB, body.product_id);
  if (!storedRead) throw notFound('Product not found');
  const scope = body.scope;
  const id = typeof body.scope_id === 'string' ? body.scope_id : '';
  if (!['base', 'option', 'color', 'variant'].includes(String(scope)) || (scope === 'base' ? id !== '' : !id)) throw inputInvalid('scope');
  const levels = purchaseSkuLevels(storedRead.loaded);
  const narrow = skuLevelOf({ scope: scope as 'color' | 'variant', scope_id: id }, levels);
  if ((scope === 'color' || scope === 'variant') && !narrow && !levels?.variants.has(id)) throw inputInvalid('scope_id');
  const read = await importStockNotConfigured(c.env.DB, storedRead.loaded.id)
    ? { ...storedRead, loaded: withPreparedProcurementStock(storedRead.loaded, { scope, scope_id: id }) } : storedRead;
  const options = { viewer: 'owner' as const, env: c.env, user: c.get('user'), now: new Date().toISOString() };
  const pricing: Record<string, unknown> = { method: storedMethodOf(read) ?? 'cost' };
  const inputs: Array<Record<string, unknown>> = [];
  const cost: Record<string, unknown> = { inputs };
  pricing.cost = cost;
  const evaluate = () => evaluateDesired(read, desiredFor(read, parseV2Wire(pricing), options));
  let ev = await evaluate();
  const matches = (u: V2Evaluation['legacy']['units'][number]) => scope === 'base'
    || (scope === 'option' && unitOptionIds(u).includes(id))
    || (scope === 'color' && unitColorId(u) === id)
    || (scope === 'variant' && unitComboKey(u) === levels?.variants.get(id));
  const unit = ev.legacy.units.find(matches);
  if (!unit) throw inputInvalid('scope_id');
  const selection = { option_value_ids: unitOptionIds(unit), color_id: unitColorId(unit), combo_key: unitComboKey(unit) };
  const target = narrow ?? { scope: scope === 'option' ? 'option' : scope === 'variant' && selection.option_value_ids[0] ? 'option' : 'base', scope_id: scope === 'option' ? id : scope === 'variant' ? selection.option_value_ids[0] ?? '' : '' };
  const resolvedOf = (e: V2Evaluation) => resolveSkuInputs(chainOfUnit(e.inputs, { ...selection, packaged: packagesOf(read.loaded.doc)(selection.option_value_ids, selection.color_id) }));
  const replacementOf = (e: V2Evaluation) => {
    const resolved = resolvedOf(e);
    const profile = resolved.inputs.shipping_profile?.value;
    return profile && read.rates ? replacementCost(resolved, profile, read.rates.central) : null;
  };

  // Row 273: this shipment's landed unit cost in dollars, when the draft carries it for this selection.
  const bought = (l: PurchaseForPricing['lines'][number]) => l.product_id === read.loaded.id && l.scope === scope && l.scope_id === id;
  // `keep_cost`: the owner typed and saved a final cost against this same shipment; it stays the cost.
  if (body.keep_cost !== undefined && typeof body.keep_cost !== 'boolean') throw inputInvalid('keep_cost');
  const shipmentRate = purchase && body.keep_cost !== true ? shipmentUsdIqd(purchase, read.rates) : null;
  const shipmentLanded = purchase && shipmentRate ? shipmentUnitLandedIqd(purchase, bought) : null;
  const shipmentUsd = shipmentLanded && shipmentRate ? ceilToPlaces(quotientProcurementExact(shipmentLanded, shipmentRate), 6) : null;
  // A new/unpriced selection fills its missing inputs from this unsaved purchase (fill only: what is stored
  // stays). With the shipment's own cost, the route and measure it may still need come from it too.
  if ((!replacementOf(ev)?.ok || shipmentUsd) && purchase) {
    const lines = purchase.lines.filter(bought);
    const derived = deriveProductEntries({ ...purchase, lines }, read.loaded.id, read.stored, {
      optIn: new Set(lines.map((l) => l.key)), prefer: false, usePurchase: true, rates: read.rates, levels,
    });
    for (const entry of derived.entries) {
      const seed = openSeedFields(ev.inputs, { ...entry.write, seed: true });
      if (!seed) continue;
      // Colour/SKU inputs have the same fill-only behaviour as broader seeds.
      // A missing package must not replace a supplier price already inherited.
      const current = resolvedOf(ev).inputs;
      if (current.supplier) { delete seed.set.supplier_cost_amount; delete seed.set.supplier_cost_currency; }
      if (current.weight) delete seed.set.shipping_weight_g;
      if (current.cbm) delete seed.set.manual_cbm;
      if (current.additional_cost_iqd) delete seed.set.additional_cost_iqd;
      if (current.shipping_profile) delete seed.set.shipping_profile;
      if (!Object.keys(seed.set).length) continue;
      inputs.push({ scope: seed.scope, scope_id: seed.scope_id, ...Object.fromEntries(FORM_INPUT_FIELDS.filter((k) => k in seed.set).map((k) => [k, seed.set[k]])) });
    }
    ev = await evaluate();
  }

  const ruleTarget = unitRuleTarget(read.loaded.id, selection);
  const profitScope = target.scope === 'base' ? 'product' : target.scope;
  const setProfit = (amount: string) => { cost.minimum_profit = [{ kind: 'target_profit', scope: profitScope, scope_id: target.scope_id, amount_usd: amount }]; };
  if (body.minimum_profit_usd !== undefined) {
    if (typeof body.minimum_profit_usd !== 'string') throw inputInvalid('minimum_profit_usd');
    const text = typedDecimalText(body.minimum_profit_usd.trim());
    if (text && !parseV2Usd(text)) throw inputInvalid('minimum_profit_usd');
    setProfit(text);
  }
  // The supplier component that makes the engine's cost exactly `amount` after its freight and extras. A
  // shipment's cost that cannot be represented (no route to freight it, or freight above it) leaves the
  // inputs as they were, and the card reads the product's own cost as before; a typed one is refused.
  const applyFinalCost = async (amount: ReturnType<typeof procurementExact>, typed: boolean) => {
    // A temporary supplier amount lets the same cost resolver calculate the
    // freight even when the supplier cost has never been entered.
    const at = inputs.find((i) => i.scope === target.scope && i.scope_id === target.scope_id);
    const input = at ?? { ...target };
    const before = at ? { ...at } : null;
    const undo = () => {
      if (!before) inputs.splice(inputs.indexOf(input), 1);
      else { for (const k of Object.keys(input)) delete input[k]; Object.assign(input, before); }
    };
    if (!at) inputs.push(input);
    Object.assign(input, { supplier_cost_amount: '1', supplier_cost_currency: 'USD' });
    ev = await evaluate();
    const replacement = replacementOf(ev);
    if (!replacement?.ok || !read.rates?.usd_iqd) {
      if (typed) throw inputInvalid('final_cost_usd_requires_freight');
      undo();
      return false;
    }
    const charges = addProcurementExact(procurementExact(replacement.cost.shipping_cost_exact), procurementExact(replacement.cost.additional_cost_iqd));
    const chargesUsd = quotientProcurementExact(charges, procurementExact(read.rates.usd_iqd));
    const supplier = addProcurementExact(amount, { num: -chargesUsd.num, den: chargesUsd.den });
    if (supplier.num <= 0n) {
      if (typed) throw inputInvalid('final_cost_usd_below_freight');
      undo();
      return false;
    }
    // Down at the sixth place, so the engine reads back exactly the final cost asked (freight ÷ U rarely ends
    // within six places; rounding up would show $700.000001 for a typed $700). The gap is under a millionth of
    // a dollar, and the price above it is still rounded up to its step.
    const supplierText = procurementExactText(floorToPlaces(supplier, 6));
    if (!parseV2Usd(supplierText, { zero: false })) {
      if (typed) throw inputInvalid('final_cost_usd_below_freight');
      undo();
      return false;
    }
    input.supplier_cost_amount = supplierText;
    return true;
  };
  let fromShipment = false;
  if (body.final_cost_usd !== undefined) {
    if (typeof body.final_cost_usd !== 'string') throw inputInvalid('final_cost_usd');
    const amount = parseV2Usd(typedDecimalText(body.final_cost_usd.trim()), { zero: false });
    if (!amount) throw inputInvalid('final_cost_usd');
    await applyFinalCost(amount, true);
  } else if (shipmentUsd && shipmentUsd.num > 0n) {
    fromShipment = await applyFinalCost(shipmentUsd, false);
  }
  ev = await evaluate();
  const usd = (amount: string | number) => read.rates?.usd_iqd ? procurementExactText(ceilToPlaces(quotientProcurementExact(procurementExact(amount), procurementExact(read.rates.usd_iqd)), 6)) : null;
  const channelOf = (e: V2Evaluation) => {
    const channels = e.result?.skus.find((s) => s.combo_key === selection.combo_key)?.channels;
    return channels?.find((ch) => ch.channel === 'direct_sale') ?? channels?.[0];
  };
  if (body.customer_price_usd !== undefined) {
    if (body.minimum_profit_usd !== undefined || typeof body.customer_price_usd !== 'string') throw inputInvalid('customer_price_usd');
    const requested = parseV2Usd(typedDecimalText(body.customer_price_usd.trim()));
    if (!requested) throw inputInvalid('customer_price_usd');
    const requestedText = procurementExactText(requested);
    let fixed = ev.method === 'usd';
    if (!fixed) {
      // Resolve the same shelf/supplier cost and adjustments as the normal
      // engine, even when this selection has no minimum profit yet. This is
      // only a preview; its temporary rule is replaced before it can be saved.
      setProfit('1');
      ev = await evaluate();
      const channel = channelOf(ev);
      const replacement = replacementOf(ev);
      const base = channel?.shelf?.cost_iqd ?? (replacement?.ok ? replacement.cost.replacement_exact : null);
      const baseUsd = base === null ? null : usd(base);
      if (!channel || baseUsd === null) throw inputInvalid('customer_price_usd_requires_cost');
      fixed = channel.anchor !== 'cost';
      const delta = procurementExact(channel.deltas_usd, { signed: true });
      const effectiveCost = addProcurementExact(procurementExact(baseUsd), !fixed && delta.num > 0n ? delta : procurementExact('0'));
      const profit = addProcurementExact(requested, { num: -effectiveCost.num, den: effectiveCost.den });
      if (profit.num <= 0n) throw inputInvalid('customer_price_usd_below_cost');
      setProfit(procurementExactText(profit));
    }
    if (fixed) {
      // Keep the product's method, discounts and unrelated price points. A
      // colour/variant gets its own SKU price; a model keeps its model scope.
      const pointScope = scope === 'base' ? 'product' : scope === 'option' && selection.option_value_ids[0] === id ? 'option' : 'sku';
      const pointId = pointScope === 'product' ? '' : pointScope === 'option' ? id : selection.combo_key;
      const points = ev.points.filter((p) => p.scope !== pointScope || p.scope_id !== pointId).map((p) => ({ ...p }));
      const point = { scope: pointScope, scope_id: pointId, kind: 'fixed', usd: requestedText };
      pricing.points = [...points, point];
      ev = await evaluate();
      const channel = channelOf(ev);
      if (channel) {
        // Model/product anchors still carry option and colour differences.
        // Reverse the exact differences, even when a negative adjustment was
        // temporarily hidden by the engine's minimum-profit floor.
        const delta = procurementExact(channel.deltas_usd, { signed: true });
        const adjusted = addProcurementExact(requested, { num: -delta.num, den: delta.den });
        const text = procurementExactText(adjusted);
        if (!parseV2Usd(text)) throw inputInvalid('customer_price_usd_conflicts');
        point.usd = text;
      }
    }
    ev = await evaluate();
    // A narrower exception must never make a typed price appear saved while
    // the customer's price remains different. The advanced editor resolves it.
    const channel = channelOf(ev);
    if (!channel || usd(channel.direct_exact_iqd) !== requestedText) throw inputInvalid('customer_price_usd_conflicts');
  }
  const replacement = replacementOf(ev);
  const rule = resolveRuleAt(mergedRules(read.stored, ev.ruleWrites), 'target_profit', ruleTarget, { usdIqdRate: read.rates?.usd_iqd ?? null });
  const row = ev.rows.find((r) => r.combo_key === selection.combo_key && r.channel === 'direct_sale') ?? ev.rows.find((r) => r.combo_key === selection.combo_key);
  const finalCostUsd = replacement?.ok ? usd(replacement.cost.replacement_exact) : null;
  return {
    pricing,
    preview: v2Answer({ viewer: 'owner', read, ev }),
    final_cost_usd: finalCostUsd,
    minimum_profit_usd: rule.status === 'active' ? rule.amount_usd ?? (rule.amount_iqd === null ? null : usd(rule.amount_iqd)) : null,
    customer_price_usd: row?.owner?.usd_ceil6 ?? row?.usd_exact ?? null,
    customer_price_iqd: row?.new_iqd ?? null,
    profit_scope: profitScope,
    cost_from_purchase: inputs.length > 0 && body.final_cost_usd === undefined,
    // Row 273: where the final cost came from — this shipment (its landed unit dinars and dollar rate), or null.
    shipment: fromShipment && shipmentLanded && shipmentRate
      ? { landed_cost_iqd: procurementExactText(ceilToPlaces(shipmentLanded, 3)), usd_iqd: procurementExactText(ceilToPlaces(shipmentRate, 6)), final_cost_usd: finalCostUsd ?? procurementExactText(shipmentUsd!) }
      : null,
  };
}
