/**
 * «سرعة متجري» — THE BUILDER'S «السرعة» TAB (docs/MERCHANT_PLATFORM_V2.md
 * storefront §3.9 / §3.10, §4.5 S4–S7). Lazily loaded by StoreDesignPanel,
 * so a merchant who never opens the tab downloads none of it.
 *
 * FOUR THINGS, IN THIS ORDER, and never mixed:
 *
 *   1. REAL VISITORS (GET /api/merchant/store/layout/speed/report): the
 *      verdict and one tile per vital, each a WORD in a StatusChip — the
 *      bucket that holds the 75th percentile, never an interpolated number —
 *      with the window's mean as context and the daily share of good visits
 *      as a Sparkline; then how the page appeared (DistributionBar). Under
 *      the server's 50 readings there is no verdict at all: an EmptyState
 *      says how many have come in.
 *   2. THE FIRST-SCREEN WEIGHT (WeightList): the server's deterministic
 *      audit of the published page — or of the draft, when it differs — that
 *      needs no visitors and so stands in the empty state too.
 *   3. «ما الذي يسرّع متجرك»: the audit's closed finding codes as numbered
 *      sentences (storeDesign/strings.ts), each with the door to where it is
 *      fixed — «افتح القسم» selects the section in the Sections tab.
 *   4. «قياس مختبري»: the outbound PageSpeed link, a separate tile that is
 *      never mixed with the real-user figures; then the honesty line.
 *
 * Every word is a key of storeDesign/strings.ts (ar / en / ckb); the server
 * sends codes and numbers only. Figures are Latin digits, as the rest of the
 * builder writes them, and sizes read «6.2 MB» (`formatBytes`).
 */
import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { Check, ExternalLink, Gauge, Monitor, Smartphone } from 'lucide-react';
import { useLanguage } from '../../../../LanguageContext';
import { StatusChip, type Tone } from '../../../ui/Badge';
import { EmptyState, ErrorState } from '../../../ui/AsyncStates';
import { KpiRowSkeleton, ListRowsSkeleton } from '../../../ui/DashboardSkeletons';
import { KpiTile, Sparkline } from '../../../ui/KpiTile';
import { Segmented } from '../../../ui/Segmented';
import type { BlockType } from '../../../../../packages/storeLayout/src/blocks';
import { BLOCK_COPY, say } from '../catalog';
import { formatBytes } from '../refusal';
import { fillSpeed, useSpeedStrings, type SpeedStrings } from '../strings';
import {
  BACKGROUND_SLOT,
  HEADER_SLOT,
  VITAL_NAMES,
  VITALS_THRESHOLDS,
  speedApi,
  type Bucket,
  type LayoutSource,
  type RumSummary,
  type SpeedAuditAnswer,
  type SpeedDays,
  type SpeedDevice,
  type SpeedFinding,
  type SpeedReport,
  type VitalName,
  type VitalsDay,
  type WeightAudit,
} from './api';
import DistributionBar from './DistributionBar';
import WeightList, { type WeightRow } from './WeightList';

// ------------------------------------------------------------------ doors

/** Where a thing on the first screen is changed. */
export type SpeedDoor =
  | { kind: 'block'; id: string }
  /** The Page tab — the page background lives there. */
  | { kind: 'page' }
  /** The Sections list — the ORDER of sections. */
  | { kind: 'sections' }
  /** The store's own settings — its logo and cover. */
  | { kind: 'settings' }
  /** The products — their pictures. */
  | { kind: 'products' };

export interface SpeedActions {
  /** Select a section in the Sections tab (StoreDesignPanel's `select`). */
  openBlock: (id: string) => void;
  openPage: () => void;
  openSections: () => void;
  /** Doors out of the builder; absent where there is no workspace to go through, and then not drawn. */
  openSettings?: () => void;
  openProducts?: () => void;
}

/** The door of a first-screen slot, or null when its section is no longer in the draft. */
export function slotDoor(blockId: string | null | undefined, draftIds: ReadonlySet<string>): SpeedDoor | null {
  if (!blockId) return null;
  if (blockId === HEADER_SLOT) return { kind: 'settings' };
  if (blockId === BACKGROUND_SLOT) return { kind: 'page' };
  return draftIds.has(blockId) ? { kind: 'block', id: blockId } : null;
}

