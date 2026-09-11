/**
 * PRINTER FARM — the shell.
 *
 * One state object from GET /api/farm/state drives everything below; the
 * header, the room, every card and every sheet render it and nothing else.
 * The page re-reads it every 20 s while visible, when the tab comes back, and
 * the moment any local countdown reaches a server `ends_at` — the client
 * never decides that a print finished, it asks. Every intent goes through
 * `run()` with a fresh idempotency key and re-renders from the answer.
 */
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Lock, X } from 'lucide-react';
import { useLanguage } from '../../LanguageContext';
import { ErrorState } from '../../components/ui/AsyncStates';
import Note from '../../components/ui/Note';
import { TabPanels } from '../../components/ui/Tabs';
import { collectResultOf, dailyJobs, farmApi, statValue, unlockLevel, type CollectResult, type FarmPrinter } from '../../lib/farmApi';
import FarmSkeleton from './FarmSkeleton';
import FarmTabBar, { FARM_TABS, type FarmTab, type TabLock } from './FarmTabBar';
import { GamesHeader } from './PageChrome';
import { FARM_STRINGS } from './strings';
import { farmErrorText } from './errors';
import { ms } from './format';
import { BUSY, useFarmState } from './hooks/useFarmState';
import { Chip, CoinsChip, Stars } from './bits';
import CollectNote from './CollectNote';
import { collectNotice } from './collect';
import { FOCUS, PANEL } from './ui';
import FarmView from './views/FarmView';
import JobsView from './views/JobsView';
import MarketView from './views/MarketView';
import InventoryView from './views/InventoryView';
import PrinterSheet from './sheets/PrinterSheet';
import JobSheet from './sheets/JobSheet';
import AwaySheet from './sheets/AwaySheet';

const DEFAULT_MAINTENANCE_THRESHOLD = 50;

