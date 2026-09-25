/**
 * FARM — the room and one card per machine.
 *
 * Every figure on a card is a server field or the difference between two
 * server timestamps: progress is (now − started_at) / (ends_at − started_at),
 * the countdown is ends_at − now, health is `health`. The primary action is
 * chosen from the printer's state; the server decides whether it succeeds.
 */
import React from 'react';
import { ArrowRight, ArrowLeft, Sparkles } from 'lucide-react';
import type { FarmPrinter, FarmState } from '../../../lib/farmApi';
import { batchEnded, farmApi, printerModel } from '../../../lib/farmApi';
import Room from '../room/Room';
import type { FarmStrings } from '../strings';
import { countdown, formatInt, ms, nameOf, printerName, printerStateLabel, progressFraction } from '../format';
import { Chip, HealthBar, ProgressBar, SectionTitle } from '../bits';
import { BTN_PRIMARY, BTN_SECONDARY, PANEL, STATE_CHIP } from '../ui';
import type { RunResult } from '../hooks/useFarmState';

export interface FarmViewProps {
  state: FarmState;
  now: number;
  lang: string;
  dir: 'ltr' | 'rtl';
  s: FarmStrings;
  busy: string | null;
  run: (actionId: string, call: (key: string) => Promise<unknown>) => Promise<RunResult>;
  onError: (err: unknown) => void;
  /** The collect answer (state + `collected`/`delivered`/`payout_deferred`), for the shell's notice. */
  onCollected: (res: unknown) => void;
  onOpenPrinter: (printer: FarmPrinter, anchor: HTMLElement | null) => void;
  onOpenEmptySlot: (slot: number, anchor: HTMLElement | null) => void;
  onGoJobs: () => void;
  showIntro: boolean;
  /** Health below which the card recommends maintenance (from the config). */
  maintenanceThreshold: number;
}

export default function FarmView({
  state,
  now,
  lang,
  dir,
  s,
  busy,
  run,
  onError,
  onCollected,
  onOpenPrinter,
  onOpenEmptySlot,
  onGoJobs,
  showIntro,
  maintenanceThreshold,
}: FarmViewProps) {
  const printers = [...state.printers].sort((a, b) => a.slot - b.slot);
  const Forward = dir === 'rtl' ? ArrowLeft : ArrowRight;

  const act = async (id: string, call: (key: string) => Promise<unknown>) => {
    const r = await run(id, call);
    if (r.ok === false) onError(r.error);
    return r;
  };

  return (
    <div className="space-y-5">
      <section className={`${PANEL} overflow-hidden`} aria-label={s.roomLabel}>
        <div className="px-3 pt-3">
          <Room
            printers={printers}
            spools={state.spools}
            config={state.config}
            maxPrinters={state.profile.location.max_printers}
            now={now}
            lang={lang}
            s={s}
            onOpenPrinter={onOpenPrinter}
            onOpenEmptySlot={onOpenEmptySlot}
          />
        </div>
        <div className="flex items-center justify-between gap-3 px-4 py-2.5 border-t border-zinc-800/70 text-[11px] text-zinc-500">
          <span>{s.roomDesc(printers.length, state.profile.location.max_printers)}</span>
          <span className="tabular-nums" dir="ltr">
            {s.spoolsOnShelf(state.spools.length)}
          </span>
        </div>
      </section>

      {showIntro && (
        <section className={`${PANEL} p-4 space-y-3 border-gold/30`} data-farm-intro aria-labelledby="farm-intro-title">
          <h2 id="farm-intro-title" className="flex items-center gap-2 text-white font-bold text-[15px]">
            <Sparkles aria-hidden="true" className="w-4 h-4 text-gold" />
            {s.title}
          </h2>
          <ol className="space-y-1.5 text-[13px] text-zinc-300 leading-relaxed list-none">
            <li>{s.introLine1}</li>
            <li>{s.introLine2}</li>
            <li>{s.introLine3}</li>
          </ol>
          <button type="button" onClick={onGoJobs} className={`${BTN_PRIMARY} w-full`} data-farm-first-job>
            {s.takeFirstJob}
            <Forward aria-hidden="true" className="w-4 h-4" />
          </button>
        </section>
      )}

      <section className="space-y-3" aria-labelledby="farm-machines-title">
        <SectionTitle id="farm-machines-title" title={s.machines} count={printers.length} />
        {printers.length === 0 && <p className="text-[13px] text-zinc-500">{s.noPrinters}</p>}
        {printers.map((p) => (
          <MachineCard
            key={p.id}
            printer={p}
            state={state}
            now={now}
            lang={lang}
            s={s}
            busy={busy}
            act={act}
            onCollected={onCollected}
            onOpen={onOpenPrinter}
            onGoJobs={onGoJobs}
            maintenanceThreshold={maintenanceThreshold}
          />
        ))}
      </section>
    </div>
  );
}

