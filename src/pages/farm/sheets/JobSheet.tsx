/**
 * Allocate an accepted job: how many parts each printer prints, from which
 * spool, at which quality. Incompatible printers are shown disabled WITH the
 * reason (material, colours, size, state) so the refusal comes before the
 * tap, not after. The time and deadline lines are estimates derived from the
 * server's own figures by the contract's formula and are labelled as such;
 * the server re-validates everything on Start and its state is what renders.
 */
import React, { useEffect, useId, useMemo, useState } from 'react';
import { Minus, Plus } from 'lucide-react';
import { Segmented } from '../../../components/ui/Segmented';
import Spinner from '../../../components/ui/Spinner';
import Note from '../../../components/ui/Note';
import {
  colorNameOf,
  farmApi,
  PRINT_QUALITIES,
  printerModel,
  productByKey,
  type AssignAllocation,
  type FarmJob,
  type FarmState,
  type PrintQuality,
} from '../../../lib/farmApi';
import type { FarmStrings } from '../strings';
import { countdown, formatDateTime, gameDuration, localName, nameOf, printerName, qualityLabel, realSecondsFor, swatchFor } from '../format';
import {
  compatibleSpools,
  deadlineRisk,
  estimateGameSeconds,
  gramsForQty,
  printerFit,
  queueGameSeconds,
  remainingQty,
  type IncompatibilityReason,
} from '../rules';
import { Chip, Swatch } from '../bits';
import { BTN_PRIMARY, BTN_SECONDARY, FOCUS, ICON_BTN, INPUT, ROW } from '../ui';
import type { RunResult } from '../hooks/useFarmState';
import { Window, WINDOW_BODY } from './Window';

interface Alloc {
  qty: number;
  spool_id: string;
}

function reasonText(reason: IncompatibilityReason, s: FarmStrings): string {
  switch (reason) {
    case 'unknown_model':
      return s.unknownModel;
    case 'broken':
      return s.unavailableBroken;
    case 'maintenance':
      return s.unavailableMaintenance;
    case 'material':
      return s.incompatibleMaterial;
    case 'multicolor':
      return s.incompatibleMulticolor;
    case 'too_large':
      return s.incompatibleTooLarge;
  }
}

