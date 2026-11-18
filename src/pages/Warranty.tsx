import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { ArrowLeft, ArrowRight, ClipboardList, Crown, Gift, BadgePercent, MessageSquare, Plus, Printer, ShieldCheck } from 'lucide-react';
import { useLanguage } from '../LanguageContext';
import { api, ApiError } from '../lib/api';
import { Skeleton, SkeletonGroup } from '../components/ui/Skeleton';
import { EmptyState, ErrorState } from '../components/ui/AsyncStates';
import { CARE_STRINGS, WARRANTY_STRINGS } from '../components/warranty/strings';
import type { Claim, Device, MineResponse } from '../components/warranty/types';
import { fmtCount, fmtInt } from '../components/warranty/types';
import { AddDevicePanel } from '../components/warranty/AddDevicePanel';
import { DeviceCard, type ClaimKind } from '../components/warranty/DeviceCard';
import { ClaimCard } from '../components/warranty/ClaimCard';
import { DeviceClaimOverlay } from '../components/warranty/ClaimForms';
import { ClaimThreadOverlay } from '../components/warranty/ClaimThreadOverlay';
import { UnlinkSheet } from '../components/warranty/UnlinkSheet';
import { NoticeStack, type PageNotice } from '../components/warranty/Notices';
import { BTN_PRIMARY, BTN_SECONDARY, CARD, FOCUS } from '../components/warranty/ui';
import { IconButton } from '../components/ui/Button';

/**
 * THE WARRANTY CENTER, REBUILT AROUND ONE QUESTION: «طابعتي — ما الذي يغطيها،
 * وحتى متى، وماذا أفعل الآن؟» (DECISIONS row 358). Top to bottom:
 *
 *   1. the notices — they stay until the customer puts them away, and ride
 *      under the header so a notice raised from a card far down is still seen;
 *      with them, a part offered at a Levo Care discount that waits in a
 *      conversation («لديك عرض قطعة بخصم ليفو كير»);
 *   2. «طابعاتي» — one cover card per printer: the warranty and then Levo Care
 *      after it, in words and as one line; what Care gives; the requests open
 *      on it; «افتح طلب ضمان» and, with Care in force, «اطلب خصم ليفو كير».
 *      «إضافة طابعة» is the first thing on the page only while there is no
 *      printer; after that it is a section the button beside the heading opens;
 *   3. «مطالباتي» — every request and its conversation;
 *   4. how the cover works, in three lines.
 *
 * THE FREE-FORM «مطالبة عامة» LINK STAYS GONE BY THE OWNER'S DECISION: «يحذف —
 * فالضمان للطابعات فقط». The only way to open a request is from a linked
 * printer. The route behind the old link is untouched — the general claims
 * already filed have `unit_id IS NULL`, and the list below still shows them.
 *
 * Every window is the house Overlay/Sheet: it arrives from the control that
 * raised it and leaves the same way. Data flows one way — the server says what
 * the cover is, and this page draws exactly that.
 *
 * `?claim=<id>` OPENS THAT REQUEST'S CONVERSATION. It is the address every
 * warranty notification carries (worker/lib/engagementNotify.ts
 * `warrantyClaimLink`) — «رد من فريق الضمان» in the bell lands the customer IN
 * the thread, not on a list they then have to search.
 */

function DeviceSkeleton() {
  return (
    <div className={`${CARD} p-4`} aria-hidden="true">
      <div className="flex gap-3">
        <Skeleton className="w-16 h-16 rounded-lg shrink-0" />
        <div className="flex-1 space-y-2 pt-1">
          <Skeleton className="h-4 w-2/3" />
          <Skeleton className="h-3 w-1/2" />
        </div>
      </div>
      <div className="mt-4 border-t border-border-subtle pt-4 flex gap-2.5">
        <Skeleton className="h-9 w-9 rounded-full shrink-0" />
        <div className="flex-1 space-y-2">
          <Skeleton className="h-4 w-3/4" />
          <Skeleton className="h-3 w-1/3" />
        </div>
      </div>
      <Skeleton className="h-2 w-full rounded-full mt-4" />
      <div className="flex justify-between mt-2">
        <Skeleton className="h-3 w-24" />
        <Skeleton className="h-3 w-24" />
      </div>
      <Skeleton className="h-3 w-2/3 mt-4" />
      <Skeleton className="h-3 w-1/2 mt-2" />
      <Skeleton className="h-11 w-full rounded-md mt-4" />
    </div>
  );
}