function MachineCard({
  printer: p,
  state,
  now,
  lang,
  s,
  busy,
  act,
  onCollected,
  onOpen,
  onGoJobs,
  maintenanceThreshold,
}: {
  printer: FarmPrinter;
  state: FarmState;
  now: number;
  lang: string;
  s: FarmStrings;
  busy: string | null;
  act: (id: string, call: (key: string) => Promise<unknown>) => Promise<RunResult>;
  onCollected: (res: unknown) => void;
  onOpen: (printer: FarmPrinter, anchor: HTMLElement | null) => void;
  onGoJobs: () => void;
  maintenanceThreshold: number;
}) {
  const model = printerModel(state.config, p.model_key);
  const recommend = state.unlocks.maintenance && p.health < maintenanceThreshold && p.state !== 'maintenance';
  const anyBusy = busy !== null;
  const current = p.current;
  const ended = batchEnded(p);
  const failedBatch = ended && current?.state === 'failed';

  let timeline: React.ReactNode = null;
  if (failedBatch && current) {
    timeline = (
      <div className="text-[12px] text-coral font-bold">
        {s.batchFailed(current.failure_kind ? s.failureKinds[current.failure_kind] ?? current.failure_kind : s.failures)}
      </div>
    );
  } else if (p.state === 'printing' && current) {
    const end = ms(current.ends_at);
    const frac = progressFraction(current.started_at, current.ends_at, now);
    timeline = (
      <div className="space-y-1">
        <div className="flex items-baseline justify-between gap-3 text-[12px]">
          <span className="text-zinc-300 truncate">
            <span className="tabular-nums" dir="ltr">
              {current.qty}×
            </span>{' '}
            {nameOf(current.title, lang)}
          </span>
          <span className="text-gold font-bold tabular-nums shrink-0" data-farm-duration="countdown">
            {end === null ? '' : countdown(end - now, lang)}
          </span>
        </div>
        <ProgressBar fraction={frac} label={s.progress} />
      </div>
    );
  } else if (p.state === 'maintenance') {
    const end = ms(p.state_until);
    timeline = (
      <div className="flex items-baseline justify-between gap-3 text-[12px]">
        <span className="text-honey">{s.underMaintenance}</span>
        <span className="text-honey font-bold tabular-nums" data-farm-duration="countdown">
          {end === null ? '' : countdown(end - now, lang)}
        </span>
      </div>
    );
  } else if (p.state === 'done' && current) {
    timeline = (
      <div className="flex items-baseline justify-between gap-3 text-[12px]">
        <span className="text-zinc-300 truncate">
          <span className="tabular-nums" dir="ltr">
            {current.qty}×
          </span>{' '}
          {nameOf(current.title, lang)}
        </span>
        <span className="text-sage font-bold shrink-0">{s.readyToCollect}</span>
      </div>
    );
  } else if (p.state === 'broken') {
    timeline = <div className="text-[12px] text-coral font-bold">{s.awaitingRepair}</div>;
  }

  // The one primary action a machine offers from the card.
  let primary: React.ReactNode = null;
  if (ended) {
    primary = (
      <button
        type="button"
        disabled={anyBusy}
        onClick={async () => {
          const r = await act(`collect:${p.id}`, (k) => farmApi.collect(p.id, k));
          if (r.ok) onCollected(r.result);
        }}
        className={BTN_PRIMARY}
        data-farm-action="collect"
      >
        {s.collect}
      </button>
    );
  } else if (p.state === 'broken') {
    primary = (
      <button type="button" disabled={anyBusy} onClick={() => act(`repair:${p.id}`, (k) => farmApi.repair(p.id, k))} className={BTN_PRIMARY} data-farm-action="repair">
        {s.repair}
      </button>
    );
  } else if (p.state === 'idle' && recommend) {
    primary = (
      <button type="button" disabled={anyBusy} onClick={() => act(`maintain:${p.id}`, (k) => farmApi.maintain(p.id, k))} className={BTN_PRIMARY} data-farm-action="maintain">
        {s.maintain}
      </button>
    );
  } else if (p.state === 'idle') {
    primary = (
      <button type="button" onClick={onGoJobs} className={BTN_PRIMARY} data-farm-action="assign">
        {s.assignWork}
      </button>
    );
  }

  return (
    <article className={`${PANEL} p-4 space-y-3`} data-farm-machine={p.id} data-farm-machine-state={p.state}>
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <h3 className="text-white font-bold text-[14px] truncate">{printerName(p, state.config, lang)}</h3>
          <p className="text-[11px] text-zinc-500 truncate" dir="ltr">
            {nameOf(model?.name, lang, p.model_key)}
          </p>
        </div>
        <Chip className={STATE_CHIP[p.state] ?? STATE_CHIP.idle}>{printerStateLabel(p.state, s)}</Chip>
      </div>

      {timeline}

      <div className="space-y-1">
        <div className="flex items-baseline justify-between text-[11px]">
          <span className="text-zinc-500">{s.health}</span>
          <span className="text-zinc-300 tabular-nums" dir="ltr">
            {formatInt(p.health, lang)}%
          </span>
        </div>
        <HealthBar health={p.health} label={s.healthPct(Math.round(p.health))} />
        {recommend && <p className="text-[11px] text-honey">{s.maintenanceRecommended}</p>}
      </div>

      <div className="flex items-baseline justify-between gap-3 text-[11px]">
        <span className="text-zinc-500">{s.nextInQueue}</span>
        <span className="text-zinc-300 truncate">
          {p.queue.length > 0 ? (
            <>
              <span className="tabular-nums" dir="ltr">
                {p.queue[0].qty}×
              </span>{' '}
              {nameOf(p.queue[0].title, lang)}
              <span className="text-zinc-500"> · {s.queued(p.queue.length)}</span>
            </>
          ) : (
            s.queueEmpty
          )}
        </span>
      </div>

      <div className="flex items-center gap-2 pt-1">
        {primary}
        <button type="button" onClick={(e) => onOpen(p, e.currentTarget)} className={`${BTN_SECONDARY} ms-auto`} data-farm-action="details">
          {s.details}
        </button>
      </div>
    </article>
  );
}
