/**
 * PRICING V2 — WHAT EACH ROLE MAY READ OF A V2 EVALUATION (spec §3.1 dto.ts,
 * §4.4 role projection, C-7; V2-3b's routes answer through these).
 *
 * Built from EXPLICIT ALLOW-LISTS, field by field — never by deleting keys from
 * a richer object, so a field added to the evaluation later reaches nobody
 * until it is listed here:
 *   - everyone who may see the product's prices (owner and price editors): the
 *     final IQD table, old → new, the 15% / 30% flags, whether a route is
 *     blocked, the grouped missing codes and field NAMES, the hash (`review_hash`,
 *     C-14: never `preview_hash` / `change_pct`, the V1 and FX oracle keys of
 *     FINANCIAL_FIELDS — the V2 change is `change_percent`);
 *   - the owner alone (`v2_*`, every key in FINANCIAL_FIELDS): the exact IQD,
 *     the USD ceiling, the floor and its flags, R, T, `below_cost`, U — never
 *     to a price editor;
 *   - on a PRICE-FIRST product, the owner AND the price editors (the owner's
 *     answer Q2, DECISIONS row 222: «staff see and edit USD»; the owner
 *     accepted that staff may work out U, risk R-2): the dollar points and
 *     discounts they edit and each channel's exact dollars, under keys
 *     outside FINANCIAL_FIELDS (`editor_usd`, `editor_usd_price`, added by
 *     api.ts `v2Answer`). Never on a cost-first product, where D = R + T.
 * Nothing here is computed: every figure is the evaluation's own.
 */
import type { V2Evaluation, V2Row } from './evaluate';

/** One row of the table every price editor reads: final IQD only. */
function publicRow(r: V2Row) {
  return {
    combo_key: r.combo_key,
    option_value_ids: [...r.option_value_ids],
    color_id: r.color_id,
    names: { ar: r.name_ar, en: r.name_en, ckb: r.name_ckb },
    channel: r.channel,
    price_iqd: r.new_iqd,
    old_iqd: r.old_iqd,
    ...(r.blocked ? { blocked: true as const } : {}),
  };
}

/** The owner's private figures of one row (every key `v2_*`, FINANCIAL_FIELDS). */
function ownerExtras(r: V2Row) {
  const o = r.owner;
  return o
    ? {
        v2_exact_iqd: o.exact_iqd,
        v2_usd_ceil6: o.usd_ceil6,
        v2_delta_usd: o.deltas_usd,
        v2_discount_usd: o.discount_usd,
        v2_discount_scope: o.discount_from ? { scope: o.discount_from.scope, id: o.discount_from.scope_id } : null,
        v2_floor: o.floor,
        v2_replacement_iqd: o.replacement_cost_iqd,
        v2_profit_usd: o.target_profit_usd,
        v2_below_cost: o.below_cost,
      }
    : null;
}

const changeOf = (r: V2Row) => ({
  combo_key: r.combo_key,
  names: { ar: r.name_ar, en: r.name_en, ckb: r.name_ckb },
  channel: r.channel,
  old_iqd: r.old_iqd,
  new_iqd: r.new_iqd,
  change_percent: r.change_pct,
  large: r.large,
  drop_flag: r.drop_flag,
});

/** A price editor's (or any non-owner admin's) view of an evaluation: final dinars, codes and names only. */
export function v2EditorAnswer(ev: V2Evaluation) {
  return {
    product_id: ev.product_id,
    v2: true as const,
    method: ev.method,
    complete: ev.complete,
    codes: [...ev.codes],
    table: ev.rows.map(publicRow),
    changes: ev.changes.map(changeOf),
    missing: ev.missing.map((m) => ({ code: m.code, field: m.field, level: m.level, count: m.count, first_name: m.first_name })),
    large_change: ev.large_change,
    drop_flag: ev.drop_flag,
    needs_write: ev.needs_write,
    // C-14: versions and final prices only — never U, R or T. Not `preview_hash`: that key is the V1 and
    // FX hashes', which bind private values (FINANCIAL_FIELDS); the apply body still sends it as `preview_hash`.
    review_hash: ev.hash,
  };
}

/** The owner's view: the editor's, plus the private figures per row and the dollar set behind them. */
export function v2OwnerAnswer(ev: V2Evaluation) {
  const base = v2EditorAnswer(ev);
  return {
    ...base,
    table: ev.rows.map((r) => ({ ...publicRow(r), owner: ownerExtras(r) })),
    v2_points: ev.points.map((p) => ({ scope: p.scope, id: p.scope_id, kind: p.kind, usd: p.usd })),
    v2_discounts: ev.discounts.map((d) => ({ scope: d.scope, id: d.scope_id, usd: d.usd })),
    v2_rate: ev.rates?.usd_iqd ? { usd_iqd: ev.rates.usd_iqd, version: ev.rates.pair_versions.USD_IQD } : null,
  };
}
