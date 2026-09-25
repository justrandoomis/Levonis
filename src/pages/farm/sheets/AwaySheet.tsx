/**
 * "While you were away" — the unseen `farm_events`, grouped by kind (the
 * pure grouping lives in ../events.ts). Every line is a count of server
 * events; the absence length is the server's `away.minutes`; the coin line
 * appears only when an event carried an amount. "Got it" posts the ids to
 * /events/seen and the page re-reads its state.
 */
import React, { useId } from 'react';
import { Ban, CheckCircle2, Clock, Coins, Info, TrendingUp, TriangleAlert, Wrench } from 'lucide-react';
import Spinner from '../../../components/ui/Spinner';
import { farmApi, type FarmEvent } from '../../../lib/farmApi';
import type { FarmStrings } from '../strings';
import { formatSignedCoins, gameDuration } from '../format';
import { groupEvents } from '../events';
import { BTN_PRIMARY, ROW } from '../ui';
import type { RunResult } from '../hooks/useFarmState';
import { Window, WINDOW_BODY } from './Window';

export default function AwaySheet({
  open,
  events,
  awayMinutes,
  lang,
  s,
  busy,
  run,
  onDone,
  onError,
}: {
  open: boolean;
  events: FarmEvent[];
  /** The server's measure of the absence, when it sent one. */
  awayMinutes: number | null;
  lang: string;
  s: FarmStrings;
  busy: boolean;
  run: (actionId: string, call: (key: string) => Promise<unknown>) => Promise<RunResult>;
  onDone: () => void;
  onError: (err: unknown) => void;
}) {
  const titleId = useId();
  const g = groupEvents(events);
  const rows: Array<{ key: string; icon: React.ReactNode; text: string; tone: string }> = [];
  if (g.finished) rows.push({ key: 'ok', icon: <CheckCircle2 aria-hidden="true" className="w-4 h-4" />, text: s.awayFinished(g.finished), tone: 'text-sage' });
  if (g.failed) rows.push({ key: 'f', icon: <TriangleAlert aria-hidden="true" className="w-4 h-4" />, text: s.awayFailed(g.failed), tone: 'text-coral' });
  if (g.late) rows.push({ key: 'l', icon: <Clock aria-hidden="true" className="w-4 h-4" />, text: s.awayLate(g.late), tone: 'text-honey' });
  if (g.cancelled) rows.push({ key: 'c', icon: <Ban aria-hidden="true" className="w-4 h-4" />, text: s.awayCancelled(g.cancelled), tone: 'text-honey' });
  if (g.maintenance) rows.push({ key: 'm', icon: <Wrench aria-hidden="true" className="w-4 h-4" />, text: s.awayMaintenance(g.maintenance), tone: 'text-honey' });
  if (g.levelUp) rows.push({ key: 'u', icon: <TrendingUp aria-hidden="true" className="w-4 h-4" />, text: s.awayLevelUp(g.levelUp), tone: 'text-gold' });
  if (g.other) rows.push({ key: 'o', icon: <Info aria-hidden="true" className="w-4 h-4" />, text: s.awayOther(g.other), tone: 'text-zinc-300' });

  const acknowledge = async () => {
    const ids = events.map((e) => e.id);
    const r = await run('events-seen', (k) => farmApi.markEventsSeen(ids, k));
    if (r.ok === false) {
      onError(r.error);
      return;
    }
    onDone();
  };

  return (
    <Window open={open} onClose={onDone} label={s.awayTitle} labelledBy={titleId} busy={busy} testId="farm-away">
      <div className={WINDOW_BODY}>
        <h3 id={titleId} className="text-white font-bold text-[16px]">
          {s.awayTitle}
        </h3>
        <p className="text-[13px] text-zinc-400">
          {s.awayIntro}
          {awayMinutes !== null && awayMinutes > 0 && (
            <>
              {' '}
              <span className="text-zinc-300 tabular-nums">{s.awaySince(gameDuration(awayMinutes * 60, lang))}</span>
            </>
          )}
        </p>
        <ul className="space-y-1.5" data-farm-away-rows={rows.length}>
          {rows.map((r) => (
            <li key={r.key} className={`${ROW} px-3 py-2.5 flex items-center gap-2.5 text-[13px] text-zinc-100`}>
              <span className={r.tone}>{r.icon}</span>
              <span>{r.text}</span>
            </li>
          ))}
          {g.coins !== null && (
            <li className={`${ROW} px-3 py-2.5 flex items-center justify-between gap-2.5 text-[13px]`}>
              <span className="inline-flex items-center gap-2.5 text-zinc-100">
                <Coins aria-hidden="true" className="w-4 h-4 text-gold" />
                {s.awayCoins}
              </span>
              <span className={`font-black tabular-nums ${g.coins >= 0 ? 'text-gold' : 'text-coral'}`} dir="ltr">
                {formatSignedCoins(g.coins, lang)}
              </span>
            </li>
          )}
        </ul>
        <button type="button" disabled={busy} onClick={acknowledge} className={`${BTN_PRIMARY} w-full`} data-farm-action="events-seen">
          {busy && <Spinner size="sm" delayMs={0} decorative />}
          {s.gotIt}
        </button>
      </div>
    </Window>
  );
}
