/**
 * THE CUSTOMER'S HOME (GET /me/dashboard, /queue, /jobs/{id}, /printers).
 *
 * The prototype's layout, in the house clay: the balances as stat cards —
 * printing hours per class («18.4 h of 24 h», both figures the server's) and
 * the filament in their inventory — then «Start a new print» with the quick
 * doors (buy hours, buy filament, the printers), then the four views of
 * their prints, printers, filament and history.
 *
 * HONEST BY CONSTRUCTION (docs/PRINT_CLOUD.md):
 *   - progress, remaining time and layers come ONLY from the printer's own
 *     telemetry while it is live; a stale reading says «last reported …, not
 *     live» and draws no bar; a printer that sends nothing says so;
 *   - grams on a print are the ESTIMATE's, labelled as one — the printer
 *     does not report grams;
 *   - queue times are the server's simulation, labelled «around» with its
 *     own note, and a job the simulation cannot place says why;
 *   - a printer is «free now» only by the scheduler's count; nothing is ever
 *     shown online because it is listed;
 *   - a new customer sees empty states with the way in, never sample rows.
 */
import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { Segmented } from '../../components/ui/Segmented';
import { formatFigure } from '../../lib/localeNumber';
import { getDashboard, getJob, getQueue, listPrinters } from '../api';
import { useCloud } from '../CloudContext';
import { formatDuration, formatHours, formatMass, formatPercent, formatQuantity, formatRelative, hoursParts, massParts, permillePercent, progressPercent } from '../format';
import { service } from '../strings/common';
import { home } from '../strings/home';
import { tx, useCloudText } from '../text';
import type { Dashboard, InventoryBalance, JobSummary, MyPrinterModel, PrinterModel, QueueEstimate } from '../types';
import {
  Box,
  CalendarClock,
  Clock,
  CloudEmptyState,
  CloudErrorState,
  CloudPageSkeleton,
  Disc3,
  History,
  Hourglass,
  Info,
  Layers,
  ListRow,
  PrimaryAction,
  Printer,
  ProgressBar,
  QuickAction,
  SectionHeader,
  StatCard,
  StatusPill,
  Upload,
  jobPillState,
  machinePillState,
  modelPillState,
} from '../ui';
import { useCloudQuery, usePoll } from '../useCloudQuery';
import { isLow } from './account/logic';

type View = 'prints' | 'printers' | 'filament' | 'history';

/** A job's name as the customer gave it, or the honest «untitled». */
function useJobTitle() {
  const { t } = useCloudText();
  return (job: { title: string }) => job.title.trim() || t(home.untitled);
}

// ------------------------------------------------------------------ balances

function HoursCards({ data }: { data: Dashboard }) {
  const { t, lang } = useCloudText();
  const tiers = data.credits.tiers;
  if (tiers.length === 0) {
    return (
      <div className="lv-surface flex min-w-0 flex-col gap-2 p-4">
        <p className="flex items-center gap-2 text-[13px] font-medium text-text-secondary">
          <Clock aria-hidden="true" className="h-4 w-4" />
          {t(home.printingHours)}
        </p>
        <p className="text-[15px] font-bold text-text-primary">{t(home.noHoursTitle)}</p>
        <p className="text-[12px] leading-relaxed text-text-muted">{t(home.noHoursBody)}</p>
        <Link to="/store?tab=hours" className="lv-button lv-button-secondary lv-button-sm mt-1 self-start">
          {t(home.buyHours)}
        </Link>
      </div>
    );
  }
  return (
    <>
      {tiers.map((tier) => {
        const total = tier.available_seconds + tier.reserved_seconds + tier.consumed_seconds;
        const parts = hoursParts(tier.available_seconds, lang);
        const sub = [
          total > tier.available_seconds ? t(home.ofTotal, { total: formatHours(total, lang) }) : null,
          tier.reserved_seconds > 0 ? t(home.reserved, { amount: formatHours(tier.reserved_seconds, lang) }) : null,
        ]
          .filter(Boolean)
          .join(' · ');
        return (
          <StatCard
            key={tier.tier_id}
            to={`/store?tab=hours&tier=${encodeURIComponent(tier.tier_id)}`}
            icon={<Clock className="h-5 w-5" />}
            title={tiers.length > 1 ? tx(tier.name, lang) || tier.code : t(home.printingHours)}
            value={parts.value}
            unit={parts.unit}
            sub={sub || (tiers.length > 1 ? null : tx(tier.name, lang))}
            progress={progressPercent(tier.available_seconds, total)}
            progressLabel={t(home.hoursLeftLabel)}
            tone="accent"
          />
        );
      })}
    </>
  );
}