/**
 * The door of a finding: product pictures are fixed on the products, the
 * order of sections in the Sections list, everything else where its slot is.
 * OK_IMAGES needs nothing.
 */
export function findingDoor(f: SpeedFinding, draftIds: ReadonlySet<string>): SpeedDoor | null {
  switch (f.code) {
    case 'OK_IMAGES':
      return null;
    case 'PRODUCT_IMAGES_LARGE':
      return { kind: 'products' };
    case 'ABOVE_FOLD_BLOCKS':
      return { kind: 'sections' };
    default:
      return slotDoor(f.block_id, draftIds);
  }
}

/** A finding about a section the draft no longer has (it is still on the PUBLISHED page). */
export function findingGone(f: SpeedFinding, draftIds: ReadonlySet<string>): boolean {
  if (!f.block_id || f.block_id === HEADER_SLOT || f.block_id === BACKGROUND_SLOT) return false;
  if (f.code === 'PRODUCT_IMAGES_LARGE' || f.code === 'ABOVE_FOLD_BLOCKS' || f.code === 'OK_IMAGES') return false;
  return !draftIds.has(f.block_id);
}

/** Whether this screen can open the door: the ones out of the builder need the workspace. */
export function canOpen(door: SpeedDoor, actions: SpeedActions): boolean {
  if (door.kind === 'settings') return !!actions.openSettings;
  if (door.kind === 'products') return !!actions.openProducts;
  return true;
}

/** Opens a door. True when it moved WITHIN the builder (the caller brings the builder's top into view). */
export function openDoor(door: SpeedDoor, actions: SpeedActions): boolean {
  switch (door.kind) {
    case 'block':
      actions.openBlock(door.id);
      return true;
    case 'page':
      actions.openPage();
      return true;
    case 'sections':
      actions.openSections();
      return true;
    case 'settings':
      actions.openSettings?.();
      return false;
    case 'products':
      actions.openProducts?.();
      return false;
  }
}

export function doorLabel(door: SpeedDoor, s: SpeedStrings): string {
  switch (door.kind) {
    case 'block':
      return s.door.section;
    case 'page':
      return s.door.background;
    case 'sections':
      return s.door.sections;
    case 'settings':
      return s.door.settings;
    case 'products':
      return s.door.products;
  }
}

// ---------------------------------------------------------------- figures

/** A figure in Latin digits, as the builder writes them («312», «2.9»). */
export function figure(n: number, fraction = 0): string {
  return (Number.isFinite(n) ? n : 0).toLocaleString('en-US', { maximumFractionDigits: fraction, minimumFractionDigits: 0 });
}

/** A vital's value in its unit: seconds for LCP / TTFB and milliseconds for INP (the server's ms), CLS unitless (the server's ×1000). */
export function vitalFigure(v: VitalName, value: number, s: SpeedStrings): string {
  if (v === 'cls') return figure(value / 1000, 2);
  if (v === 'inp') return fillSpeed(s.millis, { n: figure(value) });
  return fillSpeed(s.seconds, { n: figure(value / 1000, 1) });
}

/**
 * A size inside a sentence, isolated left-to-right (LRI … PDI, as the
 * storefront's workshop line does): in an Arabic or Sorani line «6.2 MB»
 * would otherwise read «MB 6.2». Invisible in English.
 */
export function sizeInLine(n: unknown): string {
  return `⁦${formatBytes(n)}⁩`;
}

/** A finding in the merchant's words: the closed code's sentence with its numbers filled in. */
export function findingText(f: SpeedFinding, s: SpeedStrings): string {
  const p = f.params ?? {};
  const template = s.finding[f.code];
  if (!template) return '';
  switch (f.code) {
    case 'HERO_GIF':
    case 'BACKGROUND_VIDEO_ON_PHONE':
      return fillSpeed(template, { size: sizeInLine(p.bytes) });
    case 'HERO_HEAVY':
      return fillSpeed(template, { size: sizeInLine(p.bytes), max: sizeInLine(p.max_bytes) });
    case 'AUTOPLAY_VIDEO_COUNT':
    case 'OK_IMAGES':
      return fillSpeed(template, { count: figure(Number(p.count)), size: sizeInLine(p.bytes) });
    case 'PRODUCT_IMAGES_LARGE':
      return fillSpeed(template, { size: sizeInLine(p.avg_bytes), max: sizeInLine(p.max_bytes) });
    case 'ABOVE_FOLD_BLOCKS':
      return fillSpeed(template, { count: figure(Number(p.count)), max: figure(Number(p.max)) });
    default:
      return fillSpeed(template, {});
  }
}

