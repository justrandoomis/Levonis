/**
 * THE OFFER, FROM THE DATABASE'S FACTS (Services S-P2 spec §4.3, §6.3; DECISIONS row 238).
 *
 * Gathers what the pure formula (packages/pricing/src/tradeInOffer.ts) needs —
 * today's public price of each part (B.4 rules 1–5, every price through the
 * strict resolver, `TodayReader`), what was paid (the S-P0 paid-net rule, split
 * across the parts by today's prices), the months used and of warranty left,
 * the repairs LEVONIS itself did (G15) and the condition answers — and returns:
 *
 *   public  the ONE figure the customer reads (offer), today's price when it is
 *           a public price (rule 1 or the device's own SKU), what was paid;
 *   owner   the valuation row (resale, costs, margin, the store's cap, the
 *           parameters) — written to `trade_in_valuations`, read by the owner only.
 *
 * Never on a read: preview (counted), submit, intake, an owner override.
 * The component references and the valuation record are read and written by
 * NAMED COLUMNS only; a database without 0192 has neither (rules 1 and 5 only).
 */
import type { Env } from './types';
import { safeParse } from './types';
import { newId } from './crypto';
import { closedClaimSql } from './deviceOps';
import { loadPricingRates } from './pricingEngine/rates';
import { TodayReader, type NowChannel, type TodayPrice } from './tradeInToday';
import type { ComponentRow, EligibleUnit, RequestRow, RuleBook, StoredRuleSet } from './tradeIn';
import {
  blankInputs,
  validateInputs,
  warrantyMonthsLeft,
  wholeMonthsBetween,
  type ComponentInputs,
  type ComponentRole,
  type TradeInFamily,
} from '@levonis/pricing/tradeIn';
import { componentOffer, paramsOf, requestOffer, splitPaid, type ComponentOffer, type OfferParams } from '@levonis/pricing/tradeInOffer';

export type NowSource = 'own_sku' | 'combo_gap' | 'standalone_cap' | 'standalone' | 'owner_usd' | 'ams_reference' | 'successor' | 'combo_whole';

export interface PartNow {
  now_iqd: number;
  source: NowSource;
  channel: NowChannel | null;
}

export interface UnitNows {
  /** No price today for the device (or its Combo): no offer. */
  missing: boolean;
  combo_now: number | null;
  /** The printer (or the whole device) and, on a Combo, its AMS. */
  device: PartNow | null;
  ams: PartNow | null;
  /** A Combo whose AMS share cannot be priced (rule 5): only `whole`, as one machine at combo_now. */
  split_unavailable: boolean;
}

export interface ComponentRef {
  product_id: string;
  option_value_id: string;
  role: 'device' | 'ams';
  ref_product_id: string | null;
  ref_price_usd: string | null;
}

/** The owner's references for one product (named columns; none on a database without 0192). */
export async function componentRefsFor(db: D1Database, productId: string): Promise<ComponentRef[]> {
  try {
    const { results } = await db
      .prepare('SELECT product_id, option_value_id, role, ref_product_id, ref_price_usd FROM trade_in_component_refs WHERE product_id = ?')
      .bind(productId)
      .all<ComponentRef>();
    return results ?? [];
  } catch (e) {
    if (/no such table/i.test(e instanceof Error ? e.message : String(e))) return [];
    throw e;
  }
}

/** ceil_step(usd × U) — exact decimal arithmetic in BigInt, rounded UP to the step (the V2 writer's own rule). */
export function usdToIqdCeil(usdText: string, rateText: string, step = 1000): number | null {
  const parse = (t: string): { n: bigint; d: bigint } | null => {
    const m = /^(\d{1,12})(?:\.(\d{1,12}))?$/.exec(t.trim());
    if (!m) return null;
    const frac = m[2] ?? '';
    return { n: BigInt(`${m[1]}${frac}`), d: 10n ** BigInt(frac.length) };
  };
  const a = parse(usdText);
  const b = parse(rateText);
  if (!a || !b || a.n === 0n || b.n === 0n) return null;
  const num = a.n * b.n;
  const den = a.d * b.d;
  const iqd = (num + den - 1n) / den;
  const s = BigInt(step);
  const out = ((iqd + s - 1n) / s) * s;
  return out > BigInt(Number.MAX_SAFE_INTEGER) ? null : Number(out);
}