/** Filament only: grams, the one unit that may be added across variants. */
function filamentRows(inventory: InventoryBalance[]): InventoryBalance[] {
  return inventory.filter((r) => r.category_kind === 'filament' && r.unit_code === 'g');
}

function FilamentCard({ data }: { data: Dashboard }) {
  const { t, lang } = useCloudText();
  const rows = filamentRows(data.inventory);
  if (rows.length === 0) {
    return (
      <div className="lv-surface flex min-w-0 flex-col gap-2 p-4">
        <p className="flex items-center gap-2 text-[13px] font-medium text-text-secondary">
          <Disc3 aria-hidden="true" className="h-4 w-4" />
          {t(home.myFilament)}
        </p>
        <p className="text-[15px] font-bold text-text-primary">{t(home.noFilamentTitle)}</p>
        <p className="text-[12px] leading-relaxed text-text-muted">{t(home.noFilamentBody)}</p>
        <Link to="/store?tab=materials" className="lv-button lv-button-secondary lv-button-sm mt-1 self-start">
          {t(home.buyFilament)}
        </Link>
      </div>
    );
  }
  const available = rows.reduce((s, r) => s + r.available_qty, 0);
  const held = rows.reduce((s, r) => s + r.available_qty + r.reserved_qty + r.consumed_qty, 0);
  const low = rows.some(isLow);
  const parts = massParts(available, lang);
  const sub = low ? t(home.lowStock) : rows.length === 1 ? tx(rows[0].name, lang) : t(home.materialsCount, { n: formatFigure(rows.length, lang) });
  return (
    <StatCard
      to="/store?tab=materials"
      icon={<Disc3 className="h-5 w-5" />}
      title={t(home.myFilament)}
      value={parts.value}
      unit={parts.unit}
      sub={sub}
      progress={progressPercent(available, held)}
      progressLabel={t(home.filamentLeftLabel)}
      tone={low ? 'warning' : 'success'}
    />
  );
}

// ------------------------------------------------------------------ my prints

/** How often the current print is read again while it is on a machine (as its own page, print/model.ts `jobPollMs`). */
const CURRENT_POLL_MS = 10_000;
const ON_A_MACHINE: readonly string[] = ['preparing', 'printing', 'paused'];

