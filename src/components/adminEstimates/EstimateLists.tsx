/**
 * «جاهز للتطبيق» · «المنتجات التقديرية» · «الملاحظات» · «التحديث» — THE STORED
 * PREVIEWS (docs/SMART_PRICING.md §4.6–§4.10, §7).
 *
 *   READY      products with no blocking flag (`GET /estimates/products?state=ready`):
 *              the source, supplier amount and currency, R (`est_cost_iqd`) and D,
 *              the soft flags. «احسب الكل» computes every page (`POST /estimates/
 *              compute {cursor}`, nothing published); a selection is applied five
 *              products a call (`POST /estimates/apply`), each in its own batch,
 *              with per-product outcomes — a stale hash answers the fresh
 *              preview, which the owner reviews before applying again;
 *   ESTIMATED  every labelled product: «تأكيد السعر» (§4.9 — the whole product or
 *              chosen SKUs, every open soft flag accepted by name, never while a
 *              default measure prices a SKU), pause and resume;
 *   FLAGS      labelled products with open flags, in the owner's words;
 *   REFRESH    products whose recomputed estimate differs from the published one —
 *              a price, or real measures its apply takes in where the published
 *              one is on a type default (§4.9 refuses until then; such a row
 *              says no price changes): old → new and %; a large change needs
 *              the tick (no fresh sign-in: DECISIONS row 285).
 *
 * Every figure is the server's (R and D in dinars, supplier amounts as
 * decimal text, the change as its percentage text); nothing is computed here.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { ArrowLeft, Calculator, CheckCircle2, Play } from 'lucide-react';
import { Button } from '../ui/Button';
import { StatusChip } from '../ui/Badge';
import { Checkbox } from '../ui/Switch';
import { Segmented } from '../ui/Segmented';
import { Skeleton } from '../ui/Skeleton';
import {
  applyEstimates,
  computeEstimates,
  fetchEstimates,
  productEditorHref,
  setEstimateProduct,
  type ApplyItem,
  type ApplyOutcome,
  type EstimateFlagEntry,
  type EstimateLine,
  type EstimateListFilter,
  type EstimatePreview,
  type EstimatesPage,
  type StoredEstimate,
} from './api';
import { ActNote, Failure, FlagList, Ltr, Pager, SourceChip, refusalText, useAct, useCursorPages, useUiLang } from './parts';
import ConfirmSheet, { lineName, useSkuLabels, type LabelMap } from './ConfirmSheet';
import { applyInPages, computeAllPages } from './runs';
import { COMMON, ESTIMATE_STATE_LABELS, LISTS, MEASURE_LABELS, OUTCOMES, REVIEW, flagText, say, type UiLang } from './strings';
import { dayOf, iqdText, moneyText, pctText } from './format';

export type ListMode = 'ready' | 'estimated' | 'flags' | 'refresh';

/** The outcome of one product of an apply, in the owner's words. */
export function outcomeText(o: ApplyOutcome, lang: UiLang): { tone: 'success' | 'warning' | 'danger'; text: string } {
  if (o.outcome === 'applied') return { tone: 'success', text: say(OUTCOMES.applied, lang) };
  if (o.outcome === 'already') return { tone: 'success', text: say(OUTCOMES.already, lang) };
  if (o.code === 'PRICING_PREVIEW_STALE') return { tone: 'warning', text: say(OUTCOMES.stale, lang) };
  if (o.code === 'PRICING_LARGE_CHANGE_CONFIRM') return { tone: 'warning', text: say(OUTCOMES.needsTick, lang) };
  if (o.code === 'PRICE_ESTIMATE_NOT_ELIGIBLE') {
    const flags = Array.isArray(o.details?.flags) ? (o.details!.flags as unknown[]).filter((f): f is string => typeof f === 'string') : [];
    if (flags.length) return { tone: 'danger', text: say(OUTCOMES.notEligible, lang, { flags: flags.map((f) => flagText(f, lang)).join(' · ') }) };
  }
  return { tone: 'danger', text: say(OUTCOMES.refused, lang, { reason: refusalText({ code: o.code, message: '' }, lang) }) };
}

