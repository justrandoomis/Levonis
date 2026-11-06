/**
 * «المكافآت» — THE REWARDS AREA (rewards spec §1 and §2.1; DECISIONS row 290).
 *
 * ONE PAGE, SEVEN ADDRESSES. /rewards (the hub), /rewards/coupons,
 * /rewards/shop, /rewards/rate, /rewards/competitions,
 * /rewards/competitions/:id and the /rewards/* splat all render this same
 * element (src/App.tsx), so React Router keeps ONE instance across them: the
 * reads, the pages already loaded and the scroll memory survive moving
 * between sections, and Back from a competition finds the list as it was.
 * The address alone says which screen shows (`sectionOf`, `viewOf`): no
 * section lives in a hash, so signing in returns to the same place.
 *
 * WHAT THE FRAME DRAWS, around every screen:
 * - the header (AreaHeader: back through `useGoBack(PARENT[section])`, the
 *   h1, the mascot anchor) and, on the competitions list, its tabs;
 * - one scroller per screen, keyed by section and id, so a pushed screen
 *   mounts at its top;
 * - the states no screen has to repeat: the skeleton while the session
 *   loads, a guest's sign-in state, the area's NotFound, a competition's
 *   NotFound (a malformed id, without a fetch, or the server's 404), the
 *   StaleLine above a screen whose re-read failed, «المزيد في المكافآت»
 *   after coupons, shop, rate and the list;
 * - the slot the competition's CTA bar is portalled into, after the scroller
 *   (so the bar never covers content and needs no fixed positioning);
 * - one polite live region («حُمّلت نتائج أخرى» after «عرض المزيد»).
 *
 * THE FULL-SCREEN SHELL RESTORES NOTHING, so this does:
 * - OFFSETS remembers each history entry's scroll (rAF-throttled, 40
 *   entries); a POP waits for its screen's read to settle, applies the offset
 *   and again one frame later, once, and gives up after 2 s. Module-level, so
 *   Back from a product into a remounted area still lands where it was.
 * - A REPLACE inside a screen (a tab, the «مشاركاتي فقط» filter) goes to the
 *   top.
 * - Focus: the h1 on a PUSH into a screen; on a POP to the list, the row last
 *   opened; a tab switch keeps focus on the tab (TabStrip).
 * The stack slide on PUSH and POP is the router's (NavigationRouter's view
 * transition); it skips REPLACE and query-only changes by itself.
 *
 * PERSONAL DATA: a read runs only for a signed-in customer on its own pages
 * (src/components/rewards/useRewardsData.ts), and nothing is cached beyond
 * this page. The screens decide nothing the server owns.
 */
import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useLocation, useNavigate, useNavigationType } from 'react-router-dom';
import { useAuth } from '../AuthContext';
import { useLanguage } from '../LanguageContext';
import { useWallet } from '../WalletContext';
import { useGoBack } from '../lib/useGoBack';
import { TabPanels } from '../components/ui/Tabs';
import {
  AreaHeader,
  AreaNotFound,
  CompetitionNotFound,
  RelatedDoors,
  SectionGuest,
  SectionSkeleton,
  StaleLine,
  relatedSection,
} from '../components/rewards/AreaChrome';
import { CompetitionScreen } from '../components/rewards/CompetitionScreen';
import { CompetitionTabs, CompetitionsScreen } from '../components/rewards/CompetitionsScreen';
import { CouponsScreen } from '../components/rewards/CouponsScreen';
import { HubGuest, HubScreen } from '../components/rewards/HubScreen';
import { PARENT, TITLE, mineOf, sectionOf, viewOf, type CompetitionsView, type Section } from '../components/rewards/model';
import { RateScreen } from '../components/rewards/RateScreen';
import { ShopScreen } from '../components/rewards/ShopScreen';
import {
  useCompetition,
  useCompetitionsList,
  useReloadSoon,
  useRewardPrinters,
  useRewardsHub,
  type CompetitionSeed,
  type LoadStatus,
} from '../components/rewards/useRewardsData';
import { useRewardsT } from '../components/rewards/useT';

