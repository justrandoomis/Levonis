/**
 * One machine, in full: state and countdown, health, the queue with up/down
 * reordering (buttons, not drag — Phase 1), Collect / Maintain / Repair with
 * their server-priced costs, Rename, and Sell behind a confirmation window.
 * The sheet renders the printer from the LATEST state (looked up by id), so a
 * collect or a reorder redraws it from the server's answer, never from a
 * local guess.
 */
import React, { useEffect, useId, useRef, useState } from 'react';
import { ArrowDown, ArrowUp, Pencil } from 'lucide-react';
import Spinner from '../../../components/ui/Spinner';
import { Overlay } from '../../../components/ui/Overlay';
import { batchEnded, farmApi, printerModel, unlockLevel, type FarmPrinter, type FarmState } from '../../../lib/farmApi';
import type { FarmStrings } from '../strings';
import { countdown, formatCoins, formatHours, formatInt, ms, nameOf, printerName, printerStateLabel, progressFraction } from '../format';
import { Chip, HealthBar, ProgressBar } from '../bits';
import CollectNote from '../CollectNote';
import type { CollectNotice } from '../collect';
import { BTN_DANGER, BTN_PRIMARY, BTN_SECONDARY, ICON_BTN, INPUT, ROW, STATE_CHIP } from '../ui';
import type { RunResult } from '../hooks/useFarmState';
import { Window, WINDOW_BODY } from './Window';