/** A line's codes that say where its supplier price came from (soft, §4.6). */
const LINE_SOURCE_CODES: readonly string[] = ['EST_US_REFERENCE', 'EST_MANUAL_PRICE', 'EST_STORE_PAGE_PRICE', 'EST_UNITS_DIVIDED'];

/**
 * The flags a row shows for its product: the server's; in «التحديث», also where the refresh's lines take their
 * supplier prices from, each with its options, since the apply would publish those. A flag naming no option is
 * the product's already.
 */
export function rowFlags(r: Pick<StoredEstimate, 'flags' | 'lines'>, mode: ListMode): EstimateFlagEntry[] {
  if (mode !== 'refresh') return r.flags;
  const out = new Map(r.flags.map((f) => [f.code, f] as const));
  let added = false;
  for (const l of r.lines) {
    for (const code of l.flags) {
      if (!LINE_SOURCE_CODES.includes(code)) continue;
      const was = out.get(code);
      if (was && !was.combo_keys?.length) continue;
      out.set(code, { ...was, code, combo_keys: [...new Set([...(was?.combo_keys ?? []), l.combo_key])].sort() });
      added = true;
    }
  }
  return added ? [...out.values()].sort((a, b) => (a.code < b.code ? -1 : a.code > b.code ? 1 : 0)) : r.flags;
}

/**
 * A refresh none of whose lines moves its published price: «التحديث» lists it only because its apply takes real
 * measures in where the published estimate is on a type default (the server's `LIST_WHERE.refresh`), which the row says.
 */
export const refreshKeepsPrices = (lines: readonly Pick<EstimateLine, 'est_price_iqd' | 'published_price_iqd'>[]): boolean =>
  lines.length > 0 && lines.every((l) => l.est_price_iqd === l.published_price_iqd);

/** A fresh preview (a stale apply's) laid over the stored row, so the next apply carries the fresh hash. */
function withPreview(row: StoredEstimate, p: EstimatePreview): StoredEstimate {
  return { ...row, state: p.state, label: p.label, type: p.type, flags: p.flags, preview_hash: p.preview_hash, computed_at: p.computed_at, lines: p.lines, version: p.version };
}

const isPreview = (v: unknown): v is EstimatePreview =>
  !!v && typeof v === 'object' && Array.isArray((v as EstimatePreview).lines) && Array.isArray((v as EstimatePreview).flags) && typeof (v as EstimatePreview).product_id === 'string';