/** The daily share of good readings of one vital, oldest first — a tile's trend; a day without a reading of it is left out. */
export function goodShareSeries(days: readonly VitalsDay[], v: VitalName): number[] {
  const out: number[] = [];
  for (const d of days ?? []) {
    const c = d[v];
    const n = c ? c.good + c.ok + c.poor : 0;
    if (n > 0) out.push(c.good / n);
  }
  return out;
}

/** A band's tone: the word is always beside it. */
export const BUCKET_TONE: Readonly<Record<Bucket, Tone>> = { good: 'success', ok: 'warning', poor: 'danger' };

/** The line under a vital's word: the window's mean where the server keeps one, and where «good» ends. */
export function vitalHint(rum: RumSummary, v: VitalName, s: SpeedStrings): string {
  if (!rum.p75_bucket[v]) return s.collecting;
  const parts: string[] = [];
  const mean = v === 'lcp' ? rum.mean_ms.lcp : v === 'ttfb' ? rum.mean_ms.ttfb : null;
  if (typeof mean === 'number') parts.push(fillSpeed(s.average, { value: vitalFigure(v, mean, s) }));
  parts.push(fillSpeed(s.goodUpTo, { limit: vitalFigure(v, VITALS_THRESHOLDS[v][0], s) }));
  return parts.join(' · ');
}

// ------------------------------------------------------------------ the view

export interface SpeedViewProps {
  report: SpeedReport | null;
  error: unknown;
  loading: boolean;
  onRetry: () => void;
  days: SpeedDays;
  onDays: (d: SpeedDays) => void;
  device: SpeedDevice;
  onDevice: (d: SpeedDevice) => void;
  /** The audit on show — the report's (published) or the draft's — or null while the draft's is loading. */
  weight: { audit: WeightAudit; source: LayoutSource } | null;
  weightError?: unknown;
  onWeightRetry?: () => void;
  /** The published | draft switch; null when the draft is what visitors see anyway. */
  source: 'published' | 'draft' | null;
  onSource?: (s: 'published' | 'draft') => void;
  /** The current draft's sections: a door opens only one that still exists, and names it. */
  blocks: ReadonlyArray<{ id: string; type: BlockType }>;
  actions: SpeedActions;
}