/**
 * B.4 — TODAY'S PRICE OF EACH PART, in the rules' order:
 *   1 Combo SKU − plain sibling SKU (same colour): the AMS is the gap, the printer the plain model;
 *   2 a linked standalone AMS caps that gap;
 *   3 the plain model no longer sold and the link exists: the AMS is the standalone one;
 *   4 the owner's reference (USD, or the AMS rule set's dinar reference), at most half the Combo;
 *   5 none: «printer only» / «AMS only» are unavailable and the whole Combo is one machine.
 * A device that is not a Combo: its own SKU; else the owner's successor or USD reference; else none.
 */
export async function componentNows(
  env: Env,
  reader: TodayReader,
  unit: Pick<EligibleUnit, 'product_id' | 'is_combo' | 'selection'>,
  opts: { amsReferenceIqd: number; refs?: ComponentRef[] }
): Promise<UnitNows> {
  const refs = opts.refs ?? (await componentRefsFor(env.DB, unit.product_id));
  const sel = unit.selection;
  let rate: string | null | undefined;
  const usdRate = async () => {
    if (rate === undefined) rate = (await loadPricingRates(env.DB).catch(() => null))?.usd_iqd ?? null;
    return rate;
  };
  const fromUsd = async (usd: string | null) => (usd && (await usdRate()) ? usdToIqdCeil(usd, (await usdRate())!) : null);
  const own: TodayPrice | null = await reader.price({ productId: unit.product_id, optionValueIds: sel.option_value_ids, colorId: sel.color_id });

  if (!unit.is_combo) {
    if (own) return { missing: false, combo_now: null, device: { now_iqd: own.iqd, source: 'own_sku', channel: own.channel }, ams: null, split_unavailable: false };
    const ref = refs.find((r) => r.role === 'device' && (r.option_value_id === '' || sel.option_value_ids.includes(r.option_value_id)));
    const successor = ref?.ref_product_id ? await reader.lowest(ref.ref_product_id) : null;
    if (successor) return { missing: false, combo_now: null, device: { now_iqd: successor.iqd, source: 'successor', channel: null }, ams: null, split_unavailable: false };
    const usd = await fromUsd(ref?.ref_price_usd ?? null);
    if (usd) return { missing: false, combo_now: null, device: { now_iqd: usd, source: 'owner_usd', channel: null }, ams: null, split_unavailable: false };
    return { missing: true, combo_now: null, device: null, ams: null, split_unavailable: false };
  }

  if (!own) return { missing: true, combo_now: null, device: null, ams: null, split_unavailable: false };
  const combo = own.iqd;
  const plain =
    sel.combo_value_id && sel.plain_value_id
      ? await reader.price({
          productId: unit.product_id,
          optionValueIds: sel.option_value_ids.map((id) => (id === sel.combo_value_id ? sel.plain_value_id! : id)),
          colorId: sel.color_id,
        })
      : null;
  const amsRef =
    refs.find((r) => r.role === 'ams' && sel.combo_value_id !== null && r.option_value_id === sel.combo_value_id) ??
    refs.find((r) => r.role === 'ams' && r.option_value_id === '');
  const standalone = amsRef?.ref_product_id ? await reader.lowest(amsRef.ref_product_id) : null;
  const split = (ams: number, source: NowSource, printerSource: NowSource, printerChannel: NowChannel | null): UnitNows => ({
    missing: false,
    combo_now: combo,
    ams: { now_iqd: ams, source, channel: source === 'combo_gap' ? own.channel : null },
    device: { now_iqd: combo - ams, source: printerSource, channel: printerChannel },
    split_unavailable: false,
  });
  // 1 + 2
  const gap = plain ? combo - plain.iqd : 0;
  if (plain && gap > 0) {
    if (standalone && standalone.iqd < gap) return split(standalone.iqd, 'standalone_cap', 'standalone_cap', null);
    return split(gap, 'combo_gap', 'combo_gap', plain.channel);
  }
  // 3
  if (!plain && standalone && combo - standalone.iqd > 0) return split(standalone.iqd, 'standalone', 'standalone', null);
  // 4
  const refIqd = (await fromUsd(amsRef?.ref_price_usd ?? null)) ?? (opts.amsReferenceIqd > 0 ? opts.amsReferenceIqd : null);
  if (refIqd) {
    const ams = Math.min(refIqd, Math.floor(combo / 2));
    if (ams > 0) return split(ams, amsRef?.ref_price_usd ? 'owner_usd' : 'ams_reference', amsRef?.ref_price_usd ? 'owner_usd' : 'ams_reference', null);
  }
  // 5
  return {
    missing: false,
    combo_now: combo,
    device: { now_iqd: combo, source: 'combo_whole', channel: own.channel },
    ams: { now_iqd: 0, source: 'combo_whole', channel: null },
    split_unavailable: true,
  };
}

