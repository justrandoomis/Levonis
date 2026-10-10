/**
 * «ملف بيانات المنتج» — THE OWNER'S `pricing.*` BLOCK (worker/lib/productDataFile.ts).
 *
 * One block per pricing scope — the product (`pricing.base.*`), each model
 * (`pricing.options.N.*`) and, with the SKU rung (0183), each colour
 * (`pricing.colors.N.*`) and colour/variant SKU (`pricing.skus.N.*`) — with
 * the product form's own fields (supplier cost in its currency or the dinar
 * convenience entry, the shipping route, the packed weight or box, the CBM,
 * the additional cost) and the two owner rules (minimum profit in USD, Direct
 * Sale Extra). Empty = not set here (the scope inherits).
 *
 * It is the verified owner's alone and is never rendered, compared or echoed
 * for anyone else. Changes go through the SAME door as the form's save
 * (`parseProductInputs` → `effectiveWrites` → `productEngineEvaluation`), with
 * the same gates: a save that would write prices (adopt or reprice) needs the
 * hash of the preview the owner read, a large change the tick and a fresh
 * sign-in; a dinar entry needs the hash of the rate it converts at.
 */
import { HttpError } from './http';
import { engineCoreInstalled } from './engineInstalled';
import { loadPreviewContext, loadProducts, type LoadedProduct } from './pricingEngine/load';
import { loadPricingRates, type PricingRates } from './pricingEngine/rates';
import {
  loadProductPricing,
  ownerRow,
  ruleAt,
  type InputScope,
  type ProductPricingData,
  type ProductRuleScope,
} from './pricingEngine/store';
import {
  effectiveWrites,
  formPreviewHash,
  formScopeIds,
  loadEngineReads,
  parseProductInputs,
  productEngineEvaluation,
  type ProductInputsDraft,
} from './pricingEngine/productInputs';
import { engineEvaluationDto, type EngineEvaluation } from './pricingEngine/engineWrite';
import { inputInvalid } from './pricingEngine/whatIf';
import type { PricingContext } from '../routes/cart';
import { serverMessage } from '../../packages/contracts/src/costRefusals';
import { PRICING_INPUT_KEYS, type FlatEntry, type NEntry } from './productDataFile';

export interface PricingLive {
  loaded: LoadedProduct;
  stored: ProductPricingData;
  scopes: { option: Set<string>; color: Set<string>; sku: Set<string> };
  entries: FlatEntry[];
  /** Comments beside a key (where a value came from). */
  notes: Map<string, string[]>;
  /** A comment above a scope's id line (the model, colour or SKU it is). */
  above: Map<string, string>;
}

/** SKU scopes are listed whole up to this many; above it, only the ones that hold a value. */
const SKU_LISTED = 24;

const str = (v: unknown): string | null => (v === null || v === undefined || v === '' ? null : String(v));