export default function PrinterSheet({
  open,
  printer: p,
  state,
  now,
  lang,
  s,
  busy,
  run,
  onClose,
  onError,
  onCollected,
  lastCollect,
  anchor,
  maintenanceThreshold,
}: {
  open: boolean;
  printer: FarmPrinter | null;
  state: FarmState;
  now: number;
  lang: string;
  s: FarmStrings;
  busy: string | null;
  run: (actionId: string, call: (key: string) => Promise<unknown>) => Promise<RunResult>;
  onClose: () => void;
  onError: (err: unknown) => void;
  /** The collect answer, for the shell's live notice. */
  onCollected: (res: unknown) => void;
  /** The shell's current collect notice; repeated here when it concerns this machine. */
  lastCollect: CollectNotice | null;
  anchor: React.RefObject<HTMLElement | null>;
  maintenanceThreshold: number;
}) {
  const titleId = useId();
  const sellTitleId = useId();
  const [renaming, setRenaming] = useState(false);
  const [nickname, setNickname] = useState('');
  const [sellOpen, setSellOpen] = useState(false);
  const sellBtn = useRef<HTMLButtonElement | null>(null);

  useEffect(() => {
    if (!open) {
      setRenaming(false);
      setSellOpen(false);
    }
  }, [open]);
  useEffect(() => {
    if (p) setNickname(p.nickname);
  }, [p?.id, p?.nickname, p]);

  const act = async (id: string, call: (key: string) => Promise<unknown>) => {
    const r = await run(id, call);
    if (r.ok === false) onError(r.error);
    return r.ok;
  };

  if (!p) return null;
  const config = state.config;
  const model = printerModel(config, p.model_key);
  const coins = state.profile.coins;
  const anyBusy = busy !== null;
  const maint = config.economy?.maintenance;
  const rep = config.economy?.repair;
  const maintenanceUnlocked = state.unlocks.maintenance;
  const maintLevel = unlockLevel(config, 'maintenance', state.unlock_levels);
  const canMaintain = maintenanceUnlocked && (p.state === 'idle' || p.state === 'done') && !!maint && maint.cost <= coins;
  const canRepair = p.state === 'broken' && !!rep && rep.cost <= coins;
  const canCollect = batchEnded(p);
  const failedBatch = canCollect && p.current?.state === 'failed';
  // The server sells only an idle machine with nothing on it and nothing queued.
  const canSell = p.state === 'idle' && !p.current && p.queue.length === 0;
  // The sale price is the server's `resale_coins` — the exact credit a sale
  // pays now. When an older row lacks it the figure is simply not shown;
  // money is never computed in the browser (the rounding would drift).
  const resale = typeof p.resale_coins === 'number' ? p.resale_coins : null;
  const recommend = maintenanceUnlocked && p.health < maintenanceThreshold && p.state !== 'maintenance';
  const displayName = printerName(p, config, lang);

  const reorder = async (index: number, dir: -1 | 1) => {
    const order = p.queue.map((q) => q.assignment_id);
    const j = index + dir;
    if (j < 0 || j >= order.length) return;
    [order[index], order[j]] = [order[j], order[index]];
    await act(`queue:${p.id}:${order.join(',')}`, (k) => farmApi.reorderQueue(p.id, order, k));
  };

  const current = p.current;
  const end = p.state === 'printing' && current ? ms(current.ends_at) : p.state === 'maintenance' ? ms(p.state_until) : null;

  return (
    <Window open={open} onClose={onClose} label={displayName} labelledBy={titleId} busy={anyBusy} anchor={anchor} testId="farm-printer-sheet">
      <div className={WINDOW_BODY}>
        {/* ------------------------------------------------------------ head */}
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0 flex-1">
            {renaming ? (
              <form
                className="flex items-center gap-2"
                onSubmit={async (e) => {
                  e.preventDefault();
                  const next = nickname.trim();
                  if (!next || next === p.nickname) {
                    setRenaming(false);
                    return;
                  }
                  const ok = await act(`rename:${p.id}`, (k) => farmApi.rename(p.id, next, k));
                  if (ok) setRenaming(false);
                }}
              >
                <label htmlFor={`${titleId}-name`} className="sr-only">
                  {s.renameLabel}
                </label>
                <input
                  id={`${titleId}-name`}
                  value={nickname}
                  onChange={(e) => setNickname(e.target.value)}
                  maxLength={40}
                  placeholder={s.renamePlaceholder}
                  className={`${INPUT} py-2`}
                  autoFocus
                />
                <button type="submit" disabled={anyBusy} className={BTN_PRIMARY}>
                  {s.save}
                </button>
              </form>
            ) : (
              <div className="flex items-center gap-2 min-w-0">
                <h3 id={titleId} className="text-white font-bold text-[16px] truncate">
                  {displayName}
                </h3>
                <button type="button" aria-label={s.rename} onClick={() => setRenaming(true)} className={`${ICON_BTN} shrink-0`}>
                  <Pencil aria-hidden="true" className="w-3.5 h-3.5" />
                </button>
              </div>
            )}
            <p className="text-[11px] text-zinc-500 truncate" dir="ltr">
              {nameOf(model?.name, lang, p.model_key)} · {s.slotN(p.slot + 1)}
            </p>
          </div>
          <Chip className={STATE_CHIP[p.state] ?? STATE_CHIP.idle}>{printerStateLabel(p.state, s)}</Chip>
        </div>

        {/* --------------------------------------------------- current print */}
        {current && (
          <div className={`${ROW} p-3 space-y-2`}>
            <p className="text-[11px] text-zinc-500">{s.currentPrint}</p>
            <div className="flex items-baseline justify-between gap-3 text-[12.5px]">
              <span className="text-zinc-100 truncate">
                <span className="tabular-nums" dir="ltr">
                  {current.qty}×
                </span>{' '}
                {nameOf(current.title, lang)}
              </span>
              {!canCollect && end !== null && (
                <span className="text-[#BAA369] font-bold tabular-nums shrink-0" data-farm-duration="countdown">
                  {countdown(end - now, lang)}
                </span>
              )}
              {canCollect && !failedBatch && <span className="text-[#A6B283] font-bold shrink-0">{s.readyToCollect}</span>}
            </div>
            {failedBatch && (
              <p className="text-[12px] text-[#E06070] font-bold">
                {s.batchFailed(current.failure_kind ? s.failureKinds[current.failure_kind] ?? current.failure_kind : s.failures)}
              </p>
            )}
            {!canCollect && p.state === 'printing' && <ProgressBar fraction={progressFraction(current.started_at, current.ends_at, now)} label={s.progress} />}
          </div>
        )}
        {p.state === 'maintenance' && (
          <div className={`${ROW} p-3 flex items-baseline justify-between gap-3 text-[12.5px]`}>
            <span className="text-[#E4B363]">{s.underMaintenance}</span>
            <span className="text-[#E4B363] font-bold tabular-nums" data-farm-duration="countdown">
              {end === null ? '' : countdown(end - now, lang)}
            </span>
          </div>
        )}

        {/* ------------------------------------------------------- health */}
        <div className="space-y-1">
          <div className="flex items-baseline justify-between text-[11px]">
            <span className="text-zinc-500">{s.health}</span>
            <span className="text-zinc-300 tabular-nums" dir="ltr">
              {formatInt(p.health, lang)}%
            </span>
          </div>
          <HealthBar health={p.health} label={s.healthPct(Math.round(p.health))} />
          {recommend && <p className="text-[11px] text-[#E4B363]">{s.maintenanceRecommended}</p>}
        </div>

        <dl className="grid grid-cols-3 gap-2 text-[11px]">
          <div>
            <dt className="text-zinc-500">{s.hours}</dt>
            <dd className="text-zinc-200 font-bold tabular-nums" dir="ltr">
              {formatHours(p.hours, lang)}
            </dd>
          </div>
          <div>
            <dt className="text-zinc-500">{s.prints}</dt>
            <dd className="text-zinc-200 font-bold tabular-nums" dir="ltr">
              {formatInt(p.prints, lang)}
            </dd>
          </div>
          <div>
            <dt className="text-zinc-500">{s.failures}</dt>
            <dd className="text-zinc-200 font-bold tabular-nums" dir="ltr">
              {formatInt(p.failures, lang)}
            </dd>
          </div>
        </dl>

        {/* -------------------------------------------------------- queue */}
        <div className="space-y-1.5">
          <p className="text-[11px] font-semibold text-zinc-500">
            {s.queueTitle} <span className="tabular-nums">({p.queue.length})</span>
          </p>
          {p.queue.length === 0 ? (
            <p className="text-[12px] text-zinc-500">{s.queueEmpty}</p>
          ) : (
            <ol className="space-y-1.5">
              {p.queue.map((q, i) => (
                <li key={q.assignment_id} className={`${ROW} px-3 py-2 flex items-center gap-2`} data-farm-queue-item={q.assignment_id}>
                  <span className="text-[11px] text-zinc-500 tabular-nums w-4" dir="ltr">
                    {i + 1}
                  </span>
                  <div className="min-w-0 flex-1">
                    <p className="text-[12.5px] text-zinc-100 truncate">
                      <span className="tabular-nums" dir="ltr">
                        {q.qty}×
                      </span>{' '}
                      {nameOf(q.title, lang)}
                    </p>
                  </div>
                  <button type="button" aria-label={s.moveUp} disabled={anyBusy || i === 0} onClick={() => reorder(i, -1)} className={ICON_BTN}>
                    <ArrowUp aria-hidden="true" className="w-4 h-4" />
                  </button>
                  <button type="button" aria-label={s.moveDown} disabled={anyBusy || i === p.queue.length - 1} onClick={() => reorder(i, 1)} className={ICON_BTN}>
                    <ArrowDown aria-hidden="true" className="w-4 h-4" />
                  </button>
                </li>
              ))}
            </ol>
          )}
        </div>

        {/* -------------------------------------------- the collect result */}
        {lastCollect && lastCollect.printer_id === p.id && <CollectNote notice={lastCollect} s={s} testId="farm-collect-note-sheet" />}

        {/* ------------------------------------------------------ actions */}
        <div className="space-y-2 border-t border-zinc-800/70 pt-3">
          {canCollect && (
            <button
              type="button"
              disabled={anyBusy}
              onClick={async () => {
                const r = await run(`collect:${p.id}`, (k) => farmApi.collect(p.id, k));
                if (r.ok === false) onError(r.error);
                else onCollected(r.result);
              }}
              className={`${BTN_PRIMARY} w-full`}
              data-farm-action="collect"
            >
              {busy === `collect:${p.id}` && <Spinner size="sm" delayMs={0} decorative />}
              {s.collect}
            </button>
          )}
          {p.state === 'broken' && rep && (
            <div className="flex items-center justify-between gap-3">
              <div className="text-[11px] text-zinc-400 tabular-nums">
                {s.repairCost(formatCoins(rep.cost, lang), rep.minutes)}
                {!canRepair && <p className="text-[#E4B363]">{s.notEnoughCoins}</p>}
              </div>
              <button type="button" disabled={anyBusy || !canRepair} onClick={() => act(`repair:${p.id}`, (k) => farmApi.repair(p.id, k))} className={BTN_PRIMARY} data-farm-action="repair">
                {s.repair}
              </button>
            </div>
          )}
          {p.state !== 'broken' && maint && (
            <div className="flex items-center justify-between gap-3">
              <div className="text-[11px] text-zinc-400 tabular-nums">
                {s.maintainCost(formatCoins(maint.cost, lang), maint.minutes)}
                {!maintenanceUnlocked && maintLevel !== null && <p className="text-zinc-500">{s.maintenanceLocked(maintLevel)}</p>}
                {maintenanceUnlocked && !(p.state === 'idle' || p.state === 'done') && <p className="text-zinc-500">{s.onlyWhenIdle}</p>}
                {maintenanceUnlocked && (p.state === 'idle' || p.state === 'done') && maint.cost > coins && <p className="text-[#E4B363]">{s.notEnoughCoins}</p>}
              </div>
              <button type="button" disabled={anyBusy || !canMaintain} onClick={() => act(`maintain:${p.id}`, (k) => farmApi.maintain(p.id, k))} className={BTN_SECONDARY} data-farm-action="maintain">
                {s.maintain}
              </button>
            </div>
          )}
          <div className="flex items-center justify-between gap-3">
            <p className="text-[11px] text-zinc-500">{canSell ? '' : s.sellOnlyIdle}</p>
            <button ref={sellBtn} type="button" disabled={anyBusy || !canSell} onClick={() => setSellOpen(true)} className={BTN_SECONDARY} data-farm-action="sell">
              {s.sell}
            </button>
          </div>
        </div>
      </div>

      <Overlay open={sellOpen} onClose={() => setSellOpen(false)} label={s.sellTitle} labelledBy={sellTitleId} anchor={sellBtn} z={260} dismissOnEscape={!anyBusy} dismissOnScrim={!anyBusy} panelClassName="w-full max-w-sm" testId="farm-sell-confirm">
        <div className={WINDOW_BODY}>
          <h3 id={sellTitleId} className="text-white font-bold text-[16px]">
            {s.sellTitle}
          </h3>
          <p className="text-[13px] text-zinc-300 leading-relaxed" data-farm-sell-quote={resale === null ? 'absent' : 'server'}>
            {resale === null ? s.sellBodyNoQuote(displayName) : s.sellBody(displayName, formatCoins(resale, lang))}
          </p>
          <div className="flex items-center justify-end gap-2 pt-1">
            <button type="button" disabled={anyBusy} onClick={() => setSellOpen(false)} className={BTN_SECONDARY}>
              {s.cancel}
            </button>
            <button
              type="button"
              disabled={anyBusy || !canSell}
              onClick={async () => {
                const ok = await act(`sell:${p.id}`, (k) => farmApi.sellPrinter(p.id, k));
                if (ok) {
                  setSellOpen(false);
                  onClose();
                }
              }}
              className={BTN_DANGER}
            >
              {s.sell}
            </button>
          </div>
        </div>
      </Overlay>
    </Window>
  );
}