/** Repairs LEVONIS did on the slot's devices (G15): closed warranty claims decided «repair». */
export async function systemRepairs(db: D1Database, orderItemId: string, unitIds: readonly string[]): Promise<number> {
  const row = await db
    .prepare(
      `SELECT COUNT(*) AS n FROM warranty_claims wc
        WHERE (wc.unit_id IN (SELECT value FROM json_each(?2)) OR (wc.unit_id IS NULL AND wc.order_item_id = ?1))
          AND wc.decision = 'repair' AND ${closedClaimSql('wc')}`
    )
    .bind(orderItemId, JSON.stringify(unitIds))
    .first<{ n: number }>();
  return Number(row?.n ?? 0);
}

export interface ValuationDraft {
  phase: 'submit' | 'intake' | 'override' | 'cutover';
  offer_iqd: number | null;
  ceiling_iqd: number | null;
  store_cap_iqd: number | null;
  expected_margin_iqd: number | null;
  params_json: string;
  components_json: string;
}

export interface OfferOutcome {
  offer_iqd: number | null;
  no_offer_reason: 'no_price_today' | 'below_minimum' | 'scope_unavailable' | null;
  /** Σ today's price of the scope — only when every part is a PUBLIC price (rule 1 or its own SKU). */
  now_price_iqd: number | null;
  now_price_channel: NowChannel | null;
  /** What was paid for the scope (paid net, split by today's prices). */
  paid_net_iqd: number | null;
  usage_months: number;
  warranty_remaining_months: number;
  rule_versions: Partial<Record<TradeInFamily, number>>;
  /** The owner's record (never sent to a customer or a staff member). */
  owner: ValuationDraft;
  parts: ComponentOffer[];
}

const PUBLIC_SOURCES: ReadonlySet<NowSource> = new Set(['own_sku', 'combo_gap']);

/** The stored offer parameters of a rule set, as the pure module reads them. */
export function offerParamsOf(rules: StoredRuleSet): OfferParams {
  return paramsOf({ family: rules.family, cap_bp: rules.cap_bp, ...(rules.offer_params ?? {}) });
}

/**
 * THE OFFER for a request's components, at `nowIso`. `inputsOf` names whose
 * answers count: the customer's at preview/submit, the desk's at intake.
 */