/** The owner's block as the product stands now; null when the pricing engine is not installed. */
export async function loadPricingLive(db: D1Database, productId: string): Promise<PricingLive | null> {
  if (!(await engineCoreInstalled(db))) return null;
  const loaded = (await loadProducts(db, [productId])).get(productId);
  if (!loaded || (loaded.doc.composition ?? '') !== '') return null;
  const stored = await loadProductPricing(db, productId);
  let ids: { option: ReadonlySet<string>; color?: ReadonlySet<string>; sku?: ReadonlySet<string> };
  try {
    ids = formScopeIds(loaded);
  } catch {
    // A failed read of the SKU rung: the models only (never "no colour level" by mistake — nothing is written from here).
    ids = { option: new Set(loaded.doc.options.filter((o) => o.active !== false && !o.merged_into).map((o) => o.id)) };
  }
  const scopes = { option: new Set(ids.option), color: new Set(ids.color ?? []), sku: new Set(ids.sku ?? []) };
  const entries: FlatEntry[] = [];
  const notes = new Map<string, string[]>();
  const above = new Map<string, string>();
  const pid = productId;

  const write = (prefix: string, scope: InputScope, scopeId: string) => {
    const row = ownerRow(stored.inputs, scope, scopeId);
    const ruleScope: ProductRuleScope = scope === 'base' ? 'product' : scope;
    const target = ruleAt(stored.rules, pid, 'target_profit', ruleScope, scopeId);
    const extra = ruleAt(stored.rules, pid, 'direct_sale_extra', ruleScope, scopeId);
    const converted = row?.supplier_input_mode === 'IQD_CONVERTED';
    const values: Record<string, string | null> = {
      supplier_cost_amount: str(row?.supplier_cost_amount),
      supplier_cost_currency: str(row?.supplier_cost_currency),
      supplier_cost_iqd: converted ? str(row?.original_input_amount) : null,
      shipping_profile: str(row?.shipping_profile),
      shipping_weight_g: str(row?.shipping_weight_g),
      shipping_length_mm: str(row?.shipping_length_mm),
      shipping_width_mm: str(row?.shipping_width_mm),
      shipping_height_mm: str(row?.shipping_height_mm),
      manual_cbm: str(row?.manual_cbm),
      additional_cost_iqd: str(row?.additional_cost_iqd),
      minimum_target_profit_usd: target?.state === 'ACTIVE' ? str(target.amount_usd) : null,
      direct_sale_extra_iqd: extra?.state === 'ACTIVE' ? str(extra.amount_iqd) : null,
    };
    for (const [field, value] of Object.entries(values)) entries.push({ key: `${prefix}.${field}`, value });
    if (converted) {
      notes.set(`${prefix}.supplier_cost_iqd`, [
        `أُدخلت بالدينار وحُوّلت إلى الدولار بسعر ${row?.conversion_rate_snapshot ?? '—'} · entered in IQD, converted at ${row?.conversion_rate_snapshot ?? '—'} · بە دینار نووسرا و گۆڕدرا`,
      ]);
    }
    const source = stored.inputs.find((r) => r.scope === scope && r.scope_id === (scope === 'base' ? '' : scopeId) && r.origin === 'SOURCE');
    if (source?.supplier_cost_amount) {
      notes.set(`${prefix}.supplier_cost_amount`, [
        `من الشراء: ${source.supplier_cost_amount} ${source.supplier_cost_currency ?? ''} — فارغ هنا = تُستعمل قيمة الشراء · from the purchase; empty here = the purchase value is used · لە کڕینەوە`,
      ]);
    }
    if (target?.state === 'ACTIVE' && !target.amount_usd && target.amount_iqd) {
      notes.set(`${prefix}.minimum_target_profit_usd`, [`قيمة مرحّلة بالدينار: ${target.amount_iqd} · a migrated dinar value · بەهایەکی گواستراوە بە دینار`]);
    }
  };

  write('pricing.base', 'base', '');
  let i = 0;
  for (const o of loaded.doc.options) {
    if (!scopes.option.has(o.id)) continue;
    const prefix = `pricing.options.${++i}`;
    entries.push({ key: `${prefix}.id`, value: o.id });
    above.set(`${prefix}.id`, `${o.name_ar || o.name_en || o.id}`);
    write(prefix, 'option', o.id);
  }
  i = 0;
  for (const c of loaded.doc.colors) {
    if (!scopes.color.has(c.id)) continue;
    const prefix = `pricing.colors.${++i}`;
    entries.push({ key: `${prefix}.id`, value: c.id });
    above.set(`${prefix}.id`, `${c.name_ar || c.name_en || c.id}`);
    write(prefix, 'color', c.id);
  }
  const holds = (combo: string) =>
    stored.inputs.some((r) => r.scope === 'sku' && r.scope_id === combo && r.origin === 'MANUAL_OVERRIDE') ||
    stored.rules.some((r) => r.product_id === pid && r.scope === 'sku' && r.scope_id === combo);
  const skus = [...scopes.sku].sort().filter((combo) => scopes.sku.size <= SKU_LISTED || holds(combo));
  i = 0;
  for (const combo of skus) {
    const prefix = `pricing.skus.${++i}`;
    entries.push({ key: `${prefix}.combo_key`, value: combo });
    write(prefix, 'sku', combo);
  }
  if (skus.length < scopes.sku.size) {
    above.set('pricing.base.supplier_cost_amount', `${scopes.sku.size - skus.length} تركيبة أخرى تُعدّل من النموذج · more SKUs are edited in the form · تێکەڵەی تر لە فۆڕمەکەوە دەگۆڕدرێن`);
  }
  return { loaded, stored, scopes, entries, notes, above };
}