/** Scroll offsets by history entry (`location.key`); the oldest written goes first past 40. */
const OFFSETS = new Map<string, number>();
const OFFSETS_MAX = 40;
/** A POP's restore waits for its screen's data this long after the POP, then gives up. */
const RESTORE_WINDOW_MS = 2_000;
/** The pages the hub's read feeds. */
const HUB_SECTIONS: ReadonlySet<Section> = new Set<Section>(['home', 'coupons', 'shop', 'rate']);

function rememberOffset(key: string, top: number): void {
  OFFSETS.delete(key);
  OFFSETS.set(key, top);
  while (OFFSETS.size > OFFSETS_MAX) {
    const oldest = OFFSETS.keys().next().value;
    if (oldest === undefined) break;
    OFFSETS.delete(oldest);
  }
}

const settled = (status: LoadStatus) => status === 'ready' || status === 'error';
const nothingToReload = async () => {};

/** Focus the list row last opened (Back to the list), without scrolling to it: the restore placed it. */
function focusRow(root: HTMLElement | null, id: string): void {
  if (!root) return;
  for (const el of root.querySelectorAll<HTMLElement>('[data-competition-link]')) {
    if (el.getAttribute('data-competition-link') === id) {
      el.focus({ preventScroll: true });
      return;
    }
  }
}