export default function JobSheet({
  open,
  job,
  state,
  now,
  lang,
  s,
  busy,
  run,
  onClose,
  onError,
  anchor,
}: {
  open: boolean;
  job: FarmJob | null;
  state: FarmState;
  now: number;
  lang: string;
  s: FarmStrings;
  busy: boolean;
  run: (actionId: string, call: (key: string) => Promise<unknown>) => Promise<RunResult>;
  onClose: () => void;
  onError: (err: unknown) => void;
  anchor: React.RefObject<HTMLElement | null>;
}) {
  const titleId = useId();
  const config = state.config;
  const timeScale = config.time?.time_scale ?? 1;
  const [quality, setQuality] = useState<PrintQuality>('standard');
  const [allocs, setAllocs] = useState<Record<string, Alloc>>({});

  // Reset when a different job opens.
  useEffect(() => {
    if (!open) return;
    setQuality(job?.quality ?? 'standard');
    setAllocs({});
  }, [open, job?.id, job?.quality]);

  const remaining = job ? remainingQty(job) : 0;
  const spools = useMemo(() => (job ? compatibleSpools(state.spools, job) : []), [state.spools, job]);
  const printers = useMemo(() => [...state.printers].sort((a, b) => a.slot - b.slot), [state.printers]);
  const fits = useMemo(() => new Map(printers.map((p) => [p.id, job ? printerFit(p, job, config) : { ok: false, reason: null }])), [printers, job, config]);

  const total = Object.values(allocs).reduce((n, a) => n + a.qty, 0);
  const tooMany = total > remaining;
  const partial = total > 0 && total < remaining;

  const setQty = (printerId: string, qty: number) => {
    setAllocs((prev) => {
      const cur = prev[printerId] ?? { qty: 0, spool_id: spools[0]?.id ?? '' };
      const next = { ...prev, [printerId]: { ...cur, qty: Math.max(0, qty) } };
      if (next[printerId].qty === 0) delete next[printerId];
      return next;
    });
  };
  const setSpool = (printerId: string, spool_id: string) => {
    setAllocs((prev) => ({ ...prev, [printerId]: { qty: prev[printerId]?.qty ?? 0, spool_id } }));
  };

  // Estimates per printer and the latest finish among them.
  let latestFinish = 0;
  const rows = printers.map((p) => {
    const fit = fits.get(p.id) ?? { ok: false, reason: null };
    const a = allocs[p.id];
    const qty = a?.qty ?? 0;
    const grams = job ? gramsForQty(job, qty) : 0;
    const spool = a?.spool_id ? state.spools.find((sp) => sp.id === a.spool_id) ?? null : null;
    const gramsOk = !spool || spool.grams_left >= grams;
    const own = job && qty > 0 ? estimateGameSeconds(job, qty, p.model_key, quality, config) : 0;
    const wait = qty > 0 ? queueGameSeconds(p, now, timeScale) : 0;
    const finishAt = qty > 0 ? now + realSecondsFor(wait + own, timeScale) * 1000 : 0;
    if (finishAt > latestFinish) latestFinish = finishAt;
    return { p, fit, qty, grams, spool, gramsOk, own, wait, finishAt };
  });
  const risk = job && latestFinish > 0 ? deadlineRisk(latestFinish, job.deadline_at, now) : null;

  const valid =
    !!job &&
    total > 0 &&
    !tooMany &&
    rows.every((r) => r.qty === 0 || (r.fit.ok && r.spool !== null && r.gramsOk));

  const start = async () => {
    if (!job || !valid) return;
    const allocations: AssignAllocation[] = rows
      .filter((r) => r.qty > 0 && r.spool)
      .map((r) => ({ printer_id: r.p.id, qty: r.qty, spool_id: r.spool!.id }));
    const r = await run(`assign:${job.id}`, (k) => farmApi.assignJob(job.id, { allocations, quality, allow_partial: partial || undefined }, k));
    if (r.ok === false) {
      onError(r.error);
      return;
    }
    onClose();
  };

  const product = job ? productByKey(config, job.product_key) : null;

  return (
    <Window open={open && !!job} onClose={onClose} label={s.assignTitle} labelledBy={titleId} busy={busy} anchor={anchor} testId="farm-job-sheet">
      {job && (
        <div className={WINDOW_BODY}>
          <div>
            <h3 id={titleId} className="text-white font-bold text-[16px]">
              {s.assignTitle}
            </h3>
            <p className="text-[13px] text-zinc-300 mt-0.5">
              {s.qtyProduct(job.qty, localName(product, lang, nameOf(job.title, lang)))} ·{' '}
              <span dir="ltr">{job.material}</span>{' '}
              <span className="inline-flex items-center gap-1 align-middle" aria-label={`${s.colors}: ${job.colors.map((c) => nameOf(colorNameOf(config, c), lang, c)).join(', ')}`}>
                {job.colors.map((c) => (
                  <Swatch key={c} color={swatchFor(config, c)} />
                ))}
              </span>
            </p>
            <p className="text-[12px] text-zinc-500 mt-1">{s.assignIntro}</p>
            {job.payout_deferred_day && (
              <p className="mt-2 flex flex-wrap items-center gap-2 text-[11.5px] text-[#E4B363]">
                <Chip className="border-[#E4B363]/40 text-[#E4B363] bg-[#E4B363]/10" data-farm-payout-pending={job.id}>
                  {s.payoutPending}
                </Chip>
                <span>{s.payoutPendingBody}</span>
              </p>
            )}
          </div>

          <div className="space-y-1.5">
            <p className="text-[11px] font-semibold text-zinc-500">{s.qualityLabel}</p>
            <Segmented
              group="farm-quality"
              label={s.qualityLabel}
              value={quality}
              onChange={(id) => setQuality(id as PrintQuality)}
              dataAttr="data-farm-quality"
              items={PRINT_QUALITIES.map((q) => ({
                id: q,
                label: qualityLabel(q, s),
                accent: { indicator: 'bg-[#BAA369]/10 border-[#BAA369]/40', text: 'text-[#BAA369]' },
              }))}
            />
          </div>

          <div className="space-y-2">
            <div className="flex items-baseline justify-between">
              <p className="text-[11px] font-semibold text-zinc-500">{s.printersLabel}</p>
              <p className={`text-[11px] tabular-nums ${tooMany ? 'text-[#E06070]' : 'text-zinc-400'}`}>{s.allocated(total, remaining)}</p>
            </div>
            {rows.map(({ p, fit, qty, grams, spool, gramsOk, own, wait, finishAt }) => {
              const model = printerModel(config, p.model_key);
              const disabled = !fit.ok;
              return (
                <div key={p.id} className={`${ROW} p-3 space-y-2 ${disabled ? 'opacity-70' : ''}`} data-farm-alloc={p.id} aria-disabled={disabled || undefined}>
                  <div className="flex items-center justify-between gap-3">
                    <div className="min-w-0">
                      <p className="text-[13px] text-white font-bold truncate">{printerName(p, config, lang)}</p>
                      <p className="text-[11px] text-zinc-500 truncate" dir="ltr">
                        {nameOf(model?.name, lang, p.model_key)}
                      </p>
                    </div>
                    {disabled && fit.reason ? (
                      <Chip className="border-zinc-700 text-zinc-400 bg-zinc-800/60">{reasonText(fit.reason, s)}</Chip>
                    ) : (
                      <div className="flex items-center gap-1" role="group" aria-label={s.parts(qty)}>
                        <button type="button" aria-label={s.moveDown} disabled={qty <= 0} onClick={() => setQty(p.id, qty - 1)} className={ICON_BTN}>
                          <Minus aria-hidden="true" className="w-4 h-4" />
                        </button>
                        <input
                          type="number"
                          inputMode="numeric"
                          min={0}
                          max={remaining}
                          value={qty}
                          aria-label={s.parts(qty)}
                          onChange={(e) => setQty(p.id, Math.min(remaining, Math.max(0, Number(e.target.value) || 0)))}
                          className={`${INPUT} w-16 min-h-[44px] text-center tabular-nums py-2`}
                          dir="ltr"
                        />
                        <button type="button" aria-label={s.moveUp} disabled={total >= remaining} onClick={() => setQty(p.id, qty + 1)} className={ICON_BTN}>
                          <Plus aria-hidden="true" className="w-4 h-4" />
                        </button>
                      </div>
                    )}
                  </div>

                  {!disabled && qty > 0 && (
                    <>
                      <div className="space-y-1">
                        <label className="text-[11px] text-zinc-500" htmlFor={`spool-${p.id}`}>
                          {s.spoolLabel} · <span className="tabular-nums">{s.gramsNeeded(grams)}</span>
                        </label>
                        {spools.length === 0 ? (
                          <p className="text-[12px] text-[#E4B363]">{s.noCompatibleSpool}</p>
                        ) : (
                          <select
                            id={`spool-${p.id}`}
                            value={spool?.id ?? ''}
                            onChange={(e) => setSpool(p.id, e.target.value)}
                            className={`${INPUT} py-2.5 ${FOCUS}`}
                          >
                            <option value="">{s.chooseSpool}</option>
                            {spools.map((sp) => (
                              <option key={sp.id} value={sp.id} disabled={sp.grams_left < grams}>
                                {sp.material} {nameOf(colorNameOf(config, sp.color), lang, sp.color)} — {s.gramsLeft(sp.grams_left)}
                                {sp.grams_left < grams ? ` · ${s.insufficientGrams}` : ''}
                              </option>
                            ))}
                          </select>
                        )}
                        {spool && !gramsOk && <p className="text-[11px] text-[#E06070]">{s.insufficientGrams}</p>}
                      </div>
                      <p className="text-[11px] text-zinc-400 tabular-nums" data-farm-duration="estimate">
                        ≈ {gameDuration(own, lang)}
                        {wait > 0 ? ` · ${s.queueWait(gameDuration(wait, lang))}` : ''} · {formatDateTime(new Date(finishAt).toISOString(), lang)}
                      </p>
                    </>
                  )}
                </div>
              );
            })}
          </div>

          {total > 0 && (
            <dl className="grid grid-cols-2 gap-3 text-[12px] border-t border-zinc-800/70 pt-3">
              <div>
                <dt className="text-zinc-500">
                  {s.estPrintTime} <span className="text-zinc-600">({s.estimate})</span>
                </dt>
                <dd className="text-zinc-100 font-bold tabular-nums" data-farm-duration="estimate">
                  {gameDuration(Math.max(0, (latestFinish - now) / 1000) * timeScale, lang)} · {s.realTime(countdown(Math.max(0, latestFinish - now), lang))}
                </dd>
              </div>
              <div>
                <dt className="text-zinc-500">{s.estFinish}</dt>
                <dd className="flex items-center gap-2 flex-wrap">
                  <span className="text-zinc-100 font-bold tabular-nums">
                    {formatDateTime(new Date(latestFinish).toISOString(), lang)}
                  </span>
                  {risk && (
                    <Chip
                      className={
                        risk === 'on_time'
                          ? 'border-[#A6B283]/40 text-[#A6B283] bg-[#A6B283]/10'
                          : risk === 'tight'
                            ? 'border-[#E4B363]/40 text-[#E4B363] bg-[#E4B363]/10'
                            : 'border-[#E06070]/40 text-[#E06070] bg-[#E06070]/10'
                      }
                    >
                      {risk === 'on_time' ? s.riskOnTime : risk === 'tight' ? s.riskTight : s.riskLate}
                    </Chip>
                  )}
                </dd>
              </div>
            </dl>
          )}

          {tooMany && (
            <Note tone="amber" compact animate={false}>
              {s.tooMany}
            </Note>
          )}
          {partial && !tooMany && (
            <Note tone="zinc" compact animate={false}>
              {s.partialNote(remaining - total)}
            </Note>
          )}

          <div className="flex items-center justify-end gap-2 pt-1">
            <button type="button" disabled={busy} onClick={onClose} className={BTN_SECONDARY}>
              {s.cancel}
            </button>
            <button type="button" disabled={busy || !valid} onClick={start} className={BTN_PRIMARY} data-farm-action="start">
              {busy && <Spinner size="sm" delayMs={0} decorative />}
              {s.start}
            </button>
          </div>
        </div>
      )}
    </Window>
  );
}
