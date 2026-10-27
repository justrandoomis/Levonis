/**
 * /jobs/:id — ONE PRINT, FOLLOWED THROUGH ITS FOURTEEN STATES
 * (GET /jobs/{id}, /jobs/{id}/projection, /queue; POST analyze, review,
 * confirm, cancel, requests, reschedule; PATCH /jobs/{id}).
 *
 * THE HONEST PROJECTION BEFORE CONFIRM. With no estimate the page says
 * «awaiting estimate» and shows no time and no grams. With one, it says where
 * it came from — the workshop's slicer (named, with its version) or an
 * operator reading their slicer — then what confirming would reserve, from the
 * server's projection: the hours of the job's class and every material and
 * accessory, needed / held / left after, and every shortfall with the store
 * page that covers it. Confirming opens a sheet that asks the server to
 * review again (fresh figures, a fresh window), and sends the confirmation
 * with ONE Idempotency-Key made when the sheet opened and re-sent on every
 * retry of that intent (src/cloud/api.ts) — a replay says so.
 *
 * FOLLOWING IT. The page asks again while something can change without the
 * customer (the estimate arriving, the workshop approving, the queue moving,
 * a print running). The queue's position and times are the server's
 * simulation, labelled as one, and shown only when it gives them. Progress,
 * layers, time left and temperatures come only from the printer's reading
 * when it is fresh AND about this print; a stale reading is stale, none is
 * «no reading yet».
 *
 * WHAT THE CUSTOMER MAY DO is what the server would accept in that state
 * (model.ts `jobAllows`): ask for the estimate, review and confirm, change
 * the settings before anything is reserved, cancel before the workshop
 * starts, hold a queued print's start, and ask the workshop — recorded for an
 * operator, never executed — to pause or stop, or send a note (a reprint
 * after a failure is the workshop's decision, asked for in a note).
 */
import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { Link, useLocation, useParams } from 'react-router-dom';
import { StatusChip } from '../../../components/ui/Badge';
import { Button } from '../../../components/ui/Button';
import { ConfirmDialog } from '../../../components/ui/ConfirmDialog';
import { Field, Input, Textarea } from '../../../components/ui/Field';
import { Sheet } from '../../../components/ui/Sheet';
import { formatFigure } from '../../../lib/localeNumber';
import { toast } from '../../../lib/toastStore';
import {
  cancelJob,
  cloudErrorCode,
  cloudErrorText,
  confirmJob,
  editJob,
  getJob,
  getJobProjection,
  getQueue,
  requestJobAnalysis,
  rescheduleJob,
  reviewJob,
  sendJobRequest,
  useIdempotencyKey,
} from '../../api';
import { useCloud } from '../../CloudContext';
import { formatDateTime, formatDuration, formatMass, formatNozzle, formatPercent, formatQuantity, formatRelative } from '../../format';
import { common, jobStatus as jobStatusWords, service } from '../../strings/common';
import { configure, jobWords, print, settingWords, stepWords } from '../../strings/print';
import { tx, useCloudText } from '../../text';
import type { JobReviewed, JobView, PrintSettings, PrinterModel } from '../../types';
import {
  CalendarClock,
  Check,
  Clock,
  CloudErrorState,
  CloudPageSkeleton,
  Disc3,
  Boxes,
  Hourglass,
  Layers,
  MessageSquare,
  CircleX,
  PageHeader,
  Pause,
  Printer,
  ProgressBar,
  SectionHeader,
  SlidersHorizontal,
  StatusPill,
  TriangleAlert,
  X,
  jobPillState,
  machinePillState,
} from '../../ui';
import { useCloudQuery } from '../../useCloudQuery';
import { Fact, RefreshNote, Swatch, printerName, usePoll, usePrinterModels, useVariantNames, type VariantName } from './kit';
import {
  actorText,
  currentHold,
  eventText,
  failurePartyText,
  failurePolicyText,
  failureReasonText,
  jobAllows,
  jobPollMs,
  jobStateText,
  jobStep,
  jobSteps,
  lastAnalysisProblem,
  projectionDisplay,
  queueBasisText,
  shortfallLink,
  telemetryDisplay,
  type ProjectionDisplay,
} from './model';
import { SettingsFields } from './SettingsForm';

type Names = (variantId: string) => VariantName | null;

const QUEUE_POLL_MS = 30_000;

/** A material's name as the customer reads it, or the honest «Material <id>». */
function useMaterialLabel(names: Names) {
  const { t, lang } = useCloudText();
  return (variantId: string) => {
    const v = names(variantId);
    return v ? tx(v.name, lang) : t(jobWords.materialId, { id: variantId });
  };
}

const unitOf = (names: Names, variantId: string, kind: string) => names(variantId)?.unit ?? (kind === 'accessory' ? 'pc' : 'g');

// ------------------------------------------------------------------ where it is

function Stepper({ job }: { job: JobView }) {
  const { t } = useCloudText();
  const steps = jobSteps(job.needs_operator_approval);
  const on = jobStep(job.status);
  // Off the path: a failure stopped at the printing stage; a cancelled job stopped wherever it was.
  const stoppedAt = on ?? (job.status === 'failed' || job.status === 'reprint_requested' ? 'printing' : null);
  const at = stoppedAt ? steps.indexOf(stoppedAt) : -1;
  return (
    <ol aria-label={t(stepWords.label)} className="flex flex-wrap gap-x-4 gap-y-2">
      {steps.map((s, i) => {
        const done = i < at || (job.status === 'completed' && s === 'done');
        const current = i === at && job.status !== 'completed';
        const stopped = current && !on;
        return (
          <li key={s} aria-current={current ? 'step' : undefined} className="flex items-center gap-1.5 text-[12px]">
            {done ? (
              <Check aria-hidden="true" className="h-3.5 w-3.5 text-success" />
            ) : stopped ? (
              <TriangleAlert aria-hidden="true" className="h-3.5 w-3.5 text-danger" />
            ) : (
              <span aria-hidden="true" className={`h-2 w-2 rounded-full ${current ? 'bg-gold' : 'bg-text-muted/40'}`} />
            )}
            <span className={current ? 'font-bold text-text-primary' : done ? 'text-text-secondary' : 'text-text-muted'}>{t(stepWords[s])}</span>
            {current ? <span className="sr-only">({t(stepWords.current)})</span> : done ? <span className="sr-only">({t(stepWords.passed)})</span> : null}
          </li>
        );
      })}
    </ol>
  );
}