export default function PrinterFarm() {
  const { lang, dir } = useLanguage();
  const s = FARM_STRINGS[lang];
  const { state, loading, error, busy, now, reload, run } = useFarmState();

  const [tab, setTab] = useState<FarmTab>('farm');
  const [focusCatalog, setFocusCatalog] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  // A quiet hint — "Unlocks at level 3" after a tap on a locked tab. Nothing
  // went wrong, so it is a Note, not the alert; it leaves on its own.
  const [hint, setHint] = useState<string | null>(null);
  useEffect(() => {
    if (!hint) return;
    const t = window.setTimeout(() => setHint(null), 4000);
    return () => window.clearTimeout(t);
  }, [hint]);

  // The last collect's answer (§4 collect: `collected`, `delivered`,
  // `payout_deferred`). Kept as the server sent it and worded at render time
  // in the current language; it stays until dismissed or the next collect.
  const [lastCollect, setLastCollect] = useState<(CollectResult & { replayed: boolean }) | null>(null);
  const onCollected = useCallback((res: unknown) => {
    const r = collectResultOf(res);
    if (r) setLastCollect(r);
  }, []);
  const collectNote = lastCollect ? collectNotice(lastCollect, s, lang) : null;

  // Sheets render the LATEST object for their id, so a mutation redraws them.
  const [printerId, setPrinterId] = useState<string | null>(null);
  const [jobId, setJobId] = useState<string | null>(null);
  const printerAnchor = useRef<HTMLElement | null>(null);
  const jobAnchor = useRef<HTMLElement | null>(null);

  const onError = useCallback(
    (err: unknown) => {
      if (err === BUSY) return; // a second tap while the first is in flight — nothing went wrong
      setNotice(farmErrorText(err, s));
    },
    [s]
  );

  // --------------------------------------------------------------- locks
  const locks = useMemo<Record<FarmTab, TabLock>>(() => {
    const u = state?.unlocks;
    const cfg = state?.config;
    const levels = state?.unlock_levels;
    const lockFor = (feature: 'market' | 'inventory'): TabLock => {
      if (!u || u[feature]) return { reason: null };
      const lvl = unlockLevel(cfg, feature, levels);
      return { reason: lvl !== null ? s.lockedLevel(lvl) : s.lockedSection };
    };
    // STORE and UPGRADES have no Phase 1 surface: locked with the server's
    // level until it unlocks them, and "not in this phase" once it has.
    const laterFor = (feature: 'store' | 'upgrades'): TabLock => {
      if (u?.[feature]) return { reason: s.lockedLater };
      const lvl = unlockLevel(cfg, feature, levels);
      return { reason: lvl !== null ? s.lockedLevel(lvl) : s.lockedSection };
    };
    return {
      farm: { reason: null },
      jobs: { reason: null },
      market: lockFor('market'),
      inventory: lockFor('inventory'),
      store: laterFor('store'),
      upgrades: laterFor('upgrades'),
    };
  }, [state?.unlocks, state?.config, state?.unlock_levels, s]);

  useEffect(() => {
    if (locks[tab].reason) setTab('farm');
  }, [locks, tab]);

  // ------------------------------------------- countdown → server re-sync
  // The soonest server instant still ahead of us; when the local clock
  // passes it the state is re-read once, so a print that "finished" locally
  // shows what the server made of it within a second.
  const nextInstant = useMemo(() => {
    if (!state) return null;
    let next: number | null = null;
    const consider = (iso: string | null | undefined) => {
      const t = ms(iso);
      if (t !== null && t > now && (next === null || t < next)) next = t;
    };
    for (const p of state.printers) {
      consider(p.current?.ends_at);
      consider(p.state_until);
    }
    for (const j of state.jobs.offered) consider(j.offer_expires_at);
    for (const j of state.jobs.active) consider(j.deadline_at);
    return next;
  }, [state, now]);
  const armedFor = useRef<number | null>(null);
  useEffect(() => {
    if (nextInstant !== null) armedFor.current = nextInstant;
  }, [nextInstant]);
  useEffect(() => {
    const t = armedFor.current;
    if (t !== null && now >= t && busy === null) {
      armedFor.current = null;
      void reload();
    }
  }, [now, busy, reload]);

  // -------------------------------------------------------- away summary
  // The sheet opens for events that happened while the player was AWAY. The
  // server says whether the absence was long enough (`away` is null when it
  // was not); events resolved while the player was watching are already on
  // the machine cards, so they are marked seen quietly instead of interrupting.
  const acknowledged = useRef(new Set<string>());
  const unseen = useMemo(() => (state?.events_unseen ?? []).filter((e) => !acknowledged.current.has(e.id)), [state?.events_unseen]);
  const awayKnown = state !== null && state.away !== undefined;
  const awayOpen = unseen.length > 0 && (!awayKnown || state.away !== null);
  const quietIds = unseen.length > 0 && awayKnown && state.away === null ? unseen.map((e) => e.id) : null;
  useEffect(() => {
    if (!quietIds || busy !== null) return;
    for (const id of quietIds) acknowledged.current.add(id);
    void run('events-seen-quiet', (k) => farmApi.markEventsSeen(quietIds, k));
  }, [quietIds, busy, run]);

  // -------------------------------------------------------------- render
  if (loading && !state) return <FarmSkeleton />;
  if (!state) {
    return (
      <div dir={dir} className="w-full flex-1 min-h-0 flex flex-col bg-[#0a0a0a] text-zinc-300 overflow-hidden">
        <GamesHeader title={s.title} backLabel={s.back} fallback="/games" />
        <div className="flex-1 min-h-0 overflow-y-auto">
          <div className="p-4 max-w-2xl mx-auto">
            <ErrorState error={error} onRetry={() => void reload()} next="/games/printer-farm" />
          </div>
        </div>
      </div>
    );
  }

  const profile = state.profile;
  const today = dailyJobs(state.limits);
  const maintenanceThreshold = state.config.economy?.maintenance?.recommend_below ?? DEFAULT_MAINTENANCE_THRESHOLD;
  const tutorial = profile.tutorial;
  const showIntro =
    tutorial?.done !== true &&
    (typeof tutorial?.step === 'number' ? tutorial.step : 0) < 1 &&
    state.jobs.active.length === 0 &&
    (statValue(profile.stats, 'jobs_delivered', 'delivered') ?? 0) === 0;

  const selectedPrinter: FarmPrinter | null = printerId ? state.printers.find((p) => p.id === printerId) ?? null : null;
  const selectedJob = jobId ? state.jobs.active.find((j) => j.id === jobId) ?? null : null;
  const visibleTabs = FARM_TABS.filter((t) => !locks[t].reason);

  const openPrinter = (p: FarmPrinter, anchor: HTMLElement | null) => {
    printerAnchor.current = anchor;
    setPrinterId(p.id);
  };
  const openEmptySlot = () => {
    if (locks.market.reason) {
      setNotice(locks.market.reason);
      return;
    }
    setFocusCatalog(true);
    setTab('market');
  };
  const openAssign = (id: string, anchor: HTMLElement | null) => {
    jobAnchor.current = anchor;
    setJobId(id);
  };

  return (
    <div dir={dir} className="w-full flex-1 min-h-0 flex flex-col bg-[#0a0a0a] text-zinc-300 overflow-hidden" data-farm-page>
      <GamesHeader
        title={profile.farm_name}
        backLabel={s.back}
        fallback="/games"
        trailing={<CoinsChip coins={profile.coins} lang={lang} s={s} />}
      >
        <div className="flex items-center gap-2 text-[11px] text-zinc-400 leading-4 min-w-0">
          <span className="tabular-nums whitespace-nowrap">{s.level(profile.level)}</span>
          <span aria-hidden="true" className="text-zinc-700">
            ·
          </span>
          <Stars stars={profile.stars} s={s} />
          {profile.state === 'recovery' && <Chip className="border-[#E4B363]/40 text-[#E4B363] bg-[#E4B363]/10">{s.recovery}</Chip>}
          {/* The daily cap, as the server counts it — both numbers are its own. */}
          {today && (
            <>
              <span aria-hidden="true" className="text-zinc-700">
                ·
              </span>
              <span className="tabular-nums whitespace-nowrap text-zinc-500 truncate" data-farm-today>
                {s.todayJobs(today.jobs, today.cap)}
              </span>
            </>
          )}
        </div>
      </GamesHeader>

      {notice && (
        <div role="alert" className="shrink-0 mx-4 mt-3 flex items-center gap-2 rounded-xl border border-[#E06070]/30 bg-[#E06070]/10 ps-3 pe-1 py-1 text-[12.5px] text-[#f2b3bb] max-w-2xl sm:mx-auto sm:w-full" data-farm-notice>
          <span className="flex-1 min-w-0 py-1 leading-snug">{notice}</span>
          <button type="button" aria-label={s.close} onClick={() => setNotice(null)} className={`shrink-0 min-w-[44px] min-h-[44px] inline-flex items-center justify-center rounded-lg hover:bg-white/5 ${FOCUS}`}>
            <X aria-hidden="true" className="w-4 h-4" />
          </button>
        </div>
      )}
      {hint && (
        <div className="shrink-0 mx-4 mt-3 max-w-2xl sm:mx-auto sm:w-full" aria-live="polite" data-farm-notice="hint">
          <Note tone="zinc" compact icon={<Lock className="w-4 h-4" />} testId="farm-locked-hint">
            <div className="flex items-center gap-2">
              <span className="flex-1 min-w-0">{hint}</span>
              <button type="button" aria-label={s.close} onClick={() => setHint(null)} className={`shrink-0 -my-2 -me-2 min-w-[44px] min-h-[44px] inline-flex items-center justify-center rounded-lg hover:bg-white/5 ${FOCUS}`}>
                <X aria-hidden="true" className="w-4 h-4" />
              </button>
            </div>
          </Note>
        </div>
      )}

      {/* The collect result: money that arrived, a failed batch, a payout the
          cap deferred — one live region, read once, dismissible. */}
      <div className="shrink-0 mx-4 mt-3 max-w-2xl sm:mx-auto sm:w-full empty:hidden" aria-live="polite" data-farm-notice="collect">
        {collectNote && <CollectNote notice={collectNote} s={s} onClose={() => setLastCollect(null)} />}
      </div>

      <div className="flex-1 min-h-0 overflow-y-auto" data-farm-scroll>
        <div className="p-4 max-w-2xl mx-auto">
          <TabPanels value={tab} order={visibleTabs}>
            {tab === 'farm' && (
              <FarmView
                state={state}
                now={now}
                lang={lang}
                dir={dir}
                s={s}
                busy={busy}
                run={run}
                onError={onError}
                onCollected={onCollected}
                onOpenPrinter={openPrinter}
                onOpenEmptySlot={openEmptySlot}
                onGoJobs={() => setTab('jobs')}
                showIntro={showIntro}
                maintenanceThreshold={maintenanceThreshold}
              />
            )}
            {tab === 'jobs' && <JobsView state={state} now={now} lang={lang} s={s} busy={busy} run={run} onError={onError} onAssign={openAssign} />}
            {tab === 'market' && <MarketView state={state} lang={lang} s={s} busy={busy} run={run} onError={onError} focusCatalog={focusCatalog} />}
            {tab === 'inventory' && <InventoryView state={state} lang={lang} s={s} />}
            {(tab === 'store' || tab === 'upgrades') && (
              <div className={`${PANEL} p-4`}>
                <p className="text-[13px] text-zinc-400">{s.sectionLockedBody}</p>
              </div>
            )}
          </TabPanels>
        </div>
      </div>

      <FarmTabBar
        value={tab}
        onChange={(t) => {
          if (t !== 'market') setFocusCatalog(false);
          setTab(t);
        }}
        onLocked={(_, reason) => setHint(reason)}
        locks={locks}
        badges={{ jobs: state.jobs.offered.length }}
        s={s}
      />

      <PrinterSheet
        open={selectedPrinter !== null}
        printer={selectedPrinter}
        state={state}
        now={now}
        lang={lang}
        s={s}
        busy={busy}
        run={run}
        onClose={() => setPrinterId(null)}
        onError={onError}
        onCollected={onCollected}
        lastCollect={collectNote}
        anchor={printerAnchor}
        maintenanceThreshold={maintenanceThreshold}
      />
      <JobSheet
        open={selectedJob !== null}
        job={selectedJob}
        state={state}
        now={now}
        lang={lang}
        s={s}
        busy={busy !== null}
        run={run}
        onClose={() => setJobId(null)}
        onError={onError}
        anchor={jobAnchor}
      />
      <AwaySheet
        open={awayOpen}
        events={unseen}
        awayMinutes={state.away?.minutes ?? null}
        lang={lang}
        s={s}
        busy={busy === 'events-seen'}
        run={run}
        onDone={() => {
          for (const e of unseen) acknowledged.current.add(e.id);
          // A dismissal without the server's confirmation only hides the
          // sheet for this visit; the events stay unseen server-side.
          void reload();
        }}
        onError={onError}
      />
    </div>
  );
}