export default function EstimateListTab({ mode, onReview }: { mode: ListMode; onReview: (productId: string) => void }) {
  const { lang } = useUiLang();
  const [view, setView] = useState<'estimated' | 'paused' | 'confirmed'>('estimated');
  const filter: EstimateListFilter = mode === 'estimated' ? view : mode;
  const pages = useCursorPages(filter);
  const [data, setData] = useState<EstimatesPage | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [reload, setReload] = useState(0);
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  const [large, setLarge] = useState<ReadonlySet<string>>(new Set());
  const [outcomes, setOutcomes] = useState<ReadonlyMap<string, ApplyOutcome>>(new Map());
  const [confirming, setConfirming] = useState<StoredEstimate | null>(null);
  const act = useAct(lang, () => setReload((n) => n + 1));
  const stop = useRef(false);
  const [progress, setProgress] = useState<string | null>(null);

  useEffect(() => {
    const ac = new AbortController();
    setError(null);
    setData(null);
    fetchEstimates(filter, pages.cursor, { signal: ac.signal, mascot: 'silent' })
      .then((a) => {
        if (!ac.signal.aborted) setData(a);
      })
      .catch((e) => {
        if (!ac.signal.aborted) setError(e);
      });
    return () => ac.abort();
  }, [filter, pages.cursor, reload]);

  useEffect(() => {
    setSelected(new Set());
    setOutcomes(new Map());
  }, [filter, pages.cursor]);

  const rows = useMemo(() => data?.products ?? [], [data]);
  const applicable = useMemo(() => rows.filter((r) => !!r.preview_hash && (r.state === 'candidate' || r.state === 'estimated')), [rows]);
  const canApply = mode === 'ready' || mode === 'refresh';

  /** «احسب الكل»: every page of compute, until the end or «أوقف». Nothing is published. */
  const computeAll = () =>
    act.run(
      'compute',
      () => {
        stop.current = false;
        return computeAllPages(computeEstimates, { shouldStop: () => stop.current, onPage: (n) => setProgress(say(LISTS.computing, lang, { n })) }).finally(() => setProgress(null));
      },
      ({ stopped, ...r }) => {
        setProgress(null);
        setReload((x) => x + 1);
        return { tone: 'success', text: stopped ? `${say(LISTS.computeDone, lang, r)} ${say(COMMON.stopped, lang)}` : say(LISTS.computeDone, lang, r) };
      }
    );

  /** Apply the selection, five a call; the items a call defers are sent again as its cursor. */
  const applySelected = () => {
    const items: ApplyItem[] = applicable
      .filter((r) => selected.has(r.product_id))
      .map((r) => ({ product_id: r.product_id, preview_hash: r.preview_hash!, ...(large.has(r.product_id) ? { confirm_large_change: true } : {}) }));
    if (!items.length) return;
    return act.run(
      'apply',
      () => {
        stop.current = false;
        return applyInPages(items, applyEstimates, {
          shouldStop: () => stop.current,
          onResults: (done) => {
            setOutcomes(new Map(done));
            setProgress(say(LISTS.applying, lang, { done: done.size, total: items.length }));
          },
        }).finally(() => setProgress(null));
      },
      (done) => {
        setProgress(null);
        // A stale hash came back with its fresh preview: the row shows it, and the next apply carries its hash.
        setData((d) => {
          if (!d) return d;
          return {
            ...d,
            products: d.products.map((r) => {
              const o = done.get(r.product_id);
              const fresh = o && o.outcome === 'refused' && o.code === 'PRICING_PREVIEW_STALE' ? o.details?.preview : null;
              return isPreview(fresh) ? withPreview(r, fresh) : r;
            }),
          };
        });
        const applied = [...done.values()].filter((o) => o.outcome !== 'refused').length;
        setSelected(new Set());
        return { tone: applied === items.length ? 'success' : 'warning', text: say(LISTS.applyDone, lang, { applied, total: items.length }) };
      }
    );
  };

  const intro = mode === 'ready' ? LISTS.readyIntro : mode === 'estimated' ? LISTS.estimatedIntro : mode === 'flags' ? LISTS.flagsIntro : LISTS.refreshIntro;

  return (
    <section className="space-y-4" data-estimates-list={mode}>
      <p className="max-w-[72ch] text-[13px] leading-relaxed text-text-secondary">{say(intro, lang)}</p>
      <div className="flex min-w-0 flex-wrap items-center gap-2">
        {mode === 'estimated' ? (
          <Segmented
            group="estimate-list-view"
            label={say(LISTS.viewLabel, lang)}
            value={view}
            onChange={(v) => setView(v as typeof view)}
            size="sm"
            items={(['estimated', 'paused', 'confirmed'] as const).map((v) => ({ id: v, label: say(LISTS.views[v], lang) }))}
          />
        ) : null}
        {canApply ? (
          <>
            <Button variant="secondary" icon={<Calculator aria-hidden="true" className="h-4 w-4" />} loading={act.busy === 'compute'} disabled={!!act.busy && act.busy !== 'compute'} onClick={() => void computeAll()} data-estimates-compute-all>
              {say(LISTS.computeAll, lang)}
            </Button>
            <Button
              variant="primary"
              icon={<Play aria-hidden="true" className="h-4 w-4" />}
              loading={act.busy === 'apply'}
              disabled={(!!act.busy && act.busy !== 'apply') || !applicable.some((r) => selected.has(r.product_id))}
              onClick={() => void applySelected()}
              data-estimates-apply
            >
              {say(LISTS.applySelected, lang, { n: applicable.filter((r) => selected.has(r.product_id)).length })}
            </Button>
          </>
        ) : null}
        {act.busy === 'compute' || act.busy === 'apply' ? (
          <Button variant="ghost" onClick={() => (stop.current = true)}>
            {say(COMMON.stop, lang)}
          </Button>
        ) : null}
      </div>
      {progress ? <p className="text-[12px] text-text-muted" data-estimates-progress>{progress}</p> : null}
      <ActNote message={act.message} />

      {error ? (
        <Failure error={error} lang={lang} onRetry={() => setReload((n) => n + 1)} />
      ) : !data ? (
        <div className="space-y-2" aria-busy="true">
          <Skeleton className="h-28 w-full" />
          <Skeleton className="h-28 w-full" />
        </div>
      ) : rows.length === 0 ? (
        <p className="lv-surface p-4 text-[14px] text-text-secondary" data-estimates-empty={mode}>
          {say(COMMON.empty, lang)}
        </p>
      ) : (
        <>
          {canApply && applicable.length ? (
            <Checkbox
              checked={applicable.every((r) => selected.has(r.product_id))}
              indeterminate={applicable.some((r) => selected.has(r.product_id))}
              onChange={(v) => setSelected(v ? new Set(applicable.map((r) => r.product_id)) : new Set())}
              label={say(COMMON.selectAll, lang)}
            />
          ) : null}
          <ul className="space-y-3">
            {rows.map((r) => (
              <EstimateRow
                key={r.product_id}
                row={r}
                mode={mode}
                lang={lang}
                selectable={canApply && applicable.includes(r)}
                selected={selected.has(r.product_id)}
                onSelect={(v) =>
                  setSelected((s) => {
                    const next = new Set(s);
                    if (v) next.add(r.product_id);
                    else next.delete(r.product_id);
                    return next;
                  })
                }
                largeTicked={large.has(r.product_id)}
                onLarge={(v) =>
                  setLarge((s) => {
                    const next = new Set(s);
                    if (v) next.add(r.product_id);
                    else next.delete(r.product_id);
                    return next;
                  })
                }
                outcome={outcomes.get(r.product_id) ?? null}
                onReview={() => onReview(r.product_id)}
                onConfirm={() => setConfirming(r)}
                onChanged={() => setReload((n) => n + 1)}
              />
            ))}
          </ul>
          <Pager lang={lang} page={pages.page} hasPrev={pages.hasPrev} nextCursor={data.next_cursor} onPrev={pages.prev} onNext={() => pages.next(data.next_cursor)} />
        </>
      )}
      <ConfirmSheet
        estimate={confirming}
        onClose={() => setConfirming(null)}
        onDone={() => {
          setConfirming(null);
          setReload((n) => n + 1);
        }}
        // The sheet reads the product itself; when it finds the server moved (a compute, a stale version), so does the list.
        onStale={() => setReload((n) => n + 1)}
      />
    </section>
  );
}