function CurrentPrintCard({ job }: { job: JobSummary }) {
  const { t, lang } = useCloudText();
  const titleOf = useJobTitle();
  const view = useCloudQuery((signal) => getJob(job.id, { signal }), [job.id, job.updated_at]);
  const v = view.data;
  // A reading is «live» only as of the last answer: the card asks again while the print is on a machine
  // (a hidden tab asks nothing and asks once on return), and a failed re-read is never shown as live.
  usePoll(view.reload, ON_A_MACHINE.includes(v?.status ?? job.status), CURRENT_POLL_MS);
  const telemetry = v?.telemetry ?? null;
  const live = !view.error && !!telemetry && telemetry.live;
  const percent = live ? permillePercent(telemetry.progress_permille) : null;
  const grams = v?.estimate ? v.estimate.model_grams + v.estimate.support_grams + v.estimate.purge_grams : null;

  return (
    <article className="lv-surface p-4" aria-label={titleOf(job)}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="text-[15px] font-bold text-text-primary">{t(home.currentPrint)}</h3>
        <div className="flex flex-wrap items-center gap-1.5">
          <StatusPill kind="job" state={jobPillState(v?.status ?? job.status)} />
          {v?.printer ? <StatusPill kind="printer" state={live ? 'live' : machinePillState(telemetry)} /> : null}
        </div>
      </div>
      <div className="mt-3 flex items-start gap-3">
        <span aria-hidden="true" className="grid h-12 w-12 shrink-0 place-items-center rounded-xl lv-well text-text-secondary">
          <Box className="h-6 w-6" />
        </span>
        <div className="min-w-0 flex-1">
          <Link
            to={`/jobs/${encodeURIComponent(job.id)}`}
            className="block truncate rounded text-[15px] font-semibold text-text-primary hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus"
          >
            {titleOf(job)}
          </Link>
          <p className="truncate text-[12px] text-text-muted">
            {!v ? ' ' : v.printer ? (live ? t(home.liveFrom, { printer: v.printer.name }) : v.printer.name) : t(home.notOnMachine)}
          </p>
          {percent != null ? (
            <div className="mt-2 flex items-center gap-2">
              <ProgressBar value={percent} label={t(home.progressLabel)} tone="info" className="flex-1" />
              <bdi className="text-sm font-bold tabular-nums text-text-primary">{formatPercent(percent, lang)}</bdi>
            </div>
          ) : null}
        </div>
      </div>

      {view.error ? (
        <CloudErrorState compact className="mt-3" error={view.error} onRetry={view.reload} />
      ) : v ? (
        <>
          <dl className="mt-3 grid grid-cols-3 gap-2 text-center">
            <div className="rounded-xl lv-well px-2 py-2">
              <dt className="flex items-center justify-center gap-1 text-[11px] text-text-muted">
                <Hourglass aria-hidden="true" className="h-3.5 w-3.5" />
                {t(home.remaining)}
              </dt>
              <dd className="text-sm font-bold tabular-nums text-text-primary">{live && telemetry.remaining_seconds != null ? formatDuration(telemetry.remaining_seconds, lang) : '—'}</dd>
            </div>
            <div className="rounded-xl lv-well px-2 py-2">
              <dt className="flex items-center justify-center gap-1 text-[11px] text-text-muted">
                <Disc3 aria-hidden="true" className="h-3.5 w-3.5" />
                {t(home.estimatedMaterial)}
              </dt>
              <dd className="text-sm font-bold tabular-nums text-text-primary">{grams != null ? formatMass(grams, lang) : '—'}</dd>
            </div>
            <div className="rounded-xl lv-well px-2 py-2">
              <dt className="flex items-center justify-center gap-1 text-[11px] text-text-muted">
                <Layers aria-hidden="true" className="h-3.5 w-3.5" />
                {t(home.layers)}
              </dt>
              <dd className="text-sm font-bold tabular-nums text-text-primary">
                {live && telemetry.layer != null && telemetry.total_layers ? (
                  <bdi dir="ltr">
                    {formatFigure(telemetry.layer, lang)} / {formatFigure(telemetry.total_layers, lang)}
                  </bdi>
                ) : (
                  '—'
                )}
              </dd>
            </div>
          </dl>
          {v.printer && telemetry && !live ? (
            <p className="mt-3 text-[12px] leading-relaxed text-text-muted">{t(home.staleSince, { when: formatRelative(telemetry.received_at, lang) })}</p>
          ) : null}
          {v.printer && !telemetry ? <p className="mt-3 text-[12px] leading-relaxed text-text-muted">{t(home.noTelemetry)}</p> : null}
        </>
      ) : null}
    </article>
  );
}

function basisText(basis: QueueEstimate['basis'], t: (s: { ar: string; en: string; ckb: string }) => string): string | null {
  if (basis === 'no_compatible_printer') return t(home.noCompatiblePrinter);
  if (basis === 'waiting_for_dependency') return t(home.waitingForDependency);
  if (basis === 'dependency_cannot_complete') return t(home.dependencyCannotComplete);
  return null;
}

