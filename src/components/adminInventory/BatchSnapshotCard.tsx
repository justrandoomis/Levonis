import { useEffect, useState } from 'react';
import { api, money, T } from '../adminOperations/shared';
import { useLanguage } from '../../LanguageContext';
import { BATCH_STRINGS as S, tri } from './batchSnapshotStrings';

/**
 * «الدفعة وأسعار الشراء» — THE OWNER'S BATCH SNAPSHOT (FX programme plan §9
 * §16-§19; push FX-6). Reads GET /api/admin/pricing/batches, which only the
 * verified owner is answered: anyone else is refused at the pricing door, and
 * this card then renders nothing at all — not even its heading.
 *
 * Two costs, never mixed (§19): first what the batch actually cost in dinars
 * (fixed; a reconciliation is a new version), then apart from it the
 * purchase-time snapshot. A batch received before the snapshot existed reads
 * «بالدينار فقط» (§18) — or a figure derived from its own purchase, labelled
 * so — and is never converted at today's rate. The client computes no money:
 * every figure is the server's, formatted.
 */
type Snapshot = {
  snapshot_source: 'purchase' | 'legacy_incoming';
  purchase_id: string | null;
  supplier_original_currency: string | null;
  supplier_original_amount: string | null;
  supplier_cost_mode: 'unit' | 'total' | null;
  supplier_line_total_original: string | null;
  exchange_rate_at_purchase: string | null;
  supplier_cost_usd_at_purchase: string | null;
  usd_iqd_rate_at_purchase: string | null;
  eur_usd_rate_at_purchase: string | null;
  cny_usd_rate_at_purchase: string | null;
  usd_iqd_fx_version: number | null;
  eur_usd_fx_version: number | null;
  cny_usd_fx_version: number | null;
  fx_snapshot_at: string | null;
  fx_snapshot_source: 'document' | 'central' | null;
  historical_usd_equivalent: string | null;
  calculated_at: string | null;
  split_from_lot_id: string | null;
};
export type BatchView = {
  id: string;
  received_at: string;
  qty_received: number;
  qty_remaining: number;
  batch_cost: { unit_cost_iqd: number | null; actual_landed_cost_iqd: number | null; actual_landed_total_iqd: number | null };
  snapshot_state: 'recorded' | 'derived' | 'iqd_only';
  snapshot: Snapshot | null;
  derived: { usd_iqd_rate: string; historical_usd_equivalent: string | null; derived_from: 'purchase_document' | 'purchase_snapshot' } | null;
};
export type BatchFilter = { lot_id: string } | { purchase_id: string } | { product_id: string };

const queryOf = (f: BatchFilter) =>
  'lot_id' in f ? `lot_id=${encodeURIComponent(f.lot_id)}` : 'purchase_id' in f ? `purchase_id=${encodeURIComponent(f.purchase_id)}` : `product_id=${encodeURIComponent(f.product_id)}`;

const day = (iso: string | null | undefined) => (iso ? iso.slice(0, 10) : '—');