export async function offerFor(
  env: Env,
  args: {
    req: Pick<RequestRow, 'scope' | 'source_snapshot_json' | 'source_product_id' | 'order_item_id'>;
    unit: Pick<EligibleUnit, 'product_id' | 'is_combo' | 'selection' | 'paid_iqd'>;
    comps: ReadonlyArray<Pick<ComponentRow, 'role' | 'family'>>;
    book: RuleBook;
    phase: ValuationDraft['phase'] | 'preview';
    inputsOf: (c: Pick<ComponentRow, 'role' | 'family'>) => ComponentInputs;
    slotUnitIds: readonly string[];
    nowIso: string;
    reader?: TodayReader;
  }
): Promise<OfferOutcome> {
  const { req, unit, comps, book, nowIso } = args;
  const reader = args.reader ?? new TodayReader(env);
  const snap = safeParse<{ delivered_at?: string | null; warranty_end_at?: string | null }>(req.source_snapshot_json, {});
  const usage = wholeMonthsBetween(snap.delivered_at ?? null, nowIso);
  const left = warrantyMonthsLeft(snap.warranty_end_at ?? null, nowIso);
  const versions: Partial<Record<TradeInFamily, number>> = {};
  for (const c of comps) versions[c.family] = book[c.family].version;
  const [nows, repairs] = await Promise.all([
    componentNows(env, reader, unit, { amsReferenceIqd: book.ams.ams_reference_iqd }),
    systemRepairs(env.DB, req.order_item_id, args.slotUnitIds),
  ]);
  const roles = new Set(comps.map((c) => c.role));
  const primary = comps.find((c) => c.role === 'device') ?? comps[0];
  const primaryParams = offerParamsOf(book[primary?.family ?? 'fdm']);
  const paramsJson = JSON.stringify({
    rule_versions: versions,
    params: Object.fromEntries([...new Set(comps.map((c) => c.family))].map((f) => [f, offerParamsOf(book[f])])),
  });
  const none = (reason: NonNullable<OfferOutcome['no_offer_reason']>): OfferOutcome => ({
    offer_iqd: null,
    no_offer_reason: reason,
    now_price_iqd: null,
    now_price_channel: null,
    paid_net_iqd: unit.paid_iqd,
    usage_months: usage,
    warranty_remaining_months: left,
    rule_versions: versions,
    owner: { phase: args.phase === 'preview' ? 'submit' : args.phase, offer_iqd: null, ceiling_iqd: null, store_cap_iqd: null, expected_margin_iqd: null, params_json: paramsJson, components_json: JSON.stringify({ nows }) },
    parts: [],
  });
  if (nows.missing || !nows.device) return none('no_price_today');
  if (nows.split_unavailable && req.scope !== 'whole') return none('scope_unavailable');

  // What was paid for each part, split by today's prices (AMS first; a Combo whose AMS cannot be priced is one machine).
  const amsNow = nows.ams?.now_iqd ?? 0;
  const deviceNow = nows.device.now_iqd;
  const [paidAms, paidDevice] = unit.is_combo && !nows.split_unavailable ? splitPaid(unit.paid_iqd, [amsNow, deviceNow]) : [0, unit.paid_iqd];
  const parts: ComponentOffer[] = [];
  const nowOf = (role: ComponentRole) => (role === 'ams' ? nows.ams : nows.device);
  for (const c of comps) {
    const rules = book[c.family];
    const p = offerParamsOf(rules);
    const asked = args.inputsOf(c);
    const inputs: ComponentInputs = { ...asked, repairs_count: Math.max(asked.repairs_count, repairs) };
    parts.push(
      componentOffer(rules, p, {
        role: c.role,
        family: c.family,
        now_iqd: nowOf(c.role)?.now_iqd ?? 0,
        paid_iqd: c.role === 'ams' ? paidAms : paidDevice,
        usage_months: usage,
        warranty_left_months: left,
        product_id: req.source_product_id ?? unit.product_id,
        inputs,
      })
    );
  }
  const r = requestOffer(parts, {
    wholeComboNowIqd: unit.is_combo && req.scope === 'whole' ? nows.combo_now : null,
    fdmParams: primaryParams,
    rounding: primaryParams.offer_rounding_iqd,
    minOffer: primaryParams.min_offer_iqd,
  });
  const inScope = comps.map((c) => nowOf(c.role)).filter((x): x is PartNow => !!x);
  const allPublic = inScope.every((x) => PUBLIC_SOURCES.has(x.source));
  const splitPrivate =
    unit.is_combo && !nows.split_unavailable && req.scope !== 'whole' && [nows.ams, nows.device].some((x) => !!x && !PUBLIC_SOURCES.has(x.source));
  const nowSum = unit.is_combo && req.scope === 'whole' && !nows.split_unavailable ? (nows.combo_now ?? 0) : inScope.reduce((n, x) => n + x.now_iqd, 0);
  const channel = roles.has('device') ? nows.device.channel : (nows.ams?.channel ?? null);
  const components = parts.map((x) => ({ ...x, now_source: nowOf(x.role)?.source ?? null, now_channel: nowOf(x.role)?.channel ?? null }));
  return {
    offer_iqd: r.offer_iqd,
    no_offer_reason: r.offer_iqd === null ? 'below_minimum' : null,
    now_price_iqd: allPublic ? nowSum : null,
    now_price_channel: allPublic ? channel : null,
    // What was paid for the parts in scope: the customer's own figure — unless it is a Combo's part
    // split by today's prices and one of those prices is the owner's private reference (review F-6):
    // the split would give the reference away (paid × part ÷ whole). Then the request carries none.
    paid_net_iqd: splitPrivate ? null : parts.reduce((n, x) => n + x.paid_iqd, 0),
    usage_months: usage,
    warranty_remaining_months: left,
    rule_versions: versions,
    owner: {
      phase: args.phase === 'preview' ? 'submit' : args.phase,
      offer_iqd: r.offer_iqd,
      ceiling_iqd: null,
      store_cap_iqd: r.store_cap_iqd,
      expected_margin_iqd: r.expected_margin_iqd,
      params_json: paramsJson,
      components_json: JSON.stringify(components),
    },
    parts,
  };
}

