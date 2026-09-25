/**
 * JOBS — customer offers to accept or reject, and the jobs already taken.
 *
 * An offer card shows the customer's terms exactly as the server states them:
 * reward, reputation gain, the late and cancel penalties, the deadline and the
 * offer's own expiry. Urgency is the room between now and the deadline against
 * the print time the server quoted. Accepting opens the allocation sheet;
 * nothing prints until the server has taken the allocation.
 */
import React, { useId, useRef, useState } from 'react';
import { CalendarClock, ClipboardList, Clock, Coins, Star } from 'lucide-react';
import { EmptyState } from '../../../components/ui/AsyncStates';
import { colorNameOf, farmApi, productByKey, reputationGainBp, type FarmJob, type FarmState } from '../../../lib/farmApi';
import type { FarmStrings } from '../strings';
import {
  countdown,
  formatCoins,
  gameDuration,
  jobStateLabel,
  localName,
  ms,
  nameOf,
  realSecondsFor,
  starsDelta,
  swatchFor,
  tierLabel,
} from '../format';
import { offerUrgency, remainingQty } from '../rules';
import { Chip, ProgressBar, SectionTitle, Swatch } from '../bits';
import { BTN_DANGER, BTN_PRIMARY, BTN_SECONDARY, JOB_CHIP, PANEL, URGENCY_CHIP } from '../ui';
import { Window, WINDOW_BODY } from '../sheets/Window';
import type { RunResult } from '../hooks/useFarmState';

export interface JobsViewProps {
  state: FarmState;
  now: number;
  lang: string;
  s: FarmStrings;
  busy: string | null;
  run: (actionId: string, call: (key: string) => Promise<unknown>) => Promise<RunResult>;
  onError: (err: unknown) => void;
  /** Open the allocation sheet for a job (after accepting, or for remaining parts). */
  onAssign: (jobId: string, anchor: HTMLElement | null) => void;
}

export default function JobsView({ state, now, lang, s, busy, run, onError, onAssign }: JobsViewProps) {
  const offered = state.jobs.offered;
  const active = state.jobs.active;
  const timeScale = state.config.time?.time_scale ?? 1;

  const act = async (id: string, call: (key: string) => Promise<unknown>) => {
    const r = await run(id, call);
    if (r.ok === false) onError(r.error);
    return r.ok;
  };

  return (
    <div className="space-y-6">
      <section className="space-y-3" aria-labelledby="farm-offers-title">
        <SectionTitle id="farm-offers-title" title={s.offers} count={offered.length} />
        {offered.length === 0 ? (
          <EmptyState compact icon={<ClipboardList aria-hidden="true" className="w-6 h-6" />} title={s.noOffers} description={s.noOffersDesc} />
        ) : (
          offered.map((job) => (
            <OfferCard
              key={job.id}
              job={job}
              state={state}
              now={now}
              lang={lang}
              s={s}
              timeScale={timeScale}
              disabled={busy !== null}
              onAccept={async (anchor) => {
                const ok = await act(`accept:${job.id}`, (k) => farmApi.acceptJob(job.id, k));
                if (ok) onAssign(job.id, anchor);
              }}
              onReject={() => act(`reject:${job.id}`, (k) => farmApi.rejectJob(job.id, k))}
            />
          ))
        )}
      </section>

      <section className="space-y-3" aria-labelledby="farm-active-title">
        <SectionTitle
          id="farm-active-title"
          title={s.activeJobs}
          count={typeof state.limits?.max_active_jobs === 'number' ? s.activeOfMax(active.length, state.limits.max_active_jobs) : active.length}
        />
        {active.length === 0 ? (
          <EmptyState compact icon={<Clock aria-hidden="true" className="w-6 h-6" />} title={s.noActive} description={s.noActiveDesc} />
        ) : (
          active.map((job) => (
            <ActiveCard
              key={job.id}
              job={job}
              state={state}
              now={now}
              lang={lang}
              s={s}
              disabled={busy !== null}
              onAssign={(anchor) => onAssign(job.id, anchor)}
              onCancel={() => act(`cancel:${job.id}`, (k) => farmApi.cancelJob(job.id, k))}
            />
          ))
        )}
      </section>
    </div>
  );
}

// ------------------------------------------------------------------ pieces

function Terms({ job, s, lang }: { job: FarmJob; s: FarmStrings; lang: string }) {
  return (
    <ul className="flex flex-wrap gap-x-3 gap-y-1 text-[11.5px] text-zinc-400">
      <li className="inline-flex items-center gap-1 text-gold font-bold">
        <Coins aria-hidden="true" className="w-3.5 h-3.5" />
        <span className="tabular-nums" dir="ltr">
          {formatCoins(job.reward_coins, lang)}
        </span>
      </li>
      <li className="inline-flex items-center gap-1 text-sage">
        <Star aria-hidden="true" className="w-3.5 h-3.5" />
        <span className="tabular-nums">{s.reputationGain(starsDelta(reputationGainBp(job)))}</span>
      </li>
      {job.late_penalty_bp > 0 && <li className="tabular-nums text-honey">{s.latePenalty(starsDelta(job.late_penalty_bp))}</li>}
      {job.cancel_penalty_bp > 0 && <li className="tabular-nums">{s.cancelPenaltyBp(starsDelta(job.cancel_penalty_bp))}</li>}
      {job.cancel_penalty_coins > 0 && <li className="tabular-nums">{s.cancelPenaltyCoins(formatCoins(job.cancel_penalty_coins, lang))}</li>}
    </ul>
  );
}