export default function BatchSnapshotCard({ filter, title }: { filter: BatchFilter; title?: 'lot' | 'purchase' }) {
  const { loc } = useLanguage();
  const t = (entry: (typeof S)[keyof typeof S], values?: Record<string, string | number>) => tri(loc, entry, values);
  const [state, setState] = useState<{ status: 'loading' | 'ready' | 'hidden' | 'failed'; batches: BatchView[] }>({ status: 'loading', batches: [] });
  const query = queryOf(filter);
  useEffect(() => {
    const controller = new AbortController();
    setState({ status: 'loading', batches: [] });
    api
      .get<{ batches: BatchView[] }>(`/api/admin/pricing/batches?${query}`, { signal: controller.signal })
      .then((r) => setState({ status: 'ready', batches: r.batches ?? [] }))
      .catch((e: { status?: number }) => {
        if (controller.signal.aborted) return;
        // Not the owner (403) or a database without the pricing router: nothing to show.
        setState({ status: e?.status === 403 || e?.status === 401 || e?.status === 404 ? 'hidden' : 'failed', batches: [] });
      });
    return () => controller.abort();
  }, [query]);

  if (state.status === 'hidden') return null;
  const unknown = <em className={T.text3}>{t(S.unknown)}</em>;
  const value = (v: string | null | undefined, suffix?: string) => (v == null ? unknown : <span dir="ltr">{v}{suffix ? ` ${suffix}` : ''}</span>);
  const rate = (v: string | null, version: number | null) =>
    v == null ? unknown : <span><span dir="ltr">{v}</span>{version != null ? <small className={T.text3}> · {t(S.version, { n: version })}</small> : null}</span>;

  return <section className="inventory-line mb-4" data-batch-snapshot aria-busy={state.status === 'loading'}>
    <h4>{t(title === 'purchase' ? S.purchaseTitle : S.title)}</h4>
    {state.status === 'loading' && <p role="status" className={`text-sm ${T.text3}`}>{t(S.loading)}</p>}
    {state.status === 'failed' && <p role="alert" className={`text-sm ${T.text3}`}>{t(S.failed)}</p>}
    {state.status === 'ready' && !state.batches.length && <p className={`text-sm ${T.text3}`}>{t(S.empty)}</p>}
    {state.batches.map((b) => {
      const s = b.snapshot;
      return <article key={b.id} className="my-3" data-batch-state={b.snapshot_state}>
        <strong className="text-sm">{t(S.batch, { id: b.id.slice(-8), date: day(b.received_at) })}</strong>
        <h5 className={`mt-2 text-xs ${T.text3}`}>{t(S.batchCostTitle)}</h5>
        <dl className="inventory-review">
          <div><dt>{t(S.bookedUnit)}</dt><dd>{money(b.batch_cost.unit_cost_iqd)}</dd></div>
          <div><dt>{t(S.actualUnit)}</dt><dd>{money(b.batch_cost.actual_landed_cost_iqd)}</dd></div>
          <div><dt>{t(S.actualTotal)}</dt><dd>{money(b.batch_cost.actual_landed_total_iqd)}</dd></div>
        </dl>
        <p className={`text-xs ${T.text3}`}>{t(S.immutableNote)}</p>
        <h5 className={`mt-2 text-xs ${T.text3}`}>{t(S.snapshotTitle)}</h5>
        {b.snapshot_state === 'iqd_only' && <p className="text-sm" data-batch-iqd-only><strong>{t(S.iqdOnly)}</strong> — {t(S.iqdOnlyNote)}</p>}
        {b.snapshot_state === 'derived' && b.derived && <>
          <dl className="inventory-review">
            <div><dt>{t(S.usdIqd)}</dt><dd>{value(b.derived.usd_iqd_rate)} <small className={T.text3}>({t(b.derived.derived_from === 'purchase_document' ? S.derivedDocument : S.derivedSnapshot)})</small></dd></div>
            <div><dt>{t(S.historicalUsd)}</dt><dd>{value(b.derived.historical_usd_equivalent, 'USD')}</dd></div>
          </dl>
          <p className={`text-xs ${T.text3}`}>{t(S.derivedNote)}</p>
        </>}
        {s && <>
          <dl className="inventory-review">
            <div><dt>{t(S.supplierAmount)}</dt><dd>{s.supplier_original_currency && s.supplier_original_amount != null ? <span dir="ltr">{s.supplier_original_amount} {s.supplier_original_currency}</span> : unknown}</dd></div>
            {s.supplier_cost_mode === 'total' && <div><dt>{t(S.lineTotal)}</dt><dd>{value(s.supplier_line_total_original, s.supplier_original_currency ?? undefined)}</dd></div>}
            <div><dt>{t(S.documentRate)}</dt><dd>{value(s.exchange_rate_at_purchase)}</dd></div>
            <div><dt>{t(S.usdIqd)}</dt><dd>{rate(s.usd_iqd_rate_at_purchase, s.usd_iqd_fx_version)}{s.fx_snapshot_source && <small className={T.text3}> ({t(s.fx_snapshot_source === 'document' ? S.fromDocument : S.fromCentral)})</small>}</dd></div>
            <div><dt>{t(S.eurUsd)}</dt><dd>{rate(s.eur_usd_rate_at_purchase, s.eur_usd_fx_version)}</dd></div>
            <div><dt>{t(S.cnyUsd)}</dt><dd>{rate(s.cny_usd_rate_at_purchase, s.cny_usd_fx_version)}</dd></div>
            <div><dt>{t(S.supplierUsd)}</dt><dd>{value(s.supplier_cost_usd_at_purchase, 'USD')}</dd></div>
            <div><dt>{t(S.historicalUsd)}</dt><dd>{value(s.historical_usd_equivalent, 'USD')}</dd></div>
          </dl>
          <p className={`text-xs ${T.text3}`}>
            {s.fx_snapshot_at && <>{t(S.ratesTakenAt, { date: day(s.fx_snapshot_at) })} · </>}
            {t(S.recordedAt, { date: day(s.calculated_at) })}
            {s.split_from_lot_id && <> · {t(S.splitFrom, { id: s.split_from_lot_id.slice(-8) })}</>}
          </p>
        </>}
      </article>;
    })}
  </section>;
}