function EstimateRow({
  row: r,
  mode,
  lang,
  selectable,
  selected,
  onSelect,
  largeTicked,
  onLarge,
  outcome,
  onReview,
  onConfirm,
  onChanged,
}: {
  row: StoredEstimate;
  mode: ListMode;
  lang: UiLang;
  selectable: boolean;
  selected: boolean;
  onSelect: (v: boolean) => void;
  largeTicked: boolean;
  onLarge: (v: boolean) => void;
  outcome: ApplyOutcome | null;
  onReview: () => void;
  onConfirm: () => void;
  onChanged: () => void;
}) {
  const act = useAct(lang, onChanged);
  const [open, setOpen] = useState(mode === 'refresh');
  const labels = useSkuLabels(r.product_id, open);
  const editor = productEditorHref(r.product_id);
  const sources = useMemo(() => [...new Set(r.lines.map((l) => l.source))], [r.lines]);
  const flags = useMemo(() => rowFlags(r, mode), [r, mode]);
  const prices = r.lines.map((l) => l.est_price_iqd).filter((p): p is number => typeof p === 'number');
  const low = prices.length ? Math.min(...prices) : null;
  const high = prices.length ? Math.max(...prices) : null;
  const hasLarge = r.lines.some((l) => l.large);
  const result = outcome ? outcomeText(outcome, lang) : null;

  const pause = (state: 'paused' | 'active') =>
    act.run(state, () => setEstimateProduct(r.product_id, { version: r.version, state }), () => {
      onChanged();
      return { tone: 'success', text: say(state === 'paused' ? LISTS.paused : LISTS.resumed, lang) };
    });

  const compute = () =>
    act.run('compute', () => computeEstimates({ product_ids: [r.product_id] }), () => {
      onChanged();
      return { tone: 'success', text: say(REVIEW.computed, lang) };
    });

  return (
    <li className="lv-surface min-w-0 space-y-3 p-3 sm:p-4" data-estimate-row={r.product_id} data-estimate-state={r.state}>
      <div className="flex min-w-0 items-start gap-3">
        {selectable ? <Checkbox checked={selected} onChange={onSelect} aria-label={say(COMMON.selectRow, lang, { name: r.name })} /> : null}
        <div className="min-w-0 flex-1 space-y-1.5">
          <div className="flex min-w-0 flex-wrap items-center gap-2">
            <h3 dir="auto" className="min-w-0 break-words text-[15px] font-bold leading-snug text-text-primary">
              {r.name || r.product_id}
            </h3>
            <StatusChip tone={r.state === 'estimated' ? 'accent' : r.state === 'confirmed' ? 'success' : r.state === 'paused' ? 'neutral' : 'info'} className="shrink-0">
              {say(ESTIMATE_STATE_LABELS[r.state], lang)}
            </StatusChip>
            {r.label ? <span className="text-[12px] font-semibold text-text-secondary">{say(LISTS.labelOn, lang)}</span> : null}
          </div>
          <p className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1 text-[12px] text-text-secondary">
            {r.type ? <span>{say(LISTS.type, lang, { type: r.type })}</span> : null}
            {sources.map((s) => (
              <SourceChip key={s} source={s} lang={lang} />
            ))}
            {low !== null && high !== null ? (
              <span>
                {say(LISTS.price, lang)}: <Ltr className="font-bold text-text-primary">{low === high ? iqdText(low, lang) : `${iqdText(low, lang)} – ${iqdText(high, lang)}`}</Ltr>
              </span>
            ) : null}
            {r.computed_at ? <span className="text-text-muted">{say(LISTS.computedAt, lang, { date: dayOf(r.computed_at) })}</span> : null}
          </p>
        </div>
      </div>

      {flags.length ? <FlagList flags={flags} lang={lang} /> : <p className="text-[12px] text-text-muted">{say(LISTS.noFlags, lang)}</p>}
      {mode === 'refresh' && refreshKeepsPrices(r.lines) ? (
        <p className="text-[12px] text-text-secondary" data-estimate-measures-only>
          {say(LISTS.refreshMeasuresOnly, lang)}
        </p>
      ) : null}

      <button type="button" className="inline-flex min-h-11 items-center px-1 text-[13px] font-bold text-text-primary underline underline-offset-2" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
        {say(LISTS.lines, lang)} ({r.lines.length})
      </button>
      {open ? <LinesTable lines={r.lines} labels={labels} lang={lang} refresh={mode === 'refresh'} /> : null}

      {hasLarge && (mode === 'refresh' || mode === 'ready') ? (
        <div className="lv-alert lv-alert-warning space-y-1 text-[12px] text-text-primary" data-estimate-large>
          <p>{say(LISTS.large, lang)}</p>
          <Checkbox checked={largeTicked} onChange={onLarge} label={say(LISTS.confirmLarge, lang)} />
        </div>
      ) : null}

      {result ? (
        <ActNote message={result} />
      ) : null}

      <div className="flex flex-wrap items-center gap-2">
        {mode === 'estimated' && r.state === 'estimated' ? (
          <>
            <Button size="sm" variant="primary" icon={<CheckCircle2 aria-hidden="true" className="h-4 w-4" />} onClick={onConfirm} data-estimate-confirm={r.product_id}>
              {say(LISTS.confirm, lang)}
            </Button>
            <Button size="sm" variant="ghost" loading={act.busy === 'paused'} onClick={() => void pause('paused')} data-estimate-pause={r.product_id}>
              {say(LISTS.pause, lang)}
            </Button>
          </>
        ) : null}
        {r.state === 'paused' ? (
          <Button size="sm" variant="secondary" loading={act.busy === 'active'} onClick={() => void pause('active')} data-estimate-resume={r.product_id}>
            {say(LISTS.resume, lang)}
          </Button>
        ) : null}
        {r.state === 'candidate' || r.state === 'estimated' ? (
          <Button size="sm" variant="ghost" loading={act.busy === 'compute'} onClick={() => void compute()}>
            {say(REVIEW.computeAgain, lang)}
          </Button>
        ) : null}
        <Button size="sm" variant="ghost" onClick={onReview} iconEnd={<ArrowLeft aria-hidden="true" className="h-4 w-4 ltr:rotate-180" />}>
          {say(LISTS.review, lang)}
        </Button>
        {editor ? (
          <a href={editor} className="inline-flex min-h-11 items-center px-1 text-[13px] font-bold text-text-primary underline underline-offset-2">
            {say(COMMON.openProduct, lang)}
          </a>
        ) : null}
      </div>
      <ActNote message={act.message} />
    </li>
  );
}