function Upcoming({ data }: { data: Dashboard }) {
  const { t, lang } = useCloudText();
  const titleOf = useJobTitle();
  const queue = useCloudQuery((signal) => getQueue({ signal }), [data]);
  const byId = useMemo(() => new Map((queue.data?.jobs ?? []).map((e) => [e.job_id, e])), [queue.data]);
  const jobs = data.jobs.queued;
  return (
    <section aria-labelledby="cloud-home-upcoming" className="space-y-2">
      <SectionHeader id="cloud-home-upcoming" title={t(home.upcoming)} count={jobs.length} />
      {jobs.length === 0 ? (
        <CloudEmptyState compact icon={<CalendarClock className="h-6 w-6" />} title={t(home.noUpcoming)} />
      ) : (
        <>
          <ul className="space-y-2">
            {jobs.map((job) => {
              const est = byId.get(job.id);
              const meta = est
                ? [t(home.position, { n: formatFigure(est.position, lang) }), basisText(est.basis, t) ?? (est.estimated_start_at ? t(home.startsAround, { when: formatRelative(est.estimated_start_at, lang) }) : null)]
                    .filter(Boolean)
                    .join(' · ')
                : null;
              return (
                <li key={job.id}>
                  <ListRow
                    to={`/jobs/${encodeURIComponent(job.id)}`}
                    leading={<CalendarClock className="h-4 w-4" />}
                    title={titleOf(job)}
                    meta={meta}
                    trailing={<StatusPill kind="job" state={jobPillState(job.status)} />}
                  />
                </li>
              );
            })}
          </ul>
          {queue.data?.jobs.length ? <p className="text-[12px] leading-relaxed text-text-muted">{t(home.queueNote)}</p> : null}
        </>
      )}
    </section>
  );
}

function InPreparation({ data }: { data: Dashboard }) {
  const { t } = useCloudText();
  const titleOf = useJobTitle();
  const jobs = data.jobs.in_preparation;
  if (jobs.length === 0) return null;
  return (
    <section aria-labelledby="cloud-home-preparing" className="space-y-2">
      <SectionHeader id="cloud-home-preparing" title={t(home.inPreparation)} count={jobs.length} />
      <ul className="space-y-2">
        {jobs.slice(0, 5).map((job) => (
          <li key={job.id}>
            <ListRow
              to={`/jobs/${encodeURIComponent(job.id)}`}
              leading={<Box className="h-4 w-4" />}
              title={titleOf(job)}
              trailing={<StatusPill kind="job" state={jobPillState(job.status)} />}
            />
          </li>
        ))}
      </ul>
    </section>
  );
}

// ------------------------------------------------------------------ printers

interface StripItem {
  id: string;
  name: string;
  active: number;
  idle: number;
  meta: string;
}

