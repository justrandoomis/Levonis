import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { ArrowLeft, ArrowRight, ClipboardList, Crown, MessageSquare, Printer } from 'lucide-react';
import { useLanguage } from '../LanguageContext';
import { api, ApiError } from '../lib/api';
import { Skeleton, SkeletonGroup } from '../components/ui/Skeleton';
import { EmptyState, ErrorState } from '../components/ui/AsyncStates';
import { WARRANTY_STRINGS } from '../components/warranty/strings';
import type { Claim, Device, MineResponse } from '../components/warranty/types';
import { fmtInt } from '../components/warranty/types';
import { AddDevicePanel } from '../components/warranty/AddDevicePanel';
import { DeviceCard } from '../components/warranty/DeviceCard';
import { ClaimCard } from '../components/warranty/ClaimCard';
import { DeviceClaimOverlay } from '../components/warranty/ClaimForms';
import { ClaimThreadOverlay } from '../components/warranty/ClaimThreadOverlay';
import { UnlinkSheet } from '../components/warranty/UnlinkSheet';
import { CARD, FOCUS, OK_BOX } from '../components/warranty/ui';

/**
 * Warranty center, built around the PHYSICAL printers linked to an account:
 *
 *   1. a header with the one-line promise and the membership strip (PRO
 *      priority service — never a claim about longer coverage, because
 *      membership does not change coverage);
 *   2. "Add a printer" — by serial/receipt number, from the account's own
 *      delivered orders, or by scanning the receipt QR / label barcode;
 *   3. "My printers" — one card per unit with the coverage timeline and the
 *      actions that belong to a unit (claim, support, receipt, order, and
 *      "remove from my account" behind a confirmation sheet);
 *   4. "My claims" — the claims list, the thread and the per-device claim form.
 *
 * THE FREE-FORM «مطالبة عامة» LINK IS GONE BY THE OWNER'S DECISION: «يحذف —
 * فالضمان للطابعات فقط». Warranty is for printers, so the only way to open a
 * claim is from a linked device. The route behind the old link is untouched —
 * the general claims already filed have `unit_id IS NULL`, and the list above
 * and the admin queue both still show and answer them; there is simply no
 * longer a control that files a new one.
 *
 * Every window is the house Overlay/Sheet: it arrives from the control that
 * raised it and leaves the same way. Data flows one way — the server says what
 * the coverage is, and this page draws exactly that.
 *
 * `?claim=<id>` OPENS THAT CLAIM'S CONVERSATION. It is the address every
 * warranty notification carries (worker/lib/engagementNotify.ts
 * `warrantyClaimLink`) — «رد من فريق الضمان» in the bell lands the customer IN
 * the thread, not on a list they then have to search.
 */