/** The tab's content from what the reads answered — pure, so the tests render it with fixed data. */
export function SpeedView(p: SpeedViewProps) {
  const s = useSpeedStrings();
  const { loc } = useLanguage();
  const draftIds = useMemo(() => new Set(p.blocks.map((b) => b.id)), [p.blocks]);
  const names = useMemo(() => new Map(p.blocks.map((b) => [b.id, say(loc, BLOCK_COPY[b.type]?.name)])), [p.blocks, loc]);
  const report = p.report;
  const rum = report?.rum ?? null;

  const go = (door: SpeedDoor) => {
    if (!openDoor(door, p.actions)) return;
    // The door opened another tab: its top, not the depth this list was read at.
    requestAnimationFrame(() => document.querySelector('[data-store-design]')?.scrollIntoView({ block: 'start' }));
  };
  // A weight row's door says «افتح» and is named for its row; a hint's door
  // says where it goes and is described by the hint it stands under.
  const rowDoor = (row: WeightRow): ReactNode => {
    const door = slotDoor(row.blockId, draftIds);
    if (!door || !canOpen(door, p.actions)) return null;
    return (
      <button
        type="button"
        onClick={() => go(door)}
        aria-label={`${s.weight.open}: ${row.label ? s.label[row.label] : ''}`}
        title={doorLabel(door, s)}
        data-speed-open={door.kind}
        data-speed-block={door.kind === 'block' ? door.id : undefined}
        className="lv-button lv-button-ghost lv-button-sm shrink-0"
      >
        {s.weight.open}
      </button>
    );
  };
  const hintDoor = (door: SpeedDoor | null, describedBy: string): ReactNode => {
    if (!door || !canOpen(door, p.actions)) return null;
    return (
      <button
        type="button"
        onClick={() => go(door)}
        aria-describedby={describedBy}
        data-speed-open={door.kind}
        data-speed-block={door.kind === 'block' ? door.id : undefined}
        className="lv-button lv-button-secondary lv-button-sm mt-2 self-start"
      >
        {doorLabel(door, s)}
      </button>
    );
  };

  // The figures say which window they answer (the server's, not the switch's), and figures that answer
  // another window or device than the one now asked — while the next read is on its way, or after it
  // failed — are dimmed, never passed off as the new ones.
  const period = rum?.window_days === 7 ? s.days.d7 : s.days.d28;
  const visits = rum ? fillSpeed(s.visits, { n: figure(rum.samples), period }) : '';
  const stale = !!rum && (rum.window_days !== p.days || rum.device !== p.device);

  let real: ReactNode;
  if (!report) {
    real = <KpiRowSkeleton count={4} />;
  } else if (rum!.verdict === 'collecting') {
    real = (
      <div data-speed-collecting>
        <EmptyState
          compact
          icon={<Gauge aria-hidden="true" className="h-6 w-6" />}
          title={s.empty.title}
          description={fillSpeed(s.empty.body, { min: figure(rum!.min_samples), n: figure(rum!.samples) })}
        />
      </div>
    );
  } else {
    const r = rum!;
    const verdict = r.verdict as Bucket;
    real = (
      <div className="space-y-3">
        <div className="grid grid-cols-2 gap-3 lg:grid-cols-6" data-speed-tiles>
          <KpiTile
            className="col-span-2"
            label={s.verdict}
            value={
              <span data-speed-verdict={verdict}>
                <StatusChip tone={BUCKET_TONE[verdict]}>{s.bucket[verdict]}</StatusChip>
              </span>
            }
            hint={visits}
          />
          {VITAL_NAMES.map((v) => {
            const word = r.p75_bucket[v];
            const series = goodShareSeries(r.days, v);
            return (
              <KpiTile
                key={v}
                label={s.vital[v]}
                value={
                  word ? (
                    <span data-speed-vital={v} data-speed-word={word}>
                      <StatusChip tone={BUCKET_TONE[word]}>{s.bucket[word]}</StatusChip>
                    </span>
                  ) : null
                }
                hint={vitalHint(r, v, s)}
                trend={series.length >= 2 ? <Sparkline series={series} /> : undefined}
              />
            );
          })}
        </div>
        <DistributionBar counts={r.totals.lcp} title={s.spread.title} />
      </div>
    );
  }

  const weight = p.weight;
  const findings = weight?.audit.findings ?? [];
  const fixes = findings.filter((f) => f.code !== 'OK_IMAGES');
  const fine = findings.find((f) => f.code === 'OK_IMAGES');
  // «Nothing weighs your first screen» is a claim about files that were weighed.
  const unmeasured = !!weight?.audit.first_view?.some((it) => it.bytes === null);
  const sourceSwitch =
    p.source && p.onSource ? (
      <Segmented
        size="sm"
        group="sd-speed-source"
        label={s.weight.source.label}
        value={p.source}
        onChange={(v) => p.onSource?.(v === 'draft' ? 'draft' : 'published')}
        dataAttr="data-speed-source"
        className="ms-auto min-w-[12rem]"
        items={[
          { id: 'published', label: s.weight.source.published },
          { id: 'draft', label: s.weight.source.draft },
        ]}
      />
    ) : null;

  const header = (
    <header className="flex flex-col gap-3 lg:flex-row lg:items-center">
      <div className="min-w-0 flex-1">
        <h2 className="text-[15px] font-bold text-text-primary">{s.title}</h2>
        <p className="mt-0.5 text-[12.5px] leading-relaxed text-text-muted">{s.lead}</p>
      </div>
      <div className="flex flex-wrap gap-2">
        <Segmented
          size="sm"
          group="sd-speed-device"
          label={s.device.label}
          value={p.device}
          onChange={(v) => p.onDevice(v === 'desktop' ? 'desktop' : 'phone')}
          dataAttr="data-speed-device"
          className="min-w-[12rem] flex-1"
          items={[
            { id: 'phone', label: s.device.phone, icon: <Smartphone aria-hidden="true" className="h-4 w-4" /> },
            { id: 'desktop', label: s.device.desktop, icon: <Monitor aria-hidden="true" className="h-4 w-4" /> },
          ]}
        />
        <Segmented
          size="sm"
          group="sd-speed-days"
          label={s.days.label}
          value={String(p.days)}
          onChange={(v) => p.onDays(v === '7' ? 7 : 28)}
          dataAttr="data-speed-days"
          className="min-w-[15rem] flex-1"
          items={[
            { id: '7', label: s.days.d7 },
            { id: '28', label: s.days.d28 },
          ]}
        />
      </div>
    </header>
  );

  // Nothing answered: the one failure, with its retry — not a skeleton under it.
  if (!report && p.error) {
    return (
      <div data-sd-speed className="space-y-5">
        {header}
        <ErrorState error={p.error} onRetry={p.onRetry} compact />
      </div>
    );
  }

  return (
    <div data-sd-speed className="space-y-5" aria-busy={p.loading || undefined}>
      {header}

      {/* A failed refresh keeps what it had and says so, with its retry (DataList's «stale»). */}
      {report && p.error ? <ErrorState error={p.error} onRetry={p.onRetry} compact /> : null}
      <div data-speed-real data-speed-stale={stale || undefined} className={stale ? 'opacity-60 transition-opacity motion-reduce:transition-none' : 'transition-opacity motion-reduce:transition-none'}>
        {real}
      </div>

      <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_340px] lg:items-start">
        {weight ? (
          <WeightList audit={weight.audit} source={weight.source} control={sourceSwitch} blockName={(id) => names.get(id) || null} renderDoor={rowDoor} />
        ) : (
          <section className="min-w-0 space-y-2" aria-busy={!p.weightError || undefined}>
            <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
              <h3 className="text-[13px] font-bold text-text-primary">{s.weight.title}</h3>
              {sourceSwitch}
            </div>
            {p.weightError ? (
              <ErrorState error={p.weightError} onRetry={p.onWeightRetry} compact />
            ) : (
              <div className="lv-surface overflow-hidden">
                <ListRowsSkeleton rows={4} thumbnail={false} />
              </div>
            )}
          </section>
        )}

        <section aria-labelledby="sd-speed-hints" data-speed-hints className="min-w-0 space-y-2">
          <h3 id="sd-speed-hints" className="text-[13px] font-bold text-text-primary">
            {s.hints.title}
          </h3>
          <div className="lv-surface overflow-hidden">
            {!weight ? (
              <ListRowsSkeleton rows={2} thumbnail={false} />
            ) : (
              <>
                {fixes.length > 0 && (
                  <ol className="divide-y divide-border-subtle">
                    {fixes.map((f, i) => {
                      const door = findingDoor(f, draftIds);
                      const textId = `sd-speed-finding-${i}`;
                      return (
                        <li key={`${f.code}:${f.block_id ?? ''}:${i}`} data-speed-finding={f.code} className="flex gap-3 px-4 py-3">
                          <span aria-hidden="true" className="grid size-6 shrink-0 place-items-center rounded-full bg-surface-selected text-[12px] font-bold tabular-nums text-text-secondary">
                            {figure(i + 1)}
                          </span>
                          <div className="flex min-w-0 flex-1 flex-col">
                            <p id={textId} className="text-[13px] leading-relaxed text-text-primary">
                              {findingText(f, s)}
                            </p>
                            {door
                              ? hintDoor(door, textId)
                              : findingGone(f, draftIds) && <p className="mt-1 text-[12px] text-text-muted">{s.hints.gone}</p>}
                          </div>
                        </li>
                      );
                    })}
                  </ol>
                )}
                {fine && (
                  <p data-speed-finding="OK_IMAGES" className={`flex items-start gap-2 px-4 py-3 text-[13px] leading-relaxed text-text-secondary ${fixes.length ? 'border-t border-border-subtle' : ''}`}>
                    <Check aria-hidden="true" className="mt-0.5 h-4 w-4 shrink-0 text-success" />
                    <span className="min-w-0">{findingText(fine, s)}</span>
                  </p>
                )}
                {fixes.length === 0 && !fine && <p className="px-4 py-3 text-[13px] text-text-muted">{unmeasured ? s.hints.unmeasured : s.hints.none}</p>}
              </>
            )}
          </div>
        </section>
      </div>

      {report?.psi_url && (
        <section aria-labelledby="sd-speed-lab" data-speed-lab className="lv-surface flex flex-col gap-3 p-4 sm:flex-row sm:items-center">
          <div className="min-w-0 flex-1">
            <h3 id="sd-speed-lab" className="text-[13px] font-bold text-text-primary">
              {s.lab.title}
            </h3>
            <p className="mt-0.5 text-[12px] leading-relaxed text-text-muted">{s.lab.body}</p>
          </div>
          <a href={report.psi_url} target="_blank" rel="noopener noreferrer" data-speed-psi className="lv-button lv-button-secondary lv-button-sm shrink-0 self-start sm:self-auto">
            {s.lab.open}
            <ExternalLink aria-hidden="true" className="h-4 w-4" />
            <span className="sr-only">({s.lab.external})</span>
          </a>
        </section>
      )}

      <p className="text-[11.5px] leading-relaxed text-text-muted" data-speed-honesty>
        {s.honesty}
      </p>
    </div>
  );
}

