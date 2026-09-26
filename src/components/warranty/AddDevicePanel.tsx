import React, { Suspense, useCallback, useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { Barcode, Camera, LifeBuoy, Link2, Package, ScanLine } from 'lucide-react';
import type { Language } from '../../translations';
import { api, ApiError } from '../../lib/api';
import { TabPanels, TabStrip } from '../ui/Tabs';
import { Overlay } from '../ui/Overlay';
import SafeImage from '../ui/SafeImage';
import { Skeleton, SkeletonGroup } from '../ui/Skeleton';
import { EmptyState, ErrorState } from '../ui/AsyncStates';
import Spinner from '../ui/Spinner';
import { primeScannerAudio } from '../scanner/feedback';
import type { ScanRead } from '../scanner/BarcodeScanner';
import type { Device, EligibleUnit, RegisterResponse } from './types';
import { fmtDate, productName } from './types';
import type { WarrantyStrings } from './strings';
import { BTN_PRIMARY, BTN_SECONDARY, CARD, ERROR_BOX, INPUT, LINK_QUIET, OK_BOX } from './ui';

// The camera scanner and its barcode reader are their own lazy chunks: a
// customer who types the serial never downloads either.
const BarcodeScanner = React.lazy(() => import('../scanner/BarcodeScanner'));

/**
 * "Add a printer" — three ways in, one outcome. The serial form and the
 * scanner both end in the same POST, so they share one status line; the
 * "from my orders" list is the no-typing path for a person who has the order
 * but not the label in front of them.
 *
 * The 404 from the serial endpoint is shown as ONE fixed sentence in every
 * language. The server deliberately does not say whether the number is
 * unknown, undelivered, replaced or held by someone else, and this panel must
 * not try to guess on its behalf. What it CAN do is offer the way forward:
 * «اطلب مراجعة يدوية» opens a support ticket naming the number, and the
 * warranty team — who can see the serial inventory — links it by hand.
 *
 * The serial may also be one the shop recorded BEFORE the sale (the serial
 * inventory, 0139): the server then attaches it to the customer's own
 * delivered printer of that model. The scanner reads the box label's
 * «Product SN» barcode for exactly that.
 */

type AddTab = 'serial' | 'orders' | 'scan';
const TAB_ORDER: AddTab[] = ['serial', 'orders', 'scan'];

interface Notice {
  kind: 'ok' | 'error';
  text: string;
  hint?: string;
  /** The number to name in a manual-review ticket. */
  review?: string;
}

function registerErrorNotice(e: unknown, s: WarrantyStrings, tried = ''): Notice {
  if (e instanceof ApiError) {
    if (e.status === 429) return { kind: 'error', text: s.rateLimited };
    if (e.status === 404 || e.code === 'SERIAL_NOT_FOUND_OR_IN_USE') {
      return { kind: 'error', text: s.notFound, hint: s.notFoundNext, review: tried || undefined };
    }
    if (e.code === 'LINKED_ELSEWHERE') return { kind: 'error', text: s.linkedElsewhere };
    if (e.message) return { kind: 'error', text: e.message };
  }
  return { kind: 'error', text: s.error };
}

export function AddDevicePanel({
  lang,
  s,
  refreshKey,
  onLinked,
}: {
  lang: Language;
  s: WarrantyStrings;
  /** Bump to make the "from my orders" list reload (e.g. after an unlink). */
  refreshKey: number;
  onLinked: (device: Device, alreadyRegistered: boolean) => void;
}) {
  const [tab, setTab] = useState<AddTab>('serial');
  const [serial, setSerial] = useState('');
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<Notice | null>(null);

  const [scannerOpen, setScannerOpen] = useState(false);
  const [scanned, setScanned] = useState('');
  const scanButton = useRef<HTMLButtonElement | null>(null);

  const [eligible, setEligible] = useState<EligibleUnit[] | null>(null);
  const [eligibleLoading, setEligibleLoading] = useState(false);
  const [eligibleError, setEligibleError] = useState<unknown>(null);
  const [rowBusy, setRowBusy] = useState<string | null>(null);
  const [rowErrors, setRowErrors] = useState<Record<string, string>>({});

  const loadEligible = useCallback(async () => {
    setEligibleLoading(true);
    setEligibleError(null);
    try {
      const res = await api.get<{ units: EligibleUnit[] }>('/api/devices/eligible');
      setEligible(res.units);
    } catch (e) {
      setEligibleError(e);
    } finally {
      setEligibleLoading(false);
    }
  }, []);

  useEffect(() => {
    if (tab === 'orders') loadEligible();
  }, [tab, refreshKey, loadEligible]);

  const register = async (raw: string) => {
    const value = raw.trim();
    if (!value || busy) return;
    setBusy(true);
    setNotice(null);
    try {
      const res = await api.post<RegisterResponse>('/api/devices/register', { serial: value });
      setNotice({ kind: 'ok', text: res.already_registered ? s.alreadyLinked : s.linkedOk });
      setSerial('');
      setScanned('');
      onLinked(res.device, res.already_registered);
      if (eligible) loadEligible();
    } catch (e) {
      setNotice(registerErrorNotice(e, s, value));
    } finally {
      setBusy(false);
    }
  };

  const linkUnit = async (u: EligibleUnit) => {
    if (rowBusy) return;
    setRowBusy(u.unit_id);
    setRowErrors((r) => ({ ...r, [u.unit_id]: '' }));
    setNotice(null);
    try {
      const res = await api.post<RegisterResponse>(`/api/devices/units/${encodeURIComponent(u.unit_id)}/register`, {});
      setEligible((list) => (list ? list.filter((x) => x.unit_id !== u.unit_id) : list));
      setNotice({ kind: 'ok', text: res.already_registered ? s.alreadyLinked : s.linkedOk });
      onLinked(res.device, res.already_registered);
    } catch (e) {
      const n = registerErrorNotice(e, s);
      setRowErrors((r) => ({ ...r, [u.unit_id]: n.text }));
      if (e instanceof ApiError && e.code === 'LINKED_ELSEWHERE') {
        setEligible((list) => (list ? list.map((x) => (x.unit_id === u.unit_id ? { ...x, linked_elsewhere: true } : x)) : list));
      }
    } finally {
      setRowBusy(null);
    }
  };

  const openScanner = () => {
    // Inside the tap: iOS lets the scanner beep only from a gesture.
    primeScannerAudio();
    setNotice(null);
    setScannerOpen(true);
  };

  /** A receipt QR first, then the device serial, then (after a pause) a box SN — the server maps each. */
  const onScanned = (read: ScanRead) => {
    const text = read.receipt ?? read.productSn ?? read.boxSn ?? '';
    setScannerOpen(false);
    if (!text) return;
    setScanned(text);
    if (tab === 'serial') setSerial(text);
    register(text);
  };

  const onTypedInScanner = (text: string) => {
    setScannerOpen(false);
    setScanned(text);
    if (tab === 'serial') setSerial(text);
    register(text);
  };

  const tabLabel = (Icon: React.ElementType, text: string) => (
    <span className="inline-flex items-center gap-1.5">
      <Icon aria-hidden="true" className="w-4 h-4" />
      {text}
    </span>
  );

  return (
    <section className={`${CARD} overflow-hidden`} aria-labelledby="warranty-add-title">
      <div className="px-4 pt-4">
        <h2 id="warranty-add-title" className="text-white font-bold text-base">
          {s.addTitle}
        </h2>
        <p className="text-zinc-500 text-[12px] mt-0.5">{s.addIntro}</p>
      </div>
      <TabStrip
        items={[
          { id: 'serial', label: tabLabel(Barcode, s.tabSerial) },
          { id: 'orders', label: tabLabel(Package, s.tabOrders) },
          { id: 'scan', label: tabLabel(ScanLine, s.tabScan) },
        ]}
        value={tab}
        onChange={(id) => setTab(id as AddTab)}
        group="warranty-add"
        label={s.addTitle}
        indicatorClassName="bg-gold"
        className="mt-2 border-b border-zinc-800"
      />
      <TabPanels value={tab} order={TAB_ORDER} className="p-4">
        {tab === 'serial' && (
          <form
            onSubmit={(e) => {
              e.preventDefault();
              register(serial);
            }}
            className="space-y-3"
          >
            <div>
              <label htmlFor="warranty-serial" className="text-[12px] text-zinc-400 mb-1.5 block font-medium">
                {s.serialLabel}
              </label>
              <div className="flex gap-2">
                <input
                  id="warranty-serial"
                  value={serial}
                  onChange={(e) => setSerial(e.target.value)}
                  placeholder={s.serialPlaceholder}
                  maxLength={200}
                  autoComplete="off"
                  autoCapitalize="characters"
                  spellCheck={false}
                  inputMode="text"
                  dir="ltr"
                  className={`${INPUT} font-mono flex-1`}
                />
                <button type="submit" disabled={busy || !serial.trim()} className={`${BTN_PRIMARY} shrink-0`}>
                  <Link2 aria-hidden="true" className="w-4 h-4" />
                  <span className="hidden sm:inline">{busy ? s.linking : s.link}</span>
                  <span className="sm:hidden">{busy ? s.linking : s.linkRow}</span>
                </button>
              </div>
            </div>
            <button ref={tab === 'serial' ? scanButton : undefined} type="button" onClick={openScanner} disabled={busy} className={`${BTN_SECONDARY} w-full sm:w-auto`} data-warranty-scan-serial>
              <ScanLine aria-hidden="true" className="w-4 h-4" />
              {s.scanBarcode}
            </button>
            <p className="text-zinc-500 text-[11px] leading-relaxed">{s.inventoryHint}</p>
            <p className="text-zinc-500 text-[11px]">{s.registerHint}</p>
          </form>
        )}

        {tab === 'orders' && (
          <div className="space-y-3">
            <p className="text-zinc-500 text-[12px]">{s.eligibleIntro}</p>
            {eligible === null && eligibleLoading && (
              <SkeletonGroup className="divide-y divide-zinc-800/70">
                {[0, 1].map((i) => (
                  <div key={i} className="flex items-center gap-3 py-3" aria-hidden="true">
                    <Skeleton className="w-12 h-12 rounded-lg shrink-0" />
                    <div className="flex-1 space-y-2">
                      <Skeleton className="h-4 w-1/2" />
                      <Skeleton className="h-3 w-3/4" />
                    </div>
                    <Skeleton className="h-10 w-16 rounded-xl" />
                  </div>
                ))}
              </SkeletonGroup>
            )}
            {eligibleError != null && !eligibleLoading && <ErrorState error={eligibleError} onRetry={loadEligible} compact />}
            {eligible && eligible.length === 0 && eligibleError == null && (
              <EmptyState
                compact
                icon={<Package aria-hidden="true" className="w-6 h-6" />}
                title={s.eligibleEmpty}
                description={s.eligibleEmptyDesc}
              />
            )}
            {eligible && eligible.length > 0 && (
              <ul className="divide-y divide-zinc-800/70">
                {eligible.map((u) => {
                  const disabled = u.linked_elsewhere || rowBusy === u.unit_id;
                  return (
                    <li key={u.unit_id} className="flex items-center gap-3 py-3 first:pt-0 last:pb-0" data-unit-id={u.unit_id}>
                      <SafeImage src={u.product.image} alt="" aspect="auto" className="w-12 h-12 rounded-lg border border-zinc-800 shrink-0" bgClassName="bg-zinc-950" />
                      <div className="min-w-0 flex-1">
                        <div className={`text-[14px] font-bold truncate ${u.linked_elsewhere ? 'text-zinc-400' : 'text-white'}`}>
                          {productName(u.product, lang)}
                        </div>
                        <div className="text-zinc-500 text-[11px] truncate tabular-nums">
                          {u.order_id && (
                            <>
                              <span dir="ltr" className="font-mono">{u.order_id}</span>
                              {' · '}
                            </>
                          )}
                          {s.unitN(u.unit_index)}
                          {' · '}
                          {s.deliveredAt} {fmtDate(u.delivered_at, lang)}
                        </div>
                        {u.linked_elsewhere && <div className="text-zinc-500 text-[11px] mt-0.5 leading-snug">{s.linkedElsewhere}</div>}
                        {!u.linked_elsewhere && rowErrors[u.unit_id] && (
                          <div role="alert" className="text-red-300 text-[11px] mt-0.5 leading-snug">
                            {rowErrors[u.unit_id]}
                          </div>
                        )}
                      </div>
                      <button
                        type="button"
                        onClick={() => linkUnit(u)}
                        disabled={disabled}
                        aria-label={`${s.linkRow} — ${productName(u.product, lang)} · ${s.unitN(u.unit_index)}`}
                        className={`${BTN_PRIMARY} shrink-0 min-h-[40px] px-3.5`}
                      >
                        <Link2 aria-hidden="true" className="w-4 h-4" />
                        {rowBusy === u.unit_id ? s.linking : s.linkRow}
                      </button>
                    </li>
                  );
                })}
              </ul>
            )}
          </div>
        )}

        {tab === 'scan' && (
          <div className="space-y-3">
            <p className="text-zinc-400 text-[13px]">{s.scanIntro}</p>
            <button ref={tab === 'scan' ? scanButton : undefined} type="button" onClick={openScanner} disabled={busy} className={BTN_PRIMARY}>
              <Camera aria-hidden="true" className="w-4 h-4" />
              {busy ? s.linking : s.scanCta}
            </button>
            {scanned && (
              <p className="text-[12px] text-zinc-400 break-all">
                <span dir="ltr" className="font-mono text-zinc-200">{scanned}</span>
              </p>
            )}
            <p className="text-zinc-500 text-[11px]">{s.registerHint}</p>
          </div>
        )}
      </TabPanels>

      {notice && (
        <div className="px-4 pb-4">
          <div role={notice.kind === 'error' ? 'alert' : 'status'} className={notice.kind === 'error' ? ERROR_BOX : OK_BOX}>
            {notice.text}
            {notice.hint && <div className="text-[11px] opacity-80 mt-1">{notice.hint}</div>}
          </div>
          {notice.review && (
            <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1" data-warranty-review>
              <Link to="/support" state={{ subject: s.reviewSubject(notice.review) }} className={LINK_QUIET.replace('min-h-[32px]', 'min-h-[44px]')}>
                <LifeBuoy aria-hidden="true" className="w-3.5 h-3.5" />
                {s.requestReview}
              </Link>
              <span className="text-zinc-500 text-[11px] leading-snug">{s.reviewHint}</span>
            </div>
          )}
        </div>
      )}

      {/* The scanner window grows out of the button that opened it. `solid`:
          the preview has to stay true black behind the frame to scan at all. */}
      <Overlay
        open={scannerOpen}
        onClose={() => setScannerOpen(false)}
        labelledBy="warranty-scanner-title"
        anchor={scanButton}
        solid
        z={60}
        testId="warranty-scanner"
        panelClassName="w-full max-w-md bg-zinc-950 border border-zinc-800 overflow-hidden"
      >
        <Suspense
          fallback={
            <div className="flex items-center justify-center py-16">
              <Spinner size="md" delayMs={150} decorative />
            </div>
          }
        >
          <BarcodeScanner
            mode="single"
            qr
            frame="strip"
            titleId="warranty-scanner-title"
            title={s.scanTitle}
            onRead={onScanned}
            onManual={onTypedInScanner}
            onClose={() => setScannerOpen(false)}
          />
        </Suspense>
      </Overlay>
    </section>
  );
}