function PrintersStrip({ data, full = false }: { data: Dashboard; full?: boolean }) {
  const { t, lang } = useCloudText();
  const mine: MyPrinterModel[] = data.printers;
  // A customer with no hours yet sees the workshop's models instead (GET /printers).
  const all = useCloudQuery<PrinterModel[] | null>((signal) => (mine.length ? Promise.resolve(null) : listPrinters({ signal })), [mine.length]);
  const items: StripItem[] = mine.length
    ? mine.map((m) => ({
        id: m.printer_model_id,
        name: `${m.brand} ${m.model_name}`.trim(),
        active: m.compatible_machines,
        idle: m.idle_machines,
        meta: t(home.hoursHeld, { amount: formatHours(m.available_seconds, lang) }),
      }))
    : (all.data ?? []).map((m) => ({
        id: m.id,
        name: `${m.brand} ${m.model_name}`.trim(),
        active: m.machines_active,
        idle: m.machines_idle,
        meta: m.machines_active ? t(home.freeOfActive, { idle: formatFigure(m.machines_idle, lang), active: formatFigure(m.machines_active, lang) }) : '',
      }));
  const shown = full ? items : items.slice(0, 4);
  return (
    <section aria-labelledby="cloud-home-printers" className="space-y-2">
      <SectionHeader
        id="cloud-home-printers"
        title={mine.length ? t(home.yourPrinters) : t(home.workshopPrinters)}
        link={{ to: '/printers', label: t(home.viewPrinters) }}
      />
      {mine.length && full ? <p className="text-[12px] text-text-muted">{t(home.yourPrintersHint)}</p> : null}
      {all.error && !mine.length ? (
        <CloudErrorState compact error={all.error} onRetry={all.reload} />
      ) : !mine.length && !all.data ? (
        <CloudPageSkeleton />
      ) : shown.length === 0 ? null : (
        <ul className={`grid gap-2 ${full ? 'sm:grid-cols-2' : 'grid-cols-2 sm:grid-cols-4'}`}>
          {shown.map((p) => (
            <li key={p.id}>
              <Link
                to={`/printers/${encodeURIComponent(p.id)}`}
                className="lv-surface flex h-full min-w-0 flex-col items-center gap-2 p-3 text-center no-press transition-colors hover:bg-surface-raised active:shadow-press focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus"
              >
                <span aria-hidden="true" className="grid h-12 w-12 place-items-center rounded-full lv-well text-text-secondary">
                  <Printer className="h-6 w-6" />
                </span>
                <span className="w-full truncate text-[13px] font-bold text-text-primary">{p.name}</span>
                <StatusPill kind="printer" state={modelPillState(p.active, p.idle)} />
                {p.meta ? <span className="w-full truncate text-[11px] text-text-muted">{p.meta}</span> : null}
              </Link>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

// ------------------------------------------------------------------ filament and history

function FilamentList({ data }: { data: Dashboard }) {
  const { t, lang } = useCloudText();
  if (data.inventory.length === 0) {
    return (
      <CloudEmptyState
        icon={<Disc3 className="h-6 w-6" />}
        title={t(home.noFilamentTitle)}
        body={t(home.noFilamentBody)}
        action={
          <Link to="/store?tab=materials" className="lv-button lv-button-primary">
            {t(home.buyFilament)}
          </Link>
        }
      />
    );
  }
  return (
    <ul className="space-y-2">
      {data.inventory.map((r) => (
        <li key={r.account_id}>
          <ListRow
            leading={
              r.color_hex ? (
                // The colour of the material itself (the owner's catalogue data), not a theme colour.
                <span className="block h-5 w-5 rounded-full border border-border-subtle" style={{ backgroundColor: r.color_hex }} />
              ) : (
                <Disc3 className="h-4 w-4" />
              )
            }
            title={tx(r.name, lang)}
            meta={r.reserved_qty > 0 ? t(home.reserved, { amount: formatQuantity(r.reserved_qty, r.unit_code, lang) }) : r.brand || null}
            trailing={
              <span className="flex flex-col items-end gap-1">
                <span className="text-sm font-bold tabular-nums text-text-primary">{formatQuantity(r.available_qty, r.unit_code, lang)}</span>
                {isLow(r) ? <span className="text-[11px] font-semibold text-warning">{t(home.lowStock)}</span> : null}
              </span>
            }
          />
        </li>
      ))}
    </ul>
  );
}

function HistoryList({ data }: { data: Dashboard }) {
  const { t, lang } = useCloudText();
  const titleOf = useJobTitle();
  const jobs = [...data.jobs.completed, ...data.jobs.failed, ...data.jobs.cancelled]
    .sort((a, b) => (a.updated_at < b.updated_at ? 1 : a.updated_at > b.updated_at ? -1 : 0))
    .slice(0, 12);
  if (jobs.length === 0) return <CloudEmptyState compact icon={<History className="h-6 w-6" />} title={t(home.historyEmpty)} />;
  return (
    <div className="space-y-2">
      <p className="text-[12px] text-text-muted">{t(home.historyHint)}</p>
      <ul className="space-y-2">
        {jobs.map((job) => (
          <li key={job.id}>
            <ListRow
              to={`/jobs/${encodeURIComponent(job.id)}`}
              leading={<History className="h-4 w-4" />}
              title={titleOf(job)}
              meta={t(home.updated, { when: formatRelative(job.updated_at, lang) })}
              trailing={<StatusPill kind="job" state={jobPillState(job.status)} />}
            />
          </li>
        ))}
      </ul>
    </div>
  );
}

// ------------------------------------------------------------------ the page

export default function Home() {
  const { t } = useCloudText();
  const cloud = useCloud();
  const dash = useCloudQuery((signal) => getDashboard({ signal }), [cloud.dashboardVersion]);
  const [view, setView] = useState<View>('prints');

  if (dash.error) return <CloudErrorState error={dash.error} onRetry={dash.reload} />;
  if (!dash.data) return <CloudPageSkeleton />;
  const data = dash.data;
  const noModels = data.files.files.length === 0 && data.files.imports.length === 0;
  const waitingForEstimate = data.jobs.in_preparation.some((j) => j.status === 'analyzing' || j.status === 'uploaded');
  const slicer = cloud.status?.slicer;

  return (
    <div className="space-y-5">
      <h1 className="sr-only">{t(home.title)}</h1>

      <section aria-label={t(home.printingHours)} className="grid grid-cols-2 gap-3 lg:grid-cols-3">
        <HoursCards data={data} />
        <FilamentCard data={data} />
      </section>

      <section aria-label={t(home.quickActions)} className="grid grid-cols-3 gap-2 sm:grid-cols-6">
        <PrimaryAction className="col-span-full sm:col-span-3" to="/print" icon={<Box className="h-5 w-5" />} label={t(home.startPrint)} hint={t(home.startPrintHint)} />
        <QuickAction to="/store?tab=hours" icon={<Clock className="h-5 w-5" />} label={t(home.buyHours)} />
        <QuickAction to="/store?tab=materials" icon={<Disc3 className="h-5 w-5" />} label={t(home.buyFilament)} />
        <QuickAction to="/printers" icon={<Printer className="h-5 w-5" />} label={t(home.viewPrinters)} />
      </section>

      {waitingForEstimate && slicer && slicer !== 'connected' ? (
        <p className="flex items-start gap-2 rounded-xl lv-well px-3 py-2 text-[13px] leading-snug text-text-secondary">
          <Info aria-hidden="true" className="mt-0.5 h-4 w-4 shrink-0" />
          {slicer === 'stale' ? t(service.slicerStale) : t(service.slicerOff)}
        </p>
      ) : null}

      <Segmented
        group="cloud-home-view"
        label={t(home.tabsLabel)}
        value={view}
        onChange={(id) => setView(id as View)}
        items={[
          { id: 'prints', label: t(home.tabPrints) },
          { id: 'printers', label: t(home.tabPrinters) },
          { id: 'filament', label: t(home.tabFilament) },
          { id: 'history', label: t(home.tabHistory) },
        ]}
      />

      {view === 'prints' ? (
        <div className="space-y-5">
          {noModels ? (
            <CloudEmptyState
              icon={<Upload className="h-6 w-6" />}
              title={t(home.noFilesTitle)}
              body={t(home.noFilesBody)}
              action={
                <Link to="/print" className="lv-button lv-button-primary">
                  {t(home.uploadFirst)}
                </Link>
              }
            />
          ) : null}
          <section aria-label={t(home.currentPrints)} className="space-y-3">
            {data.jobs.current.length === 0 ? (
              <CloudEmptyState compact icon={<Printer className="h-6 w-6" />} title={t(home.noCurrentPrint)} />
            ) : (
              data.jobs.current.slice(0, 3).map((job) => <CurrentPrintCard key={job.id} job={job} />)
            )}
          </section>
          <Upcoming data={data} />
          <InPreparation data={data} />
          <PrintersStrip data={data} />
        </div>
      ) : view === 'printers' ? (
        <PrintersStrip data={data} full />
      ) : view === 'filament' ? (
        <FilamentList data={data} />
      ) : (
        <HistoryList data={data} />
      )}
    </div>
  );
}