// ------------------------------------------------------------- the reads

export interface SpeedPanelProps {
  blocks: ReadonlyArray<{ id: string; type: BlockType }>;
  /** The draft differs from what visitors see: the weight can then be read for either. */
  hasUnpublished: boolean;
  actions: SpeedActions;
}

export default function SpeedPanel({ blocks, hasUnpublished, actions }: SpeedPanelProps) {
  const [days, setDays] = useState<SpeedDays>(28);
  const [device, setDevice] = useState<SpeedDevice>('phone');
  const [report, setReport] = useState<SpeedReport | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [loading, setLoading] = useState(true);
  const [attempt, setAttempt] = useState(0);
  const [source, setSource] = useState<'published' | 'draft'>('published');
  const [draft, setDraft] = useState<SpeedAuditAnswer | null>(null);
  const [draftError, setDraftError] = useState<unknown>(null);
  const [draftAttempt, setDraftAttempt] = useState(0);

  // The report: the window and the device are the server's parameters; the
  // last answer stays on screen while the next one is read.
  useEffect(() => {
    let alive = true;
    setLoading(true);
    speedApi
      .report(days, device)
      .then(
        (r) => {
          if (!alive) return;
          setReport(r);
          setError(null);
        },
        (e: unknown) => {
          if (alive) setError(e);
        }
      )
      .finally(() => {
        if (alive) setLoading(false);
      });
    return () => {
      alive = false;
    };
  }, [days, device, attempt]);

  // The draft's weight, read each time it is asked for (the draft moves while the merchant edits).
  const showDraft = hasUnpublished && source === 'draft';
  useEffect(() => {
    if (!showDraft) return;
    let alive = true;
    setDraft(null);
    setDraftError(null);
    speedApi.audit('draft').then(
      (a) => {
        if (alive) setDraft(a);
      },
      (e: unknown) => {
        if (alive) setDraftError(e);
      }
    );
    return () => {
      alive = false;
    };
  }, [showDraft, draftAttempt]);

  const weight = showDraft
    ? draft
      ? { audit: draft.audit, source: draft.source }
      : null
    : report
      ? { audit: report.weight, source: report.weight_source }
      : null;

  return (
    <SpeedView
      report={report}
      error={error}
      loading={loading}
      onRetry={() => setAttempt((n) => n + 1)}
      days={days}
      onDays={setDays}
      device={device}
      onDevice={setDevice}
      weight={weight}
      weightError={showDraft ? draftError : null}
      onWeightRetry={() => (showDraft ? setDraftAttempt((n) => n + 1) : setAttempt((n) => n + 1))}
      source={hasUnpublished ? source : null}
      onSource={setSource}
      blocks={blocks}
      actions={actions}
    />
  );
}