/** Per SKU × route: the source and supplier amount, the measure, R and D — and, on a refresh, published → new and %. */
function LinesTable({ lines, labels, lang, refresh }: { lines: readonly EstimateLine[]; labels: LabelMap; lang: UiLang; refresh: boolean }) {
  return (
    <ul className="divide-y divide-border-subtle/60 rounded-xl bg-surface-raised px-3" data-estimate-lines>
      {lines.map((l) => (
        <li key={`${l.combo_key}@${l.channel}`} className="min-w-0 space-y-1 py-2 text-[12px]" data-estimate-line={l.combo_key}>
          <p dir="auto" className="break-words font-semibold text-text-primary">
            {lineName(l, labels, lang)}
          </p>
          <p className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1 text-text-secondary">
            <SourceChip source={l.source} lang={lang} />
            <span>
              {say(LISTS.supplier, lang)}: <Ltr className="font-semibold text-text-primary">{moneyText(l.supplier_amount, l.supplier_currency)}</Ltr>
            </span>
            <span>
              {say(LISTS.measure, lang)}: {say(MEASURE_LABELS[l.measure_source] ?? MEASURE_LABELS.none, lang)}
            </span>
          </p>
          <p className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1 text-text-secondary">
            <span>
              {say(LISTS.cost, lang)}: <Ltr className="font-semibold text-text-primary">{iqdText(l.est_cost_iqd, lang)}</Ltr>
            </span>
            {refresh && l.published_price_iqd !== null ? (
              <span data-estimate-change>
                {say(LISTS.change, lang)}: <Ltr className="font-semibold text-text-primary">{iqdText(l.published_price_iqd, lang)}</Ltr>
                <ArrowLeft aria-hidden="true" className="mx-1 inline h-3.5 w-3.5 ltr:rotate-180" />
                <Ltr className="font-semibold text-text-primary">{iqdText(l.est_price_iqd, lang)}</Ltr> <Ltr className={l.large ? 'font-bold text-warning' : ''}>{pctText(l.change_pct)}</Ltr>
              </span>
            ) : (
              <span>
                {say(LISTS.price, lang)}: <Ltr className="font-semibold text-text-primary">{iqdText(l.est_price_iqd, lang)}</Ltr>
                {l.published_price_iqd !== null && l.published_price_iqd !== l.est_price_iqd ? (
                  <span className="ms-1 text-text-muted">
                    ({say(LISTS.published, lang)}: <Ltr>{iqdText(l.published_price_iqd, lang)}</Ltr>)
                  </span>
                ) : null}
              </span>
            )}
          </p>
          {l.flags.length ? <p className="break-words text-text-muted">{l.flags.map((f) => flagText(f, lang)).join(' · ')}</p> : null}
        </li>
      ))}
    </ul>
  );
}