export default function Warranty() {
  const navigate = useNavigate();
  const { lang, dir } = useLanguage();
  const s = WARRANTY_STRINGS[lang];
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
  const [devicesNotice, setDevicesNotice] = useState('');
  // Bumped whenever the set of linked devices changes, so the "from my
  // orders" list inside the add panel knows to reload.
  const [refreshKey, setRefreshKey] = useState(0);

  // -------------------------------------------------------------- claims
  const [claims, setClaims] = useState<Claim[]>([]);
  const [claimsLoading, setClaimsLoading] = useState(true);
  const [claimsError, setClaimsError] = useState<unknown>(null);
  const [claimsNotice, setClaimsNotice] = useState('');

  // ------------------------------------------------------------- windows
  // The control each window grows out of. Devices and claims are stacks of
  // near-identical rows, so the origin of the arrival is what says which row
  // is being acted on while the window is on its way in.
  const claimAnchor = useRef<HTMLElement | null>(null);
  const threadAnchor = useRef<HTMLElement | null>(null);
  const [claimForDevice, setClaimForDevice] = useState<Device | null>(null);
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
      setClaims(res.claims);
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

  // Success notices are transient: they confirm, then get out of the way.
  useEffect(() => {
    if (!devicesNotice) return;
    const t = window.setTimeout(() => setDevicesNotice(''), 6000);
    return () => window.clearTimeout(t);
  }, [devicesNotice]);
  useEffect(() => {
    if (!claimsNotice) return;
    const t = window.setTimeout(() => setClaimsNotice(''), 6000);
    return () => window.clearTimeout(t);
  }, [claimsNotice]);

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
  };

  const openClaimFor = (device: Device, trigger: HTMLElement) => {
    claimAnchor.current = trigger;
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
      setDevicesNotice(s.unlinkedOk);
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
    // The thread may have grown while it was open.
    loadClaims();
  };

  const onClaimSubmitted = (result: { id: string; replay: boolean }) => {
    if (result.replay) {
      // The stored claim kept its FIRST version; what the customer added on
      // the retry was not saved. Say so, and open the one place it can still
      // be sent — the claim's own conversation.
      setClaimsNotice(s.claimReplayNotice);
      setThreadNotice(s.claimReplayNotice);
      threadAnchor.current = claimAnchor.current;
      setOpenClaimId(result.id);
    } else {
      setClaimsNotice(s.claimSubmitted);
    }
    loadClaims();
    // open_claims on the card changes too.
    loadDevices();
  };

  const devices = mine?.devices ?? [];
  const priority = mine?.priority_service === true;

  return (
    <div className="w-full pb-24 text-zinc-300 min-h-screen">
      {/* Translucent chrome over content: the page passes under it. */}
      <header className="sticky top-0 z-40 material material-thin px-4 py-3 flex items-center gap-3">
        <button
          type="button"
          onClick={goBack}
          aria-label={s.back}
          className={`p-2 bg-zinc-900/80 rounded-full hover:bg-zinc-800 transition-colors ${FOCUS}`}
        >
          {dir === 'rtl' ? <ArrowRight aria-hidden="true" className="w-5 h-5" /> : <ArrowLeft aria-hidden="true" className="w-5 h-5" />}
        </button>
        <h1 className="text-white font-bold text-lg">{s.title}</h1>
      </header>

      <div className="p-4 space-y-6 max-w-2xl mx-auto">
        {/* ------------------------------------------------ intro + membership */}
        <section className="space-y-3">
          <p className="text-zinc-400 text-[13px] leading-relaxed">{s.intro}</p>
          {priority ? (
            <div className="flex items-center gap-3 rounded-2xl border border-gold/30 bg-gold/10 px-4 py-3" data-testid="warranty-pro-strip">
              <Crown aria-hidden="true" className="w-5 h-5 text-gold shrink-0" />
              <p className="text-[13px] text-zinc-100 flex-1 min-w-0 leading-snug">{s.proStrip}</p>
              <Link to="/subscription" className={`text-[12px] font-bold text-gold whitespace-nowrap hover:underline underline-offset-2 rounded ${FOCUS}`}>
                {s.proStripLink}
              </Link>
            </div>
          ) : mine ? (
            <p className="text-[12px] text-zinc-500">
              <Link to="/subscription" className={`hover:text-zinc-300 underline underline-offset-2 rounded ${FOCUS}`}>
                {s.proTeaser}
              </Link>
            </p>
          ) : null}
          <p className="text-[11px] text-zinc-600">{s.coverageNote}</p>
        </section>

        {/* ------------------------------------------------------ add a printer */}
        <AddDevicePanel lang={lang} s={s} refreshKey={refreshKey} onLinked={onLinked} />

        {/* --------------------------------------------------------- my printers */}
        <section aria-labelledby="warranty-devices-title" className="space-y-3">
          <div className="flex items-baseline justify-between gap-3">
            <h2 id="warranty-devices-title" className="text-white font-bold text-base">
              {s.myPrinters}
            </h2>
            {devices.length > 0 && <span className="text-zinc-500 text-[12px] tabular-nums">{fmtInt(devices.length, lang)}</span>}
          </div>
          {devicesNotice && (
            <div role="status" className={OK_BOX}>
              {devicesNotice}
            </div>
          )}
          {devicesLoading ? (
            <SkeletonGroup className="space-y-3">
              {[0, 1].map((i) => (
                <div key={i} className={`${CARD} p-4`} aria-hidden="true">
                  <div className="flex gap-3">
                    <Skeleton className="w-16 h-16 rounded-xl shrink-0" />
                    <div className="flex-1 space-y-2 pt-1">
                      <Skeleton className="h-4 w-2/3" />
                      <Skeleton className="h-3 w-1/2" />
                    </div>
                  </div>
                  <Skeleton className="h-3 w-28 mt-5" />
                  <Skeleton className="h-px w-full mt-4" />
                  <div className="flex justify-between mt-2">
                    <Skeleton className="h-3 w-24" />
                    <Skeleton className="h-3 w-24" />
                  </div>
                  <div className="grid grid-cols-2 gap-2 mt-4">
                    <Skeleton className="h-11 rounded-xl" />
                    <Skeleton className="h-11 rounded-xl" />
                  </div>
                </div>
              ))}
            </SkeletonGroup>
          ) : devicesError != null ? (
            <ErrorState error={devicesError} onRetry={loadDevices} />
          ) : devices.length === 0 ? (
            <EmptyState icon={<Printer aria-hidden="true" className="w-6 h-6" />} title={s.devicesEmpty} description={s.devicesEmptyDesc} />
          ) : (
            <div className="space-y-3">
              {devices.map((d) => (
                <DeviceCard key={d.unit_id} device={d} lang={lang} s={s} onOpenClaim={openClaimFor} onRemove={askUnlink} />
              ))}
            </div>
          )}
        </section>

        {/* ----------------------------------------------------------- my claims */}
        <section aria-labelledby="warranty-claims-title" className="space-y-3">
          <div className="flex items-baseline justify-between gap-3">
            <h2 id="warranty-claims-title" className="text-white font-bold text-base">
              {s.claims}
            </h2>
            {claims.length > 0 && <span className="text-zinc-500 text-[12px] tabular-nums">{fmtInt(claims.length, lang)}</span>}
          </div>
          {/* WHAT A TAP ON A CLAIM DOES, said before anyone has to guess —
              «لا يوجد هنالك توضيح … أن عند الضغط على مطالباتي تفتح المحادثة». */}
          {claims.length > 0 && (
            <p className="text-zinc-400 text-[12px] leading-relaxed flex items-start gap-1.5" data-claims-hint>
              <MessageSquare aria-hidden="true" className="w-3.5 h-3.5 mt-0.5 text-gold shrink-0" />
              <span>{s.claimsHint}</span>
            </p>
          )}
          {claimsNotice && (
            <div role="status" className={OK_BOX}>
              {claimsNotice}
            </div>
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
            <EmptyState icon={<ClipboardList aria-hidden="true" className="w-6 h-6" />} title={s.claimsEmpty} description={s.claimsEmptyDesc} />
          ) : (
            <div className="space-y-3">
              {claims.map((cl) => (
                <ClaimCard
                  key={cl.id}
                  claim={cl}
                  lang={lang}
                  s={s}
                  onOpen={(claim, trigger) => openThread(claim.id, trigger)}
                />
              ))}
            </div>
          )}
        </section>
      </div>

      {/* ------------------------------------------------------------ windows */}
      <DeviceClaimOverlay
        device={claimForDevice}
        anchor={claimAnchor}
        lang={lang}
        s={s}
        onClose={() => setClaimForDevice(null)}
        onSubmitted={onClaimSubmitted}
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