export default function Warranty() {
  const navigate = useNavigate();
  const { lang, dir } = useLanguage();
  const s = WARRANTY_STRINGS[lang];
  const c = CARE_STRINGS[lang];
  const [searchParams, setSearchParams] = useSearchParams();
  const deepClaim = searchParams.get('claim');

  const goBack = () => {
    // navigate(-1) is a no-op when the page was opened directly (deep link,
    // refresh) — fall back to home instead of a dead button.
    const idx = (window.history.state as { idx?: number } | null)?.idx ?? 0;
    if (idx > 0) navigate(-1);
    else navigate('/');
  };

  // ------------------------------------------------------------- devices
  const [mine, setMine] = useState<MineResponse | null>(null);
  const [devicesLoading, setDevicesLoading] = useState(true);
  const [devicesError, setDevicesError] = useState<unknown>(null);
  // Bumped whenever the set of linked devices changes, so the "from my
  // orders" list inside the add panel knows to reload.
  const [refreshKey, setRefreshKey] = useState(0);
  // «إضافة طابعة» as a secondary section, once there is a printer.
  const [addOpen, setAddOpen] = useState(false);
  const addButton = useRef<HTMLButtonElement | null>(null);

  // -------------------------------------------------------------- claims
  const [claims, setClaims] = useState<Claim[]>([]);
  const [claimsLoading, setClaimsLoading] = useState(true);
  const [claimsError, setClaimsError] = useState<unknown>(null);

  // ------------------------------------------------------------- notices
  // They stay until dismissed (they used to vanish after six seconds).
  const [notices, setNotices] = useState<PageNotice[]>([]);
  const noticeSeq = useRef(0);
  const notify = useCallback((tone: PageNotice['tone'], text: string, action?: PageNotice['action']) => {
    noticeSeq.current += 1;
    const id = `n${noticeSeq.current}`;
    // The same sentence twice is one notice, the newer one.
    setNotices((prev) => [...prev.filter((n) => n.text !== text), { id, tone, text, action }]);
  }, []);
  const dismiss = useCallback((id: string) => setNotices((prev) => prev.filter((n) => n.id !== id)), []);

  // ------------------------------------------------------------- windows
  // The control each window grows out of. Devices and claims are stacks of
  // near-identical rows, so the origin of the arrival is what says which row
  // is being acted on while the window is on its way in.
  const claimAnchor = useRef<HTMLElement | null>(null);
  const threadAnchor = useRef<HTMLElement | null>(null);
  const [claimForDevice, setClaimForDevice] = useState<Device | null>(null);
  const [claimKind, setClaimKind] = useState<ClaimKind>('warranty');
  const sentKind = useRef<ClaimKind>('warranty');
  const [openClaimId, setOpenClaimId] = useState<string | null>(null);
  const [threadNotice, setThreadNotice] = useState('');

  const [unlinkDevice, setUnlinkDevice] = useState<Device | null>(null);
  const [unlinkOpen, setUnlinkOpen] = useState(false);
  const [unlinkBusy, setUnlinkBusy] = useState(false);
  const [unlinkError, setUnlinkError] = useState('');
  const [unlinkBlocked, setUnlinkBlocked] = useState(false);

  const loadDevices = useCallback(async () => {
    try {
      const res = await api.get<MineResponse>('/api/devices/mine');
      setMine(res);
      setDevicesError(null);
    } catch (e) {
      setDevicesError(e);
    } finally {
      setDevicesLoading(false);
    }
  }, []);

  const loadClaims = useCallback(async () => {
    try {
      const res = await api.get<{ claims: Claim[] }>('/api/devices/claims');
      setClaims(res.claims ?? []);
      setClaimsError(null);
    } catch (e) {
      setClaimsError(e);
    } finally {
      setClaimsLoading(false);
    }
  }, []);

  useEffect(() => {
    loadDevices();
    loadClaims();
  }, [loadDevices, loadClaims]);

  // A notification's link: open the thread it names. Keyed on the id, so a
  // second notification tapped while this page is open opens its own claim.
  useEffect(() => {
    if (!deepClaim) return;
    threadAnchor.current = null;
    setClaims((prev) => prev.map((cl) => (cl.id === deepClaim ? { ...cl, unread: false } : cl)));
    setOpenClaimId(deepClaim);
  }, [deepClaim]);

  // Opening «إضافة طابعة» moves focus to its name, so a keyboard or a screen
  // reader lands in the section the button just opened.
  useEffect(() => {
    if (addOpen) document.getElementById('warranty-add-title')?.focus();
  }, [addOpen]);

  // --------------------------------------------------------------- actions
  const onLinked = (device: Device) => {
    // Show it at once, then let the server's list be the truth.
    setMine((prev) => {
      if (!prev) return prev;
      if (prev.devices.some((d) => d.unit_id === device.unit_id)) return prev;
      return { ...prev, devices: [device, ...prev.devices] };
    });
    setRefreshKey((k) => k + 1);
    loadDevices();
    // A request filed on it before it was linked now belongs on its card.
    loadClaims();
  };

  const closeAdd = () => {
    setAddOpen(false);
    addButton.current?.focus();
  };

  const openClaimFor = (device: Device, kind: ClaimKind, trigger: HTMLElement) => {
    claimAnchor.current = trigger;
    setClaimKind(kind);
    setClaimForDevice(device);
  };

  const askUnlink = (device: Device) => {
    setUnlinkDevice(device);
    setUnlinkBusy(false);
    // A unit with an open claim cannot be unlinked; say so before the tap
    // rather than after a failed request.
    const blocked = device.open_claims > 0;
    setUnlinkBlocked(blocked);
    setUnlinkError(blocked ? s.claimOpenBlock : '');
    setUnlinkOpen(true);
  };

  const confirmUnlink = async () => {
    if (!unlinkDevice || unlinkBusy) return;
    setUnlinkBusy(true);
    setUnlinkError('');
    try {
      await api.delete(`/api/devices/units/${encodeURIComponent(unlinkDevice.unit_id)}/registration`);
      setUnlinkOpen(false);
      setMine((prev) => (prev ? { ...prev, devices: prev.devices.filter((d) => d.unit_id !== unlinkDevice.unit_id) } : prev));
      notify('ok', s.unlinkedOk);
      setRefreshKey((k) => k + 1);
      loadDevices();
    } catch (e) {
      if (e instanceof ApiError && e.code === 'CLAIM_OPEN') {
        setUnlinkBlocked(true);
        setUnlinkError(s.claimOpenBlock);
      } else {
        setUnlinkError(e instanceof ApiError ? e.message : s.error);
      }
    } finally {
      setUnlinkBusy(false);
    }
  };

  /**
   * Opening a thread is READING it: the card drops «رد جديد» at once, and the
   * server records the same when the thread loads (GET /claims/:id stamps
   * `customer_seen_at`), so the next list agrees.
   */
  const openThread = (claimId: string, trigger: HTMLElement | null) => {
    threadAnchor.current = trigger;
    setClaims((prev) => prev.map((cl) => (cl.id === claimId ? { ...cl, unread: false } : cl)));
    setThreadNotice('');
    setOpenClaimId(claimId);
  };

  const closeThread = () => {
    setOpenClaimId(null);
    setThreadNotice('');
    // The link that opened it is spent: a refresh must not open it again.
    if (searchParams.has('claim')) {
      const next = new URLSearchParams(searchParams);
      next.delete('claim');
      setSearchParams(next, { replace: true });
    }
    // The thread may have grown while it was open — and a Care quote accepted
    // or a part offer used in it changes what the printer's card says is left.
    loadClaims();
    loadDevices();
  };

  const onClaimSubmitted = (result: { id: string; replay: boolean }) => {
    if (result.replay) {
      // The stored claim kept its FIRST version; what the customer added on
      // the retry was not saved. Say so, and open the one place it can still
      // be sent — the claim's own conversation.
      notify('warn', s.claimReplayNotice);
      setThreadNotice(s.claimReplayNotice);
      threadAnchor.current = claimAnchor.current;
      setOpenClaimId(result.id);
    } else {
      const id = result.id;
      notify('ok', sentKind.current === 'care' ? s.careSubmitted : s.claimSubmitted, { label: s.openThread, run: (el) => openThread(id, el) });
    }
    loadClaims();
    // The card's open request and its actions change too.
    loadDevices();
  };

  const devices = mine?.devices ?? [];
  const priority = mine?.priority_service === true;
  const hasDevices = devices.length > 0;
  const devicesReady = !devicesLoading && devicesError == null;

  // Each printer's own requests, newest first as the list sends them.
  const claimsByUnit = useMemo(() => {
    const map = new Map<string, Claim[]>();
    for (const cl of claims) {
      if (!cl.unit_id) continue;
      const list = map.get(cl.unit_id);
      if (list) list.push(cl);
      else map.set(cl.unit_id, [cl]);
    }
    return map;
  }, [claims]);

  // A part offered at a Levo Care discount waits in a conversation: said at the top of the page.
  const offerClaims = claims.filter((cl) => (Number(cl.part_offers_live) || 0) > 0);
  const offersLive = offerClaims.reduce((n, cl) => n + (Number(cl.part_offers_live) || 0), 0);

  return (
    <div className="w-full pb-24 text-text-secondary min-h-screen" data-warranty-page>
      {/* Translucent chrome over content: the page passes under it. */}
      <header className="sticky top-0 z-40 material material-thin px-4 py-3 flex items-center gap-3">
        <IconButton
          variant="secondary"
          onClick={() => {
            goBack();
          }}
          label={s.back}
          icon={dir === 'rtl' ? <ArrowRight aria-hidden="true" className="w-5 h-5" /> : <ArrowLeft aria-hidden="true" className="w-5 h-5" />}
          className="-my-1.5"
        />
        <h1 className="text-text-primary font-bold text-lg">{s.title}</h1>
      </header>

      <div className="p-4 space-y-5 max-w-2xl mx-auto">
        <p className="text-text-secondary text-[13.5px] leading-relaxed">{s.intro}</p>

        {/* ------------------------------------------------------- notices */}
        {/* The live region is always in the page (so a notice is announced when it
            arrives); it takes room, and rides under the header, only while it holds one. */}
        <div className={notices.length > 0 ? 'sticky z-30' : 'sr-only'} style={notices.length > 0 ? { top: 68 } : undefined}>
          <NoticeStack notices={notices} onDismiss={dismiss} dismissLabel={s.dismiss} />
        </div>
        {offersLive > 0 && (
          <button
            type="button"
            onClick={(e) => openThread(offerClaims[0].id, e.currentTarget)}
            className={`flex w-full min-h-[44px] items-center gap-2.5 text-start lv-alert lv-alert-info ${FOCUS}`}
            data-warranty-offers={offersLive}
          >
            <Gift aria-hidden="true" className="w-4 h-4 shrink-0" style={{ color: 'var(--color-info)' }} />
            <span className="min-w-0 flex-1 text-[13px] font-bold leading-snug text-text-primary">{c.offerWaiting(offersLive, fmtCount(offersLive))}</span>
            <span className="shrink-0 text-[12.5px] font-bold underline underline-offset-2 text-text-primary">{c.seeOffer}</span>
          </button>
        )}

        {priority && (
          <div className="flex items-center gap-3 rounded-2xl border border-gold/30 bg-gold/10 px-4 py-3" data-testid="warranty-pro-strip">
            <Crown aria-hidden="true" className="w-5 h-5 text-gold shrink-0" />
            <p className="text-[13px] text-text-primary flex-1 min-w-0 leading-snug">{s.proStrip}</p>
            <Link to="/subscription" className={`inline-flex min-h-[44px] items-center text-[12px] font-bold text-gold whitespace-nowrap hover:underline underline-offset-2 rounded ${FOCUS}`}>
              {s.proStripLink}
            </Link>
          </div>
        )}

        {/* --------------------------------------------------------- my printers */}
        <section aria-labelledby="warranty-devices-title" className="space-y-3">
          <div className="flex items-center justify-between gap-3 min-h-[44px]">
            <h2 id="warranty-devices-title" className="text-text-primary font-bold text-[17px]">
              {s.myPrinters}
              {hasDevices && <span className="ms-2 text-text-muted text-[13px] font-normal tabular-nums">{fmtInt(devices.length, lang)}</span>}
            </h2>
            {/* Once there is a printer, adding another is a secondary action. */}
            {devicesReady && hasDevices && (
              <button
                ref={addButton}
                type="button"
                onClick={() => setAddOpen((o) => !o)}
                aria-expanded={addOpen}
                aria-controls="warranty-add"
                className={`${BTN_SECONDARY} lv-button-sm shrink-0`}
                data-warranty-add-toggle
              >
                <Plus aria-hidden="true" className="w-4 h-4" />
                {s.addTitle}
              </button>
            )}
          </div>

          {devicesReady && hasDevices && addOpen && <AddDevicePanel lang={lang} s={s} refreshKey={refreshKey} onLinked={onLinked} onClose={closeAdd} />}

          {devicesLoading ? (
            <SkeletonGroup className="space-y-3">
              <DeviceSkeleton />
              <DeviceSkeleton />
            </SkeletonGroup>
          ) : devicesError != null ? (
            <ErrorState error={devicesError} onRetry={loadDevices} />
          ) : !hasDevices ? (
            <>
              {/* No printer yet: the page says what it is for, and adding one is the first thing on it. */}
              <div className={`${CARD} p-5 text-center`} data-warranty-empty>
                <span className="lv-well inline-flex h-12 w-12 items-center justify-center rounded-full text-gold">
                  <Printer aria-hidden="true" className="w-6 h-6" />
                </span>
                <h3 className="mt-3 text-[17px] font-bold leading-snug text-text-primary">{s.devicesEmpty}</h3>
                <p className="mt-1.5 text-[13px] leading-relaxed text-text-secondary">{s.devicesEmptyDesc}</p>
                <button type="button" onClick={() => document.getElementById('warranty-serial')?.focus()} className={`${BTN_PRIMARY} mt-4 w-full sm:w-auto`} data-warranty-empty-cta>
                  <Plus aria-hidden="true" className="w-4 h-4" />
                  {s.emptyCta}
                </button>
              </div>
              <AddDevicePanel lang={lang} s={s} refreshKey={refreshKey} onLinked={onLinked} />
            </>
          ) : (
            <div className="space-y-3">
              {devices.map((d) => (
                <DeviceCard
                  key={d.unit_id}
                  device={d}
                  claims={claimsByUnit.get(d.unit_id)}
                  lang={lang}
                  s={s}
                  onOpenClaim={openClaimFor}
                  onOpenThread={(claim, trigger) => openThread(claim.id, trigger)}
                  onRemove={askUnlink}
                  maintenancePath={mine?.maintenance_path ?? null}
                  carePerks={mine?.care_perks ?? null}
                />
              ))}
            </div>
          )}
        </section>

        {/* ----------------------------------------------------------- my claims */}
        <section aria-labelledby="warranty-claims-title" className="space-y-3">
          <h2 id="warranty-claims-title" className="text-text-primary font-bold text-[17px]">
            {s.claims}
            {claims.length > 0 && <span className="ms-2 text-text-muted text-[13px] font-normal tabular-nums">{fmtInt(claims.length, lang)}</span>}
          </h2>
          {/* WHAT A TAP ON A CLAIM DOES, said before anyone has to guess —
              «لا يوجد هنالك توضيح … أن عند الضغط على مطالباتي تفتح المحادثة». */}
          {claims.length > 0 && (
            <p className="text-text-secondary text-[12px] leading-relaxed flex items-start gap-1.5" data-claims-hint>
              <MessageSquare aria-hidden="true" className="w-3.5 h-3.5 mt-0.5 text-gold shrink-0" />
              <span>{s.claimsHint}</span>
            </p>
          )}
          {claimsLoading ? (
            <SkeletonGroup className="space-y-3">
              {[0, 1].map((i) => (
                <div key={i} className={`${CARD} p-4`} aria-hidden="true">
                  <div className="flex justify-between gap-3">
                    <Skeleton className="h-4 w-1/2" />
                    <Skeleton className="h-3 w-16" />
                  </div>
                  <Skeleton className="h-3 w-1/3 mt-2" />
                  <div className="grid grid-cols-5 gap-1 mt-4">
                    {[0, 1, 2, 3, 4].map((j) => (
                      <div key={j} className="flex flex-col items-center gap-1.5">
                        <Skeleton className="w-[11px] h-[11px] rounded-full" />
                        <Skeleton className="h-2.5 w-10" />
                      </div>
                    ))}
                  </div>
                  <Skeleton className="h-3 w-full mt-3" />
                  <Skeleton className="h-3 w-3/4 mt-1.5" />
                </div>
              ))}
            </SkeletonGroup>
          ) : claimsError != null ? (
            <ErrorState error={claimsError} onRetry={loadClaims} />
          ) : claims.length === 0 ? (
            <EmptyState compact icon={<ClipboardList aria-hidden="true" className="w-6 h-6" />} title={s.claimsEmpty} description={s.claimsEmptyDesc} />
          ) : (
            <div className="space-y-3">
              {claims.map((cl) => (
                <ClaimCard key={cl.id} claim={cl} lang={lang} s={s} onOpen={(claim, trigger) => openThread(claim.id, trigger)} />
              ))}
            </div>
          )}
        </section>

        {/* ------------------------------------------------ how the cover works */}
        <section aria-labelledby="warranty-how-title" className={`${CARD} p-4`} data-warranty-how>
          <h2 id="warranty-how-title" className="text-text-primary font-bold text-[15px]">
            {s.howTitle}
          </h2>
          <ul className="mt-3 space-y-3 text-[13px] leading-relaxed text-text-secondary">
            <li className="flex items-start gap-2.5">
              <ShieldCheck aria-hidden="true" className="w-4 h-4 mt-0.5 shrink-0 text-gold" />
              <span>{s.howWarranty}</span>
            </li>
            <li className="flex items-start gap-2.5">
              <BadgePercent aria-hidden="true" className="w-4 h-4 mt-0.5 shrink-0" style={{ color: 'var(--color-info)' }} />
              <span>{s.howCare}</span>
            </li>
            <li className="flex items-start gap-2.5">
              <MessageSquare aria-hidden="true" className="w-4 h-4 mt-0.5 shrink-0 text-text-muted" />
              <span>{s.howRequest}</span>
            </li>
          </ul>
          <p className="mt-3 border-t border-border-subtle pt-3 text-[12px] leading-relaxed text-text-muted">
            {s.coverageNote}
          </p>
          {mine && !priority ? (
            <Link to="/subscription" className={`inline-flex min-h-[44px] items-center text-[12px] text-text-muted hover:text-text-primary underline underline-offset-2 rounded ${FOCUS}`}>
              {s.proTeaser}
            </Link>
          ) : null}
        </section>
      </div>

      {/* ------------------------------------------------------------ windows */}
      <DeviceClaimOverlay
        device={claimForDevice}
        kind={claimKind}
        anchor={claimAnchor}
        lang={lang}
        s={s}
        onClose={() => setClaimForDevice(null)}
        onKindSent={(kind) => {
          sentKind.current = kind;
        }}
        onSubmitted={onClaimSubmitted}
        onOpenClaim={(claimId) => {
          // W-3: the device's open request — continue there instead of opening a second.
          setClaimForDevice(null);
          openThread(claimId, claimAnchor.current);
        }}
      />
      <ClaimThreadOverlay
        claimId={openClaimId}
        anchor={threadAnchor}
        lang={lang}
        s={s}
        onClose={closeThread}
        notice={threadNotice}
      />
      <UnlinkSheet
        device={unlinkDevice}
        open={unlinkOpen}
        busy={unlinkBusy}
        error={unlinkError}
        blocked={unlinkBlocked}
        lang={lang}
        s={s}
        onConfirm={confirmUnlink}
        onClose={() => setUnlinkOpen(false)}
      />
    </div>
  );
}