/** One pricing field's verdict (keyed by the entry's identity). */
export interface PricingRefusal {
  status: 'INVALID_VALUE' | 'STRUCTURE_WITH_ADOPTION';
  message: string;
}

export interface PricingJudgement {
  refusals: Map<string, PricingRefusal>;
  /** The accepted entries (after the per-field checks). */
  accepted: NEntry[];
  draft: ProductInputsDraft | null;
  writes: ReturnType<typeof effectiveWrites> | null;
  ev: EngineEvaluation | null;
  /** What the save does with prices: nothing to save, data only, or a price write (adopt/reprice). */
  kind: 'none' | 'data' | 'price';
  /** The hash the apply must carry: the engine write's, or the dinar conversion's (null = none needed). */
  hash: string | null;
  large_change: boolean;
  adoption: ReturnType<typeof engineEvaluationDto> | null;
  rates: PricingRates | null;
  ctx: PricingContext | null;
}

const scopeOf = (n: NEntry): { scope: InputScope; scope_id: string } => {
  if (!n.item) return { scope: 'base', scope_id: '' };
  const lvl = n.item.group.slice('pricing.'.length);
  return { scope: lvl === 'options' ? 'option' : lvl === 'colors' ? 'color' : 'sku', scope_id: n.item.id };
};
const fieldOf = (n: NEntry) => n.path[1];
const BOX = ['shipping_length_mm', 'shipping_width_mm', 'shipping_height_mm'];
const WHOLE = new Set(['shipping_weight_g', 'shipping_length_mm', 'shipping_width_mm', 'shipping_height_mm', 'additional_cost_iqd', 'supplier_cost_iqd', 'direct_sale_extra_iqd']);

/** The file's value as the pricing door's wire type: text for decimals and codes, a whole number, or null. */
function wireValue(field: string, raw: string | null): { ok: true; value: unknown } | { ok: false } {
  const v = raw === null ? '' : raw.trim();
  if (v === '' || v === '__NULL__' || v === '__CLEAR__') return { ok: true, value: null };
  if (WHOLE.has(field)) {
    if (!/^\d{1,15}$/.test(v)) return { ok: false };
    return { ok: true, value: Number(v) };
  }
  return { ok: true, value: v };
}

const refusalText = (e: unknown): string => (e instanceof HttpError ? e.message : e instanceof Error ? e.message : String(e));

/**
 * The owner's pricing changes, judged field by field and then as one save.
 * `otherChanges` says whether the same apply also changes the product itself:
 * a save that would WRITE PRICES (adopt or reprice) is then refused for the
 * pricing lines (STRUCTURE_WITH_ADOPTION) — the product changes go first, the
 * pricing in a second apply of the same file, so the engine always prices the
 * product as it is stored.
 */