function Spec({ job, state, s, lang }: { job: FarmJob; state: FarmState; s: FarmStrings; lang: string }) {
  const product = productByKey(state.config, job.product_key);
  const name = localName(product, lang, nameOf(job.title, lang));
  const colorLabels = job.colors.map((c) => nameOf(colorNameOf(state.config, c), lang, c));
  return (
    <div className="space-y-1">
      <p className="text-[13px] text-zinc-200 font-bold">{s.qtyProduct(job.qty, name)}</p>
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-[11.5px] text-zinc-400">
        <span className="font-semibold text-zinc-300" dir="ltr">
          {job.material}
        </span>
        <span className="inline-flex items-center gap-1" aria-label={`${s.colors}: ${colorLabels.join(', ')}`}>
          {job.colors.map((c) => (
            <Swatch key={c} color={swatchFor(state.config, c)} />
          ))}
          <span>{colorLabels.join(' · ')}</span>
        </span>
        <span className="tabular-nums" dir="ltr">
          {s.grams(job.grams)}
        </span>
      </div>
    </div>
  );
}

function OfferCard({
  job,
  state,
  now,
  lang,
  s,
  timeScale,
  disabled,
  onAccept,
  onReject,
}: {
  job: FarmJob;
  state: FarmState;
  now: number;
  lang: string;
  s: FarmStrings;
  timeScale: number;
  disabled: boolean;
  onAccept: (anchor: HTMLElement | null) => void;
  onReject: () => void;
}) {
  const urgency = offerUrgency(job, now, timeScale);
  const urgencyLabel = urgency === 'urgent' ? s.urgencyUrgent : urgency === 'tight' ? s.urgencyTight : s.urgencyRelaxed;
  const expires = ms(job.offer_expires_at);
  const deadline = ms(job.deadline_at);
  const expired = expires !== null && expires <= now;
  const realLabel = gameDuration(Math.max(60, realSecondsFor(job.print_seconds, timeScale)), lang);
  const acceptRef = useRef<HTMLButtonElement | null>(null);

  return (
    <article className={`${PANEL} p-4 space-y-3`} data-farm-offer={job.id} data-farm-urgency={urgency}>
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <h3 className="text-white font-bold text-[14px] truncate">{nameOf(job.customer_name, lang)}</h3>
          <p className="text-[11px] text-zinc-500">{tierLabel(job.customer_tier, s)}</p>
        </div>
        <Chip className={URGENCY_CHIP[urgency]}>{urgencyLabel}</Chip>
      </div>

      <Spec job={job} state={state} s={s} lang={lang} />

      {/* Durations carry a unit letter in the UI language, so these cells
          inherit the page direction; each number+unit token is bidi-isolated
          by format.ts and needs no dir="ltr" (which reordered them). */}
      <dl className="grid grid-cols-2 gap-x-3 gap-y-1 text-[11.5px]">
        <div>
          <dt className="text-zinc-500">{s.printTime}</dt>
          <dd className="text-zinc-200 font-bold tabular-nums" data-farm-duration="print">
            {gameDuration(job.print_seconds, lang)}
            <span className="text-zinc-500 font-medium"> · {s.realTime(realLabel)}</span>
          </dd>
        </div>
        <div>
          <dt className="text-zinc-500">{s.deadline}</dt>
          <dd className="text-zinc-200 font-bold tabular-nums" data-farm-duration="deadline">
            {deadline === null ? '—' : deadline <= now ? s.deadlinePassed : countdown(deadline - now, lang)}
          </dd>
        </div>
      </dl>

      <Terms job={job} s={s} lang={lang} />

      <div className="flex items-center justify-between gap-3 pt-1">
        <span className={`text-[11px] tabular-nums ${expired ? 'text-coral' : 'text-zinc-500'}`}>
          {expires === null ? '' : expired ? s.offerExpired : s.offerExpiresIn(countdown(expires - now, lang))}
        </span>
        <div className="flex items-center gap-2">
          <button type="button" disabled={disabled} onClick={onReject} className={BTN_SECONDARY} data-farm-action="reject">
            {s.reject}
          </button>
          <button
            ref={acceptRef}
            type="button"
            disabled={disabled || expired}
            onClick={() => onAccept(acceptRef.current)}
            className={BTN_PRIMARY}
            data-farm-action="accept"
          >
            {s.accept}
          </button>
        </div>
      </div>
    </article>
  );
}