// ------------------------------------------------------------------ the estimate, and what confirming would hold

function EstimateCard({ job }: { job: JobView }) {
  const { t, lang } = useCloudText();
  const cloud = useCloud();
  const { refreshStatus } = cloud;
  // «The slicer is connected» is read again with every poll of a job being measured — never from the app's first load.
  useEffect(() => {
    if (job.status === 'analyzing') refreshStatus();
  }, [job, refreshStatus]);
  const d = projectionDisplay(job.estimate, null);
  if (d.source === 'none') {
    // Only a job still on its way to an estimate is «awaiting» one; later states have their own cards.
    if (jobStep(job.status) !== 'estimate') return null;
    const slicer = cloud.status?.slicer;
    return (
      <section aria-labelledby="print-job-estimate" className="lv-surface space-y-2 p-4">
        <SectionHeader id="print-job-estimate" title={t(jobWords.estimate)} action={<StatusPill kind="job" state="awaiting_estimate" />} />
        <p className="text-[13px] leading-relaxed text-text-secondary">{t(jobWords.awaitingBody)}</p>
        {job.status === 'analyzing' && slicer ? (
          <p className="text-[12px] leading-relaxed text-text-muted">
            {slicer === 'connected' ? t(service.slicerConnected) : slicer === 'stale' ? t(service.slicerStale) : t(service.slicerOff)}
          </p>
        ) : null}
      </section>
    );
  }
  const e = job.estimate!;
  const source =
    d.source === 'slicer'
      ? e.slicer_name
        ? t(jobWords.sourceSlicerNamed, { slicer: [e.slicer_name, e.slicer_version].filter(Boolean).join(' ') })
        : t(jobWords.sourceSlicer)
      : t(jobWords.sourceOperator);
  const g = d.grams!;
  return (
    <section aria-labelledby="print-job-estimate" className="lv-surface space-y-3 p-4">
      <SectionHeader id="print-job-estimate" title={t(jobWords.estimate)} />
      <p className="text-[12px] text-text-muted">{source}</p>
      <dl className="grid grid-cols-2 gap-2 text-center sm:grid-cols-3">
        <div className="rounded-xl lv-well px-2 py-2">
          <dt className="flex items-center justify-center gap-1 text-[11px] text-text-muted">
            <Clock aria-hidden="true" className="h-3.5 w-3.5" />
            {t(jobWords.printTime)}
          </dt>
          <dd className="text-sm font-bold tabular-nums text-text-primary">{formatDuration(d.durationSeconds, lang)}</dd>
        </div>
        <div className="rounded-xl lv-well px-2 py-2">
          <dt className="flex items-center justify-center gap-1 text-[11px] text-text-muted">
            <Disc3 aria-hidden="true" className="h-3.5 w-3.5" />
            {t(jobWords.material)}
          </dt>
          <dd className="text-sm font-bold tabular-nums text-text-primary">{formatMass(g.total, lang)}</dd>
        </div>
        {d.layerCount != null ? (
          <div className="rounded-xl lv-well px-2 py-2">
            <dt className="flex items-center justify-center gap-1 text-[11px] text-text-muted">
              <Layers aria-hidden="true" className="h-3.5 w-3.5" />
              {t(jobWords.layers)}
            </dt>
            <dd className="text-sm font-bold tabular-nums text-text-primary">{formatFigure(d.layerCount, lang)}</dd>
          </div>
        ) : null}
      </dl>
      <p className="text-[12px] text-text-muted">
        {t(jobWords.grams, { model: formatMass(g.model, lang), support: formatMass(g.support, lang), purge: formatMass(g.purge, lang) })}
        {d.colourChanges ? ` · ${t(jobWords.colourChanges)}: ${formatFigure(d.colourChanges, lang)}` : ''}
      </p>
      {d.warnings.length ? (
        <div className="space-y-1">
          <p className="text-[12px] font-semibold text-text-secondary">{t(jobWords.slicerNotes)}</p>
          <ul className="list-disc space-y-0.5 ps-5 text-[12px] text-text-secondary">
            {d.warnings.map((w) => (
              <li key={w}>
                <bdi>{w}</bdi>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
      <p className="text-[12px] leading-relaxed text-text-muted">{t(jobWords.estimateNote)}</p>
    </section>
  );
}

/** Needed / held / left after for one line, and — when it is short — by how much and where to buy it. */
function ProjectionLine({
  label,
  leading,
  needed,
  have,
  after,
  short,
}: {
  label: ReactNode;
  leading?: ReactNode;
  needed: string;
  have: string;
  after: string;
  short: { amount: string; to: string; label: string } | null;
}) {
  const { t } = useCloudText();
  return (
    <li className="space-y-2 py-3">
      <div className="flex items-center justify-between gap-3">
        <p className="flex min-w-0 items-center gap-2 text-sm font-semibold text-text-primary">
          {leading}
          <span className="truncate">{label}</span>
        </p>
        <StatusChip tone={short ? 'danger' : 'success'}>{short ? t(jobWords.short, { amount: short.amount }) : t(jobWords.enough)}</StatusChip>
      </div>
      <dl className="grid grid-cols-3 gap-2 text-center">
        <div className="rounded-xl lv-well px-1 py-1.5">
          <dt className="text-[11px] text-text-muted">{t(jobWords.needed)}</dt>
          <dd className="text-[13px] font-bold tabular-nums text-text-primary">{needed}</dd>
        </div>
        <div className="rounded-xl lv-well px-1 py-1.5">
          <dt className="text-[11px] text-text-muted">{t(jobWords.have)}</dt>
          <dd className="text-[13px] font-bold tabular-nums text-text-primary">{have}</dd>
        </div>
        <div className="rounded-xl lv-well px-1 py-1.5">
          <dt className="text-[11px] text-text-muted">{t(jobWords.after)}</dt>
          <dd className={`text-[13px] font-bold tabular-nums ${short ? 'text-danger' : 'text-text-primary'}`}>{after}</dd>
        </div>
      </dl>
      {short ? (
        <Link to={short.to} className="lv-button lv-button-secondary lv-button-sm">
          {short.label}
        </Link>
      ) : null}
    </li>
  );
}

/** «Left after» may be below zero when it is short: written as «−» and the figure, never as a balance the customer has. */
const signed = (n: number, write: (x: number) => string) => (n < 0 ? `−${write(-n)}` : write(n));

function ProjectionLines({ d, names, model }: { d: ProjectionDisplay; names: Names; model: PrinterModel | undefined }) {
  const { t, lang } = useCloudText();
  const label = useMaterialLabel(names);
  const tier = model ? tx(model.tier_name, lang) || model.tier_code : '';
  if (!d.hours) return null;
  const h = d.hours;
  return (
    <>
      <ul className="divide-y divide-border-subtle">
        <ProjectionLine
          label={tier ? t(jobWords.hoursOf, { class: tier }) : t(jobWords.printingHours)}
          leading={<Clock aria-hidden="true" className="h-4 w-4 text-text-secondary" />}
          needed={formatDuration(h.required, lang)}
          have={formatDuration(h.available, lang)}
          after={signed(h.after, (x) => formatDuration(x, lang))}
          short={
            h.shortfall > 0
              ? {
                  amount: formatDuration(h.shortfall, lang),
                  to: shortfallLink({ kind: 'hours', code: 'INSUFFICIENT_CREDIT', id: h.tierId, amount: h.shortfall }),
                  label: tier ? t(jobWords.buyHours, { class: tier }) : t(jobWords.buyHoursPlain),
                }
              : null
          }
        />
        {d.materials.map((m) => {
          const unit = unitOf(names, m.variantId, m.kind);
          const q = (x: number) => formatQuantity(x, unit, lang);
          return (
            <ProjectionLine
              key={m.variantId}
              label={
                <>
                  {label(m.variantId)}
                  <span className="ms-1.5 text-[11px] font-normal text-text-muted">{t(m.kind === 'accessory' ? jobWords.accessory : jobWords.filament)}</span>
                </>
              }
              leading={<Swatch hex={names(m.variantId)?.colorHex} />}
              needed={q(m.required)}
              have={q(m.available)}
              after={signed(m.after, q)}
              short={
                m.shortfall > 0
                  ? {
                      amount: q(m.shortfall),
                      to: shortfallLink({ kind: m.kind === 'accessory' ? 'accessory' : 'filament', code: 'INSUFFICIENT_INVENTORY', id: m.variantId, amount: m.shortfall }),
                      label: t(jobWords.buy, { name: label(m.variantId) }),
                    }
                  : null
              }
            />
          );
        })}
      </ul>
      {d.sufficient ? (
        <p className="lv-alert lv-alert-success text-[13px] text-text-primary">{t(jobWords.covered)}</p>
      ) : (
        <div role="alert" className="lv-alert lv-alert-warning space-y-1 text-[13px] text-text-primary">
          <p className="font-bold">{t(jobWords.shortTitle)}</p>
          <p>{t(jobWords.shortBody)}</p>
        </div>
      )}
    </>
  );
}

function ProjectionCard({ job, names, model }: { job: JobView; names: Names; model: PrinterModel | undefined }) {
  const { t } = useCloudText();
  const q = useCloudQuery((signal) => getJobProjection(job.id, { signal }), [job.id, job.updated_at]);
  if (q.error && !q.data) return <CloudErrorState compact error={q.error} onRetry={q.reload} />;
  if (!q.data) return <CloudPageSkeleton />;
  const d = projectionDisplay(job.estimate, q.data);
  return (
    <section aria-labelledby="print-job-projection" className="lv-surface space-y-2 p-4">
      <SectionHeader id="print-job-projection" title={t(jobWords.projection)} />
      <ProjectionLines d={d} names={names} model={model} />
    </section>
  );
}

// ------------------------------------------------------------------ confirming: the money door

function ConfirmSheet({
  job,
  open,
  onClose,
  onDone,
  names,
  model,
}: {
  job: JobView;
  open: boolean;
  onClose: () => void;
  onDone: () => void;
  names: Names;
  model: PrinterModel | undefined;
}) {
  const { t, lang } = useCloudText();
  const cloud = useCloud();
  // ONE KEY PER INTENT: made when the sheet opens, re-sent on every retry, renewed after success.
  const intent = useIdempotencyKey('job-confirm');
  const [review, setReview] = useState<JobReviewed | null>(null);
  const [reviewError, setReviewError] = useState<unknown>(null);
  const [confirmError, setConfirmError] = useState<unknown>(null);

  const runReview = useCallback(async () => {
    setReview(null);
    setReviewError(null);
    setConfirmError(null);
    try {
      setReview(await reviewJob(job.id));
    } catch (e) {
      setReviewError(e);
    }
  }, [job.id]);

  useEffect(() => {
    if (!open) return;
    intent.renew();
    void runReview();
    // A new intent each time the sheet opens; `intent.renew` is stable.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, runReview]);

  const confirm = async () => {
    setConfirmError(null);
    try {
      const r = await confirmJob(job.id, intent.key);
      intent.renew();
      toast.success(r.replayed ? t(jobWords.replayed) : t(jobWords.confirmed));
      cloud.refreshDashboard();
      onDone();
    } catch (e) {
      setConfirmError(e);
    }
  };

  const d = review ? projectionDisplay(job.estimate, review) : null;
  const refusal = cloudErrorCode(confirmError);
  const expired = refusal === 'QUOTE_EXPIRED';
  // A refusal with a code (the window closed, a balance moved, the job changed) needs fresh figures:
  // review again. A request that never got an answer (no code) is retried as it was — the same key.
  const reviewFirst = !!refusal && refusal !== 'NETWORK' && refusal !== 'TIMEOUT';
  return (
    <Sheet
      open={open}
      onClose={onClose}
      labelledBy="print-confirm-title"
      detents={['large']}
      panelClassName="w-full sm:max-w-lg"
      header={
        <div className="flex items-center justify-between gap-2 px-5 pb-2 pt-1">
          <h2 id="print-confirm-title" className="truncate text-[16px] font-bold text-text-primary">
            {t(jobWords.confirm)}
          </h2>
          <Button variant="ghost" size="sm" icon={<X aria-hidden="true" className="h-4 w-4" />} onClick={onClose}>
            {t(common.close)}
          </Button>
        </div>
      }
      footer={
        <div className="flex flex-col-reverse gap-2 px-5 py-3 sm:flex-row sm:justify-end">
          <Button variant="secondary" onClick={onClose}>
            {t(common.close)}
          </Button>
          {reviewFirst ? (
            <Button variant="primary" onClick={runReview}>
              {t(jobWords.reviewAgain)}
            </Button>
          ) : (
            <Button variant="primary" disabled={!d || !d.sufficient} onClick={confirm}>
              {t(jobWords.confirm)}
            </Button>
          )}
        </div>
      }
    >
      <div className="space-y-3 px-5 pb-6 pt-1" aria-live="polite">
        {reviewError ? (
          <CloudErrorState compact error={reviewError} onRetry={runReview} />
        ) : !d || !review ? (
          <div className="space-y-3">
            <p className="text-[13px] text-text-secondary">{t(jobWords.reviewing)}</p>
            <CloudPageSkeleton />
          </div>
        ) : (
          <>
            <p className="text-[13px] leading-relaxed text-text-secondary">{t(jobWords.confirmLead)}</p>
            <ProjectionLines d={d} names={names} model={model} />
            <p className="text-[12px] text-text-muted">{t(jobWords.holdsUntil, { time: formatDateTime(review.confirmation_expires_at, lang) })}</p>
            <p className="text-[12px] text-text-muted">{t(job.needs_operator_approval ? jobWords.approvalNext : jobWords.queueNext)}</p>
            <p className="text-[12px] text-text-muted">{t(jobWords.settleNote)}</p>
          </>
        )}
        {confirmError ? (
          <div role="alert" className="lv-alert lv-alert-danger space-y-1 text-[13px] text-text-primary">
            <p>{cloudErrorText(confirmError, lang)}</p>
            {expired ? <p>{t(jobWords.expired)}</p> : null}
          </div>
        ) : null}
      </div>
    </Sheet>
  );
}

// ------------------------------------------------------------------ the queue

function QueueCard({ job, onChanged }: { job: JobView; onChanged: () => void }) {
  const { t, lang } = useCloudText();
  const q = useCloudQuery((signal) => getQueue({ signal }), [job.id, job.updated_at]);
  usePoll(q.reload, true, QUEUE_POLL_MS);
  const mine = q.data?.jobs.find((e) => e.job_id === job.id) ?? null;
  const hold = currentHold(job.events);
  const [open, setOpen] = useState(false);
  const [when, setWhen] = useState('');
  const [problem, setProblem] = useState<string | null>(null);
  const save = async (notBefore: string | null) => {
    setProblem(null);
    if (notBefore !== null && !(Date.parse(notBefore) > Date.now())) {
      setProblem(t(jobWords.inPast));
      return;
    }
    try {
      await rescheduleJob(job.id, notBefore);
      toast.success(t(jobWords.rescheduled));
      setOpen(false);
      onChanged();
    } catch (e) {
      setProblem(cloudErrorText(e, lang));
    }
  };
  const basis = mine ? queueBasisText(mine.basis, lang) : null;
  return (
    <section aria-labelledby="print-job-queue" className="lv-surface space-y-2 p-4">
      <SectionHeader
        id="print-job-queue"
        title={t(jobWords.queue)}
        action={
          <Button size="sm" variant="ghost" icon={<CalendarClock aria-hidden="true" className="h-4 w-4" />} onClick={() => setOpen(true)}>
            {t(jobWords.reschedule)}
          </Button>
        }
      />
      {q.error && !q.data ? (
        <CloudErrorState compact error={q.error} onRetry={q.reload} />
      ) : !q.data ? null : mine ? (
        <div className="space-y-1 text-[13px] text-text-secondary">
          <p className="font-semibold text-text-primary">{t(jobWords.position, { n: formatFigure(mine.position, lang) })}</p>
          {basis ? <p className="text-warning">{basis}</p> : null}
          {!basis && mine.estimated_start_at ? <p>{t(jobWords.startsAround, { when: formatRelative(mine.estimated_start_at, lang) })}</p> : null}
          {!basis && mine.estimated_end_at ? <p>{t(jobWords.endsAround, { when: formatRelative(mine.estimated_end_at, lang) })}</p> : null}
          <p className="text-[12px] text-text-muted">{t(jobWords.queueNote)}</p>
        </div>
      ) : (
        <p className="text-[13px] text-text-muted">{t(jobWords.noPosition)}</p>
      )}
      {hold ? <p className="text-[13px] text-text-secondary">{t(jobWords.holdUntil, { time: formatDateTime(hold, lang) })}</p> : null}
      <Sheet
        open={open}
        onClose={() => setOpen(false)}
        labelledBy="print-reschedule-title"
        panelClassName="w-full sm:max-w-md"
        header={
          <div className="px-5 pb-2 pt-1">
            <h2 id="print-reschedule-title" className="text-[16px] font-bold text-text-primary">
              {t(jobWords.reschedule)}
            </h2>
          </div>
        }
      >
        <form
          className="space-y-3 px-5 pb-6 pt-1"
          onSubmit={(e) => {
            e.preventDefault();
            if (when) void save(new Date(when).toISOString());
          }}
        >
          <p className="text-[13px] leading-relaxed text-text-secondary">{t(jobWords.rescheduleBody)}</p>
          <Field label={t(jobWords.notBefore)} error={problem}>
            <Input ltr type="datetime-local" value={when} onChange={(e) => setWhen(e.target.value)} />
          </Field>
          <div className="flex flex-wrap gap-2">
            <Button type="submit" variant="primary" disabled={!when}>
              {t(print.save)}
            </Button>
            {hold ? (
              <Button variant="ghost" onClick={() => save(null)}>
                {t(jobWords.clearHold)}
              </Button>
            ) : null}
          </div>
        </form>
      </Sheet>
    </section>
  );
}

// ------------------------------------------------------------------ the printer's reading

function PrinterCard({ job }: { job: JobView }) {
  const { t, lang } = useCloudText();
  const d = telemetryDisplay(job.telemetry);
  if (!job.printer) {
    return (
      <section aria-labelledby="print-job-printer" className="lv-surface space-y-1 p-4">
        <SectionHeader id="print-job-printer" title={t(jobWords.printerProgress)} />
        <p className="text-[13px] text-text-muted">{t(jobWords.notOnMachine)}</p>
      </section>
    );
  }
  return (
    <section aria-labelledby="print-job-printer" className="lv-surface space-y-3 p-4">
      <SectionHeader
        id="print-job-printer"
        title={t(jobWords.printerProgress)}
        action={<StatusPill kind="printer" state={d.kind === 'live' ? 'live' : machinePillState(job.telemetry)} />}
      />
      <p className="flex items-center gap-2 text-[13px] font-semibold text-text-primary">
        <Printer aria-hidden="true" className="h-4 w-4 text-text-secondary" />
        <bdi>{d.kind === 'live' ? t(jobWords.liveFrom, { printer: job.printer.name }) : job.printer.name}</bdi>
      </p>
      {d.kind === 'live' ? (
        <>
          {d.percent != null ? (
            <div className="flex items-center gap-2">
              <ProgressBar value={d.percent} label={t(jobWords.progressLabel)} tone="info" className="flex-1" />
              <bdi className="text-sm font-bold tabular-nums text-text-primary">{formatPercent(d.percent, lang)}</bdi>
            </div>
          ) : null}
          <dl className="divide-y divide-border-subtle">
            {d.layer != null && d.totalLayers ? (
              <Fact label={t(jobWords.layer)}>
                <bdi dir="ltr">
                  {formatFigure(d.layer, lang)} / {formatFigure(d.totalLayers, lang)}
                </bdi>
              </Fact>
            ) : null}
            {d.remainingSeconds != null ? (
              <Fact label={t(jobWords.remaining)}>
                <span className="inline-flex items-center gap-1">
                  <Hourglass aria-hidden="true" className="h-3.5 w-3.5 text-text-muted" />
                  {formatDuration(d.remainingSeconds, lang)}
                </span>
              </Fact>
            ) : null}
            {d.nozzleC != null ? <Fact label={t(jobWords.nozzleTemp)}>{t(jobWords.degrees, { n: formatFigure(d.nozzleC, lang) })}</Fact> : null}
            {d.bedC != null ? <Fact label={t(jobWords.bedTemp)}>{t(jobWords.degrees, { n: formatFigure(d.bedC, lang) })}</Fact> : null}
          </dl>
          <p className="text-[12px] text-text-muted">{t(jobWords.reportedAt, { when: formatRelative(d.receivedAt, lang) })}</p>
        </>
      ) : d.kind === 'stale' ? (
        <p className="lv-alert lv-alert-warning text-[13px] text-text-primary">{t(jobWords.staleSince, { when: formatRelative(d.receivedAt, lang) })}</p>
      ) : d.kind === 'elsewhere' ? (
        <p className="text-[13px] text-text-muted">{t(jobWords.elsewhere)}</p>
      ) : (
        <p className="text-[13px] text-text-muted">{t(jobWords.noTelemetry)}</p>
      )}
    </section>
  );
}

// ------------------------------------------------------------------ what is held, and what it came to

function ReservationsCard({ job, names }: { job: JobView; names: Names }) {
  const { t, lang } = useCloudText();
  const label = useMaterialLabel(names);
  const c = job.reservations.credits;
  const mats = job.reservations.materials;
  if (!c && mats.length === 0) return null;
  const state = (s: string) => (s === 'active' ? t(jobWords.heldNow) : s === 'settled' ? t(jobWords.settled) : s === 'released' ? t(jobWords.released) : s);
  const row = (held: string, used: string, back: string) => `${t(jobWords.held)} ${held} · ${t(jobWords.used)} ${used} · ${t(jobWords.returned)} ${back}`;
  return (
    <section aria-labelledby="print-job-reserved" className="lv-surface space-y-2 p-4">
      <SectionHeader id="print-job-reserved" title={t(jobWords.reserved)} />
      <ul className="divide-y divide-border-subtle">
        {c ? (
          <li className="space-y-0.5 py-2">
            <p className="flex items-center justify-between gap-2 text-sm font-semibold text-text-primary">
              <span>{t(jobWords.printingHours)}</span>
              <StatusChip tone={c.state === 'active' ? 'info' : 'neutral'}>{state(c.state)}</StatusChip>
            </p>
            <p className="text-[12px] text-text-muted">
              {row(formatDuration(c.seconds_reserved, lang), formatDuration(c.seconds_consumed, lang), formatDuration(c.seconds_released, lang))}
            </p>
          </li>
        ) : null}
        {mats.map((m) => {
          const unit = names(m.variant_id)?.unit ?? 'g';
          const q = (x: number) => formatQuantity(x, unit, lang);
          return (
            <li key={m.variant_id} className="space-y-0.5 py-2">
              <p className="flex items-center justify-between gap-2 text-sm font-semibold text-text-primary">
                <span className="flex min-w-0 items-center gap-2">
                  <Swatch hex={names(m.variant_id)?.colorHex} />
                  <span className="truncate">{label(m.variant_id)}</span>
                </span>
                <StatusChip tone={m.state === 'active' ? 'info' : 'neutral'}>{state(m.state)}</StatusChip>
              </p>
              <p className="text-[12px] text-text-muted">{row(q(m.qty_reserved), q(m.qty_consumed), q(m.qty_released))}</p>
            </li>
          );
        })}
      </ul>
    </section>
  );
}

function ResultCard({ job }: { job: JobView }) {
  const { t, lang } = useCloudText();
  if (job.status !== 'completed') return null;
  return (
    <section aria-labelledby="print-job-result" className="lv-surface p-4">
      <SectionHeader id="print-job-result" title={t(jobWords.result)} />
      <dl className="mt-1 divide-y divide-border-subtle">
        {job.printed_seconds != null ? <Fact label={t(jobWords.printedTime)}>{formatDuration(job.printed_seconds, lang)}</Fact> : null}
        {job.billable_seconds != null ? <Fact label={t(jobWords.billedTime)}>{formatDuration(job.billable_seconds, lang)}</Fact> : null}
        {job.ended_at ? <Fact label={t(jobStatusWords.completed)}>{formatDateTime(job.ended_at, lang)}</Fact> : null}
      </dl>
    </section>
  );
}

function FailureCard({ job }: { job: JobView }) {
  const { t, lang } = useCloudText();
  const f = job.failure;
  if (!f) return null;
  const policy = failurePolicyText(f.policy, lang);
  return (
    <section aria-labelledby="print-job-failure" className="lv-surface space-y-2 p-4">
      <SectionHeader id="print-job-failure" title={t(jobWords.failure)} />
      <dl className="divide-y divide-border-subtle">
        <Fact label={t(jobWords.reasonLabel)}>
          <bdi>{failureReasonText(f.reason_code, lang)}</bdi>
        </Fact>
        <Fact label={t(jobWords.responsible)}>{failurePartyText(f.responsible, lang)}</Fact>
        {f.billable_seconds != null && f.status !== 'reported' ? <Fact label={t(jobWords.billedTime)}>{formatDuration(f.billable_seconds, lang)}</Fact> : null}
      </dl>
      <p className="text-[13px] leading-relaxed text-text-secondary">
        {f.status === 'reported' ? t(jobWords.failureReported) : policy ? t(jobWords.failureResolved, { policy }) : null}
      </p>
      {f.reprint_job_id ? (
        <Link to={`/jobs/${encodeURIComponent(f.reprint_job_id)}`} className="lv-button lv-button-primary lv-button-sm">
          {t(jobWords.reprint)}
        </Link>
      ) : null}
    </section>
  );
}

// ------------------------------------------------------------------ the settings, and changing them

function settingsSummary(s: PrintSettings, copies: number, t: (x: { ar: string; en: string; ckb: string }, v?: Record<string, string | number>) => string, lang: 'ar' | 'en' | 'ckb') {
  const plate = s.plate_type in settingWords ? t(settingWords[s.plate_type as 'textured_pei']) : s.plate_type;
  return [
    [t(settingWords.layerHeight), formatNozzle(s.layer_height_um, lang)],
    [t(settingWords.infill), formatPercent(s.infill_percent, lang)],
    [t(settingWords.supports), t(settingWords[`supports_${s.supports}`])],
    [t(settingWords.plateType), plate],
    [t(settingWords.nozzle), formatNozzle(s.nozzle_um, lang)],
    [t(settingWords.walls), formatFigure(s.walls, lang)],
    [t(settingWords.brim), s.brim ? t(common.yes) : t(common.no)],
    [t(settingWords.orientation), t(s.orientation === 'auto' ? settingWords.orientation_auto : settingWords.orientation_as_uploaded)],
    [t(settingWords.copies), formatFigure(copies, lang)],
  ] as const;
}

function SettingsCard({ job, model, onChanged }: { job: JobView; model: PrinterModel | undefined; onChanged: () => void }) {
  const { t, lang } = useCloudText();
  const allows = jobAllows(job.status);
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState<PrintSettings>(job.settings);
  const [copies, setCopies] = useState(job.copies);
  const [problem, setProblem] = useState<string | null>(null);
  const begin = () => {
    setDraft(job.settings);
    setCopies(job.copies);
    setProblem(null);
    setOpen(true);
  };
  const save = async () => {
    setProblem(null);
    try {
      await editJob(job.id, { settings: job.plate_id ? { ...draft, orientation: 'as_uploaded' } : draft, copies });
      toast.success(t(jobWords.editSaved));
      setOpen(false);
      onChanged();
    } catch (e) {
      setProblem(cloudErrorText(e, lang));
    }
  };
  return (
    <section aria-labelledby="print-job-settings" className="lv-surface p-4">
      <SectionHeader
        id="print-job-settings"
        title={t(jobWords.settings)}
        action={
          allows.edit ? (
            <Button size="sm" variant="ghost" icon={<SlidersHorizontal aria-hidden="true" className="h-4 w-4" />} onClick={begin}>
              {t(jobWords.edit)}
            </Button>
          ) : undefined
        }
      />
      <dl className="mt-1 grid gap-x-6 sm:grid-cols-2">
        {settingsSummary(job.settings, job.copies, t, lang).map(([label, value]) => (
          <Fact key={label} label={label}>
            {value}
          </Fact>
        ))}
      </dl>
      {job.settings.notes ? <p className="mt-2 whitespace-pre-line text-[12px] text-text-secondary">{job.settings.notes}</p> : null}
      <Sheet
        open={open}
        onClose={() => setOpen(false)}
        labelledBy="print-edit-title"
        detents={['large']}
        panelClassName="w-full sm:max-w-lg"
        header={
          <div className="px-5 pb-2 pt-1">
            <h2 id="print-edit-title" className="text-[16px] font-bold text-text-primary">
              {t(jobWords.edit)}
            </h2>
          </div>
        }
        footer={
          <div className="flex flex-col-reverse gap-2 px-5 py-3 sm:flex-row sm:justify-end">
            <Button variant="secondary" onClick={() => setOpen(false)}>
              {t(common.close)}
            </Button>
            <Button variant="primary" onClick={save}>
              {t(print.save)}
            </Button>
          </div>
        }
      >
        <div className="space-y-3 px-5 pb-6 pt-1">
          <p className="lv-alert lv-alert-info text-[13px] leading-relaxed text-text-primary">{t(jobWords.editBody)}</p>
          {problem ? <p className="lv-field-error">{problem}</p> : null}
          <SettingsFields
            group="print-edit"
            value={draft}
            onChange={setDraft}
            nozzles={model?.nozzle_options_um ?? []}
            plateChosen={!!job.plate_id}
            copies={{ value: copies, onChange: setCopies }}
          />
        </div>
      </Sheet>
    </section>
  );
}

// ------------------------------------------------------------------ asking the workshop

function RequestsCard({ job }: { job: JobView }) {
  const { t, lang } = useCloudText();
  const allows = jobAllows(job.status);
  const [action, setAction] = useState<'pause' | 'cancel' | 'note' | null>(null);
  const [message, setMessage] = useState('');
  const [problem, setProblem] = useState<string | null>(null);
  if (!allows.askPause && !allows.askStop && !allows.note) return null;
  const send = async () => {
    if (!action) return;
    setProblem(null);
    try {
      await sendJobRequest(job.id, action, message.trim() || undefined);
      toast.success(t(jobWords.recorded));
      setAction(null);
      setMessage('');
    } catch (e) {
      setProblem(cloudErrorText(e, lang));
    }
  };
  const title = action === 'pause' ? jobWords.askPause : action === 'cancel' ? jobWords.askStop : jobWords.sendNote;
  return (
    <section aria-labelledby="print-job-requests" className="lv-surface space-y-2 p-4">
      <SectionHeader id="print-job-requests" title={t(jobWords.requests)} />
      <p className="text-[12px] leading-relaxed text-text-muted">{t(jobWords.requestsNote)}</p>
      {job.status === 'failed' ? <p className="text-[12px] leading-relaxed text-text-secondary">{t(jobWords.reprintAsk)}</p> : null}
      <div className="flex flex-wrap gap-2">
        {allows.askPause ? (
          <Button size="sm" variant="secondary" icon={<Pause aria-hidden="true" className="h-4 w-4" />} onClick={() => setAction('pause')}>
            {t(jobWords.askPause)}
          </Button>
        ) : null}
        {allows.askStop ? (
          <Button size="sm" variant="secondary" icon={<CircleX aria-hidden="true" className="h-4 w-4" />} onClick={() => setAction('cancel')}>
            {t(jobWords.askStop)}
          </Button>
        ) : null}
        {allows.note ? (
          <Button size="sm" variant="ghost" icon={<MessageSquare aria-hidden="true" className="h-4 w-4" />} onClick={() => setAction('note')}>
            {t(jobWords.sendNote)}
          </Button>
        ) : null}
      </div>
      <Sheet
        open={action !== null}
        onClose={() => setAction(null)}
        labelledBy="print-request-title"
        panelClassName="w-full sm:max-w-md"
        header={
          <div className="px-5 pb-2 pt-1">
            <h2 id="print-request-title" className="text-[16px] font-bold text-text-primary">
              {t(title)}
            </h2>
          </div>
        }
      >
        <form
          className="space-y-3 px-5 pb-6 pt-1"
          onSubmit={(e) => {
            e.preventDefault();
            void send();
          }}
        >
          <p className="text-[12px] leading-relaxed text-text-muted">{t(jobWords.requestsNote)}</p>
          <Field label={t(jobWords.message)} optional={action !== 'note'} error={problem}>
            <Textarea rows={3} maxLength={500} value={message} onChange={(e) => setMessage(e.target.value)} />
          </Field>
          <Button type="submit" variant="primary" disabled={action === 'note' && !message.trim()}>
            {t(print.send)}
          </Button>
        </form>
      </Sheet>
    </section>
  );
}

// ------------------------------------------------------------------ the timeline

function Timeline({ job }: { job: JobView }) {
  const { t, lang } = useCloudText();
  if (!job.events.length) return null;
  const events = [...job.events].reverse();
  return (
    <section aria-labelledby="print-job-timeline" className="lv-surface p-4">
      <SectionHeader id="print-job-timeline" title={t(jobWords.timeline)} count={events.length} />
      <ol className="mt-2 divide-y divide-border-subtle">
        {events.map((e, i) => {
          const note = e.event === 'customer_request' && typeof e.detail?.message === 'string' ? e.detail.message : null;
          return (
            <li key={`${e.created_at}-${i}`} className="space-y-0.5 py-2">
              <p className="flex items-start justify-between gap-3 text-[13px]">
                <span className="min-w-0 font-semibold text-text-primary">{eventText(e, lang)}</span>
                <span className="shrink-0 text-[12px] text-text-muted">{formatDateTime(e.created_at, lang)}</span>
              </p>
              <p className="text-[12px] text-text-muted">{t(jobWords.by, { actor: actorText(e.actor_type, lang) })}</p>
              {note ? <p className="text-[12px] text-text-secondary">«{note}»</p> : null}
            </li>
          );
        })}
      </ol>
    </section>
  );
}

// ------------------------------------------------------------------ the page

export default function JobDetail() {
  const { t, lang } = useCloudText();
  const location = useLocation();
  const cloud = useCloud();
  const { id = '' } = useParams();
  const q = useCloudQuery((signal) => getJob(id, { signal }), [id]);
  const printers = usePrinterModels();
  const names = useVariantNames();
  usePoll(q.reload, !!q.data && jobPollMs(q.data.status) !== null, q.data ? jobPollMs(q.data.status) : null);
  const [confirming, setConfirming] = useState(false);
  const [cancelling, setCancelling] = useState(false);
  const [cancelError, setCancelError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<unknown>(null);

  if (q.error && !q.data) return <CloudErrorState error={q.error} onRetry={q.reload} />;
  const job = q.data;
  if (!job) return <CloudPageSkeleton />;

  const model = printers.byId.get(job.printer_model_id);
  const allows = jobAllows(job.status);
  const state = jobStateText(job.status, lang);
  const problem = jobStep(job.status) === 'estimate' ? lastAnalysisProblem(job.events) : null;
  const handedOver = (location.state as { analyzeError?: unknown } | null)?.analyzeError;
  const analyzeError = typeof handedOver === 'string' && (job.status === 'draft' || job.status === 'uploaded') ? handedOver : null;
  const showProjection = !!job.estimate && (job.status === 'ready' || job.status === 'awaiting_confirmation');
  const onFloor = job.status === 'preparing' || job.status === 'printing' || job.status === 'paused';

  const analyze = async () => {
    setActionError(null);
    try {
      const r = await requestJobAnalysis(job.id);
      toast.info(r.slicer === 'queued' ? t(jobWords.analyzeSent) : t(jobWords.analyzeWaiting));
      q.reload();
    } catch (e) {
      setActionError(e);
    }
  };
  const cancel = async () => {
    setCancelError(null);
    try {
      await cancelJob(job.id);
      setCancelling(false);
      toast.success(t(jobWords.cancelled));
      cloud.refreshDashboard();
      q.reload();
    } catch (e) {
      setCancelError(cloudErrorText(e, lang));
    }
  };

  return (
    <div className="space-y-4">
      <PageHeader
        back={{ to: '/jobs', label: t(print.myPrints) }}
        title={job.title.trim() || t(print.untitled)}
        subtitle={[model ? t(jobWords.onModel, { printer: printerName(model) }) : null, t(print.created, { when: formatRelative(job.created_at, lang) })]
          .filter(Boolean)
          .join(' · ')}
      />
      <RefreshNote error={q.data && q.error ? q.error : null} onRetry={q.reload} />

      <section aria-labelledby="print-job-state" className="lv-surface space-y-3 p-4">
        <div className="flex flex-wrap items-center gap-2">
          <h2 id="print-job-state" className="sr-only">
            {state.title}
          </h2>
          <StatusPill kind="job" state={jobPillState(job.status)} />
          {job.printer && onFloor ? <StatusPill kind="printer" state={telemetryDisplay(job.telemetry).kind === 'live' ? 'live' : machinePillState(job.telemetry)} /> : null}
        </div>
        <p className="text-[13px] leading-relaxed text-text-secondary">{state.body}</p>
        <Stepper job={job} />
        {analyzeError ? <p className="lv-alert lv-alert-warning text-[13px] text-text-primary">{t(configure.analyzeLater, { reason: analyzeError })}</p> : null}
        {problem ? (
          <div className="lv-alert lv-alert-warning space-y-1 text-[13px] text-text-primary">
            <p>{problem.kind === 'failed' ? t(jobWords.lastAnalysisFailed, { code: problem.code || '—' }) : t(jobWords.lastIncompatible)}</p>
            {problem.kind === 'incompatible' && problem.warnings.length ? (
              <ul className="list-disc ps-5 text-[12px]">
                {problem.warnings.map((w) => (
                  <li key={w}>
                    <bdi>{w}</bdi>
                  </li>
                ))}
              </ul>
            ) : null}
          </div>
        ) : null}
        {job.parent_job_id ? (
          <p className="text-[12px] text-text-muted">
            {t(jobWords.reprintOf)}{' '}
            <Link to={`/jobs/${encodeURIComponent(job.parent_job_id)}`} className="font-semibold text-text-secondary underline underline-offset-2">
              {t(jobWords.openOriginal)}
            </Link>
          </p>
        ) : null}
        {actionError ? <CloudErrorState compact error={actionError} /> : null}
        <div className="flex flex-wrap gap-2">
          {allows.analyze ? (
            <Button variant="primary" icon={<Disc3 aria-hidden="true" className="h-4 w-4" />} onClick={analyze}>
              {t(jobWords.analyze)}
            </Button>
          ) : null}
          {allows.review && job.estimate ? (
            <Button variant="primary" icon={<Check aria-hidden="true" className="h-4 w-4" />} onClick={() => setConfirming(true)}>
              {job.status === 'awaiting_confirmation' ? t(jobWords.confirm) : t(jobWords.review)}
            </Button>
          ) : null}
          {job.status === 'completed' || job.status === 'cancelled' ? (
            <Link to={`/projects/${encodeURIComponent(job.project_id)}/print`} className="lv-button lv-button-secondary">
              {t(print.printAgain)}
            </Link>
          ) : null}
          <Link to={`/projects/${encodeURIComponent(job.project_id)}`} className="lv-button lv-button-ghost">
            <Boxes aria-hidden="true" className="h-4 w-4" />
            {t(jobWords.openProject)}
          </Link>
        </div>
      </section>

      <EstimateCard job={job} />
      {showProjection ? <ProjectionCard job={job} names={names} model={model} /> : null}
      {job.status === 'queued' ? <QueueCard job={job} onChanged={q.reload} /> : null}
      {onFloor ? <PrinterCard job={job} /> : null}
      <ResultCard job={job} />
      <FailureCard job={job} />
      <ReservationsCard job={job} names={names} />
      <SettingsCard job={job} model={model} onChanged={q.reload} />
      <RequestsCard job={job} />
      <Timeline job={job} />

      {allows.cancel ? (
        <div className="flex justify-center">
          <Button variant="danger" size="sm" icon={<X aria-hidden="true" className="h-4 w-4" />} onClick={() => setCancelling(true)}>
            {t(jobWords.cancel)}
          </Button>
        </div>
      ) : null}

      <ConfirmSheet
        job={job}
        open={confirming}
        onClose={() => {
          setConfirming(false);
          q.reload();
        }}
        onDone={() => {
          setConfirming(false);
          q.reload();
        }}
        names={names}
        model={model}
      />
      <ConfirmDialog
        open={cancelling}
        destructive
        title={t(jobWords.cancelQ)}
        consequence={t(jobWords.cancelBody)}
        confirmLabel={t(jobWords.cancel)}
        cancelLabel={t(jobWords.keep)}
        error={cancelError}
        onConfirm={cancel}
        onCancel={() => {
          setCancelling(false);
          setCancelError(null);
        }}
      />
    </div>
  );
}