export default function RewardsArea() {
  const location = useLocation();
  const navigationType = useNavigationType();
  const navigate = useNavigate();
  const { isAuthenticated, isLoaded: authLoaded } = useAuth();
  const { dir } = useLanguage();
  const { t } = useRewardsT();
  const { pointBalance, isLoaded: walletLoaded, refreshWallet } = useWallet();

  const { section, id } = sectionOf(location.pathname);
  const goBack = useGoBack(PARENT[section]);
  /** One scroller per screen: a competition's id is part of it, with a separator no id can contain. */
  const screenKey = id === undefined ? section : `${section}/${id}`;
  const authed = authLoaded && isAuthenticated;
  const guest = authLoaded && !isAuthenticated;
  const onList = section === 'competitions';

  // THE LIST'S VIEW comes from the address on the list. Anywhere else the list
  // keeps the view it was left on, so a competition opened from «النتائج» is
  // seeded from those rows and Back finds them still there.
  const urlView = viewOf(location.search);
  const urlMine = mineOf(location.search);
  const [kept, setKept] = useState<{ view: CompetitionsView; mine: boolean }>({ view: urlView, mine: urlMine });
  useLayoutEffect(() => {
    if (onList) setKept((k) => (k.view === urlView && k.mine === urlMine ? k : { view: urlView, mine: urlMine }));
  }, [onList, urlView, urlMine]);
  const view = onList ? urlView : kept.view;
  const mine = onList ? urlMine : kept.mine;

  // THE THREE READS, each enabled only for a signed-in customer on its pages.
  const hub = useRewardsHub(authed && HUB_SECTIONS.has(section));
  const printers = useRewardPrinters(authed && section === 'coupons');
  const list = useCompetitionsList(authed && onList, view, mine);
  // The row the customer tapped draws the competition at once (§2.3).
  const seed = useMemo<CompetitionSeed | null>(() => {
    if (id === undefined) return null;
    const fromList = list.data ? list.items.find((c) => c.id === id) : undefined;
    if (fromList && list.data) {
      return { competition: fromList, server_time: list.data.server_time, point_balance: list.data.point_balance, skewMs: list.skewMs };
    }
    const fromHub = hub.data?.competitions?.find((c) => c.id === id);
    if (fromHub && hub.data) {
      return { competition: fromHub, server_time: hub.data.server_time, point_balance: hub.data.point_balance, skewMs: hub.skewMs };
    }
    return null;
  }, [id, list.data, list.items, list.skewMs, hub.data, hub.skewMs]);
  const detail = useCompetition(id, authed && section === 'competition' && id !== undefined, seed);

  const active = HUB_SECTIONS.has(section) ? hub : onList ? list : section === 'competition' && id !== undefined ? detail : null;
  /** Countdown.onZero on any screen: the visible screen's read, 1.5 s later. */
  const reloadSoon = useReloadSoon(active ? active.reload : nothingToReload);
  /** The screen has what it needs to be measured: its read settled, or it needs none. */
  const screenReady =
    section === 'unknown' ||
    (section === 'competition' && id === undefined) ||
    guest ||
    (authed && (section === 'competition' ? detail.notFound || settled(detail.status) : !!active && settled(active.status)));

  // REFRESHES AFTER ACTIONS (§2.3). Both resolve once everything is in; the
  // wallet's own refresh never rejects.
  const { reload: hubReload, invalidate: hubInvalidate } = hub;
  const { invalidate: listInvalidate } = list;
  const { reload: detailReload } = detail;
  const onSwapped = useCallback(async () => {
    await Promise.all([hubReload(), refreshWallet()]);
  }, [hubReload, refreshWallet]);
  const onEntered = useCallback(async () => {
    await Promise.all([detailReload(), refreshWallet()]);
    hubInvalidate();
    listInvalidate();
  }, [detailReload, refreshWallet, hubInvalidate, listInvalidate]);

  // «الحالية» ↔ «النتائج» and «مشاركاتي فقط» REPLACE the entry: Back leaves
  // the page, not the tab.
  const setView = useCallback(
    (next: CompetitionsView) => {
      if (next === urlView) return;
      navigate(next === 'results' ? '/rewards/competitions?view=results' : '/rewards/competitions', { replace: true });
    },
    [navigate, urlView]
  );
  const setMine = useCallback(
    (on: boolean) => {
      navigate('/rewards/competitions?view=results' + (on ? '&mine=1' : ''), { replace: true });
    },
    [navigate]
  );

  // ------------------------------------------------------------ scroll and focus (§1.4)
  const scroller = useRef<HTMLDivElement | null>(null);
  const titleRef = useRef<HTMLHeadingElement | null>(null);
  const lastOpened = useRef<string | null>(null);
  const saveFrame = useRef(0);
  const restoreFrame = useRef(0);
  const pendingSave = useRef<{ key: string; el: HTMLElement } | null>(null);

  const saveOffset = useCallback(
    (e: React.UIEvent<HTMLDivElement>) => {
      pendingSave.current = { key: location.key, el: e.currentTarget };
      if (saveFrame.current) return;
      saveFrame.current = requestAnimationFrame(() => {
        saveFrame.current = 0;
        const p = pendingSave.current;
        pendingSave.current = null;
        // A scroller already replaced by the next screen has nothing to say.
        if (p && p.el.isConnected) rememberOffset(p.key, p.el.scrollTop);
      });
    },
    [location.key]
  );

  // A POP is remembered when it lands, so its restore can wait for the data.
  const pop = useRef<{ key: string; at: number; done: boolean } | null>(null);
  useLayoutEffect(() => {
    pop.current = navigationType === 'POP' ? { key: location.key, at: Date.now(), done: false } : null;
  }, [location.key, navigationType]);

  // POP: once the screen's read has settled, put the scroll back (twice, a
  // frame apart, as the shell does for the main site), then focus the list's
  // last opened row. Once per entry, within 2 s of the POP.
  useLayoutEffect(() => {
    const p = pop.current;
    if (!p || p.done || p.key !== location.key || !screenReady) return;
    p.done = true;
    if (Date.now() - p.at > RESTORE_WINDOW_MS) return;
    const el = scroller.current;
    const top = OFFSETS.get(p.key);
    if (el && top !== undefined) {
      el.scrollTo({ top });
      cancelAnimationFrame(restoreFrame.current);
      restoreFrame.current = requestAnimationFrame(() => {
        restoreFrame.current = 0;
        if (el.isConnected) el.scrollTo({ top });
      });
    }
    if (section === 'competitions' && lastOpened.current) focusRow(el, lastOpened.current);
  }, [location.key, screenReady, section]);

  // PUSH into a screen: its h1 takes focus, so the new page is announced.
  useLayoutEffect(() => {
    if (navigationType === 'PUSH') titleRef.current?.focus({ preventScroll: true });
  }, [location.key, navigationType]);

  // REPLACE inside the same screen (a tab, the filter): back to the top.
  const shownScreen = useRef(screenKey);
  useLayoutEffect(() => {
    const same = shownScreen.current === screenKey;
    shownScreen.current = screenKey;
    if (same && navigationType === 'REPLACE') scroller.current?.scrollTo({ top: 0 });
  }, [location.key, navigationType, screenKey]);

  // ------------------------------------------------------------ the live region
  const [announcement, setAnnouncement] = useState('');
  const announceTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const seenMore = useRef(list.moreLoaded);
  useEffect(() => {
    const grew = list.moreLoaded > seenMore.current;
    seenMore.current = list.moreLoaded;
    if (!grew) return;
    // Emptied first, so the same sentence is announced again the next time.
    setAnnouncement('');
    if (announceTimer.current !== null) clearTimeout(announceTimer.current);
    announceTimer.current = setTimeout(() => {
      announceTimer.current = null;
      setAnnouncement(t('moreLoaded'));
    }, 100);
  }, [list.moreLoaded, t]);

  useEffect(
    () => () => {
      cancelAnimationFrame(saveFrame.current);
      cancelAnimationFrame(restoreFrame.current);
      if (announceTimer.current !== null) clearTimeout(announceTimer.current);
    },
    []
  );

  // The CTA bar's portal target (CompetitionScreen), after the scroller.
  const [ctaSlot, setCtaSlot] = useState<HTMLDivElement | null>(null);

  // ------------------------------------------------------------ which screen
  let screen: React.ReactNode = null;
  if (section === 'unknown') screen = <AreaNotFound />;
  else if (section === 'competition' && id === undefined) screen = <CompetitionNotFound />;
  else if (!authLoaded) {
    screen = onList ? (
      // Inside a panel of the tabs' group, so the header's tabs (drawn while
      // the session loads, so nothing jumps) name an element that exists.
      <TabPanels value={view} order={['current', 'results']} group="rewards-competitions">
        <SectionSkeleton section={section} />
      </TabPanels>
    ) : (
      <SectionSkeleton section={section} />
    );
  } else if (!isAuthenticated) screen = section === 'home' ? <HubGuest /> : <SectionGuest section={section} />;
  else if (section === 'competition' && detail.notFound) screen = <CompetitionNotFound />;
  else if (section === 'home') screen = <HubScreen hub={hub} walletPoints={walletLoaded ? pointBalance : null} reloadSoon={reloadSoon} />;
  else if (section === 'coupons') screen = <CouponsScreen hub={hub} printers={printers} reloadSoon={reloadSoon} />;
  else if (section === 'shop') screen = <ShopScreen hub={hub} onSwapped={onSwapped} />;
  else if (section === 'rate') screen = <RateScreen hub={hub} />;
  else if (section === 'competitions') {
    screen = (
      <CompetitionsScreen
        list={list}
        view={view}
        mine={mine}
        onViewChange={setView}
        onMineChange={setMine}
        lastOpened={lastOpened}
        reloadSoon={reloadSoon}
      />
    );
  } else if (id !== undefined) {
    screen = <CompetitionScreen id={id} detail={detail} ctaSlot={ctaSlot} onEntered={onEntered} reloadSoon={reloadSoon} />;
  }

  const stale = authed && active !== null && active.status === 'ready' && active.stale && !(section === 'competition' && detail.notFound);
  const related = authed ? relatedSection(section) : null;

  return (
    <div
      data-testid="rewards-area"
      data-rewards-section={section}
      dir={dir}
      className="flex w-full min-w-0 flex-1 min-h-0 flex-col font-sans text-text-primary"
    >
      <AreaHeader title={t(TITLE[section])} onBack={goBack} wide={section === 'competition'} titleRef={titleRef}>
        {onList && !guest && <CompetitionTabs view={view} counts={list.counts} onChange={setView} />}
      </AreaHeader>
      <div key={screenKey} ref={scroller} onScroll={saveOffset} data-rewards-scroll className="flex-1 min-h-0 overflow-y-auto overscroll-contain">
        <div
          className={`mx-auto w-full max-w-2xl ${section === 'competition' ? 'lg:max-w-4xl' : ''} px-4 pt-4 pb-[max(1.5rem,env(safe-area-inset-bottom))] space-y-4`}
        >
          {stale && active && <StaleLine onRetry={active.reload} />}
          {screen}
          {related && <RelatedDoors current={related} />}
        </div>
      </div>
      <div ref={setCtaSlot} data-rewards-cta-slot className="shrink-0" />
      <p role="status" aria-live="polite" className="sr-only">
        {announcement}
      </p>
    </div>
  );
}