/** The validated answers stored on a component (or blank), for `inputsOf`. */
export function storedInputs(json: string, rules: StoredRuleSet): ComponentInputs {
  const checked = validateInputs(safeParse(json, {}), rules);
  return checked.ok ? checked.value : blankInputs(rules.family);
}

/** The owner's valuation record, one INSERT (id `tiv_…`), named columns. */
export function valuationStatement(db: D1Database, requestId: string, row: ValuationDraft, actorId: string | null, now: string): D1PreparedStatement {
  return db
    .prepare(
      `INSERT INTO trade_in_valuations (id, request_id, phase, offer_iqd, ceiling_iqd, store_cap_iqd, expected_margin_iqd, params_json, components_json, actor_id, created_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)`
    )
    .bind(newId('tiv'), requestId, row.phase, row.offer_iqd, row.ceiling_iqd, row.store_cap_iqd, row.expected_margin_iqd, row.params_json, row.components_json, actorId, now);
}

/** The owner's valuation rows of one request, newest first (owner door only). */
export async function valuationsOf(db: D1Database, requestId: string) {
  const { results } = await db
    .prepare(
      `SELECT phase, offer_iqd, ceiling_iqd, store_cap_iqd, expected_margin_iqd, params_json, components_json, actor_id, created_at
         FROM trade_in_valuations WHERE request_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 20`
    )
    .bind(requestId)
    .all<{
      phase: string;
      offer_iqd: number | null;
      ceiling_iqd: number | null;
      store_cap_iqd: number | null;
      expected_margin_iqd: number | null;
      params_json: string;
      components_json: string;
      actor_id: string | null;
      created_at: string;
    }>();
  return (results ?? []).map((r) => ({
    phase: r.phase,
    offer: r.offer_iqd,
    ceiling: r.ceiling_iqd,
    store_cap: r.store_cap_iqd,
    expected_margin: r.expected_margin_iqd,
    components: safeParse<unknown>(r.components_json, []),
    params: safeParse<unknown>(r.params_json, {}),
    actor_id: r.actor_id,
    created_at: r.created_at,
  }));
}

/** The newest valuation row of one request (named columns; null when none or on a database without 0192). */
export async function latestValuation(db: D1Database, requestId: string) {
  try {
    return (
      (await db
        .prepare(
          `SELECT phase, offer_iqd, ceiling_iqd, store_cap_iqd, expected_margin_iqd, params_json, components_json
             FROM trade_in_valuations WHERE request_id = ? AND phase IN ('submit','intake','cutover') ORDER BY created_at DESC, rowid DESC LIMIT 1`
        )
        .bind(requestId)
        .first<{ phase: string; offer_iqd: number | null; ceiling_iqd: number | null; store_cap_iqd: number | null; expected_margin_iqd: number | null; params_json: string; components_json: string }>()) ?? null
    );
  } catch (e) {
    if (/no such table/i.test(e instanceof Error ? e.message : String(e))) return null;
    throw e;
  }
}

/**
 * THE OWNER'S RECORD OF A VALUE ABOVE THE CEILING (decision 3, spec §6.6): the store's own cap (Σ of
 * each part's E − K − M, owner-only) and the expected margin at that value, from the newest
 * computation. `needs_ack`: the value passes the store's cap and the owner did not acknowledge that
 * the margin may be a loss (TRADE_IN_MARGIN_ACK_REQUIRED). No computation on record (a request sent
 * before S-P2 and never received): the cap is unknown, so the acknowledgement is asked.
 */
export async function overrideRecord(
  db: D1Database,
  requestId: string,
  value: number,
  ceiling: number,
  ownerReason: string,
  acknowledged: boolean
): Promise<{ needs_ack: boolean; row: ValuationDraft }> {
  const last = await latestValuation(db, requestId);
  const cap = last?.store_cap_iqd ?? null;
  // Σ(E − K) − value: the newest record's margin plus its offer is Σ(E − K).
  const margin = last && last.expected_margin_iqd !== null && last.offer_iqd !== null ? last.expected_margin_iqd + last.offer_iqd - value : null;
  return {
    needs_ack: (cap === null || value > cap) && !acknowledged,
    row: {
      phase: 'override',
      offer_iqd: value,
      ceiling_iqd: ceiling,
      store_cap_iqd: cap,
      expected_margin_iqd: margin,
      params_json: JSON.stringify({ from_phase: last?.phase ?? null, owner_reason: ownerReason, ack_below_margin: acknowledged }),
      components_json: last?.components_json ?? '[]',
    },
  };
}