export async function judgePricing(
  db: D1Database,
  live: PricingLive,
  changes: readonly NEntry[],
  file: readonly NEntry[],
  liveEntries: readonly NEntry[],
  opts: { otherChanges: boolean; now: string }
): Promise<PricingJudgement> {
  const out: PricingJudgement = { refusals: new Map(), accepted: [], draft: null, writes: null, ev: null, kind: 'none', hash: null, large_change: false, adoption: null, rates: null, ctx: null };
  if (!changes.length) return out;
  const rates = await loadPricingRates(db);
  out.rates = rates;
  if (!rates) {
    // The form's door answers PRICING_NOT_INSTALLED without confirmed central rates; so does this one, per line.
    for (const n of changes) out.refusals.set(n.nkey, { status: 'INVALID_VALUE', message: serverMessage('PRICING_NOT_INSTALLED') });
    return out;
  }
  const cx = { rates, now: opts.now };
  const fileValue = (scopeKey: string, field: string): string | null => {
    const n = file.find((x) => x.head === 'pricing' && `${scopeOf(x).scope}:${scopeOf(x).scope_id}` === scopeKey && fieldOf(x) === field);
    if (n) return n.value;
    return liveEntries.find((x) => x.head === 'pricing' && `${scopeOf(x).scope}:${scopeOf(x).scope_id}` === scopeKey && fieldOf(x) === field)?.value ?? null;
  };

  // Group by scope.
  const byScope = new Map<string, NEntry[]>();
  for (const n of changes) {
    const s = scopeOf(n);
    const k = `${s.scope}:${s.scope_id}`;
    (byScope.get(k) ?? byScope.set(k, []).get(k)!).push(n);
  }

  const inputs: Array<Record<string, unknown>> = [];
  const rules: Array<Record<string, unknown>> = [];
  const refuse = (n: NEntry, message: string) => out.refusals.set(n.nkey, { status: 'INVALID_VALUE', message });

  for (const [k, list] of byScope) {
    const { scope, scope_id } = scopeOf(list[0]);
    const entry: Record<string, unknown> = { scope, ...(scope === 'base' ? {} : { scope_id }) };
    const ruleScope = scope === 'base' ? 'product' : scope;
    const scopeRules: Array<{ n: NEntry; rule: Record<string, unknown> }> = [];
    const inputEntries: NEntry[] = [];
    for (const n of list) {
      const field = fieldOf(n);
      const w = wireValue(field, n.value);
      if (!w.ok) {
        refuse(n, inputInvalid(field).message);
        continue;
      }
      if (field === 'minimum_target_profit_usd') {
        scopeRules.push({ n, rule: { kind: 'target_profit', scope: ruleScope, ...(scope === 'base' ? {} : { scope_id }), amount_usd: w.value === null ? null : String(w.value) } });
        continue;
      }
      if (field === 'direct_sale_extra_iqd') {
        scopeRules.push({ n, rule: { kind: 'direct_sale_extra', scope: ruleScope, ...(scope === 'base' ? {} : { scope_id }), amount_iqd: w.value } });
        continue;
      }
      if (field === 'supplier_cost_iqd' && w.value === null) {
        refuse(n, 'امسح المبلغ بالدولار supplier_cost_amount لمسح المدخل بالدينار / clear supplier_cost_amount to clear the dinar entry / بۆ سڕینەوەی دینار، supplier_cost_amount پاک بکەرەوە');
        continue;
      }
      inputEntries.push(n);
    }
    // The box travels whole: one edited axis sends all three (the file's, else the stored).
    const fields = new Set(inputEntries.map(fieldOf));
    if (BOX.some((f) => fields.has(f))) {
      for (const f of BOX) {
        const w = wireValue(f, fileValue(k, f));
        entry[f] = w.ok ? w.value : fileValue(k, f);
      }
    }
    for (const n of inputEntries) {
      const f = fieldOf(n);
      if (BOX.includes(f)) continue;
      const w = wireValue(f, n.value);
      if (w.ok) entry[f] = w.value;
    }
    if (entry.supplier_cost_iqd !== undefined && (entry.supplier_cost_amount !== undefined || entry.supplier_cost_currency !== undefined)) {
      const n = inputEntries.find((x) => fieldOf(x) === 'supplier_cost_iqd')!;
      refuse(n, 'اكتب المبلغ بالدولار أو بالدينار، لا الاثنين / write the supplier cost in its currency or in dinars, not both / یان بە دراو یان بە دینار، نەک هەردووکیان');
      delete entry.supplier_cost_iqd;
    }
    // The scope's input entry, judged whole; a refusal names its field, which names the line.
    const hasInput = Object.keys(entry).some((f) => (PRICING_INPUT_KEYS as readonly string[]).includes(f));
    if (hasInput) {
      try {
        parseProductInputs({ inputs: [entry] }, live.loaded, live.stored, cx);
        inputs.push(entry);
      } catch (e) {
        const field = e instanceof HttpError && typeof e.details?.field === 'string' ? (e.details.field as string) : '';
        const culprits = inputEntries.filter((n) => fieldOf(n) === field || (field === 'shipping_box' && BOX.includes(fieldOf(n))));
        for (const n of culprits.length ? culprits : inputEntries) if (!out.refusals.has(n.nkey)) refuse(n, refusalText(e));
        // Without the culprits, the rest of the scope may still stand.
        const rest = { ...entry };
        for (const n of culprits.length ? culprits : inputEntries) delete rest[fieldOf(n)];
        if (culprits.some((n) => BOX.includes(fieldOf(n)))) for (const f of BOX) delete rest[f];
        if (Object.keys(rest).some((f) => (PRICING_INPUT_KEYS as readonly string[]).includes(f))) {
          try {
            parseProductInputs({ inputs: [rest] }, live.loaded, live.stored, cx);
            inputs.push(rest);
          } catch (e2) {
            for (const n of inputEntries) if (!out.refusals.has(n.nkey)) refuse(n, refusalText(e2));
          }
        }
      }
    }
    for (const { n, rule } of scopeRules) {
      try {
        parseProductInputs({ rules: [rule] }, live.loaded, live.stored, cx);
        rules.push(rule);
      } catch (e) {
        refuse(n, refusalText(e));
      }
    }
  }

  out.accepted = changes.filter((n) => !out.refusals.has(n.nkey));
  if (!inputs.length && !rules.length) return out;

  const draft = parseProductInputs({ inputs, rules }, live.loaded, live.stored, cx);
  const writes = effectiveWrites(draft);
  out.draft = draft;
  out.writes = writes;
  if (!writes.inputWrites.length && !writes.ruleWrites.length) {
    out.accepted = [];
    return out;
  }
  const [ctx, reads] = await Promise.all([loadPreviewContext(db), loadEngineReads(db, live.loaded.id)]);
  out.ctx = ctx;
  const ev = await productEngineEvaluation(live.loaded, live.stored, ctx, rates, draft, reads, { writes });
  out.ev = ev;
  if (ev.kind && (ev.needs_write || !ev.complete)) {
    if (!ev.complete) {
      // An engine product never loses its price: a save that would leave it incomplete is refused.
      for (const n of out.accepted) out.refusals.set(n.nkey, { status: 'INVALID_VALUE', message: serverMessage('PRICING_ENGINE_INCOMPLETE') });
      out.accepted = [];
      return out;
    }
    if (opts.otherChanges) {
      for (const n of out.accepted) {
        out.refusals.set(n.nkey, {
          status: 'STRUCTURE_WITH_ADOPTION',
          message:
            'هذا التعديل يعيد تسعير المنتج: طبّق تغييرات المنتج الأخرى أولاً ثم أرفق الملف نفسه مرة ثانية / this change reprices the product: apply the other changes first, then attach the same file again / ئەم گۆڕانکارییە نرخ دەگۆڕێت: سەرەتا گۆڕانکارییەکانی تر جێبەجێ بکە، پاشان هەمان فایل دووبارە هاوپێچ بکە',
        });
      }
      out.accepted = [];
      return out;
    }
    out.kind = 'price';
    out.hash = ev.hash;
    out.large_change = ev.large_change;
    out.adoption = engineEvaluationDto(ev);
    return out;
  }
  out.kind = 'data';
  out.hash = draft.iqd.length ? await formPreviewHash(live.loaded.id, draft.iqd, rates) : null;
  return out;
}