function ActiveCard({
  job,
  state,
  now,
  lang,
  s,
  disabled,
  onAssign,
  onCancel,
}: {
  job: FarmJob;
  state: FarmState;
  now: number;
  lang: string;
  s: FarmStrings;
  disabled: boolean;
  onAssign: (anchor: HTMLElement | null) => void;
  onCancel: () => Promise<boolean>;
}) {
  const deadline = ms(job.deadline_at);
  const remaining = remainingQty(job);
  const summary = job.assignments_summary;
  const assigned = typeof summary?.assigned === 'number' ? summary.assigned : null;
  const finished = (summary?.done ?? 0) + (summary?.collected ?? 0);
  const printersOn = state.printers.filter((p) => p.current?.job_id === job.id || p.queue.some((q) => q.job_id === job.id)).length;
  const [confirm, setConfirm] = useState(false);
  const [cancelling, setCancelling] = useState(false);
  const cancelRef = useRef<HTMLButtonElement | null>(null);
  const assignRef = useRef<HTMLButtonElement | null>(null);
  const titleId = useId();
  const canCancel = job.state === 'accepted' || job.state === 'printing';

  return (
    <article className={`${PANEL} p-4 space-y-3`} data-farm-job={job.id} data-farm-job-state={job.state}>
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <h3 className="text-white font-bold text-[14px] truncate">{nameOf(job.title, lang)}</h3>
          <p className="text-[11px] text-zinc-500 truncate">
            {nameOf(job.customer_name, lang)} · {tierLabel(job.customer_tier, s)}
          </p>
        </div>
        <div className="flex flex-wrap items-center justify-end gap-1 shrink-0">
          <Chip className={JOB_CHIP[job.state] ?? JOB_CHIP.accepted}>{jobStateLabel(job.state, s)}</Chip>
          {/* Every part handed over, coins held by today's cap: paid on a later day (§9a). */}
          {job.payout_deferred_day && (
            <Chip className={JOB_CHIP.late} data-farm-payout-pending={job.id}>
              <CalendarClock aria-hidden="true" className="w-3 h-3" />
              {s.payoutPending}
            </Chip>
          )}
        </div>
      </div>

      <Spec job={job} state={state} s={s} lang={lang} />
      {job.payout_deferred_day && <p className="text-[11.5px] text-honey">{s.payoutPendingBody}</p>}

      <div className="space-y-1">
        <div className="flex items-baseline justify-between gap-3 text-[11.5px]">
          <span className="text-zinc-400 tabular-nums">
            {assigned !== null ? s.assignedOf(assigned, job.qty) : ''}
            {printersOn > 0 && <span className="text-zinc-500"> · {s.printingOn(printersOn)}</span>}
          </span>
          <span className={`font-bold tabular-nums ${deadline !== null && deadline <= now ? 'text-honey' : 'text-zinc-200'}`} data-farm-duration="deadline">
            {deadline === null ? '' : deadline <= now ? s.deadlinePassed : s.deadlineIn(countdown(deadline - now, lang))}
          </span>
        </div>
        {summary && job.qty > 0 && <ProgressBar fraction={finished / job.qty} tone="good" label={s.progress} />}
      </div>

      <Terms job={job} s={s} lang={lang} />

      <div className="flex items-center gap-2 pt-1">
        {remaining > 0 && (
          <button ref={assignRef} type="button" disabled={disabled} onClick={() => onAssign(assignRef.current)} className={BTN_PRIMARY} data-farm-action="assign-job">
            {s.assign}
            <span className="tabular-nums text-black/70" dir="ltr">
              {remaining}
            </span>
          </button>
        )}
        {remaining > 0 && <span className="text-[11px] text-honey">{s.unassigned(remaining)}</span>}
        {canCancel && (
          <button ref={cancelRef} type="button" disabled={disabled} onClick={() => setConfirm(true)} className={`${BTN_SECONDARY} ms-auto`} data-farm-action="cancel-job">
            {s.cancelJob}
          </button>
        )}
      </div>

      <Window open={confirm} onClose={() => setConfirm(false)} label={s.cancelJobTitle} labelledBy={titleId} busy={cancelling} anchor={cancelRef} testId="farm-cancel-job">
        <div className={WINDOW_BODY}>
          <h3 id={titleId} className="text-white font-bold text-[16px]">
            {s.cancelJobTitle}
          </h3>
          <p className="text-[13px] text-zinc-300 leading-relaxed">{s.cancelJobBody}</p>
          <Terms job={job} s={s} lang={lang} />
          <div className="flex items-center justify-end gap-2 pt-1">
            <button type="button" disabled={cancelling} onClick={() => setConfirm(false)} className={BTN_SECONDARY}>
              {s.keepJob}
            </button>
            <button
              type="button"
              disabled={cancelling}
              onClick={async () => {
                setCancelling(true);
                const ok = await onCancel();
                setCancelling(false);
                if (ok) setConfirm(false);
              }}
              className={BTN_DANGER}
            >
              {s.cancelJob}
            </button>
          </div>
        </div>
      </Window>
    </article>
  );
}
